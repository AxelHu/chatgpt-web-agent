#!/usr/bin/env node
import fs from "node:fs";
import { CompositeBackend } from "./backend/composite.js";
import { FeishuBackend } from "./backend/feishu.js";
import { GoogleDriveBackend } from "./backend/google-drive.js";
import { OpenClawBackend } from "./backend/openclaw.js";
import { SkillsBackend } from "./backend/skills.js";
import type { LocalToolBackend } from "./backend/types.js";
import { loadBridgeConfig } from "./config.js";
import { createLocalMcpServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadBridgeConfig();
  const workspace = fs.statSync(config.workspaceDir);
  if (!workspace.isDirectory()) {
    throw new Error(`workspace is not a directory: ${config.workspaceDir}`);
  }

  const backends: LocalToolBackend[] = [new OpenClawBackend(config)];
  if (config.skills) {
    fs.mkdirSync(config.skills.catalogDir, { recursive: true });
    backends.push(new SkillsBackend(config.skills, config.maxOutputChars));
  }
  if (config.googleDrive) {
    fs.mkdirSync(config.googleDrive.localRoot, { recursive: true });
    backends.push(new GoogleDriveBackend(config.googleDrive));
  }
  if (config.feishu) {
    backends.push(new FeishuBackend(config.feishu));
  }
  const backend = new CompositeBackend(backends);
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
