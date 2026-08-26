#!/usr/bin/env node
import fs from "node:fs";
import { createExecRuntimeBackend } from "./backend/exec-runtime-client.js";
import { loadBridgeConfig } from "./config.js";
import { createExecRuntimeServer } from "./exec-runtime-server.js";

async function main(): Promise<void> {
  const config = loadBridgeConfig();
  const workspace = fs.statSync(config.workspaceDir);
  if (!workspace.isDirectory()) {
    throw new Error(`workspace is not a directory: ${config.workspaceDir}`);
  }

  const backend = createExecRuntimeBackend(config);
  const runtime = createExecRuntimeServer(backend, config.execRuntime.socketPath);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  await runtime.listen();
  process.stdout.write(`[chatgpt-web-agent-exec] listening on ${config.execRuntime.socketPath}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[chatgpt-web-agent-exec] ${message}\n`);
  process.exitCode = 1;
});
