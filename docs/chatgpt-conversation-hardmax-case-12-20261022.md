# Case #12 — GPT-6 Pro / Astra Pro tool-heavy conversation hard max (2026-10-22)

## Classification

- Public share: `https://chatgpt.com/share/6ad98c94-2040-83e8-a504-47a5a1bf864e`
- Backing conversation: `6ad7707f-6e30-83e8-85c2-06bb356e54ca`
- Title: `放置增量开发`
- Default serialized model profile: `gpt-6-pro` (GPT-6 Pro / Astra Pro in the product UI)
- User-observed terminal condition: explicit conversation maximum / a new chat was required.

The public share does not contain the product warning itself. Consistent with the previously reproduced rollback/share behavior, this report treats the share as the last publicly shareable persisted checkpoint and therefore as a **pre-limit lower bound**, not the exact rejected over-limit state.

This is the first new local hard-max sample after issue #19 was closed for on-demand monitoring on 2026-10-16. It directly disproves the stronger interpretation that the newer Astra-era persistence/load improvements removed the conversation-level hard maximum.

There is also a notable rollout correlation. OpenAI's 2026-10-16 ChatGPT release notes describe a GPT-6 Pro Chat update with improved plugin/tool use and multiple agents working on different parts of a task in parallel. This conversation began on 2026-10-19 and hit hard max on 2026-10-22, after roughly 46 days without a newly recorded local hard-max sample. The timing and the unusually high per-turn internal density justify tracking a **suspected orchestration-era regression in state-consumption rate**. They do **not** establish that OpenAI lowered the underlying numeric hard cap: the same observations can be explained by newer orchestration persisting more tool, subagent and continuation state per visible turn.

## Exact public checkpoint

Measured with `scripts/analyze-chatgpt-share.py` and `o200k_base`:

| Metric | Case #12 |
|---|---:|
| Linear conversation nodes | **6,218** |
| Message nodes | **6,217** |
| Real user-authored messages | **30** |
| Distinct turn exchanges | **34** |
| Assistant → tool calls | **2,574** |
| Tool-result nodes | **3,077** |
| Public-share redacted assistant/tool nodes | **4,539** |
| Identifiable model continuations | **1,686** |
| Share-visible unique text | **150,872 tokens** |
| Real-user text | **6,274 tokens** |
| Visible assistant content excluding redaction placeholders | **95,261 tokens** |
| Visible-prefix input-equivalent over continuations | **134,743,730 tokens** |
| Turn-start-only visible-history replay | **2,564,286 tokens** |
| Flattened share payload | **7,061,948 bytes** |
| Share HTML | **8,441,642 bytes** |

Role counts in the persisted share branch:

- assistant: 3,058
- tool: 3,077
- system: 45
- user-role nodes: 37 (30 are real user-authored messages; the remainder include synthetic/bootstrap context)

The represented conversation lifetime is only **66.84 hours**:

- first persisted timestamp: 2026-10-19 17:04:21 +08:00
- last public-share node: 2026-10-22 11:54:39 +08:00
- share created: 2026-10-22 12:09:56 +08:00

Calendar age is therefore a poor risk indicator. A sufficiently dense agentic workflow can still consume the conversation budget in under three days.

## Terminal sequence and live read-only evidence

### Last public turn

The last real user request begins at public node position 6,142:

> 继续完成前面回合的任务

Its persisted public segment contains:

- 76 nodes
- 34 top-level tool calls
- 30 tool-result nodes
- approximately 827 seconds of observed timestamps
- no normal final response

The public branch ends on an assistant tool-call node at 11:54:39 +08:00.

### Cloud state after the share

A later read-only Desktop bridge check found that the cloud persisted branch had accepted **one additional tool-result node** at 11:55:37 +08:00. It still had:

- no terminal message ID;
- no terminal receipt;
- `outcome = unknown`;
- renderer status `idle`;
- a mismatch between the cloud current node and the native renderer current node.

The bridge classified this as `transport_or_sync_unknown` with `terminal_receipt_missing` and `current_node_mismatch`. No send/reconcile probe was attempted.

This evidence is compatible with an already stopped, non-terminally persisted turn and a renderer/cloud projection mismatch. It is not evidence that the assistant was still computing in the background.

### Earlier near-limit degradation

The immediately preceding exchanges are also abnormal:

- exchange #32: 713 nodes / 347 calls / 347 results, no normal final;
- exchange #33: a five-node continuation with no normal final, carrying a persisted `finished_duration_sec = 6672` summary marker;
- exchange #34: the final 76-node segment above, again without a normal final.

The last ordinary final-text completion predates these exchanges. This does not prove that exchange #32 itself crossed the hard limit, but it is strong evidence that **unfinished/no-final heavy turns can precede the explicit next-send maximum warning**.

## Comparison with prior controls and hard-max cases

| Sample | Status | Nodes | Calls | Tool results | Redacted | Continuations | Visible tokens | Prefix-equivalent |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Case #7, GPT-5.6 Pro | hard max | 6,085 | 1,932 | 3,105 | 4,763 | 1,709 | 162,053 | 177.6M |
| Case #8, GPT-5.6 Pro successor | hard max | 4,017 | 1,588 | 1,730 | 3,006 | 1,485 | 115,393 | 82.0M |
| Mixed GPT-5.6 Pro → GPT-6 Pro | hard max | 6,238 | 1,505 | 3,310 | 4,177 | 1,149 | 273,186 | 129.8M |
| Case #11, GPT-6/Astra | **non-max control** | 4,024 | 725 | 2,628 | 3,103 | 544 | ~113,800 | ~23.3M |
| **Case #12, GPT-6/Astra** | **hard max** | **6,218** | **2,574** | **3,077** | **4,539** | **1,686** | **150,872** | **134.7M** |

Case #12 is especially informative:

1. Its node count is almost identical to the mixed Pro hard-max case (6,218 vs. 6,238), while its public flattened payload is about 15% smaller and its call/continuation shape is very different.
2. Its tool-result count is close to Case #7 (3,077 vs. 3,105), and its continuation count is also close (1,686 vs. 1,709), but Case #8 and the mixed case prove that neither is a universal hard counter.
3. Compared with the non-max Astra Case #11, Case #12 has +54.5% nodes, +255% top-level calls, +17.1% tool results, +46.3% redacted items, +209.9% continuations, and roughly +478% visible-prefix replay traffic.
4. The 2,574 top-level tool calls are the highest count in the recorded local cases. The newer orchestration can clearly survive well beyond the old ~1.7k-call danger cluster, but it remains finite.

## Updated inference

The best-fit model remains a hidden **per-conversation persisted/composite-state budget**. Likely contributors include:

- persisted assistant intermediate items;
- tool calls and tool-result payloads;
- orchestration/continuation metadata;
- summaries or compacted context state not exposed in the public share;
- branch and delivery metadata;
- average logical weight of each item, which varies by model/runtime/workload.

The following simple hypotheses are still rejected:

- fixed visible user-turn count;
- fixed public node count;
- fixed tool-call count;
- fixed continuation count;
- fixed public share/HTML byte size;
- fixed gross visible-token count;
- fixed per-turn duration;
- budget reset after switching selected models.

The three Pro-heavy hard-max samples at roughly 6.1k–6.24k public nodes form a useful operational cluster, but Case #8 at only 4,017 nodes prevents treating 6.2k as the product limit. Public counters are workload-dependent proxies for an unexported state budget.

## Revised operational handoff policy

No single counter should trigger or suppress a handoff. For current high-tool-density GPT-6 Pro/Astra development/research chats, use a composite rule.

### Proactive checkpoint / yellow zone

Checkpoint the repository, issue state, current deliverable and next action, then plan a successor chat when **any two** of the following are observed:

- public/analyzer branch reaches roughly 4,500–5,000 nodes;
- identifiable continuations reach roughly 1,250–1,350;
- redacted assistant/tool items reach roughly 3,400–3,600;
- top-level tool calls reach roughly 1,900–2,100;
- one exchange exceeds about 500 nodes or 250 tool calls;
- a heavy exchange stops without a normal final response.

These numerical bands are approximately 75–80% of Case #12 and are only empirical workload-specific safety margins.

### Immediate handoff / red zone

Do not continue loading more project state into the same conversation when any of these occurs:

- branch exceeds roughly 5,500 nodes;
- continuations exceed roughly 1,500;
- repeated `继续` requests follow an unfinished/no-final exchange;
- Web UI remains loading while a read-only backend/Desktop projection is idle;
- terminal receipt is missing together with cloud/renderer current-node mismatch;
- the product shows the explicit maximum-length notice.

Symptoms override counters. Case #8 demonstrates that payload-heavy conversations can hit the underlying state budget well below the typical node cluster.

### Measurement limitation

Desktop/native projections are not interchangeable with public-share structure. For this sample:

- public share: 6,217 message nodes;
- Desktop bridge `total_messages`: 4,289;
- native-renderer visible projection: 809 messages.

Those surfaces apply different filtering/projection rules. A future proactive warning must count a stable persisted representation or expose a deliberately calibrated risk metric; it must not compare `total_messages` directly with share-node thresholds.

## Official product context

OpenAI's release notes document infrastructure changes that improve long-chat reliability and loading:

- 2026-02-13: reduced interruption rates in longer Thinking chats;
- 2026-08-21: long web conversations load messages in smaller sections rather than retrieving the entire conversation at once.

These are real improvements, but neither release note states that the per-conversation hard maximum was removed or gives a numeric hard threshold. The current official model/usage-limit documentation likewise describes plan/model allowances rather than a numeric lifetime capacity for one ordinary text conversation.

References:

- `https://help.openai.com/en/articles/6825453-chatgpt-release-notes`
- `https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt`

The 2026-10-16 release-note entry is the relevant orchestration change: improved use of plugins/tools and parallel multiple-agent work in GPT-6 Pro Chat.

## Reproduction / evidence commands

```bash
PYTHONPATH=/tmp/chatgpt-share-tiktoken \
  python3 scripts/analyze-chatgpt-share.py --json \
  'https://chatgpt.com/share/6ad98c94-2040-83e8-a504-47a5a1bf864e'
```

The public token metrics are lower bounds because 4,539 of the heaviest assistant/tool nodes are represented only by redaction placeholders. The exact backend persistence representation, compaction policy and rejected over-limit transient state remain unavailable.
