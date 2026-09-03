import type { BridgeConfig } from "../config.js";
import {
  EXEC_RUNTIME_PROTOCOL_VERSION,
  type ExecRuntimeToolName,
} from "../exec-runtime-protocol.js";
import { callExecRuntimeSocket } from "../exec-runtime-server.js";
import { toolError } from "../result.js";
import { OpenClawBackend } from "./openclaw.js";
import type { LocalToolBackend, LocalToolDescriptor, ToolCallContext } from "./types.js";
import { RequestLedger, summarizeToolArgs, summarizeToolResult } from "../request-ledger.js";

const EXEC_RUNTIME_SESSION_KEY = "agent:chatgpt-web-agent:exec-runtime";
const EXEC_RUNTIME_SCHEMA_SESSION_KEY = "agent:chatgpt-web-agent:exec-runtime-schema";

export class ExecRuntimeClientBackend implements LocalToolBackend {
  readonly id = "exec-runtime-client";
  readonly #config: BridgeConfig;
  readonly #toolNames: ReadonlySet<string>;
  readonly #descriptors: Promise<LocalToolDescriptor[]>;
  readonly #ledger?: RequestLedger;

  constructor(config: BridgeConfig, toolNames: ReadonlySet<string>, ledger?: RequestLedger) {
    this.#config = config;
    this.#toolNames = toolNames;
    this.#ledger = ledger;
    const schemaBackend = new OpenClawBackend(config, {
      toolAllowlist: toolNames,
      sessionKey: EXEC_RUNTIME_SCHEMA_SESSION_KEY,
    });
    this.#descriptors = schemaBackend.listTools();
  }

  async listTools(): Promise<LocalToolDescriptor[]> {
    return await this.#descriptors;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ) {
    if (!this.#toolNames.has(name) || (name !== "exec" && name !== "process")) {
      return toolError(`Tool not available: ${name}`);
    }
    const startedAt = performance.now();
    this.#ledger?.record({
      phase: "exec_runtime_forward_started",
      callId: context.callId,
      tool: name,
      backend: this.id,
      metadata: summarizeToolArgs(name, args),
    });
    try {
      const result = await callExecRuntimeSocket(
        this.#config.execRuntime.socketPath,
        {
          version: EXEC_RUNTIME_PROTOCOL_VERSION,
          requestId: context.callId,
          callId: context.callId,
          tool: name as ExecRuntimeToolName,
          args,
        },
        this.#config.execRuntime.requestTimeoutMs,
      );
      this.#ledger?.record({
        phase: "exec_runtime_forward_completed",
        callId: context.callId,
        tool: name,
        backend: this.id,
        ok: result.isError !== true,
        durationMs: Math.round(performance.now() - startedAt),
        metadata: summarizeToolResult(result),
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#ledger?.record({
        phase: "exec_runtime_forward_failed",
        callId: context.callId,
        tool: name,
        backend: this.id,
        ok: false,
        durationMs: Math.round(performance.now() - startedAt),
        errorKind: error instanceof Error ? error.name : typeof error,
      });
      return toolError(`${name} runtime unavailable: ${message}`);
    }
  }
}

export function createExecRuntimeBackend(config: BridgeConfig): OpenClawBackend {
  return new OpenClawBackend(config, {
    toolAllowlist: new Set(["exec", "process"]),
    sessionKey: EXEC_RUNTIME_SESSION_KEY,
  });
}
