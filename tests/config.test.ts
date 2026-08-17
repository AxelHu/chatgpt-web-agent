import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBridgeConfig } from "../src/config.js";

describe("loadBridgeConfig", () => {
  it("uses the four P0 tools by default", () => {
    const config = loadBridgeConfig({}, "/tmp/workspace");
    expect([...config.toolAllowlist]).toEqual(["read", "exec", "process", "apply_patch"]);
    expect(config.workspaceDir).toBe(path.resolve("/tmp/workspace"));
    expect(config.workspaceOnly).toBe(true);
  });

  it("parses explicit tool and exec policy overrides", () => {
    const config = loadBridgeConfig(
      {
        CHATGPT_WEB_AGENT_TOOLS: "read, exec",
        CHATGPT_WEB_AGENT_EXEC_SECURITY: "full",
        CHATGPT_WEB_AGENT_EXEC_ASK: "off",
        CHATGPT_WEB_AGENT_WORKSPACE_ONLY: "false",
      },
      "/tmp/workspace",
    );
    expect([...config.toolAllowlist]).toEqual(["read", "exec"]);
    expect(config.execSecurity).toBe("full");
    expect(config.execAsk).toBe("off");
    expect(config.workspaceOnly).toBe(false);
  });
});
