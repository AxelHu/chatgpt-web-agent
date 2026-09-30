# 验收矩阵

2026-09-30，当前本地完整回归151 tests / 17 files，另有独立Codex只读review。

| 层级 | 验证 | 当前证据 |
|---|---|---|
| 基础协议 | modern discovery/events/list/subscribe/unsubscribe，legacy工具不变 | HTTP集成通过 |
| 签名/传输 | challenge、缓存、轮换双签、同ID重试、429退避、410/413、6次截止 | 单元/协议测试通过 |
| 存储 | 24并发订阅、两个独立SQLite连接抢一个outbox、重启恢复、取消竞态、旧JSON识别 | 通过 |
| 调度 | 外部→监工→工作者、领取幂等、状态分层、busy、独立工作树、暂停、租约、reconcile | 通过 |
| 循环 | 直接self拒绝；同root无进展回环拒绝；新checkpoint允许回访；100独立tick完成200run | 通过，无总回合小上限 |
| 失败 | 明确拒收释放排队；先不明后410仍保留uncertain；晚到真实claim可收尾 | 通过 |
| 权限 | status无secret/lease；写工具真实标注；当前full/ask=off未改变 | 本机和插件核验 |
| 双客户端 | 独立MCP客户端扮演监工和工作者，经真实HTTP完整两段事件 | 通过，callback接收端为mock，不是OpenAI |
| OpenAI端 | 新普通Chat真实订阅、callback验签、原订阅Chat新回合、调用WebAgentTools | 尚待平台侧重扫与真实探针，不宣称通过 |
| 稳定性 | 停止/限流/审批/工具缺失/并发回合/网页关掉后仍触发 | 待真实Chat事件功能验证后按有限用例测 |

## 独立review

Codex gpt-6-sol high、read-only检查提出4项：旧store检测、永久失败卡队列、DNS首地址失败、standalone emitter pending退出码。均补修与相应回归；第二轮审查补充了拒收后的同key重试、undefined字段序列化、HTTPS复用连接识别，已分别修复（独立HTTPS连接避免误判已发送请求）；传输不确定性按更严格的重复运行防护处理，不能因timeout直接清空任务。

Reviewer sandbox里执行测试时/tmp目录失败、没有执行到测试；不把该环境失败说成代码回归。实际pnpm check在正常开发运行时通过。

## 真实有限探针

目标不是“通知已发送”，而是确认：由ChatGPT分配callback，服务器验签成功，事件2xx，ChatGPT自己新增run，工作者领取后写一条限定scratch证明，再finish；不通过Desktop send伪装成callback续轮。

先一个worker/一个event；成功后一个supervisor+一个worker+一个external tick；不自动启用周期任务。记录threadId、subscriptionId（回执隐藏callback/secret）、eventId、new message/run证明、claim/finish和审批次数。完成后暂停或取消探针。
