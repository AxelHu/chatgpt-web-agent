# 2026-09-30：刷新后的平台事件注册与订阅入口诊断

## 已有证据，不再沿用旧的“16 工具”结论

用户手动刷新网页连接后，当前普通 Chat 原生发现 20 个 WebAgentTools
工具，并直接调用 workflow_status 成功。四个 workflow 工具和进程等待动作
均已进入工具 schema。这不是通过 exec 转发 RPC 模拟的原生调用。

2026-09-30 13:03:57 +08:00，通过既有 Desktop 原生认证读取**同一个账号、
同一个 WebAgentTools 连接**的云端元数据，得到 HTTP 200：

- connector_type = MCP；连接为个人 ONLY_ME。
- actions = 20；actions_changed_since_review = false。
- mcp_events = 1；事件名称 workflow.continue。

诊断没有导出登录凭据；仓库只保留上述去标识化摘要，不存完整云端响应、
回调地址、签名密钥或会话认证信息。

**工具刷新、事件发现及云端事件元数据登记已通过。** 不能继续把剩余问题
归因于官方 Tunnel 或旧 MCP 目录，也不需要为本次日志修改再次刷新插件。

## 尚未取得的平台能力

本轮普通 Chat 仍只获得带 schedule/timing 参数的 automations.create；
没有 triggers 参数，也没有可调用的 discover_webhook_schema。
WebAgentTools 的 workflow_manage 绑定的是已有真实订阅，不能凭空申请
OpenAI callback；不能用伪造 callback 或普通定时任务替代订阅创建。

Desktop 客户端能显示已有 webhook_triggers 和条件，但当前手工新任务
构造器只构造时间计划。其 MCP UI 的 openai/events/subscribe 流式通道
随界面组件生命周期清理，不是所需的持久后台 webhook task。

为检查网页登录入口，只在家里既有 Chrome 中新建了一扇测试窗口，访问
ChatGPT tasks；实际页面为 ERR_CONNECTION_CLOSED。该窗口已单独关闭，
未关闭其他窗口、未改浏览器代理、未导出 cookie，也未提交模型提示词。
这只证明这条网页访问路径当时失败，不证明账号没有事件权限。

公开资料需要区分：

- MCP Events 开发文档明确描述自定义事件、ChatGPT 下发 callback/secret，
  以及在 subscribed chat 处理事件的流程，并让开发者用新 Chat 验收。
- 面向用户的任务帮助页目前列出的 Gmail/Slack/GitHub 事件任务运行在 Work，
  对符合条件的 Pro 等套餐开放；还明确 Desktop 不能创建或编辑事件条件。
- 因此不能从“Pro 可以连接 MCP”推导“这个普通 Chat 一定已经拿到每一种
  MCP 扩展的任务创建工具”，也不能从本轮缺少工具推导“Pro 不支持自定义事件”。

官方来源（2026-09-30 实际读取）：

- https://developers.openai.com/plugins/build/mcp-events
- https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
- https://learn.chatgpt.com/docs/automations

## 补齐请求诊断，而不是伪造订阅工具

旧实现只记 events_list / event_subscribed / event_unsubscribed。
订阅参数验证失败或 callback challenge 失败时，可能没有相应成功记录。
所以旧日志没有 event_subscribed，**不能证明平台完全没有尝试请求**。

增加 EventRequestAudit，使用 SDK 支持的 Standard Schema 接口包裹原参数
验证器，不改变事件定义、原校验规则、返回值、权限或工具目录：

1. event_audit_started：当前 HTTP 服务的诊断覆盖起点和版本。
2. event_request_received：请求进入事件参数验证层。
3. event_request_rejected：参数 schema 未通过，或验证器本身出错。
4. event_request_validated：校验通过、即将执行事件方法。
5. event_request_failed：运行阶段失败，区分已知参数错误及 callback
   invalid_url / timeout / challenge_failed 等现有分类。
6. events_list / event_subscribed / event_unsubscribed：成功完成，保留原相位名。

每次请求使用唯一 callId 关联阶段；请求 ID、topic、callback URL 只记摘要。
不写原参数、原错误文本、校验 issue 内容、secret、URL、challenge 或回应正文。
healthz 增加 eventAuditVersion = 1，便于确认在线代码版本。

诊断范围是**已经到达 SDK 事件参数验证层**的请求。非法 JSON、协议 envelope
或更上游网络/权限拒绝仍需相应传输证据。未观察到记录不等于证明请求未发出；
日志也是 best-effort，不把缺日志变成权限或套餐结论。

## 测试

新增 13 项测试通过，均经过真实本地现代 MCP HTTP 路径或验证器错误路径：
缺失参数、非法 URL、发送失败、非成功状态、错误 challenge、非 JSON 回应、
非法 secret、未知事件名、成功订阅/取消、并发请求隔离、关闭日志仍可用、
诊断覆盖标记，以及验证器异常不泄露原错误。

完整回归：20 个测试文件，192/192 通过。四项真实 OpenClaw 长进程测试仍通过。
独立只读 Codex review 未报告可操作的回归；其只运行类型检查，运行期测试由
本轮主执行器完成。所有 callback 测试接收端均是隔离测试端，不冒充 OpenAI。

## 当前验收状态和下一项真实测试

本轮未创建新的真实 subscription、workflow、run、outbox 或周期监工，
未发送 OpenAI callback，未启动新的子会话或将任务 handoff。
Issue #41 保持打开。

当当前普通 Chat 或明确支持的同账号界面提供实际创建入口时，先做有限测试：
独立 topic、短期有效订阅、只处理一次；由平台生成 callback 和 secret。
观察真实 events/subscribe、验证成功、数据库登记；再发一个事件，分别核实
平台接收、同一订阅 Chat 的新 run、事后文件读取和正常工具调用。
最后取消订阅并核验清理。不要用 Desktop send、UI 流式事件或定时 poll
冒充这个闭环；通过之后才继续监工到工作者与长进程等待的云端验收。
