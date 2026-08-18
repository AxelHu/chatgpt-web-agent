import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBridgeConfig } from "../src/config.js";

describe("loadBridgeConfig", () => {
  it("uses the four P0 tools by default", () => {
    const config = loadBridgeConfig({}, "/tmp/workspace");
    expect([...config.toolAllowlist]).toEqual(["read", "exec", "process", "apply_patch"]);
    expect(config.workspaceDir).toBe(path.resolve("/tmp/workspace"));
    expect(config.workspaceOnly).toBe(true);
    expect(config.skills).toEqual({
      agentId: "chatgpt-web-agent",
      gatewayUrl: "ws://127.0.0.1:18789",
      catalogDir: path.resolve("/tmp/workspace/skills-catalog"),
      qmdUrl: undefined,
      qmdCollection: "skills-chatgpt-web-agent",
      defaultLimit: 8,
      maxLimit: 20,
      requestTimeoutMs: 10_000,
      maxSkillFileBytes: 256_000,
    });
  });

  it("parses Skills discovery overrides and can disable the backend", () => {
    const config = loadBridgeConfig(
      {
        CHATGPT_WEB_AGENT_SKILLS_AGENT_ID: "web-scope",
        CHATGPT_WEB_AGENT_SKILLS_GATEWAY_URL: "ws://127.0.0.1:19999",
        CHATGPT_WEB_AGENT_SKILLS_QMD_URL: "http://m4.local:8181/mcp",
        CHATGPT_WEB_AGENT_SKILLS_QMD_COLLECTION: "skills-web",
        CHATGPT_WEB_AGENT_SKILLS_DEFAULT_LIMIT: "5",
        CHATGPT_WEB_AGENT_SKILLS_MAX_LIMIT: "12",
        CHATGPT_WEB_AGENT_SKILLS_TIMEOUT_MS: "7000",
        CHATGPT_WEB_AGENT_SKILLS_MAX_FILE_BYTES: "123456",
      },
      "/tmp/workspace",
    );
    expect(config.skills).toMatchObject({
      agentId: "web-scope",
      gatewayUrl: "ws://127.0.0.1:19999",
      qmdUrl: "http://m4.local:8181/mcp",
      qmdCollection: "skills-web",
      defaultLimit: 5,
      maxLimit: 12,
      requestTimeoutMs: 7000,
      maxSkillFileBytes: 123456,
    });
    expect(loadBridgeConfig({ CHATGPT_WEB_AGENT_SKILLS_ENABLED: "false" }, "/tmp/workspace").skills).toBeUndefined();
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

  it("enables Google Drive with workspace-local credential and staging defaults", () => {
    const config = loadBridgeConfig(
      { CHATGPT_WEB_AGENT_DRIVE_ENABLED: "true" },
      "/tmp/workspace",
    );
    expect(config.googleDrive).toEqual({
      credentialsPath: path.resolve("/tmp/workspace/.credentials/google-drive/credentials.json"),
      tokenPath: path.resolve("/tmp/workspace/.credentials/google-drive/token.json"),
      localRoot: path.resolve("/tmp/workspace/exchange"),
      localRootOnly: true,
    });
  });

  it("enables Feishu with a fixed Web Agent identity and workspace-scoped media defaults", () => {
    const config = loadBridgeConfig(
      { CHATGPT_WEB_AGENT_FEISHU_ENABLED: "true" },
      "/tmp/workspace",
    );
    expect(config.feishu).toEqual({
      agentId: "chatgpt-web-agent",
      accountId: "chatgpt-web-agent",
      gatewayUrl: "ws://127.0.0.1:18789",
      requestTimeoutMs: 10_000,
      mediaRoot: path.resolve("/tmp/workspace"),
      mediaRootOnly: true,
      defaultDirectoryLimit: 20,
      maxDirectoryLimit: 100,
    });
  });

  it("parses Feishu overrides without exposing sender selection to tool callers", () => {
    const config = loadBridgeConfig(
      {
        CHATGPT_WEB_AGENT_FEISHU_ENABLED: "true",
        CHATGPT_WEB_AGENT_FEISHU_AGENT_ID: "web-agent",
        CHATGPT_WEB_AGENT_FEISHU_ACCOUNT_ID: "web-bot",
        CHATGPT_WEB_AGENT_FEISHU_GATEWAY_URL: "ws://127.0.0.1:19999",
        CHATGPT_WEB_AGENT_FEISHU_TIMEOUT_MS: "7000",
        CHATGPT_WEB_AGENT_FEISHU_MEDIA_ROOT: "/tmp/feishu-media",
        CHATGPT_WEB_AGENT_FEISHU_MEDIA_ROOT_ONLY: "false",
        CHATGPT_WEB_AGENT_FEISHU_DIRECTORY_DEFAULT_LIMIT: "10",
        CHATGPT_WEB_AGENT_FEISHU_DIRECTORY_MAX_LIMIT: "50",
      },
      "/tmp/workspace",
    );
    expect(config.feishu).toEqual({
      agentId: "web-agent",
      accountId: "web-bot",
      gatewayUrl: "ws://127.0.0.1:19999",
      requestTimeoutMs: 7000,
      mediaRoot: path.resolve("/tmp/feishu-media"),
      mediaRootOnly: false,
      defaultDirectoryLimit: 10,
      maxDirectoryLimit: 50,
    });
  });
});
