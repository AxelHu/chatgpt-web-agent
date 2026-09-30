#!/usr/bin/env node
import { EventRuntime } from "./events.js";

function usage(): never {
  process.stderr.write(
    "Usage: chatgpt-web-agent-event emit --topic <topic> --reason <reason> " +
    "[--summary <text>] [--state-ref <ref>] [--source <source>] [--sequence <n>]\n",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) usage();
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "emit") usage();
  const args = parseArgs(rest);
  const topic = args.topic;
  const reason = args.reason;
  if (!topic || !reason) usage();
  const sequence = args.sequence === undefined ? undefined : Number.parseInt(args.sequence, 10);
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0)) usage();

  const runtime = new EventRuntime();
  const result = await runtime.emitContinue({
    topic,
    trigger_reason: reason,
    summary: args.summary,
    state_ref: args["state-ref"],
    source: args.source,
    sequence,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

