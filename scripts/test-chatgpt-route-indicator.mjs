import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../userscripts/chatgpt-route-indicator.user.js", import.meta.url), "utf8");
const hook = {};
const context = vm.createContext({
  globalThis: { __CHATGPT_ROUTE_INDICATOR_TEST__: hook },
  Set,
});
vm.runInContext(source, context, { filename: "chatgpt-route-indicator.user.js" });
const { routeFromMetadata, collectRoutes, chooseLatest, sameModel } = hook.exports;

assert.equal(sameModel("gpt-6-astra", "gpt-6-pro"), true);

const degraded = routeFromMetadata({
  default_model_slug: "gpt-6-pro",
  requested_model_slug: "gpt-5-4-auto-thinking",
  model_slug: "gpt-5-4-thinking",
  resolved_model_slug: "gpt-5-4-auto-thinking",
  turn_exchange_id: "degraded-turn",
});
assert.equal(degraded.mismatch, true);
assert.equal(degraded.override, true);
assert.equal(degraded.resolved, "gpt-5-4-auto-thinking");

const healthy = routeFromMetadata({
  default_model_slug: "gpt-6-astra",
  model_slug: "gpt-6-pro",
  resolved_model_slug: "gpt-6-pro",
  turn_exchange_id: "healthy-turn",
});
assert.equal(healthy.mismatch, false);

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

console.log(JSON.stringify({ ok: true, routes: routes.length, degraded: degraded.resolved, healthy: healthy.resolved }));
