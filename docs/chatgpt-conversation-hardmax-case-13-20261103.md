# Case #13 — mixed GPT-5.6 Pro / GPT-6 Pro conversation becomes read-only (2026-11-03)

## Classification

- Public share: `https://chatgpt.com/share/6ae9b554-5a6c-83e8-8e42-b777ef60cb69`
- Backing conversation: `6ae3060e-fb14-83e8-940c-d543585dca2a`
- Title: `分析UDG卡牌对战缺口`
- Serialized default model: `gpt-6-pro`
- User-observed terminal behavior: the **original backing conversation** is displayed as read-only and no longer accepts new messages.
- Classification: **high-confidence probable conversation hard max**, but not promoted to “explicit-banner confirmed” because no screenshot or persisted node contains the exact maximum-length wording.

The public share itself is always read-only and therefore is not evidence. The classification relies on the user's observation of the original backing chat, together with its size, terminal shape, and current native/cloud error state.

Current official OpenAI help now describes a full chat in almost exactly this shape: a few long exchanges can consume more room than many short exchanges; the limit applies to that conversation; the user can still read earlier messages even when another message can no longer be sent. The help page does not publish a fixed per-chat message count.

References:

- `https://help.openai.com/en/articles/9275245-chatgpt-free-tier-faq` (sections “Why does ChatGPT say my chat is full?” and “Can I still read my original chat?”)
- `https://community.openai.com/t/chatgpt-plus-conversations-reaching-maximum-length-unusually-fast-across-multiple-new-chats/1396609` (community reports of maximum-length chats becoming permanently read-only; not an official root-cause source)

## Exact public checkpoint

Measured with the existing `scripts/analyze-chatgpt-share.py` and a clean `o200k_base` tokenizer environment:

| Metric | Case #13 |
|---|---:|
| Linear conversation nodes | **5,599** |
| Message nodes | **5,598** |
| Real user-authored messages | **35** |
| Distinct turn exchanges | **35** |
| Serialized assistant → tool-call nodes | **3,202** |
| Tool-result nodes | **2,124** |
| Public-share redacted assistant/tool nodes | **4,222** |
| Identifiable model continuations | **1,098** |
| Share-visible unique text | **172,588 tokens** |
| Real-user text | **1,834 tokens** |
| Visible assistant content excluding redaction placeholders | **52,908 tokens** |
| Visible-prefix input-equivalent over continuations | **86,524,582 tokens** |
| Turn-start-only visible-history replay | **2,882,648 tokens** |
| Flattened share payload | **5,871,580 bytes** |
| Share HTML | **7,123,981 bytes** |
| Mapping branches | **0** |

Role counts:

- assistant: 3,374
- tool: 2,124
- system: 64
- user-role nodes: 36 (35 real user messages plus one bootstrap/custom-instruction placeholder)

### Important counting caveat

The new orchestration serializes nested wrapper and inner tool-call items separately. For example, the share contains both `api_tool.call_tool` and `functions.exec` call/result layers. Therefore **3,202 is a serialized call-node count, not a claim that 3,202 independent external commands ran**. It remains useful as a same-parser persistence proxy because every serialized item consumes conversation state.

## Lifetime and model phases

The persisted branch covers only about **120.28 hours / 5.01 days**:

- first persisted timestamp: 2026-10-29 16:38:39 +08:00
- last public-share node: 2026-11-03 16:55:40 +08:00
- share created: 2026-11-03 18:20:05 +08:00

Model routing by turn:

- turn 1: GPT-6 Pro
- turns 2–6: GPT-5.6 Pro
- turns 7–9: GPT-6 Pro
- turns 10–26: GPT-5.6 Pro
- turns 27–35: GPT-6 Pro

Aggregated serialized activity:

| Phase | Turns | Nodes | Call nodes | Tool results | Finished turns | Exposed finished duration |
|---|---:|---:|---:|---:|---:|---:|
| GPT-5.6 Pro-dominant | 22 | 2,536 | 1,630 | 780 | 18 | 49,831 s (~13.84 h) |
| GPT-6 Pro-dominant | 13 | 3,062 | 1,572 | 1,344 | 7 | 17,544 s (~4.87 h) |

This is another within-conversation confirmation that switching model profiles does not reset the conversation-level lifetime. The final GPT-6 Pro phase continued on top of the earlier GPT-5.6 Pro state until the chat became read-only.

## Terminal sequence

The last normal final response was persisted at **2026-11-03 07:00:29 +08:00**, at public node position 4,907.

After that final, the branch accumulated **691 additional nodes** across three user exchanges without another normal final:

- 3 user nodes
- 8 system/context nodes
- 353 assistant nodes
- 327 tool-result nodes
- 331 serialized assistant→tool call nodes

The three exchanges were:

1. `那现在又到了tempo和control提升的时候了，继续吧`
   - 493 nodes / 239 call nodes / 236 tool results / no final
2. `继续完成任务`
   - 190 nodes / 90 call nodes / 90 tool results / no final
3. `继续完成任务`
   - 8 nodes / 2 call nodes / 1 tool result / no final

The final public branch ends on a successful tool-result node. It has no final message, no reasoning end, and no terminal receipt.

This is stronger than a single orphaned call: the conversation retained substantial work across **three consecutive no-final exchanges**, then the original UI became read-only.

## Read-only native/cloud evidence

A fresh read-only Desktop bridge observation of the backing conversation found:

- cloud persisted current node: `0a39e9f4-aad0-4586-9d81-aaf8c0c9f6d6`
- terminal message ID: absent
- terminal receipt: absent
- persisted outcome: `unknown`
- server-side in-progress: `false`
- native renderer state: `error`
- native renderer current node: `e859dd51-86c5-47fc-a065-81b0def29f4c`
- cloud/native current-node mismatch
- bridge diagnosis: `transport_or_sync_unknown` / `terminal_receipt_missing`

The bridge did not submit a probe, retry, reconcile, or new message. The evidence says the old execution is not server-side active, but its terminal state is not cleanly represented and the native renderer is on a different error node.

This pattern is compatible with a rejected/read-only terminal state that is not part of the shareable canonical branch. It is not, by itself, a cryptographic proof that the product counter was specifically the conversation-length counter; that final classification additionally uses the user's observed read-only original chat and the official “full chat remains readable but not sendable” behavior.

## Comparison with representative cases

| Sample | Status | Nodes | Call nodes | Tool results | Redacted | Continuations | Visible tokens | Prefix-equivalent | Flat payload |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Case #11, GPT-6/Astra | non-max control | 4,024 | 725 | 2,628 | 3,103 | 544 | ~113.8K | ~23.3M | 4.76 MB |
| Mixed GPT-5.6 Pro → GPT-6 Pro | explicit hard max | 6,238 | 1,505 | 3,310 | 4,177 | 1,149 | 273.2K | 129.8M | 8.30 MB |
| Case #12, GPT-6/Astra | explicit hard max | 6,218 | 2,574 | 3,077 | 4,539 | 1,686 | 150.9K | 134.7M | 7.06 MB |
| **Case #13, mixed Pro** | **read-only / probable hard max** | **5,599** | **3,202** | **2,124** | **4,222** | **1,098** | **172.6K** | **86.5M** | **5.87 MB** |

### What this case changes

Compared with Case #12, Case #13 reaches the read-only condition with:

- 10.0% fewer nodes;
- 24.4% more serialized call nodes;
- 31.0% fewer tool-result nodes;
- 7.0% fewer redacted nodes;
- 34.9% fewer identifiable continuations;
- 35.8% less visible-prefix replay traffic;
- 16.9% smaller public flattened payload.

Compared with the non-max Astra Case #11, Case #13 has:

- +39.1% nodes;
- +341.7% serialized call nodes;
- **19.2% fewer tool-result nodes**;
- +36.1% redacted items;
- +101.8% continuations;
- +271.4% visible-prefix replay traffic.

The fact that a maxed/read-only case can have fewer tool-result nodes than a healthy control is especially useful: raw result count is not the hidden budget. Item composition and payload weight matter.

## Updated interpretation

Case #13 supports the same best-fit model:

> ChatGPT maintains an unexported per-conversation persisted/composite-state budget. Public nodes, call items, results, continuations, visible tokens and share bytes are workload-dependent proxies rather than the governing counter.

This case additionally strengthens four points:

1. **Read-only is now an important terminal symptom.** OpenAI's current help says a full chat remains readable while it no longer accepts messages. An explicit maximum banner is useful evidence, but no longer required to classify a sufficiently heavy original chat as probable hard max when the original is demonstrably read-only.
2. **No-final tails are dangerous.** Three no-final exchanges added 691 nodes after the last normal final. Repeated fresh-turn continuation preserves useful local work, but it also preserves and adds conversation state.
3. **Branch explosion is not required.** The public mapping is purely linear with zero branching nodes.
4. **Quota unification does not remove the engineering problem.** Even if per-model Chat quota accounting matters less, hard max still causes read-only lockout, missing final/terminal records and forced handoff.

## Operational update

For tool-heavy development/research chats, the most actionable trigger remains behavioral rather than numerical:

- one heavy no-final exchange: checkpoint immediately;
- a second consecutive no-final exchange: start a successor chat rather than sending another `继续`;
- native `error` plus server-side not-in-progress plus terminal-receipt/current-node mismatch: treat the old chat as terminally unreliable;
- original chat becomes read-only: classify as probable hard max unless another product-specific reason is established.

The previous numeric yellow/red bands remain useful only as supporting evidence. Case #13 again shows that one conversation can reach the terminal condition below Case #12 on most public counters.

## Evidence command

```bash
PYTHONNOUSERSITE=1 PYTHONPATH=/tmp/case13-tiktoken \
  python3 scripts/analyze-chatgpt-share.py --json \
  'https://chatgpt.com/share/6ae9b554-5a6c-83e8-8e42-b777ef60cb69?ogimg=plain'
```

The 4,222 redacted assistant/tool nodes make all public token and byte figures lower-bound proxies. The exact rejected/read-only UI state and hidden backend record are not exported by the share.
