import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TOOL_ALLOWLIST = [
  "read",
  "exec",
  "process",
  "apply_patch",
  "rescue_exec",
] as const;

export type BridgeConfig = {
  workspaceDir: string;
  workspaceOnly: boolean;
  toolAllowlist: ReadonlySet<string>;
  maxOutputChars: number;
  requestLedger: RequestLedgerConfig;
  fullTrace: FullTraceConfig;
  execRuntime: ExecRuntimeConfig;
  execSecurity?: "deny" | "allowlist" | "full";
  execAsk?: "off" | "on-miss" | "always";
  googleDrive?: GoogleDriveConfig;
  skills?: SkillsConfig;
  feishu?: FeishuConfig;
};

export type RequestLedgerConfig = {
  enabled: boolean;
  directory: string;
  retentionDays: number;
  maxBytes: number;
};

export type FullTraceConfig = {
  enabled: boolean;
  directory: string;
  retentionDays: number;
  maxBytes: number;
};

export type ExecRuntimeConfig = {
  socketPath: string;
  requestTimeoutMs: number;
};

export type GoogleDriveConfig = {
  credentialsPath: string;
  tokenPath: string;
  localRoot: string;
  localRootOnly: boolean;
};

export type SkillsConfig = {
  agentId: string;
  gatewayUrl: string;
  gatewayToken?: string;
  catalogDir: string;
  qmdUrl?: string;
  qmdCollection: string;
  defaultLimit: number;
  maxLimit: number;
  requestTimeoutMs: number;
  maxSkillFileBytes: number;
};

export type FeishuConfig = {
  agentId: string;
  accountId: string;
  gatewayUrl: string;
  gatewayToken?: string;
  requestTimeoutMs: number;
  mediaRoot: string;
  mediaRootOnly: boolean;
  defaultDirectoryLimit: number;
  maxDirectoryLimit: number;
};

function readBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function readEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (!value) {
    return undefined;
  }
  if (!allowed.includes(value as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function readGatewayToken(env: NodeJS.ProcessEnv): string | undefined {
  const inline = env.CHATGPT_WEB_AGENT_GATEWAY_TOKEN?.trim();
  const fileValue = env.CHATGPT_WEB_AGENT_GATEWAY_TOKEN_FILE?.trim();
  if (inline && fileValue) {
    throw new Error(
      "set only one of CHATGPT_WEB_AGENT_GATEWAY_TOKEN or CHATGPT_WEB_AGENT_GATEWAY_TOKEN_FILE",
    );
  }
  if (inline) {
    return inline;
  }
  if (!fileValue) {
    return undefined;
  }
  const tokenPath = path.resolve(fileValue);
  const stat = fs.lstatSync(tokenPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("CHATGPT_WEB_AGENT_GATEWAY_TOKEN_FILE must be a regular non-symlink file");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("CHATGPT_WEB_AGENT_GATEWAY_TOKEN_FILE must not be accessible by group or others");
  }
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  if (!token) {
    throw new Error("CHATGPT_WEB_AGENT_GATEWAY_TOKEN_FILE is empty");
  }
  return token;
}

function defaultExecRuntimeSocket(env: NodeJS.ProcessEnv): string {
  const xdgRuntimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (xdgRuntimeDir) {
    return path.join(path.resolve(xdgRuntimeDir), "chatgpt-web-agent", "exec.sock");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `chatgpt-web-agent-${uid}`, "exec.sock");
}

function defaultStateRoot(env: NodeJS.ProcessEnv): string {
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  return xdgStateHome ? path.resolve(xdgStateHome) : path.join(os.homedir(), ".local", "state");
}

function defaultFullTraceDir(env: NodeJS.ProcessEnv): string {
  return path.join(defaultStateRoot(env), "chatgpt-web-agent", "full-trace");
}

function defaultRequestLedgerDir(env: NodeJS.ProcessEnv): string {
  const stateHome = env.XDG_STATE_HOME?.trim()
    ? path.resolve(env.XDG_STATE_HOME.trim())
    : path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "chatgpt-web-agent", "request-ledger");
}

export function loadBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): BridgeConfig {
  const workspaceDir = path.resolve(env.CHATGPT_WEB_AGENT_WORKSPACE?.trim() || cwd);
  const gatewayToken = readGatewayToken(env);
  const requestedTools = (env.CHATGPT_WEB_AGENT_TOOLS ?? DEFAULT_TOOL_ALLOWLIST.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (requestedTools.length === 0) {
    throw new Error("CHATGPT_WEB_AGENT_TOOLS must contain at least one tool name");
  }

  const driveEnabled = readBoolean(
    env.CHATGPT_WEB_AGENT_DRIVE_ENABLED,
    false,
    "CHATGPT_WEB_AGENT_DRIVE_ENABLED",
  );
  const googleDrive = driveEnabled
    ? {
        credentialsPath: path.resolve(
          env.CHATGPT_WEB_AGENT_DRIVE_CREDENTIALS?.trim() ||
            path.join(workspaceDir, ".credentials/google-drive/credentials.json"),
        ),
        tokenPath: path.resolve(
          env.CHATGPT_WEB_AGENT_DRIVE_TOKEN?.trim() ||
            path.join(workspaceDir, ".credentials/google-drive/token.json"),
        ),
        localRoot: path.resolve(
          env.CHATGPT_WEB_AGENT_DRIVE_LOCAL_ROOT?.trim() || path.join(workspaceDir, "exchange"),
        ),
        localRootOnly: readBoolean(
          env.CHATGPT_WEB_AGENT_DRIVE_LOCAL_ROOT_ONLY,
          true,
          "CHATGPT_WEB_AGENT_DRIVE_LOCAL_ROOT_ONLY",
        ),
      }
    : undefined;

  const skillsEnabled = readBoolean(
    env.CHATGPT_WEB_AGENT_SKILLS_ENABLED,
    true,
    "CHATGPT_WEB_AGENT_SKILLS_ENABLED",
  );
  const skillsDefaultLimit = readPositiveInteger(
    env.CHATGPT_WEB_AGENT_SKILLS_DEFAULT_LIMIT,
    8,
  );
  const skillsMaxLimit = readPositiveInteger(env.CHATGPT_WEB_AGENT_SKILLS_MAX_LIMIT, 20);
  if (skillsDefaultLimit > skillsMaxLimit) {
    throw new Error("CHATGPT_WEB_AGENT_SKILLS_DEFAULT_LIMIT must not exceed CHATGPT_WEB_AGENT_SKILLS_MAX_LIMIT");
  }
  const skills = skillsEnabled
    ? {
        agentId: env.CHATGPT_WEB_AGENT_SKILLS_AGENT_ID?.trim() || "chatgpt-web-agent",
        gatewayUrl:
          env.CHATGPT_WEB_AGENT_SKILLS_GATEWAY_URL?.trim() || "ws://127.0.0.1:18789",
        ...(gatewayToken ? { gatewayToken } : {}),
        catalogDir: path.resolve(
          env.CHATGPT_WEB_AGENT_SKILLS_CATALOG_DIR?.trim() || path.join(workspaceDir, "skills-catalog"),
        ),
        qmdUrl: env.CHATGPT_WEB_AGENT_SKILLS_QMD_URL?.trim() || undefined,
        qmdCollection:
          env.CHATGPT_WEB_AGENT_SKILLS_QMD_COLLECTION?.trim() || "skills-chatgpt-web-agent",
        defaultLimit: skillsDefaultLimit,
        maxLimit: skillsMaxLimit,
        requestTimeoutMs: readPositiveInteger(
          env.CHATGPT_WEB_AGENT_SKILLS_TIMEOUT_MS,
          10_000,
        ),
        maxSkillFileBytes: readPositiveInteger(
          env.CHATGPT_WEB_AGENT_SKILLS_MAX_FILE_BYTES,
          256_000,
        ),
      }
    : undefined;

  const feishuEnabled = readBoolean(
    env.CHATGPT_WEB_AGENT_FEISHU_ENABLED,
    false,
    "CHATGPT_WEB_AGENT_FEISHU_ENABLED",
  );
  const feishuDefaultDirectoryLimit = readPositiveInteger(
    env.CHATGPT_WEB_AGENT_FEISHU_DIRECTORY_DEFAULT_LIMIT,
    20,
  );
  const feishuMaxDirectoryLimit = readPositiveInteger(
    env.CHATGPT_WEB_AGENT_FEISHU_DIRECTORY_MAX_LIMIT,
    100,
  );
  if (feishuDefaultDirectoryLimit > feishuMaxDirectoryLimit) {
    throw new Error(
      "CHATGPT_WEB_AGENT_FEISHU_DIRECTORY_DEFAULT_LIMIT must not exceed CHATGPT_WEB_AGENT_FEISHU_DIRECTORY_MAX_LIMIT",
    );
  }
  const feishu = feishuEnabled
    ? {
        agentId: env.CHATGPT_WEB_AGENT_FEISHU_AGENT_ID?.trim() || "chatgpt-web-agent",
        accountId: env.CHATGPT_WEB_AGENT_FEISHU_ACCOUNT_ID?.trim() || "chatgpt-web-agent",
        gatewayUrl:
          env.CHATGPT_WEB_AGENT_FEISHU_GATEWAY_URL?.trim() || "ws://127.0.0.1:18789",
        ...(gatewayToken ? { gatewayToken } : {}),
        requestTimeoutMs: readPositiveInteger(
          env.CHATGPT_WEB_AGENT_FEISHU_TIMEOUT_MS,
          10_000,
        ),
        mediaRoot: path.resolve(
          env.CHATGPT_WEB_AGENT_FEISHU_MEDIA_ROOT?.trim() || workspaceDir,
        ),
        mediaRootOnly: readBoolean(
          env.CHATGPT_WEB_AGENT_FEISHU_MEDIA_ROOT_ONLY,
          true,
          "CHATGPT_WEB_AGENT_FEISHU_MEDIA_ROOT_ONLY",
        ),
        defaultDirectoryLimit: feishuDefaultDirectoryLimit,
        maxDirectoryLimit: feishuMaxDirectoryLimit,
      }
    : undefined;

  return {
    workspaceDir,
    workspaceOnly: readBoolean(
      env.CHATGPT_WEB_AGENT_WORKSPACE_ONLY,
      true,
      "CHATGPT_WEB_AGENT_WORKSPACE_ONLY",
    ),
    toolAllowlist: new Set(requestedTools),
    maxOutputChars: readPositiveInteger(env.CHATGPT_WEB_AGENT_MAX_OUTPUT_CHARS, 100_000),
    requestLedger: {
      enabled: readBoolean(
        env.CHATGPT_WEB_AGENT_REQUEST_LEDGER_ENABLED,
        true,
        "CHATGPT_WEB_AGENT_REQUEST_LEDGER_ENABLED",
      ),
      directory: path.resolve(
        env.CHATGPT_WEB_AGENT_REQUEST_LEDGER_DIR?.trim() || defaultRequestLedgerDir(env),
      ),
      retentionDays: readPositiveInteger(
        env.CHATGPT_WEB_AGENT_REQUEST_LEDGER_RETENTION_DAYS,
        7,
      ),
      maxBytes: readPositiveInteger(
        env.CHATGPT_WEB_AGENT_REQUEST_LEDGER_MAX_BYTES,
        64 * 1024 * 1024,
      ),
    },
    fullTrace: {
      enabled: readBoolean(
        env.CHATGPT_WEB_AGENT_FULL_TRACE_ENABLED,
        true,
        "CHATGPT_WEB_AGENT_FULL_TRACE_ENABLED",
      ),
      directory: path.resolve(
        env.CHATGPT_WEB_AGENT_FULL_TRACE_DIR?.trim() || defaultFullTraceDir(env),
      ),
      retentionDays: readPositiveInteger(
        env.CHATGPT_WEB_AGENT_FULL_TRACE_RETENTION_DAYS,
        7,
      ),
      maxBytes: readPositiveInteger(
        env.CHATGPT_WEB_AGENT_FULL_TRACE_MAX_BYTES,
        2 * 1024 * 1024 * 1024,
      ),
    },
    execRuntime: {
      socketPath: path.resolve(
        env.CHATGPT_WEB_AGENT_EXEC_RUNTIME_SOCKET?.trim() || defaultExecRuntimeSocket(env),
      ),
      requestTimeoutMs: readPositiveInteger(
        env.CHATGPT_WEB_AGENT_EXEC_RUNTIME_TIMEOUT_MS,
        150_000,
      ),
    },
    execSecurity: readEnum(
      env.CHATGPT_WEB_AGENT_EXEC_SECURITY,
      ["deny", "allowlist", "full"] as const,
      "CHATGPT_WEB_AGENT_EXEC_SECURITY",
    ),
    execAsk: readEnum(
      env.CHATGPT_WEB_AGENT_EXEC_ASK,
      ["off", "on-miss", "always"] as const,
      "CHATGPT_WEB_AGENT_EXEC_ASK",
    ),
    googleDrive,
    skills,
    feishu,
  };
}
