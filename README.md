# chatgpt-web-agent

让 ChatGPT 网页端通过 OpenAI Secure MCP Tunnel 使用本机工具的本地 MCP 胶水层。

这是一个可运行的参考实现，而不是追求一键安装的成品；它主要用于分享一条实际验证过的接入思路，使用者可以借助 Agent 按自己的本地环境快速适配。

项目自己的 MCP 接口保持稳定，真实工具由可替换的 `LocalToolBackend` 提供。首个 backend 直接复用 OpenClaw Plugin SDK，不修改 OpenClaw 源码，也不重新实现文件、Shell、补丁和后台进程工具。

## 当前状态

P0 提供四个 OpenClaw 工具：

- `read`
- `exec`
- `process`
- `apply_patch`

可选启用 Google Drive 文件交换工具：

- `drive_list`
- `drive_search`
- `drive_stat`
- `drive_upload`
- `drive_download`
- `drive_export`
- `drive_mkdir`

默认启用两个只读 OpenClaw Skills 工具：

- `skills_list(query?, limit?)`
- `skill_read(name)`

`skills_list()` 返回当前 eligible + model-visible Skill 的紧凑名字目录；带自然语言 `query`
时可通过独立 QMD collection 返回少量候选的名字和描述。`skill_read` 只接受 Skill 名称/key，
canonical `SKILL.md` 路径始终由实时 OpenClaw `skills.status` 解析，不接受客户端提供文件路径。
MCP initialize instructions 还会提示客户端：仅当任务明显可能依赖本地工具、服务、工作流或操作规范且当前上下文不足时主动发现 Skill；普通自包含任务不查询 Skill。

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
      → SkillsBackend → OpenClaw Gateway (live status)
                      → QMD MCP (optional semantic discovery)
      → NativeBackend / other backend（后续按需）
```

Skills backend 只做 capability discovery/read；QMD 仅是候选检索加速器，实时 OpenClaw inventory
始终是 eligibility、model visibility 和 canonical Skill 路径的事实源。

### Skills semantic discovery

推荐把 semantic catalog 放在独立 QMD named index，而不是共享 memory index。QMD 2.5.3 的 vector ANN 会先在整个 index 取候选、再应用 collection filter；把几十条 Skill 混进数万条 memory 文档会让小 collection 被全库候选淹没。

当前部署使用：

```text
local catalog: <workspace>/skills-catalog/
M4 mirror:     ~/qmd-data/skills-chatgpt-web-agent/
QMD index:     skills-chatgpt-web-agent
collection:    skills-chatgpt-web-agent
MCP endpoint:  http://192.168.0.96:8182/mcp
```

检索使用 Qwen3-Embedding-0.6B、vector-only、`rerank=false`，不做 query expansion / HyDE。QMD 命中只是候选；返回前仍与 live `skills.status` 取交集。catalog schema/inventory 通过 `catalogHash` 做 generation 失效，QMD 不可用或 catalog stale 时自动回退到 live names-only catalog。

## Google Drive

Drive 是可选的数据通道，不做后台同步、磁盘挂载或整盘镜像。实现直接使用 Google Drive API v3，MCP 只暴露小而稳定的文件操作原语。

默认情况下，Drive 的本地上传/下载/导出路径只能位于：

```text
<CHATGPT_WEB_AGENT_WORKSPACE>/exchange
```

该限制独立于 `CHATGPT_WEB_AGENT_WORKSPACE_ONLY`，用于降低 Drive 工具被误用为任意本地数据外传通道的风险。确有需要时可由部署者通过 `CHATGPT_WEB_AGENT_DRIVE_LOCAL_ROOT` 和 `CHATGPT_WEB_AGENT_DRIVE_LOCAL_ROOT_ONLY` 调整。

### 一次性 OAuth 配置

1. 在 Google Cloud 中启用 Drive API，并创建 Desktop OAuth client。
2. 将下载的 OAuth JSON 保存为：

   ```text
   <workspace>/.credentials/google-drive/credentials.json
   ```

   或设置 `CHATGPT_WEB_AGENT_DRIVE_CREDENTIALS` 指向其他本地私有路径。
3. 运行：

   ```bash
   CHATGPT_WEB_AGENT_WORKSPACE=/path/to/workspace pnpm drive:auth
   ```

   浏览器授权完成后会生成权限为 `0600` 的 authorized-user token。OAuth client secret 和 refresh token 不应提交到 Git，也不会通过 MCP 返回。
4. 启动服务时设置：

   ```bash
   export CHATGPT_WEB_AGENT_DRIVE_ENABLED=true
   ```

Drive 工具中的 `folderId` / `fileId` 直接使用 Drive API ID。普通二进制文件使用 `drive_download`；Google Docs/Sheets/Slides 使用 `drive_export` 导出到指定 MIME type。
