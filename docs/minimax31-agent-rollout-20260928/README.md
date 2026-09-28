# MiniMax M3 → M3.1 Flash：本机 agent 迁移（2026-09-28）

用户在完成模型接入和冻结指纹后，明确要求将仍使用 M3 的本地 agent 切到 M3.1 Flash，并按纯手搓→混合顺序做教室场景测试。

## 已生效的模型切换

目标引用：`minimax/MiniMax-M3.1-Flash-Preview`。通过 OpenClaw 原生 `config patch` 先 dry-run 再一次验证写入；原始完整配置只在主机私有备份目录保存，本仓不包含凭据/完整运行配置。配置支持热加载，未强制重启或打断其他任务。

明确修改主模型的 15 个 agent：

`mala`, `zero-producer`, `zero-designer`, `zero-artist`, `zero-reviewer`, `reader-r01`, `reader-r04`, `reader-r06`, `reader-r08`, `reader-r10`, `hunter`, `index`, `huabi`, `yinzhang`, `wenshi`。

全局默认主模型和读图模型同时切换，因此 `chatgpt-web-agent` 等继承默认的本地入口也使用新引用。这不改变网页 ChatGPT 本身的模型。`huoshan` 的 GLM 主模型保持不变，仅将旧 `volcengine/minimax-m3` fallback 替换为已经验证的 MiniMax 官方订阅通道 M3.1 Flash；未虚构火山平台的 M3.1 模型 ID。其他 provider 主模型、M2.7 fallback、工具权限、渠道和调度配置不变。

旧 M3 模型目录、别名/参数与冻结测试保留供明确选择和历史复现，不做全仓字符串改名。旧会话中最后实际使用的 model 字段不伪造；数十天前的已结束 subagent 测试 override 不作为当前 agent 默认迁移对象。

## 定时任务显式模型锁定

以下四项仅变更 payload.model，逐项核验 schedule/enabled/agentId/sessionTarget/delivery 和其他 payload 字段不变：

- `health-check-index` (`d39effb2-6788-4b73-bd69-b46d4d7a46e7`)
- `librarian-daily-scan` (`77a40465-0825-495d-8c61-cce231bb1720`)
- `check-qmd-issue-735-daily` (`daa28d3f-f363-4d29-bd09-d02627d2f757`)
- `librarian-weekly-summary` (`3987a894-ae4f-44f9-8193-477c2ce8ac21`)

全量调度列表复查，没有剩余 M3 显式 payload.model。没有创建额外周期任务，也没有手动触发上述工作。

## 实际验收

- dry-run schema 与引用可解析性通过；写入后 `openclaw config validate` 通过。
- 完整配置差异仅包含19个预期叶路径；没有无关配置改动，当前 agent 的 model/imageModel/subagents/heartbeat 中没有剩余 M3 运行引用。
- 原生 agents list 和常驻 Gateway models.list 核对新模型可用，默认思考为 max。
- 常驻 Gateway 的全新 mala smoke **没有传 --model 或 --thinking 覆盖**，实际返回 `MiniMax-M3.1-Flash-Preview`、`max`、`fallbackUsed=false`，文本为 `M31_ROLLOUT_OK`。这补上了上次发布报告里未跑通的常驻回合边界，但它是无工具 smoke，不冒充文件工具测试。
- 原有 Feishu DM 空 allowlist 警告仍在，本次不改变通讯权限来消除它。

详见同目录机器可读证据。完整会话、私有备份、凭据与运行配置不提交。

## 教室测试登记

执行者为 mala 的全新 OpenClaw headless 实例；两模式使用不同工作目录和 SQLite 会话状态，不读取旧答案或彼此结果。题目为 classroom-v1/1.0.0，冻结 benchmark revision `432830eb5bb2364869c0b3a3c05e231041347813`，五档中固定 max，每模式3600秒预算；顺序 from-scratch 然后 mixed。

操作者先生成外部合同与过滤输入包，两个包均通过公开校验。纯手搓不包含预制 assets；混合保留题目允许素材但不强制使用比例。输入文件只读，native 文件工具 workspaceOnly；没有宣称提供了 OS namespace 级隔离。两次答案及独立检查/视觉/来源审阅应归档到 `Agents/agent-evals-minimax` 的新 run 目录。登记信息见 `classroom-registration.json`；本报告不将登记或启动视为测试完成。
