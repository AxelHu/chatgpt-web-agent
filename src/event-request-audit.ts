import { createHash, randomUUID } from "node:crypto";
import type { StandardSchemaV1 } from "@modelcontextprotocol/server";
import { CallbackEndpointError, CONTINUE_EVENT_NAME } from "./events.js";
import type { RequestLedger, RequestLedgerEvent } from "./request-ledger.js";

export const EVENT_AUDIT_VERSION = 1;
export type EventMethod = "events/list" | "events/subscribe" | "events/unsubscribe";
type Attempt = { callId: string; startedAt: number };

function digest(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? createHash("sha256").update(String(value)).digest("hex").slice(0, 24)
    : undefined;
}

function metadata(method: EventMethod, params: object, requestId: unknown) {
  const p = params as Record<string, unknown>;
  const args = p.arguments as Record<string, unknown> | undefined;
  const delivery = p.delivery as Record<string, unknown> | undefined;
  return {
    method,
    requestIdHash: digest(requestId),
    event: method === "events/list" ? undefined
      : p.name === CONTINUE_EVENT_NAME ? CONTINUE_EVENT_NAME : "unrecognized",
    topicHash: digest(args?.topic),
    callbackUrlHash: digest(delivery?.url),
  };
}

function failure(error: unknown): Pick<RequestLedgerEvent, "errorKind" | "metadata"> {
  if (error instanceof CallbackEndpointError) {
    const allowed = new Set(["invalid_url", "timeout", "challenge_failed"]);
    return {
      errorKind: "CallbackEndpointError",
      metadata: { reason: allowed.has(error.reason) ? error.reason : "other" },
    };
  }
  const known = new Set([
    "unsupported_event", "unsupported_delivery", "invalid_webhook_secret",
    "invalid_ttl", "subscription_cancelled_during_verification",
  ]);
  return {
    errorKind: error instanceof Error ? "Error" : "NonErrorThrown",
    metadata: {
      reason: error instanceof Error && known.has(error.message) ? error.message : "unclassified",
    },
  };
}

/** Only records lifecycle metadata. Raw params, validation issues, callbacks,
 * signing secrets, challenge bodies, and arbitrary error text never enter the
 * ledger. This does not create, authorize, or deliver a subscription. */
export class EventRequestAudit {
  readonly #pending = new WeakMap<object, Attempt>();
  constructor(private readonly ledger?: RequestLedger) {}

  params<Input, Output extends object>(
    method: EventMethod,
    schema: StandardSchemaV1<Input, Output>,
  ): StandardSchemaV1<Input, Output> {
    const standard = schema["~standard"];
    return {
      "~standard": {
        ...standard,
        validate: async (value) => {
          const attempt = { callId: `event-${randomUUID()}`, startedAt: performance.now() };
          this.ledger?.record({ phase: "event_request_received", callId: attempt.callId, metadata: { method } });
          try {
            const result = await standard.validate(value);
            if (result.issues) {
              this.ledger?.record({
                phase: "event_request_rejected", callId: attempt.callId, ok: false,
                errorKind: "InvalidParams", metadata: { method, issueCount: result.issues.length },
              });
            } else {
              this.#pending.set(result.value, attempt);
            }
            return result;
          } catch (error) {
            this.ledger?.record({
              phase: "event_request_rejected", callId: attempt.callId, ok: false,
              errorKind: "SchemaValidationError", metadata: { method },
            });
            throw error;
          }
        },
      },
    };
  }

  async run<Params extends object, Result>(
    method: EventMethod,
    params: Params,
    requestId: unknown,
    operation: () => Result | Promise<Result>,
  ): Promise<Result> {
    const attempt = this.#pending.get(params) ?? { callId: `event-${randomUUID()}`, startedAt: performance.now() };
    const safe = metadata(method, params, requestId);
    this.ledger?.record({ phase: "event_request_validated", callId: attempt.callId, ok: true, metadata: safe });
    try {
      const result = await operation();
      const phase = { "events/list": "events_list", "events/subscribe": "event_subscribed", "events/unsubscribe": "event_unsubscribed" }[method];
      this.ledger?.record({
        phase, callId: attempt.callId, ok: true,
        durationMs: Math.round(performance.now() - attempt.startedAt), metadata: safe,
      });
      return result;
    } catch (error) {
      const failed = failure(error);
      this.ledger?.record({
        phase: "event_request_failed", callId: attempt.callId, ok: false,
        durationMs: Math.round(performance.now() - attempt.startedAt),
        errorKind: failed.errorKind, metadata: { ...safe, ...failed.metadata },
      });
      throw error;
    } finally {
      this.#pending.delete(params);
    }
  }
}
