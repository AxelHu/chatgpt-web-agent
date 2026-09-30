# 2026-09-30：普通 Chat 来源任务转换为 MCP 事件的补测

## 用户纠正与本轮目标

用户指出：通过 Desktop 指挥既有 Chat 是早已有的能力，上一轮的新证据只是
事件能触发这条旧链路，不应当作“原生直接绑定已实现”。用户要求继续实测
直接绑定，并认可必要时用一个专门会话或其他方法补上中间缺口。

本轮只补测一个此前遗漏的创建顺序：

普通 Chat 内原生创建任务 → 立即暂停 → 保留原绑定 → 由 Work 改成事件。

时间型任务只是取到真实普通Chat来源对象的停用测试种子，不是轮询方案；
没有让该时间任务运行，也没有用Desktop发送来制造所谓事件回复。

## 结论

**这条创建顺序仍未通过。** 四次真实事件更新均返回同一任务服务错误，
没有保存trigger；普通跨会话标题编辑两次都成功。移除原时间计划、允许直接
启用、平台自动改变任务来源标记后，分别补测，均没有解除阻塞。

只得出“本次这组普通Chat来源任务转换没有成功”，不推导所有Pro、所有客户端
或所有未来版本都不支持，也不将unexpected error自动归因于Auto Review。

## 对象与隔离

- 普通Chat目标：6abce144-3594-83e8-b205-d553c7099596。
- Work配置会话：6abca752-5328-83e8-8c44-b42367a558cc。
- 本轮唯一新种子：6abcec086eb88191a31a7b7b1aa7e47b。
- 标题：MCP Ordinary-origin Conversion Probe 20260930。
- 专用topic：poc:ordinary-origin-conversion-20260930。
- 旧事件任务6abcaf92a8dc81918ce9ef9c2469585c保持停用，未作为本轮写入对象。

普通Chat真实create成功，未来时间为2026-10-30 12:00 Asia/Shanghai；随后
原生update立即停用。精确GET证实：conversation_id就是该普通Chat，
conversation_origin=null，source_conversation_is_work_mode=false，
thread_mode=existing_chat。没有“自报绑定”替代云端核验。

## 逐项对照

时间均为北京时间2026-09-30。

| 阶段 | 实际操作与回执 | 状态核验 |
|---|---|---|
| 19:01 创建、停用种子 | 普通Chat原生create和立即disable均SUCCESS | target正确，source=false，无trigger，last_run_time=null |
| 第一次事件update | 保留原远期计划、不显式传schedule，添加trigger且is_enabled=false | ERROR，未部分保存 |
| 19:08移除时间计划 | 客户端真实save路径，保持disabled和原目标 | X-UNSCHEDULED:1，next_run_times=[]，source仍false |
| 第二次事件update | 原参数重试，已无时间计划，仍保持disabled | ERROR，未保存trigger/prompt |
| 第三次事件update | 唯一参数变化为is_enabled=true | ERROR，仍disabled，无trigger |
| 19:13—19:14常规编辑对照 | Work原生update只改title并随后恢复，均不传trigger/source/conversation | 两次SUCCESS；真实标题变更/恢复、目标ID不变 |
| 来源标记核验 | 普通编辑后精确GET显示任务source=true，而目标聊天origin仍null | 是平台普通保存的附带状态变化，不是手工伪造source |
| 第四次事件update | 在此新真实状态下，重试与第三次完全相同的事件update | 仍ERROR、无部分保存 |

四次原始错误均是：

`The task service returned an unexpected error.`

用户可见错误为：

`Unable to complete task request. Try again.`

四次请求均来自同一个真实Work执行路径，使用已发现的通用triggers schema：
connector_id=asdk_app_6a82a84b38248191a8d10e8977069f08，event=workflow.continue，
params.topic为本轮专用topic。没有向工具传入未开放的conversation/source字段，
没有随trigger添加时间schedule。前两次disabled，后两次enabled。

正常标题编辑成功使“任何跨会话任务写入都不可用”不再是合理概括；但本轮
没有另外创建一个全新Work事件任务作为同时段阳性对照，所以仍不能彻底区分
原始普通Chat目的地限制、此转换路径缺陷或更局部的平台事件服务问题。

## task来源与chat来源不能混为一谈

Work配置会话最初报告其更新参数没有改来源，这对**所提交参数**属实；但
父会话独立读取云端完整元数据发现任务来源标记仍被平台改为了true。
其后续报告中“来源未修改”不能被升级为“所有持久化来源字段未改变”。

这个变化说明任务来源标签与目标聊天来源是两个状态，不代表目标Chat已转换
成Work，也不代表trigger必然可创建。第四次实际更新正是针对这个变化补测，
而不是看到字段变化就宣布成功。

最初清理脚本要求source=false，因此它在删除前正确停止。核对出真实状态
变化后才重新运行精确清理；没有把前置条件错误解释成权限拒绝。

## 没有制造假续轮

本机当前SDK事件参数层的审计窗口内，没有观察到events/subscribe请求；
测试topic没有真实订阅，没有发送任何事件，没有marker的MCP读取请求。
普通Chat最后节点仍为创建种子的正常回复80b525bd-f5dc-44e9-b9f0-63a50740f560，
不是一个新自动回合。

“不见本机audit”只涵盖到达当前SDK事件处理层的请求，并不证明上游从未尝试。
没有把测试marker路径放进任何实际执行的事件，也没有调用Run now。

## 清理

19:18通过客户端实际removeAutomation路径，删除唯一新测试种子。
再次GET精确ID得到HTTP410和automation_not_found；普通Chat仍可读、origin=null，
节点未变。旧事件任务仍disabled，默认模型/推理、existing_chat及最新结果目标
均保留。实验topic订阅0，pending/sending投递0，无新周期或无限循环。

该remove动作不会被用来删除测试会话或任何已有项目任务。本轮没有修改
运行时代码、权限或服务，没有重启Tunnel，也不声称重跑此前226项运行时测试。

## 中转方案的实际定位

已经可用的备选是：

本机／外部事件 → 一个固定事件收件会话 → 既有Desktop发送能力 → 目标普通Chat。

新增价值只在前半段：外部条件能触发一次平台处理。后半段的定向发消息和
选择gpt-6-pro/standard本来就已存在，上一轮只是验证它能被事件回合串接。
它不是原生任意Chat订阅，也不是本轮新开发出来的指挥能力。

中转会话应当是固定的轻量接收器，而不是每次重新规划项目的监工：
只依据已授权topic/route key读本机路由表，核对目标idle及本event是否已提交，
调用现有Desktop发送动作，保存回执，然后结束。不按checkpoint字符串变化
或所谓进展评分设置准入门槛。目标模型来自用户批准的配置，不让payload
临时更改目标/模型/提示或扩大授权。

多目标并发需要目标级原子lease及已提交事件回执；read-then-send的单次隔离
验证不等于具备所有并发保证。本轮仅说明这种接缝设计，未部署新的常驻中转、
新增工具或打开自动循环。中转增加一个模型回合并依赖Desktop在线，额度未测。

如果信号本来就在本机，直接让已有本地调度调用Desktop更短，也不需要为了
使用MCP Events而多绕一个模型回合；那属于既有本机自动化，不冒充新事件绑定。
需要平台托管的事件入口或统一连接器时，固定收件会话才提供不同的价值。

## 可核对证据

workspace scratch/mcp-events-direct-binding-20260930/：

- native-conversion-evidence.json：精确测试会话的原生调用及原始结果节点，排除无关任务列表。
- seed-before-conversion.json：普通Chat来源和原绑定。
- remove-time-plan-receipt.json：移除时间计划仍保持普通来源。
- seed-final-state.json、seed-before-final-cleanup.json：平台改变任务来源后的完整状态。
- cleanup-seed-receipt.json：删除回执、HTTP410、普通Chat及旧任务保留状态。
- event-request-audit-final.json：当前处理层的有限观察窗口，不反推上游行为。
- verified-experiment.json、verify-experiment.py：45条证据断言通过；这是证据一致性检查，不是45个功能成功用例。

没有输出或保存callback URL、签名secret或登录凭据。Issue #41保持打开。

官方参考（2026-09-30实际读取）：
https://developers.openai.com/plugins/build/mcp-events
https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt

官方“subscribed chat”是订阅归属描述，不等于承诺可在工具里任意写一个
conversation_id；帮助页目前将事件任务描述为在Work执行。文档仅作解释背景，
不替代上述真实创建／转换测试。
