import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecRuntimeClientBackend, createExecRuntimeBackend } from "../src/backend/exec-runtime-client.js";
import type { LocalToolBackend } from "../src/backend/types.js";
import type { BridgeConfig } from "../src/config.js";
import {
  EXEC_RUNTIME_PROTOCOL_VERSION,
  parseExecRuntimeRequest,
  type ExecRuntimeRequest,
} from "../src/exec-runtime-protocol.js";
import { callExecRuntimeSocket, createExecRuntimeServer, type ExecRuntimeServer } from "../src/exec-runtime-server.js";

describe("exec runtime IPC", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  async function tempSocket(): Promise<{ dir: string; socketPath: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-web-agent-exec-test-"));
    cleanups.push(async () => fs.rm(dir, { recursive: true, force: true }));
    return { dir, socketPath: path.join(dir, "exec.sock") };
  }

  async function startServer(
    backend: LocalToolBackend,
    socketPath: string,
  ): Promise<ExecRuntimeServer> {
    const server = createExecRuntimeServer(backend, socketPath);
    await server.listen();
    cleanups.push(async () => server.close());
    return server;
  }

  function request(
    requestId: string,
    command: string,
  ): ExecRuntimeRequest {
    return {
      version: EXEC_RUNTIME_PROTOCOL_VERSION,
      requestId,
      callId: requestId,
      tool: "exec",
      args: { command },
    };
  }

  it("deduplicates only the same runtime request id, including while in flight", async () => {
    const { socketPath } = await tempSocket();
    let calls = 0;
    const backend: LocalToolBackend = {
      id: "counting",
      async listTools() {
        return [];
      },
      async callTool() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { content: [{ type: "text", text: `call-${calls}` }] };
      },
    };
    await startServer(backend, socketPath);

    const same = request("same-request", "printf same");
    const [a, b] = await Promise.all([
      callExecRuntimeSocket(socketPath, same, 2_000),
      callExecRuntimeSocket(socketPath, same, 2_000),
    ]);
    expect(calls).toBe(1);
    expect(a.content[0]).toMatchObject({ type: "text", text: "call-1" });
    expect(b.content[0]).toMatchObject({ type: "text", text: "call-1" });

    await callExecRuntimeSocket(socketPath, request("new-request", "printf same"), 2_000);
    expect(calls).toBe(2);
  });

  it("rejects reuse of one request id with a different payload", async () => {
    const { socketPath } = await tempSocket();
    let calls = 0;
    const backend: LocalToolBackend = {
      id: "counting",
      async listTools() {
        return [];
      },
      async callTool() {
        calls += 1;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    await startServer(backend, socketPath);
    await callExecRuntimeSocket(socketPath, request("reuse", "printf one"), 2_000);
    await expect(
      callExecRuntimeSocket(socketPath, request("reuse", "printf two"), 2_000),
    ).rejects.toThrow("request id was reused with a different payload");
    expect(calls).toBe(1);
  });

  it("does not automatically replay an ambiguous exec request after the IPC response is lost", async () => {
    const { socketPath } = await tempSocket();
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.once("data", () => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    cleanups.push(
      async () =>
        await new Promise<void>((resolve) => server.close(() => resolve())),
    );

    await expect(
      callExecRuntimeSocket(socketPath, request("ambiguous", "printf once"), 1_000),
    ).rejects.toThrow("closed before a response");
    expect(connections).toBe(1);
  });

  it("refuses to replace a live runtime socket", async () => {
    const { socketPath } = await tempSocket();
    const backend: LocalToolBackend = {
      id: "first",
      async listTools() {
        return [];
      },
      async callTool() {
        return { content: [{ type: "text", text: "first-ok" }] };
      },
    };
    await startServer(backend, socketPath);
    const second = createExecRuntimeServer(backend, socketPath);
    await expect(second.listen()).rejects.toThrow("socket is already active");

    const result = await callExecRuntimeSocket(
      socketPath,
      request("first-still-live", "printf first"),
      2_000,
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: "first-ok" });
  });

  it("keeps an OpenClaw background session alive across client replacement", async () => {
    const { dir, socketPath } = await tempSocket();
    const config: BridgeConfig = {
      workspaceDir: dir,
      workspaceOnly: true,
      toolAllowlist: new Set(["exec", "process"]),
      maxOutputChars: 100_000,
      execRuntime: { socketPath, requestTimeoutMs: 5_000 },
      execSecurity: "full",
      execAsk: "off",
    };
    await startServer(createExecRuntimeBackend(config), socketPath);

    const firstClient = new ExecRuntimeClientBackend(config, new Set(["exec", "process"]));
    const background = await firstClient.callTool(
      "exec",
      {
        command: `node -e "setTimeout(()=>console.log('runtime-survived'),250)"`,
        background: true,
      },
      { callId: "background-start" },
    );
    expect(background.isError).not.toBe(true);
    const sessionId = (background.structuredContent as { sessionId?: string } | undefined)?.sessionId;
    expect(sessionId).toBeTruthy();

    const replacementClient = new ExecRuntimeClientBackend(config, new Set(["exec", "process"]));
    const polled = await replacementClient.callTool(
      "process",
      { action: "poll", sessionId, timeout: 2_000 },
      { callId: "background-poll" },
    );
    expect(polled.isError).not.toBe(true);
    expect(polled.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("runtime-survived"),
    });
  });

  it("can advertise exec/process schemas without contacting the runtime socket", async () => {
    const { dir, socketPath } = await tempSocket();
    const config: BridgeConfig = {
      workspaceDir: dir,
      workspaceOnly: true,
      toolAllowlist: new Set(["exec", "process"]),
      maxOutputChars: 100_000,
      execRuntime: { socketPath, requestTimeoutMs: 1_000 },
      execSecurity: "full",
      execAsk: "off",
    };
    const client = new ExecRuntimeClientBackend(config, new Set(["exec", "process"]));
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["exec", "process"]);
  });

  it("rejects the pre-8.2 exec runtime protocol instead of mixing timeout contracts", () => {
    expect(() =>
      parseExecRuntimeRequest({
        version: 1,
        requestId: "legacy-request",
        callId: "legacy-request",
        tool: "exec",
        args: { command: "true", timeout: 1 },
      }),
    ).toThrow("unsupported exec runtime protocol version: 1");
  });
});
