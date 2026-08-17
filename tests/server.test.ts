import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createLocalMcpServer } from "../src/server.js";
import type { LocalToolBackend } from "../src/backend/types.js";

describe("createLocalMcpServer", () => {
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
      expect(client.getInstructions()).toContain("skills_list");
      expect(client.getInstructions()).toContain("skill_read");
      expect(client.getInstructions()).toContain("Do not query Skills for ordinary self-contained tasks");
    } finally {
      await client.close();
      await local.close();
    }
  });
});
