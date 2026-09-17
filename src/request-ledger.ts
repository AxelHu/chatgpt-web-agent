import fs from "node:fs";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";

export type RequestLedgerConfig = {
  enabled: boolean;
  directory: string;
  retentionDays: number;
  maxBytes: number;
};

export type RequestLedgerEvent = {
  phase: string;
  callId?: string;
  mcpRequestId?: string;
  tool?: string;
  backend?: string;
  durationMs?: number;
  ok?: boolean;
  errorKind?: string;
  metadata?: Record<string, unknown>;
};

const SCHEMA_VERSION = 1;
const PRUNE_INTERVAL_MS = 60_000;

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

function errorKind(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Return diagnostic metadata only. Command bodies, tool output and message/file
 * contents are deliberately excluded from the ledger.
 */
export function summarizeToolArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  if (tool === "process") {
    return {
      action: text(args.action),
      sessionId: text(args.sessionId),
      timeoutMs: numeric(args.timeout),
      offset: numeric(args.offset),
      limit: numeric(args.limit),
    };
  }
  if (tool === "exec") {
    return {
      workdir: text(args.workdir),
      timeoutSec: numeric(args.timeoutSeconds),
      yieldMs: numeric(args.yieldMs),
      background: boolean(args.background),
      pty: boolean(args.pty),
      commandChars: typeof args.command === "string" ? args.command.length : undefined,
    };
  }
  if (tool === "read") {
    return {
      path: text(args.path),
      offset: numeric(args.offset),
      limit: numeric(args.limit),
      cursor: numeric(args.cursor),
      optional: boolean(args.optional),
    };
  }
  return {};
}

export function summarizeToolResult(result: CallToolResult): Record<string, unknown> {
  let textChars = 0;
  let imageBase64Chars = 0;
  for (const block of result.content ?? []) {
    if (block.type === "text") textChars += block.text.length;
    if (block.type === "image") imageBase64Chars += block.data.length;
  }
  return {
    isError: result.isError === true,
    contentBlocks: result.content?.length ?? 0,
    textChars,
    imageBase64Chars,
    hasStructuredContent: result.structuredContent !== undefined,
  };
}

/**
 * Small best-effort JSONL request ledger. Logging failures never fail a tool
 * call. Files are split by local calendar day and pruned by both age and a
 * total-byte ceiling.
 */
export class RequestLedger {
  readonly #config: RequestLedgerConfig;
  readonly #source: string;
  #lastPruneAt = 0;
  #lastErrorAt = 0;

  constructor(config: RequestLedgerConfig, source: string) {
    this.#config = config;
    this.#source = source;
    if (config.enabled) this.#prune(Date.now());
  }

  record(event: RequestLedgerEvent): void {
    if (!this.#config.enabled) return;
    const now = new Date();
    try {
      fs.mkdirSync(this.#config.directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.#config.directory, 0o700);
      const file = path.join(this.#config.directory, `${localDateKey(now)}.jsonl`);
      const line = `${JSON.stringify({
        schema: SCHEMA_VERSION,
        time: now.toISOString(),
        localTime: localIso(now),
        source: this.#source,
        ...event,
      })}\n`;
      fs.appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(file, 0o600);
      const nowMs = now.getTime();
      if (nowMs - this.#lastPruneAt >= PRUNE_INTERVAL_MS) this.#prune(nowMs, file);
    } catch (error) {
      const nowMs = Date.now();
      if (nowMs - this.#lastErrorAt >= PRUNE_INTERVAL_MS) {
        this.#lastErrorAt = nowMs;
        process.stderr.write(`[chatgpt-web-agent ledger] ${errorKind(error)}\n`);
      }
    }
  }

  #prune(nowMs: number, activeFile?: string): void {
    this.#lastPruneAt = nowMs;
    let entries: Array<{ file: string; mtimeMs: number; size: number }> = [];
    try {
      fs.mkdirSync(this.#config.directory, { recursive: true, mode: 0o700 });
      entries = fs
        .readdirSync(this.#config.directory)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
        .flatMap((name) => {
          const file = path.join(this.#config.directory, name);
          try {
            const stat = fs.statSync(file);
            return [{ file, mtimeMs: stat.mtimeMs, size: stat.size }];
          } catch {
            return [];
          }
        });
    } catch {
      return;
    }

    const cutoff = nowMs - this.#config.retentionDays * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (entry.file !== activeFile && entry.mtimeMs < cutoff) {
        try {
          fs.rmSync(entry.file, { force: true });
        } catch {
          // Best effort. The byte-cap pass below re-stats surviving files.
        }
      }
    }

    entries = entries
      .filter((entry) => fs.existsSync(entry.file))
      .map((entry) => {
        try {
          const stat = fs.statSync(entry.file);
          return { ...entry, mtimeMs: stat.mtimeMs, size: stat.size };
        } catch {
          return { ...entry, size: 0 };
        }
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= this.#config.maxBytes) break;
      if (entry.file === activeFile) continue;
      try {
        fs.rmSync(entry.file, { force: true });
        total -= entry.size;
      } catch {
        // Retention must never affect tool execution.
      }
    }
  }
}
