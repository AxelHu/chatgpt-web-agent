import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { createExecRuntimeBackend } from "../src/backend/exec-runtime-client.js";
import { loadBridgeConfig } from "../src/config.js";
import { createExecRuntimeServer } from "../src/exec-runtime-server.js";

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-web-agent-smoke-"));
await fs.writeFile(path.join(workspaceDir, "probe.txt"), "mcp-read-ok\n");
const socketPath = path.join(workspaceDir, "exec-runtime.sock");
const runtimeEnv = {
  ...process.env,
  CHATGPT_WEB_AGENT_WORKSPACE: workspaceDir,
  CHATGPT_WEB_AGENT_EXEC_SECURITY: "full",
  CHATGPT_WEB_AGENT_EXEC_ASK: "off",
  CHATGPT_WEB_AGENT_EXEC_RUNTIME_SOCKET: socketPath,
};
const runtimeConfig = loadBridgeConfig(runtimeEnv, workspaceDir);
const runtime = createExecRuntimeServer(createExecRuntimeBackend(runtimeConfig), socketPath);
await runtime.listen();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/cli.js")],
  env: runtimeEnv,
  stderr: "pipe",
});
const client = new Client({ name: "chatgpt-web-agent-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const read = await client.callTool({ name: "read", arguments: { path: "probe.txt" } });
  const exec = await client.callTool({ name: "exec", arguments: { command: "printf mcp-exec-ok" } });
  const rescueExec = await client.callTool({
    name: "rescue_exec",
    arguments: { command: "printf mcp-rescue-ok" },
  });
  const patch = await client.callTool({
    name: "apply_patch",
    arguments: {
      input: [
        "*** Begin Patch",
        "*** Update File: probe.txt",
        "@@",
        "-mcp-read-ok",
        "+mcp-patch-ok",
        "*** End Patch",
      ].join("\n"),
    },
  });
  const background = await client.callTool({
    name: "exec",
    arguments: {
      command: `node -e "setTimeout(()=>console.log('mcp-process-ok'),100)"`,
      background: true,
    },
  });
  const sessionId = (background.structuredContent as { sessionId?: string } | undefined)?.sessionId;
  if (!sessionId) {
    throw new Error("background exec did not return a process session id");
  }
  const managedProcess = await client.callTool({
    name: "process",
    arguments: { action: "poll", sessionId, timeout: 5_000 },
  });
  const patchedText = await fs.readFile(path.join(workspaceDir, "probe.txt"), "utf8");
  process.stdout.write(
    `${JSON.stringify(
      {
        tools: listed.tools.map((tool) => tool.name).sort(),
        read: read.content,
        exec: exec.content,
        rescueExec: rescueExec.content,
        patch: patch.content,
        patchedText,
        process: managedProcess.content,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await client.close();
  await runtime.close();
  await fs.rm(workspaceDir, { recursive: true, force: true });
}
