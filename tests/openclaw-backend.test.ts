import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenClawBackend } from "../src/backend/openclaw.js";
import type { BridgeConfig } from "../src/config.js";

describe("OpenClawBackend", () => {
  let workspaceDir: string;
  let backend: OpenClawBackend;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-web-agent-"));
    const config: BridgeConfig = {
      workspaceDir,
      workspaceOnly: true,
      toolAllowlist: new Set(["read", "exec", "process", "apply_patch"]),
      maxOutputChars: 100_000,
      execSecurity: "full",
      execAsk: "off",
    };
    backend = new OpenClawBackend(config);
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("publishes only the configured P0 tools and hides exec policy controls", async () => {
    const tools = await backend.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "apply_patch",
      "exec",
      "process",
      "read",
    ]);
    const exec = tools.find((tool) => tool.name === "exec");
    const properties = exec?.inputSchema.properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty("host");
    expect(properties).not.toHaveProperty("security");
    expect(properties).not.toHaveProperty("ask");
    expect(properties).not.toHaveProperty("elevated");
  });

  it("reads files and executes commands through OpenClaw tools", async () => {
    await fs.writeFile(path.join(workspaceDir, "probe.txt"), "hello\n");
    const read = await backend.callTool("read", { path: "probe.txt" }, { callId: "read-1" });
    expect(read.isError).not.toBe(true);
    expect(read.content[0]).toMatchObject({ type: "text", text: "hello\n" });

    const exec = await backend.callTool(
      "exec",
      { command: "printf exec-ok", workdir: "." },
      { callId: "exec-1" },
    );
    expect(exec.isError).not.toBe(true);
    expect(exec.content[0]).toMatchObject({ type: "text", text: "exec-ok" });
  });

  it("applies patches inside the workspace", async () => {
    await fs.writeFile(path.join(workspaceDir, "note.txt"), "before\n");
    const result = await backend.callTool(
      "apply_patch",
      {
        input: [
          "*** Begin Patch",
          "*** Update File: note.txt",
          "@@",
          "-before",
          "+after",
          "*** End Patch",
        ].join("\n"),
      },
      { callId: "patch-1" },
    );
    expect(result.isError).not.toBe(true);
    await expect(fs.readFile(path.join(workspaceDir, "note.txt"), "utf8")).resolves.toBe("after\n");
  });

  it("manages background commands through the paired process tool", async () => {
    const background = await backend.callTool(
      "exec",
      {
        command: `node -e "setTimeout(()=>console.log('process-ok'),100)"`,
        background: true,
      },
      { callId: "exec-background" },
    );
    expect(background.isError).not.toBe(true);
    const sessionId = (background.structuredContent as { sessionId?: string } | undefined)?.sessionId;
    expect(sessionId).toBeTruthy();

    const polled = await backend.callTool(
      "process",
      { action: "poll", sessionId, timeout: 5_000 },
      { callId: "process-poll" },
    );
    expect(polled.isError).not.toBe(true);
    expect(polled.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("process-ok"),
    });
  });

  it("rejects exec workdirs outside the configured workspace", async () => {
    const result = await backend.callTool(
      "exec",
      { command: "pwd", workdir: ".." },
      { callId: "exec-outside" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("must stay inside workspace"),
    });
  });

  it("rejects file reads outside the configured workspace", async () => {
    const outsidePath = path.join(path.dirname(workspaceDir), `outside-${path.basename(workspaceDir)}.txt`);
    await fs.writeFile(outsidePath, "outside\n");
    try {
      const result = await backend.callTool(
        "read",
        { path: outsidePath },
        { callId: "read-outside" },
      );
      expect(result.isError).toBe(true);
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it("uses the workspace as a default without restricting external paths when configured", async () => {
    const outsidePath = path.join(
      path.dirname(workspaceDir),
      `outside-unrestricted-${path.basename(workspaceDir)}.txt`,
    );
    await fs.writeFile(outsidePath, "outside-ok\n");
    try {
      const unrestricted = new OpenClawBackend({
        workspaceDir,
        workspaceOnly: false,
        toolAllowlist: new Set(["read", "exec", "process", "apply_patch"]),
        maxOutputChars: 100_000,
        execSecurity: "full",
        execAsk: "off",
      });
      const read = await unrestricted.callTool(
        "read",
        { path: outsidePath },
        { callId: "read-outside-unrestricted" },
      );
      expect(read.isError).not.toBe(true);
      expect(read.content[0]).toMatchObject({ type: "text", text: "outside-ok\n" });

      const exec = await unrestricted.callTool(
        "exec",
        { command: "pwd", workdir: path.dirname(workspaceDir) },
        { callId: "exec-outside-unrestricted" },
      );
      expect(exec.isError).not.toBe(true);
      expect(exec.content[0]).toMatchObject({
        type: "text",
        text: path.dirname(workspaceDir),
      });
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });
});
