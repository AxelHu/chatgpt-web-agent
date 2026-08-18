import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuBackend, type FeishuBackendDeps } from "../src/backend/feishu.js";
import type { FeishuConfig } from "../src/config.js";

describe("FeishuBackend", () => {
  let root: string;
  let mediaRoot: string;
  let config: FeishuConfig;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-web-agent-feishu-"));
    mediaRoot = path.join(root, "media");
    await fs.mkdir(mediaRoot);
    config = {
      agentId: "chatgpt-web-agent",
      accountId: "chatgpt-web-agent",
      gatewayUrl: "ws://127.0.0.1:18789",
      requestTimeoutMs: 1000,
      mediaRoot,
      mediaRootOnly: true,
      defaultDirectoryLimit: 20,
      maxDirectoryLimit: 100,
    };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function backend(
    requestAction = vi.fn<FeishuBackendDeps["requestAction"]>(),
    getAccountStatus = vi.fn<FeishuBackendDeps["getAccountStatus"]>(async () => ({
      accountId: "chatgpt-web-agent",
      enabled: true,
      configured: true,
      running: true,
      connected: true,
    })),
  ) {
    return {
      backend: new FeishuBackend(config, { requestAction, getAccountStatus }),
      requestAction,
      getAccountStatus,
    };
  }

  it("publishes only the two narrow Feishu tools without account selection", async () => {
    const { backend: instance } = backend();
    const tools = await instance.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["feishu_message", "feishu_directory"]);
    const sendSchema = tools.find((tool) => tool.name === "feishu_message")?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(sendSchema.properties).not.toHaveProperty("accountId");
    expect(sendSchema.properties).not.toHaveProperty("channel");
  });

  it("sends with an explicit target and renders real Feishu mention markup", async () => {
    const requestAction = vi.fn<FeishuBackendDeps["requestAction"]>(async () => ({
      ok: true,
      action: "send",
      messageId: "om_123",
      chatId: "oc_group",
    }));
    const { backend: instance } = backend(requestAction);

    const result = await instance.callTool(
      "feishu_message",
      {
        target: "chat:oc_group",
        message: "请看一下这个问题",
        mentions: [{ openId: "ou_programmer", name: "程序员" }],
      },
      { callId: "send" },
    );

    expect(result.isError).not.toBe(true);
    expect(requestAction).toHaveBeenCalledWith(
      "send",
      {
        target: "chat:oc_group",
        message: '<at user_id="ou_programmer">程序员</at> 请看一下这个问题',
      },
      undefined,
    );
    expect(result.structuredContent).toMatchObject({
      ok: true,
      sender: { agentId: "chatgpt-web-agent", accountId: "chatgpt-web-agent" },
      target: "chat:oc_group",
      messageId: "om_123",
      mentions: [{ openId: "ou_programmer", name: "程序员" }],
    });
  });

  it("deduplicates mentions and escapes display text", async () => {
    const requestAction = vi.fn<FeishuBackendDeps["requestAction"]>(async () => ({ ok: true }));
    const { backend: instance } = backend(requestAction);
    await instance.callTool(
      "feishu_message",
      {
        target: "user:ou_target",
        message: "hello",
        mentions: [
          { openId: "ou_target", name: "A < B & C" },
          { openId: "ou_target", name: "duplicate" },
        ],
      },
      { callId: "mention" },
    );
    expect(requestAction).toHaveBeenCalledWith(
      "send",
      {
        target: "user:ou_target",
        message: '<at user_id="ou_target">A &lt; B &amp; C</at> hello',
      },
      undefined,
    );
  });

  it("sends a workspace-scoped local attachment and can mark audio as voice", async () => {
    const mediaPath = path.join(mediaRoot, "voice.opus");
    await fs.writeFile(mediaPath, "audio");
    const requestAction = vi.fn<FeishuBackendDeps["requestAction"]>(async () => ({
      ok: true,
      messageId: "om_voice",
    }));
    const { backend: instance } = backend(requestAction);

    const result = await instance.callTool(
      "feishu_message",
      { target: "chat:oc_group", mediaPath: "voice.opus", asVoice: true },
      { callId: "voice" },
    );

    expect(result.isError).not.toBe(true);
    expect(requestAction).toHaveBeenCalledWith(
      "send",
      { target: "chat:oc_group", media: mediaPath, asVoice: true },
      undefined,
    );
  });

  it("blocks path traversal and symlink escape before the Gateway call", async () => {
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "private");
    const requestAction = vi.fn<FeishuBackendDeps["requestAction"]>();
    const { backend: instance } = backend(requestAction);

    const traversal = await instance.callTool(
      "feishu_message",
      { target: "chat:oc_group", mediaPath: "../outside.txt" },
      { callId: "traversal" },
    );
    expect(traversal.isError).toBe(true);
    expect(requestAction).not.toHaveBeenCalled();

    await fs.symlink(root, path.join(mediaRoot, "escape"));
    const symlink = await instance.callTool(
      "feishu_message",
      { target: "chat:oc_group", mediaPath: "escape/outside.txt" },
      { callId: "symlink" },
    );
    expect(symlink.isError).toBe(true);
    expect(requestAction).not.toHaveBeenCalled();
  });

  it("rejects implicit or malformed targets", async () => {
    const requestAction = vi.fn<FeishuBackendDeps["requestAction"]>();
    const { backend: instance } = backend(requestAction);
    for (const target of ["oc_group", "main", "", "chat:not-a-chat-id"]) {
      const result = await instance.callTool(
        "feishu_message",
        { target, message: "hello" },
        { callId: "bad-target" },
      );
      expect(result.isError).toBe(true);
    }
    expect(requestAction).not.toHaveBeenCalled();
  });

  it("discovers groups and returns ready-to-use explicit targets", async () => {
    const requestAction = vi.fn<FeishuBackendDeps["requestAction"]>(async () => ({
      ok: true,
      groups: [
        { kind: "group", id: "oc_alpha", name: "Alpha" },
        { kind: "group", id: "invalid", name: "Ignored" },
      ],
    }));
    const { backend: instance } = backend(requestAction);
    const result = await instance.callTool(
      "feishu_directory",
      { kind: "groups", query: "Alpha", limit: 5 },
      { callId: "groups" },
    );
    expect(requestAction).toHaveBeenCalledWith(
      "channel-list",
      { scope: "groups", limit: 5, query: "Alpha" },
      undefined,
    );
    expect(result.structuredContent).toMatchObject({
      kind: "groups",
      accountId: "chatgpt-web-agent",
      count: 1,
      entries: [{ id: "oc_alpha", target: "chat:oc_alpha", name: "Alpha" }],
    });
  });

  it("discovers peers with ready-to-use direct targets and mention objects", async () => {
    const requestAction = vi.fn<FeishuBackendDeps["requestAction"]>(async () => ({
      ok: true,
      peers: [{ kind: "user", id: "ou_alice", name: "Alice" }],
    }));
    const { backend: instance } = backend(requestAction);
    const result = await instance.callTool(
      "feishu_directory",
      { kind: "peers" },
      { callId: "peers" },
    );
    expect(result.structuredContent).toMatchObject({
      count: 1,
      entries: [
        {
          openId: "ou_alice",
          target: "user:ou_alice",
          mention: { openId: "ou_alice", name: "Alice" },
        },
      ],
    });
  });

  it("lists members of an explicit group and preserves pagination", async () => {
    const requestAction = vi.fn<FeishuBackendDeps["requestAction"]>(async () => ({
      ok: true,
      chat_id: "oc_group",
      has_more: true,
      page_token: "next-page",
      members: [{ member_id: "ou_bob", name: "Bob", member_id_type: "open_id" }],
    }));
    const { backend: instance } = backend(requestAction);
    const result = await instance.callTool(
      "feishu_directory",
      { kind: "members", target: "chat:oc_group", limit: 10, pageToken: "page-1" },
      { callId: "members" },
    );
    expect(requestAction).toHaveBeenCalledWith(
      "member-info",
      { chatId: "oc_group", pageSize: 10, pageToken: "page-1" },
      undefined,
    );
    expect(result.structuredContent).toMatchObject({
      kind: "members",
      target: "chat:oc_group",
      count: 1,
      hasMore: true,
      pageToken: "next-page",
      members: [
        {
          openId: "ou_bob",
          target: "user:ou_bob",
          mention: { openId: "ou_bob", name: "Bob" },
        },
      ],
    });
  });

  it("accepts the legacy nested member-info response shape", async () => {
    const requestAction = vi.fn<FeishuBackendDeps["requestAction"]>(async () => ({
      ok: true,
      members: {
        chat_id: "oc_group",
        has_more: false,
        page_token: "",
        members: [{ member_id: "ou_legacy", name: "Legacy", member_id_type: "open_id" }],
      },
    }));
    const { backend: instance } = backend(requestAction);
    const result = await instance.callTool(
      "feishu_directory",
      { kind: "members", target: "chat:oc_group" },
      { callId: "legacy-members" },
    );
    expect(result.structuredContent).toMatchObject({
      count: 1,
      hasMore: false,
      members: [
        {
          openId: "ou_legacy",
          target: "user:ou_legacy",
          mention: { openId: "ou_legacy", name: "Legacy" },
        },
      ],
    });
  });

  it("fails closed before any action when the fixed account does not exist", async () => {
    const requestAction = vi.fn<FeishuBackendDeps["requestAction"]>();
    const getAccountStatus = vi.fn<FeishuBackendDeps["getAccountStatus"]>(async () => undefined);
    const { backend: instance } = backend(requestAction, getAccountStatus);
    const result = await instance.callTool(
      "feishu_message",
      { target: "chat:oc_group", message: "hello" },
      { callId: "missing-account" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("refusing to fall back to another account"),
    });
    expect(requestAction).not.toHaveBeenCalled();
  });

  it("surfaces action failures after the fixed identity preflight succeeds", async () => {
    const requestAction = vi.fn<FeishuBackendDeps["requestAction"]>(async () => ({
      ok: false,
      error: "Feishu send rejected",
    }));
    const { backend: instance } = backend(requestAction);
    const result = await instance.callTool(
      "feishu_message",
      { target: "chat:oc_group", message: "hello" },
      { callId: "missing-account" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Feishu send rejected"),
    });
    expect(requestAction).toHaveBeenCalledTimes(1);
  });
});
