import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/server";
import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/server";
import type { FullTraceEvent } from "./full-trace.js";
import type { RequestLedgerEvent } from "./request-ledger.js";

/**
 * Compatibility transport for stdout failures such as EPIPE.
 *
 * This legacy stdio fallback keeps explicit output-error handling so a host
 * closing its read side cannot turn an EPIPE into an unhandled process error.
 * Production uses the independent HTTP MCP service; stdio remains a rollback
 * path and test surface.
 */
export class EpipeSafeStdioServerTransport implements Transport {
  private readonly readBuffer = new ReadBuffer();
  private started = false;
  private closed = false;

  constructor(
    private readonly stdin: Readable = process.stdin,
    private readonly stdout: Writable = process.stdout,
    private readonly observe?: (event: RequestLedgerEvent) => void,
    private readonly trace?: (event: FullTraceEvent) => void,
  ) {}

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly onData = (chunk: Buffer) => {
    this.readBuffer.append(chunk);
    this.processReadBuffer();
  };

  private readonly onInputError = (error: Error) => {
    this.trace?.({ phase: "mcp_transport_input_error", ok: false, error });
    this.onerror?.(error);
  };

  private readonly onOutputError = (error: Error) => {
    this.trace?.({ phase: "mcp_transport_output_error", ok: false, error });
    this.onerror?.(error);
    void this.close().catch(() => {
      // The transport is already in an error path; close is best effort here.
    });
  };

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("EpipeSafeStdioServerTransport already started");
    }
    this.started = true;
    this.stdin.on("data", this.onData);
    this.stdin.on("error", this.onInputError);
    this.stdout.on("error", this.onOutputError);
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) {
          break;
        }
        const candidate = message as unknown as Record<string, unknown>;
        this.observe?.({
          phase: "mcp_transport_received",
          mcpRequestId:
            candidate.id === undefined || candidate.id === null ? undefined : String(candidate.id),
          metadata: {
            method: typeof candidate.method === "string" ? candidate.method : undefined,
            kind:
              "method" in candidate
                ? candidate.id === undefined
                  ? "notification"
                  : "request"
                : "response",
          },
        });
        this.trace?.({
          phase: "mcp_transport_received",
          mcpRequestId:
            candidate.id === undefined || candidate.id === null ? undefined : String(candidate.id),
          payload: message,
        });
        this.onmessage?.(message);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.trace?.({ phase: "mcp_transport_parse_error", ok: false, error: normalized });
        this.onerror?.(normalized);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    this.stdin.off("data", this.onData);
    this.stdin.off("error", this.onInputError);
    this.stdout.off("error", this.onOutputError);

    if (this.stdin.listenerCount("data") === 0) {
      this.stdin.pause();
    }
    this.readBuffer.clear();
    this.onclose?.();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("EpipeSafeStdioServerTransport is closed"));
    }

    const candidate = message as unknown as Record<string, unknown>;
    const mcpRequestId =
      candidate.id === undefined || candidate.id === null ? undefined : String(candidate.id);
    return new Promise((resolve, reject) => {
      const json = serializeMessage(message);
      let settled = false;

      const cleanup = () => {
        this.stdout.off("error", onError);
        this.stdout.off("drain", onDrain);
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.observe?.({
          phase: "mcp_transport_send_failed",
          mcpRequestId,
          ok: false,
          errorKind: error.name || "Error",
        });
        this.trace?.({
          phase: "mcp_transport_send_failed",
          mcpRequestId,
          ok: false,
          payload: message,
          error,
        });
        reject(error);
      };
      const onDrain = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.observe?.({ phase: "mcp_transport_sent", mcpRequestId, ok: true });
        this.trace?.({ phase: "mcp_transport_sent", mcpRequestId, ok: true, payload: message });
        resolve();
      };

      // Arm the error listener before write(): streams can fail synchronously.
      this.stdout.once("error", onError);
      if (this.stdout.write(json)) {
        if (settled) return;
        settled = true;
        cleanup();
        this.observe?.({ phase: "mcp_transport_sent", mcpRequestId, ok: true });
        this.trace?.({ phase: "mcp_transport_sent", mcpRequestId, ok: true, payload: message });
        resolve();
      } else if (!settled) {
        this.stdout.once("drain", onDrain);
      }
    });
  }
}
