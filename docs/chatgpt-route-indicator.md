# ChatGPT actual-model route indicator

`userscripts/chatgpt-route-indicator.user.js` is a local Tampermonkey userscript for
`chatgpt.com`. It makes persisted model-routing metadata visible while leaving the
normal ChatGPT UI and request flow intact.

It reports the fields that ChatGPT itself persists on assistant nodes:

- `default_model_slug`: the persisted conversation/default target when present;
- `requested_model_slug`: the model requested by orchestration for that turn/node;
- `resolved_model_slug`: the effective resolved route, falling back to
  `model_slug` only when the resolved field is absent;
- `model_slug`: the raw node label, retained only for diagnostics.

A warning is shown only when an explicit persisted default and effective resolved
route differ after the small known GPT-6 Pro/Astra alias normalization. Unknown
model names are never capability-ranked. A raw `gpt-5-4-thinking` node whose
`resolved_model_slug` is `gpt-5-4-auto-thinking` is therefore displayed as one
resolved 5.4 Auto route, not as a second model switch.

The script observes cloned same-origin ChatGPT conversation/SSE responses and has a
debounced same-origin conversation-GET fallback after navigation or assistant UI
changes. It never sends data to another origin. It stores only route metadata in
memory for the current tab and does not retain prompt/response text.

The floating badge shows the latest observed route. When ChatGPT exposes the usual
`data-message-author-role="assistant"` DOM marker, a small route label is also added
to the latest visible assistant response. Clicking the floating badge expands the
default/requested/resolved/raw fields and a shortened turn id.

Tampermonkey installation on Firefox/Chromium is preferred here because it avoids
changing Firefox unsigned-extension security policy. The userscript must be
installed/updated by the browser user; repository presence alone does not activate
it.

Offline regression:

```bash
node --check userscripts/chatgpt-route-indicator.user.js
node scripts/test-chatgpt-route-indicator.mjs
```
