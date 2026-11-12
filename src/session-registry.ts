import os from "node:os";
import path from "node:path";
import { StateDatabase } from "./state-db.js";

export type SessionRecord = {
  clientSessionKey: string;
  name: string;
  firstRegisteredAt: string;
  lastRegisteredAt: string;
  lastRequest?: { callId: string; tool: string; receivedAt: string };
  lastResult?: {
    callId: string;
    tool: string;
    completedAt: string;
    ok: boolean;
    durationMs: number;
    errorKind?: string;
  };
};

const BUCKET = "sessions";
const KEY_PATTERN = /^v1:[0-9a-f]{16}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function validateKey(key: string): void {
  if (typeof key !== "string" || key.length !== 19 || !KEY_PATTERN.test(key)) {
    throw new Error("Invalid client session key: expected v1: followed by 16 lowercase hexadecimal characters");
  }
}

function normalizedName(name: string): string {
  if (typeof name !== "string" || CONTROL_CHARACTERS.test(name)) {
    throw new Error("Invalid session name: control characters are not allowed");
  }
  const normalized = name.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error("Invalid session name: expected 1 to 200 characters after trimming");
  }
  return normalized;
}

function defaultStorePath(): string {
  return process.env.CHATGPT_WEB_AGENT_SESSION_STORE || path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    "chatgpt-web-agent",
    "sessions.sqlite",
  );
}

function lastActivityAt(record: SessionRecord): string {
  const receivedAt = record.lastRequest?.receivedAt;
  return receivedAt && receivedAt > record.lastRegisteredAt ? receivedAt : record.lastRegisteredAt;
}

/** Persistent labels and reconstructable activity summaries, keyed only by a
 * previously hashed client identity. WAL/NORMAL preserves normal frontend
 * restarts without forcing a disk sync on every observation; the last committed
 * summary is not guaranteed across power loss. Results are recorded separately:
 * finishing a background task is not evidence of a new request from the chat. */
export class SessionRegistry {
  readonly storePath: string;
  readonly #db: StateDatabase;
  readonly #ownsDb: boolean;
  readonly #now: () => Date;

  constructor(options: { storePath?: string; db?: StateDatabase; now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#ownsDb = options.db === undefined;
    this.storePath = options.db?.filename ?? path.resolve(options.storePath ?? defaultStorePath());
    // Observation runs on the normal tool path. Do not synchronously wait for
    // another writer; the frontend can degrade immediately on a busy store.
    this.#db = options.db ?? new StateDatabase(this.storePath, { busyTimeoutMs: 0, synchronous: "NORMAL" });
  }

  register(key: string, name: string): SessionRecord {
    validateKey(key);
    const label = normalizedName(name);
    return this.#db.atomic(() => {
      const previous = this.#db.get<SessionRecord>(BUCKET, key);
      const now = this.#now().toISOString();
      const record: SessionRecord = {
        ...previous,
        clientSessionKey: key,
        name: label,
        firstRegisteredAt: previous?.firstRegisteredAt ?? now,
        lastRegisteredAt: now,
      };
      this.#db.put(BUCKET, key, record);
      return record;
    });
  }

  get(key: string): SessionRecord | undefined {
    validateKey(key);
    return this.#db.get<SessionRecord>(BUCKET, key);
  }

  list(limit = 50, name?: string): SessionRecord[] {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Session limit must be a positive integer");
    return this.#db.all<SessionRecord>(BUCKET)
      .filter(record => name === undefined || record.name === name)
      .sort((a, b) => {
        const activityA = lastActivityAt(a), activityB = lastActivityAt(b);
        if (activityA !== activityB) return activityA > activityB ? -1 : 1;
        return a.clientSessionKey < b.clientSessionKey ? -1 : a.clientSessionKey > b.clientSessionKey ? 1 : 0;
      })
      .slice(0, Math.min(limit, 200));
  }

  requestStarted(key: string, callId: string, tool: string): SessionRecord | undefined {
    validateKey(key);
    return this.#db.atomic(() => {
      const record = this.#db.get<SessionRecord>(BUCKET, key);
      if (!record) return undefined;
      record.lastRequest = { callId, tool, receivedAt: this.#now().toISOString() };
      this.#db.put(BUCKET, key, record);
      return record;
    });
  }

  requestFinished(key: string, callId: string, tool: string, ok: boolean, durationMs: number, errorKind?: string): void {
    validateKey(key);
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new RangeError("Request duration must be a finite, non-negative number");
    }
    this.#db.atomic(() => {
      const record = this.#db.get<SessionRecord>(BUCKET, key);
      if (!record) return;
      record.lastResult = {
        callId,
        tool,
        completedAt: this.#now().toISOString(),
        ok,
        durationMs,
        ...(errorKind === undefined ? {} : { errorKind }),
      };
      this.#db.put(BUCKET, key, record);
    });
  }

  close(): void {
    // An injected database can be shared with another registry; its caller owns it.
    if (this.#ownsDb) this.#db.close();
  }
}
