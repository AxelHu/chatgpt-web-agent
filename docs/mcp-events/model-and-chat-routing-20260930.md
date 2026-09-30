# 2026-09-30：模型指定、普通 Chat 目的地与跨会话事件实测

> 后续补测：[普通Chat来源任务转换](ordinary-origin-conversion-20260930.md)测试了先在目标普通Chat建立任务再添加事件，四种状态下仍未成功。普通标题编辑会改变任务来源标签但不改变聊天origin，该变化也未解除trigger阻塞。Desktop定向发送属于既有能力，事件中转仍仅为备选接缝。

## 结论摘要

| 问题 | 本轮实际结论 |
|---|---|
| 事件任务能保存 model / reasoning_effort 吗？ | 能通过已登录客户端实际使用的 save 接口持久保存，并能 fresh GET 读回。 |
| 保存后能确认自动事件回合使用指定模型吗？ | 三组对照均未通过：输出 metadata 仍为 gpt-5-6-thinking / extended，无 resolved_model_slug。 |
| new_chat 会创建独立会话吗？ | 实际创建了新会话，但 origin 仍为 tpp，不等于普通 Chat。 |
| 能把现有任务直接重绑到指定普通 Chat 吗？ | 本轮尝试未成功：conversation_id 被忽略；source_conversation_origin='chat' 被 schema 拒绝。 |
| 会话间能通过事件合作吗？ | 通过：普通 Chat 启动事件，独立监工会话 claim→dispatch→finish，独立工作者会话 claim→read→finish。 |
| 能实际到既有普通 Chat 并指定 Astra 吗？ | 桥接路径通过：事件回合→ChatgptDesktop.chatgpt_send→既有普通 Chat；最终 resolved_model_slug=gpt-6-pro、standard，并保留旧上下文锚点。 |

这里的“桥接成功”不是“原生 webhook 可任意绑定普通 Chat”。两个机制必须分开。
本轮共6个真实事件运行；没有新建第二个平台任务或启用任何周期循环。

## 测试对象与已授权范围

复用唯一隔离任务 6abcaf92a8dc81918ce9ef9c2469585c，标题 MCP Work Event Probe
20260930，事件 workflow.continue，topic=poc:work-events-20260930-1410。
没有更改已有研究、Feed或其他任务，没有为此重启MCP、官方Tunnel、exec runtime。
另建一个隔离普通Chat作为测试启动者和后续桥接目标：
6abce144-3594-83e8-b205-d553c7099596，origin=null。

平台最初创建订阅仍沿用已验证Work入口；本轮保存配置及启停使用第一方客户端
实际调用的路径，通过已有Desktop认证发送，不提取或导出登录凭据：

- GET /automation/{id}
- POST /automations/save
- POST /automations/set_status
- GET /automation/{id}/webhook_batch_state
- GET /automation/{id}/latest_backing_run?include_snapshot=true

这是**第一方客户端接口的实测**，不声称是可凭普通OpenAI API key调用、具有
稳定兼容性承诺的公开Tasks API。每次只操作上述唯一owned测试任务，保存前
核对身份/状态，保存后读取真实结果；不修改功能开关或账户权限。

## 模型对照

下表均在模型配置fresh-read确认后发送一个真实事件，并确认工具read成功和
输出节点的automation_id/async_source为同一任务：

| 请求模型 | 请求推理 | thread_mode | 输出记录 | 结果节点 |
|---|---|---|---|---|
| gpt-6-pro | high | existing_chat | gpt-5-6-thinking / extended | fca39943-03ea-5023-bdb8-ff2b334e6a19 |
| gpt-6-sol | low | existing_chat | gpt-5-6-thinking / extended | 20b8a8a5-6000-5487-83d9-11a94ee78776 |
| gpt-6-pro | high | new_chat | gpt-5-6-thinking / extended | 682574ac-2d26-5d22-8ef9-91f8aa0b915c |

运行后配置仍保持请求值，排除了“写入没保存”这一解释；但只能得出**这些字段
没有在可观察的事件运行模型记录中兑现**。自动结果没有resolved_model_slug，
不推断其内部是否另有未披露的工作模型或摘要模型，不把它讲成确定的内部降级。
不能将这三组结果扩大为所有模型/任务/执行器都永远不能选择。

起初尝试普通Chat常用的standard档位，服务器明确拒绝。实际任务保存字段枚举为
none/minimal/low/medium/high/xhigh/max/ultra；随后改用high测试。这只证明字段
类型允许，不证明每个档位对每个模型/事件执行器都有效。

前三组共用model-marker.txt并逐次换随机值。三次本机read都真实成功；前两次
文件版本没有单独字节快照，不声称其随机值获得额外独立原文比对。第三次保留
原文。模型选择结论依赖配置/自动结果metadata，不依赖对随机值外观的猜测。

## 普通 Chat 目的地与 new_chat

向已暂停测试任务保存指定普通Chat的conversation_id，请求返回成功，但fresh GET
仍指向原Work会话；因此**写请求成功不是重绑定成功**。

真实网页saveAutomation函数会传source_conversation_origin。测试null没有把结果
转换成普通Chat；测试'chat'收到literal_error：只接受ConversationOrigin.TPP='tpp'。
之后恢复tpp。没有试图修改账户门控或把这种限制包装成网络问题。

thread_mode='new_chat'能够保存并真正创建新结果会话：
142f82d2-8054-8323-bb76-bd291e852a76，origin=tpp。其只含任务结果而不是指定的
既有普通Chat历史。后续监工、工作者和桥接事件也各自产生独立tpp来源会话。

**new_chat还会更新任务响应中的conversation_id为最新生成的结果会话。**
不应继续硬编码最初的Work源会话ID作为“以后所有结果的位置”。本轮清理后任务
已恢复existing_chat等初始配置，但conversation_id仍是最后产生的桥接会话
c8181b96-a3b8-832d-8403-c3e9ef4dc6ab；未声称直接重绑定恢复了原ID。

## 完整原生跨会话合作：claim / dispatch / finish 均通过

只使用同一真实订阅，并让平台为每次事件创建独立会话。事件数据选择已授权的
固定角色；行为由保存的prompt规定，不把事件payload当新指令。

1. 普通Chat 6abce144…中的真实exec启动一个带固定dedupKey的外部事件。
2. 监工任务poc:model-chat-supervisor-20260930在新会话07e8a435-8554-8328-89bc-337e8f58fe04运行。
3. 它原生workflow_run.claim成功，用返回lease调用workflow_dispatch，派发工作者，
   然后workflow_run.finish完成。不是由父会话替它执行这些调用。
4. 工作任务poc:model-chat-worker-20260930在另一个新会话031e8940-a2a8-832b-bb05-5bcdb3c1de54运行。
5. 工作者真实claim，读取独立保存的peer-worker-marker.txt，再finish completed。

| 项目 | 监工 | 工作者 |
|---|---|---|
| eventId | evt_14fa6b84-7c55-40e1-ab1a-5ed4c9afe313 | evt_2f39044d-68b0-41ba-8022-b01a6c300dc0 |
| dispatchId | run_14dd122b-f4ba-4c93-97ee-a345617bcffd | run_7f1b6533-545c-4b76-a325-9fc8d43d79f6 |
| claim（北京时间） | 18:27:54.584 | 18:29:45.917 |
| finish（北京时间） | 18:28:23.262 | 18:30:09.666 |
| 最终回复 | 3f8e42e7-b5ec-5852-9dc8-f050c805dea9 | 8866f238-98ba-50b8-9537-073a47699c11 |

两边run都为finished/completed，共享同一rootId；工作者sourceTask指向监工。
四次claim/finish和一次workflow_dispatch都有独立本机成功回执。两个自动
会话都没有父会话手工补发的user提示；结果metadata均指向真实automation。
与上一轮只观察进程但未claim不同，这次没有用reconcile冒充领取/完成。

诊断期间曾因平台batch状态看到pending=1而复查。当时监工实际上已经完成，
pending是工作者事件。恢复source origin的配置请求发生在监工完成之后，
保留了同一个prompt和订阅；不能将它说成修好了监工启动或证明必须这样刷新。

测试启动脚本也发现了一项自身错误：flush接收eventId字符串，脚本误传对象。
排队已成功而脚本exitCode=1；独立服务从持久化outbox完成同一事件投递。
修正脚本后，对同一dedupKey做了一次回执恢复，返回duplicate_request、exit0，
run/outbox数量及attempts完全不变，没有新增模型运行。保留原始错误，非故意
故障注入，不把初次脚本说成成功退出。

此组验证的是两个**新生成**会话的原生合作，不是固定两个既有普通Chat的原生互唤。

## 已通过的实用桥接：事件 → 指定 Astra → 既有普通 Chat

保存一个明确标注“桥接而非原生绑定”的一次性任务prompt，要求事件处理者：

- 只读取上述指定普通Chat，确认idle并检查本eventId是否已提交；
- 只调用一次ChatgptDesktop.chatgpt_send，明确model=gpt-6-pro、thinking=standard；
- 不直接读marker，不等待目标完成，不再派发事件。

18:31:25本机发送evt_bridge_existing_chat_c7ff295c-c528-4a43-bb0e-ae1d0cb80f22，
一次HTTP200。自动桥接会话c8181b96…返回BRIDGE_DISPATCHED，其metadata是
真实automation来源。提交回执中的user message ID与普通Chat真实新增节点
46e8087b-f42a-4f34-810b-b1c0395e4444一致。

普通Chat最终节点38f8a505-e888-4506-b919-017284f703c1完成：

- conversation_origin仍是null；没有转换为Work。
- model_slug和resolved_model_slug都是gpt-6-pro，thinking_effort=standard。
- 返回文件原文，与保留的bridge-chat-marker.txt独立核对一致。
- 返回只在较早普通Chat历史出现的CONTEXT_CHAT_ANCHOR值；该值不在保存的
  桥接prompt、事件payload或本次新增user消息里，证实此项旧上下文保留。
- 返回准确的桥接eventId。

桥接阶段本机有两条成功的marker读取回执，而不是声称“只读了一次”；普通Chat
持久化工具节点的部分内容为空，不臆造更细的逐次归属。最终普通Chat结果、
其Pro路由记录、实际read成功和匹配原文仍构成明确闭环。

**Astra指定成功的是Desktop提交后的目标普通Chat，不是事件任务自身。**
事件处理者的结果模型仍记录为gpt-5-6-thinking/extended。这条路径增加一个
事件处理回合并依赖家里Desktop/Bridge在线；未测量额度，不宣称免费或几乎无成本。

## 清理、验证和已知限制

- 6个逻辑事件均已接受并产生对应结果；没有调用Run now。
- 两个coordinator任务均completed后pause；没有遗留lease/currentRun。
- 唯一平台task已disabled，平台原生unsubscribe，本机订阅0、pending/sending 0。
- 已恢复该测试任务原prompt、默认model/effort、existing_chat模式及通知配置；
  latest conversation pointer按new_chat实际行为变化，保留在清理回执中。
- 运行时代码没有改动，不把本轮文档/实验声称为重新跑226项回归或重新部署。
- verify-experiment.py的39条事实断言通过，验证三组模型记录、两个协作run、
  自动结果来源、实际读回执、普通Chat Pro结果及旧锚点、幂等恢复与清理。

本机证据：workspace scratch/mcp-events-model-chat-20260930/：
verified-experiment.json、model-execution-evidence.json、routing-execution-evidence.json、
peer-coordinator-evidence.json、verified-native-tool-audit.json、bootstrap-error.json、
bootstrap-idempotent-recovery.json、cleanup-task-receipt.json、cleanup-local-receipt.json。
原始callback URL、签名secret和登录凭据不写入报告。

## 建议采用的分层方式

普通任务/监工可以采用原生event→claim→dispatch→finish；目前不要依赖保存的
model字段来保证Astra。必须使用既有普通Chat及指定模型时，采用已验收的
事件→Desktop桥接，并保留目标idle核查、提交幂等回执和完成后的路由验证。
完整多目标生产化还需要目标级原子lease，不能只靠prompt中的read-then-send
检查解决所有并发。本轮是隔离单目标验证，未对任何正式项目开启该循环。

官方背景（2026-09-30检索）：
- https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
- https://learn.chatgpt.com/docs/automations

官方描述eligible模型和existing/new chat选择，不能替代具体事件执行器的实测。
