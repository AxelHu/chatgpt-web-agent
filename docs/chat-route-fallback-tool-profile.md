# Chat 路由降级与自定义工具 profile：当前阶段诊断结论

> 状态：2026-09-20 的阶段性实测结论。它描述当前 Chat 产品行为，后续平台更新可能改变；遇到新反例时应更新本页，而不是把这里当成永久 API 契约。

## 当前最有用的操作结论

普通 Chat 中，如果原本选择/目标是 GPT-6 Pro / Astra Pro，但当前回合的持久化路由突然显示为 GPT-5.4，同时 `WebAgentTools`、本地执行、Blender 写回等自定义/MCP 能力消失，**优先把这两个现象视为同一个平台侧 degraded/fallback 状态的组合表现**，不要先假定本地 Tunnel、MCP server 或 OpenClaw 已损坏。

当前建议判断顺序：

1. 先看浏览器 Actual Model Route badge，展开确认 `default / requested / resolved / actual`。
2. 若出现 `GPT-6 Pro/Astra -> GPT-5.4`，同时自定义/MCP 工具不可用，则先标记为 **route fallback + restricted external-tool profile**。
3. 不因单个 fallback 回合立即重启 Tunnel、MCP、OpenClaw 或本地工作流。
4. 下一自然回合或新 ordinary Chat 会话恢复 GPT-6 后，优先直接复查原自定义工具是否恢复；若无需任何本地修复就恢复，则进一步支持平台侧编排状态，而非本地故障。
5. 只有在**正常 GPT-6 路由下**自定义工具仍连续不可用，并且本地 ledger/health/tunnel 也出现异常时，才升级为本地链路排障。

这条经验尤其适用于“上一回合还能实际开发，下一回合突然只口头回复、声称拿不到本地工具”的情况。

## 已有证据

截至 2026-09-20，针对近期 ordinary Chat / Astra-heavy current branches 的重算与人工核对得到：

| 路由情况 | 0 persisted tool calls | >=1 persisted tool call |
|---|---:|---:|
| 明确 GPT-6 -> GPT-5.4 fallback | **7** | **0** |
| 正常明确 GPT-6/Astra route | 41 | **201** |

已确认的 7 个 fallback 样本来自至少两个独立长会话、两个不同日期：

- 2026-09-20 的 Blender/本地场景长任务：5 个 fallback；
- 2026-09-16 的本地游戏开发长任务：2 个 fallback。

第二个会话的对照尤其清楚：2 个 fallback 回合均为 0 tool calls；同一 current branch 中其余 6 个正常 Astra 回合的 tool-call 数分别为 `181, 4, 100, 63, 99, 3`。其中一个 fallback 回合用户明确要求“在本地项目里建 issue 并继续”，但回复只给出计划，没有任何工具 recipient。

在 2026-09-20 的长会话中，还观察到 fallback 回合明确声称没有 `WebAgentTools / 本地执行 / Blender 写回入口`；紧邻的后续 GPT-6 回合在**没有重启或修复 Tunnel/MCP**的情况下立即重新出现工具节点并成功执行本地工作。

因此，当前最符合数据的工作假设是：

> 上游编排器在某些 degraded/fallback 状态下，同时选择 GPT-5.4 fallback route，并给该执行一个更窄的 external/MCP capability profile；或者 external-tool hydration 先失败，随后编排器选择 text-only 的 GPT-5.4 fallback。现有持久化数据还不能确定这两种因果方向中的哪一个正确。

## 2026-09-21 新反例：工具 profile 异常也可发生在仍标记为 GPT-6/Astra 的回合

会话 `6aa79d0a-4bb8-83e8-bd6b-3663dc85d1f5`（「继续开发像素城堡」）给出了一个重要反例，说明“external/MCP 工具消失”并不要求模型同时 fallback 到 GPT-5.4。

公开 share `6ab085ae-15d4-83e8-93fc-95754395433e` 的 conversation-level `default_model_slug` 仍为 `gpt-6-pro`，`disabled_tool_ids=[]`。账户侧持久化 current branch 中，最后三个异常 user turn 分别发生在 2026-09-21 09:14、09:15、09:17（Asia/Shanghai）：

- 三个回合的 `expected_model_slug` / effective persisted model 都是 `gpt-6-pro`；
- `requested_model_slug` 没有出现 GPT-5.4 override；
- `route_mismatch=false`，`route_override=false`；
- 三个回合全部 `tool_calls=0`；
- 没有完整 reasoning duration，回复分别在约 1.94 s、2.36 s、3.30 s 内直接给出纯文本；
- 回复自身明确承认“没有拿到可用的本地执行链路 / WebAgentTools”，并停止实际开发。

作为对照，同一会话此前 2026-09-20 22:21 的正常 GPT-6/Astra 长回合有 33 个 persisted tool calls；之后存在一个 `reasoning_cancelled` 节点（2026-09-21 01:44），再到早晨连续三个 text-only GPT-6 回合。没有证据表明中间发生了本地 Tunnel/MCP 修复或配置变化。

因此当前诊断应明确区分两种现象：

1. **route fallback + restricted external-tool profile**：此前 7/7 明确 GPT-6 -> GPT-5.4 fallback 都是 0 persisted tool calls，且多次伴随 WebAgentTools 缺席；
2. **GPT-6/Astra label retained + restricted external-tool profile**：模型持久化标签仍为 GPT-6 Pro，但回合退化成极短 text-only 执行，工具没有实际挂载/调用。

这意味着“fallback -> 工具缺席”的相关性仍成立于现有样本，但反方向绝对不能写成“工具缺席 -> 一定 fallback”。遇到 badge 仍显示 GPT-6/Astra、但连续回合无法实际调用工具时，应归入**动态 tool hydration/binding / degraded execution profile**排查，而不是把插件判为错误或强行认定后台已换成 5.4。

一个待观察但未证实的附加线索是：本例在长回合 `reasoning_cancelled` 后出现持续 text-only GPT-6 回合。暂时不要把 cancellation 写成因果，只记录为时间相关。

## 重要限定

- **不是“5.4 一定没有任何工具”。** 历史 5.4 回合里见过 built-in container / image-generation 一类能力。当前强相关的是 `WebAgentTools`、本地执行和其他 external/MCP 高权限工具链的缺席或收窄。
- **不是“0 tool calls 就代表发生 fallback”。** 正常 GPT-6/Astra 回合也可以因为任务本来就是纯文本而有 0 tool calls。当前经验只支持单向模式：`observed GPT-5.4 fallback -> 7/7 zero persisted tool calls`。
- persisted `tool_calls=0` 本身不能证明工具 manifest 一定未注入；真正更强的样本是：回复明确报告 external tools 不可用，且紧邻 GPT-6 回合无需本地修复便恢复。
- `default_model_slug`、`requested_model_slug`、`resolved_model_slug`、`model_slug` 是不同层：浏览器 Actual 显示应优先以具体 assistant message 的 `model_slug` 为证据；Sites 的 Route Health 则仍是 target/default 对 resolved route 的路由健康指标。
- 当前样本是 targeted/current-branch audit，不是随机总体抽样，不把描述性统计外推成账户总体故障率。

## 与 5.6 Sol 的当前经验

近期日常使用中，用户在 GPT-5.6 Sol 上几乎没有遇到这类“模型路由降级 + 自定义工具同时消失”的组合问题。这个经验对运行时选择有参考价值，但目前没有证据证明原因一定是 Sol 服务压力更低；“服务压力/资源池差异”保留为解释假设，不写成已证实因果。

## 相关记录

- 浏览器路由提示：[`chatgpt-route-indicator.md`](chatgpt-route-indicator.md)
- 动态工具 hydration / binding 与安全拦截分层：[`tool-safety-check-diagnostics.md`](tool-safety-check-diagnostics.md)
- 内部调查：Gitea `Agents/chatgpt-web-agent#36`，尤其 2026-09-20 的 route telemetry、公司侧 userscript 验证、fallback/tool correlation 与历史回扫评论。

后续不需要主动消耗 Astra 回合制造样本。正常使用中若再遇到 fallback，只需继续记录模型四层字段、external/MCP 工具是否实际可用，以及下一 GPT-6 回合是否无本地修复即可恢复。
