# E2b 讨论输入：A 侧状态对照与负例

> 状态：R1 已由 B 侧于 2026-10-07 14:16Z 冻结（head `9a2052b83e3c4a233d3db450426074accdd4f37b`，blob `8c8594c3`，sha256 `c8881904fc151093fb6a4f1f8409bf89151b50b7784e14b87648ed790ec3ee9d`）；blob 开头「待…批准冻结」是冻结前写的自述。P2 blob `c2143324` / `55b81b56` 同批冻结。
> 冻结只冻设计。**本文是讨论输入，不授权实现**；冲突处按下列修订：
> 状态名、消息名、原因码以 P2（`docs/design/e2b-protocol.md`）为准，本文与 P2 冲突处一律采信 P2，不改协议。
> 基础是 PR #773 的 A 侧设计稿（分支 `feat/e2ba-1`，`docs/design/e2b-a-side.md`，下称「A 稿」）。
> 本文不改 A 稿；A 稿那两句小修在 §5 写清楚，等 #773 解除 hold 后再合进去。
> 角色同 [现有入口盘点](./e2b-current-entry-inventory.md)：B = 仓库方（委托方），A = 执行方（接收方）。

## 0. 先说清楚的三件事

1. **E2b 的状态全部是「设计，未实现」。** 盘点 §2.1 末行：`src` 里没有 E2b 接单 / 激活 / 整卡唯一委托 / stop_confirm 入口。
   下表「现有落点」一列写的是**设计打算复用的现有原语**，不表示 E2b 已经接上它。
2. **业务效果和控制确认分开记（Shawn 要求）。**
   - 业务效果：推进卡、改外部世界的动作——建卡、派单、建 session、推分支、deliver、`merge_handoff`、生成新的业务回写。
     受业务效果闸管（P2 §3.2 第 1 条，同事务核）：委托行 `active` 且**不在 `handed` 或 `withdrawing` 子状态**、epoch 不变、租约有效。
     A 的 PM 手工推卡也要过这道闸。
   - 控制确认：报告状态、请求下一步、确认对方动作的签名消息——接单回执、对 `revoke` 的应答、`return_request`、
     `stop_confirm`、`renew_request` / `renew_ack`、`handoff_withdraw` / `withdraw_confirm`、B→A `complete`、`reclaim_confirm`、各条回执。**不受业务闸限制**，停下之后照样能发、能收（A 稿 §3.4）。
   - 每一次迁移都分两行记：业务效果落在哪本台账、控制确认由谁签发；**确认丢了只能重发或冻结，不能推断为已确认**。
3. **推进权与合并权分开。** 委托只转推进权；合并权、CI 闸、部署始终在 B（A 稿 §0、§2.2 第 5 条要求 `mergeHandoff: true`）。

## 1. 状态对照表

逐行对照 P2 §3.1（B 侧）、§3.2（A 侧）。A 委托行状态为 `queued` / `needs_owner` / `active` / `stopping` / `stopped` / `closed`，
`active` 下另有两个持久子状态 `handed`、`withdrawing`（P2 §3.2）。「推进卡」指作者侧推进（派单、建会话、推分支、deliver、生成 handoff / 业务回写）。

| # | A 委托行 | A 卡 | B 侧委托状态 | 谁推进卡 | 业务效果闸（P2 §3.2 第 1 条） | 现有落点（设计复用） |
|---|---|---|---|---|---|---|
| S0 | 无行 | 无 | `preparing` → `offering`（offer 已进 outbox；B 卡 workflow 已切 `delegated`） | 无人 | — | B：workflow mode（盘点 §3），`delegated` 模式未实现 |
| S1 | 只有接收日志（`rejected`） | 无 | `reclaimed`（A 签名回执确认未建卡；回 manual） | B | — | A：拒单只记日志、重发拿同一回执 |
| S2 | `queued` | 无 | `queued` | 无人 | 不适用（没有卡） | A：额度 / 槽口径同本机派单 |
| S3 | `needs_owner` | 无 | `needs_owner` | 无人 | 不适用 | A：authorize ask，`ask-bind.ts` |
| S4 | `active` | auto：restate → write → review → fix | `delegated` | **A** | 开 | A：v3 自动卡（`scheduler-auto-tick.ts`） |
| S5 | `active` / 子状态 `handed`（B 已签回执收下 handoff） | `merge` 等待：不排意图、不推分支、**不写 carry 回写** | `delegated/handed`（含 `handed/reopening`） | 无人推作者侧；**B** 做自己的审查、update-branch、合并 | **关**：A 只发控制消息 | 设计，未实现（P2 §3.1「handed 写口」） |
| S5w | `active` / 子状态 `withdrawing`（已发 `handoff_withdraw`，未收 `withdraw_confirm`） | 已离开 merge，停在原地 | `delegated/handed` 先停新效果、对账在途；结清后回 `delegated` | 无人 | **关**，直到 `withdraw_confirm` 或 `complete` | 设计，未实现（P2 §3.2 第 5 条、§6.4） |
| S6 | `closed`（completed） | 结束（MHO1 交回完成态），清理 worktree | `completed` | B（部署、核验在 B 本机） | — | 设计，未实现（P2 §6.8） |
| S7 | `stopping` | 原阶段，效果闸全关 | 普通：`delegated`（还不知道）或 `stopping`；handed 下失租：**保持 `delegated/handed`**；`notStopped` 非空 / 证据不合格：`frozen` | 无人推作者侧（handed 下 B 的合并照走） | 关 | A：出借失租自停（`lend-watchdog.ts`） |
| S8a | `stopped`，起因 `revoke` / `return_request` | `cancelled`（发出 `stop_confirm` 后） | `stopping` / `frozen` | 无人 | 关 | A：保全同出借收尾（`lend-reclaim-stopped.ts`） |
| S8b | `stopped`，起因租约过期，或收到终局 `stale_epoch` / `not_delegated`（一律按失租） | **暂停**：原阶段、原轮次，workflow 转 manual，`e2b_paused`；非终态 | 普通：`stopping`（起因失租）；handed：`delegated/handed` | 无人推作者侧 | 关（PM 手推也过闸） | 设计，未实现（P2 §3.2 第 3 条、§4.4） |
| S9 | `closed` | `cancelled`（S8b 收到 `reclaim_confirm` 时才转） | `reclaimed`（epoch+1，回 manual） | B | — | 设计，未实现（P2 §5.4） |

要点：

- **没有任何一行两端同时推进作者侧。** S5 / S5w 下 B 只做自己的审查与合并（P2 §3.1「handed 写口」），A 不产生业务效果。
- S5 的交接资格按 P2 §6.1-6.2：只表示 B 收到了一份完整、对得上的交接，可以开始 B 自己的流程，不是审查通过、互认或合并许可。
- update-branch 与 carry 归 B：交接后 PR 只合入了 main 时，以 B 的 `reviewMainCarryProof` 重算继承链（P2 §6.5）；A 不写 carry 事件、不回写。
  现有 MHO1 的 `merge_handoff_carry`（`scheduler-merge-handoff.ts:37`）只用于非委托 MHO1 卡，E2b 卡上不启用。**设计，未实现。**
- `complete` 是 **B→A** 控制消息（P2 §2.3、§6.8）：B 合并确认后发，A 只读核实 PR 后关闭本机委托。

## 2. 迁移：业务效果 × 控制确认

逐行对照 P2。列：触发；业务效果（有 / 无，写在哪）；控制或业务消息的方向与谁签确认；确认丢了怎么办；P2 条款。
消息类别以 P2 §2.3 为准：业务消息走业务 seq（严格按序、`gap` 补发），控制消息走独立 cSeq，不排队、不受业务闸限制（P2 §2.4）。
所有回执由收方实例签名；发方验签后才把 outbox 里那条标为已送达（P2 §2.4）。

### 2.1 接单与普通推进（B 在 `delegated` 及之前）

| 迁移 | 触发 | 业务效果 | 消息 / 谁签确认 | 确认丢了怎么办 | P2 |
|---|---|---|---|---|---|
| S0→S4 接单 | B→A `offer`（业务） | **有**：A 一个事务内核 12 条、落委托行、建 A 卡 | A 签终局回执 `accepted` | B 用同一 delegationId、同一 seq 重发，A 拿回原回执；或 B 收到 A 的首条业务消息即**推断接单**转 `delegated` | §2.3、§2.4、§3.1「推断接单」、§4.1 |
| S0→S2 / S3 | 同上，名额满 / 无授权 | 有：只落委托行，不建卡 | A 签 `queued` / `needs_owner` | 同上 | §4.1 |
| S0→S1 拒单 | 同上，12 条之一不过 | 无（只记接收日志） | A 签终局 `rejected:<码>`；B 转 `reclaimed` | B 重发拿同一回执 | §2.3、§3.1 `reclaimed` 行 |
| S2→S4 补位 | A 名额空出 | 有：重核 1–12 条、建 A 卡 | A→B `writeback{admission, accepted}`（业务 aSeq），B 签回执；B `queued`→`delegated` | A outbox 退避重发；缺口 `gap` 补发 | §4.1「排队补位」 |
| S2→S9 补位不过 | 同上 | 无：委托行转 `closed` | A→B `writeback{admission, rejected:<码>}`，B 签回执、转 `reclaimed` | 同上 | §4.1 |
| S3→S4 / S1 | A owner 答复 / 24h 超时 | 同意：有（建卡）；拒绝或超时：无 | A owner 的 authorize 答复（`checkAsk`）；对 B 是 `writeback{admission}` 或 `rejected:owner_timeout` | ask 答复丢失 = 没有答复，按超时；回写走 outbox | §4.1 第 2 条 |
| S4 内推进 | v3 调度 | **有**：阶段 / 审查 / deliver（A 台账），推分支、开 PR（GitHub，先登记 operationId） | A→B `writeback`（业务 aSeq），B 签 `{delegationId, epoch, aSeq, sha256}` | outbox 重发；`gap` 补发；同键异内容 409 → 冻结交收方 PM | §2.3、§2.4、§5.5 |
| S4 规格变化 | B→A `spec_update`（业务） | 有：A 卡 specRev+1、P1 连续计数清零 | A 签 `applied` / `needs_owner` / `rejected:<码>` | B 同 seq 重发，A 回原回执 | §4.3 |
| S4 续租 | A 每 60 秒 | 无 | A→B `renew_request`（控制），B 签 `renew_ack` | A 重发；到期仍没续上 → 失租行 | §4.4 |
| S4→S5 交接 | A 卡进 merge | **有**：生成 handoff（A 台账；闸要求 `active` 且不在 handed / withdrawing） | A→B `handoff`（业务 aSeq，引用 R1 包 `bundleId` 与 `manifestSha256`）；B 签 `handoff_received` 并附资格裁决；有资格时 B 转 `delegated/handed`，A 收到回执后委托行记 `handed` | A 同 aSeq 重发，B 拿回原回执；回执未到前 A 卡停 merge 等待、不排意图；裁 `handoff_rejected:<码>` → A 回 fix 或交 A 的 PM | §3.2、§6.1、§6.2 |

### 2.2 交接之后（B 在 `delegated/handed`）

| 迁移 | 触发 | 业务效果 | 消息 / 谁签确认 | 确认丢了怎么办 | P2 |
|---|---|---|---|---|---|
| S5 内：B 审查、update-branch、carry | B 自己的流程 | **A 侧无**；B 侧有（B 台账 / GitHub）。A 不推分支、不写 carry 回写；继承链由 B 用 `reviewMainCarryProof` 重算 | 无 A↔B 消息 | — | §3.1「handed 写口」、§6.5 |
| S5 续租 | A 照常 | 无 | A→B `renew_request`，B 在 `delegated/handed` 下照签 `renew_ack` | A 重发；到期 → handed 失租行 | §3.1「handed 期间的租约」、§4.4 |
| S5→S4 reopen | B 要求修改 | B 先停新的审查 / 合并效果并对账，记 `handed/reopening`；A：**有**，一个事务里 merge → fix，委托行离开 `handed` 回普通 `active` | B→A `reopen`（业务，带 B 当前 PR head）；A 签终局 `applied` | B 同 seq 重发；A 暂停中回暂态 `retry:not_active`（B 停在 `handed/reopening`，A 续租后重发）；A 已停止或关闭回终局 `rejected:not_active`，B 转 `stopping` | §3.1「reopen」、§3.2 第 4 条、§2.4 |
| S5→S6 完成 | B 合并队列确认合并成功 | A 侧无新效果；B 一个事务里委托行转 `completed`、`complete` 进 outbox | **B→A `complete`**（控制：mergeSha、prHead、mergedAt）；A 只读核实 PR merged、合并提交 = mergeSha、PR head = prHead，通过则委托行转 `closed`、A 卡结束、释放名额 | **B 重发**（outbox）；A 核实不通过回 `rejected:<码>` 交 A 的 PM，B 的 PM 对账 | §2.3、§6.8 |
| S5→S5w 撤回交接 | A 因自己的原因离开 merge（本地 P1、CI 红、主动退回；B 的 `reopen` 不算），或收到 `revoke` | 有（只限 A 台账）：同一事务记阶段变化、委托行转 `withdrawing`、`handoff_withdraw` 进控制 outbox；之后业务闸关 | A→B `handoff_withdraw{handoffASeq, evidenceSha256, head, reason}`（控制，带 outbox 里最近一份 handoff，不管其回执到没到）；B 签 `withdraw_received`（撤回先到时带 `early: true` 并记墓碑） | A 同 acSeq 重发，B 拿回同一回执；最近一份 handoff 已被撤回确认过或本轮没生成过 handoff → 不发撤回，直接离开 merge | §3.2 第 5 条、§6.4 |
| S5w 内 | B 回 `withdraw_received` | 无：**不解除**闸 | — | — | §3.2 第 5 条 |
| S5w→S4 撤回结清 | B 在途效果结清 | B：`delegated/handed` → `delegated`，阶段回到收下交接前；A：**有**，解除 `withdrawing`，从 `prHead` 起修 | B→A `withdraw_confirm{handoffSeq, handoffASeq, settled[], prHead}`（控制）；A 核 `handoffASeq` = 委托行记的那份 | B 重发；A 不超时，停在 `withdrawing`；`handoffASeq` 对不上不解除，交 A 的 PM | §3.2 第 5 条、§6.4 |
| S5w→S6 撤回前已合并 | B 对账发现合并已完成 | 同 S5→S6 | B 不发 `withdraw_confirm`，改发 **B→A `complete`** | 同 S5→S6；A 本地 P1 交 A 的 PM，作合并后的发现 | §3.2 第 5 条、§6.4、§6.8 |
| S5w 撤回对不上 | B 找不到对应交接 / 摘要不符 / 已撤过 | 无 | B 回终局 `rejected:withdraw_mismatch` 并冻结委托 | A 停在 `withdrawing`，交 A 的 PM | §6.4 |
| S5w 迟到回执 | 被撤那份 handoff 的终局 `handoff_rejected:withdrawn` 到达 | 无：只把 outbox 那条标为已送达 | — | — | §3.2 第 5 条 |

### 2.3 停止、续租与收回

| 迁移 | 触发 | 业务效果 | 消息 / 谁签确认 | 确认丢了怎么办 | P2 |
|---|---|---|---|---|---|
| S4→S7 撤回（普通） | B 撤回 | 有：A 一个事务内委托行转 `stopping`、停新效果，pending 意图取消、submitted 意图对账 | B→A `revoke`（控制）；A 签应答 `stopping` | B 用同 bcSeq 重发，A 回同一应答 | §2.3、§5.2 |
| S5→S7 撤回（handed） | 同上 | B 先停审查 / 合并效果并对账（P2 §3.1 末段），再进 `stopping`；A 同上，另按 §6.4 发 `handoff_withdraw` | 同上 + `handoff_withdraw` 一组回执 | 同上 | §3.1、§6.4 |
| S4 / S5→S7 退回 | A 的 PM / owner，或 A 推不动 | 同撤回；handed 下 B 先停自己的效果 | A→B `return_request`（控制），B 签应答 | A 重发；B 不确认不算结束 | §5.1、§2.3 |
| S4→S7 失租（普通） | A 到期仍没续上 | 有：A 自停新效果，A 卡暂停（`e2b_paused`）；B 转 `stopping`，停收业务写入 | 断网时发不出；恢复后先补发积压回写与 `stop_confirm` | 不超时、不自动收回；双方停住 | §4.4、§3.2 第 3 条 |
| S5→S7 失租（handed） | 同上 | A 本来无业务效果，按 §3.2 第 3 条暂停；**B 保持 `delegated/handed`**，自己的合并流程照走 | 同上 | 同上 | §3.1「handed 期间的租约」、§4.4 |
| S4 / S5→S7 被拒 | A 收到终局 `stale_epoch` / `not_delegated` | 同失租：一律按失租处理，A 卡暂停 | A 发 `stop_confirm` | 同上 | §3.2 第 3 条 |
| S7 部分停止 | 有会话 / 出借单停不下 | 无 | A→B `stop_confirm`（`notStopped` 非空）；B 转 `frozen` | A 停掉后用新 acSeq 重发完整一份，B 以 acSeq 最大的为准；`frozen` 收到合格的回 `stopping` | §5.3、§5.4 |
| S7→S8a | 起因 revoke / return，全部停下 | 有：A 卡 `cancelled`；worktree、分支保留到 `reclaim_confirm` | A→B `stop_confirm`（`notStopped` 为空、`orders[]` 全终结、`lastSeq`） | A 在 S8a 照样重发 | §5.2、§5.3、§3.2 第 3 条 |
| S7→S8b | 起因失租 / 被拒，全部停下 | 无新效果：A 卡保持暂停，非终态 | 同上 | 同上 | §5.2、§3.2 第 3 条 |
| S8b→S4 同 epoch 续租（普通） | A 恢复联系；B 仍在本 epoch、未撤回，B 是起因为失租的 `stopping`，且已按 §5.3 核过 `stop_confirm` | 有：A 先对账未结意图，再由**系统**（不是 PM）恢复 auto，从原阶段继续；B 回 `delegated` | A→B `renew_request`（在积压回写与 `stop_confirm` 之后），B 签 `renew_ack` | 没有 `renew_ack` 就留在 S8b；B 在 `frozen` 不续租 | §4.4 |
| S8b→S5 同 epoch 续租（handed） | 同上，B 在 `delegated/handed` | 无：A 回到交接后的 merge 等待 | 同上 | 同上 | §3.1「handed 期间的租约」、§4.4 |
| S8a 续租 | — | 不允许：撤回 / 退回起因同 epoch 不可能恢复，A 卡已 `cancelled` | — | 只能收回后重新委托（新 `delegationId`、新 A 卡） | §3.2 第 3 条 |
| S8a / S8b→S9 收回 | B 有停止证据、在途成果逐条处置（无 `hold`）、B 侧在途效果结清 | 有：B epoch+1、转 `reclaimed`；A 委托行转 `closed`，按 `disposition[]` 清理，A 卡转（S8b）/保持（S8a）`cancelled` | B→A `reclaim_confirm{newEpoch, disposition[]}`（控制） | B 重发；A 停在 S8 占资源、重发 `stop_confirm`；同卡新委托在 B 侧被唯一索引拦住、在 A 侧被第 9 条拒 | §5.4、§2.3 |

两条通用规矩：

- **生成**业务消息那一刻核业务闸；outbox **发送**时只核 epoch 属于这份委托（P2 §3.2 第 2 条）。停止时刻前已写进 outbox 的积压回写照样送达，B 收下只入历史和停止核对。
- A 重启后委托行状态从持久记录读回，`stopping` / `stopped` / `withdrawing` 不会因重启改变；先对账未结意图，再按上表继续。

## 3. 负例表

「依据」一栏写 A 稿的节号；本文新增的规则标「本文」。期望行为里的原因码是 A 稿已有的，没有的写「码待定」。

### 3.1 重复委托

| # | 输入 | 期望 | 依据 |
|---|---|---|---|
| N1 | 同一张 B 卡的 `d1`、`d2`（不同 `delegationId`）**同时**到达，授权上限 ≥ 2、槽都空 | 一份 `accepted`；另一份 `already_delegated`，附胜出那份的 `delegationId` 与状态；A 只建一张卡 | A 稿 §2.2 第 9 条（同事务 + 部分唯一索引） |
| N2 | `d1` 已 `accepted`（S4），之后**顺序到达** `d2` | `already_delegated`，附 `d1` 的 id 与 `active`；不排队、不建卡 | A 稿 §2.2 第 9 条；场景见 §5 第 2 条 |
| N3 | `d1` 在 `queued` 或 `needs_owner`，来了 `d2` | `already_delegated`（等待中的也算没关闭） | A 稿 §2.2 第 9 条括注 |
| N4 | `d1` 已 `stopped`（S8a / S8b），A 还没收到 `reclaim_confirm`，来了 `d2` | `already_delegated`；B 要先补发 `d1` 的 `reclaim_confirm`，A 行转 `closed` 后再委托（B 侧唯一索引本来就拦住同卡新 offer） | A 稿 §2.2 第 9 条后段；P2 §5.4 |
| N5 | `d1` 已 `closed`，来了 `d3` 但 epoch ≤ `d1` 的 epoch | 拒（码待定，A 侧倾向沿用 `already_delegated`） | A 稿 §2.2 第 9 条「epoch 必须更大」 |
| N6 | `d1` 重发，内容摘要相同 | 回原回执，不新建行、不新建卡 | A 稿 §2.3 幂等 |
| N7 | `d1` 重发，内容摘要不同 | 409；A 不改原行 | A 稿 §2.3 |
| N8 | `d1` 在 `queued` 时 B 撤回 | 直接转 `closed`，没有 A 卡要停 | A 稿 §2.2 第 9 条末句 |
| N9 | 两份委托 `delegationId` 不同但 B 卡号大小写 / 前后空白不同 | 码待定：A 侧倾向按 B 原样字节比，不做归一；B 卡号格式由 B 的 order-wire 规则约束（`order-wire.ts:80`） | 本文 |

### 3.2 离线与收回

| # | 输入 | 期望 | 依据 |
|---|---|---|---|
| N10 | A、B 断网，租约到期 | A 自停（S7），A 卡暂停；普通委托 B 转 `stopping`、停收业务写入；handed 下 B 保持 `delegated/handed`，自己的合并照走；**谁都不推作者侧** | P2 §3.1「handed 期间的租约」、§4.4 |
| N11 | B 在租约过期后看 GitHub 没有新推送，想收回 | 拒：静态观测不算停止证据，卡保持冻结，不加 epoch | A 稿 §6.3 第 2 条 |
| N12 | B owner 想在没有停止证据时强制收回 | 不在 E2b 收回路径内，另立项批准 | A 稿 §6.3 第 4 条、§11 第 8 条 |
| N13 | A 恢复联系后，在 `stopping` 下想发新的业务回写（`aSeq > lastSeq`） | A 的业务闸在生成时就拒；就算发出，B 回 `stale_epoch` | A 稿 §3.4 |
| N14 | A 恢复联系后发积压回写（`aSeq ≤ lastSeq`）与 `stop_confirm` | B 收下，只入历史和停止核对，不推进 B 卡 | A 稿 §3.4 |
| N15 | `stop_confirm.notStopped` 非空 | 只算部分停止：A **留在 S7**，B 转 `frozen`、不能据此收回；A 的 PM 手动停掉后重发 `notStopped` 为空的 `stop_confirm`，A 才进 S8a / S8b | A 稿 §6.3 第 2 条；P2 §3.1 |
| N16 | 冻结期间旧 worker 推送成功 | B 不采纳、不推进；A 的停止清单（`git ls-remote` 核的 head）列出这次推送，B 收回时逐条处置 | A 稿 §6.3 第 3 条 |
| N17 | B 已收回（epoch+1）之后才到的旧 `stop_confirm` | 收下，只作迟到历史，不改任何状态 | A 稿 §3.4 B 表 `reclaimed` 行 |
| N18 | A 在 S7 重启 | 委托行仍是 `stopping`，继续停止流程，不回 `active` | 本文 §2 通用规矩 |
| N18b | 撤回 / 退回起因的 S8a（A 卡 `cancelled`）发 `renew_request` | 拒：同 epoch 不可能恢复，终态卡不可重开；只能等 B 收回后重新委托（新 `delegationId`、新 A 卡） | P2 §3.2 第 3 条；A 稿 §3.1 |
| N18c | 回写被 B 以终局 `stale_epoch` 拒（A 分不清 B 是失租还是已收回） | 一律按租约过期处理：进 `stopping`、A 卡**暂停**而非 `cancelled`、发 `stop_confirm`；只有收到 `reclaim_confirm` 才转 `cancelled` | P2 §3.2 第 3 条 |
| N18d | S5（handed）或 S5w（withdrawing）下规划器算出新派单 / 推分支 | 业务闸拒：handed 期间 A 不产生业务效果，推了就是 head 漂移、交接失效；withdrawing 要等 `withdraw_confirm` | P2 §3.1、§3.2 第 1、5 条 |
| N19 | B 的逐条回执丢了 | A 重发同键，B 回原回执；不跳号、不重编号 | A 稿 §4.2 |

### 3.3 撤回与合并并发

合并权一直在 B，所以「并发」只有两类：B 的撤回撞上 A 的交接 / 跟随；B 的合并撞上 A 仍持有推进权。

| # | 输入 | 期望 | 依据 |
|---|---|---|---|
| N20 | B 的 `revoke` 与 A 生成 handoff 同时发生，**交接先提交** | handoff 已在 outbox、`aSeq ≤ lastSeq`，按积压送达；B 已是 `stopping`，只入历史和停止核对，**不产生交接资格**；A 另按 §6.4 发 `handoff_withdraw`；PR 列入停止清单的在途成果，B 收回时逐条处置 | P2 §3.2 第 2 条、§6.4、§5.4 |
| N21 | 同上，**撤回先提交** | 生成 handoff 在业务闸处被拒，不写交接事件、不发 handoff | P2 §3.2 第 1 条（闸含「生成 handoff」） |
| N22 | 撤回时 A 正在 `git push` | 推送结果记为 unknown 效果，写进 `stop_confirm.unknownEffects`；head 以 `git ls-remote` 为准；不重试推送 | A 稿 §6.1 第 3 步 |
| N23 | handed 期间 B 正在 update-branch 时，A 撤回交接或 B 撤回委托 | A 不做 carry 核对、不写 carry 回写（carry 归 B）；B 按两段回执先停新效果，已发出的 update-branch 读 PR head 核实，写进 `withdraw_confirm.settled[]` 和 `prHead`；A 从 `prHead` 起修 | P2 §3.1、§6.4、§6.5 |
| N24 | S5（handed）期间 B 合并成功 | B 委托行转 `completed`，**B→A `complete`**；A 只读核实 PR merged、合并提交 = mergeSha、PR head = prHead，通过则关闭本机委托（S6） | P2 §6.8 |
| N25 | `complete` 到达，但 A 只读核实不通过（PR 未合并、mergeSha 或 prHead 对不上） | A 不关闭委托，回 `rejected:<码>` 交 A 的 PM；B 的 PM 收到后对账。PR head 被 B 的 update-branch 改过不归 A 判（继承链由 B 重算），A 只核 `prHead` 与 GitHub 一致 | P2 §6.5、§6.8 |
| N26 | S4（还没交接，A 仍在 review / fix）时 B 在 GitHub 上直接合并 PR | **B 应先撤回再合并**（B 侧只观察模式应拒绝 B 调度器合并这张卡，B 实现）。若 owner 绕过闸手工合并：A 下一次读 PR 发现已合并 → 进停止流程，`return_request{reason: merged_externally}`（码待定）；A 不再推分支。**设计，未实现**：A 现在只在 merge 阶段读 PR 状态（`scheduler-merge-handoff-tick.ts`），review / fix 阶段要加这次读 | 本文；A 稿 §9「B 的 PM 手推 B 卡阶段」 |
| N27 | B 在 `stopping` / `frozen` 期间合并 PR | 合并是 B 的权利，A 不阻止也阻止不了；A 在停止清单里写明「PR 合并时 head」与「A 最后推送 head」是否一致，供 B 核对 | 本文 |
| N28 | B 的 `revoke` 与 A 的 `return_request` 交叉 | 两者都进同一个停止流程；`stop_confirm` 同时记两个发起原因；只走一次 | A 稿 §6.1；本文 |
| N29 | `stopping` 期间 B 发 `spec_update` / `reopen` | 拒（码待定，A 侧倾向 `not_active`）：这两条是业务消息 | A 稿 §3.4 |

## 4. 确认丢失的总表（按丢的是哪一条）

| 丢失的确认 | 丢在哪一侧 | 后果 | 处理 |
|---|---|---|---|
| A 的接单回执 | B 没收到 | B 停在 S0，卡没人推 | B 用同一 `delegationId` 重发（N6）；**换 ID 会撞 N2** |
| B 的逐条回执 | A 没收到 | outbox 积压；交接被挡（交接要求 outbox 清空） | 重发；超 15 分钟提醒 A 的 PM 一次（A 稿 §4.3） |
| A 对 `revoke` 的应答 | B 没收到 | B 不知道 A 停了没有 | B 重发 `revoke`；同时可以等 `stop_confirm`，两者都是停止证据的一部分 |
| A 的 `stop_confirm` | B 没收到 | B 停在 `stopping` | A 在 S8a / S8b 重发（新 acSeq 以最大为准）；B 不得超时收回（N11） |
| B 的 `reclaim_confirm` | A 没收到 | A 停在 S8 占资源；同卡新委托被拒（N4） | B 重发；A 收到后转 `closed` |
| B 的 `renew_ack` | A 没收到 | A 到期按失租暂停（S7 / S8b） | A 重发 `renew_request`；B 核过 `stop_confirm` 后再回 `renew_ack` |
| B 的 `withdraw_confirm` | A 没收到 | A 停在 `withdrawing`，业务闸关 | B 重发；A 不超时 |
| B→A `complete` | A 没收到 | A 委托行仍是 `active/handed`，A 卡停在 merge 等待，不产生效果 | **B 重发**（outbox）；A 收到后只读核实再关闭 |

## 5. 对应 A 稿的小修（只写在这里，不改 #773）

1. **A 稿 §3.4 要回指 §2.2 第 9 条。** §3.4 讲「同一时刻只有一个调度器推进」靠 epoch，但 epoch 只挡「旧 epoch 的效果」，
   挡不住 A 本机**两份不同 `delegationId`** 同时是 `active`——那是 §2.2 第 9 条（同一张 B 卡在 A 侧最多一份没关闭的委托）挡的。
   建议在 §3.4 规则那句后加：「A 本机的唯一性由 §2.2 第 9 条保证；epoch 只负责跨两端的新旧之分。」本文 §1 的对照表即按这个分工写。
2. **补「顺序到达的 d2 被拒」场景。** A 稿 §10 场景 2 只写了 `d1`、`d2` 同时到达。建议加一句：
   「`d1` 已 `accepted` 并在推进中，B 再发 `d2`（新的 `delegationId`，同一张 B 卡）→ `already_delegated`，附 `d1` 的 id 与状态，
   A 不排队、不建第二张卡；`d1` 在 `queued` / `needs_owner` / `stopped` 时同样被拒。」对应本文 N2、N3、N4。
3. **（附带发现）A 稿 §6.1 第 5 步与 §6.3 续租待定项互相矛盾**：§6.1 在停止确认后把 A 卡一律转 `cancelled`，§6.3 却设想停止确认后续租回 `active`。
   P2 §3.2 第 3 条已按起因拆开解决：撤回 / 退回起因转 `cancelled`；租约过期起因 A 卡暂停（`e2b_paused`，非终态），续租回 active，`reclaim_confirm` 才转 `cancelled`。A 稿 §6.1 第 5 步应按此改写，本文 §1 的 S8a / S8b 即按 P2 写。

## 6. 留给 P2 的问题（本文不决定）

1. ~~B 侧状态名与 `complete` 方向~~：已按 P2 §3.1、§6.8 对齐（`preparing` / `offering` / … / `completed`，`complete` 为 B→A）。
2. N5、N9、N25、N26、N29 的原因码。
3. N26：是否要求 A 在 review / fix 阶段也读 PR 状态，读频多少；还是只靠 B 侧闸挡住「未撤回就合并」。
4. ~~续租用同一 epoch 还是重新委托~~：P2 §4.4 定为允许同 epoch 续租（条件见 §2「续租」行）。

接线点（留给后续实现卡）：A 侧委托表与效果闸（A 稿 §3.4 `e2b_delegations`）、outbox（仿 `peer-pr-push.ts` 的推送重试）、
停止清单命令（A 稿 §6.1 提案的 `ledger e2b-stop-report`）、N26 的 PR 状态读取（`scheduler-merge-handoff-tick.ts` 旁）。
