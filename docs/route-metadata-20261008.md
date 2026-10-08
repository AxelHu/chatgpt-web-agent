# Metadata acquisition race — 0.7.4

## Actual observations

The user reported visible labels stuck at `0/0 assistant models known` and one
unmatched ID, with some conversations working and others slow. The screenshot's
conversation loaded four completed reply labels after a fresh home Chrome load;
that does not dismiss a stale/missing record in an already-open tab.

A live passive trace found that the app successfully consumes the conversation
response with `Response.text()`. The response was about 2.06 MB in that trace. It
then aborts its fetch controller as cleanup. Measured body completion and abort
were separated by roughly 7–11 ms. A parallel `Response.clone().json()` reader
lost the race: **26 AbortErrors and zero successful clone JSON parses** in the
recorded sample, despite successful primary app reads. Old script code swallowed
these errors, leaving an unmatched DOM message ID with no explanation.

The normal app endpoint is plural `/backend-api/conversations/<id>` with app
authentication. The old script's two singular cookie-only fallback endpoints
were independently recorded returning 404; a direct cookie-only plural request
returned 401. Merely retrying or changing the spelling does not provide a valid
fallback. No tokens are extracted/replayed by this fix.

These observations demonstrate a concrete script acquisition defect and explain
intermittent/stuck metadata depending on response-consumption timing. They do not
prove that every previously reported unknown label has this single cause.

## Fix

Observe successful `Response.json()` and `Response.text()` consumption on the
exact same-origin conversation response before returning the **unchanged** object
or string to the app. This also covers a native fetch reference saved before the
userscript. Filter by exact current conversation ID and navigation epoch; permit
only the verified single transition for a navigation loader's destination.

The script does not collect auth headers, read cookies, replay signed requests,
change app request bodies, or store reply text. Route metadata remains local tab
memory. JSON cloning is deferred and skipped when the primary consumer has already
started, avoiding an unnecessary full parallel body tee for the normal app path.
SSE observation remains unchanged.

Legacy fallback is now bounded and single-flight, with an 8-second timeout. It
runs only for missing metadata, stops for unsupported endpoints or auth refusal,
and makes at most three attempts per navigation. No guessed plural auth request
is added. Diagnostics expose primary-read count, source and fallback status.
The zero-match label now says it is waiting for assistant metadata rather than
implying that the assistant has no model.

## Validation

Both Chromium and Firefox pass **72 scenarios / 268 checks**. New fixtures include
primary json/text success with an aborted duplicate, saved-native-fetch reading,
unchanged text bytes, native rejection equivalence, late/different-conversation
isolation, navigation-loader ordering, and suppression of repeated 404/401 or idle
fallback traffic. All previous visibility, cache, identity and SSE cases remain.

Installed home acceptance of 0.7.4 is recorded below.
See the accompanying JSON receipt for sanitized timing and test evidence.

## Browser API references

- https://developer.mozilla.org/en-US/docs/Web/API/Response/clone
- https://developer.mozilla.org/en-US/docs/Web/API/AbortController/abort
- https://developer.mozilla.org/en-US/docs/Web/API/Response/text

## Installed home Chrome result

Updated the existing Tampermonkey script normally to 0.7.4, then loaded the same
conversation shown in the screenshot. No temporary metadata observer remained in
that document. Four completed assistant replies had readable, exactly matched
labels and no unmatched IDs. Primary consumption count rose from 1 to 7 through
normal app polling, with zero primary read errors, zero cloned reads, and no
fallback requests needed. Route records rose from 574 to 579 as metadata updated.
The recorded source was `page response.text()` throughout this check.

This validates the fix on real current-page traffic, not only a synthetic DOM.
It does not claim every company-side conversation has been retested or that a
not-yet-returned model field can be shown instantly. The tool-submission/current
turn was not forced to complete and no additional ChatGPT prompt was sent.

Original ACGPower proxy was restored, the task-owned test window was closed, and
the original Chrome process and user window remained present. The normally
installed/enabled 0.7.4 script remains on the home Chrome profile.
