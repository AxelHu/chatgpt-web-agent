# ChatGPT actual-model route indicator

`userscripts/chatgpt-route-indicator.user.js` is a local Tampermonkey userscript for
`chatgpt.com`. It makes persisted model-routing metadata visible while leaving the
normal ChatGPT UI and request flow intact.

For the current operational interpretation of GPT-6/Astra -> GPT-5.4 fallback together with missing external/MCP tools, see [`chat-route-fallback-tool-profile.md`](chat-route-fallback-tool-profile.md).

It reports the fields that ChatGPT itself persists on assistant nodes:

- `default_model_slug`: the persisted conversation/default target when present;
- `requested_model_slug`: the model requested by orchestration for that turn/node;
- `resolved_model_slug`: the route selected by orchestration;
- `model_slug`: the concrete model recorded on that generated assistant node and
  therefore the value displayed as **actual**.

A warning is shown when an explicit persisted default and concrete message model
differ after the small known GPT-6 Pro/Astra alias normalization. GPT-6 Sol and
GPT-6 Luna are intentionally treated as distinct concrete models, not aliases of
GPT-6 Pro/Astra. A separate note
is shown when the resolved route and concrete model differ. For example, a final
assistant node with `resolved_model_slug: gpt-5-4-auto-thinking` and
`model_slug: gpt-5-4-thinking` is displayed as actual **GPT-5.4 Thinking**, while
the Auto value remains visible in the resolved row. Resolved/requested values are
never relabeled as actual when `model_slug` is absent.

The script observes cloned same-origin ChatGPT conversation/SSE responses and has a
coalesced, rate-limited same-origin conversation-GET fallback after navigation or assistant UI
changes. It never sends data to another origin. It stores only route metadata in
memory for the current tab and does not retain prompt/response text.

The floating badge follows the visible assistant response, including nested scroll
containers and `display: contents` wrappers. Version **0.7.0** no longer relies on
only `data-message-author-role="assistant"`. It also supports explicit assistant
message/turn markers, or an exact DOM message ID linked to persisted **assistant**
metadata. Message identity can live on an ancestor. Nested old/new wrappers are
deduplicated; user/tool elements and quoted code are excluded.

A wrapper with only a turn-exchange ID may use same-exchange assistant evidence
only when its concrete model is unambiguous. Message identity remains preferred:
reasoning and final nodes in one turn can legitimately have different models.
When no visible response can be matched, the floating badge says **no reply
matched**, rather than disguising a locator failure with the global latest model.
Clicking the badge shows the route fields, shortened IDs, and script version.

DOM replacements, deleted labels and attribute-only message/turn ID changes trigger
reattachment. Rendering is coalesced without waiting for streaming to become idle;
the script does not observe its own insertions or create an idle refresh loop.
Stale fetch/SSE observations from another navigation are ignored. A newly created
chat's `/` to `/c/ID` transition preserves its own stream only when the response's
explicit conversation ID matches; it cannot adopt an unrelated conversation.

Cancelled, interrupted, failed, and model-unavailable assistant responses keep a
visible label instead of silently disappearing. If another persisted node in the
same `turn_exchange_id` records a concrete `model_slug`, that model is shown with
the terminal status (for example, `GPT-5.4 Thinking · cancelled`). If no concrete
model evidence exists anywhere in the turn, the script explicitly shows
`Actual · unknown · interrupted` or `Actual · unknown · unavailable`; it never
promotes requested/resolved routing values to actual execution evidence.

Tampermonkey installation on Firefox/Chromium is preferred here because it avoids
changing Firefox unsigned-extension security policy. The userscript must be
installed/updated by the browser user; repository presence alone does not activate
it.

Offline regression:

```bash
node --check userscripts/chatgpt-route-indicator.user.js
node scripts/test-chatgpt-route-indicator.mjs
# Optional DOM/network regression; requires Playwright and its Chromium installed:
node scripts/test-chatgpt-route-indicator-browser.mjs
```
Version 0.6 also adds a deliberately conservative execution-health warning for
GPT-6 Pro/Astra. If a turn records a nonzero thinking effort but the whole turn
contains no resolved-route evidence, no reasoning-lifecycle node, and no tool
execution signal, the badge shows **execution signal incomplete** with a distinct
suspect style. This is intentionally separate from the stronger wrong-model
warning: it only marks the observable pattern seen in degraded continuation cases
where the persisted model tag remained `gpt-6-pro`.

## 0.7.0 compatibility delivery

See [the 2026-10-08 audit](route-ui-compat-20261008.md) and its synthetic test
receipts. The old script reproduces "floating badge present, inline labels absent"
when the legacy author marker is removed; the new adapter passes that fixture and
the expanded regression suite. **This is not a claim of live-site acceptance:**
the available signed-in webpage was not obtained during this audit.

Keep the existing script name and namespace; replace/update the installed script
rather than enabling a second copy, then refresh ChatGPT. The expanded badge must
show `script: 0.7.0`. A Git checkout or a published artifact does not by itself
update Tampermonkey, and installations pinned to a commit need an explicit update.
