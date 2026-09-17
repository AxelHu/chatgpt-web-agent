import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

export type JsonSchema = Record<string, unknown> & { type: "object" };

export type LocalToolDescriptor = {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: Tool["annotations"];
};

export type ToolCallContext = {
  callId: string;
  signal?: AbortSignal;
};

export interface LocalToolBackend {
  readonly id: string;
  listTools(): Promise<LocalToolDescriptor[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<CallToolResult>;
  close?(): Promise<void>;
}
