# Jev（TypeSafe System One）接入 Claudestra——探索稿

> 状态：**探索中**（owner 2026-09-28「新建一个分支，主要用来集成 Jev，探索相关功能」）。分支 `feat/jev-integration`。
> 参考：`typesafe-ai/skills` 的 SKILL.md（已按官网指引装成 Claude Code 插件 `typesafe@typesafe-ai`）、https://docs.typesafe.ai/llms.txt。

## 1. Jev 是什么、不是什么

- **是**：TypeSafe 的 System One 模型。输入一份 `state`（文本 / JSON）+ 一组**类型化问题**，返回结构化答案：
  `choice`（从给定选项挑一个，带每个选项的概率与 confidence）、`score`（按你定义的有序等级打分，带分布）、`noul`（是 / 否的概率）。
  一次请求可带很多问题，模型只读一遍 state、并行作答；同一 state 上的多个问题**应该合在一个请求里**（官方 cookbook：13 问合一，便宜 12 倍、快 10 倍）。
- **不是**：聊天 / 代码生成模型。不产生文本，不能替代 agent 背后的 LLM。它给的是「代码里缺一块语义判断」时的那一块。
- **接口**：`POST https://api.typesafe.ai/v1/systemone`，`Authorization: Bearer <TYPESAFE_API_KEY>`；JS SDK `@typesafe-ai/sdk`（Node 20+，类型推断答案，默认重试 429/529）。模型 `jev-latest`（= jev-1.13.0）。
- **约束**：只算输入 token，$0.042 / Mtok；限速 250k tok/s、1200 req/min（动态调整中）；64k 上下文（state + 所有问题），state + 最长问题 ≤ 32k；只收文本。
  **英文最好，CJK「能处理但不等同」**——我们的会话几乎全中文，必须在自家数据上测 confidence 后再依赖。
- **安全**：key 只放服务端（bridge `.env`），不进浏览器。Jev 不用客户数据训练。

## 2. Claudestra 里哪些地方缺「一块语义判断」

按「代码掌握流程，Jev 只给判断」的原则，候选如下（★ 为推荐先做）：

| # | 场景 | 现状 | Jev 问题（primitive） | 代码怎么用答案 |
|---|---|---|---|---|
| ★A | **agent 回复分级** | 每条 `api:` 出站回复一律推送 + 未读 +1，owner 分不清「要我拍板」还是「FYI」 | `choice` kind ∈ {needs_decision, asks_question, blocked_or_error, fyi_done}；`score` urgency（Calm / Soon / Now）；`noul` mentions_destructive_action | 推送：只推 needs_decision / blocked / Now，其余合并成静默计数；侧栏未读角标分色；Discord 在 Now 时才 @；低 confidence 一律按「需要看」处理 |
| B | **#control 入站意图路由** | 大总管每条都进 LLM 回合才决定派给谁；LLM-free 按钮另一套 | `choice` target ∈ 各 agent（criteria = purpose + cwd + 最近话题）+ `is_management_command` noul | 高 confidence 直接 `send_to_agent`，省一个 master 回合；低 confidence 照旧交 master |
| C | **peer 入站守门** | peer 请求全靠 agent 自己「超出职责可拒绝」 | `noul` asks_machine_level_change、asks_outside_exposed_scope、contains_credential_request | 命中即在注入头加 ⚠ 提示 / 或先押后并推 owner 一条「peer 想让 agent 做 X，放行？」按钮 |
| D | **排队消息可等性** | held-flush 队列一律等回合结束 | `noul` can_wait_until_turn_ends；`noul` is_interrupt_request | 可中断的（「停」「别做了」）走 interrupt，其余照旧排队 |
| E | **值守 / cron 结果判定** | mission 报告靠 agent 自述 | `choice` status ∈ {progressing, done, blocked_needs_owner, looping}；`noul` claims_done_without_evidence | done → 自动收尾；blocked → 推 owner；looping → 提前停 |
| F | **记忆卫生分类** | save-compact 靠 agent 自己判「长期事实 vs 进度」 | `choice` type ∈ {decision, feedback, reference, guide, progress}；`noul` still_true_in_a_year | progress 不进 mem0；低 confidence 交 agent 复核 |
| G | **技能建议** | 命令面板靠人翻 | 官方 cookbook（182 技能两轮）直接可套 | 输入框旁「可能想用：/xxx」 |

**推荐先做 A**：数据路径现成（event-bus 的出站 `api:` 消息 → 推送派发器 / 未读计数），一个请求 3 个问题，效果可量化（推送条数、误判率），不动 agent 回合，失败降级 = 现状。B 收益大但涉及 master 语义与失误成本；C / D 是安全相关，先在 A 上验证中文 confidence 再说。

## 3. A 的落法（草案）

- `src/lib/jev.ts`：薄客户端（fetch，不引 SDK 也行；带 key 缺失 / 超时 / 429 的降级），纯函数 `buildReplyTriageQuestions()`、`applyTriage(answers, thresholds)` 放 `src/lib/jev-triage.ts` 可单测。
- 接在推送派发前：拿到 kind / urgency / confidence → 决定推不推、推送标题前缀（「⚠ 待决定」「❌ 卡住」）、未读角标类型（新增 `unreadKinds` 字段给侧栏分色）。
- 阈值先取 confidence ≥ 0.6 才按分级走，否则按「需要看」；灰度：先只打日志不改行为（`JEV_TRIAGE=shadow`），跑几天对照 owner 实际点开的记录，再切 `on`。
- 全中文 state：先用 owner 近两周的真实回复样本（bridge 历史）离线跑一遍看 confidence 分布，决定要不要在 state 里附英文 purpose / 问题写英文。
- 成本估算：一条回复平均 ~400 token state + 问题 ~300 → 0.0003 美元 / 条；一天 200 条 ≈ 0.06 美元。

## 4. 未决

- API key：owner 到 https://console.typesafe.ai/keys 取，放 `.env` `TYPESAFE_API_KEY`（doctor 加一项检查）。
- 中文效果未知——第一步就是离线测。
- 隐私：state 里是会话内容，会发到 TypeSafe（无训练、有 DPA）；要不要给 owner 一个总开关（设置 → 实验）。
