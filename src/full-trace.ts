import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

export type FullTraceConfig = {
  enabled: boolean;
  directory: string;
  retentionDays: number;
  maxBytes: number;
};

export type FullTraceEvent = {
  phase: string;
  callId?: string;
  mcpRequestId?: string;
  tool?: string;
  backend?: string;
  durationMs?: number;
  ok?: boolean;
  payload?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
};

const SCHEMA_VERSION = 1;
const MAINTENANCE_INTERVAL_MS = 60_000;
const BASE64_OMIT_THRESHOLD = 4096;
const SECRET_KEY_RE = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|passphrase|secret|client[-_]?secret|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|runtime[-_]?api[-_]?key|private[-_]?key)$/i;
const SECRET_ENV_RE = /(?:^|_)(?:TOKEN|PASSWORD|PASSWD|PASSPHRASE|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET)(?:$|_)/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localIso(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const offsetRemainder = String(absolute % 60).padStart(2, "0");
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  const millisecond = String(date.getMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}${sign}${offsetHours}:${offsetRemainder}`;
}

function sha256(value: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function binaryDescriptor(value: string | Buffer | Uint8Array, encoding: string): Record<string, unknown> {
  return {
    omitted: true,
    kind: "binary",
    encoding,
    bytes: typeof value === "string" ? undefined : value.byteLength,
    chars: typeof value === "string" ? value.length : undefined,
    sha256: sha256(value),
  };
}

function redactSecretsInString(input: string): string {
  let value = input;
  value = value.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    "[REDACTED_PRIVATE_KEY]",
  );
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]");
  value = value.replace(/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, "Basic [REDACTED]");
  value = value.replace(
    /\b((?:[A-Za-z0-9_]*(?:TOKEN|PASSWORD|PASSWD|PASSPHRASE|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET)[A-Za-z0-9_]*)=)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
    "$1[REDACTED]",
  );
  value = value.replace(
    /(\s--(?:token|password|passwd|passphrase|secret|client-secret|api-key|access-token|refresh-token|private-key)\s+)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
    "$1[REDACTED]",
  );
  value = value.replace(
    /("(?:authorization|proxy-authorization|cookie|password|passwd|passphrase|secret|client_secret|api_key|access_token|refresh_token|id_token|token|private_key)"\s*:\s*")[^"]*(")/gi,
    "$1[REDACTED]$2",
  );
  value = value.replace(
    /(^|[\r\n])([ \t]*(?:authorization|proxy-authorization|cookie|password|passwd|passphrase|secret|client_secret|api_key|access_token|refresh_token|id_token|token|private_key)[ \t]*:[ \t]*)([^\r\n#]+)/gim,
    "$1$2[REDACTED]",
  );
  value = value.replace(
    /\b(Authorization|Proxy-Authorization|Cookie):\s*([^\r\n'"`]+)/gi,
    "$1: [REDACTED]",
  );
  value = value.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[REDACTED]");
  value = value.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh_[REDACTED]");
  value = value.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "AIza[REDACTED]");
  value = value.replace(/\bya29\.[0-9A-Za-z._-]{16,}\b/g, "ya29.[REDACTED]");
  value = value.replace(/\b1\/\/[0-9A-Za-z._-]{16,}\b/g, "1//[REDACTED]");
  value = value.replace(
    /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g,
    "[REDACTED_JWT]",
  );
  value = value.replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, "$1[REDACTED]$2");
  return value;
}

function looksLikeBase64(value: string): boolean {
  return (
    value.length >= BASE64_OMIT_THRESHOLD &&
    value.length % 4 === 0 &&
    BASE64_RE.test(value)
  );
}

function sanitizeValue(value: unknown, key?: string, parent?: Record<string, unknown>): unknown {
  if (key && (SECRET_KEY_RE.test(key) || SECRET_ENV_RE.test(key))) return "[REDACTED]";
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return binaryDescriptor(value, "buffer");
  if (value instanceof Uint8Array) return binaryDescriptor(value, "uint8array");
  if (value instanceof Error) {
    const candidate = value as Error & { code?: unknown; cause?: unknown };
    return {
      name: candidate.name,
      message: redactSecretsInString(candidate.message),
      stack: candidate.stack ? redactSecretsInString(candidate.stack) : undefined,
      code: candidate.code,
      cause: candidate.cause === undefined ? undefined : sanitizeValue(candidate.cause),
    };
  }
  if (typeof value === "string") {
    if (parent?.type === "image" && key === "data") {
      return binaryDescriptor(value, "base64-image");
    }
    if (looksLikeBase64(value)) return binaryDescriptor(value, "base64");
    return redactSecretsInString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(source)) {
      result[entryKey] = sanitizeValue(entryValue, entryKey, source);
    }
    return result;
  }
  return String(value);
}

export function sanitizeFullTraceValue(value: unknown): unknown {
  return sanitizeValue(value);
}

type TraceFile = {
  file: string;
  dateKey: string;
  size: number;
  compressed: boolean;
};

function parseTraceFile(name: string): { dateKey: string; compressed: boolean } | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.zst)?$/.exec(name);
  if (!match) return undefined;
  return { dateKey: match[1]!, compressed: Boolean(match[2]) };
}

function dateKeyAgeMs(dateKey: string, now: Date): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  const fileDay = new Date(year!, month! - 1, day!).getTime();
  const currentDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return currentDay - fileDay;
}

/**
 * Full local diagnostic trace. It preserves request/response payloads and stage
 * boundaries, while narrowly removing credentials and large binary/base64
 * blobs. Active-day traces are plain JSONL for grep; older days are zstd
 * compressed and all files are bounded by age and total bytes.
 */
export class FullTrace {
  readonly #config: FullTraceConfig;
  readonly #source: string;
  #lastMaintenanceAt = 0;
  #lastErrorAt = 0;

  constructor(config: FullTraceConfig, source: string) {
    this.#config = config;
    this.#source = source;
    if (config.enabled) {
      const now = new Date();
      this.#maintain(now, path.join(config.directory, `${localDateKey(now)}.jsonl`));
    }
  }

  record(event: FullTraceEvent): void {
    if (!this.#config.enabled) return;
    const now = new Date();
    try {
      fs.mkdirSync(this.#config.directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.#config.directory, 0o700);
      const file = path.join(this.#config.directory, `${localDateKey(now)}.jsonl`);
      const line = `${JSON.stringify(
        sanitizeFullTraceValue({
          schema: SCHEMA_VERSION,
          time: now.toISOString(),
          localTime: localIso(now),
          source: this.#source,
          ...event,
        }),
      )}\n`;
      fs.appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(file, 0o600);
      const nowMs = now.getTime();
      if (nowMs - this.#lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS) {
        this.#maintain(now, file);
      }
    } catch (error) {
      const nowMs = Date.now();
      if (nowMs - this.#lastErrorAt >= MAINTENANCE_INTERVAL_MS) {
        this.#lastErrorAt = nowMs;
        const kind = error instanceof Error ? error.name || "Error" : typeof error;
        process.stderr.write(`[chatgpt-web-agent full-trace] ${kind}\n`);
      }
    }
  }

  #listFiles(): TraceFile[] {
    let names: string[] = [];
    try {
      fs.mkdirSync(this.#config.directory, { recursive: true, mode: 0o700 });
      names = fs.readdirSync(this.#config.directory);
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      const parsed = parseTraceFile(name);
      if (!parsed) return [];
      const file = path.join(this.#config.directory, name);
      try {
        return [{ file, ...parsed, size: fs.statSync(file).size }];
      } catch {
        return [];
      }
    });
  }

  #compressInactive(activeFile: string): void {
    for (const entry of this.#listFiles()) {
      if (entry.compressed || entry.file === activeFile) continue;
      const target = `${entry.file}.zst`;
      if (fs.existsSync(target)) {
        fs.rmSync(entry.file, { force: true });
        continue;
      }
      try {
        const compressed = zstdCompressSync(fs.readFileSync(entry.file));
        const temp = `${target}.tmp-${process.pid}`;
        fs.writeFileSync(temp, compressed, { mode: 0o600 });
        fs.renameSync(temp, target);
        fs.chmodSync(target, 0o600);
        fs.rmSync(entry.file, { force: true });
      } catch {
        // Compression is opportunistic. Retention still applies to the raw file.
      }
    }
  }

  #maintain(now: Date, activeFile: string): void {
    this.#lastMaintenanceAt = now.getTime();
    try {
      fs.mkdirSync(this.#config.directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.#config.directory, 0o700);
      this.#compressInactive(activeFile);
      const cutoffMs = this.#config.retentionDays * 24 * 60 * 60 * 1000;
      for (const entry of this.#listFiles()) {
        if (entry.file === activeFile) continue;
        if (dateKeyAgeMs(entry.dateKey, now) >= cutoffMs) {
          try {
            fs.rmSync(entry.file, { force: true });
          } catch {
            // Best effort.
          }
        }
      }

      const entries = this.#listFiles().sort((a, b) => a.dateKey.localeCompare(b.dateKey));
      let total = entries.reduce((sum, entry) => sum + entry.size, 0);
      for (const entry of entries) {
        if (total <= this.#config.maxBytes) break;
        if (entry.file === activeFile) continue;
        try {
          fs.rmSync(entry.file, { force: true });
          total -= entry.size;
        } catch {
          // Trace retention must never affect tool execution.
        }
      }
    } catch {
      // Full trace maintenance is deliberately best effort.
    }
  }
}
