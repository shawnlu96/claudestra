# 观察期登记与到期自动核对（agents-PMAUTO1）

机制上线后通常先在 `observe` 跑一段，再由 PM 人工核对、人工切 `on`。PM 为此自己挂定时器、到点被叫醒去翻台账。这里把「到期按声明核对、全满足就转正」做进系统：PM 明确登记一次，之后调度服务到期自己核，过了切、没过才叫 PM。

没有登记就什么都不会自动切。规格里写了「观察期：N 小时」不等于登记；PVDEFER1 的提醒算法（`scheduler-post-verify-defer.ts`）一行没动。

## 开关

`autostart.autoMode`，项目级，缺省 `observe`，和别的 autostart 三档开关同一处读写：`ledger autostart-set on|off --auto-mode on|observe|off --reason …`。

| 档 | 到期时 |
| --- | --- |
| off | 不读登记、不调台账、不写、不发 |
| observe | 在卡上记一条 note：`本会转正` 或 `本会交 PM 判断：<原因>`；不切、不通知；每条登记只记一次 |
| on | 全满足 → 只把登记的那个目标切 `on`，卡上记一条 note，PM 收一行摘要；否则交 PM 一次 |

本机制不给自己转正：`autostart:autoMode`、`autostart:p2BacklogMode` 拒登记。

## 登记

```
ledger observation-register <卡> --target recovery:<恢复键>|autostart:<字段> --project <id> \
  --rule v1 --source ledger-events [--hours <1–168>] [--start <毫秒|ISO>] --reason <为什么>
```

- 谁能登记：有权改该项目调度开关的人（项目 PM，调度助理除外 / master / owner）。登记就是这个人对这一次转正的授权。
- 目标白名单：项目级恢复单键（`manualStall` 除外）；autostart 的 `specWait` / `mergePmWait` / `reviewPmWait` / `postVerifyDefer` / `wipGate`。整机键、`manualStallHours`、额度线、阈值、总开关是 owner 的，拒登记。
- 时长：`--hours`，不给就取规格 `## 上线后 PM` 第一行的「观察期：N 小时」；两者走同一个解析（`parseObservation`），超过 168 按 168。
- 起点：缺省该卡最近一次进 `verified`。不倒填：不早于这次 verified，也不早于目标本次进 observe 的时间。
- 目标此刻必须是 `observe`；同一项目同一目标只留一条有效登记。重新上线或改规则：`observation-cancel` 后重新登记。
- 登记绑定五样东西：规格版本（`specRev`）、verified 时间、目标所在的 observe 世代（最近一次改变其生效模式且没作废的审计事件 seq，0 = 一直是缺省）、目标的配置版本（`configRev`）、登记人。
- 配置版本按目标取：最近一次动过它配置原值且没作废的审计 seq（恢复键 = 该键的覆盖值或项目模式；autostart = 该字段）。有人把同一目标显式写成 `observe`，生效模式和世代都没变，配置版本也会变。恢复策略文件里的 `rev` 是整个项目一个数，别的键、别的登记转正都会抬它，拿它绑会让同项目的登记互相作废，所以不用它。没有 `configRev` 的旧登记到期不转正，要重新登记。

登记落状态目录 `observation-plans.json`（`file-lock` + 原子写）。`recovery-policy.json` 的严格格式不动，模式真源仍是恢复策略文件和 autostart meta。每个动作在卡上留一条 `decision`（`op: observation_plan`）。

其它命令（同样要 PM / master / owner）：

| 命令 | 作用 |
| --- | --- |
| `observation-cancel <登记号> --reason` | 撤掉自动转正 |
| `observation-mark <登记号> --misjudged <观察记录号> --reason` | 标一条观察记录为人工误判；持久在登记文件里，重启不丢 |
| `observation-unmark <登记号> --misjudged <观察记录号> --reason` | 清误判标记，单独一条命令、单独一条审计 |
| `observation-recheck <登记号> --reason` | 把已交 PM 判断的登记放回再核一次 |
| `observation-plans [--project] [--all]` | 只读列表 |
| `observation-due <卡> <登记号> [--sent]` | 到期核对；调度服务每轮调，PM 也可手动调 |

## 核对口径（v1）

只读台账里的结构化事件，由代码里的适配器白名单决定读什么；不执行规格里的任何命令，不搜文本日志。四条全满足才算过：

1. 窗口 `[起点, 起点 + N 小时]` 内本项目该机制的观察记录 > 0；
2. 窗口内该机制的结构化错误 = 0；
3. 没清掉的人工误判标记 = 0；
4. 证据可读、窗口已走完，且该机制有适配器。

机制没有适配器 = 不可核，到期交 PM。日志里搜不到 error 不是「无错误」的证明。

### 首批适配器名单与依据

配适配器的条件：observe 档的观察记录落成台账结构化事件，**并且**有结构化的错误来源。逐个核过的结果：

| 机制 | observe 档的记录 | 结构化错误来源 | 适配器 |
| --- | --- | --- | --- |
| `dagWriteScrub` | DAG 写入事件的 `data.dagWriteScrub`（`dag-write-scrub.ts`） | `op: converge_dag_scrub` 的 note（`review-converge-followup.ts`） | 有 |
| `nearMarker` | `op: review_near_marker`、`data.mode: observe` | 无（读开关失败只打 console） | 无 |
| `ciKnownFlaky` | `op: merge_ci_known_flaky_observe` | 无（失败只打 console） | 无 |
| `auditTrainQueue` | 无事件，只在巡检条目正文后缀里 | 无 | 无 |
| `auditIdleFacts` | 无事件，只在巡检条目正文后缀里 | 无 | 无 |
| `auditMirrorPush` | 无事件，只进巡检结果的 `skipped` | 无 | 无 |
| `auditEscalate` | 无事件，bridge 只打 console | 无 | 无 |
| `postVerifyDefer` | 无；说明只是通知正文后缀，`post_verify` 事件的 `mode` 是 specWait 的 | 无 | 无 |

所以首版只有 `recovery:dagWriteScrub` 能自动转正；其余可以登记，但到期一律交 PM（和现在一样人工核）。autostart 字段目前没有一个够条件，那条路径只由测试里注入的适配器覆盖。给某个机制补上结构化的观察事件和错误事件之后，在 `observation-plan-evidence.ts` 的 `ADAPTERS` 里加一项即可。

## 到期

调度 tick（`pmWakeTicks` 的最后一项，`observation-plan-tick.ts`）按登记文件的只读快照预筛，对到期的登记经调度身份调 `ledger observation-due`。规格原文写的是在 `scheduler-pass.ts` 加一行；实际挂在 `pmWakeTicks`，因为同类的上线后提醒就在这个数组里，autostart 的 tick 已经逐项跑它，改动最小（PM 已同意）。

`observation-due` 全程拿着登记文件的锁，所以先到的人工撤销 / 标误判它一定看得见。锁内重核，任何一条不满足都不转正：

- 登记人此刻仍有该项目的配置权；
- 规格版本没变、该卡没有重新 verified、口径版本没变；
- 目标仍是 `observe`，且还在登记时那一个世代（中途切过 off 再切回来也算变了）；
- 目标的配置版本和登记时一样。

然后按四条口径判。不满足 / 证据缺 / 配置变了：登记转 `judged`，给 PM 发一条带证据的 `[观察期核对] …`，只发一次；没送达的下一轮原文重发，不重核、不重试切换。

### 切模式与回执

切模式和卡上的 note 不是一笔事务，登记里存执行回执：

1. `prepared` 先落盘；
2. 经原 writer 切：恢复键走 `setRecovery`（它自己的锁、审计、`published` / `void` 对账），autostart 字段走 `setAutostartSwitch`（台账事务）。两者都带 dedupKey `observation-promote:<登记号>:<次数>`；
3. 切成 → `published`（记审计 seq）→ 卡上记 `op: observation_promote` 的 note（窗口、样本、规则、旧新模式、证据引用）→ `noted`，登记转 `promoted`。

动手前的最后一道核对在目标 writer 自己的锁 / 事务里（恢复键：策略文件的锁加台账事务；autostart：台账事务），它写任何东西之前跑：

- 上面那组重核再跑一遍（等锁期间人工切了 off、配置被写了一版、换了授权，都在这里挡住）；
- 项目的 `autoMode` 必须仍是 `on`。等锁期间被改成 off / observe：不切、不交 PM，登记原样留着，再开 on 时从头核；
- 登记文件的锁必须仍是本次执行的。失租（进程停太久被回收，别人可能已经标了误判或撤销）：立刻停，什么都不写，下一轮在新锁里按落盘的状态重来。

中途崩了，重启按回执和原 writer 的审计对账，不凭登记人此刻的权限：

| 落盘的回执 | 原 writer 留下的 | 处理 |
| --- | --- | --- |
| `published` | — | 只补 note |
| `prepared` | 没有带这个 dedupKey 的审计 | 没切过，从头再核 |
| `prepared`，autostart | 审计在（和改值同一个事务） | 已切，只补 note |
| `prepared`，恢复键 | `published` 记录在，或文件里该项目的 `rev` 就是这条审计 | 已切，只补 note；不重入 writer，换了 PM 也照补 |
| `prepared`，恢复键 | `void` 记录在 | 没生效，不记成功，带 `failed` 回执交 PM |
| `prepared`，恢复键 | 两样都没有，文件 `rev` 也不是它 | 发没发布还没核定：重入原 writer 让它在自己的锁里核定，这一步照常要登记人的授权 |

不会切第二次。切失败不记成功：登记带 `failed` 回执转 `judged` 交 PM，模式原样；PM 处理后 `observation-recheck` 放回。

### 权限

调度身份没有任何改模式的权限（它能调的只有 `observation-due` 这个入口）。两个 writer 都以**登记人**的身份调，由它们各自在锁 / 事务里重核这个人此刻的配置权。`setRecovery` 多了一个可注入的 `opts.authorize`（缺省就是原来的 `actorMayConfigure`）：到期核对用它把「目标仍在同一 observe 世代」放进恢复策略文件的锁和台账事务里再核一遍，所以等锁期间人工切的 off 不会被覆盖。

autostart 的关着的项目有个细节：`setAutostartSwitch` 会把「谁、何时、为何关」重盖成本次调用；转正只该动一个字段，所以同一事务里把原来的关停记录放回去。

## PM 路由

PMROUTE1 的四类口径不变：转正成功的一行 `[观察期转正] …` 按完整模板归 digest（规则 `observation.promoted`）；核对失败的 `[观察期核对] …` 没有规则，照旧 judge。没有新的 owner 直发。

## 调度可达文件登记

- `scheduler-v2-skip-effects.ts`：`observation-plan-tick.ts` 归 manager（`ledger=2`）；`observation-plan.ts` 归 writer（`fs=1`，只有锁内建目录）。通知复用 `scheduler-spec-wait.ts` 的 `sendToPm`，没有新的通知点。
- `scheduler-v2-skip-paths.ts`：`SKIP_LEDGER_COMMANDS` 加 `"observation-due": "task"`（第一个参数是卡号）。

## 命令入口

`manager/ledger-observation-wiring.ts` 把本卡两组命令合成 `PMAUTO_CMDS`，`manager/ledger.ts` 展开进命令表。调度服务身份只多两条：`observation-due` 和 `p2-backlog-record`（`PMAUTO_SERVICE`，命令里都要调度租约）；登记、撤销、标误判、清标记、放回重核不在名单里，调度身份调不到。`observation-plans`、`p2-backlog` 在 `write-commands.ts` 里按读算。`tests/p2-backlog-entry.test.ts` 走真实的 `runLedger`。

## 上线顺序

本卡自己不转正。先留 `autoMode observe`，核几条到期登记在卡上的预演 note，再人工开 `on`。`tests/observation-plan.test.ts`。
