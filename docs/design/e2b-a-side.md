# E2b 整卡委托：接收方（A 侧）设计稿

> 状态：**设计稿（讨论用）**，还没实现。卡号 E2BA-1。协议主线以 B 侧（仓库方）的 P2 冻结稿为准：`docs/design/e2b-protocol.md` 和 `docs/design/e2b-standing-authorization.md`（PR #793 第 2 轮，head `b6526819`；下称「P2」「P2 授权稿」）。本稿只写 A 侧怎么做：第 5 轮起按 P2 对齐，第 6 轮对齐到 P2 第 2 轮。
> 上一版写 `待定` 的地方，已按 P2 §11 的冻结结论改写为「已冻结（P2 §x）」，不再保留旧选项。和 P2 有分歧、或 A 侧做不到的地方，正文不改协议，统一列在 §12「对 P2 的意见」。

**E2BR-1（#785）`e2b-a-side-states.md` 的内容去向**（#785 是给 P2 的讨论输入，本卡不改它）：

| #785 的部分 | 去向 |
|---|---|
| §0 三件事（还没实现、业务效果与控制确认分开记、推进权与合并权分开） | 已被 P2 取代：§0 三条不变量、§1 末段、§3.3 两套闸 |
| §1 状态对照表 S0–S9 | A 侧状态已被 P2 §3.2（本稿 §3.4）取代；B 侧状态已被 P2 §3.1 取代：`offered` 对应 `preparing` / `offering`，`待收回` 对应 `stopping` / `frozen`，S5 的「入场资格」对应 `delegated/handed`，S6 对应 `completed` |
| §1 的 `complete` 消息 | 已被 P2 §6.8 `complete` 取代 |
| §2 迁移表 | 消息、闸、停止流程已被 P2 §2.3、§3.3、§5 取代；「确认丢了怎么办」这一列还有用，留给双实例场景测试（P2 §9 的 E2B-T1） |
| §2 的「续租」行（只限 S7，必须在完整停止确认之前） | 已被 P2 §3.2 第 3 条、§4.4 取代：租约过期时 A 卡暂停、不进终态，发完停止确认也能续租 |
| §3.1 重复委托 N1–N9 | N1 已被 P2 §8 第 3 行取代；N2 已被 P2 §8 第 2 行和本稿 §10 A1 取代；N3–N8 还有用，作 A1 和 E2B-T1 的负例；N9（B 卡号大小写）对分支已不成问题，分支按 `delegationId` 推出（P2 §2.2），卡号要不要归一化仍归 B 侧卡号规则 |
| §3.2 离线与收回 N10–N19 | 已被 P2 §5.3、§5.4、§2.4 和 §8 第 4、6、15、21、30 行取代；N18b 已被 P2 §3.2 第 3 条取代 |
| §3.3 撤回与合并并发 N20–N29 | N20、N24–N27 的主体已被 P2 §6.4、§6.8 和 §8 第 18、19、26、27 行取代；N22 已被 P2 §5.5 取代；N29 已被 P2 §2.3 `rejected:not_active` 取代；N21、N23、N26、N28 还有用，留作 E2B-T1 的负例 |
| §4 确认丢失总表 | 已被 P2 §2.4 取代（outbox、签名回执，结果只有重试 / 冻结 / 退回人工三种） |
| §5 对 A 稿的三处小修 | 已落进本稿：§3.4 回指 §2.2 第 9 条、§10 A1、§6.3 的停止去向 |
| §6 留给 P2 的问题 | 状态名、续租、N29 的码已由 P2 §3.1、§3.2、§4.4、§2.3 定下；N26（交接之前 B 绕过闸在 GitHub 上直接合并）P2 没定，留给 E2B-T1 当负例 |

## 0. 名词与一句话

- **B（仓库方 / 委托方）**：仓库的 owner 实例（Shawn）。卡原本在 B 的台账上，规格由 B 写，**合并和部署权始终在 B**。
- **A（接收方）**：本机。整卡接过来，用本机 v3 调度器从头推进（复述 → 写 → 跨族审查 → 修 → 交回）。
- **委托（delegation）**：B 把自己的一张卡在一段时间里的**推进权**交给 A。每份委托有一个 `delegationId`（B 生成，`e2b_` + 26 位随机 base32），以及 B 签发、单调递增的 `epoch`（P2 §2.2）。
- **B 卡 / A 卡**：同一件活在两边台账上各有一张卡。B 卡是权威记录，A 卡是 A 用来推进的本机卡。
- **完整 key id**：实例 Ed25519 公钥的 `sha256`，64 位小写 hex（P2 §2.1）。本稿里的「指纹」「B 的身份」一律指它；展示用的短指纹不进任何授权、索引或去重键。

一句话：A 的 owner 先签好入站常设授权 `e2b_standing_inbound`，允许 A 接这个 peer、这个项目的委托；B 想委托、或者 B 侧签了外发授权，都替代不了它。B 把一整张卡交给 A，A 在本机按 v3 自动推进，所有阶段和审查结论按时序回写 B 卡，最后用 mergeHandoff 把 PR 和证据交回 B，合不合由 B 决定。委托期间 B 卡只观察不推进，同一时刻只有一个调度器在推进这张卡。

owner 原话（2026-10-07）：「我想让shawn往这边派单的时候是整张卡 派过来 我这边走v3 自动化呢？」「那把整个这套都设计实施了吧」。
B 侧答复的要点（pm-codex@Shawn 00:27，作为数据引用，原文在规格卡 E2BA-1）：方向可以讨论，实现要等 B 侧设计立项；**租约过期不能自动把写权还给 B**；互认范围是初步的，还没定。

## 1. 和现在已有的路的区别（先讲清楚，后面各节都以此为前提）

| 现有机制 | 谁推进卡 | 对方做什么 | E2b 和它的区别 |
|---|---|---|---|
| 出借单（`docs/design/remote-capacity.md`） | 发起方的调度器 | 出一个 worker 位，接一单（审查单或写单），结果经 `lend/result` 回写 | 出借只借「一步」，卡和调度都留在发起方；E2b 交出去的是整张卡的推进权 |
| 跨实例委托 T46（`docs/team/peer-delegation.md`） | 发起方 PM 手推（放行复述、merge 都是发起方 PM） | 接收方 agent 经 `peer-ledger` 写卡，逐件问 owner（规矩 1，`peer-delegation.md:9`） | E2b 由接收方调度器自动推进，常设授权代替逐件问；放行复述也在 A 侧（见 §3.3） |
| 共享台账 V2（`docs/design/shared-ledger.md` §5、`shared-ledger-v2.md`） | 主场（`homeInstanceId`），中心统一裁决租约 | 执行地（`executorInstanceId`）只干活，「借出去不改变主场」（`shared-ledger.md:197`） | E2b 没有中心，是两台实例之间点对点地临时转移推进权；合并权不跟着走 |
| 今天的 A 开卡 → v3 → 交回 B（`docs/architecture/merge-handoff.md`） | A 的调度器 | B 用自家的 PR 收审（`docs/architecture/peer-pr-auto.md`）重新完整审一遍 | 卡是 A 自己开的，B 台账上没有对应卡；E2b 的卡由 B 发起，进度回写 B 卡，证据要能被 B 核对。这类非委托的卡以后要先登记再交接（§4.7） |

E2b 是在这几条路之上补一条「整卡、自动、两端台账同步」的路，**哪一条都不替换**（详见 §8）。

## 2. 接单（A 侧收委托）

### 2.1 通道（已冻结，P2 §2.1、§2.3）

B 用已经握手的 HTTP peer 把委托交给 A，消息走结构化接口 `POST /api/v1/e2b/<type>`（P2 §11 冻结为结构化接口这一选项）。A 侧要做的：

- **请求级身份**：A 的 bridge 验 B 的请求签名（新增签名用途 `e2b`），公钥必须等于这个 peer 钉住的公钥，B 的身份取完整 key id。请求体里自报的实例和名字一概不信（同 `remote-capacity.md:150`）。peer 名相同但公钥变了，当新主体处理，旧委托、旧授权都不继承。
- **消息格式**：body 是严格 JSON，有未知字段就拒收，整条消息 ≤ 32 KiB；规格太长时按 `spec_chunk` 分块收，每块都核 `specSha256`。
- **A 收的消息**：业务类 `offer`、`spec_update`、`reopen`；控制类 `revoke`、`renew_ack`、`reclaim_confirm`、`complete`。
- **A 发的消息**：业务类 `writeback`（含补位结果 `admission`）、`handoff`、`mho_register`（§4.7）；控制类 `handoff_withdraw`、`renew_request`、`return_request`、`stop_confirm`。

选结构化接口的理由：接单要在事务里做 CAS、支持幂等重发、发签名回执、按 epoch 拒收旧消息，`send_to_agent` 的消息正文做不到这些；而且它的注入头会要求先问 owner（`peer-delegation.md:140`），和「常设授权内自动接」相冲突。

### 2.2 A 要核的东西（在一个写事务里核完再落卡）

已冻结：P2 §4.1 沿用本稿原来的 9 条，第 2 轮改了第 3 条的数法，并新增第 10–12 条。

| # | 核什么 | 依据 | 不满足时 |
|---|---|---|---|
| 1 | B 的身份：bridge 验签，公钥等于钉住的公钥，身份取完整 key id | P2 §2.1 | 401，不落任何东西 |
| 2 | 有一份 A owner 本人签的**入站常设授权** `e2b_standing_inbound`：没撤销、没过期，`peerKey` 等于认证得到的 B 的完整 key id，仓库和模板都在白名单里，规格没碰到 `excludeSurfaces` | P2 授权稿 §2、§4 | 回执 `needs_owner`，转逐卡 authorize（§2.3） |
| 3 | 并发名额：这个 peer 在 A 侧**占名额**的委托数 < 授权里的 `maxConcurrent`（1–8）。只数 `active`、`stopping`、`stopped`；`queued`、`needs_owner` 不占名额。和第 9 条在同一个写事务里数，不在事务外先数后写 | P2 §4.1 第 3 条、P2 授权稿 §4 | 名额满：排队，回执 `queued`。排队也满（同一 peer 排队中的已有 `maxConcurrent` 份）：拒单，回执 `rejected:queue_full` |
| 4 | 模板：`security` 一律不接，v1 没有逐卡放行 security 的路；其余模板还要在授权的 `templates` 里（只能是 `code` / `ui`），这一半跟第 2 条一起核 | P2 §4.1；`remote-capacity.md:153-154` | 拒单，回执 `template_not_allowed` |
| 5 | A 本机：项目的入站开关 `e2b.inbound = on`；`scheduler.json` 启用了这个项目、`autoDispatch` 开着；项目是 `mergeHandoff: true` | P2 §7；`scheduler-engine.md:203`、`merge-handoff.md:8-15` | 拒单，回执 `not_configured`。开关是 `observe` 时，做完全部检查、记下「本来会接」，回执 `rejected:observe_only` |
| 6 | A 本机额度闸和 worker 槽 | 和本机派单同一个口径（`remote-capacity.md:385`） | 排队，回执 `queued`，原因写「额度 / 槽满」；排队满时同第 3 条 |
| 7 | 仓库：委托里的 `owner/repo` 在授权的仓库白名单里，而且就是 A 这个项目 `repoDir` 的 origin | 和 `merge-handoff.md:56-57` 的 origin 核对同一套 | 拒单，回执 `repo_mismatch` |
| 8 | 规格大小有上限、能脱敏；正文按外来数据处理 | `remote-capacity.md:187-191` | 拒单，回执 `spec_invalid` |
| 9 | **同一张 B 卡在 A 侧最多只有一份没关闭的委托**：按 `(bKey, bTask)` 查委托表，除了这个 `delegationId` 自己那一行，不能有状态不是 `closed` 的行（`queued`、`needs_owner` 虽然不占名额，也算没关闭）。新委托的 epoch 还必须大于这张 B 卡上一份委托的 epoch | P2 §2.2 `bTask` 行、§4.1；本稿 §3.4 | 拒单，回执 `already_delegated`，附上 A 侧那份旧委托的 `delegationId` 和状态；**不排队** |
| 10 | offer 带 `observing: true`、`bWorkflowRev` 和 `quiesceSeq`，表示 B 卡已经切到只观察的 `delegated` 模式，并且 B 已在 `preparing` 里核清了本卡的在途（P2 §3.1）。A 核不了 B 的内部状态，只核这几个字段在；B 的签名对它们负责 | P2 §2.2、§3.1、§4.1 | 拒单，回执 `not_observing` |
| 11 | `branch` 等于由 `delegationId` 推出的 `e2b/d-<delegationId 去掉 e2b_ 前缀后的 26 位小写>`，而且 A 用 `git ls-remote` 核这个分支在 B 仓库里**不存在** | P2 §2.2、§4.1 | 拒单，回执 `branch_conflict`；不在别人的分支上接着写 |
| 12 | `startHead` 在 B 仓库里能取到：fetch 之后这个完整 SHA 存在 | P2 §2.2、§4.1 | 拒单，回执 `start_head_missing` |

**检查顺序**：
1. 先核第 1 条；
2. 再核结构性拒单的第 4、5、7、8、10、11、12 条；
3. 然后核第 9 条；
4. 再核第 2 条；
5. 最后核排队类的第 3、6 条。

这样排的理由：
- 注定要拒的委托，在问 owner、进排队之前就拒掉；
- 第 9 条排在任何一行落库之前；
- P2 §4.1 要求的「第 9 条在第 3、6 条之前核」也满足。

同一个 `delegationId` 的重发不走这些检查，直接按 §2.3 的幂等规则拿回原回执（第 11 条也不重核，P2 §4.1）。

**排队补位**（已冻结，P2 §4.1）：
- **什么时候补**：有名额空出时（委托行转 `closed`：收到 `reclaim_confirm` 或 `complete`），A 在**一个写事务里**按到达顺序取排队中最早的一份，重新数占名额的委托数，然后把第 1–12 条全部重核（第 11 条照样核分支不存在）。名额的数和委托行的状态改在同一个事务里，所以两个补位事务并发时，也只有一份能拿到空出来的那个名额。
- **通过**：委托行转 `active`、建 A 卡，回写 `writeback{kind: admission, outcome: accepted}`；B 收到后 `queued` → `delegated`。
- **不通过**：委托行转 `closed`，回写 `admission{outcome: rejected:<码>}`；B 收到后转 `reclaimed`。这时没有 A 卡，不需要停止证据。
- `admission` 回写在补位事务里和委托行状态一起生成，是唯一一种不在 `active` 下生成的业务回写。

**第 9 条怎么落库**：在同一个写事务里核，加上委托表上的部分唯一索引 `(bKey, bTask) WHERE state <> 'closed'`。两份委托并发到达时只有一份能落库，另一份拿到 `already_delegated`（P2 §2.2 要求两侧都这样做）。其他规则：
- 同一个 `delegationId` 的重发命中自己那一行，不算第二份。
- A 那一行只有在收到 `reclaim_confirm`、核实通过的 `complete`，或者补位、owner 授权没通过时，才转 `closed`。B 已经收回、A 还没收到的，B 先补发 `reclaim_confirm`，再重新委托。
- 排队中、等 owner 中的委托被 B 撤回时，没有 A 卡要停，直接转 `closed`。
- 分支由 `delegationId` 推出，每份委托各不相同，跨委托也永不复用（P2 §2.2）。

第 5 条是 A 侧防越权的关键：**项目没配 `mergeHandoff` 的，一律不接。** 这样 A 的调度器对这张卡根本不会排合并意图，不会更新分支，也不会部署（`merge-handoff.md:72-77`），合并权在机制上留在 B。

**第 2 条的授权（已冻结，P2 授权稿）**：
- 形式：authorize ask，`bind.action = "e2b_standing_inbound"`，params 就是 P2 授权稿 §2 的字段（去掉 id、rev、askId、bindHash）。
- 谁能签：只有 A 的 owner 本人在全权设备上点同意才生效。PM、master、peer、guest 都不能签，也不能代签；生效前要过 `ledger ask-check`。
- 期限：`expiresAt` 从签发起最长 7 天，到期要重签，不自动续。
- 改名：不沿用 `peer_accept_standing` 这个名字（P2 授权稿 §7）。现状是代码里只有逐卡的 `peer_accept`（`src/manager/peer-ledger-cli.ts:14-24`）。
- 管辖范围：授权只管接单这一刻（P2 授权稿 §4、§5）。接单记录写上那份授权的 `id` 和 `rev`。到期或普通撤销后不再接新单，已经在途的委托照常推进到收回。在途委托只有两种情况会再碰授权：
  - owner 主动选「撤销并收回在途」：A 发 `return_request`，走 §6（P2 授权稿 §5）。这是唯一会因为授权变化而停下在途委托的路；
  - 规格更新：拿**接单时记下的那份授权**的 `excludeSurfaces` 和范围去评估新规格，不重核授权当前是否过期、是否被普通撤销（§3.3）。

### 2.3 接不下来怎么办

接单回执由 A 用实例签名，签 `{delegationId, epoch, dir, seq, sha256, outcome}`（P2 §2.4）。`outcome` 取下面几种：

- `accepted`：落卡，进 §3。
- `queued`：名额满或额度紧（第 3、6 条）。在 A 侧排队，不占名额；有空位时按 §2.2 的「排队补位」处理，结果用 `admission` 回写。排队期间 B 可以撤回。
- `needs_owner`：没有合格的入站常设授权（第 2 条）。A 在自家 owner 频道发一张逐卡 authorize，问「这一张接不接」，和 T46 同一套（`peer-delegation.md` 流程第 2 步）。
  - owner 点同意：再核第 3、6 条，有名额就建卡，回写 `admission{outcome: accepted}`；没有名额就转 `queued`。
  - owner 不同意：回写 `admission{outcome: rejected:owner_declined}`。
  - 24 小时没人答：回写 `admission{outcome: rejected:owner_timeout}`。
- `rejected`：带原因码（见上表最后一列，包括 `queue_full`）。拒单不落 A 卡，只记一条接收日志，这样 B 重发同一个 `delegationId` 时能拿到同一张回执。

A 侧的接单接口必须幂等：同一个 `delegationId`、同样的内容摘要，重发拿回原回执；同一个 `delegationId` 换了内容，返回 409。

## 3. 本机推进

### 3.1 卡号映射

- **映射是查表，不是现算。** 委托表 `e2b_delegations` 对 `(bKey, bTask, delegationId)` 建唯一索引，记下当时分配的 A 卡号。接单、补发、规格追加都**先按这三项查表**，查到就用表里的卡号；只有第一次接单才分配新卡号。这样映射一经分配就固定。反查（A 卡号 → bKey + bTask）也只读这张表，不从卡号字符串里拆。这张三元表只用来追溯历史；「同一张 B 卡同时只能有一份」由 §2.2 第 9 条的部分唯一索引管。
- **分配规则**（确定性，按顺序取第一个可用的；P2 §2.2 冻结时把指纹改成了完整 key id）。本机卡号规则是 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$`，最长 60 字符（`src/lib/dag-tools-start.ts:94`）；B 侧卡号最长可到 64 字符（`src/lib/order-wire.ts:80`），所以要处理超长：
  1. 可读形式 `E2-<fp8>-<bTask>`：`fp8` 是 B 完整 key id 的前 8 位 hex。用 8 位而不用 4 位，是为了少撞；4 位只够做分支名后缀（`remote-capacity.md:172`），不够做卡号。条件是整串满足本机规则（≤ 60 字符），而且本机还没有同名卡。
  2. 哈希形式 `E2-<fp8>-h<sha256("<bKey>:<bTask>:<delegationId>") 前 16 位 hex>`，固定 29 个字符（3 + 8 + 2 + 16），和 B 卡号多长无关。以下情况用它：B 卡号太长（加上前缀超 60 字符）、含本机不收的字符，或者可读形式已经被别的映射占了（`fp8` 撞了、本机恰好有同名卡，或者同一张 B 卡第二次委托过来，见下一条）。
  3. 哈希形式也被占用：实际不会发生，但要有结果。拒单，回执 `rejected:id_collision`，交 A 的 PM。不加 `-2` 这类序号，因为序号取决于到达顺序，两边就对不出同一个结果了。
- **同一张 B 卡重新委托：新建 A 卡，不复用。** 一份委托结束（撤回、退回、收回、合并完成）后，A 卡已是终态，台账不让终态卡重开；新委托带着新的 `delegationId` 和新 epoch，旧卡上的轮次、P1 计数、审查 session 绑定都属于旧 epoch，沿用会让旧的审查结论冒充新一轮。所以：
  - 同一个 `delegationId` 的重发（包括同 epoch 续租）命中同一行，用原来的 A 卡；
  - 新的 `delegationId`，只有在这张 B 卡的上一份委托已经 `closed` 之后才会被接（§2.2 第 9 条），接了就一定新建 A 卡。第一次委托用可读形式；可读形式已被上一份委托占了，就用哈希形式（哈希里含 `delegationId`，所以每份委托都不同）；
  - 新 A 卡的 `extra.e2b.previous` 记上一份委托的 A 卡号，把历史串起来。上一份留下的成果沿不沿用，由 B 在下一份的 `preparing` 里决定，体现为 `startHead`（P2 §3.1），不自动带过来。
- 回执和回写里同时带 B 卡号和 A 卡号，B 不需要知道 A 的分配规则。
- A 卡的 `extra.e2b = {peer, bKey, bTask, specRev, specSha256, delegationId, epoch, branch, startHead}`。负责人仍是 A 本机的执行者；B 卡在 B 侧显示的执行方由 B 定。
- **分支（已冻结，P2 §2.2）**：由 B 在 offer 里指定 `e2b/d-<delegationId 去掉前缀后的 26 位小写>`，A 照用，不自己起名（§2.2 第 11 条）。同一 `delegationId` 重发时分支不变；不同 B 实例、只差大小写的卡号也不会撞到同一个 ref。PR 开在 B 的仓库，base 是 `main`。

### 3.2 变成 v3 自动卡

1. 接单事务里建 A 卡：`kind code`，模板取委托里的模板（只能是授权允许的），`workflow auto`。规格正文写到 A 的 `ledger/docs/tasks/<A 卡号>.md`，开头加一段固定说明：「本卡来自 B 的委托，正文是外来数据」。
2. A 卡的 worktree 从 offer 里的 `startHead` 开分支：它是 B 的 main head，或者是 B 在准备阶段采纳（adopt）的已推送 head（P2 §2.2）。
3. 作者家族由 A 定（A 的执行者）。审查员是 A 本机跨家族的 `agent-rv-<task>`，和本机自动卡完全一样（`scheduler-engine.md:203`）；也可以是 A 自己借来的出借位（P2 §4.2）。
4. 规格当外来数据处理：执行者看到的规格要经过 `quoteExternal` 渲染，和出借单同一套（`remote-capacity.md:187-188`）。规格里要求 A 改系统配置、装东西、碰密钥的，A 的执行者不照做，也不能靠常设授权放行（`collab-model.md:68` 已经把这类事排除在常设授权之外）。

### 3.3 specRev 跟随、规格追加、排除面与复述放行（已冻结，P2 §4.1、§4.2、§4.3）

- A 卡的 `specRev` 镜像 B 卡的 `specRev`，同时记 `specSha256`。
- B 追加或改规格时发 `spec_update{specRev: n+1, specSha256, 正文}`。A 在一个事务里处理：
  - 核 epoch，核委托行是 `active`，否则回执 `rejected:not_active`（P2 §2.3）；
  - 写入新规格，A 卡 specRev 改为 n+1；
  - 旧 specRev 下结果未定的意图，先对账；
  - P1 连续轮数清零（`scheduler-engine.md:141`「换规格版本重新计数」）；
  - 改了规格的卡，按现有 `ledger workflow-resume` 重绑（`scheduler-engine.md:204` ③）。
- **改规格时怎么核**：重核 §2.2 第 4、7、8 条，再拿**接单时那份授权**（委托行记着它的 `id` 和 `rev`）评估新规格。
  - 只核新规格：碰没碰到那份授权的 `excludeSurfaces`，在不在它的范围里。第 4、7 条用到授权的部分（templates、repos 白名单），也拿这份授权来比。
  - **不重核**授权当前是否过期、是否被普通撤销。授权只管接单那一刻（P2 授权稿 §4、§5），在途的卡不能因为授权自然到期，就在下一次规格更新时被卡住。owner 想停下在途的，走「撤销并收回在途」（§2.2 第 2 条的管辖范围）。
  - 为什么要拿接单授权评估新规格：只核第 4、7、8 条的话，B 可以先用普通规格拿到授权，再用 `spec_update` 把排除面的需求加进来。

  评估结果分三种：
  - **都通过**：照常写入新规格，继续自动推进。授权已经到期或被普通撤销的，也一样。
  - **第 4、7、8 条不过**（规格不合格，或模板、仓库不在接单授权里）：按新委托处理，回执 `rejected:<码>`，规格不写入，A 卡照旧。
  - **新规格碰到接单授权的 `excludeSurfaces`，或超出它的范围**：A 照写新规格，好让 specRev 和 B 对齐，但**暂停自动推进**：
    1. A 卡转 manual；
    2. 回写 B 一条 `fallback`，原因码 `surface_excluded`；
    3. 回执 `needs_owner`；
    4. A 在 owner 频道发一张逐卡 authorize，问「这份规格超出了常设授权的范围，这张卡还接不接」。owner 同意，系统把 A 卡恢复成 auto；owner 不同意或 24 小时没人答，A 的 PM 发 `return_request`，走 §6。
  - 这个口径由 §12 第 1 条提出，P2 第 3 轮已采纳（按收窄后的口径：只用接单授权评估新规格，不重核有效期和普通撤销）。
- **推进中改动碰到 `excludeSurfaces`**（规格没变，是 A 的作者改动碰到的；P2 §4.1 末段、P2 授权稿 §4）：A 卡转 manual，回写 B 一条 `fallback`（`surface_excluded`），由 A 的 PM 决定是收窄改动后继续，还是发 `return_request`；委托本身不自动停。交接时 B 还会按外发授权的 `excludeSurfaces` 把整份改动再核一遍（P2 §6.2 第 6 条）。
- 委托行不是 `active` 时收到 `reopen`，同样回执 `rejected:not_active`。
- **复述放行**：复述（包括规格改动后的重新复述）由 **A 侧 PM** 用 `ledger restate-approve` 放行，同时把复述正文回写 B（P2 §11 冻结为这一选项）。B 不同意时用 `spec_update` 或 `revoke` 纠正，不要求每次都跨实例等一轮。

### 3.4 「同一时刻只有一个调度器推进」：唯一委托、epoch 与 A 侧状态机

规则：**B 签发 epoch，A 持有 epoch，A 的每一次效果都带着 epoch。** 几件事各有分工：

- **A 本机的唯一性由 §2.2 第 9 条保证。** 同一张 B 卡在 A 侧最多只有一份没关闭的委托：重复委托（比如 B 重试时换了 `delegationId`）和并发委托，都在接单事务里被拒，回执 `already_delegated`，不排队、不补位。
- **epoch 只负责跨两端区分新旧。** 旧 epoch 的业务效果在两端都不算数。epoch 只由 B 增，而且只在正式收回或新委托时增（P2 §2.2）；A 永远不自己增，也不复用旧值。
- **B 侧交出前先静止、交出后不推进。** B 在 `preparing` 里核清本卡在途的意图、会话、出借单、合并运行和未推送的提交，核清了才发 offer（P2 §3.1）。委托期间 B 卡在 `delegated` 模式：B 的规划器不排意图，B 侧所有会推进卡的写口一律拒（`card_delegated`）；只有收下有效交接后，B 的审查、合并、部署写口才按 CAS 放开（`delegated/handed`）。A 接单时核 offer 里的 `observing`、`bWorkflowRev`、`quiesceSeq`（§2.2 第 10 条）。
- **A 的 PM 手推也过业务闸**（P2 §3.2 第 1 条）：委托不在 `active` 时，PM 手工推卡同样不产生效果。

**A 侧状态机（已冻结，P2 §3.2）**：委托表 `e2b_delegations` 一份委托一行。

| A 委托行状态 | 进入条件 | 占名额 | A 卡 | 业务效果 / 生成新的业务回写 | 发积压的业务回写 | 发控制消息 |
|---|---|---|---|---|---|---|
| `queued` | 接单检查第 3 或第 6 条没过；或 owner 同意后没有名额 | 否（另有排队上限） | 还没建 | 只有补位事务里的 `admission` | — | 只发接单回执 |
| `needs_owner` | 第 2 条没过，等 A owner 逐卡 authorize | 否 | 还没建 | 只有 owner 答复后的 `admission` | — | 只发接单回执 |
| `active` | 接单通过、补位通过，或同 epoch 续租拿到 `renew_ack` | 是 | v3 auto 卡在推进；交接后停在 merge 等待（§4.6） | 可以；交接后只等不推 | 可以 | `renew_request`、`return_request`、对 `revoke` 的应答、`handoff_withdraw` |
| `stopping` | B 发 `revoke`、A 发 `return_request`、租约过期，或 B 回了 `stale_epoch` / `not_delegated` | 是 | 按起因分（§6.3）：撤回或退回的，发出 `stop_confirm` 后转 `cancelled`；租约过期的，暂停在原阶段（manual，`e2b_paused`） | 不可以 | 可以，只限 `aSeq` ≤ 停止时刻的 | `stop_confirm`（包括部分停止的，可以用新 aSeq 重发）、`return_request`、`handoff_withdraw`；A 卡暂停（非终态）时还可以发 `renew_request` |
| `stopped` | 已发出合格的 `stop_confirm`（`notStopped` 为空、`orders[]` 全部终结），等 B 的 `reclaim_confirm` 或 `renew_ack` | 是 | `cancelled`，或者仍暂停（同上） | 不可以 | 可以（补发） | 重发 `stop_confirm`；A 卡暂停时还可以发 `renew_request` |
| `closed` | 收到 `reclaim_confirm`；收到 `complete` 并核实通过；补位或 owner 授权没通过；排队中、等 owner 中被撤回 | 否（释放） | 终态：`cancelled`，或 MHO1 的交回完成态；没建卡的就没有 | 不可以 | 只作迟到历史 | 只作迟到历史 |

**两套闸（已冻结，P2 §3.3）**：

- **业务闸**：紧贴效果，在同一个事务里核三件事：委托行是 `active`、epoch 没变、租约没过期。核的位置照 T68h 的做法（`scheduler-engine.md:204` ①）。它管的效果：派单、建会话、推分支、`deliver`、生成 handoff、生成新的业务回写。
- **控制闸**：管控制消息和积压回写。只核签名有效、epoch 曾由 B 为这份委托签发过、消息类型在白名单里。停止之后照收照发，只入历史和对账，不改变阶段。
- 闸在「生成回写」那一刻核；outbox 发送时不再核 `active`，只核 epoch 属于这份委托。所以停下之前已经写进 outbox 的回写，照样能送达。

B 侧各状态收什么，已在 P2 §3.1、§3.3 冻结，本稿不另列。

理由：如果靠租约到期自动换手，断网时两边都会以为自己在推进。改用 epoch 加「收回前先核清」，代价是断网时卡会停住，但不会出现两端同时推进。这就是 Shawn 要求的那条修正，见 §6。

## 4. 回执与回写（A → B）

### 4.1 回写哪些事件

| A 侧事件 | 回写内容 | 不回写 |
|---|---|---|
| 接单结果 | `accepted / queued / needs_owner / rejected` + 原因 | — |
| 补位或 owner 答复的结果 | `admission{outcome}`（§2.2、§2.3） | — |
| 复述 | 复述正文（已脱敏） | A 的规格文件路径 |
| 阶段变化 | `from / to / round / specRev` | 触发它的本机意图 id |
| 交付 | 完整 head SHA、分支、PR 链接 | worktree 路径 |
| 每轮审查结论 | `verdict`、P0 / P1 / P2 计数、`findings[]`（findingId、family、severity、脱敏后的描述）、审查员身份声明 | 报告原文的本机路径；原文按 §5 放进证据包 |
| 关闭证据 | 每条 finding 的关闭方式和对应 head | — |
| blocked / 解除 | 原因的一句话 | — |
| 退回人工（fallback） | 原因码（比如 `surface_excluded`）+ 一句话 | PM 之间的对话 |
| 交回 | `handoff` + HandoffEvidence（P2 §6.1） | — |
| 撤回交接 | `handoff_withdraw{head, reason}`：卡离开 merge、A 本地出现 P1、CI 红、主动退回、收到 `revoke` 时发（P2 §6.4） | — |
| 停止确认、在途成果清单 | 见 §6 | — |

白名单的思路和 `peer-ledger` 的时间线白名单一样（`peer-delegation.md:99-100`）：只回写对 B 的推进判断有用的字段，A 的本机路径、owner 原话、session 记录都不出机器。出机器前统一过 `redactPeerPr` 那一套脱敏和密钥闸（`peer-pr-auto.md:47-55`）；没过就不发，也不截断了发。

### 4.2 幂等与排序（已冻结，P2 §2.4）

- **去重键**：业务消息 `e2b:<delegationId>:<epoch>:<dir>:<seq>`（A→B 的 seq 就是 `aSeq`，A 卡事件的本机序号，单调增）；控制消息 `e2b:<delegationId>:<epoch>:ctl:<type>:<seq>`。非委托的 MHO1 登记没有 epoch，用 `mho:<registrationId>:<dir>:<seq>` 和 `mho:<registrationId>:ctl:<type>:<seq>`。
- **排序**：收方按 seq 顺序收；有缺口回 `gap{expect}`，发方从缺口那条起补发。
- **冲突**：同一个键、同样的内容摘要，重发拿回原回执；同一个键换了内容，返回 409，冻结这份委托、交给收方的 PM，不自动重编号。
- **回执**：由收方实例签 `{delegationId, epoch, dir, seq, sha256, outcome}`，A 验签后才把这条标成已送达。这和出借回执是同一个模式（`remote-capacity.md:226`）。

### 4.3 断网、重启后补发

- A 侧用 outbox：一条回写一行，状态 `claimed → sent | failed | refused | abandoned`，先写 outbox 再发。重试从 30 秒退避到 10 分钟，和 peer-pr-auto 的推送语义一致（`peer-pr-auto.md:57-64`）。重启后扫一遍 outbox，从最小的未确认 `aSeq` 起重发。
- 断网期间，在租约还有效时，A 的本机推进**照常进行**（这是 A 自己的活），回写只是排在 outbox 里。例外：**交回（handoff）要等 outbox 清空**，也就是 B 已经收到交回之前的全部历史，才把 PR 和证据交过去。理由：B 做合并判断时不能缺审查轮次。
- outbox 有未确认的回写超过 15 分钟，提醒 A 的 PM 一次；租约到期仍没续上，按 §6.2 的租约过期处理。

### 4.4 B 拒收

| B 返回 | A 怎么办 |
|---|---|
| `stale_epoch` / `not_delegated` | 当作 B 已经撤回或收回：立刻停掉这张卡的所有新效果，进 §6.1 的停止流程。停止确认和积压回写走控制闸照常发给 B，B 收下只入历史 |
| `gap{expect}` | 从 `expect` 起补发 |
| 409（同键不同内容） | 冻结卡，交 A 的 PM；不自动重编号 |
| `schema` / `invalid` | 这一条标 `refused`，卡退回人工，通知 A 的 PM；后续回写暂停，免得 B 在缺一条的状态上继续收 |
| 网络错误 / 5xx | 重试（§4.3） |

**不允许静默丢弃。** 回写失败只能有三种结果：重试、冻结、退回人工。

### 4.5 交回之后 B 要求修改（已冻结，P2 §2.3 `reopen`、§3.1、§11）

今天的 mergeHandoff 在交回之后，只要 PR head 的变化不是「纯合入 main」，就把卡交给 PM（`merge-handoff.md:28-36`）。E2b 新增一条路：B 审完提出修改时，先停掉自己的合并效果、对账在途，从 `handed` 退回 `delegated`，再发 `reopen{findings[], B 当前的 PR head}`（P2 §3.1）。

A 的处理：
1. 核委托行是 `active`，否则回执 `rejected:not_active`。
2. 把卡从 merge 退回 fix；卡离开 merge 时发 `handoff_withdraw`（P2 §6.4）。
3. **从 B 带来的 PR head 起修**：这个 head 可能含有 B 的 update-branch 合并提交，A 先把 worktree 对齐到它，再开新一轮。
4. B 的修改意见记成 A 卡上的一轮审查：findingId 沿用，同类 P1 的轮数接着计。
5. A 的执行者修，A 的审查员复审，修完重新 handoff。

### 4.6 交接之后：等待与正常结束（已冻结，P2 §3.1 handed、§3.2 第 4 条、§6.8）

- **只等不推。** handoff 被 B 收下（回执 `handoff_received` 且资格裁决通过）之后，A 卡停在 merge 等待，也就是 MHO1 的 merge 等待态：
  - 规划器对这张卡不排任何意图；
  - A 不向分支推送。推送了就是 head 漂移，交接失效（P2 §8 第 12 行）；
  - A 这时只发控制消息：`handoff_withdraw`、`renew_request`、`return_request`。
- **收到 `reopen`**：按 §4.5 退回 fix。
- **收到 `complete{mergeSha, prHead, mergedAt}`**：A 先只读核实三件事：PR 状态是 merged；合并提交等于 `mergeSha`；PR head 等于 `prHead`。
  - 核实通过：委托行转 `closed`（completed），释放 §2.2 第 3 条的名额，触发排队补位；A 卡结束，进 MHO1 的交回完成态；清理 worktree。分支在 B 仓库里，由 B 按自己的规矩处理。
  - 核实不通过（PR 没合并、SHA 对不上）：A 不关闭，回执 `rejected:<码>`，交 A 的 PM；B 的 PM 收到后去对账。
- handed 期间 A 的租约过期：§12 第 3 条提出的问题，P2 第 3 轮已采纳，写法以 P2 第 3 轮为准。A 侧倾向是 handed 下 B 对 `renew_request` 照回 `renew_ack`。

### 4.7 非委托的 MHO1 自动卡（A 自己开的卡，已冻结，P2 §6.7）

这类卡是 A 在自己台账上开的（项目 `mergeHandoff: true`），PR 开在 B 仓库；没有委托、没有 epoch，B 不交出任何推进权。P2 只冻结它的交接资格：让 A 的撤回和本地 P1 能拦住 B 的收审。实现归 E2B-A3，本稿写 A 侧要做的事。

1. **登记**：A 的调度器在开 PR 之前（最晚在第一次 handoff 之前）发 `mho_register{registrationId, aTask, repo, branch, specRev, specSha256, template}`。
   - 拿到 `registered`：照常开 PR。从这以后，这个分支的 PR 在 B 侧是 `mho_pending`，要等有效 handoff 才收审。
   - 拿到 `rejected:<码>`（包括 B 的收审开关关着时的 `rejected:not_configured`）：照现在的 MHO1 做法开 PR，B 照旧走普通收审；通知 A 的 PM 一次。
   - B 一直联系不上：不开 PR，按 outbox 重试；超过 15 分钟提醒 A 的 PM。
   - A 改了规格：用同一个 `registrationId`、新的 aSeq 重发 `mho_register`，更新 specRev 和 specSha256。
2. **交接**：流程和委托卡相同。HandoffEvidence 用 MHO1 v1 的字段，加 `aKey`、`registrationId`、`aTask`，不带 `delegation`。B 照旧完整审查，交接资格不是 PASS，也不是互认。
3. **撤回**：和 §4.1 的 `handoff_withdraw` 一样，带 `registrationId`。卡离开 merge、本地出现 P1、CI 红、主动退回时发。A 的本地 P1 不会被 B 的旧 PASS 盖掉。
4. **结束**：收到 `complete{registrationId, …}`，A 按 §4.6 只读核实之后，A 卡结束，登记关闭。PR 没合并就被关闭的，登记关闭，记一条事件。
5. **迁移**：B 打开 `e2b.handoffIntake` 时，A 给已经开着的 MHO1 自动卡 PR 补发 `mho_register`；被回 `rejected:already_merged` 的，什么也不做。
6. 去重键用 `mho:<registrationId>:…`（§4.2）。`registrationId` 由 A 生成，格式是 `mho_` + 26 位随机 base32，全局唯一、不复用（§12 第 4 条，P2 第 3 轮已采纳）。

## 5. 证据导出（交给 R1）

**已冻结（P2 §6.1、§11）**：
- 证据包另起新版本，身份、来源、探针、哈希这些字段由 R1 定。
- handoff 只引用 R1 证据包的 `bundleId` 和 manifest sha256。
- 签名用途 `e2b` 已由 P2 §2.1 批准。

下面这张表是 A 侧交给 R1 的输入，最终字段以 R1 为准。

基础是现有的 `ledger review-export` v1（`src/manager/ledger-review-export-cmd.ts:39-44`）。它的 manifest 已经有：`format / version / bundleId`、`origin.instanceFingerprint`、`subject{repo, pr, head, base, specRev, taskId}`、`scope`、`authors`、`rounds`、`closuresArtifact`、`final`、`artifacts`（`src/lib/review-evidence.ts:224-231`）。

| 字段 | 内容 | 理由 |
|---|---|---|
| `delegation` | `{delegationId, epoch, bTask, specRev, specSha256}`；非委托的 MHO1 卡换成 `registrationId` + `aTask` | 让 B 能核：证据对应的就是自己发出的那份规格 |
| `rounds[].reviewer.verification` | 审查员身份是怎么核的，取值三种：`mcp_bound_session`（结论经 MCP 从绑定 session 写入，即 `d.via === "mcp"`，`review-evidence.ts:162-163`）、`registry_runtime`（registry 当前 session 和 runtime 家族对得上，`scheduler-engine.md:203`）、`claim_only`（只有声明） | 现在只有一个 `verified` 布尔值，B 看不出是哪种核法 |
| `rounds[].reviewer.instance` | A 的完整 key id；审查单借给第三台时是那台的完整 key id | 审查员身份是「哪台机器上的哪个 session、哪个家族」 |
| `pinned` | `{head, base, specRev}`，以及 base 的来源（`baseSource`） | 证据只对这一组固定值有效 |
| `rounds[].findings` + `closures` | 沿用 v1 的 closures.json | v1 已经有 |
| `rounds[].probes[]` | 每个探针的来源（审查员写的 / 规格给的）、文件名、sha256 | v1 只记 probe-source 文件和哈希，没记来源 |
| `carries[]` | 交回之后 head 每一跳的 `{from, to, mainParent, diffHash, basis}` | 只是 A 的声明，B 会自己重算（见下） |
| `surfaces[]` | 改动碰到了哪些「B 必须完整再审」的面（§7）：`{surface, paths[], ruleSource}` | 让 B 一眼看出哪些部分不能只做证据核对 |
| `signature` | A 用实例钥匙签 manifest 的 sha256 | B 只能验「这包出自 A 这台机器」，验不了 A 内部 |

**head 变了，证据就失效（已冻结，P2 §6.5）**：
- 证据绑定 `pinned.head`，head 一换，旧证据作废。
- 唯一例外是「纯合入 main」。这时以 B 的规范算法 `reviewMainCarryProof`（`src/lib/review-main-carry-proof.ts:174`：完整净 diff、main 来源、最多 16 跳）为准，由 B 重算并记录继承链。
- A 的 `carries[]` 和 body 里的 `carry=true` 都只是声明，B 不信。
- 有实质改动的，必须重新 handoff，并且要有当前 head 自己的 CI 结果。

诚实的边界：
- 对 B 来说，A 记的 `verified` 仍然只是 A 的声明，B 能核的只有 A 实例的签名。这和出借结论里「家族只算自称」是同一回事（`remote-capacity.md:151-154`）。
- 「审查员不是作者」在 A 本机是真校验，过了实例边界就只能凭 A 的声明（`collab-model.md:56`）。
- B 收下交接只表示 B 有了「交接资格」，不等于 PASS，不等于互认，也不等于合并许可（P2 §6.2）。

## 6. 撤回、退回与收回

三种情况共用一个**停止流程**，区别只在谁发起（P2 §5.1）。

### 6.1 停止流程（A 侧要做的，已冻结，P2 §5.2）

1. **先停新效果**：同一事务里把委托行改成 `stopping`。从这一刻起，业务闸对这张卡一律不放行：不派新单、不建 session、不推分支、不交付、不交回，A 的 PM 手推也一样。还没结清的 pending 意图取消，submitted 意图照常对账。
2. **让在途的会话停下**：给执行者和审查员 session 发停止消息，等它们停下。判据是 session 已退出，或者被 kill 后确认进程不在。停不下来的，记进 `notStopped`。
3. **结清本委托开过的全部订单**，逐条写进 `orders[]`：
   - 每条写明 orderId、执行地（本机，或 peer 的完整 key id）、领单来源（claim / worker）、终结方式、回执摘要；
   - 本机订单（作者、审查、收敛）：对应 session 已退出，订单已结清或已撤回；
   - A 借给第三台机器 C 的出借单（比如审查单）：要有 C 签名的 release / cancel 回执，或者按出借协议收回、拿到 C 的停止证据；
   - C 离线、回执拿不到、停止状态不明的，这张单进 `notStopped`；
   - 审查单的执行者没有写权限，也照样要结清，因为它的结论会推动阶段。
4. **出在途成果清单**（提案命令 `ledger e2b-stop-report <A 卡号>`，只读），列这些：
   - 分支名、origin 上的最新 head（A 自己 `git ls-remote` 核过）、本地有没有没推的提交；
   - PR 链接和状态；
   - 结果未定的外部效果。每个外部写效果在执行前都登记了 `operationId`；这里按 P2 §5.5 只读核实（推分支看 `git ls-remote`，开 PR 用 `gh pr list --head`，handoff 看 B 有没有回执），核不清的列进 `unknownEffects`，不重做；
   - outbox 里还没确认的回写；
   - 写完还没回写的审查报告。
5. **发停止确认**：`stop_confirm{stoppedAt, lastSeq, sessions[], orders[], notStopped[], unknownEffects[], artifacts[]}`，用 A 的实例签名，经 outbox 发出。
   - 这是控制消息，不受业务闸限制，委托已经是 `stopping` 也照样能发。
   - `lastSeq` 是停止前最后一条业务回写的 `aSeq`，B 据此判断积压收齐没有。
   - `notStopped` 不为空时，只算「部分停止」，委托行留在 `stopping`，不能作为 B 正式收回的依据（§6.3）。
   - 之后停下了剩下的会话、补齐了订单回执、核清了 unknown，就用**新的 aSeq 重发一份完整的 `stop_confirm`**，B 以 aSeq 最大、验签通过的那一份为准（P2 §5.3）。合格的一份发出后，委托行转 `stopped`。
6. **A 卡按起因处理**（§6.3）：撤回或退回的，转 `cancelled`；租约过期的，暂停。两种都保留现场：worktree 和分支要等收到 `reclaim_confirm` 或 `complete` 才清理（P2 §3.2 第 3 条）。

### 6.2 三种情况

- **B 撤回**：B 发 `revoke`，A 应答 `stopping`，然后走 6.1。之后 B 核对清单、增 epoch，发 `reclaim_confirm`。
- **A 退回**：由 A 的 PM 或 owner 主动退回；或者 A 自己推不动了，比如 P1 到了安全阀、退回人工后 A 的 PM 也推不动、额度长期不足、规格碰到排除面而 owner 不同意（§3.3）。A 先发 `return_request{reason}`，再走 6.1。退回要 B 确认才算结束，A 不能单方面宣布。
- **租约过期**（已冻结，P2 §4.4）：A 每 60 秒发 `renew_request`，B 回 `renew_ack`，租期 10 分钟。这些数值进双方配置，只能在 B 侧最大值以内调。**按 Shawn 的要求，过期不能自动把写权还给 B：**
  - **A 侧**：到了租约截止仍没续上，A 自己执行 6.1 的第 1、2 步，停掉旧 epoch 的一切新效果，A 卡暂停（§6.3），保留现场和 journal。这和出借方「到租约截止仍没续上就自停 worker，保留工作副本和 journal」是同一个做法（`remote-capacity.md:221`）。恢复联系后，先补发积压回写和 `stop_confirm`，再按 §6.3 续租。
  - **B 侧**：租约过期只说明「联系不上 A」，不说明 A 已经停了。B 一律进 `stopping`（不进 `frozen`），**没有超时**：不再接受旧 epoch 的业务写入，自己也不发出新指令，但照收控制消息和积压回写，然后等 A 的停止确认。这和共享台账 V2「超时不自动换主场」是一个思路（`shared-ledger.md:210-211`）。
  - 还没核清的 unknown 继续占着资源，不因为租约到期就解锁重试。

### 6.3 停止证据、正式收回与 A 卡去向（已冻结，P2 §3.2、§4.4、§5.3、§5.4）

**停止证据**只有一种：A 签名的 `stop_confirm`，并且同时满足：
- `notStopped` 为空；
- `orders[]` 每一条都已终结、带回执摘要，并且列全了 A 台账上本委托开过的全部订单。B 会拿回写里出现过的交付、审查来源（订单号、执行地）交叉核对：回写里有、清单里没有的，整份不合格；
- 积压回写连续收到了 `lastSeq`。

下面这些都**不算**停止证据：GitHub 上没有新推送（`gh pr view`、`git ls-remote`）、agent 界面空闲、租约过期、会话已退出、审查员没有写权限。原因是它们看不到 A 本地正在写、还没提交的改动，看不到进行中的 `git push`、借出去的订单，也看不到没回写的审查和其他未知效果。

1. **正式收回**需要同时满足：
   - B 有停止证据；
   - `unknownEffects` 和在途成果逐条有处置，每条只能是三种之一：`adopt`（采纳，写明 head）、`discard`（丢弃，写明理由）、`hold`（继续当 unknown 占着资源）。**只要有一条是 `hold`，就不能收回**；
   - B 侧在途的合并、部署、update-branch 都已结清。

   全部满足后，B 才增 epoch、转 `reclaimed`，发 `reclaim_confirm{newEpoch, disposition[]}`。A 收到后，委托行转 `closed`、释放名额，A 卡转 `cancelled`（之前还没转的），然后按处置清理现场。收回之前，同一张 B 卡的新 offer 两侧都会拦住。
2. **停止证据不合格时 B 进 `frozen`**：包括 A 报了 `notStopped` 非空、`orders[]` 缺单或回执对不上，以及出现 409。
   - 不超时、不自动收回；B 不在这张卡上开新的推进，旧 epoch 的资源继续占着。
   - 解冻只有一条路：A 用新的 aSeq 补发一份合格的 `stop_confirm`，B 收到后回到 `stopping`，再按第 1 条判断能不能收回。
   - `notStopped` 非空的，由 A 的 PM 或 owner 在 A 本机停掉那些 session（kill 后确认进程不在）、收回那些出借单，再重发。
3. **联系不上 A**：B 停在 `stopping` 一直等，不进 `frozen`，也不超时。
4. **冻结期间旧端的迟到效果**（比如旧 worker 推送成功）不另开处理。它发生在 epoch 加一之前，A 停下后出的清单（head 由 `git ls-remote` 核）会把它列进在途成果，B 按第 1 条逐条处置。
5. **强制收回：已冻结为 v1 不提供**（P2 §5.4、§11）。以后要的话另行立项，由 owner 批准。

**A 卡去向与同 epoch 续租**（已冻结，P2 §3.2 第 3 条、§4.4）：A 卡在停止流程里**按起因分**，不一律进终态。
- **起因是 B 的 `revoke` 或 A 的 `return_request`**：同 epoch 不可能恢复，A 卡在发出 `stop_confirm` 之后转终态 `cancelled`，A 不发 `renew_request`。之后只能等 `reclaim_confirm`，再由 B 重新委托、新建 A 卡（§3.1）。
- **起因是租约过期**：A 卡**暂停**，不进终态。
  - 暂停的样子：A 卡停在原阶段、原轮次，workflow 转 manual，原因码 `e2b_paused`。这期间 PM 手推也被业务闸挡住。
  - A 侧把「收到 `stale_epoch` / `not_delegated` 而进的停止」也按这一类处理：A 分不清 B 那边是租约过期还是已经收回，先暂停是安全的，之后收到 `reclaim_confirm` 照样转 `cancelled`。这一条由 §12 第 2 条提出，P2 第 3 轮已采纳。
- **续租流程**：
  1. A 先把积压回写和 `stop_confirm` 按控制闸发完，再发 `renew_request`。
  2. B 核对：B 卡仍在这个 epoch，委托没被撤回；B 状态是 `stopping`，而且起因只是租约过期（`frozen` 不能续租）；B 已按停止证据的要求核过这份 `stop_confirm`。
  3. B 回 `renew_ack` 之后，A 先对账未结意图，再由**系统**（不是 PM）把 A 卡恢复成 auto，从原阶段继续；委托行回到 `active`。在那之前，业务闸一直关着。
  4. B 不同意（回 `stale_epoch`）：A 卡保持暂停，不转终态。比如 B 因为停止证据不合格进了 `frozen`，A 补发合格的 `stop_confirm`、B 回到 `stopping` 之后，还能再申请续租。只有收到 `reclaim_confirm`，A 卡才转 `cancelled`。

## 7. 互认边界（已冻结：交给 R1，P2 §11）

P2 只规定了一点：交接资格不等于互认（P2 §6.2）。互认范围本身交给 R1。下面照原意抄录 Shawn 给的初步范围，供 R1 参考：

- **可以考虑「证据核对 + 抽查」的**：文档、隔离测试、叶模块、普通 UI。
- **B 侧保留独立完整审的**：身份 / 鉴权 / 权限、台账写入、授权租约、出借协议、调度合并部署、CI 闸、宿主 shell、密钥，以及 security 模板。
- head 变化原则上证据失效；但已有的 canonical 纯 main 净 diff 证明的沿用规则要保留（P2 §6.5）。
- 以上都是待定的设计边界，现有流程没有改。

A 侧要做的：导出证据时填 `surfaces[]`（§5），按文件路径标出这次改动碰到了上面哪一类「完整再审」面。
- **面的分类以 R1 为准。** B 可以在 offer 里带 `surfaceRules`（P2 §2.3），也就是一份 glob → 面的映射表，A 照着算。这和 peer-pr-auto「规则是数据」是同一个做法（`peer-pr-auto.md:38`，`src/lib/peer-pr-surface.ts`）。
- B 没给表时，A 用本机 `peer-pr-surface` 的规则，并在 `ruleSource` 里标明用的是 A 的规则。
- 读不出、或者改动超过 300 个文件，一律标成 security。
- A 的标注只是建议，B 会自己重算一遍；两边算得不一样，以 B 为准。
- 授权里的 `excludeSurfaces` 是另一回事，怎么处理见 §3.3：接单时核规格，规格更新时重核，推进中途改动碰到了就转人工。

## 8. 和现有机制的关系

- **出借单**：照用。A 推进 E2b 卡时，如果自己的槽满了，也可以把审查单挂到出借池，借第三台机器的位（`remote-capacity.md` §10）。这样证据里审查员的实例就是第三方，`verification` 记 `claim_only`。security 卡本来就不接。停止时借出去的单也要结清，拿到 C 的回执或停止证据，否则进 `notStopped`（§6.1 第 3 步）。
- **T46 委托卡**：照用，留给边界不清、需要人逐件拍板的活；E2b 只接规格写清楚、模板允许、在常设授权内的卡。逐卡的 `peer_accept` 也原样保留，不会升级成常设授权（P2 授权稿 §6、§7）。
- **共享台账 V2**：E2b 是 V2 落地之前点对点的做法。V2 落地后，E2b 的 epoch 和租约可以映射成中心上的 `scheduler_leases`：推进权临时迁到 A，合并权不迁。但 V2 写的是「出借不改主场」（`shared-ledger-v2.md:46`），而 E2b 改的恰恰是推进权，所以「推进权临时迁移」算不算换主场，要留给 V2 定（P2 §10）。
- **peer-pr-auto / mergeHandoff**：A 侧交回直接用现有的 mergeHandoff（`merge-handoff.md`）。证据放在 `HandoffEvidence` 预留的位置（`merge-handoff.md:100-102`），E2b 加的字段见 P2 §6.1。B 侧收 PR 的分类已冻结（P2 §6.3），只认 B 台账里的委托行和登记行：
  - 委托分支开的 PR，收到有效 handoff 才算 `e2b_handed`，挂到原 B 卡上；在那之前一律算 `e2b_pending`，不另开 `PR<n>` 卡；
  - A 自己开的 MHO1 卡，登记了的是 `mho_pending` / `mho_handed`（§4.7）；
  - 没登记的照旧收审。

  这些分类由 B 侧实现。
- **A 侧代码里退回人工的那一处**：`src/lib/worker-session.ts:116-117` 把 peer 委托退回 manual（注释写的是「until E2」）。E2b 不需要改它：A 推进的是本机卡，执行者都是本机 session，根本不走 peer 路由。

## 9. 双端推进与越权：A 侧逐条排查

| 路径 | 风险 | 怎么挡 |
|---|---|---|
| B 交出时自己还有在途的执行者、出借单或未推送的提交 | 双端推进 | B 在 `preparing` 里核清才发 offer（P2 §3.1）；A 核 offer 带了 `quiesceSeq`（§2.2 第 10 条） |
| B 的规划器仍在推 B 卡 | 双端推进 | B 卡在 `delegated` 模式，B 侧推进写口一律 `card_delegated`（P2 §3.1）；A 接单时核 `observing` 和 `bWorkflowRev`（§2.2 第 10 条） |
| B 的 PM 手推 B 卡阶段 | 双端推进 | 同上，由 B 实现；A 发来的业务回写带 epoch，B 收到时核 |
| B 对同一张卡发了两份委托（重试换了 `delegationId`、两个请求并发，或者第一份还在推进时又来一份） | A 本机两套调度同时推同一张 B 卡 | 接单事务按 `(bKey, bTask)` 只允许一份没关闭的委托，其余回执 `already_delegated`，不排队（§2.2 第 9 条、§3.4） |
| A 撤回或过期之后仍在推，或者 A 的 PM 手推暂停的卡 | 双端推进 | A 的业务闸核委托行状态 + epoch + 租约，PM 手推也过闸（§3.4）；失租就自停（§6.2） |
| A 卡已经 `cancelled` 又想续租 | 终态卡被重开，旧审查结论冒充新一轮 | 撤回或退回引起的停止直接转终态、不发 `renew_request`；只有租约过期暂停的卡能续租（§6.3） |
| 交接之后 A 还在推分支 | head 漂移，旧证据被拿去合并 | A 卡停在 merge 等待，不排意图、不推送，只发控制消息（§4.6） |
| 伪造的 `complete`，或者 PR 其实没合并 | A 提前释放名额、清掉现场 | 只读核实 merged、`mergeSha`、`prHead`，不通过就不关闭（§4.6） |
| A 重启后状态是旧的 | 旧 epoch 复活 | 委托行持久化；重启后先对账未结意图，再按现有对账规则继续 |
| 断网时两端都以为自己是推进方 | 双端推进 | 只有 B 能增 epoch，而且必须拿到停止证据才增；A 过期就自停；回到 `active` 要 B 的 `renew_ack`（§6.3） |
| 联系不上 A 时凭 GitHub 没有新推送就收回 | 旧 worker 迟到的推送和 B 的新推进叠在一起 | GitHub 静态观测不算停止证据，没有 A 的停止证据就一直等；E2b v1 不提供强制收回（§6.3） |
| A 借给第三台机器的单没结清就被收回 | 旧端的审查结论在收回后还在推动阶段 | `orders[]` 必须列全并且每条终结、带回执，B 交叉核对；拿不到就进 `notStopped`（§6.1、§6.3） |
| 停止确认被自己的业务闸挡住 | 两边互等，永远收不回 | 控制消息和积压回写走控制闸，B 在收回前后都照收、只入历史（§3.4，P2 §3.3） |
| 在 B 没指定的分支、或者已经存在的分支上写 | 越权 / 串卡 | §2.2 第 11 条，分支由 `delegationId` 推出且必须不存在，否则 `branch_conflict` |
| A 本机合并或部署 | 越权 | 接单时要求项目是 `mergeHandoff: true`；这种项目不排合并意图，配了 deploy 直接判配置无效（`merge-handoff.md:14-15`、`:72-77`） |
| B 通过规格让 A 做授权外的事 | 越权 | 规格是外来数据（§3.2），系统配置、安装、密钥类不在常设授权内 |
| B 先拿到授权，再用 `spec_update` 把排除面加进规格 | 越权 | 改规格时拿接单那份授权的 `excludeSurfaces` 评估新规格，碰到了就暂停自动推进，转逐卡授权或退回（§3.3） |
| 授权到期或被普通撤销后，在途卡的规格更新被要求重新授权 | 在途委托被授权变化卡住，违背「授权只管接单」 | 规格更新不重核授权当前的有效期和撤销状态；只有「撤销并收回在途」会停下在途委托（§2.2 第 2 条、§3.3） |
| B 把 security 卡塞给 A | 越权 / 审查降级 | §2.2 第 4 条一律拒；授权的 templates 里写了 security，整条授权不生效（P2 授权稿 §2） |
| B 抬高并发 | 越权 | 上限只取 A owner 签的授权，B 报的值不算（P2 授权稿 §6） |
| 换机器沿用同一个 peer 名 | 冒名 | 授权的 `peerKey` 是完整 key id；同名换实例当新主体，旧委托、旧授权都不继承（P2 §2.1） |
| 本机 agent 伪造 B 的回写 / 伪造 epoch | 伪造 | 和现有台账的身份边界相同：同一个 OS 用户下只能检测、不能防（`peer-delegation.md:143`、`scheduler-engine.md:142`）。B 收的写入只认经过 A bridge 签名的请求 |

## 10. 验收场景（以 P2 §8 为准）

验收线已冻结为 P2 §8 的 31 行，都在双实例沙箱里跑（出借 R5 用的 `--lab --pair`，`remote-capacity.md:259`），不碰生产。

本稿最早的 10 条已经并进 P2 §8：

| 原条目 | P2 §8 对应行 |
|---|---|
| 第 1 条 | 第 1 行 |
| 第 2 条 | 拆进第 22、3 行，以及下面的 A1、A2 |
| 第 3 条 | 第 11 行 |
| 第 4 条 | 第 4、5 行 |
| 第 5 条 | 第 7、6、15 行 |
| 第 6 条 | 第 4 行 |
| 第 7 条 | 第 21 行 |
| 第 8 条 | P2 表里没有，留作下面的 A4 |
| 第 9 条 | 第 27 行 |
| 第 10 条 | 第 5 行 |

A 侧要额外断言的几条，补充 P2 表里「预期 A」那一列：

- **A1 唯一委托（顺序到达，对齐 P2 §8 第 2 行）**：
  - `d1` 已经 `accepted`、正在推进，B 再发 `d2`（同一张 B 卡、新的 `delegationId`）：回执 `already_delegated`，附 `d1` 的 id 和状态；A 不排队，不建第二张卡。
  - `d1` 处在 `queued`、`needs_owner`、`stopping`、`stopped` 时，结果相同。注意 `queued` / `needs_owner` 不占名额，但照样算没关闭。
  - 收到 `d1` 的 `reclaim_confirm`、A 那一行转 `closed` 之后，再来 `d3`（epoch 更大，分支由它自己的 `delegationId` 推出），才新建 A 卡（哈希卡号）。
  - 并发到达的情形见 P2 第 3 行。
- **A2 接单检查的新码**：
  - offer 缺 `observing: true`、`bWorkflowRev` 或 `quiesceSeq` → `not_observing`；
  - `branch` 不是由 `delegationId` 推出的那个，或者这个分支已经存在 → `branch_conflict`；
  - `startHead` 取不到 → `start_head_missing`；
  - 名额满且排队也满（排队中已有 `maxConcurrent` 份）→ `rejected:queue_full`；
  - 没有入站常设授权 → `needs_owner`，24 小时没人答 → `admission{rejected:owner_timeout}`；
  - `e2b.inbound` 关着 → `not_configured`；开在 `observe` → `rejected:observe_only`。
- **A3 暂停与恢复（补 P2 第 4 行）**：
  - 租约过期暂停期间，PM 手推 A 卡：不派单、不推分支，业务闸拦下。
  - 拿到 `renew_ack` 后：先对账未结意图，再由系统恢复成 auto，A 卡从原阶段、原轮次继续，不新建卡。
  - 收到 `stale_epoch` 进的停止也暂停；续租被拒（`stale_epoch`）时仍然暂停，收到 `reclaim_confirm` 才转 `cancelled`。
  - 撤回引起的停止：A 卡发出 `stop_confirm` 后直接 `cancelled`，A 不发 `renew_request`。
- **A4 拒审换家族**：A 的审查员（比如 Codex）拒审，换成另一家（比如 Pi 审查员）。证据包里如实记录换了家族，以及每一轮审查员的 `verification`。
- **A5 `complete` 核实不通过**：B 发来的 `complete` 里 `mergeSha` 和 PR 实际的合并提交对不上，或者 PR 还没合并：A 不关闭委托行，不释放名额，不清现场，回执 `rejected`，交 A 的 PM。
- **A6 规格更新碰到排除面（补 P2 第 29 行）**：接单时那份入站授权 `excludeSurfaces=[鉴权]`；首次 offer 只改普通 UI，接单通过；随后 `spec_update` 加入登录鉴权的修改，模板、仓库、大小都不变。期望：
  - A 写入新规格，A 卡转 manual，回写 `fallback{surface_excluded}`，回执 `needs_owner`；
  - owner 同意前不派任何单；
  - owner 不同意 → A 发 `return_request`。
- **A7 授权到期后的普通规格更新（对应第 6 轮审查探针）**：A owner 签了 7 天的入站授权，day 1 接下一张普通 UI 卡；day 8 授权自然到期；B 发 `spec_update`，只追加一条验收描述，同仓库、同模板，没碰排除面。期望：
  - 回执 `applied`，A 卡 specRev 加一，**继续自动推进**；
  - 不转 manual，不回 `needs_owner`，不发逐卡 authorize；
  - 授权被普通撤销（不是「撤销并收回在途」）的，结果相同；
  - 同一时刻 B 再发一份新的 offer，会因为授权已到期回 `needs_owner`。授权只管接单。

## 11. 待对齐（现有文档 / 代码里发现的出入，本卡不改，只记在这里）

1. `docs/team/collab-model.md:68` 写了常设授权 `peer_accept_standing`，但代码里只有逐卡的 `peer_accept`（`src/manager/peer-ledger-cli.ts:14-24`）。P2 授权稿 §7 已定：不实现这个名字，改为 `e2b_standing_inbound` / `e2b_standing_outbound`；实现 E2B-S1 时同步改协作模型文档。
2. `docs/design/scheduler-engine.md:145` 描述的整卡委托方向是「A 委托给 B」；本稿和 P2 的方向都是 B（仓库方）→ A。两份稿子里 A / B 的指代相反，合并讨论时以 P2 的称呼为准。
3. 规格卡引用的 `src/lib/worker-session.ts:113-118`，实际是 111–115 行的注释加 116–117 行的函数；peer 退回人工在第 117 行。
4. `docs/architecture/merge-handoff.md:100-102` 写了「证据怎么到 owner 那边不在本卡范围」。P2 §6.1、§6.7 补上了这一段，实现时要回头更新这几行。
5. review-evidence v1 草案（在台账目录 `ledger/docs/review-evidence-v1/review-evidence-v1.md`，不在仓库里）写了「不新增加密用途、不做接收方导入」。按 P2 §11，新证据格式由 R1 另起版本，签名用途 `e2b` 由 P2 §2.1 批准；v1 草案本身不改。
6. `docs/design/shared-ledger-v2.md:46`「出借不改主场」和 E2b 的「推进权临时迁移」之间的关系，留给 V2 写清楚（P2 §10、本稿 §8）。
7. B 侧的 peer-pr-auto 收 PR 时会新建 `PR<n>` 卡（`peer-pr-auto.md:37`）。P2 §6.3 已定分类：委托分支的 PR 按 `e2b_handed` / `e2b_pending`，挂原 B 卡、不另开卡；登记过的 MHO1 PR 按 `mho_handed` / `mho_pending`；由 B 侧实现。
8. 旧端没确认停止时的「强制收回」：P2 §11 已冻结为 v1 不提供，以后要的话另行立项、由 owner 批准。上一版稿子提过的思路（B owner 签 authorize、epoch 加一、关旧 PR、换新分支、收回委托 token）留作那个议题的素材。它只能让旧端的效果不被采纳，停不了旧端，也挡不住有写权限的旧账号推到别的分支，所以不满足「先核清旧端已停再收回」。

## 12. 对 P2 的意见

本稿不替 P2 改协议；正文里凡是需要 A 侧先给个做法的，都标了「见 §12 第 n 条」。

**第 5 轮的 7 条已全部处理**（P2 §12.2）：
- 第 1 条：停止一律 cancelled 与续租冲突 → 已采纳（P2 §3.2 第 3 条）；
- 第 2 条：stopping / frozen 的进入条件重叠 → 已采纳（P2 §3.1、§4.4）；
- 第 3 条：缺正常结束路径 → 已采纳（P2 §6.8 `complete`）；
- 第 4 条：推进中碰到 excludeSurfaces → 已采纳（P2 §4.1 末段、§6.2 第 6 条）；
- 第 5 条：非 active 时收到 spec_update / reopen → 已采纳（P2 §2.3、§4.3 `rejected:not_active`）；
- 第 6 条：「为空」怎么判 → P2 换了做法，分支按 `delegationId` 唯一、要求不存在（P2 §4.1 第 11 条），本稿已跟；
- 第 7 条：hold 核清后用什么消息 → 已采纳（P2 §5.3）。

**第 6 轮（对 P2 第 2 轮 `b6526819`）的 5 条：已全部采纳（P2 第 3 轮）**。P2 第 3 轮推上去后再逐条核节号。
1. `spec_update` 要拿入站授权评估新规格 → 已采纳（P2 第 3 轮）。口径按第 7 轮收窄：只用**接单时那份授权**的 `excludeSurfaces` 和范围去评估新规格；不重核授权当前的有效期和普通撤销。碰到排除面时：A 照写规格，A 卡转 manual，回写 `fallback{surface_excluded}`，回执 `needs_owner`，走逐卡授权；owner 不同意或超时就 `return_request`（本稿 §3.3）。
2. 收到 `stale_epoch` / `not_delegated` 而进的停止，按租约过期处理，A 卡暂停 → 已采纳（P2 第 3 轮）。
3. handed 期间租约过期，A 回不了 `active`，`reopen` 会被拒 → 已采纳（P2 第 3 轮）。A 侧倾向 handed 下 B 照回 `renew_ack`，具体写法以 P2 第 3 轮为准。
4. `registrationId` 由 A 生成，格式是 `mho_` + 26 位随机 base32 → 已采纳（P2 第 3 轮）。
5. 登记生效时 PR 已在普通收审中，一律按迁移处理（`pm_hold`）→ 已采纳（P2 第 3 轮）。

目前没有新的意见。
