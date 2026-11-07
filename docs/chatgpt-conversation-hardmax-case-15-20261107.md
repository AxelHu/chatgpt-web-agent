# Case #15 — pure GPT-6 Pro / Astra new-orchestration hard max after five giant turns (2026-11-07)

## Classification

- Public share: `https://chatgpt.com/share/6aee79e2-7b30-83e8-a4e7-a077d62df1a4`
- Backing conversation: `6aeca1eb-436c-83e8-959e-0630bf8b5b67`
- Title: `继续复活阿斯塔塔`
- Default model: `gpt-6-pro`
- User classification: supplied as a new conversation-hard-max case
- Repository classification: **user-reported hard max; exact product banner not captured in this investigation**

The share and cloud evidence strongly establish an exhausted, non-terminal conversation, but this case does not include a screenshot of the exact product error. It is therefore not labeled “explicit-banner confirmed” in the narrower Case #14 sense.

This case is uniquely valuable because it is a nearly pure sample of the current GPT-6 Pro/Astra multi-agent orchestration. Every persisted node that exposes a model identity is `gpt-6-pro`; no GPT-5.6 or GPT-5.4 route appears anywhere in the share.

## Public-share ingestion change

The ordinary share HTML route initially returned HTTP 503 and later returned a newer HTML format without the former flattened React Router payload. The public endpoint:

`https://chatgpt.com/backend-api/share/6aee79e2-7b30-83e8-a4e7-a077d62df1a4`

returned the complete canonical conversation JSON successfully.

`scripts/analyze-chatgpt-share.py` was updated in the same delivery to support:

- the existing flattened share HTML / flattened JSON representation;
- canonical public share JSON files;
- automatic fallback from a public share URL to `backend-api/share` when the HTML route fails or no longer contains the flattened payload.

The new canonical parser was cross-checked against Case #14 and reproduced its structural metrics exactly: 5,097 nodes, 2,224 serialized call nodes, 2,359 tool results, 3,495 redacted nodes, and 1,226 identifiable continuations.

## Exact canonical checkpoint

Measured with the updated analyzer and `o200k_base`:

| Metric | Case #15 |
|---|---:|
| Linear conversation nodes | **6,993** |
| Message nodes | **6,992** |
| Real user-authored messages | **5** |
| Distinct turn exchanges | **5** |
| Serialized assistant → tool-call nodes | **2,753** |
| Tool-result nodes | **2,116** |
| Public-share redacted assistant/tool nodes | **4,230** |
| Identifiable model continuations | **1,858** |
| Share-visible unique text | **101,103 tokens** |
| Real-user text | **96 tokens** |
| Visible assistant content excluding redaction placeholders | **62,937 tokens** |
| Visible-prefix input-equivalent over continuations | **87,350,959 tokens** |
| Turn-start-only visible-history replay | **150,536 tokens** |
| Canonical public share JSON | **17,589,871 bytes** |
| Mapping branches | **0** |

Role counts:

- assistant: 4,871
- tool: 2,116
- user: 5

There are no separate system-role nodes in this serialization. Each turn includes a visually hidden `model_editable_context` item instead.

## Pure GPT-6 Pro / Astra evidence

Across the complete public branch:

- **2,749 nodes expose `model_slug = gpt-6-pro`;**
- **4,243 nodes expose no model slug**, overwhelmingly redacted wrapper/tool items;
- **zero nodes expose GPT-5.6, GPT-5.4, or another model.**

All five turn exchanges are GPT-6 Pro-dominant. This is not a mixed-route sample and gives the cleanest evidence so far that the current orchestration alone can rapidly consume the conversation lifetime.

## New-orchestration shape

The public state contains explicit multi-agent activity items:

| Persisted orchestration item | Count |
|---|---:|
| `SubAgentActivityThreadItem.started` | **7** |
| `SubAgentActivityThreadItem.interacted` | **511** |
| `SubAgentActivityThreadItem.completed` | **91** |
| Total subagent activity items | **609** |
| `CollabAgentToolCallThreadItem.wait` | **28** |
| Unique subagent thread IDs | **10** |
| Unique persisted agent paths | **10** |

The ten persisted agent paths include account/release review, roster restoration, equipment inspection, load-harness audit, quest/flying audit, story acceptance, process-handle preservation, post-full review, story commit review, and weapon-state audit.

The share also contains:

- 2,114 assistant `api_tool.call_tool` items;
- 2,112 corresponding tool-result items named `api_tool.call_tool`;
- 2 assistant `web.run` calls and 4 web result items.

Serialized call-node counts are persistence proxies, not independent external-command counts. The current orchestration can write wrapper, inner call, activity and result items separately.

## Five turns consumed the conversation

| Turn | User prompt | Nodes | Call nodes | Tool results | Subagent activity | Observed span | Normal final |
|---:|---|---:|---:|---:|---:|---:|---|
| 1 | initial handoff / continue revival | 661 | 289 | 235 | 55 | 4,158.8 s (~69m19s) | no |
| 2 | `继续完成任务` | 1,467 | 551 | 449 | 101 | 12,594.4 s (~3h29m54s) | no |
| 3 | `继续完成任务` | 1,573 | 593 | 461 | 132 | 14,793.3 s (~4h06m33s) | no |
| 4 | `继续完成任务` | 179 | 72 | 52 | 20 | 1,863.0 s (~31m03s) | no |
| 5 | `继续完成任务` | **3,112** | **1,248** | **919** | **301** | **29,609.6 s (~8h13m30s)** | no |

Turn-density summary:

- mean: **1,398.4 nodes / 550.6 serialized calls per turn**;
- median: **1,467 nodes / 551 calls**;
- maximum: **3,112 nodes / 1,248 calls**.

The five real user prompts contain only **96 o200k tokens** in total. Visible turn count and human prompt volume are therefore effectively useless predictors for current high-intensity Astra orchestration.

## No normal final in the whole conversation

The public branch contains **zero normal final responses**.

Two turns end with a `reasoning_recap` item whose content is `已停止思考`:

- turn 2 at 2026-11-06 12:20:55 +08:00;
- turn 3 at 2026-11-06 16:28:23 +08:00.

Three stale `in_progress` items also remain embedded in the persisted tree. Other turns simply stop on commentary, tool work or a tool-call boundary without a final.

This is materially different from older samples where heavy turns often produced normal finals and only the final one or two exchanges degraded. In Case #15, every visible user exchange is a large retained no-final attempt.

## Lifetime

The persisted branch covers only **30.52 hours**:

- first persisted node: **2026-11-05 23:35:36 +08:00**;
- last public-share node: **2026-11-07 06:06:50 +08:00**;
- share created: **2026-11-07 09:07:47 +08:00**;
- share created about **3h00m57s** after the last public node.

The elapsed wall span includes idle gaps between user prompts. Calendar age again has little predictive value: the conversation reached this state after only five user turns and about one and a quarter days of persisted activity.

## Public tail and fresh cloud evidence

The public share ends on an assistant → `api_tool.call_tool` call at **2026-11-07 06:06:50 +08:00**. That call has no result in the public snapshot and there is no normal terminal message.

A fresh read-only Desktop bridge observation found that the backing cloud branch accepted one additional tool result at **06:06:51 +08:00**:

- public current node: `96c21a9c-7f19-59a7-8d05-9e857acfadd9` (assistant call);
- cloud current node: `41d7169d-de55-56ef-b338-87d72d93d26f` (its tool result);
- terminal message ID: absent;
- terminal receipt: absent;
- persisted outcome: `unknown`;
- server-side in-progress: `false`;
- bridge diagnosis: `transport_or_sync_unknown` / `terminal_receipt_missing`;
- native renderer evidence was unavailable because the conversation was not loaded.

No probe message, retry, forced reconciliation or node rewrite was performed.

The live Desktop projection reported 6,988 messages while the public canonical share contains 6,992 message nodes. These are different projections and must not be used as interchangeable counters.

## Same-format comparison

The following values were recomputed from each case's canonical public `backend-api/share` JSON with the same analyzer version:

| Sample | Status | Nodes | Call nodes | Results | Redacted | Continuations | Users / turns | Visible tokens | Prefix-equivalent | Canonical JSON |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Case #11, GPT-6/Astra | non-max control | 4,024 | 725 | 2,628 | 3,103 | 544 | 46 / 47 | 112.2K | 22.9M | 9.81 MB |
| Case #12, GPT-6/Astra | hard max | 6,218 | 2,574 | 3,077 | 4,539 | 1,686 | 30 / 34 | 149.6K | 133.6M | 14.38 MB |
| Case #13, mixed Pro | probable max | 5,599 | 3,202 | 2,124 | 4,222 | 1,098 | 35 / 35 | 172.3K | 86.3M | 11.91 MB |
| Case #14, GPT-6 Pro | confirmed hard max | 5,097 | 2,224 | 2,359 | 3,495 | 1,226 | 33 / 33 | 113.6K | 87.6M | 12.32 MB |
| Mixed GPT-5.6 Pro → GPT-6 Pro | hard max | 6,238 | 1,505 | 3,310 | 4,177 | 1,149 | 41 / 41 | 257.0K | 120.7M | 16.56 MB |
| **Case #15, pure new orchestration** | **user-reported hard max** | **6,993** | **2,753** | **2,116** | **4,230** | **1,858** | **5 / 5** | **101.1K** | **87.4M** | **17.59 MB** |

Case #15 is the highest recorded public checkpoint in this comparison for:

- total nodes;
- identifiable continuations;
- canonical public JSON bytes.

Its serialized call count is second only to Case #13.

### Compared with Case #12

Case #15 has:

- +12.5% nodes;
- +7.0% serialized call nodes;
- **31.2% fewer tool-result nodes**;
- 6.8% fewer redacted nodes;
- +10.2% continuations;
- **34.6% less visible-prefix replay traffic**;
- +22.3% canonical public JSON bytes;
- 83.3% fewer real user messages.

The conversation can therefore hold more persisted items and bytes while replaying materially less visible text. Gross input traffic is not the limiting counter.

### Compared with Case #13

Case #15 has nearly the same prefix-input proxy (+1.2%) and almost the same number of redacted items (+0.2%), but:

- +24.9% nodes;
- +69.2% continuations;
- +47.8% canonical public JSON bytes;
- 85.7% fewer user turns.

This again points to item composition and orchestration metadata rather than any single public token or event count.

### Compared with the non-max Astra control

Case #15 has:

- +73.8% nodes;
- +279.7% serialized call nodes;
- +36.3% redacted items;
- +241.5% continuations;
- +281.0% visible-prefix replay traffic;
- +79.2% canonical public JSON bytes;
- **89.1% fewer real user messages**.

The healthy control did more visible conversational turns, while Case #15 generated far more persistent internal state through the new orchestration.

## Updated inference

Case #15 is strong evidence for the following narrower claim:

> The current GPT-6 Pro/Astra multi-agent orchestration can consume the existing per-conversation persisted/composite-state budget much faster per visible user turn than prior Chat orchestration.

It does **not** prove that OpenAI numerically lowered the underlying hard cap. The same observations are explained if the cap stayed similar while each new-orchestration turn persisted many more:

- subagent activity events;
- wrapper and inner tool-call items;
- tool results;
- orchestration waits and bookkeeping;
- assistant intermediate messages and summaries.

This sample also rules out several alternative explanations:

- model fallback is not required;
- branching/retry explosion is not required (the mapping is completely linear);
- long visible prose is not required;
- many user messages are not required;
- a normal final is not required for substantial state to be retained.

## Operational policy for new orchestration

The old “wait until 4.5–5K nodes” safety rule is too late for a single turn capable of adding 3,112 nodes.

For current multi-agent Astra development/research chats:

1. **Any turn exceeding roughly 1,000 nodes or 500 serialized call nodes must be followed by a durable checkpoint and successor-chat decision before another `继续`.**
2. **Two consecutive no-final turns are sufficient to hand off.** Case #15 continued through five and accumulated 6,993 nodes.
3. Treat `已停止思考`, silent termination, or terminal-receipt absence as retained state consumption, not as a free/rolled-back turn.
4. Monitor explicit subagent activity and per-turn state delta, not visible turn count or calendar age.
5. Preserve Git, tests, issue state and the next concrete action outside Chat after each giant turn. The practical risk is forced handoff and incomplete terminal reporting, even when unified Chat quota makes model-specific allowance planning less important.

## Evidence and reproduction

```bash
PYTHONNOUSERSITE=1 PYTHONPATH=/tmp/case15-tiktoken \
  python3 scripts/analyze-chatgpt-share.py --json \
  'https://chatgpt.com/share/6aee79e2-7b30-83e8-a4e7-a077d62df1a4'
```

The public share redacts 4,230 assistant/tool nodes. All token and byte measures remain public lower-bound/proxy metrics rather than the backend's actual persisted-state accounting.
