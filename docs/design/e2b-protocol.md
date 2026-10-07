# E2b 整卡委托：协议冻结稿（P2）

> 状态：**设计冻结稿第 3 轮（待另一家族设计审查、A 侧对齐）**。只写设计，不授权实现、生产开关、算力额度或审查互认。
> 第 2 轮改动：第 1 轮设计审查的 7 条 P1，以及 A 侧稿第 5 轮 §12 的 7 条对齐意见。
> 第 3 轮改动：第 2 轮设计审查的 4 条 P1，以及 A 侧稿第 6 轮 §12 的 5 条意见（含第 1 条的收窄更正）。逐条结论都在 §12。
> 立项依据：仓库 owner 批准设计立项（只设计）。实现要在本稿和 R1 冻结后，作为一个实现包另行报 owner 批准。
> 角色：**B = 仓库方 / 委托方**（卡原本在 B 的台账上，合并与部署权永远在 B）；**A = 执行方 / 接收方**。
> 输入：A 侧讨论稿 [PR773 `e2b-a-side.md`]（A 侧细节以它为准，本稿对它的「待定」逐条拍板，见 §11）、
> [入口盘点](./e2b-current-entry-inventory.md)、[scheduler-engine](./scheduler-engine.md)、[出借](./remote-capacity.md)、
> [共享台账](./shared-ledger.md) / [V2](./shared-ledger-v2.md)、[MHO1](../architecture/merge-handoff.md)、
> [逐步委托](../team/peer-delegation.md)、[协作模型](../team/collab-model.md)。常设授权单列在 [e2b-standing-authorization](./e2b-standing-authorization.md)。
> 本文示例全部是合成值，不含任何真实实例、路径、指纹或台账内容。

## 0. 一句话与三条不变量

B 把一整张卡在一段时间里的**推进权**交给 A：A 用自己的 v3 调度器从复述推进到交回，所有阶段和审查结论按序回写 B 卡；
最后用 mergeHandoff 把 PR 和证据交回 B。B 收下交接之后，按自己的闸决定合不合、部不部署。

1. **唯一推进者。** 同一张 B 卡在任意时刻最多只有一个调度器在产生业务效果。交出之前，B 先核清自己在途的执行者、订单和效果（§3.1 `preparing`），然后才发 offer；交出之后 B 只观察。A 只在持有当前 epoch、租约有效时推进。
2. **合并与部署权不跟着走。** A 侧项目必须是 `mergeHandoff: true`。A 永不 merge、update-branch、部署。交接资格不是 PASS，不是审查互认，也不是 B 的合并许可。
3. **收回要证据，不靠超时。** 租约过期只让旧端的新效果失效，不把写权自动还给 B。正式收回之前，必须核清旧端已经停止，worker、订单和 unknown 效果都已结清，未交成果已保全。离线或证据不明，卡就冻结，不做假确认。

## 1. 和现有路径的边界

| 现有路径 | 谁推进卡 | E2b 与它的关系 |
|---|---|---|
| 出借单（T47/T48，`remote-capacity.md`） | 发起方调度器，只借一步 | 照用、不替换。E2b 交出去的是整卡推进权；A 推进时仍可以把审查单借给第三台机器 |
| 逐步委托 T46（`peer-delegation.md`） | 发起方 PM 手推 | 照用。边界不清、要逐件拍板的活走 T46；E2b 只接规格写清、在常设授权内的卡 |
| 本机 v3 / E2a | 本机调度器 | A 推进的就是一张本机 v3 卡，执行者都是本机会话，不走 peer 路由（`worker-session.ts` 的 peer→manual 不用改） |
| 共享台账 V2 home / executor | 中心裁决租约，主场不变 | E2b 是 V2 落地前的点对点做法。V2 落地后，epoch 和租约映射成中心的 lease；「推进权临时迁移」是否算换主场，由 V2 另定（§10） |
| MHO1 mergeHandoff | A 开卡 → v3 → 交回 | E2b 复用它的交回与纯 main carry，只是卡由 B 发起，交接经认证 peer 送到 B，B 持久接收后才算交接成立（§6）。A 自己开的 MHO1 自动卡（非委托）也走同一套交接、撤回与 B 侧资格裁决，先登记再交接（§6.7） |
| B 的 peer PR 收审（`peer-pr-auto.md`） | B 新建 `PR<n>` 卡 | 委托分支所开的 PR **不走**普通收审，挂在原 B 卡上；已登记的 MHO1 自动卡 PR 要等有效交接才收审（§6.3）；`handoffIntake` 对这个 peer 打开后，它开的未登记 PR 先经 `mho_query` 正面分类，回答 `ordinary` 的照旧 |

E2b 不改任何现有生产权威：不改出借授权、不改共享台账、不改合并闸。实现上线前，本文描述的接口都**不存在**。

## 2. 标识与线契约

### 2.1 实例身份

- 线上的实例身份一律用 **完整 key id**：`sha256(规范 Ed25519 公钥字节)` 的 64 位小写 hex。现有展示用指纹（前 16 位 hex 分组）只用于显示，不进任何授权、索引或去重键。
- 身份只来自认证传输：请求签名验过，且公钥等于该 peer 钉住的公钥。body 里自报的实例、角色、名字一概不信。
- 签名新增一个用途 `e2b`。签名覆盖 method、path、时间、body 哈希，与现有请求签名同一套。E2b 的重放防护不靠进程内缓存，靠 §2.4 的持久去重键。
- **同名换实例**：peer 名相同但公钥变了，一律当新主体处理。旧委托、旧常设授权都不继承（fail closed）。重新钉 key 走现有 repin 流程，之后要重新签常设授权。

### 2.2 委托标识与 epoch

| 字段 | 定义 | 规则 |
|---|---|---|
| `delegationId` | B 生成，`e2b_` + 26 位随机 base32 | 全局唯一、不复用。同一 id 的重发必须内容摘要相同，否则 409 |
| `bKey` / `aKey` | B / A 的完整 key id | 由认证传输确定，body 里的值只用来核对一致 |
| `bTask` | B 卡号 | 同一 `(bKey, bTask)` 在 B、A 两侧都最多一份未关闭委托（部分唯一索引，事务内保证） |
| `epoch` | B 签发的正整数，每张 B 卡单调递增 | 只有 B 增，只在正式收回（§5.4）或新委托时增；A 永不自增、永不复用 |
| `specRev` / `specSha256` | B 卡规格版本，以及规格全文的 sha256 | A 卡镜像；规格变化走 `spec_update`（§4.3） |
| `allowed` | 允许的模板与步骤 | 模板 ∈ 常设授权允许集；步骤固定为 `restate,write,review,fix,handoff`，不含 merge / deploy |
| `repo` / `base` | `owner/name`；基线分支固定为 `main` | 必须在常设授权的仓库白名单里，且等于 A 项目 repoDir 的 origin |
| `branch` | **由 B 在 offer 里指定**：`e2b/d-<delegationId 去掉前缀后的 26 位小写>` | 一份委托一条分支：同一 `delegationId` 重发时不变，跨委托永不复用；不同 B 实例、只差大小写的卡号都不会撞到同一个 ref。A 必须用这个分支，不自己起名。PR 开在 B 仓库，base `main` |
| `startHead` | A 开工的起点：B 的 main head，或 B 准备阶段采纳（adopt）的已推送 head | 完整 SHA；B 在 `preparing` 里定下（§3.1），A 接单时核它在 B 仓库里存在 |
| `quiesceSeq` | B 台账上「本卡已静止」那条事件的 seq | 只用于对账和审计；A 无法核 B 的内部状态，B 签名对它负责 |
| `bSeq` / `aSeq` | B → A、A → B 各自的消息序号，按 `(delegationId, epoch)` 单调递增 | 各自持久化；收方按序收、有缺口回 `gap{expect}` |
| `operationId` | 每个外部写效果的稳定 id：`<delegationId>:<epoch>:<kind>:<n>` | 用于未知结果对账（§5.5），不承诺通用 exactly-once |

A 卡号的分配照 A 侧稿 §3.1：查表、确定性、超长落哈希形式、同一 B 卡重新委托一律新建 A 卡。冻结时作两处修改：
- `fp8` 改成取完整 key id 的前 8 位 hex；
- 哈希形式里的指纹也用完整 key id。

### 2.3 消息清单

全部走 `POST /api/v1/e2b/<type>`。body 是严格 JSON：未知字段拒收，各字段有上限，整条消息 ≤ 32 KiB（与 order-wire 同一上限）。
规格正文超长时，分块放进 `spec_chunk`，每块带 `specSha256`。

| 方向 | 类型 | 类别 | 主要字段 | 收方结果 |
|---|---|---|---|---|
| B→A | `offer` | 业务 | delegationId、epoch、bTask、specRev、specSha256、规格或分块、template、repo、branch、startHead、quiesceSeq、leaseMs、bWorkflowRev、`observing: true`、surfaceRules？ | `accepted` / `queued` / `needs_owner` / `rejected:<码>` |
| B→A | `spec_update` | 业务 | specRev+1、specSha256、正文 | 回执 `applied` / `needs_owner` / `rejected:<码>`（§4.3）；A 卡因租约过期暂停时回暂态 `retry:not_active`，委托已停止或关闭时回 `rejected:not_active` |
| B→A | `reopen` | 业务 | 交回后 B 审查的 findings[]（含 findingId）、B 当前的 PR head | 回执 `applied`：A 已把卡从 merge 退回 fix，从这个 head 起修，B 的结论记成 A 卡上的一轮审查。A 卡暂停时回暂态 `retry:not_active`，已停止或关闭时回 `rejected:not_active`（§3.1） |
| B→A | `revoke` | 控制 | reason | 应答 `stopping`，A 进停止流程 |
| B→A | `renew_ack` | 控制 | leaseUntil | 续租确认 |
| B→A | `reclaim_confirm` | 控制 | newEpoch、disposition[] | A 委托行转 `closed`，按处置清理 |
| B→A | `complete` | 控制 | mergeSha、prHead、mergedAt（委托用 delegationId，非委托 MHO1 用 registrationId） | A 只读核实 PR 已合并、合并提交一致后，委托行转 `closed`（completed），A 卡结束，释放名额（§6.8） |
| A→B | `writeback` | 业务 | aSeq、kind（admission / restate / stage / deliver / review / closure / blocked / fallback）、payload | 回执签名 `{delegationId, epoch, aSeq, sha256}`；`admission` 是排队补位的结果（§4.1） |
| A→B | `handoff` | 业务 | aSeq、HandoffEvidence（§6.1） | 回执 `handoff_received` 并附资格裁决（§6.2） |
| A→B | `handoff_withdraw` | 控制 | aSeq、head、reason | 回执 `withdraw_received`（B 已停止开始新效果）；在途效果结清后 B 另发 `withdraw_confirm`（§6.4） |
| B→A | `withdraw_confirm` | 控制 | handoffSeq、settled[]（每项在途效果的对账结论）、prHead | A 收到后才解除 `withdrawing`，从 `prHead` 起修（§3.2、§6.4）；合并已完成的改发 `complete` |
| B→A | `mho_query` | 控制 | repo、pr、branch、head | `handoffIntake` 打开时，B 对这个 peer 开的、还没有登记的 PR 问 A 是什么卡；A 签名回 `{kind: mho, registrationId}` 或 `{kind: ordinary}`（§6.3） |
| A→B | `renew_request` | 控制 | leaseUntil 申请值 | B 回 `renew_ack`（含 `delegated/handed`，§4.4），或回 `stale_epoch` |
| A→B | `return_request` | 控制 | reason | B 应答，之后双方走停止流程 |
| A→B | `stop_confirm` | 控制 | stoppedAt、lastSeq、sessions[]、orders[]、notStopped[]、unknownEffects[]、artifacts[] | B 用来核停止（§5.3）。可以用新 aSeq 重发更新后的一份，B 以 aSeq 最大的一份为准 |
| A→B | `mho_register` | 业务 | registrationId（A 生成，`mho_` + 26 位随机 base32，不复用）、aTask、repo、branch、specRev、specSha256、template | 非委托 MHO1 自动卡登记（§6.7），回执 `registered` / `rejected:<码>`；A 拿到 `registered` 之前不开 PR |

### 2.4 去重、排序与回执

- 去重键：业务消息 `e2b:<delegationId>:<epoch>:<dir>:<seq>`，控制消息 `e2b:<delegationId>:<epoch>:ctl:<type>:<seq>`。
  非委托 MHO1 登记没有 epoch，键为 `mho:<registrationId>:<dir>:<seq>` 和 `mho:<registrationId>:ctl:<type>:<seq>`。
  同键同摘要，拿回原回执；同键换了内容，返回 409，并冻结该委托、交给收方 PM，不自动重编号。
- **终局回执与暂态回执。** 回执分两类：
  - 终局回执（`accepted`、`applied`、`rejected:<码>` 等）：持久记进去重表，这条 seq 算已消费；同键重发拿回同一份回执。
  - 暂态回执（`retry:<码>`、`gap{expect}`）：表示「收方现在的状态还不能裁决这条，过后再发」。**不进去重表、不消费 seq、不固定裁决**；
    发方保持这条在 outbox 里，按退避用同一 seq、同一内容重发，收方状态允许时给出终局回执。后续 seq 排在它后面等。
  - 暂态只限本文点名的情况：`gap`，以及 §3.2 第 3 条暂停中的 A 收到 `spec_update` / `reopen`。其余拒收一律终局。
  - B 在 offering / queued / needs_owner 时收到 A 的业务消息，不回拒收，而是推断 A 已接单（§3.1）。
- 收方按 `seq` 顺序收。有缺口回 `gap{expect}`，发方从缺口那条起补发。
- 所有回执都用收方实例签名，签 `{delegationId, epoch, dir, seq, sha256, outcome}`。发方验签之后，才把这条在 outbox 里标为已送达。
- 两侧都是 **outbox 先写后发**：重试退避 30 秒到 10 分钟，重启后从最小的未确认 seq 重发。不允许静默丢弃，结果只有三种：重试、冻结、退回人工。

## 3. 状态机

### 3.1 B 侧（每份委托一行，持久在 B 台账）

| 状态 | 进入条件 | B 对这张卡能做什么 | 收 A 业务消息 | 收 A 控制 / 积压 |
|---|---|---|---|---|
| `preparing` | B PM 在 B 外发常设授权内发起委托 | 卡的 workflow 已切到 `delegated`，规划器不再排新意图；B 核清本卡的在途（见下）。只能放弃准备 | 拒（`not_delegated`） | — |
| `offering` | 准备完成，记下 `quiesceSeq` 和 `startHead`，offer 已进 outbox | 同上；可撤回 | 推断接单（见下），转 `delegated` 后照收 | 收 offer 回执 |
| `queued` / `needs_owner` | A 回执排队 / 等 A owner | 同上；可撤回 | `admission` 照收；其他业务消息推断接单（见下） | 收 |
| `delegated` | A 回执 `accepted`，或 `admission{accepted}`，或推断接单 | 只观察：投影 A 的回写；PM 只能 `revoke`、`spec_update`、写 note | 收（epoch 等于当前值、委托 active、seq 连续） | 收 |
| `delegated/handed` | 收下有效 handoff（§6.2） | 按下面「handed 写口」放开 B 的审查、合并与部署；作者侧写口仍拒 | 收 writeback；新的 handoff 拒（`handoff_active`），要先撤回旧的 | 收（含 `handoff_withdraw`） |
| `stopping` | B 撤回，或 A 发 `return_request`，或租约过期（含联系不上 A） | 不推进，等停止证据；**没有超时**，联系不上就一直等 | 拒（`stale_epoch`） | 收，只入历史和停止核对 |
| `frozen` | A 报 `notStopped` 非空，或出现 409，或停止证据不合格 | 不推进，**不开任何新推进**；资源继续占着，交 B 的 PM | 拒 | 收 |
| `reclaimed` | §5.4 的条件全部满足；或排队 / 等 owner 阶段被撤回、被拒（没有 A 卡，A 签名回执确认未建卡）；epoch+1 | B 卡回到 B 本机流程（manual），之后可以重新委托 | 拒 | 收，只作迟到历史 |
| `completed` | handed 后 B 合并成功并发出 `complete`（§6.8） | 委托结束；B 卡在 B 本机继续部署、核验 | 拒 | 收，只作迟到历史 |

- `delegated` 是 B 卡 workflow 的一个新模式。在这个模式下，B 的规划器对这张卡不排任何意图。
- B 侧**所有**会推进卡的写口一律拒绝这张卡，并给出同一个错误码 `card_delegated`。这些写口包括：
  stage、step、deliver、review 入账、lend-offer / reoffer、manual-merge-request、workflow-set / resume、scheduler-* 系列，
  以及 DAG 改写里与本节点绑定的卡。唯一的例外是下面的 handed 写口。
- 这是 B 侧实现的前提：A 接单时会核 offer 里的 `observing: true` 和 `bWorkflowRev`。
- 从 `delegated` 回到本机推进，只有两条路：`reclaimed`（回 manual），或 `completed`（合并之后的部署、核验照 B 的流程走）。B owner 或 PM 都不能手工把卡改回 auto。
  `preparing` 阶段还没发出任何 offer，PM 可以放弃准备，卡直接回 manual，epoch 不变。

**准备（`preparing`）：交出之前先静止。** B 在一个写事务里切 `delegated`，之后逐项核清，全部满足才转 `offering`：
1. 本卡所有调度意图都已结清，没有 pending / submitted / unknown；
2. 本卡的作者、审查会话都已退出（判据同 §5.2 第 2 步）；
3. 本卡的出借单都已终结：对端签名的 release / cancel 回执，或按出借协议收回并拿到对端的停止证据；
4. 本卡没有未结束的合并运行，B 侧 outbox 里本卡的消息都已送达；
5. 本卡分支上未推送的提交逐条处置：推送后 `adopt`（它的 head 成为 `startHead`），或者 `discard` 并写理由。

任一条核不清（unknown、对端离线、会话停不掉）就停在 `preparing`，交 B 的 PM，**不发 offer**，不把执行权交给 A。
核清后记一条 `e2b_quiesce` 事件，事件的 seq 就是 offer 里的 `quiesceSeq`；没有 adopt 的提交时，`startHead` 取当时的 main head。

**推断接单（接单回执丢失）。** A 的接单写在 A 自己的事务里，`accepted` 回执可能在路上丢掉，而 A 已经开始回写。
B 在 `offering` / `queued` / `needs_owner` 时收到一条业务消息，同时满足下面三条，就把它当成 A 已接单的证明：
- 验签通过，发送方是这份 offer 的 A（完整 key id 一致）；
- 绑定的 `(delegationId, epoch)` 等于这份委托的当前值；
- 不是 `admission{rejected}`。

A 的业务效果闸要求委托行是 `active`（§3.2 第 1 条），所以这样一条消息只可能在 A 接单之后产生。
B 在同一个事务里先转 `delegated`，记一条 `e2b_accept_inferred`（证据就是这条消息的签名摘要），再按 `delegated` 正常收这条消息、签终局回执。
之后迟到的 `accepted` 回执只入历史。B 重发 offer 时，A 照去重规则拿回原 `accepted`，结果一致。

**handed 写口。** 卡在 `delegated/handed` 时，B 只放开以下写口，每次都在事务里 CAS 核对
`(delegationId, epoch, handoffSeq, PR, head)` 等于当前有效交接：
- 本卡的 B 侧审查入账（B 自己的合并审查，按 R1 分级）；
- manual-merge-request、合并队列的各步（含对委托分支的 update-branch）、部署、核验。

stage（merge 以外）、step、deliver、lend-offer、workflow-set / resume 仍然回 `card_delegated`。
handed 期间 A 不产生业务效果：A 卡停在 merge 等待，规划器不排意图，A 不向分支推送；
推送了就是 head 漂移，交接失效（§8 第 12 行）。A 这时只发控制消息（`handoff_withdraw`、续租、`return_request`）。

**handed 期间的租约。** 续租照常：A 照常发 `renew_request`，B 在 `delegated/handed` 下照回 `renew_ack`（handed 期间 A 本来就不产生业务效果，续上租约不会放出任何推进权）。
A 的租约过期时，A 按 §3.2 第 3 条暂停；B 保持 `handed`，自己的合并流程照走。联系恢复后，A 按 §4.4 续租，B 在 `handed` 下同样可以回 `renew_ack`，A 回到交接后的 merge 等待。
A 的迟到撤回按 §6.4 的规则处理。

**handed 下 B 要退回修改（`reopen`）。** 次序固定，B 在每一步都持久记录：
1. 先停新的合并效果，按 §6.4 第 2 步对账在途的 update-branch、merge、部署，结清本卡的合并意图。在途效果核不清就停在这一步，按现有 unknown 规则交 B 的 PM，不发 `reopen`。
2. 委托行记 `handed/reopening`（仍属 handed：handed 写口全部关闭，续租照回），把 `reopen` 写进 outbox，带上 B 当前的 PR head（可能含 B 的 update-branch 合并提交）。
3. 收到 A 的终局回执 `applied`，才转 `delegated`。
   - A 回暂态 `retry:not_active`（A 卡因租约过期暂停中）：B 停在 `handed/reopening`，不推进合并，等 A 续租回到 active 后用同一 seq 重发（暂态不消费 seq，§2.4）。
   - A 回终局 `rejected:not_active`（A 已因 revoke / 退回进入停止，或委托已关闭）：B 转 `stopping`，按停止流程继续。

handed 下 B 要 `revoke`，或者收到 A 的 `return_request` 时，也先做第 1 步的停止和对账，再进 `stopping`。

### 3.2 A 侧

照 A 侧稿 §3.4 的表冻结，状态为 `queued` / `needs_owner` / `active` / `stopping` / `stopped` / `closed`。
`active` 下另有两个持久子状态：`handed`（B 已签回执收下 handoff）和 `withdrawing`（A 已发 `handoff_withdraw`，还没收到 `withdraw_confirm`）。冻结时补五条：

1. 业务效果闸紧贴效果，在同一事务里核：委托行是 `active`，**不在 `handed` 或 `withdrawing`**，epoch 没变，租约没过期。业务效果包括：派单、建会话、推分支、deliver、生成 handoff、生成新的业务回写。
   A 的 PM 手工推卡也要过这道闸。
2. 控制消息和「停止时刻之前已经写进 outbox 的积压回写」不受业务闸限制，在 `stopping` / `stopped` / `closed` 下照常发送（§5.2）。
3. A 卡在停止流程里的去向**按起因分**，不一律进终态：
   - 起因是 `revoke` 或 `return_request`：同 epoch 不可能恢复，A 卡在发出 `stop_confirm` 后转终态 `cancelled`；
   - 起因是租约过期：A 卡**暂停**，停在原阶段、原轮次，workflow 转 manual，原因码 `e2b_paused`（第 1 条的闸保证 PM 手推也不产生效果）。
     收到 `renew_ack`：先对账未结意图，再由系统（不是 PM）恢复成 auto，从原阶段继续；收到 `reclaim_confirm`：转 `cancelled`。
     暂停中收到 `spec_update` / `reopen`，回暂态 `retry:not_active`，续租回到 active 后再按正常规则处理。
   - A 收到 B 的终局 `stale_epoch` 或 `not_delegated`（例如续租、回写被拒），A 分不清 B 那边是租约过期还是已经收回，**一律按租约过期处理**：
     进 `stopping`、A 卡暂停、发 `stop_confirm`；只有收到 `reclaim_confirm` 才转 `cancelled`。
   - 两种情况下，worktree 和分支都要等收到 `reclaim_confirm` 或 `complete` 才清理，不能提前删。
4. 交接之后，A 卡停在 merge 等待（MHO1 的 merge 等待态），不排任何意图。收到 `complete` 结束；收到 `reopen` 退回 fix（委托行离开 `handed`）。
   handed 期间续租照常；租约过期按第 3 条暂停，续上后回到 merge 等待。
5. **撤回交接的等待闸。** A 卡离开 merge（本地 P1、CI 红、主动退回）时，A 在同一个事务里：记阶段变化，委托行转 `withdrawing`，把 `handoff_withdraw` 写进 outbox。
   `withdrawing` 期间第 1 条的闸拒绝一切业务效果：不派 fix、不建会话、不推分支、不生成新 handoff。规划器可以算出下一步，但不能落成效果。
   - 收到 `withdraw_received`：只说明 B 已停止开始新效果，**不解除**闸；
   - 收到 `withdraw_confirm`：B 已结清在途效果。A 解除 `withdrawing`，从回执里的 `prHead` 起修（可能含 B 的 update-branch 合并提交）；
   - 收到 `complete`（撤回到达前 B 已合并）：按 §6.8 结束，本地 P1 交 A 的 PM，作为合并后的发现处理；
   - 一直收不到：不超时，停在 `withdrawing`，交 A 的 PM。

### 3.3 两套闸（冻结）

| | 业务效果 / 业务消息 | 控制消息 / 积压回写 |
|---|---|---|
| 判据 | 委托 active 且不在 handed / withdrawing、epoch 等于当前值、租约有效 | 签名有效、epoch 曾由 B 为本委托签发、类型在白名单内 |
| 停止之后 | 一律拒 | 照收照发，只入历史和对账，不改变阶段 |
| 目的 | 防止双端推进 | 防止「停了效果，连停机确认也发不出去」造成互等 |

## 4. 接单与推进

### 4.1 A 的接单检查（一个写事务内完成）

照 A 侧稿 §2.2 的 9 条冻结，检查顺序和回执码沿用。冻结时的修改：

- 第 2 条（授权）改为核 A 侧**入站常设授权**（standing 文档 §2）。缺授权，或授权已过期、已撤销，回执 `needs_owner`：A 在自己的 owner 频道发一张逐卡 authorize，24 小时没人答，回 `rejected:owner_timeout`。
  接单时委托行记下这次所依据的授权（常设授权的 id 和 rev，或逐卡 authorize 的 askId），之后 §4.3 用它评估新规格。
- 第 3 条（并发）只数**占名额**的委托：这个 peer 在 A 侧处于 `active` / `stopping` / `stopped`（未 `closed`）的委托。
  `queued`、`needs_owner` 不占名额，另有排队上限：同一 peer 排队中的委托最多 `maxConcurrent` 份，再多回 `rejected:queue_full`。
  名额在委托行转 `closed` 时释放（收到 `reclaim_confirm` 或 `complete`）。
- 第 4 条（模板）：`security` 模板**不接**，回执 `template_not_allowed`。v1 没有逐卡放行 security 的路径。
- 第 9 条（唯一）在第 3、6 条之前核，命中直接拒，回执 `already_delegated`，不排队。排队中的委托照样计入唯一（A 侧稿第 9 条原文）。
- 新增第 10 条：offer 必须带 `observing: true`、`bWorkflowRev` 和 `quiesceSeq`，否则拒（`not_observing`）。
- 新增第 11 条：`branch` 必须等于由 `delegationId` 推出的 `e2b/d-<26 位>`，且 A 用 `git ls-remote` 核这个分支在 B 仓库里**不存在**。
  存在就拒（`branch_conflict`），不在别人的分支上续写。同一 `delegationId` 的重发直接拿回原回执，不重核。
- 新增第 12 条：`startHead` 在 B 仓库里能取到（fetch 后存在），否则拒（`start_head_missing`）。

**排队补位。** 有名额空出时，A 按到达顺序取排队中的委托，在一个写事务里把第 1–12 条全部重核（第 11 条照样核分支不存在）：
- 通过：委托行转 `active`、建 A 卡，回写 `writeback{kind: admission, outcome: accepted}`，B 收到后 `queued` → `delegated`；
- 不通过：委托行转 `closed`，回写 `admission{outcome: rejected:<码>}`，B 收到后转 `reclaimed`（没有 A 卡，不需要停止证据）。

**推进中碰到 `excludeSurfaces`。** 授权的有效期只在接单时核；推进中，A 的作者改动碰到了接单时那份授权的 `excludeSurfaces` 时（规格变化见 §4.3）：
- A 卡转 manual，回写 B 一条 `fallback`（原因码 `surface_excluded`）；委托本身不自动停止；
- A 的 PM 只能做一件事：**收窄改动**，改到不再碰排除面后恢复 auto。PM 不能自己决定碰着排除面继续推进；
- 要碰排除面继续，只能走 A owner 的逐卡 authorize（同第 2 条的卡面）；owner 不同意或 24 小时没答，A 发 `return_request`；
- B 在交接时也按 B 外发授权的 `excludeSurfaces` 核整份改动，碰到了就回 `handoff_rejected:surface_excluded`（§6.2）。

### 4.2 推进

- A 卡是普通的 v3 auto 卡。作者家族由 A 定，审查员是跨家族的本机会话，或者 A 自己借来的出借位。
- 规格当外来数据，经 `quoteExternal` 渲染。规格里要求改系统配置、安装软件、碰密钥的，A 不做，常设授权也不能放行这类事。
- 复述由 **A 侧 PM** 用 `restate-approve` 放行，同时把复述正文回写 B。B 不同意时，用 `spec_update` 或 `revoke` 纠正，不要求每次跨实例等一轮。

### 4.3 规格变化

`spec_update` 由 A 在一个事务里处理：核 epoch，核委托行是 `active`（暂停中回暂态 `retry:not_active`，已停止或关闭回 `rejected:not_active`），写新规格，specRev 加 1，P1 连续计数清零，旧 specRev 下结果未定的意图先对账。

规格变化后，A 用**接单时记下的那份授权**（§4.1 第 2 条）评估新规格：
- 重核接单检查的第 4、7、8 条；
- 用那份授权的 `excludeSurfaces` 和授权范围核新规格。**不重核授权现在的有效期，也不看它是否被普通撤销**：授权只管接单那一刻，普通到期或撤销不影响在途（standing 文档 §4、§5）。只有 owner 主动选「撤销并收回在途」才走停止。
- 第 4、7、8 条不过：回 `rejected:<码>`，委托不变，B 的 PM 决定改规格还是 `revoke`。
- 新规格碰到排除面或超出授权范围：A 照写新规格（specRev 与 B 对齐），A 卡转 manual，回写 `fallback{surface_excluded}`，回执 `needs_owner`，走 A owner 的逐卡 authorize；
  owner 批准，A 卡恢复 auto；owner 不同意或 24 小时没答，A 发 `return_request`。

B 卡在 `delegated/handed` 时，B 不发 `spec_update`：先按 §3.1 走 `reopen`，收到 `applied` 回到 `delegated` 后再发。

### 4.4 租约

- A 每 60 秒发 `renew_request`，B 回 `renew_ack`，租期 10 分钟。数值进双方配置，只在 B 侧最大值以内可调。
- A 到期仍没续上：A 自己停掉新效果（进 `stopping`），A 卡按 §3.2 第 3 条暂停，保留现场和 journal。联系恢复后，先补发积压回写和 `stop_confirm`。
- B 侧租约过期（包括联系不上 A）一律进 `stopping`，不进 `frozen`；`stopping` 没有超时。`frozen` 只留给 `notStopped` 非空、409、停止证据不合格。
- **同 epoch 续租（冻结为允许）**：同时满足以下条件时，A 发完积压回写和 `stop_confirm` 之后可以发 `renew_request`：
  - B 卡仍在这个 epoch，委托没有被撤回；
  - B 状态是 `stopping`，起因只能是租约过期（`frozen` 不能续租）；或者 B 状态是 `delegated/handed`（含 `handed/reopening`）；
  - B 已按 §5.3 核过这份 `stop_confirm`。
  B 回 `renew_ack` 后，双方回到 `delegated` / `active`（handed 时回到 `delegated/handed` 和 A 的交接后等待），A 卡从原阶段继续。其他情况一律走正式收回，然后重新委托。
- 卡在 `delegated/handed` 时，租约过期不改变 B 的 handed，续租照回（§3.1「handed 期间的租约」）。

## 5. 停止、退回与收回

### 5.1 三种起因

B 撤回（`revoke`）、A 退回（`return_request`）、租约过期。三者共用同一个停止流程，退回也要 B 确认才算结束，A 不能单方面宣布。

### 5.2 A 的停止流程

照 A 侧稿 §6.1 冻结：
1. 先停新效果；
2. 让在途会话停下，判据是会话退出、进程确认不在；
3. 结清本卡的**全部订单**，逐条写进 `orders[]`：
   - 本机订单（作者、审查、收敛）：对应会话已退出，订单已结清或已撤回；
   - A 借给第三台机器的出借单（例如审查单借给 C）：要有 C 签名的 release / cancel 回执，或按出借协议收回并拿到 C 的停止证据；
   - 每条写明 orderId、执行地（本机 / peer 的完整 key id）、领单来源（claim / worker）、终结方式和回执摘要。
   C 离线、回执拿不到、停止状态不明的，这张单进 `notStopped`。审查单的执行者没有写权限，也照样要结清：它的结论会推动阶段。
4. 出在途成果清单：分支和 origin head（`git ls-remote` 核过）、本地未推送的提交、PR、unknown 意图及其可能的外部效果、未确认的 outbox、未回写的报告；
5. 用实例签名发 `stop_confirm`；
6. A 卡按 §3.2 第 3 条的起因处理（cancelled 或暂停），现场保留。

### 5.3 「停止证据」的定义（冻结）

能证明旧端已经停止的，只有 A 签名的 `stop_confirm`，且同时满足：
- `notStopped` 为空；
- `orders[]` 每一条都已终结、带回执摘要，并且是 A 台账上本委托开过的全部订单；B 用回写里出现过的交付、审查来源（订单号、执行地）交叉核对，回写里有、清单里没有的，整份不合格；
- 积压回写连续收到 `lastSeq`。

GitHub 上没有新推送、agent 界面空闲、租约过期、会话已退出、审查员没有写权限，都**不能**代替上面任何一条。
`stop_confirm` 不合格（缺订单、回执对不上）时，B 转 `frozen`，交 B 的 PM。

A 之后核清了 unknown 或补齐了订单回执，就用**新的 aSeq 重发一份完整的 `stop_confirm`**，B 以 aSeq 最大、且验签通过的那一份为准，旧的只入历史。
`frozen` 收到合格的新一份后回到 `stopping`，再按 §5.4 判断能不能收回。

### 5.4 正式收回（B）

B 只在以下全部满足时，才把 epoch 加 1，转 `reclaimed`，并发出 `reclaim_confirm`：
1. 有 §5.3 的停止证据；
2. `unknownEffects` 和在途成果逐条有处置，每条只能是三种之一：
   - `adopt`：采纳，写明 head；
   - `discard`：丢弃，写明理由；
   - `hold`：继续当 unknown 占着资源。只要有一条是 `hold`，这次就不能收回。
3. B 侧在途的合并、部署、update-branch 效果都已结清（§6.4）。

收回之前，新委托一律不发：B 侧唯一索引在本委托 `reclaimed` 之前拦住同卡的新 offer。

联系不上 A 时 B 停在 `stopping`；A 报了 `notStopped` 非空，或者停止证据不合格时 B 是 `frozen`。两种情况都：
- 不超时、不自动收回；
- **v1 不提供强制收回**。

出路只有一条：A 补出合格的停止证据。联系不上就等 A 恢复。`notStopped` 非空的，由 A 的 PM 或 owner 在 A 本机停掉那些会话、收回那些出借单，再用新 aSeq 发一份 `stop_confirm`。

### 5.5 未知效果对账

- 每个外部写效果在执行前先登记 `operationId`，执行后记结果。外部写效果包括：推分支、开 PR、deliver、handoff。
- 结果不明的（超时、进程退出），对账时**只读核实**外部事实，不重做：
  - 推分支：`git ls-remote` 看分支 head；
  - 开 PR：用 `gh pr list --head` 查；
  - handoff：看 B 有没有给出回执。
- 核实结果是「已发生」就补记；「未发生」才允许用同一个 `operationId` 重试；「核不清」就保持 unknown、占着资源，交给 PM。
- 不承诺通用的 exactly-once，也不换 key 盲目重试。

## 6. 交接（handoff）与合并资格

### 6.1 HandoffEvidence（线上的 E2b 版）

在 MHO1 `HandoffEvidence v1` 的字段上加：
- `delegation`：`{delegationId, epoch, bTask, specRev, specSha256}`；
- `aKey`：A 的完整 key id；
- `repo` / `pr` / `head` / `base`；
- `template`、`authorFamily`；
- `review`：沿用 v1 的 round、verdict、reviewerFamily、p2、reviewSeq；报告不带本机路径，换成 R1 证据包里的条目 id 和 sha256；
- `ci`：A 侧看到的 head CI 运行 id，以及各项结论（只是参考，B 会自己重读）；
- `carries[]`：只是 A 的声明，B 会自己重算。
- 整个 `evidence` 的规范 JSON sha256 由 A 签名。
- 证据包的身份、来源、探针和哈希字段由 R1 定义。本稿只要求 handoff 引用 R1 证据包的 `bundleId` 和 manifest sha256。

### 6.2 B 的接收与资格裁决

B 收到 `handoff` 后，在一个事务里依次核：
1. 委托 `delegated`、epoch 等于当前值、aSeq 连续；
2. `repo` 和 `pr` 是这份委托的分支所开的 PR，base 是 `main`，B 自己读 GitHub 的 PR head 等于 `head`；
3. `specRev` 和 `specSha256` 等于 B 卡当前值；
4. A 卡上没有未关闭的 P0 / P1；本轮 A 的结论是 PASS，或者只剩 P2；
5. 证据包可以取回，哈希对得上；
6. 整份改动（`startHead` 到 `head` 的净 diff）没有碰 B 外发授权的 `excludeSurfaces`，碰了回 `handoff_rejected:surface_excluded`。

全部通过后，B 持久记一条 `e2b_handoff`（含裁决，seq 即 `handoffSeq`），然后签回执。B 卡从 `delegated` 进入 **`handed`** 子状态：
- 这一刻起，这个 PR、这个 head 才有资格进入 B 自己的合并审查流程，B 能用的写口见 §3.1「handed 写口」；
- 核心面要完整审查，见 R1 的分级；互认在开关打开、R1 落地之前一律不启用；
- 合并闸不改；合并成功后 B 发 `complete`（§6.8）。

任一条不过，回执 `handoff_rejected:<码>`，卡停在 `delegated`，A 回到 fix 或交给 A 的 PM。

**交接资格 ≠ PASS ≠ 互认 ≠ 合并许可**：资格只表示「B 收到了一份完整、对得上的交接，可以开始 B 自己的流程」。
A 的本轮 PASS 和 B 的旧 PASS 互不覆盖：任何一侧有未关闭的 P0 / P1，或者有有效的撤回，都不能拿另一侧的 PASS 补上。

### 6.3 PR 分类（B 的收审）

| PR 情况 | 归类 | 处理 |
|---|---|---|
| 分支是某份活委托指定的 `branch`，已收到有效 handoff | `e2b_handed` | 挂到原 B 卡，进 B 的合并审查流程 |
| 分支是活委托的 `branch`，但还没有 handoff，或 handoff 已撤回 | `e2b_pending` | **不收审、不建 `PR<n>` 卡、不进合并队列**。PR 存在、draft 状态、作者 login、标题标签、CI 绿，都不算交接 |
| 分支是某条有效 MHO1 登记的 `branch`，已收到有效 handoff | `mho_handed` | 按 §6.7 建 / 挂 `PR<n>` 卡，进 B 的合并审查流程 |
| 分支是有效 MHO1 登记的 `branch`，但还没有 handoff，或 handoff 已撤回 | `mho_pending` | 同 `e2b_pending`：不收审、不进合并队列 |
| 分支是某条 `closed_unmerged` 登记的 `branch`（登记过的 PR 未合并就关了，之后又重开） | `mho_pending` | 登记恢复为有效，等新的有效 handoff；**不回落成普通收审** |
| 这个 peer 开的其他 PR，`handoffIntake` 对这个 peer 打开 | `peer_unclassified` | B 发 `mho_query` 问 A。拿到 A 签名的回答之前：可以读，不建 `PR<n>` 卡，不进合并队列。A 回 `ordinary` → 照旧；A 回 `mho` → 按 §6.7「迁移」处理；联系不上就一直等，交 B 的 PM |
| 其他 peer PR（`handoffIntake` 对这个 peer 关闭，或者 PR 不是这个 peer 开的） | 照旧 | 现有 peer-pr-auto 流程不变，不因 E2b 放宽，B 照旧完整审查；也不借道出借（lend）路径 |

分类只认 B 台账里的委托行、登记行和 A 签名的 `mho_query` 回答，按 `(repo, branch)` 精确匹配；PR 的标题、标签、作者 login 都不参与分类。
「没有登记」本身不能证明它不是 A 的自动卡，所以 `handoffIntake` 打开后，这个 peer 的 PR 必须先有正面分类。
`mho_query` 的回答持久记在 B 台账上，按 `(repo, branch)` 绑定：同一分支之后再开 PR、PR 重开，都沿用这个分类，不再问；A 回过 `ordinary` 的分支，之后 A 要登记，按 §6.7「迁移」处理。

### 6.4 撤回交接

- A 在以下情况发 `handoff_withdraw{head, reason}`：卡离开 merge、A 本地出现 P1、CI 红、主动退回、收到 B 的 `revoke`。
  发出前 A 先在同一个事务里把委托行转 `withdrawing`，之后不产生任何业务效果，直到收到 `withdraw_confirm` 或 `complete`（§3.2 第 5 条）。
- B 收到经认证、并且对应原交接、PR、head 的撤回后，回执分两段：
  1. **先停新效果**：不再开始 update、merge、deploy；持久记录后签 `withdraw_received`。这一段只表示「收到了、不再开始新的」；
  2. 在途的效果做真实对账：
     - update-branch 已发出的，读 PR head 核实；
     - merge 结果不明的，按现有 unknown 规则冻结；
     - 部署照现有部署对账；
  3. 全部结清后，委托卡从 `delegated/handed` 回到 `delegated`（§3.1），分类回到 `e2b_pending`，再发 `withdraw_confirm{handoffSeq, settled[], prHead}`。
     `settled[]` 逐项写明每个在途效果的结论（未发出 / 已完成并核实 / 已取消），`prHead` 是 B 核实过的当前 PR head。
  - 对账发现合并已经完成：不发 `withdraw_confirm`，改发 `complete`（§6.8）；
  - 对账核不清（unknown）：按现有规则冻结、交 B 的 PM，`withdraw_confirm` 等核清再发。A 那边停在 `withdrawing`，不超时。
- **接收撤回不等于已经停下，也不等于撤销了已完成的合并**：
  - 合并已经完成的，撤回只作为迟到记录入账，不自动回滚，也不重新执行；
  - 后续怎么处理（revert 或补修）交给 B 的 PM，按现有流程办。
- 控制回执不受业务闸限制。
- 恢复交接只有一条路：新的有效 handoff。gh 的 ready 状态、旧 PASS 都不能让它自动恢复。

### 6.5 纯 main 继承

- 交接之后，PR 只合入了 main：以 **B 的规范算法** 为准，即 `reviewMainCarryProof`（完整净 diff、main 来源、多跳 ≤16）。B 重算并记录继承链。
- A 发来的 `carries[]` 和 body 里的 `carry=true` 都只是声明，B 不信。
- 有实质改动的，必须重新 handoff，并且有当前 head 自己的 CI 结果。

### 6.6 过渡期

实现上线之前，A 侧（He）对某个具体 PR 或 head 发出 hold 的，B 的 PM 照现有做法处理：
- 记一次 `pm_hold`，结清旧的合并意图；
- 不整项目冻结；
- 解除 hold 需要新的、固定 head 的正式交接，并由 B 复验。

### 6.7 非委托的 MHO1 自动卡（A 自己开的卡）

A 在自己的台账上开卡（项目 `mergeHandoff: true`），PR 开在 B 仓库。这类卡没有委托、没有 epoch，B 不交出任何推进权；
本节只冻结它的交接资格，让 A 的撤回和本地 P1 能拦住 B 的收审。

- **登记。** A 先发 `mho_register`，**拿到 `registered` 回执之后才能在 B 仓库开 PR**：A 侧开 PR 的步骤在登记回执之前一律拒，这是 A 侧的效果闸，不靠 PM 自觉。
  `registrationId` 由 A 生成，格式与 `delegationId` 相同：`mho_` + 26 位随机 base32，全局唯一、不复用。B 在一个事务里核：
  1. 发送方由认证传输确定，`aKey` 是一个已钉住的 peer；
  2. `repo` 是 B 的项目仓库，`branch` 不属于任何活委托，也不绑在其他登记上（含 `closed_unmerged`；`(repo, branch)` 唯一索引）；
  3. 这个分支上已有 PR 的，PR 作者按现有 peer-pr-auto 的映射必须是同一个 peer；
  4. `template` 不是 `security`。
  通过就记登记行、签回执 `registered`；否则回 `rejected:<码>`。登记不授予任何权限，只把这个分支的 PR 从「照旧收审」收紧为「先交接再收审」，所以不需要 B owner 授权。
- **交接与资格裁决。** HandoffEvidence 用 MHO1 v1 的字段，加 `aKey`、`registrationId`、`aTask`，不带 `delegation`。
  B 按 §6.2 裁决，其中：
  - 第 1 条换成「登记有效、aSeq 连续」；第 2 条的分支换成登记的 `branch`；
  - 第 3 条换成「等于登记行的 specRev / specSha256」，A 改了规格就先用同一 registrationId、新 aSeq 重发 `mho_register` 更新；
  - 第 4、5 条照旧；第 6 条不适用（这类卡没有外发授权，B 照旧完整审查）。
  通过后：
  - 已有 `PR<n>` 卡就挂上，没有就按 peer-pr-auto 新建，卡上记 `handoffSeq`；
  - B 照旧完整审查，合并闸不改；交接资格不是 PASS，不是互认。
- **撤回。** 同 §6.4：A 在卡离开 merge、本地 P1、CI 红、主动退回时，先把自己的卡置于撤回等待（不推分支、不派 fix、不重新交接），再发 `handoff_withdraw`；
  B 先停新效果、签 `withdraw_received`，对账在途后发 `withdraw_confirm`；分类回到 `mho_pending`。A 收到 `withdraw_confirm` 才解除等待。
  A 的本地 P1 不能被 B 的旧 PASS 盖掉，反之亦然。只有新的有效 handoff 能恢复。
- **head 漂移与纯 main 继承**：同 §6.5。
- **结束。** B 合并成功后发 `complete`（registrationId），A 卡结束，登记行关闭。
  PR 未合并就被关闭的，登记行转 `closed_unmerged` 并记一条事件，**不删**：`(repo, branch)` 仍绑在这条登记上；PR 重开时登记恢复有效，分类回到 `mho_pending`（§6.3）。
- **迁移（统一规则）。** 下面几种情况，B 一律按迁移处理：
  - `handoffIntake` 刚打开时，这个 peer 已经开着的 PR（B 先对每一个发 `mho_query`）；
  - `mho_query` 得到 `mho` 的回答；
  - 登记生效时，这个分支上已经有 B 普通收审建的 `PR<n>` 卡（例如 A 侧出错，先开了 PR 再登记）；
  - A 回过 `ordinary` 的分支，之后又登记。

  处理：B 侧对应的 `PR<n>` 卡还没合并的，记一次 `pm_hold`、结清旧的合并意图（同 §6.6），等新的有效 handoff；已经合并的，登记回 `rejected:already_merged`。
  A 侧照 §6.7「登记」先拿到回执再开 PR，正常走不到后两种情况；这两条是兜底。

### 6.8 正常结束（`complete`）

- B 的合并队列确认合并成功（合并 SHA 已核实）后，B 在同一个事务里把委托行转 `completed`（或把登记行关闭），并把 `complete` 写进 outbox。
- A 收到后只读核实：PR 状态是 merged，合并提交等于 `mergeSha`，PR head 等于 `prHead`。核实通过：
  - 委托行转 `closed`（completed），释放 §4.1 第 3 条的名额；
  - A 卡结束（MHO1 的交回完成态），清理 worktree；分支是 B 仓库的，由 B 按自己的规矩处理。
- 核实不通过（PR 未合并、SHA 对不上），A 不关闭，回 `rejected:<码>` 并交 A 的 PM；B 的 PM 收到后对账。
- B 卡之后的部署、核验都在 B 本机，和 A 无关。

## 7. 开关与缺省

| 开关 | 位置 | 取值 | 缺省 | 效果 |
|---|---|---|---|---|
| B 外发 | B 项目配置 `e2b.outbound` | off / observe / on | **off** | observe：只记录「本可委托」的事件，不发 offer；on：允许 PM 在外发常设授权内发 offer |
| A 入站 | A 项目配置 `e2b.inbound` | off / observe / on | **off** | off：一律回 `rejected:not_configured`；observe：做完全部接单检查并记录「本会接」，回 `rejected:observe_only`；on：照协议接单 |
| B 交接收审 | B `e2b.handoffIntake`（按 peer 生效） | off / on | **off** | off 时 `e2b_*` 类 PR 一律当 `e2b_pending` 处理，绝不放宽成普通收审；`mho_register` 回 `rejected:not_configured`，MHO1 自动卡 PR 保持现状（照旧收审）。on 时这个 peer 开的未登记 PR 先 `mho_query` 再分类（§6.3），打开那一刻已开着的 PR 按 §6.7「迁移」处理 |

- 配置读不出、或者损坏，按 off 处理。
- 设计批准、实现合入，都不等于开关已经打开。打开每一个开关，都要 owner 单独批准。

## 8. 场景矩阵（验收的依据，双实例沙箱）

每一行都要在 `--lab --pair` 双实例沙箱里复现，核对两边的状态，并断言「禁止效果」一次也没有发生。

| # | 场景 | 预期 B | 预期 A | 禁止效果 |
|---|---|---|---|---|
| 1 | 5 张卡、A 入站授权并发 3（B 外发上限 ≥ 5） | 5 份委托：3 份 delegated、2 份 queued；一张 completed 或 reclaimed 后，收到 `admission` 补位 | 3 张 active、2 张 queued（不占名额）；一份 closed 后按到达顺序补位，补位时重核全部接单检查 | A 同时占名额的委托超过 3 份；排队行占住名额导致永不补位；B 推进任何一张 |
| 2 | 同一张 B 卡顺序委托两次 | d1 reclaimed 之后，d2 用新 epoch | d1 closed 之后才接 d2，d2 新建 A 卡（哈希卡号） | d2 在 d1 closed 之前被接 |
| 3 | 同一张 B 卡并发两份 offer | B 侧唯一索引只让一份落库 | 另一份回 `already_delegated` | A 出现两张 A 卡 |
| 4 | 推进中断网 10 分钟 | 租约过期 → stopping（不进 frozen），不收回；核过 stop_confirm 后回 renew_ack | 自停 → stopping，A 卡暂停在原阶段（非终态），outbox 积压；恢复后补发积压和 stop_confirm，经同 epoch 续租回到 active，A 卡从原阶段继续 | 断网期间任何一侧产生业务效果；A 卡进终态后又被「恢复」 |
| 5 | A 重启 | 不变 | 委托行持久，先对账未结意图，再续租 | 重复的推送或事件 |
| 6 | 旧 epoch 的结果迟到 | reclaimed 之后收下，只入历史 | — | 迟到消息改变 B 卡阶段 |
| 7 | B 撤回（fix 进行中） | stopping → 核对清单 → reclaimed | stopping → stop_confirm → A 卡 cancelled → 收到 reclaim_confirm 后 closed | 收回前清理 A 现场 |
| 8 | A 退回 | 应答之后走同一流程 | return_request → 停止流程 | A 单方面宣布结束 |
| 9 | 效果 unknown（推分支超时） | 处置表里有 hold 就保持 frozen | 只读核实，不盲目重推 | 换 key 重试 |
| 10 | 有未推送的 WIP | 处置为 adopt 或 discard 后才收回 | 清单列出未推送的提交，现场保留 | 丢弃 WIP |
| 11 | 规格漂移（spec_update） | specRev+1 | 重核授权，P1 计数清零 | 拿旧规格的结论当新一轮 PASS |
| 12 | head 漂移（交接后 PR 被推了实质改动） | 交接失效，卡回 delegated | 新一轮 fix，然后重新 handoff | 拿旧证据合并 |
| 13 | 交接后只合了 main | B 重算继承链并沿用 | — | 信 body 里的 carry |
| 14 | 常设授权被撤销 / 到期 | — | 不接新单；在途的卡照常推进到收回，授权只管接单（standing 文档 §5） | 撤销后接新单 |
| 15 | 停止确认与业务闸 | stopping 下照收 stop_confirm | stopping 下照发 | 停止确认被业务闸拦下 |
| 16 | 同名换实例 | 新 key 的消息一律 `not_delegated` | 旧授权不继承 | 新 key 继承任何权限 |
| 17 | 未交接却有正式 PR、CI 也绿 | `e2b_pending`，不收审 | — | 进合并队列 |
| 18 | 撤回交接与合并并发 | 先停新效果，在途的合并按 unknown 对账 | — | 自动回滚或重新合并 |
| 19 | 已合并之后才到的撤回 | 只记迟到，交给 PM | — | 自动 revert |
| 20 | A 本地 P1，而 B 旧 PASS | 交接被拒，或撤回 | 回 fix | 用 B 的 PASS 盖掉 A 的 P1 |
| 21 | 联系不上、旧 worker 还活着 | stopping，一直等停止证据；A 恢复后报 notStopped 非空则 frozen | 恢复后，人工停会话，再用新 aSeq 发 stop_confirm | 凭 GitHub 静态观测就收回 |
| 22 | security 模板 | 外发闸拒绝 | `template_not_allowed` | 远端整卡接 security |
| 23 | 首次交出时 B 还有在途作者、出借单或 unknown 意图 | 停在 preparing，交 B 的 PM，不发 offer；核清后记 e2b_quiesce 再发 | — | B 旧执行者还在写时 A 已开工 |
| 24 | A 把审查单借给第三台 C，C 离线 | stop_confirm 里这张单在 notStopped → frozen；补齐 C 的回执后新 aSeq 重发 → stopping → reclaimed | 收回出借单，拿 C 的停止证据 | C 的单没结清就 reclaimed；以「审查员没写权限」代替结清 |
| 25 | 两个不同 B 实例、同卡号、同 epoch，委托给两台 A | 两份委托的 branch 由各自 delegationId 推出，互不相同 | 各自核分支不存在 | 两份委托共用一个 ref；推到对方分支 |
| 26 | handed 后 B 合并 | handed 写口按 CAS 放开审查、合并、部署；合并成功 → completed，发 complete | A 卡在 merge 等待；核实 merged 后 closed，名额释放 | handed 期间 A 推送分支；B 的作者侧写口被放开 |
| 27 | handed 后 B 要求修改 | 先停新合并效果、对账在途，结清合并意图后退回 delegated，再发 reopen（带 B 当前 head） | merge → fix，从 B 的 head 起修，之后重新 handoff | B 合并在途时 A 已开始修；B 未对账就发 reopen |
| 28 | A 自己的 MHO1 自动卡 PR | 已登记：mho_pending，收到有效 handoff 才收审；A 本地 P1 → 撤回 → withdraw_confirm 后回到 mho_pending | 拿到 registered 才开 PR，之后交接；撤回等 withdraw_confirm 才动分支 | 已登记 PR 没交接就进合并队列；B 旧 PASS 盖掉 A 的 P1；登记回执前已开 PR |
| 29 | 推进中改动碰到 excludeSurfaces | 收到 fallback；交接时整份改动再核一次，碰到回 handoff_rejected:surface_excluded | A 卡转 manual；PM 只能收窄，要继续须 A owner 逐卡 authorize，不同意或超时发 return_request | 照常自动推进；PM 自己决定碰着排除面继续；委托被自动停止 |
| 30 | 收回时有 hold，A 之后核清了 unknown | 以 aSeq 最大的 stop_confirm 为准，处置全部不是 hold 后 reclaimed | 用新 aSeq 重发完整 stop_confirm | 用旧的一份收回；有 hold 时收回 |
| 31 | spec_update / reopen 到达时 A 委托不在 active | 暂态 retry:not_active：保持原状态，同一 seq 稍后重发；终局 rejected:not_active：按停止流程继续 | 暂停中回 retry:not_active；已停止或关闭回 rejected:not_active | 停止中的卡被改规格或退回 fix；暂态回执被记进去重表、消费 seq |
| 32 | 接单回执丢失（B 在 offering，A 已 active 并发出 aSeq=1 回写） | 验签、绑定一致 → 推断接单转 delegated，记 e2b_accept_inferred，再收 aSeq=1、签终局回执；迟到的 accepted 只入历史 | 正常推进；重发的 offer 拿回原 accepted | 把 aSeq=1 拒收并固定进去重表；B 永久漏掉首条回写 |
| 33 | handed 期间断网超过租期，之后 B 要求修改 | 保持 handed，续租照回；对账结清后进 handed/reopening 发 reopen；收到 retry:not_active 就等，A 续上后同 seq 重发；收到 applied 才转 delegated | 暂停（e2b_paused）→ 续租回到 merge 等待 → 收 reopen 回 applied、merge → fix，从 B 的 head 起修 | B 在 A 接受 reopen 之前退回 delegated；暂态拒收消费 seq；两边都等对方、卡死 |
| 34 | 撤回交接时 B 有在途 update-branch | 先停新效果、签 withdraw_received；核实 update-branch 结果后发 withdraw_confirm（含 prHead）；合并已完成的改发 complete | 本地 P1 → withdrawing；收到 withdraw_received 仍不动；收到 withdraw_confirm 才派 fix，从 prHead 起修 | withdraw_confirm 之前 A 派 fix、推分支或重新交接；B 把 withdraw_received 当成已结清 |
| 35 | handoffIntake 打开后，这个 peer 开了一个未登记 PR | peer_unclassified：发 mho_query，回答前不建 PR<n> 卡、不进合并队列；ordinary → 照旧；mho → 迁移（pm_hold、结清旧意图、等有效 handoff） | 签名回答 | 用「没有登记」证明不是自动卡；回答前进合并队列 |
| 36 | 已登记的 PR 未合并就关了，之后重开 | 登记行 closed_unmerged → 恢复有效，mho_pending，等新的有效 handoff | 重新交接 | 重开后落回普通收审 |
| 37 | spec_update 碰到接单时那份授权的 excludeSurfaces；另一张卡的原授权在途中自然到期 | 收到 fallback{surface_excluded} 和 needs_owner；owner 不同意或超时后收到 return_request。到期的那张照常 | 照写新规格，A 卡 manual，逐卡 authorize；到期那张不重核有效期，照常推进 | 授权自然到期就把在途卡转 manual；PM 绕过 owner 继续 |
| 38 | A 收到终局 stale_epoch / not_delegated | — | 按租约过期处理：stopping、A 卡暂停、发 stop_confirm；收到 reclaim_confirm 才 cancelled | A 卡直接进终态；暂停中产生业务效果 |

## 9. 后续实现拆分（实现包，待 owner 批准；本卡不开）

| 节点 | 归属 | 范围（候选 fileGlobs） | 依赖 |
|---|---|---|---|
| E2B-C1 线契约 | B | `src/lib/e2b-contract*.ts`：schema、完整 key id、签名用途、去重键 | — |
| E2B-S1 常设授权 | B（双方共用库） | `src/lib/e2b-authorization*.ts` + 绑定 bridge ask 的 action | C1 |
| E2B-B1 委托状态与 delegated 模式 | B | `src/lib/ledger-e2b*.ts`：preparing 静止核对、handed 写口 CAS；B 侧所有写口统一拒绝的薄接线 | C1 |
| E2B-B2 B 收发端点与 outbox | B | `src/bridge/e2b-*.ts`、`src/lib/e2b-outbox*.ts` | C1、B1 |
| E2B-B3 交接接收、PR 分类、撤回与结束 | B | `src/lib/e2b-handoff*.ts`、`src/lib/e2b-mho*.ts`（MHO1 登记、`mho_query`、迁移）、两段撤回回执、`complete` 发送；peer-pr intake 的分类薄接线 | B2、R1 |
| E2B-A1 接单与效果闸 | A（He） | `src/lib/e2b-intake*.ts`、`src/lib/e2b-runtime*.ts` | C1、S1 |
| E2B-A2 回写与停止清单 | A（He） | `src/lib/e2b-writeback*.ts`、`ledger e2b-stop-report`（含 orders[] 与出借单回执）、排队补位、暂停与恢复、`handed` / `withdrawing` 效果闸 | A1、C1 |
| E2B-A3 交接证据导出 | A（He） | `src/lib/e2b-evidence*.ts`（以 R1 为准）、`mho_register` 发送（开 PR 前置闸）、`mho_query` 回答、`complete` 核实 | R1、A2 |
| E2B-T1 双实例场景测试 | 双方 | `tests/e2b-*.test.ts`，覆盖 §8 全部 38 行 | 以上全部 |

- 薄接线进热点文件（`scheduler-auto-tick.ts`、`peer-pr-*`、manager 子命令注册）的，按防腐规则每处不超过 10 行，逻辑放新模块。
- 所有台账写入都走 scheduler-only 或 PM 子命令。调度服务只有只读句柄，直接写库在生产上会报 readonly。

## 10. 与 V2 的关系（留给 V2 定）

E2b 的委托行加 epoch、租约，在 V2 里可以映射成中心上的 `scheduler_leases`：推进权临时迁到执行地，合并权不迁。
V2 目前写的是「出借不改主场」。E2b 改的正是推进权，V2 落地时要明确：这种「推进权临时迁移」是否算换主场，以及 E2b 怎样迁移到中心裁决。
在此之前，E2b 只做点对点；中心模块、镜像、worker 权限都不当作 E2b 的入口。

## 11. 对 A 侧稿「待定」的冻结结论

| A 侧稿位置 | 待定 | 冻结 |
|---|---|---|
| §2.1 | 消息形状 | (b) 结构化接口 `/api/v1/e2b/*`，见 §2.3 |
| §2.2 第 2 条 | 授权形状 | 双向常设授权：A 入站、B 外发，见 standing 文档；不沿用 `peer_accept_standing` 这个名字 |
| §3.1 | 分支命名 | 由 B 在 offer 里指定 `e2b/d-<delegationId 的 26 位>`（第 2 轮由 `e2b/<bTask>-e<epoch>` 改来，见 §12） |
| §3.3 | 规格改动谁放行 | (a) A 侧 PM 用 restate-approve 放行，复述回写 B |
| §4.5 | B 的修改意见怎么记 | 记成 A 卡上的一轮审查（`reopen`），findingId 沿用 |
| §5 | 证据包版本 | 交给 R1：新证据格式另起版本；签名用途 `e2b` 由本稿批准 |
| §6.3 | 同 epoch 续租 | (a) 允许，条件见 §4.4；只限起因是租约过期，A 卡暂停而非终态（§3.2）；handed 下续租照回（第 3 轮） |
| §6.3 / §11 第 8 条 | 强制收回 | v1 不提供；以后如果需要，另行立项，由 owner 批准 |
| §7 | 互认范围 | 交给 R1；本稿只规定交接资格不等于互认 |
| 全文 | 指纹 | 一律用完整 key id（§2.1） |

## 12. 各轮设计审查与 A 侧对齐意见的处理

### 12.1 第 1 轮设计审查（另一家族，7 条 P1）

| findingId | 问题 | 处理 |
|---|---|---|
| handoff-scope | 非委托的 MHO1 自动卡没有交接资格契约 | 新增 §6.7：先登记、后交接，分类 `mho_pending` / `mho_handed`，撤回与迁移；未登记的普通 peer PR 照旧，不借道出借 |
| queue-count | 排队行也占并发名额，永远补不了位 | A 入站只数占名额的状态，排队另设上限（§4.1 第 3 条）；B 外发数全部未结束的委托，由 B 自己的结束释放，不会互锁（standing 文档 §4）；补位用 `admission` 回写 |
| lease-terminal | 停止一律转终态，同 epoch 续租接不上 | §3.2 第 3 条按起因分：租约过期只暂停 A 卡，revoke / 退回才 `cancelled` |
| handed-gate | handed 下 B 的审查、合并写口被总闸拦死 | §3.1 新增「handed 写口」（CAS 绑定交接），以及 reopen 前先停 B 侧合并效果 |
| branch-collision | 分支名只绑卡号和 epoch，会撞 | §2.2 分支由 `delegationId` 推出，接单时核分支不存在 |
| offer-drain | 首次交出没核清 B 的在途 | §3.1 新增 `preparing`：静止核对五条，核不清不发 offer；offer 带 `quiesceSeq`、`startHead` |
| stop-orders | 停止证据没有覆盖订单，尤其是借给第三台的单 | §5.2 第 3 步、§5.3：`orders[]` 必须全部终结并带回执，出借单要 C 的回执或停止证据 |

### 12.2 A 侧稿第 5 轮 §12 的对齐意见

| # | 意见 | 结论 |
|---|---|---|
| 1 | 停止一律 cancelled 与同 epoch 续租冲突 | 接受，与 lease-terminal 合并处理（§3.2 第 3 条） |
| 2 | 租约过期与「联系不上」都可进 frozen，条件重叠 | 接受：租约过期一律 `stopping`，不设超时；`frozen` 只留给 notStopped 非空、409、停止证据不合格（§3.1、§4.4） |
| 3 | 缺正常结束路径，A 名额一直占着 | 接受，用专门的 `complete`（§6.8），委托与非委托 MHO1 共用 |
| 4 | 推进中碰到 excludeSurfaces 怎么办 | 接受原建议：A 卡 manual + fallback，A 的 PM 决定，委托不自动停；另加 B 在交接时的整份核对（§4.1、§6.2 第 6 条） |
| 5 | 非 active 时收到 spec_update / reopen | 接受：`rejected:not_active`；handed 时 B 先 reopen 再改规格（§2.3、§4.3） |
| 6 | 「分支为空」怎么判 | 改为分支名按委托唯一，接单时要求分支**不存在**，不再需要「空」的定义（§4.1 第 11 条） |
| 7 | hold 核清后用什么消息通知 B | 接受：新 aSeq 重发完整 `stop_confirm`，B 以 aSeq 最大的一份为准（§5.3） |

### 12.3 第 2 轮设计审查（另一家族，4 条 P1）

| findingId | 问题 | 处理 |
|---|---|---|
| handoff-scope | 登记可以晚于开 PR；未登记、登记关闭后重开都落回普通收审，「没登记」被当成「不是自动卡」 | A 拿到 `registered` 才能开 PR（A 侧效果闸，§6.7）；`handoffIntake` 打开后这个 peer 的未登记 PR 先 `mho_query` 正面分类（§6.3）；登记关闭改为 `closed_unmerged`，重开恢复有效；几种迟到情形统一按迁移处理（§6.7） |
| accept-race | `accepted` 回执丢了，A 已开始回写，B 在 offering 拒收并把拒收固定进去重表 | B 在 offering / queued / needs_owner 收到验签通过、绑定一致的业务消息，推断 A 已接单，同事务转 delegated 再收（§3.1）；另定义暂态回执，不进去重表、不消费 seq（§2.4） |
| reopen-lease | handed 期间租约过期后，B 发出的 reopen 必被拒，B 又先退回了 delegated，续租条件也接不上 | handed 下续租照回（§3.1、§4.4）；reopen 改成 `handed/reopening` → 收到 `applied` 才转 delegated；A 暂停时回暂态 `retry:not_active`，续上后同 seq 重发（§3.1、§3.2 第 3 条） |
| withdraw-drain | A 撤回交接后马上可以派 fix，B 还拿着 handed 写口和在途 update-branch | A 侧新增持久子状态 `handed` / `withdrawing`，进业务效果闸（§3.2 第 1、5 条）；B 的回执分 `withdraw_received` 和 `withdraw_confirm`，后者带 `settled[]` 与 `prHead`，A 收到它才派 fix（§6.4） |

### 12.4 A 侧稿第 6 轮 §12 的对齐意见

| # | 意见 | 结论 |
|---|---|---|
| 1 | §4.3 规格更新没有重核排除面；§4.1 末段允许 PM 绕过 owner 继续 | 接受，并按 A 侧的收窄更正写：用**接单时那份授权**的 excludeSurfaces 和范围评估新规格，不重核有效期、不看普通撤销；碰到排除面 → A 卡 manual、`fallback{surface_excluded}`、`needs_owner`、A owner 逐卡 authorize，不同意或超时 `return_request`（§4.3）。§4.1 末段改成 PM 只能收窄 |
| 2 | 收到 `stale_epoch` / `not_delegated` 时 A 分不清 B 是租约过期还是已收回 | 接受：一律按租约过期处理，暂停，收到 `reclaim_confirm` 才 `cancelled`（§3.2 第 3 条） |
| 3 | handed 期间租约过期后续租和 reopen 接不上 | 接受方案 (a)：handed 下 B 照回 `renew_ack`；与 reopen-lease 合并处理（§3.1、§4.4） |
| 4 | `registrationId` 谁生成、什么格式 | 接受：A 生成，`mho_` + 26 位随机 base32，不复用（§2.3、§6.7） |
| 5 | A 拿到登记回执前就开了 PR，B 可能已建 `PR<n>` 卡 | 接受：一律按迁移处理（§6.7「迁移（统一规则）」）；A 侧先拿 `registered` 再开 PR，正常走不到 |
