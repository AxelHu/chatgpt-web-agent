import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../userscripts/chatgpt-route-indicator.user.js", import.meta.url), "utf8");
const hook = {};
const context = vm.createContext({
  globalThis: { __CHATGPT_ROUTE_INDICATOR_TEST__: hook },
  Map,
  Set,
});
vm.runInContext(source, context, { filename: "chatgpt-route-indicator.user.js" });
const {
  routeFromMetadata,
  routeKey,
  mergeRoute,
  collectRoutes,
  chooseLatest,
  routeForIdentity,
  exceptionalStatus,
  sameModel,
  modelLabel,
  executionConcern,
} = hook.exports;

assert.equal(sameModel("gpt-6-astra", "gpt-6-pro"), true);
assert.equal(sameModel("gpt-6-sol", "gpt-6-pro"), false);
assert.equal(sameModel("gpt-6-luna", "gpt-6-pro"), false);
assert.equal(modelLabel("gpt-6-sol"), "GPT-6 Sol");
assert.equal(modelLabel("gpt-6-luna"), "GPT-6 Luna");

const solReroute = routeFromMetadata({
  default_model_slug: "gpt-6-pro",
  requested_model_slug: "gpt-6-pro",
  model_slug: "gpt-6-sol",
  resolved_model_slug: "gpt-6-sol",
  turn_exchange_id: "sol-reroute",
});
assert.equal(solReroute.actual, "gpt-6-sol");
assert.equal(solReroute.mismatch, true);
assert.equal(solReroute.resolutionChanged, false);

const lunaReroute = routeFromMetadata({
  default_model_slug: "gpt-6-pro",
  requested_model_slug: "gpt-6-pro",
  model_slug: "gpt-6-luna",
  resolved_model_slug: "gpt-6-luna",
  turn_exchange_id: "luna-reroute",
});
assert.equal(lunaReroute.actual, "gpt-6-luna");
assert.equal(lunaReroute.mismatch, true);
assert.equal(lunaReroute.resolutionChanged, false);

const degraded = routeFromMetadata({
  default_model_slug: "gpt-6-pro",
  requested_model_slug: "gpt-5-4-auto-thinking",
  model_slug: "gpt-5-4-thinking",
  resolved_model_slug: "gpt-5-4-auto-thinking",
  turn_exchange_id: "degraded-turn",
});
assert.equal(degraded.mismatch, true);
assert.equal(degraded.override, true);
assert.equal(degraded.actual, "gpt-5-4-thinking");
assert.equal(degraded.resolved, "gpt-5-4-auto-thinking");
assert.equal(degraded.resolutionChanged, true);

const healthy = routeFromMetadata({
  default_model_slug: "gpt-6-astra",
  model_slug: "gpt-6-pro",
  resolved_model_slug: "gpt-6-pro",
  turn_exchange_id: "healthy-turn",
});
assert.equal(healthy.mismatch, false);
assert.equal(healthy.actual, "gpt-6-pro");

// A GPT-6 Pro turn can retain the expected model tag while losing the rest of
// the execution lifecycle. This mirrors the observed degraded continuation:
// standard thinking was requested, but there was no resolved route, reasoning
// sibling, or tool execution signal.
const degradedContinuation = routeForIdentity({
  messageId: "degraded-continuation-final",
  turnId: "degraded-continuation",
  modelSlug: "gpt-6-pro",
  status: "finished_successfully",
}, new Map([[
  "degraded-continuation-final",
  routeFromMetadata({
    model_slug: "gpt-6-pro",
    thinking_effort: "standard",
    turn_exchange_id: "degraded-continuation",
  }, {
    messageId: "degraded-continuation-final",
    authorRole: "assistant",
    contentType: "text",
  }),
]]));
assert.equal(degradedContinuation.turnReasoningObserved, false);
assert.equal(degradedContinuation.turnToolObserved, false);
assert.equal(degradedContinuation.turnResolvedObserved, false);
assert.equal(executionConcern(degradedContinuation), "execution-evidence-missing");

// A normal long-running GPT-6 Pro turn has sibling execution evidence even
// though its final visible text node can itself have no reasoning status.
const healthyLongTurnRoutes = collectRoutes({ mapping: {
  reasoning: { message: {
    id: "healthy-reasoning",
    create_time: 40,
    author: { role: "assistant" },
    content: { content_type: "thoughts", parts: [] },
    recipient: "all",
    metadata: {
      model_slug: "gpt-6-pro",
      resolved_model_slug: "gpt-6-pro",
      thinking_effort: "standard",
      reasoning_status: "is_reasoning",
      turn_exchange_id: "healthy-long-turn",
    },
  } },
  final: { message: {
    id: "healthy-final",
    create_time: 41,
    author: { role: "assistant" },
    content: { content_type: "text", parts: ["done"] },
    recipient: "all",
    metadata: {
      model_slug: "gpt-6-pro",
      turn_exchange_id: "healthy-long-turn",
    },
  } },
} });
const healthyLongTurnMap = new Map(healthyLongTurnRoutes.map((route) => [routeKey(route), route]));
const healthyFinal = routeForIdentity({
  messageId: "healthy-final",
  turnId: "healthy-long-turn",
  modelSlug: "gpt-6-pro",
  status: "finished_successfully",
}, healthyLongTurnMap);
assert.equal(healthyFinal.turnReasoningObserved, true);
assert.equal(healthyFinal.turnResolvedObserved, true);
assert.equal(executionConcern(healthyFinal), null);

const payload = {
  mapping: {
    first: { message: { id: "m1", create_time: 1, author: { role: "assistant" }, metadata: {
      default_model_slug: "gpt-6-pro", model_slug: "gpt-6-pro", resolved_model_slug: "gpt-6-pro", turn_exchange_id: "one",
    } } },
    second: { message: { id: "m2", create_time: 2, author: { role: "assistant" }, metadata: {
      default_model_slug: "gpt-6-pro", requested_model_slug: "gpt-5-4-auto-thinking",
      model_slug: "gpt-5-4-thinking", resolved_model_slug: "gpt-5-4-auto-thinking", turn_exchange_id: "two",
    } } },
  },
};
const routes = collectRoutes(payload);
assert.equal(routes.length, 2);
assert.equal(chooseLatest(routes).turnExchangeId, "two");
assert.equal(chooseLatest(routes).mismatch, true);
assert.equal(routeKey(routes[0]), "m1");
assert.equal(routeKey(routes[1]), "m2");

// Distinct assistant nodes in one turn must retain their concrete model. A
// reasoning/summary node can carry the routed alias while the final visible
// answer carries the actually executing model slug.
const sameTurnNodes = collectRoutes({ mapping: {
  reasoning: { message: { id: "reasoning-node", create_time: 20, author: { role: "assistant" }, metadata: {
    model_slug: "gpt-5-4-auto-thinking", resolved_model_slug: "gpt-5-4-auto-thinking", turn_exchange_id: "shared-turn",
  } } },
  final: { message: { id: "final-node", create_time: 21, author: { role: "assistant" }, metadata: {
    default_model_slug: "gpt-6-pro", requested_model_slug: "gpt-5-4-auto-thinking",
    model_slug: "gpt-5-4-thinking", resolved_model_slug: "gpt-5-4-auto-thinking", turn_exchange_id: "shared-turn",
  } } },
} });
assert.equal(sameTurnNodes.length, 2);
assert.equal(new Map(sameTurnNodes.map((route) => [routeKey(route), route])).get("final-node").actual, "gpt-5-4-thinking");

const partialSameTurn = chooseLatest([
  routeFromMetadata({
    default_model_slug: "gpt-6-pro",
    requested_model_slug: "gpt-5-4-auto-thinking",
    model_slug: "gpt-5-4-thinking",
    resolved_model_slug: "gpt-5-4-auto-thinking",
    turn_exchange_id: "partial-turn",
  }, { createTime: 10 }),
  routeFromMetadata({
    model_slug: "gpt-5-4-auto-thinking",
    resolved_model_slug: "gpt-5-4-auto-thinking",
    turn_exchange_id: "partial-turn",
  }, { createTime: 11 }),
]);
assert.equal(partialSameTurn.expected, "gpt-6-pro");
assert.equal(partialSameTurn.requested, "gpt-5-4-auto-thinking");
assert.equal(partialSameTurn.mismatch, true);

const resolvedOnly = routeFromMetadata({
  default_model_slug: "gpt-6-pro",
  resolved_model_slug: "gpt-5-4-auto-thinking",
});
assert.equal(resolvedOnly.actual, null);
assert.equal(resolvedOnly.mismatch, false);
const enrichedFromDom = mergeRoute(
  routeFromMetadata({ model_slug: "gpt-5-4-thinking" }, { messageId: "dom-node", source: "dom-message-model" }),
  routeFromMetadata({
    default_model_slug: "gpt-6-pro",
    requested_model_slug: "gpt-5-4-auto-thinking",
    resolved_model_slug: "gpt-5-4-auto-thinking",
  }, { messageId: "dom-node" }),
);
assert.equal(enrichedFromDom.actual, "gpt-5-4-thinking");
assert.equal(enrichedFromDom.resolved, "gpt-5-4-auto-thinking");
assert.equal(enrichedFromDom.mismatch, true);

assert.equal(exceptionalStatus({ reasoning_status: "reasoning_cancelled" }), "cancelled");
assert.equal(exceptionalStatus({ finish_details: { type: "interrupted" } }), "interrupted");
assert.equal(exceptionalStatus({}, { status: "finished_error" }), "failed");

const interruptedPayload = {
  mapping: {
    routed: { message: { id: "route-node", create_time: 30, author: { role: "assistant" }, metadata: {
      model_slug: "gpt-5-4-thinking", resolved_model_slug: "gpt-5-4-auto-thinking", turn_exchange_id: "interrupted-turn",
    } } },
    cancelled: { message: { id: "cancelled-node", create_time: 31, author: { role: "assistant" }, metadata: {
      reasoning_status: "reasoning_cancelled", turn_exchange_id: "interrupted-turn",
    } } },
  },
};
const interruptedRoutes = collectRoutes(interruptedPayload);
assert.equal(interruptedRoutes.length, 2);
const interruptedMap = new Map(interruptedRoutes.map((route) => [routeKey(route), route]));
const interrupted = routeForIdentity({
  messageId: "cancelled-node", turnId: null, modelSlug: null, status: null,
}, interruptedMap);
assert.equal(interrupted.actual, "gpt-5-4-thinking");
assert.equal(interrupted.status, "cancelled");
assert.equal(interrupted.source, "turn sibling metadata");

const noModelEvidence = routeForIdentity({
  messageId: "failed-before-route", turnId: "failed-turn", modelSlug: null, status: "interrupted",
}, new Map());
assert.equal(noModelEvidence.actual, null);
assert.equal(noModelEvidence.status, "interrupted");
assert.equal(noModelEvidence.source, "no model metadata");
const metadataFreeFailure = collectRoutes({
  id: "metadata-free-failure",
  author: { role: "assistant" },
  status: "finished_error",
});
assert.equal(metadataFreeFailure.length, 1);
assert.equal(metadataFreeFailure[0].status, "failed");

console.log(JSON.stringify({
  ok: true,
  routes: routes.length,
  actual: degraded.actual,
  resolved: degraded.resolved,
  healthy: healthy.actual,
  interrupted: interrupted.status,
  unavailable: noModelEvidence.actual,
}));
