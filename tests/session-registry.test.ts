import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../src/session-registry.js";
import { StateDatabase } from "../src/state-db.js";

const KEY_A = "v1:0123456789abcdef";
const KEY_B = "v1:fedcba9876543210";
const KEY_C = "v1:0000000000000003";
const BASE = Date.UTC(2026, 10, 12);
const registries: SessionRegistry[] = [];
const databases: StateDatabase[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "session-registry-"));
  directories.push(directory);
  return directory;
}

function create(options: ConstructorParameters<typeof SessionRegistry>[0] = {}): SessionRegistry {
  const registry = new SessionRegistry(options);
  registries.push(registry);
  return registry;
}

function setup() {
  const storePath = path.join(tempDirectory(), "sessions.sqlite");
  let time = BASE;
  const now = () => new Date(time);
  return {
    registry: create({ storePath, now }),
    storePath,
    now,
    advance: () => { time += 1000; },
  };
}

describe("SessionRegistry", () => {
  it("normalizes the display name and keeps same-name client identities separate", () => {
    const { registry } = setup();
    const first = registry.register(KEY_A, "  UDG 美术开发  ");
    registry.register(KEY_B, "UDG 美术开发");
    expect(first).toEqual({
      clientSessionKey: KEY_A,
      name: "UDG 美术开发",
      firstRegisteredAt: new Date(BASE).toISOString(),
      lastRegisteredAt: new Date(BASE).toISOString(),
    });
    expect(registry.list()).toHaveLength(2);
    registry.requestStarted(KEY_A, "call-a", "exec");
    expect(registry.get(KEY_B)?.lastRequest).toBeUndefined();
    expect(registry.get(KEY_A)?.lastRequest?.callId).toBe("call-a");
  });

  it("updates a registration and name without resetting its first timestamp or observations", () => {
    const { registry, advance } = setup();
    const first = registry.register(KEY_A, "开发");
    advance();
    registry.requestStarted(KEY_A, "call-1", "read");
    advance();
    registry.requestFinished(KEY_A, "call-1", "read", true, 1000);
    const observed = registry.get(KEY_A)!;
    advance();
    const renamed = registry.register(KEY_A, "开发续轮");
    expect(renamed).toEqual({
      ...observed,
      name: "开发续轮",
      lastRegisteredAt: new Date(BASE + 3000).toISOString(),
    });
    expect(renamed.firstRegisteredAt).toBe(first.firstRegisteredAt);
    expect(registry.list()).toHaveLength(1);
  });

  it("never creates anonymous registrations from ordinary request observations", () => {
    const { registry } = setup();
    expect(registry.requestStarted(KEY_A, "unknown", "exec")).toBeUndefined();
    registry.requestFinished(KEY_A, "unknown", "exec", true, 5);
    expect(registry.get(KEY_A)).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("records results separately even when an older request completes after a newer one starts", () => {
    const { registry, advance } = setup();
    const registered = registry.register(KEY_A, "构建");
    advance();
    registry.requestStarted(KEY_A, "slow", "exec");
    advance();
    const pending = registry.requestStarted(KEY_A, "newer", "read")!;
    advance();
    registry.requestFinished(KEY_A, "slow", "exec", false, 2000, "TimeoutError");
    expect(registry.get(KEY_A)).toEqual({
      ...pending,
      lastResult: {
        callId: "slow", tool: "exec", completedAt: new Date(BASE + 3000).toISOString(),
        ok: false, durationMs: 2000, errorKind: "TimeoutError",
      },
    });
    expect(registry.get(KEY_A)?.lastRegisteredAt).toBe(registered.lastRegisteredAt);
    advance();
    registry.requestFinished(KEY_A, "newer", "read", true, 2000);
    expect(registry.get(KEY_A)?.lastRequest).toEqual(pending.lastRequest);
    expect(registry.get(KEY_A)?.lastResult).not.toHaveProperty("errorKind");
  });

  it("persists registrations and observations after closing and reopening the database", () => {
    const { registry, storePath, advance } = setup();
    registry.register(KEY_A, "持久化");
    advance();
    registry.requestStarted(KEY_A, "persist", "apply_patch");
    advance();
    registry.requestFinished(KEY_A, "persist", "apply_patch", false, 1000, "ToolError");
    const expected = registry.get(KEY_A);
    registry.close();
    const reopened = create({ storePath });
    expect(reopened.get(KEY_A)).toEqual(expected);
    expect(reopened.list()).toEqual([expected]);
  });

  it("preserves interleaved updates from two database connections to the same store", () => {
    const { registry: a, storePath, now, advance } = setup();
    const db = new StateDatabase(storePath);
    databases.push(db);
    const b = create({ db, now });
    a.register(KEY_A, "第一轮");
    advance();
    a.requestStarted(KEY_A, "first", "exec");
    advance();
    b.register(KEY_A, "第二轮");
    advance();
    a.requestFinished(KEY_A, "first", "exec", true, 2000);
    advance();
    b.requestStarted(KEY_A, "second", "process");
    advance();
    a.register(KEY_A, "最新名称");
    expect(a.get(KEY_A)).toEqual(b.get(KEY_A));
    expect(b.get(KEY_A)).toMatchObject({
      name: "最新名称",
      firstRegisteredAt: new Date(BASE).toISOString(),
      lastRegisteredAt: new Date(BASE + 5000).toISOString(),
      lastRequest: { callId: "second", receivedAt: new Date(BASE + 4000).toISOString() },
      lastResult: { callId: "first", completedAt: new Date(BASE + 3000).toISOString() },
    });
    b.register(KEY_B, "其他会话");
    expect(a.list()).toHaveLength(2);
    b.close();
    expect(db.count("sessions")).toBe(2); // The caller owns an injected database.
  });

  it.each(["", "   ", "x".repeat(201), "\tname", "name\n", "bad\u0000name", "bad\u007fname", "bad\u0085name"])(
    "rejects invalid display name %j without creating a record", name => {
      const { registry } = setup();
      expect(() => registry.register(KEY_A, name)).toThrow("Invalid session name");
      expect(registry.list()).toEqual([]);
    },
  );

  it("allows the maximum name length and rejects invalid renames without changing an existing record", () => {
    const { registry } = setup();
    const registered = registry.register(KEY_A, "中".repeat(200));
    expect(() => registry.register(KEY_A, "\nnew")).toThrow("Invalid session name");
    expect(registry.get(KEY_A)).toEqual(registered);
  });

  it.each(["", "raw-client-token", "v1:short", "v1:0123456789abcdef0", "v1:0123456789abcdeg", "v2:0123456789abcdef", "v1:ABCDEF0123456789", " v1:0123456789abcdef", "v1:0123456789abcdef\n", "v1:0123456789abcdef\r"])(
    "rejects an unhashed or malformed client key %j across the public operations", key => {
      const { registry } = setup();
      expect(() => registry.register(key, "valid")).toThrow("Invalid client session key");
      expect(() => registry.get(key)).toThrow("Invalid client session key");
      expect(() => registry.requestStarted(key, "call", "exec")).toThrow("Invalid client session key");
      expect(() => registry.requestFinished(key, "call", "exec", true, 0)).toThrow("Invalid client session key");
      expect(registry.list()).toEqual([]);
    },
  );

  it("orders by the latest request or registration, ignores completion time, and matches names exactly", () => {
    const { registry, advance } = setup();
    registry.register(KEY_A, "UDG 美术");
    advance();
    registry.register(KEY_B, "其他");
    advance();
    registry.register(KEY_C, "UDG 美术");
    advance();
    registry.requestStarted(KEY_A, "latest-request", "read");
    advance();
    registry.requestFinished(KEY_B, "old-work", "exec", true, 1000);
    expect(registry.list().map(row => row.clientSessionKey)).toEqual([KEY_A, KEY_C, KEY_B]);
    expect(registry.list(1, "UDG 美术").map(row => row.clientSessionKey)).toEqual([KEY_A]);
    expect(registry.list(50, "UDG")).toEqual([]);
    expect(registry.list(50, "UDG 美术 ")).toEqual([]);
    advance();
    registry.register(KEY_B, "其他");
    expect(registry.list().map(row => row.clientSessionKey)).toEqual([KEY_B, KEY_A, KEY_C]);
    expect(registry.list(50, "UDG 美术").map(row => row.clientSessionKey)).toEqual([KEY_A, KEY_C]);
  });

  it("defaults to 50 rows, caps results at 200, and validates the limit", () => {
    const db = new StateDatabase(path.join(tempDirectory(), "sessions.sqlite"));
    databases.push(db);
    let time = BASE;
    const registry = create({ db, now: () => new Date(time) });
    // This case tests query limits, not 205 independent fsync operations.
    db.atomic(() => {
      for (let i = 0; i < 205; i++) {
        registry.register(`v1:${i.toString(16).padStart(16, "0")}`, `session-${i}`);
        time += 1000;
      }
    });
    expect(registry.list()).toHaveLength(50);
    expect(registry.list(500)).toHaveLength(200);
    expect(registry.list(1)[0]?.name).toBe("session-204");
    for (const limit of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => registry.list(limit)).toThrow("positive integer");
    }
  });

  it("propagates database write failures and leaves prior records unchanged", () => {
    const storePath = path.join(tempDirectory(), "sessions.sqlite");
    const db = new StateDatabase(storePath);
    databases.push(db);
    const registry = create({ db });
    const previous = registry.register(KEY_A, "unchanged");
    db.db.exec("PRAGMA query_only=ON");
    try {
      expect(() => registry.register(KEY_A, "rename")).toThrow();
      expect(() => registry.register(KEY_B, "new")).toThrow();
      expect(() => registry.requestStarted(KEY_A, "call", "exec")).toThrow();
      expect(() => registry.requestFinished(KEY_A, "call", "exec", true, 1)).toThrow();
      expect(registry.get(KEY_A)).toEqual(previous);
      expect(registry.get(KEY_B)).toBeUndefined();
    } finally {
      db.db.exec("PRAGMA query_only=OFF");
    }
    expect(registry.register(KEY_A, "recovered").name).toBe("recovered");
  });

  it("rejects invalid durations rather than silently persisting null or negative measurements", () => {
    const { registry } = setup();
    registry.register(KEY_A, "duration");
    for (const duration of [NaN, Infinity, -1]) {
      expect(() => registry.requestFinished(KEY_A, "call", "exec", true, duration)).toThrow("finite, non-negative");
    }
    expect(registry.get(KEY_A)?.lastResult).toBeUndefined();
  });

  it("fails observations and registration promptly while a second connection holds the write lock", () => {
    const { registry, storePath } = setup();
    const original = registry.register(KEY_A, "locked-source");
    const writer = new StateDatabase(storePath);
    databases.push(writer);
    writer.atomic(() => {
      const started = performance.now();
      expect(() => registry.requestStarted(KEY_A, "blocked", "read")).toThrow(/locked|busy/i);
      expect(() => registry.requestFinished(KEY_A, "blocked", "read", true, 1)).toThrow(/locked|busy/i);
      expect(() => registry.register(KEY_A, "must-not-report-success")).toThrow(/locked|busy/i);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(registry.get(KEY_A)).toEqual(original);
    });
    expect(registry.requestStarted(KEY_A, "recovered", "read")?.lastRequest?.callId).toBe("recovered");
    registry.requestFinished(KEY_A, "recovered", "read", true, 1);
    expect(registry.get(KEY_A)?.lastResult).toMatchObject({ callId: "recovered", ok: true });
  });

  it("preserves the existing timeout and durability defaults without changing an injected database", () => {
    const db = new StateDatabase(path.join(tempDirectory(), "shared.sqlite"));
    databases.push(db);
    expect(db.db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    expect(db.db.prepare("PRAGMA synchronous").get()?.synchronous).toBe(2); // FULL
    create({ db });
    expect(db.db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    expect(db.db.prepare("PRAGMA synchronous").get()?.synchronous).toBe(2);
  });

  it("uses zero lock waiting and NORMAL durability on its own summary database connection", () => {
    const put = vi.spyOn(StateDatabase.prototype, "put");
    const { registry } = setup();
    registry.register(KEY_A, "summary");
    const db = put.mock.contexts[0] as StateDatabase;
    expect(db.db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(0);
    expect(db.db.prepare("PRAGMA synchronous").get()?.synchronous).toBe(1); // NORMAL
    expect(db.db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
  });

  it("rejects unsupported durability settings before opening a database", () => {
    const storePath = path.join(tempDirectory(), "invalid-mode.sqlite");
    expect(() => new StateDatabase(storePath, { synchronous: "OFF" as "FULL" })).toThrow("FULL or NORMAL");
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("closes a newly opened SQLite handle when schema initialization fails", () => {
    const storePath = path.join(tempDirectory(), "invalid-schema.sqlite");
    const malformed = new DatabaseSync(storePath);
    malformed.exec("CREATE TABLE objects (wrong_column TEXT)");
    malformed.close();
    const close = vi.spyOn(DatabaseSync.prototype, "close");
    expect(() => new StateDatabase(storePath, { busyTimeoutMs: 0 })).toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("uses the explicit path, environment override, XDG state directory, or home state default", () => {
    const root = tempDirectory();
    const override = path.join(root, "override.sqlite");
    vi.stubEnv("CHATGPT_WEB_AGENT_SESSION_STORE", override);
    expect(create().storePath).toBe(override);
    const explicit = path.join(root, "explicit.sqlite");
    expect(create({ storePath: explicit }).storePath).toBe(explicit);
    vi.stubEnv("CHATGPT_WEB_AGENT_SESSION_STORE", "");
    const xdg = path.join(root, "xdg");
    vi.stubEnv("XDG_STATE_HOME", xdg);
    expect(create().storePath).toBe(path.join(xdg, "chatgpt-web-agent", "sessions.sqlite"));
    vi.stubEnv("XDG_STATE_HOME", "");
    vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "user"));
    expect(create().storePath).toBe(path.join(root, "user", ".local", "state", "chatgpt-web-agent", "sessions.sqlite"));
  });
});
