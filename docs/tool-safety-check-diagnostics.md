# 工具安全拦截：分层诊断与实测

日期：2026-09-07（Asia/Shanghai）。操作者：ChatGPT Web Agent。

用户授权：复测读取自己的 ChatGPT 会话与 SSH 访问家中 M4，调查安全拦截位置和原因。这里只记录结果与待验证项，不放宽执行策略、不关闭检查、不以其他通道重做被拒绝的操作。

## 结论与证据强度

- **本轮实测成功**：原先被拒绝的 `ChatgptDesktop.chatgpt_get`，相同会话 ID、`max_messages=100`、`include_tools=false` 返回 HTTP 200；常规 M4 SSH 只读探针退出 0。
- **本轮现场复现**：随后只读检查一条历史诊断日志及桥接源码时，`WebAgentTools.exec` 返回“因 OpenAI 无法确定请求的安全状态，已拦截此工具调用”。再后的本地 Gitea issue 列表查询也收到相同拒绝；未通过另一个入口重试这些操作。
- **本轮有直接证据的位置**：第一笔现场拒绝的完整命令哈希，在当日 `mcp_call_received` 记录中匹配数为 0。前后正常请求、其他会话请求和同一工具的简单基线均正常。因此定位到本地 MCP 接收之前，而非 wrapper、OpenClaw 执行器或 SSH 返回错误。
- **尚不掌握**：平台内部分类器、规则、分数、请求 ID，以及具体哪个语义或上下文因素触发拒绝。不能把“不能判定安全”直接等同于已认定用户违规，也不能断言是某个关键词、Astra、代理或自定义提示词造成。

## 自定义指令与推送状态

用户已确认手动设置；本轮能在聊天历史看到正文，但未观察到独立标识的自定义指令注入，也未从设置页回读。保存确认与加载验证分开记录，不能因本轮某次调用成功就推断是新指令修好了权限。

规范正文仍见 [chatgpt-custom-instructions.md](chatgpt-custom-instructions.md)，SHA-256 保持 `759b7551aa71fe85397d99646ac7542526fe11bba398b065accdbb0d7aa442dd`。

账号保存确认提交 `e16f288` 已推送至私有 Gitea `Agents/chatgpt-web-agent` 的 `main`，同时带上此前本地已有的 `ea68447`（正文存档）和 `eed2b25`（8.2 适配）。推送前 `pnpm check` 12 文件 / 71 测试通过，`pnpm smoke` 通过；远端 ref 已回读匹配。没有推送 GitHub mirror，没有重启运行服务。

## 1. 会话读取

原失败参数与本轮复测参数相同：

```json
{"conversation_id":"6a82bcad-48ec-83e8-97f6-0ad3f7338f8e","max_messages":100,"include_tools":false}
```

结果：`ok=true`、`status=200`、标题“外部内容安全规则”、`total_messages=2`、`truncated=false`。该历史会话是旧规则存在性的确认，不是旧配置全文；不要将其概括误标为逐字恢复。

随后正常检索并读取了“检查OpenClaw额度消耗”（`6a9cdd56-60dc-83e8-b802-0504bba225ae`）的最近相关消息。没有通过 raw CDP、任意后台请求、创建子会话或更换执行环境来获取这些内容。

Desktop bridge 当前 `61bbcc2` 的 get/search 路径未发现本地语义安全分类器；它的 stdio server 没有 WebAgentTools 同等级的逐请求 ledger/full trace。因此，这次 get 成功可直接验证，但不能用另一服务的日志反推当时 Desktop get 的完整云端执行轨迹。

## 2. SSH 与原认证操作需要分开

实际在 10:35:36 执行：

```sh
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 axelhu@192.168.0.96 'printf "M4_SSH_READONLY_OK\n"; /usr/bin/whoami; /bin/hostname; /usr/bin/uname -s'
```

退出 0，返回标记、用户 `axelhu`、主机输出 `192.168.0.96`、系统 `Darwin`。未关闭主机密钥校验、未修改 SSH 配置、未读取或输出私钥。

该探针 `callId=mcp-fc79fc92-5006-4789-9ae7-0a82099efc99`。当日 request ledger 第 6400–6407 行包含接收、转发、OpenClaw 开始/完成和返回的完整八阶段记录，`mcp_call_completed.ok=true`，耗时 387 ms。

正在运行的 `openclaw-m4-node-tunnel.service` 也使用同一目标，10:34:50 观测为 active/running。其持续连接不等于 Mac 节点已完成 Gateway 认证。

历史会话与 `Agents/local-system-health` 的 `incidents/2026-09-07-node-capabilities-and-exec-boundary.md`（提交 `7bb0dee`）明确区分：SSH 本来已通；被拒绝的是创建 `configure-m4-auth.py`，拟经 SSH 标准输入向 Mac 的 0600 配置传递 Gateway 认证信息。本轮只复测访问，没有重试凭据配置或设备配对，不能宣称该有状态步骤已解封或已完成。

本轮独立解压核对 9 月 6 日 full trace：`mcp_call_received` 总数确为 2761。脚本文件名有 1 条引用记录（20:08:55，`mcp-52a18a6c-3f76-4648-954e-da8997420afe`）；“提到文件名”不等于“创建请求”。继续核查这条引用语义时发生本轮现场拦截，因此没有把历史报告中的“创建请求为 0”冒充成本轮重新逐条确认的结论。

## 3. 本轮拦截的直接定位

第一笔现场拒绝发生在 10:38:38–10:39:32 之间；平台没有提供更精确时间戳或请求 ID。命令仅计划读取一条旧日志、显示源码和工具帮助，没有计划执行原认证脚本或传递认证信息。未重试这段被拒绝的命令，也未读取其被拦的输出。

- 被拒绝命令长度：1202 字符。
- 精确命令 SHA-256：`180c391235fd6202921f965613cf826cd5a090351c9dee1c1a4b775c925f146f`。
- 当日 full trace 中对应 `mcp_call_received`：0 条。
- 前一笔本轮成功请求：10:38:37.689，`mcp-70a5252b-e024-46c5-9f87-2f53c9592714`。
- 拒绝后的简单基线：10:39:32.273，`mcp-4b7339bc-3511-4dea-b880-875a95089e11`，正常输出时间和 ledger。
- 此间其他会话也有正常工具请求，日志持续写入，不是整个 MCP 或日志服务离线。

逻辑调用链：ChatGPT/平台动作检查与转发 → Secure MCP Tunnel → 本地 MCP → exec-runtime → OpenClaw → SSH → M4。可确认的边界是本地 MCP 之前；结合产品返回的安全检查错误，证据支持平台侧审核/转发阶段。没有平台内部 trace，不能再细分具体云端服务或客户端组件。

本机执行进程中只读取非敏感策略字段，得到 `EXEC_SECURITY=full`、`EXEC_ASK=off`、`WORKSPACE_ONLY=false`。这些配置没有修改；本地执行策略不等于平台动作许可。

最小证据保存于 workspace 的 `scratch/security-check-20260907/trace-verification.json` 和 `current-block-dispatch-evidence.json`。原始日志仍由既有 7 日轮换维护，不整份提交到仓库。被拒绝调用没有本地 callId；本地 `mcpRequestId=0` 不是可用于官方排障的全球唯一请求 ID。

## 4. 一个确实存在、但未证明是根因的工具契约缺口

`chatgpt-desktop-bridge/src/manager.ts` 的 get/search/read 等声明没有 `annotations.readOnlyHint`；构建产物也未包含该标注。WebAgentTools 的 `src/backend/openclaw.ts` 映射仅保留 name/title/description/inputSchema，未提供这一标注。

OpenAI Developer mode 文档写明：未提供 `readOnlyHint` 的工具按写操作对待。这会使工具的声明语义比实际只读查询更宽，但不能据此断言本次误拦就由它造成；社区报告也包含正确标注的只读工具被拦。

后续应按每个工具的真实行为审查并补齐 annotations，不能把可执行任意命令的 exec 或有修改能力的工具伪标为只读，也不能将 metadata 当作绕过检查的手段。本轮没有修改工具 schema、插件权限或服务配置。

Desktop 桥接缺少逐调用诊断记录是另一项可观测性缺口。后续改进应只记录必要的 request/call ID、时间、工具名、阶段和结果，不需要因此收集浏览器凭据或完整账号数据。

## 5. 公共证据与因果界限

公开资料核验于 2026-09-07：

1. [OpenAI：Additional safety checks](https://help.openai.com/en/articles/20001326-additional-safety-checks-for-biological-and-cybersecurity-requests-in-chatgpt-codex-and-the-api)：额外检查不自动意味着用户违规；对于反复被拦的明确正常/已授权请求，可提交准确文案、模型、时间时区和请求 ID 供支持排查。这不是对本次内部分类结果的披露。
2. [OpenAI：Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt)：动作评估考虑具体操作、共享信息与上下文；降低确认频率不覆盖某些平台安全保护。
3. [OpenAI：Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)：没有 `readOnlyHint` 的工具被当作写动作；[工具定义指南](https://developers.openai.com/plugins/plan/tools)要求标注真实反映副作用，不替代授权。
4. [开发者社区第一手报告，2026-07-08 起](https://community.openai.com/t/chatgpt-app-mcp-tool-calls-blocked-by-openai-safety-checks-before-reaching-mcp-server/1386059)：只读航班搜索、自建 Gitea 文件读取、文件系统工具均有转发前被拦报告；有作者观察到完全相同调用随后成功。社区推断不是本次根因证明。
5. [GitHub connector 使用者的第一手报告](https://www.reddit.com/r/ChatGPT/comments/1vnlnin/blocked_by_openai_safety_checks_errors_with_the/)：出现与本例对应的英文“couldn't determine the safety status of the request”。页面相对时间和抓取时间不一致，因此不依据它断言发布时间或当前大面积故障。
6. [OpenAI：Custom Instructions](https://help.openai.com/en/articles/8096356-chatgpt-custom-instructions)：主体说明更新适用于包括既有会话在内的聊天，但不据此替代本账号设置回读和实际加载验证。

自有机器/账号并不把普通授权请求变成有害请求；平台检查与资源所有权属于不同判断维度。这里要保护的是动作范围、凭据和信息流，而不是禁止正常访问自己的资料。当前证据支持选择性、上游的安全拒绝；可能包括风险分类偏保守或误报。没有受控对照，不能将某次恢复归因于新提示词、模型切换、文件名或重试技巧。

## 后续处理范围

保留既有安全配置；正常任务按原授权继续。对重复误拦保留最小事实与时间窗口，不把单次拒绝当作本地服务坏了，也不盲目重启、改路由或重放可能产生副作用的请求。按真实工具语义完善 metadata 与分层日志是工程改进，具体平台判定原因仍需要平台侧诊断。

本轮尝试读取 Gitea issue 列表时同样被拒绝，因此没有新增 issue；本文件保留调查结论和这项尚未完成的记录动作，不声称已经反馈官方或完成修复。
