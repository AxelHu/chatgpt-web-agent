import path from "node:path";

export const DEFAULT_TOOL_ALLOWLIST = ["read", "exec", "process", "apply_patch"] as const;

export type BridgeConfig = {
  workspaceDir: string;
  workspaceOnly: boolean;
  toolAllowlist: ReadonlySet<string>;
  maxOutputChars: number;
  execSecurity?: "deny" | "allowlist" | "full";
  execAsk?: "off" | "on-miss" | "always";
  googleDrive?: GoogleDriveConfig;
  skills?: SkillsConfig;
  feishu?: FeishuConfig;
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

export function loadBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): BridgeConfig {
  const workspaceDir = path.resolve(env.CHATGPT_WEB_AGENT_WORKSPACE?.trim() || cwd);
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
