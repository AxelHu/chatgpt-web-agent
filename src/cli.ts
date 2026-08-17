#!/usr/bin/env node
import fs from "node:fs";
import { OpenClawBackend } from "./backend/openclaw.js";
import { loadBridgeConfig } from "./config.js";
import { createLocalMcpServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadBridgeConfig();
  const workspace = fs.statSync(config.workspaceDir);
  if (!workspace.isDirectory()) {
    throw new Error(`workspace is not a directory: ${config.workspaceDir}`);
  }

  const backend = new OpenClawBackend(config);
  const localServer = createLocalMcpServer(backend);
  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await localServer.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  process.stdin.once("end", () => void close());
  process.stdin.once("close", () => void close());

  await localServer.serveStdio();
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[chatgpt-web-agent] ${message}\n`);
  process.exitCode = 1;
});
