import { spawn, type ChildProcess } from "node:child_process";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeConfig } from "../config.js";
import { toolError } from "../result.js";
import type { JsonSchema, LocalToolBackend, LocalToolDescriptor, ToolCallContext } from "./types.js";
import { resolveToolWorkdir } from "./workdir.js";

const TOOL_NAME = "rescue_exec";
const DEFAULT_TIMEOUT_SECONDS = 15;
const MAX_TIMEOUT_SECONDS = 60;
const KILL_GRACE_MS = 500;

const SAFE_INHERITED_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "XDG_DATA_DIRS",
  "DBUS_SESSION_BUS_ADDRESS",
]);

const INPUT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["command"],
  additionalProperties: false,
  properties: {
    command: {
      type: "string",
      minLength: 1,
      description: "Shell command to execute",
    },
    workdir: {
      type: "string",
      description: "Working directory. Omit to use the configured workspace.",
    },
    env: {
      type: "object",
      patternProperties: {
        "^.*$": { type: "string" },
      },
      additionalProperties: false,
      description: "Explicit string environment overrides added to the minimal rescue environment.",
    },
    timeout: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: MAX_TIMEOUT_SECONDS,
      description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, hard cap ${MAX_TIMEOUT_SECONDS})`,
    },
  },
};

type RescueExitDetails = {
  status: "completed" | "failed";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  failureKind?: "overall-timeout" | "aborted";
  exitReason: "exit" | "signal" | "overall-timeout" | "aborted";
  durationMs: number;
  aggregated: string;
  timedOut?: true;
  aborted?: true;
  noOutputTimedOut: false;
  cwd: string;
};

function buildMinimalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (SAFE_INHERITED_ENV.has(key) || key.startsWith("LC_")) {
      env[key] = value;
    }
  }
  return env;
}

function parseEnv(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("env must be an object of string values");
  }
  const parsed: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`env.${key} must be a string`);
    }
    parsed[key] = entry;
  }
  return parsed;
}

function parseTimeout(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("timeout must be a positive number of seconds");
  }
  if (value > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout must not exceed ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return value;
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    // Fall back to the direct child if the process group has already disappeared.
  }
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the state check and the signal.
  }
}

function formatCompletedOutput(raw: string, code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null && code !== 0) {
    return `${raw}${raw ? "\n\n" : ""}(Command exited with code ${code})`;
  }
  if (signal) {
    return `${raw}${raw ? "\n\n" : ""}(Command terminated by signal ${signal})`;
  }
  return raw;
}

function resultWithDetails(text: string, details: RescueExitDetails): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: details,
  };
}

export class RescueExecBackend implements LocalToolBackend {
  readonly id = "rescue-exec";
  readonly #config: Pick<BridgeConfig, "workspaceDir" | "workspaceOnly" | "maxOutputChars">;
  #running = false;

  constructor(config: Pick<BridgeConfig, "workspaceDir" | "workspaceOnly" | "maxOutputChars">) {
    this.#config = config;
  }

  async listTools(): Promise<LocalToolDescriptor[]> {
    return [
      {
        name: TOOL_NAME,
        title: "Rescue Exec",
        description:
          "Run a short local shell command through an execution path independent of OpenClaw. Use only when normal exec is unavailable, hung, or its OpenClaw execution path is suspected broken; prefer exec otherwise. Synchronous and short-lived; never use as an automatic retry for a failed exec command.",
        inputSchema: INPUT_SCHEMA,
      },
    ];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<CallToolResult> {
    if (name !== TOOL_NAME) {
      return toolError(`Tool not available: ${name}`);
    }
    if (this.#running) {
      return toolError("rescue_exec is already running; V1 allows only one rescue command at a time");
    }

    const allowedArgs = new Set(["command", "workdir", "env", "timeout"]);
    const unexpected = Object.keys(args).filter((key) => !allowedArgs.has(key));
    if (unexpected.length > 0) {
      return toolError(`rescue_exec does not support: ${unexpected.join(", ")}`);
    }

    try {
      const command = args.command;
      if (typeof command !== "string" || command.trim().length === 0) {
        throw new Error("command must be a non-empty string");
      }
      if (args.workdir !== undefined && typeof args.workdir !== "string") {
        throw new Error("workdir must be a string");
      }
      const cwd = resolveToolWorkdir(
        this.#config.workspaceDir,
        args.workdir as string | undefined,
        this.#config.workspaceOnly,
        TOOL_NAME,
      );
      const timeoutSeconds = parseTimeout(args.timeout);
      const env = {
        ...buildMinimalEnvironment(process.env),
        ...parseEnv(args.env),
      };

      if (context.signal?.aborted) {
        return toolError("rescue_exec aborted before start");
      }

      this.#running = true;
      try {
        return await this.#execute(command, cwd, env, timeoutSeconds, context.signal);
      } finally {
        this.#running = false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`rescue_exec failed: ${message}`);
    }
  }

  async #execute(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const startedAt = performance.now();

    return await new Promise<CallToolResult>((resolve) => {
      const child = spawn("/bin/bash", ["-c", command], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      let rawOutput = "";
      let omittedChars = 0;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const append = (chunk: string) => {
        const remaining = Math.max(0, this.#config.maxOutputChars - rawOutput.length);
        if (remaining > 0) {
          rawOutput += chunk.slice(0, remaining);
        }
        omittedChars += Math.max(0, chunk.length - remaining);
      };
      const collectedOutput = () =>
        omittedChars > 0
          ? `${rawOutput}\n\n[chatgpt-web-agent rescue_exec truncated ${omittedChars} characters]`
          : rawOutput;
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);

      const hardKillSoon = () => {
        killTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), KILL_GRACE_MS);
        killTimer.unref?.();
      };
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateProcessGroup(child, "SIGTERM");
        hardKillSoon();
      }, timeoutSeconds * 1_000);
      timeoutTimer.unref?.();

      const onAbort = () => {
        aborted = true;
        terminateProcessGroup(child, "SIGTERM");
        hardKillSoon();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        signal?.removeEventListener("abort", onAbort);
      };

      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(toolError(`rescue_exec failed: ${error.message}`));
      });

      child.once("close", (code, exitSignal) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        const durationMs = Math.round(performance.now() - startedAt);
        const raw = collectedOutput();

        if (timedOut) {
          const details: RescueExitDetails = {
            status: "failed",
            exitCode: code,
            exitSignal,
            failureKind: "overall-timeout",
            exitReason: "overall-timeout",
            durationMs,
            aggregated: raw,
            timedOut: true,
            noOutputTimedOut: false,
            cwd,
          };
          const message = `Command timed out after ${timeoutSeconds} seconds.`;
          resolve(resultWithDetails(raw ? `${raw}\n\n${message}` : message, details));
          return;
        }

        if (aborted) {
          const details: RescueExitDetails = {
            status: "failed",
            exitCode: code,
            exitSignal,
            failureKind: "aborted",
            exitReason: "aborted",
            durationMs,
            aggregated: raw,
            aborted: true,
            noOutputTimedOut: false,
            cwd,
          };
          const message = "Command aborted.";
          resolve(resultWithDetails(raw ? `${raw}\n\n${message}` : message, details));
          return;
        }

        const aggregated = formatCompletedOutput(raw, code, exitSignal);
        const details: RescueExitDetails = {
          status: "completed",
          exitCode: code,
          exitSignal,
          exitReason: exitSignal ? "signal" : "exit",
          durationMs,
          aggregated,
          noOutputTimedOut: false,
          cwd,
        };
        resolve(resultWithDetails(aggregated, details));
      });
    });
  }
}
