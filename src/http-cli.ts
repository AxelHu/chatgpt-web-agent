#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpMcpServer } from "./http-server.js";
import { createBridgeRuntime } from "./runtime.js";

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function defaultSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR?.trim();
  if (runtime) return path.join(path.resolve(runtime), "chatgpt-web-agent", "mcp.sock");
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `chatgpt-web-agent-${uid}`, "mcp.sock");
}

function parseLoopbackListen(value: string): { host: string; port: number } {
  const url = new URL(`http://${value}`);
  const host = url.hostname;
  const port = Number.parseInt(url.port, 10);
  if (!(host === "127.0.0.1" || host === "::1" || host === "localhost")) {
    throw new Error("CHATGPT_WEB_AGENT_MCP_HTTP_LISTEN must bind loopback only");
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("CHATGPT_WEB_AGENT_MCP_HTTP_LISTEN must include a valid port");
  }
  return { host, port };
}

async function main(): Promise<void> {
  const { backend, ledger, trace } = createBridgeRuntime();
  const listenValue = process.env.CHATGPT_WEB_AGENT_MCP_HTTP_LISTEN?.trim();
  const socketValue = process.env.CHATGPT_WEB_AGENT_MCP_HTTP_SOCKET?.trim();
  if (listenValue && socketValue) {
    throw new Error("set only one of CHATGPT_WEB_AGENT_MCP_HTTP_LISTEN or CHATGPT_WEB_AGENT_MCP_HTTP_SOCKET");
  }
  const tcp = listenValue ? parseLoopbackListen(listenValue) : undefined;
  const socketPath = tcp ? undefined : path.resolve(socketValue || defaultSocketPath());
  const idleTtlMs = positiveInteger(
    process.env.CHATGPT_WEB_AGENT_MCP_SESSION_IDLE_TTL_MS,
    20 * 60_000,
    "CHATGPT_WEB_AGENT_MCP_SESSION_IDLE_TTL_MS",
  );
  const maxSessions = positiveInteger(
    process.env.CHATGPT_WEB_AGENT_MCP_MAX_SESSIONS,
    16,
    "CHATGPT_WEB_AGENT_MCP_MAX_SESSIONS",
  );
  const sessionModeValue = process.env.CHATGPT_WEB_AGENT_MCP_HTTP_MODE?.trim() || "stateful";
  if (!(sessionModeValue === "stateful" || sessionModeValue === "stateless")) {
    throw new Error("CHATGPT_WEB_AGENT_MCP_HTTP_MODE must be stateful or stateless");
  }
  if (socketPath) {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    try {
      const stat = fs.lstatSync(socketPath);
      if (!stat.isSocket()) throw new Error(`refusing to replace non-socket path: ${socketPath}`);
      fs.unlinkSync(socketPath);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const mcp = createHttpMcpServer({
    backend,
    ledger,
    trace,
    sessionIdleTtlMs: idleTtlMs,
    maxSessions,
    sessionMode: sessionModeValue,
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await mcp.close();
    await backend.close();
    if (socketPath) {
      try { fs.unlinkSync(socketPath); } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  await new Promise<void>((resolve, reject) => {
    mcp.server.once("error", reject);
    const ready = () => {
      mcp.server.off("error", reject);
      if (socketPath) {
        fs.chmodSync(socketPath, 0o600);
        process.stderr.write(`[chatgpt-web-agent-http] listening on unix://${socketPath}\n`);
      } else if (tcp) {
        process.stderr.write(`[chatgpt-web-agent-http] listening on http://${tcp.host}:${tcp.port}/mcp\n`);
      }
      resolve();
    };
    if (socketPath) mcp.server.listen(socketPath, ready);
    else if (tcp) mcp.server.listen(tcp.port, tcp.host, ready);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[chatgpt-web-agent-http] ${message}\n`);
  process.exitCode = 1;
});
