import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import { promises as fs } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import ipaddr from "ipaddr.js";
import { Webhook } from "standardwebhooks";

export const CONTINUE_EVENT_NAME = "workflow.continue";

export const EVENT_DEFINITIONS = [
  {
    name: CONTINUE_EVENT_NAME,
    description:
      "A local workflow is ready for ChatGPT to continue work in the subscribed chat. " +
      "Use a stable topic to bind a continuation stream to one project, task, or research thread.",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Stable continuation topic, for example light-alchemy:item-expansion.",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        trigger_reason: {
          type: "string",
          description: "Data describing why the local workflow became ready to continue.",
        },
        summary: {
          type: "string",
          description: "Small state summary. Large state should be fetched with normal MCP tools.",
        },
        state_ref: {
          type: "string",
          description: "Optional durable local reference such as a process session, checkpoint, or repo path.",
        },
        source: {
          type: "string",
          description: "Optional producer label such as process, timer, codex, git, or research.",
        },
        sequence: {
          type: "integer",
          minimum: 0,
          description: "Optional producer sequence number for ordering or deduplication.",
        },
      },
      required: ["topic", "trigger_reason"],
      additionalProperties: false,
    },
  },
] as const;

export type ContinueEventData = {
  topic: string;
  trigger_reason: string;
  summary?: string;
  state_ref?: string;
  source?: string;
  sequence?: number;
};

export type EventDelivery = {
  mode: "webhook";
  url: string;
  secret: string;
};

export type EventSubscription = {
  id: string;
  owner: string;
  name: string;
  arguments: Record<string, unknown>;
  delivery: EventDelivery;
  createdAt: string;
  updatedAt: string;
  refreshBefore: string | null;
};

type EventStoreFile = {
  version: 1;
  subscriptions: EventSubscription[];
};

export type SubscribeRequest = {
  name: string;
  arguments?: Record<string, unknown>;
  delivery: EventDelivery;
  cursor?: string | null;
  ttlMs?: number | null;
};

export type UnsubscribeRequest = {
  name: string;
  arguments?: Record<string, unknown>;
  delivery: Pick<EventDelivery, "mode" | "url">;
};

export type EventDeliveryResponse = {
  ok: boolean;
  status: number;
  body: string;
};

export type EventWebhookSender = (
  subscription: EventSubscription,
  body: string,
  headers: Record<string, string>,
) => Promise<EventDeliveryResponse>;

export type EventRuntimeOptions = {
  storePath?: string;
  sender?: EventWebhookSender;
  validateCallback?: (url: string) => Promise<void>;
  now?: () => Date;
};

function defaultStorePath(): string {
  const explicit = process.env.CHATGPT_WEB_AGENT_EVENT_STORE?.trim();
  if (explicit) return path.resolve(explicit);
  const stateHome = process.env.XDG_STATE_HOME?.trim();
  return path.join(stateHome ? path.resolve(stateHome) : path.join(os.homedir(), ".local", "state"), "chatgpt-web-agent", "events.json");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
  return `{${entries.join(",")}}`;
}

function deterministicSubscriptionId(
  owner: string,
  callbackUrl: string,
  name: string,
  args: Record<string, unknown>,
): string {
  const digest = createHash("sha256")
    .update(owner)
    .update("\n")
    .update(callbackUrl)
    .update("\n")
    .update(name)
    .update("\n")
    .update(canonicalJson(args))
    .digest("hex");
  return `sub_${digest.slice(0, 32)}`;
}

function validateSecret(secret: string): void {
  if (!secret.startsWith("whsec_")) throw new Error("webhook secret must start with whsec_");
  let decoded: Buffer;
  try {
    decoded = Buffer.from(secret.slice("whsec_".length), "base64");
  } catch {
    throw new Error("webhook secret is not valid base64");
  }
  if (decoded.length < 24 || decoded.length > 64) {
    throw new Error("webhook secret must decode to 24-64 bytes");
  }
}

function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === "unicast";
  } catch {
    return false;
  }
}

async function resolvePublicCallback(urlValue: string): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
  const url = new URL(urlValue);
  if (url.protocol !== "https:") throw new Error("callback URL must use https");
  if (url.username || url.password) throw new Error("callback URL must not contain credentials");
  if (url.hash) throw new Error("callback URL must not contain a fragment");
  const literal = ipaddr.isValid(url.hostname.replace(/^\[|\]$/g, ""));
  const addresses = literal
    ? [{ address: url.hostname.replace(/^\[|\]$/g, ""), family: ipaddr.parse(url.hostname.replace(/^\[|\]$/g, "")).kind() === "ipv4" ? 4 : 6 }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("callback URL resolves to a non-public address");
  }
  return { url, addresses };
}

async function pinnedHttpsPost(
  urlValue: string,
  body: string,
  headers: Record<string, string>,
): Promise<EventDeliveryResponse> {
  const { url, addresses } = await resolvePublicCallback(urlValue);
  let lastError: unknown;
  for (const target of addresses) {
    try {
      return await new Promise<EventDeliveryResponse>((resolve, reject) => {
        const request = https.request(
          {
            protocol: "https:",
            hostname: url.hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method: "POST",
            servername: url.hostname,
            headers: {
              ...headers,
              "content-length": String(Buffer.byteLength(body, "utf8")),
            },
            lookup: ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
              callback(null, target.address, target.family);
            }) as never,
            timeout: 10_000,
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            response.on("end", () => {
              const status = response.statusCode ?? 0;
              resolve({
                ok: status >= 200 && status < 300,
                status,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
          },
        );
        request.on("timeout", () => request.destroy(new Error("callback timeout")));
        request.on("error", reject);
        request.end(body);
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("callback delivery failed");
}

async function readStore(storePath: string): Promise<EventStoreFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(storePath, "utf8")) as Partial<EventStoreFile>;
    return {
      version: 1,
      subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions as EventSubscription[] : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, subscriptions: [] };
    throw error;
  }
}

async function writeStore(storePath: string, store: EventStoreFile): Promise<void> {
  const dir = path.dirname(storePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, storePath);
  await fs.chmod(storePath, 0o600);
}

function parseTopic(args: Record<string, unknown>): string {
  if (Object.keys(args).some((key) => key !== "topic")) throw new Error("workflow.continue only accepts the topic filter");
  const topic = args.topic;
  if (typeof topic !== "string" || topic.trim().length === 0 || topic.length > 200) {
    throw new Error("workflow.continue requires a non-empty topic no longer than 200 characters");
  }
  return topic;
}

function validateEventName(name: string): void {
  if (name !== CONTINUE_EVENT_NAME) throw new Error(`unsupported event: ${name}`);
}

function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class EventRuntime {
  readonly storePath: string;
  readonly sender: EventWebhookSender;
  readonly validateCallback: (url: string) => Promise<void>;
  readonly now: () => Date;

  constructor(options: EventRuntimeOptions = {}) {
    this.storePath = options.storePath ?? defaultStorePath();
    this.sender = options.sender ?? (async (subscription, body, headers) =>
      pinnedHttpsPost(subscription.delivery.url, body, headers));
    this.validateCallback = options.validateCallback ?? (async (url) => {
      await resolvePublicCallback(url);
    });
    this.now = options.now ?? (() => new Date());
  }

  list() {
    return { events: EVENT_DEFINITIONS };
  }

  async subscribe(owner: string, request: SubscribeRequest) {
    validateEventName(request.name);
    const args = request.arguments ?? {};
    parseTopic(args);
    if (request.delivery?.mode !== "webhook") throw new Error("only webhook delivery is supported");
    validateSecret(request.delivery.secret);
    await this.validateCallback(request.delivery.url);

    const id = deterministicSubscriptionId(owner, request.delivery.url, request.name, args);
    const verificationId = `msg_verification_${randomUUID()}`;
    const challenge = randomUUID();
    const verificationBody = JSON.stringify({ type: "verification", challenge });
    const signedAt = this.now();
    const signer = new Webhook(request.delivery.secret);
    const verification = await this.sender(
      {
        id,
        owner,
        name: request.name,
        arguments: args,
        delivery: request.delivery,
        createdAt: signedAt.toISOString(),
        updatedAt: signedAt.toISOString(),
        refreshBefore: null,
      },
      verificationBody,
      {
        "content-type": "application/json",
        "webhook-id": verificationId,
        "webhook-timestamp": String(Math.floor(signedAt.getTime() / 1000)),
        "webhook-signature": signer.sign(verificationId, signedAt, verificationBody),
        "X-MCP-Subscription-Id": id,
      },
    );
    if (!verification.ok) throw new Error(`callback verification returned HTTP ${verification.status}`);
    let echoed: unknown;
    try {
      echoed = JSON.parse(verification.body);
    } catch {
      throw new Error("callback verification returned invalid JSON");
    }
    const echoedChallenge = (echoed as { challenge?: unknown })?.challenge;
    if (typeof echoedChallenge !== "string" || !safeEqualText(echoedChallenge, challenge)) {
      throw new Error("callback verification challenge mismatch");
    }

    const requestedTtl = request.ttlMs;
    const now = this.now();
    const refreshBefore = requestedTtl === null
      ? null
      : new Date(now.getTime() + Math.max(60_000, requestedTtl ?? 30 * 24 * 60 * 60 * 1000)).toISOString();
    const store = await readStore(this.storePath);
    const existing = store.subscriptions.find((entry) => entry.id === id);
    const next: EventSubscription = {
      id,
      owner,
      name: request.name,
      arguments: args,
      delivery: request.delivery,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      refreshBefore,
    };
    store.subscriptions = [...store.subscriptions.filter((entry) => entry.id !== id), next];
    await writeStore(this.storePath, store);
    return { id, refreshBefore, cursor: null, truncated: false };
  }

  async unsubscribe(owner: string, request: UnsubscribeRequest): Promise<Record<string, never>> {
    validateEventName(request.name);
    const args = request.arguments ?? {};
    parseTopic(args);
    if (request.delivery?.mode !== "webhook") throw new Error("only webhook delivery is supported");
    const id = deterministicSubscriptionId(owner, request.delivery.url, request.name, args);
    const store = await readStore(this.storePath);
    store.subscriptions = store.subscriptions.filter((entry) => entry.id !== id || entry.owner !== owner);
    await writeStore(this.storePath, store);
    return {};
  }

  async subscriptions(): Promise<EventSubscription[]> {
    const store = await readStore(this.storePath);
    return store.subscriptions;
  }

  async emitContinue(data: ContinueEventData): Promise<{
    eventId: string;
    matched: number;
    delivered: number;
    failed: Array<{ subscriptionId: string; status?: number; error?: string }>;
  }> {
    parseTopic({ topic: data.topic });
    if (typeof data.trigger_reason !== "string" || data.trigger_reason.trim().length === 0) {
      throw new Error("trigger_reason is required");
    }
    const eventId = `evt_${randomUUID()}`;
    const timestamp = this.now().toISOString();
    const eventBody = JSON.stringify({
      eventId,
      name: CONTINUE_EVENT_NAME,
      timestamp,
      data,
      cursor: null,
    });
    if (Buffer.byteLength(eventBody, "utf8") > 256 * 1024) {
      throw new Error("event payload exceeds 256 KiB");
    }

    const store = await readStore(this.storePath);
    const nowMs = this.now().getTime();
    const active = store.subscriptions.filter((entry) =>
      entry.name === CONTINUE_EVENT_NAME &&
      entry.arguments.topic === data.topic &&
      (entry.refreshBefore === null || Date.parse(entry.refreshBefore) > nowMs));
    const failed: Array<{ subscriptionId: string; status?: number; error?: string }> = [];
    let delivered = 0;

    for (const subscription of active) {
      const signer = new Webhook(subscription.delivery.secret);
      let deliveredThisSubscription = false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const signedAt = this.now();
        try {
          const response = await this.sender(subscription, eventBody, {
            "content-type": "application/json",
            "webhook-id": eventId,
            "webhook-timestamp": String(Math.floor(signedAt.getTime() / 1000)),
            "webhook-signature": signer.sign(eventId, signedAt, eventBody),
            "X-MCP-Subscription-Id": subscription.id,
          });
          if (response.ok) {
            delivered += 1;
            deliveredThisSubscription = true;
            break;
          }
          if (response.status === 410 || response.status === 413 || response.status < 500) {
            failed.push({ subscriptionId: subscription.id, status: response.status });
            break;
          }
          if (attempt === 3) failed.push({ subscriptionId: subscription.id, status: response.status });
        } catch (error) {
          if (attempt === 3) {
            failed.push({
              subscriptionId: subscription.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (!deliveredThisSubscription && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
        }
      }
    }

    return { eventId, matched: active.length, delivered, failed };
  }
}

