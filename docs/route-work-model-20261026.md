# Work model labels — 0.8.0 verification (2026-10-26)

## Finding

The 0.7.4 userscript was written and tested around ordinary Chat metadata. It
recognized `gpt-6-astra` as an ordinary-Chat alias of `gpt-6-pro`, but had no
Work-surface concept and no `*-wm` mapping. The reproduced baseline was:

- `modelLabel("gpt-6-astra-wm")` returned the raw slug;
- `sameModel("gpt-6-astra", "gpt-6-astra-wm")` returned `false`;
- a parsed Work route carried no surface identity.

This made Work labels incomplete and made the browser-persisted and native Work
IDs look like different models after the Desktop Bridge compatibility update.

## Read-only live evidence

The signed-in Desktop renderer was queried through its existing read-only HTTP
and native RPC paths. No prompt was submitted and no conversation, thread, file,
setting, or browser storage was changed.

| Source | Observed identity |
| --- | --- |
| Authenticated web Work conversation (ID omitted from the committed receipt) | `conversation_origin: tpp`; 373 assistant model nodes; every concrete slug was `gpt-6-astra-wm` |
| Corresponding native Work thread (ID omitted from the committed receipt) | `thread.model: gpt-6-astra` |
| Native Work `model/list` | `gpt-6-astra` display name `GPT-6-Astra` |

Only route metadata was retained in the receipt; conversation text was excluded,
and the web/native IDs were reduced to short SHA-256 prefixes.
The complete metadata-only result is in
[`route-work-model-20261026-live.json`](route-work-model-20261026-live.json).

## 0.8.0 behavior

Version 0.8.0 distinguishes the surface before comparing or labelling models:

- `conversation_origin: tpp` / `work` establishes Work context;
- a persisted `-wm` suffix is direct Work evidence and overrides an earlier
  metadata-free streaming fragment that provisionally appeared to be Chat;
- `-wm` is removed only for Work-family comparison;
- Work labels use the live native Work catalog names and append `· Work`;
- ordinary Chat keeps the existing `gpt-6-pro` / `gpt-6-astra` alias behavior;
- the ordinary-Chat execution-signal warning is not applied to Work Astra;
- the expanded panel exposes both `surface: Work / tpp` and the exact recorded
  slug, such as `gpt-6-astra-wm`.

Consequently:

| Comparison | Result |
| --- | --- |
| Work web `gpt-6-astra-wm` vs native Work `gpt-6-astra` | same Work model |
| Work `gpt-6-astra-wm` vs ordinary-Chat `gpt-6-pro` | different models |
| Visible Work label | `GPT-6-Astra · Work` |

The current native Work catalog labels covered by regression are
`GPT-6.1-Sol`, `GPT-6-Astra`, `GPT-6-Sol`, `GPT-6-Luna`, `GPT-5.6-Sol`,
`GPT-5.6-Terra`, and `GPT-5.6-Luna`.

## Verification

The pure metadata regression passed, including the sanitized live Work payload,
native/web suffix normalization, grouped-message handling, and preservation of
ordinary-Chat aliases.

Both browser engines then passed the complete suite:

| Engine | Scenarios | Assertions | Result |
| --- | ---: | ---: | --- |
| Chromium | 74 | 282 | pass |
| Firefox | 74 | 282 | pass |

The added navigation regression explicitly visits Work, switches to an ordinary
Chat using the overlapping `gpt-6-astra` family, and then revisits cached Work. It
verifies that Work identity does not leak into Chat and that the cached Work
surface is restored correctly.

Receipts:

- [`route-work-model-20261026-chromium.json`](route-work-model-20261026-chromium.json)
- [`route-work-model-20261026-firefox.json`](route-work-model-20261026-firefox.json)
- [`route-work-model-20261026-live.json`](route-work-model-20261026-live.json)

Commands used for the offline/browser regression:

```bash
node --check userscripts/chatgpt-route-indicator.user.js
node scripts/test-chatgpt-route-indicator.mjs
node scripts/test-chatgpt-route-indicator-browser.mjs
ROUTE_TEST_BROWSER=firefox node scripts/test-chatgpt-route-indicator-browser.mjs
```

## Delivery boundary

The userscript still injects only on `https://chatgpt.com/*`; it does not run in
the Desktop application's `app://-` renderer. The native Work API was used to
verify the canonical ID and display name. Repository version 0.8.0 must still be
updated in the existing Tampermonkey entry before the browser uses it; a repository
checkout alone does not alter an installed userscript.

A read-only inspection of the active Chrome Default Tampermonkey storage found the
enabled installed copy still at **0.7.4**, with its download URL pinned to commit
`d370c4d08799f30b50adcb6f0890ee3c1d2f7d98`. No extension storage was changed.
See [`route-work-model-20261026-installed.json`](route-work-model-20261026-installed.json).
