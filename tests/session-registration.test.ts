import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalToolBackend } from "../src/backend/types.js";
import { createHttpMcpServer, type HttpMcpServer } from "../src/http-server.js";
import { RequestLedger, type RequestLedgerEvent } from "../src/request-ledger.js";
import { SessionRegistry, type SessionRecord } from "../src/session-registry.js";
import { SessionTools } from "../src/session-tools.js";
import { StateDatabase } from "../src/state-db.js";

const clients = new Set<Client>();
const servers = new Set<HttpMcpServer>();
const registries = new Set<SessionRegistry>();
const directories = new Set<string>();
const SOURCE_A = "wire-session-A-private-token";
const SOURCE_B = "wire-session-B-private-token";

afterEach(async () => {
  for (const client of clients) await client.close();
  clients.clear();
  for (const server of servers) await server.close();
  servers.clear();
  for (const registry of registries) registry.close();
  registries.clear();
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
  directories.clear();
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "webagent-session-wire-"));
  directories.add(directory);
  return directory;
}

function backend(call?: LocalToolBackend["callTool"]): LocalToolBackend {
  return {
    id: "session-wire-stub",
    async listTools() {
      return ["read", "exec", "process"].map(name => ({
        name,
        description: "Test backend action",
        inputSchema: { type: "object", properties: { path: { type: "string" }, mode: { type: "string" } } },
      }));
    },
    callTool: call ?? (async (name, args) => ({
      content: [{ type: "text", text: name + ":" + String(args.path ?? "") }],
    })),
  };
}

async function start(
  directory: string,
  options: { backend?: LocalToolBackend; now?: () => Date; sessions?: SessionTools } = {},
) {
  const ledgerDirectory = path.join(directory, "ledger");
  const ledger = new RequestLedger({
    enabled: true, directory: ledgerDirectory, retentionDays: 1, maxBytes: 4_000_000,
  }, "session-wire-test");
  const registry = options.sessions ? undefined : new SessionRegistry({
    storePath: path.join(directory, "sessions.sqlite"), now: options.now,
  });
  if (registry) registries.add(registry);
  const sessions = options.sessions ?? new SessionTools(registry!);
  const server = createHttpMcpServer({
    backend: options.backend ?? backend(), ledger, sessions, events: false,
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.server.once("error", reject);
    server.server.listen(0, "127.0.0.1", () => {
      server.server.off("error", reject);
      resolve();
    });
  });
  const address = server.server.address() as AddressInfo;
  return {
    server, registry, ledgerDirectory,
    endpoint: new URL("http://127.0.0.1:" + address.port + "/mcp"),
  };
}

async function connect(endpoint: URL, token?: string): Promise<Client> {
  const client = new Client(
    { name: "session-wire-client", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  clients.add(client);
  await client.connect(new StreamableHTTPClientTransport(endpoint, {
    requestInit: token ? { headers: { "x-openai-session": token } } : undefined,
  }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

async function register(client: Client, name: string): Promise<SessionRecord> {
  const result = await call(client, "session_register", { name });
  expect(result.isError).not.toBe(true);
  const data = result.structuredContent as { registered: boolean; binding: string; session: SessionRecord };
  expect(data).toMatchObject({ registered: true, binding: "upstream_session" });
  return data.session;
}

async function status(observer: Client, args: Record<string, unknown> = {}): Promise<SessionRecord[]> {
  const result = await call(observer, "session_status", args);
  expect(result.isError).not.toBe(true);
  return (result.structuredContent as { sessions: SessionRecord[] }).sessions;
}

async function ledgerRows(directory: string): Promise<RequestLedgerEvent[]> {
  const files = (await fs.readdir(directory)).filter(name => name.endsWith(".jsonl"));
  const bodies = await Promise.all(files.map(file => fs.readFile(path.join(directory, file), "utf8")));
  return bodies.flatMap(body => body.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

describe("conversation registration over real sessionless HTTP", () => {
  it("isolates concurrent same-name sources and attributes later tools without repeated names", async () => {
    const fixture = await start(await temporaryDirectory());
    const [a, b, observer] = await Promise.all([
      connect(fixture.endpoint, SOURCE_A), connect(fixture.endpoint, SOURCE_B), connect(fixture.endpoint),
    ]);
    const tools = (await a.listTools()).tools;
    expect(tools.find(tool => tool.name === "session_register")).toMatchObject({
      inputSchema: { required: ["name"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    expect(tools.find(tool => tool.name === "session_status")?.annotations?.readOnlyHint).toBe(true);
    const [registeredA, registeredB] = await Promise.all([register(a, "共同标题"), register(b, "共同标题")]);
    expect(registeredA.clientSessionKey).not.toBe(registeredB.clientSessionKey);

    await Promise.all([call(a, "read", { path: "from-A" }), call(b, "exec", { path: "from-B" })]);
    const entries = await status(observer, { name: "共同标题" });
    expect(entries).toHaveLength(2);
    expect(entries.find(entry => entry.clientSessionKey === registeredA.clientSessionKey)).toMatchObject({
      name: "共同标题", lastRequest: { tool: "read" }, lastResult: { tool: "read", ok: true },
    });
    expect(entries.find(entry => entry.clientSessionKey === registeredB.clientSessionKey)).toMatchObject({
      name: "共同标题", lastRequest: { tool: "exec" }, lastResult: { tool: "exec", ok: true },
    });

    await register(a, "UDG美术开发3");
    await register(a, "UDG美术开发3");
    await call(a, "process", { path: "from-A" });
    const after = await status(observer);
    expect(after).toHaveLength(2);
    expect(after.find(entry => entry.clientSessionKey === registeredA.clientSessionKey)).toMatchObject({
      name: "UDG美术开发3", firstRegisteredAt: registeredA.firstRegisteredAt,
      lastRequest: { tool: "process" }, lastResult: { tool: "process", ok: true },
    });
    expect(await status(observer, { name: "共同标题" })).toHaveLength(1);
    expect(await status(observer, { session_key: registeredB.clientSessionKey })).toMatchObject([
      { name: "共同标题", lastRequest: { tool: "exec" } },
    ]);

    const rows = await ledgerRows(fixture.ledgerDirectory);
    expect(rows.find(row => row.phase === "mcp_call_received" && row.tool === "read")).toMatchObject({
      clientSessionKey: registeredA.clientSessionKey, sessionName: "共同标题",
    });
    expect(rows.find(row => row.phase === "mcp_call_completed" && row.tool === "exec")).toMatchObject({
      clientSessionKey: registeredB.clientSessionKey, sessionName: "共同标题",
    });
    expect(rows.find(row => row.phase === "mcp_call_completed" && row.tool === "process")).toMatchObject({
      clientSessionKey: registeredA.clientSessionKey, sessionName: "UDG美术开发3",
    });
    expect(JSON.stringify(rows)).not.toContain(SOURCE_A);
    expect(JSON.stringify(rows)).not.toContain(SOURCE_B);
  });

  it("retains a binding across frontend shutdown and a fresh HTTP client", async () => {
    const directory = await temporaryDirectory();
    const first = await start(directory);
    const a = await connect(first.endpoint, SOURCE_A);
    const registration = await register(a, "持久会话");
    await call(a, "read");
    await a.close();
    clients.delete(a);
    await first.server.close();
    servers.delete(first.server);

    const second = await start(directory);
    const [reconnected, observer] = await Promise.all([
      connect(second.endpoint, SOURCE_A), connect(second.endpoint),
    ]);
    await call(reconnected, "exec");
    expect(await status(observer)).toMatchObject([{
      clientSessionKey: registration.clientSessionKey,
      name: "持久会话",
      firstRegisteredAt: registration.firstRegisteredAt,
      lastRequest: { tool: "exec" },
      lastResult: { tool: "exec", ok: true },
    }]);
  });

  it("never borrows a prior registration when the request has no source identity", async () => {
    const fixture = await start(await temporaryDirectory());
    const [a, anonymous] = await Promise.all([connect(fixture.endpoint, SOURCE_A), connect(fixture.endpoint)]);
    const registered = await register(a, "已登记会话");
    const rejected = await call(anonymous, "session_register", { name: "没有来源" });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).toContain("session_identity_unavailable");
    expect((await call(anonymous, "read", { path: "still-available" })).isError).not.toBe(true);
    expect(await status(anonymous)).toMatchObject([{
      clientSessionKey: registered.clientSessionKey, name: "已登记会话",
      lastRequest: { tool: "session_register" },
    }]);
    const read = (await ledgerRows(fixture.ledgerDirectory)).find(
      row => row.phase === "mcp_call_completed" && row.tool === "read",
    );
    expect(read?.clientSessionKey).toBeUndefined();
    expect(read?.sessionName).toBeUndefined();
  });

  it("records returned and thrown failures without turning completions into new chat requests", async () => {
    let time = Date.parse("2026-11-12T01:00:00Z");
    const fixture = await start(await temporaryDirectory(), {
      now: () => new Date(time),
      backend: backend(async (_name, args): Promise<CallToolResult> => {
        time += 60_000;
        if (args.mode === "throw") throw new TypeError("deliberate backend failure");
        return { content: [{ type: "text", text: "deliberate tool failure" }], isError: true };
      }),
    });
    const [a, observer] = await Promise.all([connect(fixture.endpoint, SOURCE_A), connect(fixture.endpoint)]);
    await register(a, "错误观察");
    const returnedStart = new Date(time).toISOString();
    expect((await call(a, "read", { mode: "error" })).isError).toBe(true);
    expect((await status(observer))[0]).toMatchObject({
      lastRequest: { tool: "read", receivedAt: returnedStart },
      lastResult: { tool: "read", completedAt: new Date(time).toISOString(), ok: false },
    });
    const thrownStart = new Date(time).toISOString();
    await expect(call(a, "exec", { mode: "throw" })).rejects.toThrow();
    expect((await status(observer))[0]).toMatchObject({
      lastRequest: { tool: "exec", receivedAt: thrownStart },
      lastResult: { tool: "exec", completedAt: new Date(time).toISOString(), ok: false, errorKind: "TypeError" },
    });
    expect((await ledgerRows(fixture.ledgerDirectory)).find(
      row => row.phase === "mcp_call_failed" && row.tool === "exec",
    )).toMatchObject({ sessionName: "错误观察", ok: false, errorKind: "TypeError" });
  });

  it("keeps a delayed call's original label when the same source is renamed in flight", async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fixture = await start(await temporaryDirectory(), {
      backend: backend(async () => {
        enter();
        await gate;
        return { content: [{ type: "text", text: "finished" }] };
      }),
    });
    const a = await connect(fixture.endpoint, SOURCE_A);
    await register(a, "原名");
    const pending = call(a, "read");
    try {
      await entered;
      await register(a, "新名");
    } finally {
      release();
    }
    await pending;
    const rows = (await ledgerRows(fixture.ledgerDirectory)).filter(row => row.tool === "read");
    expect(rows.filter(row => row.phase === "mcp_call_received" || row.phase === "mcp_call_completed"))
      .toMatchObject([{ sessionName: "原名" }, { sessionName: "原名" }]);
    const observer = await connect(fixture.endpoint);
    expect((await status(observer))[0]).toMatchObject({
      name: "新名", lastRequest: { tool: "session_register" }, lastResult: { tool: "read" },
    });
  });

  it("does not stall HTTP tools behind another connection's SQLite write lock", async () => {
    const directory = await temporaryDirectory();
    const fixture = await start(directory);
    const a = await connect(fixture.endpoint, SOURCE_A);
    const registered = await register(a, "锁竞争前的名字");
    const blocker = new StateDatabase(path.join(directory, "sessions.sqlite"));
    blocker.db.exec("BEGIN IMMEDIATE");
    try {
      const readStarted = performance.now();
      const result = await call(a, "read", { path: "work-during-lock" });
      expect(performance.now() - readStarted).toBeLessThan(2_000);
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "read:work-during-lock" }]);

      const registerStarted = performance.now();
      const rejected = await call(a, "session_register", { name: "不应保存的新名字" });
      expect(performance.now() - registerStarted).toBeLessThan(2_000);
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected.content)).toMatch(/locked|busy/i);
    } finally {
      blocker.db.exec("ROLLBACK");
      blocker.close();
    }
    expect(fixture.registry!.get(registered.clientSessionKey)?.name).toBe("锁竞争前的名字");
    await call(a, "read", { path: "after-unlock" });
    expect(fixture.registry!.get(registered.clientSessionKey)).toMatchObject({
      name: "锁竞争前的名字",
      lastRequest: { tool: "read" },
      lastResult: { tool: "read", ok: true },
    });
    expect((await ledgerRows(fixture.ledgerDirectory)).some(
      row => row.phase === "session_observation_failed",
    )).toBe(true);
  });

  it("keeps ordinary tools usable when the optional session store is unavailable", async () => {
    const fixture = await start(await temporaryDirectory(), {
      sessions: new SessionTools(() => { throw new Error("session store unavailable"); }),
    });
    const a = await connect(fixture.endpoint, SOURCE_A);
    const registered = await call(a, "session_register", { name: "不会假成功" });
    expect(registered.isError).toBe(true);
    expect(JSON.stringify(registered.content)).toContain("session store unavailable");
    const result = await call(a, "read", { path: "normal-work" });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "read:normal-work" }]);
    expect((await ledgerRows(fixture.ledgerDirectory)).some(row => row.phase === "session_observation_failed")).toBe(true);
  });
});
