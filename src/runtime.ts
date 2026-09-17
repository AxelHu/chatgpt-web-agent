import fs from "node:fs";
import { CompositeBackend } from "./backend/composite.js";
import { ExecRuntimeClientBackend } from "./backend/exec-runtime-client.js";
import { FeishuBackend } from "./backend/feishu.js";
import { GoogleDriveBackend } from "./backend/google-drive.js";
import { OpenClawBackend } from "./backend/openclaw.js";
import { RescueExecBackend } from "./backend/rescue-exec.js";
import { SkillsBackend } from "./backend/skills.js";
import type { LocalToolBackend } from "./backend/types.js";
import { loadBridgeConfig, type BridgeConfig } from "./config.js";
import { FullTrace } from "./full-trace.js";
import { RequestLedger } from "./request-ledger.js";

export type BridgeRuntime = {
  config: BridgeConfig;
  backend: CompositeBackend;
  ledger: RequestLedger;
  trace: FullTrace;
};

export function createBridgeRuntime(): BridgeRuntime {
  const config = loadBridgeConfig();
  const ledger = new RequestLedger(config.requestLedger, "mcp-wrapper");
  const trace = new FullTrace(config.fullTrace, "mcp-wrapper");
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
    backends.push(new ExecRuntimeClientBackend(config, execRuntimeTools, ledger, trace));
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

  return {
    config,
    backend: new CompositeBackend(backends),
    ledger,
    trace,
  };
}
