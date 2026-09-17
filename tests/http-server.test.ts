import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalToolBackend } from "../src/backend/types.js";
import { createHttpMcpServer, type HttpMcpServer } from "../src/http-server.js";

const servers: HttpMcpServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

function stubBackend(): LocalToolBackend {
  return {
    id: "stub",
    async listTools() {
      return [{
        name: "read",
        description: "read a local file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      }];
    },
    async callTool(name, args) {
      return { content: [{ type: "text", text: `${name}:${String(args.path ?? "")}` }] };
    },
  };
}

async function listen(server: HttpMcpServer): Promise<URL> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.server.once("error", reject);
    server.server.listen(0, "127.0.0.1", () => {
      server.server.off("error", reject);
      resolve();
    });
  });
  const address = server.server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Streamable HTTP MCP server", () => {
  it("supports a stateful session, tool discovery/call, and clean client close", async () => {
    const mcp = createHttpMcpServer({ backend: stubBackend() });
    const endpoint = await listen(mcp);
    const client = new Client({ name: "http-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(endpoint);
    await client.connect(transport);
    expect(mcp.sessionCount()).toBe(1);
    expect(client.getInstructions()).toContain("local computer");

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
    const result = await client.callTool({ name: "read", arguments: { path: "/tmp/demo" } });
    expect(result.content).toEqual([{ type: "text", text: "read:/tmp/demo" }]);

    await transport.terminateSession();
    await waitFor(() => mcp.sessionCount() === 0);
    await client.close();
  });

  it("expires an abandoned session after the idle TTL", async () => {
    const mcp = createHttpMcpServer({
      backend: stubBackend(),
      sessionIdleTtlMs: 40,
      sessionSweepIntervalMs: 10,
    });
    const endpoint = await listen(mcp);
    const client = new Client({ name: "http-abandon-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(endpoint);
    await client.connect(transport);
    expect(mcp.sessionCount()).toBe(1);

    await waitFor(() => mcp.sessionCount() === 0, 1000);
    await client.close().catch(() => undefined);
  });
});

describe("stateless Streamable HTTP MCP server", () => {
  it("supports initialize, discovery, and tool calls without protocol sessions", async () => {
    const mcp = createHttpMcpServer({ backend: stubBackend(), sessionMode: "stateless" });
    const endpoint = await listen(mcp);
    const client = new Client({ name: "http-stateless-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(endpoint);
    await client.connect(transport);
    expect(transport.sessionId).toBeUndefined();
    expect(mcp.sessionCount()).toBe(0);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
    const result = await client.callTool({ name: "read", arguments: { path: "/tmp/stateless" } });
    expect(result.content).toEqual([{ type: "text", text: "read:/tmp/stateless" }]);
    expect(transport.sessionId).toBeUndefined();
    expect(mcp.sessionCount()).toBe(0);
    await client.close();
  });
});
