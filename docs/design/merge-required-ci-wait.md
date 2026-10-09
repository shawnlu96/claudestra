# 必需 CI 长期未定：可观测性与安全收口（dispatch-recovery-CIF6，仅设计）

状态：**设计稿**。依赖 CIF4（c78c1fca，`ready` 在必需结论出来前等待）已合。对应问题 `ready-wait-unbounded`。
本文只新增这一个文件：不改源码、测试、配置、`recovery-policy.json`、运行意图或任何预算，不发 GitHub 请求。
**合并本文不等于“卡住的问题已解决”或“新超时已上线”**；实现另行登记（见 §9）。

修订（dispatch-recovery-CIF7，仅澄清，不扩能力）：收 CIF6 r2 审查的三条 P2——`ready-await-continuity`（§3.1、§3.4）、
`observe-to-on-overdue`（§3.2、§3.5）、`unchanged-snapshot-since`（§5）。原审查报告不改写；三条 P2 登记在 CIF7，不因本文关闭。
本修订不注册 `ciWait`、不加阈值 / 重跑 / 告警、不加第二份 once 额度或第二个策略入口；§7 仍是设计矩阵，不是已跑过的 CLI 测试。

基线 head：`fbf10b39`（CIF6 写作时为 `a60464d3`；两者之间只有 `scheduler-merge-external.ts` 多了一行 import，其余引用文件未变）。下文行号都指 `fbf10b39`。

## 1. 现状：哪些路径会无限等

合并驱动每个调度 tick 跑一步（`src/lib/scheduler-service.ts:101` `driveMerge`），每次写入都经
`ledger scheduler-merge-step` 子进程（`advanceMergeRun`，租约 + `phase/rev` CAS）。服务进程手里的 `db` 只用来读
（`mergeRunDrift(db, m)`），从不直接写——它就是 `src/scheduler.ts:26` 的 `LedgerReader` 连接（`src/lib/ledger-read.ts:32`，
`PRAGMA query_only = ON`），任何写语句在 SQLite 层就被拒。本设计所有“驱动侧查询投影”都指这条连接（§5）。

返回 `run` 原样（不写任何东西，下一 tick 再读）的分支，也就是“未定”：

| # | 阶段 | 条件 | 位置 | 有没有时钟 |
|---|------|------|------|-----------|
| W1 | ready | CLEAN/UNSTABLE/BEHIND 且 `ciRed()==="unsettled"`（非必需项已红，必需项缺或 pending）—— CIF4 | `scheduler-merge-driver.ts:174` | **无** |
| W2 | ready / await_ci | `pr.draft` | `:167`、`:203` | 无（不在本卡范围，见 §6） |
| W3 | ready / await_ci | 列车 `train()==="wait"` | `:172`、`:218` | 列车自己的：`TRAIN_CI_TIMEOUT_MS` 60 分钟/车厢、`TRAIN_DEADLINE_MS` 6 小时/列车（`scheduler-merge-train.ts:17-18`） |
| W4 | await_ci | BEHIND 且已有 fail 但 `unsettled` | `:219-220` | **无** |
| W5 | await_ci | UNSTABLE 且（无红 或 `unsettled`） | `:221-223` | **无** |
| W6 | await_ci | CLEAN、无 fail/cancel、但 `green()` 为假（必需项 pending / 缺名 / skipping） | `:228` | **无** |
| W7 | updating | BEHIND（GitHub 还在更新） | `:192` | 无（CIF2 自己的 claim 有 `BEHIND_SETTLE_MS`，其余无；不在本卡范围，见 §6） |

已有、**不能挪用**的时钟和预算：

- `MERGE_STATE_UNKNOWN_LIMIT_MS = 10 分钟`（`driver:57`）：只量**连续** `mergeState=UNKNOWN`，起点存在
  `scheduler_merges.unknownSince`，经同阶段观察回执 `MERGE_UNKNOWN_WAIT/CLEAR` 写（`scheduler-merge.ts:198-217`）；
  任何非 UNKNOWN 读数都清零（`watchUnknown`，`driver:61`）。到点 → `unknown`（冻结队列）。
  “gh 明说 no checks reported”被 `mergeExternal.inspect` 改写成 UNKNOWN（`scheduler-merge-external.ts:55-57` 注释、`:70` 赋值），
  所以“workflow 根本没触发”**已经**走这条 10 分钟 → `NO_CHECKS_LIMIT_REASON`。本设计不借这个时钟，也不改它的语义。
- `RERUN_SETTLE_MS`（`scheduler-merge-ci-rerun.ts:213`）、`BEHIND_SETTLE_MS`（`scheduler-merge-ci-behind.ts:182`）：各 10 分钟，
  只量“已发重跑/已发 update-branch 后 GitHub 是否开始动”，不量 CI 跑多久。
- CIF1 重跑额度：每个 PR head 一次（`rerunOf` 按 head 查 `merge_ci_rerun` 事件，`ci-rerun.ts:264`）。
- CIF2 合入 main 额度：每个合并运行一次、每个 head 一次（`behindOf`，`ci-behind.ts:228`）。
- `MAX_CI_REFRESHES = 3`（`scheduler-merge.ts:159`）：await_ci → updating 次数上限。
- 列车 CI 预算：上面 W3 的 60 分钟 / 6 小时。

现有展示：

- `ledger merge-queue`（只读，走 `LedgerReader`，`src/manager/ledger.ts:150-152`、`write-commands.ts:65`）只给阶段，不给“等 CI 多久、为什么”。
- 工作看板 `ledger-work-board.ts:78`：`await_ci` → “等 CI”，起点用 `merge.updatedAt`——它会被 rerun claim、`unknownSince`
  观察等任何 `rev+1` 改动刷新，**不是**等 CI 的起点；W1 停在 `ready`，看板根本不显示“等 CI”。

结论：仓库里**不存在**“CI 未定超时”。W1/W4/W5/W6 可以永远占着项目合并槽，没有结构化记录，也没人被告知。

## 2. 证据等级

只看驱动本来就读到的 `PrSnapshot`（`mergeState` + `checks[{name,bucket,link}]` + `noChecks`），不加 GitHub 调用。
`required` = `run.requiredChecks`（开 run 时固定，`beginMergeRun`）。

| 级 | 名称 | 判定（同一次 inspect） | 说明 | 本设计处理 |
|----|------|------------------------|------|-----------|
| E0 | 读失败 | `inspect` 抛错 | 驱动 catch → `unknown`“外部步骤失败”（`driver:240`） | **不变**；读失败不算观察、不推进也不清零任何计时 |
| E1 | 必需 pending | 每个必需名都在，至少一个 `pending`，无必需红 | CI 正在跑，最强“还在跑”证据 | 观察 `pending` |
| E2 | 必需缺名、其他在跑 | 有必需名缺席，且非必需项里还有 `pending` | 分片 workflow 的汇总闸 `typecheck + test + guard`（`needs: tests`）还没被创建，正常 | 观察 `pending`（与 E1 同类、同时钟） |
| E3 | 必需缺名、其他全部结束 | 有必需名缺席，且所有出现的检查都是 pass/fail/skipping/cancel | 汇总闸没生成：workflow 改名、job 改名、Actions 没排上、`if:` 没写 `always()` 等——**异常**，但不等于代码失败 | 观察 `missing` |
| E3s | 必需项 skipping | 必需名出现但 `bucket=skipping`，其余全部结束 | `green()` 只认 `pass`，会永远等（W6）；也不是红 | 归入 `missing` |
| E4 | 一个检查都没有 | `noChecks===true` | workflow 未触发 | **不变**：已由 UNKNOWN 10 分钟时钟管 |
| E5 | 必需红 | `ciRed()==="required"` | 已由 bounce / CIF1 / CIF2 处理 | **不变**，不观察 |

E2 与 E3 的区分只看“其他检查是否都已结束”，不看时间戳（`PrSnapshot` 没有）；E3 起点是**第一次读到 E3 的那次观察**。

## 3. 观察记录（验收 1）

### 3.1 写在哪

**只写事件，不改 `scheduler_merges` 的列**：不碰 `reason`（CIF1 的 `等 CI 重跑开始：…` 缓存、CIF2 的 behind claim
都住在这里）、不碰 `unknownSince`、不碰 `phase`、不 `rev+1`、不改 `updatedAt`；不写进 carry 回执与来源链（MAINP2 chain）。

写入通道是现有 `scheduler-merge-step <intent> --from P --to P --rev N --receipt <CI_WAIT 回执>`（同阶段观察），在
`observeMergeState`（`scheduler-merge.ts:202`）里加一个分支：

1. 只接受 `phase ∈ {ready, await_ci}`、`rev` 等于当前（CAS），回执可解析；
2. 照旧先跑 `mergeRunDrift`：漂移就抛 conflict → 驱动 catch → `unknown`，**与 UNKNOWN 观察一致，CI 解释不能盖住漂移**；
3. 回执里的 `head` 必须等于 `row.reviewedHead`，`checks` 名必须是 `requiredChecks` 子集，enter/snapshot/switch 类必须是 `pending|missing`，exit 类为 null 且必须引用当前活动 episode；
4. 在同一事务内按事件 seq 投影当前等待，校验回执的 `expectedObservationSeq` 等于当前末条观察 seq
   （空历史为 0）；不相等报 conflict，不写事件。行 `rev` 未变时仍靠此观察 CAS 防止旧快照覆盖新状态。
   相同 `observationId` 重送且内容一致返回已写结果；同 ID 不同内容拒绝。去重先核对既有结果，再检查观察 CAS。

等待生命周期与 CIF1 额度分开：`rerunSeq` 仅引用该 head 最新 CIF1 `merge_ci_rerun` seq（无则 0），
**不是 episode ID**，不新增或重置任何 rerun/behind claim。每次从 inactive 进入等待，事务分配单调递增
`episode`（同 intent/head）；每次切类也关闭旧 episode 并打开新 episode，起点取该次写入的台账时间。

**episode 的唯一连续性规则**（全文只有这一条，§3.4 给推演）：一个活动 episode 由 `(intentId, head, rerunSeq, class)` 标识，
只在下列四种情况关闭：(a) 有效观察切类（`switch`）或读到退出条件（`exit`，见下段）；(b) 运行离开观察范围
`{ready, await_ci}`——即任何去 `updating / merging / await_review / unknown / resolved` 的合法转换，关闭写在该转换的原事务里；
(c) `head` 改变（沿用审查 `carryReview` 把 `reviewedHead` 换成新 head，`scheduler-merge.ts:175`、`:186`）——同样在原转换事务里关闭；
(d) 该 head 的 CIF1 `merge_ci_rerun` seq 前进，旧 episode 由投影判为 inactive，下一次有效观察以 `enter` 另开（`previousEpisode` 指向旧的）。
**观察范围内部的合法阶段转换不关闭 episode**：今天只有 `ready → await_ci`（`driver:182`，`advanceMergeRun` 走正常 `rev+1`、
原回执、原漂移门）；`NEXT` 没有 `await_ci → ready` 的边（`scheduler-merge.ts:153-157`），所谓“反向”在现状态机不可达，
若将来加上也适用同一规则。转换本身不写 `merge_ci_wait`，也不绕开 `rev`：转换后 `rev` 已变，下一条观察回执必须用新 `rev`，
并重新读取投影取得 `expectedObservationSeq`（转换没写观察事件，所以它通常等于转换前的末条观察 seq）。转换后第一条有效观察
若与活动 episode 同类，写 `snapshot`（事件里的 `phase` 更新为新阶段），`since` 不变；若切类写 `switch`；若读到退出条件写 `exit`。

事件形状（`kind: "scheduler"`；observe 模式同结构包在 `recovery_observe` 的机制笔记内）：

```
data: { op: "merge_ci_wait", intentId, phase, head, episode, rerunSeq,
        action: "enter"|"snapshot"|"switch"|"exit", class: "pending"|"missing"|null,
        previousEpisode, expectedObservationSeq, observationId, exitReason,
        missing: [必需名…], pending: [必需名…], others: { pass, fail, pending, skipping, cancel },
        mergeState, mode: "on"|"observe" }
```

`switch` 在一条事件内关闭 previousEpisode 并打开新 episode；`exit` 仅关闭，不留活动 class。
每次有效同类读取用 `snapshot` 更新缺名、pending 名、其他计数与 mergeState；这些变化不重置 since。
内容未变可以不写，最新持久快照标注其实际观察时间；不能将旧快照时间伪装为本次读取。
`others` 只存计数，不存非必需项名字/链接；既有回执 ≤600 字限制不放宽，超限拒绝且不截断必需名。
后续实现需以紧凑编码验证该边界，不能发布部分诊断快照。

去重分两层：回执重送按 `intent/head/observationId`；到期按 `intent/head/episode/overdue`。
`merge_ci_wait_overdue` 引用 episode 与当前快照 seq；事务再次核对 episode 活动、class、观察 CAS 及阈值，
到期记录和 on 模式的升级原子去重。重启/重复 tick 不重复升级；旧 episode 的 overdue 不能升级当前等待。

退出也必须持久化：有效读取显示全绿、必需红、noChecks/UNKNOWN、draft、列车 wait 或离开 W1/W4/W5/W6
时，经同一租约/CAS通道写 exit，再走原路径。离开观察范围、head 改变或进入终态时，由该合法转换的原事务关闭旧活动
episode（上段 (b)(c)）；观察范围内的 `ready → await_ci` 不关闭。不得为此放宽漂移检查或在终态补写未经授权回执。读 API 失败不是有效退出观察，不编造 exit；原 catch
若实际转入 unknown，则由该阶段转换关闭 episode。退出后重新进入，无 rerun 也必须分配新 episode。

### 3.2 observe / on / off

新机制挂在现有唯一策略入口 `recoveryPolicy(project, key)`（`recovery-policy.ts:86`），拟用键名 `ciWait`。
**本文不注册该键**（`RECOVERY_KEYS`，`:27`）、不改 `recovery-policy.json`。

| 模式 | 行为 |
|------|------|
| off | 与今天字节级一致：驱动不发 CI_WAIT 回执，不写任何事件 |
| observe | 写 `recordObserved` 笔记（`op: recovery_observe`, `mechanism: ciWait`，actionKey 使用完整 intent/head/observationId；到期使用 intent/head/episode/overdue），**经 `scheduler-merge-step` 子进程**写，不由驱动直写 |
| on | 写 §3.1 的 `merge_ci_wait` / `merge_ci_wait_overdue`，到期发一条升级（§4.2） |

注意：注册键后，缺省模式是 `DEFAULT_RECOVERY_MODE = observe`（`:31`），即**所有项目默认开始写观察笔记**。这在实现单里
需要 owner 明确批准；若要求默认零写入，实现时须在项目里显式置 `off`。W1–W7 的阶段判定与结局（仍是原地等待）在任何模式下不变，observe / on 仅增加生命周期观察写，不改变原结局。

恢复规则：按同 intent/head 的持久事件 seq 顺序投影（on 事件与 observe 笔记统一语义），
enter/switch 确定 episode 的 since，snapshot 仅替换诊断，exit 使其 inactive；不按 class 最早 ts 回溯。
observe → on 保留活动 episode、since 与快照；若 observe 已记录 overdue，on 不补发重复升级——**这是有意的通知代价**，
不是遗漏：该 episode 在 observe 中已到期，随后切 on 不自动补告警；不得为了拿到告警假造 exit / 新 episode 或重置 since。
若以后要 catch-up，须另立带审批边界的设计（它等于一次新的通知授权）；本文不新增通知预算或授权。四组切换推演见 §3.5。
off 不写新事件；读展示在 off 下不展示旧活动等待，重新启用时先关闭旧投影再按当前有效读取新开 episode，
不把 off 期间未观察的时间算进等待。本文不注册或启用策略，也不授予持续批准。

### 3.3 只读展示，与真实 CLI 共存

- `ledger merge-queue`：仍走 `LedgerReader`，**只 SELECT**，不调 gh。每行加 `ciWait`：`类 / 起点 / 已等分钟 / 是否到期`，
  只认 intent/head 匹配、阶段仍在范围内的唯一活动 episode，展示其当前 class 与最新诊断快照；
  已退出、旧类、旧 head、终态与旧 episode 不显示。明确标注“最后一次观察，不是实时 GitHub”。
- 工作看板 `ledger-work-board.ts:78`：有当前 `merge_ci_wait` 记录时 `since` 用其起点，否则保持 `merge.updatedAt`（旧行为）；
  W1（phase=ready）有记录时也显示“等 CI”。
- 读库连接、`READER_ONLY_SUBS` 不变；展示代码不调用 `recordObserved`、不 `openLedger`。
- **不泛发 owner 告警**：升级只针对本卡 PM（§4.2）。

### 3.4 阶段连续性推演（CIF7 · ready-await-continuity）

真实可达的 W1 → W6 连续 pending（同 intent、同 head、`rerunSeq=0`，每步都是现有驱动代码的分支）：

| t | 读到 | 驱动分支 | 台账写 | episode / since |
|---|------|----------|--------|-----------------|
| t0 | `ready`，分片 `test` 红（非必需）、必需 `typecheck + test + guard` pending | `driver:174` `unsettled` → 原地 | 同阶段观察 `enter(pending)` `ready@rev0`，`expectedObservationSeq=0` | E1 开，since=t0 |
| t1 | 同上，另一个非必需检查结束（others 计数变），mergeState 仍 CLEAN | 同上 | `snapshot`（others 变）`ready@rev0`，`expected=seq(t0)` | E1，since=t0 |
| t2 | 有人手动重跑了那个红分片，分片变 pending；必需仍 pending。**前提全部成立**：同 head、非 draft、`bounceStep` 无结论（非 DIRTY）、mergeState CLEAN 或 UNSTABLE（不是 BEHIND）、`external.freshness().behindBy === 0`、没有列车或列车已 cleared、无 fail/cancel | `ciRed()` 不再 `unsettled`（没有非必需红了）→ `driver:175` 两个条件都假 → `:180` 非 failed → `:182` `step("await_ci")` | 先写 `snapshot` `ready@rev0`（others 计数变），再 `ready→await_ci` **`rev0→rev1`**，原回执“PR … 可合并，等待 CI”，原漂移门 | E1 **不关**，since=t0 |
| t3 | `await_ci`，CLEAN，必需仍 pending | `driver:228` `!green()` → 原地 | `snapshot` `await_ci@rev1`，`phase=await_ci`，`expected=seq(t2 的 snapshot)` | E1，since=t0 |
| t60 | 同 t3 | 同上 | 投影：since=t0、已等 60 分钟 → 到期回执 `await_ci@rev1`（§5） | `overdue` 引用 E1；on 模式升级一次 |

重跑分片本身不造成转换：转换只因为 `ciRed()` 不再返回 `unsettled`，且 `driver:175` 的 BEHIND / `behindBy` 两个条件同时为假。
同一 head 一旦 BEHIND（或 `behindBy > 0`），不换 head 就回不到“不落后”，所以那条路是 `updating`（离开范围，新 episode），不是连续 W1→W6。

对照（都开新 episode，since 重置）：t2 若读到必需 `missing`（E3）→ `switch` 关 E1 开 E2（切类）；t2 若 CIF1 已对该 head 写过
`merge_ci_rerun`（`rerunSeq` 从 0 变成那条 seq）→ E1 由投影判 inactive，下一次观察 `enter` 开 E2、`previousEpisode=E1`；
`await_ci` 期间 BEHIND 走 `updating`（离开范围）→ 转换事务里 `exit`，回到 `await_ci` 后再 `enter`；沿用审查换 head →
碰不到旧 key，转换事务里 `exit`，新 head 从零；全绿 / 必需红 / `unknown` / `resolved` → `exit` 或转换事务关闭。
旧 episode 的 `overdue` 永远不升级新 episode；CIF1 / CIF2 的每 head 一次额度在整个推演里不被读、不被写。

### 3.5 模式切换推演（CIF7 · observe-to-on-overdue）

六组场景的区别只在“谁写了什么”，episode、since、旧额度与去重在每组都保持；都只是设计矩阵，不是已跑过的 CLI 测试。

**什么才算一次真实的模式转换。** 模式由 `recovery-policy.json` 决定：所有读者（含驱动每 tick 调的 `recoveryPolicy(project, "ciWait")`，
`recovery-policy.ts:86`）只读文件，`ciWait` 的有效模式 = `keys.ciWait ?? 项目 mode ?? observe`（`:91`，override 优先于项目整体 mode）。
`ledger scheduler-recovery`（`setRecovery`，`:239`）的发布协议是：事务里先提交一条 `kind: decision / op: scheduler_recovery`
审计（`publish: "prepared"`，`from/to` 为整个项目状态 `{mode, manualStallHours, keys}`），COMMIT 后才原子写文件（项目条目 `rev` = 审计 seq），
最后写 `scheduler_recovery_published` 注记（dedupKey `recovery-published:<seq>`）；写文件失败则写 `scheduler_recovery_void`
（`recovery-void:<seq>`）。setter 在 COMMIT 与注记之间崩溃时审计悬而未决，由**下一个** setter 持文件锁后按文件 `rev` 补注
（`settlePending`，`:193`；`tests/recovery-policy-cli.test.ts:375` 起三个用例）。因此 **decision 的存在不证明模式生效**。

投影只采纳“已生效”的转换，判定规则（只读，三选一，不比较模式、不写任何注记——补注永远是 `setRecovery` 的事）：

1. 审计 seq 有 `scheduler_recovery_published` 注记 → 已生效；
2. 没有注记、也没有 `void`，但文件里该项目的 `rev === seq` → 已生效（发布后、注记前崩溃的只读证据；文件就是读者的真相）；
3. 其余——有 `void`、或 prepared 且 `rev !== seq`——**不是**证据：文件从未显示过这个模式，驱动在那段时间一直按旧模式读文件、照常写观察，
   所以等待并没有真的停过。unresolved prepared 不当 off 处理。

“最近观察 seq 之后存在一次已生效的转换，其 `effective(to) === "off"`”才构成 off 区间（C 组）；对 `from/to` 都用上面的有效模式公式，
所以项目整体 `mode: off` 与 `keys.ciWait: off` 一视同仁。手改 `recovery-policy.json`（无审计、`rev` 不变）和文件损坏导致的
`stopped("off")`（`:83`，无审计）都不留可采信的转换：投影不假造间隙，episode 按连续处理，等待时长可能偏长，但后果只是更早的一次
升级，不碰合并门；实现规格若要收紧，须另定且仍不得让只读投影写审计。

| 组 | 切换前 | 切换后第一次有效同类观察 | 到期 | 说明 |
|----|--------|--------------------------|------|------|
| A. observe 已到期 → on | observe 笔记里已有 `enter` 与 `overdue`（actionKey intent/head/episode/overdue） | `snapshot`（`mode: on`），since 不变 | 投影显示该 episode 已记录 overdue → **不**写 `merge_ci_wait_overdue`、**不**升级 | 有意的通知代价；`merge-queue` 仍显示“已到期”；只有新 episode（切类 / 退出重进 / head 或 rerunSeq 变）才会再升级 |
| B. observe 未到期 → on | observe 笔记里只有 `enter` / `snapshot` | `snapshot`（`mode: on`），since 不变 | 到阈值时写 `merge_ci_wait_overdue` + 一条 escalate，按 episode 去重 | 切换不重置 since，也不提前到期 |
| C. off 后重开（off → observe / on） | 最近观察 seq 之后有一次**已生效**（上面规则 1 或 2）的转换，`effective(to) === "off"` | 先 `exit`（`exitReason: mode_gap`，引用旧 episode）再 `enter` 新 episode，同一回执、同一事务 | 新 episode 从重开后的第一次有效观察起算；旧 episode 若已记录 overdue，保持已记录 | off 期间没观察的时间不算等待；旧 overdue 的去重键不复用 |
| D. 重启恢复（on / observe） | 持久事件里有活动 episode，当前文件模式是 on 或 observe | 新控制器经 `LedgerReader` 按 seq 投影取回 since、最新快照 seq、是否已 overdue，再决定 `snapshot` / 不写 | 只按投影：已记录则不重复；未记录且已过阈值则写一次 | 没有内存状态可丢；重送同 `observationId` 返回已写结果。off 下重启不在此行：off 不写任何事件、展示隐藏旧活动等待，之后重开按 C 处理 |
| E. 申请 off，COMMIT 后、写文件前崩溃（后被 void） | on 下 E1 pending，since=t0；事件里有 `to: off` 的 prepared 审计，文件仍是 on（`rev` 是上一次的 seq），下一个 setter 补 `void` | 规则 3：不是转换 → 普通 `snapshot`，since=t0 **不重置** | 已记录的 overdue 保持，不另开去重键、不再升级 | 驱动在整段时间都按文件读到 on、照常写观察，连续等待没有断过；`tests/recovery-policy-cli.test.ts:375` 的用例就是这个事件序列 |
| F. 申请 off，写文件后、`published` 注记前崩溃 | 文件已是 off（`rev === 该审计 seq`），事件里只有 prepared 审计，没有注记 | 规则 2：已生效 → 文件 off 期间驱动不写；重开（新审计发布为 observe/on，此时 `settlePending` 先给旧审计补 `published`）后第一次观察按 C：`exit(mode_gap)` + `enter` | 新 since；旧 overdue 保持 | 注记补上前，投影的证据是文件 `rev`，不是等注记；投影不替 setter 补注 |

所有组都不新增 once 额度、不改 CIF1 / CIF2 claim、不改 `unknownSince`。A 组若将来要补发，必须另立规格并过 §8 的审批点 2。
E / F 两组只用现有发布协议的既有事件与文件 `rev`，不要求 `setRecovery` 改任何行为。

## 4. 期限、升级、平台重跑（验收 2、3）

### 4.1 阈值

| 类 | 阈值 | 依据 | 到期做什么 |
|----|------|------|-----------|
| `pending`（E1/E2） | 60 分钟，自当前 episode 的 enter/switch | 与 `TRAIN_CI_TIMEOUT_MS` 同尺：本仓已认定“单次 CI 超过 60 分钟即异常”。是**独立观察阈值**，不读、不改、不延长列车预算 | 写 overdue + 升级 |
| `missing`（E3/E3s） | 10 分钟，自当前 missing episode 的 enter/switch | 与 `RERUN_SETTLE_MS`/`BEHIND_SETTLE_MS` 同尺：“GitHub 该动没动”。不借 UNKNOWN 的 `unknownSince` | 写 overdue + 升级 |

阈值作为实现里的常量，不进 `recovery-policy.json`、不新增配置键；改阈值另走规格。
列车 `wait`（W3）期间**不计 CI 等待**，进入时关闭原 episode：列车自己的 60 分钟 / 6 小时管；列车作废后成员回串行路径，再从头观察（新起点）。

### 4.2 到期语义

到期**只**产生记录与一次升级：

- **不**改 phase、**不**写 `resolved`、**不**构造 `ci_fail` 退回回执、**不**进 `unknown`、**不**冻结队列、**不**释放合并槽；
- 不意味代码失败，更不意味 CI 成功：`claimAndMerge`（`driver:121`）的最终门照旧要求 `CLEAN` 且 `green()`——**每个**必需名都 `pass`、
  无 fail/cancel/pending；缺一项不合，不能拿六个 success 顶七项必需；
- on 模式下升级 = 一条 `kind: "escalate"` 事件，目标是本卡，文本带类、起点、缺/挂的必需名、`mergeState`、PR head；
  只发一次（overdue dedup）；接收人是项目 PM 的现有看板/`pm-status`，不 @owner、不发频道广播。
  PM 现有出口不变：切手动后未发出的运行经 `manualCancel`（`scheduler-merge-conflict.ts:144`）取消、释放槽；或等作者推新 head。

### 4.3 平台重跑：本设计**不提出**

P1 不发任何新的 GitHub 写（不 `gh run rerun`、不 re-run workflow、不 dispatch）。若以后要对 E3 做平台重跑，前置条件（另立规格）：

- owner 批准（外部写），默认 off；
- 证据精确：所有出现的检查链接指向**同一** `actions/runs/<id>`，该 run 的 `head_sha == run.reviewedHead`、`attempt == 1`、`completed`；
- 先过台账 claim 再发；**与 CIF1 共用每 head 一次的重跑额度**（同一 `merge_ci_rerun` 查重），不得新增第二份 once；
- 发后 10 分钟未见新 attempt → 按 CIF1 的“重跑没有开始”收口。

### 4.4 已发合并与漂移

- `merging` / `unknown` 阶段完全不在本机制范围：已发出的 merge 结果不明仍是 `unknown`、不重发（`driver:233-238`、`resolveMergeRun` 只许人工）。
- 每次观察写都先过 `mergeRunDrift`（流程/规格/意图/head/PR/阶段/冻结/审查/UI/来源）；租约、CAS 失败照旧抛错。
  CI 未定的记录永远不作为任何漂移、head 变化、来源失效的解释。

## 5. 驱动侧改动要点

后续实现须在有效 inspect 后、各早退路径之前决定 enter/snapshot/switch/exit，不能只在等待分支写 enter。
同阶段观察通过既有 step 通道，离开观察范围 / head 改变 / 终态转换的关闭与原转换原子提交（§3.1 规则 (b)(c)）。
观察写返回活动 episode、since、最新快照 seq；驱动不靠内存计时，到期写再核对投影与 CAS。E0 不提供新快照，E4 关闭旧等待后
仅走原 UNKNOWN 时钟；列车 wait 关闭旧等待后仍走原列车预算。观察不得跳过身份、来源、租约或漂移闸。

### 5.1 内容未变、不写快照的 tick：since 从哪来（CIF7 · unchanged-snapshot-since）

驱动在每个 tick 里只有两种数据来源：这次 `inspect` 的 `PrSnapshot`，和 `src/scheduler.ts:26` 那条 `LedgerReader` 只读连接。
**没有第三种**：不保存上一 tick 的 since / seq，不用进程内计时器，不用 `Date.now()` 之差累加等待时长。

读路径（每个处于 `ready` / `await_ci` 的 tick，在有效 inspect 之后）：

1. 由 `PrSnapshot` 算出本次证据级（§2）与诊断内容（缺名、pending 名、others 计数、mergeState）。
2. 经只读连接查投影 `ciWaitProjection(db, intentId, reviewedHead)`：按同 intent/head 的 `merge_ci_wait` 事件与 `recovery_observe(ciWait)`
   笔记以 seq 顺序回放，得到 `{ episode, class, rerunSeq, since, lastObservationSeq, lastSnapshot, overdueRecorded, offGap }`；
   `since` 取活动 episode 的 `enter` / `switch` 事件的台账 `ts`，`rerunSeq` 同时对照该 head 最新 `merge_ci_rerun` seq；
   `offGap` 按 §3.5 的三条规则只看 `lastObservationSeq` 之后**已生效**的 `scheduler_recovery` 审计（`published` 注记，或文件 `rev === seq`），
   `void` 与未决 prepared 一律忽略。当前模式本身仍由 `recoveryPolicy(project, "ciWait")` 读文件得到，不从事件推。
3. 诊断内容与 `lastSnapshot` 逐字段相同 → **不写**；投影里的 `since` 与 `lastObservationSeq` 就是这个 tick 的全部状态。
   展示侧（`merge-queue`、看板）读的也是同一投影，所以“最后一次观察时间”= `lastSnapshot` 的台账 `ts`，不会被这个 tick 刷新。
4. `now - since ≥ 阈值(class)` 且 `overdueRecorded=false` → 发到期回执（下节）；否则结束本 tick 的观察部分，走原分支。
   这里的 `now` 只是本 tick 的墙钟读数，用于决定“要不要发请求”；判定权在写端。

到期写路径（CLI / CAS）：

- 驱动发 `scheduler-merge-step <intent> --from P --to P --rev <当前 rev> --receipt <CI_WAIT overdue 回执>`，回执带
  `episode / class / head / rerunSeq / expectedObservationSeq=lastObservationSeq / observationId`。
- 写端（`observeMergeState`，`scheduler-merge.ts:202`，调度服务身份、持租约）在原事务里：先 `mergeRunDrift`；再**重新**投影，核
  episode 仍活动、class 相同、`rerunSeq` 相同、`head == reviewedHead`、`expectedObservationSeq` 等于当前末条观察 seq；
  用写端自己的 `ctx.now` 与投影的 `since` 重算阈值；查 overdue 去重键 `intent/head/episode/overdue`。全部通过才写
  `merge_ci_wait_overdue`（on 模式再原子写一条 escalate；observe 模式只写 `recordObserved` 笔记）。
- 写端返回活动 episode、since、最新快照 seq；驱动不缓存，下一 tick 重新查投影。

陈旧投影一律拒绝写（`conflict` / `invalid`，事件不落）：

| 驱动读到的投影 | 写端核对结果 | 处理 |
|----------------|--------------|------|
| `rev` 过期（期间有合法转换或 UNKNOWN 观察） | `row.rev !== input.rev` | conflict；驱动下一 tick 重读 |
| `expectedObservationSeq` 不等于末条观察 seq（并发 tick 已写） | 观察 CAS 失败 | conflict |
| episode 已 exit / 已被 switch 关闭 / rerunSeq 已前进 | 投影无此活动 episode | conflict |
| class 与写端重算不符 | class 不同 | invalid |
| `head ≠ reviewedHead`（沿用审查已换 head） | head 不符 | invalid |
| 写端按 `ctx.now` 未过阈值（驱动时钟快了） | 阈值未到 | conflict |
| overdue 已记录（含 observe 笔记） | 去重命中 | 幂等返回已写结果，不升级 |
| 阶段不在 `{ready, await_ci}` | 范围外 | invalid |
| 任何漂移（流程 / 规格 / 意图 / head / PR / 阶段 / 冻结 / 审查 / UI / 来源） | `mergeRunDrift` 非空 | conflict → 驱动走原 `unknown` 路径 |

保留不变：已发出的 `merging` 结果不明仍是 `unknown`、不重发（§4.4）；最终合并门仍是 `CLEAN` 且 `green()` 对每个必需名 `pass`（§4.2）；
写端身份（调度服务）、租约、来源（MCRY6）、只读连接（`READER_ONLY_SUBS`、`ledger.ts:152`）与旧路径（UNKNOWN 观察、slot turn）共存，
`observeMergeState` 的既有分支逐字保留。

## 6. 不做

- 不改 W2（draft）、W7（updating BEHIND）的无界等待；不改 CIF1/CIF2/CIF3/CIF4 的判定与额度；不改 `MAX_CI_REFRESHES`、列车预算、UNKNOWN 时钟。
- 不新增表、列、迁移；不改 `scheduler.json` / `requiredChecks`；不改 `ci.yml`。

## 7. 后续实现 P1 测试矩阵（验收 4）

正例 = 应写记录/到期；负例 = 必须**不**写、或必须走旧路径。全部用真实台账 + `scheduler-merge-step` 子进程（现有
`tests/scheduler-merge-ci-ready-kit.test.ts` 的 CLI 套件）至少各一条，其余可用驱动单测。

| 组 | 用例 | 期望 |
|----|------|------|
| ready 未定 | W1：分片红、汇总缺名、其他仍 pending | `pending` 记录 1 条；phase 仍 ready；无 rerun/bounce；`unknownSince` 仍 null |
| | W1 持续 61 分钟 | overdue 1 条 + escalate 1 条；phase 仍 ready；槽仍占 |
| await_ci 未定 | W6：CLEAN、7 项必需中 6 项 pass、1 项 pending | `pending`；不合并 |
| | W6：1 项必需缺、其余全部结束 | `missing`；11 分钟后 overdue；**不合并、不 ci_fail** |
| | W6：必需项 skipping | `missing` |
| | W5 UNSTABLE 无红 / W4 BEHIND+unsettled | `pending` |
| 退出与重进 | pending → 全绿 | 持久 exit 后正常 `merging`；无活动等待 |
| | pending → 必需红 | 持久 exit 后走 CIF1/CIF2/bounce，原回执与额度不变；不写 overdue |
| | pending → CIF1 重跑 → 再 pending | 新 episode、新起点；rerunSeq 仅引用原 claim；CIF1 额度仍是一次 |
| | missing → 汇总出现变 pending | 新类 `pending` 新起点；旧 `missing` 不再显示 |
| | 固定 head/rerunSeq=0：t0 pending → t5 missing → t59 pending → t61 | 三个 episode，当前 since=59，等待2分钟，未到期；只显示最后 pending |
| | §3.4 W1→W6：ready pending(t0) → 分片手动重跑 → ready→await_ci rev+1(t2) → await_ci pending(t3) → t60 | **同一 episode**，since=t0；t2 的转换不写 ci_wait、不绕 rev；t3 snapshot `phase=await_ci`、expected=t2 快照 seq；t60 overdue 一次 |
| | 同上但 t2 读到必需 missing / t2 前 CIF1 已写 rerun / await_ci BEHIND 走 updating 再回 | 各开新 episode、since 重置；旧 overdue 不复用；CIF1/CIF2 额度不动 |
| 模式切换 | §3.5 A：observe 下已 overdue → 切 on → 继续同类 | snapshot `mode: on`，since 不变；**无** `merge_ci_wait_overdue`、无 escalate |
| | §3.5 B：observe 下未到期 → 切 on → 到阈值 | since 不变；overdue + escalate 各一条 |
| | §3.5 C：off → 重开（off 审计有 `published` 注记） | 同一回执 exit(mode_gap)+enter；新 since；off 期间不计 |
| | §3.5 D：on / observe 下重启 | 投影恢复；重送去重；overdue 只一次 |
| | off 下重启 | 不写任何事件；展示隐藏；重开走 C |
| | §3.5 E：off 审计 prepared 后崩溃、文件仍 on、后被 `void` | 普通 snapshot，since 不重置；旧 overdue 去重键不变、不再升级 |
| | §3.5 F：off 已写进文件（`rev === seq`）、无注记 | 判已生效：off 期间不写；重开后 exit(mode_gap)+enter，新 since |
| | 文件损坏 → `stopped("off")` / 手改文件 | 无可采信转换：不假造间隙，episode 连续；投影不写审计注记 |
| | §3.4 t2 前提缺一（仍 BEHIND / `behindBy > 0` / 列车 wait / fail） | 走 updating / 列车 / unknown，离开范围：exit 后新 episode，不是连续 W1→W6 |
| 不变快照 | §5.1：连续 N 个 tick 内容未变 | N 个 tick 都不写；`merge-queue` 的“最后观察”仍是最后一条 snapshot 的 ts；第 N 个 tick 过阈值 → 到期回执只带投影的 since |
| | §5.1 陈旧投影表的每一行 | 对应 conflict / invalid / 幂等，事件不写，`unknownSince` 与 rev 不动 |
| | pending → train wait → 串行 pending（同 head、无 rerun） | 持久 exit 后新 episode；列车时间不计入；预算不变 |
| | pending A → A完成/B pending（同类） | since 不变，最新快照仅列 B；到期引用 B，重启后仍为 B |
| | missing → pending、同类重复、全绿/红/终态后重入各在边界重启 | 投影唯一活动类；exit 后 inactive；重入新 since；旧 overdue 不复用 |
| 重启恢复 | 记录后杀进程、新控制器接手 | 按 seq 恢复活动 episode 的 since 与最新快照；重送去重；overdue 只一次 |
| 陈旧 / 多 head | CIF2 合入 main 换 head；沿用审查换 head；同 head 新意图 | 旧记录不计时、不显示；新 key 从零 |
| CLI / CAS | `--rev` 过期的观察回执 | conflict，事件不写 |
| | 观察时 PM 切手动 / head 漂移 / 队列冻结 | 走现有漂移 → unknown / manualCancel，**不被 CI 解释遮住** |
| | `merge-queue` 只读读到记录 | 不写库、不调 gh；读库未迁移时不报错 |
| | 回执 head ≠ reviewedHead、检查名不在 required、类非法 | invalid |
| 策略 | off | 与基线行为、事件流逐条一致 |
| | observe | 只有 `recovery_observe` 笔记，无 `merge_ci_wait`、无 escalate |
| | 策略文件损坏 | off（带诊断），不写 |
| 不越界 | E4 noChecks | 关闭旧 episode，仅原 UNKNOWN 时钟；无新等待/overdue |
| | E0 inspect 抛错 | 无新观察；原 catch → unknown 的转换关闭 episode |
| | 列车 `wait` | 有活动等待仅写 exit；无新等待/overdue；列车预算未变 |
| | `merging` 阶段重启、外部已合 / 未知 | 原核实或 unknown，不重发；无 ci_wait |
| | 平台 5xx / gh 超时（观察写之前） | 同 E0 |
| 保留门 | CIF1/CIF2 原测试、`scheduler-merge-ci-*` 全套、最终 `green()` 门 | 全部原样通过 |

## 8. 拟改文件与审批边界（验收 5）

后续实现单（另登记，估算行数，不含本文）：

| 文件 | 改动 | 估计 |
|------|------|------|
| `src/lib/recovery-policy.ts` | `RECOVERY_KEYS` 加 `ciWait` | +1 |
| `src/lib/scheduler-merge-ci-wait.ts`（新） | `ciWaitClass`、回执生成/解析、阈值常量、生命周期投影与快照查询 | ~180 |
| `src/lib/scheduler-merge.ts` | `observeMergeState` 加 CI_WAIT 分支（漂移、CAS、校验、事件、observe 笔记、观察 CAS 与转换关闭） | ~45 |
| `src/lib/scheduler-merge-driver.ts` | 有效 inspect 后覆盖等待、切类与退出分支 | ~30 |
| `src/manager/ledger-merge-queue-cmds.ts` | 只读 `ciWait` 列 | ~20 |
| `src/lib/ledger-work-board.ts` | `since` 取观察起点；W1 显示等 CI | ~8 |
| `tests/scheduler-merge-ci-wait*.test.ts`（新） | §7 矩阵 | ~480 |

审批点：

1. 注册 `ciWait` 键（默认 observe = 全项目开始写笔记）——owner；
2. 把任一项目切 `on`（开始写 escalate）——owner / 项目 PM 按 `scheduler-recovery` 现有权限；
3. 阈值 60 / 10 分钟——随实现规格由 PM 定；
4. 平台重跑——本设计不含，若要做须单独规格 + owner 批准。

流程边界：本卡只交设计稿，走设计提交 → 正式 CI → 独立审查。实现须另行登记卡片、文件范围与验收；
在实现合并并启用前，`ready-wait-unbounded` 仍是**未解决**状态。CIF7 的澄清不改变任何审批点：§3.5 A 组若要补发升级，
是新的通知授权，走审批点 2 另立规格。
