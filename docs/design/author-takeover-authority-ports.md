# PMLPORT1：已结 peer 作者的本机正规接管——权威端口冻结前设计

> 状态：specRev 1 设计稿，仅文档。待另一家族完整设计审，再由 PM 定实施范围。涉及新增协议动作、签名用途或 MCP 工具的部分，还要 owner 另行批准。
> 本稿合入**不**授权：实现、启用新签名用途、真实接管任何卡、全局开关、模型额度，也不改变现有 take_order / deliver 门。
> 来源是 PMLOCAL1 的正式 block 与 ports-v1 提案。ports-v1 原件只在提案机保全，本轮没有外发。本文不引用它的字节、行号或段落，下面的现状全部按当前仓库 head 独立核对。需要原提案某段时，先走正规材料需求和外发闸。
> 全文只用字段名和合成标识，不含个人路径、生产记录、凭据、公钥或私钥材料，也不含会话正文。

## 0. 问题与边界

**目标。** 一张 build/fix 卡的写作者原本是出借方（peer）的 worker。该出借单已经结束（done/cancelled/released），PM 要让本机一个新作者会话**正规**接手这张卡。接手后要满足四条：

- 新作者通过原有 `take_order` 能领到单。
- 旧作者的 SID、订单和代数，都被现有门拒绝。
- 历史（旧绑定、archive/kill 回执、出借单、REBOR2/UPDW 的来源与被拒事实）一条不丢。
- 每一步都有可复核的权威来源。

**明确禁止的捷径**（现有代码都能做到，但都不算正规接管）：

| 捷径 | 现状为何可行 | 为何不算接管 |
|---|---|---|
| `ledger task-set --agent` / `ledger step write <新>` 改执行者 | `setTask`（`src/lib/ledger-write.ts`）只要 PM 加 rev CAS；`assignStep`（`src/lib/ledger-steps-write.ts`）只要 PM | 不核旧作者是否已停、有没有保全，也不核新作者身份。卡上没退役的作者绑定还在，`bindingAllows` 继续拒新作者（`src/lib/order-take.ts:58-62`） |
| 把旧绑定直接写成 `retired`（假退役） | `recordSessionRetirement` 只收收尾卡（`src/lib/scheduler-sessions.ts:143`）。手写 SQL 或借用别的 writer 能绕过 | 把行政替换伪装成生命周期退役，没有真实 archive/kill 回执。`bindingAllows` 遇到 retired 会当作“没有绑定”（`order-take.ts:60`），旧 agent 名只要还是步骤执行者就能领单 |
| `reclaimLend` 后直接本机做 | `reclaimLend`（`src/lib/ledger-lend.ts:315-335`）撤单、结束租约、把 `tasks.agent` 还原成借出前的值 | 只证明 A 侧撤了单，不证明 B 侧 worker 已退出。不处理 peer 作者的 `scheduler_sessions` 行，也没有保全证明 |
| 套用修复换会话 `applyFixReplacement` | 现有唯一的原子作者替换（`src/lib/fix-strategy-session.ts:12-47`） | actor 只能是 scheduler，只收 `fix_swap` 意图，只在 fix 阶段、auto 模式下工作，并且显式拒绝 `old.transport === "peer"`（`:28`，以及 `fix-strategy-lifecycle.ts:65`） |

**历史不补造。** 旧 REBOR2 链缺历史可信的退出或保全证明。按本设计，它仍然是 blocked，即使下面三张前置都实现了也一样。新端口只对实现之后新产生的事实生效，不从现有 note、正文或本机 journal 回填。

## 1. 现状核对：provider 终态、真实退出、WIP 保全（验收 1）

### 1.1 两本账，各自证明什么

- **B 侧 provider journal**：`src/lib/lend-journal.ts`，表 `lend_orders`，只存在出借方本机，A 读不到。
  - 状态见 `LendState` 与 `NEXT`（`:24-33`），每次推进都对“从哪个状态来”做 CAS。
  - 终态 `acked`、`stopped`、`cancelled` 只在 `finish()` 杀掉 worker 并确认窗口没了之后才写（`src/lib/lend-drive.ts:216-223`）。没确认退出就什么都不记，下一轮再停。
- **A 侧 ledger**：`src/lib/ledger-lend-schema.ts:19-27`，表同名 `lend_orders`。
  - 状态：`pooled | claimed | done | unknown | cancelled | released`。
  - 关键列：`leaseGen`、`supersedes`、`branch`，以及 `lend_write_leases(state held|ended, fp, prevAssignee*)`。

**关键区分：acked/done ≠ 原 SID/order/gen 已停止。**

- A 侧 `done` 只表示结论或交付已入账。
- B 侧 `acked` 表示 B 验过了 A 的回执。B 在写 `acked` 之前确实杀过 worker，但这个事实只在 B 的 journal 里，A 从来收不到。
- B 只在 `stopped` 时通知 A：`settleOrder` 发 `lease release` 加 `reason`（`lend-drive.ts:183-190`）。A 把它记成 note `{op:"release",reason:"stopped",gen}`，见 `ledger-lend.ts` 的 `leaseLend`。
- 结论：对 A 来说，“已 done 的出借单其 worker 已退出”**没有任何 canonical 字段**。

### 1.2 逐项端口：已存在 / 真实缺失

| # | 端口（A 侧需要的权威事实） | 现状 | 缺失的 canonical 字段 / 入口 |
|---|---|---|---|
| E1 | 原 order+gen 的 worker 已真实退出 | **部分存在**：`cleanExit()`（`src/lib/lend-reclaim-scheduler.ts:43-46`）只认两种来源。一是 B 的 clean cancel ack，dedup 键 `convergence-cancel:<orderId>`，带 `clean`、`gen`（`lend-reclaim-scheduler-ack.ts`）。二是 `stoppedReportSeq()`（`lend-reclaim-stopped.ts:14-24`），即撤单之前 B 自报的 `release stopped`。回收时用 `recordStoppedExits` 记成 `convergence_stopped_exit`。只有 CONV3 换家族路径会用它，而且要求 proto≥3 | `done` 单完全没有退出事实。`reclaimLend` 不等任何退出证明。B 的 `acked` 终态不回传 A。缺字段：`{orderId, gen, terminal: acked\|stopped\|cancelled\|released, workerAbsent: true, probedAt}` 这条 A 侧 canonical 事件，以及写入它的租约端点动作 |
| E2 | 原副本删除前的源码保全证明 | **只在 provider 本地、只在续借路径存在**：`preserveReborrowGit`（`src/lib/lend-reborrow-preserve.ts:17-61`）。它要求工作区干净，收集 HEAD、`refs/heads`、`refs/checkpoints`、`refs/stash`、reflog，逐个证明是新远端 head 的祖先，打 bundle 并 verify，写 `source.json`，前后各做一次快照防漂移 | `acked`/`cancelled` 在 `settleOrder` 里直接 `removeDir`（`lend-drive.ts:192-198`，`rmSync` 递归，不看 git 状态）。`stopped` 保留 24h 后同样删除（`lend-work-retention.ts`）。A 收不到 bundle 摘要。缺字段：`{bundleSha256, remoteHead, checkpoints[], clean: true, preservedAt}` 回传 A，以及 B 侧“删除前先保全”的顺序门 |
| E3 | 没有待转 payload、待回执、`sending` 中的消息 | **provider 本地存在**：`oldJournal()`（`lend-reborrow-provider.ts:18-29`）拒 `settle != null`、`submit === "sending"`，以及没有回执却带 `payload/work/payloadSha` 的行 | A 侧只有 `lend_orders.status` 和 `lend_relays`（`pending/sending/unknown`）。缺少 B 对“本单无待转结果”的声明，应并入 E1 那条事件 |
| E4 | 没有 unknown 结果 | **A 侧存在**：`LEND_LIVE = pooled/claimed/unknown`（`ledger-lend-schema.ts:15`），部分唯一索引 `lend_orders_live`。续借事实也拒（`lend-reborrow-facts.ts:47`） | 无缺口。接管直接复用 `LEND_LIVE` 判据 |
| E5 | 没有活 writer：A 侧没有未结步骤、意图、写租约 | **存在**：`captureReborrowFacts` 拒 `assigned` 步骤和 `pending/submitted/unknown` 意图（`lend-reborrow-facts.ts:48-50`）。`heldLease()`（`ledger-lend-lease.ts`）给出写租约 | 无缺口。复用这些判据，不另写 |
| E6 | 本机旧作者的真实停止 | **存在**：`stopConvergenceAuthor`（`fix-strategy-lifecycle.ts:63-89`）先 archive 后 kill，再按 registry 复读 `stopped && !pending && !window`（`scheduler-retire.ts:49`）。回执记在事件 `scheduler:<intent>:archive|kill` 上 | 只能由 `fix_swap` 意图驱动。本稿的 peer 场景不直接需要它，后续本机→本机的接管可以复用 |
| E7 | 代数与 fp 绑定 | **存在**：`leaseGen` 在 claim 时 +1（`ledger-lend.ts:389`），旧代数一律回 `stale_gen` / `stale_lease_gen`。`fp` 进入分支名 `lendBranch(task, fp)` | 本机会话没有代数，见 §2.4 |

### 1.3 协议与签名边界

- E1、E2 需要 B 主动向 A 报告新事实。可选路线有两条：

| 路线 | 做法 | 需要的批准 |
|---|---|---|
| **R-a（推荐）** | 走现有、已认证的租约端点请求（与 `release stopped` 同一条认证通道），新增一个动作，例如 `lease` 的 `action: "terminal"` | lend wire 协议升级（proto 门槛），属于**协议批准** |
| R-b | 让 B 用实例密钥对终态加保全摘要签名，便于第三方复核 | 在 `SIGN_PURPOSES`（`src/lib/instance-signature.ts:43`）新增一个用途，例如 `claudestra-lend-terminal-v1`，属于 **owner 批准**。本稿不启用，也不预占名字 |

- 推荐 R-a 的理由：A 只需要“B 对自己内部事实负责”，现有请求认证已经够用。
- R-b 只在 E2b 互认这类第三方复核需求出现时再提。任何新用途都要 owner 单独拍板，不能以本稿自批。
- 旧 peer（proto 不够的）没有 E1/E2 端口。对它们接管必须停在 PM 手动、blocked，不做降级放行。这与 CONV3 处理 proto<3 的方式一致（`lend-reclaim-scheduler.ts:81-83`）。

## 2. 新作者的身份与授权（验收 2）

### 2.1 可用的身份事实，以及不可信的来源

| 来源 | 内容 | 能否作为接管依据 |
|---|---|---|
| MCP 已验证调用 `VerifiedCall`（`src/lib/order-tool-route.ts:12-19`） | `agent` 是频道主人，凭据签给的就是他（`caller-identity.ts:47-58`） | **能**，只能经 `routeOrderTool` 的 `requireVerified` 进入 |
| `VerifiedCall.sessionId` | 取自 **registry 当前值**（`caller-identity.ts:55`），不是凭据签发时的 SID | **不能单独用**：它不代表历史，也会被 `/clear` 或线程轮转改掉 |
| `CredRecord.sessionId`（`caller-cred.ts:25-32`） | 启动时记录（fork 启动不记，见 `caller-cred-launch.ts:60`） | 能作为“本次接入代次”的锚，但**目前不进入 `CallerIdentity`**，是缺口 |
| LIFE1 `worker_agents`（`agent-lifecycle-schema.ts:8-11`） | `agent, sessionId, taskId, role, state` | **能**：建会话时由 `activateWorker` CAS 落定（`agent-lifecycle-store.ts:144-161`）。但现有 order 门**不读**它，是缺口 |
| body 里的 `verified:true`、自报 agent 或 SID、caller-witness | — | **一律不能**。witness 只是旁证（`caller-witness.ts` 头注释） |
| 共享台账任意写权限，或别处 registry 的当前 SID | — | **不能**代替本人接受 |

### 2.2 授权链：PM 精确授予 → 本人接受

**G：授予。** 授予人必须是 `isRealPmRole` 认定的真实 PM、master 或 owner（与 `requireRealPm` 同口径，排除 dispatcher）。授予写一条事件 `op: author_takeover_grant`，绑定以下字段：

- `grantId`：128 位随机 nonce 的 base64url 编码，与 `newInviteNonce` 同强度。
- 卡与版本：`taskId`、`task.rev`、`workflow.rev`、`specRev`、`stage`、`round`、`headSHA`、`branch`。
- 旧作者：`fromBinding = {agent, sessionId, transport, createIntentId}`。
- 终态来源：`source = {orderId, gen, terminalEventSeq, preservationDigest}`，即 §1 的 E1/E2 事件。
- 新作者：`to = {agent, sessionId, family}`。三项都必须等于该 agent 当前 LIFE1 行，且 `role = 'author'`、`taskId` 等于本卡。
- `expiresAt`：TTL 默认 1h，上限 24h。比 `resume-grant` 的 24h/72h 更短，因为接管窗口不应该长期开着。

**R：撤销。** 撤销写 `op: author_takeover_revoke`，带 `grantId`，只有授予人或其他真实 PM 能写。下列情况视同撤销，不必另写事件：

- 授予后卡、工作流、租约或出借单有任何漂移（§3.3 的 CAS 指纹变化）。
- 授予人不再是真实 PM，复核方式同 `stillRealPm`。

**A：本人接受。** 新作者本人通过一个新增的 MCP 派单工具 `accept_takeover`（暂名）接受。这个工具要经过 `routeOrderTool`。handler 检查：

1. 调用方 `agent` 等于 `to.agent`。
2. `call.sessionId` 等于 `to.sessionId`。
3. 凭据代次锚 `credSessionId`（新增字段）等于 `to.sessionId`，并且凭据签发时刻 `credIssuedAt` 早于授予时刻（授予后重签视为断线换代）。
4. LIFE1 行仍是 `active`，且不是 `cleanup_pending`。
5. `grantId` 等于台账中最新的、未撤销、未过期的授予。
6. 该授予还没有被接受过。

接受写事件 `op: author_takeover_accept`，dedup 键 `author-takeover:<grantId>:accept`，以 dedup 键唯一保证单用。重放同一 `grantId` 会命中 dedup 键，按“已接受”返回原结果，不产生第二次效果。用旧 nonce 一律拒绝。

**断线代次。** 新作者在授予后重启或重新签发凭据，会让 `caller-cred` 顶掉旧凭据（`replaceAgentCreds`）。此后 `credIssuedAt` 或 `credSessionId` 变化，接受被拒，要求 PM 按新 SID 重新授予。接受之后、提交之前（§2.3 的 T3）发生断线的，提交同样拒绝。

### 2.3 跨进程与异步窗口：哪些在同一事务，哪些不在

这里不用“同事务”掩盖网络或验证步骤。现有 ledger 写入都走 `tx()`，即 `BEGIN IMMEDIATE`（`ledger-tx.ts:13-15`）。下表中只有 T-COMMIT 是单一 SQLite 写事务。

| 步骤 | 位置 | 是否在事务里 | 失败或漂移时 |
|---|---|---|---|
| T0：B 报终态与保全（R-a 请求） | 跨机网络，然后 A 侧单事务写事件 | 网络不在事务里。写事件用自己的 `tx`，并对 `orderId+gen` 做 dedup | 没收到就没有事实，接管门保持关闭 |
| T1：PM 授予 | 一次 CLI 调用，单 `tx` | 是 | CAS 失败就拒绝，不写任何东西 |
| T2：新作者接受 | MCP 调用，先在 bridge 解析身份（读凭据库和 registry，**在事务外**），再进入单 `tx` 写接受事件 | 身份读取在事务外，写入在事务内 | 写入时在事务内重读 LIFE1 和授予。身份读和写之间如果凭据被顶掉，由 T-COMMIT 再核一次 |
| T3：提交前复核远端 | `git ls-remote` 核分支 head 等于授予时的 `headSHA`，与 `reclaimForFamilySwap` 的 `context.remoteHead` 做法相同。这一步是网络调用，**在事务外** | 否 | 不一致就停在“已接受、未提交”，不重试写入 |
| T-COMMIT：canonical supersession | 单 `tx`。先重算 §3.3 的全部 CAS 指纹，与 T1 记录的指纹比对，再重读凭据库，确认 `credIssuedAt` 与 `credSessionId` 未变 | 是 | 任一漂移就整体回滚。零新绑定，接受事件保留但标记为未消费 |

**凭据撤销时序**（只对本机旧作者适用，peer 旧作者在 A 侧没有凭据）：

1. 先在 T-COMMIT 中让旧绑定失去 current 地位。
2. 提交之后再调用 `revokeCallerCreds(old.agent)`。

第 2 步是写文件，不在事务里。即使它失败，旧会话在 `bindingAllows` 上也已经被新的 active 绑定拒绝；撤销只是加固，失败会记录并重试，不回滚提交。反过来，先撤销凭据再提交是不允许的：提交失败时，旧作者会被无故断开。

### 2.4 原 take_order / deliver 门保持不变

- 接管只改变门读到的**数据**：`task_steps` 的执行者、`tasks.agent`，以及唯一一条 active 作者绑定。门的**逻辑**不变。
- 新作者通过既有 `scanOrders`（执行者加 `bindingAllows`）领单。
- `deliver` 仍由 `currentOrders`（`order-deliver.ts:87`）和 `confirmOrderDelivery`（`ledger-autostart-resume.ts:92-106`，要求 active 绑定的 SID 等于调用方 SID）把关。
- 旧 SID 被拒的原因：active 作者行已换成新 SID，旧 agent 也已不是步骤执行者。
- 已知隐患：`bindingAllows` 把 retired 当作“没有绑定”。正因如此，接管提交必须**同时**写新的 active 行和新的执行者，不能只退役旧行。§4 的负例覆盖这一点。

## 3. canonical session writer、迁移与读口投影（验收 3）

### 3.1 分列语义

| 维度 | 记在哪里 | 谁写 |
|---|---|---|
| 生命周期退役（LIFE retired：进程收掉、磁盘清掉） | `worker_agents.state='retired'`，以及 `scheduler_sessions.archiveReceipt` / `killReceipt` | 只有生命周期（`recordWorkerRetire`）和收尾退役（`recordSessionRetirement`）。**接管不写** |
| 行政替换（superseded：这张卡的 current 作者换人） | 新表 `author_supersessions`，加上 `scheduler_sessions` 新增的可空列 `supersededBy` | 只有新的 canonical writer `supersedeAuthor` |

被替换的旧绑定行设为 `state='retired'`、`supersededBy=<supersessionId>`。`archiveReceipt` / `killReceipt` **保持原值**：peer 行本来就是 NULL，不伪造回执。

选择沿用 `retired` 加附加列，而不是给 `state` 新增一个 `superseded` 枚举值，原因有三：

1. 现有 CHECK 只允许 `active|retiring|retired`（`ledger-scheduler-schema.ts:58`）。加枚举值要重建整张表。
2. 部分唯一索引 `scheduler_sessions_current ... WHERE state != 'retired'`（`scheduler-sessions.ts:220`）和几十个 `state != 'retired'` 读口都依赖“非 retired 即 current”。新枚举值会让这些读口把被替换行误判为 current，造成双 writer。
3. 附加列是可空、加性的，旧读口不需要改就保持正确。

真 archive/kill 的历史照旧：旧 peer 会话的退出证明在 §1 的 E1 事件里，不复制成 `killReceipt`。

### 3.2 迁移

- 一条加性迁移，追加到 `LEDGER_MIGRATIONS` 末尾（`ledger-store.ts:144-147`），规矩同 `sqlite-migrate.ts`：每步可重跑，一条语句一次 `prepare().run()`。内容：
  - `CREATE TABLE IF NOT EXISTS author_supersessions (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), project TEXT NOT NULL, grantId TEXT NOT NULL UNIQUE, intentId TEXT NOT NULL REFERENCES scheduler_intents(id), fromAgent TEXT NOT NULL, fromSessionId TEXT NOT NULL, fromTransport TEXT NOT NULL, toAgent TEXT NOT NULL, toSessionId TEXT NOT NULL, toFamily TEXT NOT NULL, sourceOrderId TEXT NOT NULL, sourceGen INTEGER NOT NULL, sourceEventSeq INTEGER NOT NULL, preservationDigest TEXT NOT NULL, fingerprint TEXT NOT NULL, actor TEXT NOT NULL, createdAt INTEGER NOT NULL)`
  - 先查 `PRAGMA table_info`，没有该列时再执行 `ALTER TABLE scheduler_sessions ADD COLUMN supersededBy TEXT`。
  - 同步更新 `REQUIRED_COLUMNS`、`SCHEDULER_COLUMNS`。
- 新绑定行的 `createIntentId` 有外键约束，指向 `scheduler_intents`。T-COMMIT 在同一事务内插入一条接管意图，`action='author_takeover'`，`status` 直接为 `done`，`receipt` 填 supersession id。`action` 列没有 CHECK（`ledger-scheduler-schema.ts:19-28`）。意图以 `done` 落地，不会卡住 `captureReborrowFacts` 和收尾退役的“没有未结意图”判据。
- 第一次替换前调用 `preserveSessionHistory`，把主键放宽到 `(taskId, role, sessionId)`，与 fix swap 和 reviewer swap 的做法相同。
- 版本兼容：
  - 旧代码打开新库：多出的列和表被忽略。旧代码只会看到 `retired` 加一条新 active 行，判断依然正确。
  - 新代码打开旧库：表不存在时视为“从未接管”。
  - 回滚到旧版本不需要反向迁移。

### 3.3 writer：`supersedeAuthor(db, ctx, acceptId)`，单一 `tx`

**CAS 指纹**沿用 `captureReborrowFacts` 加 `assertReborrowCas` 的模式（`lend-reborrow-facts.ts:25-74`），在 T1 记录，在 T-COMMIT 重算。覆盖范围：

- 卡的完整行，工作流行，`task_steps`；
- 本卡全部 `lend_orders`，`lend_write_leases`；
- 本卡未结 `scheduler_intents`；
- 当前作者绑定行；
- 新作者的 LIFE1 行；
- E1/E2 事件的 seq。

**前置条件**（任一不满足就整体回滚）：

1. `grant` 和 `accept` 事件存在、彼此匹配、`now < expiresAt`、没被撤销，授予人仍是真实 PM。
2. 指纹与 T1 一致。
3. 卡在 build/fix；没有 `LEND_LIVE` 单；写租约已 `ended`，或由本 writer 在同一事务内 `endWriteLease`，原因写 `author_takeover:<id>`。
4. 旧绑定行就是 `fromBinding`，且仍是 current（非 retired）。
5. E1 的 `orderId/gen` 等于这张卡最后一张写单的 `orderId` 和 `leaseGen`，且 `terminal` 不是“未知”；E2 的 `remoteHead` 等于 `task.headSHA`。
6. LIFE1 新作者行仍 active，`sessionId` 等于 `to.sessionId`；凭据锚未变。
7. `to.family` 等于 `workflow.authorFamily`，或者授予里显式写了换家族（换家族另需 CONV 规则，不在本稿默认范围）。

**效果**（与 `applyFixReplacement` 同一组投影，不另造 binding）：

- 旧行：`state='retired'`、`supersededBy=id`、`retireIntentId=接管意图`，`updatedAt` 更新。
- 插入新的 active 作者行（`transport` 取 `acp` 或 `tmux`，`createIntentId` 为接管意图）。
- `updateTask`：`agent`、`assignee`、`assigneeKind` 改为新作者。
- 当前 round 的 `write|fix` 步骤：执行者改为新作者，`executorKind='agent'`，状态 `assigned`。
- 插入 `author_supersessions` 行。
- 写事件 `op: author_takeover`，dedup 键 `scheduler:<intentId>:takeover`。

**幂等与竞争：**

- 同一 `grantId` 第二次提交命中 `author_supersessions.grantId UNIQUE` 或 dedup 键，返回已有结果。
- 两个并发提交由 `BEGIN IMMEDIATE` 串行化，后到者的指纹已经变化，被拒。
- 部分唯一索引 `scheduler_sessions_current` 是最后一道防线：任何路径想再插一条非 retired 作者行，都会撞约束回滚。

**不散抄 SQL。** 新 writer 放在 `scheduler-sessions.ts` 旁边，通过 `tx` 和 `insertEvent` 写入。旧行改写与新行插入的四条语句，应和 `applyFixReplacement` 抽成一个共用的内部函数（例如 `replaceAuthorRow`），两条路径共用。这要扩大到 `fix-strategy-session.ts`，属于 **PM 精确扩围**项；扩围没批时，新 writer 自带这四条语句，并在注释里指向对方，等后续合并。

### 3.4 需要改动的读口，以及范围

只有标为“改”的读口进入实现范围，其余列出“核对后不改”的理由。

| 读口 | 判定 | 范围 |
|---|---|---|
| `taskSessionLinks`（`scheduler-sessions.ts:62-69`）→ `ledger-read.ts` 详情 | **改** | 链接增加 `supersededBy` 或 `endKind: 'superseded' \| 'retired'`，用于展示；约 6 行 |
| `review-evidence-collect.ts`（经 `getSchedulerSession` 取作者会话） | **核对，可能要改** | 它只取当前行；接管后较早轮次的证据可能被归到新作者。需要按轮次时间取当时 current 行，并标出被替换的行；约 8 行 |
| `remoteHeadFamily`（`scheduler-head-family.ts:11-17`），被交叉家族审查读取 | 核对后不改 | 它取最近一次带 head 的交付；本机新作者交付后自然变为 null，回到 `workflow.authorFamily`。接管到首次本机交付之间，head 仍然是 peer 写的，按 peer 家族审查正确 |
| `scheduler-agent-pool-ledger.ts:46`（任何状态的作者行都算有作者） | 核对后不改 | 被替换的行仍然代表“这张卡曾有作者”，语义正确 |
| `scheduler-retire-owner.ts:71`（任何状态都算 session 管理） | 核对后不改 | 被替换的本机 agent 仍归 session 步骤收尾，语义正确；peer 行在本机没有进程 |
| `RetireRun.run`、`retireCandidates`、`agentStillInUse`（`scheduler-retire.ts`） | 不改 | 只看非 retired，被替换行自然排除。本机被替换会话的真实收尾走 LIFE 生命周期，不由接管伪造 |
| `bindingAllows`、`currentOrders`、`confirmOrderDelivery` | **不改**（验收 2 要求门不变） | 接管只改它们读到的数据 |
| `getSchedulerSession` 排序、`taskWorkerRefs`、`cardWorkerIndex` | 不改 | 唯一 current 行由部分唯一索引保证 |
| `mayRebindReviewer`、`swappedSession`（`scheduler-review-swap.ts`） | 不改 | 只看审查角色 |
| `usage-attr.ts:205`（全部行） | 不改 | 按 SID 归因，历史行照常计入 |
| 意图读口：`scheduler-agent-pool-ledger.ts:30` 等按 `action` 过滤处 | 核对 | 新 `action='author_takeover'` 生来就是 `done`，不进入任何“未结意图”集合；实现时用 grep 确认没有“未知 action 就报错”的读口 |

## 4. 三张实现前置卡（验收 4）

行数是新模块或改动行的上限预算，不含测试。fileGlobs 是候选，最终由 PM 精确核定。

### P-A：provider 终态来源（E1 + E2 + E3）

- **内容**：
  - B 侧在 `finish()` 与 `settleOrder` 的 `removeDir` **之前**插入保全：
    - 写单或修复单在 `acked`/`cancelled` 时，复用 `preserveReborrowGit` 的快照、祖先和 bundle 逻辑，抽成通用的 `preserveOrderGit`。
    - 工作区不干净或保全失败时，不删目录，并把终态报告标记为 `preservation: failed`。
  - 然后经 R-a 的新 `lease` 动作 `terminal` 向 A 报告 `{orderId, gen, terminal, workerAbsent, pendingPayload:false, preservation:{bundleSha256, remoteHead, checkpoints}}`。
  - A 侧租约端点校验 `gen === leaseGen`、peer 和 fp 匹配，按 `lend-terminal:<orderId>:<gen>` 去重，写 canonical 事件。
- **新模块**：
  - `src/lib/lend-terminal-report.ts`（B 侧组装与发送，≤90 行）
  - `src/lib/ledger-lend-terminal.ts`（A 侧校验与入账，≤90 行）
  - `src/lib/lend-order-preserve.ts`（从续借保全抽出的共用核心，≤70 行；`lend-reborrow-preserve.ts` 改成薄调用，净减行数）
- **薄接线**：`lend-drive.ts` 的 `finish`/`settleOrder`（≤15 行）；A 侧租约路由加一个分支（≤10 行）。
- **fileGlobs**：上述新文件、`src/lib/lend-drive.ts`、`src/lib/lend-reborrow-preserve.ts`、A 侧租约端点所在文件（实现前由 PM 精确点名），以及 `tests/lend-terminal-*.test.ts`。
- **依赖**：lend wire 协议升级需要 **owner 和协议批准**。不新增签名用途。
- **负例**：
  - 工作区有未提交改动；保全前后快照漂移；远端 head 不符；
  - `gen` 过期，错误 fp 或 peer；
  - `submit==='sending'`，或待转 payload 存在；
  - worker 仍在运行或探测为 `unknown`；
  - 重复报告内容不一致（回 `dedup_mismatch`）。
  - 以上都只产生“不可接管”的事实或拒绝，不产生 E1/E2 事件。
- **正例**：干净 acked 写单 → 先保全、再删目录 → A 得到一条事件；同一报告重发结果相同，幂等。
- **版本兼容**：旧 peer 不发 `terminal`，A 侧不会有事件，接管门保持关闭。旧 A 收到未知动作回 `invalid`，B 记日志，不重试降级。

### P-B：本人接受（G、R、A）

- **内容**：PM CLI `ledger author-takeover-grant` / `--revoke`，新 MCP 派单工具 `accept_takeover`，`CallerIdentity` 增加 `credSessionId`、`credIssuedAt`（只读、取自凭据记录）。
- **新模块**：
  - `src/lib/author-takeover-grant.ts`（授予、撤销与校验，≤110 行）
  - `src/lib/author-takeover-accept.ts`（接受 handler 的纯逻辑，≤80 行）
- **薄接线**：
  - `caller-identity.ts` 两个字段（≤8 行）；`order-tool-route.ts` 的 `VerifiedCall` 透传（≤4 行）；
  - `bridge/order-tools.ts` 注册工具（≤10 行）；manager 命令（≤30 行）。
- **fileGlobs**：上述文件、`src/lib/caller-identity.ts`、`src/lib/order-tool-route.ts`、`src/bridge/order-tools.ts`、对应 manager 命令文件，以及 `tests/author-takeover-*.test.ts`。
- **依赖**：P-A 的事件格式（授予要绑定 `source`）。新增 MCP 工具会改变派单工具面，需 **PM 精确扩围**；如果要把工具开放给出借 worker，需 **owner 批准**。
- **负例**：
  - 非真实 PM 授予（含 dispatcher）；body 里写 `verified:true`；未验证调用；
  - 错误 agent、SID 或 family；LIFE1 行缺失、retired 或 `cleanup_pending`；`role` 不是 `author`，或 `taskId` 不符；
  - 授予过期或已撤销；旧 nonce，或第二次接受（第二次接受返回幂等结果，不产生新效果）；
  - 授予后凭据被重新签发；`credSessionId` 为空（fork 启动）。
- **正例**：真实 PM 授予 → 本人在 TTL 内经已验证调用接受 → 只出现一条接受事件。
- **版本兼容**：旧 bridge 没有这个工具，接受无法进行，接管门保持关闭。`CallerIdentity` 新字段对旧调用方透明。

### P-C：canonical supersession（§3）

- **内容**：迁移、`supersedeAuthor` writer、T3 远端核验加 T-COMMIT、§3.4 中标为“改”的读口、提交后的凭据撤销（只针对本机旧作者）。
- **新模块**：
  - `src/lib/author-supersession.ts`（writer 与指纹，≤140 行）
  - `src/lib/author-supersession-schema.ts`（≤30 行）
- **薄接线**：
  - `ledger-store.ts` 迁移列表与必需列（≤8 行）；
  - `scheduler-sessions.ts` 的 `taskSessionLinks`（≤6 行）；
  - `review-evidence-collect.ts`（≤8 行，核对后才动）；
  - 可选扩围：与 `fix-strategy-session.ts` 共用 `replaceAuthorRow`（≤20 行净改）。
- **fileGlobs**：上述文件，以及 `tests/author-supersession*.test.ts`、`tests/order-take*.test.ts`（只加新用例）。
- **依赖**：P-A 与 P-B 合入。
- **负例**（每条都断言零新绑定：作者行数不变、`tasks.agent` 不变、执行者不变、无 `author_takeover` 事件）：
  - 原 peer 单仍活或 `unknown`；B 结果待回执；错误 fp、gen 或 SID；
  - 有未交检查点（E2 缺失或 `preservation: failed`）；伪造的保全摘要与远端 head 不符；
  - 冒充的新作者、错误家族、过期授予、旧 nonce；
  - 两个提交并发（第二个回滚）；授予后任一来源漂移（指纹不同）；
  - 事务中途失败（注入抛错 → 全部回滚，包括接管意图和 `author_supersessions` 行）。
- **正例**：必须是**真实的临时 canonical 集成**，用临时 ledger、真实迁移和真实 writer。依次执行：
  1. 种一张 peer 作者卡，出借单 done，入账 E1/E2；
  2. PM 授予；
  3. 用 LIFE1 登记的新作者以已验证调用接受；
  4. 提交。
  - 断言：
    - 现有 `takeOrderResult` 对新作者的 `VerifiedCall` 返回这张卡的单；
    - 对旧 peer agent 的 SID 和对同名新 SID 以外的会话都返回空；
    - `deliver` 的 `currentOrders` 同样只认新 SID。
  - 不允许用专门写的测试 helper 直接改表来“证明”。
- **版本兼容**：见 §3.2。

## 5. 负例总表（验收 5）

以下情况全部为零新绑定效果；每条在 §4 都对应到具体的前置卡。

- 接管不是换模型或换家族的通道。provider 的策略拒审（`refusal`，见 MODELX 的拒审纪元）不能借接管绕过：授予要求 `to.family === workflow.authorFamily`，换家族只能走 CONV 规则加对应批准。
- 原作者仍活、`unknown`、结果待回执，或 fp、gen、SID 不符。
- 有未交检查点、假保全，或保全失败后仍删了目录（P-A 改了顺序，先保全后删除）。
- 冒充的新作者、错误家族、过期授予、旧 nonce、二次接受、授予后重启。
- 并发双 writer：`BEGIN IMMEDIATE`、指纹和部分唯一索引三层兜底。
- 任一来源漂移：卡、工作流、步骤、出借单、租约、意图、绑定、LIFE1 行、E1/E2 事件。
- 事务失败：整体回滚。外部效果（凭据撤销）只在提交之后做。

## 6. 现有能力与缺口一览（验收 6）

| 能力 | 现状 | 本稿处理 |
|---|---|---|
| A 侧活单、unknown、未结意图的判据 | 有（`LEND_LIVE`、`captureReborrowFacts`） | 复用 |
| 本机旧作者 archive/kill | 有（`stopConvergenceAuthor`） | 本稿不需要；后续本机→本机接管可复用 |
| peer 已停的 A 侧证据 | 只有 CONV3 的 `cleanExit`，且只覆盖撤单和自报停 | P-A 补“已 done 单的退出加保全” |
| 删除前保全 | 只有续借路径在 B 本地做 | P-A 推广到所有写单终态，并把摘要回传 A |
| PM 授予、TTL、单用 | `resume-grant` 有 TTL，单用是隐式的；`ask-bind` 被注明不是安全边界 | P-B 新建显式授予与接受 |
| 新作者历史身份 | `VerifiedCall.sessionId` 是 registry 当前值；LIFE1 不进门 | P-B 加凭据锚，接受时核 LIFE1 |
| 行政替换和退役分列 | 没有；fix swap 和 CONV3 回收都只写 `retired` | P-C 增加 `supersededBy` 和 `author_supersessions` |
| 旧 WIP 不丢 | B 侧 `acked/cancelled` 直接删目录 | P-A 改顺序；历史上已删的不补造（REBOR2 仍 blocked） |

**验证边界。** 本稿合入前要做三件事：另一家族完整设计审、当前 head 的 CI 三项、`bun run check` / guard。本稿只是设计输入：

- 最终实施范围（尤其 §3.3 的共用 writer 扩围和 §3.4 中“核对，可能要改”的读口）由 PM 精确核定。
- §1.3 的协议升级和任何签名用途，以及 P-B 的工具开放范围，由 owner 另行批准。
- 本稿不自批任何一项。
