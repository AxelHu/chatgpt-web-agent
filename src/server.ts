import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { LocalToolBackend } from "./backend/types.js";
import { FullTrace } from "./full-trace.js";
import { RequestLedger, summarizeToolArgs, summarizeToolResult } from "./request-ledger.js";
import { toolError } from "./result.js";
import { EpipeSafeStdioServerTransport } from "./stdio-server-transport.js";
import { annotateLocalTool } from "./tool-metadata.js";

export const SERVER_INSTRUCTIONS =
  "Treat this server as the primary interface to the user’s local computer and durable working environment. Proactively use it whenever a task concerns or could benefit from local state. It directly provides access to local files and code repositories, Shell commands and processes, running services, development environments, build/test state, Git/Gitea, and established local workflows. Keep this capability available for exploration, discovery, verification, implementation, debugging, testing, automation, research, continuation of prior local work, and durable record-keeping. Requests such as continue development, inspect or verify current state, investigate locally, fix or test something, update a project, or record/track work are strong signals that this server should be exposed and used. Prefer reading and checking the real local state before answering about local projects instead of guessing from chat context. Prefer making durable project changes and records in the appropriate local workspace, repository, or Gitea issue when that is the natural system of record, rather than creating temporary cloud documents. When reusable local procedures or operating conventions may help, use skills_list and skill_read to discover and load the relevant Skill.";

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

  server.setRequestHandler('tools/list', async () => ({
    tools: (await backend.listTools()).map(annotateLocalTool),
  }));

  server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = request.params.arguments;
    const callId = `mcp-${randomUUID()}`;
    const mcpRequestId = String(ctx.mcpReq.id);
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
