import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LocalToolBackend } from "./backend/types.js";
import { RequestLedger, summarizeToolArgs, summarizeToolResult } from "./request-ledger.js";
import {
  EXEC_RUNTIME_PROTOCOL_VERSION,
  parseExecRuntimeRequest,
  parseExecRuntimeResponse,
  type ExecRuntimeRequest,
  type ExecRuntimeResponse,
} from "./exec-runtime-protocol.js";

const MAX_FRAME_CHARS = 2_000_000;
const IDEMPOTENCY_TTL_MS = 5 * 60_000;
const IDEMPOTENCY_MAX_ENTRIES = 256;

type MemoEntry = {
  fingerprint: string;
  promise: Promise<ExecRuntimeResponse>;
  completedAt?: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fingerprintRequest(request: ExecRuntimeRequest): string {
  return JSON.stringify({
    callId: request.callId,
    tool: request.tool,
    args: request.args,
  });
}

export type ExecRuntimeServer = {
  listen(): Promise<void>;
  close(): Promise<void>;
};

export function createExecRuntimeServer(
  backend: LocalToolBackend,
  socketPath: string,
  ledger?: RequestLedger,
): ExecRuntimeServer {
  const memo = new Map<string, MemoEntry>();
  let listening = false;

  const pruneMemo = () => {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [requestId, entry] of memo) {
      if (entry.completedAt !== undefined && entry.completedAt < cutoff) {
        memo.delete(requestId);
      }
    }
    if (memo.size <= IDEMPOTENCY_MAX_ENTRIES) return;
    for (const [requestId, entry] of memo) {
      if (memo.size <= IDEMPOTENCY_MAX_ENTRIES) break;
      if (entry.completedAt !== undefined) memo.delete(requestId);
    }
  };

  const executeOnce = (request: ExecRuntimeRequest): Promise<ExecRuntimeResponse> => {
    pruneMemo();
    const fingerprint = fingerprintRequest(request);
    const existing = memo.get(request.requestId);
    if (existing) {
      ledger?.record({
        phase: "exec_runtime_request_reused",
        callId: request.callId,
        tool: request.tool,
        backend: "exec-runtime",
      });
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve({
          version: EXEC_RUNTIME_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: false,
          error: "exec runtime request id was reused with a different payload",
        });
      }
      return existing.promise;
    }

    ledger?.record({
      phase: "openclaw_call_started",
      callId: request.callId,
      tool: request.tool,
      backend: "openclaw",
      metadata: summarizeToolArgs(request.tool, request.args),
    });
    const startedAt = performance.now();
    const promise = backend
      .callTool(request.tool, request.args, { callId: request.callId })
      .then(
        (result): ExecRuntimeResponse => {
          ledger?.record({
            phase: "openclaw_call_completed",
            callId: request.callId,
            tool: request.tool,
            backend: "openclaw",
            ok: result.isError !== true,
            durationMs: Math.round(performance.now() - startedAt),
            metadata: summarizeToolResult(result),
          });
          return {
            version: EXEC_RUNTIME_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: true,
            result,
          };
        },
        (error): ExecRuntimeResponse => {
          ledger?.record({
            phase: "openclaw_call_failed",
            callId: request.callId,
            tool: request.tool,
            backend: "openclaw",
            ok: false,
            durationMs: Math.round(performance.now() - startedAt),
            errorKind: error instanceof Error ? error.name : typeof error,
          });
          return {
            version: EXEC_RUNTIME_PROTOCOL_VERSION,
            requestId: request.requestId,
            ok: false,
            error: errorMessage(error),
          };
        },
      )
      .finally(() => {
        const entry = memo.get(request.requestId);
        if (entry) entry.completedAt = Date.now();
      });
    memo.set(request.requestId, { fingerprint, promise });
    return promise;
  };

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;

    const fail = (requestId: string, error: string) => {
      const response: ExecRuntimeResponse = {
        version: EXEC_RUNTIME_PROTOCOL_VERSION,
        requestId,
        ok: false,
        error,
      };
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
    };

    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > MAX_FRAME_CHARS) {
        handled = true;
        fail("unknown", "exec runtime request exceeded the frame limit");
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const line = buffer.slice(0, newline);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        fail("unknown", `invalid exec runtime JSON: ${errorMessage(error)}`);
        return;
      }
      let request: ExecRuntimeRequest;
      try {
        request = parseExecRuntimeRequest(parsed);
      } catch (error) {
        const requestId =
          parsed && typeof parsed === "object" && "requestId" in parsed
            ? String((parsed as { requestId?: unknown }).requestId ?? "unknown")
            : "unknown";
        fail(requestId, errorMessage(error));
        return;
      }
      ledger?.record({
        phase: "exec_runtime_request_received",
        callId: request.callId,
        tool: request.tool,
        backend: "exec-runtime",
        metadata: summarizeToolArgs(request.tool, request.args),
      });
      void executeOnce(request).then((response) => {
        if (!socket.destroyed) {
          ledger?.record({
            phase: "exec_runtime_response_emitted",
            callId: request.callId,
            tool: request.tool,
            backend: "exec-runtime",
            ok: response.ok,
          });
          socket.end(`${JSON.stringify(response)}\n`);
        } else {
          ledger?.record({
            phase: "exec_runtime_response_dropped",
            callId: request.callId,
            tool: request.tool,
            backend: "exec-runtime",
            ok: false,
          });
        }
      });
    });
  });

  server.on("connection", (socket) => {
    socket.on("error", () => {
      // A caller may disappear after a command was accepted. The request is
      // deliberately not cancelled or replayed; idempotency remains keyed by
      // requestId inside this runtime instance.
    });
  });

  const removeStaleSocket = async () => {
    let stat;
    try {
      stat = await fs.lstat(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!stat.isSocket()) {
      throw new Error(`refusing to replace non-socket exec runtime path: ${socketPath}`);
    }
    const state = await new Promise<"live" | "stale" | "unknown">((resolve) => {
      const probe = net.createConnection({ path: socketPath });
      let settled = false;
      const finish = (value: "live" | "stale" | "unknown") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        probe.removeAllListeners();
        probe.destroy();
        resolve(value);
      };
      const timer = setTimeout(() => finish("unknown"), 500);
      timer.unref?.();
      probe.once("connect", () => finish("live"));
      probe.once("error", (error: NodeJS.ErrnoException) => {
        finish(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "stale" : "unknown");
      });
    });
    if (state === "live") {
      throw new Error(`exec runtime socket is already active: ${socketPath}`);
    }
    if (state === "unknown") {
      throw new Error(`could not prove exec runtime socket is stale: ${socketPath}`);
    }
    await fs.rm(socketPath, { force: true });
  };

  const listen = async () => {
    if (listening) return;
    const dir = path.dirname(socketPath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    await removeStaleSocket();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(socketPath);
    });
    listening = true;
    await fs.chmod(socketPath, 0o600);
  };

  const close = async () => {
    if (listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      listening = false;
    }
    await backend.close?.();
    await fs.rm(socketPath, { force: true });
  };

  return { listen, close };
}

export async function callExecRuntimeSocket(
  socketPath: string,
  request: ExecRuntimeRequest,
  timeoutMs: number,
): Promise<CallToolResult> {
  return await new Promise<CallToolResult>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeAllListeners();
      if (!socket.destroyed) socket.destroy();
    };
    const finishResolve = (result: CallToolResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() => {
      finishReject(new Error(`exec runtime request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_CHARS) {
        finishReject(new Error("exec runtime response exceeded the frame limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = parseExecRuntimeResponse(JSON.parse(buffer.slice(0, newline)) as unknown);
        if (response.requestId !== request.requestId) {
          throw new Error("exec runtime response requestId mismatch");
        }
        if (!response.ok) {
          throw new Error(response.error);
        }
        finishResolve(response.result);
      } catch (error) {
        finishReject(error);
      }
    });
    socket.once("error", finishReject);
    socket.once("close", () => {
      if (!settled) finishReject(new Error("exec runtime connection closed before a response"));
    });
  });
}
