# v1：本机事件直接续接普通 Chat，不设置中转模型会话

## 本轮决定与边界

当前默认采用：**本机事件 → 持久队列/确定性路由 → 既有 Desktop Bridge → 指定普通 Chat**。
不是“本机事件 → Work/事件收件模型 → Desktop → 普通 Chat”。不需要先创建
OpenAI Scheduled Task、MCP webhook订阅、callback或模型中转会话。

这复用了原有Desktop定向发消息和选择模型能力，新增的仅是本地事件的持久
队列、并发互斥和可核验回执。不得把它称为“普通Chat原生MCP事件绑定成功”。
此前原生直接绑定的负面实验保持原结论，不推断官方永远不支持或不打算支持。

原生MCP Events实现仍保留为另一条可选出口，适合明确需要OpenAI平台托管
订阅/事件执行的场景。只有本机或已有本地适配器能取得的信号才能直接进入
当前新入口；仅对OpenAI平台可见的连接器事件，不会因此自动直达本机。

## 实现

新增独立代码，不更改当前MCP工具目录、旧事件数据库或Desktop提交实现：

- `src/local-chat-continuation.ts`：路由验证、SQLite inbox、目标占用、恢复。
- `src/local-chat-adapter.ts`：调用已安装Desktop Bridge的get/send及原操作日志。
- `src/local-chat-cli.ts`：一次性enqueue/dispatch/recover/settle/cancel/status。
- package bin：`chatgpt-web-agent-local-event`，本地也可直接运行`node dist/local-chat-cli.js`。

一个事件的目标chat、模型、thinking及保存prompt来自操作者确认的路由文件；
event只能提供固定schema的id/route/topic/source/reason/stateRef，不能替换
目标、模型、prompt或shell命令。stateRef规范化为已解析路径，并检查实际
目录（包括符号链接和不存在文件的最近已存在祖先），发送前再核对一次。
这些是事件输入边界，不是新增的Git、shell或日常开发审批。

每个logical event有唯一(key=route+event id)和payload摘要；重复ID/相同数据
返回原记录，重复ID/不同数据拒绝，不能悄悄篡改已排队指令。每个事件还使用
一个独立的Desktop短期操作日志，避免多个本地发送器相互覆盖共享JSON日志。

### 状态与恢复

| 状态/观察 | 处理 |
|---|---|
| pending | 已存储，尚未提交；可被明确取消 |
| target_busy | 保留pending，发送attempts不增加，不打断或排队用户消息 |
| checking | SQLite原子目标锁下只读检查；锁过期后可重新核验 |
| sending | 进入真实提交副作用边界，不能因时间到就回退成可重发 |
| held | 提交是否发生不明确；只读查原消息ID，不盲目重发 |
| submitted | 仅说明消息已提交，不能称模型任务完成 |
| settle确认完成 | 已看到该精确user message及其后的terminal结果，释放目标占用 |

即便新读到“idle”，也必须看到上次提交的精确message ID和后续完成节点，
避免延迟的旧idle快照让两个相邻事件都提交。查询先读200个含工具节点；
工具密集长回合导致原user节点截断时，再用Bridge支持的500条**过滤后可见**
消息核验，不能把几百条工具日志当永久未完成。若连这个窗口仍找不到精确ID，
或用户已切到另一个历史分支，继续待核验，不靠时间、文本相似度或进展评分放行。
这仍是现有Bridge历史接口的边界，不声称无限长度的精确祖先查询已实现。

明确not_started且safe_to_resubmit=true才允许后续显式重试，最多6次实际send，
每次有退避。重试前归档并清除旧attempt receipt，防止过期重试生成新消息ID
后恢复逻辑还错误查询旧ID。其他模糊失败不以新eventId逃过幂等检查。

进程在提交后、保存inbox回执前退出时，recover只读该事件的既有Desktop日志，
按kind/thread/match hash/requestId找回精确message ID，再从正确Chat独立核验。
保留的旧日志过期不会被当作“未提交”；如果证据缺失或互相矛盾，仍不自动发。
日志、队列和配置保存在用户本机私有目录；不读出或导出登录凭据。

目标锁协调的是**使用同一数据库的这些派发器**；用户或其他旧程序绕开这个
入口并发手工发送，不受该锁控制。本轮未声称解决所有人工操作竞态。
路由文件是每次CLI启动时读取的配置；停用对后续调用生效，不会撤回已提交消息。

## 最小用法

下面是配置结构示意，默认停用，必须替换成已授权真实Chat及本机绝对路径：

```json
{
  "version": 1,
  "desktopBridgeRoot": "/absolute/path/to/chatgpt-desktop-bridge",
  "stateDirectory": "/absolute/private/state/local-chat-events",
  "routes": [{
    "key": "project-checkpoint",
    "topic": "project:checkpoint",
    "threadId": "00000000-0000-4000-8000-000000000001",
    "model": "gpt-6-pro",
    "thinking": "standard",
    "prompt": "读取本项目已授权检查点并继续既定工作。",
    "enabled": false,
    "stateRoot": "/absolute/path/to/project/checkpoints"
  }]
}
```

完成信号示意：

```json
{
  "id": "job-123-completed",
  "route": "project-checkpoint",
  "topic": "project:checkpoint",
  "source": "process.completed",
  "stateRef": "/absolute/path/to/project/checkpoints/job-123.json"
}
```

```sh
node dist/local-chat-cli.js enqueue --config /private/config.json --file /private/event.json
node dist/local-chat-cli.js dispatch --config /private/config.json --key '<enqueue返回的key>'
node dist/local-chat-cli.js status --config /private/config.json
node dist/local-chat-cli.js recover --config /private/config.json --key '<需核验的key>'
node dist/local-chat-cli.js settle --config /private/config.json --key '<已提交的key>'
```

作业生产者也可在原代码中直接调用enqueue及一次dispatch，不用再唤起一个LLM
来决定“发给谁”。长进程结束、Codex完成、已有本地监工确定有下一阶段时，都
可在既定授权下提供这种信号；跨会话监工仍可存在，但它负责判断和工作安排，
不是每个事件必经的转发模型。

本入口不自己注册timer、不循环poll整个账号、不自动生成下一event。
pending事件由既有本机调度器的下一次检查、另一真实事件或显式dispatch处理。
本轮没有修改任何已运行的定时任务；`process-waits`原有native-MCP出口也没有
偷偷改成Desktop。把所有正式项目的生产者接入，是后续按项目明确启用的步骤。

## 本轮真实验收（2026-09-30，北京时间）

复用隔离普通Chat `6abce144-3594-83e8-b205-d553c7099596`，没有新建会话。
没有调用Work、automation create/update或发送原生MCP callback。

### 第一个事件：并发重复只产生一条提交

两个独立Node进程同时dispatch同一个持久event key。其中一个获得锁并完成
真实Desktop提交，另一个返回target_locked，send attempts为0。
获胜者的真实提交回执：

- user message：`6f8f4ecd-1bb1-414c-9356-7249cc535738`。
- parent：实验开始前的原普通Chat末节点`80b525bd-f5dc-44e9-b9f0-63a50740f560`。
- 最终结果：`ef57813b-69cf-4b67-972e-9f0def5d8914`，19:40:27。
- model_slug和resolved_model_slug均`gpt-6-pro`，thinking_effort=`standard`。
- 实际执行20秒隔离等待命令并读取marker-a.txt；文件原文独立匹配，旧上下文锚点正确。

20秒等待仅为形成可观察忙碌窗口，不是让长期系统用sleep充当业务进展。

### 第二个事件：忙碌时保留，同一待办在空闲后完成

一个真实有限作业在19:39:51写完新结果并入队完成信号。首次尝试观测到目标
仍active，返回pending/target_busy，attempts=0。该生产者进程随后真实退出0；
本轮之后才显式再次dispatch这个**相同事件**，并没有用新ID重造一条。
这里区别作业工作已完成与生产者进程已退出，不把应用内的自报exitCode当OS回执。

第二次dispatch先核实原提交节点及其后的终态，再经Desktop真实发送：

- user message：`f88df227-845a-4389-8cbd-c7d225489728`。
- parent：第一轮真实最终结果`ef57813b-69cf-4b67-972e-9f0def5d8914`。
- 最终结果：`1142322a-cce9-4f4b-85eb-2d52b79be27c`，19:42:09。
- 实际和resolved模型仍为`gpt-6-pro`，standard；新marker-b.txt和旧上下文锚点均正确。
- 提交后在另一个CLI进程重放同event key，返回相同message ID，attempts仍1。

两次合计只在该普通Chat新增两个user turn；现有Work配置会话末节点没有变化。
原上下文锚点值没有放入新提示或event payload。目标实际MCP marker读取回执共
观察到3条，不声称“每轮严格只调用read一次”；两份保留文件和对应结果均独立匹配。

### 实现测试与清理

43项本地派发器测试覆盖并发、忙碌、旧idle、截断历史、确认未提交重试、未知
结果保持、丢回执恢复、旧attempt隔离、符号链接、路由暂停/变更、腐坏状态等。
完整回归22个文件、269项测试通过（以本轮最终日志为准），保留原226项的
原生事件/真实进程等待回归。两轮独立审查提出的恢复和路径问题已补修/补测；
极端历史窗口限制明确保留，不靠猜测释放锁。

额外26条真实证据一致性断言通过；这26条不是额外模型运行次数。
两条测试路由已停用，目标已idle，settle核验后目标锁为0；没有pending、sending
或held测试事件。已提交记录保留作为幂等历史，不清空来假装系统没有执行过。
没有重启MCP、官方Tunnel或既有Desktop Bridge，也未迁移正式研究/Feed任务。

本机详细证据在workspace `scratch/local-chat-direct-20260930/`：
`verified-live.json`、`race-a.json`、`initial-b.json`、`resumed-b.json`、
`final-target.json`、`marker-mcp-audit.json`、`completion-and-locks.json`。
该目录是私有实验记录，不加入公共仓库；文档不包含登录凭据或callback secret。

## 版本选择

- 默认：local continuation，保留普通Chat上下文与现有明确模型选择。
- 可选：原生MCP Events，用于确有平台托管需求的事件；不依赖其未验证的模型覆盖。
- 暂不做：固定中转模型、每次新建Work收件会话、继续猜测个人Chat任务私有写字段。
- 未宣称：跨客户端全局原子发送、无限历史查询、长时间无人值守稳定性、额度测量、
  自动接入全部生产项目。所有这些都与已通过的两次真实直达验收分开。

官方协议背景：
https://developers.openai.com/plugins/build/mcp-events
https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
