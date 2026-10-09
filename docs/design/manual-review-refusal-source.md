# MANREFD1：手动审查被提供方拒审后的正式来源（设计稿）

> 状态：**仅设计与待决边界；不授权实现、豁免、新 writer、新开关或任何提供方/机器权限**。
> 源码基线：`a2b255b2a121623128f8c1a35388efb18df851dd`。本卡只提交本文，不改源码、测试、UISPATH1 的源/步骤/绑定/状态。
> 依赖：MODELX 系列（MODEL / MODELW / MODELX r4 / MODELXW* / MODELXP*）已合入并在本基线可读。
> 修订（MANREFD2，仅本文）：按 `97ae6049` 上的 `cardFacts` / `createRefusalApprovalPort` / `epochFacts` 原文收紧「manual 卡」概括——
> 批准是否「可适用」只看卡的 review/head/spec 与最近匹配 intent，**不读 `workflow.mode`**；epoch 与 manual 合并闸另有门。
> 本修订不新增 writer / 快照 / epoch / 审批 / 接续 / 提供方权限，不关闭 UISPATH1 的独立审查阻塞，也不得被用来派同一被拒材料重试、同族代审或给予新平台权限。

## 1. 问题与口径

UISPATH1 的本轮审查（按 UISPATH1 原规格陈述）由 Code/ACP 审查员**本人以 manual 步骤**领单（take_review），审查中被提供方拒审中止（不可重试），
只留下部分测试进度，没有结构化 verdict。本文不据运行时文字推断拒审类别，不补传原拒绝全文；完整非秘密正式标识留在原证据处，不外发私有工件。现行 MODELX 写口只认**调度服务派出的 review intent** 及其**派出前冻结的材料快照**。
本文回答：这种 manual 拒审现在有哪些正式来源、缺什么；若将来要支持，最小合法形状是什么；哪些情况必须保持阻塞或转获准人工审查。

口径（与 [E2b 盘点](./e2b-current-entry-inventory.md) §1 一致）：
- 「已实现」= 代码与生产调用链存在，不代表当前开启；「设计」= 本文或他文意向，不是可用入口；生产配置/开关实际值**一律未知**。
- 只读本仓库代码、测试与公开设计文档；**未读**任何台账、会话记录、拒审原文、私有报告或配置。UISPATH1 的实例事实
  只按规格陈述与结构推断分列，凡需台账确认的标「待本机核」，不在本文抄录拒审全文或私有工件。
- 推演（§5）只是对现有判据的纸面应用，**不是**已运行 writer 的输出，也不构成豁免。

## 2. 真实入口链（已实现部分）

| # | 环节 | 真实模块 / 符号 | manual 卡是否经过 |
|---|---|---|---|
| E1 | 领审 | `src/lib/review-order.ts` `takeReview` → `reviewSlotFor` | 是：非 auto 分支取 `currentReview(stepsOf)` 当前步骤执行者 = 调用方 agent；单号 `manualOrderId` = `<卡>:<step>:r<round>`（`order-take.ts:41`），**本次 manual 领单不新写 `scheduler_intents`**；卡上若有先前 auto 派审留下的 review intent，它照旧在表里，但不是这张 manual 单 |
| E2 | 交结论 | `review-verdict.ts` `submitVerdict`（幂等键 `verdictKey` = `verdict:<orderId>@<head>`） | 是，但拒审时**没有调用**，故无 verdict 事件 |
| E3 | 提供方失败信号 | `src/bridge/acp-link.ts` `acp_failure` → `ask-runtime.ts` `openRuntimeAsk`（`extra.failure=error`、`sessionId`、`failedAt`） | 仅 ACP 宿主的会话有；tmux/channel 宿主的 Claude Code 会话**没有**结构化失败卡 |
| E4 | 失败分类 | `scheduler-model-outcome.ts` `classifyModelOutcome`：safety（cyber_policy / Claude usage policy / `stop_reason refusal`）优先于 capacity/host；auth、发送未知不可自动恢复 | 纯函数，可对任意文本算；但只有 E5 被调用时才落账 |
| E5 | 模型结果记账 | `recordModelOutcome`（actor 必须 scheduler；`getIntent` 必须是 dispatch/review 意图）；唯一生产调用 `scheduler-auto-tick.ts:329` → `modelOutcomeStep` | **否**：auto tick 不推 manual 卡，manual 单号也不是 intent |
| E6 | 材料快照 | `scheduler-model-wiring.ts` `freezeReviewMaterials` → `writeReviewSnapshot`（intent=review/adversarial_review/pending，head/spec/round 当前，reviewer 绑定 active） | **否（对本次 manual 领单）**：manual 领单不产生 intent 与调度绑定，故不产生它的发送前快照；卡先前 auto 派审若留有快照，只属于那张历史 intent，不覆盖本次 manual 发送 |
| E7 | 批准 port | `recovery-refusal-approval.ts` `createRefusalApprovalPort`（owner 本人答复的 `policy-refusal-rule` / `refusal_rule_exec` ask） | 可读。`cardFacts` **不读 `workflow.mode`**：`content:"allowed"` 当且仅当卡 stage=review、headSHA/specRev 有效，且最近一张 review/dispatch intent 是 action=review 并与当前 head/specRev 一致；否则 `"uncertain"`。故 mode=manual 本身不使其 uncertain——曾有匹配 auto 派审 intent、后改 manual 的卡仍可得 allowed；没有匹配 intent 的 manual 步骤（如 UISPATH1，见 §4）才得 uncertain。allowed 只说明批准事实可适用，**不等于** E8 epoch 或 E11 manual 合并闸放行 |
| E8 | 拒审 epoch | `scheduler-sessions.ts` `beginRefusalEpoch` → `scheduler-review-swap.ts` `applyRefusalEpoch` / `refusalEpochLapse` | **否**：`epochFacts` 要求 scheduler actor、MODEL 记下的 on 模式 safety 计划事件、`workflow.mode==="auto"`、当前窗口、`approvalLapse` 无、原审查单为当前 head/spec 且材料摘要一致、被拒审查员仍是当前绑定；manual 卡在 auto 门即拒，批准 allowed 也绕不过 |
| E9 | 监护处置 | `agent-supervisor.ts` `cyber()`：同会话发 `CYBER_RECOVERY_TEXT` 一次后 report；`refusalYieldsToModel` 只对 auto 派审单且 modelOutcome=on 让路 | 若会话在监护名单且是 Codex 运行时卡，可能触发；**这是现行同会话改述续跑机制，不是拒审来源，也不能被本设计引用为接续** |
| E10 | 池单拒审 | `ledger-pool-refusal.ts`（MODELXP2）：只认出借方 release 的结构化 `failure.class=provider_policy`（`lend-health.ts`） | 否：仅出借池订单 |
| E11 | 合并来源 | `scheduler-merge.ts` `mergeReviewProof`：manual 走 `manualRunReviewer`（PM 的 manual-merge-request 绑定 reviewer/session/family），且 `manual \|\| !exemptVerdict` → **manual 路径一律不收同族例外** | 是：只认真实结构化 PASS/changes 且无 P0/P1 |
| E12 | 待 PM 提醒 | RVWAKE1 `reviewPmCandidate`（`scheduler-review-pm-wait.ts`） | 只在有结构化结论时提醒；拒审无结论 → 无提醒 |

结论：**manual 拒审今天没有任何正式 writer**。E3 失败卡（如存在）是唯一可认证的提供方信号；E5、E6、E8 只服务调度派审；E7 是不看 mode 的只读谓词，其 allowed 不构成任何流程放行。

## 3. 三种来源字段矩阵

| 字段 / 证明 | 自动（MODELX） | 池（MODELXP2） | manual（今天） |
|---|---|---|---|
| 订单标识 | `scheduler_intents.id`（review） | 出借单号 + 租约代数 `gen` | `manualOrderId`；本次领单无持久 intent（卡上历史 auto intent 不是本单） |
| actor / session | `scheduler_sessions` reviewer 绑定 + 会话 | 出借 journal worker / session，签名票据 | 步骤执行者 agent；会话只在 take/submit 时从身份取，**不持久绑定** |
| head / specRev / round | intent 冻结 | 订单冻结 | 只在卡当前状态，无发送时冻结点 |
| 提供方失败来源 | auto tick `observe` 失败 / `unclaimedRefusal` 关联 ACP 失败卡 | release 的结构化 `failure.class` | ACP 失败卡（若宿主是 ACP）；否则**无** |
| 分类器 | `classifyModelOutcome` | `lend-health.ts classOf`（同一分类器） | 可算，未落账 |
| 材料快照（拒审前） | `review_material_snapshot`（dedup `review-materials:<intentId>`） | 池单原文 + 签名摘要 | 本次 manual 发送**无**；历史 auto intent 的快照只证明那次派审 |
| 批准 | `createRefusalApprovalPort` + `approvalLapse` | 同一谓词 | 同一谓词、不看 mode：最近 review/dispatch intent 为同 head/spec 的 review 时 allowed，否则 uncertain；allowed 仍过不了 E8 auto 门与 E11 |
| 正式 writer | `ledger scheduler-model-outcome` / `scheduler-refusal-epoch`（scheduler 身份） | `ledger scheduler-pool-refusal`（scheduler 身份） | **无** |
| 合并认可同族例外 | `exemptVerdict`（crossModel:false 明示） | `poolExemptVerdict` | **不认**（`manual \|\| …`） |

## 4. UISPATH1 当前形态：证明存在 / 缺失

| 证明项 | 状态 | 依据 |
|---|---|---|
| 真实 actor（领单 agent）/ 卡 / head / specRev / round | 存在（待本机核具体值） | 规格陈述；take_review 本身只读、不落账，需由台账步骤与会话记录交叉核 |
| 领单会话 id | 部分：仅可从会话自身记录/失败卡 `sessionId` 取得 | take_review 不写会话绑定 |
| 结构化提供方拒绝信号 | 待本机核：ACP 宿主则应有 `extra.failure=error` 卡；非 ACP 则**缺** | E3 |
| 与普通错误 / quota / auth / 用户停止的区分 | 仅在有失败卡时可由 `classifyModelOutcome` 区分；用户停止不产生失败卡，**不能被推成拒审** | E4 |
| 拒审前材料快照 | **缺**（规格陈述无匹配调度 intent / 发前快照）；manual 领单本身也不会产生 | E6；事后冻结只能证明「冻结时」材料，不能冒称发送前快照，不得倒写 |
| 模型结果事件 / epoch | **缺** | E5 / E8 |
| 有效 owner 批准适用本卡 | **缺**：原因是无匹配 review intent（规格陈述，待本机核），不是 mode=manual 本身；即使适用也不放行 E8 / E11 | E7 |
| 最终 verdict | **缺**；部分测试进度不是结论 | E2 |
| 可用于合并的审查来源 | **缺** | E11 |

因此 UISPATH1 的 manual 旧单**继续不适格**任何接续或豁免（缺匹配 intent、发前快照与最终 verdict）；不得补造 intent、倒写快照或凭已有历史记录（含本卡先前 auto 派审留下的 intent / 快照）冒当前合法；其审查阻塞须保持，直至获得一份新的、合法的独立审查结论（§6.3）。

## 5. 推演：合法与拒绝案例（纸面，不是运行结果）

| 情形 | 推演结论 | 判据来源 |
|---|---|---|
| 调度派审（auto、有快照、owner 批准有效、mode on）被 cyber/usage policy 拒 | 合法当前源：MODELX 记录 → epoch → 换家族一次，`crossModel` 如实 | E5–E8 |
| manual 领审被拒，有 ACP 失败卡，无匹配 intent、无快照 | 只能留证/人工；不得接续或豁免 | 缺 E6；E7 uncertain；E8 auto 门 |
| manual 卡带先前 auto 派审留下的真实匹配 review intent / 快照，本步改 manual 领审被拒 | 逐门按原判据核：E7 可能 allowed（只说明批准事实适用）；E5 不为 manual 单记账，E8 `workflow.mode!=="auto"` 即拒，E11 manual 不收同族例外；历史快照只覆盖那张 intent 的发送，不覆盖 manual 发送。结论：仍只能留证/人工，不推成当前卡获准 | E5–E8、E11 |
| 只有 PM 描述、普通消息、聊天截图说「被拒了」 | 拒：不是可认证的提供方来源 | §3 失败来源列 |
| 失败卡缺 `sessionId` / `failedAt`，或会话与领单人对不上 | 拒：无法证明属于本单本回合（同 `turnFailureDoubt` 口径） | `runtime-failure-audience.ts`、`lend-turn-failure.ts` |
| 拒审后才补冻材料，称作「发送前快照」 | 拒：事后冻结只可标注冻结时刻，永不替代发送前快照 | E6 |
| 旧 head / 旧 specRev / 旧轮次上的拒审 | 拒，仅原窗口留证（同 `STALE_OP` 口径），新 head 不继承 | `recordModelOutcome` stale 分支 |
| 批准已撤销 / owner 挂起 / 批准时间缺失或歧义 | 拒，按无批准 | `approvalGap`、`createRefusalApprovalPort` |
| 普通 error、quota、auth、发送未知、用户停止 | 不是拒审：按原 host/capacity/人工处置，不得改记为 safety | `classifyModelOutcome` |
| 同一材料重复被拒（含改词、同会话「恢复消息」、换会话同模型重试） | 拒：不再尝试同一提供方；第二次豁免后再拒 → 人工 | `planRefusal`、owner 10-06 去掉同模型重试 |
| 改述材料以通过提供方 | 拒：材料变化即 `reviewMaterialCheck` 失败，且属规避安全约束 | E6 |
| 作者自审 / requester 当审查员 / 收件 PM 自审 | 拒：作者独立与请求人判据不变 | `reviewPmCandidate`、manual-merge-request 受理判据 |
| 部分测试进度 + 「看起来没问题」 | 拒：不是 verdict，不得写 PASS | E2、E11 |

## 6. 未来 manual 来源支持（候选，全部待 owner 批准）

### 6.1 不变的前提

- 拒审 ≠ 通过，≠ 换家族授权；不扩大任何提供方的安全许可，不改词、不换会话反复投同一份被拒材料。
- 保留原 routine readonly 范围、有限次数（沿 MODELX：至多一次换家族）、已批准且未撤销的 owner 许可、作者独立、
  安全卡只在本机审（`poolTarget` 拒 security 远端）、材料不变 / 新 head 不继承、当前 epoch、非自审 / 非 requester。
- manual 合并闸（E11）**不改**：manual 路径继续不收同族例外。

### 6.2 候选形状（两段，可只做第一段）

**段 A · 留证 writer（只记事实，不接续）**：`ledger manual-review-refusal record <卡>`，仅 PM / owner 发起，writer 在
BEGIN IMMEDIATE 里重读：卡 manual 且在 review、当前步骤执行者 = 失败卡 agent、失败卡 `sessionId` / `failedAt` 晚于本步骤开始、
`classifyModelOutcome=safety`、head/spec/round 当前。写一条 `kind:"escalate"` 事件（op 新名待定），只存结构化标识
（卡、步骤、轮次、head、specRev、agent、session、失败卡 id、类别 cyber_policy/usage_policy、`noReport:true`、`verdict:null`），
**不存拒审正文**；任一项缺 → 零写并说明缺什么。它不改阶段、绑定、意图，不生成批准，不被 E7/E8/E11 读取。

**段 B · 未来单的发送前快照（只对上线后新领的 manual 单）**：在 E1 `takeReview` 成功返回 manual 单时由一个新 writer
冻结同 `writeReviewSnapshot` 形状的快照（键含 manual 单号 + head + spec + round）。只有存在该快照且早于失败卡的单，
才可能在将来被一个**单独批准**的方案纳入类 MODELX 的换家族审查；旧单（含 UISPATH1）无快照，永久不适格。
take_review 当前是只读工具，段 B 让它产生写入 → 属新权限，须 owner 单独批准。

### 6.3 无合法接续时

保持阻塞，或由 PM 走**正常新审查**：在当前 head 上按现有规则派一份新的、跨族的独立审查（manual 步骤改派或转 auto 由调度派审），
其结论按原合并门判定。它是新审查而不是拒审的接续，不引用拒审作为豁免依据，不得派给被拒的同一提供方重审同一材料。
任何结论都必须是审查员本人通过 `submit_verdict` / 池票据入账的结构化结论；不得假 PASS。

## 7. MANEX1 / AUTOACK1 边界

两张卡在本基线**未见实现或文档**（`grep MANEX\|AUTOACK` 无命中）；按规格 PM 定 4 约束：
- MANEX1 只消费**已存在且合法**的拒审 epoch（E8 产物）；不能为 manual 拒审创建 epoch、模型结果或豁免。
- AUTOACK1 只承接**已有完整的本人结构化结论**（E2 verdictKey 或池票据）；拒审无结论，故无可承接。
- 二者都不得读取段 A 留证事件作为放行依据；段 A 也不得被它们当输入。

## 8. 拟实施拆分（未冻结，不授权）

| 块 | 精确文件（候选） | 正式接口 | 失败语义 | 开关 | 审批 |
|---|---|---|---|---|---|
| A 留证 | `src/lib/manual-review-refusal.ts`、`src/manager/ledger-*-cmds.ts` 一行接入、`tests/manual-review-refusal*.test.ts` | `ledger manual-review-refusal record`（PM/owner） | 事务内重读，任一缺项零写；去重键按卡+步骤+轮次+失败卡 | 沿用 `recoveryPolicy` 新 key，缺省 observe（仅 would 记录），坏 port → off | 新 writer：owner |
| B 快照 | `src/lib/review-order.ts`（薄调用）、新 `src/lib/manual-review-snapshot.ts`、测试 | take_review 后写快照 | 写失败不阻领单，但该单永不可接续；不回填旧单 | 同上，独立 key | 新写权限：owner |
| C 接续 | 未设计；须另开设计卡 | — | — | — | owner 另决 |

部署 / 审批清单：A、B 各自代码审查 + 准确 head CI 三项 → owner 批准上线 → observe 核 would 记录 → owner 再决定 on。
不申请或修改 Daybreak / 平台账户、机器权限、配额、提供方设置或 owner 既有拒审规矩。

## 9. 本稿验证记录

- MANREFD1 原稿：文档仅新增本文件；源码 / 测试 / 配置零改动。原作者本机 check / build 是否运行、结果如何：**本文无可核来源，保持未知**，不追认为已通过。
- MANREFD2 修订：diff 仅本文件。本机实际执行结果（`97ae6049` 起的分支，提交前运行，结果见下行，不代表 CI）：
  `bun run check`、`GUARD_STRICT=1 bun run guard`、入口 `bun build`（CI 同八个入口）：
  装好 web 依赖后 `bun run check` 中 typecheck 通过；`bun test` 被系统杀掉（exit **137**），被杀前已见 `tests/shared-feature-proposals.test.ts` 两例 fail（与本文无关，未排查），check 内的 guard 因此未跑；
  首次未装 web 依赖时 typecheck 失败（缺 web/node_modules），已如实保留。`GUARD_STRICT=1 bun run guard` 通过；八个入口 `bun build` 全部通过。本地结果**不是**全量绿色。
- 正式 CI 以 PR **准确 head** 上 `ci.yml` 的七项检查为准：`test shard 1..4 of 4`（四项）、`typecheck + test + guard`、
  `web typecheck + lint`、`desktop typecheck + cargo test`。本稿提交时均**未知**；旧 head 的 CI 或部分本地测试不得冒全量绿色，
  事后补的结果须注明时间与来源（PR 检查页），不冒提交前已做。
- 独立跨族文档复验：**未进行**，待审查环节；原 MANREFD1 r1 finding approval-mode-overclaim/P2 保持开放，凭该独立复验通过才可关闭。
- 发布本设计不关闭 UISPATH1 的真实独立审查阻塞，不开启任何 writer；后续实现/权限方案须 owner 另决。
