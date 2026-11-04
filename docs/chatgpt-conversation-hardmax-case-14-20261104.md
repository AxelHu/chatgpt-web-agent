# Case #14 — explicit GPT-6 Pro hard max with screenshot-confirmed admission rejection (2026-11-04)

## Classification

- Public share: `https://chatgpt.com/share/6aea9d61-3518-83e8-ba51-22450fc1da97`
- Backing conversation: `6acb3b27-ca14-83e8-92be-c7cb5022aa0b`
- Title: `继续开发Keyforge`
- Serialized model profile: `gpt-6-pro` for all 33 turn exchanges
- Classification: **confirmed conversation hard max**

The user captured the original backing conversation before refreshing. The screenshot address bar shows the same backing ID as the public share, and the product displays the exact error:

> `The conversation is too long, please start a new one.`

The rejected user message visible immediately above the error is:

> `继续完成任务`

After refresh, the user created the public share. That rejected message is absent from the share; the share ends at the previous partial assistant/tool turn. This is a direct within-case before/after confirmation that the over-limit admission attempt was transient and was not committed to the canonical conversation tree.

## Screenshot evidence

The original screenshot was supplied in the investigation conversation.

- pixel dimensions: **1243 × 827**
- mode: RGBA
- file bytes: **78,656**
- SHA-256: `b9413bda038ddbe968d4de102c732d8b36a706a98ad3f35ad6e3c5f89350159a`
- address-bar conversation: `chatgpt.com/c/6acb3b27-ca14-83e8-92be-c7cb5022aa0b`
- exact error: `The conversation is too long, please start a new one.`
- visible action: Chinese `重试` button
- rejected prompt: `继续完成任务`

The screenshot also shows the previous turn still represented as `正在思考`, with persisted partial commentary about checking KeyForge enhancement ordering and Abagnale stacking. Thus the user attempted a fresh continuation after an unfinished/partial turn, and the new message was rejected at the conversation-length boundary.

## Exact refreshed/share checkpoint

Measured with `scripts/analyze-chatgpt-share.py` and a clean `o200k_base` tokenizer:

| Metric | Case #14 |
|---|---:|
| Linear conversation nodes | **5,097** |
| Message nodes | **5,096** |
| Real user-authored messages | **33** |
| Distinct turn exchanges | **33** |
| Serialized assistant → tool-call nodes | **2,224** |
| Tool-result nodes | **2,359** |
| Public-share redacted assistant/tool nodes | **3,495** |
| Identifiable model continuations | **1,226** |
| Share-visible unique text | **114,910 tokens** |
| Real-user text | **2,508 tokens** |
| Visible assistant content excluding redaction placeholders | **29,912 tokens** |
| Visible-prefix input-equivalent over continuations | **88,736,176 tokens** |
| Turn-start-only visible-history replay | **1,759,011 tokens** |
| Flattened share payload | **6,092,918 bytes** |
| Share HTML | **7,367,987 bytes** |
| Mapping branches | **0** |

Role counts:

- assistant: 2,649
- tool: 2,359
- system: 53
- user-role nodes: 35 (33 real user messages plus bootstrap/context placeholders)

All persisted turn exchanges are serialized as `gpt-6-pro`; this is not a mixed-model sample.

## Lifetime and work density

The share represents a much longer calendar-lived conversation than the recent rapid max cases:

- first persisted timestamp: **2026-10-11 15:31:54 +08:00**
- last public-share node: **2026-11-04 09:55:42 +08:00**
- share created: **2026-11-04 10:50:09 +08:00**
- represented lifetime: **2,053,427.89 seconds ≈ 23.77 days**
- share was created about **54m27s** after the last public node

The 27 turns exposing `finished_duration_sec` total **73,055 seconds ≈ 20.29 hours** of observable finished-turn activity.

The conversation contains extreme single-turn activity while still disproving any simple per-turn cap:

- largest turn: **921 nodes / 452 serialized call nodes / 451 tool results**, no final;
- another turn: **828 nodes / 387 calls / 394 results**, no final;
- a completed turn persisted **5,155 seconds ≈ 85m55s** and ended normally;
- another completed turn had **569 nodes / 277 calls / 277 results** and a normal final.

Thus neither ~450 call nodes nor ~86 minutes is a per-turn hard threshold. These heavy unfinished turns instead appear to contribute to cumulative conversation-state consumption.

## Terminal sequence

### Last normal final

The final normal answer was persisted at public node position **5,087**, time **2026-11-04 09:48:28 +08:00**. It answered the user's DM enhancement-order and Honorable Abagnale questions.

### Last persisted partial turn

The next real user prompt began at **2026-11-04 09:54:33 +08:00** and asked for official/third-party support, deterministic handling of same-name copies, new-deck examples, and an Abagnale stacking ruling.

The refreshed share preserves only a short partial execution:

- **9 nodes**
- 1 user node
- 6 assistant nodes
- 2 tool-result nodes
- **3 serialized tool-call nodes**
- **2 tool results**
- no normal final
- last public node at **09:55:42 +08:00**

It ends on a successful tool-result node after local project inspection. No reasoning end or normal terminal answer is persisted.

### Rejected next-turn admission

Before refresh, the user sent `继续完成任务`. The screenshot shows that message plus the exact conversation-too-long error. The refreshed share contains no such user node. Therefore:

1. the prior partial turn was the last canonical persisted state;
2. the next user message reached the UI/transient admission path;
3. the product rejected continuation because the conversation was too long;
4. the rejected message was not committed;
5. refresh returned to the previous canonical checkpoint, after which sharing succeeded.

This is one of the cleanest confirmations of the admission/persistence-boundary model in the dataset.

## Read-only native/cloud evidence

A fresh read-only Desktop bridge check of the backing conversation found:

- cloud persisted current node: `6aa4da1e-56b7-43ff-87d8-dfcadebe0fbc`
- terminal message ID: absent
- persisted outcome: `unknown`
- server-side in-progress: `false`
- native renderer state: **`error`**
- native renderer current node: `f1b19f98-f827-4d45-8f27-6cc0be4654f2`
- native terminal request ID: `a9dd1fbf-7972-4edd-8324-1d9da14831b9`
- native terminal result: `completed`
- native terminal message ID: absent
- cloud/native current-node mismatch
- bridge diagnosis: `transport_or_sync_unknown` / `terminal_receipt_missing`

No retry, probe message, forced node update or reconcile was performed. The execution is not server-side active, but the canonical and native terminal projections disagree and no terminal assistant message exists.

## Comparison with recent samples

| Sample | Status | Nodes | Call nodes | Tool results | Redacted | Continuations | Visible tokens | Prefix-equivalent | Flat payload |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Case #11, GPT-6/Astra | non-max control | 4,024 | 725 | 2,628 | 3,103 | 544 | ~113.8K | ~23.3M | 4.76 MB |
| Case #12, GPT-6/Astra | confirmed hard max | 6,218 | 2,574 | 3,077 | 4,539 | 1,686 | 150.9K | 134.7M | 7.06 MB |
| Case #13, mixed Pro | probable read-only max | 5,599 | 3,202 | 2,124 | 4,222 | 1,098 | 172.6K | 86.5M | 5.87 MB |
| **Case #14, GPT-6 Pro** | **confirmed hard max** | **5,097** | **2,224** | **2,359** | **3,495** | **1,226** | **114.9K** | **88.7M** | **6.09 MB** |

### Relationship to Case #13

Case #14 reaches an explicit hard max with:

- 9.0% fewer public nodes;
- 30.5% fewer serialized call nodes;
- 11.1% more tool-result nodes;
- 17.2% fewer redacted items;
- 11.7% more continuations;
- 33.4% less visible unique text;
- only 2.6% more visible-prefix replay traffic;
- only 3.8% larger flattened payload.

The last two public proxies are close for these two recent workloads, but the older hard-max cases vary widely; this is correlation, not evidence of an 87–89M token or ~6MB universal threshold.

### Relationship to the non-max Astra control

Compared with Case #11, Case #14 has:

- +26.7% nodes;
- +206.8% serialized call nodes;
- **10.2% fewer tool-result nodes**;
- +12.6% redacted items;
- +125.4% continuations;
- nearly the same visible unique text (+1.0%);
- +280.8% visible-prefix replay traffic;
- +28.0% flat payload.

Again, a healthy control can have more raw tool-result nodes than a maxed case. Item composition and hidden payload weight, not a raw result counter, remain central.

## Updated inference

Case #14 strongly reinforces the existing model:

> ChatGPT Web applies a per-conversation persisted/composite-state budget at admission and/or commit boundaries. The public share exposes workload-dependent proxies, not the actual counter.

The explicit screenshot/share pair confirms:

- model execution and partial tool work can still occur close to the boundary;
- the next user turn can be rejected immediately by a conversation-length admission check;
- the rejected user prompt and error state are not committed to the shareable canonical tree;
- refresh rolls back to the last persisted partial turn;
- the original chat can show an error while the server-side branch is no longer active and still lacks a normal terminal answer.

This sample also weakens any policy based only on recent no-final tails. Its final no-final tail is tiny (9 nodes), but the conversation had already accumulated several earlier 500–900-node unfinished exchanges. **Cumulative retained unfinished state**, rather than just the size of the immediately preceding turn, is likely relevant.

## Operational update

For high-tool-density Chat development/research:

1. Preserve a durable checkpoint after every very heavy exchange, whether or not it ends normally.
2. Count prior unfinished/no-final exchanges as retained lifetime consumption; a later successful final does not erase them from the conversation tree.
3. If the latest turn remains partial and the conversation already has multiple historical heavy no-final exchanges, start a successor instead of testing another `继续`.
4. Capture the exact error before refresh. Case #14 demonstrates that the rejected prompt and product error disappear from the public share after rollback.
5. Continue treating all share metrics as pre-limit lower bounds. Screenshot/UI evidence is required to classify the exact rejected terminal attempt.

## Evidence commands

```bash
PYTHONNOUSERSITE=1 PYTHONPATH=/tmp/case13-tiktoken \
  python3 scripts/analyze-chatgpt-share.py --json \
  'https://chatgpt.com/share/6aea9d61-3518-83e8-ba51-22450fc1da97'
```

The exact backend persisted-state representation and the rejected transient turn remain unavailable. Public redaction removes the payloads of 3,495 assistant/tool nodes, so visible token and byte totals are lower-bound proxies.
