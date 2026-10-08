> Final installed version: **0.7.3**. Real-account home Chrome acceptance passed
> for visible labels, independent metadata comparison, cached navigation, scroll
> focus and full reload. Earlier checkpoints below record the failures found
> during testing; they are not the final acceptance status.

# Home Chrome real-account acceptance — 2026-10-08

## Confirmed failure in 0.7.1

The signed-in real webpage exposes `data-conversation-role="assistant"` on an
`H4.sr-only` accessibility heading (absolute 1×1 px, overflow hidden,
`clip-path: inset(50%)`). Version 0.7.1 appended its label into that heading.
A nonzero DOM badge count and a positive bounding box were therefore insufficient
acceptance evidence. The visual message is the containing search-ID DIV.

The updated UI also keeps inactive conversation page surfaces at `display:none`.
After navigation, their old role markers must not count as current replies.
Three unknown labels observed during a real navigation belonged to the hidden old
conversation, not the active conversation's missing metadata.

## 0.7.2 changes

Keep the semantic heading as identity evidence, but mount the label on its own
visual search-ID/message container. Reject an ambiguous owner or a user-containing
owner; do not change the site's accessibility heading/styles. Focus calculations
use the same visual anchor. Skip inactive app-shell page surfaces and reattach on
visibility changes. Diagnostics now distinguish readable layout from sr-only or
hidden layout instead of treating a 1px box as sufficient.

## Regression

The 0.7.1 source fails the exact anonymized geometry fixture: two labels are inside
sr-only headings. With 0.7.2, Chromium and Firefox each pass 58 scenarios / 220
checks. The new fixture verifies visible text width, placement below reply text,
center-point hit testing, grouped exact assistant IDs and hidden cached surfaces.

## Live delivery checkpoint

Source fix and regression are ready. Actual installed 0.7.2 home Chrome acceptance
is pending at this commit; do not treat fixture results as that acceptance.
No credential values or conversation text are included in this document.

## Second live finding: cached navigation

The installed 0.7.2 candidate passed readable placement and three real scroll/hit
checks, but returning to an already-open conversation could show unknown models:
the application reused its cached DOM without necessarily fetching its metadata.
Version 0.7.3 keeps metadata-only snapshots for the three most recently departed
conversations (at most 4,000 records per saved conversation), keyed by exact
conversation ID and held only in tab memory. It does not retain credentials or
message text. The active conversation still has its existing full metadata map.
The destination snapshot is taken before admitting the departed page, preventing
incorrect eviction on return to the oldest retained conversation.

The response guard now recognizes both singular and plural conversation-ID URL
paths, so background requests for another conversation cannot modify the active
map. A credentials-only direct request was not used to obtain authenticated
metadata: the live independent check observes clones of normal application
responses and retains only message ID, role and concrete model for comparison.

Chromium and Firefox each pass 62 scenarios / 232 checks, including negative
cache-eviction, revisit and background-plural-response tests. Installed 0.7.3 real
acceptance is pending at this checkpoint.

## Final installed home acceptance

The existing Chrome Google sign-in succeeded. The fixed script was installed
through Tampermonkey's normal update confirmation, not pasted into the webpage.
Chrome's per-extension Allow User Scripts setting and Tampermonkey's separate
master switch had both been disabled and were enabled for this test/install.

Two real conversations were tested. One had two completed assistant replies with
concrete models `gpt-6-thinking` and `gpt-5-6-thinking`; both labels were 768 CSS px
wide and about 15.4 px high, outside the sr-only heading. The other had three
completed replies; all three exact assistant IDs and concrete `gpt-6-pro` values
were independently compared with metadata from cloned normal application JSON
responses. No request credentials or conversation text were exported.

Navigation to the other chat and back retained the correct models and showed only
the active page's labels, despite hidden cached conversation DOMs still existing.
First → last → first scrolling checked exact focused-ID equality, readable width,
viewport position, exclusion from sr-only, and center-point hit testing: passed.
After a full reload, the independent observer was absent and all these checks
passed again on the installed 0.7.3 script. This separates real installation
acceptance from temporary diagnostic instrumentation.

[Structured acceptance receipt](route-ui-home-20261008-results.json). Synthetic
regression is additionally 62 scenarios / 232 checks in each of Chromium/Firefox;
it is not substituted for the real checks above. Company-side revalidation remains
a separate environment; use 0.7.3 rather than the unsuccessful 0.7.1.

## Cleanup

The original ZeroOmega **acgpower** profile was restored after testing. Its toolbar
again identified the localhost:8123 PAC configuration. The task-owned test window
was closed, and the original Chrome window and PID were verified still present;
no browser restart or user-tab closure occurred. The normal Google login and the
installed/enabled 0.7.3 script remain available. Testing submitted no new ChatGPT
prompt. The native inline-label crop was visually reviewed; only that crop is used
as screenshot evidence, not the rejected floating crop or any full private page.
