import { randomUUID } from "node:crypto";
import {
  createOpenClawCodingTools,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeConfig } from "../config.js";
import { normalizeToolResult, toolError } from "../result.js";
import type { JsonSchema, LocalToolBackend, LocalToolDescriptor, ToolCallContext } from "./types.js";
import { resolveToolWorkdir } from "./workdir.js";

const INTERNAL_EXEC_FIELDS = new Set(["host", "security", "ask", "node", "elevated"]);

type ExecutableTool = AnyAgentTool & {
  prepareBeforeToolCallParams?: (
    args: Record<string, unknown>,
    context: { toolCallId: string; signal?: AbortSignal },
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  finalizeBeforeToolCallParams?: (
    args: Record<string, unknown>,
    prepared: Record<string, unknown>,
  ) => Record<string, unknown>;
};

function cloneSchema(schema: unknown): JsonSchema {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  return structuredClone(schema) as JsonSchema;
}

function publicSchemaFor(tool: ExecutableTool): JsonSchema {
  const schema = cloneSchema(tool.parameters);
  if (tool.name !== "exec") {
    return schema;
  }
  const properties = schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const field of INTERNAL_EXEC_FIELDS) {
      delete (properties as Record<string, unknown>)[field];
    }
  }
  return schema;
}

function sanitizeExecArgs(
  args: Record<string, unknown>,
  workspaceDir: string,
  workspaceOnly: boolean,
): Record<string, unknown> {
  const sanitized = { ...args };
  for (const field of INTERNAL_EXEC_FIELDS) {
    delete sanitized[field];
  }
  const requestedWorkdir = typeof sanitized.workdir === "string" ? sanitized.workdir.trim() : "";
  sanitized.workdir = resolveToolWorkdir(
    workspaceDir,
    requestedWorkdir || undefined,
    workspaceOnly,
    "exec",
  );
  return sanitized;
}

function createToolRuntimeConfig(config: BridgeConfig) {
  return {
    tools: {
      fs: {
        workspaceOnly: config.workspaceOnly,
      },
      exec: {
        security: config.execSecurity ?? ("allowlist" as const),
        ask: config.execAsk ?? ("on-miss" as const),
        applyPatch: {
          workspaceOnly: config.workspaceOnly,
        },
      },
    },
  };
}

function resolveExecDefaults(
  config: BridgeConfig,
  runtimeConfig: ReturnType<typeof createToolRuntimeConfig>,
) {
  const exec = runtimeConfig.tools?.exec;
  return {
    host: "gateway" as const,
    security: config.execSecurity ?? exec.security,
    ask: config.execAsk ?? exec.ask,
  };
}

export class OpenClawBackend implements LocalToolBackend {
  readonly id = "openclaw";
  readonly #config: BridgeConfig;
  readonly #tools: Map<string, ExecutableTool>;

  constructor(
    config: BridgeConfig,
    options: {
      toolAllowlist?: ReadonlySet<string>;
      sessionKey?: string;
      sessionId?: string;
    } = {},
  ) {
    this.#config = config;
    const runtimeConfig = createToolRuntimeConfig(config);
    const toolAllowlist = options.toolAllowlist ?? config.toolAllowlist;
    const tools = createOpenClawCodingTools({
      agentId: "chatgpt-web-agent",
      sessionKey: options.sessionKey ?? `agent:chatgpt-web-agent:mcp:${process.pid}`,
      sessionId: options.sessionId ?? randomUUID(),
      workspaceDir: config.workspaceDir,
      cwd: config.workspaceDir,
      config: runtimeConfig,
      exec: resolveExecDefaults(config, runtimeConfig),
      toolConstructionPlan: {
        includeBaseCodingTools: true,
        includeShellTools: true,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    });
    this.#tools = new Map(
      tools
        .filter((tool) => toolAllowlist.has(tool.name))
        .map((tool) => [tool.name, tool as ExecutableTool]),
    );
  }

  async listTools(): Promise<LocalToolDescriptor[]> {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      title: tool.label,
      description: tool.description,
      inputSchema: publicSchemaFor(tool),
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<CallToolResult> {
    const tool = this.#tools.get(name);
    if (!tool) {
      return toolError(`Tool not available: ${name}`);
    }
    try {
      const publicArgs =
        name === "exec"
          ? sanitizeExecArgs(args, this.#config.workspaceDir, this.#config.workspaceOnly)
          : args;
      const prepared = tool.prepareBeforeToolCallParams
        ? await tool.prepareBeforeToolCallParams(publicArgs, {
            toolCallId: context.callId,
            signal: context.signal,
          })
        : publicArgs;
      const finalized = tool.finalizeBeforeToolCallParams
        ? tool.finalizeBeforeToolCallParams(prepared, prepared)
        : prepared;
      const result = await tool.execute(context.callId, finalized, context.signal);
      return normalizeToolResult(result, this.#config.maxOutputChars);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`${name} failed: ${message}`);
    }
  }
}
