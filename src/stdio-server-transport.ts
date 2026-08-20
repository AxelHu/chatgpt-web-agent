import process from "node:process";
import type { Readable, Writable } from "node:stream";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Temporary v1 SDK backport for stdout failures such as EPIPE.
 *
 * @modelcontextprotocol/sdk 1.29.0 only listens for stdin errors. If the MCP
 * host closes its read side before a response is written, Node emits an
 * unhandled stdout error and terminates the whole server process. The upstream
 * v1 fix is not released yet, so keep the compatibility shim local until a
 * released SDK version contains equivalent behavior.
 */
export class EpipeSafeStdioServerTransport implements Transport {
  private readonly readBuffer = new ReadBuffer();
  private started = false;
  private closed = false;

  constructor(
    private readonly stdin: Readable = process.stdin,
    private readonly stdout: Writable = process.stdout,
  ) {}

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private readonly onData = (chunk: Buffer) => {
    this.readBuffer.append(chunk);
    this.processReadBuffer();
  };

  private readonly onInputError = (error: Error) => {
    this.onerror?.(error);
  };

  private readonly onOutputError = (error: Error) => {
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
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
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
        reject(error);
      };
      const onDrain = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      // Arm the error listener before write(): streams can fail synchronously.
      this.stdout.once("error", onError);
      if (this.stdout.write(json)) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      } else if (!settled) {
        this.stdout.once("drain", onDrain);
      }
    });
  }
}
