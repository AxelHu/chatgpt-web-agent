import path from "node:path";

export const DEFAULT_TOOL_ALLOWLIST = ["read", "exec", "process", "apply_patch"] as const;

export type BridgeConfig = {
  workspaceDir: string;
  workspaceOnly: boolean;
  toolAllowlist: ReadonlySet<string>;
  maxOutputChars: number;
  execSecurity?: "deny" | "allowlist" | "full";
  execAsk?: "off" | "on-miss" | "always";
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
  };
}
