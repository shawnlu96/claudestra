# RVQUOTA1 · 原审查会话到额度线后的安全接续设计

> 只是诊断与设计文档。没有改调度、会话绑定、原会话、订单、MODELX、名额 / 额度线、配置或任何代码 / 测试；
> 没有为诊断真实换会话、退役、发 lend、开新审查 epoch、接续旧拒审或启用开关；没有读台账、会话记录、quota-state、凭据或私有工件。
> 基线 head `c4ab21eebfe98a021bd8b6f48f085b677f309ee4`（specRev 1，第 0 轮）。依赖 [QSRC1](./quota-source-consistency.md) 的资格契约 C1–C3，
> 以及 MODELX / MODELXW / MODELXP 与 RVSRC1 已在本基线合入的正式来源。实施另立正式规格；本文所列 owner 待定项在批准前**一律保持现规则**。
> 第 1 轮修订（起点 `676630e8`）：按上一轮审查补 §6.2 阶段 CAS（phase-cas）、§6.3 来源端 claim 闸与撤销线性化（claim-fence）、
> §6.5 epoch 结清与一次重绑契约（rebind-loop）；所引源码行号未变（本卡不动代码）。
> 第 2 轮修订（起点 `d6047ad7`）：§6.4 退休引用改为真实意图行 X（epoch-fk）；§6.2 补齐自身事务间的正常持久态 K0′/K1o/K3s/K4e/K4e′（phase-cas）；
> §6.1/§6.3 把目标实例公钥指纹冻结进批准并在挂池 / claim / poll / 入账核对（claim-fence）；§6.5-0 补后续轮次的规划闸与端到端恢复路径（rebind-loop）。
> 第 3 轮修订（起点 `9cebf34d`）：§6.2 公共判据拆成「新效果 G-eff」与「结清 G-set」，关开关 / 撤销 / refusal 只禁新效果、不阻塞结清（phase-cas）；
> §6.3-2 的指纹闸前移到 `o.peer === peer` 之后、`status=claimed` 幂等返回之前，并覆盖所有带订单号返回材料的出借入口（claim-fence）；
> §6.5-0 的 localOnly 改在 `reviewPlacement` 入口统一执行，覆盖 agents / 旧池 / off 全部分支且不依赖模式（rebind-loop）；
> §6.2/§6.4 按批准 version 识别尝试，新增 K0c「上次尝试已取消」，历史 cancelled X 只作审计、不阻塞新 version（retry-state）。

标签：

- **〔源〕** 在上述 head 源码里逐行读到的行为（附 `文件:行`）。
- **〔规格〕** 取自本卡规格的事实陈述（S2D2 现状），本文没有读台账核实，不补、不推。
- **〔推〕** 对源码判据的纸面推演，可对照所引行号逐条复核；**不是**运行结果。
- **〔假〕** 推断，实施前须核；**〔拟〕** 本文提议的机制；**〔待定〕** 需要 owner 拍板。

第 0–1 轮没有跑探针；第 2 轮只跑了一个隔离内存 SQLite / 纯函数探针（6.4、6.5，不读台账、registry、额度、凭据）。尤其没有用「只配空 registry / 缺 pool 的 plan 快照」去算容量——那种探针只证明某分支可达，不是当前容量事实；
本文所有关于「此刻 Code=0 / HeCode 有空位」的说法都来自规格陈述〔规格〕。

---

## 0. 结论摘要

1. 〔源〕S2D2 的等待不是 bug 路径，而是两条既有硬规则叠加：
   - **同卡复验沿原 session**：本机绑定的独立审查员在 `keepsReviewer` 下成立（`scheduler-review-swap.ts:78`），
     放置时 `localOnly = keepsReviewer && source==="local"`（`scheduler-agent-pool-plan.ts:25`）把 peer 清空；
   - **额度门把本机容量置 0**：`quotaPoolTotals` 在周窗口 `usedPct >= 线` 时把该家族 totals 置 0（`scheduler-agent-pool-quota.ts:25-28`），
     `localPoolRoom` 于是为 false（`scheduler-agent-pool.ts:22-26`），`placeAgentPool` 返回 `wait「等 codex 空位」`（`:50-51`），
     `reviewDispatch` 落成 `wait("placement")`（`scheduler-plan.ts:230-231`）。
   HeCode 的空位因此**看不见**，这是设计意图（「a local session's continuity remains a hard rule, not a load preference」，`scheduler-agent-pool-plan.ts:24`）。
2. 现有代码里**没有**任何从「额度到线」通向「换审查会话」的路：唯一的换人 epoch 是作者家族变化（FAM1a，`swapNeeded`，`:67-75`）与
   提供方策略拒审（MODELX refusal epoch，`:238-260`）。额度类模型失败被 MODEL 归为 `capacity`（`scheduler-model-outcome.ts:69`），
   其恢复计划是 `redispatch` 而不是换 epoch，且要求原单「无结果且已终止」（`:177`）。
3. 因此本设计的默认结论是：**继续等**。在第 6 节〔拟〕一个默认关闭的「额度接续 epoch」，只在原审查已安全结清、额度到线是 C1 合格事实、
   目标 peer 合法、owner 逐卡授权四者同时成立时才可能开新 epoch；它不移交旧结论、不冒用旧票据、不触碰安全卡与策略拒审路径。
4. 无批准时：S2D2 保持等待，owner X13 前置保持，不称 S2D2 已恢复派审。

---

## 1. 真实路径（验收线 1）

### 1.1 S2D2 事实组合〔规格〕

| 项 | 值 |
|---|---|
| 作者 | 真实作者 CLA（claude 家族） |
| 审查员绑定 | 本机 Code 审查员（codex 家族，`source:"local"`），本卡独立 session |
| `keepsReviewer` | 成立 → 复验 `localOnly` |
| 本机有效 codex 容量 | 额度门后 = 0 |
| peer | HeCode 有 codex 空位 |
| 原 session、未结结果、额度规则 | 均有效；人工 lend 不能代实现 |

### 1.2 调度链〔源〕

| # | 步骤 | 位置 | 行为 |
|---|---|---|---|
| 1 | `reviewDispatch` 先找本节点活的 review intent | `scheduler-plan.ts:217-219` | 有就沿用（`liveIntent`），不再派 |
| 2 | 池单残留 | `:222` | `strayPoolOrders` 非空 → `escalate pool_order_open` |
| 3 | `reviewSwapPlan` | `scheduler-review-swap.ts:81-106` | 只在 `swapNeeded`（作者家族变 / 作者自审）或远端缺家族证据时出手；额度不是触发条件 |
| 4 | MODELXP2 池单拒审 epoch | `scheduler-plan.ts:224-229` | 只对池单的策略拒审 |
| 5 | `reviewPlacement` | `scheduler-placement-plan.ts:78-84` | 安全卡且本机 cap 0 → `secReviewNoRoom` 告警；`remote.agents` 存在 → `agentPoolReview` |
| 6 | `agentPoolReview` | `scheduler-agent-pool-plan.ts:20-29` | `localOnly` → `placeAgentPool({...facts, peers: []})`，peer 被清空 |
| 7 | 本机容量 | `scheduler-agent-pool-ledger.ts:68-73` → `quotaPoolTotals` | 周窗口 `>=` 线 → 该家族 totals = 0；codex 线 = `codexWeeklyLine(db, project)`，claude 线 = 项目 `weeklyLinePct`（默认 70） |
| 8 | `placeAgentPool` | `scheduler-agent-pool.ts:43-51` | 无 peer、本机无空位 → `wait「等 codex 空位」` |
| 9 | 回到 `reviewDispatch` | `scheduler-plan.ts:230-231` | `wait("placement", …)`；不会走到 `sessionGate` |
| 10 | 若容量回来 | `:234`、`sessionGate` `:144-167` | 原 session 再次被派；`reviewerHistory` 里的前一份审查若不是同 agent+sessionId → `escalate reviewer_replaced「同卡复验必须沿用原审查 session」`（`:154-155`） |

非 agent-pool 旧路径（`remote.agents` 缺）〔源〕：`poolReview` 对 `keepsReviewer` 直接回 `localReviewFallback`（`scheduler-placement-plan.ts:88`），
后者只看 `localFamilyRefusal`，不读额度——此时阻挡来自其它地方（本机额度门 / 运行时 create 门），不在本文复现。

### 1.3 第 7 步用的是 QSRC1 的「路径 A」〔源〕

`quotaPoolTotals` 固定 `codexRollout: null`（`scheduler-agent-pool-quota.ts:21-22`），只吃账户卡（可能是 `live_stale`）。
按 QSRC1 §0/§3，路径 A 与出借线 / hello / 运行时门（路径 B）可能对同一账户给出不同结论。所以「本机 Code=0」本身就要区分：
它是**合格事实**（C1：绑定账户、`uncertain=false`、有 resetAt、真实 observedAt）还是 `live_stale` / 冲突（D7）。
本文第 3 节据此分 Q1 / Q2。

### 1.4 隔离事实组合（纸面，可对行复核）〔推〕

| 组合 | 输入 | 按 1.2 推得 |
|---|---|---|
| F1 | 绑定本机 codex 审查员、`keepsReviewer`、`quotaPoolTotals.codex=0`、peer HeCode `slots.codex=1` | 第 6 步清空 peer → 第 8 步 wait；HeCode 不参与 |
| F2 | 同 F1，但 `keepsReviewer=false`（无绑定） | 第 6 步走 `placeWithRetries`，HeCode 可被选（`:45-46`） |
| F3 | 同 F1，`template=security` | 第 5 步 `secReviewNoRoom`（若 `remote` 本机 cap 为 0）或 localOnly wait；任何情况下不出机 |
| F4 | 同 F1，本轮已有 `review` intent 处于 submitted/unknown | 第 1 步沿用该 intent，不派新单 |
| F5 | 同 F1，额度回落到线下 | 第 8 步 local → 第 10 步派原 session |
| F6 | 同 F1，人为把审查员换成另一本机 session（无 swap 事件） | 第 10 步 `reviewer_replaced` 升级——证明「换会话」不能靠改绑定绕过 |

F2 说明「HeCode 有空位」只在**没有**本卡连续性约束时才有意义；F6 说明现有规则对未授权换人是硬拒。

---

## 2. 不能混淆的五种状态（PM 定 1）

| 类 | 判据〔源/拟〕 | 不能被当成 |
|---|---|---|
| **Q1 额度到线（合格）** | 当前绑定账户的 C1 合格周读数 `>=` 线（QSRC1 §5.1） | 提供方策略拒审；原审查已结清 |
| **Q2 额度未知 / 陈旧 / 冲突** | 卡 `live_stale`、`unbound` 读数、D7 冲突、缺 resetAt（D9c）、已过 reset 未确认（D5） | 到线（Q1）；也不能当「有余量」 |
| **R 原审查未结** | R1 本轮 review intent `pending/submitted/unknown`；R2 原审查员仍在跑（registry 非 stopped）；R3 有未结外部效果：池单未对账（`strayPoolOrders`）、换人效果 archive/kill 半途（`applyReviewerSwapEffect` `:192-211`）、MCP 票据已发未回 | 已结清；`actor stopped` 或容量 0 都不等于已结清 |
| **D 原审查已给结论** | 本轮 `review` 事件已入账（结构化 verdict） | 可迁移——已有结论走原 fix/merge 流程，不需要也不允许新审查覆盖 |
| **P peer 可用但原绑定 localOnly** | F1 | 迁移授权：hello 新鲜、对方有槽、临时配置、本机 0 容量**都不能单独**成为授权（QSRC1 资格 + 规格 PM 定 5） |
| **S 提供方策略拒审** | MODEL 分类 `safety`（`scheduler-model-outcome.ts:68`）→ MODELX hold / refusal epoch | 额度。**不得**把 quota 写成 `cyber_policy` / `usage_policy` 借 MODELX 豁免换家族；反之，策略拒审也不得借本文的额度通道续做 |

关键分界〔源〕：MODEL 的 `capacity` 与 `safety` 是不同 class、不同 dedup 键（`outcomeKey` `:189`），本文**不新增**跨类映射。

---

## 3. 每类的现规则行为：只读等待与 PM 通知（PM 定 2 第一部分）

本节全是**现规则**下应有的行为，无需任何新开关。

| 类 | 调度动作 | PM 通知 | 能否由 PM 解除 |
|---|---|---|---|
| Q1 + 已绑定本机 | `wait placement`（1.2 第 9 步）；保留绑定、保留原 session | 现有 wait 呈现（卡片等待原因「等 codex 空位」）〔假：未在源码中找到针对非安全卡 placement 长等待的专门告警，实施卡须确认〕；可由 PM 手动发一条只读说明 | 只能等额度回落、owner 调线（QSRC1 待定 3）或 owner 批准第 6 节方案；PM 不可改绑定 |
| Q1 + 安全卡 | `secReviewNoRoom` 告警 + PM ask（`scheduler-sec-review.ts:48-52`） | 已有 | 只能本机恢复；不出机 |
| Q2 | 同 Q1 的 wait（规划门对 unknown fail-open，但本卡阻挡来自路径 A 的卡值）；**不得**据此开迁移 | 应标出「额度事实非合格（stale / 冲突 / unbound）」 | 先按 QSRC1 C3 得到合格事实；否则等 |
| R1 | 沿用活 intent（第 1 步） | 无新通知 | 等原 intent 结算；unknown 走既有对账 |
| R2 | 不派新单 | — | 等原审查员自然结束或 owner 处置；不得以「容量 0」推定其已停 |
| R3 | `pool_order_open` 升级 / 换人效果待收尾 | 已有升级 | 先对账、收尾；不得重放原外部效果 |
| D | 按 verdict 进 fix / merge（`fixDecision` / `reviewPass` `scheduler-plan.ts:246-275`） | 已有 | 不需要迁移 |
| P | 同 Q1 | 同 Q1 | 同 Q1 |
| S | MODELX：hold / retry_same / exempt_review（`:127-166`），或 MODELXP2 池单 epoch | MODELX 已有 owner 通知 | 只走 MODELX 自己的批准与次数 |

---

## 4. 状态表：边界变化与并发（验收线 2）

「继续等」= 不改绑定、不派新单；「owner」= 只能 owner 决定；任何行都**不**假解除绑定。

### 4.1 原单状态

| 原单状态 | 现规则 | 第 6 节方案（开启时） |
|---|---|---|
| 本轮未发（无 review intent，额度阻挡在派单前） | 继续等 | 唯一可能进入迁移准备的状态（还须满足 6.1 其余条件） |
| 已发 pending / 已领 submitted | 继续等（沿用 intent） | 不可迁移：原单未结 |
| 正在审（原 session 在跑） | 继续等 | 不可迁移 |
| 已签回（本轮 verdict 入账） | 按 verdict 走 | 不迁移：无需新审查 |
| unknown（发送 / 结果不明） | 走既有对账，结论不明前等 | 不可迁移；只有对账确认「无结果且已终止」才回到「未发」等价态 |
| 已停（registry stopped，无本轮 intent） | 继续等（绑定仍有效，容量回来即复派） | 可进入准备；但「已停」本身不是授权 |
| 原审查员上一轮给过结论、本轮未发 | 继续等 | 可进入准备；旧 report / findings / P1 streak 全部保留（6.6） |

### 4.2 边界变化（在准备 → 授权 → 写 epoch → 派单 → claim → 通知 任一 await 之间发生；按阶段 K0–K4 的精确判据见 6.2）

| 变化 | 处理 |
|---|---|
| head 变（新交付） | 作废未写入的准备与授权；已写的 epoch 绑定旧 head，不覆盖新 head（`inWindow` 同款判据 `scheduler-review-swap.ts:254`）；作者家族若变，走 FAM1a 原路径 |
| specRev 变 / round 变 | 同上，全部作废，重算 |
| task.rev 变（阶段 / 意图被他人推进） | 事务 CAS 失败 → 零写、重算 |
| 权限变（owner 撤销、批准过期、项目改为 manual / observe） | K0 → 零写；K0′（X 已计划）→ apply-epoch CAS 失败，只把 X 置 cancelled；K1（epoch 已写未派）→ 不派、等 owner；K1o（P 未挂）→ offer 拒绝，无 O 空结；K2（已挂未领）→ 撤销事务内同时撤池单，与 claim 在同一行上线性化（6.3-6）；K3（已领 / unknown）→ 不能收回已起的对方 worker，写「领后撤销」回执、保全、交 owner（6.3、6.6）；任何阶段都不恢复旧绑定 |
| 额度变：回落线下 | 未写 epoch → 放弃迁移，原 session 复派（F5）；已写 epoch → 不回滚（避免两个审查员），按新 epoch 继续 |
| 额度变：读数变 stale / 冲突 | 未写 epoch → 零写（失去 Q1 资格） |
| peer 身份变（钉住公钥指纹 / 机器名 / 授权仓库变化、槽位归 0） | K0–K1：重核失败 → 不建 X / P，wait 或升级；K1o：挂池指纹闸拒 → 无 O 空结（6.3-1）；K2：claim 只认签名指纹 = A.peerFp（6.3-2/3），同名新实例领不到、也撤不掉；K3：已由被批准实例领走，按 K3 保全；不切到其它未授权 peer，换实例须新批准 |
| 原审查员复活（6.7） | 未写 epoch → 迁移作废；已写 epoch → 旧 session 结论不认 |
| 出现策略拒审 / safety hold | `openRefusal` 优先（同 `reviewSwapPlan` `:86-87`），迁移作废，走 MODELX |

### 4.3 并发与重启

| 场景 | 处理 |
|---|---|
| 双 PM 同时点批准 | 批准记录按 `(task, head, specRev, round, 原 sessionId)` 去重；第二次重放同一记录，不生成第二个批准 |
| 双 tick 同时写 epoch | X 的 id 由 (卡, 轮, 批准 version) 确定、主键唯一，`planIntent` 的「已有未结意图」闸挡第二个；E 的 dedupKey `swapKey(X.id)` 唯一（6.4），`BEGIN IMMEDIATE` 内重读；第二个 tick 读到已写 → 返回同一结果 |
| 双 tick 同时派 epoch 池单 | 「epoch 之后任一 review intent（含已 cancelled）」即禁止再建（6.2 K1 判据），不是只看活 intent；双 tick 同时挂池由 `poolLinkKey(P.id)` 去重；挂池事务再按 `exclude=本 intent` 重算（`ledger-scheduler-pool.ts:71-73`、`scheduler-auto-snapshot.ts:48`），`offerLendCore` 的「本卡已有未结出借单」闸（`ledger-lend.ts:207-208`）兜底 |
| 撤销与 claim 同时到 | 两个事务都写同一 `lend_orders` 行，提交先后即线性化点（6.3） |
| 迁移与 FAM1a 换人 / MODELX epoch 竞争 | 同一事务读 `latestReviewerSwap`：本轮已有任何 swap → 迁移零写（与 `applyReviewerSwap` `:171` 一致） |
| 退出再恢复（bridge / scheduler 重启） | 准备与授权只存台账；重启后按 6.2 的阶段表从台账重算（含 K0′/K1o/K3s/K4e 等中间态），不从内存续；派单 intent 若 unknown → 对账，不重派 |
| 本机调度租约丢失 | 每个 await 前后 `assertSchedulerLease`（沿 `createReplacement` `scheduler-review-swap-runtime.ts:59-63` 的 `active()` 模式） |

---

## 5. 设计不变量（PM 定 2、4、5）

1. **真实原作者**：作者家族取 `remoteHeadFamily ?? workflow.authorFamily`（同 `applyReviewerSwap` `:162`）；缺远端家族证据 → 不迁移。
2. **跨模型**：新审查家族 = 原审查家族 ≠ 作者家族（「同家族迁移」指沿用审查家族，不是与作者同族）；不经 MODELX 豁免。
3. **固定窗口**：迁移绑定完整 40 位 head、specRev、round；任一变化即作废（4.2）。
4. **旧结论只读保留**：原 report、findings、P1 streak 不移到新 head 或新 session；新 epoch 不改写 round 历史。
5. **原票据不冒用**：原 session 的 MCP 票据 / review intent 不随新 session 生效；新审查只凭新 intent 入账。
6. **安全卡**：`template=security` 永不迁移、永不出机（`secReviewNoRoom`、`localOnly` 原样）。
7. **策略拒审**：有 `openRefusal` 时迁移不可用；不续做被拒活动，不外发被拒材料。
8. **额度事实**：只认 QSRC1 C1 合格事实；本机 0 容量、对方 hello 新鲜、临时配置都不是授权。
9. **不降规则**：`keepsReviewer` / `reviewer_replaced` 在开关 off / observe 时逐字节不变。

---

## 6. 受控接续方案（〔拟〕，默认关闭，不批准实现）


记号：**A** = owner 逐卡批准记录（`approvalId`、单调 `version`、`expiresAt`、`revokedAt`、冻结的目标 `peerFp`）；
**X** = 接续意图，**真实的 `scheduler_intents` 行**（6.4）；**E** = 接续 epoch 事件（`reviewer_swap` + `continuity` 字段，`intentId = X.id`）；
**P** = E 之后为本节点建的唯一 review intent（recipient `pool:<toPeer>`）；**O** = P 经 `pool_offer` 链接事件（`poolLinkKey(P.id)`，
`scheduler-pool-facts.ts:24`、`ledger-scheduler-pool.ts:95`）对应的出借单；**B** = 本卡 reviewer 绑定行；**C** = E 的结清回执 `continuity_close`（6.5-2）。

### 6.1 准入（全部满足才可能提出新 epoch）

1. 状态：`stage=review`、`workflow.mode=auto`、`template≠security`、本轮无活 review intent（pending/submitted/unknown 都不行）、
   本卡无 `pooled/claimed/unknown` 出借单（同 `ledger-lend.ts:207`）、`strayPoolOrders` 空、本轮无 `reviewer_swap`、`openRefusal` 为 null、无未收尾换人效果。
2. 原审查员：绑定行 `state=active`、`source=local`、`keepsReviewer` 成立；registry 中该 agent `status=stopped` 或可核为空闲且无待回票据；
   身份（agent + sessionId + family）与 `session_bind` 事件一致。
3. 额度：当前绑定账户、审查家族的 C1 合格周读数 `>=` 线（Q1）；记录读数摘要（账户键、窗口、usedPct、observedAt、resetAt、layer）。Q2 一律不准入。
4. 目标 peer：在借入名单、`poolPeerRefusal` 为 null（`scheduler-agent-pool.ts:10-20`）、未在本轮 tried、授权本仓库；家族 = 原审查家族；
   **当前钉住的实例公钥指纹**（`lendCallerRefusal` 认的那把，`bridge/local-api/lend.ts:64-66`；指纹算法同 `lend-inbox.ts:34` 的 `keyFingerprint`）= A.peerFp；
   中心出借路由关闭（`sharedLendApi` 开启时 claim 不走本机 `claimLend`，`shared-ledger-v2-lend-api.ts:87`，6.3-5）。
5. owner 授权：A 绑定 `(task, 40 位 head, specRev, round, 原 agent/sessionId/family, 额度读数摘要, 目标 peer 名 + peerFp)`，带过期时间；可撤销；
   每次撤销 / 改写都使 `version` +1，旧 version 一律失效。peer 名相同而指纹不同 = 另一个实例，不在 A 之内。

### 6.2 阶段机与每阶段 CAS（修 phase-cas）

**阶段是台账行的纯函数**（X、E、A、P、O、C、B 与 task 行），不存内存、不另设阶段列；每个事务先重算阶段，再只做该阶段允许的那一个写。
第 1 轮版本漏了自身事务之间的正常持久态（P 已建未挂、O 已变而 P 未同步、P 已结而 C 未写），本版按现行写入边界逐个列出：
建 P 是 `planIntent` 一个事务（`ledger-scheduler-write.ts:225-241`）；挂池是**另一个** `schedulerPoolStep` 事务，其中 `offerLendCore` 建 O
与写链接事件同属该事务（`ledger-scheduler-pool.ts:86-98`，外层 `tx` 在 `:153`），所以「O 存在而无链接」不是正常态；
O 的状态由 claim / 结论 / 撤单在出借侧事务里先变，P 由下一次 `sync` 才镜像（`:118-128`），所以「O 先于 P」是正常态。

公共判据按写的性质分两类（第 2 轮版本把两者合成一个 G，导致「关开关按撤销收尾」时收尾写自身判据失败——修 phase-cas）：

- **G-eff（产生新效果的写：建 X、apply-epoch、建 P、挂池建 O、claim 放行）**：调度租约有效；`head/specRev/round` = X 的窗口（E 写入后 = E 的窗口）；
  `mode=auto`、`workflow.specRev=task.specRev`；`openRefusal` 为 null；开关 = on；A 有效且 version 匹配；本卡最新 `reviewer_swap` 是 E（E 写入前：本轮没有任何 swap）。
  任何一条失败 = 不再产生新效果，转入下面的结清路径，**不是**「整个阶段机卡死」。
- **G-set（保全 / 结清的写：X `pending→cancelled`、撤池 `withdrawPooledLend`、`sync` 镜像 P、写 C、写撤销 / 领后回执、对已领单收结论）**：调度租约有效；
  本卡最新 `reviewer_swap` 是 E（E 写入前：X 是本卡唯一未结意图）；P / O 经链接事件与 E 一一对应；dedupKey 未被占用。
  **不**核开关、mode、`openRefusal`、A、窗口——这些只决定「能不能再做新事」，而结清只是把已有的 E / P / O 按其自身固定的来源（订单号、peer、`E.peerFp`）
  收到终态。窗口变了的结论由既有入账判据拒收（`ledger-lend-result.ts:94` 核窗口，`cardMoved` 撤单），结清写的是 C{empty}，不是放宽结论来源。
  E 被更新的 swap 取代（他人写入）→ 不属于结清，按「不一致即停」升级。

开关 off / observe、A 撤销或过期、`openRefusal` 出现、mode 离开 auto 时的统一处理：G-eff 失败的阶段只做其 G-set 写——K0′ → X `cancelled`；
K1 → 零写，停在 K1 `wait` 并升级 owner（无 P、无 O，没有待结清的外部效果；是否交还原绑定为 owner 待定 4）；K1o → P `cancelled` → K4e′；K2 → 撤池 → K4e；
K3 起照常结清（领单已在 6.3 线性化，默认收结论；owner 要放弃用 `cancelLend`）。这些写在开关 off 下仍可达（6.8），重启后同样可完成。

**G-pre**（只在 O 收到结论之前的阶段要）：`stage=review` 且 task.rev = 该阶段的期望值。结论入账会推进 stage / rev（这是结论本身的效果），
所以 K3s 之后改为核「结论事件 seq = O.eventSeq 且其窗口 = E」，不再核 stage / rev。

| 阶段 | 识别（台账事实） | 本阶段 CAS 判据（G-eff / G-set 之外） | 唯一允许的写 / 后继 |
|---|---|---|---|
| **K0 规划** | 窗口内无 E；无未结 X（pending/submitted）；无 id 带当前 `A.version` 的 X（任何状态）。其它 version 的 `cancelled` X 只作历史审计，**不**参与识别 | G-eff；G-pre（rev = 读到的 rev）；6.1 全部；A 有效，且 `A.version` > 窗口内所有已 cancelled X 的 `approvalVersion` | 规划器建 X(`v=A.version`)（`planIntent` 事务，其自身「本卡无未结意图」闸 `ledger-scheduler-write.ts:209-211` 排除并发意图）。→ K0′ |
| **K0c 上次尝试已取消** | 窗口内无 E；无未结 X；最新 X 为 `cancelled`；无 version 更高的有效 A | — | **零写**。接续分支不生效（不返回 wait / in_flight），规划回到原规则：原 `keepsReviewer` 等待 / 人工队列照旧（第 3 节），另发一次 note「接续尝试 v<n> 已取消（reason），等 owner 新批准」（dedup 按 X.id）。owner 给出新 version → K0 |
| **K0′ 已计划待执行** | X `pending`；无 `swapKey(X.id)` 事件 | G-eff；G-pre（rev = `X.taskRev`）；B=`active` 且身份 = A；A 有效且 `version = X` 记录的 `approvalVersion`；6.1-2/3/4 重核 | apply-epoch 事务：E（dedup `swapKey(X.id)`）+ B → `retired`、`retireIntentId = X.id` + 保全回执（6.5-3）+ X `pending→submitted→done`。→ K1。G-eff 或本阶段判据失败 → G-set 写：**只**把 X `pending→cancelled`（reason 写明哪条）→ K0c |
| **K1 epoch 已提交** | E 在窗、X `done`、B 为 X 所退、E 之后无任何 review intent | G-eff；G-pre（rev = `E.taskRev`）；B.`retireIntentId = X.id`（**预期后继**，不再要求 active）；E 之后 review intent 数 = 0（含 cancelled——一次性）；本卡无未结出借单；A 有效且 `version = E.approvalVersion`；目标 peer 仍合法且当前钉住指纹 = E.peerFp | 规划器建 P（`continuityEpoch = E.seq`、recipient 固定 `pool:E.toPeer`）。→ K1o。G-eff 失败 → 零写、`wait` + 升级 owner（无 P / O，无待结清效果） |
| **K1o 已建待挂** | P `pending`；无 `poolLinkKey(P.id)` 事件；本卡无指向 P 的 O | offer：G-eff；G-pre（rev = `P.taskRev` = `E.taskRev`）；E 之后 review intent **恰为 {P}**；本卡无未结出借单；**挂池指纹闸**（6.3-1）。取消：G-set | `schedulerPoolStep → offer` 一个事务：建 O + 链接事件 → K2；G-eff 失败或 offer 拒绝（`ledger-scheduler-pool.ts:60-61`，含指纹闸失败）→ G-set 写 P `cancelled`、**无 O** → K4e′ |
| **K2 已挂待领** | O `pooled` 且经链接属于 P；P `pending` | 领单放行：G-eff（在 claim 事务里，6.3-2）；「恰为 {P} / {O}」；`O.peer=E.toPeer`、`O.head/specRev/round` = E 窗口、`O.step=review`。撤池：G-set | 对方领单走 6.3 闸 → K3；撤销 / 关开关 / refusal / mode 变 / 超时 → G-set 写 `withdrawPooledLend` CAS（`ledger-lend.ts:261-275`）→ K4e |
| **K3 已领 / unknown** | O `claimed`（P `pending`=未同步 或 `submitted`），或 O `unknown`（P `pending/submitted/unknown`） | G-set；「恰为 {P} / {O}」；**不**核 A / 开关 / refusal（领单已在 6.3 线性化） | `sync` 镜像：claimed → P `submitted`（`:120-121`）；unknown → P `unknown`（`:126`），走既有对账；租约 / 结论 / 报停照旧。→ K3s / K4e |
| **K3s 结论已入账待同步** | O `done`；P `pending/submitted/unknown` | G-set；O.eventSeq 指向的 review 事件的窗口 = E 窗口（固定事实，不比当前 task 行）、`reviewer = peer:E.toPeer`、`reviewerSessionId = lend:<peer>:<O.orderId>`；**不核** stage / rev / 开关 | `sync` 事务：P → `done`（`:123-124`）**并在同一事务**写 C{reviewed}。→ K4 |
| **K4e 退回待同步** | O `cancelled/released`；P `pending/submitted` | G-set；「恰为 {P} / {O}」 | `sync` 事务：P → `cancelled`（`:127-128`）+ C{empty} 同一事务。→ K4 |
| **K4e′ 空结（无 O）** | P `cancelled`；无链接、无 O；无 C | G-set | 写 C{empty}。→ K4 |
| **K4 已结** | C 存在，且（C=reviewed ∧ P `done` ∧ O `done`）或（C=empty ∧ P `cancelled` ∧ O ∈ {无, cancelled, released}） | — | 无写。empty → `escalate continuity_empty`，不自动重派 |

自身写入的预期后继〔源 + 推〕：apply-epoch 事务只写事件、`scheduler_sessions` 与 X 的 settle，不写 task 行（同 `applyReviewerSwap` `:173-181`），
故 K1–K3 的 rev 期望值就是 `E.taskRev`；建 P / 挂 O / claim / sync 也不写 task 行〔假：实施卡须逐个核，任何一步若会改 task.rev，
须在同一事务把新 rev 记进该步的事件，后续 CAS 改认此值，而不是放宽判据〕。结论入账推进 stage / rev 是唯一预期的 task 行变化，
其后的阶段以 O.eventSeq 认它（K3s）。B 从 K1 起的期望状态是 `retired by X`，不是 `active`；他人把 B 改成任何别的状态 = 判据失败。

不一致即停：识别不出唯一阶段（E 之后 ≥2 个 review intent、O 不经链接事件属于 P、有链接而无 O、B 被别的 intent 退役、出现第二张未结单、
X `done` 而无 E、E 存在而 X 非 `done`、窗口内 ≥2 个未结 X、E 的 `intentId` 指向 cancelled X）→ 零写、`escalate continuity_inconsistent`，交 owner；绝不「挑一个继续」。

重启恢复：从台账重算阶段，仅做该阶段允许的写。K0′ 中断（X pending、无 E）→ G-eff 仍成立则重跑 apply-epoch（dedup `swapKey(X.id)` 保证至多一次），否则 G-set 取消 X → K0c；K0c 重启后仍零写、回原规则；
K1 中断 → 继续建 P 或因 A 失效停在 K1 等 owner，不回滚 E；K1o 中断 → 重跑 offer（链接 dedup `poolLinkKey(P.id)`）；
K3 / K3s / K4e 中断 → 下一次 `sync` 补镜像，C 与 P 终态同事务，故不会出现「P 已结而 C 缺」；万一出现（旧版本写入）只补 C。P `unknown` 只对账不重派。

规划器接线〔拟〕：`reviewDispatch` 在 `strayPoolOrders`（`scheduler-plan.ts:222`）之后、`reviewSwapPlan`（`:223`）**之前**插接续分支
（否则 B 退役后 `reviewer=null`，`reviewSwapPlan` 会先进 `:97-105` 的通用放置，见 6.5-0）。分支只在 E 在窗、窗口内有**未结** X（pending/submitted），或有一个尚无对应 X 的有效 A version（K0）时生效；窗口内只有 cancelled X（K0c）时不生效，规划完全按原规则走：
`liveIntent` floor 加入 E.seq（同 refusal / legacy，`:218-219`），K1o–K3 由它返回 `in_flight` / `unknown_effect`，挂池 / 同步由池步执行器按意图推进；
K1 建 P；P 已 `cancelled` → `escalate continuity_empty`；**不**进 `reviewPlacement`（同 `pool = epoch || legacy ? null` 的先例，`:230`）。
offer 事务按 `exclude=P.id` 重算（`ledger-scheduler-pool.ts:71-73`），接续分支在 K1 判据下必须复现同一 id / recipient〔假：实施卡核 `makeIntent` id 的确定性〕。

### 6.3 来源端 claim 闸、身份指纹与撤销线性化（修 claim-fence）

现状〔源〕：`claimLend` 在一个事务里核 `o.peer === peer`（**只比名字**）、状态、borrow、maxOpen、`cardMoved` 后即 `pooled → claimed`（`ledger-lend.ts:367-395`）；
bridge 只把 peer 名交给 manager（`bridge/local-api/lend.ts:115`），虽然 `lendCallerRefusal`（`:60-67`）已要求请求由**当前钉住的**公钥签名，
但该公钥 / 指纹没有传进台账事务。先例：`lend-inbox.ts:34-35` 已把验过签的公钥指纹作为参数交给 manager。

〔拟〕全部只对「O 经链接事件属于带 `continuityEpoch` 的 P」的单生效，其它单逐字节不变：

1. **挂池指纹闸**（K1o 的 offer 事务）：事务前读本机当前钉住的该 peer 公钥（`readPeerPins`，`lib/peer-trust.ts:75`；bridge 内存态为 `peerSignatureState`，`bridge/peer-signature.ts:32`），
   事务内比较其指纹 = E.peerFp = A.peerFp；不等、未钉、钥匙处于 `key_changed` → offer 拒绝 → P `cancelled`、无 O（K4e′），升级 owner「目标实例已变，须重新授权」。
   这一步只防止把单挂给已知换了实例的 peer；权威闸是第 2 条。
2. **claim 闸**（分两道，位置不同——修 claim-fence）：bridge 对 continuity 相关的 `/lend/claim`、`/lend/poll`、`/lend/lease`、结论回传等**所有带订单号或会返回订单材料的出借入口**
   按 `lend-inbox.ts:34` 的做法把 `signerFp = keyFingerprint(签名公钥)` 追加为 manager 参数。
   - **身份闸** `continuityIdentityLapse(db, O, signerFp)`：放在 `claimLend` 事务里 `o.peer === peer` 检查（`ledger-lend.ts:371`）**紧后**、
     `status === "claimed"` 的幂等返回（`:372-375`）**之前**，也就是在任何 `claimed(o)` payload（订单正文 / 规格 / 租约，`:364-365`）可能返回之前。
     O 属于 continuity P 时要求 `signerFp` 存在且 = E.peerFp；否则一律回 `not_found`（同 `:371` 的「没有挂给你的这一单」），**不**改 O、不续租、不返回任何材料，
     写 note 并升级 owner。这道闸对 O 的**每个**状态都生效（pooled / claimed / unknown / done / cancelled），所以同名换钥的新实例拿已知订单号重 claim
     （上一轮探针 `returnsMaterials=true` 的路径）在 `:372` 之前就被挡住。`leaseLend` / 结论入账 / poll 用同一函数作首道检查。
     身份闸只比 E 里冻结的指纹，**不**读 A——它不是授权判断，撤销 A 不会让已领单的合法持有者（被批准实例）重 claim / 续租失败。
   - **授权闸** `continuityClaimLapse(db, O, signerFp)`：只在真正的 `pooled → claimed` 转移路径上，放在 `cardMoved` 之后、`UPDATE … status='claimed'` 之前，
     同一事务重读 G-eff：E 仍是最新 swap 且在窗；`peer = E.toPeer`；`signerFp = E.peerFp = A.peerFp`；A 未撤销、未过期、`version = E.approvalVersion`；开关 on；
     `openRefusal` 为 null；mode auto；B 仍为 X 所退；P 仍 pending。失败 → 同事务 `O → cancelled`（reason 写明哪条）+ note，回对方 `cancelled`。
     走到这里时身份闸已通过（领单者就是被批准实例），对方此时还没起 worker，外部效果为零。
   - 已 `claimed` 的幂等重 claim 只过身份闸，不过授权闸（撤销语义见第 6 条：领单后不再重核 A）；身份失败的请求不能借此撤掉或改动这一单，O 留在原状态由超时 / owner 收尾。
3. **跨 await 的身份变化**〔推〕：claim 请求经 `checkPeerSignature`（读 peers / pins）→ `lendCallerRefusal` → `sharedLendApi` → `runManagerProcess` → 台账事务，每一步都是 await。
   `signerFp` 是**这个请求**签名所用公钥的指纹，签名覆盖 method / path / ts / body（`bridge/peer-signature.ts:73-76`），任何 await 都改不了它；
   事务内拿它与**同一事务**读到的 A / E 比。因此：await 期间 peer 被改钉成新实例 → 新实例发来的请求 signerFp = new-pin，被第 2 条拒；
   本请求若由旧（被批准）实例签名，则领单者就是被批准的实例，合法。owner 若要在途中切断旧实例，唯一手段是撤销 A（第 4 条），与 claim 在同一行线性化。
   不以「当前 pins 文件」为权威：它在台账事务之外，读完到提交之间可变。
4. **撤销事务**：owner 撤销 A 或改写目标（含改指纹）时，同一事务内 `version+1`、写 `revokedAt`，并对 O 调 `withdrawPooledLend`（若 O 仍 `pooled`）。
5. **中心路由**：`lendCentralRoutingEnabled()` 时 claim 由中心 journal 处理，不经本机 `claimLend`（`shared-ledger-v2-lend-api.ts:87-93`）。
   6.1-4 要求准入时关闭；K2 期间若被打开，中心路径对带 `continuityEpoch` 标记的单须 fail-closed（回 `unavailable`，不领），实施卡须给这条路加同等闸或证明不可达〔待定 11〕。
6. **线性化点**：claim 事务与撤销事务都写 O 这一行，SQLite 写锁使二者串行，**先提交者即线性化点**：
   - 撤销先提交 → O 已 `cancelled` 或 A 已失效，后到的 claim 被状态检查（`ledger-lend.ts:378`）或第 2 条授权闸拒绝 → K4e，零外部效果。
   - claim 先提交 → claim 时批准有效、身份 = 被批准实例，领单合法；撤销事务看到 O 已 `claimed`，不能撤池，只写回执
     `continuity_revoke_after_claim{orderId, leaseGen, worker}`，P/O 进入 K3 保全。
     默认：已领单照常收结论（批准在领单时有效）；owner 若要放弃，用现有 `cancelLend`（`claimed → cancelled`），此后对方结论被 `ledger-lend-result.ts:88` 拒收，
     K4e 空结；无论哪种都**不重放**对方已做的工作、不另派。
   - 已 `unknown`（对方报停 / 租约过期）→ 既有对账；撤销只记回执，不推定「无效果」，不收结论（`ledger-lend-result.ts:87`）。
7. **poll 侧**：`pollLend` 带 `signerFp`，对 continuity 单先过第 2 条身份闸，再只在授权闸仍成立时列出——不再是可选优化，
   以免同名的新实例看到这张单；权威仍是第 2 条两道闸，poll 过滤只是减少噪音。

结论入账不再重核 A（已在 claim 线性化），但要求 E 是最新 swap 且窗口未变（现有 `ledger-lend-result.ts:94` 已核窗口），
并要求结果签名公钥的指纹 = E.peerFp（入账已取 `pinnedKey`，`manager/ledger-lend-cmds.ts:272`；continuity 单再与 E 比）；E 已被更新的 swap 取代 → 拒收、交 PM。

### 6.4 epoch 形状与退休引用载体（修 epoch-fk）

〔源〕`scheduler_sessions.retireIntentId` 是 `REFERENCES scheduler_intents(id)` 的外键（`ledger-scheduler-schema.ts:60`），台账连接开 `PRAGMA foreign_keys = ON`
（`ledger-store.ts:197`）。第 1 轮版本让 `retireIntentId = continuity-epoch:<A.seq>`（不是意图行）——第一笔 apply-epoch 事务会以 `FOREIGN KEY constraint failed` 整体回滚。
引的 MODELX 先例也不成立：`refusalEpochId` 只作事件 dedupKey，事件 `intentId` 与绑定的 `retireIntentId` 都是**已存在**的被拒审查单 `sent.id`
（`scheduler-review-swap.ts:402,411,415`）；FAM1a 用的是规划器建的真实 `review_swap` 意图（`:91`、`:180`）。

〔拟〕载体：**X 是真实的 `scheduler_intents` 行**，不改表结构：

- X = 规划器决策 `{ kind:"intent", id:"review-continuity:s<born>:r<round>:v<A.version>", action:"review_continuity", node:"adversarial_review",
  recipient:null, resources:["task:s<born>"] }`，形状仿 FAM1a 的 `review-swap:s<born>:r<round>`（`:91-92`）。`action` 列没有 CHECK（`ledger-scheduler-schema.ts:20-28`），
  新 action 只需扩 `PlannedIntent["action"]` 类型与执行器分派；**不**复用 `review_swap`，否则执行器会把它交给 `applyReviewerSwap`（其 `swapNeeded` 判据必拒，`:171`）。
- id 带 `A.version`：同一 version 至多一个 X；K0′ CAS 失败后 X 为 `cancelled`，同 id 不能重建（主键），重试须新的批准 version——「一个批准 version = 一次尝试」。
  尝试按 version 识别（修 retry-state）：K0 只排除「当前 `A.version` 的 X」与未结 X，不排除别的 version 的 cancelled X；新 version 的 X id 不同，主键不冲突，
  `planIntent` 的未结闸只数 `pending/submitted/unknown`（`ledger-scheduler-write.ts:209-211`），cancelled 行不挡。历史 cancelled X 留作审计（reason 可查），
  无新批准时为 K0c：零写、接续分支不生效、回原规则等待 / 人工队列。A 的 version 单调递增（6.1-5），所以不会出现新 X 的 version ≤ 已 cancelled X。
- apply-epoch 同一事务：E（dedupKey `swapKey(X.id)`，`:140`；`data.intentId = X.id`）+ B `state=retired`、`retireIntentId = X.id`（外键指向真实行，合法）
  + 保全回执 + X `pending→submitted→done`（同 `applyReviewerSwap` 的 settle，`:174`；本 effect 在事务内即完成，故直接 done，使 K1 的 `planIntent` 不被
  `ledger-scheduler-write.ts:209-211` 的「已有未结调度意图」挡住）。**不** kill、不唤醒原 session。
- E 字段：`continuity: { reason:"quota", approvalId, approvalVersion, quotaFact:{…摘要}, fromSession, toPeer, peerFp }`，并带 `intentId/round/head/specRev/taskRev/family`；
  与 `refusal` / `legacy` 并列、互斥。`latestReviewerSwap` / 「本轮已换过」（`:171`）/ FAM1a 互斥原样生效；每轮至多一次。
- `mayRebindReviewer` 对 E 仍恒为 false（无 kill / reuse / legacy，`:224`）——X 现在是真实且 `done` 的行，满足 `:227`，但 `:224` 先拒；
  这正是 off / 未结清时的保护，唯一放行路径是 6.5 的专用判据。

隔离探针〔本轮跑过，scratchpad，内存 SQLite + 真实 `SCHEDULER_SESSIONS_SCHEMA` + `foreign_keys=ON`，不读台账 / registry / 额度〕：
`retireIntentId = "continuity-epoch:7"` → `FOREIGN KEY constraint failed`（复现上一轮）；先插意图行 `review-continuity:s1:r2` 再退役 → 成功，B=`retired`。

〔假〕`reviewsAfterSwap` 以最新 swap 为界截断审查历史（`:21-24`）。上一轮审查员指出它只用于 `reviewerHistory`、
streak / roundCap 消费完整事件；实施卡仍须用测试确认 P1 streak / roundCap / `reviewStartRound` 跨 E 保留原轮次结论（第 7 节 7）。

### 6.5 epoch 结清、后续轮次规划闸与一次重绑契约（修 rebind-loop）

问题〔源〕有两层：
- **规划层**（第 1 轮漏了）：B 退役后 `reviewer=null`，最新 swap 仍是 E。`reviewSwapPlan` 在 `:95` 之后对非 refusal / legacy 的 swap 查 `s.intents` 里的 E.intentId，
  不是 `done` 就恒回 `wait reviewer_swap`（`:97-98`），且不看窗口 / 轮次；它在 `reviewDispatch` 里先于 `sessionGate`（`scheduler-plan.ts:223` 对 `:234`）。
  第 1 轮的合成 intentId 没有意图行 → round+1 永远卡在这里，到不了绑定闸。反过来，X `done` 后 `:99-105` 会走**通用放置**，
  `reviewer=null` 时可直接挂给任一 peer——等于用一次批准换来往后各轮的出机审查，同样不可接受。
  探针〔同上〕：真实 `reviewSwapPlan`，round=3、E.round=2、已有 review 与 C、reviewer=null：无 X 行 → `wait reviewer_swap`、placement 0 次（复现）；
  X 行 `done` → 返回 null 且调用了 placement 1 次（证明必须在 `:99` 之前截住）。
- **绑定层**：下一次本机建审查 session 走 `bindSchedulerSession`；该处只认 `refusalRebind`（`scheduler-sessions.ts:98`）或 `mayRebindReviewer`（`:99`），
  E 不满足后者（6.4），不加专用判据必被「本卡角色已绑定另一个 session；不能换审查上下文」（`:101`）拒绝。

〔拟〕契约（全部成立才放行，**一次**）：

0. **规划闸** `continuitySwapGate(s, E)`，插在 `reviewSwapPlan` 的 `:95` 与 `:96` 之间（与 refusal / legacy 的提前返回并列）：
   - E 在窗 → 返回 null 交给 6.2 的接续分支（防御；正常情况下接续分支已先于 `reviewSwapPlan` 处理）。
   - E 不在窗、X `done`、C = reviewed、且 C 之后尚无 `continuityEpoch = E.seq` 的 reviewer bind → 返回 null，**跳过** `:97-105` 的通用放置；
     本卡放置改为 localOnly，且**在 `reviewPlacement` 入口统一执行**（第 2 轮只扩了 `agentPoolReview` 的谓词，旧池分支 `poolReview` 与 `remote.agents` 缺失时漏掉——修 rebind-loop）：
     `reviewPlacement`（`scheduler-placement-plan.ts:78-84`）在 `secReviewNoRoom`（`:80`）之后、`p?.remote.agents` 分支之前先判
     `continuityRebindPending(s)`，成立则直接返回 `continuityLocalPlacement(s)`，**不进入** `agentPoolReview` / `poolReview` / `legacyPool` 任一分支：
     - `remote.agents` 存在 → `placeAgentPool({ ...facts, peers: [] }, "review", family)`（同 security 的 localOnly 形状）：本机有空位 → null，否则 `wait`；
     - 无 `remote.agents`（旧池 / `remote.mode=off` / 无 pool 快照）→ `localReviewFallback(s)`，再加本机名额判断 `localReviewers >= maxWorkers` → `wait`（同 `reviewSwapPlan` `:104-105` 的措辞）；
     - 任何分支都**不**返回 `{ peer }`。
     `continuityRebindPending(s)` 是台账事实的纯函数：最新 `reviewer_swap` 是带 `continuity` 的 E，且 E 之后没有 `continuityEpoch = E.seq` 的 reviewer bind。
     它**不读** `remote.mode` / `remote.agents` / 开关 / A，所以准入后配置在 agents 与旧池之间切换、`remote.mode` 改变、开关被关，都不改变结果——
     模式变更天然 fail-closed，不另设「全过程模式约束」。`reviewPlacement` 的三个调用点（`scheduler-plan.ts:151`、`reviewSwapPlan` 的 `place`〔`:223`→`scheduler-review-swap.ts:100`〕、`scheduler-plan.ts:230`）都经它，
     所以规划闸返回 null 后 `reviewDispatch:230` 再算放置也只能得 local / wait。
     于是：本机额度仍到线 → `wait placement`（同 F1，需要再迁移就得新窗口的新批准 A）；本机有空位 → `reviewPlacement` 为 null → `sessionGate` 发 `ensure_session` → 绑定层第 1–6 条。
     一次批准因此只授权 E 那一轮的那一张池单；之后任一轮要再出机，必须新的 X / A（6.1、owner 待定 12），不存在「批准一次、后续轮次通用外派」。
   - E 不在窗、C = empty 或缺 C、或 X 非 `done` → `escalate continuity_unsettled`（保留保护，不自动放行、不通用放置）。
   - 已有 `continuityEpoch = E.seq` 的 bind 之后 → 本闸不再介入，B′ 为 `active`，`reviewSwapPlan` 在 `:95` 因 `s.reviewer` 非空直接返回，回到普通 `keepsReviewer`。
1. **E 识别**：`continuityRebind(db, prior, intentId)` 与 `refusalRebind` 并列，在 `scheduler-sessions.ts:98` 处 `refusalRebind(...) ?? continuityRebind(...)`。
   条件：`latestReviewerSwap` 是带 `continuity` 的 E；`E.intentId = X.id = prior.retireIntentId`；`getIntent(X.id)` 为 `action=review_continuity, status=done`；
   `E.sessionId = prior.sessionId`；prior `role=reviewer, state=retired`。
2. **结清回执 C**（dedupKey `${swapKey(X.id)}:close`）：只在 K3s / K4e / K4e′ 与 P 终态同事务写，内容固定
   `{ outcome:"reviewed"|"empty", Pid, orderId?, reviewEventSeq?, reviewer:"peer:<toPeer>", reviewerSessionId?, signerFp? }`。
   `reviewed` 要求该 review 事件来自 O（`reviewerSessionId = lend:<peer>:<orderId>`，`scheduler-pool-facts.ts:26`）、P `done`、签名指纹 = E.peerFp——这就是**唯一新审查来源证明**：
   新结论只经 O 的 claim 票据入账，原 session 的票据不可能产生它。没有 C → 不放行。
3. **原 worker 保全证明**：E 的同一事务写 `reviewer_swap_effect{effect:"preserve", intentId: X.id}`（新 effect，仅 continuity 可用），回执记录退役时 registry 中
   原 agent/sessionId 的状态（stopped / 空闲且无待回票据）；不写 killReceipt。缺此回执 → K0′ 事务本身失败，不会出现 E。原 session 之后的处置是 owner 待定 5，不影响本判据。
4. **时序**：本次 ensure_session intent 的 `eventSeq > C.seq`；`outcome=reviewed` 时只允许在 `task.round > E.round` 的轮次重绑；
   `outcome=empty` 时**不**放行（同轮回本机等于换 session 复审本轮，交 owner，第 7 节 4）。
5. **家族**：期望家族 = `E.family`（原审查家族），且仍须 = 作者家族的另一族（`scheduler-sessions.ts:106-107` 原判据不放宽）；作者家族若已变 → FAM1a 原路径，本判据不放行。
6. **一次**：bind 事件带 `continuityEpoch: E.seq`；此后 B′ 为 `active`，回到普通 `keepsReviewer` 连续性规则；同一 E 不能第二次放行。

一次性池审查的 `reviewer` 是 `peer:<机器>`，`reviewerHistory` 不把它算作需沿用的 session（`scheduler-review-swap.ts:42`），
所以 B′ 绑定后 `sessionGate` 不会因 E 的池审查报 `reviewer_replaced`；B′ 之前的原 session 审查被 `reviewsAfterSwap` 截在 E 之前，也不会触发。

完整恢复路径（实施卡须一条端到端测试，从规划到绑定）：round=r 的 K0→K4(reviewed) → stage 推进 → 作者交付 round r+1 → `reviewDispatch`：
接续分支不在窗 → `reviewSwapPlan` 经第 0 条返回 null → localOnly 放置 → `sessionGate` → `ensure_session` → `bindSchedulerSession` 经第 1 条放行 →
B′ active、bind 带 `continuityEpoch` → 下一次 `reviewDispatch` 派给 B′；负例：C=empty / 缺 C / X 非 done → `continuity_unsettled`，本机额度到线 → `wait placement`，
绝不出现通用 peer 放置。

### 6.6 失败与撤销保全

| 时点 | 失败 / 撤销结果 |
|---|---|
| K0（准备 / 批准） | 无任何写入；原绑定、原等待照旧 |
| K0′ → K1 事务 CAS 失败 | G-set：只把 X 置 `cancelled`（带原因），其它零写 → K0c：同一批准 version 不再重试，回原规则等待 / 人工队列；owner 给新 version 后按 K0 再建 X(新 version)，旧 cancelled X 留作审计、不阻塞 |
| K1（epoch 已写、未派）peer 失格 / 批准被撤 | 不建 P，`wait` / 升级 owner；**不**自动恢复旧绑定（owner 待定 4）；原 report 不动 |
| K1o（P 已建未挂）批准被撤 / 实例指纹变 | offer 拒绝 → P `cancelled`、无 O → K4e′ 空结 |
| K2（已挂未领）批准被撤 | 撤销事务同时撤池（6.3-4）→ K4e 空结 |
| K2 / K3 同名新实例来领或重 claim 已领单 | 身份闸在 `status=claimed` 幂等返回之前回 `not_found`，不返回任何材料，O 不变，升级 owner（6.3-2） |
| K0′–K2 开关被关 / refusal 出现 / mode 离开 auto | 同「批准被撤」：G-eff 失败 → 对应 G-set 写（取消 X / 不建 P / 取消 P / 撤池），结清可在 off 下完成（6.2、6.8） |
| K3（已领）批准被撤 | `continuity_revoke_after_claim` 回执；默认收结论，owner 可 `cancelLend`；不重放、不另派 |
| K3 unknown | 既有池单对账；不重派、不另起 |
| K4 空结 | `continuity_close{empty}`；不自动重派、不放行重绑，升级 owner |
| peer 审查被策略拒审 | 走 MODELXP2 原路径，不叠加本方案 |

任何失败都不移动原 report / findings / P1 streak，不把旧 PASS 挪到新 head 或新 session。

### 6.7 旧 session 恢复竞争与来源消歧

- 未写 epoch 前原 session 复活 / 额度回落：迁移作废，原规则复派（F5）。
- epoch 写入后原 session 复活：其绑定已 retired，`sessionGate` 不会再派给它；若它经旧票据提交 verdict，入账判据须要求
  verdict 绑定的 intent 属于**当前** epoch（intent.eventSeq > E.seq），否则拒收并记一条只读 note，不当本轮结论、不当 PASS。
- 新审查的结论只认 O（订单号 + peer + P），`reviewer` 字段为 `peer:<机器>`；旧 session 的结论不得「沿新 session」冒名；
  6.5 的 B' 是另一个新 session，其结论只从 B' 自己的票据入账。

### 6.8 开关（拟议名不落库；当前不写策略键）

- 三态 on / observe / off，**默认 off**。
- off：**新效果**路径不可达（G-eff 恒失败：不会再建 X / E / P / O、不放行 claim），从未开过开关的卡因无 E，`continuityRebind` / `continuityIdentityLapse` / `continuityClaimLapse` / `continuitySwapGate` / `continuityRebindPending` 恒为 null / false，claim / poll 的 `signerFp` 参数对非 continuity 单不读，1.2 链逐字节不变。
  已有 E 的卡在 off 下**仍执行** G-set 结清（取消 X、撤池、`sync`、写 C、收已领单结论）以及保护性判据（身份闸、`continuityRebindPending` 的 localOnly、`continuity_unsettled`）——关开关只禁新效果，不撤保护、不让结清卡死（修 phase-cas）。
  off 下 C=reviewed 后的一次重绑（6.5-1）是否放行列 owner 待定 13，本文默认不放行：`continuitySwapGate` 改回 `escalate continuity_off`，localOnly 保护照旧。
- observe：只写一条 note「若开启将如何」，不 ask、不写 epoch、不改绑定；与原 wait 并存。
- on：仍须逐卡 owner 批准；无批准时与 off 相同，继续等待 / 人工队列。开关在 K0′–K2 被关 → 同「批准被撤」处理（6.2 的 G-eff 失败 → G-set 写）；K3 起照常结清。
- 验收（实施卡）：off/observe 下 F1–F6 结果与本基线一致；on 无批准时同 off；4.1–4.3 与 6.2 每个阶段、6.3 两种提交先后、
  6.5 每条判据各一条负例或正例测试（含「continuity E 无 kill 时 `mayRebindReviewer` 仍为 false」）；另须：真实 schema + `foreign_keys=ON` 下 apply-epoch 成功
  （退休引用指向 X）；6.2 每个中间态（K0′/K0c/K1o/K3s/K4e/K4e′）重启后识别正确；K2 关开关后撤池、K4e 写 C 在 off 下完成；X(v1) cancelled 后 A(v2) 能建 X(v2)、无新批准时回原规则；
  同名换钥实例对 pooled 与**已 claimed** 订单的 claim / poll / lease 均被拒、不返回材料且 O 不变；6.5 的规划→绑定端到端恢复与
  「X done 后不出现通用 peer 放置」的负例，须在 `remote.agents` 存在、缺失（旧池）、`remote.mode=off` 三种配置及准入后切换配置下各跑一次。

---

## 7. owner 待定项（不批准实现）

1. 是否允许任何「额度到线」触发审查会话连续性例外（改变 `keepsReviewer` 规则本身）。
2. 自动迁移权限：仅逐卡人工批准，还是允许某种常设授权；本文只设计逐卡批准。
3. 开关键名、默认值与作用域（项目 / 全局）；本文提议默认 off。
4. epoch 写入后的撤销语义：是否允许 owner 把绑定还给原 session，以及与新池单的互斥；空结（K4 empty）后能否同轮回本机。
5. 原 session 在迁移后的处置（保留 / 归档 / 停止）及其回执要求（6.5-3 只要求保全，不要求停止）。
6. 额度到线判据用哪条线（QSRC1 待定 3、4）与路径 A / B 分歧期间是否一律视为 Q2。
7. 跨 epoch 的 P1 streak / roundCap 计算口径（6.4〔假〕）。
8. 旧票据迟到 verdict 的拒收位置（入账闸 / MCP 工具 / 两者）。
9. 领后撤销（6.3-6）的默认：收结论（本文默认）还是一律 `cancelLend`。
10. 新增 `reviewer_swap_effect{preserve}` 与 `continuity_close` 两种事件、`review_continuity` 意图 action 是否接受，或改用其它载体。
11. bridge 向 manager 的 claim / poll 追加 `signerFp` 参数（仿 `lend-inbox.ts:34-35`）；中心出借路由下 continuity 单的处理（本文默认 fail-closed）。
12. 一次接续 epoch 之后的轮次只限本机新 session（6.5-0 localOnly，本文默认）还是允许再挂池（须另一个批准）。
13. 开关在 C=reviewed 之后被关时，是否仍放行 6.5 的一次本机重绑（本文默认不放行、升级 owner；localOnly 保护不受开关影响）。

---

## 8. S2D2 与本卡不宣称的事

- S2D2 保持现等待；owner X13 前置保持；不称 S2D2 已恢复派审。
- 本文发布不触发迁移、退役、lend、新 epoch 或重启。
- 不证明本机 Code 此刻真为 0、HeCode 此刻真有空位（均为〔规格〕）。
- 不把额度写成策略拒审，不扩大 MODELX 豁免，不外发安全卡。
- 第 6 节是候选设计，不是实现批准；实施另立正式规格并先落实第 7 节。
