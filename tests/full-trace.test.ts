import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { FullTrace, sanitizeFullTraceValue } from "../src/full-trace.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "full-trace-"));
  dirs.push(dir);
  return dir;
}

function dateKey(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

describe("FullTrace", () => {
  it("preserves ordinary request and response text", () => {
    const directory = tempDir();
    const trace = new FullTrace(
      { enabled: true, directory, retentionDays: 7, maxBytes: 16 * 1024 * 1024 },
      "test",
    );
    trace.record({
      phase: "request",
      callId: "call-1",
      payload: {
        command: "printf DIAGNOSTIC_COMMAND && cat /tmp/example.txt",
        patch: "*** Begin Patch\n+ordinary patch body\n*** End Patch",
        message: "ordinary message body",
      },
    });
    trace.record({
      phase: "response",
      callId: "call-1",
      payload: { content: [{ type: "text", text: "complete tool output for diagnosis" }] },
    });
    const raw = fs.readFileSync(path.join(directory, `${dateKey(0)}.jsonl`), "utf8");
    expect(raw).toContain("DIAGNOSTIC_COMMAND");
    expect(raw).toContain("ordinary patch body");
    expect(raw).toContain("ordinary message body");
    expect(raw).toContain("complete tool output for diagnosis");
  });

  it("redacts narrow credential patterns but preserves surrounding command context", () => {
    const sanitized = sanitizeFullTraceValue({
      env: { NORMAL_FLAG: "visible", GITEA_TOKEN: "gitea-secret-value" },
      Authorization: "Bearer exact-secret-header",
      credentialsPath: "/home/me/.credentials/service.json",
      tokenPath: "/home/me/.credentials/token.json",
      command:
        "curl -H 'Authorization: Bearer command-secret-token' https://example.test && API_KEY='inline-secret' run --token 'flag-secret' --verbose",
      output: '{"token":"json-secret-value","status":"visible"}',
      yaml: "token: yaml-secret-value\nmode: visible",
    });
    const raw = JSON.stringify(sanitized);
    expect(raw).toContain("NORMAL_FLAG");
    expect(raw).toContain("visible");
    expect(raw).toContain("credentialsPath");
    expect(raw).toContain("tokenPath");
    expect(raw).toContain("curl -H");
    expect(raw).toContain("https://example.test");
    expect(raw).not.toContain("gitea-secret-value");
    expect(raw).not.toContain("exact-secret-header");
    expect(raw).not.toContain("command-secret-token");
    expect(raw).not.toContain("inline-secret");
    expect(raw).not.toContain("flag-secret");
    expect(raw).not.toContain("json-secret-value");
    expect(raw).not.toContain("yaml-secret-value");
  });

  it("replaces image and large base64 blobs with hashes", () => {
    const image = "A".repeat(8192);
    const sanitized = sanitizeFullTraceValue({
      content: [{ type: "image", mimeType: "image/png", data: image }],
    }) as Record<string, unknown>;
    const raw = JSON.stringify(sanitized);
    expect(raw).toContain('"kind":"binary"');
    expect(raw).toContain('"encoding":"base64-image"');
    expect(raw).toContain('"chars":8192');
    expect(raw).not.toContain(image);
  });

  it("compresses inactive daily traces with zstd", () => {
    const directory = tempDir();
    const yesterday = path.join(directory, `${dateKey(1)}.jsonl`);
    fs.writeFileSync(yesterday, '{"old":"trace text that should survive compression"}\n');
    const trace = new FullTrace(
      { enabled: true, directory, retentionDays: 7, maxBytes: 16 * 1024 * 1024 },
      "test",
    );
    trace.record({ phase: "today", payload: { ok: true } });
    const compressed = `${yesterday}.zst`;
    expect(fs.existsSync(yesterday)).toBe(false);
    expect(fs.existsSync(compressed)).toBe(true);
    const restored = zstdDecompressSync(fs.readFileSync(compressed)).toString("utf8");
    expect(restored).toContain("trace text that should survive compression");
  });

  it("prunes traces outside retention", () => {
    const directory = tempDir();
    const stale = path.join(directory, `${dateKey(10)}.jsonl`);
    fs.writeFileSync(stale, "stale\n");
    new FullTrace(
      { enabled: true, directory, retentionDays: 7, maxBytes: 16 * 1024 * 1024 },
      "test",
    );
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(`${stale}.zst`)).toBe(false);
  });

  it("enforces the configured total byte ceiling across inactive traces", () => {
    const directory = tempDir();
    for (const daysAgo of [2, 1]) {
      fs.writeFileSync(
        path.join(directory, `${dateKey(daysAgo)}.jsonl`),
        Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 73 + daysAgo) % 256)),
      );
    }
    const trace = new FullTrace(
      { enabled: true, directory, retentionDays: 7, maxBytes: 5000 },
      "test",
    );
    trace.record({ phase: "today", payload: { diagnostic: "visible" } });
    const total = fs
      .readdirSync(directory)
      .filter((name) => /\.jsonl(?:\.zst)?$/.test(name))
      .reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0);
    expect(total).toBeLessThanOrEqual(5000);
    expect(fs.existsSync(path.join(directory, `${dateKey(0)}.jsonl`))).toBe(true);
  });
});
