# Claude 接入 WebAgentTools

## 2026-11-11 验收状态

公网服务和三个新 systemd 服务已部署。14 项定向测试通过；经显式代理完成真实公网 OAuth、16 工具枚举、文件写读、后台任务查询、刷新后调用和撤销后 401，测试授权与临时文件均已清理。[不含凭据的验收回执](../../docs/claude-connector-live-20261111.json)记录准确范围。

**用户 Claude 账号内的连接尚未完成。** 当前已代理的 Firefox 停在 Cloudflare 人机验证页，且该浏览器没有已有 Claude 登录态。需用户完成验证并登录其已经注册的账号，再按下述入口添加连接器；尚未声称 Claude 聊天中的真实工具调用通过。

## 使用入口

在 Claude 网页或桌面端的 **Customize → Connectors → Add custom connector** 添加：

- 名称：`WebAgentTools`
- Remote MCP server URL：`https://sites.axelhu.com/agent-access-claude/mcp`
- 认证：OAuth / Sign in now；使用自动注册（DCR）。OAuth client ID 和 secret 留空。
- 传输：Streamable HTTP，保留自动选择。

首次 Connect 会打开自有 Agent Access 授权页，显示一次性配对码。只批准自己刚打开的页面上显示的请求；先查看其 client、回调和 resource，再在家中 WSL 运行：

```bash
cd /home/axelhu/.openclaw/workspace-chatgpt-web-agent/projects/chatgpt-web-agent
python3 infra/agent-access-tunnel/ops/home/claude-access-admin.py pairings
python3 infra/agent-access-tunnel/ops/home/claude-access-admin.py approve XXXX-XXXX
```

批准后授权页会返回 Claude。Claude 持有和自动刷新自己的凭据，普通新聊天、工具进程重启或隧道短时断线不需要重新配对。当前 refresh token 每次使用后旋转，有效期为滚动 30 天；长时间不使用而过期、主动撤销或客户端丢失凭据时需要重新连接。撤销某个授权：

```bash
python3 infra/agent-access-tunnel/ops/home/claude-access-admin.py clients
python3 infra/agent-access-tunnel/ops/home/claude-access-admin.py revoke CLIENT_ID
```

OAuth 页面与 MCP 工具都不会显示 access/refresh token。首次授权不是公开注册本机执行权限；只有受信任的本机管理员批准才会得到权限。

## 当前套餐与官方 tunnel

2026-11-11 查阅的 Claude 官方文档明确：Free 可添加 **1 个自定义远程连接器**。本入口在一个连接器中提供全部基础工具，不需要按工具分别占名额。

Claude.ai 官方 MCP tunnels 是 Enterprise research preview；Claude Console/API 的 tunnel 不能直接给 Claude.ai 账户使用。因此这里复用已有腾讯云 HTTPS 入口和家中向外建立的 SSH 反向隧道。

## 部署结构

| 层 | Claude 专用配置 |
| --- | --- |
| 公网 MCP | `https://sites.axelhu.com/agent-access-claude/mcp` |
| OAuth issuer | `https://sites.axelhu.com/agent-access-claude` |
| 腾讯云网关 | `agent-access-claude.service`，`127.0.0.1:3251` |
| 腾讯云源码 | `/opt/agent-access-claude/current/gateway` |
| 腾讯云状态 | `/var/lib/agent-access-claude`；SQLite、密钥由服务用户保存 |
| 家中反向隧道 | `agent-access-claude-tunnel.service`，远端回环 `18792` → 家中回环 `18792` |
| 家中 MCP | `agent-access-claude-mcp.service`，`127.0.0.1:18792/mcp` |
| 工具执行 | 复用 `chatgpt-web-agent-exec-runtime.service` |
| 本地日志 | `~/.local/state/agent-access-claude/{request-ledger,full-trace}` |

三个平台的公网认证和 MCP frontend 分开；底层工作区与 exec/process runtime 共享，所以后台进程可在连接器重连后继续查询。当前 ChatGPT `18790` 与 MiniMax `18791/3250` 保留原服务及状态。

入口提供 16 个工具：文件读取/补丁、命令/后台进程、独立救援执行、Skills 发现/读取、7 个 Google Drive 文件工具、飞书目录和消息工具。是否实际执行写入或发送，由当前用户任务与 Claude 的工具权限设置决定。

Claude 不支持 OpenAI 专有的 Events/workflow callback；本 frontend 显式关闭该扩展。长任务使用 `exec` 的后台模式，随后用 `process` 查询，不能将后台完成等同于 Claude 会自动唤醒。

## 代理

访问 Claude 的用户浏览器必须走已配置的本地代理。此次检查的 Firefox 主 profile 使用 PAC：B 站相关域名直连，其余域名返回 `SOCKS5 localhost:1080`，没有 `DIRECT` 回退。对 Claude 的程序化外网请求显式使用 `http://127.0.0.1:1080`，禁用对 Claude 的 NO_PROXY 例外。

家中 Claude MCP 服务配置同一 HTTP/HTTPS 代理和 SOCKS5 ALL_PROXY；localhost 仍直连。浏览器代理、工具进程外网访问和 Anthropic 云端访问公网 MCP 是三条不同链路。家中代理不会被 Anthropic 云端继承，公网 MCP 自己通过 HTTPS 和 OAuth 保护。

不要依赖仅设置 shell 环境变量就让已有浏览器改代理。实际浏览器的 PAC/启动参数必须单独核实。专门为 Claude 启动的浏览器应采用显式代理，并在代理不可用时失败。

## 运维

家中：

```bash
systemctl --user status agent-access-claude-mcp agent-access-claude-tunnel
curl --noproxy '*' http://127.0.0.1:18792/healthz
```

云端：

```bash
ssh tencent-cloud-2 'systemctl status agent-access-claude; curl --noproxy "*" http://127.0.0.1:3251/healthz'
```

未认证访问公网 `/mcp` 应返回 **401**，并带指向 protected-resource metadata 的 `WWW-Authenticate`。health 为 200 只证明进程和隧道；验收还要有 OAuth、真实工具调用和 Claude 客户端结果。

Caddy 需同时处理带前缀的入口与 RFC 8414 根级 discovery 路径。现有云端 Caddy 2.6.2 使用 `skip_log`；2.8+ 改名为 `log_skip`。OAuth 路径不记录 access log，避免授权查询参数和浏览器会话进入日志。不要顺手升级整个 Caddy。

停用时只停止新加的两个家中服务和 `agent-access-claude.service`，并从 Caddy 配置移除 `BEGIN/END CLAUDE_WEBAGENTTOOLS` 标记块后先 validate 再 reload。保留 Claude 状态目录即可恢复原授权。不要停止共享 exec runtime，也不要覆盖其他会话后来修改的整份 Caddyfile；部署前备份只作为对照。

## 参考

- [Claude 自定义连接器、Free 数量与添加步骤](https://claude.com/docs/connectors/custom/add-unlisted)
- [Claude OAuth discovery、PKCE、DCR 和刷新要求](https://claude.com/docs/connectors/building/authentication)
- [Claude MCP 功能、结果大小与调用时限](https://claude.com/docs/connectors/building)
- [Claude 连接器测试](https://claude.com/docs/connectors/building/testing)
- [Claude.ai 官方 MCP tunnel 的适用套餐](https://claude.com/docs/connectors/mcp-tunnels/overview)
