import { describe, expect, it } from "vitest";
import { annotateLocalTool } from "../src/tool-metadata.js";
import type { LocalToolDescriptor } from "../src/backend/types.js";

const make = (name: string): LocalToolDescriptor => ({ name, description: "Existing tool description.", inputSchema: { type: "object", properties: { marker: { type: "string" } } } });

describe("truthful WebAgentTools metadata", () => {
  it.each(["read", "skills_list", "skill_read", "drive_list", "drive_search", "drive_stat", "feishu_directory"])("declares %s read-only", (name) => {
    expect(annotateLocalTool(make(name)).annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });
  it.each(["exec", "process", "rescue_exec", "apply_patch", "drive_download", "drive_export"])("keeps %s potentially destructive", (name) => {
    const tool = annotateLocalTool(make(name));
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.annotations?.destructiveHint).toBe(true);
    expect(tool.annotations?.idempotentHint).toBe(false);
  });
  it.each(["drive_upload", "drive_mkdir", "feishu_message"])("declares %s additive but not read-only", (name) => {
    expect(annotateLocalTool(make(name)).annotations?.readOnlyHint).toBe(false);
    expect(annotateLocalTool(make(name)).annotations?.destructiveHint).toBe(false);
  });
  it("preserves schemas, existing descriptions and conservative unknown-tool defaults", () => {
    const source = make("exec"); const result = annotateLocalTool(source);
    expect(result.inputSchema).toBe(source.inputSchema);
    expect(result.description.startsWith(source.description)).toBe(true);
    expect(source.annotations).toBeUndefined();
    expect(annotateLocalTool(make("future_tool")).annotations).toBeUndefined();
  });
});
