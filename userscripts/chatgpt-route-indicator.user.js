// ==UserScript==
// @name         ChatGPT Actual Model Route
// @namespace    https://chatgpt.com/
// @version      0.7.4
// @description  Show the concrete model recorded on each ChatGPT assistant message without collecting conversation text.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "0.7.4";
  const testHook = globalThis.__CHATGPT_ROUTE_INDICATOR_TEST__;
  const GPT6_ALIASES = new Set(["gpt-6-pro", "gpt-6-astra", "gpt-6-astra-pro"]);
  const ROUTE_KEYS = ["default_model_slug", "requested_model_slug", "resolved_model_slug", "model_slug"];

  function canonicalModel(value) {
    if (typeof value !== "string" || !value) return null;
    return GPT6_ALIASES.has(value) ? "gpt-6-pro" : value;
  }

  function sameModel(left, right) {
    const a = canonicalModel(left);
    const b = canonicalModel(right);
    return a !== null && b !== null && a === b;
  }

  function modelLabel(slug) {
    const labels = {
      "gpt-6-pro": "GPT-6 Pro / Astra",
      "gpt-6-astra": "GPT-6 Pro / Astra",
      "gpt-6-astra-pro": "GPT-6 Pro / Astra",
      "gpt-6-sol": "GPT-6 Sol",
      "gpt-6-luna": "GPT-6 Luna",
      "gpt-5-4-auto-thinking": "GPT-5.4 Auto",
      "gpt-5-4-thinking": "GPT-5.4 Thinking",
      "gpt-5-6-thinking": "GPT-5.6 Thinking",
      "gpt-5.6-sol": "GPT-5.6 Sol",
      "gpt-5-6": "GPT-5.6",
    };
    return labels[slug] || slug || "unknown";
  }

  function exceptionalStatus(metadata, fallback = {}) {
    const finishDetails = metadata && typeof metadata.finish_details === "object"
      ? metadata.finish_details
      : null;
    const candidates = [
      metadata?.reasoning_status,
      metadata?.status,
      finishDetails?.type,
      finishDetails?.reason,
      fallback.status,
    ].filter((value) => typeof value === "string" && value);
    for (const value of candidates) {
      const normalized = value.toLowerCase();
      if (normalized.includes("cancel")) return "cancelled";
      if (normalized.includes("interrupt") || normalized.includes("abort")) return "interrupted";
      if (normalized.includes("error") || normalized.includes("fail")) return "failed";
      if (normalized.includes("unavailable")) return "unavailable";
    }
    return null;
  }

  function finiteTimestamp(value) {
    return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  }

  function routeFromMetadata(metadata, fallback = {}) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    // model_slug belongs to the generated assistant node. In routed modes it can
    // intentionally differ from requested_model_slug/resolved_model_slug; that
    // concrete node value is the best persisted evidence of the executing model.
    const actual = typeof metadata.model_slug === "string" ? metadata.model_slug : null;
    const resolved = typeof metadata.resolved_model_slug === "string" ? metadata.resolved_model_slug : null;
    const expected = typeof metadata.default_model_slug === "string" ? metadata.default_model_slug : null;
    const requested = typeof metadata.requested_model_slug === "string" ? metadata.requested_model_slug : null;
    const thinkingEffort = typeof metadata.thinking_effort === "string"
      ? metadata.thinking_effort
      : typeof fallback.thinkingEffort === "string" ? fallback.thinkingEffort : null;
    const reasoningStatus = typeof metadata.reasoning_status === "string"
      ? metadata.reasoning_status
      : typeof fallback.reasoningStatus === "string" ? fallback.reasoningStatus : null;
    const contentType = typeof fallback.contentType === "string" ? fallback.contentType : null;
    const recipient = typeof fallback.recipient === "string" ? fallback.recipient : null;
    const authorRole = typeof fallback.authorRole === "string" ? fallback.authorRole : null;
    const reasoningObserved = Boolean(
      reasoningStatus
      || contentType === "thoughts"
      || contentType === "reasoning_recap"
      || finiteTimestamp(metadata.reasoning_start_time)
      || finiteTimestamp(metadata.reasoning_end_time)
    );
    const toolObserved = Boolean(
      authorRole === "tool"
      || (authorRole === "assistant"
        && recipient
        && recipient !== "all"
        && recipient !== "web")
    );
    const status = exceptionalStatus(metadata, fallback);
    if (!actual && !resolved && !requested && !expected && !status
      && !thinkingEffort && !reasoningObserved && !toolObserved
      && !(authorRole && fallback.messageId)) return null;
    return {
      messageId: fallback.messageId || null,
      turnExchangeId: typeof metadata.turn_exchange_id === "string"
        ? metadata.turn_exchange_id
        : fallback.turnExchangeId || null,
      requestId: typeof metadata.request_id === "string" ? metadata.request_id : null,
      createTime: Number.isFinite(Number(fallback.createTime)) ? Number(fallback.createTime) : null,
      expected,
      requested,
      actual,
      resolved,
      authorRole,
      thinkingEffort,
      reasoningStatus,
      reasoningObserved,
      toolObserved,
      status,
      source: fallback.source || "metadata",
      mismatch: Boolean(expected && actual && !sameModel(expected, actual)),
      resolutionChanged: Boolean(resolved && actual && !sameModel(resolved, actual)),
      override: Boolean(expected && requested && !sameModel(expected, requested)),
    };
  }

  function routeKey(route) {
    // One turn can contain reasoning, summary and final response nodes carrying
    // different model_slug values. Keep message identity before turn identity so
    // the final visible response cannot be overwritten by another phase.
    return route.messageId || route.turnExchangeId || route.requestId || [
      route.createTime || "",
      route.expected || "",
      route.requested || "",
      route.actual || "",
      route.resolved || "",
    ].join("|");
  }

  function mergeRoute(previous, next) {
    if (!previous) return next;
    const merged = {
      ...previous,
      ...next,
      messageId: next.messageId || previous.messageId || null,
      turnExchangeId: next.turnExchangeId || previous.turnExchangeId || null,
      requestId: next.requestId || previous.requestId || null,
      createTime: Math.max(previous.createTime || 0, next.createTime || 0) || null,
      expected: next.expected || previous.expected || null,
      requested: next.requested || previous.requested || null,
      actual: next.actual || previous.actual || null,
      resolved: next.resolved || previous.resolved || null,
      authorRole: next.authorRole || previous.authorRole || null,
      thinkingEffort: next.thinkingEffort || previous.thinkingEffort || null,
      reasoningStatus: next.reasoningStatus || previous.reasoningStatus || null,
      reasoningObserved: Boolean(previous.reasoningObserved || next.reasoningObserved),
      toolObserved: Boolean(previous.toolObserved || next.toolObserved),
      status: next.status || previous.status || null,
      source: next.source || previous.source || "metadata",
    };
    merged.mismatch = Boolean(merged.expected && merged.actual && !sameModel(merged.expected, merged.actual));
    merged.resolutionChanged = Boolean(merged.resolved && merged.actual && !sameModel(merged.resolved, merged.actual));
    merged.override = Boolean(merged.expected && merged.requested && !sameModel(merged.expected, merged.requested));
    return merged;
  }

  function collectRoutes(value) {
    const routes = [];
    const seen = new Set();
    const visit = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 32 || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }

      const authorRole = node.author && typeof node.author === "object" ? node.author.role : null;
      const metadata = node.metadata && typeof node.metadata === "object" ? node.metadata : null;
      const contentType = node.content && typeof node.content === "object" && typeof node.content.content_type === "string"
        ? node.content.content_type
        : null;
      if (["assistant", "tool", "user", "system", "developer"].includes(authorRole)
        || (metadata && ROUTE_KEYS.some((key) => typeof metadata[key] === "string"))) {
        const route = routeFromMetadata(metadata || {}, {
          messageId: typeof node.id === "string" ? node.id : null,
          createTime: node.create_time,
          status: typeof node.status === "string" ? node.status : null,
          authorRole,
          recipient: typeof node.recipient === "string" ? node.recipient : null,
          contentType,
        });
        if (route) routes.push(route);
      }

      if (node.message && typeof node.message === "object") visit(node.message, depth + 1);
      for (const [key, child] of Object.entries(node)) {
        if (key === "message" || key === "metadata" || key === "content" || key === "parts") continue;
        if (child && typeof child === "object") visit(child, depth + 1);
      }
    };
    visit(value, 0);
    return routes;
  }

  function chooseLatest(routes) {
    if (!routes.length) return null;
    const byTurn = new Map();
    for (const route of routes) {
      const key = routeKey(route);
      const previous = byTurn.get(key);
      if (!previous) {
        byTurn.set(key, route);
        continue;
      }
      // Prefer richer persisted metadata for repeated observations of one node.
      const score = (item) => Number(Boolean(item.expected)) * 4
        + Number(Boolean(item.requested)) * 2
        + Number(Boolean(item.resolved)) * 2
        + Number(Boolean(item.actual)) * 8
        + Number(Boolean(item.messageId));
      byTurn.set(key, score(route) >= score(previous) ? mergeRoute(previous, route) : mergeRoute(route, previous));
    }
    return [...byTurn.values()].sort((a, b) => {
      const ta = a.createTime || 0;
      const tb = b.createTime || 0;
      return ta - tb;
    }).at(-1) || null;
  }

  function parseMessageIds(value) {
    if (typeof value !== "string") return { ids: [], valid: false };
    const text = value.trim();
    if (!text) return { ids: [], valid: true };
    let items;
    try {
      if (/^[\["{]/.test(text)) {
        const decoded = JSON.parse(text);
        items = Array.isArray(decoded) ? decoded : typeof decoded === "string" ? decoded.trim().split(/[\s,]+/).filter(Boolean) : null;
      } else items = text.split(/[\s,]+/).filter(Boolean);
    } catch (_) { return { ids: [], valid: false }; }
    // No substring matching, numeric coercion, or execution of attribute text.
    if (!items || !items.every((id) => typeof id === "string"
      && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)
      && !["true", "false", "null", "undefined"].includes(id))) return { ids: [], valid: false };
    return { ids: [...new Set(items)].sort(), valid: true };
  }

  function routeForMessageSet(identity, routes) {
    const values = routes instanceof Map ? [...routes.values()] : [...routes];
    const byMessage = routes instanceof Map ? routes : new Map(values.map((route) => [route.messageId, route]));
    const members = [], unmapped = [];
    let excludedCount = 0;
    for (const id of [...new Set(identity.messageIds)].sort()) {
      const route = byMessage.get(id);
      if (!route || route.messageId !== id || !route.authorRole) { unmapped.push(id); continue; }
      if (route.authorRole !== "assistant") { excludedCount += 1; continue; }
      // Exact listed assistant node only: a sibling/final node is not inferred
      // from search-ID order, timestamp, turn-key syntax, or another turn.
      const peers = route.turnExchangeId
        ? values.filter((item) => item.turnExchangeId === route.turnExchangeId) : [route];
      members.push({ ...route,
        turnThinkingEffort: route.thinkingEffort || peers.find((item) => item.thinkingEffort)?.thinkingEffort || null,
        turnReasoningObserved: peers.some((item) => item.reasoningObserved),
        turnToolObserved: peers.some((item) => item.toolObserved),
        turnResolvedObserved: peers.some((item) => Boolean(item.resolved)),
      });
    }
    const common = (key) => members.length && members.every((item) => item[key] === members[0][key])
      ? members[0][key] || null : null;
    const actualModels = [...new Set(members.filter((item) => item.actual).map((item) => canonicalModel(item.actual)))].sort();
    const knownCount = members.filter((item) => item.actual).length;
    const complete = members.length > 0 && knownCount === members.length
      && !unmapped.length && !identity.invalidIdLists;
    return {
      messageId: members.length === 1 ? members[0].messageId : null,
      turnExchangeId: common("turnExchangeId"),
      actual: complete && actualModels.length === 1 ? actualModels[0] : null,
      actualModels, memberRoutes: members, knownCount, unmappedMessageIds: unmapped,
      excludedCount, invalidIdLists: identity.invalidIdLists || 0,
      expected: common("expected"), requested: common("requested"), resolved: common("resolved"),
      status: members.length ? (members.every((item) => item.status === members[0].status)
        ? members[0].status : "mixed") : "unavailable",
      thinkingEffort: common("thinkingEffort"), turnThinkingEffort: common("turnThinkingEffort"),
      turnReasoningObserved: members.some((item) => item.turnReasoningObserved),
      turnToolObserved: members.some((item) => item.turnToolObserved),
      turnResolvedObserved: members.some((item) => item.turnResolvedObserved),
      mismatch: members.some((item) => item.mismatch),
      resolutionChanged: members.some((item) => item.resolutionChanged),
      override: members.some((item) => item.override),
      source: "exact assistant IDs from " + (identity.bindingSource || "DOM message set"),
    };
  }

  function messageSetLabel(route) {
    if (!route.memberRoutes || (route.memberRoutes.length === 1
      && !route.unmappedMessageIds.length && !route.invalidIdLists)) return null;
    const models = route.actualModels.map(modelLabel).join(" / ");
    const count = route.memberRoutes.length;
    const incomplete = route.knownCount < count || route.unmappedMessageIds.length || route.invalidIdLists;
    if (incomplete) return [
      "actual model: unknown", models ? `recorded: ${models}` : "",
      count ? `${route.knownCount}/${count} assistant models known` : "waiting for assistant metadata",
      route.unmappedMessageIds.length ? `${route.unmappedMessageIds.length} unmatched ID(s)` : "",
      route.invalidIdLists ? "invalid message-ID list" : "",
    ].filter(Boolean).join(" · ");
    if (!count) return "actual model: unknown · no matched assistant IDs";
    return `${route.actualModels.length > 1 ? "actual models" : "actual model"}: ${models} · ${count} assistant messages`;
  }

  function routeForIdentity(identity, routes) {
    if (!identity.messageId && Array.isArray(identity.messageIds)) return routeForMessageSet(identity, routes);
    const values = routes instanceof Map ? [...routes.values()] : [...routes];
    const get = (key) => key && routes instanceof Map ? routes.get(key) : null;
    const domRoute = identity.modelSlug ? routeFromMetadata({ model_slug: identity.modelSlug }, {
      messageId: identity.messageId,
      turnExchangeId: identity.turnId,
      source: "dom-message-model",
      status: identity.status,
    }) : null;
    const assistantRoute = (route) => route && (!route.authorRole || route.authorRole === "assistant");
    let exact = get(identity.messageId) || get(identity.turnId) || null;
    if (!assistantRoute(exact)) exact = null;
    let result = exact;
    if (exact && domRoute) {
      result = mergeRoute(domRoute, exact);
      result.source = exact.actual ? exact.source : "metadata + DOM message model";
    } else if (!result) {
      result = domRoute;
    }

    // A redesigned turn wrapper may expose only the exchange ID. Use it only
    // when concrete assistant evidence in that exchange is unambiguous. Never
    // guess by DOM order, conversation-turn-N, or the globally latest message.
    if (!result && identity.turnId) {
      const peers = values.filter((route) => assistantRoute(route)
        && route.actual && route.turnExchangeId === identity.turnId);
      const models = new Set(peers.map((route) => canonicalModel(route.actual)));
      if (models.size === 1) {
        const sibling = chooseLatest(peers);
        result = { ...sibling, messageId: identity.messageId || null,
          status: exceptionalStatus({}, { status: identity.status }) || sibling.status,
          source: "turn sibling metadata" };
      }
    }

    if (result && !result.actual && result.turnExchangeId) {
      const sibling = values
        .filter((route) => route !== exact
          && assistantRoute(route)
          && route.actual
          && route.turnExchangeId === result.turnExchangeId)
        .sort((left, right) => (left.createTime || 0) - (right.createTime || 0))
        .at(-1);
      if (sibling) {
        result = mergeRoute(sibling, result);
        result.source = "turn sibling metadata";
      }
    }

    if (!result) {
      return {
        messageId: identity.messageId || null,
        turnExchangeId: identity.turnId || null,
        requestId: null,
        createTime: null,
        expected: null,
        requested: null,
        actual: null,
        resolved: null,
        status: exceptionalStatus({}, { status: identity.status }) || "unavailable",
        source: "no model metadata",
        mismatch: false,
        resolutionChanged: false,
        override: false,
      };
    }
    result = {
      ...result,
      messageId: identity.messageId || result.messageId || null,
      turnExchangeId: result.turnExchangeId || identity.turnId || null,
    };
    const turnPeers = result.turnExchangeId
      ? values.filter((route) => route.turnExchangeId === result.turnExchangeId)
      : [result];
    result.turnThinkingEffort = result.thinkingEffort
      || turnPeers.find((route) => route.thinkingEffort)?.thinkingEffort
      || null;
    result.turnReasoningObserved = turnPeers.some((route) => route.reasoningObserved);
    result.turnToolObserved = turnPeers.some((route) => route.toolObserved);
    result.turnResolvedObserved = turnPeers.some((route) => Boolean(route.resolved));
    if (!result.actual && !result.status) result.status = "unavailable";
    return result;
  }

  function executionConcern(route) {
    if (!route || !sameModel(route.actual, "gpt-6-pro")) return null;
    const effort = route.turnThinkingEffort || route.thinkingEffort;
    if (!["standard", "medium", "high", "xhigh", "max"].includes(effort)) return null;
    if (route.status && route.status !== "unavailable") return null;
    if (route.turnReasoningObserved || route.turnToolObserved || route.turnResolvedObserved) return null;
    return "execution-evidence-missing";
  }

  if (testHook && typeof testHook === "object") {
    testHook.exports = {
      canonicalModel,
      sameModel,
      modelLabel,
      finiteTimestamp,
      exceptionalStatus,
      routeFromMetadata,
      routeKey,
      mergeRoute,
      collectRoutes,
      chooseLatest,
      routeForIdentity,
      parseMessageIds,
      routeForMessageSet,
      messageSetLabel,
      executionConcern,
    };
    return;
  }

  const state = {
    routes: new Map(),
    recentConversations: new Map(),
    latest: null,
    path: location.pathname,
    provisionalConversationId: null,
    epoch: 0,
    observer: null,
    fallbackDue: 0,
    lastFallbackAt: 0,
    fallbackTimer: null,
    renderTimer: null,
    fallbackInFlight: null,
    fallbackDisabled: false,
    fallbackAttempts: 0,
    acquisition: { primaryReads: 0, primaryErrors: 0, cloneReads: 0,
      cloneAborts: 0, lastSource: "waiting for page metadata", lastUpdateAt: null,
      fallback: "not attempted" },
  };
  const responseScopes = new WeakMap();
  const observerOwnedResponses = new WeakSet();

  function rememberRoutes(routes) {
    let changed = false;
    for (const route of routes) {
      const key = routeKey(route);
      const previous = state.routes.get(key);
      const next = mergeRoute(previous, route);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) changed = true;
      state.routes.set(key, next);
    }
    if (!changed) return;
    state.latest = chooseLatest([...state.routes.values()]);
    scheduleRender();
  }

  function saveConversationMetadata(id) {
    if (!id || !state.routes.size) return;
    // The app caches inactive conversation pages. Keep only metadata for the
    // three most recently departed conversations, never response text or auth.
    // The active conversation remains uncapped; saved snapshots are bounded.
    const records = [...state.routes.entries()].slice(-4000);
    state.recentConversations.delete(id);
    state.recentConversations.set(id, records);
    while (state.recentConversations.size > 3) {
      state.recentConversations.delete(state.recentConversations.keys().next().value);
    }
  }

  function syncNavigation() {
    if (state.path === location.pathname) return false;
    // Creating a chat changes / -> /c/ID while the same response is streaming.
    // Preserve only metadata explicitly bound by that creation response's ID.
    const destination = conversationId();
    const cached = destination && state.recentConversations.get(destination);
    state.recentConversations.delete(destination);
    saveConversationMetadata(conversationId(state.path));
    const creatingThisChat = !conversationId(state.path) && state.provisionalConversationId
      && state.provisionalConversationId === conversationId();
    state.path = location.pathname;
    state.epoch += 1;
    if (!creatingThisChat) {
      state.routes = new Map(cached || []);
      state.latest = chooseLatest([...state.routes.values()]);
    }
    state.provisionalConversationId = null;
    state.fallbackInFlight?.abort();
    state.fallbackInFlight = null;
    state.fallbackDisabled = false;
    state.fallbackAttempts = 0;
    state.acquisition.lastSource = cached ? "conversation metadata cache" : "waiting for page metadata";
    state.acquisition.lastUpdateAt = null;
    state.acquisition.fallback = "not attempted";
    state.lastFallbackAt = 0;
    clearTimeout(state.fallbackTimer);
    state.fallbackTimer = null;
    scheduleRender();
    scheduleFallback(250);
    return true;
  }

  function currentEpoch(source) {
    syncNavigation();
    if (typeof source === "number") return source === state.epoch;
    if (source.epoch === state.epoch) return true;
    // A navigation loader can request its exact destination before committing
    // the URL. Accept that one transition, but never an old response from a
    // previous visit to the same conversation or a different destination.
    if (source.requestId && source.requestId === conversationId()
      && source.originConversationId !== source.requestId && source.epoch + 1 === state.epoch) {
      source.epoch = state.epoch;
      return true;
    }
    if (source.creating && source.createdId && source.createdId === conversationId()
      && source.epoch + 1 === state.epoch) {
      source.epoch = state.epoch;
      source.creating = false;
      return true;
    }
    return false;
  }

  function awaitingCreationId(source) {
    return typeof source === "object" && source.creating && !source.createdId
      && source.epoch + 1 === state.epoch && Boolean(conversationId());
  }

  function inspectObject(value, epoch = state.epoch, via = "cloned response") {
    try {
      if (typeof epoch === "object" && epoch.creating && !epoch.createdId
        && typeof value?.conversation_id === "string") epoch.createdId = value.conversation_id;
      if (!currentEpoch(epoch)) return;
      const id = conversationId();
      if (!id && typeof epoch === "object" && epoch.creating && epoch.createdId) {
        state.provisionalConversationId = epoch.createdId;
      }
      if (id && typeof value?.conversation_id === "string" && value.conversation_id !== id) return;
      const routes = collectRoutes(value);
      if (routes.length) {
        state.acquisition.lastSource = via;
        state.acquisition.lastUpdateAt = Date.now();
        rememberRoutes(routes);
        scheduleRender();
      }
    } catch (_) {
      // This observer must never affect ChatGPT itself.
    }
  }

  function parseEventBlock(block, epoch) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try { inspectObject(JSON.parse(data), epoch); } catch (_) {}
  }

  async function inspectEventStream(response, epoch) {
    if (!response.body || typeof TextDecoderStream === "undefined") {
      try {
        const text = await response.text();
        for (const block of text.split(/\r?\n\r?\n/)) parseEventBlock(block, epoch);
      } catch (_) {}
      return;
    }
    try {
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!currentEpoch(epoch) && !awaitingCreationId(epoch)) { await reader.cancel(); break; }
        buffer += value;
        for (;;) {
          const match = /\r?\n\r?\n/.exec(buffer);
          if (!match) break;
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          parseEventBlock(block, epoch);
        }
      }
      if (buffer.trim()) parseEventBlock(buffer, epoch);
    } catch (_) {}
  }

  function shouldInspect(url, response) {
    if (!url) return false;
    const contentType = response.headers.get("content-type") || "";
    return url.origin === location.origin && (
      url.pathname.includes("/conversation")
      || contentType.includes("text/event-stream")
    );
  }

  function conversationResponseId(url) {
    return url?.pathname.match(/^\/backend-api\/(?:f\/)?conversations?\/([0-9a-f-]{20,})\/?$/i)?.[1] || null;
  }

  function consumptionScope(response) {
    if (observerOwnedResponses.has(response)) return null;
    let url;
    try { url = new URL(response.url); } catch (_) { return null; }
    if (url.origin !== location.origin || !response.ok
      || !(response.headers.get("content-type") || "").includes("json")) return null;
    const id = conversationResponseId(url);
    if (!id || id !== conversationId()) return null;
    return responseScopes.get(response) || { epoch: state.epoch, requestId: id };
  }

  // The site normally reads JSON with response.text(), then aborts its fetch
  // controller as cleanup. A parallel clone.json() can lose that race even
  // after the primary reader has successfully received the complete body.
  // Observe the primary consumer's successful result BEFORE returning it to
  // the app, never replace its value, consume the body twice, capture request
  // headers, or issue an authenticated request on the app's behalf.
  for (const method of ["json", "text"]) {
    const descriptor = Object.getOwnPropertyDescriptor(Response.prototype, method);
    if (typeof descriptor?.value !== "function") continue;
    const original = descriptor.value;
    try {
      Object.defineProperty(Response.prototype, method, { ...descriptor,
        value: function (...args) {
          let scope = null;
          try { syncNavigation(); scope = consumptionScope(this); } catch (_) {}
          const result = Reflect.apply(original, this, args);
          if (!scope) return result;
          return result.then((value) => {
            try {
              if (currentEpoch(scope) && (!scope.requestId || scope.requestId === conversationId())) {
                const object = method === "json" ? value : JSON.parse(value);
                state.acquisition.primaryReads += 1;
                inspectObject(object, scope, `page response.${method}()`);
              }
            } catch (_) {
              // Diagnostic failure must not change the app's value or rejection.
              state.acquisition.primaryErrors += 1;
            }
            return value;
          }, (error) => {
            if (currentEpoch(scope)) { state.acquisition.primaryErrors += 1; scheduleRender(); }
            throw error;
          });
        },
      });
    } catch (_) {
      // Keep passive-clone/legacy behavior if a host locks its Response methods.
    }
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function routeAwareFetch(input, init) {
    syncNavigation();
    let url = null;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href); } catch (_) {}
    const epoch = { epoch: state.epoch, createdId: null, originConversationId: conversationId(),
      creating: !conversationId() && url?.origin === location.origin
        && /^\/backend-api\/(?:f\/)?conversation\/?$/.test(url.pathname)
        && String(init?.method || input?.method || "GET").toUpperCase() === "POST" };
    const response = await nativeFetch(input, init);
    try {
      if (!url) return response;
      const requestId = url.pathname.match(/\/conversations?\/([0-9a-f-]{20,})(?:\/|$)/i)?.[1];
      epoch.requestId = requestId || null;
      responseScopes.set(response, epoch);
      if ((currentEpoch(epoch) || awaitingCreationId(epoch))
        && (!requestId || requestId === conversationId()) && shouldInspect(url, response)) {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/event-stream")) {
          const clone = response.clone();
          observerOwnedResponses.add(clone);
          void inspectEventStream(clone, epoch);
        } else if (contentType.includes("json")) {
          // Let an ordinary text/json consumer start first. Do not allocate an
          // extra unbounded tee for multi-megabyte conversation JSON when the
          // app is already consuming it through the observed primary methods.
          setTimeout(() => {
            try {
              if (response.bodyUsed || !currentEpoch(epoch)) return;
              const clone = response.clone();
              observerOwnedResponses.add(clone);
              void clone.json().then((value) => {
                state.acquisition.cloneReads += 1;
                inspectObject(value, epoch, "cloned response");
              }).catch((error) => {
                if (currentEpoch(epoch) && error?.name === "AbortError") {
                  state.acquisition.cloneAborts += 1;
                  scheduleRender();
                }
              });
            } catch (_) {}
          }, 0);
        }
      }
    } catch (_) {}
    return response;
  };

  function conversationId(path = location.pathname) {
    const match = path.match(/\/c\/([0-9a-f-]{20,})/i);
    return match ? match[1] : null;
  }

  function needsMetadata() {
    const nodes = assistantNodes();
    // Metadata-backed selectors cannot identify the assistant before the first
    // payload. Permit one legacy bootstrap when message/turn IDs exist at all.
    if (!nodes.length) return !state.routes.size
      && Boolean(document.querySelector(MESSAGE_SELECTOR + "," + FIELD_SELECTOR + "," + TURN_SELECTOR));
    return nodes.some((node) => {
      const identity = assistantIdentity(node);
      if (identity.messageId) return !state.routes.has(identity.messageId) && !identity.modelSlug;
      if (identity.messageIds) return identity.messageIds.some((id) => !state.routes.get(id)?.authorRole)
        || (!identity.messageIds.length && !identity.invalidIdLists && !state.routes.size);
      return !routeForAssistant(node)?.actual;
    });
  }

  async function fetchConversationFallback() {
    syncNavigation();
    const epoch = state.epoch;
    const id = conversationId();
    if (!id || state.fallbackDisabled || state.fallbackInFlight || !needsMetadata()) return;
    const now = Date.now();
    if (now - state.lastFallbackAt < 3000) {
      scheduleFallback(3000 - (now - state.lastFallbackAt));
      return;
    }
    if (state.fallbackAttempts >= 3) return;
    state.fallbackAttempts += 1;
    state.lastFallbackAt = now;
    const controller = new AbortController();
    state.fallbackInFlight = controller;
    const timer = setTimeout(() => controller.abort(), 8000);
    const candidates = [
      `/backend-api/conversation/${encodeURIComponent(id)}`,
      `/backend-api/f/conversation/${encodeURIComponent(id)}`,
    ];
    let unsupported = 0;
    state.acquisition.fallback = "legacy compatibility check";
    try {
      for (const path of candidates) {
        if (!currentEpoch(epoch) || controller.signal.aborted) return;
        const response = await nativeFetch(path, { credentials: "include", cache: "no-store", signal: controller.signal });
        observerOwnedResponses.add(response);
        if (!currentEpoch(epoch)) return;
        if ([401, 403].includes(response.status)) {
          state.fallbackDisabled = true;
          state.acquisition.fallback = `HTTP ${response.status}; awaiting normal page data`;
          return;
        }
        if ([404, 410].includes(response.status)) { unsupported += 1; continue; }
        if (!response.ok) { state.acquisition.fallback = `HTTP ${response.status}`; continue; }
        if (!(response.headers.get("content-type") || "").includes("json")) continue;
        const value = await response.json();
        if (!currentEpoch(epoch)) return;
        state.acquisition.fallback = "legacy metadata received";
        inspectObject(value, epoch, "legacy conversation response");
        return;
      }
      if (unsupported === candidates.length) {
        state.fallbackDisabled = true;
        state.acquisition.fallback = "legacy endpoints unavailable; awaiting normal page data";
      }
    } catch (error) {
      if (currentEpoch(epoch)) state.acquisition.fallback = error?.name === "AbortError"
        ? "legacy read timed out" : "legacy read failed";
    } finally {
      clearTimeout(timer);
      if (state.fallbackInFlight === controller) state.fallbackInFlight = null;
      if (currentEpoch(epoch)) scheduleRender();
    }
  }

  function scheduleFallback(delay = 1200) {
    const due = Date.now() + delay;
    if (state.fallbackTimer && state.fallbackDue <= due) return;
    clearTimeout(state.fallbackTimer);
    state.fallbackDue = due;
    state.fallbackTimer = setTimeout(() => {
      state.fallbackTimer = null;
      void fetchConversationFallback();
    }, delay);
  }

  const ASSISTANT_SELECTOR = [
    '[data-message-author-role="assistant"]',
    '[data-message-role="assistant"]',
    '[data-turn="assistant"]',
    '[data-turn-role="assistant"]',
    '[data-conversation-role="assistant"]',
  ].join(",");
  const MESSAGE_SELECTOR = "[data-message-id]";
  const SEARCH_IDS_SELECTOR = "[data-chatgpt-search-message-ids]";
  const FIELD_SELECTOR = '[data-turn-key], [data-conversation-role="assistant"], [data-chatgpt-agent-turn-start], ' + SEARCH_IDS_SELECTOR;
  const TURN_SELECTOR = "[data-turn-id], [data-turn-id-container]";
  const EXCLUDED_SELECTOR = [
    '[data-message-author-role="user"]', '[data-message-role="user"]',
    '[data-turn="user"]', '[data-turn-role="user"]',
    '[data-conversation-role="user"]', '[data-user-message-bubble="true"]',
    '[data-message-author-role="tool"]', '[data-message-role="tool"]',
    '[data-turn="tool"]', '[data-turn-role="tool"]',
    '[data-conversation-role="tool"]',
    'pre', 'code', '[contenteditable="true"]',
    '#chatgpt-route-indicator-host', '[data-chatgpt-actual-route]',
  ].join(",");
  const OBSERVER_OPTIONS = {
    subtree: true, childList: true, attributes: true,
    attributeFilter: [
      "data-message-id", "data-message-author-role", "data-message-role",
      "data-turn", "data-turn-role", "data-turn-id", "data-turn-id-container",
      "data-message-model-slug", "data-message-status", "data-status",
      "data-turn-key", "data-conversation-role", "data-chatgpt-agent-turn-start",
      "data-chatgpt-search-message-ids", "data-user-message-bubble",
      "class", "style", "hidden", "aria-hidden", "inert",
    ],
  };

  function fieldRoot(node) {
    let role = node.closest("[data-conversation-role]");
    if (role && role.dataset.conversationRole !== "assistant") return null;
    // Repeated role markers inside the same keyed reply are one ownership scope.
    for (let parent = role?.parentElement?.closest("[data-conversation-role]"); parent;
      parent = parent.parentElement?.closest("[data-conversation-role]")) {
      if (parent.dataset.conversationRole !== "assistant"
        || parent.closest("[data-turn-key]") !== role.closest("[data-turn-key]")) break;
      role = parent;
    }
    const key = node.closest("[data-turn-key]");
    if (key) {
      if (role && key.contains(role)) return role;
      const roles = [...key.querySelectorAll('[data-conversation-role="assistant"]')]
        .filter((item) => item.closest("[data-turn-key]") === key
          && item.parentElement?.closest('[data-conversation-role="assistant"]')?.closest("[data-turn-key]") !== key);
      if (roles.length === 1) return roles[0];
      if (roles.length > 1) return null;
      return key;
    }
    if (role) return role;
    const legacy = node.closest(ASSISTANT_SELECTOR);
    if (legacy) return legacy;
    const descendants = [...node.querySelectorAll('[data-conversation-role="assistant"]')]
      .filter((item) => !item.closest("[data-turn-key]"));
    if (descendants.length === 1) return descendants[0];
    return node.matches(SEARCH_IDS_SELECTOR + ",[data-chatgpt-agent-turn-start]") ? node : null;
  }

  function fieldIdentity(node) {
    const host = fieldRoot(node) || node;
    const owners = new Set();
    for (const item of [node, ...node.querySelectorAll(SEARCH_IDS_SELECTOR)]) {
      if (item.matches(SEARCH_IDS_SELECTOR) && !item.closest(EXCLUDED_SELECTOR)
        && (item === node || fieldRoot(item) === host)) owners.add(item);
    }
    // A list on the keyed parent is usable only if it has one assistant owner;
    // do not lend one parent's whole list to several neighboring replies.
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (fieldRoot(parent) !== host) break;
      if (parent.matches(SEARCH_IDS_SELECTOR)) owners.add(parent);
      if (parent.matches("[data-turn-key]")) break;
    }
    const ids = new Set();
    let invalidIdLists = 0;
    for (const owner of owners) {
      const parsed = parseMessageIds(owner.getAttribute("data-chatgpt-search-message-ids"));
      if (!parsed.valid) invalidIdLists += 1;
      for (const id of parsed.ids) ids.add(id);
    }
    const key = node.closest("[data-turn-key]");
    if (!owners.size) {
      // Marker/key values can be opaque. Only exact persisted assistant IDs can
      // resolve them later; they are NOT turn_exchange_id aliases.
      const markers = [node, ...node.querySelectorAll("[data-chatgpt-agent-turn-start]")]
        .filter((item) => !item.closest(EXCLUDED_SELECTOR) && (item === node || fieldRoot(item) === host));
      for (const value of [...markers.map((item) => item.getAttribute("data-chatgpt-agent-turn-start")), key?.getAttribute("data-turn-key")]) {
        const parsed = parseMessageIds(value);
        if (parsed.valid) for (const id of parsed.ids) {
          const route = state.routes.get(id);
          if (route?.messageId === id && route.authorRole === "assistant") ids.add(id);
        }
      }
    }
    return { messageIds: [...ids].sort(), invalidIdLists,
      turnKey: key?.getAttribute("data-turn-key") || null,
      bindingSource: owners.size ? "data-chatgpt-search-message-ids" : "exact marker/key ID",
    };
  }

  function assistantIdentity(node) {
    if (!node) return { messageId: null, turnId: null, modelSlug: null, status: null };
    const message = node.closest(MESSAGE_SELECTOR);
    const turn = node.closest(TURN_SELECTOR);
    const containerId = turn?.dataset.turnIdContainer;
    const messageId = message?.dataset.messageId || null;
    const field = !messageId && (node.matches(FIELD_SELECTOR) || node.closest("[data-turn-key],[data-conversation-role]")
      || node.querySelector(SEARCH_IDS_SELECTOR)) ? fieldIdentity(node) : {};
    return {
      ...field,
      messageId,
      turnId: turn?.dataset.turnId || (containerId && !["true", "false"].includes(containerId) ? containerId : null),
      modelSlug: node.dataset.messageModelSlug || message?.dataset.messageModelSlug || null,
      status: node.dataset.messageStatus || node.dataset.status
        || message?.dataset.messageStatus || message?.dataset.status || null,
    };
  }

  function inactivePage(node) {
    for (let page = node.closest("[data-app-shell-page-surface]"); page;
      page = page.parentElement?.closest("[data-app-shell-page-surface]")) {
      const style = getComputedStyle(page);
      if (page.hidden || page.hasAttribute("inert") || page.getAttribute("aria-hidden") === "true"
        || style.display === "none" || style.visibility === "hidden") return true;
    }
    return false;
  }

  function screenReaderMarker(node) {
    if (node.classList.contains("sr-only")) return true;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.position === "absolute" && rect.width <= 2 && rect.height <= 2
      && (style.clipPath !== "none" || style.clip !== "auto");
  }

  function inlineHost(node) {
    if (!screenReaderMarker(node)) return node;
    // The actual site places the role on H4.sr-only, not on the visual reply.
    // Keep that node as identity evidence; place ONLY our label on its own
    // message-search container. Do not remove accessibility styles or promote
    // to a whole turn that also contains a user bubble or another assistant.
    const owner = node.parentElement?.closest(SEARCH_IDS_SELECTOR + "," + MESSAGE_SELECTOR);
    if (!owner || owner.closest("[data-turn-key]") !== node.closest("[data-turn-key]")
      || owner.closest(EXCLUDED_SELECTOR) || owner.querySelector('[data-user-message-bubble="true"]')) return null;
    const roles = [...owner.querySelectorAll('[data-conversation-role]')]
      .filter((role) => role.closest(SEARCH_IDS_SELECTOR + "," + MESSAGE_SELECTOR) === owner);
    if (roles.some((role) => role.dataset.conversationRole !== "assistant") || roles.length > 1) return null;
    return owner;
  }

  function assistantNodes() {
    const candidates = new Set();
    const eligible = (node) => {
      if (node.closest(EXCLUDED_SELECTOR)) return false;
      const route = state.routes.get(assistantIdentity(node).messageId);
      return !route?.authorRole || route.authorRole === "assistant";
    };
    for (const root of document.querySelectorAll(ASSISTANT_SELECTOR)) {
      if (!eligible(root)) continue;
      const messages = [...root.querySelectorAll(MESSAGE_SELECTOR)].filter(eligible);
      if (root.matches(MESSAGE_SELECTOR) || !messages.length) candidates.add(root);
      for (const node of messages) candidates.add(node);
    }
    // When the author DOM marker is gone entirely, the exact persisted message
    // ID and assistant author role are sufficient. User/tool IDs are not.
    for (const node of document.querySelectorAll(MESSAGE_SELECTOR)) {
      if (state.routes.get(node.dataset.messageId)?.authorRole === "assistant" && eligible(node)) candidates.add(node);
    }
    // Some layouts put the assistant message ID directly on the turn element.
    for (const node of document.querySelectorAll(TURN_SELECTOR)) {
      const id = node.dataset.turnId || node.dataset.turnIdContainer;
      if (state.routes.get(id)?.authorRole === "assistant" && eligible(node)) candidates.add(node);
    }
    for (const node of document.querySelectorAll(FIELD_SELECTOR)) {
      const root = fieldRoot(node);
      if (!root || !eligible(root)) continue;
      if (!root.matches(ASSISTANT_SELECTOR) && root.querySelector('[data-user-message-bubble="true"]')) continue;
      const identity = assistantIdentity(root);
      const hasAssistantProof = identity.messageIds?.some((id) => {
        const route = state.routes.get(id);
        return route?.messageId === id && route.authorRole === "assistant";
      });
      if (root.matches(ASSISTANT_SELECTOR) || hasAssistantProof) candidates.add(root);
    }
    const redundant = new Set();
    for (const node of candidates) {
      const id = assistantIdentity(node).messageId;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (candidates.has(parent) && (!parent.matches(MESSAGE_SELECTOR)
          || assistantIdentity(parent).messageId === id)) redundant.add(parent);
      }
    }
    const hosts = new Set();
    return [...candidates].filter((node) => {
      if (redundant.has(node) || inactivePage(node)) return false;
      const host = inlineHost(node);
      if (!host || hosts.has(host)) return false;
      hosts.add(host);
      return true;
    });
  }

  function routeForAssistant(node) {
    return routeForIdentity(assistantIdentity(node), state.routes);
  }

  function focusedAssistant(assistants) {
    if (!assistants.length) return null;
    const viewportHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    const viewportCenter = viewportHeight / 2;
    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const clipping = new Map();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    for (const node of assistants) {
      const anchor = inlineHost(node);
      if (!anchor) continue;
      const style = getComputedStyle(anchor);
      if (style.visibility === "hidden" || style.display === "none") continue;
      let rect = anchor.getBoundingClientRect();
      // display:contents has no own box, but its rendered reply still occupies
      // the viewport. Measure its contents rather than the badge alone.
      if (!rect.width && !rect.height && style.display === "contents") {
        const range = document.createRange();
        range.selectNodeContents(anchor);
        rect = range.getBoundingClientRect();
      }
      let top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, viewportHeight);
      let left = Math.max(rect.left, 0), right = Math.min(rect.right, viewportWidth);
      for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
        if (!clipping.has(parent)) {
          const css = getComputedStyle(parent);
          clipping.set(parent, { rect: parent.getBoundingClientRect(),
            x: css.display !== "contents" && /auto|scroll|hidden|clip/.test(css.overflowX),
            y: css.display !== "contents" && /auto|scroll|hidden|clip/.test(css.overflowY) });
        }
        const clip = clipping.get(parent);
        if (clip.y) { top = Math.max(top, clip.rect.top); bottom = Math.min(bottom, clip.rect.bottom); }
        if (clip.x) { left = Math.max(left, clip.rect.left); right = Math.min(right, clip.rect.right); }
      }
      const visibleHeight = Math.max(0, bottom - top);
      if (visibleHeight <= 0 || right <= left) continue;
      const visibleRatio = visibleHeight / Math.max(1, Math.min(rect.height || visibleHeight, viewportHeight));
      const center = (top + bottom) / 2;
      const score = visibleRatio * 10000 - Math.abs(center - viewportCenter);
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
    return best;
  }

  function ensurePanel() {
    let host = document.getElementById("chatgpt-route-indicator-host");
    if (host) return host.shadowRoot;
    host = document.createElement("div");
    host.id = "chatgpt-route-indicator-host";
    host.dataset.scriptVersion = VERSION;
    host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;pointer-events:none";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box}button{font:12px/1.35 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
        .pill{pointer-events:auto;border:1px solid rgba(148,163,184,.45);border-radius:999px;padding:7px 10px;background:rgba(15,23,42,.94);color:#e2e8f0;box-shadow:0 7px 24px rgba(15,23,42,.22);cursor:pointer;max-width:min(440px,calc(100vw - 36px));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .pill.good{border-color:rgba(52,211,153,.55);color:#d1fae5}.pill.warn{border-color:rgba(251,191,36,.72);color:#fef3c7}.pill.suspect{border-color:rgba(96,165,250,.7);color:#dbeafe}.pill.unknown{color:#cbd5e1}
        .detail{pointer-events:auto;display:none;margin-top:8px;width:min(390px,calc(100vw - 36px));padding:11px 12px;border:1px solid rgba(148,163,184,.3);border-radius:14px;background:rgba(15,23,42,.96);color:#e2e8f0;box-shadow:0 10px 30px rgba(15,23,42,.28);font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
        .detail.open{display:block}.row{display:grid;grid-template-columns:82px 1fr;gap:8px}.muted{color:#94a3b8}.warnText{color:#fbbf24}.suspectText{color:#93c5fd}.goodText{color:#6ee7b7}
      </style>
      <button type="button" class="pill unknown" id="pill" title="Click for persisted model route metadata">Model · waiting for metadata</button>
      <div class="detail" id="detail" role="status" aria-live="polite"></div>`;
    shadow.getElementById("pill").addEventListener("click", () => shadow.getElementById("detail").classList.toggle("open"));
    (document.documentElement || document).appendChild(host);
    return shadow;
  }

  function renderInline(assistants) {
    const retained = new Set();
    for (const target of assistants) {
      const route = routeForAssistant(target);
      const host = inlineHost(target);
      if (!host) continue;
      let badge = host.querySelector(":scope > [data-chatgpt-actual-route]");
      if (!route) {
        if (badge) badge.remove();
        continue;
      }
      if (!badge) {
        badge = document.createElement("div");
        badge.dataset.chatgptActualRoute = "true";
        badge.style.cssText = "display:block;flex:0 0 auto;align-self:stretch;grid-column:1/-1;width:100%;margin:6px 0 2px;font:11px/1.4 ui-sans-serif,system-ui;color:#64748b";
        host.appendChild(badge);
      }
      retained.add(badge);
      const identity = assistantIdentity(target);
      const memberIds = route.memberRoutes?.map((item) => item.messageId) || (route.messageId ? [route.messageId] : []);
      badge.dataset.routeMessageIds = JSON.stringify(memberIds);
      badge.dataset.routeBinding = route.memberRoutes ? "assistant-message-set" : "exact-message";
      badge.dataset.routeUnmatchedCount = String(route.unmappedMessageIds?.length || 0);
      badge.dataset.routeInvalidLists = String(route.invalidIdLists || 0);
      badge.dataset.routeTurnKey = identity.turnKey || "";
      const setLabel = messageSetLabel(route);
      if (setLabel) {
        if (badge.textContent !== setLabel) badge.textContent = setLabel;
        badge.style.color = route.actualModels.length > 1 || !route.actual ? "#d97706" : "#64748b";
      } else if (route.actual) {
        const actual = modelLabel(route.actual);
        const status = route.status ? ` · ${route.status}` : "";
        const runtimeConcern = executionConcern(route);
        const strongWarning = route.mismatch || route.resolutionChanged || (route.status && route.status !== "unavailable");
        const text = route.mismatch && route.expected
          ? `⚠ actual model: ${modelLabel(route.expected)} → ${actual}${status}`
          : runtimeConcern
            ? `? actual model: ${actual} · execution signal incomplete${status}`
            : `actual model: ${actual}${status}`;
        const color = strongWarning ? "#d97706" : runtimeConcern ? "#60a5fa" : "#64748b";
        if (badge.textContent !== text) badge.textContent = text;
        if (badge.style.color !== color) badge.style.color = color;
      } else {
        const text = `actual model: unknown${route.resolved ? ` · resolved route: ${modelLabel(route.resolved)}` : ""}${route.status ? ` · ${route.status}` : ""}`;
        if (badge.textContent !== text) badge.textContent = text;
        const color = route.status && route.status !== "unavailable" ? "#d97706" : "#64748b";
        if (badge.style.color !== color) badge.style.color = color;
      }
    }
    for (const badge of document.querySelectorAll('[data-chatgpt-actual-route="true"]')) {
      if (!retained.has(badge)) badge.remove();
    }
  }

  function renderPage() {
    syncNavigation();
    const shadow = ensurePanel();
    shadow.host.dataset.routeAcquisition = JSON.stringify({ ...state.acquisition,
      routeRecords: state.routes.size, fallbackInFlight: Boolean(state.fallbackInFlight) });
    const pill = shadow.getElementById("pill");
    const detail = shadow.getElementById("detail");
    const assistants = assistantNodes();
    renderInline(assistants);
    const target = focusedAssistant(assistants);
    const identity = assistantIdentity(target);
    const route = target ? routeForAssistant(target) : null;
    if (!route) {
      pill.className = "pill unknown";
      pill.textContent = "Actual · no reply matched";
      pill.dataset.focusedMessageId = identity.messageId || "";
      pill.dataset.focusedMessageIds = "[]";
      pill.dataset.focusedTurnKey = "";
      detail.innerHTML = `<div class="muted">No visible assistant response could be matched. Latest metadata is not substituted for the focused response.</div><div class="muted">Script ${VERSION} · ${state.routes.size} metadata records</div>`;
      return;
    }
    const actual = route.actual ? modelLabel(route.actual) : null;
    const exceptional = route.status && route.status !== "unavailable";
    const runtimeConcern = executionConcern(route);
    const strongWarning = route.mismatch || route.resolutionChanged || exceptional;
    const status = route.status ? ` · ${route.status}` : "";
    pill.className = `pill ${strongWarning ? "warn" : runtimeConcern ? "suspect" : actual ? "good" : "unknown"}`;
    const setLabel = messageSetLabel(route);
    pill.textContent = setLabel ? setLabel.replace(/^actual/, "Actual") : actual
      ? (route.mismatch && route.expected
        ? `⚠ Actual ${modelLabel(route.expected)} → ${actual}${status}`
        : runtimeConcern
          ? `? Actual · ${actual} · execution signal incomplete${status}`
          : `Actual · ${actual}${status}`)
      : `Actual · unknown${route.resolved ? ` · resolved ${modelLabel(route.resolved)}` : ""}${status}`;
    pill.dataset.focusedMessageId = identity.messageId || route.messageId || "";
    pill.dataset.focusedMessageIds = JSON.stringify(route.memberRoutes?.map((item) => item.messageId) || (route.messageId ? [route.messageId] : []));
    pill.dataset.focusedTurnKey = identity.turnKey || "";
    const row = (name, value, className = "") => `<div class="row"><span class="muted">${name}</span><span class="${className}">${escapeHtml(value || "—")}</span></div>`;
    detail.innerHTML = [
      row("script", VERSION),
      row("data source", state.acquisition.lastSource),
      row("page reads", String(state.acquisition.primaryReads)),
      row("fallback", state.acquisition.fallback),
      row("binding", route.memberRoutes ? "exact assistant message set" : "individual message"),
      ...(route.memberRoutes ? [
        row("matched IDs", String(route.memberRoutes.length)),
        row("excluded", String(route.excludedCount)),
        row("unmatched", String(route.unmappedMessageIds.length)),
        row("invalid lists", String(route.invalidIdLists)),
        row("turn key", identity.turnKey ? identity.turnKey.slice(0, 24) : null),
        ...route.memberRoutes.slice(0, 20).map((item) => row(item.messageId.slice(0, 8) + "…",
          `${modelLabel(item.actual)}${item.status ? " · " + item.status : ""}`)),
        route.memberRoutes.length > 20 ? row("more IDs", String(route.memberRoutes.length - 20)) : "",
      ] : []),
      row("default", modelLabel(route.expected), route.mismatch ? "warnText" : "goodText"),
      row("requested", modelLabel(route.requested)),
      row("resolved", modelLabel(route.resolved)),
      row("actual", actual || (route.actualModels?.length > 1 ? "multiple (see matched IDs)" : "unknown"), strongWarning ? "warnText" : runtimeConcern ? "suspectText" : "goodText"),
      row("thinking", route.turnThinkingEffort || route.thinkingEffort),
      row("reasoning", route.turnReasoningObserved ? "observed" : "not observed"),
      row("tool signal", route.turnToolObserved ? "observed" : "not observed"),
      row("status", route.status || (route.memberRoutes ? "no exception observed" : "complete")),
      row("message", (identity.messageId || route.messageId) ? `${(identity.messageId || route.messageId).slice(0, 8)}…` : "—"),
      row("turn", route.turnExchangeId ? `${route.turnExchangeId.slice(0, 8)}…` : "—"),
      row("source", route.source === "metadata"
        ? "assistant metadata"
        : route.source === "dom-message-model" ? "DOM message model" : route.source),
      route.override ? '<div class="warnText" style="margin-top:6px">orchestrator requested a model different from the persisted default</div>' : "",
      route.resolutionChanged ? '<div class="warnText" style="margin-top:6px">resolved route differs from the concrete model on this assistant message</div>' : "",
      runtimeConcern ? '<div class="suspectText" style="margin-top:6px">Suspected execution degradation: GPT-6 Pro is recorded, but this turn has no resolved-route, reasoning-lifecycle, or tool-execution evidence despite a nonzero thinking effort. This is not proof of a different model.</div>' : "",
      exceptional ? '<div class="warnText" style="margin-top:6px">generation did not complete normally; model is shown only when persisted evidence exists</div>' : "",
      !route.actual ? (route.memberRoutes
        ? '<div class="warnText" style="margin-top:6px">No single unambiguous model for this message set. Known assistant-node models are listed above; neither ID order nor the turn key selects a final response.</div>'
        : '<div class="warnText" style="margin-top:6px">actual model is unavailable; the resolved route is not treated as execution proof</div>') : "",
      '<div class="muted" style="margin-top:6px">Local display only · conversation text is neither stored nor transmitted.</div>',
    ].join("");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function render() {
    // Do not observe our own label insertions. Site removals/replacements still
    // trigger the observer, allowing React/virtualized turns to recover labels.
    state.observer?.disconnect();
    try { renderPage(); }
    finally { state.observer?.observe(document.documentElement, OBSERVER_OPTIONS); }
  }

  function scheduleRender() {
    // A trailing-only debounce can starve during continuous streaming/scrolling.
    if (state.renderTimer) return;
    state.renderTimer = setTimeout(() => {
      state.renderTimer = null;
      render();
    }, 50);
  }

  function observePage() {
    ensurePanel();
    scheduleRender();
    scheduleFallback(350);
    const observer = new MutationObserver((records) => {
      const layoutOnly = (record) => record.type === "attributes"
        && ["class", "style", "hidden", "aria-hidden", "inert"].includes(record.attributeName);
      const relevant = records.filter((record) => !layoutOnly(record)
        || record.target.matches(ASSISTANT_SELECTOR + ",[data-app-shell-page-surface]")
        || record.target.querySelector?.(ASSISTANT_SELECTOR));
      if (!relevant.length) return;
      const navigated = syncNavigation();
      scheduleRender();
      if (!navigated && relevant.some((record) => !layoutOnly(record))) scheduleFallback(1500);
    });
    state.observer = observer;
    observer.observe(document.documentElement, OBSERVER_OPTIONS);
    // SPA navigation need not change the assistant count or mutate the DOM yet.
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function (...args) {
        const result = Reflect.apply(original, this, args);
        syncNavigation();
        return result;
      };
    }
    document.addEventListener("scroll", scheduleRender, { passive: true, capture: true });
    window.addEventListener("resize", scheduleRender, { passive: true });
    window.addEventListener("popstate", () => {
      syncNavigation();
      scheduleRender();
      scheduleFallback(250);
    }, { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { scheduleRender(); scheduleFallback(350); }
    }, { passive: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observePage, { once: true });
  else observePage();
})();
