import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { LocalToolBackend } from "./backend/types.js";
import { RequestLedger, summarizeToolArgs, summarizeToolResult } from "./request-ledger.js";
import { toolError } from "./result.js";
import { EpipeSafeStdioServerTransport } from "./stdio-server-transport.js";

export type LocalMcpServer = {
  server: Server;
  serveStdio(): Promise<void>;
  close(): Promise<void>;
};

export function createLocalMcpServer(
  backend: LocalToolBackend,
  ledger?: RequestLedger,
): LocalMcpServer {
  const server = new Server(
    { name: "chatgpt-web-agent", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "When a task plausibly depends on local tools, services, workflows, or operating conventions and the current context is insufficient, call skills_list with a natural-language description of the task. If a relevant Skill is returned, call skill_read for that Skill before acting. Do not query Skills for ordinary self-contained tasks.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await backend.listTools(),
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
      throw error;
    }
  });

  return {
    server,
    serveStdio: async () => {
      const transport = new EpipeSafeStdioServerTransport(
        undefined,
        undefined,
        (event) => ledger?.record(event),
      );
      await server.connect(transport);
    },
    close: async () => {
      await backend.close?.();
      await server.close();
    },
  };
}
