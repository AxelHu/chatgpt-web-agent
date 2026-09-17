import type { AddressInfo } from "node:net";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
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

async function assertToolSurface(client: Client, expectedPath: string): Promise<void> {
  expect(client.getInstructions()).toContain("primary interface");
  expect(client.getInstructions()).toContain("durable working environment");
  expect(client.getInstructions()).toContain("Gitea issue");
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(["read"]);
  const result = await client.callTool({ name: "read", arguments: { path: expectedPath } });
  expect(result.content).toEqual([{ type: "text", text: `read:${expectedPath}` }]);
}

describe("sessionless Streamable HTTP MCP server", () => {
  it("serves the modern 2026-07-28 per-request protocol", async () => {
    const mcp = createHttpMcpServer({ backend: stubBackend() });
    const endpoint = await listen(mcp);
    const client = new Client(
      { name: "http-modern-test", version: "0.1.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StreamableHTTPClientTransport(endpoint);
    await client.connect(transport);

    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect(transport.sessionId).toBeUndefined();
    await assertToolSurface(client, "/tmp/modern");
    expect(transport.sessionId).toBeUndefined();
    await client.close();
  });

  it("keeps 2025-era clients working through the stateless compatibility leg", async () => {
    const mcp = createHttpMcpServer({ backend: stubBackend() });
    const endpoint = await listen(mcp);
    const client = new Client({ name: "http-legacy-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(endpoint);
    await client.connect(transport);

    expect(client.getProtocolEra()).toBe("legacy");
    expect(client.getNegotiatedProtocolVersion()).not.toBe("2026-07-28");
    expect(transport.sessionId).toBeUndefined();
    await assertToolSurface(client, "/tmp/legacy");
    expect(transport.sessionId).toBeUndefined();
    await client.close();
  });

  it("reports sessionless health and rejects non-local browser origins", async () => {
    const mcp = createHttpMcpServer({ backend: stubBackend() });
    const endpoint = await listen(mcp);
    const base = new URL(endpoint);

    const health = await fetch(new URL("/healthz", base));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      mode: "sessionless",
      modernProtocol: "2026-07-28",
      legacyCompatibility: "stateless",
      sessions: 0,
    });

    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(rejected.status).toBe(403);
  });
});
