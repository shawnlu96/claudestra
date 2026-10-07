# E2b 讨论输入：A 侧状态对照与负例

> 状态：**讨论输入，不授权实现**。P2、R1 已冻结，冲突处按下列修订：状态名、消息名、原因码以 P2（`docs/design/e2b-protocol.md`，blob `c2143324`）为准，
> 本文与 P2 冲突处一律采信 P2，不改协议。
> 基础是 PR #773 的 A 侧设计稿（分支 `feat/e2ba-1`，`docs/design/e2b-a-side.md`，下称「A 稿」）。
> 本文不改 A 稿；A 稿那两句小修在 §5 写清楚，等 #773 解除 hold 后再合进去。
> 角色同 [现有入口盘点](./e2b-current-entry-inventory.md)：B = 仓库方（委托方），A = 执行方（接收方）。

## 0. 先说清楚的三件事

1. **E2b 的状态全部是「设计，未实现」。** 盘点 §2.1 末行：`src` 里没有 E2b 接单 / 激活 / 整卡唯一委托 / stop_confirm 入口。
   下表「现有落点」一列写的是**设计打算复用的现有原语**，不表示 E2b 已经接上它。
2. **业务效果和控制确认分开记（Shawn 要求）。**
   - 业务效果：推进卡、改外部世界的动作——建卡、派单、建 session、推分支、deliver、`merge_handoff`、生成新的业务回写。
     受 A 稿 §3.4 的效果闸管（委托行 `active` + epoch 不变 + 租约有效，同事务核）。
   - 控制确认：报告状态、请求下一步、确认对方动作的签名消息——接单回执、对 `revoke` 的应答、`return_request`、
     `stop_confirm`、`renew_request`、B 的逐条回执和收回确认。**不受业务闸限制**，停下之后照样能发、能收（A 稿 §3.4）。
   - 每一次迁移都分两行记：业务效果落在哪本台账、控制确认由谁签发；**确认丢了只能重发或冻结，不能推断为已确认**。
3. **推进权与合并权分开。** 委托只转推进权；合并权、CI 闸、部署始终在 B（A 稿 §0、§2.2 第 5 条要求 `mergeHandoff: true`）。

## 1. 状态对照表

A 委托行状态取自 A 稿 §2.3、§3.4；B 侧状态取自 A 稿 §3.4 的 B 表，`offered`、`待收回`、`completed` 是本文补的提案。

| # | A 委托行 | A 卡 | B 侧委托状态 | B 卡 | 推进权 | 现有落点（设计复用） |
|---|---|---|---|---|---|---|
| S0 | 无行 | 无 | `offered`（已发委托、未收到回执） | 只观察（发委托前已切） | 无人推进 | B：workflow mode 现有 manual/observe/auto（盘点 §3），只观察模式名未定 |
| S1 | 只有接收日志（`rejected`） | 无 | 收到 `rejected` → 回到 B 自己的模式 | B 自己的模式 | B | A：拒单只记日志、重发拿同一回执（A 稿 §2.3） |
| S2 | `queued` | 无 | `delegated`（排队中） | 只观察 | 无人推进（等 A 补位） | A：额度 / 槽口径同本机派单（A 稿 §2.2 第 3、6 条） |
| S3 | `needs_owner` | 无 | `delegated`（等 A owner） | 只观察 | 无人推进 | A：authorize ask，`ask-bind.ts` 的 bindHash / checkAsk |
| S4 | `active` | `auto`，restate → write → review → fix | `delegated` | 只观察，投影 A 的回写 | **A** | A：v3 自动卡（`scheduler-auto-tick.ts`）；效果闸紧贴效果（T68h 做法） |
| S5 | `active` / `handed` | `merge`，已记 `merge_handoff` | `delegated` / `handed`（P2 §6.2） | 只观察；B 开始自己的合并审查流程 | A 只跟随 PR；**合并由 B** | `recordMergeHandoff` / `handoffOf`（`scheduler-merge-handoff.ts`） |
| S6 | `active` | `live`（PR 已在跟随的 head 合并） | `completed`（提案） | B 收尾 | 无 | `merge → live`（merge-handoff.md「Flow」末行） |
| S7 | `stopping`（含「部分停止」：已发 `stop_confirm` 但 `notStopped` 非空） | 原阶段（**非终态**），效果闸全关 | `delegated`（B 还不知道）或 `stopping` | 只观察 | **无人推进** | A：出借租约失效自停（`lend-watchdog.ts`） |
| S8 | `stopped`（在途 session **全部**确认停下，`stop_confirm.notStopped` 为空） | `cancelled`（终态，不可重开），worktree / 分支保留 | `stopping` / `待收回` | 冻结 | 无人推进 | A：保全同出借收尾（`lend-reclaim-stopped.ts`） |
| S9 | `closed` | 终态：经 S8 收回的是 `cancelled`；经 S6 完成关闭的是 `live` | `reclaimed`（epoch 已加一）或 `completed` 已关闭 | B 自己的模式 | B | — |

要点：

- **没有任何一行两端同时有推进权。** S0、S2、S3、S7、S8 是「两边都不推」，这是故意的：断网或确认丢失时宁可停住（A 稿 §3.4 末段）。
- S5 的交接资格按 P2 §6.1-6.2：只表示 B 收到了一份完整、对得上的交接，可以开始 B 自己的流程，不是审查通过、互认或合并许可。
- S6 是 A 稿没有写的终点（A 稿只写了撤回 / 退回 / 过期三种结束）。本文提案：PR 合并后 A 发控制消息 `complete{delegationId, epoch, mergeSha}`，
  B 确认后加 epoch 关闭，A 行转 `closed`。走的仍是 §6.3 的「收回」，只是停止清单为空、成果已合并。

## 2. 迁移：业务效果 × 控制确认

每行左边是业务效果（受 A 稿 §3.4 业务闸），右边是控制确认（不受业务闸）。「确认丢了」一列都只有三种结果：重发、冻结、退人工。

| 迁移 | 触发 | 业务效果（写在哪） | 控制确认（谁签、载体） | 确认丢了怎么办 |
|---|---|---|---|---|
| S0→S4 接单 | B 发委托 | A 同一事务：核 A 稿 §2.2 九条 → 落委托行 + 建 A 卡（A 台账） | A 实例签接单回执 `{delegationId, outcome:accepted, aTask}` | B 停在 S0，用**同一个** `delegationId` 重发；A 命中原行，回原回执（A 稿 §2.3 幂等）。B 不得把「没收到」当拒，也不得换新 ID 重发（会撞 §3 N2） |
| S0→S2 / S3 | 并发满 / 无授权 | A 落委托行，不建卡 | A 签 `queued` / `needs_owner` 回执 | 同上 |
| S0→S1 拒单 | 九条之一不过 | A 只记接收日志 | A 签 `rejected{reason}` 回执 | 同上；B 收到前不得回到自己的模式 |
| S2→S4 补位 | A 槽空出 | 九条全部重核 → 建 A 卡 | 业务回写 `accepted`（带 `aSeq`），B 签逐条回执 | outbox 重发（A 稿 §4.3）；B 在收到前一直显示排队 |
| S3→S4 / S1 | A owner 答复 | 同意 → 建 A 卡；拒绝 / 24h 超时 → 无 | A owner 的 ask 答复（`checkAsk` 按调用者核 bind）；对 B 是业务回写 | ask 答复丢失 = 没有答复，按超时拒；回写丢失走 outbox |
| S4 内阶段推进 | v3 调度 | A 卡 stage / review / deliver 事件（A 台账）；推分支、开 PR（GitHub） | 每条回写 `(delegationId, epoch, aSeq)`，B 签 `{delegationId, epoch, aSeq, sha256}`（A 稿 §4.2） | outbox 退避重发；缺口 `gap{expect}` 补发；同键异内容 409 → 冻结交 A 的 PM |
| S4 规格追加 | B 发 `spec_update` | A 卡 specRev+1，P1 计数清零（A 台账） | A 签回执；B 卡 specRev 由 B 自己记 | B 重发同一 `spec_update`；A 同键同摘要回原回执 |
| S4→S5 交接 | A 卡进 merge | `merge_handoff` 事件（A 台账）；**前提 outbox 清空**（A 稿 §4.3） | handoff（引用 R1 包的 `bundleId` 与 `manifestSha256`），B 签回执；回执只表示收到，资格由 B 按 P2 §6.2 裁决 | 重发；B 未回执前 A 只跟随 PR，不做任何别的效果 |
| S5 内 carry | owner 合入 main | `merge_handoff_carry` 事件（A 台账，`scheduler-merge-handoff.ts:37`） | 回写 + B 回执 | 同上 |
| S5→S4 reopen | B 要求修改 | A 卡 merge → fix（A 台账） | B 签 `reopen`；A 回执 | B 重发；A 未收到前停在 S5 跟随 |
| S5→S6 合并 | **B** 合并 PR | B 的合并（GitHub、B 台账）；A 卡 `merge → live` | A 发 `complete`（提案）；B 签关闭确认 | A 重发 `complete`；A 卡已终态，业务闸无事可放，丢确认不会双推 |
| S4/S5→S7 撤回 | B 发 `revoke` | A 同一事务：委托行 → `stopping`，取消 pending 意图，submitted 意图照常对账 | A 签对 `revoke` 的应答 | B 重发 `revoke`；A 已是 `stopping`，回同一应答 |
| S4/S5→S7 退回 | A 的 PM / owner 或 A 推不动 | 同上 | A 先发 `return_request{reason}` 再进停止流程 | `return_request` 走 outbox 重发；B 不确认就不算结束 |
| S4/S5→S7 失租 | 租约到期未续上 | A 自停（同上），保留现场与 journal | 断网时**发不出**；恢复后补发 `stop_confirm` | 没有确认就一直停在 S7 / S8，B 停在 `待收回`，不自动收回；恢复后想续推进只能在进 S8 之前（见下方「续租」行） |
| S7 内部分停止 | 有 session 停不下来 | 无（A 卡保持原阶段、非终态） | A 签 `stop_confirm`，`notStopped` 非空 = **部分停止**，B 不能据此收回 | **留在 S7**；A 的 PM / owner 手动停掉后再发一份（N15） |
| S7→S8 停稳 | 在途 session **全部**确认停下 | A 卡 → `cancelled`（终态）；worktree、分支保留 | A 签 `stop_confirm`，`notStopped` 为空——**只有这一份**能作为收回依据 | 在 S8 照样重发 `stop_confirm`（A 稿 §3.4 表）；B 只看 `notStopped` 为空的那份 |
| S8→S9 收回 | B 核清停止证据 | B 加 epoch、收回推进权（B 台账） | B 签收回确认 | A 停在 S8 继续占资源、重发 `stop_confirm`；同一张 B 卡的新委托被 A 稿 §2.2 第 9 条拒，直到 B 补发收回确认 |
| S6→S9 完成关闭 | B 确认 `complete` | B 加 epoch、关闭委托（B 台账）；A 委托行 → `closed`，A 卡保持 `live` | B 签关闭确认 | A 重发 `complete`（见 §4） |
| S7→S4 续租 | A 恢复联系（**待定**，A 稿 §6.3），**只限 S7**（失租原因、A 卡还没进终态） | 无，直到 B 同意；同意后委托行回 `active`，原 A 卡继续 | 先发完积压回写，再发 `renew_request`；B 签同意 | 没有同意就留在 S7；**S8 不能续租**：A 卡已 `cancelled`，终态卡不可重开（A 稿 §3.1），只能收回后重新委托、新建 A 卡 |

两条通用规矩：

- **生成**业务回写那一刻核业务闸；outbox **发送**时只核 epoch 属于这份委托，不再核 `active`（A 稿 §3.4）。所以停下前已写进 outbox 的回写（`aSeq ≤ lastSeq`）照样送达，B 收下只入历史。
- A 重启后委托行状态从持久记录读回，`stopping` / `stopped` 不会因重启变回 `active`；先对账未结意图，再按上表继续。

## 3. 负例表

「依据」一栏写 A 稿的节号；本文新增的规则标「本文」。期望行为里的原因码是 A 稿已有的，没有的写「码待定」。

### 3.1 重复委托

| # | 输入 | 期望 | 依据 |
|---|---|---|---|
| N1 | 同一张 B 卡的 `d1`、`d2`（不同 `delegationId`）**同时**到达，授权上限 ≥ 2、槽都空 | 一份 `accepted`；另一份 `already_delegated`，附胜出那份的 `delegationId` 与状态；A 只建一张卡 | A 稿 §2.2 第 9 条（同事务 + 部分唯一索引） |
| N2 | `d1` 已 `accepted`（S4），之后**顺序到达** `d2` | `already_delegated`，附 `d1` 的 id 与 `active`；不排队、不建卡 | A 稿 §2.2 第 9 条；场景见 §5 第 2 条 |
| N3 | `d1` 在 `queued` 或 `needs_owner`，来了 `d2` | `already_delegated`（等待中的也算没关闭） | A 稿 §2.2 第 9 条括注 |
| N4 | `d1` 已 `stopped`（S8），A 还没收到 B 的收回确认，来了 `d2` | `already_delegated`；B 要先补发 `d1` 的收回确认，A 行转 `closed` 后再委托 | A 稿 §2.2 第 9 条后段 |
| N5 | `d1` 已 `closed`，来了 `d3` 但 epoch ≤ `d1` 的 epoch | 拒（码待定，A 侧倾向沿用 `already_delegated`） | A 稿 §2.2 第 9 条「epoch 必须更大」 |
| N6 | `d1` 重发，内容摘要相同 | 回原回执，不新建行、不新建卡 | A 稿 §2.3 幂等 |
| N7 | `d1` 重发，内容摘要不同 | 409；A 不改原行 | A 稿 §2.3 |
| N8 | `d1` 在 `queued` 时 B 撤回 | 直接转 `closed`，没有 A 卡要停 | A 稿 §2.2 第 9 条末句 |
| N9 | 两份委托 `delegationId` 不同但 B 卡号大小写 / 前后空白不同 | 码待定：A 侧倾向按 B 原样字节比，不做归一；B 卡号格式由 B 的 order-wire 规则约束（`order-wire.ts:80`） | 本文 |

### 3.2 离线与收回

| # | 输入 | 期望 | 依据 |
|---|---|---|---|
| N10 | A、B 断网，租约到期 | A 自停（S7），B 停收旧 epoch 业务写入、停在 `待收回`；**谁都不推进** | A 稿 §6.2 |
| N11 | B 在租约过期后看 GitHub 没有新推送，想收回 | 拒：静态观测不算停止证据，卡保持冻结，不加 epoch | A 稿 §6.3 第 2 条 |
| N12 | B owner 想在没有停止证据时强制收回 | 不在 E2b 收回路径内，另立项批准 | A 稿 §6.3 第 4 条、§11 第 8 条 |
| N13 | A 恢复联系后，在 `stopping` 下想发新的业务回写（`aSeq > lastSeq`） | A 的业务闸在生成时就拒；就算发出，B 回 `stale_epoch` | A 稿 §3.4 |
| N14 | A 恢复联系后发积压回写（`aSeq ≤ lastSeq`）与 `stop_confirm` | B 收下，只入历史和停止核对，不推进 B 卡 | A 稿 §3.4 |
| N15 | `stop_confirm.notStopped` 非空 | 只算部分停止：A **留在 S7**，B 不能据此收回；A 的 PM 手动停掉后重发 `notStopped` 为空的 `stop_confirm`，A 才进 S8 | A 稿 §6.3 第 2 条 |
| N16 | 冻结期间旧 worker 推送成功 | B 不采纳、不推进；A 的停止清单（`git ls-remote` 核的 head）列出这次推送，B 收回时逐条处置 | A 稿 §6.3 第 3 条 |
| N17 | B 已收回（epoch+1）之后才到的旧 `stop_confirm` | 收下，只作迟到历史，不改任何状态 | A 稿 §3.4 B 表 `reclaimed` 行 |
| N18 | A 在 S7 重启 | 委托行仍是 `stopping`，继续停止流程，不回 `active` | 本文 §2 通用规矩 |
| N18b | A 已在 S8（A 卡 `cancelled`）后发 `renew_request` | 拒：终态卡不可重开；只能等 B 收回后重新委托（新 `delegationId`、新 A 卡） | A 稿 §3.1；本文 §2「续租」行 |
| N19 | B 的逐条回执丢了 | A 重发同键，B 回原回执；不跳号、不重编号 | A 稿 §4.2 |

### 3.3 撤回与合并并发

合并权一直在 B，所以「并发」只有两类：B 的撤回撞上 A 的交接 / 跟随；B 的合并撞上 A 仍持有推进权。

| # | 输入 | 期望 | 依据 |
|---|---|---|---|
| N20 | B 的 `revoke` 与 A 的 `merge_handoff` 同时发生，**交接先提交** | 交接事件已写入、其回写 `aSeq ≤ lastSeq`，按积压回写送达；B 处于 `stopping`，只入历史，**不产生交接资格**；PR 列入停止清单的在途成果，B 收回时决定是否采纳 | A 稿 §3.4、§6.3 第 1 条；本文 |
| N21 | 同上，**撤回先提交** | `merge_handoff` 在效果闸处被拒，不写交接事件、不发 handoff | A 稿 §3.4（效果闸含 `merge_handoff`） |
| N22 | 撤回时 A 正在 `git push` | 推送结果记为 unknown 效果，写进 `stop_confirm.unknownEffects`；head 以 `git ls-remote` 为准；不重试推送 | A 稿 §6.1 第 3 步 |
| N23 | 撤回时 A 正在做 carry 核对 | carry 只是 A 台账记录；提交在 `stopping` 之前 → 作积压回写；之后 → 不写 | A 稿 §3.4；`scheduler-merge-handoff.ts` carry 只由调度器在事务内写 |
| N24 | S5（已交接）期间 B 合并 PR，PR 合并时的 head = A 跟随的 head | 正常路径：A 卡 `merge → live`，发 `complete`（提案），B 关闭委托 | merge-handoff.md「Flow」；本文 S6 |
| N25 | S5 期间 B 合并 PR，但合并时的 head 不是 A 跟随的 head，也不是纯 main 合入 | 按 merge-handoff 现有规则交 A 的 PM（fallback manual）；A 不再产生业务效果，发 `return_request{reason: merged_at_unfollowed_head}`（码待定） | merge-handoff.md「Flow」；本文 |
| N26 | S4（还没交接，A 仍在 review / fix）时 B 在 GitHub 上直接合并 PR | **B 应先撤回再合并**（B 侧只观察模式应拒绝 B 调度器合并这张卡，B 实现）。若 owner 绕过闸手工合并：A 下一次读 PR 发现已合并 → 进停止流程，`return_request{reason: merged_externally}`（码待定）；A 不再推分支。**设计，未实现**：A 现在只在 merge 阶段读 PR 状态（`scheduler-merge-handoff-tick.ts`），review / fix 阶段要加这次读 | 本文；A 稿 §9「B 的 PM 手推 B 卡阶段」 |
| N27 | B 在 `stopping` / `待收回` 期间合并 PR | 合并是 B 的权利，A 不阻止也阻止不了；A 在停止清单里写明「PR 合并时 head」与「A 最后推送 head」是否一致，供 B 核对 | 本文 |
| N28 | B 的 `revoke` 与 A 的 `return_request` 交叉 | 两者都进同一个停止流程；`stop_confirm` 同时记两个发起原因；只走一次 | A 稿 §6.1；本文 |
| N29 | `stopping` 期间 B 发 `spec_update` / `reopen` | 拒（码待定，A 侧倾向 `not_active`）：这两条是业务消息 | A 稿 §3.4 |

## 4. 确认丢失的总表（按丢的是哪一条）

| 丢失的确认 | 丢在哪一侧 | 后果 | 处理 |
|---|---|---|---|
| A 的接单回执 | B 没收到 | B 停在 S0，卡没人推 | B 用同一 `delegationId` 重发（N6）；**换 ID 会撞 N2** |
| B 的逐条回执 | A 没收到 | outbox 积压；交接被挡（交接要求 outbox 清空） | 重发；超 15 分钟提醒 A 的 PM 一次（A 稿 §4.3） |
| A 对 `revoke` 的应答 | B 没收到 | B 不知道 A 停了没有 | B 重发 `revoke`；同时可以等 `stop_confirm`，两者都是停止证据的一部分 |
| A 的 `stop_confirm` | B 没收到 | B 停在 `待收回` | A 在 S8 重发；B 不得超时收回（N11） |
| B 的收回确认 | A 没收到 | A 停在 S8 占资源；同卡新委托被拒（N4） | B 补发；A 收到后转 `closed` |
| B 对 `complete` 的关闭确认 | A 没收到 | A 行留在 `active`，但 A 卡已 `live`，没有可放行的效果 | A 重发 `complete`；不影响合并结果 |

## 5. 对应 A 稿的小修（只写在这里，不改 #773）

1. **A 稿 §3.4 要回指 §2.2 第 9 条。** §3.4 讲「同一时刻只有一个调度器推进」靠 epoch，但 epoch 只挡「旧 epoch 的效果」，
   挡不住 A 本机**两份不同 `delegationId`** 同时是 `active`——那是 §2.2 第 9 条（同一张 B 卡在 A 侧最多一份没关闭的委托）挡的。
   建议在 §3.4 规则那句后加：「A 本机的唯一性由 §2.2 第 9 条保证；epoch 只负责跨两端的新旧之分。」本文 §1 的对照表即按这个分工写。
2. **补「顺序到达的 d2 被拒」场景。** A 稿 §10 场景 2 只写了 `d1`、`d2` 同时到达。建议加一句：
   「`d1` 已 `accepted` 并在推进中，B 再发 `d2`（新的 `delegationId`，同一张 B 卡）→ `already_delegated`，附 `d1` 的 id 与状态，
   A 不排队、不建第二张卡；`d1` 在 `queued` / `needs_owner` / `stopped` 时同样被拒。」对应本文 N2、N3、N4。
3. **（附带发现）A 稿 §6.1 第 5 步与 §6.3 续租待定项互相矛盾。** §6.1 在停止确认后把 A 卡转 `cancelled`，§3.1 说终态卡不可重开，§6.3 却设想「先发完 `stop_confirm` 再 `renew_request`，回到 `active`」。本文按 §3.1 取：续租只在发出 `notStopped` 为空的 `stop_confirm` 之前（S7）可行；若 P2 选续租方案 (a)，A 稿 §6.3 要改成「续租请求在完整停止确认之前发」。

## 6. 留给 P2 的问题（本文不决定）

1. `offered`、`待收回`、`completed`、`complete` 消息是否进协议，B 侧的状态名用什么。
2. N5、N9、N25、N26、N29 的原因码。
3. N26：是否要求 A 在 review / fix 阶段也读 PR 状态，读频多少；还是只靠 B 侧闸挡住「未撤回就合并」。
4. 续租（S7→S4）用同一 epoch 还是一律重新委托（A 稿 §6.3 待定项）；本文已限定 S8 不能续租（§5 第 3 条）。

接线点（留给后续实现卡）：A 侧委托表与效果闸（A 稿 §3.4 `e2b_delegations`）、outbox（仿 `peer-pr-push.ts` 的推送重试）、
停止清单命令（A 稿 §6.1 提案的 `ledger e2b-stop-report`）、N26 的 PR 状态读取（`scheduler-merge-handoff-tick.ts` 旁）。
