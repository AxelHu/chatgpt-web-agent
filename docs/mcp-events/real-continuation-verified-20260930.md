# 2026-09-30：同一订阅两次真实自动续轮验收通过

## 已通过的范围

本轮复用由 Work 创建的隔离事件任务，在同一个真实订阅上完成两次续轮：
一次由本机主动发出 workflow.continue，另一次由真实后台进程完成后自动发出。
两次均由 OpenAI 接收并产生原订阅会话中的新助手回复，而且实际调用了
WebAgentTools 读取新鲜的本机验证文件。不再只是 HTTP200 或 last_run_time。

本轮没有改运行时代码、重启 MCP/Tunnel/exec runtime、创建子会话或启用周期监工。

## 探针身份

- Work 创建/订阅会话：6abca752-5328-83e8-8c44-b42367a558cc。
- 平台 task：6abcaf92a8dc81918ce9ef9c2469585c。
- 事件：workflow.continue；topic：poc:work-events-20260930-1410。
- 本轮两次触发共用 subscription：sub_28407d6aebf3e5af503f67d83be246ae。
- 测试工作目录：workspace scratch/mcp-events-work-retry-20260930。
- 会话标题已改为“MCP Events：真实续轮与进程完成验收”，只改标题，不补发提示伪装事件。

## 本轮恢复与配置

上轮已暂停任务且取消本机订阅。本轮普通 Chat 两次调用原生 automations.update
尝试启用并替换 prompt，都返回 Unable to complete task request. Try again.；
云端仍 disabled，MCP 未收到订阅请求。

随后在原 Work 会话调用一次真实事件 update，保留完整 triggers，启用并替换
最小执行 prompt。15:28:49（UTC+8）本机完成真实 callback 验证，平台返回 SUCCESS。
Work 本轮可用 update schema 有 triggers，但没有 model/reasoning/executor/
thread_mode/conversation_id。普通 Chat 的窄接口缺 triggers，不能用它宣称所有
事件管理操作已经可用；此次也未因该局部失败判定整个工具集不可用。

保存的执行指令只要求：输出启动标记，调用 workflow_status，读取 marker.txt，
报告文件原文与 eventId，结束。配置回合不读文件，也不发事件。

## 证据链一：主动通用事件

全部时间是北京时间 2026-09-30：

| 阶段 | 实际证据 |
|---|---|
| Work 配置回合结束 | 7d38679c-3d71-5b12-8aa9-fbcbad354d24 完成、会话 idle |
| 15:29:27.235 本机发送 | evt_work_retry_001936bf-52ee-49d6-bb04-8f4fdf28c70c，HTTP200，一次accepted，无歧义重试 |
| 15:30:11.289 工具调用 | workflow_status 请求与成功回执均进入本机日志 |
| 15:30:19.428 文件读取 | read(marker.txt)，同一callId的completed回执为ok=true |
| 15:30:38.337 自动回复 | 45f992c0-57df-51d6-b8d8-086fdafb7038，包含正确随机marker和对应eventId |

随机 marker 在本机独立生成；没有放进事件payload、创建提示或Work配置请求。
对照文件原文及实际read回执，而不是只相信模型声称“已经读取”。

## 证据链二：同一订阅的真实进程完成

没有再次调用 Work、创建订阅、调整任务prompt或手工发送第二个事件。

- 原生 workflow_manage 分别 register、bind 一个隔离worker；两个action的
  字段不能混用。首次误把subscription_id放进register而被严格验证拒绝，
  随后按已读源码分为两步；这个参数错误与平台权限无关。
- 启动一个有限的真实OpenClaw后台进程 plaid-valley；静默等待后在退出前
  写入一个新的随机marker，并输出完成标记。
- 原生 watch_process 登记成功，观察到 running；本机服务随后观察实际退出。

| 阶段 | 实际证据 |
|---|---|
| 15:32:35.646 进程开始 | plaid-valley，独立后台进程 |
| 15:32:49.065 进程完成 | 完成时才写入新marker，实际exitCode=0 |
| 等待任务自动投递 | wait_96b6267ae42269d7f844fb5054ac8754 → evt_549d89b2-de7d-43bb-9f4f-c044549a532b，HTTP200/一次accepted |
| 15:33:25.588 文件读取 | 第二次read成功，读取新marker，不是复述上一个值 |
| 15:33:40.864 自动回复 | 5cab4bf2-cdb6-5bb8-a61a-2dec7a66e658，包含进程marker、正确eventId及退出码 |

这验证的是跨回合完成通知机制，测试进程本身只运行约13秒，不把它说成已做
数小时压力测试。等待由本机driver承担，模型不需要存活并不断poll。

## 如何排除手工回复或假续轮

全量读取这个特定会话的61个mapping节点，按时间筛选：两次事件各新增一个
助手结果节点，没有在两者之间发新的user提示。第二次助手节点parent就是
第一次助手节点；第一次parent是已结束的Work配置回合。

两条结果的metadata都有：

- automation_id / async_source = 上述真实平台task ID。
- 不同的 working_turn_id / turn_exchange_id。
- status = finished_successfully。

本机分别有对应的read收到与完成回执，两个实际文件值均与云端回复匹配。
没有点击Run now，没有用Desktop send触发这些自动回复。

## 模型与会话边界仍需区分

创建/恢复操作在Work中执行，记录是gpt-5.6-sol-wm / xhigh。两次事件结果
记录的model_slug均为gpt-5-6-thinking，thinking_effort=extended；
resolved_model_slug缺失，不编造更深层路由结论，也不能说沿用了Astra。
平台task的model/reasoning字段此前为null（默认）。

目标会话的conversation_origin仍为tpp。已证明的是**原Work建立订阅的会话
能被本机事件重复续轮并调用工具**，不是把任意既有普通Chat ID绑定成功。
同一会话节点链成立，也还不等于逐项验证了全部历史上下文都被自动run采用。
后续接研究任务前，需验证执行模型控制和既有普通Chat目标。

## 上一轮为何没出结果

上一轮没有工具/新节点证据的结论仍是当时真实观察。本轮在同一已部署服务
上恢复了订阅，同时替换了prompt，Work update的默认timezone和callback
也发生变化。并非单变量实验，所以不把成功归因于某一个prompt字眼、时区、
Auto Review、固定等待时间或所谓模型路由修复。

## 清理与准确的workflow状态

测试保存的prompt只做状态/读取，没有模拟实际开发worker的claim/finish。
因此本地coordinator里的进程派发记录仍曾为queued，不拿它冒充“已领取运行”。
实际生产worker仍须按既有协议claim/heartbeat/finish。

fresh-read确认原会话idle及进程completed后，原生reconcile释放探针的queued
占用，并在outcome中保留真实自动回复和read回执依据；随后pause该测试worker。
15:35:52平台成功暂停task，已实际下发events/unsubscribe。本机没有活跃测试
订阅或待投递事件；已接受outbox与已完成等待记录只保留作审计。

## 保存的可核对材料

workspace scratch/mcp-events-work-retry-20260930/：

- verified-e2e-receipt.json：自动断言通过的端到端摘要。
- cloud-e2e-evidence.json：两个自动结果、parent链及automation来源metadata。
- complete-marker-read-audit.json：两个读取请求与成功回执。
- process-completion.json：进程实际起止与新marker。
- single-event-delivery.json、callback-response-summary.jsonl：首次独立事件的
  持久化投递回执；响应为HTTP200空正文，未将其单独当作执行证明。

不记录callback URL、签名密钥或登录凭据。文档变更不重新声称执行了整套
226项回归；运行时代码仍是此前PR #45已验证部署版本，本轮是额外真实云端验收。

## 当前可采用的运行方式

Work建立并启用真实订阅一次后，本机在该订阅有效期间可多次按topic发送事件，
不需要每次发事件先唤醒一个Work会话；进程完成只是其中一种来源。
暂停后恢复或改订阅条件目前仍应使用带完整triggers的已验证入口。

Issue #41不再以“缺少任何真实云端run证据”为阻塞；保留针对既有普通Chat
目的地、执行模型控制和完整监工→worker领取/完成闭环的后续验收，
未启用生产式周期监工或无限循环。

官方机制参考：
https://developers.openai.com/plugins/build/mcp-events
https://learn.chatgpt.com/docs/automations
