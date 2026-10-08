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
