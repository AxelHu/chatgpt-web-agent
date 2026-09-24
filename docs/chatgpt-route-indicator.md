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
debounced same-origin conversation-GET fallback after navigation or assistant UI
changes. It never sends data to another origin. It stores only route metadata in
memory for the current tab and does not retain prompt/response text.

The floating badge follows the assistant response with the strongest visibility in
the viewport, so it changes while scrolling between turns. When ChatGPT exposes the
usual `data-message-author-role="assistant"` DOM marker, each response receives its
own small actual-model label. Message identity is retained before turn identity
because reasoning, summary, and final response nodes in one turn can legitimately
carry different `model_slug` values. Clicking the floating badge expands the
default/requested/resolved/actual fields plus shortened message and turn ids.

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
```
