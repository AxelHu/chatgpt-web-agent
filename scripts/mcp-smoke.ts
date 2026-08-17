import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-web-agent-smoke-"));
await fs.writeFile(path.join(workspaceDir, "probe.txt"), "mcp-read-ok\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.resolve("dist/cli.js")],
  env: {
    ...process.env,
    CHATGPT_WEB_AGENT_WORKSPACE: workspaceDir,
    CHATGPT_WEB_AGENT_EXEC_SECURITY: "full",
    CHATGPT_WEB_AGENT_EXEC_ASK: "off",
  },
  stderr: "pipe",
});
const client = new Client({ name: "chatgpt-web-agent-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const read = await client.callTool({ name: "read", arguments: { path: "probe.txt" } });
  const exec = await client.callTool({ name: "exec", arguments: { command: "printf mcp-exec-ok" } });
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
  await fs.rm(workspaceDir, { recursive: true, force: true });
}
