import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createLocalMcpServer } from "../src/server.js";
import type { LocalToolBackend } from "../src/backend/types.js";

describe("createLocalMcpServer", () => {
  it("publishes truthful annotations over tools/list without changing schemas", async () => {
    const inputSchema = { type: "object", properties: { path: { type: "string" } } };
    const backend: LocalToolBackend = {
      id: "stub",
      async listTools() { return ["read", "exec", "drive_download"].map((name) => ({ name, description: "original", inputSchema })); },
      async callTool() { return { content: [] }; },
    };
    const local = createLocalMcpServer(backend);
    const client = new Client({ name: "metadata-server-test", version: "0.1.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([local.server.connect(st), client.connect(ct)]);
      const { tools } = await client.listTools();
      expect(tools.find((tool) => tool.name === "read")?.annotations?.readOnlyHint).toBe(true);
      for (const name of ["exec", "drive_download"]) expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
      for (const tool of tools) expect(tool.inputSchema).toEqual(inputSchema);
    } finally { await client.close(); await local.close(); }
  });
  it("advertises lightweight proactive Skill discovery instructions", async () => {
    const backend: LocalToolBackend = {
      id: "stub",
      async listTools() {
        return [];
      },
      async callTool() {
        return { content: [{ type: "text", text: "unused" }] };
      },
    };
    const local = createLocalMcpServer(backend);
    const client = new Client({ name: "server-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([local.server.connect(serverTransport), client.connect(clientTransport)]);
      expect(client.getInstructions()).toContain("primary interface");
      expect(client.getInstructions()).toContain("Proactively use it");
      expect(client.getInstructions()).toContain("Gitea issue");
      expect(client.getInstructions()).toContain("skills_list");
      expect(client.getInstructions()).toContain("skill_read");
    } finally {
      await client.close();
      await local.close();
    }
  });
});
