# LSTSKIP1 · 自动恢复「持久跳过」诊断设计

状态：设计稿（specRev 1，基线 head `6656cf461acd`，依赖 LSTGUARD1 verified；第 1 轮审查后修订：过期轮、发帧栅栏、预检阶段读失败、项目限流表有界；第 2 轮审查后修订：项目边界、计数封顶）。本卡只改本文件，不改源码、测试、配置、机器设施或权限。
来源：正式安全审查事件 66007 的 P2 `restore-precheck-refusal-as-skip`。原报告与计数保持原样；**本文发布不关闭该 P2，未实现前不称问题已修**。
本文定义的 on / observe / off 与「默认 observe」只是设计默认，**不批准生产启用，也不批准新实现**；实现须按 §10 另立卡。

一句话结论：现行源码里，恢复预检的拒绝一律记成 skip——不算成功、不扣失败额度、不告警（LSTGUARD1 的边界，保留）。
这对暂态是对的，但登记长期缺项的 agent 会每轮被捡起、每轮被跳过，launcher 状态里不留任何痕迹，也没有人被告知（§3 隔离夹具实跑 12 轮：12 次子进程、0 告警、failures 恒 0）。
本设计在恢复路径**之外**加一个只读旁路：按同一登记代次累计「连续、无暂态证据的跳过」，够久才诊断；每一轮都能由结构化字段解释的记「登记缺项」或「待核」，
解释不了的（排除不了预检阶段读失败 / 死活未知）只走「本机待核」并写明证据限制；过期的一轮观测不得提交（观测令牌，§5.1）。
通知只发给正式项目 PM 绑定，同一条诊断记录对同一项目每类最多一次（出现恢复证据后再次持续跳过才算新的一条，至少 30 分钟之后），发帧的同步段里再核一次认领、项目归属和 PM 绑定。
agent 换了项目，累计从零重数，旧项目握手中的认领作废；帧离开本进程之后的项目变更只有 bridge 能拦，而现有 `route_to_agent` 没有这个字段（缺口 G9），补上之前 on 模式不得实现。它不重启、不发键、不修登记、不碰恢复预算。

---

## 1. 固定对照（基线 `6656cf461acd`，只读）

| 文件（blob 前 12 位） | 本设计依赖的事实 |
|---|---|
| `src/launcher.ts`（`24d2b2fb6a77`） | `restoreDeadAgents`（:674）：`manager list` → `restoreGate.select` → 逐个 `restoreGate.restart(agent, () => manager restart --restore-expect <观测> -- <name>)`；:727 `why?.startsWith("skipped:")` 只 `skipped++`，**跳过原因不落日志**；`select` 为空在 :700 提前返回。巡检间隔 `DEAD_AGENT_CHECK_INTERVAL_MS = 60_000`（:107），波内租约 `restartWaveUntil`（:663、:706、:733）。:1139 的 periodic 调用是 `restoreDeadAgents("periodic").catch(() => {})`，**不等它结束**；租约只在 `select` 非空之后才设，所以同进程两轮、reload 时新旧进程的两轮都可能重叠。launcher 当前**不读台账** |
| `src/lib/launcher-restore-gate.ts`（`38f22410ff7a`） | 状态 `launcher-restore-gate.json`，写者只有 `LauncherRestoreGate.transaction`（文件锁 `acquireLock(…, 1000)` + `commitIf: lock.held()`）。代次 `generation(a) = JSON.stringify([created, sessionId, channelId, cwd])`（:35，**未导出**）。`restart()`：先预占 `failures++`，子进程结果带 `skipped`（:208）则 `failures = max(0, failures - 1)`（:217）、不告警，返回 `skipped:<文本>`；gate 自身拒绝返回 `launcher restore gate: restore limit reached`（:199）或状态故障文本（都是普通字符串） |
| `src/manager.ts`（`213cdd896a61`） | `cmdList`：登记 `active`、窗口没了（或停在裸 shell）即 `status: "dead"`，带 `restoreExpect`、`sessionId`、`channelId`、`projectId`（:1512–:1527 停在裸 shell 的窗口，缺字段输出 `""`；:1561–:1574 窗口没了的，字段原样透出，缺了就是没有这个键）；带 pending 的条目由 `pendingHoldsOffHeal` 挡在 dead 之外。`cmdRestart`：:1257 缺 `sessionId` / `channelId` 直接出失败条目；:1265 重启锁被占出「另一个 restart 正在进行」；拿锁后 `expectSkip`；结尾 `markExpectSkips(results, opts.expect ?? opts.restore)` |
| `src/manager/restart-expect.ts`（`8123eea7b1b9`） | `markExpectSkips`：带 `--expect` / `--restore-expect` 时，复核通过前被拒的结果一律补 `skipped: "复核前已拒：…"`（自由文本） |
| `src/manager/restart-expect-restore.ts`（`b0dfc4aedb0d`） | `restoreObservations`：窗口清单读不到返回 `{}`（无恢复授权）。`restoreSkip`：线格式、身份（8 项）、窗口 ID、死活探测任一不符或读失败 → `skipped: String(e)`。顺序是先 `parse`（:75，不做任何读），再 `matches()`（:78–:83，**重新**读窗口清单和 registry）、`deps.dead`（:85）、再 `matches()`；这几步抛错或答未知都落进同一个 catch（:88–:90），结果只有 `name / ok / skipped / error` 四个键，没有结构化原因。`parse` 私有；导出的 `restoreWindowIds(raw, target)` 会调它，线格式不合格即抛 |
| `src/manager/restart-lock.ts`（`b4fe0ae1a4ed`） | `tryLockRestart` / `isRestartInProgress(name)`（只读：读锁文件 + `kill(pid, 0)`；锁超过 3 分钟或持有进程已死按没在跑） |
| `src/lib/pm-role.ts`（`574f1eb1d7d5`） | `activeProjectPm(db, project)`：`activePm` 指针，否则 `pms` 里第一个非 dispatcher，**都没有返回 `null`**；指针格式坏会抛 |
| `src/lib/pm-notify.ts`（`104719d525e6`） | `notifyProjectPm`：无绑定时**回落 `"master"`**，失败只抛错（丢掉 `sent`）——见缺口 G5 |
| `src/lib/bridge-client.ts`（`fbe16528f25f`） | `bridgeSend`：`{ ok: true }`；`{ ok: false, sent: false }` = 帧没发出或 bridge 以 typed `rejected` 拒绝，可以再排；`{ ok: false, sent: true }` = 结果未知，不得盲目重发。帧在 `ws.onopen` 里才发（:78–:82）；可选的 `stillActive` 在**同一同步段**里、`ws.send` 之前被问一次（:80），答 `false` 就不发并返回 `sent: false` |
| `src/lib/ledger-read.ts`（`c3875ed456c6`） | `LedgerReader.get()`：`PRAGMA query_only = ON` 的只读连接；库不存在返回 `null` |
| `src/lib/file-lock.ts`（`6b8db5eb35ee`）、`src/lib/state-file.ts`（`e2ed4c90577c`） | `acquireLock` / `LockHandle.held()`、`readJsonStateSync`（同步；`missing` / `corrupt` / 数据三态）、`writeJsonAtomicSync(…, { mode, commitIf })` |
| `src/manager/projects.ts`（`e5f580595f1d`） | `cmdProjectAssign`（:139–:161）：只改 registry 里该 agent 的 `projectId`（:154）后 `saveRegistry`；`created` / `sessionId` / `channelId` / `cwd` 都不动，所以**换项目不换代次** |
| `src/bridge.ts`（`3e61e290fb83`） | `route_to_agent`（:2208 起）：bridge 自己跑一次 `manager list`（:2264），只按 `targetName` 找收件人（:2279–:2280），**不看任何项目**；带 `expectSession` 时用 `sessionGone` 在路由处（:2285）和押后补投前（:865）各核一次，不符以 typed `rejected: "session_mismatch"` 拒绝。目标回合中时消息进押后队列，对调用方已答「受理」，真正投递在之后 |
| `src/lib/route-session.ts`（`16a54da12648`）、`src/bridge/router.ts` | `sessionGone(expect, channelId)`：帧里唯一的「期望值」核对，只比会话。信封 `meta.expectSession`（`router.ts:155`）。**没有期望项目字段** |
| `src/bridge/local-api/project-pm-delivery.ts`（`5dc45395e578`） | `deliverPmLocal`：收件人是项目里的前任 PM 时，按收件人**当前登记的项目**转交给该项目当班 PM（:33、:58，`a.projectId === original.projectId`）。转交不跨项目，但项目取的是投递时刻的登记，不是发送方以为的那个 |
| `src/lib/registry.ts`（`bab7990eb00e`） | `REGISTRY_PATH`、`normalizeRegistryAgents`（:147）导出；`readRegistryAgentsSync`（:206）在文件损坏时**回落本进程上次成功值**，缺失时返回空数组 |
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

**本轮修订补跑的探针**（同样是真实执行现行源码，同样的 `env -i` 隔离；scratchpad `probe.test.ts`，sha256 前 16 位 `3a7baf2fe8c289c1`，不入仓；7 个用例 22 个断言全过；跑完私有状态目录与运行目录为空）：

| 探针 | 做法 | 实测结果 |
|---|---|---|
| P-send | 直接 import 真实 `bridgeSend`，全局 `WebSocket` 换成不联网的假对象；发起后、触发 `onopen` 前把「认领仍有效」的代用布尔值置假 | 不传 `stillActive`：发 1 帧、返回 `ok: true`；传 `stillActive`：被问 1 次、发 0 帧、返回 `ok: false, sent: false`；`stillActive` 答真：发 1 帧。与上一轮审查方的探针结论一致 |
| P-read | `restoreObservations` 用好的假依赖造出合格观测（`restoreWindowIds` 不抛），再把同一观测交给真实 `restoreSkip`，分别让 ①registry 重读抛错 ②窗口清单重读抛错 ③死活探测答「没死 / 未知」 | 三种都返回普通 `skipped`，结果键恒为 `error, name, ok, skipped`——**launcher 侧拿不到任何能把它和别的跳过分开的结构化字段**；此时 list 行的 `restoreExpect` 合格，即 `noAuthority = false` |
| P-wire | 身份首项为空串的观测交给 `restoreSkip` | `restoreWindowIds` 抛；`restoreSkip` 返回 `skipped`，registry / 窗口 / 死活三个依赖调用合计 0——线格式不合格的拒绝发生在任何读之前 |

探针里的布尔值只是「认领失效」的替身，验证的是**现有端口**的发帧时点与预检出口形状，不是新机制的实现测试。

读法：S2–S5 证明 LSTGUARD1 的边界在基线成立（暂态不扣预算，未知 / 读失败 / 换代不碰窗口）。S1 证明 P2 的现行表现：持久原因与暂态在 launcher 侧得到完全相同的处理，而且不留痕。

## 4. 设计

### 4.1 位置与不变量

新机制是 `restoreDeadAgents` 的一个**旁路**，接三处：进入函数、发起 `manager list` **之前**无锁读一次自己的状态文件取「观测令牌」（§5.1，一次同步只读）；`select` 为空的提前返回处与函数尾部各提交一次本轮观测。
它只拿到本轮已经产生的值（`manager list` 的行、`select` 选中的名单、每个 agent 的恢复结果种类），在 gate 的事务提交之后运行，自己的任何异常都在内部吞掉并写一行本机日志。不变量：

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
| `explained` | `gap` 或 `wireInvalid` 成立 | 本轮的拒绝已由**成功读到的 list 行自身**的结构化缺陷解释：缺项在 `manager.ts:1257` 被拒，线格式不合格在 `parse` 被拒，两处都在预检的重读之前（§3 S1a、P-wire）。同轮即便另有读失败，这条缺陷事实仍然成立 |
| `noAuthority` | 行的 `restoreExpect` 缺失或为空 | **只覆盖一种读失败**：`manager list` 取初始窗口清单失败（`restoreObservations` 返回 `{}`）。这一轮对登记什么都证明不了。预检阶段的重读失败、死活未知**不在**这一位里，见下 |
| `lockBusy` | 该 agent 的结果回来后同步调一次 `isRestartInProgress(name)` | 此刻另有 restart 持锁 |
| `gen` | gate 的同一个四元组 `[created, sessionId, channelId, cwd]`，状态里只存它的 sha256 前 32 位十六进制 | 登记代次。**不含项目**：`project-assign` 不换代次（§1） |
| `project` | 本轮 `manager list` 行的 `projectId`（缺失按空串） | 该 agent 此刻登记的项目；与记录里的 `project` 不同即项目变更（R2p） |

**读失败证据的实际覆盖范围**（如实）：launcher 能看到的「不可读」只有三种——`manager list` 整体失败（R0）、初始窗口清单失败（`noAuthority`，R7）、诊断自己的状态不可读（R0）。
预检阶段的失败（初始观测合格之后，`restoreSkip` 重读 registry / 窗口清单抛错，或死活探测答未知）在 launcher 侧就是一个普通 `skip`：`noAuthority = false`、`gap = false`、`wireInvalid = false`，锁也已释放（§3 P-read）。
在补上结构化原因出口（缺口 G3）之前，这种轮**无法**与「登记合格、读也成功、但预检因别的原因拒绝」分开。本设计的保守做法：凡是累计里出现过哪怕一个「未解释」的合格轮（`explained` 不成立），这条记录就只能是**本机待核**，不通知 PM（§4.3）。
「出现过」记在一个只置不清的布尔位 `hadUnexplained` 里，不从计数器反推——计数器会封顶，封顶后「解释轮数 = 合格轮数」不再证明每一轮都有解释（§4.3「计数封顶」）。

**不使用**：`skipped:` 后面的文本、manager 的 stderr、pane 内容、任何在线 / 空闲推断。跳过文本只在本机日志里截 200 字符原样显示，标注「未归类原文」，不进状态文件，不进通知。

### 4.3 起点、累计、分类

常量（设计默认）：`N_MIN = 10` 轮，`T_MIN = 30 分钟`，两条都满足才分类。取 30 分钟是因为它明显长于已知暂态的上界：重启锁 3 分钟过期、launcher 子进程 300 秒超时、恢复波租约 10 分钟。

每个 agent 至多一条记录，按下面的顺序处理一轮（先命中先停）：

| # | 条件 | 动作 |
|---|---|---|
| R0 | `manager list` 失败、诊断锁没拿到、诊断状态不可读、**观测令牌已过期**（§5.1：本轮取令牌之后已有别的观测提交） | 整轮不动（不推进、不终止、不认领、不写）；过期轮另打一行本机日志（`stale_round`） |
| R1 | agent 不在本轮名单里 | 删记录（`removed`） |
| R2 | 记录的 `gen` 与本轮不同 | 删旧记录（`superseded`），本轮按无记录继续。只有过了 R0 令牌核对的轮才走得到这里，所以「把更新的代次当旧记录删掉」不会发生 |
| R2p | 记录的 `project` 与本轮 `project` 不同（含任一边为空串） | 项目变更（`reassigned`）：计数、起点、当前类别、`localOnly`、两个证据标记、不可读计数全部清零（同 R6），`project` 改成本轮的值，**保留全部通知键**（键自带项目，§4.5）；然后本轮按清零后的记录继续走 R3–R8 |
| R3 | 不再 dead，或 `outcome = ok` | 删记录（`recovered`）——合法恢复 |
| R4 | `outcome = fail`（预检已通过后的真实失败） | 删记录（`failed_counted`）；它归既有失败额度和既有告警 |
| R5 | dead 但未被选中，或 `gate_refused` | 保持（gate 自己的熔断 / 缺目录 / 状态故障告警在管） |
| R6 | `skip` 且 `lockBusy` | 连续性中断：计数、起点、当前类别、`localOnly` 与两个证据标记清零，**保留已发通知的去重记录** |
| R7 | `skip` 且 `noAuthority` | 保持，不推进；`unreadableRounds++`，记 `firstUnreadableAt` |
| R8 | 其余 `skip`（合格轮） | 没有起点就把**本轮时刻**记为 `startedAt`（不回填更早的时间）；`skipRounds++`，`gap` 成立则 `gapRounds++`、否则置 `hadNonGap`，`wireInvalid` 成立则 `wireInvalidRounds++`，`explained` 成立则 `explainedRounds++`、否则置 `hadUnexplained` |

「本轮时刻」取本轮提交时的本机时钟；它早于记录的 `lastAt`（时钟回拨）时这一轮对该记录不推进。

分类（R8 之后，`skipRounds ≥ N_MIN` 且 `now − startedAt ≥ T_MIN`）**只看两个标记**，不比较计数器：

- **`registration_gap`（登记缺项，可通知 PM）**：`hadNonGap` 与 `hadUnexplained` 都为假，即本段每一个合格轮都看到结构化的缺项事实。
- **`pending_review`（待核，可通知 PM）**：`hadUnexplained` 为假、`hadNonGap` 为真——每一个合格轮都有结构化的拒绝证据，其中至少一轮不是缺项而是「观测线格式不合格」。只断言这一点，**不断言是哪一项不合格**；
  `wireInvalidRounds` 随记录保存，但不升级成「登记缺项」——同名多窗口同样会让线格式不合格，而那不是登记问题。
- **`pending_review_local`（本机待核，仅本机）**：`hadUnexplained` 为真，即本段至少有一个合格轮没有任何结构化证据。只断言「同一登记代次连续 N 轮、历时 T 被预检跳过，期间没采到持锁，也没有恢复证据」；
  **排除不了**预检阶段读失败或死活未知（§4.2），所以按 PM 定 3 只写本机诊断，**不通知 PM**。已经是 `registration_gap` / `pending_review` 的记录一旦出现未解释轮，也降到这一类：不再认领新通知，握手中的那一条被取消（§4.5），已发出的去重记录保留。
- **`unreadable_inputs`（输入不可读，仅本机）**：`unreadableRounds ≥ N_MIN` 且 `now − firstUnreadableAt ≥ T_MIN`。只写本机诊断，**永不通知 PM**。它是独立的本机标记（`unreadableNoted`），不占类别。

**计数封顶与证据标记**（第 2 轮审查的 counter-cap）：五个计数器各自在 100000 处饱和，只用于门槛（`≥ N_MIN`，远低于上限）和展示（到顶时正文写「≥100000 轮」），**不参与分类**。
上一版用 `explainedRounds === skipRounds`、`gapRounds === skipRounds` 分类，分母先到顶、分子随后追平，曾经的未解释轮（或非缺项轮）就被抹掉——审查序列「1 个未解释轮 + 100000 个线格式轮」会从本机待核翻成可通知；同理「1 个线格式轮 + 100000 个缺项轮」会从待核翻成登记缺项。
现在这两件事各由一个布尔位记：`hadUnexplained`、`hadNonGap`。它们在 R8 里只置不清，随状态文件持久化，生命周期与计数段完全相同——只在记录被删（R1–R4）、R6 清零、R2p 清零时与计数一起归零，封顶、launcher 重启、观测作废都不动它们。
于是「出现过未解释轮 ⇒ 本段永远只能本机待核」不依赖任何计数器是否到顶。读状态时核一条一致性：未到顶的记录必须满足 `hadUnexplained ⇔ explainedRounds < skipRounds`、`hadNonGap ⇔ gapRounds < skipRounds`，到顶的记录必须满足计数不等 ⇒ 标记为真；不满足按状态损坏处理（§4.4，诊断暂停，不猜）。

本机类别的可见面：自有状态文件、launcher 日志（类别变化时一行），以及可选的 `manager doctor` 只读展示（节点 I5）。「既有重试」就是原有的每分钟巡检照常再试，本设计不加任何重试。

暂态如何被排除：持锁被采到 → R6 清零；持锁没被采到（锁在采样前释放了）→ 记 1 个合格轮，但那次 restart 的结果会在随后几轮表现为 R3 / R4，远不到 30 分钟；
初始窗口清单读失败 → R7 不推进；预检阶段读失败 / 死活未知 → 计入 R8 但属未解释轮，记录最多成为本机待核，不产生 PM 通知；换代 → R2 从零开始；换项目 → R2p 从零开始。无法可靠区分时一律落到本机待核，不猜。

### 4.4 终止、重启重建、新代次

- **恢复终止**：R3 / R4 删记录。之后同一代次再次被持续跳过，是一条新记录，要重新累计满 `N_MIN` 和 `T_MIN` 才会再诊断。
- **launcher 重启**：状态在文件里，重启后接着数；内存里不保存任何去重所需的东西。
- **状态文件丢失**：从零重建并换一个新的 `epoch`（§5.1），起点是重建后第一个合格轮，不回填；丢失前取的观测令牌、握手中的认领全部作废。代价是同一代次最多可能再通知一次（且至少 30 分钟之后）——这是已知限制。
- **状态文件损坏**：诊断暂停（不写、不通知），每个 launcher 进程打一行本机日志；**不自动覆盖**，证据留在原地；恢复不受影响。人工删除或修好文件后按上一条重建。
- **项目变更**（R2p）：代次没变，所以**记录不删**，但本段累计归零——新项目的 PM 只会因为「在它的项目里」又被持续跳过满 `N_MIN` 和 `T_MIN` 才收到通知，正文里的轮数和起始时间也只覆盖新项目这一段。
  旧项目的通知键原样**保存**在记录里（不迁移给新项目）：`delivered` / `unknown` / `failed` 不变，agent 之后移回旧项目并再次分类时，旧项目的 PM 不会为同一代次同一类别再收一条；
  旧项目握手中的 `claimed` 被发帧栅栏拦下并取消（§4.5）。项目被清空（`project` 为空串）同样走 R2p，之后是 `no_target`。
- **新代次**：`gen` 变了就是新记录，旧代次的计数、分类、通知状态都不继承；新代次可以独立再诊断、再通知。

### 4.5 通知（仅 on）

**收件人**只来自正式项目 PM 绑定：项目取本轮 `manager list` 行的 `projectId`；PM 取 `activeProjectPm(db, projectId)`，`db` 来自 `LedgerReader.get()` 的只读连接。下面任一情况都记 `no_target`，**只做本机诊断，不发任何帧**，也不回落 owner / master / 控制频道：

- `projectId` 为空；台账不存在或打不开；`activeProjectPm` 返回 `null` 或抛错；
- PM 名不是本机 `agent-…` 形态（含 `@` 或以 `peer:` 开头的会被 bridge 当成跨机路由）；
- PM 不在本轮 `manager list` 里，或它登记的 `projectId` 不是这个项目（防止发到别的项目）；
- 记录的 `project` 不是这个项目（本轮刚走过 R2p 的记录已是新项目、且已清零，不会带着旧项目的类别来认领）；
- PM 就是被诊断的那个 agent 自己。

`no_target` 每 30 分钟最多重新解析一次（一次本地只读，绑定可能后来才建），只有结果变了才再打日志。这就是「既有重试」：不新增重试机制，靠的是原有的每分钟巡检再走到这里。
不看 list 的 active / idle 去猜 PM 在不在线；投递结果只认 `bridgeSend` 的返回。

**去重与限流**：

- 去重键 = `agent | gen | 项目 | 类别`，记在该 agent 的记录里，每个键自带它认领时的项目；记录不删（见 R6、R2p）就不会对同一项目重发。会通知的类别只有两个（`registration_gap`、`pending_review`），所以一条记录对同一个项目最多发两条。
  认领、重试只看「键的项目 = 记录当前 `project`」的键；别的项目的键只保存、不动。一条记录最多 8 个键：满了以后这条记录不再为新的（项目，类别）认领，本机日志一行（`notice_keys_full`）——不淘汰旧键，淘汰会让旧项目重复收到。键随记录删除（R1–R4）一起消失。
- 每个项目 30 分钟内最多一条消息，一条消息最多列 10 个 agent，余下的等下一个窗口。限流记在顶层 `projects[<id>] = { lastNoticeAt, msgId }`，生命周期见下面「项目限流表」。
- 每轮最多给 3 个项目发消息，每次发送超时 30 秒；上一轮的发送还没结束时本轮不发（状态照常更新）。
- 所以同一个错误不会每分钟唤醒 PM：同一 agent 两次诊断之间至少隔 `T_MIN`，同一项目两条消息之间至少隔 30 分钟。

**项目限流表**（有界、可回收）：

- 一个项目项只在认领时写入，含义只有一个：「这个项目在 `lastNoticeAt` 认领过一条消息」。没有项目项 ≡ 不在限流窗口内。
- 回收：每次观测提交和每次认领事务里顺手扫一遍，`now − lastNoticeAt ≥ 30 分钟` 且状态里没有任何 `claimed` 的通知键还带着这个 `msgId` 的项目项，删除。
  仍在 30 分钟窗口内的不删（限流继续有效）；有未结认领的不删（发送还在路上）。`failed` 的重试时点记在 agent 记录自己的 `nextAttemptAt` 里，不依赖项目项，所以回收不会丢重试。
- `lastNoticeAt` 晚于当前时钟（时钟回拨）时改写成当前时刻，保证它 30 分钟后必然可回收。
- 容量：硬上限 256 项。回收后仍满时，本轮不为新项目认领（不挤掉仍有效的窗口），本机日志一行。按「每轮最多 3 个项目」和 30 分钟窗口，单进程稳态下项目项数 ≤ 3 × 窗口内轮数（§7 B2 按 75 秒一轮推演的峰值是 72）。
- agent 记录被 R1–R4 删除不影响项目项；项目项只按上面的时间规则走，因此「项目来了又走」不会留下永久条目（§7 B1）。

**发送步骤**（先认领后发送，与 gate 的 `announce`、监护的 claim 同一做法）：

1. **认领事务**（持锁）。前提全部成立才认领，否则本轮不发：当前观测令牌仍是**本轮自己那次观测提交**产生的令牌（§5.1；已有更新的观测就让那一轮去认领）；记录还在、`gen`、`project` 与类别同本轮所见；该（项目，类别）的通知键是空的、`cancelled`、或到了重试时点的 `failed`；项目不在限流窗口内；收件人按上面的规则在**本轮**重新解析且仍属这个项目。
   认领把一条消息里的每个键写成 `claimed`（带 `project`，`attempts + 1`、`claimedAt`、`claimId = msgId`，`msgId` 是本条消息的随机 64 位十六进制），同时写项目的 `{ lastNoticeAt, msgId }`；提交失败就不发。
2. `bridgeSend({ type: "route_to_agent", targetName: <PM>, text, fromName: "launcher", oneShot: true }, { timeoutMs: 30_000, stillActive })`——消息体与 `pm-notify.ts:16`、`agent-supervisor-deps.ts:48` 相同，**并使用端口现有的 `stillActive` 选项**（`bridge-client.ts:64`、:80）。
3. **发帧栅栏**：`stillActive` 由端口在 `ws.onopen` 里、`ws.send` 之前的同一同步段调用。它做一次同步无锁读（`readJsonStateSync`，原子改名写入保证读到的是某次完整提交），下面任何一条不成立就答 `false`，端口不发帧并返回 `sent: false`：
   状态可读且 `epoch` 与认领时相同；消息里**每一个** agent 的记录都还在、`gen` 没变、**`project` 仍是本条消息的项目**、当前类别仍是所通知的类别、该项目该类别的通知键仍是 `claimed` 且 `claimId` 等于本条 `msgId`。
   **项目与绑定复核**（同一同步段，全部是只读的同步调用）：`readJsonStateSync(REGISTRY_PATH)` 必须是 `ok`（缺失 / 损坏都答 `false`；**不用** `readRegistryAgentsSync`，它在损坏时回落旧值），经 `normalizeRegistryAgents` 后消息里每一个 agent 与收件人 PM 的 `projectId` 都等于本条消息的项目；
   `LedgerReader.get()` 非空且 `activeProjectPm(db, 项目)` 仍等于收件人（抛错答 `false`）。registry 与台账都只读，launcher 不因此成为它们的 writer。
   于是握手期间发生的 R1 移除、R2 换代、**R2p 换项目**、R3 / R4 终止、R6 清零、降到本机待核、状态文件被删或损坏，以及**被诊断 agent 或收件人 PM 被 `project-assign` 移走、项目 PM 绑定换人**（这三种诊断状态可能一字未变），都使这条消息 0 帧。一条消息里只要有一个 agent 失效就整条不发（正文里不能带着已失效的一行），其余的按第 4 步取消后下一轮重新认领。
4. **落结果事务**（持锁）：只改「记录还在、`gen` 相同、通知键仍是 `claimed` 且 `claimId` 相同」的键（按 `claimId` 找键，不要求键的项目仍是记录当前项目——换项目后旧项目那条认领正是这样被写成 `cancelled` 的），其余一律不写。
5. **bridge 端期望项目**（**现有端口没有，缺口 G9；on 模式的前置**）：帧里带 `expectProject: { id, members }`，`members` 是收件人加正文里列出的全部 agent（至多 11 个名字）。
   bridge 在路由处和押后补投前——也就是现有 `expectSession` 的那两个核对点（`bridge.ts:2285`、`:865`）——用自己读到的登记核对：最终收件人与每个 member 的 `projectId` 都等于 `id`，否则不投；路由处以 typed `rejected: "project_mismatch"` 回答（`bridgeSend` 因此返回 `sent: false`），补投前直接丢弃并记 bridge 日志。
   `deliverPmLocal` 的「前任 PM → 当班 PM」转交发生在同一项目内（§1），核对针对转交后的最终收件人。launcher 不改 bridge 的任何状态；这一步只是让 bridge 在它本来就要做的那次登记读取上多比一个字段。

发帧栅栏的边界（如实）：发送以栅栏那次读为线性化点。读之后、帧离开进程之前另一个**进程**又提交了终止，这条消息仍会发出——它与「通知发出后 agent 立刻恢复」不可区分，也无法靠任何发送前检查消除；栅栏关掉的是握手期（最长 30 秒）这个窗口，同进程内则没有任何代码能插进这一同步段。

**项目边界的分工与端口缺口**（第 2 轮审查的 project-fence，如实）：

- 发送方栅栏（第 3 步）用的全是现有可执行端口，管到**帧离开 launcher 进程为止**。
- 帧离开之后还有一段只属于 bridge 的时间：bridge 先跑自己的 `manager list`（子进程），目标在回合中时消息还会进押后队列、等到回合结束才补投（§1）。这段时间里收件人或被诊断 agent 被移到别的项目，launcher 无从得知，现有 `route_to_agent` 帧也**没有任何期望项目字段**——bridge 只按名字投。
  所以只靠现有端口，「不向错误项目发消息」在这一段**得不到保证**。本设计不假装它成立：第 5 步的 `expectProject` 列为缺口 G9、节点 I4a，**I4（on 模式通知）以它为前置**；G9 落地之前 on 模式不得实现，observe / off 不受影响（它们不发帧）。
- G9 落地后的剩余边界：bridge 的核对同样以它那次登记读取为线性化点，读之后的变更与「送达后才换项目」不可区分。正式 PM 绑定（台账指针）只在发送方栅栏里核，bridge 端不重核——之后绑定换人，消息要么被 `deliverPmLocal` 按现行规则转交给**同一项目**的当班 PM，要么留在同一项目的原收件人那里，都不出项目。
- 押后补投前被 `project_mismatch` 丢弃的那一条，launcher 这边已经记成 `delivered`（bridge 当时受理了）。这与 `delivered` 的既有含义一致（只表示受理），不改确认语义；代价是那位 PM 没收到、也不会重发——换项目后的新项目由 R2p 另行累计、另行通知。

**送达三态与重试边界**：

| `bridgeSend` 返回 | 记为 | 之后 |
|---|---|---|
| `ok: true` | `delivered` | 不再发。含义只是「bridge 受理了这次路由」，**不等于 PM 已读或已确认**；诊断记录继续开着，直到 R1–R4 |
| `ok: false, sent: false` | `failed` | 帧没发出或被 typed 拒绝（含 G9 落地后的 `project_mismatch`），可以重试：受同一个 30 分钟项目限流约束，每个键最多 3 次；用完保持 `failed`。重试不是重放旧帧：每次都重新过认领的全部前提，收件人重新解析，记录已换项目或 PM 已不属本项目就认领不了（`no_target`） |
| `ok: false, sent: true` | `unknown` | **不自动重发**（可能已经送到，重发会重复唤醒）；也**不记成已送达** |
| `ok: false, sent: false` 且本次 `stillActive` 答过 `false`（发送方自己记着） | `cancelled` | **帧确定没发**。认领仍在的键写成 `cancelled`：`attempts − 1`、清掉 `claimId` / `claimedAt`，不占重试次数；项目项的 `msgId` 仍是本条时删掉项目项（没有消息发出，不占限流窗口）。记录已删 / 已换代 / 认领已不是本条的键什么都不写——认领随记录一起消失。之后只有新的一轮在类别重新成立时才会再认领 |
| 认领后进程崩溃，或结果没能落下（拿不到锁 / 状态不可写），`claimed` 已超过 60 秒 | `unknown` | 同上一行 `unknown`：不自动重发。由之后任一被接受的观测轮在提交时转换；转换后迟到的真实结果因通知键已不是 `claimed` 而不再写入，栅栏也因同一条件不再放行 |

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
agent 在项目之间移动时：在 A 累计的轮数不计入 B 的门槛（R2p 清零）；A 的通知键不挡 B 的通知，B 的也不挡 A 的；A 的 PM 收不到 agent 进入 B 之后的任何诊断，B 的 PM 收不到带 A 项目 id 的正文（认领前提、发帧栅栏、G9 三层）。

## 5. 状态所有权、writer、并发

| 项 | 设计 |
|---|---|
| 状态文件 | `statePath("launcher-restore-skip-diag.json")`，权限 `0o600`，与 `launcher-restore-gate.json` 是两份独立文件 |
| 所有者 | launcher 进程 |
| 唯一 writer | 未来的 `src/lib/restore-skip-diag.ts` 里的一个事务函数，只由 `restoreDeadAgents` 调。manager、bridge、调度服务、cron、web 都不写 |
| 只读接线 | launcher → gate：只读它的返回值；launcher → 台账：`LedgerReader` 的 `query_only` 连接，只在 on 模式开；launcher → 重启锁：`isRestartInProgress` 只读；launcher → registry：发帧栅栏里 `readJsonStateSync(REGISTRY_PATH)` 一次同步只读，只在 on 模式。其它 daemon 以后要展示诊断，也只能读这份文件 |
| 文件锁 | `acquireLock(<path>.lock, 1000)`，与 gate 同一端口、同一等待上限；拿不到 = 本轮 R0，绝不无锁写，也绝不让恢复等它 |
| CAS | 事务内「读 → 改 → `writeJsonAtomicSync(…, { mode: 0o600, commitIf: () => lock.held() })`」，锁丢了就不提交；状态带 `rev`，每次提交 +1（只作变更计数，**不承担新旧判定**）。新旧判定靠 §5.1 的观测令牌：观测提交比对 `epoch:obsSeq`；认领比对「令牌仍是本轮自己的」；通知结果比对 `gen + claimId`，发帧栅栏比对 `gen + project + 类别 + claimId` 并复核登记项目与 PM 绑定（§4.5） |
| 租约 | 不借用任何租约。`restartWaveUntil` 是恢复波自己的内存租约，诊断不读不写；调度服务租约（`scheduler-lease-env.ts`）与 launcher 无关，launcher 进程没有它 |
| 并发 | boot 与 periodic 两轮重叠（:1139 不等待）、launcher reload 时新旧进程短暂并存：文件锁 + `commitIf` 负责**串行**，观测令牌负责**拒收过期轮**（§5.1），两者缺一不可。发送有进程内「在发」标志，重叠轮不重复发；跨进程的重复发送由认领（状态里的 `claimed`）挡住，握手期失效由发帧栅栏挡住（§4.5） |
| 界限 | agent 记录数 ≤ 本轮名单里的 agent 数，硬上限 256（超出的不建记录，本机日志每轮一行）；项目限流表硬上限 256 项且按时间回收（§4.5）；计数器各自在 100000 饱和且不参与分类（§4.3）；每条记录的通知键 ≤ 8；状态里没有自由文本；每条记录、每个项目项字段固定 |

记录字段（v1）：`gen`、`project`、`startedAt`、`lastAt`、`skipRounds`、`gapRounds`、`wireInvalidRounds`、`explainedRounds`、`hadUnexplained`、`hadNonGap`、`unreadableRounds`、`firstUnreadableAt?`、`unreadableNoted?`、`klass?`（可通知类别）、`localOnly?`（`pending_review_local`）、
`notices: [ { project, klass, state, attempts, claimId?, claimedAt?, nextAttemptAt? } ]`（≤ 8 项，（`project`，`klass`）不重复）；顶层另有 `version: 1`、`epoch`、`obsSeq`、`rev`、`projects: { <id>: { lastNoticeAt, msgId } }`。

### 5.1 观测令牌（拒收过期轮）

文件锁和 `commitIf` 只保证提交一个一个来，不分先后新旧：一轮在 `manager list` 之后要等最长 300 秒的子进程，期间别的轮（同进程的另一轮，或 reload 后的新进程）可以观测到更新的事实并先提交。令牌补上这层顺序。

- 状态顶层带 `epoch`（文件创建时生成的 128 位随机十六进制；文件丢失后重建就换新的，防止序号从头再来时撞上旧令牌）和 `obsSeq`（被接受的观测提交数）。令牌 = `epoch:obsSeq`；文件不存在时令牌是 `missing`。
- **取令牌**：每轮进入 `restoreDeadAgents`、发起 `manager list` **之前**，同步无锁读一次状态文件得到 `base`。状态损坏按 R0。本轮所有观测（list 行、`select`、每个 agent 的恢复结果、`lockBusy` 采样）都发生在这之后。
- **提交核对**：尾部拿到文件锁后重读，当前令牌 ≠ `base` → 本轮过期：按 R0 整轮作废，状态一个字节不动，不终止任何记录，不认领，本机日志一行 `stale_round`。相等才应用 R1–R8，并 `obsSeq + 1`（文件不存在则带新 `epoch` 创建）。
- **顺序性**：设 X、Y 都被接受且 X 先提交。Y 提交时令牌等于它的 `base`，说明 Y 取令牌到提交之间没有别的观测提交，所以 Y 取令牌晚于 X 提交；而每轮的观测都夹在自己的取令牌与提交之间，于是 Y 的全部观测晚于 X 的全部观测。被接受的观测与提交同序，「旧观测删掉新代次、抹掉新代次的计数和 `delivered` / `unknown`」不可能发生。
- **通知事务不推进 `obsSeq`**（只 `rev + 1`）：认领、落结果、陈旧 `claimed` 转 `unknown` 不带新观测，不应让并行的观测轮作废；它们各自按记录身份比对。认领另外要求当前令牌等于本轮自己那次观测提交之后的令牌，所以过期轮也发不出通知。
- **代价**：重叠的几轮里只有最先提交的算数，其余作废——合格轮数只会少计，诊断只会更晚、不会更早，`T_MIN` 不受影响。没有饿死：同一令牌下总有一轮提交成功。新旧进程并存不需要特判，两边走同一条规则。

**本设计不写台账，不新增授权**。launcher 没有台账写身份：`resolveActor` 对没有频道号的环境判为 `owner`，`scheduler-supervise` 只认 `actor === "scheduler"`。让 launcher 直接跑台账写命令等于用 owner 身份写，本文不这么做，也不假称有通用 writer（缺口 G6）。

## 6. 模式

开关：launcher 进程环境变量 `LAUNCHER_RESTORE_SKIP_DIAG`，启动时读一次（与 `CONTROL_CHANNEL_ID`、`MASTER_EFFORT` 同一读法），不改任何配置文件格式。缺省 `observe`；认不出的值按 `observe` 并在启动时打一行日志。

| 模式 | 做什么 | 不做什么 |
|---|---|---|
| `off` | 什么都不做：模块不加载（动态 import 只在非 off 时发生） | **零附加写**：没有状态文件、锁文件、日志行；不取观测令牌（连诊断状态都不读）、不开台账、不采重启锁、不发帧 |
| `observe`（默认） | 累计、分类，写自己的状态文件，状态变化时打本机日志（含截断的跳过原文） | 不开台账、不解析 PM、不发任何帧；不改恢复结果、预算、告警或波租约 |
| `on` | observe 的全部，加 §4.5 的通知 | 仅诊断：不重启、不发键、不修登记、不清锁、不改 gate |

与原恢复路径共存：三种模式下 `select` / `restart` 的入参、返回值、调用次数、gate 文件内容都应逐字节相同（§10 矩阵 M9、M10 用差分验证）。

## 7. 确定性推演（新机制，**不是实跑实现**）

新机制没有实现。下表是把 §4.3、§4.5、§5.1 的规则写成一个纯函数参考模型（无 IO、无时钟、无网络；scratchpad `model2.ts`，sha256 前 16 位 `ec3e9ec9d3259f23`，不入仓）后跑出来的事件序列，用来核对规则自洽和数字。
第 1 轮修订改了规则（观测令牌、未解释轮、发帧栅栏、项目限流表回收），模型随之重写并整表重跑（`model2.ts`）。
第 2 轮修订又改了规则（标记分类、R2p、项目键、栅栏的项目复核），本轮另写了一个纯函数模型（scratchpad `model3.ts`，sha256 前 16 位 `b71cfcfd6f5f479c`，不入仓，31 项核对全过）：
「累计与分类」15 行按新规则**重跑，输出与下表逐行相同**；「计数封顶」「项目变更」两张表是本轮新跑的。「过期轮」「握手期间失效」「项目限流表有界」三张表是 `model2.ts` 的输出，**本轮没有重跑**（`model2.ts` 不在本轮工作副本里）；这三张表的场景都不含换项目和到顶，本轮也没改它们涉及的规则，但这是推断而非重跑结果。
假设每轮间隔 75 秒——源码常量是巡检 60 秒加波后冷却 60 秒，**实际周期本卡没有测量**。模型里的「发帧」只是计数，`stillActive` 是同一判定的纯函数版本；真实端口的发帧时点见 §3 P-send。

**累计与分类**（on 模式，单 agent）：

| 场景 | 输入序列 | 模型输出 |
|---|---|---|
| 登记缺项持续 | 60 轮 `skip` + `gap` | 第 25 轮（30.00 分）分类 `registration_gap`，发帧 1；之后 35 轮没有新事件 |
| 合法身份恢复 | 3 轮 `skip` → 不再 dead | 第 4 轮 `recovered`，无分类，发帧 0 |
| 合法身份恢复 | 2 轮 `skip` → `ok` | 第 3 轮 `recovered`，无分类，发帧 0 |
| 持锁冲突 | 40 轮 `skip` + `lockBusy` | 没有任何事件，`skipRounds` 始终为 0，发帧 0 |
| 持锁冲突（没采到锁） | 1 轮 `skip` → 不再 dead | 第 2 轮 `recovered`，无分类 |
| 读失败·初始窗口清单（短） | 5 轮 `noAuthority` → `ok` | 第 6 轮 `recovered`，无分类 |
| 读失败·初始窗口清单（长） | 40 轮 `noAuthority` | 第 25 轮只出本机 `unreadable_inputs`；`skipRounds` 为 0，发帧 0 |
| **读失败·预检阶段 / 死活未知** | 40 轮 `skip`，`noAuthority`、`gap`、`wireInvalid`、`lockBusy` 全假（§3 P-read 的输入形状） | 第 25 轮只出本机 `pending_review_local`；**发帧 0** |
| 线格式不合格持续 | 30 轮 `skip` + `wireInvalid` | 第 25 轮分类 `pending_review`，发帧 1 |
| 缺项与未解释轮混合 | 20 轮 `gap` → 10 轮无证据 | 第 25 轮本机 `pending_review_local`，发帧 0 |
| 已通知后出现未解释轮 | 30 轮 `gap` → 5 轮无证据 | 第 25 轮 `registration_gap` 发帧 1；第 31 轮降为本机 `pending_review_local`，不再发帧 |
| 身份换代（诊断前） | 20 轮 `skip` + `gap`（25 分）→ 新代次 `ok` | 第 21 轮 `superseded`，无分类、发帧 0 |
| 身份换代（诊断后） | 代次 1 缺项 30 轮 → 代次 2 缺项 30 轮 | 第 25 轮代次 1 发帧；第 31 轮 `superseded`；代次 2 从零数，第 55 轮（67.50 分）独立发帧；合计 2 |
| 缺项后真实失败 | 12 轮 `skip` + `gap` → `fail` | 第 13 轮 `failed_counted`，无分类 |
| gate 熔断穿插 | 12 轮 `gap` → 5 轮未被选中 → 13 轮 `gap` | 未选中的 5 轮不推进也不终止；第 25 轮分类（当时 `skipRounds = 20`），发帧 1 |

**计数封顶**（§4.3；单 agent，on 模式；「未解释」= 四个证据位全假的 `skip`）：

| 场景 | 输入序列 | 模型输出 |
|---|---|---|
| 审查序列·到顶前 | 1 轮未解释 → 99999 轮 `wireInvalid` | `skipRounds = 100000`、`explainedRounds = 99999`、`hadUnexplained` 真；本机待核，发帧 0 |
| 审查序列·到顶后 | 1 轮未解释 → 100000 轮 `wireInvalid` | 两个计数都是 100000（旧的等式规则在这个状态下判为可通知）；`hadUnexplained` 仍为真，**仍是本机待核，发帧 0** |
| 审查序列·继续 | 同上再加 5000 轮 | 不变：本机待核，发帧 0 |
| 审查序列·重启重建 | 1 轮未解释 → 100001 轮 `wireInvalid`，**每一轮之后都把记录序列化再读回** | 与不重建时逐字段相同：本机待核，发帧 0 |
| 非缺项轮被追平 | 1 轮 `wireInvalid` → 100001 轮 `gap` | `gapRounds = skipRounds = 100000`，`hadNonGap` 为真：仍是 `pending_review`，不升成 `registration_gap`；发帧 1（第 25 轮那一条） |
| 纯缺项越过上限 | 100002 轮 `gap` | 两个标记都假：`registration_gap`，发帧 1，到顶前后类别不变 |
| 到顶之后才出现未解释轮 | 100001 轮 `gap` → 1 轮未解释 | 之前 `registration_gap` 发帧 1；最后一轮降为本机待核 |
| 持锁清零后重新累计 | 1 轮未解释 → 30 轮 `wireInvalid` → 1 轮 `lockBusy` → 30 轮 `wireInvalid` | 第 25 轮本机待核；第 32 轮 R6 清零（标记随段清除）；新的一段从第 33 轮起算，第 57 轮 `pending_review`，发帧 1 |

**项目变更**（§4.3 R2p、§4.5；项目 A 的 PM 是 pmA，B 的是 pmB；「bridge 端」一列是缺口 G9 的规则，不是现有 bridge 的行为）：

| 场景 | 序列 | 模型输出 |
|---|---|---|
| 被诊断 agent 握手中换项目（审查序列） | A 里 25 轮 `gap` → 认领给 pmA → agent 移到 B 并被接受 1 轮观测 → `onopen` | 上一版栅栏（`epoch` / `gen` / 类别 / `claimId`）在此状态下答真；新栅栏答假，**发帧 0**；A 的键 `cancelled`、`attempts` 回到 0；记录 `project = B`、`skipRounds = 1`、无类别 |
| A → B → A → B | 每段 30–40 轮 `gap` | 第 25 轮发给 pmA；第 31 轮 `reassigned`；第 55 轮（B 里满 25 轮）发给 pmB；回到 A、再到 B 各自重新分类但**不再发帧**；合计发帧 2，键为 A `delivered`、B `delivered` |
| 收件人 PM 握手中被移到 B | A 里已认领 → pmA 的登记项目改成 B → `onopen` | 诊断状态一字未变；栅栏的登记复核答假，发帧 0 |
| 收件人 PM 在栅栏之后被移走 | 栅栏放行、帧已发 → pmA 移到 B → bridge 路由 | 发送方无法拦；bridge 端 `expectProject` 不符，typed 拒绝 → `failed`；下一次认领重新解析收件人，pmA 已不属 A → 认领不了 |
| 握手中项目 PM 绑定换人 | A 里已认领 → 台账指针改成另一人 → `onopen` | 栅栏的绑定复核答假，发帧 0 |
| 项目键上限 | 同一代次依次流经 12 个项目，每个项目里都满 25 轮 | 前 8 个项目各发 1 帧；之后键满，不再认领；键数 8 |

**过期轮**（§5.1）：

| 场景 | 序列 | 模型输出 |
|---|---|---|
| 旧轮晚于新轮提交（上一轮审查的序列） | 旧轮取令牌并观测到代次 g1 → 另一方连续提交 30 轮 g2（第 25 轮已 `delivered`）→ 旧轮提交 | 旧轮 `stale`，状态逐字节不变：仍是 g2、`skipRounds = 30`、`delivered`；继续跑到第 60 轮累计发帧仍为 1，`skipRounds = 59`（没有从零重数） |
| `unknown` 不被旧轮擦除 | 同上，通知结果为 `unknown`；旧轮带的是「g1 已不再 dead」 | 旧轮 `stale`；记录仍是 g2、通知键仍是 `unknown` |
| 两轮同一令牌 | 两轮都在同一次提交之后取令牌 | 先提交的 `ok`，后提交的 `stale`；过期那轮手里的令牌去认领，认领数 0 |
| 状态文件删除后重建 | 旧令牌与重建后的令牌序号相同（都是 1），`epoch` 不同 | 旧令牌提交 `stale` |

**握手期间失效**（§4.5 发帧栅栏；一条消息含同项目两个 agent：a、b）：

| 认领之后、`onopen` 之前发生 | 发帧 | a 的通知键 | b 的通知键 | 项目项 |
|---|---|---|---|---|
| 什么都没发生 | 1 | `delivered` | `delivered` | 保留 |
| a 换代（R2） | 0 | 不存在（新代次记录，无继承） | `cancelled`，`attempts` 回到 0 | 删除 |
| a 恢复（R3） | 0 | 记录已删 | `cancelled`，`attempts` 回到 0 | 删除 |
| a 被采到持锁（R6） | 0 | `cancelled` | `cancelled` | 删除 |
| 状态文件被删 | 0 | — | — | — |

**项目限流表有界**：

| 场景 | 序列 | 模型输出 |
|---|---|---|
| 项目长期流转（上一轮审查的序列） | 300 个项目依次各有 1 个缺项 agent，诊断并发帧后该 agent 消失 | 发帧 300（每个项目各 1）；agent 记录峰值 1；**项目项峰值 1**，结束时 1 |
| 多项目同时缺项 | 300 个 agent 分属 300 个项目，持续 200 轮 | 记录 256（硬上限）；发帧 256，每个项目至多 1；项目项峰值 72，全部过窗后回到 0 |
| 回收时点 | 项目发过一条后同项目另一个 agent 继续被跳过 | 项目项在认领后整 30 分钟被回收，之前一直保留；带未结 `claimed` 的项目项超过窗口也不回收 |

对照验收：持久问题在 30 分钟处变得可诊断；持锁、读失败（两种）、换代、合法恢复都不产生 PM 通知。这些场景里「不扣预算、不触窗口副作用」来自现行源码（§3 实测），新机制按 §4.1 不参与恢复，所以不会改变它——这一点要到实现后由 §10 的差分用例实证，本文不预支。

## 8. 证据限制（如实）

1. `registration_gap` 只覆盖 `sessionId` / `channelId` 为空。其它登记问题（字段含控制字符、观测超长、rename 残留）与同名多窗口一样只能落到 `pending_review`，带 `wireInvalidRounds` 证据位——除非补上缺口 G3 的结构化码。
   list 行合格却持续被预检拒绝的（没有任何结构化证据）只能是 `pending_review_local`：其中可能混着真实的持久问题（例如 list 判 dead 而死活探测一直答「没死 / 未知」），在 G3 落地前**PM 不会收到通知**，只能从本机诊断看到。这是为了守住「状态不可读只本机」而接受的漏报，不是已解决。
2. `lockBusy` 是事后采样，锁在采样前释放就采不到；靠 30 分钟门槛兜住，不靠采样精确。
3. 「合格轮」之间如果夹着恢复波租约或巡检没跑，轮数不涨但时间在走，所以同时要求 `N_MIN`。
4. `gap` 读的是 `manager list` 的输出，不是 registry 原文；缺失在 `cmdList` 里表现为 `""`（:1523–:1524）或没有键（:1571–:1572），两种都按缺项读。
5. bridge 对「目标 agent 离线」的 `route_to_agent` 怎么处理，本卡没有核实；所以 `delivered` 只解释为「bridge 受理」。
6. `fail` 与 `gate_refused` 在补上缺口 G2 之前分不开；G2 不落地，R4 就可能把 gate 自身的拒绝误当成「预检已通过」，因此 G2 是实现的前置。
7. on 模式不减少对坏登记的重复尝试：每轮仍会起一个 `manager restart` 子进程再被跳过。减少尝试等于改恢复行为，不在本设计内。
8. 「不可读」的结构化证据只有 §4.2 列的三种；预检阶段的读失败没有独立证据位，是靠「未解释轮一律本机」这条保守规则兜住的，而不是被识别出来的。
9. 观测令牌让重叠的轮只算一轮，轮数可能少计；发帧栅栏之后到帧离开进程之间的跨进程提交挡不住（§4.5）。两者都只会让通知更少、更晚。
10. 项目归属有两段观测滞后的时间：其一，agent 换项目到下一轮观测被接受之前（至多一个巡检周期加一轮恢复的时长），诊断仍按旧项目记账——发帧栅栏的登记复核会拦住这段时间里的发送；
    其二，帧离开 launcher 之后的换项目，现有端口拦不住，靠缺口 G9；G9 落地前 on 模式不得实现（§4.5）。G9 落地后仍以 bridge 那次登记读取为界。
11. 换项目后累计从零重数：频繁在项目间移动的 agent（每次不到 30 分钟）永远到不了通知门槛，只能从本机日志的 `reassigned` 行看到。这是为了不让 A 的历史算进 B 而接受的漏报。
12. 计数器到顶后不再增长，正文只能写「≥100000 轮」；到顶不影响分类（§4.3）。
13. §7 是模型推演；§3 是现行源码的隔离实测。两者都不是生产观测，原 P2 的报告与计数不因本文改变。

## 9. 缺口（具体文件；以下都**不存在**或**不能直接复用**）

| # | 文件 | 缺什么 |
|---|---|---|
| G1 | `src/lib/restore-skip-diag.ts` | 不存在。§4.3 的纯状态机和 §5 的状态事务要新建 |
| G2 | `src/lib/launcher-restore-gate.ts` | `restart()` 只返回字符串：gate 自身拒绝（额度已满、状态故障）与预检通过后的真实失败无法结构化区分；`generation()` 未导出。需要一个不改预算、不改返回值的只读结果出口，并导出代次函数（在新模块里再抄一份四元组会漂移） |
| G3 | `src/manager/restart-expect-restore.ts`、`src/manager.ts` | `parse` 私有，只能经 `restoreWindowIds` 得到合格 / 抛错两态；manager 结果里的 `skipped` 是自由文本，没有结构化原因码。预检阶段的读失败 / 死活未知因此没有证据位（§3 P-read）。I1–I4 **不依赖它**——代价是未解释轮只能本机待核（§8 第 1 条）；要让 `pending_review_local` 里「读成功但被拒」的那部分能通知 PM，或把「待核」再细分，才需要它，范围见 §10.1 的 I6 |
| G4 | `src/launcher.ts` | 跳过原因现在不落日志（:727 只计数）；没有模式开关；不读台账；`restoreDeadAgents` 是带顶层副作用的脚本里的私有函数，没有进程内测试缝 |
| G5 | `src/lib/pm-notify.ts` | `notifyProjectPm` 无绑定回落 `"master"`，失败只抛错、丢 `sent`，不能直接用。`activeProjectPm` + `bridgeSend` 两个端口现成可执行，但把它们组合起来（含 §4.5 的目标校验）是新代码 |
| G6 | `src/manager/ledger-identity.ts`、`src/manager/ledger-supervise-cmds.ts` | launcher 没有台账写身份（无频道环境 = `owner`；监护留痕只认 `scheduler`）。本设计因此不写台账；要记进台账须另立卡定义身份和命令 |
| G7 | `src/lib/notify.ts` | `recordUndelivered` 私有，PM 通知失败无法复用 `undelivered-alerts.log`；本设计改记在自有状态和 launcher 日志 |
| G8 | `src/lib/doctor.ts` | `manager doctor` 不读这份状态；只读展示是可选后续 |
| G9 | `src/bridge.ts`（`route_to_agent` 分支 :2208 起，及押后补投前 :865）、`src/bridge/router.ts`（信封 `meta` :155）、`src/lib/route-session.ts`（或其旁的新文件）、`src/lib/held-idle-batch.ts`（:18、:42 押后批次对 `meta` 的校验） | `route_to_agent` 帧**没有期望项目字段**：bridge 只按 `targetName` 投，不核收件人或正文所涉 agent 的项目；现有唯一的期望值核对是 `expectSession`（只比会话）。需要新增 `expectProject: { id, members }`、typed 拒绝码 `project_mismatch`，并在 `expectSession` 的两个核对点各核一次。`bridge.ts` 在体积基线内只能缩，逻辑须放进新模块。`src/lib/bridge-client.ts` 不用改（帧体原样透传）。**这是 on 模式的前置，不是可选项** |

## 10. 未来实现（需另立卡；本卡不落任何一项）

### 10.1 文件范围与节点依赖

| 节点 | 文件 | 依赖 | 备注 |
|---|---|---|---|
| I1 纯核与状态 | 新 `src/lib/restore-skip-diag.ts`、新 `tests/restore-skip-diag.test.ts` | 本设计、LSTGUARD1 verified | 无接线，合并后生产行为不变 |
| I2 gate 只读出口 | `src/lib/launcher-restore-gate.ts`、新 `tests/launcher-restore-gate-outcome.test.ts` | 无（可与 I1 并行） | `tests/launcher-restore-gate.test.ts`、`tests/launcher-restore-gate-lstguard1.test.ts`、`tests/restart-expect-restore*.test.ts` **不改且保持绿** |
| I3 launcher 接线（off / observe） | `src/launcher.ts`、新 `tests/launcher-restore-skip-diag-wiring.test.ts` | I1、I2 | launcher 改动控制在十几行：读开关、收集证据、三处调用（`manager list` 之前取观测令牌、提前返回处与尾部提交）；先解决 G4 的测试缝 |
| I4a bridge 期望项目（G9；改 bridge 路由，须另立卡并单独过安全审查） | 新 `src/lib/route-project.ts`、`src/bridge.ts`（两处各一行调用）、`src/bridge/router.ts`（`meta.expectProject` 类型）、`src/lib/held-idle-batch.ts`（批次校验带上该字段）、新 `tests/route-project.test.ts` | 无（可与 I1–I3 并行） | 只加一个可选字段：不带该字段的帧行为逐字节不变（现有调用方都不带）；`tests/project-pm*.test.ts`、`expectSession` 相关用例不改且保持绿 |
| I4 通知（on） | 新 `src/lib/restore-skip-notice.ts`、新 `tests/restore-skip-notice.test.ts`、`src/launcher.ts`（注入依赖） | I3、**I4a** | 合并不等于启用；on 需要 PM 单独批准。`bridgeSend` 原样使用（含现有 `stillActive`），`src/lib/bridge-client.ts` 不改 |
| I5 只读展示（可选） | `src/lib/doctor.ts` 及其测试 | I3 | 本机类别（`pending_review_local`、`unreadable_inputs`）除日志外的唯一展示面 |
| I6 预检结构化原因出口（可选，G3；须另立卡并单独过安全审查） | `src/manager/restart-expect-restore.ts`（`restoreSkip` 的 catch 给出原因码：读失败 / 死活未知 / 身份或状态不符 / 线格式）、`src/manager/restart-expect.ts`（`markExpectSkips` 的「复核前已拒」同样带码）、`src/manager.ts`（结果行透出该字段）、`src/lib/launcher-restore-gate.ts`（只读透传，`skipped` 的判定与预算不变）、对应新测试 | I2、I4 | 只加字段，不改任何放行 / 拒绝判定。落地后才可以把「每个未解释轮都带『非读失败、非死活未知』码」的记录从本机待核升为可通知；带读失败 / 死活未知码的轮仍然只本机 |

不在 I1–I5 任何节点范围内：`src/manager.ts`、`src/manager/restart-expect*.ts`、`src/manager/restart-lock.ts`、`src/manager/projects.ts`、`src/lib/bridge-client.ts`、registry 写入、台账写命令、配置文件格式、机器设施；bridge 只有 I4a 碰，且只加期望项目核对。I6 是唯一会碰 manager 预检文件的节点，它不是 I1–I5 的前置。

### 10.2 旧红新绿矩阵（全部在隔离夹具里：`mkdtemp` 状态目录、假 `RestoreDeps`、注入的假 `bridgeSend` 与内存台账、假时钟）

「旧红」= 用例在基线 `6656cf461acd` 上失败（模块不存在或断言不成立）；「保持绿」= 基线已成立，实现后必须仍成立。

| # | 场景 | 断言 | 基线 | 实现后 | 节点 |
|---|---|---|---|---|---|
| M1 | 登记缺项持续（S1a / S1b 的输入，假时钟推 30 分钟） | 状态里出现 `klass: registration_gap`，本机日志 1 行 | 红（§3：不留痕） | 绿 | I1、I3 |
| M2 | 同上 | gate 的 `failures` 恒 0、gate 告警 0、子进程回调次数与基线相同 | 绿 | 保持绿 | I3 |
| M3 | 合法身份恢复 | 记录被删，无分类 | 红（无模块） | 绿 | I1 |
| M4 | 持锁冲突持续超过 30 分钟（假 `isRestartInProgress` 恒真） | 计数恒 0，无分类 | 红 | 绿 | I1 |
| M5 | 读失败·初始窗口清单持续超过 30 分钟（`noAuthority`） | 只有本机 `unreadable_inputs` 标记；`skipRounds` 为 0；on 模式发帧 0 | 红 | 绿 | I1、I4 |
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
| M18 | 发帧栅栏（真实 `bridgeSend` + 假 `WebSocket`，在 `bridgeSend` 已调用、`onopen` 触发之前改状态） | 握手期间分别发生：换代（R2）、恢复删除（R3）、真实失败（R4）、从名单移除（R1）、持锁清零（R6）、降为本机待核、状态文件被删、状态文件损坏——每种都是 0 帧、返回 `sent: false`；同一条消息里其余 agent 的键变 `cancelled` 且 `attempts` 复原、项目项被删、下一轮可重新认领；握手期间无变化时恰 1 帧。另：认领前换代则根本不认领 | 红 | 绿 | I4 |
| M19 | 界限 | 300 个 agent：记录 ≤ 256；计数封顶；状态无自由文本字段；项目限流表 ≤ 256 项；每条记录通知键 ≤ 8 | 红 | 绿 | I1、I4 |
| M20 | gate 出口 | 额度已满 / 状态故障报 `gate_refused`（诊断保持，不终止）；既有 gate 用例的状态文件逐字节不变 | 红 | 绿 | I2 |
| M21 | 读失败·预检阶段：初始观测合格（`restoreWindowIds` 不抛），随后真实 `restoreSkip` 分别遇到 registry 重读抛错、窗口清单重读抛错、死活探测答未知，各持续超过 30 分钟 | 三种都只有 `localOnly: pending_review_local`；on 模式发帧 0、不解析 PM；gate 的 `failures` 恒 0 | 红 | 绿 | I1、I3、I4 |
| M22 | 未解释轮混入 | 缺项轮中夹 1 个无证据轮：不出 `registration_gap`；已 `delivered` 之后再出现无证据轮：降为本机待核、不再发帧、去重记录保留 | 红 | 绿 | I1、I4 |
| M23 | 过期轮·旧轮晚于新轮（两个实例共用一个状态目录，旧实例在取令牌后挂起到新实例提交之后） | 旧轮提交被拒，状态文件字节不变：新代次的计数、`delivered` 都在；之后新代次不从零重数、不重发 | 红 | 绿 | I1、I3 |
| M24 | 过期轮·不擦除通知状态、不发通知 | 新代次通知键为 `unknown` / `claimed` / `failed` 时旧轮晚到：键原样保留；过期轮认领数 0、发帧 0；两轮同令牌时恰一轮被接受；状态文件删除重建后旧令牌（序号相同、`epoch` 不同）被拒 | 红 | 绿 | I1、I4 |
| M25 | 项目长期流转 | 300 个项目依次建立诊断、发帧、agent 消失（假时钟）：全程项目项数 ≤ 同一 30 分钟窗口内认领过的项目数，结束后过窗归零；窗口内的项目项不被回收（同项目第二条消息仍被限流）；带未结 `claimed` 的项目项不被回收；`lastNoticeAt` 在未来时被改写并可回收 | 红 | 绿 | I4 |
| M26 | 计数封顶·未解释轮（测试里把上限注入成小值，如 50，另留一个用真实上限 100000 的纯核用例） | 1 个未解释轮后全是线格式轮：到顶前一轮、到顶当轮、到顶后 1 轮与 N 轮，都是 `localOnly: pending_review_local`，on 模式认领 0、发帧 0；`hadUnexplained` 始终为真 | 红 | 绿 | I1、I4 |
| M27 | 计数封顶·非缺项轮与重启重建 | 1 个线格式轮后全是缺项轮：到顶前后都是 `pending_review`，不变成 `registration_gap`；纯缺项到顶前后都是 `registration_gap` 且不重发；在到顶前、到顶当轮、到顶后分别丢弃实例、从同一状态文件新建：类别与两个标记不变、不重发；R6 / R2p 清零后标记归零并可重新累计；标记与计数不一致的状态文件按损坏处理（不写、不通知） | 红 | 绿 | I1、I4 |
| M28 | 项目变更·记录与去重 | 同代次 A → B：`reassigned`，计数与类别清零，B 里重新满 `N_MIN` / `T_MIN` 才通知 pmB，正文轮数只含 B 段；A 的 `delivered` 键保留，回到 A 再分类不重发；A 的 `failed` 键在 B 期间不重试；`project` 变空 → `no_target`、0 帧；12 个项目流转后键 ≤ 8、之后不认领 | 红 | 绿 | I1、I4 |
| M29 | 项目变更·发送方栅栏（真实 `bridgeSend` + 假 `WebSocket`，`bridgeSend` 已调用、`onopen` 之前改动） | 分别：被诊断 agent 移到 B 且新一轮已提交；被诊断 agent 的登记已改到 B 但新一轮未提交；收件人 PM 的登记改到 B（诊断状态字节不变）；台账 PM 指针换人；registry 文件缺失 / 损坏；台账打不开——每种都是 0 帧、`sent: false`，旧项目的键 `cancelled` 且 `attempts` 复原，pmA 与 pmB 都没收到任何东西；无改动时恰 1 帧且帧里带 `expectProject` | 红 | 绿 | I4 |
| M30 | bridge 期望项目（隔离的 bridge 路由夹具，假登记） | 带 `expectProject` 的帧：收件人不在该项目、任一 member 不在该项目、member 不在登记里 → typed `project_mismatch`、0 投递；押后期间收件人或 member 换项目 → 补投前丢弃、0 投递；前任 PM 转交给同项目当班 PM 时照常投递；全部相符时投递 1 次。不带该字段的帧：投递与基线逐字节相同 | 红（字段不存在） | 绿 | I4a |
| M31 | 项目隔离端到端（I4 + I4a，假 bridge 实现 M30 的规则） | 栅栏放行之后、bridge 路由之前把 pmA 移到 B：0 投递，键记 `failed`，下一次认领因 pmA 不属 A 而不发生；全程 pmB 收到的正文里不出现项目 A 的 id，pmA 收不到 agent 进入 B 之后产生的诊断 | 红 | 绿 | I4、I4a |

## 11. 本卡校验（如实分列）

本卡的 diff 只有本文件。

- §3 隔离夹具：本机实跑，6 pass / 0 fail / 47 个断言；第一次运行有 1 个失败，原因是夹具把同一个 agent 名用在多个用例里、撞上 `markExpectSkips` 的进程级集合（夹具问题，不是源码问题），改成每个用例独立命名后全过。夹具与模型脚本都不入仓，审查方未复跑。
- §3 补跑探针（本轮修订）：本机实跑真实 `bridgeSend` 与 `restoreSkip`，7 pass / 0 fail / 22 个断言；先按 CI 用 `bun install --frozen-lockfile` 装了根目录依赖（没装时 import 链报缺 `zod`）。不入仓，审查方未复跑；上一轮审查方自己的发帧探针结论与 P-send 一致。
- §7 模型：纯函数推演，不是实现；本轮按修订后的规则重写并整表重跑。§3 的 S1–S5 夹具是上一版作者所跑，本轮**没有复跑**，其结论只涉及现行源码、不受本轮规则修订影响。
- 第 1 轮修订对应第 1 轮审查的四项：过期轮（§5.1、M23、M24）、发帧栅栏（§4.5、M18）、预检阶段读失败（§4.2、§4.3、M21、M22、I6）、项目限流表有界（§4.5、M19、M25）。
- 第 2 轮修订对应第 2 轮审查的两项：项目边界 project-fence（§4.3 R2p、§4.4、§4.5 第 3、5 步与「项目边界的分工」、G9、I4a、M28–M31）、计数封顶 counter-cap（§4.3「计数封顶与证据标记」、M26、M27）。
  本轮对源码只做了只读核对（`projects.ts`、`bridge.ts` 路由与押后补投、`route-session.ts`、`project-pm-delivery.ts`、`registry.ts`，blob 见 §1）；**没有补跑任何针对现行源码的夹具或探针**，§3 的两组实跑都是之前轮次的结果。
  `model3.ts` 是本轮新写、本机实跑的纯函数模型（31 项核对全过；第一次运行有 1 项不过，是我把「持锁清零后重新累计」的期望轮次算错了一轮，模型输出 57 是对的，改期望后全过）。G9 的 bridge 端规则在模型里只是一个布尔函数，**现有 bridge 没有这个行为**。
- 本地（只改文档，结果与源码无关，如实列出）：上一版记录的是 `bun run typecheck` 退出 0、`GUARD_STRICT=1 bun run guard` 通过、`bun build src/manager.ts --target=bun` 退出 0；每轮修订后重跑的是 `GUARD_STRICT=1 bun run guard` 与 `git diff --check`（结果见各轮交付自查），typecheck 与 build 修订轮未重跑。本地全量 `bun test` **未跑**。
- 全量测试以 PR 准确 head 的正式 CI 为准；独立跨族审查以审查回执为准。这两项本文不预填结果。
- 原 P2 `restore-precheck-refusal-as-skip` 不因本文发布而关闭。
