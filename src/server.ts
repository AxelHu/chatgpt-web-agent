import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { LocalToolBackend } from "./backend/types.js";
import { toolError } from "./result.js";
import { EpipeSafeStdioServerTransport } from "./stdio-server-transport.js";

export type LocalMcpServer = {
  server: Server;
  serveStdio(): Promise<void>;
  close(): Promise<void>;
};

export function createLocalMcpServer(backend: LocalToolBackend): LocalMcpServer {
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

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = request.params.arguments;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return toolError("Tool arguments must be an object");
    }
    return backend.callTool(name, (args ?? {}) as Record<string, unknown>, {
      callId: `mcp-${randomUUID()}`,
    });
  });

  return {
    server,
    serveStdio: async () => {
      const transport = new EpipeSafeStdioServerTransport();
      await server.connect(transport);
    },
    close: async () => {
      await backend.close?.();
      await server.close();
    },
  };
}
