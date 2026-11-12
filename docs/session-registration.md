# 会话登记与工具活动

## 使用

在当前会话每回合开始时调用一次：

```json
{"name":"UDG美术开发3"}
```

工具名为 `session_register`。模型可沿用一个用户能够辨认的固定名称；无需填写时间、
模型、请求编号或会话 URL。名称为 1–200 字符，不接受控制字符。

可加入系统提示词：

> 每回合开始时，先调用 WebAgentTools 的 session_register，以当前会话名称登记；后续回合沿用同一名称。登记只需本轮调用一次，之后正常执行任务。

服务端返回 `registered: true`、`binding: "upstream_session"` 和
`session.clientSessionKey`。只有收到成功回执，才视为登记成功。

查询工具 `session_status`：

```json
{}
{"name":"UDG美术开发3"}
{"session_key":"v1:0123456789abcdef"}
{"limit":100}
```

`name` 精确匹配；相同显示名称的不同来源分别返回。`session_key` 是登记回执中的
匿名键。默认返回最近 50 条，最多 200 条。

## 绑定与时间语义

- 每条 HTTP 请求的 `x-openai-session` 经既有 SHA-256 截断得到
  `clientSessionKey`。原始上游值不写入登记库或日志。
- 显示名称是调用者主动登记的标签，不是读取自 ChatGPT 的官方会话标题。
- 同一来源重复登记更新名字和最近登记时间，保留最早登记时间与最近活动。
- 不同来源不因名字相同而合并；不存在全局“当前会话”默认值。
- `lastRequest.receivedAt` 表示最近一次请求到达接口的时间；
  `lastResult.completedAt` 表示最近一次完成结果被接口观察到的时间。
  两者可能来自不同调用，因为请求可以并行。
- 正常工具结果、返回 `isError` 的工具结果和抛出的错误均被记录。
- 普通工具日志中的 `sessionName` 在请求开始时固定。并发改名不会重写旧调用的归属。
  `session_register` 自身是名称更新边界，其成功完成日志使用新名称。
- 记录是工具活动证据，不是模型心跳。无新请求不能单独证明聊天停止；
  后台进程存活或完成也不等于发起它的聊天仍在运行。

该匿名键不是 ChatGPT thread UUID。PR61 的现场验收已记录同一 Chat 跨两个独立回合、
多次接口服务重启保持同一值，另一个 Chat 使用不同值。这是实际观测，不是平台承诺
上游键永久不变；每回合重新登记可让当前来源获得正确名称，但不会据此自动合并两个不同来源。
没有来源键的客户端调用登记会返回 `session_identity_unavailable`，不保存绑定。
其他工具继续正常工作；当前版本没有额外的显式 ID 传参机制。

## 实现与运维

`SessionTools` 在 MCP 通用入口工作，登记和查询不会发起模型回合、订阅或后台任务，
也不经过 OpenClaw exec runtime。所有正常工具继续使用原有参数。

登记数据默认存于 `$XDG_STATE_HOME/chatgpt-web-agent/sessions.sqlite`；XDG 未设置时
使用 `~/.local/state/chatgpt-web-agent/sessions.sqlite`。可通过
`CHATGPT_WEB_AGENT_SESSION_STORE` 指定文件。

存储复用项目的 SQLite `StateDatabase`，事务内读改写，避免多个前端或交错请求
丢失更新。会话摘要自建库使用 WAL/NORMAL 和零写锁等待，减少每次观测的同步开销；
事件与工作流数据库继续沿用原来的 FULL 同步设置。每个已登记来源只保存一份紧凑摘要；完整历史沿用现有 request ledger /
full trace 的保留策略。接口服务重启不会丢弃绑定。

登记库按需打开，初始化或观测写入失败不会阻断普通工具。登记/查询自身无法完成时
返回工具错误；普通调用的观测故障记入 `session_observation_failed` 诊断事件，
不改变原工具的执行结果。自动归属覆盖 HTTP `tools/call`，不包含直接 `events/*`
协议请求或 `tools/list` 等元数据请求。

发布时只需更新对应 MCP frontend，再刷新原 ChatGPT 连接的工具元数据。
本地 `tools/list` 可验证服务端已经公布接口，实际 ChatGPT 工具调用用于验证
客户端已刷新；两项验收分开记录。
