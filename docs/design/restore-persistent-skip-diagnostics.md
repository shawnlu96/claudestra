# LSTSKIP1 · 自动恢复「持久跳过」诊断设计

状态：设计稿（specRev 1，基线 head `6656cf461acd`，依赖 LSTGUARD1 verified）。本卡只改本文件，不改源码、测试、配置、机器设施或权限。
来源：正式安全审查事件 66007 的 P2 `restore-precheck-refusal-as-skip`。原报告与计数保持原样；**本文发布不关闭该 P2，未实现前不称问题已修**。
本文定义的 on / observe / off 与「默认 observe」只是设计默认，**不批准生产启用，也不批准新实现**；实现须按 §10 另立卡。

一句话结论：现行源码里，恢复预检的拒绝一律记成 skip——不算成功、不扣失败额度、不告警（LSTGUARD1 的边界，保留）。
这对暂态是对的，但登记长期缺项的 agent 会每轮被捡起、每轮被跳过，launcher 状态里不留任何痕迹，也没有人被告知（§3 隔离夹具实跑 12 轮：12 次子进程、0 告警、failures 恒 0）。
本设计在恢复路径**之外**加一个只读旁路：按同一登记代次累计「连续、无暂态证据的跳过」，够久才诊断；能由结构化字段证明的记「登记缺项」，证明不了的走「待核」并写明证据限制；
通知只发给正式项目 PM 绑定，同一条诊断记录每类最多一次（出现恢复证据后再次持续跳过才算新的一条，至少 30 分钟之后）。它不重启、不发键、不修登记、不碰恢复预算。

---

## 1. 固定对照（基线 `6656cf461acd`，只读）

| 文件（blob 前 12 位） | 本设计依赖的事实 |
|---|---|
| `src/launcher.ts`（`24d2b2fb6a77`） | `restoreDeadAgents`（:674）：`manager list` → `restoreGate.select` → 逐个 `restoreGate.restart(agent, () => manager restart --restore-expect <观测> -- <name>)`；:727 `why?.startsWith("skipped:")` 只 `skipped++`，**跳过原因不落日志**；`select` 为空在 :700 提前返回。巡检间隔 `DEAD_AGENT_CHECK_INTERVAL_MS = 60_000`（:107），波内租约 `restartWaveUntil`（:663、:706、:733）。launcher 当前**不读台账** |
| `src/lib/launcher-restore-gate.ts`（`38f22410ff7a`） | 状态 `launcher-restore-gate.json`，写者只有 `LauncherRestoreGate.transaction`（文件锁 `acquireLock(…, 1000)` + `commitIf: lock.held()`）。代次 `generation(a) = JSON.stringify([created, sessionId, channelId, cwd])`（:35，**未导出**）。`restart()`：先预占 `failures++`，子进程结果带 `skipped`（:208）则 `failures = max(0, failures - 1)`（:217）、不告警，返回 `skipped:<文本>`；gate 自身拒绝返回 `launcher restore gate: restore limit reached`（:199）或状态故障文本（都是普通字符串） |
| `src/manager.ts`（`213cdd896a61`） | `cmdList`：登记 `active`、窗口没了（或停在裸 shell）即 `status: "dead"`，带 `restoreExpect`、`sessionId`、`channelId`、`projectId`（:1512–:1527 停在裸 shell 的窗口，缺字段输出 `""`；:1561–:1574 窗口没了的，字段原样透出，缺了就是没有这个键）；带 pending 的条目由 `pendingHoldsOffHeal` 挡在 dead 之外。`cmdRestart`：:1257 缺 `sessionId` / `channelId` 直接出失败条目；:1265 重启锁被占出「另一个 restart 正在进行」；拿锁后 `expectSkip`；结尾 `markExpectSkips(results, opts.expect ?? opts.restore)` |
| `src/manager/restart-expect.ts`（`8123eea7b1b9`） | `markExpectSkips`：带 `--expect` / `--restore-expect` 时，复核通过前被拒的结果一律补 `skipped: "复核前已拒：…"`（自由文本） |
| `src/manager/restart-expect-restore.ts`（`b0dfc4aedb0d`） | `restoreObservations`：窗口清单读不到返回 `{}`（无恢复授权）。`restoreSkip`：线格式、身份（8 项）、窗口 ID、死活探测任一不符或读失败 → `skipped: String(e)`。`parse` 私有；导出的 `restoreWindowIds(raw, target)` 会调它，线格式不合格即抛 |
| `src/manager/restart-lock.ts`（`b4fe0ae1a4ed`） | `tryLockRestart` / `isRestartInProgress(name)`（只读：读锁文件 + `kill(pid, 0)`；锁超过 3 分钟或持有进程已死按没在跑） |
| `src/lib/pm-role.ts`（`574f1eb1d7d5`） | `activeProjectPm(db, project)`：`activePm` 指针，否则 `pms` 里第一个非 dispatcher，**都没有返回 `null`**；指针格式坏会抛 |
| `src/lib/pm-notify.ts`（`104719d525e6`） | `notifyProjectPm`：无绑定时**回落 `"master"`**，失败只抛错（丢掉 `sent`）——见缺口 G5 |
| `src/lib/bridge-client.ts`（`fbe16528f25f`） | `bridgeSend`：`{ ok: true }`；`{ ok: false, sent: false }` = 帧没发出或 bridge 以 typed `rejected` 拒绝，可以再排；`{ ok: false, sent: true }` = 结果未知，不得盲目重发 |
| `src/lib/ledger-read.ts`（`c3875ed456c6`） | `LedgerReader.get()`：`PRAGMA query_only = ON` 的只读连接；库不存在返回 `null` |
| `src/lib/file-lock.ts`（`6b8db5eb35ee`）、`src/lib/state-file.ts`（`e2ed4c90577c`） | `acquireLock` / `LockHandle.held()`、`readJsonStateSync`（`missing` / `corrupt` / 数据三态）、`writeJsonAtomicSync(…, { mode, commitIf })` |
| `src/lib/notify.ts`（`67af8f080ccb`） | `notify()` 发系统通知到指定频道，失败写 `undelivered-alerts.log`；`recordUndelivered` 私有 |

监护路径（调度服务的 `restart --expect`，`docs/architecture/agent-supervisor.md`）有自己的台账留痕（`restart/done/skipped`），不在本卡范围；本设计只管 launcher 的 `--restore-expect` 路径。

## 2. 现行表现与 P2 的关系

跳过在 launcher 侧只有一个可见事实：`gate.restart` 返回以 `skipped:` 开头的字符串。它背后至少有这些来源，launcher 现在分不开，也不记录：

| 来源 | 性质 | manager 给出的东西 |
|---|---|---|
| 登记缺 `sessionId` / `channelId` | 持久，直到有人改登记 | `复核前已拒：registry 中缺少 sessionId 或 channelId`，或 `invalid restore identity` |
| 线格式其它不合格（同名多窗口、身份字段含控制字符、超过 2048 字节、rename 做到一半） | 多为持久（由源码推出，本卡未实跑） | `invalid restore observation` / `invalid restore identity` 等 |
| 另一个 restart 持锁 | 暂态（锁 3 分钟过期，launcher 子进程 300 秒超时） | `复核前已拒：另一个 restart 正在进行，已跳过` |
| 窗口清单 / registry 读失败、死活未知 | 暂态或未知 | `JSON Parse error`、读错误原文、`restored or liveness unknown` |
| 身份换代（会话被替换） | 正常，旧观测作废 | `restore identity/state changed` 等 |
| 排队期间已被前一个 restart 救回 | 正常 | `restored or liveness unknown` |

右列全部是自由文本，本设计**不用它做分类**（§4.2）。P2 的实质是第一、二行：skip 回退 failures 之后，没有任何有界、可见的东西表示「这个 agent 已经被跳过很久了」。

## 3. 隔离夹具实跑（现行源码的行为，不是新机制）

**这是真实执行**：直接 import 基线源码的 `LauncherRestoreGate`、`restoreObservations`、`expectSkip`、`markExpectSkips`、`restoreWindowIds`、`tryLockRestart` / `isRestartInProgress` / `unlockRestart`，
用注入的假 `RestoreDeps`（registry / windows / dead / children）和 `mkdtemp` 私有目录跑。`env -i` 只带 `PATH`、私有 `HOME` / `TMPDIR`、`CLAUDESTRA_STATE_DIR` / `CLAUDESTRA_RUNTIME_DIR`（都在 scratchpad 下）、`CLAUDESTRA_TEST=1`、`NODE_ENV=test`、`BRIDGE_URL=ws://127.0.0.1:9`；
没有起 manager 子进程，没有碰真实 tmux、registry、台账或 bridge。本机 Bun 1.3.10，6 个用例 47 个断言全过。夹具放在 scratchpad（`baseline.test.ts`，sha256 前 16 位 `1f328b3d0914d7ba`），**不入仓**。
**边界**：`cmdRestart` 本体没有跑——S1a、S3 的拒绝条目按 `src/manager.ts:1257` / `:1265` 的字面值手工构造后交给真实的 `markExpectSkips`；每个用例换一个 agent 名，因为 `markExpectSkips` 的「已通过」集合是进程级的（生产里一条命令一个进程）。

| 场景 | 做法 | 实测结果 |
|---|---|---|
| S1a 登记缺项持续 | 登记行 `sessionId: ""`，12 轮 `select` → `restart` | 12 轮都被选中、12 次进入子进程回调；`why` 只有一个取值 `skipped:复核前已拒：registry 中缺少 sessionId 或 channelId`；告警 0；gate 条目 `failures: 0, missingAlert: false, failureAlert: false`；死活探测调用 0；`restoreWindowIds(观测, 名字)` 抛错 |
| S1b 登记缺项持续 | 登记行没有 `sessionId` 字段，12 轮，走真实 `expectSkip` → `restoreSkip` | `why` 只有 `skipped:Error: invalid restore identity`；告警 0；`failures: 0`；死活探测 0 |
| S2 合法身份恢复 | 身份未变、窗口确认死 | `expectSkip` 返回 null（放行 1 次），`why = null`，`failures: 0`；下一轮该 agent `active` + idle，`select` 返回空 |
| S3 持锁冲突 | 真实 `tryLockRestart` 占锁后再抢 | 第二次抢锁 `false`，`isRestartInProgress` 为 `true`；`why = skipped:复核前已拒：另一个 restart 正在进行，已跳过`，`failures: 0`，告警 0；释锁后 `isRestartInProgress` 为 `false`，下一次恢复 `why = null` |
| S4 读失败 | ①窗口清单抛错 ②registry 抛错 ③死活探测答「没死 / 未知」 | ①`restoreObservations` 返回 `{}`，launcher 传 `""` → `skipped:SyntaxError: JSON Parse error: Unexpected EOF` ②`skipped:Error: registry unreadable` ③`skipped:Error: restored or liveness unknown`；三次后 `failures: 0`、告警 0（`dead` 被调 1 次，就是③自己的探测） |
| S5 身份换代 | 代次 1 先记 1 次真实失败，再把登记换成新会话 | 旧观测 `skipped:Error: restore identity/state changed`，死活探测 0，代次 1 的 `failures` 保持 1；新代次进 `select` 后条目换成新 `generation`、`failures: 0`，不继承 |

读法：S2–S5 证明 LSTGUARD1 的边界在基线成立（暂态不扣预算，未知 / 读失败 / 换代不碰窗口）。S1 证明 P2 的现行表现：持久原因与暂态在 launcher 侧得到完全相同的处理，而且不留痕。

## 4. 设计

### 4.1 位置与不变量

新机制是 `restoreDeadAgents` 尾部的一个**旁路**：它只拿到本轮已经产生的值（`manager list` 的行、`select` 选中的名单、每个 agent 的恢复结果种类），在 gate 的事务提交之后运行，自己的任何异常都在内部吞掉并写一行本机日志。不变量：

1. 不调用 `manager restart`，不发任何 tmux 键，不写 registry，不删重启锁。
2. 不读写 `launcher-restore-gate.json`，不调用 gate 上任何会改状态的方法；`failures`、告警去重、30 分钟冷却、`restartWaveUntil` 都不受它影响。
3. LSTGUARD1 的判定原样保留：skip 不算成功、不扣失败额度；未知 / 读失败 / 身份漂移不产生窗口副作用。本设计不靠增加恢复次数来处理坏登记。
4. 诊断只回答「被跳过了多久、有什么结构化证据」，不回答「agent 在不在线」。

### 4.2 证据：只用真实、允许读取的既有状态

| 证据位 | 来源 | 含义 |
|---|---|---|
| `outcome` | 本轮 gate 的结果种类：`skip` / `ok` / `fail` / `gate_refused` / 未被选中 / 不再 dead / 不在名单 | `skip` 用 gate 自己按结构化 `skipped` 字段加的 `skipped:` 前缀判（launcher :727 已在用）；`fail` 与 `gate_refused` 现在都是普通字符串，分不开——缺口 G2 |
| `gap` | 本轮 `manager list` 行的 `sessionId` 或 `channelId` 为空串或没有这个键 | 登记缺项的结构化事实（`cmdList` 两条 dead 路径对缺失字段分别输出 `""` 和不输出，见 §1） |
| `wireInvalid` | 行带 `restoreExpect` 且 `restoreWindowIds(restoreExpect, name)` 抛错 | 观测线格式不合格（只有合格 / 不合格两态，说不出是哪一项） |
| `noAuthority` | 行的 `restoreExpect` 缺失或为空 | 窗口清单没读到，这一轮对登记什么都证明不了 |
| `lockBusy` | 该 agent 的结果回来后同步调一次 `isRestartInProgress(name)` | 此刻另有 restart 持锁 |
| `gen` | gate 的同一个四元组 `[created, sessionId, channelId, cwd]`，状态里只存它的 sha256 前 32 位十六进制 | 登记代次 |

**不使用**：`skipped:` 后面的文本、manager 的 stderr、pane 内容、任何在线 / 空闲推断。跳过文本只在本机日志里截 200 字符原样显示，标注「未归类原文」，不进状态文件，不进通知。

### 4.3 起点、累计、分类

常量（设计默认）：`N_MIN = 10` 轮，`T_MIN = 30 分钟`，两条都满足才分类。取 30 分钟是因为它明显长于已知暂态的上界：重启锁 3 分钟过期、launcher 子进程 300 秒超时、恢复波租约 10 分钟。

每个 agent 至多一条记录，按下面的顺序处理一轮（先命中先停）：

| # | 条件 | 动作 |
|---|---|---|
| R0 | `manager list` 失败、诊断锁没拿到、诊断状态不可读 | 整轮不动（不推进、不终止、不写） |
| R1 | agent 不在本轮名单里 | 删记录（`removed`） |
| R2 | 记录的 `gen` 与本轮不同 | 删旧记录（`superseded`），本轮按无记录继续 |
| R3 | 不再 dead，或 `outcome = ok` | 删记录（`recovered`）——合法恢复 |
| R4 | `outcome = fail`（预检已通过后的真实失败） | 删记录（`failed_counted`）；它归既有失败额度和既有告警 |
| R5 | dead 但未被选中，或 `gate_refused` | 保持（gate 自己的熔断 / 缺目录 / 状态故障告警在管） |
| R6 | `skip` 且 `lockBusy` | 连续性中断：计数与起点清零，**保留已发通知的去重记录** |
| R7 | `skip` 且 `noAuthority` | 保持，不推进；`unreadableRounds++`，记 `firstUnreadableAt` |
| R8 | 其余 `skip`（合格轮） | 没有起点就把**本轮时刻**记为 `startedAt`（不回填更早的时间）；`skipRounds++`，`gap` 成立则 `gapRounds++`，`wireInvalid` 成立则 `wireInvalidRounds++` |

分类（R8 之后，`skipRounds ≥ N_MIN` 且 `now − startedAt ≥ T_MIN`）：

- **`registration_gap`（登记缺项）**：`gapRounds === skipRounds`，即每一个合格轮都看到结构化的缺项事实。
- **`pending_review`（待核）**：其余情况。只断言「同一登记代次连续 N 轮、历时 T 被预检跳过，期间没有持锁证据，也没有恢复证据」，**不断言原因**。`wireInvalidRounds` 作为证据位随记录保存，但不升级成「登记缺项」——同名多窗口同样会让线格式不合格，而那不是登记问题。
- **`unreadable_inputs`（输入不可读，仅本机）**：`unreadableRounds ≥ N_MIN` 且 `now − firstUnreadableAt ≥ T_MIN`。只写本机诊断，**永不通知 PM**。

暂态如何被排除：持锁被采到 → R6 清零；持锁没被采到（锁在采样前释放了）→ 记 1 个合格轮，但那次 restart 的结果会在随后几轮表现为 R3 / R4，远不到 30 分钟；
读失败 → R7 不推进；换代 → R2 从零开始。无法可靠区分时一律落到「待核」，不猜。

### 4.4 终止、重启重建、新代次

- **恢复终止**：R3 / R4 删记录。之后同一代次再次被持续跳过，是一条新记录，要重新累计满 `N_MIN` 和 `T_MIN` 才会再诊断。
- **launcher 重启**：状态在文件里，重启后接着数；内存里不保存任何去重所需的东西。
- **状态文件丢失**：从零重建，起点是重建后第一个合格轮，不回填。代价是同一代次最多可能再通知一次（且至少 30 分钟之后）——这是已知限制。
- **状态文件损坏**：诊断暂停（不写、不通知），每个 launcher 进程打一行本机日志；**不自动覆盖**，证据留在原地；恢复不受影响。人工删除或修好文件后按上一条重建。
- **新代次**：`gen` 变了就是新记录，旧代次的计数、分类、通知状态都不继承；新代次可以独立再诊断、再通知。

### 4.5 通知（仅 on）

**收件人**只来自正式项目 PM 绑定：项目取本轮 `manager list` 行的 `projectId`；PM 取 `activeProjectPm(db, projectId)`，`db` 来自 `LedgerReader.get()` 的只读连接。下面任一情况都记 `no_target`，**只做本机诊断，不发任何帧**，也不回落 owner / master / 控制频道：

- `projectId` 为空；台账不存在或打不开；`activeProjectPm` 返回 `null` 或抛错；
- PM 名不是本机 `agent-…` 形态（含 `@` 或以 `peer:` 开头的会被 bridge 当成跨机路由）；
- PM 不在本轮 `manager list` 里，或它登记的 `projectId` 不是这个项目（防止发到别的项目）；
- PM 就是被诊断的那个 agent 自己。

`no_target` 每 30 分钟最多重新解析一次（一次本地只读，绑定可能后来才建），只有结果变了才再打日志。这就是「既有重试」：不新增重试机制，靠的是原有的每分钟巡检再走到这里。
不看 list 的 active / idle 去猜 PM 在不在线；投递结果只认 `bridgeSend` 的返回。

**去重与限流**：

- 去重键 = `agent | gen | 类别`，记在该 agent 的记录里；记录不删（见 R6）就不会重发。会通知的类别只有两个，所以一条记录存续期间最多发两条。
- 每个项目 30 分钟内最多一条消息，一条消息最多列 10 个 agent，余下的等下一个窗口。
- 每轮最多给 3 个项目发消息，每次发送超时 30 秒；上一轮的发送还没结束时本轮不发（状态照常更新）。
- 所以同一个错误不会每分钟唤醒 PM：同一 agent 两次诊断之间至少隔 `T_MIN`，同一项目两条消息之间至少隔 30 分钟。

**发送步骤**（先认领后发送，与 gate 的 `announce`、监护的 claim 同一做法）：

1. 事务内把该键写成 `claimed`（`attempts + 1`、`claimedAt`），同时写项目的 `lastNoticeAt`；提交失败就不发。
2. 重新读一次状态：记录还在、`gen` 没变、认领还是这一次，才发；否则记 `cancelled`，不发。
3. `bridgeSend({ type: "route_to_agent", targetName: <PM>, text, fromName: "launcher", oneShot: true }, { timeoutMs: 30_000 })`——与 `pm-notify.ts:16`、`agent-supervisor-deps.ts:48` 相同的调用形态。
4. 事务内落结果（记录、`gen`、`claimedAt` 都对得上才写）。

**送达三态与重试边界**：

| `bridgeSend` 返回 | 记为 | 之后 |
|---|---|---|
| `ok: true` | `delivered` | 不再发。含义只是「bridge 受理了这次路由」，**不等于 PM 已读或已确认**；诊断记录继续开着，直到 R1–R4 |
| `ok: false, sent: false` | `failed` | 帧没发出或被 typed 拒绝，可以重试：受同一个 30 分钟项目限流约束，每个键最多 3 次；用完保持 `failed` |
| `ok: false, sent: true` | `unknown` | **不自动重发**（可能已经送到，重发会重复唤醒）；也**不记成已送达** |
| 认领后进程崩溃，重启时 `claimed` 已超过 60 秒 | `unknown` | 同上 |

`failed`、`unknown`、`no_target` 都不吞：记录保持打开，状态里看得到，每次状态变化打一行本机日志。本设计不引入「PM 确认」这个动作，也不替任何既有流程确认或关闭东西。

**公共正文**只含：项目 id、agent 名、类别、已持续的轮数与起始时间、固定的说明句和只读核对命令（`manager list`）。
**不含** `sessionId`、`channelId`、`cwd`、状态文件路径、家目录、跳过原文。示意：

```
[launcher 恢复诊断] 项目 <projectId>：下列 agent 的自动恢复已被预检连续跳过 ≥30 分钟（同一登记代次）。
跳过不计入恢复失败额度；launcher 没有重启它们，也没有改登记。
- <agent>：登记缺项（会话或频道登记为空），已 N 轮，自 <时间> 起
- <agent>：待核（原因未归类），已 N 轮，自 <时间> 起
只读核对：manager list。同一次诊断每类只通知一次。
```

### 4.6 多项目互不连坐

记录按 agent 独立；限流、收件人解析、认领、发送、结果都按项目独立并各自 try / catch。项目 A 的 `no_target`、`failed`、`unknown` 或台账读错不影响项目 B 的诊断与通知；一个 agent 的记录也不影响同项目其它 agent 的分类。

## 5. 状态所有权、writer、并发

| 项 | 设计 |
|---|---|
| 状态文件 | `statePath("launcher-restore-skip-diag.json")`，权限 `0o600`，与 `launcher-restore-gate.json` 是两份独立文件 |
| 所有者 | launcher 进程 |
| 唯一 writer | 未来的 `src/lib/restore-skip-diag.ts` 里的一个事务函数，只由 `restoreDeadAgents` 调。manager、bridge、调度服务、cron、web 都不写 |
| 只读接线 | launcher → gate：只读它的返回值；launcher → 台账：`LedgerReader` 的 `query_only` 连接，只在 on 模式开；launcher → 重启锁：`isRestartInProgress` 只读。其它 daemon 以后要展示诊断，也只能读这份文件 |
| 文件锁 | `acquireLock(<path>.lock, 1000)`，与 gate 同一端口、同一等待上限；拿不到 = 本轮 R0，绝不无锁写，也绝不让恢复等它 |
| CAS | 事务内「读 → 改 → `writeJsonAtomicSync(…, { mode: 0o600, commitIf: () => lock.held() })`」，锁丢了就不提交；状态带 `rev`，每次提交 +1；通知结果按 `gen + claimedAt` 比对后才落 |
| 租约 | 不借用任何租约。`restartWaveUntil` 是恢复波自己的内存租约，诊断不读不写；调度服务租约（`scheduler-lease-env.ts`）与 launcher 无关，launcher 进程没有它 |
| 并发 | boot 与 periodic 两轮重叠、launcher reload 时新旧进程短暂并存，都由文件锁 + `commitIf` 串行；发送有进程内「在发」标志，重叠轮不重复发 |
| 界限 | 记录数 ≤ 本轮名单里的 agent 数，硬上限 256（超出的不建记录，本机日志每轮一行）；计数器封顶 100000；状态里没有自由文本；每条记录字段固定 |

记录字段（v1）：`gen`、`project`、`startedAt`、`lastAt`、`skipRounds`、`gapRounds`、`wireInvalidRounds`、`unreadableRounds`、`firstUnreadableAt?`、`klass?`、`localOnly?`、
`notices: { <类别>: { state, attempts, claimedAt, nextAttemptAt? } }`；顶层另有 `version: 1`、`rev`、`projects: { <id>: { lastNoticeAt } }`。

**本设计不写台账，不新增授权**。launcher 没有台账写身份：`resolveActor` 对没有频道号的环境判为 `owner`，`scheduler-supervise` 只认 `actor === "scheduler"`。让 launcher 直接跑台账写命令等于用 owner 身份写，本文不这么做，也不假称有通用 writer（缺口 G6）。

## 6. 模式

开关：launcher 进程环境变量 `LAUNCHER_RESTORE_SKIP_DIAG`，启动时读一次（与 `CONTROL_CHANNEL_ID`、`MASTER_EFFORT` 同一读法），不改任何配置文件格式。缺省 `observe`；认不出的值按 `observe` 并在启动时打一行日志。

| 模式 | 做什么 | 不做什么 |
|---|---|---|
| `off` | 什么都不做：模块不加载（动态 import 只在非 off 时发生） | **零附加写**：没有状态文件、锁文件、日志行；不开台账、不采重启锁、不发帧 |
| `observe`（默认） | 累计、分类，写自己的状态文件，状态变化时打本机日志（含截断的跳过原文） | 不开台账、不解析 PM、不发任何帧；不改恢复结果、预算、告警或波租约 |
| `on` | observe 的全部，加 §4.5 的通知 | 仅诊断：不重启、不发键、不修登记、不清锁、不改 gate |

与原恢复路径共存：三种模式下 `select` / `restart` 的入参、返回值、调用次数、gate 文件内容都应逐字节相同（§10 矩阵 M9、M10 用差分验证）。

## 7. 确定性推演（新机制，**不是实跑实现**）

新机制没有实现。下表是把 §4.3 的规则写成一个纯函数参考模型（无 IO，scratchpad `model.ts`，sha256 前 16 位 `50d45f6954e49414`，不入仓）后跑出来的事件序列，用来核对规则自洽和数字。
假设每轮间隔 75 秒——源码常量是巡检 60 秒加波后冷却 60 秒，**实际周期本卡没有测量**。

| 场景 | 输入序列 | 模型输出 |
|---|---|---|
| 登记缺项持续 | 60 轮 `skip` + `gap` | 第 25 轮（30.00 分）分类 `registration_gap` 并产生 1 次通知意图；之后 35 轮没有新事件 |
| 合法身份恢复 | 3 轮 `skip` → 不再 dead | 第 4 轮 `recovered`，无分类、无通知 |
| 合法身份恢复 | 2 轮 `skip` → `ok` | 第 3 轮 `recovered`，无分类 |
| 持锁冲突 | 40 轮 `skip` + `lockBusy` | 没有任何事件，记录的计数始终为 0 |
| 持锁冲突（没采到锁） | 1 轮 `skip` → 不再 dead | 第 2 轮 `recovered`，无分类 |
| 读失败（短） | 5 轮 `noAuthority` → `ok` | 第 6 轮 `recovered`，无分类 |
| 读失败（长） | 40 轮 `noAuthority` | 第 25 轮只出本机 `unreadable_inputs`；`skipRounds` 为 0，通知 0 |
| 身份换代（诊断前） | 20 轮 `skip` + `gap`（25 分）→ 新代次 `ok` | 第 21 轮 `superseded`，无分类、无通知 |
| 身份换代（诊断后） | 代次 1 缺项 30 轮 → 代次 2 缺项 30 轮 | 第 25 轮代次 1 通知；第 31 轮 `superseded`；代次 2 从零数，第 55 轮（67.50 分）独立通知 |
| 原因不明 | 30 轮 `skip`、无 `gap` | 第 25 轮分类 `pending_review` |
| 缺项后真实失败 | 12 轮 `skip` + `gap` → `fail` | 第 13 轮 `failed_counted`，无分类 |
| gate 熔断穿插 | 12 轮 `skip` → 5 轮未被选中 → 13 轮 `skip` | 未选中的 5 轮不推进也不终止；第 25 轮分类（`skipRounds = 20`） |

对照验收：持久问题在 30 分钟处变得可诊断；持锁、读失败、换代、合法恢复都不产生 PM 通知。这些场景里「不扣预算、不触窗口副作用」来自现行源码（§3 实测），新机制按 §4.1 不参与恢复，所以不会改变它——这一点要到实现后由 §10 的差分用例实证，本文不预支。

## 8. 证据限制（如实）

1. `registration_gap` 只覆盖 `sessionId` / `channelId` 为空。其它登记问题（字段含控制字符、观测超长、rename 残留）与同名多窗口一样只能落到 `pending_review`，带 `wireInvalidRounds` 证据位——除非补上缺口 G3 的结构化码。
2. `lockBusy` 是事后采样，锁在采样前释放就采不到；靠 30 分钟门槛兜住，不靠采样精确。
3. 「合格轮」之间如果夹着恢复波租约或巡检没跑，轮数不涨但时间在走，所以同时要求 `N_MIN`。
4. `gap` 读的是 `manager list` 的输出，不是 registry 原文；缺失在 `cmdList` 里表现为 `""`（:1523–:1524）或没有键（:1571–:1572），两种都按缺项读。
5. bridge 对「目标 agent 离线」的 `route_to_agent` 怎么处理，本卡没有核实；所以 `delivered` 只解释为「bridge 受理」。
6. `fail` 与 `gate_refused` 在补上缺口 G2 之前分不开；G2 不落地，R4 就可能把 gate 自身的拒绝误当成「预检已通过」，因此 G2 是实现的前置。
7. on 模式不减少对坏登记的重复尝试：每轮仍会起一个 `manager restart` 子进程再被跳过。减少尝试等于改恢复行为，不在本设计内。
8. §7 是模型推演；§3 是现行源码的隔离实测。两者都不是生产观测，原 P2 的报告与计数不因本文改变。

## 9. 缺口（具体文件；以下都**不存在**或**不能直接复用**）

| # | 文件 | 缺什么 |
|---|---|---|
| G1 | `src/lib/restore-skip-diag.ts` | 不存在。§4.3 的纯状态机和 §5 的状态事务要新建 |
| G2 | `src/lib/launcher-restore-gate.ts` | `restart()` 只返回字符串：gate 自身拒绝（额度已满、状态故障）与预检通过后的真实失败无法结构化区分；`generation()` 未导出。需要一个不改预算、不改返回值的只读结果出口，并导出代次函数（在新模块里再抄一份四元组会漂移） |
| G3 | `src/manager/restart-expect-restore.ts`、`src/manager.ts` | `parse` 私有，只能经 `restoreWindowIds` 得到合格 / 抛错两态；manager 结果里的 `skipped` 是自由文本，没有结构化原因码。本设计不依赖它；要把「待核」再细分才需要 |
| G4 | `src/launcher.ts` | 跳过原因现在不落日志（:727 只计数）；没有模式开关；不读台账；`restoreDeadAgents` 是带顶层副作用的脚本里的私有函数，没有进程内测试缝 |
| G5 | `src/lib/pm-notify.ts` | `notifyProjectPm` 无绑定回落 `"master"`，失败只抛错、丢 `sent`，不能直接用。`activeProjectPm` + `bridgeSend` 两个端口现成可执行，但把它们组合起来（含 §4.5 的目标校验）是新代码 |
| G6 | `src/manager/ledger-identity.ts`、`src/manager/ledger-supervise-cmds.ts` | launcher 没有台账写身份（无频道环境 = `owner`；监护留痕只认 `scheduler`）。本设计因此不写台账；要记进台账须另立卡定义身份和命令 |
| G7 | `src/lib/notify.ts` | `recordUndelivered` 私有，PM 通知失败无法复用 `undelivered-alerts.log`；本设计改记在自有状态和 launcher 日志 |
| G8 | `src/lib/doctor.ts` | `manager doctor` 不读这份状态；只读展示是可选后续 |

## 10. 未来实现（需另立卡；本卡不落任何一项）

### 10.1 文件范围与节点依赖

| 节点 | 文件 | 依赖 | 备注 |
|---|---|---|---|
| I1 纯核与状态 | 新 `src/lib/restore-skip-diag.ts`、新 `tests/restore-skip-diag.test.ts` | 本设计、LSTGUARD1 verified | 无接线，合并后生产行为不变 |
| I2 gate 只读出口 | `src/lib/launcher-restore-gate.ts`、新 `tests/launcher-restore-gate-outcome.test.ts` | 无（可与 I1 并行） | `tests/launcher-restore-gate.test.ts`、`tests/launcher-restore-gate-lstguard1.test.ts`、`tests/restart-expect-restore*.test.ts` **不改且保持绿** |
| I3 launcher 接线（off / observe） | `src/launcher.ts`、新 `tests/launcher-restore-skip-diag-wiring.test.ts` | I1、I2 | launcher 改动控制在十几行：读开关、收集证据、两处调用（提前返回处与尾部）；先解决 G4 的测试缝 |
| I4 通知（on） | 新 `src/lib/restore-skip-notice.ts`、新 `tests/restore-skip-notice.test.ts`、`src/launcher.ts`（注入依赖） | I3 | 合并不等于启用；on 需要 PM 单独批准 |
| I5 只读展示（可选） | `src/lib/doctor.ts` 及其测试 | I3 | — |

不在任何节点范围内：`src/manager.ts`、`src/manager/restart-expect*.ts`、`src/manager/restart-lock.ts`、registry 写入、台账写命令、bridge、配置文件格式、机器设施。

### 10.2 旧红新绿矩阵（全部在隔离夹具里：`mkdtemp` 状态目录、假 `RestoreDeps`、注入的假 `bridgeSend` 与内存台账、假时钟）

「旧红」= 用例在基线 `6656cf461acd` 上失败（模块不存在或断言不成立）；「保持绿」= 基线已成立，实现后必须仍成立。

| # | 场景 | 断言 | 基线 | 实现后 | 节点 |
|---|---|---|---|---|---|
| M1 | 登记缺项持续（S1a / S1b 的输入，假时钟推 30 分钟） | 状态里出现 `klass: registration_gap`，本机日志 1 行 | 红（§3：不留痕） | 绿 | I1、I3 |
| M2 | 同上 | gate 的 `failures` 恒 0、gate 告警 0、子进程回调次数与基线相同 | 绿 | 保持绿 | I3 |
| M3 | 合法身份恢复 | 记录被删，无分类 | 红（无模块） | 绿 | I1 |
| M4 | 持锁冲突持续超过 30 分钟（假 `isRestartInProgress` 恒真） | 计数恒 0，无分类 | 红 | 绿 | I1 |
| M5 | 读失败持续超过 30 分钟 | 只有 `localOnly: unreadable_inputs`；on 模式发帧 0 | 红 | 绿 | I1、I4 |
| M6 | 身份换代 | 旧记录 `superseded`；新代次从 0 数；旧通知状态不继承；新代次可独立通知 | 红 | 绿 | I1、I4 |
| M7 | 重启重建 | 同一状态文件上新建实例：不重发；陈旧 `claimed` 变 `unknown`；文件删除后从零重建且起点不回填 | 红 | 绿 | I1、I4 |
| M8 | 诊断状态损坏 / 锁被占 | 诊断本轮不写；损坏文件字节不变；恢复的返回值与 gate 文件同基线 | 红 | 绿 | I1、I3 |
| M9 | off | 状态目录前后文件清单与内容相同；假 bridge 0 帧；台账未打开；诊断模块未加载 | 红（无开关） | 绿 | I3 |
| M10 | observe 对 off 差分 | 同一输入序列下 `select` / `restart` 的返回值序列与 gate 文件字节相同；0 帧；台账未打开 | 红 | 绿 | I3 |
| M11 | on 去重 | 60 轮同代次同类别：发送恰 1 次 | 红 | 绿 | I4 |
| M12 | 多项目 | A 无目标 / 发送失败时 B 照常发；同项目 30 分钟内 1 条；一条最多 10 个 agent | 红 | 绿 | I4 |
| M13 | 无目标 | 无 `projectId`、无绑定、指针坏、台账缺失、PM 不属本项目、PM 即本体、`peer:` / `@` 形名：都是 0 帧，且从不出现 `master` / owner / 控制频道 | 红 | 绿 | I4 |
| M14 | 送达三态 | `ok` → `delivered`；`sent: false` → `failed`，30 分钟后重试，最多 3 次；`sent: true` → `unknown`，不重发、不记成送达 | 红 | 绿 | I4 |
| M15 | 认领后崩溃 | 认领提交后、发送前中断再重建：发送总数 ≤ 1 | 红 | 绿 | I4 |
| M16 | 公共正文 | 正文不含夹具里的 `sessionId`、`channelId`、`cwd`、状态路径、跳过原文 | 红 | 绿 | I4 |
| M17 | on 零副作用 | 假 tmux 变更日志为空；registry 文件字节不变；重启锁文件不变；没有多出的 `manager restart` 调用 | 红 | 绿 | I3、I4 |
| M18 | 发送前 CAS | 认领与发送之间换代：`cancelled`，0 帧 | 红 | 绿 | I4 |
| M19 | 界限 | 300 个 agent：记录 ≤ 256；计数封顶；状态无自由文本字段 | 红 | 绿 | I1 |
| M20 | gate 出口 | 额度已满 / 状态故障报 `gate_refused`（诊断保持，不终止）；既有 gate 用例的状态文件逐字节不变 | 红 | 绿 | I2 |

## 11. 本卡校验（如实分列）

本卡的 diff 只有本文件。

- §3 隔离夹具：本机实跑，6 pass / 0 fail / 47 个断言；第一次运行有 1 个失败，原因是夹具把同一个 agent 名用在多个用例里、撞上 `markExpectSkips` 的进程级集合（夹具问题，不是源码问题），改成每个用例独立命名后全过。夹具与模型脚本都不入仓，审查方未复跑。
- §7 模型：纯函数推演，不是实现。
- 本地（只改文档，结果与源码无关，如实列出）：`bun run typecheck` 退出 0（先按 CI 装了根目录与 `web/` 的依赖；没装 `web/` 依赖时它在基线上同样报 `web/` 缺 `react`，与本文件无关）；`GUARD_STRICT=1 bun run guard` 通过；`bun build src/manager.ts --target=bun` 退出 0；`git diff --check` 通过。本地全量 `bun test` **未跑**。
- 全量测试以 PR 准确 head 的正式 CI 为准；独立跨族审查以审查回执为准。这两项本文不预填结果。
- 原 P2 `restore-precheck-refusal-as-skip` 不因本文发布而关闭。
