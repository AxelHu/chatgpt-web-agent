import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { LocalToolBackend } from "./backend/types.js";
import { FullTrace } from "./full-trace.js";
import { RequestLedger, summarizeToolArgs, summarizeToolResult } from "./request-ledger.js";
import { toolError } from "./result.js";
import { EpipeSafeStdioServerTransport } from "./stdio-server-transport.js";
import { annotateLocalTool } from "./tool-metadata.js";

export const SERVER_INSTRUCTIONS =
  "Use this server whenever the user request depends on or may depend on their local computer, files, code repositories, development environment, running services, Shell/process state, Git/Gitea state, or established local workflows. It is especially appropriate for continuing existing local development, research, and automation work and for verifying results against the real machine rather than guessing from chat context. When local operating conventions or reusable procedures may matter and the current context is insufficient, call skills_list with a natural-language description of the task; if a relevant Skill is returned, call skill_read for that Skill before acting. Do not query Skills for ordinary self-contained tasks.";

export type LocalMcpServer = {
  server: Server;
  serveStdio(): Promise<void>;
  close(): Promise<void>;
};

export function createMcpProtocolServer(
  backend: LocalToolBackend,
  ledger?: RequestLedger,
  trace?: FullTrace,
): Server {
  const server = new Server(
    { name: "chatgpt-web-agent", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await backend.listTools()).map(annotateLocalTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = request.params.arguments;
    const callId = `mcp-${randomUUID()}`;
    const mcpRequestId = String(extra.requestId);
    const startedAt = performance.now();
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      ledger?.record({
        phase: "mcp_call_rejected",
        callId,
        mcpRequestId,
        tool: name,
        ok: false,
        errorKind: "InvalidArguments",
      });
      return toolError("Tool arguments must be an object");
    }
    const normalizedArgs = (args ?? {}) as Record<string, unknown>;
    ledger?.record({
      phase: "mcp_call_received",
      callId,
      mcpRequestId,
      tool: name,
      metadata: summarizeToolArgs(name, normalizedArgs),
    });
    trace?.record({
      phase: "mcp_call_received",
      callId,
      mcpRequestId,
      tool: name,
      payload: { arguments: normalizedArgs },
    });
    try {
      const result = await backend.callTool(name, normalizedArgs, { callId });
      ledger?.record({
        phase: "mcp_call_completed",
        callId,
        mcpRequestId,
        tool: name,
        ok: result.isError !== true,
        durationMs: Math.round(performance.now() - startedAt),
        metadata: summarizeToolResult(result),
      });
      trace?.record({
        phase: "mcp_call_completed",
        callId,
        mcpRequestId,
        tool: name,
        ok: result.isError !== true,
        durationMs: Math.round(performance.now() - startedAt),
        payload: result,
      });
      return result;
    } catch (error) {
      ledger?.record({
        phase: "mcp_call_failed",
        callId,
        mcpRequestId,
        tool: name,
        ok: false,
        durationMs: Math.round(performance.now() - startedAt),
        errorKind: error instanceof Error ? error.name : typeof error,
      });
      trace?.record({
        phase: "mcp_call_failed",
        callId,
        mcpRequestId,
        tool: name,
        ok: false,
        durationMs: Math.round(performance.now() - startedAt),
        error,
      });
      throw error;
    }
  });

  return server;
}

export function createLocalMcpServer(
  backend: LocalToolBackend,
  ledger?: RequestLedger,
  trace?: FullTrace,
): LocalMcpServer {
  const server = createMcpProtocolServer(backend, ledger, trace);
  return {
    server,
    serveStdio: async () => {
      const transport = new EpipeSafeStdioServerTransport(
        undefined,
        undefined,
        (event) => ledger?.record(event),
        (event) => trace?.record(event),
      );
      await server.connect(transport);
    },
    close: async () => {
      await backend.close?.();
      await server.close();
    },
  };
}
