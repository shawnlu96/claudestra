# E2b 整卡委托：协议冻结稿（P2）

> 状态：**设计冻结稿（待另一家族设计审查、A 侧对齐）**。只写设计，不授权实现、生产开关、算力额度或审查互认。
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

1. **唯一推进者。** 同一张 B 卡在任意时刻最多只有一个调度器在产生业务效果。B 卡交出去之后 B 只观察；A 只在持有当前 epoch、租约有效时推进。
2. **合并与部署权不跟着走。** A 侧项目必须是 `mergeHandoff: true`。A 永不 merge、update-branch、部署。交接资格不是 PASS，不是审查互认，也不是 B 的合并许可。
3. **收回要证据，不靠超时。** 租约过期只让旧端的新效果失效，不把写权自动还给 B。正式收回之前，必须核清旧端已经停止，worker、订单和 unknown 效果都已结清，未交成果已保全。离线或证据不明，卡就冻结，不做假确认。

## 1. 和现有路径的边界

| 现有路径 | 谁推进卡 | E2b 与它的关系 |
|---|---|---|
| 出借单（T47/T48，`remote-capacity.md`） | 发起方调度器，只借一步 | 照用、不替换。E2b 交出去的是整卡推进权；A 推进时仍可以把审查单借给第三台机器 |
| 逐步委托 T46（`peer-delegation.md`） | 发起方 PM 手推 | 照用。边界不清、要逐件拍板的活走 T46；E2b 只接规格写清、在常设授权内的卡 |
| 本机 v3 / E2a | 本机调度器 | A 推进的就是一张本机 v3 卡，执行者都是本机会话，不走 peer 路由（`worker-session.ts` 的 peer→manual 不用改） |
| 共享台账 V2 home / executor | 中心裁决租约，主场不变 | E2b 是 V2 落地前的点对点做法。V2 落地后，epoch 和租约映射成中心的 lease；「推进权临时迁移」是否算换主场，由 V2 另定（§10） |
| MHO1 mergeHandoff | A 开卡 → v3 → 交回 | E2b 复用它的交回与纯 main carry，只是卡由 B 发起，交接经认证 peer 送到 B，B 持久接收后才算交接成立（§6） |
| B 的 peer PR 收审（`peer-pr-auto.md`） | B 新建 `PR<n>` 卡 | 委托中的分支所开的 PR **不走**普通收审，挂在原 B 卡上（§6.3）；其他 peer PR 一律照旧 |

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
| `branch` | **由 B 在 offer 里指定**：`e2b/<bTask 小写>-e<epoch>` | A 必须用这个分支，不自己起名。PR 开在 B 仓库，base `main` |
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
| B→A | `offer` | 业务 | delegationId、epoch、bTask、specRev、specSha256、规格或分块、template、repo、branch、leaseMs、bWorkflowRev、`observing: true`、surfaceRules？ | `accepted` / `queued` / `needs_owner` / `rejected:<码>` |
| B→A | `spec_update` | 业务 | specRev+1、specSha256、正文 | 回执 `applied` / `rejected:<码>`（超授权范围按新委托处理） |
| B→A | `reopen` | 业务 | 交回后 B 审查的 findings[]（含 findingId）、B 审查的 head | A 把卡从 merge 退回 fix，B 的结论记成 A 卡上的一轮审查 |
| B→A | `revoke` | 控制 | reason | 应答 `stopping`，A 进停止流程 |
| B→A | `renew_ack` | 控制 | leaseUntil | 续租确认 |
| B→A | `reclaim_confirm` | 控制 | newEpoch、disposition[] | A 委托行转 `closed`，按处置清理 |
| A→B | `writeback` | 业务 | aSeq、kind（restate / stage / deliver / review / closure / blocked / fallback）、payload | 回执签名 `{delegationId, epoch, aSeq, sha256}` |
| A→B | `handoff` | 业务 | aSeq、HandoffEvidence（§6.1） | 回执 `handoff_received` 并附资格裁决（§6.2） |
| A→B | `handoff_withdraw` | 控制 | aSeq、head、reason | 回执 `withdraw_ack`（§6.4） |
| A→B | `renew_request` | 控制 | leaseUntil 申请值 | B 回 `renew_ack`，或回 `stale_epoch` |
| A→B | `return_request` | 控制 | reason | B 应答，之后双方走停止流程 |
| A→B | `stop_confirm` | 控制 | stoppedAt、lastSeq、sessions[]、notStopped[]、unknownEffects[]、artifacts[] | B 用来核停止（§5.4） |

### 2.4 去重、排序与回执

- 去重键：业务消息 `e2b:<delegationId>:<epoch>:<dir>:<seq>`，控制消息 `e2b:<delegationId>:<epoch>:ctl:<type>:<seq>`。
  同键同摘要，拿回原回执；同键换了内容，返回 409，并冻结该委托、交给收方 PM，不自动重编号。
- 收方按 `seq` 顺序收。有缺口回 `gap{expect}`，发方从缺口那条起补发。
- 所有回执都用收方实例签名，签 `{delegationId, epoch, dir, seq, sha256, outcome}`。发方验签之后，才把这条在 outbox 里标为已送达。
- 两侧都是 **outbox 先写后发**：重试退避 30 秒到 10 分钟，重启后从最小的未确认 seq 重发。不允许静默丢弃，结果只有三种：重试、冻结、退回人工。

## 3. 状态机

### 3.1 B 侧（每份委托一行，持久在 B 台账）

| 状态 | 进入条件 | B 对这张卡能做什么 | 收 A 业务消息 | 收 A 控制 / 积压 |
|---|---|---|---|---|
| `offering` | B PM 在 B 外发常设授权内发起委托 | 卡的 workflow 已切到 `delegated`；只能撤回 | 拒（`not_delegated`） | 收 offer 回执 |
| `queued` / `needs_owner` | A 回执排队 / 等 A owner | 同上；可撤回 | 拒 | 收 |
| `delegated` | A 回执 `accepted` | 只观察：投影 A 的回写；PM 只能 `revoke`、`spec_update`、写 note | 收（epoch 等于当前值、委托 active、seq 连续） | 收 |
| `stopping` | B 撤回，或 A 发 `return_request`，或租约过期 | 不推进，等停止证据 | 拒（`stale_epoch`） | 收，只入历史和停止核对 |
| `frozen` | 联系不上 A，或 A 报 `notStopped` 非空，或出现 409 | 不推进，**不开任何新推进**；资源继续占着 | 拒 | 收 |
| `reclaimed` | §5.4 的条件全部满足；epoch+1 | B 卡回到 B 本机流程（manual），之后可以重新委托 | 拒 | 收，只作迟到历史 |

- `delegated` 是 B 卡 workflow 的一个新模式。在这个模式下，B 的规划器对这张卡不排任何意图。
- B 侧**所有**会推进卡的写口一律拒绝这张卡，并给出同一个错误码 `card_delegated`。这些写口包括：
  stage、step、deliver、review 入账、lend-offer / reoffer、manual-merge-request、workflow-set / resume、scheduler-* 系列，
  以及 DAG 改写里与本节点绑定的卡。
- 这是 B 侧实现的前提：A 接单时会核 offer 里的 `observing: true` 和 `bWorkflowRev`。
- 从 `delegated` 回到本机推进，只有一条路：`reclaimed`。B owner 或 PM 都不能手工把卡改回 auto。

### 3.2 A 侧

照 A 侧稿 §3.4 的表冻结，状态为 `queued` / `needs_owner` / `active` / `stopping` / `stopped` / `closed`。冻结时补三条：

1. 业务效果闸紧贴效果，在同一事务里核：委托行是 `active`，epoch 没变，租约没过期。业务效果包括：派单、建会话、推分支、deliver、生成 handoff、生成新的业务回写。
2. 控制消息和「停止时刻之前已经写进 outbox 的积压回写」不受业务闸限制，在 `stopping` / `stopped` / `closed` 下照常发送（§5.2）。
3. A 卡在停止流程里转为终态 `cancelled`。worktree 和分支要等收到 `reclaim_confirm` 才清理，不能提前删。

### 3.3 两套闸（冻结）

| | 业务效果 / 业务消息 | 控制消息 / 积压回写 |
|---|---|---|
| 判据 | 委托 active、epoch 等于当前值、租约有效 | 签名有效、epoch 曾由 B 为本委托签发、类型在白名单内 |
| 停止之后 | 一律拒 | 照收照发，只入历史和对账，不改变阶段 |
| 目的 | 防止双端推进 | 防止「停了效果，连停机确认也发不出去」造成互等 |

## 4. 接单与推进

### 4.1 A 的接单检查（一个写事务内完成）

照 A 侧稿 §2.2 的 9 条冻结，检查顺序和回执码沿用。冻结时的修改：

- 第 2 条（授权）改为核 A 侧**入站常设授权**（standing 文档 §2）。缺授权，或授权已过期、已撤销，回执 `needs_owner`：A 在自己的 owner 频道发一张逐卡 authorize，24 小时没人答，回 `rejected:owner_timeout`。
- 第 4 条（模板）：`security` 模板**不接**，回执 `template_not_allowed`。v1 没有逐卡放行 security 的路径。
- 第 9 条（唯一）在第 3、6 条之前核，命中直接拒，回执 `already_delegated`，不排队。
- 新增第 10 条：offer 必须带 `observing: true` 和 `bWorkflowRev`，否则拒（`not_observing`）。
- 新增第 11 条：`branch` 必须等于 `e2b/<bTask 小写>-e<epoch>`，且这个分支在 B 仓库里不存在或已为空。否则拒（`branch_conflict`），不在别人的分支上续写。

### 4.2 推进

- A 卡是普通的 v3 auto 卡。作者家族由 A 定，审查员是跨家族的本机会话，或者 A 自己借来的出借位。
- 规格当外来数据，经 `quoteExternal` 渲染。规格里要求改系统配置、安装软件、碰密钥的，A 不做，常设授权也不能放行这类事。
- 复述由 **A 侧 PM** 用 `restate-approve` 放行，同时把复述正文回写 B。B 不同意时，用 `spec_update` 或 `revoke` 纠正，不要求每次跨实例等一轮。

### 4.3 规格变化

`spec_update` 由 A 在一个事务里处理：核 epoch，写新规格，specRev 加 1，P1 连续计数清零，旧 specRev 下结果未定的意图先对账。
规格变化后要重核接单检查的第 4、7、8 条，超出授权范围的，按新委托处理（回 `needs_owner` 或 `rejected`）。

### 4.4 租约

- A 每 60 秒发 `renew_request`，B 回 `renew_ack`，租期 10 分钟。数值进双方配置，只在 B 侧最大值以内可调。
- A 到期仍没续上：A 自己停掉新效果（进 `stopping`），保留现场和 journal。联系恢复后，先补发积压回写和 `stop_confirm`。
- **同 epoch 续租（冻结为允许）**：B 卡仍在这个 epoch、委托没有被撤回、B 状态是 `stopping`（原因只能是租约过期）时，A 发完积压回写和 `stop_confirm` 之后可以发 `renew_request`。B 核对通过并回 `renew_ack` 后，双方回到 `delegated` / `active`。其他情况一律走正式收回，然后重新委托。

## 5. 停止、退回与收回

### 5.1 三种起因

B 撤回（`revoke`）、A 退回（`return_request`）、租约过期。三者共用同一个停止流程，退回也要 B 确认才算结束，A 不能单方面宣布。

### 5.2 A 的停止流程

照 A 侧稿 §6.1 冻结：
1. 先停新效果；
2. 让在途会话停下，判据是会话退出、进程确认不在；
3. 出在途成果清单：分支和 origin head（`git ls-remote` 核过）、本地未推送的提交、PR、unknown 意图及其可能的外部效果、未确认的 outbox、未回写的报告；
4. 用实例签名发 `stop_confirm`；
5. A 卡转 `cancelled`，现场保留。

### 5.3 「停止证据」的定义（冻结）

能证明旧端已经停止的，只有 A 签名的 `stop_confirm`，且同时满足：
- `notStopped` 为空；
- 积压回写连续收到 `lastSeq`。
GitHub 上没有新推送、agent 界面空闲、租约过期，都**不算**停止证据。

### 5.4 正式收回（B）

B 只在以下全部满足时，才把 epoch 加 1，转 `reclaimed`，并发出 `reclaim_confirm`：
1. 有 §5.3 的停止证据；
2. `unknownEffects` 和在途成果逐条有处置，每条只能是三种之一：
   - `adopt`：采纳，写明 head；
   - `discard`：丢弃，写明理由；
   - `hold`：继续当 unknown 占着资源。只要有一条是 `hold`，这次就不能收回。
3. B 侧在途的合并、部署、update-branch 效果都已结清（§6.4）。

联系不上 A，或 A 报了 `notStopped` 非空，状态是 `frozen`：
- 不超时、不自动收回；
- **v1 不提供强制收回**。

解冻只有一条路：A 补出停止证据。联系不上就等 A 恢复。`notStopped` 非空的，由 A 的 PM 或 owner 在 A 本机停掉那些会话，再发一份新的 `stop_confirm`。

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
5. 证据包可以取回，哈希对得上。

全部通过后，B 持久记一条 `e2b_handoff`（含裁决），然后签回执。B 卡从 `delegated` 进入 **`handed`** 子状态：
- 这一刻起，这个 PR、这个 head 才有资格进入 B 自己的合并审查流程；
- 核心面要完整审查，见 R1 的分级；互认在开关打开、R1 落地之前一律不启用；
- 合并闸不改。

任一条不过，回执 `handoff_rejected:<码>`，卡停在 `delegated`，A 回到 fix 或交给 A 的 PM。

**交接资格 ≠ PASS ≠ 互认 ≠ 合并许可**：资格只表示「B 收到了一份完整、对得上的交接，可以开始 B 自己的流程」。
A 的本轮 PASS 和 B 的旧 PASS 互不覆盖：任何一侧有未关闭的 P0 / P1，或者有有效的撤回，都不能拿另一侧的 PASS 补上。

### 6.3 PR 分类（B 的收审）

| PR 情况 | 归类 | 处理 |
|---|---|---|
| 分支是某份活委托指定的 `branch`，已收到有效 handoff | `e2b_handed` | 挂到原 B 卡，进 B 的合并审查流程 |
| 分支是活委托的 `branch`，但还没有 handoff，或 handoff 已撤回 | `e2b_pending` | **不收审、不建 `PR<n>` 卡、不进合并队列**。PR 存在、draft 状态、作者 login、标题标签、CI 绿，都不算交接 |
| 其他 peer PR | 照旧 | 现有 peer-pr-auto 流程不变，不因 E2b 放宽 |

### 6.4 撤回交接

- A 在以下情况发 `handoff_withdraw{head, reason}`：卡离开 merge、A 本地出现 P1、CI 红、主动退回、收到 B 的 `revoke`。
- B 收到经认证、并且对应原交接、PR、head 的撤回后：
  1. **先停新效果**：不再开始 update、merge、deploy；
  2. 在途的效果做真实对账：
     - update-branch 已发出的，读 PR head 核实；
     - merge 结果不明的，按现有 unknown 规则冻结；
     - 部署照现有部署对账；
  3. 持久记录，签回执。
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

## 7. 开关与缺省

| 开关 | 位置 | 取值 | 缺省 | 效果 |
|---|---|---|---|---|
| B 外发 | B 项目配置 `e2b.outbound` | off / observe / on | **off** | observe：只记录「本可委托」的事件，不发 offer；on：允许 PM 在外发常设授权内发 offer |
| A 入站 | A 项目配置 `e2b.inbound` | off / observe / on | **off** | off：一律回 `rejected:not_configured`；observe：做完全部接单检查并记录「本会接」，回 `rejected:observe_only`；on：照协议接单 |
| B 交接收审 | B `e2b.handoffIntake` | off / on | **off** | off 时 `e2b_*` 类 PR 一律当 `e2b_pending` 处理，绝不放宽成普通收审 |

- 配置读不出、或者损坏，按 off 处理。
- 设计批准、实现合入，都不等于开关已经打开。打开每一个开关，都要 owner 单独批准。

## 8. 场景矩阵（验收的依据，双实例沙箱）

每一行都要在 `--lab --pair` 双实例沙箱里复现，核对两边的状态，并断言「禁止效果」一次也没有发生。

| # | 场景 | 预期 B | 预期 A | 禁止效果 |
|---|---|---|---|---|
| 1 | 5 张卡、A 授权并发 3 | 5 份委托：3 份 delegated、2 份 queued；前面一张收回后补位 | 3 张 active、2 张 queued；按到达顺序补位，补位时重核全部接单检查 | A 同时活跃的卡超过 3 张；B 推进任何一张 |
| 2 | 同一张 B 卡顺序委托两次 | d1 reclaimed 之后，d2 用新 epoch | d1 closed 之后才接 d2，d2 新建 A 卡（哈希卡号） | d2 在 d1 closed 之前被接 |
| 3 | 同一张 B 卡并发两份 offer | B 侧唯一索引只让一份落库 | 另一份回 `already_delegated` | A 出现两张 A 卡 |
| 4 | 推进中断网 10 分钟 | 租约过期 → stopping，不收回 | 自停 → stopping，outbox 积压；恢复后补发，经同 epoch 续租回到 active | 断网期间任何一侧产生业务效果 |
| 5 | A 重启 | 不变 | 委托行持久，先对账未结意图，再续租 | 重复的推送或事件 |
| 6 | 旧 epoch 的结果迟到 | reclaimed 之后收下，只入历史 | — | 迟到消息改变 B 卡阶段 |
| 7 | B 撤回（fix 进行中） | stopping → 核对清单 → reclaimed | stopping → stop_confirm → closed | 收回前清理 A 现场 |
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
| 21 | 联系不上、旧 worker 还活着 | frozen，直到拿到停止证据 | 恢复后，人工停会话，再发 stop_confirm | 凭 GitHub 静态观测就收回 |
| 22 | security 模板 | 外发闸拒绝 | `template_not_allowed` | 远端整卡接 security |

## 9. 后续实现拆分（实现包，待 owner 批准；本卡不开）

| 节点 | 归属 | 范围（候选 fileGlobs） | 依赖 |
|---|---|---|---|
| E2B-C1 线契约 | B | `src/lib/e2b-contract*.ts`：schema、完整 key id、签名用途、去重键 | — |
| E2B-S1 常设授权 | B（双方共用库） | `src/lib/e2b-authorization*.ts` + 绑定 bridge ask 的 action | C1 |
| E2B-B1 委托状态与 delegated 模式 | B | `src/lib/ledger-e2b*.ts`；B 侧所有写口统一拒绝的薄接线 | C1 |
| E2B-B2 B 收发端点与 outbox | B | `src/bridge/e2b-*.ts`、`src/lib/e2b-outbox*.ts` | C1、B1 |
| E2B-B3 交接接收、PR 分类与撤回 | B | `src/lib/e2b-handoff*.ts`；peer-pr intake 的分类薄接线 | B2、R1 |
| E2B-A1 接单与效果闸 | A（He） | `src/lib/e2b-intake*.ts`、`src/lib/e2b-runtime*.ts` | C1、S1 |
| E2B-A2 回写与停止清单 | A（He） | `src/lib/e2b-writeback*.ts`、`ledger e2b-stop-report` | A1、C1 |
| E2B-A3 交接证据导出 | A（He） | `src/lib/e2b-evidence*.ts`（以 R1 为准） | R1、A2 |
| E2B-T1 双实例场景测试 | 双方 | `tests/e2b-*.test.ts`，覆盖 §8 全部 22 行 | 以上全部 |

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
| §3.1 | 分支命名 | 由 B 在 offer 里指定 `e2b/<bTask 小写>-e<epoch>` |
| §3.3 | 规格改动谁放行 | (a) A 侧 PM 用 restate-approve 放行，复述回写 B |
| §4.5 | B 的修改意见怎么记 | 记成 A 卡上的一轮审查（`reopen`），findingId 沿用 |
| §5 | 证据包版本 | 交给 R1：新证据格式另起版本；签名用途 `e2b` 由本稿批准 |
| §6.3 | 同 epoch 续租 | (a) 允许，条件见 §4.4 |
| §6.3 / §11 第 8 条 | 强制收回 | v1 不提供；以后如果需要，另行立项，由 owner 批准 |
| §7 | 互认范围 | 交给 R1；本稿只规定交接资格不等于互认 |
| 全文 | 指纹 | 一律用完整 key id（§2.1） |
