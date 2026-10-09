# RVQUOTA1 · 原审查会话到额度线后的安全接续设计

> 只是诊断与设计文档。没有改调度、会话绑定、原会话、订单、MODELX、名额 / 额度线、配置或任何代码 / 测试；
> 没有为诊断真实换会话、退役、发 lend、开新审查 epoch、接续旧拒审或启用开关；没有读台账、会话记录、quota-state、凭据或私有工件。
> 基线 head `c4ab21eebfe98a021bd8b6f48f085b677f309ee4`（specRev 1，第 0 轮）。依赖 [QSRC1](./quota-source-consistency.md) 的资格契约 C1–C3，
> 以及 MODELX / MODELXW / MODELXP 与 RVSRC1 已在本基线合入的正式来源。实施另立正式规格；本文所列 owner 待定项在批准前**一律保持现规则**。

标签：

- **〔源〕** 在上述 head 源码里逐行读到的行为（附 `文件:行`）。
- **〔规格〕** 取自本卡规格的事实陈述（S2D2 现状），本文没有读台账核实，不补、不推。
- **〔推〕** 对源码判据的纸面推演，可对照所引行号逐条复核；**不是**运行结果。
- **〔假〕** 推断，实施前须核；**〔拟〕** 本文提议的机制；**〔待定〕** 需要 owner 拍板。

本文**没有**跑任何探针。尤其没有用「只配空 registry / 缺 pool 的 plan 快照」去算容量——那种探针只证明某分支可达，不是当前容量事实；
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
| 原审查员上一轮给过结论、本轮未发 | 继续等 | 可进入准备；旧 report / findings / P1 streak 全部保留（6.4） |

### 4.2 边界变化（在准备 → 授权 → 写 epoch → 派单 → claim → 通知 任一 await 之间发生）

| 变化 | 处理 |
|---|---|
| head 变（新交付） | 作废未写入的准备与授权；已写的 epoch 绑定旧 head，不覆盖新 head（`inWindow` 同款判据 `scheduler-review-swap.ts:254`）；作者家族若变，走 FAM1a 原路径 |
| specRev 变 / round 变 | 同上，全部作废，重算 |
| task.rev 变（阶段 / 意图被他人推进） | 事务 CAS 失败 → 零写、重算 |
| 权限变（owner 撤销、批准过期、项目改为 manual / observe） | 零写；已写 epoch 但未派 → 新单不派、等待 owner；不恢复旧绑定 |
| 额度变：回落线下 | 未写 epoch → 放弃迁移，原 session 复派（F5）；已写 epoch → 不回滚（避免两个审查员），按新 epoch 继续 |
| 额度变：读数变 stale / 冲突 | 未写 epoch → 零写（失去 Q1 资格） |
| peer 身份变（hello 指纹 / 机器名 / 授权仓库变化、槽位归 0） | 派单前重核：失败 → wait placement；不切到其它未授权 peer |
| 原审查员复活（6.5） | 未写 epoch → 迁移作废；已写 epoch → 旧 session 结论不认 |
| 出现策略拒审 / safety hold | `openRefusal` 优先（同 `reviewSwapPlan` `:86-87`），迁移作废，走 MODELX |

### 4.3 并发与重启

| 场景 | 处理 |
|---|---|
| 双 PM 同时点批准 | 批准记录按 `(task, head, specRev, round, 原 sessionId)` 去重；第二次重放同一记录，不生成第二个批准 |
| 双 tick 同时写 epoch | epoch 事件 dedupKey 唯一（6.3），`BEGIN IMMEDIATE` 内重读；第二个 tick 读到已写 → 返回同一结果 |
| 迁移与 FAM1a 换人 / MODELX epoch 竞争 | 同一事务读 `latestReviewerSwap`：本轮已有任何 swap → 迁移零写（与 `applyReviewerSwap` `:171` 一致） |
| 退出再恢复（bridge / scheduler 重启） | 准备与授权只存台账；重启后从台账重算，不从内存续；派单 intent 若 unknown → 对账，不重派 |
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

### 6.1 准入（全部满足才可能提出新 epoch）

1. 状态：`stage=review`、`workflow.mode=auto`、`template≠security`、本轮无活 review intent（pending/submitted/unknown 都不行）、
   `strayPoolOrders` 空、本轮无 `reviewer_swap`、`openRefusal` 为 null、无未收尾换人效果。
2. 原审查员：绑定行 `state=active`、`source=local`、`keepsReviewer` 成立；registry 中该 agent `status=stopped` 或可核为空闲且无待回票据；
   身份（agent + sessionId + family）与 `session_bind` 事件一致。
3. 额度：当前绑定账户、审查家族的 C1 合格周读数 `>=` 线（Q1）；记录读数摘要（账户键、窗口、usedPct、observedAt、resetAt、layer）。Q2 一律不准入。
4. 目标 peer：在借入名单、`poolPeerRefusal` 为 null（`scheduler-agent-pool.ts:10-20`）、未在本轮 tried、授权本仓库；家族 = 原审查家族。
5. owner 授权：逐卡批准记录，绑定 `(task, head, specRev, round, 原 agent/sessionId, 额度读数摘要, 目标 peer)`，带过期时间；可撤销。

### 6.2 流程与每步重核

```
plan(observedOnly 于 observe) → ask owner → approve(record) → apply epoch(tx) → dispatch review intent(pool) → peer claim → notify
```

每个 await 前后、以及 apply / dispatch 的事务内，重核：task.rev、head、specRev、round、stage、workflow.mode、
原绑定行与 registry 身份、无活 intent / 池单、`openRefusal`、额度读数仍为同一合格事实（或更新的同账户合格事实仍 `>=` 线）、
批准未撤销未过期、目标 peer 仍合法、调度租约。任一失败 → 零写或停在当前步，不回滚已写 epoch、不重放已发外部效果。

### 6.3 epoch 形状

- 复用 `reviewer_swap` 事件族，新增 `continuity` 字段（与 `refusal` / `legacy` 并列、互斥）：
  `{ reason:"quota", approvalId, quotaFact:{…摘要}, fromSession, toPeer }`，并带 `round/head/specRev/intentId`。
- dedupKey：`scheduler:review-continuity:s{born}:r{round}`；每轮至多一次（与 FAM1a「本轮已换过」同口径）。
- 同一事务：写事件 + 原绑定 `state=retired`、`retireIntentId=epoch intent`；**不** kill、不唤醒原 session（同 MODELXW legacy 退役不唤醒的先例，`mayRebindReviewer` `:223-224`）。
- 新审查是 one-shot 池单：`reviewerHistory` 本就过滤 `peer:` 审查（`:42`），下一轮可再走正常放置；是否回到本机新建绑定由正常 `ensure_session` 决定。

〔假〕`reviewsAfterSwap` 以最新 swap 为界截断审查历史（`:21-24`）。实施卡须确认 P1 streak / roundCap / `reviewStartRound` 的计算**跨 epoch** 保留原轮次结论，否则会丢 P1 连续轮次——这是实施前必须核的点，不在本文假定已满足。

### 6.4 失败与撤销保全

| 时点 | 失败 / 撤销结果 |
|---|---|
| 准备 / 批准阶段 | 无任何写入；原绑定、原等待照旧 |
| epoch 事务内 CAS 失败 | 零写 |
| epoch 已写、派单前失败（peer 失格、批准被撤） | 新 review 不派，`wait` / 升级给 owner；**不**自动恢复旧绑定（恢复须 owner 另行决定，避免两个活审查员）；原 report 不动 |
| 派单后 unknown | 既有池单对账；不重派、不另起 |
| peer 审查被策略拒审 | 走 MODELXP2 原路径，不叠加本方案 |

### 6.5 旧 session 恢复竞争与来源消歧

- 未写 epoch 前原 session 复活 / 额度回落：迁移作废，原规则复派（F5）。
- epoch 写入后原 session 复活：其绑定已 retired，`sessionGate` 不会再派给它；若它经旧票据提交 verdict，入账判据须要求
  verdict 绑定的 intent 属于**当前** epoch（intent.eventSeq > epoch.seq），否则拒收并记一条只读 note，不当本轮结论、不当 PASS。
- 新审查的结论只认新池单（订单号 + peer + 新 intent），`reviewer` 字段为 `peer:<机器>`；旧 session 的结论不得「沿新 session」冒名。

### 6.6 开关（拟议名不落库；当前不写策略键）

- 三态 on / observe / off，**默认 off**。
- off：本文所有拟议代码路径不可达，1.2 链逐字节不变。
- observe：只写一条 note「若开启将如何」，不 ask、不写 epoch、不改绑定；与原 wait 并存。
- on：仍须逐卡 owner 批准；无批准时与 off 相同，继续等待 / 人工队列。
- 验收（实施卡）：off/observe 下 F1–F6 结果与本基线一致；on 无批准时同 off；4.1–4.3 每行一条负例或正例测试。

---

## 7. owner 待定项（不批准实现）

1. 是否允许任何「额度到线」触发审查会话连续性例外（改变 `keepsReviewer` 规则本身）。
2. 自动迁移权限：仅逐卡人工批准，还是允许某种常设授权；本文只设计逐卡批准。
3. 开关键名、默认值与作用域（项目 / 全局）；本文提议默认 off。
4. epoch 写入后的撤销语义：是否允许 owner 把绑定还给原 session，以及与新池单的互斥。
5. 原 session 在迁移后的处置（保留 / 归档 / 停止）及其回执要求。
6. 额度到线判据用哪条线（QSRC1 待定 3、4）与路径 A / B 分歧期间是否一律视为 Q2。
7. 跨 epoch 的 P1 streak / roundCap 计算口径（6.3〔假〕）。
8. 旧票据迟到 verdict 的拒收位置（入账闸 / MCP 工具 / 两者）。

---

## 8. S2D2 与本卡不宣称的事

- S2D2 保持现等待；owner X13 前置保持；不称 S2D2 已恢复派审。
- 本文发布不触发迁移、退役、lend、新 epoch 或重启。
- 不证明本机 Code 此刻真为 0、HeCode 此刻真有空位（均为〔规格〕）。
- 不把额度写成策略拒审，不扩大 MODELX 豁免，不外发安全卡。
- 第 6 节是候选设计，不是实现批准；实施另立正式规格并先落实第 7 节。
