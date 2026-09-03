#!/usr/bin/env node
import fs from "node:fs";
import { CompositeBackend } from "./backend/composite.js";
import { ExecRuntimeClientBackend } from "./backend/exec-runtime-client.js";
import { FeishuBackend } from "./backend/feishu.js";
import { GoogleDriveBackend } from "./backend/google-drive.js";
import { OpenClawBackend } from "./backend/openclaw.js";
import { RescueExecBackend } from "./backend/rescue-exec.js";
import { SkillsBackend } from "./backend/skills.js";
import type { LocalToolBackend } from "./backend/types.js";
import { loadBridgeConfig } from "./config.js";
import { createLocalMcpServer } from "./server.js";
import { RequestLedger } from "./request-ledger.js";

async function main(): Promise<void> {
  const config = loadBridgeConfig();
  const ledger = new RequestLedger(config.requestLedger, "mcp-wrapper");
  const workspace = fs.statSync(config.workspaceDir);
  if (!workspace.isDirectory()) {
    throw new Error(`workspace is not a directory: ${config.workspaceDir}`);
  }

  const execRuntimeTools = new Set(
    ["exec", "process"].filter((name) => config.toolAllowlist.has(name)),
  );
  const directOpenClawTools = new Set(
    [...config.toolAllowlist].filter((name) => name !== "exec" && name !== "process"),
  );
  const backends: LocalToolBackend[] = [
    new OpenClawBackend(config, { toolAllowlist: directOpenClawTools }),
  ];
  if (execRuntimeTools.size > 0) {
    backends.push(new ExecRuntimeClientBackend(config, execRuntimeTools, ledger));
  }
  if (config.toolAllowlist.has("rescue_exec")) {
    backends.push(new RescueExecBackend(config));
  }
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
  const localServer = createLocalMcpServer(backend, ledger);
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
