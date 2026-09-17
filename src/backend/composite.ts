import type { CallToolResult } from "@modelcontextprotocol/server";
import { toolError } from "../result.js";
import type { LocalToolBackend, LocalToolDescriptor, ToolCallContext } from "./types.js";

export class CompositeBackend implements LocalToolBackend {
  readonly id = "composite";
  readonly #backends: LocalToolBackend[];
  readonly #routes = new Map<string, LocalToolBackend>();

  constructor(backends: LocalToolBackend[]) {
    this.#backends = backends;
  }

  async listTools(): Promise<LocalToolDescriptor[]> {
    const descriptors: LocalToolDescriptor[] = [];
    this.#routes.clear();
    for (const backend of this.#backends) {
      for (const descriptor of await backend.listTools()) {
        if (this.#routes.has(descriptor.name)) {
          throw new Error(`duplicate local MCP tool name: ${descriptor.name}`);
        }
        this.#routes.set(descriptor.name, backend);
        descriptors.push(descriptor);
      }
    }
    return descriptors;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<CallToolResult> {
    if (this.#routes.size === 0) {
      await this.listTools();
    }
    const backend = this.#routes.get(name);
    if (!backend) {
      return toolError(`Tool not available: ${name}`);
    }
    return backend.callTool(name, args, context);
  }

  async close(): Promise<void> {
    await Promise.all(this.#backends.map((backend) => backend.close?.()));
  }
}
