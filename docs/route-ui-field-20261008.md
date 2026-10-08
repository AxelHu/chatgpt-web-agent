# Actual Model Route v0.7.1 — company-side DOM follow-up

## Acceptance status

**v0.7.0 failed the company-side live old-conversation acceptance test.** The
user relayed the local agent's report: normal page content, five assistant turns,
25 copy buttons, and zero inline labels. The DOM uses `data-turn-key`,
`data-conversation-role="assistant"`, `data-chatgpt-agent-turn-start`, and
`data-chatgpt-search-message-ids`; user bubbles use `data-user-message-bubble="true"`.

The report gives attribute names and observed counts, not a full DOM snapshot or
raw attribute values. Its defect is confirmed against the 0.7.0 source, which did
not cover these attributes. Fixtures use those reported attribute names and counts
but **synthetic hierarchy, ID serialization, metadata, and text**. They are not a
claim of independently reading the company's actual browser.

**v0.7.1 implementation and automated regression are complete; company-side live
acceptance is still pending.** This supersedes the earlier 0.7.0 compatibility
assessment; do not close the live acceptance follow-up on synthetic tests alone.

## Fix and evidence rules

The new adapter handles all reported attributes and observes their attribute-only
changes. It resolves ownership within keyed assistant turns, deduplicates nested
markers, and excludes user bubbles, tool regions and quoted code. Empty/boolean
start markers are not replies. Copy-button count, list order and timestamps are
never used to assign message identity.

`data-chatgpt-search-message-ids` is parsed as a JSON string array, JSON-quoted
string, or whitespace/comma-delimited literal ID list. Unsupported/malformed lists
stay explicit invalid/unknown. Every ID must exactly match a persisted message ID;
only records with **author.role = assistant** are model evidence. Known user/tool
IDs are excluded; absent author/model records remain visible as unmatched/unknown.
Minimal ID/author metadata is retained even when the assistant has no model field.
No prompt or response text is retained.

Multiple matching assistants with the same concrete model produce one compact
badge with the assistant count. Different concrete models are shown as
`actual models: ...`, with ID-to-model mappings in the expanded pill; no list item
is guessed to be the final response. Missing models/IDs yield an incomplete state.
A more precise `data-message-id` node still wins over a grouped turn list.

`data-turn-key` is an opaque ownership key, not an alias for `turn_exchange_id`.
A marker/key value is usable as a message ID only on an exact persisted assistant
match. A present search-ID list is authoritative and cannot be replaced with an
unrelated turn-key or globally latest record.

## Regression evidence

Old 0.7.0 on the reported-attribute fixture: **zero inline labels**. Candidate 0.7.1:
**five labels for five assistant turns**, despite 25 copy buttons and mixed
user/tool/assistant IDs. Exact assistant-ID bindings are asserted, not just counts.

Chromium: **54 scenarios / 198 checks PASS**.
Firefox (Playwright's isolated engine, not the company's installed Firefox):
**54 scenarios / 198 checks PASS**.
The existing parser suite and new literal-ID/author-filtering assertions also pass.
Each browser case checks page errors and absence of cross-origin traffic. The
readonly acceptance probe is tested for no network requests and no original reply
text in its output.

The 22 field-oriented cases cover the reported layout, multi-model ordering
invariance, missing metadata, nested and adjacent turn ownership, alternate
serialization, invalid lists, attribute-only changes, marker-only identity,
scrolling, replacement, exact-message precedence and read-only diagnostics. All 32
previous browser cases remain passing, including SSE/navigation behavior.

Full receipts: `docs/route-ui-field-20261008-results.json`.
Userscript SHA-256: `c74f212c51c76060337212bab0d46e03a4930f45410013cf738f135654cab7df`.

## Company agent retest handoff

Update the existing **ChatGPT Actual Model Route** userscript, preserving its
name/namespace, to **0.7.1**. Do not enable two copies. Refresh the **same old
conversation that failed**; confirm script 0.7.1 in the expanded floating badge.
No new ChatGPT prompt is necessary.

For the five rendered assistant-turn sample, expect five nonduplicate badges,
zero badges inside user bubbles, and correct exact assistant metadata matches.
When multiple assistant nodes use different models, expect a multi-model badge,
not a guessed final model. Unknown/unmatched cases must remain visible as such.
Scroll between old turns and verify that the floating badge follows the keyed
reply. Check attribute-only hydration/reuse and navigation without altering
existing conversations or closing the user's tabs.

Run `scripts/inspect-chatgpt-route-indicator-dom.js` in that same page and return
its JSON result. It is read-only: structural counts, ID-list format categories,
userscript-generated labels and match counts only; no original conversation text,
raw IDs, URL, cookies, storage reads or network requests. `hasLayoutBox` confirms
that a badge has nonzero dimensions, not that it is currently in the viewport.

The probe's `unmatchedIds`, `invalidLists`, per-badge matched assistant counts and
list-format summary distinguish locator failure from unsupported serialization
or missing persisted metadata. Keep the follow-up open until that onsite result.

## Delivery scope

Only the userscript, its dedicated parser/browser tests, a read-only diagnostic
and compatibility documentation are changed. No extra worktree/profile copy was
created. Isolated test browsers were closed; the user's existing browser windows,
installed scripts, credentials, proxy, conversation data and services were not
modified in this follow-up.
