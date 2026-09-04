# chatgpt-web-agent

让 ChatGPT 网页端通过 OpenAI Secure MCP Tunnel 使用本机工具的本地 MCP 胶水层。

这是一个可运行的参考实现，而不是追求一键安装的成品；它主要用于分享一条实际验证过的接入思路，使用者可以借助 Agent 按自己的本地环境快速适配。

项目自己的 MCP 接口保持稳定，真实工具由可替换的 `LocalToolBackend` 提供。首个 backend 直接复用 OpenClaw Plugin SDK，不修改 OpenClaw 源码，也不重新实现文件、Shell、补丁和后台进程工具。

## 当前状态

核心工具包括四个 OpenClaw 工具：

- `read`
- `exec`
- `process`
- `apply_patch`

当前 OpenClaw 依赖固定为 `2026.8.2`。对应公共合同里 `exec` 使用
`timeoutSeconds`（秒），而 `process.poll.timeout` 仍使用毫秒；下方独立的
`rescue_exec.timeout` 也仍是它自己的秒制参数，不与 OpenClaw `exec` 混用。

以及一个由 MCP server 自己直接执行、独立于 OpenClaw Gateway/runtime 的救援工具：

- `rescue_exec(command, workdir?, env?, timeout?)`

`rescue_exec` 只用于普通 `exec` 不可用、卡住或怀疑 OpenClaw 执行路径异常时的短命诊断/修复。
它同步执行，默认 15 秒超时、最长 60 秒，不支持 `background` / `yieldMs` / `pty`，也没有
`process` session。它不是自动 fallback：普通 `exec` 失败后不得自动用 `rescue_exec` 重试同一命令，
因为结果返回失败并不等价于原命令没有产生副作用。

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

可选启用两个飞书专用工具：

- `feishu_message(target, message?, mentions?, mediaPath?, asVoice?)`
- `feishu_directory(kind, query?, target?, limit?, pageToken?)`

`skills_list()` 返回当前 eligible + model-visible Skill 的紧凑名字目录；带自然语言 `query`
时可通过独立 QMD collection 返回少量候选的名字和描述。`skill_read` 只接受 Skill 名称/key，
canonical `SKILL.md` 路径始终由实时 OpenClaw `skills.status` 解析，不接受客户端提供文件路径。
MCP initialize instructions 还会提示客户端：仅当任务明显可能依赖本地工具、服务、工作流或操作规范且当前上下文不足时主动发现 Skill；普通自包含任务不查询 Skill。

Skills 与 Feishu 是窄范围的 Gateway-direct helper。如果 OpenClaw Gateway 开启 token auth，
部署时需要显式给它们同一份 Gateway token。长期服务推荐使用
`CHATGPT_WEB_AGENT_GATEWAY_TOKEN_FILE` 指向 `0600` 的普通文件；也支持
`CHATGPT_WEB_AGENT_GATEWAY_TOKEN`，但不建议把 token 内联到 systemd/Tunnel 命令行。

飞书接口刻意不复用通用 `message` 工具的宽 schema。发送账号由部署配置固定，调用方不能选择
`accountId`；目标必须显式使用 `chat:oc_...` 或 `user:ou_...`。`feishu_directory`
用于发现群、用户、群成员与 OpenClaw named Feishu bots，并返回可以直接用于后续调用的 target / mention 数据。

默认只允许文件和补丁工具访问配置的 workspace；`exec.workdir` / `rescue_exec.workdir` 也必须位于 workspace 内。OpenClaw 内部的 `host/security/ask/node/elevated` 参数不会暴露给 MCP 客户端。

对于仅授权给可信 ChatGPT workspace 的独立 Connector，可以设置
`CHATGPT_WEB_AGENT_WORKSPACE_ONLY=false`，此时 workspace 只是相对路径和默认 cwd 的落点，
`read/apply_patch/exec.workdir/rescue_exec.workdir` 可以访问外部绝对路径。该模式不是安全沙箱。

> `exec.workdir` / `rescue_exec.workdir` 边界不是命令沙箱。获得 shell 执行权限的客户端仍可能在命令文本中访问系统其他位置；只应把 Tunnel 授权给可信的 ChatGPT workspace。`rescue_exec` 与 MCP server 使用同一个普通 OS 用户，不提供 sudo/root，也不会默认继承 SSH agent、proxy、OpenClaw runtime 等环境；它只继承 PATH/HOME/USER/locale/XDG/DBus 等必要环境，再叠加调用方显式传入的 `env`。

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
# 长期运行；生产环境建议使用 ops/systemd/chatgpt-web-agent-exec-runtime.service
node dist/exec-runtime-cli.js
# 另一个进程/终端中启动 MCP bridge
node dist/cli.js
```

服务使用 MCP stdio，标准输出只承载 MCP 协议。

`exec` / `process` 仍直接复用 OpenClaw Plugin SDK，但由独立的本地 exec runtime 持有进程
registry 和 supervisor；MCP bridge 只通过 Unix socket 转发这两个工具。因此 Tunnel/MCP bridge
重启不会丢失正在运行的 background session。8.2 wrapper 使用 exec-runtime protocol v2，
会拒绝旧 v1 frontend/runtime 混连，避免 `exec.timeout` 与 `exec.timeoutSeconds` 静默错配。
exec runtime 自身重启时不承诺恢复旧 session；
systemd 应负责自动拉起 runtime，并通过 control group 清理旧子进程，避免 orphan。

### 本地诊断日志

默认同时保留两层 7 日诊断数据：

- `~/.local/state/chatgpt-web-agent/request-ledger/YYYY-MM-DD.jsonl`：64 MiB 上限的紧凑调用索引，适合按 `callId` / `sessionId` / phase 快速 grep。
- `~/.local/state/chatgpt-web-agent/full-trace/YYYY-MM-DD.jsonl`：完整 MCP/tool request、response、error 与跨 exec-runtime 阶段事件；历史日期自动 zstd 压缩为 `.jsonl.zst`，默认总上限 2 GiB。

full trace 以排障完整性为优先：普通 command、patch、文本输出、文件内容、Drive/Skills/Feishu 参数与响应都会保留。只对 `Authorization` / Cookie / token / password / API key / private key 等明确凭据做窄范围遮蔽，并把 image/base64/二进制大块替换为长度与 SHA-256，避免无诊断价值的日志膨胀。所有日志目录/文件分别使用 `0700` / `0600` 权限，过期清理由写入进程自动完成。

### 诊断日志

Web Agent 默认写一份轻量 request ledger 到
`~/.local/state/chatgpt-web-agent/request-ledger/YYYY-MM-DD.jsonl`。它只记录请求阶段、MCP
JSON-RPC id、本地 call id、tool/action/sessionId、等待时间、耗时、结果大小和错误类型等元数据；
不会复制 `exec.command`、工具输出正文、文件内容或消息正文。默认保留 7 天，且总量上限为
64 MiB。可用 `CHATGPT_WEB_AGENT_REQUEST_LEDGER_*` 环境变量调整或关闭。

独立 WebAgent Rescue 服务同时原样镜像目标 Tunnel 的 journal，默认按天保留 7 天并设置
192 MiB 总量上限。两层合计的持续诊断日志预算约为 256 MiB；事故 snapshot 独立保存，不受
日常日志轮转影响。排障时可用时间戳 + MCP request id 将 Tunnel journal 与 request ledger 对齐，
判断一次调用停在 Tunnel→MCP、wrapper→exec-runtime、OpenClaw 执行还是 response 写回阶段。

### 配置

复制 `.env.example` 查看可用环境变量。默认工具白名单为：

```text
read,exec,process,apply_patch,rescue_exec
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

## 推荐工作流：监工会话 + 工作会话

对于需要持续推进的数学研究、工程开发等长任务，推荐把普通工作会话与一个轻量的独立监工会话分开：工作会话保留项目上下文并实际干活，监工会话通过统一 Scheduled Task 定期读取真实状态，只对 idle 的正常任务发送极短继续提示，并把疑似会话触顶、项目/重大阶段完成、需要用户决策或持续工具故障等高信号情况通过飞书升级给用户。

详见 [`docs/supervised-chat-workflow.md`](docs/supervised-chat-workflow.md)。

## 架构

```text
ChatGPT Web
  → OpenAI Secure MCP Tunnel
  → chatgpt-web-agent MCP Server
  → LocalToolBackend
      → OpenClawBackend → read / apply_patch
      → ExecRuntimeClientBackend
          → local Unix socket
          → persistent exec runtime
              → OpenClawBackend → exec / process
      → RescueExecBackend → local /bin/bash (direct spawn, no OpenClaw)
      → SkillsBackend → OpenClaw Gateway (live status)
                      → QMD MCP (optional semantic discovery)
      → FeishuBackend → OpenClaw Gateway (message + directory)
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

### 大文件与视觉产物交接

`read` 适合小文本、小图片和本地快速检查；需要跨会话交接的大型视觉/二进制产物默认走 Google Drive。多 MB 图片、视频、压缩包等应直接视为 Drive-first；约 1 MiB 以上可以作为偏保守的运维切换参考，但这不是协议硬限制。

如果较大的图片/文件通过 `read` 已出现 connector 502、timeout 或类似传输错误，不应反复重试同一个 inline payload。保留原始产物不变，在需要上传时将其复制到 Drive staging root（默认 `<workspace>/exchange`），记录原始本地路径以及必要的 checksum/provenance，然后使用 `drive_upload` 放到明确的 task/exchange folder。接收会话通过 `drive_search` / `drive_list` 定位，`drive_stat` 验证元数据，再用 `drive_download`（或 Google-native 文件的 `drive_export`）恢复原件。

可以额外制作较小的 JPEG/PNG preview 用于快速视觉检查，但 preview 不替代原件。base64 不作为常规跨会话大文件协议：它会放大传输体积，也让文件 provenance 比普通 Drive 文件交接更难维护。

## 飞书消息

飞书是可选的主动外发通道，默认关闭。推荐为 Web Agent 创建独立的 OpenClaw agent + 飞书
account，并固定使用同一个 ID，例如：

```text
OpenClaw agent:   chatgpt-web-agent
Feishu account:   chatgpt-web-agent
```

配置好对应飞书应用后，将该 account 绑定到 agent，再启用 backend：

```bash
openclaw agents bind --agent chatgpt-web-agent --bind feishu:chatgpt-web-agent
export CHATGPT_WEB_AGENT_FEISHU_ENABLED=true
```

`feishu_message` 不接受 `accountId` / `channel` 参数。每次调用还会先通过 OpenClaw Gateway 的
`channels.status` 检查固定 account 是否精确存在、已配置且未禁用；检查失败时不会进入发送/目录
action，因此不会在目标账号缺失时借用 `main` 或其他 agent 身份。

发送目标必须显式指定：

```text
群：chat:oc_...
人：user:ou_...
```

文本消息可传 `mentions=[{openId:"ou_...", name:"..."}]` 生成飞书原生 @ 提及。
图片、文件、音频通过 `mediaPath` 发送；`asVoice=true` 可将音频作为语音消息发送。默认情况下
本地媒体路径只能位于 `CHATGPT_WEB_AGENT_FEISHU_MEDIA_ROOT`（默认 workspace）内部，且会检查
真实路径以阻止 `..` 与 symlink 逃逸。OpenClaw Gateway 自己的 agent-scoped media root policy
仍会再次校验，因此如果部署者把该目录改到 OpenClaw 不允许的范围，请求仍会失败而不是扩大权限。

`feishu_directory` 支持四类发现：

- `kind="groups"`：群列表/名称查询，返回 `chat:oc_...` target；
- `kind="peers"`：可见用户查询，返回 `user:ou_...` 和可直接复用的 mention；
- `kind="members"`：指定 `chat:oc_...` 后列出群成员及 open_id，支持分页。
- `kind="bots"`：通过 OpenClaw `channels.status(probe=true)` 查询 named Feishu bot 身份，按 account/name 搜索并返回可直接用于 `mentions` 的 `botOpenId`；仅投影 account/name/open_id/运行状态等安全字段，不返回 app secret。未显式传 `limit` 时默认覆盖当前配置允许的完整小型 bot 目录。

飞书的群成员 API 不返回机器人成员，因此需要 @ 其他 OpenClaw agent 时应使用 `kind="bots"`，而不是依赖 `kind="members"` 查找机器人。

实现复用正在运行的 OpenClaw Gateway，而不是读取飞书 `appSecret` 或自行维护 token。当前只提供
主动外发和目录发现，不接收飞书入站消息；入站到 ChatGPT 网页会话的路由需要单独解决“绑定到哪个
网页会话”的生命周期问题。
