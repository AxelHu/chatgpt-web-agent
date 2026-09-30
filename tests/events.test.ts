import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import { Webhook } from "standardwebhooks";
import {
  CONTINUE_EVENT_NAME,
  EventRuntime,
  type EventDeliveryResponse,
  type EventWebhookSender,
} from "../src/events.js";

async function tempStore(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "webagent-events-"));
  return path.join(dir, "events.json");
}

describe("MCP continuation events", () => {
  it("persists an idempotent subscription and emits a signed continuation event", async () => {
    const storePath = await tempStore();
    const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    const delivered: Array<{ body: string; headers: Record<string, string> }> = [];
    const sender: EventWebhookSender = async (_subscription, body, headers): Promise<EventDeliveryResponse> => {
      const parsed = JSON.parse(body) as { type?: string; challenge?: string };
      if (parsed.type === "verification") {
        return { ok: true, status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
      }
      delivered.push({ body, headers });
      return { ok: true, status: 202, body: "" };
    };
    const runtime = new EventRuntime({
      storePath,
      sender,
      validateCallback: async () => {},
      now: () => new Date("2026-09-30T00:00:00Z"),
    });
    const request = {
      name: CONTINUE_EVENT_NAME,
      arguments: { topic: "light-alchemy:item-expansion" },
      delivery: {
        mode: "webhook" as const,
        url: "https://events.example.com/callback",
        secret,
      },
      ttlMs: null,
    };

    const first = await runtime.subscribe("owner", request);
    const second = await runtime.subscribe("owner", request);
    expect(second.id).toBe(first.id);
    expect((await runtime.subscriptions())).toHaveLength(1);

    const emitted = await runtime.emitContinue({
      topic: "light-alchemy:item-expansion",
      trigger_reason: "local checkpoint ready",
      summary: "2000-item generation pass completed",
      state_ref: "session:abc123",
      source: "research",
    });
    expect(emitted).toMatchObject({ matched: 1, delivered: 1, failed: [] });
    expect(delivered).toHaveLength(1);

    const body = delivered[0]!;
    const parsed = JSON.parse(body.body) as { eventId: string; name: string; data: { topic: string } };
    expect(parsed.name).toBe(CONTINUE_EVENT_NAME);
    expect(parsed.data.topic).toBe("light-alchemy:item-expansion");
    expect(body.headers["X-MCP-Subscription-Id"]).toBe(first.id);
    const signer = new Webhook(secret);
    const signedAt = new Date(Number.parseInt(body.headers["webhook-timestamp"]!, 10) * 1000);
    expect(body.headers["webhook-signature"]).toBe(
      signer.sign(body.headers["webhook-id"]!, signedAt, body.body),
    );
  });

  it("filters by topic instead of binding continuation to a process", async () => {
    const storePath = await tempStore();
    const secret = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
    let deliveries = 0;
    const sender: EventWebhookSender = async (_subscription, body) => {
      const parsed = JSON.parse(body) as { type?: string; challenge?: string };
      if (parsed.type === "verification") {
        return { ok: true, status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
      }
      deliveries += 1;
      return { ok: true, status: 200, body: "" };
    };
    const runtime = new EventRuntime({ storePath, sender, validateCallback: async () => {} });
    await runtime.subscribe("owner", {
      name: CONTINUE_EVENT_NAME,
      arguments: { topic: "research:collatz" },
      delivery: { mode: "webhook", url: "https://events.example.com/callback", secret },
      ttlMs: null,
    });

    expect((await runtime.emitContinue({
      topic: "research:rh",
      trigger_reason: "checkpoint ready",
    })).matched).toBe(0);
    expect((await runtime.emitContinue({
      topic: "research:collatz",
      trigger_reason: "checkpoint ready",
    })).matched).toBe(1);
    expect(deliveries).toBe(1);
  });
});
