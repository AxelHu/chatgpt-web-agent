import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EventRuntime, type EventRuntimeOptions } from "../src/events.js";
import { EventRequestAudit } from "../src/event-request-audit.js";
import { RequestLedger } from "../src/request-ledger.js";
import { createHttpMcpServer } from "../src/http-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const secret = `whsec_${Buffer.alloc(32, 83).toString("base64")}`;
const callback = "https://receiver.invalid/PRIVATE_CALLBACK_PATH?key=PRIVATE_QUERY";
const privateTopic = "poc:PRIVATE_TOPIC";
const params = () => ({
  name: "workflow.continue", arguments: { topic: privateTopic },
  delivery: { mode: "webhook", url: callback, secret }, ttlMs: 120_000,
});

async function fixture(options: Partial<EventRuntimeOptions> = {}, enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-audit-"));
  const ledgerDir = path.join(dir, "ledger");
  const ledger = new RequestLedger({ enabled, directory: ledgerDir, retentionDays: 7, maxBytes: 1024 * 1024 }, "test");
  const runtime = new EventRuntime({
    storePath: path.join(dir, "events.sqlite"),
    validateCallback: async () => {},
    sender: async (_sub, body) => ({ ok: true, status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }),
    ...options,
  });
  const server = createHttpMcpServer({
    backend: { id: "test", listTools: async () => [], callTool: async () => ({ content: [] }) },
    events: runtime, ledger,
  });
  await new Promise<void>(resolve => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: "local-event-audit-test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`)));
  cleanups.push(async () => { await client.close(); await server.close(); runtime.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const text = () => fs.existsSync(ledgerDir)
    ? fs.readdirSync(ledgerDir).filter(f => f.endsWith(".jsonl")).map(f => fs.readFileSync(path.join(ledgerDir, f), "utf8")).join("") : "";
  const records = () => text().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const request = (method: string, args: Record<string, unknown>) => client.request({ method, params: args }, z.record(z.string(), z.unknown()));
  return { runtime, ledger, text, records, request, endpoint };
}

function expectRedacted(text: string) {
  for (const value of [secret, callback, "PRIVATE_QUERY", "PRIVATE_TOPIC", "PRIVATE_ERROR", "PRIVATE_CHALLENGE"])
    expect(text).not.toContain(value);
}

describe("redacted event request lifecycle on the real MCP HTTP path", () => {
  it("records schema rejection even before the event handler runs", async () => {
    const f = await fixture();
    await expect(f.request("events/subscribe", { name: "workflow.continue" })).rejects.toBeDefined();
    expect(f.records().filter(r => r.phase === "event_request_received")).toHaveLength(1);
    expect(f.records().filter(r => r.phase === "event_request_rejected")).toMatchObject([{ errorKind: "InvalidParams" }]);
    expect(f.records().some(r => r.phase === "event_request_validated")).toBe(false);
    expect(await f.runtime.subscriptions()).toHaveLength(0);
  });

  it.each([
    ["invalid URL", "invalid_url", { validateCallback: async () => { throw new Error("PRIVATE_ERROR"); } }],
    ["network failure", "timeout", { sender: async () => { throw new Error("PRIVATE_ERROR"); } }],
    ["negative status", "challenge_failed", { sender: async () => ({ ok: false, status: 403, body: "PRIVATE_ERROR" }) }],
    ["wrong echo", "challenge_failed", { sender: async () => ({ ok: true, status: 200, body: '{"challenge":"PRIVATE_CHALLENGE"}' }) }],
    ["non-JSON echo", "challenge_failed", { sender: async () => ({ ok: true, status: 200, body: "PRIVATE_ERROR" }) }],
  ] as const)("records %s separately from an absent request", async (_label, reason, options) => {
    const f = await fixture(options);
    await expect(f.request("events/subscribe", params())).rejects.toMatchObject({ code: -32015 });
    const rows = f.records().filter(r => r.metadata?.method === "events/subscribe");
    expect(rows.map(r => r.phase)).toEqual(["event_request_received", "event_request_validated", "event_request_failed"]);
    expect(new Set(rows.map(r => r.callId)).size).toBe(1);
    expect(rows[2]).toMatchObject({ ok: false, errorKind: "CallbackEndpointError", metadata: { reason } });
    expect(await f.runtime.subscriptions()).toHaveLength(0);
    expectRedacted(f.text());
  });

  it("records invalid secret validation without making a callback", async () => {
    let calls = 0;
    const f = await fixture({ sender: async () => { calls++; return { ok: true, status: 200, body: "" }; } });
    const p = params(); p.delivery.secret = "PRIVATE_ERROR";
    await expect(f.request("events/subscribe", p)).rejects.toBeDefined();
    expect(calls).toBe(0);
    expect(f.records().find(r => r.phase === "event_request_failed")).toMatchObject({ metadata: { reason: "invalid_webhook_secret" } });
    expectRedacted(f.text());
  });

  it("does not echo an unrecognized event name into the ledger", async () => {
    const f = await fixture();
    await expect(f.request("events/subscribe", { ...params(), name: "PRIVATE_ERROR" })).rejects.toBeDefined();
    expect(f.records().find(r => r.phase === "event_request_failed")).toMatchObject({ metadata: { reason: "unsupported_event", event: "unrecognized" } });
    expectRedacted(f.text());
  });

  it("correlates successful list, subscribe and unsubscribe without raw sensitive data", async () => {
    const f = await fixture();
    await f.request("events/list", {});
    const created = await f.request("events/subscribe", params());
    expect(created.id).toMatch(/^sub_/);
    expect(await f.runtime.subscriptions()).toHaveLength(1);
    await f.request("events/unsubscribe", { name: "workflow.continue", arguments: { topic: privateTopic }, delivery: { mode: "webhook", url: callback } });
    expect(await f.runtime.subscriptions()).toHaveLength(0);
    for (const phase of ["events_list", "event_subscribed", "event_unsubscribed"])
      expect(f.records().filter(r => r.phase === phase)).toHaveLength(1);
    expectRedacted(f.text());
    const phases = f.records().filter(r => r.metadata?.method === "events/subscribe");
    expect(new Set(phases.map(r => r.callId)).size).toBe(1);
    expect(phases[1].metadata.callbackUrlHash).toMatch(/^[a-f0-9]{24}$/);
  });

  it("keeps concurrent subscription attempts distinct", async () => {
    const f = await fixture();
    await Promise.all([1, 2, 3].map(n => f.request("events/subscribe", { ...params(), arguments: { topic: `${privateTopic}:${n}` } })));
    const rows = f.records().filter(r => r.metadata?.method === "events/subscribe");
    const ids = new Set(rows.map(r => r.callId));
    expect(ids.size).toBe(3);
    for (const id of ids) expect(rows.filter(r => r.callId === id).map(r => r.phase)).toEqual(["event_request_received", "event_request_validated", "event_subscribed"]);
    expect(await f.runtime.subscriptions()).toHaveLength(3);
    expectRedacted(f.text());
  });

  it("preserves event behavior with audit output disabled", async () => {
    const f = await fixture({}, false);
    expect((await f.request("events/subscribe", params())).id).toMatch(/^sub_/);
    expect(f.text()).toBe("");
  });

  it("marks the start of audit coverage without claiming old requests were observed", async () => {
    const f = await fixture();
    expect(f.records().filter(r => r.phase === "event_audit_started")).toMatchObject([{ metadata: { version: 1 } }]);
    await expect((await fetch(`${f.endpoint}/healthz`)).json()).resolves.toMatchObject({ eventAuditVersion: 1 });
  });

  it("does not log raw errors from a failing schema adapter", async () => {
    const f = await fixture();
    const audit = new EventRequestAudit(f.ledger);
    const schema = audit.params("events/subscribe", {
      "~standard": { version: 1, vendor: "test", validate: () => { throw new Error("PRIVATE_ERROR"); } },
    });
    await expect(schema["~standard"].validate({})).rejects.toThrow("PRIVATE_ERROR");
    expect(f.records().find(r => r.phase === "event_request_rejected")).toMatchObject({ errorKind: "SchemaValidationError" });
    expectRedacted(f.text());
  });
});
