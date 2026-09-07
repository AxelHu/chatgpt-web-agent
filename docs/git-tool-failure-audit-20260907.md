# Git 与工具失败审计、记忆机制及提示词更新

日期：2026-09-07（Asia/Shanghai）。操作者：ChatGPT Web Agent。范围：更新自定义指令，检查当前可保留的本地日志，并区分历史版本与后续修复；不写 ChatGPT 记忆、不改变权限、不重放历史操作、不重启服务。

## 结论

“请求被平台拦截”不能直接报告为“Git 不可用”；反过来，已经进入本地并出现具体错误的请求，也不能一律归为平台误拦。本轮发现最显著的本地错误族不是 Git 缺失，而是 8.2 升级后的参数合同变化：238 条 `exec` 错误信封中，231 条报旧参数 `timeout` 不支持、应使用 `timeoutSeconds`。

这是保留日志中实际收到并返回错误的调用记录数，可能含其他会话、测试及重复调用，不是独立事故数、生产任务数、用户失败率或平台误拦率。平台拒绝且未转发的调用不在本地接收分母里。

## 数据边界

- `~/.local/state/chatgpt-web-agent/request-ledger/`：保留的文件为 9 月 3 日至 9 月 7 日。9 月 3 日最初时间为 `06:56:35.499Z`（北京时间 14:56:35.499），后来增加了 localTime 字段，不能把 UTC 与本地时间直接混排。
- `~/.local/state/chatgpt-web-agent/full-trace/`：实际第一条接收记录为 9 月 3 日 **17:04:17.859+08:00**。9 月 3–6 日的 zstd 文件只读解压分析，不覆盖原始日志；9 月 7 日文件仍持续写入。
- 本轮错误族扫描截止于 **9 月 7 日 13:06:57.687+08:00** 左右，共 238 条 `exec` 的 `mcp_call_completed.ok=false`。后续工具调用会继续增加当日日志，不把这份截面统计当成全天结果。
- Git 错误签名扫描重点是即时 `exec` 完成输出；未系统展开所有后台进程后续 `process` 输出、其他 agent 的完整运行日志、或 9 月 3 日以前的请求。不宣称穷尽所有 Git 失败。
- 首次宽范围批量读取请求被平台拒绝，未原样重试；随后只输出元数据、固定错误类别与有限的 Git 错误行，不输出历史命令正文或整份响应。进一步按命令哈希配对 `timeout` 失败与修正成功的请求也被平台拒绝，未重试，因此没有给出调用者归因或配对恢复成功率。

## 已进入本地的 exec 错误族

| 错误族 | 记录数 | 首次与末次观测（北京时间） | 判断 |
|---|---:|---|---|
| `exec parameter "timeout" is unsupported; use "timeoutSeconds" instead` | 231 | 9 月 4 日 15:24:07 至 9 月 6 日 12:07:14 | 当前保留日志中最大的错误族；调用方提交了旧参数，不能靠原样重试修复，也不是转发前拦截。 |
| `exec runtime request timed out after 150000ms` | 1 | 9 月 4 日 10:29:38 | 本地 runtime 请求超时；需核对是否已经执行及结果，不可据此断言 Git 缺失。 |
| 自定义 `PATH` 不允许 | 1 | 9 月 3 日 22:08:45 | 本地主机执行策略拒绝；不是 PATH 中没有 Git 的证据。 |
| `LD_LIBRARY_PATH` 不允许 | 1 | 9 月 5 日 09:06:30 | 本地主机环境变量策略拒绝；不能靠重试或换通道规避。 |
| 外部 sqlite3 不允许打开活动 OpenClaw 状态数据库 | 4 | 9 月 4 日 21:47:30 至 9 月 7 日 11:11:36 | 真实本地状态保护；本轮没有执行相关数据库访问。 |

即使当前调用接口已明确 `timeoutSeconds`，也不能推断当时具体是旧会话工具快照、脚本、测试还是模型参数选择导致；日志未提供足够的会话归属证据。统计只说明旧参数错误发生在升级之后，在本次扫描中 9 月 6 日 12:07 后未再次命中，不等于已证明所有旧调用方都已更新。

## 六条 Git 错误签名记录

以下是本地实际输出中的固定 Git 错误行及相应 `callId`，不是模型口头声称 Git 坏了。部分请求包含多个子命令，最终退出码只代表整个 shell 请求。

| 时间（北京时间） | 可核验错误 | 外层退出码 | 层次/边界 |
|---|---|---:|---|
| 9 月 3 日 20:41:54 | `fatal: ambiguous argument 'v2026.8.1..v2026.8.2': unknown revision or path not in the working tree.` | 128 | 版本引用不存在或尚未获取，Git 已实际执行。 |
| 9 月 4 日 22:12:15 | `fatal: not a git repository (or any of the parent directories): .git` | 141 | 某次子调用的仓库上下文不成立；外层 workdir 不能证明所有子调用均在相同目录，尚未精确定位子命令。不能认定整个 OpenClaw 仓库损坏。 |
| 9 月 4 日 22:40:21 | `fatal: couldn't find remote ref upgrade/v2026.8.2-local` | 0 | 远端缺少当时请求的分支；外层返回 0 不会抹去中间 Git 错误。 |
| 9 月 6 日 16:45:54 | `remote: This repo is archived`；推送 `Agents/openclaw-local.git` 返回 403 | 128 | 已归档的历史 Gitea 仓库拒绝写入，不是随机的模型审核。 |
| 9 月 6 日 17:02:02 | 同一归档仓库 403 | 0 | 同一确定性错误再次出现；整个组合请求仍可能退出 0。 |
| 9 月 7 日 10:52:51 | `error: No such remote 'origin'` | 0 | Desktop 桥接本地仓库未配置该 remote；不是本机 Git 不存在。 |

对应 callId 与可复核位置：

1. `mcp-f56a4b82-59ab-4dd3-a1df-4ee747bf183b`，`2026-09-03.jsonl.zst` 解压后第 3797 行。
2. `mcp-54043b17-9fd9-456c-bde5-5f60b6329538`，`2026-09-04.jsonl.zst` 第 28375 行。
3. `mcp-7eea840e-ac39-43ad-9b61-0caa3931b4c0`，同日第 29431 行。
4. `mcp-8f596145-8620-47ae-a1f6-91466f2f119e`，`2026-09-06.jsonl.zst` 第 18756 行。
5. `mcp-661fdff7-7582-428f-b32b-d9b15af5be09`，同日第 19042 行。
6. `mcp-9bb6c70e-5a0c-41b4-a9b7-a3298c0ba744`，`2026-09-07.jsonl` 第 6656 行。

上述请求的 `mcp_call_completed.ok` 全为 true，包括外层退出 128/141 的请求。当前这个字段反映 MCP 工具信封未标 `isError`，**不保证命令成功**。还必须看 `exitCode`、`exitReason`、是否仍 running，以及每个关键子命令的结果；不能用一层 ok 汇总整项任务成功率。本轮只记录语义差异，不贸然修改兼容字段。

此次即时输出扫描没有命中 `git: command not found`；这是有限扫描结果，不是所有环境、所有时间的 Git 可用性证明。

## 与修复时间线对齐

| 时间/版本 | 已有证据 | 对今天判断的影响 |
|---|---|---|
| 8 月 17 日 Shell/PATH 修复 | `LOCAL_WORKSPACE.md` 记载登录 Shell 环境和 pnpm 等路径修复、验收；属于历史文档证据。 | 不因一条 9 月平台拒绝再次重做老 PATH 修复；没有保留当时原始请求，不能反推该旧故障其实也是误拦。 |
| 8 月 28 日 `61bbcc2` | Desktop fresh read 已增加不完整响应重试。 | 9 月 7 日出现的 `status=unknown` 是此版本之后的剩余/新样本，不应描述成“桥接从未做过重试”。 |
| 9 月 3 日 `b38c601`、`0a18626` | 小索引和完整 trace 分别加入；日志首次出现时间与 Git 提交时间略有先后。 | commit 时间不等于精确部署时间；以实际日志起点限定可观察窗口。 |
| 9 月 4 日 15:16:33 `eed2b25` | wrapper 适配 OpenClaw 8.2，公共 exec 参数为 `timeoutSeconds`。 | 15:24 起的大量旧 timeout 参数错误在升级后；提示应使用当前工具合同，而不是循环原样重试。 |
| 9 月 6 日远端归属确认 | `Agents/local-system-health/inventory/openclaw-source-and-deployment.md` 记载源码目标是用户 `AxelHu/openclaw` fork，旧 Gitea 仓库归档，修复已推送。 | 403 历史样本已有路由层解释，不能重新解封归档仓库或说“Git 仍坏了”。 |
| 9 月 7 日 `22e15cf`、`515b326`，随后 11:13–11:16 验收 | Desktop 增加日志，双方工具 annotations/说明更新；前一轮已验证重载后的真实调用。 | 早于此时的 Desktop 调用不能要求存在新日志；说明更新也不能解释 9 月 4 日参数错误为何发生。 |
| 9 月 7 日用户确认账号权限/刷新，12:12–12:15 验收 | 说明已在当前工具定义可见，但平台拒绝仍出现；另有本地 Desktop fresh read 异常。 | 刷新/授权不是云端安全检查关闭或根因修复的证明。 |
| 9 月 7 日 12:22:25 `0f434ee` | 当前 Desktop HEAD 又增加“record observable Chat Astra Pro usage”。 | 本轮不改 Desktop 源码、分支或部署，不覆盖其他会话的新进展。 |
| 9 月 7 日 12:29:58 `c79742d` | 上一轮文档提交、私有 Gitea 推送和远端回读成功。 | 可确认 Git/远端在该时刻工作；仅凭成功样本不能证明之前所有失败都可重试恢复。 |

## 记忆机制的最新官方说明

核验于 2026-09-07，主要依据 [Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq)。该页当前把以下两套机制分开说明：

- **新版 Memory summary**：持续从聊天、文件、连接应用综合更新重要背景；用户看到的摘要不一定包含全部记忆，回复下的 memory sources 也不是所有影响因素的完整清单。这不是固定、不可变的提示词文件。
- **Legacy saved memories**：FAQ 明确说 saved memories 是回答上下文的一部分，未删除时会在未来回答中持续被考虑（“always considered in future responses”）。应如实承认这个持续性，不能说记忆只偶尔碰巧生效。
- 上述产品描述没有给出每条记忆在每个 turn 逐字注入、同等权重或无条件执行的技术保证。新版/旧版、记忆开关及项目范围也不能混为一谈；本轮没有读取账号设置，无法确定用户当前选择哪套模式。
- 同一 FAQ 的 Custom Instructions 对照明确建议把显式指导放入自定义指令。动态背景可由记忆辅助，精确的执行原则保存在用户可维护的自定义指令中。当前不改记忆模式，也不执行记忆写入。

[Custom Instructions 官方说明](https://help.openai.com/en/articles/8096356-chatgpt-custom-instructions)确认它是用户明确指导的设置入口。新正文在 [chatgpt-custom-instructions.md](chatgpt-custom-instructions.md) 唯一规范代码块中；用户已确认设置的是旧三段版，增加故障恢复的新四段版待手动替换。

对于平台审核，[官方支持 8 月 5 日与 8 月 16 日回复](https://community.openai.com/t/chatgpt-app-mcp-tool-calls-blocked-by-openai-safety-checks-before-reaching-mcp-server/1386059?page=2)承认部分正常只读调用误拦，但未披露本例每次调用的模型、采样或判定机制。只能把“可重试的瞬态失败有限恢复”作为工作原则，不能把所有安全/权限拒绝自动等同网络抖动。

## 存档与维护原则

最小本地分析结果位于 workspace `scratch/retry-prompt-audit-20260907/`：`ledger-summary.json`、`error-signature-summary.json`、`error-families.json`。它们不包含完整历史命令或整份工具响应；全文日志仍保留在既有私有轮换目录。没有将原始日志整份提交。

本轮只新增稳定的故障处理偏好：区分错误层、先核对副作用、仅对可重试错误有限恢复、按当时版本判断。具体版本号与事故细节保留在项目文档，避免自定义指令膨胀并减少重复修复已经解决的问题。未修改执行器、日志字段、Git/SSH 配置或账号权限。
