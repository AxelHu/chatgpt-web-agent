import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[chatgpt-web-agent truncated ${omitted} characters]`;
}

function normalizeContentBlock(block: unknown, maxChars: number): ContentBlock {
  if (block && typeof block === "object") {
    const candidate = block as Record<string, unknown>;
    if (candidate.type === "text" && typeof candidate.text === "string") {
      return { type: "text", text: truncateText(candidate.text, maxChars) };
    }
    if (
      candidate.type === "image" &&
      typeof candidate.data === "string" &&
      typeof candidate.mimeType === "string"
    ) {
      return {
        type: "image",
        data: candidate.data,
        mimeType: candidate.mimeType,
      };
    }
    if (candidate.type === "resource" && candidate.resource && typeof candidate.resource === "object") {
      return block as ContentBlock;
    }
  }
  return { type: "text", text: truncateText(stringifyUnknown(block), maxChars) };
}

export function normalizeToolResult(result: unknown, maxChars: number): CallToolResult {
  const candidate = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const rawContent = Array.isArray(candidate.content) ? candidate.content : [result];
  const content = rawContent.map((block) => normalizeContentBlock(block, maxChars));
  const details = candidate.details;

  return {
    content,
    ...(candidate.isError === true ? { isError: true } : {}),
    ...(details && typeof details === "object" && !Array.isArray(details)
      ? { structuredContent: details as Record<string, unknown> }
      : {}),
  };
}

export function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
