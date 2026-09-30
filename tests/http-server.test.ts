import type { AddressInfo } from "node:net";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { LocalToolBackend } from "../src/backend/types.js";
import { CONTINUE_EVENT_NAME, EventRuntime } from "../src/events.js";
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

  it("advertises and serves the modern MCP event surface", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webagent-http-events-"));
    const events = new EventRuntime({
      storePath: path.join(dir, "events.json"),
      validateCallback: async () => {},
      sender: async (_subscription, body) => {
        const parsed = JSON.parse(body) as { type?: string; challenge?: string };
        return parsed.type === "verification"
          ? { ok: true, status: 200, body: JSON.stringify({ challenge: parsed.challenge }) }
          : { ok: true, status: 200, body: "" };
      },
    });
    const mcp = createHttpMcpServer({ backend: stubBackend(), events });
    const endpoint = await listen(mcp);
    const client = new Client(
      { name: "http-events-test", version: "0.1.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(new StreamableHTTPClientTransport(endpoint));

    expect(client.getProtocolEra()).toBe("modern");
    // The generic MCP client normalizes known capabilities when connecting, so
    // query discover with a permissive schema to assert the extension survives
    // on the actual modern wire.
    const discover = await client.request(
      { method: "server/discover", params: {} },
      z.object({
        supportedVersions: z.array(z.string()),
        capabilities: z.record(z.string(), z.unknown()),
      }).passthrough(),
    );
    expect(discover.capabilities.events).toEqual({});

    const result = await client.request(
      { method: "events/list", params: {} },
      z.object({
        events: z.array(z.object({
          name: z.string(),
          description: z.string(),
        }).passthrough()),
      }),
    );
    expect(result.events.map((event) => event.name)).toContain(CONTINUE_EVENT_NAME);

    const secret = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
    const subscribed = await client.request(
      {
        method: "events/subscribe",
        params: {
          name: CONTINUE_EVENT_NAME,
          arguments: { topic: "poc:continue-chat" },
          delivery: {
            mode: "webhook",
            url: "https://events.example.com/callback",
            secret,
          },
          ttlMs: null,
        },
      },
      z.object({
        id: z.string(),
        refreshBefore: z.string().nullable(),
        cursor: z.string().nullable(),
        truncated: z.boolean(),
      }),
    );
    expect(subscribed.id).toMatch(/^sub_/);
    expect(await events.subscriptions()).toHaveLength(1);

    await client.request(
      {
        method: "events/unsubscribe",
        params: {
          name: CONTINUE_EVENT_NAME,
          arguments: { topic: "poc:continue-chat" },
          delivery: {
            mode: "webhook",
            url: "https://events.example.com/callback",
          },
        },
      },
      z.object({}).passthrough(),
    );
    expect(await events.subscriptions()).toHaveLength(0);
    await client.close();
  });
});
