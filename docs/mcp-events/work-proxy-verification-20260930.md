# 2026-09-30：真实 Work 订阅入口与回调网络修复

## 用户授权和隔离范围

用户本轮明确要求调查可封装的 API，或实际测试 Work。仅新建一个隔离
Work 会话，使用独立 workflow.continue topic；不接管既有研究/Feed 任务，
不启用周期或无限循环。普通 Chat 的长期使用偏好没有被改写。

## 平台入口已经实测出现

家里 Desktop UI 选择“工作”后提交测试请求。持久化记录确认 origin=tpp，
实际模型 gpt-5.6-sol-wm、推理 xhigh。Work 原生发现并调用事件 schema，
使用带 triggers 的 create 工具，字段为 connector_id / event / params。
事件 workflow.continue 和 topic 过滤条件真实可用；无时间 schedule。

初始六次创建均返回平台 unexpected error；状态核对未发现测试任务。
这与普通 Chat 缺少事件工具是两个不同结果：Work 的入口确实开放，
不能再把所有失败都归为平台没有下发创建工具。

服务端 audit 证明真实 events/subscribe 到达、schema 通过；失败发生在
向 OpenAI 平台下发的 callback 发送 verification challenge 的网络步骤。
原始 URL、签名 secret 和 challenge 均不写入本报告。

## 两层根因和修复

1. 旧 pinnedHttpsPost 使用 agent:false 的直连 HTTPS，没有采用 MCP 服务
   已设置的 HTTPS_PROXY。增加显式 operator proxy，保留 NO_PROXY 语义。
2. 本机系统 DNS 给 OpenAI 域名返回的地址与代理内 TLS DoH 查询结果不一致；
   使用系统地址经代理固定 IP 连接仍失败。实际 Node 代理+可信 DNS 路径
   收到 api.openai.com HTTP404 和 chatgpt.com HTTP405，证明基础 HTTP
   可达，但不把这些公共路径的回执冒充订阅验证通过。

配置了 HTTPS proxy 时，仅通过固定的 Cloudflare DNS-over-HTTPS endpoint
查询 callback 主机名；无 callback 路径、参数、签名或事件正文进入 DNS。
直接连接时维持系统 DNS。所有回答仍须是合法公网 IP，任一私网回答会拒绝。
连接 proxy 时 CONNECT 使用已验证的数值 IP，Host/SNI/证书校验保留原域名。
不跟随重定向，不关闭证书校验，不在代理失败后偷偷直连，不接受事件提供代理。

原型测试发现 Node 22.22.3 的 native proxy agent 在 CONNECT 回收与状态
交接处有异常边界；最终改用核心 HTTP CONNECT、显式 TLS 握手和独立 socket
生命周期管理，无新增依赖。证书身份校验使用原回调域名，而不是 CONNECT IP。

还验证并处理了 CONNECT 前的超时：ClientRequest 尚未拥有 pending tunnel
socket 时，request.destroy() 不能单独保证终止；现在同时约束原始 pending
socket、连接超时及总截止时间。TLS 后回执不明不自动切 IP 重发 POST，
继续依赖持久化 outbox 的同一 event ID 恢复。

## 测试与限制

新增34项：真实本地 CONNECT+TLS、Host/SNI和数值IP固定、证书/名称不匹配、
私网/混合DNS回答、代理拒收、无直连回退、重定向、回应大小、静默/持续输出
的CONNECT截止时间、NO_PROXY与大小写代理配置、DNS错误/类型/去重。
测试证书只在隔离临时目录生成并删除，不影响系统信任。

完整回归21个文件、226/226通过。第一次独立审查发现代理拒收后的pending
socket回收以及502/504前置失败切换问题，已修复并加入真实代理测试；改为
显式CONNECT/TLS后第二次只读审查未发现可操作回归，类型检查通过。实际
运行期测试由主执行器完成，不能把审查环境的只读限制说成运行期测试成功。

公开文档只把 MCP events/subscribe 定义为平台向插件服务器发起的协议。
另有 Workspace Agents trigger REST API，但目标是已发布 agent channel，
并使用 Workspace Agent access token，不是任意个人普通 Chat 的创建接口。
未确认个人 Chat Tasks 存在稳定、可凭普通 OpenAI API key 调用的公开创建 API。

来源：
- https://developers.openai.com/plugins/build/mcp-events
- https://developers.openai.com/workspace-agents/trigger-runs
- https://developers.openai.com/workspace-agents/authentication
- https://nodejs.org/api/https.html
- https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/

## 端到端验收（待追加实际结果）

修复后的平台创建、真实 callback 验证、事件投递、新 run、文件读取以及清理
必须分别记录。Work 成功不自动证明普通 Chat 可作为事件运行目标。
