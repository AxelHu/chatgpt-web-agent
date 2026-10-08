# Actual Model Route 0.7.0 — UI compatibility adaptation

## Observed report and confirmed reproduction

On 2026-10-08 the user reported a floating model badge still appearing while
per-message labels had disappeared after a ChatGPT web UI update.

Running the previous **0.6.1** script against a synthetic conversation whose
assistant article has `data-turn="assistant"` and `data-message-id`, but no
`data-message-author-role="assistant"`, reproduces that exact **failure class**:
zero inline labels, while the floating pill still reports the latest GPT-6 Luna
record. This establishes the old selector weakness, **not the exact DOM deployed
to the user's current account**. No page source or private conversation text is
included in the fixtures or published receipts.

## Changes

- Match explicit assistant message/turn markers and exact message IDs backed by
  persisted assistant authorship; support ancestor IDs and exact turn-node IDs.
- Deduplicate hybrid/nested wrappers and keep each message's concrete model; a
  turn-only fallback cannot choose among conflicting models. User/tool nodes and
  quoted code are excluded.
- Restore labels after subtree replacement, external label removal, or ID/role
  attribute changes. Render during streaming without observing our own updates.
- Follow actually visible replies, including scroll clipping and `display:
  contents`; keep the label compact in flex-column/grid layouts.
- Do not replace a missing focused-message binding with global latest metadata.
  Show an explicit unmatched state and a version row for diagnostics.
- Guard navigation and stale JSON/SSE responses. Preserve a newly created chat's
  stream only across the transition proven by its own conversation ID.

## Validation

`node --check` and the existing parser regression plus added identity/role
assertions pass. The actual userscript was loaded at document-start in Chromium
against intercepted synthetic pages/responses: **32 scenarios, 104 checks, all
passed**, with no page errors or cross-origin requests in the suite.

Coverage includes old/new/metadata-only/hybrid DOMs, exact per-phase models,
ancestor IDs, ambiguous turn-only records, React replacement, label removal,
attribute-only reuse, continuous streaming, clipped/hidden/boxless layouts,
same-count navigation, late JSON/SSE, background conversation GETs, unchanged
original stream bodies, interruption/unknown evidence, idle traffic, a 160-message
conversation, and new-chat transitions before/after initial metadata.

A candidate defect in first-message navigation was caught by two added failing
fixtures and corrected before this result. A separate negative fixture confirms
that the creation exception cannot adopt an unrelated destination conversation.

Receipts: [baseline and candidate](route-ui-compat-20261008-results.json).
Candidate userscript SHA-256: `1a3c1d427ebd58e43fd5359bc7c42cbf23f45ea4753f290e23aa86b786df7de2`.

## Live acceptance limitation

The local managed browser navigation still returned HTTP 403 with a Cloudflare
challenge; no authenticated live conversation DOM was obtained. An existing
Desktop webview exposed no conversation markers, and creating a tab inside its
Electron context returned a context-not-found error. Neither event proves a
website selector shape. No challenge bypass, proxy change, credential extraction,
new chat submission, or modification of installed browser scripts was performed.

**Source fix and synthetic regression are complete; live acceptance of the user's
installed copy remains unverified.** Update the existing Tampermonkey script to
0.7.0 and refresh the page. Confirm the version in the expanded model badge, then
check inline labels and scrolling between replies. Do not run two script copies.

## Scope and cleanup

Only the userscript, its dedicated tests, and documentation are changed. Existing
repository history was reused; no extra checkout/worktree was created. Disposable
test browsers were closed, and no original user browser windows/tabs were closed
or restarted. The script remains local-display-only: it does not persist message
text or send its observations to another origin.
