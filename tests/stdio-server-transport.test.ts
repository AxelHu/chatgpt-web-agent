import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { EpipeSafeStdioServerTransport } from "../src/stdio-server-transport.js";

describe("EpipeSafeStdioServerTransport", () => {
  it("reports a stdout EPIPE and closes instead of leaving it unhandled", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new EpipeSafeStdioServerTransport(input, output);
    const onError = vi.fn();
    const onClose = vi.fn();
    transport.onerror = onError;
    transport.onclose = onClose;

    await transport.start();
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    output.emit("error", error);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(error);
    expect(onClose).toHaveBeenCalledOnce();
    await transport.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("rejects a pending send when stdout fails instead of waiting forever for drain", async () => {
    const input = new PassThrough();
    let completeWrite: ((error?: Error | null) => void) | undefined;
    const output = new Writable({
      highWaterMark: 0,
      write(_chunk, _encoding, callback) {
        completeWrite = callback;
      },
    });
    const transport = new EpipeSafeStdioServerTransport(input, output);
    transport.onerror = () => {};
    await transport.start();

    const pending = transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    completeWrite?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    await expect(pending).rejects.toThrow("write EPIPE");
    expect(output.listenerCount("drain")).toBe(0);
    expect(output.listenerCount("error")).toBe(0);
  });

  it("rejects send after close", async () => {
    const transport = new EpipeSafeStdioServerTransport(new PassThrough(), new PassThrough());
    await transport.start();
    await transport.close();

    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow("closed");
  });
});
