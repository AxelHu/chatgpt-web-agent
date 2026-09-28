# MiniMax M3.1 Flash 发布接入与验收（2026-09-28）

## 运行版本与使用入口

精确模型标识是 `MiniMax-M3.1-Flash-Preview`；OpenClaw 引用 `minimax/MiniMax-M3.1-Flash-Preview`，别名 `minimax-m31-flash`。它是显式可选的新模型，现有 M3 默认、其它模型历史请求和其它 agent 的个别限制保持不变。

官方契约：<https://platform.minimax.cn/docs/api-reference/text-anthropic-api>（2026-09-28 核验）。支持 `low / medium / high / xhigh / max` 五档原生思考，省略为 `max`；固定 adaptive thinking，不能关闭。Anthropic Messages 的档位位于 `output_config.effort`，不是 `thinking.type`。文本、图片、视频和完整 assistant 工具历史都受支持；1,000,000 是模型上下文。当前预览限 Token Plan/MiniMax Code，不改用 PAYG 或其它账户。

OpenClaw 的 32,768 输出上限是本地保守配置，不是上游最大输出能力；订阅模型的零成本字段是账务占位，不是免费推理。

### 本机实际部署

代码提交 `7d3c40768e8e7c4b65d3ab47bca38e72dd3561b7` 已快进至 `/home/axelhu/openclaw-local` 的既有 `upgrade/v2026.8.2-local` 分支。使用完整构建产物，12,372 个文件逐一核对 SHA-256。构建身份为 `OpenClaw 2026.8.2 (7d3c407)`。

通过等待活动任务排空的原生 restart 路径重启，未强制终止活动任务；随后 readyz/healthz 正常。原始二进制和配置备份留在主机私有备份目录，不复制到本仓。MCP/exec runtime 保持独立，没有重启以规避工具检查。

新增 provider 模型定义、默认模型元数据/别名和**仅一个**明确的模型引用白名单条目。新版本里 `agents.defaults.models` 只存别名和参数，已有非空 `agents.defaults.modelPolicy.allow` 时还必须把精确模型引用追加进去；添加别名不会自动修改这个名单。本机已从 6 个引用变为 7 个，既有条目、默认模型、其它 agent 的独立 policy 均保持原样，未加入 provider 通配符、未清空名单。

常驻 Gateway 的 `models.list` 已实际返回新模型、`available=true`、五档 `thinkingLevels`、`thinkingDefault=max` 和别名。见 [目录验收](gateway-catalog-proof.json) 和 [配置差异验收](openclaw-model-policy-proof.json)。

### 验证边界

已构建 CLI 的独立真实工具回合覆盖全部五档，每档完成两次工具读取，返回模型和输出均核验通过，见 [五档工具证据](openclaw-isolated-tool-proof.json)。另外追加的“重启后通过常驻 Gateway 运行一个整回合文件读取”探针，在本次 Chat 工具检查层被拦于执行前；同工具、同身份、同参数间隔尝试共六次，未创建 dispatch 文件、未发任何模型请求，未改用另一身份或代理绕过。它没有被计为成功，见 [原始拦截说明](gateway-agent-probe-blocked.json)。这不抹去已经完成的独立 CLI、原生 HTTP、配置和 Gateway 目录证据，也不等于提供方拒绝请求。

## 仓库交付

| 仓库 | 改动范围 | PR / 状态 | 验证 |
|---|---|---|---|
| OpenClaw 本地 fork | 目录、动态模型、五档原生思考、agent/direct-completion、历史回放 | 本机已安装 `7d3c407`；可移植补丁见下 | 210 tests / 13 files；完整 build 通过 |
| Agents/llm-canary | 通用 runner、扰动/glitch、可靠采集/恢复、五档基线 | #36 已合并；main `efcb7d6` | 全套 373 passed；定向 51 passed |
| Agents/scene-building-benchmark | visual consensus 原生 effort、实际模型标识与界面参数 | #8 已合并 | 56 passed |
| GameStudio/ai-research | 多模态共识、场景评审、Spritepack stage 参数传递 | #185 已合并 | 定向 30 passed；low/max 图像计数各一次正确 |
| GameStudio/keyforge-lab | 明确模型/effort、独立账本、返回身份、可回放决策 | #32 已合并 | 1,198 passed；五档 10/10 真实开局决策 accepted |
| GameStudio/llm-town-lab | 原生 effort、工具历史、服务档与 smoke 元数据 | #94 已合并；main `858632b` | 全套 943 passed / 1 skipped；定向 48 passed；low/max 原生工具往返通过 |

OpenClaw 补丁 [openclaw-m31-flash.patch.gz](openclaw-m31-flash.patch.gz) 以 `55d30509752629b530155dd29d70cd43a4e96a8d` 为基线，仅包含这次 provider 支持；没有恢复已归档的 Gitea OpenClaw 镜像。旧 M3 行为、请求哈希与历史报告不改名。

额外检查了 wordcraft、turtle-soup-lab、chatgpt-sites、multi-agent-skills、chatgpt-desktop-bridge、multimodal 等当前消费者。它们没有本次所需的硬编码 M3 接入点；不为已有通用模型透传路径制造无意义补丁。这不是宣称每个历史仓库都做了新模型端到端评测。

## 已完成的指纹与冻结小测

| 通道 | 样本槽位 | 说明 |
|---|---:|---|
| 行为指纹 | 3,200 | 8 个固定 elicitor × 80 次 × 5 档 |
| 短答案 | 270 | 每档 54 次，机械检查器 |
| 精确输入扰动 v3 | 540 | 每档 108 次，与旧 v2 勘误版本区分 |
| 特殊 token pilot | 426 | low/max 的复制与裸输入；不是 n80 token 正式基线 |

原始计划共 4,436 样本槽位、4,455 次记录的请求尝试。首次请求完整答案为 4,415 个；经过原始有限重试后为 4,421 个。13 个可用性缺口在独立恢复目录中各追加一次请求后补齐。另两个 max 档裸 token 探针耗尽输出上限，保留终止结果，不补采、不当作正确答案。

因此原始加独立恢复共 4,468 次请求，参考集 4,436 槽位中有 4,434 个完整答案。初始化 collector pilot 单独归档，不并入主试验统计。不能把恢复后的完成率写成首次成功率。

| effort | 完整指纹 | 短答案 exact | 扰动 v3 exact |
|---|---:|---:|---:|
| low | 640/640 | 52/54 | 67/108 |
| medium | 640/640 | 51/54 | 82/108 |
| high | 640/640 | 51/54 | 79/108 |
| xhigh | 640/640 | 51/54 | 88/108 |
| max | 640/640 | 51/54 | 86/108 |

五档可加载基线位于 `Agents/llm-canary: canary-data/baselines/minimax-m31-flash-<effort>-n80-2026-09-28/`；原始结果、参考集与执行时源码快照位于 `evaluations/minimax-m31-flash-release-20260928/`。收尾报告为 `reports/minimax-m31-flash-release-20260928.md`。

这些是固定小测的描述性计数，不是总体模型排名。变体重复不能当作独立题目；少量开局决策不是完整对局或胜率；简单计数图不是美术/3D 建模质量评测；行为指纹与 API 返回名均不能证明模型权重身份。

## 可靠性与尚未通过的检查

Canary 在网络前 fsync dispatch intent，再记录原始 receipt；不对未知结果自动重发。预算先为并发请求预留，退出时停止兄弟 worker，避免收集器结束后仍继续发送请求。已落盘结果的恢复只在真的需要发请求时才读取凭据；零缺口、成功已落盘、恢复次数耗尽三种场景均有新回归测试。三项先复现失败、修复后通过；对实际数据的离线恢复没有读取凭据或发请求，30 个冻结文件的 SHA-256 均不变。

OpenClaw 的全仓 changed gate 仍报 6 项已有 plugin compatibility 到期记录；在未修改的基线也同样失败。MiniMax 局部边界、lint、相关类型检查、provider 测试及完整构建通过。不能把这个全仓 gate 写成绿色，也没有删除旧门禁来掩盖失败。

小镇完整回归采用同一提交、同一 944 个测试节点的四组分文件运行，目录互不复用。首次自建分组脚本漏建 pytest 临时目录父目录，导致 setup error；错误回执保留，修正的是启动脚本而不是产品断言。最终结果为 **943 passed / 1 skipped**；跳过项是仓库既有、需 `LLM_TOWN_RUN_YEAR_SOAK=1` 才开启的三种子全年模拟，并非 MiniMax 支持测试。精确节点与结果已归档至小镇仓库和 PR #94；本机 main 已快进同步。

精确机器可读结果见 [verification.json](verification.json) 和 [小镇完整回归](town-regression-summary.json)。

本地主要入口：Canary `projects/llm-canary` 已同步 main `efcb7d6`；小镇 canonical checkout 已同步 main `858632b`。Web Agent canonical checkout 存在其它任务的 README/自定义提示词/恢复文档改动，本次只在专用 worktree 提交此报告，不覆盖或切换那份工作区。

补丁以确定性 gzip 保留 `git format-patch` 的原始字节和标准空行上下文；`verification.json` 同时记录解压前后的 SHA-256。查看补丁可使用 `gzip -dc openclaw-m31-flash.patch.gz`；应用前应核对既定基线，先执行 `git apply --check`。
