import type { CallToolResult } from "@modelcontextprotocol/server";

// v2 is the OpenClaw 8.2 exec contract: exec.timeoutSeconds replaces exec.timeout.
// Keep this version explicit so a newly upgraded MCP frontend fails fast instead
// of silently sending 8.2 arguments to a persistent 7.x runtime.
export const EXEC_RUNTIME_PROTOCOL_VERSION = 2 as const;
export const EXEC_RUNTIME_TOOL_NAMES = new Set(["exec", "process"] as const);

export type ExecRuntimeToolName = "exec" | "process";

export type ExecRuntimeRequest = {
  version: typeof EXEC_RUNTIME_PROTOCOL_VERSION;
  requestId: string;
  callId: string;
  tool: ExecRuntimeToolName;
  args: Record<string, unknown>;
};

export type ExecRuntimeResponse =
  | {
      version: typeof EXEC_RUNTIME_PROTOCOL_VERSION;
      requestId: string;
      ok: true;
      result: CallToolResult;
    }
  | {
      version: typeof EXEC_RUNTIME_PROTOCOL_VERSION;
      requestId: string;
      ok: false;
      error: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseExecRuntimeRequest(value: unknown): ExecRuntimeRequest {
  if (!isRecord(value)) {
    throw new Error("request must be an object");
  }
  if (value.version !== EXEC_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(`unsupported exec runtime protocol version: ${String(value.version)}`);
  }
  if (typeof value.requestId !== "string" || !value.requestId.trim()) {
    throw new Error("requestId is required");
  }
  if (typeof value.callId !== "string" || !value.callId.trim()) {
    throw new Error("callId is required");
  }
  if (value.tool !== "exec" && value.tool !== "process") {
    throw new Error(`unsupported exec runtime tool: ${String(value.tool)}`);
  }
  if (!isRecord(value.args)) {
    throw new Error("args must be an object");
  }
  return {
    version: EXEC_RUNTIME_PROTOCOL_VERSION,
    requestId: value.requestId,
    callId: value.callId,
    tool: value.tool,
    args: value.args,
  };
}

export function parseExecRuntimeResponse(value: unknown): ExecRuntimeResponse {
  if (!isRecord(value)) {
    throw new Error("response must be an object");
  }
  if (value.version !== EXEC_RUNTIME_PROTOCOL_VERSION) {
    throw new Error(`unsupported exec runtime protocol version: ${String(value.version)}`);
  }
  if (typeof value.requestId !== "string" || !value.requestId.trim()) {
    throw new Error("response requestId is required");
  }
  if (value.ok === false) {
    if (typeof value.error !== "string") {
      throw new Error("error response is missing error text");
    }
    return {
      version: EXEC_RUNTIME_PROTOCOL_VERSION,
      requestId: value.requestId,
      ok: false,
      error: value.error,
    };
  }
  if (value.ok !== true || !isRecord(value.result) || !Array.isArray(value.result.content)) {
    throw new Error("success response is missing a tool result");
  }
  return {
    version: EXEC_RUNTIME_PROTOCOL_VERSION,
    requestId: value.requestId,
    ok: true,
    result: value.result as CallToolResult,
  };
}
