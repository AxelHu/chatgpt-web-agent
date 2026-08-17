# chatgpt-web-agent

让 ChatGPT 网页端通过 OpenAI Secure MCP Tunnel 使用本机工具的本地 MCP 胶水层。

项目自己的 MCP 接口保持稳定，真实工具由可替换的 `LocalToolBackend` 提供。首个 backend 直接复用 OpenClaw Plugin SDK，不修改 OpenClaw 源码，也不重新实现文件、Shell、补丁和后台进程工具。

## 当前状态

P0 提供四个工具：

- `read`
- `exec`
- `process`
- `apply_patch`

默认只允许文件和补丁工具访问配置的 workspace；`exec.workdir` 也必须位于 workspace 内。OpenClaw 内部的 `host/security/ask/node/elevated` 参数不会暴露给 MCP 客户端。

对于仅授权给可信 ChatGPT workspace 的独立 Connector，可以设置
`CHATGPT_WEB_AGENT_WORKSPACE_ONLY=false`，此时 workspace 只是相对路径和默认 cwd 的落点，
`read/apply_patch/exec.workdir` 可以访问外部绝对路径。该模式不是安全沙箱。

> `exec.workdir` 边界不是命令沙箱。获得 `exec` 权限的客户端仍可能在命令文本中访问系统其他位置；只应把 Tunnel 授权给可信的 ChatGPT workspace，并按需要使用 OpenClaw 的 allowlist/approval 策略。

## 开发

要求 Node.js 22.22.3 或兼容的 OpenClaw Node 版本，以及 pnpm。

```bash
pnpm install
pnpm check
pnpm smoke
```

## 运行

```bash
export CHATGPT_WEB_AGENT_WORKSPACE=/path/to/workspace
# 可信独立 Connector 如需把 workspace 仅作为默认工作目录：
# export CHATGPT_WEB_AGENT_WORKSPACE_ONLY=false
pnpm build
node dist/cli.js
```

服务使用 MCP stdio，标准输出只承载 MCP 协议。

### 配置

复制 `.env.example` 查看可用环境变量。默认工具白名单为：

```text
read,exec,process,apply_patch
```

`exec` 默认使用 `allowlist + on-miss`。可以显式覆盖：

```bash
export CHATGPT_WEB_AGENT_EXEC_SECURITY=allowlist
export CHATGPT_WEB_AGENT_EXEC_ASK=on-miss
```

进行本机受信任的初次 smoke 时，可临时使用：

```bash
export CHATGPT_WEB_AGENT_EXEC_SECURITY=full
export CHATGPT_WEB_AGENT_EXEC_ASK=off
```

## 架构

```text
ChatGPT Web
  → OpenAI Secure MCP Tunnel
  → chatgpt-web-agent MCP Server
  → LocalToolBackend
      → OpenClawBackend
      → NativeBackend / other backend（后续按需）
```

Google Drive 数据交换将在核心 MCP 链路之后接入；Skills 延后。
