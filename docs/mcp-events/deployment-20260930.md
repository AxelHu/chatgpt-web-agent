# 2026-09-30 接入与真实 Chat 探针

## 已上线的本机部分

服务代码提交：c9282deaa3a4347c899920b9a9c94dd6e113b019。

仅 chatgpt-web-agent-mcp.service 使用新的已验证工作树，通过
~/.config/systemd/user/chatgpt-web-agent-mcp.service.d/30-mcp-events-poc.conf
覆盖 WorkingDirectory/ExecStart，并开启 CHATGPT_WEB_AGENT_EVENTS_ENABLED=true。

工作树：/home/axelhu/.openclaw/workspace-chatgpt-web-agent/repos/chatgpt-web-agent-mcp-events-poc。
状态：~/.local/state/chatgpt-web-agent/events.sqlite，0600。

部署时刻：2026-09-30T01:49:40.492895Z。部署前核对没有在途MCP调用；部署前后独立 exec runtime 和官方 tunnel 的PID/启动时间完全相同；旧生产checkout的未提交修改完全保留。

live /healthz：ok=true, mode=sessionless, modernProtocol=2026-07-28, legacyCompatibility=stateless, sessions=0, events=true。

通过直接访问 live HTTP 端点的现代 SDK 客户端，已验证 server/discover 的 events:{}、events/list 的 workflow.continue，以及20个工具（原16个+4个workflow工具）。旧式客户端也能调用workflow_status，并且没有错误声明legacy支持事件协议。此证明是本机SDK检验，不是OpenAI平台Rescan。

另启动一个真实后台进程跨越MCP服务切换，切换后仍正常结束，证明没有丢掉exec runtime的已有session。

## 真实普通 Chat 尝试

探针会话：6abc6beb-a7a8-83e8-8697-2b273dd78869。
标题：实验：MCP Events 普通 Chat 订阅探针。
限定topic：poc:mcp-events-worker-20260930-0155。

Desktop的GPT-6 Sol创建请求在提交前返回model_config_unavailable；打开普通Chat模型目录后确认该客户端当时不能选择gpt-6-sol，没有生成重复会话。随后使用当时实际可选的GPT-5.6 Sol/high创建一次普通Chat探针；回执effective_model=gpt-5-6-thinking、effective_thinking=extended。

子会话实际从Google Drive读到Ordinary Chat Subagent Runbook.md，保持普通Chat，然后检查本轮真实工具注册表。结论：没有四个workflow工具，也没有事件订阅创建接口。没有切换Work，没有定时轮询，没有用发送聊天消息伪装事件触发，没有创建订阅或其他循环任务。

部署后执行过Desktop plugin/app catalog refresh。其明确回执：refresh_scope=desktop_catalogs，action_schema_refresh.supported_by_desktop=false，performed=false。这个目录刷新不是官方文档要求的MCP服务器action/event schema Refresh。

界面检查：Desktop插件详情/已连接菜单未提供该Rescan操作；访问管理网页的新页面未登录，已有内嵌网页导航到plugins也回到登录页。因此本轮没有执行到真正的管理端Rescan。没有卸载/重装插件、没有修改全局权限，也没有使用猜测的内部管理API。

最终本机状态：subscriptions=0、workflows=0、runs=0、outbox=0。这和子会话“订阅未创建”的回执一致。没有发送任何真实OpenAI事件callback。

**结论**：工程实现和本机联调已部署；普通Chat端到端续轮未验收，不能将此次结果归结为“Pro不支持”。明确下一门槛是平台重新发现action/event schema，然后新建普通Chat再做有限订阅/触发验收。

## 权限及检查回执

WebAgentTools app-specific permission=Allow all actions；本机 full / ask=off / workspace_only=false，均保持原有设置。

提交/开PR的合并命令首次返回“此工具调用被 OpenAI 的安全检查屏蔽。请仔细检查你发送的内容。”核验Git/远端都没有写入后，用原工具、原身份、原参数重试一次成功（提交d7b5454，PR#42）。没有通过改身份、换通道或降低检查来执行这次提交。

## 回滚

撤销本次唯一新增的30-mcp-events-poc.conf，再systemctl --user daemon-reload与restart chatgpt-web-agent-mcp.service即可回到原ExecStart。不要重启exec runtime或官方tunnel。数据库保留，不删除用户数据。

## 后续精确验收

在ChatGPT的WebAgentTools连接管理页面执行Refresh/Rescan后，确认4个workflow工具和workflow.continue事件出现。新普通Chat建立真实订阅；服务端看到events/subscribe、challenge成功及非敏感订阅ID；父控制器发一个事件；观察原订阅Chat产生新的run并读取事后更新的scratch文件。完成一次worker探针后再做一次supervisor→worker双会话探针；通过前不启用示例周期timer、不迁移现有Feed/研究监工。

资料：官方MCP Events https://developers.openai.com/plugins/build/mcp-events ，连接和刷新流程 https://developers.openai.com/plugins/deploy/connect-chatgpt 。
