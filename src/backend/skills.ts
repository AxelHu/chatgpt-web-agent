import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SkillsConfig } from "../config.js";
import { requestOpenClawGateway } from "../gateway.js";
import { toolError } from "../result.js";
import type { LocalToolBackend, LocalToolDescriptor, ToolCallContext } from "./types.js";

type SkillStatusEntry = {
  name: string;
  description: string;
  source?: string;
  skillKey?: string;
  filePath?: string;
  eligible?: boolean;
  modelVisible?: boolean;
  disabled?: boolean;
};

type SkillsStatus = {
  workspaceDir?: string;
  skills: SkillStatusEntry[];
};

type VisibleSkill = {
  name: string;
  description: string;
  source: string;
  skillKey: string;
  filePath: string;
};

type CatalogManifest = {
  schema: "chatgpt-web-agent.skills-catalog.v3";
  inventoryHash: string;
  catalogHash: string;
  files: Record<string, string>;
};

type SemanticHit = {
  file?: string;
  score?: number;
};

export type SkillsBackendDeps = {
  fetchStatus: (signal?: AbortSignal) => Promise<SkillsStatus>;
  semanticSearch: (
    query: string,
    limit: number,
    signal?: AbortSignal,
  ) => Promise<SemanticHit[]>;
};

function jsonResult(data: Record<string, unknown>, text?: string): CallToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(data, null, 2) }],
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

function visibleSkills(status: SkillsStatus): VisibleSkill[] {
  return status.skills
    .filter(
      (skill) =>
        skill.eligible === true &&
        skill.modelVisible === true &&
        skill.disabled !== true &&
        typeof skill.name === "string" &&
        typeof skill.description === "string" &&
        typeof skill.filePath === "string",
    )
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source ?? "unknown",
      skillKey: skill.skillKey ?? skill.name,
      filePath: skill.filePath!,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
}

function inventoryHash(skills: VisibleSkill[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        skills.map(({ name, description, source, skillKey }) => ({
          name,
          description,
          source,
          skillKey,
        })),
      ),
    )
    .digest("hex");
}

function catalogHash(inventoryFingerprint: string): string {
  return createHash("sha256")
    .update(`chatgpt-web-agent.skills-catalog.v3\n${inventoryFingerprint}`)
    .digest("hex");
}

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "skill";
}

function catalogFilename(skill: VisibleSkill, fingerprint: string): string {
  const identity = createHash("sha256")
    .update(`${skill.skillKey}\n${skill.name}`)
    .digest("hex")
    .slice(0, 10);
  // QMD normalizes repeated punctuation in virtual display paths. Keep separators
  // single so the on-disk filename and the search result path remain identical.
  return `${safeSlug(skill.name)}-${fingerprint.slice(0, 10)}-${identity}.md`;
}

function catalogDocument(skill: VisibleSkill): string {
  return [
    `# ${skill.name}`,
    "",
    skill.description.trim(),
    "",
    `- skillKey: \`${skill.skillKey}\``,
    `- source: \`${skill.source}\``,
    "",
  ].join("\n");
}

function qmdHitFilename(file: string | undefined): string | undefined {
  if (!file) {
    return undefined;
  }
  try {
    if (file.startsWith("qmd://")) {
      const parsed = new URL(file);
      return decodeURIComponent(path.posix.basename(parsed.pathname));
    }
  } catch {
    // Fall through to conservative basename extraction.
  }
  return path.basename(file);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[chatgpt-web-agent truncated ${text.length - maxChars} characters]`;
}

async function fetchStatusFromGateway(config: SkillsConfig, signal?: AbortSignal): Promise<SkillsStatus> {
  const result = await requestOpenClawGateway<SkillsStatus>({
    gatewayUrl: config.gatewayUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    clientDisplayName: "ChatGPT Web Agent Skills",
    scopes: ["operator.read"],
    method: "skills.status",
    params: { agentId: config.agentId },
    signal,
  });
  if (!result || !Array.isArray(result.skills)) {
    throw new Error("gateway returned an invalid skills.status payload");
  }
  return result;
}

async function semanticSearchQmd(
  config: SkillsConfig,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SemanticHit[]> {
  if (!config.qmdUrl) {
    throw new Error("semantic Skill discovery is not configured");
  }
  const client = new Client({ name: "chatgpt-web-agent-skills", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(config.qmdUrl));
  try {
    await client.connect(transport, { signal, timeout: config.requestTimeoutMs });
    const result = await client.callTool(
      {
        name: "query",
        arguments: {
          searches: [{ type: "vec", query }],
          collections: [config.qmdCollection],
          limit,
          candidateLimit: Math.max(limit, 12),
          rerank: false,
        },
      },
      undefined,
      { signal, timeout: config.requestTimeoutMs },
    );
    if (result.isError) {
      throw new Error("QMD query tool returned an error");
    }
    const structured = result.structuredContent as { results?: unknown } | undefined;
    if (!Array.isArray(structured?.results)) {
      return [];
    }
    return structured.results
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((item) => ({
        file: typeof item.file === "string" ? item.file : undefined,
        score: typeof item.score === "number" ? item.score : undefined,
      }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

export class SkillsBackend implements LocalToolBackend {
  readonly id = "skills";
  readonly #config: SkillsConfig;
  readonly #maxOutputChars: number;
  readonly #deps: SkillsBackendDeps;

  constructor(
    config: SkillsConfig,
    maxOutputChars: number,
    deps?: Partial<SkillsBackendDeps>,
  ) {
    this.#config = config;
    this.#maxOutputChars = maxOutputChars;
    this.#deps = {
      fetchStatus: deps?.fetchStatus ?? ((signal) => fetchStatusFromGateway(config, signal)),
      semanticSearch:
        deps?.semanticSearch ??
        ((query, limit, signal) => semanticSearchQmd(config, query, limit, signal)),
    };
  }

  async listTools(): Promise<LocalToolDescriptor[]> {
    return [
      {
        name: "skills_list",
        description:
          "Discover local OpenClaw Skills available to ChatGPT Web. Pass a natural-language task description in query to get a small semantic top-k with descriptions. Without query, returns the compact names-only live catalog. Only currently eligible and model-visible Skills are surfaced.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural-language task or capability to discover." },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: this.#config.maxLimit,
              description: `Maximum semantic candidates; defaults to ${this.#config.defaultLimit}.`,
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "skill_read",
        description:
          "Read one currently eligible/model-visible OpenClaw Skill by its name or skillKey. Use after skills_list identifies a likely match. This tool does not accept filesystem paths.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
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
      switch (name) {
        case "skills_list":
          return await this.#list(args, context.signal);
        case "skill_read":
          return await this.#read(args, context.signal);
        default:
          return toolError(`Tool not available: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`${name} failed: ${message}`);
    }
  }

  async #list(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const query = stringArg(args, "query");
    const limit = integerArg(
      args,
      "limit",
      this.#config.defaultLimit,
      1,
      this.#config.maxLimit,
    );
    const live = visibleSkills(await this.#deps.fetchStatus(signal));
    if (!query) {
      const names = live.map((skill) => skill.name);
      return jsonResult(
        { mode: "catalog", count: names.length, skills: names.map((name) => ({ name })) },
        names.join("\n"),
      );
    }

    try {
      const manifest = await this.#ensureCatalog(live);
      const hits = await this.#deps.semanticSearch(query, limit, signal);
      const byKey = new Map(live.map((skill) => [skill.skillKey, skill]));
      const selected: VisibleSkill[] = [];
      const seen = new Set<string>();
      for (const hit of hits) {
        const filename = qmdHitFilename(hit.file);
        const skillKey = filename ? manifest.files[filename] : undefined;
        const skill = skillKey ? byKey.get(skillKey) : undefined;
        if (!skill || seen.has(skill.skillKey)) {
          continue;
        }
        seen.add(skill.skillKey);
        selected.push(skill);
        if (selected.length >= limit) {
          break;
        }
      }
      if (selected.length > 0) {
        const publicSkills = selected.map(({ name, description, source, skillKey }) => ({
          name,
          description,
          source,
          skillKey,
        }));
        const text = publicSkills
          .map((skill, index) => `${index + 1}. ${skill.name}\n${skill.description}`)
          .join("\n\n");
        return jsonResult(
          { mode: "semantic", query, count: publicSkills.length, skills: publicSkills },
          text,
        );
      }
    } catch {
      // Semantic discovery is an accelerator. Live names-only discovery is the safe degraded path.
    }

    const names = live.map((skill) => skill.name);
    return jsonResult(
      {
        mode: "fallback_catalog",
        query,
        count: names.length,
        skills: names.map((name) => ({ name })),
      },
      names.join("\n"),
    );
  }

  async #read(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const requested = stringArg(args, "name", true)!;
    const normalized = requested.toLowerCase();
    const live = visibleSkills(await this.#deps.fetchStatus(signal));
    const exact = live.filter(
      (skill) => skill.name === requested || skill.skillKey === requested,
    );
    const matches =
      exact.length > 0
        ? exact
        : live.filter(
            (skill) => skill.name.toLowerCase() === normalized || skill.skillKey.toLowerCase() === normalized,
          );
    if (matches.length === 0) {
      throw new Error(`Skill is not currently eligible/model-visible: ${requested}`);
    }
    if (matches.length > 1) {
      throw new Error(`Skill name is ambiguous: ${requested}`);
    }
    const skill = matches[0]!;
    const stat = await fs.stat(skill.filePath);
    if (!stat.isFile() || path.basename(skill.filePath) !== "SKILL.md") {
      throw new Error(`OpenClaw returned an invalid Skill file for ${skill.name}`);
    }
    if (stat.size > this.#config.maxSkillFileBytes) {
      throw new Error(
        `Skill file is too large (${stat.size} bytes; limit ${this.#config.maxSkillFileBytes})`,
      );
    }
    const content = await fs.readFile(skill.filePath, "utf8");
    return {
      content: [{ type: "text", text: truncateText(content, this.#maxOutputChars) }],
      structuredContent: {
        name: skill.name,
        skillKey: skill.skillKey,
        source: skill.source,
        bytes: stat.size,
      },
    };
  }

  async #ensureCatalog(skills: VisibleSkill[]): Promise<CatalogManifest> {
    await fs.mkdir(this.#config.catalogDir, { recursive: true });
    const inventoryFingerprint = inventoryHash(skills);
    const catalogFingerprint = catalogHash(inventoryFingerprint);
    const manifestPath = path.join(this.#config.catalogDir, ".manifest.json");
    try {
      const existing = JSON.parse(await fs.readFile(manifestPath, "utf8")) as CatalogManifest;
      if (
        existing.schema === "chatgpt-web-agent.skills-catalog.v3" &&
        existing.inventoryHash === inventoryFingerprint &&
        existing.catalogHash === catalogFingerprint &&
        Object.keys(existing.files).length === skills.length
      ) {
        const checks = await Promise.all(
          Object.keys(existing.files).map((file) =>
            fs.stat(path.join(this.#config.catalogDir, file)).then(
              (stat) => stat.isFile(),
              () => false,
            ),
          ),
        );
        if (checks.every(Boolean)) {
          return existing;
        }
      }
    } catch {
      // Missing or stale manifest: rebuild below.
    }

    const files: Record<string, string> = {};
    const desired = new Set<string>();
    for (const skill of skills) {
      const filename = catalogFilename(skill, catalogFingerprint);
      desired.add(filename);
      files[filename] = skill.skillKey;
      const target = path.join(this.#config.catalogDir, filename);
      const temporary = `${target}.tmp-${process.pid}`;
      await fs.writeFile(temporary, catalogDocument(skill), "utf8");
      await fs.rename(temporary, target);
    }

    for (const entry of await fs.readdir(this.#config.catalogDir, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        entry.name !== ".gitkeep" &&
        !desired.has(entry.name)
      ) {
        await fs.rm(path.join(this.#config.catalogDir, entry.name), { force: true });
      }
    }

    const manifest: CatalogManifest = {
      schema: "chatgpt-web-agent.skills-catalog.v3",
      inventoryHash: inventoryFingerprint,
      catalogHash: catalogFingerprint,
      files,
    };
    const temporaryManifest = `${manifestPath}.tmp-${process.pid}`;
    await fs.writeFile(temporaryManifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await fs.rename(temporaryManifest, manifestPath);
    return manifest;
  }
}
