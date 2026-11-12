import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { LocalToolDescriptor } from "./backend/types.js";
import { SessionRegistry, type SessionRecord } from "./session-registry.js";
import { toolError } from "./result.js";

const registerArgs = z.object({ name: z.string().min(1).max(200) }).strict();
const statusArgs = z.object({
  session_key: z.string().length(19).regex(/^v1:[0-9a-f]{16}$/).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

const TOOL_DESCRIPTORS: LocalToolDescriptor[] = [
  {
    name: "session_register",
    description: "Register a recognizable name for the current chat at the start of a turn. Later tool calls are attributed automatically using this request's upstream session identity. Repeating registration updates the same source; only name is needed. Registration records activity, not a guarantee that the model is still running.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1, maxLength: 200, description: "Recognizable, consistent conversation name, for example UDG美术开发3." } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "session_status",
    description: "Read registered conversation names and their latest observed tool requests and results. Filter by name or anonymous session_key. Missing recent activity does not prove that a chat has stopped; background process liveness is separate.",
    inputSchema: {
      type: "object",
      properties: {
        session_key: { type: "string", minLength: 19, maxLength: 19, pattern: "^v1:[0-9a-f]{16}$", description: "Exact anonymous source key returned by session_register, when needed to distinguish equal names." },
        name: { type: "string", minLength: 1, maxLength: 200, description: "Exact registered display name." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum records to return; default 50." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/** One instance per frontend. Opening the optional diagnostic store is lazy:
 * its failure must not prevent the normal file/exec tools from starting. */
export class SessionTools {
  #registry?: SessionRegistry;
  readonly #factory: () => SessionRegistry;

  constructor(registryOrFactory: SessionRegistry | (() => SessionRegistry) = () => new SessionRegistry()) {
    this.#factory = typeof registryOrFactory === "function" ? registryOrFactory : () => registryOrFactory;
  }

  private registry(): SessionRegistry {
    return this.#registry ??= this.#factory();
  }

  listTools(): LocalToolDescriptor[] {
    return TOOL_DESCRIPTORS;
  }

  requestStarted(key: string | undefined, callId: string, tool: string): SessionRecord | undefined {
    return key ? this.registry().requestStarted(key, callId, tool) : undefined;
  }

  requestFinished(key: string | undefined, callId: string, tool: string, ok: boolean, durationMs: number, errorKind?: string): void {
    if (key) this.registry().requestFinished(key, callId, tool, ok, durationMs, errorKind);
  }

  callTool(name: string, args: Record<string, unknown>, sourceKey?: string): CallToolResult {
    try {
      let result: Record<string, unknown>;
      if (name === "session_register") {
        const parsed = registerArgs.parse(args);
        if (!sourceKey) return toolError("session_identity_unavailable: this request has no upstream session identity. No binding was saved; normal tools remain available.");
        result = { registered: true, binding: "upstream_session", session: this.registry().register(sourceKey, parsed.name) };
      } else if (name === "session_status") {
        const parsed = statusArgs.parse(args);
        let records: SessionRecord[];
        if (parsed.session_key) {
          const record = this.registry().get(parsed.session_key);
          records = record && (!parsed.name || record.name === parsed.name) ? [record] : [];
        } else records = this.registry().list(parsed.limit, parsed.name);
        result = {
          observedAt: new Date().toISOString(),
          currentSessionKey: sourceKey ?? null,
          sessions: records,
          observation: "Observed WebAgentTools requests and results only. No inference of model liveness or background process state.",
        };
      } else return toolError("unknown_session_tool");
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return toolError(error instanceof z.ZodError ? "Invalid session arguments" : error instanceof Error ? error.message : "session_store_error");
    }
  }

  close(): void {
    this.#registry?.close();
    this.#registry = undefined;
  }
}
