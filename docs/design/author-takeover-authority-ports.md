# PMLPORT1：已结 peer 作者的本机正规接管——权威端口冻结前设计

> 状态：specRev 1 设计稿第 8 版（第 2 版按第 1 轮 6 条 P1 修订：凭据代次线性化、peer 派单投影、retention 保全入口、family 来源、工具定义接线、共用 writer 必选；第 3 版按第 2 轮 2 条 P1 修订：registry SID 轮转并入 ledger 接入代次（§2.3），A 侧 `lend_relays` 未结状态纳入前置与 CAS（§1.2 E3、§3.3）；第 4 版按第 3 轮 2 条 P1 修订：全部 registry 文件发布收拢到 ledger 写锁内按代次行覆盖 SID，挡住过时快照的整份写回（§2.3）；relay 解决改为按台账序号绑定 E1，删除与 `updatedAt` 比较的不等式（§3.3 前置 8）；第 5 版按第 4 轮 P1/P2 修订：SID 轮转拆成只写 ledger 的 T-rot 与之后的 T-pub，删除失锁后的补偿写，新增 `publishedEpoch` 作为 T2 与 T-COMMIT 共核的权威阻断状态，`publishRegistry` 移到 `src/lib/`（§2.3、§4 P-B）；第 6 版按第 5 轮 P1 修订：区分“轮转未提交”与“轮转已提交、尚未发布”，ACP 宿主按 ledger 而非 registry 判定接回哪条线程，新增只能由轮转发起方本人解除的 `confirmPendingSidEpoch`，ACP 与 bridge 认领路径的接线、行预算和负例列入 P-B（§2.3、§4 P-B）；第 7 版按第 6 轮 P1 修订：SID 提议代次 `sidEpoch` 与接入代次 `epoch` 拆开，确认改为由持 ledger 当前凭据的宿主按 `sidEpoch` 认领，凭据换代不再让待确认的提议无法确认（§2.3、§4 P-B）；第 8 版按第 7 轮 P1 与 PM 13:02 收口补 canonical stdin 端口：确认凭据只经共享 runner `runManagerProcess` 新增的可选 `input` 交付，P-B 列入 `src/lib/run-manager.ts` 的候选预算、fileGlobs 与 T1–T5 验收（§2.3、§4 P-B）），仅文档。待另一家族完整设计审，再由 PM 定实施范围。涉及新增协议动作、签名用途或 MCP 工具的部分，还要 owner 另行批准。
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
| E3 | 没有待转 payload、待回执、`sending` 中的消息 | **B 侧（provider 本地）存在**：`oldJournal()`（`lend-reborrow-provider.ts:18-29`）拒 `settle != null`、`submit === "sending"`，以及没有回执却带 `payload/work/payloadSha` 的行。**A 侧**：`lend_relays`（`ledger-lend-relay-schema.ts:7`，状态 `pending/sending/sent/refused/dropped/failed/unknown`）记 A→B 的规格追加、复述答复与给本机复述会话的 note。订单离开 `claimed` 后，`scanRelays` 只把非 note 的 `pending` 改成 `dropped`，`sending` 超时改成 `unknown`，`unknown` 原样留着（`ledger-lend-relay.ts:175-181`）；note 的 `pending` 不受订单状态影响，仍会被 `takeRelays` 发出（`:190`）。`captureReborrowFacts` 不读 `lend_relays` | 两处缺口，分开记：① B 对“本单无待转结果”的声明，并入 E1 事件（`pendingPayload:false`）——它**只证明 B 本地**，不能代替 A 侧发送结果。② A 侧 `unknown` 没有任何权威解决入口：只发 PM 通知“请核对后手动转”，没有记录核对结论的 canonical 字段。缺：`lend_relay_resolutions` 行与真实 PM 写它的入口（§3.3 前置 8、§4 P-A）。A 侧哪些状态算已结、哪些挡接管，见 §3.3 前置 8 |
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
| `VerifiedCall.sessionId` | 取自 **registry 当前值**（`caller-identity.ts:55`），不是凭据签发时的 SID | **不能单独用**：它不代表历史，也会被 `/clear` 或线程轮转改掉。registry 的 SID 由若干 manager 路径直接写文件（`set-session.ts:23-27` 等，全集见 §2.3），只拿 registry 自己的写法，与 ledger 事务不同步，且**不推进凭据、不改 LIFE1**。`requireSessionIdentity`（`scheduler-session-identity.ts:10-21`）只核家族、完整名和 worker 种类，**不核 SID**。所以接管不能靠事务内重读 registry 或重跑它来确认 SID，SID 必须并入 §2.3 的 ledger 接入代次 |
| `CredRecord.sessionId`（`caller-cred.ts:25-32`） | 启动时记录（fork 启动不记，见 `caller-cred-launch.ts:60`） | 只是旁证。凭据存储 `caller-creds.json` 是文件，撤销与重签只拿它自己的文件锁（`caller-cred.ts:56-69`），不参加 ledger 的 `BEGIN IMMEDIATE`，所以**不能**在 ledger 事务里当代次锚，见 §2.3 |
| `CredRecord.family`（`caller-cred.ts:28-29`） | 签发时 registry 的 runtime：`claude-code` / `codex` / `pi` | **能作为家族来源之一**，经 `runtimeFamily`（`scheduler-auto-review.ts:20-21`：`claude-code` 或缺省 → `claude`，`codex` → `codex`，其余 → null）映射。`VerifiedCall.family` 是 registry **当前** runtime（`caller-identity.ts:55-56`），两者都要核 |
| LIFE1 `worker_agents`（`agent-lifecycle-schema.ts:8-11`） | `agent, sessionId, taskId, role, createdAt, state, reason`，**没有 family 列** | **能，但只证明** SID、role、taskId 与注册代次（主键 `agent+createdAt`）。建会话时由 `activateWorker` CAS 落定（`agent-lifecycle-store.ts:144-161`）。现有 order 门**不读**它，是缺口。家族不从 LIFE1 取 |
| body 里的 `verified:true`、自报 agent 或 SID、caller-witness | — | **一律不能**。witness 只是旁证（`caller-witness.ts` 头注释） |
| 共享台账任意写权限，或别处 registry 的当前 SID | — | **不能**代替本人接受 |

### 2.2 授权链：PM 精确授予 → 本人接受

**G：授予。** 授予人必须是 `isRealPmRole` 认定的真实 PM、master 或 owner（与 `requireRealPm` 同口径，排除 dispatcher）。授予写一条事件 `op: author_takeover_grant`，绑定以下字段：

- `grantId`：128 位随机 nonce 的 base64url 编码，与 `newInviteNonce` 同强度。
- 卡与版本：`taskId`、`task.rev`、`workflow.rev`、`specRev`、`stage`、`round`、`headSHA`、`branch`。
- 旧作者：`fromBinding = {agent, sessionId, transport, createIntentId}`。
- 终态来源：`source = {orderId, gen, terminalEventSeq, preservationDigest}`，即 §1 的 E1/E2 事件。
- 新作者：`to = {agent, sessionId, lifeCreatedAt, family}`，各项来源分开核：
  - `agent`、`sessionId`、`lifeCreatedAt`：等于该 agent 当前 active 的 LIFE1 行（`role = 'author'`、`taskId` 等于本卡、不是 `cleanup_pending`）。`lifeCreatedAt` 锁定注册代次，同名重建会换代。
  - `sessionId` 还必须在授予事务内等于 `caller_access_epochs` 中该 agent current 行的 `sessionId`（§2.3）。LIFE1 的 `sessionId` 是注册时的 SID，轮转不改它；两者不等说明注册后已轮转过，授予闭合失败（不以任一侧补另一侧），需重建会话再授予。同一行处于阻断状态（`publishedEpoch < epoch` 或 `confirmPendingSidEpoch IS NOT NULL`，§2.3）时也拒绝授予（第 7 版新增），授予只能在提议确认之后发出。
  - `family`：LIFE1 没有这一列，不从 LIFE1 取，也不从 body 补值。授予时由 PM 指定，取值只能是 `claude` 或 `codex`，并且必须等于 `workflow.authorFamily`（换家族不在本稿默认范围）。本人接受时再与接入代次行登记的家族、registry 当前 runtime 的映射比对（§2.2 A 第 4 条），三者一致才算数。
- `expiresAt`：TTL 默认 1h，上限 24h。比 `resume-grant` 的 24h/72h 更短，因为接管窗口不应该长期开着。

**R：撤销。** 撤销写 `op: author_takeover_revoke`，带 `grantId`，只有授予人或其他真实 PM 能写。下列情况视同撤销，不必另写事件：

- 授予后卡、工作流、租约或出借单有任何漂移（§3.3 的 CAS 指纹变化）。
- 授予人不再是真实 PM，复核方式同 `stillRealPm`。

**A：本人接受。** 新作者本人通过一个新增的 MCP 派单工具 `accept_takeover`（暂名）接受。这个工具要经过 `routeOrderTool`。handler 检查：

1. 调用方 `agent` 等于 `to.agent`。
2. `call.sessionId` 等于 `to.sessionId`，**并且**在接受事务内等于 `caller_access_epochs` 中该 agent current 行的 `sessionId`（§2.3）。registry 只会落后于 ledger、不会领先（先 ledger 后文件），所以 bridge 在事务外读到的旧 SID 与事务内的新代次 SID 不等时必拒。同一行还须 `publishedEpoch = epoch` 且 `confirmPendingSidEpoch IS NULL`（第 5、6 版新增，§2.3）：registry 尚未确认发布到当前代次，或运行时尚未确认接上当前 SID 时，一律拒绝，不靠比对文件内容推断。
3. 接入代次：调用连接所持凭据的代次标签 `credTag`（新增，见 §2.3 的接入代次表）等于 ledger 里该 agent current 行的 `credTag`，且该行的 `epoch` 推进时刻 `updatedAt` 早于授予时刻。授予后重签凭据或轮转 SID 都会推进代次，拒绝。
4. 家族：`runtimeFamily(接入代次行登记的 family)`、`runtimeFamily(call.family)`（registry 当前 runtime）与 `to.family` 三者相等。`pi` 等映射为 null 的 runtime 一律拒绝。
5. LIFE1 行就是 `to` 记录的那一行（`agent + lifeCreatedAt`），仍是 `active`，且不是 `cleanup_pending`。
6. `grantId` 等于台账中最新的、未撤销、未过期的授予。
7. 该授予还没有被接受过。

第 2（与代次行比对的部分）、3、5、6、7 条在接受的写事务内读 ledger 判定（接入代次表也在 ledger 里）；第 1、2、4 条的调用方事实来自 bridge 的已验证身份。接受事件冻结 `{accessEpoch, sessionId, family, lifeCreatedAt}`。

接受写事件 `op: author_takeover_accept`，dedup 键 `author-takeover:<grantId>:accept`，以 dedup 键唯一保证单用。重放同一 `grantId` 会命中 dedup 键，按“已接受”返回原结果，不产生第二次效果。用旧 nonce 一律拒绝。

**断线代次。** 新作者在授予后重启、重新签发凭据，或经 `/clear`、ACP 线程轮转、收编、fork 自愈换了 SID，都会先在 ledger 里推进接入代次，再改凭据文件或 registry（§2.3）。此后第 2、3 条不成立，接受被拒，要求 PM 按新 SID 重新授予。接受之后、提交之前发生的换代（含只轮转 SID、不重签凭据的 `/clear`），由 T-COMMIT 在它自己的 ledger 事务里核代次并回滚。

### 2.3 跨进程与异步窗口：哪些在同一事务，哪些不在

这里不用“同事务”掩盖网络或验证步骤。现有 ledger 写入都走 `tx()`，即 `BEGIN IMMEDIATE`（`ledger-tx.ts:13-15`）。网络调用与 bridge 的身份解析都在事务外；T1、T2、T-COMMIT 各是一个**独立**的 SQLite 写事务，彼此之间只靠 CAS 指纹和 ledger 接入代次衔接，不是同一事务。

| 步骤 | 位置 | 是否在事务里 | 失败或漂移时 |
|---|---|---|---|
| T0：B 报终态与保全（R-a 请求） | 跨机网络，然后 A 侧单事务写事件 | 网络不在事务里。写事件用自己的 `tx`，并对 `orderId+gen` 做 dedup | 没收到就没有事实，接管门保持关闭 |
| T1：PM 授予 | 一次 CLI 调用，单 `tx` | 是 | CAS 失败就拒绝，不写任何东西 |
| T2：新作者接受 | MCP 调用，先在 bridge 解析身份（读凭据文件和 registry，**在事务外**），再进入单 `tx` 写接受事件 | 身份读取在事务外，代次与授予判定在事务内 | 事务内读 ledger 接入代次表、LIFE1、授予。身份读和写之间如果凭据换代或 SID 轮转，代次表已先推进（见下），`credTag` 或 `sessionId` 对不上，事务内即拒 |
| T3：提交前复核远端 | `git ls-remote` 核分支 head 等于授予时的 `headSHA`，与 `reclaimForFamilySwap` 的 `context.remoteHead` 做法相同。这一步是网络调用，**在事务外** | 否 | 不一致就停在“已接受、未提交”，不重试写入 |
| T-COMMIT：canonical supersession | 单 `tx`。重算 §3.3 的全部 CAS 指纹并与 T1 比对；核 ledger 接入代次表中 `to.agent` 的 current 行：`epoch` 等于接受事件冻结的 `accessEpoch`，`sessionId` 等于冻结的 `sessionId`（即 `to.sessionId`），`publishedEpoch` 等于 `epoch`，`confirmPendingSidEpoch` 为 NULL（`sidEpoch` 不另比：SID 轮转同时推进 `epoch`）；在事务内重跑 `requireSessionIdentity` 只为复核家族、完整名与 worker 种类——它**不核 SID**，不能当 SID 依据 | 是。**不读凭据文件，也不以 registry 文件的 SID 为准**，接入代次（凭据与 SID）的权威在 ledger 里 | 任一漂移就整体回滚。零新绑定，接受事件保留但标记为未消费 |

**接入代次的线性化（第 2 版修凭据，第 3 版并入 SID）。** 上一稿让 T-COMMIT 在事务里重读 `caller-creds.json`。这挡不住竞态：撤销与重签只拿文件锁（`caller-cred.ts:56-69`），该锁拿不到时还会降级放行（`file-lock.ts` 头注释），与 ledger 的 `BEGIN IMMEDIATE`（`ledger-tx.ts:13-14`）互不同步。提交进程重读成功之后，另一进程仍可完成撤销，前者再提交，等于换代后仍落新绑定。第 2 版改为把可撤销代次纳入 ledger，让同一把 SQLite 写锁定序。第 2 轮审查又指出同样的窗口在 SID 上也存在：`/clear` 经 `set-session` 只改 registry 的 `sessionId`（`set-session.ts:23-27`），不重签凭据、不改 LIFE1，第 2 版的代次不动，`requireSessionIdentity` 也不核 SID，于是接受 SID-a、轮转到 SID-b 之后 T-COMMIT 仍会把 SID-a 写成 active，之后真实调用报 SID-b，`bindingAllows`（`order-take.ts:58-62`）拒，新本人拿不到单。在 ledger 事务里重读 registry 文件同样挡不住文件写入的并发窗口。第 3 版把 SID 也并入同一代次：

- 新表 `caller_access_epochs(agent TEXT PRIMARY KEY, epoch INTEGER NOT NULL, credTag TEXT, family TEXT, sessionId TEXT, publishedEpoch INTEGER, sidEpoch INTEGER NOT NULL, confirmPendingSidEpoch INTEGER, issuedAt INTEGER, updatedAt INTEGER NOT NULL)`。`publishedEpoch` 是 registry 文件已确认发布到的代次（第 5 版新增，见下文 T-pub）。`sidEpoch` 是 SID 代次，只由 T-rot 推进，凭据换代不动它（第 7 版新增）。`confirmPendingSidEpoch` 非 NULL 表示 `sidEpoch` 等于它的那一代 SID 由运行时**提议**、运行时还没确认已接上它（第 6 版新增，第 7 版改为按 `sidEpoch` 记，见下文“提议式轮转”）。`credTag` 是凭据哈希再加域分隔的派生摘要（`sha256("claudestra-cred-epoch-v1:" + credHash)`），不存凭据明文，也不存原哈希；撤销后 `credTag = NULL`。`sessionId` 是该 agent 在 registry 里**将要**成为、或已经是的官方 SID。
- 推进代次的事件有两类，`epoch + 1` 一律只在 ledger 里做：
  - **凭据**：签发、撤销（`caller-cred.ts` 的 `issueCallerCred` / `revokeCallerCreds`）。
  - **SID**：任何**有意**改写 registry 里某 agent `sessionId` 的路径。按当前源码逐个核对，全集是：`set-session.ts:25-26`（被 `bridge/clear-rotation.ts:40` 的 `/clear` 认领、`acp-host.ts:140` 的 ACP 线程轮转、`bridge/session-heal.ts` 的自愈调用）；`manager.ts` 的 `cmdAdopt`（`:1138`）；`restart` 的 fork 自愈回写（`:1392-1393`）；create/resume 整条重写 agent 记录（`:912-933`，同名换 SID 时）。这些路径改为都经一个新的薄 helper `commitRegistrySession(name, newSid, mutate)`，不再各自直接赋值。
- **只管有意改 SID 的路径不够（第 4 版，修第 3 轮 sid-rotate）。** registry 是整份 JSON 文件，`saveRegistry`（`src/manager/core.ts:146-155`）的注释自己写明不消除跨进程读-改-写的 lost update。任何拿着旧快照整份写回的写者，都会在不赋 `sessionId` 的情况下把 SID 改回旧值，例如 `cmdAgentLabel`（`src/manager/agent-external.ts:31-35`）：先读到 SID-a，正式轮转把 ledger 与 registry 都改成 SID-b，label 写者再把整份旧快照写回，registry 回到 SID-a。之后接受与 T-COMMIT 冻结的都是 ledger 里的 SID-b，`requireSessionIdentity` 不核 SID，照样通过；落下 SID-b 绑定后，真实已验证调用报 SID-a（`caller-identity.ts:55`），新本人领不到单。这种写回在 `src/` 里有四十多处 `saveRegistry` / `patchRegistryAgent` 调用点，逐个改不现实，所以约束放在**发布层**：
  - 物理上把 registry 文件发布出去的只有三处：`saveRegistry` 的 `writeJsonLeased(REGISTRY_PATH, …)`（`core.ts:155`，`patchRegistryAgent` 与全部调用点都经它）、一次性迁移 `migrateWorkerToAgent` 的 `writeJsonLeased`（`core.ts:119`）、`state-backup` 的 `restoreSnapshot`（`src/lib/state-backup.ts:101-122`，`registry.json` 在其白名单内）。这三处改为都调用一个新的发布函数 `publishRegistry(reg)`。
  - `publishRegistry` 在**一个 ledger `tx`（`BEGIN IMMEDIATE`）里**同步完成：读 `caller_access_epochs` → 对文件里每个有代次行的 agent，把待写快照的 `sessionId` **覆盖成代次行的 `sessionId`** → 写临时文件 → 现有租约复核（`writeJsonAtomicSync` 的 `commitIf` 调 `assertSchedulerLease`，与 `writeJsonLeased` 现有做法相同）→ `rename` → 对本次写出的每个有代次行的 agent 执行 `UPDATE … SET publishedEpoch = epoch` → COMMIT。中间没有 `await`。这个事务**不改** `epoch` 与 `sessionId`，只改 `publishedEpoch`。没有代次行的 agent 原样写（迁移前会话本来就不能接受，见下）。这是对过时快照的**合并**策略：SID 一律以 ledger 为准，其他字段仍按今天的最后写者生效（label 等非 SID 字段的 lost update 是现有行为，本稿不改，也不声称解决）。
  - `commitRegistrySession(name, newSid, mutate)` 拆成**两个独立事务**（第 5 版，修第 4 轮 sid-rotate。第 4 版把代次推进与文件发布放在同一事务里，COMMIT 失败后无法安全补偿）：
    1. **T-rot**：单 `tx`，只写 ledger，不碰文件。代次行的 `sessionId` 已等于 `newSid` 时不推进（幂等重试）；否则 `epoch + 1`、`sidEpoch + 1`、写 `sessionId = newSid`，`publishedEpoch` 保持旧值，因此必小于新 `epoch`。这次 COMMIT 是 SID 轮转的**线性化点**。COMMIT 失败时 SQLite 已回滚：代次行与 registry 文件都没变，返回 `ok:false`，与“第 1 步失败”相同。
    2. **T-pub**：T-rot 提交之后，另开一个 `publishRegistry` 事务。在事务内**重新读取文件**（不用调用方之前的快照），执行 `mutate`，按上一条覆盖 SID 后发布，并把 `publishedEpoch` 推到 `epoch`。T-pub 失败（拿不到锁、`rename` 前出错、`rename` 后 COMMIT 失败或进程退出）时返回 `ok:false, rotated:true, epoch`。重做 T-pub 时再调一次 `commitRegistrySession`：T-rot 按幂等跳过，只重做 T-pub。`mutate` 必须幂等（现有调用方只做整条覆盖或字段赋值）。
    3. **结果是三态，调用方必须分开处理**（第 6 版，修第 5 轮 acp-rotate）：`ok:true`（已提交、已发布）；`ok:false, rotated:false`（T-rot 没提交，ledger 与文件都还是旧 SID）；`ok:false, rotated:true`（轮转**已经提交**，只是还没发布）。第三种不是失败，调用方不能按旧 SID 回退。跨进程调用丢了回包时（`runManagerProcess` 超时或子进程退出），调用方不知道是哪一种，就用新增的只读命令 `manager session-epoch <name>` 读代次行（`sessionId`、`epoch`、`sidEpoch`、`publishedEpoch`、`confirmPendingSidEpoch`；不含 `credTag`）判定：`sessionId` 等于新 SID 算 `rotated:true`，等于旧 SID 算 `rotated:false`，读不到或是第三个值算**未定**。判定一律以 ledger 为准，不再看 registry 文件（`acp-host.ts:144-145` 现在看的是 registry，T-rot 已提交、T-pub 未提交时它报旧 SID，正是第 5 轮复现的误判来源）。
  - **COMMIT 失败后不做任何补偿写。** `tx()` 是 `db.transaction(fn).immediate()`（`ledger-tx.ts:13-15`），COMMIT 失败返回调用方之前，事务已经回滚，写锁已经释放，别的连接可以立刻拿锁发布。第 4 版“仍持锁把文件按原内容写回”的前提不成立，第 5 版整条删除：任何路径都不会在失锁后按旧内容覆盖文件，也就不会盖掉别的连接更新的发布。不补偿也安全，依据是两条不变量：
    - **I1：文件里的 SID 只会是 ledger 已提交的值。** 改 `sessionId` 的只有 T-rot，而 T-rot 不写文件。写文件的只有 `publishRegistry`，它在写锁内读到的代次行全是已提交的值，自己也不改 `sessionId`。所以即使 T-pub 在 `rename` 之后 COMMIT 失败，文件里的 SID 仍是**已提交**的当前值。第 4 轮审查复现的“文件 SID-b、ledger 回到 SID-a”在新顺序下不可达：失败的 T-rot 从未写出 SID-b，失败的 T-pub 写出的 SID-b 已经提交。
    - **I2：`publishedEpoch = epoch` 时，文件里该 agent 的 SID 等于代次行的 `sessionId`。** `publishedEpoch` 只由 COMMIT 成功的 `publishRegistry` 推进，它在同一写锁内刚把当前 SID 写进文件。此后直到下一次 T-rot，代次行不变，期间的任何发布（包括 COMMIT 失败的）写出的都是同一个 SID。T-rot 推进 `epoch` 时不动 `publishedEpoch`，两者立刻不等。绕开 `publishRegistry` 写文件的路径由守卫 ② 排除。
  - **权威阻断状态**就是 `publishedEpoch < epoch`（含 NULL）。T2 与 T-COMMIT 都在事务内核这一列（§2.2 第 2 条、§3.3 前置 6），不读文件，安全性也不靠“下一次任意 save 自愈”。处于阻断状态时，registry 落后于 ledger：bridge 读到旧 SID，与代次行不等，接受被拒；已接受的单冻结的 `accessEpoch` 落后于新 `epoch`，T-COMMIT 回滚。下一次成功的 T-pub，或任意一次成功的 `publishRegistry`（同样会写出当前 SID 并推进 `publishedEpoch`），会结束这个状态；但对提议式轮转，它们只解除 `publishedEpoch` 这一半，`confirmPendingSidEpoch` 这一半只能由持当前凭据的宿主确认解除（第 6 版，第 7 版改认领规则，见下条）。这只影响恢复能否完成，不影响安全。doctor 对 `publishedEpoch < epoch` 超过一个检测周期的行告警，manager 启动时对这些行各跑一次 `publishRegistry` 收敛。
  - **提议式轮转与观测式轮转（第 6 版，修第 5 轮 acp-rotate）。** SID 改写分两类，区别在于 T-rot 提交时运行时是否已经确定在新 SID 上：
    - **观测式**：运行时已经在新 SID 上，registry 只是追认。CC 的 `/clear` 认领（`clear-rotation.ts`）、Stop 自愈（`session-heal.ts`）、`cmdAdopt`、restart fork 回写、create/resume 都属这一类。轮转已提交而未发布时，ledger 的 SID-b 与运行时一致，任何 publisher 把 SID-b 写进文件都是正确的，`confirmPendingSidEpoch` 保持 NULL，阻断只看 `publishedEpoch`。调用方的变化只在共用的 `claimRotatedSession`（`clear-rotation.ts:34-46`）：`rotated:true` 按已提交处理，照常重挂 watcher、发 `session_rotated`，再在后台按 3 秒间隔重调 `set-session` 只重做 T-pub（与 `retryAcpRebind` 同形，进程退出后由 manager 启动收敛兜底）。今天它把 `ok:false` 一律当失败、不重挂 watcher；若不改，其他 publisher 发布 SID-b 后，`session-heal.ts` 的 `hookSid === from` 早退会让 watcher 永远停在旧文件上。
    - **提议式**：ACP `/clear`。宿主先新建线程、完成引导，再请 registry 换代（`lib/acp/clear.ts:20-21`）；换代失败时宿主停掉新适配器、按 `cfg.sessionId` 接回旧线程（`lib/acp/host.ts:501-503`、`:202`）。所以 T-rot 提交时运行时**并不确定**会留在新 SID 上。这类调用经 `set-session … --expected <old> --propose` 进入，T-rot 在同一事务内另写 `confirmPendingSidEpoch = sidEpoch`（新值）；观测式 T-rot 把它写成 NULL。`confirmPendingSidEpoch` 只能由两种写清除：宿主确认，或之后的又一次 T-rot（新代次覆盖）。`publishRegistry` 与凭据换代**都不碰** `sidEpoch` 与 `confirmPendingSidEpoch`，所以任意 publisher 或启动收敛只能推进 `publishedEpoch`，不能独立解除阻断。
    - **确认 = 当前可信宿主认领待确认提议（第 7 版，修第 6 轮 confirm-epoch）。** 第 6 版的确认 CAS 要求 `epoch = n AND confirmPendingEpoch = n`，而凭据换代推进 `epoch`、不动待确认列，确认前一旦重签凭据（宿主崩溃后 manager 重启正会经 `launchWithCallerCred → issueLaunchCred → issueCallerCred` 重签，`caller-cred-launch.ts:34-40,54-61`），两个等式再也不能同时成立，同 SID 的 T-rot 又按幂等跳过，提议永远确认不了。第 7 版把两件事拆开：提议身份用 `sidEpoch` 记，确认是否来自当前宿主用凭据判断。确认命令为 `set-session <name> <sid> --confirm <sidEpoch>`，宿主把自己持有的启动凭据经子进程 **stdin** 交给它（不进 argv、环境变量或日志；ACP 宿主启动时已读走并持有它，`acp-host.ts:34`）。今天宿主调 manager 的唯一入口 `runManagerProcess`（`acp-host.ts:140`，定义在 `lib/run-manager.ts:59-83`）不配 stdin、也不交出子进程句柄，所以这条交付要先给共享 runner 加受控的 `input` 端口，不另起 manager 子进程通道（第 8 版，修第 7 轮 confirm-stdin-port，端口语义与验收见 §4 P-B）。单 `tx`，CAS 为：
      `sessionId = <sid> AND sidEpoch = <g> AND confirmPendingSidEpoch = <g> AND credTag IS NOT NULL AND credTag = sha256("claudestra-cred-epoch-v1:" + hashCred(<stdin 凭据>))`
      命中就只写 `confirmPendingSidEpoch = NULL`，不改 `epoch`、`credTag`、`sessionId`、`publishedEpoch`，也不改 `updatedAt`（它记的是代次推进时刻，§2.2 A 第 3 条依赖它）；不命中无效果，返回不区分原因的拒绝。
      - 为什么这样安全：`credTag` 只在凭据换代的 ledger COMMIT 时改变（先 ledger 后文件），新凭据只经一次性文件交给本次启动的宿主。重签或撤销一旦提交，旧宿主手里的旧凭据就对不上 `credTag`，它发的确认零效果，不能跨越撤销；新宿主持新凭据，能确认同一个 `sidEpoch`。撤销第 1 步失败、只删了文件时，按下文的线性化，撤销尚未发生，这期间旧宿主的确认是撤销之前的事件，与 T2/T-COMMIT 同一把写锁定序，不算跨越。
      - 签发第 1 步失败（新宿主没拿到凭据，以 `verified=false` 启动）时它无法确认，阻断状态保持，闭合失败；下一次正常重启签发成功后再确认。没有凭据的运行时（`callerCred` 为 undefined 的 tmux 版等，`credTag` 被撤为 NULL）一律不能确认，它们也不发起提议式轮转。
      - 确认不推进任何代次，所以不会使已有的接受失效；但阻断期间 T1 拒授予、T2 拒接受（§2.2），确认之前不存在可被它“放行”的授予或接受。确认之后 PM 按当前行重新授予，接受冻结的 `accessEpoch` 就是重签后的 `epoch`。
      - 第 6 轮复现的时间线：提议 SID-b 提交，`epoch=2, sidEpoch=s, pending=s`；确认前宿主崩溃，manager 重启重签，`epoch=3`、`credTag` 换新，`sidEpoch` 与 `pending` 仍为 `s`；发布成功，`publishedEpoch=3`；新宿主 attach SID-b、重绑后以新凭据发 `--confirm s`，CAS 命中，`pending=NULL`，阻断解除。旧宿主（若仍残存）以旧凭据发同样的确认，`credTag` 不等，零效果。整个过程不需要另换 SID，也不需要任何人工清 NULL。
    - ACP 宿主按三态处理（`acp-host.ts` 的 `rotateSession`、`lib/acp/clear.ts` 的 `createClearedSession`、`lib/acp/host.ts` 的 `clearSession` 与 `startAdapter`）：
      1. `ok:true` 或 `rotated:true`：按已换代处理，走现有 `committed` 分支（`commitAcpClear` 改 `cfg.sessionId`、重挂 watcher），不停新适配器、不接回旧线程。`rotated:true` 时再在后台重试 `set-session` 只做 T-pub。新线程接上并且 watcher 重绑确认之后，宿主发 `--confirm <sidEpoch>`（带本进程持有的凭据），失败也按 3 秒重试；CAS 不命中且 `session-epoch` 显示 `confirmPendingSidEpoch` 已不等于该值（被新 T-rot 覆盖）时停止重试。
      2. `rotated:false`：与今天相同，走 `failed`，按旧 SID 接回。此时 ledger、文件、运行时三者都是旧 SID，`confirmPendingSidEpoch` 没被写过。
      3. **未定**：不按旧 SID 接回，也不当成功。宿主停掉适配器（`session = null`，`proc.stop()`），等下一次 `startAdapter` 再定。
      - `startAdapter` 改为：库里该 agent 有代次行时，attach 的 SID 取自 `session-epoch` 返回的 ledger `sessionId`，不再直接用 `cfg.sessionId`；读不到就不 attach，按现有起不来的退避重试（闭合失败）；没有代次行（迁移前）时照旧用 `cfg.sessionId`。attach 成功且读到的 `confirmPendingSidEpoch` 等于当前 `sidEpoch` 时，同样发 `--confirm <sidEpoch>`（第 7 版：比的是 `sidEpoch`，不是 `epoch`，所以重启重签凭据之后照样成立）。这样宿主进程在任一点崩溃后重起，接上的都是 ledger 的 SID。旧线程只有在 ledger 本来就是旧 SID 时才会被接回。
      - `committed` 之后才失败的情形（watcher 重绑失败）已由现有 `waitingForRebind` 和 `retryAcpRebind` 处理（`clear.ts:49-54`、`:63-80`），不变；只是确认要等重绑成功之后才发。
    - 由此得到第 6 版的不变量 **I3：`confirmPendingSidEpoch IS NULL` 时，运行时实际 attach 的 SID 等于代次行的 `sessionId`。** 观测式轮转在提交前运行时已在新 SID 上；提议式轮转只有持 ledger 当前凭据的宿主在 attach 并重绑新 SID 之后才会清除这一列；接回旧 SID 只发生在 `rotated:false`，那时代次行没变。I2 加 I3 合起来，就是“文件、ledger、运行时三者一致”。权威阻断状态因此改为 `publishedEpoch < epoch OR confirmPendingSidEpoch IS NOT NULL`，T2 与 T-COMMIT 都在事务内核这两列。
    - 第 5 轮复现的时间线在新设计下：T-rot 提交 SID-b（`confirmPendingSidEpoch=sidEpoch`），T-pub 在 `rename` 前失败，`set-session` 返回 `rotated:true`。宿主不再走 `failed`，留在新线程 SID-b 上；即使回包丢失，`session-epoch` 读到 SID-b 也会得到同样的结论。之后的发布把文件改成 SID-b，`publishedEpoch=epoch`，但在宿主确认之前接管门仍然关闭；确认之后，实际 attach 的 SID、registry、ledger、已验证调用报出的 SID 都是 SID-b。宿主若在确认前崩溃，重起时 manager 重签凭据，宿主按 ledger attach SID-b，再用新凭据按 `sidEpoch` 确认（第 7 版），不会接回 SID-a。
    - 剩下的窗口：T-rot 提交到宿主收到结果之间，ledger 与 registry 可能已是 SID-b，而适配器手上是刚建好、还没交给 turn loop 的新线程。这段时间 loop 处于挂起（`suspendIfIdle`），宿主不跑回合，`confirmPendingSidEpoch` 也挡着接管门，不会因此开门。这一列只约束接管门，`bindingAllows` 等现有的门行为本稿不改。
  - 进程在任一点退出：T-rot 之前退出或 T-rot 未提交，什么都没变；T-rot 已提交、T-pub 未提交，处于阻断状态，`rename` 可能已经发生，但按 I1，文件内容合法；T-pub 已提交，轮转完成。任何中间状态都不需要靠原锁回滚。
  - 跨进程顺序：所有 registry 发布都在持有 ledger 写锁时才 `rename`，SQLite 写锁把所有 registry 发布与所有 SID 代次推进（T-rot）排成一个全序。审查给出的交错因此只有两种结果：label 写者的发布排在 T-rot 之前，之后的 T-pub 在事务内重读文件写出 SID-b；排在 T-rot 之后，它在事务内读到代次行 SID-b，把旧快照里的 SID-a 覆盖掉（并顺带推进 `publishedEpoch`）。两种情况下 registry 最终都是 SID-b，与 ledger 一致。
  - 拿不到 ledger 写锁（超过 busy_timeout）时，`publishRegistry` 抛错，本次 registry 写入失败，由调用方现有的错误路径处理。它不降级成不经 ledger 直接写，这样做会重新打开过时快照覆盖 SID 的窗口。这让所有 registry 写入多了一个“ledger 忙则失败”的失败面，列入 owner 批准项。库里还没有代次表时，`publishRegistry` 不开事务、照旧直接写，行为与今天相同，接管门因为没有代次行而关闭。
- 顺序固定为**先 ledger、后文件**：
  1. 凭据类：单 `tx` 把该 agent 的 `epoch + 1`，写入新 `credTag`/`family`/`issuedAt`（撤销则写 NULL）。凭据换代不改 registry 文件，同一事务内 `publishedEpoch` 随之设为新 `epoch`，但只在旧行 `publishedEpoch` 已等于旧 `epoch` 时这样做，否则保持不变，不替尚未完成的 SID 发布解除阻断。SID 类即上文 T-rot，文件发布是之后独立的 T-pub。代次推进的 COMMIT 就是换代的**线性化点**。
  2. 凭据类在第 1 步提交之后，再按现有 `replaceAgentCreds` 改凭据文件。
  - 推论：凭据文件只会**落后**于 ledger，不会领先。registry 的 SID 只会落后于或等于 ledger（I1），不存在领先的窗口；落后时 `publishedEpoch < epoch`，按闭合失败处理。bridge 在事务外读到的 SID 或凭据与 ledger current 行不等时，事务内比对必拒。
- 防漏：P-B 加两条静态守卫测试。① `src/` 中给 registry agent 赋 `sessionId` 的语句只出现在 `commitRegistrySession` 里（新建 agent 的首条记录也经它写，代次行从 `epoch=1`、`sidEpoch=1`、`confirmPendingSidEpoch=NULL` 起）。② 写 registry 文件的语句（以 `REGISTRY_PATH` 或 `registry.json` 为目标的 `writeJson*` / `writeText*` / `rename`）只出现在 `publishRegistry` 里；`state-backup` 恢复 `registry.json` 时也必须转交给它。任何新增路径绕开这两点都会让测试失败。只按 `sessionId` 赋值做静态搜索挡不住整份旧快照写回，所以守卫 ② 是必需的。
- 失败策略：签发时第 1 步失败，就不写文件、不发凭据，启动按现有失败路径重试（闭合失败）。SID 类第 1 步（T-rot）失败：不改 registry，路径返回 `ok:false, rotated:false`，调用方按今天的失败处理（`clear-rotation.ts`、`session-heal.ts:65` 记错并在下次检测时重试；ACP 宿主按旧 SID 接回）。T-rot 已提交、T-pub 失败返回的 `rotated:true` **不是**这种失败，按上文三态处理，调用方的改动列在 P-B。这会让 registry 的 SID 暂时落后于运行时，等同今天轮转被 watcher 检测到之前的状态；但 ledger 行与 registry 一致地停在旧值，轮转在本设计里定义为第 1 步 COMMIT 的那一刻发生，下面的时序推论照常成立。这改变了 `set-session` 等路径的失败面，列入 owner 批准项。撤销时第 1 步失败，照旧删掉文件里的记录（安全方向，旧连接立即 `verified=false`），并持续重试第 1 步。重试成功前，ledger 里的 current 代次仍是旧 `credTag`，而任何新连接都不可能出示它：文件里已没有它，bridge 认不出就是未验证，拿不到接受所需的已验证调用；已接受未提交的单如何处理见下面的时序推论。
- 时序推论（与 SQLite 写锁串行化一致）：
  - 换代的第 1 步早于 T2 或 T-COMMIT 提交：后者在事务内读到新代次，拒绝或回滚，零新绑定。
  - 换代的第 1 步要等 T-COMMIT 释放写锁才能开始，也就晚于提交：它是提交之后的事件，按普通已绑定作者的重启或轮转处理（新凭据仍签给同一 agent，绑定按 SID 继续核）。提交之后的 SID 轮转让绑定与真实 SID 不一致，这是现有任何已绑定作者 `/clear` 后都有的门行为（`bindingAllows` 不跟随轮转），本稿不改门、不声称解决，也不把它算作接管漂移。
  - 只轮转 SID 的 `/clear` 发生在 T2 之后、T-COMMIT 之前：其第 1 步 COMMIT 先于 T-COMMIT，T-COMMIT 读到 `epoch` 已推进、`sessionId` 已是 SID-b，回滚，零新绑定。PM 需按 SID-b 重新授予。
  - 撤销第 1 步失败、只删了文件的情形：代次的权威定义就是 ledger 行，文件只是 MCP 验证用的派生副本。这种撤销在第 1 步重试成功那一刻才算换代，线性化点仍是那次 COMMIT，与 T-COMMIT 由同一把写锁定序。提前删文件只会让持有旧凭据的连接更早失去验证，不会让旧代次多出任何写权。撤销第 1 步失败计入 doctor 告警，便于 PM 看到。
  - 因此“提交前换代零效果”在本设计里的精确含义是：换代（凭据或 SID）的 ledger COMMIT 先于 T-COMMIT 的 COMMIT，则 T-COMMIT 必回滚。比较 `issuedAt`、重读 registry 文件的 SID 或重跑 `requireSessionIdentity` 都不能替代这一同步，本稿不用它们做提交判据。
  - T-COMMIT 提交之后，过时快照的整份写回也不能把 registry 的 SID 改回旧值：`publishRegistry` 在写锁内按代次行覆盖 SID（上文）。所以“ledger 冻结 SID-b、真实调用报 SID-a”只能出现在阻断状态里（`publishedEpoch < epoch`，或提议式轮转尚未确认，`confirmPendingSidEpoch IS NOT NULL`）。它发生在接受或提交之前时，T2 或 T-COMMIT 核到阻断而拒绝，不会落下新绑定；发生在提交之后时（即提交之后的 T-rot），按上一条的提交后轮转处理。T-rot 的 COMMIT 失败不构成轮转：代次行、文件、真实调用三者都还是 SID-a，此时提交 SID-a 绑定，与真实调用一致。
  - 本设计看不见“运行时已轮转、但还没有任何写路径提交第 1 步”的状态，今天的 registry 同样看不见；它不是本设计新开的窗口。
- 迁移前已在跑的会话没有代次行，或代次行的 `credTag`、`sessionId` 任一为 NULL：接受一律拒，须重启拿新凭据与新的 SID 记录。库里还没有代次表（未迁移、只读打开）时，签发、撤销与 registry SID 改写都跳过第 1 步、照旧只改文件，启动与轮转行为不回退；此时任何会话都无法接受，接管门闭合。只有表已存在而第 1 步失败，才按上一条闭合失败。
- 这改变共享的 `caller-cred.ts` 签发与撤销路径，以及上面列出的全部 registry SID 写路径，涉及凭据与会话身份的生命周期，需 **PM 精确扩围与 owner 批准**。不批准时 P-B 与 P-C 整体阻塞，不提供“事务内重读凭据文件或 registry”之类的降级实现。

**旧作者凭据撤销时序**（只对本机旧作者适用，peer 旧作者在 A 侧没有凭据）：

1. 先在 T-COMMIT 中让旧绑定失去 current 地位。
2. 提交之后再撤销 `old.agent` 的凭据（按上面的先 ledger 后文件）。

第 2 步不在 T-COMMIT 事务里。即使它失败，旧会话在 `bindingAllows` 上也已经被新的 active 绑定拒绝；撤销只是加固，失败会记录并重试，不回滚提交。反过来，先撤销凭据再提交是不允许的：提交失败时，旧作者会被无故断开。

### 2.4 原 take_order / deliver 门保持不变

- 接管只改变门读到的**数据**：`task_steps` 的执行者、`tasks.agent`、唯一一条 active 作者绑定，以及本阶段最新的那条派单意图。门的**逻辑**不变。
- 新作者通过既有 `scanOrders`（执行者加 `bindingAllows`）领单。注意 `scanOrders` 之后还有 `lentAway`（`order-take.ts:67-71`）：`currentIntent`（`:52-57`）取本阶段最新的、非 `cancelled` 的 `dispatch` 意图，**包括 `done`**；它的 `recipient` 是 `peer:*` 时，本机会话只拿到“本卡代码由 peer 写”的说明，拿不到单。上一稿只新增 `action='author_takeover'` 意图，不会被 `currentIntent` 选中，原来已 `done` 的 peer 派单仍是最新，新作者照样被挡。本稿的投影见 §3.2、§3.3：提交时写一条**本机** `dispatch` 意图，`eventSeq` 晚于原 peer 派单，让它成为 `currentIntent`。原 peer 派单保持 `done` 原样，不改成 `cancelled`，历史不丢。
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
  - `CREATE TABLE IF NOT EXISTS caller_access_epochs (...)`，列见 §2.3。属于 P-B，与上面两项分在两条迁移里，各自可重跑。
  - 同步更新 `REQUIRED_COLUMNS`、`SCHEDULER_COLUMNS`。
- 新绑定行的 `createIntentId` 有外键约束，指向 `scheduler_intents`。T-COMMIT 在同一事务内插入**一条**接管派单意图，同时充当绑定意图与本阶段的当前派单：
  - `action='dispatch'`，`node` 为当前 `write|fix` 步，`recipient` 为新作者的本机完整名（不带 `peer:` 前缀，`isPoolIntent` 为假，见 `scheduler-pool-plan.ts:19-21`）；
  - `status='done'`，`reason='author_takeover'`，`receipt` 填 supersession id；`specRev`、`taskRev`、`head` 取提交时的卡；
  - `eventSeq` 填本次 `author_takeover` 事件的 seq（沿用 `ledger-scheduler-write.ts:241` 先插事件再回填 `eventSeq` 的做法），因此必大于原 peer 派单的 `eventSeq`，也大于进入本阶段的 stage 事件。
  - 结果：`currentIntent` 选中它，`lentAway` 不再成立（前提是没有 `LEND_LIVE` 单，§3.3 前置 3），新作者的单号就是这条意图的 id。原 peer 派单保持 `done`，作为“这一阶段曾借出”的历史留在原处。
  - 意图以 `done` 落地，不会卡住 `captureReborrowFacts` 和收尾退役的“没有未结意图”判据；`lend-fix-reassign.ts:48` 只看 `pending|submitted|unknown`，不受影响；`recovery-local-fallback-plan.ts:189` 会把它认作“已发出的本机派单”，语义正确。
- 第一次替换前调用 `preserveSessionHistory`，把主键放宽到 `(taskId, role, sessionId)`，与 fix swap 和 reviewer swap 的做法相同。
- 版本兼容：
  - 旧代码打开新库：多出的列和表被忽略。旧代码只会看到 `retired` 加一条新 active 行，判断依然正确。
  - 新代码打开旧库：表不存在时视为“从未接管”。
  - 回滚到旧版本不需要反向迁移。

### 3.3 writer：`supersedeAuthor(db, ctx, acceptId)`，单一 `tx`

**CAS 指纹**沿用 `captureReborrowFacts` 加 `assertReborrowCas` 的模式（`lend-reborrow-facts.ts:25-74`），在 T1 记录，在 T-COMMIT 重算。覆盖范围：

- 卡的完整行，工作流行，`task_steps`；
- 本卡全部 `lend_orders`，`lend_write_leases`；
- 本卡未结 `scheduler_intents`，以及**本阶段全部 `dispatch` 意图**（含 `done`，按 `id,status,recipient,eventSeq`）。T1 时 `currentIntent` 返回的那条必须就是原 peer 派单，漂移即拒；
- 当前作者绑定行；
- 新作者的 LIFE1 行（`agent+createdAt`）与 `caller_access_epochs` 行（`epoch, credTag, sessionId, family`）；
- E1/E2 事件的 seq；
- 本卡全部出借单的 `lend_relays` 行（按 `key, state, tries, updatedAt`）与对应 `lend_relay_resolutions` 行（第 3 版新增，见前置 8）。

**前置条件**（任一不满足就整体回滚）：

1. `grant` 和 `accept` 事件存在、彼此匹配、`now < expiresAt`、没被撤销，授予人仍是真实 PM。
2. 指纹与 T1 一致。
3. 卡在 build/fix；没有 `LEND_LIVE` 单；写租约已 `ended`，或由本 writer 在同一事务内 `endWriteLease`，原因写 `author_takeover:<id>`。
4. 旧绑定行就是 `fromBinding`，且仍是 current（非 retired）。
5. E1 的 `orderId/gen` 等于这张卡最后一张写单的 `orderId` 和 `leaseGen`，且 `terminal` 不是“未知”；E2 的 `remoteHead` 等于 `task.headSHA`。
6. LIFE1 新作者行就是 `to.agent + to.lifeCreatedAt`，仍 active、非 `cleanup_pending`，`sessionId` 等于 `to.sessionId`；`caller_access_epochs` 中该 agent current 行的 `epoch` 等于接受事件冻结的 `accessEpoch`，且 `sessionId` 等于 `to.sessionId`、`credTag` 非 NULL、`publishedEpoch` 等于 `epoch`、`confirmPendingSidEpoch` 为 NULL（§2.3）。这是 SID 的唯一提交判据。
7. 家族：`to.family` 等于 `workflow.authorFamily`，等于接受事件冻结的 `family`，且事务内重跑 `requireSessionIdentity`（`scheduler-session-identity.ts:10-21`，registry runtime 经同一映射得到的家族等于 `to.family`，完整名、worker 种类）通过。它不核 SID，SID 只看前置 6。换家族不在本稿范围，另需 CONV 规则。
8. **A 侧 relay 已结**（第 3 版新增）。本卡所有出借单（不只最后一张写单）的 `lend_relays` 行逐行判定：
   - 已结、不挡：`sent`（对方 bridge 收下）、`refused`（外发闸拒，从未发出）、`dropped`（订单离开 `claimed` 后未发出即丢弃）、`failed`（`MAX_TRIES` 次都被明确拒收，确定未送达）。
   - 未结、挡：`pending`（含 note：它不随订单结束被丢，仍会被发出）、`sending`（发送进程可能还在途）。只能等现有 `settleRelay` 或 `scanRelays` 推进到确定状态，本 writer 不改它们。
   - `unknown`（可能已送达，无回执）：挡，除非有一条有效的 `lend_relay_resolutions` 行。该行由真实 PM（`isRealPmRole`，排除 dispatcher）经新入口写入，字段 `{key, orderId, terminalSeq, outcome: delivered|not_delivered, evidence, actor, eventSeq, createdAt}`，同时写一条 `op: lend_relay_resolve` 事件（dedup 键 `lend-relay-resolve:<key>:<terminalSeq>`）。
   - **先后用台账序号判定，不比较时间（第 4 版，修第 3 轮 relay-gap）。** 第 3 版要求“E1 入账时间晚于 relay 的 `updatedAt`”，但 `updatedAt` 不是发送时刻：`takeRelays` 标 `sending` 时写一次（`ledger-lend-relay.ts:187-195`），之后 `settleRelay` 结账写一次（`:201-221`），`scanRelays` 把超时的 `sending` 改成 `unknown` 时又改成扫描时刻（`:177-180`）。正常顺序是：t=100 开始发送，B 停止、保全并报 E1，A 在 t=200 入账；A 在 t=600101 扫描到遗留的 `sending`，改成 `unknown`，同时把 `updatedAt` 写成 600101。不等式 200>600101 永远不成立，PM 之后可信的 `delivered` 解决也无法放行；E1 按 `orderId+gen` 去重，重放同一 E1 也补不出更晚的时间。第 4 版删掉这个不等式，不读也不改 `updatedAt`，也不新增“实际发送时间”列（那需要改 `takeRelays`，而本稿保持 relay 状态机不动）。
   - 改用两条序号判据。① 解决入口写入时，该 relay 所属出借单最新 `leaseGen` 的 E1 终态事件必须**已经入账**，并把它的事件 seq 记作 `terminalSeq`；E1 还没入账就拒绝写解决。因此解决事件的 `eventSeq` 必然大于 `terminalSeq`，同一台账 `events.seq` 单调递增，与时钟无关。② 前置 8 判定时，只认 `terminalSeq` 等于该单当前 E1 seq 的解决记录。E1 按 `orderId+gen` 去重，每个 order+gen 只有一个 seq，不存在“重放出更新的 E1”。
   - 不需要最后发送时间的理由：`unknown` 不会再被发送（`takeRelays` 只取 `pending`，`scanRelays` 与 `settleRelay` 只推进 `sending`，没有任何路径改写 `unknown`）。至于原先那次可能仍在途的请求，即使在 E1 之后才到达 B，也改变不了接管的内容：B 的 worker 已退出（E1 `workerAbsent`），接管内容由 E2 的 `remoteHead` 与 T3 的 `git ls-remote` 钉在授予时的 `headSHA` 上。PM 解决要回答的只是“这段补充新作者有没有拿到”，这个结论在 E1 之后作出才有意义，判据 ①② 保证的就是这一点。
   - 本卡较早的出借单（不是最后一张写单）若留有 `unknown` relay，也要它自己那张单的 E1。没有 E1 的旧单（含实现前的历史单）不补造，`unknown` 一律挡住，接管保持 blocked。
   - 解决**不改** `lend_relays` 原行：`unknown` 仍是 `unknown`，`reason`、`tries`、`updatedAt` 原样保留，不伪造 `sent` 或 `dropped`。`outcome: not_delivered` 时，本条补充的原文由 PM 在授予前确认已进入规格或交给新作者的说明（resolution 的 `evidence` 引用那条事件 seq），否则不放行。
   - 这条判据在 T1 授予时与 T-COMMIT 时各判一次；授予后任何 relay 行或 resolution 的变化都改变指纹，按前置 2 回滚。
   - B 的 E1/E3 `pendingPayload:false` 只证明 B 本地，不参与本条判定，也不能代替本条。

**效果**（与 `applyFixReplacement` 同一组投影，不另造 binding）：

- 旧行：`state='retired'`、`supersededBy=id`、`retireIntentId=接管意图`，`updatedAt` 更新。
- 插入新的 active 作者行（`transport` 取 `acp` 或 `tmux`，`createIntentId` 为接管派单意图）。
- 插入 §3.2 的本机 `dispatch` 意图；原 peer 派单意图**不改**。
- `updateTask`：`agent`、`assignee`、`assigneeKind` 改为新作者。
- 当前 round 的 `write|fix` 步骤：执行者改为新作者，`executorKind='agent'`，状态 `assigned`。
- 插入 `author_supersessions` 行。
- 写事件 `op: author_takeover`，dedup 键 `scheduler:<intentId>:takeover`，再回填意图的 `eventSeq`。

**幂等与竞争：**

- 同一 `grantId` 第二次提交命中 `author_supersessions.grantId UNIQUE` 或 dedup 键，返回已有结果。
- 两个并发提交由 `BEGIN IMMEDIATE` 串行化，后到者的指纹已经变化，被拒。
- 部分唯一索引 `scheduler_sessions_current` 是最后一道防线：任何路径想再插一条非 retired 作者行，都会撞约束回滚。

**不散抄 SQL（修正上一稿）。** 旧行改写、新行插入、`updateTask`、步骤执行者改写这四条投影，目前只在 `applyFixReplacement`（`fix-strategy-session.ts:30-42`）里。本稿要求先把它们抽成一个共用的 canonical 函数 `replaceAuthorRow(db, ctx, task, old, ref, intentId, receipts)`，放在 `fix-strategy-session.ts` 内或其旁的新模块，`applyFixReplacement` 改成调用它，`supersedeAuthor` 也只调用它；差异（旧行是否写 archive/kill 回执、是否写 `supersededBy`、是否改 `authorFamily`）作为参数，不复制语句。

- 这是 P-C 的**实现前置**，不是可选项。它扩大到 `fix-strategy-session.ts`，需 **PM 精确扩围**。
- 扩围没批时，P-C 整体阻塞，不提供“新 writer 自带同样语句、注释指向对方”的备选。上一稿的这条备选正是验收线禁止的散抄 SQL writer，本稿删除。
- 抽取本身要求 `applyFixReplacement` 的现有测试原样通过（行为零变化），作为 P-C 的第一个提交。

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
| `currentIntent` / `lentAway`（`order-take.ts:52-71`） | **不改**，但列为投影的验收对象 | 取本阶段最新非 cancelled 的 `dispatch` 意图。§3.2 的本机派单意图 `eventSeq` 更大，被选中后 `isPoolIntent` 为假，`lentAway` 不成立。P-C 正例必须经这两个真实读口断言新作者拿到单、单号是接管意图 id |
| 其余按 `action='dispatch'` 读意图处：`scheduler-placement-plan.ts`、`scheduler-auto-tick.ts`、`ledger-scheduler-lease-sync.ts`、`ledger-scheduler-lease-finished.ts`、`scheduler-dispatch-block.ts`、`agent-lifecycle-cleanup-hold.ts`、`scheduler-central-context.ts`、`ledger-resource-scope.ts`、`scheduler-spec-resume-write.ts` 等 | **核对**，预期不改 | 新意图是 `done`、非 pool，与 FB2 本机兜底已落地的本机派单同形（`recovery-local-fallback-plan.ts:189`）。实现时逐个核对“`done` 的本机 dispatch”在各处的含义，任何一处需要改就回到 PM 精确扩围，不在实现里顺手改 |
| `getSchedulerSession` 排序、`taskWorkerRefs`、`cardWorkerIndex` | 不改 | 唯一 current 行由部分唯一索引保证 |
| `mayRebindReviewer`、`swappedSession`（`scheduler-review-swap.ts`） | 不改 | 只看审查角色 |
| `usage-attr.ts:205`（全部行） | 不改 | 按 SID 归因，历史行照常计入 |
| 意图读口：`scheduler-agent-pool-ledger.ts:30` 等按 `action` 过滤处 | 核对 | 本稿不再新增 action 取值（接管意图就是 `dispatch`），不存在“未知 action”问题；新意图生来就是 `done`，不进入任何“未结意图”集合 |

## 4. 三张实现前置卡（验收 4）

行数是新模块或改动行的上限预算，不含测试。fileGlobs 是候选，最终由 PM 精确核定。

### P-A：provider 终态来源（E1 + E2 + E3）

- **B 侧删除入口全集**（按当前源码逐个核对，上一稿漏了 retention）：
  | 入口 | 何时删 | 本卡处理 |
  |---|---|---|
  | `settleOrder` → `d.removeDir`（`lend-drive.ts:192-198`，实现在 `lend-deps.ts:189-191`） | `acked`/`cancelled` 结算后立即删 work 与 push | 删除前过保全门 |
  | `sweepStoppedWork`（`lend-work-retention.ts:67-95`），由 `lendTickWithRetention`（`:98-106`）每轮在 `lendTick` 之前调用 | `stopped` 满 24h 后删 work 与 push，**不看保全** | 删除前过同一保全门；门不放行就不删、不记 `cleaned` |
  | `prepareClone` 开头的 `removeOrderDir`（`lend-clone.ts:74`） | 起 worker 之前重来 clone | 不改：此时没起过 worker，目录里没有 WIP（该函数头注释）。负例覆盖“journal 已有 worker 记录时不得走到这里” |
  | `lend-push.ts:61` 删 push 区 | 推送用的临时 clone | 不改：push 区只放已提交、待推的内容，work 区才是 WIP；但若 work 区保全门未放行，push 区随 work 区一起保留 |
  | `lend-claude-worker*.ts` 的 `rmSync` | worker 配置与 Claude 临时目录，不含源码 | 不改，列出以示已核 |
- **内容**：
  - 新模块 `lend-order-preserve.ts` 提供唯一的**持久保全门** `preserveGate(journal, orderId, dir)`：
    - 复用 `preserveReborrowGit` 的快照、祖先和 bundle 逻辑（抽出共用核心，续借路径改成薄调用）。
    - 结果持久写入 provider journal 的 meta `preserve:<orderId>` = `{state: ok|failed|unknown, bundleSha256?, remoteHead?, checkpoints?, dirty?, at}`。先写 `unknown`，保全完成再改 `ok` 或 `failed`；进程中途死掉留下的就是 `unknown`。
    - 只有 `state = ok` 才放行删除。`failed`（含工作区 dirty、快照漂移、祖先不符）与 `unknown` 都**不删**目录，work 与 push 一起保留为可恢复现场，并计入 `stoppedWorkSummary` 一类的 doctor 计数与告警；不设自动过期删除。
  - `settleOrder` 和 `sweepStoppedWork` 在各自的删除语句前调用这个门。`sweepStoppedWork` 对未放行的单记日志，不写 `cleaned: true`，下轮再试保全（只重试保全，不重试删除）。
  - 保全不成立时，终态报告标记 `preservation: failed|unknown`，A 侧不可接管。
  - 已保留的现场如何最终释放（PM 人工核后放行）不在本卡范围，另立卡；本卡只保证不自动删。
  - 然后经 R-a 的新 `lease` 动作 `terminal` 向 A 报告 `{orderId, gen, terminal, workerAbsent, pendingPayload:false, preservation:{bundleSha256, remoteHead, checkpoints}}`。
  - A 侧租约端点校验 `gen === leaseGen`、peer 和 fp 匹配，按 `lend-terminal:<orderId>:<gen>` 去重，写 canonical 事件。
- **新模块**：
  - `src/lib/lend-terminal-report.ts`（B 侧组装与发送，≤90 行）
  - `src/lib/ledger-lend-terminal.ts`（A 侧校验与入账，≤90 行）
  - `src/lib/lend-order-preserve.ts`（保全门与共用核心、journal meta 读写，≤100 行；`lend-reborrow-preserve.ts` 改成薄调用，净减行数）
  - `src/lib/ledger-lend-relay-resolve.ts`（第 3 版新增，A 侧：`lend_relay_resolutions` 表的加性迁移、真实 PM 解决 `unknown` relay 的写入、§3.3 前置 8 的“relay 已结”判定函数与指纹片段；写解决前查该单当前 gen 的 E1 并记 `terminalSeq`，≤90 行；它 import `ledger-tx`，须加入 `tests/ledger-migrate.test.ts` 写入模块白名单）
- **薄接线**：
  - `lend-drive.ts` 的 `finish`/`settleOrder`（≤15 行）；
  - `lend-work-retention.ts` 的 `sweepStoppedWork` 删除前过门、未放行不记 `cleaned`，`stoppedWorkSummary` 计入保留现场（≤15 行）；
  - `lend-deps.ts` 的 `removeDir` 依赖注入改为带门版本（≤5 行）；
  - A 侧租约路由加一个分支（≤10 行）；
  - `ledger-store.ts` 迁移列表加 `lend_relay_resolutions`（≤3 行）；`manager/ledger-lend-cmds.ts` 加 PM 命令 `ledger lend relay-resolve <key> --outcome delivered|not_delivered --evidence <seq>`（≤20 行；`terminalSeq` 由入口从台账查出，不接受命令行传入）。`ledger-lend-relay.ts` 的 `scanRelays` / `settleRelay` / `takeRelays` **不改**：解决记录另表存放，原状态机不动。
- **fileGlobs**：上述新文件、`src/lib/lend-drive.ts`、`src/lib/lend-work-retention.ts`、`src/lib/lend-deps.ts`、`src/lib/lend-reborrow-preserve.ts`、`src/lib/ledger-store.ts`、`src/manager/ledger-lend-cmds.ts`、A 侧租约端点所在文件（实现前由 PM 精确点名），以及 `tests/lend-terminal-*.test.ts`、`tests/lend-order-preserve*.test.ts`、`tests/lend-work-retention*.test.ts`、`tests/lend-relay-resolve*.test.ts`、`tests/ledger-migrate.test.ts`（只加新用例或白名单项）。
- **依赖**：lend wire 协议升级需要 **owner 和协议批准**。不新增签名用途。relay 解决入口是新的 PM 写入口，需 **PM 精确扩围**。
- **负例**：
  - 工作区有未提交改动；保全前后快照漂移；远端 head 不符；
  - `gen` 过期，错误 fp 或 peer；
  - `submit==='sending'`，或待转 payload 存在；
  - worker 仍在运行或探测为 `unknown`；
  - 重复报告内容不一致（回 `dedup_mismatch`）。
  - 到期 `stopped` 单的 work 区有未提交源码：真实 `sweepStoppedWork` 跑过后文件仍在，meta 为 `failed`，没写 `cleaned`。
  - 保全进行中进程被杀（meta 停在 `unknown`）：`settleOrder` 与 `sweepStoppedWork` 都不删。
  - 保全 `ok` 之后、删除之前工作区又被改动：删除前复核快照，漂移即改记 `failed`、不删。
  - 以上都只产生“不可接管”的事实或拒绝，不产生 E1/E2 事件，且现场目录保留。
  - relay 解决入口：非真实 PM（含 dispatcher）写解决被拒；对非 `unknown` 行写解决被拒；同一 key 重复解决内容不一致回 `dedup_mismatch`；`not_delivered` 缺 `evidence` 被拒；该单当前 gen 的 E1 还没入账时写解决被拒；解决记录的 `terminalSeq` 与当前 E1 seq 不等（伪造、或指向旧 gen 的终态）时，前置 8 判定为未结；对同一 E1 重放终态报告不产生新 seq，也不能让早于 E1 的解决生效；本卡较早出借单没有自己的 E1 时，其 `unknown` relay 照样挡住。解决之后 `lend_relays` 原行逐字段不变（断言 `state='unknown'`、`reason`、`tries`、`updatedAt` 原值）。
  - 用真实 `openLedger(':memory:')` 迁移种入 done 写单加 `pending`/`sending`/`unknown` 三种 relay，跑真实 `scanRelays` 后（`pending→dropped`、`sending→unknown`、`unknown` 不变），前置 8 的判定函数对 `sending` 未超时与未解决的 `unknown` 都返回“未结”。
  - 判据不读 `updatedAt`：同一 relay 的 `updatedAt` 被 `scanRelays` 改大（复现审查的 t=100 / E1 入账 200 / 扫描 600101 时间线）之后，判定结果只随解决记录与 `terminalSeq` 变化，与 `updatedAt` 无关。
- **正例**：干净 acked 写单 → 先保全、再删目录 → A 得到一条事件；同一报告重发结果相同，幂等。干净的到期 `stopped` 单经真实 `sweepStoppedWork` 先保全再删除，与现有 24h 行为一致。真实 PM 对 E1 之后的 `unknown` relay 写 `delivered` 解决，判定函数返回“已结”，原行不变。用审查给出的正常交错走一遍：真实 `takeRelays` 在 t=100 把 relay 标成 `sending`，E1 在 t=200 入账（`terminalSeq` 为其 seq），真实 `scanRelays` 在 t=600101 把它改成 `unknown`（`updatedAt=600101`），PM 随后经真实入口写 `delivered`，前置 8 返回“已结”。
- **版本兼容**：旧 peer 不发 `terminal`，A 侧不会有事件，接管门保持关闭。旧 A 收到未知动作回 `invalid`，B 记日志，不重试降级。

### P-B：本人接受（G、R、A）

- **内容**：
  - PM CLI `ledger author-takeover-grant` / `--revoke`；
  - 新 MCP 派单工具 `accept_takeover`，**两侧都要接线**：channel-server 只公布 `ORDER_TOOLS` 里的定义（`channel-server.ts:589`），也只转发 `isOrderTool` 命中的调用（`:734`，`isOrderTool` 见 `lib/order-tools.ts:113-114`）；bridge 侧再按 `HANDLERS` 分派（`bridge/order-tools.ts` 头注释）。只做 bridge handler 的话，真实 MCP 客户端既看不到也调不到这个工具；
  - §2.3 的接入代次表与“先 ledger 后文件”的签发、撤销与 registry SID 改写顺序；
  - `CallerIdentity` / `VerifiedCall` 增加只读的 `credTag`（由 bridge 用连接出示的 `credHash` 派生，见 `caller-identity.ts:30` 的 `IdentityInput.credHash`），不暴露明文与原哈希。
- **新模块**：
  - `src/lib/author-takeover-grant.ts`（授予、撤销与校验，≤110 行）
  - `src/lib/author-takeover-accept.ts`（接受 handler 的纯逻辑与事务，≤90 行）
  - `src/lib/caller-access-epoch.ts`（代次表迁移、推进、读取，≤60 行）；`src/lib/registry-publish.ts`（`publishRegistry(path, reg, opts)` 与 `commitRegistrySession`：在 ledger 写锁内按代次行覆盖 SID，同步发布文件并推进 `publishedEpoch`；T-rot 只推进代次，T-pub 在事务内重读文件、执行调用方给的改写再发布；没有任何失锁后的补偿写，≤70 行）。它放在 `src/lib/`（第 5 版，修第 4 轮 publish-layer），只依赖 lib 内模块：`lib/ledger-tx.ts` 的 `tx`、`lib/ledger-store.ts` 的 `openLedger`、`lib/state-file.ts` 的 `writeJsonAtomicSync`、`lib/scheduler-lease-env.ts` 的 `assertSchedulerLease`、`lib/registry.ts` 的 `REGISTRY_PATH`。这样 `lib/state-backup.ts` 调它是 lib→lib，`manager/core.ts` 调它是 manager→lib，都符合 `CLAUDE.md` 第 5 条与 `scripts/guard/rules/deps.ts:62` 的 `lib-only-lib`，不需要依赖注入。目标路径与 ledger 路径由参数传入（`restoreSnapshot` 的 `dir` 参数照传，测试可以用临时目录），`noFollow` 等写选项透传。它要 import `ledger-tx`，须同步加入 `tests/ledger-migrate.test.ts` 的写入模块白名单）
- **薄接线**：
  - `lib/order-tools.ts`：`ORDER_TOOLS` 增加 `accept_takeover` 定义（`{v, grantId}` 两个参数，≤15 行）；`isOrderTool` 由 `ORDER_TOOLS` 派生，无需另改。`channel-server.ts` 展开 `ORDER_TOOLS`，不改；
  - `bridge/order-tools.ts`：`HANDLERS` 注册 handler（≤10 行）；
  - `lib/caller-identity.ts` 与 `bridge/caller-identity.ts`：`credTag` 字段（≤8 行）；`order-tool-route.ts` 的 `VerifiedCall` 透传（≤4 行）；
  - `lib/caller-cred.ts`：`issueCallerCred` / `revokeCallerCreds` 先推进 ledger 代次再改文件（≤20 行）；`caller-cred-launch.ts` 传入 ledger 句柄或路径（≤6 行）；
  - registry 文件发布收拢到 `publishRegistry`：`manager/core.ts` 的 `saveRegistry`（`:146-155`）与 `migrateWorkerToAgent`（`:119`）改调它（≤8 行），`lib/state-backup.ts` 的 `restoreSnapshot` 对 `registry.json` 先解析，再带 `noFollow` 转交给它（≤8 行，lib→lib）。`saveRegistry` 保持 async 签名，内部同步调用发布函数，四十多处调用方不受影响。四十多处 `saveRegistry` / `patchRegistryAgent` 调用点不改；
  - **canonical stdin 端口（第 8 版，修第 7 轮 confirm-stdin-port；PM 2026-10-07 13:02 收口）**：`src/lib/run-manager.ts` 是 bridge、cron、ACP 宿主等三十多处共用的 manager 子进程入口（今天 `RunManagerOpts` 在 `:49-57`，没有 stdin 字段；`runManagerProcess` 在 `:59-83`，只配 stdout/stderr/env，不写 stdin、不交出句柄）。确认凭据只走它，不在 `acp-host.ts` 里另起 `Bun.spawn`。候选改动净增 ≤8 物理行，属设计候选，实施前仍需 PM 精确核定范围；预算不够时报真实方案，不压行、不改 guard 凑数：
    - `RunManagerOpts` 增加可选 `input?: string`。`undefined` 就是旧路径：spawn 选项不加 `stdin`，保持 Bun 默认（子进程 fd0 立即读到 EOF，本机 Bun 1.3.14 实测 `cat` 不挂起），输出解释、stdout/stderr 并发读取、超时强杀全部不变，现有三十多处不传 `input` 的调用方不改一行；
    - 传了 `input` 时以 `stdin: Buffer.from(input, "utf8")` 交给 `Bun.spawn`：整段写一次后关闭（EOF），不进 argv、不进 env，runner 不记录输入的长度、哈希或前缀，失败不自动重试、不重放；
    - 类型不是字符串时在 spawn **之前**抛固定文字的 `TypeError`（不含输入内容），不起子进程；JS 字符串经 UTF-8 编码不会抛（孤立代理对按 U+FFFD 替换），所以“编码失败”在 runner 层只剩类型不合法这一种，凭据格式（字符集、长度）由调用方 `confirmSession` 在调用前校验，不合法即不调用；
    - 空字符串是合法输入：写 0 字节并 EOF，与 `undefined` 的区别只在显式配了 stdin。回显剔除对空串跳过，不做 `split("")` / `replaceAll("", …)`，不会把每个输出字符都替换掉。`confirmSession` 不发空凭据（宿主没有凭据就不确认，阻断保持），`set-session --confirm` 收到空 stdin 按凭据缺失返回固定拒绝；
    - 回显剔除：读完 stdout/stderr 后、调用 `onStderr` 与 `interpretManagerRun` **之前**，把两路输出里与 `input` 逐字相同的片段替换成固定占位（非空输入才做）。这只是兜底：输入被编码、截断、拆行后再回显的情况它不保证挡住，不能据此放宽 manager 侧的要求。`set-session --confirm` 本身只输出固定结构 `{ok, confirmed}` 或固定错误文字，任何路径都不打印 stdin 内容、`credTag` 或比对中间值；
    - runner 只是传输，不是认证、授权或送达证明：子进程返回 `ok:true` 不等于确认生效，生效与否只看 CAS 是否命中（§2.3）。确认失败、超时、回包丢失或没拿到有效 CAS 回执时，`confirmPendingSidEpoch` 保持非 NULL，接管门保持关闭，零新绑定；`confirmSession` 的 3 秒重试是调用方每次重新发起、带本进程当前凭据的新确认，由 CAS 判定，不是 runner 重放同一份输入；
    - 第 7 轮审查用的 16 项内存 SQLite 状态机探针只是代次设计的模型，不代表 stdin runner、ACP、bridge 或 canonical 集成已实现或通过。PM 记录的本机公共合成探针只验证了 Bun 1.3.14 上 buffer stdin 的 EOF、以及 8MB 输入而子进程提前 `exit 3` 时不抛，没有改 runner，也没覆盖全部 T1–T5；EPIPE 在该版本不抛不作跨版本保证。
  - registry SID 写路径改走 `commitRegistrySession`：`manager/set-session.ts`（≤6 行）、`manager.ts` 的 `cmdAdopt`、restart fork 自愈回写、create/resume 整条记录（各 ≤6 行）。`set-session` 增加 `--propose` 与 `--confirm <sidEpoch>`（凭据只从 stdin 读，比对 `credTag` 后即丢弃，不落日志），返回三态（≤26 行）；新增只读命令 `session-epoch <name>`（≤20 行，只读 `caller_access_epochs`，不读凭据）。第 5 版写的“调用方已处理 `ok:false`、不改”不成立，第 6 版改为：
    - `src/acp-host.ts` 的 `rotateSession`：加 `--propose`；把 `rotated:true` 当作已换代；回包丢失时改用 `session-epoch` 判定，不再读 registry（`:144-145`）；新增 `confirmSession(id, sidEpoch)`（把本进程已持有的 `callerCred` 经上条 `runManagerProcess` 的 `input` 交给子进程，argv 只含 `set-session <name> <sid> --confirm <sidEpoch>`；返回值只看 CAS 回执）与 `attachSessionId()` 两个依赖（≤30 行）；
    - `src/lib/acp/clear.ts`：`rotateRegistry` 的返回类型加 `rotated` 与 `unresolved`；`createClearedSession` 在 `ok || rotated` 时返回已换代，`unresolved` 时返回新的 `unresolved` 结果；`rotateAcpHost` 增加 `unresolved()` 回调，`committed` 之后发确认（≤25 行）；
    - `src/lib/acp/host.ts`：`clearSession` 接 `unresolved`（停适配器，不接回旧线程）；`startAdapter` 的 attach SID 改由 `attachSessionId()` 给出，读不到就不 attach；attach 成功后按需确认（≤25 行）；
    - `src/bridge/clear-rotation.ts` 的 `claimRotatedSession`：`rotated:true` 按已提交处理（重挂、发事件），并在后台重试 T-pub（≤15 行）。`session-heal.ts` 只经它调用，不改；
  - `ledger-store.ts` 迁移列表（≤3 行）；manager 命令（≤30 行）。
  - `lend-mcp-profile.ts` 的 `LEND_ORDER_TOOLS` **不加**这个工具：出借 worker 看不到也调不到（`lend-tools.ts:101`、`acp/tool-proxy.ts:45` 已按白名单拒）。
- **fileGlobs**：上述新文件、`src/lib/run-manager.ts`（仅 `RunManagerOpts.input` 与 `runManagerProcess` 的受控 stdin 和回显剔除，候选净增 ≤8 行）、`src/lib/order-tools.ts`、`src/bridge/order-tools.ts`、`src/lib/caller-identity.ts`、`src/bridge/caller-identity.ts`、`src/lib/order-tool-route.ts`、`src/lib/caller-cred.ts`、`src/lib/caller-cred-launch.ts`、`src/lib/ledger-store.ts`、`src/manager/core.ts`（仅 `saveRegistry` 与迁移的发布语句）、`src/lib/state-backup.ts`（仅 `registry.json` 的恢复）、`src/manager/set-session.ts`、`src/manager.ts`（仅上列三处 SID 写入与 `session-epoch` 的命令登记）、对应 manager 命令文件，`src/acp-host.ts`（仅 `rotateSession` 与新增两个依赖）、`src/lib/acp/clear.ts`、`src/lib/acp/host.ts`（仅 `clearSession` 与 `startAdapter` 的 attach SID）、`src/bridge/clear-rotation.ts`（仅 `claimRotatedSession`），以及 `tests/author-takeover-*.test.ts`、`tests/caller-access-epoch*.test.ts`、`tests/registry-publish*.test.ts`、`tests/state-backup*.test.ts`、`tests/order-tool-route.test.ts`、`tests/caller-cred.test.ts`、`tests/ledger-migrate.test.ts`、`tests/acp-host.test.ts`、`tests/acp-fork-stub.test.ts`、`tests/clear-rotation.test.ts`、`tests/session-heal.test.ts`（只加新用例或白名单项），`tests/run-manager.test.ts`（只追加 T1–T5 真实子进程用例，≤60 行，不改现有断言）。ACP 宿主与 bridge 认领路径不在本稿首轮 P-B 范围内的话，须 PM 精确扩围；它们改变共享 ACP `/clear` 的失败语义，与 registry SID 写路径一起列入 owner 批准项。
- **依赖**：P-A 的事件格式（授予要绑定 `source`）。新增 MCP 工具会改变派单工具面，需 **PM 精确扩围**；凭据签发与撤销顺序、registry SID 写路径与全部 registry 发布改在 ledger 写锁内（新增“ledger 忙则 registry 写失败”的失败面）涉及身份凭据与会话的生命周期，需 **owner 批准**；把工具开放给出借 worker 不在本稿范围，另需 owner 批准。ACP 宿主把启动凭据经 stdin 交给 `set-session --confirm` 做确认，是现有启动凭据（今天只用于 bridge 注册）的新用途，同样列入 owner 批准项（第 7 版）；共享 runner 增加 `input` 端口改的是三十多处调用方共用的 transport，需 PM 精确扩围（第 8 版），它只是传输，批了它不等于批了凭据新用途；未批时提议式轮转只能停在阻断状态，不得退回第 6 版按 `epoch` 确认或由任意 publisher 清 NULL。任一未批，P-B 阻塞。
- **负例**：
  - 非真实 PM 授予（含 dispatcher）；body 里写 `verified:true`；未验证调用；
  - 错误 agent、SID 或 family；LIFE1 行缺失、retired 或 `cleanup_pending`；`role` 不是 `author`，或 `taskId` 不符；
  - 授予过期或已撤销；旧 nonce，或第二次接受（第二次接受返回幂等结果，不产生新效果）；
  - 授予后凭据被重新签发；迁移前启动、没有代次行或代次行 `sessionId` 为 NULL 的会话；
  - SID 轮转：授予之后、接受之前经真实 `cmdSetSession`（`/clear` 路径）把 registry 改成 SID-b，接受被拒；`commitRegistrySession` 第 1 步已提交、registry 尚未写（注入暂停），bridge 读到旧 SID-a，接受事务内与代次行 SID-b 不等被拒；第 1 步注入失败时 `set-session` 返回 `ok:false` 且 registry 不变；
  - 过时快照整份写回（复现第 3 轮 sid-rotate）：临时 registry 加临时 ledger。先用真实 `loadRegistry` 取得 SID-a 快照，再经真实 `commitRegistrySession`（`cmdSetSession`）轮转到 SID-b，然后用这份旧快照调真实 `saveRegistry`（以及真实 `cmdAgentLabel` 的同形交错）。断言 registry 文件的 SID 仍是 SID-b，其他字段按最后写者生效。之后对同一 agent 跑真实 `resolveCallerIdentity`，得到的 SID 是 SID-b，与代次行一致。对照：绕开 `publishRegistry` 直接写文件会复现审查观测到的 `acceptedSID=sid-b`、`currentCallerSID=sid-a`，守卫 ② 必须对这种写法报红；
  - 跨进程交错：两个子进程，一个在 T-pub 持有 ledger 写锁时注入暂停，另一个执行旧快照的 `saveRegistry`。后者被写锁挡住，直到前者 COMMIT 才发布，最终 SID 是 SID-b；交换启动顺序，结果相同；
  - T-rot 注入 COMMIT 失败（用延迟外键约束，让事务回调执行完、只在 COMMIT 时失败，沿用第 4 轮审查探针的形状）：断言 `inTransaction=false`，代次行仍是 SID-a，registry 文件逐字节不变，返回 `ok:false`。随后真实 `resolveCallerIdentity` 报 SID-a，按设计判据提交的绑定对这次真实调用 `bindingAllows` 为真；
  - 已接受（SID-a，`accessEpoch=e`）之后 T-rot 成功，T-pub 在 `rename` 后注入 COMMIT 失败，重试也注入失败：断言文件 SID 是已提交的 SID-b，`publishedEpoch=e < epoch=e+1`；此时执行 T-COMMIT 回滚，零新绑定；以 SID-b 新开的接受也因阻断状态被拒。一次成功的 T-pub 之后 `publishedEpoch=epoch`，PM 按 SID-b 重新授予可以走通；
  - 已接受之后 T-rot 成功，T-pub 执行前进程退出（kill 子进程）：同上，T-COMMIT 回滚；manager 启动收敛后阻断解除；
  - COMMIT 失败释放锁后别的连接先发布：进程 X 的 T-pub 在 `rename` 后注入 COMMIT 失败，锁释放后进程 Y 立刻完成另一次 T-rot（SID-c）与 T-pub。断言 X 不再写文件（实现里没有补偿写），文件最终为 SID-c、`publishedEpoch=epoch`，Y 的发布没有被旧内容覆盖；
  - ACP 已提交未发布（复现第 5 轮 acp-rotate，真实宿主）：真实 `AcpHost` 加 ACP stub 适配器（沿用 `tests/acp-host.test.ts` 与 `tests/acp-fork-stub.test.ts` 的 stub）、临时 registry 加临时 ledger，`rotateSession` 走真实 `cmdSetSession --propose`。T-rot 提交 SID-b，T-pub 在 `rename` 前注入失败。断言：宿主没进入 `failed`、适配器没被停、`cfg.sessionId=SID-b`，没有按 SID-a 再 attach；此时 `confirmPendingSidEpoch=sidEpoch`（第 8 版，修第 7 轮 pending-epoch-text：夹具先签发几次凭据，让初始 `epoch != sidEpoch`，断言比的是 `sidEpoch`，不得写成等于 `epoch`），T2 与 T-COMMIT 都拒。随后注入一次独立的 `saveRegistry`（任意 publisher）：`publishedEpoch=epoch`，但 `confirmPendingSidEpoch` 不变，接管门仍关闭。宿主重绑成功、发出确认之后，stub 实际 attach 的 SID、registry 文件的 SID、ledger `sessionId`、真实 `resolveCallerIdentity` 报出的 SID 四者都是 SID-b，接管门这时才开；
  - 同上，但 `set-session` 子进程回包丢失（注入超时）：宿主经真实 `session-epoch` 读到 SID-b，结果同上；`session-epoch` 也注入失败时宿主停适配器，`startAdapter` 读不到 ledger 就不 attach，恢复之后 attach 的是 SID-b，不是 SID-a；
  - 宿主在确认前崩溃，正常重签后恢复（第 7 版，复现第 6 轮 confirm-epoch，真实临时 canonical 集成正例）：提议 SID-b 提交、T-pub 失败后杀掉宿主；经真实 `launchWithCallerCred`（临时凭据库加临时 ledger）重启，断言 `epoch` 已推进、`credTag` 已换新、`sidEpoch` 与 `confirmPendingSidEpoch` 不变；之后发布成功 `publishedEpoch=epoch`。重起的真实 `AcpHost` 按 ledger attach SID-b、重绑后以新凭据发 `--confirm <sidEpoch>`，`confirmPendingSidEpoch` 清除；整个过程 stub 没有收到对 SID-a 的 attach，也没有另换 SID、没有人工清 NULL。随后 PM 新授予，新作者本人经真实 bridge 已验证调用 `accept_takeover` 接受，T-COMMIT 提交，真实 `takeOrderResult` 对新本人 SID-b 可领、对旧作者 SID 拒绝；两种顺序（先发布后重签、先重签后发布）都跑；
  - 旧宿主跨越撤销确认：同上时间线，重签提交之后用旧凭据（模拟残存的旧宿主进程）发 `--confirm <sidEpoch>`，零效果、`confirmPendingSidEpoch` 不变；凭据被撤销（`credTag=NULL`）后任何确认零效果；重启签发第 1 步注入失败（新宿主 `verified=false`、无凭据）时确认不了，阻断保持，下次签发成功后可确认；
  - ACP T-rot 注入 COMMIT 失败（保留第 4 轮的负例）：`rotated:false`，宿主走 `failed` 按 SID-a 接回，ledger、文件、attach 三者都是 SID-a，`confirmPendingSidEpoch` 为 NULL；
  - 伪确认：用错 `sidEpoch`、错 SID、不带凭据、凭据放在 argv 或 body 里而非 stdin，或在又一次 T-rot 之后用旧 `sidEpoch` 发 `--confirm`，都无效果；`publishRegistry` 与凭据换代不改 `sidEpoch` 与 `confirmPendingSidEpoch`（单测断言两列前后相等）；阻断期间 PM 授予被拒；
  - canonical stdin 端口（第 8 版，`tests/run-manager.test.ts`，真实合成子进程，不用 mock spawn；合成凭据是测试生成的随机串，不读任何真实凭据）：
    - T1：子进程把 fd0 全文、argv、env 回写到一个临时文件。断言收到的输入与 `input` 逐字节相同且只有一次、随后 EOF；argv 与 env 里都不含输入；两个并发调用各带不同输入，互不串扰；
    - T2：不传 `input` 的旧路径，子进程读 fd0 立即得到 EOF、不挂起，返回值与现有用例一致；
    - T3：大输入（8MB 级）而子进程不读 stdin、提前 `exit 3`：真实返回失败结果，不重试（子进程计数为 1）；spawn 失败与 `input` 类型不合法分别保留各自的异常语义（后者在 spawn 前抛、不起进程）；断言只写 Bun 1.3.14 上的行为，EPIPE 不抛不当成跨版本保证；
    - T4：传 `input` 时超时，照旧强杀并返回现有的超时错误，不挂在 stdin 写入上；
    - T5：子进程把输入原文回显到 stdout、stderr 和 `{ok:false,error}` JSON 里：最终结果与 `onStderr` 收到的文本都不含原文；空字符串输入时输出不被改写。同一用例注明：编码后（如 base64）或截断的回显不在保证范围内，测试不得以此声称已防住；
    - 旧宿主凭据、撤销后、空输入、凭据放 argv 的拒绝，属于 `set-session --confirm` 的 CAS 与 `caller_access_epochs` 真实临时集成（上面“旧宿主跨越撤销确认”“伪确认”两条），不由 runner 传输测试冒充；确认失败或没拿到有效 CAS 回执时断言 `confirmPendingSidEpoch` 不变、零新绑定；
  - 观测式已提交未发布：真实 `claimRotatedSession` 收到 `rotated:true`，仍重挂 watcher 并发一次 `session_rotated`，后台重试 T-pub 成功后 `publishedEpoch=epoch`；之后的 Stop 自愈因 `hookSid === from` 早退，watcher 已在 SID-b 上；
  - 凭据在 SID 发布未完成时换代：T-rot 已提交、T-pub 未完成时签发新凭据，断言 `publishedEpoch` 仍小于 `epoch`，接受仍被拒；
  - 守卫：`registry-publish.ts` 的失败分支里不得有文件写入（静态断言 `catch` 块内没有 `writeJson*` / `writeText*` / `rename`）；
  - ledger 写锁超时：`saveRegistry` 抛错，registry 文件逐字节不变（不降级直写）；
  - 静态守卫：① `src/` 中不经 `commitRegistrySession` 给 registry agent 赋 `sessionId` 即红；② 不经 `publishRegistry` 写 registry 文件（含 `state-backup` 恢复）即红；
  - 家族：凭据登记的 runtime 映射、registry 当前 runtime 映射、`to.family` 任一不等（含 `pi` 映射为 null）；body 里自报 `family`；
  - 凭据竞态：在接受事务持有写锁期间由另一进程调用真实撤销，撤销的 ledger 代次推进必须排在提交之后；反之代次先推进，接受必拒（复用审查探针的形状，用真实 `revokeCallerCreds`）；
  - 撤销第 1 步失败：文件记录仍被删除，旧连接 `verified=false`；
  - 工具面：出借 worker 调 `accept_takeover` 回 `lend_forbidden`；未知参数、缺 `v` 或 `grantId` 被 wire 校验拒绝。
- **正例**：
  - `ORDER_TOOLS` 公布 `accept_takeover`，`isOrderTool('accept_takeover')` 为真，channel-server 转发到 bridge（沿用 `tests/order-tool-route.test.ts` 对 channel-server 登记名单的覆盖方式）；
  - 真实 PM 授予 → 本人在 TTL 内经已验证调用接受 → 只出现一条接受事件，冻结的 `accessEpoch`、`sessionId`、`family`、`lifeCreatedAt` 与来源一致。
- **版本兼容**：旧 channel-server 不公布、旧 bridge 不认这个工具，接受无法进行，接管门保持关闭。`CallerIdentity` 新字段对旧调用方透明。旧库没有代次表时签发照旧写文件，但任何会话都无法接受（闭合失败）。

### P-C：canonical supersession（§3）

- **内容**：迁移、`supersedeAuthor` writer、T3 远端核验加 T-COMMIT、§3.4 中标为“改”的读口、提交后的凭据撤销（只针对本机旧作者）。
- **实现顺序**：第一个提交只做共用 canonical writer 抽取（§3.3 `replaceAuthorRow`），`applyFixReplacement` 行为零变化、现有测试原样通过；之后才写 `supersedeAuthor`。
- **新模块**：
  - `src/lib/author-supersession.ts`（writer、指纹、本机派单意图投影，≤150 行；只经 `replaceAuthorRow` 改作者行、任务与步骤）
  - `src/lib/author-supersession-schema.ts`（≤30 行）
- **薄接线**：
  - `fix-strategy-session.ts`：抽出 `replaceAuthorRow`，`applyFixReplacement` 改为调用（≤20 行净改，**必选前置**）；
  - `ledger-store.ts` 迁移列表与必需列（≤8 行）；
  - `scheduler-sessions.ts` 的 `taskSessionLinks`（≤6 行）；
  - `review-evidence-collect.ts`（≤8 行，核对后才动）；
  - `tests/ledger-migrate.test.ts` 写入模块白名单加 `author-supersession.ts`（1 行）。
- **fileGlobs**：上述文件（含 `src/lib/fix-strategy-session.ts`），以及 `tests/author-supersession*.test.ts`、`tests/order-take*.test.ts`、`tests/fix-strategy*.test.ts`（只加新用例）。
- **依赖**：P-A 与 P-B 合入；`fix-strategy-session.ts` 的精确扩围获 PM 批准。扩围未批时 P-C 阻塞，没有自带 SQL 的备选。
- **负例**（每条都断言零新绑定：作者行数不变、`tasks.agent` 不变、执行者不变、无 `author_takeover` 事件）：
  - 原 peer 单仍活或 `unknown`；B 结果待回执；错误 fp、gen 或 SID；
  - 有未交检查点（E2 缺失或 `preservation: failed`）；伪造的保全摘要与远端 head 不符；
  - 冒充的新作者、错误家族、过期授予、旧 nonce；
  - 两个提交并发（第二个回滚）；授予后任一来源漂移（指纹不同），包括本阶段又出现一条更新的 `dispatch` 意图；
  - 接受之后、提交之前凭据换代（ledger 代次推进）：提交回滚；registry runtime 被改成别的家族：`requireSessionIdentity` 在事务内拒绝；
  - **接受 → 真实轮转 → 提交**（复现第 2 轮 sid-rotate）：以 SID-a 接受后，经真实 `cmdSetSession` 轮转到 SID-b（临时 registry 与临时 ledger），再调用真实 `supersedeAuthor`：回滚、零新绑定；对照断言旧实现思路（只重跑 `requireSessionIdentity`）在同一状态下会通过，说明 SID 判据只能来自代次行；
  - **relay 未结**（复现第 2 轮 relay-gap）：出借单已 `done`，本卡仍有 `sending` 或未解决的 `unknown` relay，或 note 类 `pending`：授予与提交都拒；授予后新增 relay 行、relay 状态推进或写入解决记录：指纹不同，提交回滚；任何路径都不改写原 relay 行；
  - 事务中途失败（注入抛错 → 全部回滚，包括接管意图和 `author_supersessions` 行）。
- **正例**：必须是**真实的临时 canonical 集成**，用临时 ledger、真实迁移和真实 writer。依次执行：
  1. 种一张 peer 作者卡：本阶段有一条 `recipient='peer:*'`、`status='done'` 的派单意图，出借单 done，入账 E1/E2。提交前先断言现有 `takeOrderResult` 对新作者返回 `order=null` 加“由 peer 写”的说明（复现审查的 reader 反例）；
  2. PM 授予；
  3. 用 LIFE1 登记的新作者以已验证调用接受；
  4. 提交。
  - 断言：
    - 现有 `takeOrderResult` 对新作者的 `VerifiedCall` 返回这张卡的单，`orderId` 等于接管派单意图 id，没有“由 peer 写”的说明；
    - 原 peer 派单意图仍是 `done`、字段不变（历史保留）；
    - 对旧 peer agent 的 SID 和对同名新 SID 以外的会话都返回空；
    - `deliver` 的 `currentOrders` 同样只认新 SID。
  - 不允许用专门写的测试 helper 直接改表来“证明”。
- **版本兼容**：见 §3.2。

## 5. 负例总表（验收 5）

以下情况全部为零新绑定效果；每条在 §4 都对应到具体的前置卡。

- 接管不是换模型或换家族的通道。provider 的策略拒审（`refusal`，见 MODELX 的拒审纪元）不能借接管绕过：授予要求 `to.family === workflow.authorFamily`，换家族只能走 CONV 规则加对应批准。
- 原作者仍活、`unknown`、结果待回执，或 fp、gen、SID 不符。
- 有未交检查点、假保全，或保全失败/`unknown`/dirty 后仍删了目录：结算删除与 `stopped` 24h 清理（`sweepStoppedWork`）共用同一持久保全门，未放行一律保留现场。
- 冒充的新作者、错误家族（凭据映射、registry 映射、授予三者任一不等）、过期授予、旧 nonce、二次接受、授予后重启。
- 凭据换代或 SID 轮转与提交竞争：换代（含只改 registry SID 的 `/clear`）的 ledger 代次推进先于提交则提交回滚；不经 SID 赋值、拿旧快照整份写回 registry（如 label 写者）不能把 SID 改回旧值，因为全部 registry 发布都在 ledger 写锁内按代次行覆盖 SID；不以读 `caller-creds.json`、重读 registry、重跑 `requireSessionIdentity` 或比较 `issuedAt`/SID 代替同步。
- ACP 提议式轮转已提交、尚未发布（T-pub 在 `rename` 前失败，或回包丢失）：宿主不按旧 SID 接回，按 ledger 留在新 SID；任意 publisher 推进 `publishedEpoch` 也不开门，只有持 ledger 当前凭据的宿主在 attach 并重绑后按 `sidEpoch` 确认才开，确认前重签凭据不影响确认；伪确认（错 `sidEpoch`、错 SID、过期 `sidEpoch`、旧宿主持旧凭据或无凭据）零效果。
- A 侧 relay 未结：本卡出借单有 `pending`、`sending`，或没有真实 PM 解决记录的 `unknown` relay；B 的 `pendingPayload:false` 不能代替；不伪造 `sent`/`dropped`，不改原行。
- 只换绑定、不换派单投影：原 `done` 的 peer 派单仍是 `currentIntent` 时新作者拿不到单，因此提交必须同时落本机派单意图；正例经真实 `takeOrderResult` 断言。
- 并发双 writer：`BEGIN IMMEDIATE`、指纹和部分唯一索引三层兜底。
- 任一来源漂移：卡、工作流、步骤、出借单、租约、意图、绑定、LIFE1 行、接入代次行（凭据或 SID）、`lend_relays` 与解决记录、E1/E2 事件。
- 事务失败：整体回滚。外部效果（凭据撤销）只在提交之后做。

## 6. 现有能力与缺口一览（验收 6）

| 能力 | 现状 | 本稿处理 |
|---|---|---|
| A 侧活单、unknown、未结意图的判据 | 有（`LEND_LIVE`、`captureReborrowFacts`） | 复用 |
| 本机旧作者 archive/kill | 有（`stopConvergenceAuthor`） | 本稿不需要；后续本机→本机接管可复用 |
| peer 已停的 A 侧证据 | 只有 CONV3 的 `cleanExit`，且只覆盖撤单和自报停 | P-A 补“已 done 单的退出加保全” |
| 删除前保全 | 只有续借路径在 B 本地做；`settleOrder` 与 `sweepStoppedWork` 都不看保全 | P-A 用一个持久保全门覆盖全部删除入口（§4 P-A 表），并把摘要回传 A |
| PM 授予、TTL、单用 | `resume-grant` 有 TTL，单用是隐式的；`ask-bind` 被注明不是安全边界 | P-B 新建显式授予与接受 |
| 新作者历史身份 | `VerifiedCall.sessionId` 是 registry 当前值，`/clear` 等路径直接改文件、不推进任何代次；`requireSessionIdentity` 不核 SID；LIFE1 不进门、没有 family；凭据文件与 ledger 不同步 | P-B 把凭据与 registry SID 的改写都并入 ledger 接入代次（先 ledger 后文件），全部 registry 文件发布收拢到 `publishRegistry`，在 ledger 写锁内按代次行覆盖 SID，挡住过时快照的整份写回；ACP 等提议式轮转另由 `confirmPendingSidEpoch` 挡到宿主本人确认，宿主按 ledger 决定 attach 哪条线程；LIFE1 只核 SID/role/task/注册代次；家族由凭据与 registry 经 `runtimeFamily` 核对后冻结 |
| 新作者能领单 | `currentIntent` 会选中原 `done` 的 peer 派单，`lentAway` 挡住本机 | P-C 提交时落一条本机 `dispatch` 意图，原 peer 派单保留 |
| 本人接受工具 | 无 | P-B 在 `ORDER_TOOLS` 与 bridge `HANDLERS` 两侧接线，出借 profile 不开放 |
| 共用作者替换 writer | 只有 `applyFixReplacement` 内联语句 | P-C 先抽 `replaceAuthorRow`，两条路径共用；未批扩围则阻塞 |
| 行政替换和退役分列 | 没有；fix swap 和 CONV3 回收都只写 `retired` | P-C 增加 `supersededBy` 和 `author_supersessions` |
| A→B 补充的发送结果 | `lend_relays` 有 `pending/sending/unknown`；`unknown` 没有权威解决入口，只有 PM 通知；`captureReborrowFacts` 不读 relay | P-A 加 `lend_relay_resolutions` 与真实 PM 入口，解决必须晚于 E1 且绑定其 seq（按台账序号，不比 `updatedAt`）；§3.3 前置 8 把 relay 行纳入判定与指纹，原行不改 |
| 旧 WIP 不丢 | B 侧 `acked/cancelled` 直接删目录，`stopped` 24h 后删目录 | P-A 两条路径都先过保全门；历史上已删的不补造（REBOR2 仍 blocked） |

**验证边界。** 本稿合入前要做三件事：另一家族完整设计审、当前 head 的 CI 三项、`bun run check` / guard。本稿只是设计输入：

- 最终实施范围（尤其 §3.3 的共用 writer 扩围、§3.4 中“核对”的读口、P-A 的 retention 接线、P-B 的 `order-tools.ts`、`caller-cred.ts` 与 registry SID 写路径接线、共享 runner `run-manager.ts` 的 `input` 端口、ACP 宿主（`acp-host.ts`、`lib/acp/clear.ts`、`lib/acp/host.ts`）与 `claimRotatedSession` 的三态接线、P-A 的 relay 解决入口）由 PM 精确核定。共用 writer 是 P-C 的必选前置，不批则 P-C 阻塞。
- §1.3 的协议升级和任何签名用途、§2.3 凭据签发与撤销、registry SID 改写顺序以及全部 registry 发布进 ledger 写锁的改变、共享 ACP `/clear` 失败语义的改变（已提交未发布不再接回旧线程，ledger 读不到时不 attach），以及 P-B 的工具开放范围，由 owner 另行批准。
- 本稿不自批任何一项。
