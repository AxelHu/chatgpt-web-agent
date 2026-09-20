// ==UserScript==
// @name         ChatGPT Actual Model Route
// @namespace    https://chatgpt.com/
// @version      0.1.0
// @description  Show the persisted default/requested/resolved Chat model route without collecting conversation text.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// ==/UserScript==

(function () {
  "use strict";

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
      "gpt-5-4-auto-thinking": "GPT-5.4 Auto",
      "gpt-5-4-thinking": "GPT-5.4 Thinking",
      "gpt-5-6-thinking": "GPT-5.6 Thinking",
      "gpt-5.6-sol": "GPT-5.6 Sol",
      "gpt-5-6": "GPT-5.6",
    };
    return labels[slug] || slug || "unknown";
  }

  function routeFromMetadata(metadata, fallback = {}) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const rawModel = typeof metadata.model_slug === "string" ? metadata.model_slug : null;
    const resolved = typeof metadata.resolved_model_slug === "string"
      ? metadata.resolved_model_slug
      : rawModel;
    if (!resolved) return null;
    const expected = typeof metadata.default_model_slug === "string" ? metadata.default_model_slug : null;
    const requested = typeof metadata.requested_model_slug === "string" ? metadata.requested_model_slug : null;
    return {
      messageId: fallback.messageId || null,
      turnExchangeId: typeof metadata.turn_exchange_id === "string"
        ? metadata.turn_exchange_id
        : fallback.turnExchangeId || null,
      requestId: typeof metadata.request_id === "string" ? metadata.request_id : null,
      createTime: Number.isFinite(Number(fallback.createTime)) ? Number(fallback.createTime) : null,
      expected,
      requested,
      rawModel,
      resolved,
      mismatch: Boolean(expected && !sameModel(expected, resolved)),
      override: Boolean(expected && requested && !sameModel(expected, requested)),
    };
  }

  function routeKey(route) {
    return route.turnExchangeId || route.messageId || route.requestId || [
      route.createTime || "",
      route.expected || "",
      route.requested || "",
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
      rawModel: next.rawModel || previous.rawModel || null,
      resolved: next.resolved || previous.resolved || null,
    };
    merged.mismatch = Boolean(merged.expected && merged.resolved && !sameModel(merged.expected, merged.resolved));
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
      if (metadata && (authorRole === "assistant" || ROUTE_KEYS.some((key) => typeof metadata[key] === "string"))) {
        const route = routeFromMetadata(metadata, {
          messageId: typeof node.id === "string" ? node.id : null,
          createTime: node.create_time,
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
      // Prefer richer persisted metadata, especially resolved/default fields.
      const score = (item) => Number(Boolean(item.expected)) * 4
        + Number(Boolean(item.requested)) * 2
        + Number(Boolean(item.resolved)) * 4
        + Number(Boolean(item.messageId));
      byTurn.set(key, score(route) >= score(previous) ? mergeRoute(previous, route) : mergeRoute(route, previous));
    }
    return [...byTurn.values()].sort((a, b) => {
      const ta = a.createTime || 0;
      const tb = b.createTime || 0;
      return ta - tb;
    }).at(-1) || null;
  }

  if (testHook && typeof testHook === "object") {
    testHook.exports = { canonicalModel, sameModel, modelLabel, routeFromMetadata, collectRoutes, chooseLatest };
    return;
  }

  const state = {
    routes: new Map(),
    latest: null,
    lastConversationId: null,
    lastFallbackAt: 0,
    fallbackTimer: null,
    renderTimer: null,
  };

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

  function inspectObject(value) {
    try {
      rememberRoutes(collectRoutes(value));
    } catch (_) {
      // This observer must never affect ChatGPT itself.
    }
  }

  function parseEventBlock(block) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try { inspectObject(JSON.parse(data)); } catch (_) {}
  }

  async function inspectEventStream(response) {
    if (!response.body || typeof TextDecoderStream === "undefined") {
      try {
        const text = await response.text();
        for (const block of text.split(/\r?\n\r?\n/)) parseEventBlock(block);
      } catch (_) {}
      return;
    }
    try {
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        for (;;) {
          const match = /\r?\n\r?\n/.exec(buffer);
          if (!match) break;
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          parseEventBlock(block);
        }
      }
      if (buffer.trim()) parseEventBlock(buffer);
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

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function routeAwareFetch(input, init) {
    const response = await nativeFetch(input, init);
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
      if (shouldInspect(url, response)) {
        const clone = response.clone();
        const contentType = clone.headers.get("content-type") || "";
        if (contentType.includes("text/event-stream")) void inspectEventStream(clone);
        else if (contentType.includes("json")) void clone.json().then(inspectObject).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  function conversationId() {
    const match = location.pathname.match(/\/c\/([0-9a-f-]{20,})/i);
    return match ? match[1] : null;
  }

  async function fetchConversationFallback() {
    const id = conversationId();
    if (!id) return;
    const now = Date.now();
    if (now - state.lastFallbackAt < 3000) return;
    state.lastFallbackAt = now;
    const candidates = [
      `/backend-api/conversation/${encodeURIComponent(id)}`,
      `/backend-api/f/conversation/${encodeURIComponent(id)}`,
    ];
    for (const path of candidates) {
      try {
        const response = await nativeFetch(path, { credentials: "include", cache: "no-store" });
        if (!response.ok) continue;
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("json")) continue;
        inspectObject(await response.json());
        return;
      } catch (_) {}
    }
  }

  function scheduleFallback(delay = 1200) {
    clearTimeout(state.fallbackTimer);
    state.fallbackTimer = setTimeout(() => void fetchConversationFallback(), delay);
  }

  function ensurePanel() {
    let host = document.getElementById("chatgpt-route-indicator-host");
    if (host) return host.shadowRoot;
    host = document.createElement("div");
    host.id = "chatgpt-route-indicator-host";
    host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;pointer-events:none";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box}button{font:12px/1.35 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
        .pill{pointer-events:auto;border:1px solid rgba(148,163,184,.45);border-radius:999px;padding:7px 10px;background:rgba(15,23,42,.94);color:#e2e8f0;box-shadow:0 7px 24px rgba(15,23,42,.22);cursor:pointer;max-width:min(440px,calc(100vw - 36px));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .pill.good{border-color:rgba(52,211,153,.55);color:#d1fae5}.pill.warn{border-color:rgba(251,191,36,.72);color:#fef3c7}.pill.unknown{color:#cbd5e1}
        .detail{pointer-events:auto;display:none;margin-top:8px;width:min(390px,calc(100vw - 36px));padding:11px 12px;border:1px solid rgba(148,163,184,.3);border-radius:14px;background:rgba(15,23,42,.96);color:#e2e8f0;box-shadow:0 10px 30px rgba(15,23,42,.28);font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
        .detail.open{display:block}.row{display:grid;grid-template-columns:82px 1fr;gap:8px}.muted{color:#94a3b8}.warnText{color:#fbbf24}.goodText{color:#6ee7b7}
      </style>
      <button type="button" class="pill unknown" id="pill" title="Click for persisted model route metadata">Route · waiting for metadata</button>
      <div class="detail" id="detail" role="status" aria-live="polite"></div>`;
    shadow.getElementById("pill").addEventListener("click", () => shadow.getElementById("detail").classList.toggle("open"));
    (document.documentElement || document).appendChild(host);
    return shadow;
  }

  function renderInline(route) {
    const assistants = document.querySelectorAll('[data-message-author-role="assistant"]');
    const target = assistants[assistants.length - 1];
    if (!target) return;
    let badge = target.querySelector(":scope > [data-chatgpt-actual-route]");
    if (!badge) {
      badge = document.createElement("div");
      badge.dataset.chatgptActualRoute = "true";
      badge.style.cssText = "margin:6px 0 2px;font:11px/1.4 ui-sans-serif,system-ui;color:#64748b";
      target.appendChild(badge);
    }
    const actual = modelLabel(route.resolved);
    badge.textContent = route.mismatch && route.expected
      ? `⚠ actual route: ${modelLabel(route.expected)} → ${actual}`
      : `actual route: ${actual}`;
    badge.style.color = route.mismatch ? "#d97706" : "#64748b";
  }

  function render() {
    const shadow = ensurePanel();
    const pill = shadow.getElementById("pill");
    const detail = shadow.getElementById("detail");
    const route = state.latest;
    if (!route) {
      pill.className = "pill unknown";
      pill.textContent = "Route · waiting for metadata";
      detail.innerHTML = '<div class="muted">No persisted assistant route metadata observed yet.</div>';
      return;
    }
    const actual = modelLabel(route.resolved);
    pill.className = `pill ${route.mismatch ? "warn" : "good"}`;
    pill.textContent = route.mismatch && route.expected
      ? `⚠ Route ${modelLabel(route.expected)} → ${actual}`
      : `Actual · ${actual}`;
    const row = (name, value, className = "") => `<div class="row"><span class="muted">${name}</span><span class="${className}">${escapeHtml(value || "—")}</span></div>`;
    detail.innerHTML = [
      row("default", modelLabel(route.expected), route.mismatch ? "warnText" : "goodText"),
      row("requested", modelLabel(route.requested)),
      row("resolved", actual, route.mismatch ? "warnText" : "goodText"),
      row("raw", modelLabel(route.rawModel)),
      row("turn", route.turnExchangeId ? `${route.turnExchangeId.slice(0, 8)}…` : "—"),
      route.override ? '<div class="warnText" style="margin-top:6px">orchestrator requested a model different from the persisted default</div>' : "",
      '<div class="muted" style="margin-top:6px">Local display only · conversation text is neither stored nor transmitted.</div>',
    ].join("");
    renderInline(route);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function scheduleRender() {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(render, 50);
  }

  function observePage() {
    ensurePanel();
    scheduleFallback(350);
    let lastUrl = location.href;
    let lastAssistantCount = 0;
    const observer = new MutationObserver(() => {
      const url = location.href;
      const count = document.querySelectorAll('[data-message-author-role="assistant"]').length;
      if (url !== lastUrl) {
        lastUrl = url;
        const id = conversationId();
        if (id !== state.lastConversationId) {
          state.lastConversationId = id;
          state.routes.clear();
          state.latest = null;
          scheduleRender();
        }
        scheduleFallback(250);
      } else if (count !== lastAssistantCount) {
        lastAssistantCount = count;
        scheduleFallback(900);
      } else {
        scheduleFallback(1500);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true });
    window.addEventListener("popstate", () => scheduleFallback(250), { passive: true });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleFallback(350);
    }, { passive: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observePage, { once: true });
  else observePage();
})();
