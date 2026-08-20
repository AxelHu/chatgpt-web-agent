import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompositeBackend } from "../src/backend/composite.js";
import { RescueExecBackend } from "../src/backend/rescue-exec.js";
import type { LocalToolBackend } from "../src/backend/types.js";

describe("RescueExecBackend", () => {
  let workspaceDir: string;
  let backend: RescueExecBackend;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-web-agent-rescue-"));
    backend = new RescueExecBackend({
      workspaceDir,
      workspaceOnly: true,
      maxOutputChars: 100_000,
    });
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("publishes only the short-lived rescue schema", async () => {
    const [tool] = await backend.listTools();
    expect(tool.name).toBe("rescue_exec");
    expect(tool.description).toContain("independent of OpenClaw");
    expect(tool.description).toContain("never use as an automatic retry");
    expect(tool.inputSchema.required).toEqual(["command"]);
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(["command", "env", "timeout", "workdir"]);
    expect(properties).not.toHaveProperty("background");
    expect(properties).not.toHaveProperty("yieldMs");
    expect(properties).not.toHaveProperty("pty");
  });

  it("captures stdout, stderr, and non-zero exit status with exec-like details", async () => {
    const result = await backend.callTool(
      "rescue_exec",
      { command: "printf OUT; printf ERR >&2; exit 7" },
      { callId: "rescue-output" },
    );
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("OUT"),
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("ERR"),
    });
    expect(result.structuredContent).toMatchObject({
      status: "completed",
      exitCode: 7,
      exitSignal: null,
      exitReason: "exit",
      cwd: workspaceDir,
    });
  });

  it("terminates the process group on timeout without leaving the spawned child alive", async () => {
    const pidFile = path.join(workspaceDir, "child.pid");
    const result = await backend.callTool(
      "rescue_exec",
      {
        command: `sleep 30 & child=$!; printf '%s' "$child" > ${JSON.stringify(pidFile)}; wait`,
        timeout: 0.2,
      },
      { callId: "rescue-timeout" },
    );
    expect(result.structuredContent).toMatchObject({
      status: "failed",
      failureKind: "overall-timeout",
      exitReason: "overall-timeout",
      timedOut: true,
    });

    const childPid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
    expect(Number.isInteger(childPid)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it("uses the workspace cwd and rejects workdirs outside the configured boundary", async () => {
    const cwd = await backend.callTool(
      "rescue_exec",
      { command: "pwd" },
      { callId: "rescue-cwd" },
    );
    expect(cwd.structuredContent).toMatchObject({ cwd: workspaceDir });
    expect(cwd.content[0]).toMatchObject({ type: "text", text: `${workspaceDir}\n` });

    const outside = await backend.callTool(
      "rescue_exec",
      { command: "pwd", workdir: ".." },
      { callId: "rescue-outside" },
    );
    expect(outside.isError).toBe(true);
    expect(outside.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("must stay inside workspace"),
    });
  });

  it("inherits only the minimal environment while accepting explicit string overrides", async () => {
    const probeName = "CHATGPT_WEB_AGENT_RESCUE_SECRET_PROBE";
    const previous = process.env[probeName];
    process.env[probeName] = "must-not-leak";
    try {
      const inherited = await backend.callTool(
        "rescue_exec",
        { command: `printf '%s' "\${${probeName}-}"` },
        { callId: "rescue-env-inherited" },
      );
      expect(inherited.content[0]).toMatchObject({ type: "text", text: "" });

      const explicit = await backend.callTool(
        "rescue_exec",
        { command: "printf '%s' \"$RESCUE_TEMP\"", env: { RESCUE_TEMP: "explicit-ok" } },
        { callId: "rescue-env-explicit" },
      );
      expect(explicit.content[0]).toMatchObject({ type: "text", text: "explicit-ok" });
    } finally {
      if (previous === undefined) {
        delete process.env[probeName];
      } else {
        process.env[probeName] = previous;
      }
    }
  });

  it("rejects session/background fields and enforces the timeout hard cap", async () => {
    const background = await backend.callTool(
      "rescue_exec",
      { command: "true", background: true },
      { callId: "rescue-background" },
    );
    expect(background.isError).toBe(true);
    expect(background.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("does not support: background"),
    });

    const tooLong = await backend.callTool(
      "rescue_exec",
      { command: "true", timeout: 61 },
      { callId: "rescue-timeout-cap" },
    );
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("must not exceed 60 seconds"),
    });
  });

  it("bounds captured output instead of buffering an arbitrarily large child stream", async () => {
    const bounded = new RescueExecBackend({
      workspaceDir,
      workspaceOnly: true,
      maxOutputChars: 100,
    });
    const result = await bounded.callTool(
      "rescue_exec",
      { command: "node -e \"process.stdout.write('x'.repeat(10000))\"" },
      { callId: "rescue-output-cap" },
    );
    const aggregated = result.structuredContent?.aggregated;
    expect(typeof aggregated).toBe("string");
    expect(aggregated).toContain("rescue_exec truncated 9900 characters");
    expect(aggregated.length).toBeLessThan(200);
  });

  it("runs while a separate normal exec backend call is stuck", async () => {
    let releaseNormal: (() => void) | undefined;
    const normalBlocked = new Promise<void>((resolve) => {
      releaseNormal = resolve;
    });
    const stuckNormalBackend: LocalToolBackend = {
      id: "stuck-normal",
      async listTools() {
        return [
          {
            name: "exec",
            description: "simulated blocked normal exec",
            inputSchema: { type: "object", properties: {} },
          },
        ];
      },
      async callTool() {
        await normalBlocked;
        return { content: [{ type: "text", text: "released" }] };
      },
    };
    const composite = new CompositeBackend([stuckNormalBackend, backend]);
    await composite.listTools();
    const pendingNormal = composite.callTool("exec", {}, { callId: "normal-stuck" });
    const rescue = await composite.callTool(
      "rescue_exec",
      { command: "printf isolated-ok" },
      { callId: "rescue-isolated" },
    );
    expect(rescue.content[0]).toMatchObject({ type: "text", text: "isolated-ok" });
    releaseNormal?.();
    await pendingNormal;
  });
});
