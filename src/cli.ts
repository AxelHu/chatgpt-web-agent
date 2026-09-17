#!/usr/bin/env node
import { createBridgeRuntime } from "./runtime.js";
import { createLocalMcpServer } from "./server.js";

async function main(): Promise<void> {
  const { backend, ledger, trace } = createBridgeRuntime();
  const localServer = createLocalMcpServer(backend, ledger, trace);
  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await localServer.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  process.stdin.once("end", () => void close());
  process.stdin.once("close", () => void close());

  await localServer.serveStdio();
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[chatgpt-web-agent] ${message}\n`);
  process.exitCode = 1;
});
