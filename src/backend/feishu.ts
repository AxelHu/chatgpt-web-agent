import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FeishuConfig } from "../config.js";
import { requestOpenClawGateway } from "../gateway.js";
import { toolError } from "../result.js";
import type { LocalToolBackend, LocalToolDescriptor, ToolCallContext } from "./types.js";

type GatewayActionResult = Record<string, unknown> & {
  ok?: boolean;
  error?: unknown;
};

type FeishuAccountStatus = {
  accountId: string;
  enabled?: boolean;
  configured?: boolean;
  running?: boolean;
  connected?: boolean;
  lastError?: string | null;
};

type ChannelsStatus = {
  channelAccounts?: Record<string, FeishuAccountStatus[]>;
};

type FeishuMention = {
  openId: string;
  name?: string;
};

export type FeishuBackendDeps = {
  getAccountStatus: (signal?: AbortSignal) => Promise<FeishuAccountStatus | undefined>;
  requestAction: (
    action: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<GatewayActionResult>;
};

const FEISHU_TARGET_RE = /^(chat:oc_[A-Za-z0-9_-]+|user:ou_[A-Za-z0-9_-]+)$/;
const FEISHU_CHAT_TARGET_RE = /^chat:(oc_[A-Za-z0-9_-]+)$/;
const FEISHU_OPEN_ID_RE = /^ou_[A-Za-z0-9_-]+$/;

function jsonResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function stringArg(args: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new Error(`${name} is required`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed && required) {
    throw new Error(`${name} is required`);
  }
  return trimmed || undefined;
}

function booleanArg(args: Record<string, unknown>, name: string, fallback = false): boolean {
  const value = args[name];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function integerArg(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function enumArg<T extends string>(
  args: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = args[name];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function validateTarget(target: string): string {
  if (!FEISHU_TARGET_RE.test(target)) {
    throw new Error("target must be an explicit Feishu target: chat:oc_... or user:ou_...");
  }
  return target;
}

function validateChatTarget(target: string): string {
  const match = FEISHU_CHAT_TARGET_RE.exec(target);
  if (!match) {
    throw new Error("target must be an explicit Feishu group target: chat:oc_...");
  }
  return match[1]!;
}

function escapeMentionName(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseMentions(args: Record<string, unknown>): FeishuMention[] {
  const raw = args.mentions;
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("mentions must be an array");
  }
  if (raw.length > 20) {
    throw new Error("mentions may contain at most 20 entries");
  }
  const seen = new Set<string>();
  const mentions: FeishuMention[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`mentions[${index}] must be an object`);
    }
    const mention = item as Record<string, unknown>;
    if (typeof mention.openId !== "string" || !FEISHU_OPEN_ID_RE.test(mention.openId.trim())) {
      throw new Error(`mentions[${index}].openId must be a Feishu open_id (ou_...)`);
    }
    const openId = mention.openId.trim();
    const name = mention.name;
    if (name !== undefined && typeof name !== "string") {
      throw new Error(`mentions[${index}].name must be a string`);
    }
    if (seen.has(openId)) {
      continue;
    }
    seen.add(openId);
    const trimmedName = typeof name === "string" ? name.trim() : "";
    mentions.push({ openId, ...(trimmedName ? { name: trimmedName } : {}) });
  }
  return mentions;
}

function renderMentionPrefix(mentions: FeishuMention[]): string {
  return mentions
    .map((mention) => {
      const label = escapeMentionName(mention.name ?? mention.openId);
      return `<at user_id="${mention.openId}">${label}</at>`;
    })
    .join(" ");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveMediaPath(config: FeishuConfig, rawPath: string): Promise<string> {
  const requested = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(config.mediaRoot, rawPath);
  if (config.mediaRootOnly && !isInside(config.mediaRoot, requested)) {
    throw new Error(`mediaPath must stay inside Feishu media root: ${config.mediaRoot}`);
  }
  const [realFile, stat] = await Promise.all([fs.realpath(requested), fs.stat(requested)]);
  if (!stat.isFile()) {
    throw new Error(`mediaPath must point to a regular file: ${requested}`);
  }
  if (config.mediaRootOnly) {
    const realRoot = await fs.realpath(config.mediaRoot);
    if (!isInside(realRoot, realFile)) {
      throw new Error(`mediaPath resolves outside Feishu media root: ${config.mediaRoot}`);
    }
  }
  return realFile;
}

function actionErrorMessage(result: GatewayActionResult): string {
  const error = result.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return "OpenClaw Feishu action failed";
}

function normalizeGroupEntries(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .filter((entry) => typeof entry.id === "string" && entry.id.startsWith("oc_"))
    .map((entry) => ({
      id: entry.id,
      target: `chat:${entry.id}`,
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
    }));
}

function normalizePeerEntries(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .filter((entry) => typeof entry.id === "string" && entry.id.startsWith("ou_"))
    .map((entry) => ({
      openId: entry.id,
      target: `user:${entry.id}`,
      mention: {
        openId: entry.id,
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      },
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
    }));
}

function normalizeMembers(raw: unknown): {
  members: Array<Record<string, unknown>>;
  hasMore: boolean;
  pageToken?: string;
} {
  const outer = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const nested = outer.members;
  const container =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : outer;
  const list = Array.isArray(container.members) ? container.members : [];
  const members = list
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .filter((entry) => typeof entry.member_id === "string" && entry.member_id.startsWith("ou_"))
    .map((entry) => {
      const openId = entry.member_id as string;
      const name = typeof entry.name === "string" ? entry.name : undefined;
      return {
        openId,
        target: `user:${openId}`,
        mention: { openId, ...(name ? { name } : {}) },
        ...(name ? { name } : {}),
      };
    });
  const pageToken = typeof container.page_token === "string" && container.page_token.trim()
    ? container.page_token.trim()
    : undefined;
  return {
    members,
    hasMore: container.has_more === true,
    ...(pageToken ? { pageToken } : {}),
  };
}

function createDefaultDeps(config: FeishuConfig): FeishuBackendDeps {
  return {
    getAccountStatus: async (signal) => {
      const status = await requestOpenClawGateway<ChannelsStatus>({
        gatewayUrl: config.gatewayUrl,
        requestTimeoutMs: config.requestTimeoutMs,
        clientDisplayName: "ChatGPT Web Agent Feishu Identity",
        scopes: ["operator.read"],
        method: "channels.status",
        params: { channel: "feishu" },
        signal,
      });
      return status.channelAccounts?.feishu?.find((account) => account.accountId === config.accountId);
    },
    requestAction: async (action, params, signal) =>
      requestOpenClawGateway<GatewayActionResult>({
        gatewayUrl: config.gatewayUrl,
        requestTimeoutMs: config.requestTimeoutMs,
        clientDisplayName: "ChatGPT Web Agent Feishu",
        scopes: ["operator.read", "operator.write"],
        method: "message.action",
        params: {
          channel: "feishu",
          action,
          params,
          accountId: config.accountId,
          agentId: config.agentId,
          idempotencyKey: randomUUID(),
        },
        signal,
      }),
  };
}

export class FeishuBackend implements LocalToolBackend {
  readonly id = "feishu";
  readonly #config: FeishuConfig;
  readonly #deps: FeishuBackendDeps;

  constructor(config: FeishuConfig, deps: FeishuBackendDeps = createDefaultDeps(config)) {
    this.#config = config;
    this.#deps = deps;
  }

  async listTools(): Promise<LocalToolDescriptor[]> {
    return [
      {
        name: "feishu_message",
        title: "Feishu Message",
        description:
          "Send one outbound Feishu message as the fixed ChatGPT Web Agent bot. Target is always explicit; the caller cannot choose the sending account. Supports text, real @mentions by open_id, and one workspace-scoped local image/file/audio attachment (audio can be sent as voice).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["target"],
          properties: {
            target: {
              type: "string",
              pattern: "^(chat:oc_[A-Za-z0-9_-]+|user:ou_[A-Za-z0-9_-]+)$",
              description: "Explicit Feishu destination: chat:oc_... for a group or user:ou_... for a person.",
            },
            message: { type: "string", description: "Optional text body." },
            mentions: {
              type: "array",
              maxItems: 20,
              description: "Users to @mention. Use feishu_directory to discover open_id values.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["openId"],
                properties: {
                  openId: { type: "string", pattern: "^ou_[A-Za-z0-9_-]+$" },
                  name: { type: "string" },
                },
              },
            },
            mediaPath: {
              type: "string",
              description:
                "Optional local image/file/audio path. Relative paths resolve under the configured Feishu media root; by default paths cannot escape it.",
            },
            asVoice: {
              type: "boolean",
              description: "Send an audio attachment as a Feishu voice message. Requires mediaPath.",
            },
          },
        },
      },
      {
        name: "feishu_directory",
        title: "Feishu Directory",
        description:
          "Discover Feishu groups, people, or members visible to the fixed ChatGPT Web Agent bot. Results include ready-to-use explicit targets and mention objects.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind: { type: "string", enum: ["groups", "peers", "members"] },
            query: {
              type: "string",
              description: "Optional name query for groups or peers.",
            },
            target: {
              type: "string",
              pattern: "^chat:oc_[A-Za-z0-9_-]+$",
              description: "Required for kind=members; explicit group target.",
            },
            limit: {
              type: "integer",
              minimum: 1,
              description: "Maximum entries requested from OpenClaw.",
            },
            pageToken: {
              type: "string",
              description: "Optional continuation token for kind=members.",
            },
          },
        },
      },
    ];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<CallToolResult> {
    try {
      if (name === "feishu_message") {
        return await this.#sendMessage(args, context.signal);
      }
      if (name === "feishu_directory") {
        return await this.#directory(args, context.signal);
      }
      return toolError(`Tool not available: ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`${name} failed: ${message}`);
    }
  }

  async #sendMessage(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const target = validateTarget(stringArg(args, "target", true)!);
    const message = stringArg(args, "message");
    const mentions = parseMentions(args);
    const mediaPath = stringArg(args, "mediaPath");
    const asVoice = booleanArg(args, "asVoice", false);
    if (!message && !mediaPath) {
      throw new Error("message or mediaPath is required");
    }
    if (asVoice && !mediaPath) {
      throw new Error("asVoice requires mediaPath");
    }
    await this.#assertFixedIdentity(signal);

    const mentionPrefix = renderMentionPrefix(mentions);
    const outgoingText = [mentionPrefix, message].filter(Boolean).join(" ");
    const actionParams: Record<string, unknown> = { target };
    if (outgoingText) {
      actionParams.message = outgoingText;
    }
    if (mediaPath) {
      actionParams.media = await resolveMediaPath(this.#config, mediaPath);
    }
    if (asVoice) {
      actionParams.asVoice = true;
    }

    const result = await this.#deps.requestAction("send", actionParams, signal);
    if (result.ok === false) {
      throw new Error(actionErrorMessage(result));
    }
    const compact: Record<string, unknown> = {
      ok: true,
      channel: "feishu",
      sender: {
        agentId: this.#config.agentId,
        accountId: this.#config.accountId,
      },
      target,
      ...(mentions.length ? { mentions } : {}),
      ...(mediaPath ? { media: { path: mediaPath, asVoice } } : {}),
    };
    for (const key of ["messageId", "chatId", "action", "receipt"] as const) {
      if (result[key] !== undefined) {
        compact[key] = result[key];
      }
    }
    return jsonResult(compact);
  }

  async #directory(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const kind = enumArg(args, "kind", ["groups", "peers", "members"] as const, "groups");
    const limit = integerArg(
      args,
      "limit",
      this.#config.defaultDirectoryLimit,
      1,
      this.#config.maxDirectoryLimit,
    );
    const query = stringArg(args, "query");
    if (kind === "members") {
      if (query) {
        throw new Error("query is not supported for kind=members; filter returned members locally");
      }
      const target = stringArg(args, "target", true)!;
      const chatId = validateChatTarget(target);
      const pageToken = stringArg(args, "pageToken");
      await this.#assertFixedIdentity(signal);
      const result = await this.#deps.requestAction(
        "member-info",
        {
          chatId,
          pageSize: limit,
          ...(pageToken ? { pageToken } : {}),
        },
        signal,
      );
      if (result.ok === false) {
        throw new Error(actionErrorMessage(result));
      }
      const normalized = normalizeMembers(result);
      return jsonResult({
        kind,
        accountId: this.#config.accountId,
        target,
        count: normalized.members.length,
        ...normalized,
      });
    }

    if (stringArg(args, "target")) {
      throw new Error("target is only supported for kind=members");
    }
    if (stringArg(args, "pageToken")) {
      throw new Error("pageToken is only supported for kind=members");
    }
    await this.#assertFixedIdentity(signal);
    const result = await this.#deps.requestAction(
      "channel-list",
      { scope: kind, limit, ...(query ? { query } : {}) },
      signal,
    );
    if (result.ok === false) {
      throw new Error(actionErrorMessage(result));
    }
    const entries = kind === "groups" ? normalizeGroupEntries(result.groups) : normalizePeerEntries(result.peers);
    return jsonResult({
      kind,
      accountId: this.#config.accountId,
      count: entries.length,
      entries,
    });
  }

  async #assertFixedIdentity(signal?: AbortSignal): Promise<void> {
    const account = await this.#deps.getAccountStatus(signal);
    if (!account || account.accountId !== this.#config.accountId) {
      throw new Error(
        `fixed Feishu account "${this.#config.accountId}" is not configured; refusing to fall back to another account`,
      );
    }
    if (account.configured !== true) {
      throw new Error(`fixed Feishu account "${this.#config.accountId}" is present but not configured`);
    }
    if (account.enabled === false) {
      throw new Error(`fixed Feishu account "${this.#config.accountId}" is disabled`);
    }
  }
}
