# 必需 CI 长期未定：可观测性与安全收口（dispatch-recovery-CIF6，仅设计）

状态：**设计稿**。依赖 CIF4（c78c1fca，`ready` 在必需结论出来前等待）已合。对应问题 `ready-wait-unbounded`。
本文只新增这一个文件：不改源码、测试、配置、`recovery-policy.json`、运行意图或任何预算，不发 GitHub 请求。
**合并本文不等于“卡住的问题已解决”或“新超时已上线”**；实现另行登记（见 §9）。

基线 head：`a60464d3`。下文行号都指这个 head。

## 1. 现状：哪些路径会无限等

合并驱动每个调度 tick 跑一步（`src/lib/scheduler-service.ts:101` `driveMerge`），每次写入都经
`ledger scheduler-merge-step` 子进程（`advanceMergeRun`，租约 + `phase/rev` CAS）。服务进程手里的 `db` 只用来读
（`mergeRunDrift(db, m)`），从不直接写。

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
  “gh 明说 no checks reported”被 `mergeExternal.inspect` 改写成 UNKNOWN（`scheduler-merge-external.ts:57-60`），
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
3. 回执里的 `head` 必须等于 `row.reviewedHead`，`checks` 名必须是 `requiredChecks` 子集，类必须是 `pending|missing`；
4. 写一条事件，`dedupKey = scheduler:<intentId>:ci_wait:<head>:<class>:<epoch>`，重复写由 UNIQUE 去重，返回原行。

`epoch` = 该 head 上 CIF1 `merge_ci_rerun` 事件的 seq（没有则 `0`）：重跑后再次 pending 是新的一轮等待，起点重算；
CIF2 / 刷新 / 沿用审查会换 head，天然是新 key。不新增任何“once”额度。

事件形状（`kind: "scheduler"`，与 `merge_ci_rerun`/`merge_ci_behind` 同列）：

```
data: { op: "merge_ci_wait", intentId, phase, head, class: "pending"|"missing", epoch,
        missing: [必需名…], pending: [必需名…], others: { pass, fail, pending, skipping, cancel },  // 计数
        mergeState, mode: "on"|"observe" }
```

`others` 只存计数，不存非必需项名字/链接，回执 ≤ 600 字（现有闸）。

到期（§4）再写一条 `op: "merge_ci_wait_overdue"`，dedup `…:ci_wait_overdue:<head>:<class>:<epoch>`，**只写一次**。

### 3.2 observe / on / off

新机制挂在现有唯一策略入口 `recoveryPolicy(project, key)`（`recovery-policy.ts:86`），拟用键名 `ciWait`。
**本文不注册该键**（`RECOVERY_KEYS`，`:27`）、不改 `recovery-policy.json`。

| 模式 | 行为 |
|------|------|
| off | 与今天字节级一致：驱动不发 CI_WAIT 回执，不写任何事件 |
| observe | 写 `recordObserved` 笔记（`op: recovery_observe`, `mechanism: ciWait`，actionKey = `ciwait:<intent>:<head12>:<class>:<epoch>` 与 `…:overdue`），**经 `scheduler-merge-step` 子进程**写，不由驱动直写 |
| on | 写 §3.1 的 `merge_ci_wait` / `merge_ci_wait_overdue`，到期发一条升级（§4.2） |

注意：注册键后，缺省模式是 `DEFAULT_RECOVERY_MODE = observe`（`:31`），即**所有项目默认开始写观察笔记**。这在实现单里
需要 owner 明确批准；若要求默认零写入，实现时须在项目里显式置 `off`。旧路径（W1–W7 的 `return run`）在任何模式下不变。

起点读取：取该 (intent, head, class, epoch) 下 `merge_ci_wait` 事件与对应 `recovery_observe` 笔记里**最早**的 `ts`，
所以 observe → on 切换不重置起点，重启后从台账恢复（不靠进程内存）。

### 3.3 只读展示，与真实 CLI 共存

- `ledger merge-queue`：仍走 `LedgerReader`，**只 SELECT**，不调 gh。每行加 `ciWait`：`类 / 起点 / 已等分钟 / 是否到期`，
  只认 `intentId` 与 `head = run.reviewedHead` 都匹配的最新 epoch；其余记录不显示（陈旧）。明确标注“最后一次观察，不是实时 GitHub”。
- 工作看板 `ledger-work-board.ts:78`：有当前 `merge_ci_wait` 记录时 `since` 用其起点，否则保持 `merge.updatedAt`（旧行为）；
  W1（phase=ready）有记录时也显示“等 CI”。
- 读库连接、`READER_ONLY_SUBS` 不变；展示代码不调用 `recordObserved`、不 `openLedger`。
- **不泛发 owner 告警**：升级只针对本卡 PM（§4.2）。

## 4. 期限、升级、平台重跑（验收 2、3）

### 4.1 阈值

| 类 | 阈值 | 依据 | 到期做什么 |
|----|------|------|-----------|
| `pending`（E1/E2） | 60 分钟，自本 epoch 首次观察 | 与 `TRAIN_CI_TIMEOUT_MS` 同尺：本仓已认定“单次 CI 超过 60 分钟即异常”。是**独立观察阈值**，不读、不改、不延长列车预算 | 写 overdue + 升级 |
| `missing`（E3/E3s） | 10 分钟，自首次读到“其他全部结束” | 与 `RERUN_SETTLE_MS`/`BEHIND_SETTLE_MS` 同尺：“GitHub 该动没动”。不借 UNKNOWN 的 `unknownSince` | 写 overdue + 升级 |

阈值作为实现里的常量，不进 `recovery-policy.json`、不新增配置键；改阈值另走规格。
列车 `wait`（W3）期间**不观察**：列车自己的 60 分钟 / 6 小时管；列车作废后成员回串行路径，再从头观察（新起点）。

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

在 W1/W4/W5/W6 的 `return run` 之前，若策略非 off：

```
const cls = ciWaitClass(run, pr);          // 纯函数：pending | missing | null（E0/E4/E5 → null）
if (cls) run = await step(run.phase, ciWaitReceipt(run, pr, cls));   // 同阶段观察；返回行不变 rev
if (overdue(cls, since)) run = await step(run.phase, ciWaitOverdueReceipt(...));
return run;
```

`since` 由观察写的返回值带回（台账算，不靠驱动内存）。`watchUnknown` 与 UNKNOWN 时钟不动；E4 已被改写成 UNKNOWN，
`ciWaitClass` 见 `noChecks` 直接返回 null，两套时钟永不同时跑同一次读。

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
| 退出与重进 | pending → 全绿 | 正常 `merging`；不再写 ci_wait |
| | pending → 必需红 | 走 CIF1/CIF2/bounce，原回执与额度不变；不写 overdue |
| | pending → CIF1 重跑 → 再 pending | 新 epoch、新起点；CIF1 额度仍是一次 |
| | missing → 汇总出现变 pending | 新类 `pending` 新起点；旧 `missing` 不再显示 |
| 重启恢复 | 记录后杀进程、新控制器接手 | 起点取台账最早 ts；不重复写（dedup）；overdue 只一次 |
| 陈旧 / 多 head | CIF2 合入 main 换 head；沿用审查换 head；同 head 新意图 | 旧记录不计时、不显示；新 key 从零 |
| CLI / CAS | `--rev` 过期的观察回执 | conflict，事件不写 |
| | 观察时 PM 切手动 / head 漂移 / 队列冻结 | 走现有漂移 → unknown / manualCancel，**不被 CI 解释遮住** |
| | `merge-queue` 只读读到记录 | 不写库、不调 gh；读库未迁移时不报错 |
| | 回执 head ≠ reviewedHead、检查名不在 required、类非法 | invalid |
| 策略 | off | 与基线行为、事件流逐条一致 |
| | observe | 只有 `recovery_observe` 笔记，无 `merge_ci_wait`、无 escalate |
| | 策略文件损坏 | off（带诊断），不写 |
| 不越界 | E4 noChecks | 只走 UNKNOWN 10 分钟 → unknown（原回执）；无 ci_wait |
| | E0 inspect 抛错 | 原 catch → unknown；无 ci_wait |
| | 列车 `wait` | 无 ci_wait；列车 60 分钟预算未变 |
| | `merging` 阶段重启、外部已合 / 未知 | 原核实或 unknown，不重发；无 ci_wait |
| | 平台 5xx / gh 超时（观察写之前） | 同 E0 |
| 保留门 | CIF1/CIF2 原测试、`scheduler-merge-ci-*` 全套、最终 `green()` 门 | 全部原样通过 |

## 8. 拟改文件与审批边界（验收 5）

后续实现单（另登记，估算行数，不含本文）：

| 文件 | 改动 | 估计 |
|------|------|------|
| `src/lib/recovery-policy.ts` | `RECOVERY_KEYS` 加 `ciWait` | +1 |
| `src/lib/scheduler-merge-ci-wait.ts`（新） | `ciWaitClass`、回执生成/解析、阈值常量、起点查询 | ~120 |
| `src/lib/scheduler-merge.ts` | `observeMergeState` 加 CI_WAIT 分支（漂移、CAS、校验、事件、observe 笔记） | ~25 |
| `src/lib/scheduler-merge-driver.ts` | W1/W4/W5/W6 前插观察调用 | ~15 |
| `src/manager/ledger-merge-queue-cmds.ts` | 只读 `ciWait` 列 | ~20 |
| `src/lib/ledger-work-board.ts` | `since` 取观察起点；W1 显示等 CI | ~8 |
| `tests/scheduler-merge-ci-wait*.test.ts`（新） | §7 矩阵 | ~400 |

审批点：

1. 注册 `ciWait` 键（默认 observe = 全项目开始写笔记）——owner；
2. 把任一项目切 `on`（开始写 escalate）——owner / 项目 PM 按 `scheduler-recovery` 现有权限；
3. 阈值 60 / 10 分钟——随实现规格由 PM 定；
4. 平台重跑——本设计不含，若要做须单独规格 + owner 批准。

流程边界：本卡只交设计稿，走设计提交 → 正式 CI → 独立审查。实现须另行登记卡片、文件范围与验收；
在实现合并并启用前，`ready-wait-unbounded` 仍是**未解决**状态。
