import { describe, expect, it } from "vitest";
import { CompositeBackend } from "../src/backend/composite.js";
import type { LocalToolBackend } from "../src/backend/types.js";

function stubBackend(id: string, toolName: string): LocalToolBackend {
  return {
    id,
    async listTools() {
      return [
        {
          name: toolName,
          description: `${id} tool`,
          inputSchema: { type: "object", properties: {} },
        },
      ];
    },
    async callTool(name) {
      return { content: [{ type: "text", text: `${id}:${name}` }] };
    },
  };
}

describe("CompositeBackend", () => {
  it("combines tool inventories and routes calls to the owning backend", async () => {
    const backend = new CompositeBackend([stubBackend("a", "one"), stubBackend("b", "two")]);
    await expect(backend.listTools()).resolves.toEqual([
      expect.objectContaining({ name: "one" }),
      expect.objectContaining({ name: "two" }),
    ]);
    const result = await backend.callTool("two", {}, { callId: "call-1" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "b:two" });
  });

  it("rejects duplicate public tool names", async () => {
    const backend = new CompositeBackend([stubBackend("a", "same"), stubBackend("b", "same")]);
    await expect(backend.listTools()).rejects.toThrow("duplicate local MCP tool name: same");
  });
});
