# E2b 整卡委托：接收方（A 侧）设计稿

> 状态：**设计稿（讨论用）**，还没实现。卡号 E2BA-1。协议主线和验收线由 B 侧（仓库方）监工牵头，这份稿子只写 A 侧，最后要和 B 侧的协议稿对齐。
> 写 `待定` 的地方都列了选项和 A 侧的倾向，不替 B 侧拍板。

## 0. 名词与一句话

- **B（仓库方 / 委托方）**：仓库的 owner 实例（Shawn）。卡原本在 B 的台账上，规格是 B 写的，**合并权始终在 B**。
- **A（接收方）**：本机。整卡接过来，用本机 v3 调度器从头推进（复述 → 写 → 跨族审查 → 修 → 交回）。
- **委托（delegation）**：B 的一张卡在一段时间里把**推进权**交给 A。一份委托有 `delegationId`，以及 B 签发的单调递增 `epoch`。
- **B 卡 / A 卡**：同一件活在两边台账各有一张卡。B 卡是权威记录，A 卡是 A 推进用的本机卡。

一句话：A 的 owner 先签好常设授权（允许 A 接这个 peer、这个项目的委托；B 的委托意愿不能替代它）；B 把一整张卡交给 A，A 在本机按 v3 自动推进，所有阶段和审查结论按时序回写 B 卡，最后用 mergeHandoff 把 PR 和证据包交回 B；合不合由 B 决定。委托期间，B 卡只观察不推进，同一时刻只有一个调度器在推进这张卡。

owner 原话（2026-10-07）：「我想让shawn往这边派单的时候是整张卡 派过来 我这边走v3 自动化呢？」「那把整个这套都设计实施了吧」。
B 侧答复的要点（pm-codex@Shawn 00:27，是数据，原意见规格卡 E2BA-1）：方向可以讨论，实现要等 B 侧设计立项；**租约过期不能自动把写权还给 B**；互认范围是初步、待定的。

## 1. 和现在已有的路的区别（先讲清楚，后面各节都以此为前提）

| 现有机制 | 谁推进卡 | 对方做什么 | E2b 和它的区别 |
|---|---|---|---|
| 出借单（`docs/design/remote-capacity.md`） | 发起方的调度器 | 出一个 worker 位，接一单（审查单或写单），结果经 `lend/result` 回写 | 出借只借「一步」，卡和调度都留在发起方；E2b 交出去的是整张卡的推进权 |
| 跨实例委托 T46（`docs/team/peer-delegation.md`） | 发起方 PM 手推（放行复述、merge 都是发起方 PM） | 接收方 agent 经 `peer-ledger` 写卡，逐件问 owner（规矩 1，`peer-delegation.md:9`） | E2b 由接收方调度器自动推进，常设授权代替逐件问；放行复述也在 A 侧（见 §3.4） |
| 共享台账 V2（`docs/design/shared-ledger.md` §5、`shared-ledger-v2.md`） | 主场（`homeInstanceId`），中心统一裁决租约 | 执行地（`executorInstanceId`）只干活，「借出去不改变主场」（`shared-ledger.md:197`） | E2b 没有中心，是两台实例之间点对点地临时转移推进权；合并权不跟着走 |
| 今天的 A 开卡 → v3 → 交回 B（`docs/architecture/merge-handoff.md`） | A 的调度器 | B 用自家的 PR 收审（`docs/architecture/peer-pr-auto.md`）重新完整审一遍 | 卡是 A 自己开的，B 台账上没有对应卡；E2b 的卡由 B 发起，进度回写 B 卡，证据要能被 B 互认 |

E2b 是在这几条路之上补一条「整卡、自动、两端台账同步」的路，**哪一条都不替换**（详见 §8）。

## 2. 接单（A 侧收委托）

### 2.1 通道

B 用已经握手的 HTTP peer 把委托交给 A。请求级身份用现有的那套：A 的 bridge 验 B 的实例签名，签名指纹要和 `peers.json` 里钉住的一致，token 对应的 peer 名也要对上；请求体里自报的名字一概不信（同 `remote-capacity.md:150`）。

**待定：消息形状。** 选项：
- (a) 沿用 T46 首行写 `[协作 Txx]` 的 `send_to_agent`，再加 `peer-ledger`；
- (b) 新开结构化接口，比如 `/api/v1/delegate/offer|ack|writeback|revoke`，形状仿照出借 v2 的 hello / offer / claim / beat。

**A 侧倾向 (b)**。理由：接单要在事务里做 CAS，还要幂等重发、签名回执、带 epoch 拒收旧消息，这些都是 (a) 那种消息正文给不了的；而且 (a) 的注入头本来就会要求先问 owner（`peer-delegation.md:140`），和「常设授权内自动接」相冲突。接口由 B 侧协议稿定，A 侧只要求它带得下 §2.2 要核的字段。

### 2.2 A 要核的东西（在一个写事务里核完再落卡）

| # | 核什么 | 依据 | 不满足时 |
|---|---|---|---|
| 1 | B 的身份：bridge 验签，指纹和 `peers.json` 钉住的一致，token 对应的 peer 名 | 现有 peer 鉴权 | 401，不落任何东西 |
| 2 | A owner 签过、在有效期内的**常设授权**，授权绑定 peer + 指纹 + 项目 + 仓库 | `docs/team/collab-model.md:68` 的 `peer_accept_standing` | 退回人工确认（§2.3） |
| 3 | 并发上限：这个 peer 在 A 侧没结束的 E2b 卡数 < 授权里写的 `maxConcurrent` | `docs/design/scheduler-engine.md:145`「超过上限排队，前卡完成即补位」 | **排队**并回执 `queued`，不拒单 |
| 4 | 模板在授权允许的范围内；`security` 默认不接 | `remote-capacity.md:153-154`（security 终审回主场本机跨家族复核），以及 B 侧要保留独立完整审的那几类面 | 拒单，回执 `template_not_allowed` |
| 5 | A 本机：`scheduler.json` 启用了这个项目、`autoDispatch` 开着、项目是 `mergeHandoff: true` | `scheduler-engine.md:203`、`merge-handoff.md:8-15` | 拒单，回执 `not_configured`（这是结构性问题，排队也没用） |
| 6 | A 本机额度闸和 worker 槽 | 和本机派单同一个口径（`remote-capacity.md:385`） | 排队，回执 `queued`，原因写「额度 / 槽满」 |
| 7 | 仓库：委托里的 `owner/repo` 在授权的仓库白名单里，并且就是 A 这个项目 `repoDir` 的 origin | 和 `merge-handoff.md:56-57` 的 origin 核对同一套 | 拒单，回执 `repo_mismatch` |
| 8 | 规格大小有上限、能脱敏；正文按外来数据处理 | `remote-capacity.md:187-191` | 拒单，回执 `spec_invalid` |

第 5 条是 A 侧防越权的关键：**项目没配 `mergeHandoff` 的，一律不接。** 这样 A 的调度器对这张卡根本不会排合并意图、不会更新分支、也不会部署（`merge-handoff.md:72-77`），合并权在机制上留在 B。

第 2 条的授权形状（**待定**，A 侧提案）：authorize ask，`bind.action = "peer_delegate_standing"`，params 为 `{peer, fp, project, repos[], templates[], maxConcurrent, expiresAt}`。
理由：授权要钉指纹，否则对方换一台机器重新握手、沿用同一个 peer 名，就能继承授权；`templates`、`maxConcurrent` 都要由 A owner 亲手定，B 在委托里报的值不算数。
另一个选项是直接沿用文档里的 `peer_accept_standing`，在 params 里加字段。现状：代码里只有逐卡的 `peer_accept`（`src/manager/peer-ledger-cli.ts:14-24`），standing 还没实现，见 §11。

### 2.3 接不下来怎么办

回执统一是 B 签名可验、A 用实例钥匙签的 `{delegationId, outcome, reason, at}`，`outcome` 取下面几种：

- `accepted`：落卡，进 §3。
- `queued`：并发满或额度紧（第 3、6 条）。在 A 侧排队；有空位时按委托到达顺序补位，补位时把第 1–8 条全部重核一遍。排队期间 B 可以撤回。
- `needs_owner`：没有常设授权，或者授权过期 / 被收回（第 2 条）。A 在自家 owner 频道发一张 authorize 卡，问的是「这一张接不接」，和 T46 第 2 步同一套（`peer-delegation.md` 流程第 2 步）。owner 点同意就当作 `accepted`；不同意、或 24 小时没人答，就回执 `rejected:owner_declined` / `rejected:owner_timeout`。
- `rejected`：带原因码（上表最后一列）。拒单不落 A 卡，只记一条接收日志，这样 B 重发同一个 `delegationId` 时能拿到同一张回执。

A 侧的接单接口必须幂等：同一个 `delegationId`、同样的内容摘要，重发拿回原回执；同一个 `delegationId` 换了内容，返回 409。

## 3. 本机推进

### 3.1 卡号映射

- **映射是查表，不是现算。** 委托表（§3.4 的 `e2b_delegations`）对 `(B 完整指纹, B 卡号)` 建唯一索引，记下当时分配的 A 卡号。接单、补发、规格追加都**先按这两项查表**，查到就用表里的卡号；只有第一次接单才分配新卡号。所以映射一经分配就固定，反查（A 卡号 → B 指纹 + B 卡号）也只读这张表，不靠从卡号字符串里拆。
- 分配规则（确定性，按顺序取第一个可用的）。本机卡号规则是 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$`，最长 60 字符（`src/lib/dag-tools-start.ts:94`）；B 侧卡号最长可到 64 字符（`src/lib/order-wire.ts:80`），所以要处理超长：
  1. 可读形式 `E2-<fp8>-<B 卡号>`：`fp8` 是 B 指纹去掉连字符后的前 8 个十六进制字符。用 8 位而不是 4 位，是为了少撞；4 位只够做分支名后缀（`remote-capacity.md:172`），不够做卡号。这种形式要求整串满足本机规则（≤ 60 字符）、本机还没有同名卡。
  2. 哈希形式 `E2-<fp8>-h<sha256("<B 完整指纹>:<B 卡号>") 前 16 个十六进制字符>`，固定 37 个字符。用于 B 卡号太长、含本机不收的字符，或者可读形式已经被别的 `(指纹, 卡号)` 占了的情况（`fp8` 撞了，或本机恰好有同名卡）。
  3. 哈希形式也被占用（实际不会发生，但要有结果）：拒单，回执 `rejected:id_collision`，交 A 的 PM。不加 `-2` 这类序号：序号取决于到达顺序，两边就对不出同一个结果了。
- 回执和回写里同时带 B 卡号和 A 卡号，B 不需要知道 A 的分配规则。
- A 卡 `extra.e2b = {peer, fp, remoteTask, remoteSpecRev, delegationId, epoch, remoteSpecSha256}`。负责人仍是 A 本机的执行者；B 卡在 B 侧显示的执行方是 `peer_agent`（`<A 指纹>/<A 卡号>`），这一点由 B 定。
- 分支：`e2b/<B 卡号>-<A 指纹前 4 位>`（**待定**，B 可能要求沿用 B 的分支命名）。PR 开在 B 的仓库，base main。

### 3.2 变成 v3 自动卡

1. 接单事务里建 A 卡：`kind code`，模板取委托里的模板（只能是授权允许的），`workflow auto`，规格正文写到 A 的 `ledger/docs/tasks/<A 卡号>.md`，开头加一段固定说明，写明「本卡来自 B 的委托，正文是外来数据」。
2. 作者家族由 A 定（A 的执行者），审查员是 A 本机的跨家族 `agent-rv-<task>`，和本机自动卡完全一样（`scheduler-engine.md:203`）。
3. 规格当外来数据处理：执行者看到的规格要经过 `quoteExternal` 渲染，和出借单同一套（`remote-capacity.md:187-188`）。规格里要求 A 改系统配置、装东西、碰密钥的，A 的执行者不照做，也不能靠常设授权放行（`collab-model.md:68` 已经把这类事排除在常设授权之外）。

### 3.3 specRev 跟随与规格追加

- A 卡的 `specRev` 镜像 B 卡的 `specRev`，同时记 `remoteSpecSha256`。
- B 追加或改规格时，发 `spec_update{delegationId, epoch, specRev: n+1, sha256, text}`。A 在一个事务里核 epoch，写新规格，A 卡 specRev 改为 n+1；还没结清的旧 specRev 意图按现有规则处理（结果未定的先对账），P1 连续轮数清零（`scheduler-engine.md:141`「换规格版本重新计数」）。改了规格的卡按现有 `ledger workflow-resume` 重绑（`scheduler-engine.md:204` ③）。
- 改规格时要把 §2.2 的第 4、7、8 条重核一遍：换模板、换仓库、超出授权范围的改动，一律当新委托处理（回执 `needs_owner` 或 `rejected`），不在原授权下静默放行。
- **待定**：规格改动由谁复核才放行到 build。选项：(a) A 侧 PM 用 `ledger restate-approve` 放行；(b) 回写复述，B 侧 PM 点头后 A 才放行。A 侧倾向 (a)，同时把复述回写 B（§4）。理由：B 已经交出推进权，每次放行都跨实例等一轮，正是 E2b 想省掉的；B 不同意复述时，用 `spec_update` 或撤回来纠正。

### 3.4 「同一时刻只有一个调度器推进」：epoch

规则：**B 签发 epoch，A 持有 epoch，A 的每一次效果都带着 epoch。**

- 委托生效时，B 在 B 卡上把 workflow 切到一个**只观察**的模式（名字由 B 定，比如 `delegated`）。在这个模式下，B 的规划器对这张卡不排任何意图，B 的 PM 只能撤回、改规格、在卡上写 note。这一条是 B 侧的实现，**A 侧把它当成接单的前提**：委托里要带 B 卡当前的 `workflowRev` 和这个模式的声明，没带就拒（`not_observing`）。
- A 侧本机有一张委托表（提案：`e2b_delegations`，一份委托一行，记 `state`、`epoch`、`leaseExpiresAt`）。A 的调度器对 E2b 卡做任何效果之前，都要在同一事务里核：这行仍是 `active`、epoch 没变、租约没过期。效果包括：派单、建 session、推分支、`deliver`、`merge_handoff`，以及**生成**新的业务回写。核的位置照 T68h 的做法，紧贴效果（`scheduler-engine.md:204` ①）。
- **业务效果和控制面回执分开。** 上面这道闸只管「推进这张卡」的业务效果。有两类发送不受它限制，在 `stopping` / `stopped` 状态下照常发出：
  1. **控制面消息**：`stop_confirm`、`return_request`、`renew_request`（§6.2 待定项的同 epoch 续租申请），以及对 B 的 `revoke` 的应答。它们只报告状态、请求下一步，不推进卡。
  2. **积压的业务回写**：在 `active` 期间已经写进 outbox 的回写（`aSeq` ≤ 停止时刻的最大值）。它们记录的是已经发生的事实，发出去不算新效果。
  闸查的是「生成回写」这一刻；outbox 发送时不再查 `active`，只查 epoch 是否仍是这份委托的。
- B 那边，凡是 A 发来的**业务**写请求，都要核 `epoch` 等于 B 卡当前的 epoch，而且委托处于 active，否则拒（`stale_epoch`）。这和共享台账 V2 的「所有写入口核 epoch」同一个思路（`shared-ledger.md:204-207`）。
- B 收**控制面消息**和**积压回写**的规则（A 侧提案，协议由 B 定）：
  - 验 A 的实例签名；epoch 必须是 B 签发过的、属于这份委托的某个值（不要求是当前值）；消息类型在白名单里。
  - 委托在撤回 / 退回 / 过期后、B 正式收回之前，B 照收这两类消息，但只记进历史和停止核对，不推进 B 卡阶段。积压回写只收 `aSeq` ≤ `stop_confirm.lastSeq` 的；`stop_confirm` 还没到时，先收下，等它到了再对一遍。
  - B 正式收回（epoch 已经加一）之后，旧 epoch 的 `stop_confirm` 和积压回写**仍然收下**，只作为迟到的历史和对账材料，不改变任何状态。
  - 幂等：控制面消息的去重键是 `e2b:<delegationId>:<epoch>:ctl:<类型>:<A 序号>`，同键同摘要拿回原回执，同键换内容返回 409。
- epoch 只由 B 增，而且只在 §6 的正式收回之后增。A 永远不自己增 epoch，也不复用旧 epoch。

理由：靠租约到期自动换手，会让断网时两边都以为自己在推进。用 epoch 加「收回前先核清」，代价是断网时卡会停住，但不会出现两端同时推进（这就是 Shawn 要求的那条修正，见 §6）。

## 4. 回执与回写（A → B）

### 4.1 回写哪些事件

| A 侧事件 | 回写内容 | 不回写 |
|---|---|---|
| 接单结果 | `accepted / queued / needs_owner / rejected` + 原因 | — |
| 复述 | 复述正文（已脱敏） | A 的规格文件路径 |
| 阶段变化 | `from / to / round / specRev` | 触发它的本机意图 id |
| 交付 | 完整 head SHA、分支、PR 链接 | worktree 路径 |
| 每轮审查结论 | `verdict`、P0 / P1 / P2 计数、`findings[]`（findingId、family、severity、脱敏后的描述）、审查员身份声明（§5.1） | 报告原文的本机路径；原文按 §5 放进证据包 |
| 关闭证据 | 每条 finding 的关闭方式和对应 head | — |
| blocked / 解除 | 原因的一句话 | — |
| 退回人工（fallback） | 原因码 + 一句话 | PM 之间的对话 |
| 交回（mergeHandoff） | `merge_handoff` 事件 + 证据包摘要（§5） | — |
| 停止确认、在途成果清单 | 见 §6 | — |

白名单思路和 `peer-ledger` 的时间线白名单一样（`peer-delegation.md:99-100`）：只回写对 B 推进判断有用的字段，A 本机路径、owner 原话、session 记录都不出机器。出机器前统一过 `redactPeerPr` 同一套脱敏和密钥闸（`peer-pr-auto.md:47-55`），没过就不发、不截断。

### 4.2 幂等与排序

- 每条回写带 `(delegationId, epoch, aSeq)`。`aSeq` 是 A 卡事件的本机序号，单调增。去重键：`e2b:<delegationId>:<epoch>:<aSeq>`。
- B 按顺序收：要求 `aSeq` 大于 B 已收的最大值。有缺口时回 `gap{expect}`，A 从缺口那条起补发。
- 同一个键、同样内容摘要的重发，拿回原回执；同一个键换了内容，返回 409。A 收到 409 就冻结这张卡，交给 A 的 PM，不自动重编号。
- B 的回执用 B 的实例钥匙签 `{delegationId, epoch, aSeq, sha256}`，A 验签后才把这条标成已送达。这和出借回执是同一个模式（`remote-capacity.md:226`）。

### 4.3 断网、重启后补发

- A 侧用 outbox 做（提案：一条回写一行，状态 `claimed → sent | failed | refused | abandoned`），先写 outbox 再发。重试从 30 秒退避到 10 分钟，和 peer-pr-auto 的推送语义一致（`peer-pr-auto.md:57-64`）。重启后扫一遍 outbox，从最小的未确认 `aSeq` 起重发。
- 断网期间，A 的本机推进**照常进行**（这是 A 自己的活），只是回写排在 outbox 里。但有一个例外：**交回（mergeHandoff）要等 outbox 清空**，也就是 B 已经收到了交回之前的全部历史，才把 PR 和证据交过去。理由：B 做合并判断时不能缺审查轮次。
- outbox 有未确认的回写超过 15 分钟，提醒 A 的 PM 一次；超过租约时长，按 §6.2 的租约过期处理。

### 4.4 B 拒收

| B 返回 | A 怎么办 |
|---|---|
| `stale_epoch` / `not_delegated` | 当作 B 已经撤回或收回：立刻停掉这张卡的所有新效果，进 §6.1 的停止流程。停止确认和积压回写走 §3.4 的控制面规则照常发给 B，B 收下只入历史 |
| `gap{expect}` | 从 `expect` 起补发 |
| 409（同键不同内容） | 冻结卡，交 A 的 PM；不自动重编号 |
| `schema` / `invalid` | 这一条标 `refused`，卡退回人工并通知 A 的 PM；后续回写暂停，以免 B 在缺一条的状态上继续收 |
| 网络错误 / 5xx | 重试（§4.3） |

**不允许静默丢弃。** 回写失败只能有三种结果：重试、冻结、退回人工。

### 4.5 交回之后 B 要求修改

今天 mergeHandoff 在交回之后，只要 PR head 的变化不是「纯合入 main」，就把卡交给 PM（`merge-handoff.md:28-36`）。E2b 需要一条新路：B 审完提出 changes 时，发 `reopen{delegationId, epoch, findings[]}`，A 把卡从 merge 退回 fix，开新一轮，由 A 的执行者修，A 的审查员复审，再交回。

**待定**：B 的 changes 是作为新一轮审查结论记在 A 卡上，还是作为 `spec_update`。A 侧倾向前者，理由是 findingId 能沿用，同类 P1 的轮数也接着计。

## 5. 证据导出（给 B 互认用）

基础是现有的 `ledger review-export` v1（`src/manager/ledger-review-export-cmd.ts:39-44`）。它的 manifest 已经有：`format / version / bundleId`、`origin.instanceFingerprint`、`subject{repo, pr, head, base, specRev, taskId}`、`scope`、`authors`、`rounds`、`closuresArtifact`、`final`、`artifacts`（`src/lib/review-evidence.ts:224-231`）。v1 草案说明了这个包只在本机导出、不发送（草案在台账目录 `ledger/docs/review-evidence-v1/`，不在仓库里）。

E2b 要补的字段（**待定**：升 v2，还是在 v1 上按「新证据用新键」加——`merge-handoff.md:87` 的约定是改含义才升版本）：

| 字段 | 内容 | 理由 |
|---|---|---|
| `delegation` | `{delegationId, epoch, remoteTask, remoteSpecRev, remoteSpecSha256}` | 让 B 能核：证据对应的就是自己发出的那份规格 |
| `rounds[].reviewer.verification` | 身份是怎么核的：`mcp_bound_session`（结论经 MCP 从绑定 session 写入，即 `d.via === "mcp"`，`review-evidence.ts:162-163`）/ `registry_runtime`（registry 当前 session 和 runtime 家族对得上，`scheduler-engine.md:203`）/ `claim_only` | 现在只有一个 `verified` 布尔值，B 看不出是哪种核法 |
| `rounds[].reviewer.instance` | A 的实例指纹 | 审查员身份是「A 这台机器上的哪个 session、哪个家族」 |
| `pinned` | `{head, base, specRev}`，以及 base 的来源（`baseSource`） | 证据只对这一组固定值有效 |
| `rounds[].findings` + `closures` | 沿用 v1 的 closures.json | v1 已经有 |
| `rounds[].probes[]` | 每个探针的来源（审查员写的 / 规格给的）、文件名、sha256 | v1 只记 probe-source 文件和哈希，没记来源 |
| `carries[]` | 交回之后 head 每一跳的 `{from, to, mainParent, diffHash, basis}` | 见下面「head 变化」 |
| `surfaces[]` | 碰到了哪些「B 必须完整再审」的面（§7）：`{surface, paths[], ruleSource}` | 让 B 一眼看出哪些部分不能只做证据核对 |
| `signature` | A 用实例钥匙签 manifest 的 sha256 | B 只能验「这包出自 A 这台机器」，验不了 A 内部 |

**head 变化后证据失效**：证据绑定 `pinned.head`，head 一换，旧证据就作废。唯一例外是「纯合入 main」：沿用 merge-handoff 的 carry 规则（`merge-handoff.md:38-70`，实现在 `src/lib/scheduler-main-merge-carry.ts`）。新 head 必须恰好有两个父提交（原 head 和 main 上的提交），并且通过 `auto-merge` 或 `net-diff` 两种证明之一，证据才沿用到新 head，每一跳记进 `carries[]`。本机审查和合并闸自己的沿用规则（`src/lib/review-main-carry-proof.ts`）不变。**要和 B 侧现有的「canonical 纯 main 净 diff」规则逐字对齐**：哪一边的算法当权威、diff 参数怎么固定，由 B 定，A 按 B 的口径导出 `diffHash`。

诚实的边界：
- 对 B 来说，A 记的 `verified` 仍然只是 A 的声明，B 能核的只有 A 实例的签名。这和出借结论「家族只算自称」是同一回事（`remote-capacity.md:151-154`）。
- 「审查员不是作者」在 A 本机是真校验，过了实例边界就只能凭 A 声明（`collab-model.md:56`）。
- 签名是新的密钥用途，v1 草案明确写了「不新增加密用途」。所以签名本身是 B 侧要拍板的协议点。

## 6. 撤回、退回与收回

三种情况共用一个**停止流程**，区别只在谁发起。

### 6.1 停止流程（A 侧要做的）

1. **先停新效果**：同一事务里把委托行改成 `stopping`。从这一刻起，§3.4 的效果闸对这张卡一律不放行：不派新单、不建 session、不推分支、不交付、不交回。还没结清的 pending 意图取消，submitted 意图照常对账。
2. **让在途的停下**：执行者和审查员 session 收到停止消息，A 等它们停下，判据是 session 空闲且确认退出，或者被 kill 后确认进程不在。停不下来的，标进清单的 `notStopped`。
3. **出在途成果清单**（A 侧提供，提案命令 `ledger e2b-stop-report <A 卡号>`，只读）：
   - 分支名、origin 上的最新 head（A 自己 `git ls-remote` 核过）、本地有没有没推的提交；
   - PR 链接和状态；
   - 结果未定（unknown）的意图，以及它们可能留下的外部效果，比如「推送可能已经发生」「交回事件可能已发出」；
   - outbox 里还没确认的回写；
   - 写完还没回写的审查报告。
4. **发停止确认**：`stop_confirm{delegationId, epoch, stoppedAt, lastSeq, sessions[], notStopped[], unknownEffects[], artifacts[]}`，用 A 的实例钥匙签名，经 outbox 发出。这是控制面消息，不受 §3.4 业务闸的限制（委托已经是 `stopping`，照样能发）；`lastSeq` 是停止前最后一条业务回写的 `aSeq`，B 据此判断积压有没有收齐。`notStopped` 不为空时，确认只能算「部分停止」，不能作为 B 正式收回的依据（§6.3）。
5. A 卡转为终态（`cancelled`，原因写明撤回 / 退回 / 过期）。worktree 和分支保留，**等 B 确认收回之后才清**。

### 6.2 三种情况

- **B 撤回**：B 发 `revoke{delegationId, epoch}`，A 走 6.1。之后 B 核对清单，增 epoch，正式收回。
- **A 退回**：A 的 PM 或 owner 主动退回；或者 A 自己推不动了，例如 P1 到了安全阀、退回人工后 A 的 PM 也推不动、额度长期不足。A 先发 `return_request{reason}`，再走 6.1。退回要 B 确认才算结束，不能 A 单方面宣布。
- **租约过期**：A 持有的委托有租约（提案：A 每 60 秒续租，租期 10 分钟，数值待 B 定）。**按 Shawn 的要求，过期不能自动把写权还给 B：**
  - A 侧：到了租约截止仍没续上，A 自己执行 6.1 的第 1、2 步，停掉旧 epoch 的一切新效果，保留现场和 journal。这和出借方「到租约截止仍没续上就自停 worker，保留工作副本和 journal」是同一个做法（`remote-capacity.md:221`）。联系得上 B 时，补发 6.1 第 4 步的停止确认。
  - B 侧：租约过期只说明「联系不上 A」，不说明 A 已经停了。B 不再接受旧 epoch 的**业务**写入、自己也不发出旧 epoch 下的新指令，但照收控制面消息和积压回写（§3.4），然后等 A 的停止确认。正式收回的条件见 §6.3。这和共享台账 V2「超时不自动换主场」是一个思路（`shared-ledger.md:210-211`）。
  - 还没核清的 unknown 继续占着资源，不因为租约到期就解锁重试。

### 6.3 正式收回要什么证据

「旧端和 worker 已停」只有 A 自己能证明。GitHub 上分支、PR 没有新推送（`gh pr view`、`git ls-remote`）**不算停止证据**：它只说明到观察那一刻为止没看到推送，看不到 A 本地正在写、还没提交的改动，看不到进行中的 `git push`，也看不到没回写的审查和其他未知效果。

1. **正常收回**：B 收到 A 签名的 `stop_confirm`，`notStopped` 为空，积压回写收齐（`aSeq` 连续到 `lastSeq`）；`unknownEffects` 和在途成果逐条有了处置（采纳、丢弃、或者作为 unknown 继续占资源）。满足这些，B 才增 epoch、正式收回。
2. **联系不上 A，或者 A 报了 `notStopped`**：没有停止证据，**卡保持冻结**。B 卡停在「待收回」，旧 epoch 的资源继续占着，B 不在这张卡上开新的推进。默认就一直这样等下去，没有超时自动收回。
3. **强制收回（待定，A 侧提案）**：B 的 owner 明确决定不等了，这必须是 owner 签的 authorize，而且写明「已知旧端可能还活着」。这时 B 不能把「没看到推送」当成「已停」，而是靠隔离让旧端可能的后续效果落空：
   - epoch 加一，此后旧 epoch 的业务写入一律拒（§3.4）；
   - B 的新推进**不沿用**旧分支和旧 PR：关闭旧 PR，换新分支、开新 PR，旧分支之后有任何推送，B 都不采纳；
   - B 卡上记录「强制收回、旧端未确认停止」，旧端留下的成果一概不当成交付；
   - 视需要收回 A 这条委托通道的 token 权限，只切断通讯，停不了 A 上的进程（`remote-capacity.md:205` 同理）。
   这样旧 worker 之后就算推送成功，也只落在一个已经作废的分支上，不会和 B 的新推进叠在同一张卡、同一个 PR 上。残留风险要写明：A 用的 GitHub 账号如果对仓库有写权限，旧 worker 仍可能推到别的分支，这一点只能靠 B 管 GitHub 权限。
4. 强制收回之后 A 才恢复联系：A 收到 `stale_epoch`，照常走 §6.1；它迟到的 `stop_confirm` 和积压回写 B 照收、只入历史（§3.4），用来补核 unknown。

**待定**：租约过期、但 B 还没收回时，A 恢复联系后能不能用同一个 epoch 续租继续推进。选项：(a) 能，前提是 B 卡仍在这个 epoch、委托没被撤；(b) 不能，一律重新委托。A 侧倾向 (a)，可以少一轮重新接单。流程是：A 先把积压回写和 `stop_confirm` 按 §3.4 的控制面规则发完，再发 `renew_request`；B 核对后同意，A 的委托行才回到 `active`。在那之前业务闸一直关着。

## 7. 互认边界（Shawn 给的初步范围，**全部待定**）

照原意抄录：

- **可以考虑「证据核对 + 抽查」的**：文档、隔离测试、叶模块、普通 UI。
- **B 侧保留独立完整审的**：身份 / 鉴权 / 权限、台账写入、授权租约、出借协议、调度合并部署、CI 闸、宿主 shell、密钥，以及 security 模板。
- head 变化，原则上证据失效；但已有 canonical 纯 main 净 diff 证明的沿用规则要保留。
- 以上都是待定的设计边界，现有流程没有改。

A 侧要做的：导出证据时填 `surfaces[]`（§5），按文件路径标出这次改动碰了上面哪一类「完整再审」面。
- **规则由 B 提供**：委托里带一份 glob → 面的映射表，A 照着算。这和 peer-pr-auto「规则是数据」同一个做法（`peer-pr-auto.md:38`，`src/lib/peer-pr-surface.ts`）。
- B 没给表时，A 用本机 `peer-pr-surface` 的规则，并在 `ruleSource` 里标明是 A 的规则。
- 读不出、或改动超过 300 个文件，一律标成 security。
- A 的标注只是建议，B 会自己重算一遍；两边算得不一样，以 B 为准。

## 8. 和现有机制的关系

- **出借单**：照用。A 推进 E2b 卡时，如果自己的槽满了，也可以把审查单挂到出借池借第三台机器的位（`remote-capacity.md` §10）。这样证据里审查员的实例就是第三方，`verification` 记 `claim_only`。security 卡本来就不接。
- **T46 委托卡**：照用，给边界不清、需要人逐件拍板的活；E2b 只接规格写清、模板允许、在常设授权内的卡。
- **共享台账 V2**：E2b 是 V2 落地之前点对点的临时做法。V2 落地后，E2b 的 epoch 和租约可以映射成中心上的 `scheduler_leases`：推进权临时迁到 A，合并权不迁。但 V2 写的是「出借不改主场」（`shared-ledger-v2.md:46`），E2b 改的恰恰是推进权，到时要在 V2 里明确这种「推进权临时迁移」算不算换主场。见 §11。
- **peer-pr-auto / mergeHandoff**：A 侧交回直接用现有的 mergeHandoff（`merge-handoff.md`），证据包在 `HandoffEvidence` 预留的位置（`merge-handoff.md:100-102`）加一项 `peerAck` 或 `e2bBundle`。B 侧收 PR 时，要把这个 PR 认成已有 B 卡的交付，而不是另开一张 `PR<n>` 卡（`peer-pr-auto.md:37`）。这是 B 侧的事。
- **A 侧代码里退回人工的那一处**：`src/lib/worker-session.ts:116-117` 把 peer 委托退回 manual（注释写的是「until E2」）。E2b 不需要改它：A 推进的是本机卡，执行者都是本机 session，根本不走 peer 路由。B 侧对委托出去的卡用只观察模式，而不是走这条 manual。

## 9. 双端推进与越权：A 侧逐条排查

| 路径 | 风险 | 怎么挡 |
|---|---|---|
| B 的规划器仍在推 B 卡 | 双端推进 | B 卡切只观察模式；A 接单时核 B 声明了这个模式（§3.4） |
| B 的 PM 手推 B 卡阶段 | 双端推进 | B 侧只观察模式下拒绝（B 实现）；A 发来的回写带 epoch，B 收到时核 |
| A 撤回或过期之后仍在推 | 双端推进 | A 的效果闸核委托行状态 + epoch + 租约（§3.4），失租就自停（§6.2） |
| A 重启后状态是旧的 | 旧 epoch 复活 | 委托行持久化；重启后先对账未结意图，再按现有对账规则续 |
| 断网两端都以为自己是推进方 | 双端推进 | 只有 B 能增 epoch，而且必须拿到停止证据才增；A 过期就自停（§6.2） |
| 联系不上 A 时凭 GitHub 没有新推送就收回 | 旧 worker 迟到的推送和 B 的新推进叠在一起 | GitHub 静态观测不算停止证据，没有证据就冻结；强制收回要 owner 授权，并且换新分支、新 PR，作废旧的（§6.3） |
| 停止确认被自己的业务闸挡住 | 两边互等、永远收不回 | 控制面消息和积压回写不受业务闸限制，B 在收回前后都照收、只入历史（§3.4） |
| A 本机合并或部署 | 越权 | 接单时要求项目是 `mergeHandoff: true`，这种项目不排合并意图、配 deploy 直接判配置无效（`merge-handoff.md:14-15`、`:72-77`） |
| B 通过规格让 A 做授权外的事 | 越权 | 规格是外来数据（§3.2），系统配置、安装、密钥类不在常设授权内；改规格重核授权（§3.3） |
| B 把 security 卡塞给 A | 越权 / 审查降级 | 模板闸默认拒（§2.2 第 4 条），授权里的 templates 只有 A owner 能改 |
| B 抬高并发 | 越权 | 上限只取 A owner 签的授权，B 报的值不算（§2.2） |
| 换机器沿用同一个 peer 名 | 冒名 | 授权绑定指纹（§2.2） |
| 本机 agent 伪造 B 的回写 / 伪造 epoch | 伪造 | 和现有台账的身份边界相同：同一个 OS 用户下只能检测、不能防（`peer-delegation.md:143`、`scheduler-engine.md:142`）。B 收的写入只认经过 A bridge 签名的请求 |

## 10. 验收场景（草案；最终验收线由 B 侧监工定）

都在双实例沙箱里跑（出借 R5 用的 `--lab --pair`，`remote-capacity.md:259`），不碰生产。

1. **并发补位**：B 同时委托五张给 A，A 的授权上限是三：先起三组（执行者 + 跨族审查员），两张回执 `queued`；前面一张交回后补一张，再交回再补一张（`scheduler-engine.md:145` 的原场景，方向改成 B→A）。
2. **无授权 / 超范围**：没有常设授权 → `needs_owner`，A owner 点同意后开工；security 模板 → `template_not_allowed`；项目没配 mergeHandoff → `not_configured`。
3. **规格追加**：A 在 build 阶段时 B 发 `spec_update`，A 卡 specRev 跟着加一，P1 计数清零，旧意图按规则结清。
4. **断网**：A 在 review 和 fix 之间断网十分钟。A 本机照常推进，outbox 积压；恢复后按 `aSeq` 补发，B 不收到重复、也没有缺口。交回要等 outbox 清空。
5. **撤回**：B 在 fix 中途撤回。A 停掉新效果，发停止确认和在途成果清单；B 核对后增 epoch。之后 A 再发任何回写，都被 `stale_epoch` 拒。
6. **租约过期**：断开 A 超过租期。A 自停，B 不自动收回；恢复联系后 A 在 `stopping` 状态下发出 `stop_confirm` 和积压回写，B 收齐核清后才收回。
7. **联系不上、但旧 worker 还活着**：A 的执行者已经开始写、还没提交，这时切断 A 和 B 的网络，并且不让 A 自停（模拟 A 的自停失效）。B 等到租约过期后，GitHub 上看不到新推送：B 必须停在「待收回」，不能正常收回。再跑强制收回：B 的 owner 授权后加 epoch、关旧 PR、开新分支；旧 worker 随后推送成功，验证这次推送只落在作废的旧分支上，B 卡和新 PR 都不受影响；A 恢复联系后收到 `stale_epoch`，迟到的停止确认被 B 收下、只入历史。
8. **拒审换家族**：A 的审查员（比如 Codex）拒审，换成另一家（比如 Pi 审查员），证据包里如实记录换家族和每一轮审查员的 `verification`。
9. **交回后 B 要求修改**：B 发 `reopen`，A 卡从 merge 回到 fix，新一轮修完再交回，`carries[]` 和轮次连续。
10. **崩溃恢复**：A 的调度器在交付和回写之间被 kill，重启后零重复事件、零重复推送。

## 11. 待对齐（现有文档 / 代码里发现的出入，本卡不改，只记在这里）

1. `docs/team/collab-model.md:68` 写了常设授权 `peer_accept_standing`，但代码里只有逐卡的 `peer_accept`（`src/manager/peer-ledger-cli.ts:14-24`），`src/` 里搜不到 `peer_accept_standing`。E2b 依赖常设授权，要么先实现它，要么按 §2.2 另立 `peer_delegate_standing`。
2. `docs/design/scheduler-engine.md:145` 描述的整卡委托方向是「A 委托给 B」；本稿的方向是 B（仓库方）→ A。两份稿子里的 A / B 指代相反，合并讨论时要统一称呼。
3. 规格卡引用的 `src/lib/worker-session.ts:113-118`，实际是 111–115 行的注释加 116–117 行的函数；peer 退回人工在第 117 行。
4. `docs/architecture/merge-handoff.md:100-102` 写了「证据怎么到 owner 那边不在本卡范围」。E2b 正好要补这一段，到时要回头更新这几行。
5. review-evidence v1 草案（台账目录 `ledger/docs/review-evidence-v1/review-evidence-v1.md`，不在仓库里）写了「不新增加密用途、不做接收方导入」；E2b 的签名和 B 侧导入，都超出了这条边界，需要另立版本。
6. `docs/design/shared-ledger-v2.md:46`「出借不改主场」和 E2b 的「推进权临时迁移」之间的关系，要在 V2 里写清楚（§8）。
7. B 侧的 peer-pr-auto 收 PR 时会新建 `PR<n>` 卡（`peer-pr-auto.md:37`）；E2b 的 PR 要挂到已有的 B 卡上，这是 B 侧收审要补的。
