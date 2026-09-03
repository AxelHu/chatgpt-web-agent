import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RequestLedger, summarizeToolArgs } from "../src/request-ledger.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "request-ledger-"));
  dirs.push(dir);
  return dir;
}

describe("RequestLedger", () => {
  it("writes metadata without command or tool output contents", () => {
    const directory = tempDir();
    const ledger = new RequestLedger(
      { enabled: true, directory, retentionDays: 7, maxBytes: 1024 * 1024 },
      "test",
    );
    ledger.record({
      phase: "mcp_call_received",
      callId: "call-1",
      tool: "exec",
      metadata: summarizeToolArgs("exec", { command: "TOP_SECRET_COMMAND", timeout: 3 }),
    });
    const files = fs.readdirSync(directory);
    expect(files).toHaveLength(1);
    const raw = fs.readFileSync(path.join(directory, files[0]!), "utf8");
    expect(raw).toContain('"phase":"mcp_call_received"');
    expect(raw).toContain('"commandChars":18');
    expect(raw).not.toContain("TOP_SECRET_COMMAND");
  });

  it("prunes ledger files older than the configured retention", () => {
    const directory = tempDir();
    const oldFile = path.join(directory, "2020-01-01.jsonl");
    fs.writeFileSync(oldFile, "old\n");
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, old, old);
    const ledger = new RequestLedger(
      { enabled: true, directory, retentionDays: 7, maxBytes: 1024 * 1024 },
      "test",
    );
    expect(fs.existsSync(oldFile)).toBe(false);
    ledger.record({ phase: "still_works" });
    expect(fs.readdirSync(directory).some((name) => name.endsWith(".jsonl"))).toBe(true);
  });

  it("enforces the configured total byte ceiling across old daily files", () => {
    const directory = tempDir();
    const first = path.join(directory, "2026-09-01.jsonl");
    const second = path.join(directory, "2026-09-02.jsonl");
    fs.writeFileSync(first, "a".repeat(800));
    fs.writeFileSync(second, "b".repeat(800));
    const recent = new Date(Date.now() - 60_000);
    fs.utimesSync(first, new Date(recent.getTime() - 1000), new Date(recent.getTime() - 1000));
    fs.utimesSync(second, recent, recent);
    new RequestLedger(
      { enabled: true, directory, retentionDays: 7, maxBytes: 1024 },
      "test",
    );
    const total = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0);
    expect(total).toBeLessThanOrEqual(1024);
    expect(fs.existsSync(second)).toBe(true);
  });
});
