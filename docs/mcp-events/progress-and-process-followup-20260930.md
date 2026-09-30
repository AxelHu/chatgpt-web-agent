# 进展判定、进程完成与 Desktop 刷新复核

2026-09-30；对应 Agents/chatgpt-web-agent#41 后续用户反馈。

## 原实现问题

旧代码只比较 target.checkpoint 字符串，变化时增加 revision，再用 root+task+revision 判回环。这既不能判断实质进展，又会把正常“工作者有新结果，回到未修改检查点的监工”误拒绝。不能称作已可靠判断无进展。

改成：相同 root 和检查点的回访只返回 same_root_checkpoint_unchanged_advisory。跨会话交接可继续，没有强行添加总轮次上限或语义评分器。直接自派发、重复请求、已运行/等待的工作区占用、暂停和已完成状态等确定性保护保留。

## 长进程

上一版只有通用事件及调度，没有后台进程终态到事件的自动桥接；本轮补齐。无需独立监工：

1. 目标Chat完成一次真实订阅并与workflow绑定。
2. 用原有exec启动后台命令，取sessionId。
3. 普通空闲任务：workflow_manage(action=watch_process,key,session_id)。已领取run：workflow_run(action=wait_process,task,lease_token,session_id)。
4. 结束当前工作阶段；HTTP服务本机每约2秒process.log检查，保存等待和终态。
5. 成功、非零退出、信号终止、超时均产生一条workflow.continue，trigger_reason区分终态，state_ref指向process session；不塞原始日志。
6. 新run按保存指令读取日志，再判断修复或下一步。不会自动重跑失败命令。

这是本机低成本状态观察，不是让Chat回合持续poll，也不是已有OpenClaw notification自动接入到ChatGPT。连接器MCP HTTP重启不影响独立exec runtime；其终态后仍可恢复等待。整个exec runtime丢失session则保留观测失败，不把消失当成功。

取消等待只停通知，不kill进程；需要实际idle证据才释放仍可能写入的工作区。暂停和临时订阅不可用都保留已观察到的终态。

## 实测

- 完整 pnpm check：179 tests / 19 files。
- 同一root、始终无新checkpoint：40次顺序跨会话交接通过（模拟执行者，非云端Chat）。
- 真实OpenClaw静默成功、退出7、整体超时：原MCP client关闭后，本机定时器自动排队并签名投递mock callback；替换client能读取原日志。
- 真实后台作业跨MCP HTTP server与事件数据库连接重建：一次终态投递。
- 23个进程等待单测覆盖并发、重复、已结束快速进程、读错误、身份/终态不完整、lease、暂停、订阅丢失、取消和工作区。
- 没有发送真实OpenAI callback；不能将以上测试写成“普通Chat已被唤醒”。

## 本机 Desktop 实际 UI 与刷新

实际调用 chatgpt_refresh_plugins 成功：refresh_scope=desktop_catalogs，installed_count=24、catalog_count=5367；app_refresh成功15项。回执 action_schema_refresh.supported_by_desktop=false、performed=false。

随后通过现有CDP连接实际操作家里Desktop，而不是只看旧说明：

- 插件→已安装WebAgentTools→详情更多：只有卸载。
- 详情“已连接”：重新连接/断开连接，没有schema Refresh。
- 插件→个人→由你创建→WebAgentTools→管理：进入自己的云端插件详情，更多仍只有卸载。
- 已安装区的“管理”→插件/应用管理列表：插件行更多只有卸载，应用页为启用开关；没有工具/事件重扫按钮。

没有执行卸载重装、断开重连、清空app数据或客户端升级。这些并不等价于用户要求的schema Refresh，可能干扰现有会话。

官方连接文档说明deploy server→connection Refresh→核对metadata→new chat；当前Desktop界面未提供这项管理端操作。入口缺失不证明Pro不支持MCP Events，不编造已完成Rescan。保持issue#41的OpenAI端验收待办。

资料：
https://developers.openai.com/plugins/deploy/connect-chatgpt
https://developers.openai.com/plugins/build/mcp-events

## 独立审查与拒收恢复

Codex CLI gpt-6-sol/high、read-only审查发现：终态入队即标dispatched，明确400拒收后会失去自动续接入口。已修为delivery_failed：保留原终态和失败回执，不自动用新eventId反复敲一个明确拒收的callback。修复原因后，由授权监工/操作方调用现有workflow_manage resume，即可从保存的终态重发，不重跑进程；不要求人类逐次批准。400/413与不明503的区分各有回归。不明投递保持uncertain，resume不能凭空证明旧Chat没运行。

首段审查遇到180秒执行超时，保存回执并续接同一Codex会话完成审查；这不是代码测试失败。修复后完整179 tests / 19 files通过。
