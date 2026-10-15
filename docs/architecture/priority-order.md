# 工作优先级排序（prioritySort）

PRIO1 登记的三档（`now` → `next` → `later`）在这里变成名额竞争的先后。
入口只有 `src/lib/scheduler-priority-order.ts`；各调度入口不自己比较档位。
机器放置（`localPriority`、借出 priority）不归本模块，照旧决定卡去哪台机器。

## 次序规则

对同一名额竞争的合法候选，依次比较：

1. 有效档位（显式 → 继承 feature → 系统缺省 `next`；未开卡的节点用节点自己的显式档位，没有才继承 feature）。读不到的卡按系统缺省，不会被提档。
2. owner 在同档登记的显式顺序（`priority_orders`，按 queue，缺省 `project`）：列出的在前、按登记次序。
3. 调用方原有次序：finish-first、merge-first、轮转、eventSeq、更新时间等全部保留。

排序是稳定的：只有档位或 owner 显式顺序不同才会挪动，同档内与旧实现完全一致。

## 开关

`prioritySort` 按项目登记，缺省 `observe`：

| 模式 | 实际执行 | 记录 |
| --- | --- | --- |
| off | 调用方原列表原样返回；不读档位 | 不写 |
| observe | 原列表（`applied === legacy`），预算游标、名额、列车都照旧 | 写新旧次序样本 |
| on | 新次序 | 写样本（审计） |

一个列表里混有多个项目时，只有 on 项目的卡在它们自己占的位置之间重排，
off / observe 项目的卡原位不动。

样本是项目级 `note` 事件，`data.op=priority-sort-sample`，含入口名、候选的档位/来源/版本/显式位置、
旧次序、新次序、认领结果（旧认领 / 本会认领 / 卡点）及合并竞争结论。去重键是这些内容的哈希：
重复 tick 不刷记录；候选、档位版本或结果变了才新记一条。多个入口共用一个列表时（auto tick 里作者派单与审查派单争同一批名额），
样本记整张共享列表的新旧次序（跨入口的翻转也看得到），入口名标出列表里出现的入口（如 `author+review`），每张候选另带自己的 `entry`。每个入口第一次真实竞争（两张及以上候选）必记一条，
供 PM 确认入口都覆盖；之后只记新旧有差异的。只有一张候选的列表不记。

排序与认领本身从不写台账（调度整轮用只读句柄，`manualTurn`、开卡挑选都是纯读）：样本先进进程内缓冲，
auto tick 之后由 `flushPrioritySamples(manager)` 经调度身份的 `ledger scheduler-priority-sample --project P --dedup K --data JSON`
（只认 scheduler 身份，同一 dedup 只记一次）写出，每轮最多 20 条，超出丢最旧的并打一行日志。写失败只打日志，不影响调度。

## API

- `sortByPriority(db, entry, items, keyOf, opts)`：在读到竞争列表的地方调用，用返回的 `applied` 代替原列表。
  `opts.pinned` 标出运行中 / 已上车 / 已提交的工作：原位不动、不被抢占。
- `claimFirst(db, entry, items, keyOf, gate, opts)`：实际认领前调用。现读档位与开关，
  按次序找第一张 `gate` 放行的卡（`gate` 就是现有依赖、锁、容量、权限、审查闸的判断，返回 null 放行）。
  排在前面被挡住的高档卡记为卡点，名额给下一张合法卡；不会越过任何闸门。
- `liftWithinBand(result, item)`：既有提升（预算补偿欠的卡、公平队首）的替代。
  on 项目的卡只在 owner 排序（档位 + 同档显式顺序）分不出先后的范围内提前：不越过更高档的卡，
  也不越过 owner 在同档显式排在它前面的卡；off / observe 照旧直接提到队首。
- `mergeContest(db, project, manualTaskId, autoTaskIds | () => ids)`：人工队首与自动候选争合并槽。
  先比档位，同档再比 owner 显式顺序；两者都分不出先后才返回 `tie`，交回现有人工/自动公平规则（owedToAuto、eventSeq）。
  observe 下 `winner` 恒为 `tie`，`would` 记本会的结论。`contestOwed` 把结论接到 `manualTurn` 的 owed 判断上。
- `slotOrder(db, cards)`：auto tick 的卡列表（作者派单与审查派单同一列表，一份样本记整张列表，候选按所在阶段标 `author` / `review`），
  并记下各 on/observe 项目尚未推进的卡次序，供认领前重读。
- `claimSlot(db, "local_slot" | "lend_slot", task, { policy })`：`drivePool` 调 `ledger scheduler-pool` 之前重读本卡与本轮排在它后面的卡的档位
  和资格（现读任务：不在了、done / cancelled / blocked、已有在途意图，或按同一名额策略跑规划器得到 wait / escalate——依赖、锁、容量、权限、
  审查闸——都算不合法，记为卡点）。后面合法的卡现在排到前面了，on 返回 held 记卡点、本轮让出；observe 只记「本会让出」照旧认领；
  off 只读开关不读档位。排在前面但已不合法的卡不会让本卡让出。
- `autostartNodes(db, project, features, nodesOf)`：开卡挑选的候选。off 按旧次序（feature → 车道）惰性展开；observe / on 把项目内所有
  可开工节点摊平，按各节点的有效档位（节点显式 → feature）与 owner 顺序排，`nodesOf` 里照旧做 feature 闸门。

入口名：`author`、`review`、`local_slot`、`lend_slot`、`autostart`、`manual_merge`、`merge_contest`、`train_boarding`。

## 不做的事

- 不抢占已运行 worker，不撤销已提交的合并，不拆正在组装 / 跑 CI 的列车；调档只影响尚未认领的候选与下一班车。
- 恢复、结果对账、必须完成的收尾不进新派单名额竞争，继续走现有保底份额。
- scheduler 不会自动升档；低档长期等待由 PM 看样本后找 owner。

## 接线（PM 精准例外，每处一行调用或包一层）

| 文件 | 位置 | 调用 |
| --- | --- | --- |
| `src/lib/scheduler-auto-tick.ts` | `schedulerAutoTick`：`mergeFirst(...)` 外包一层；预算补偿的提升与单卡名额 | `slotOrder(db, …)`、`liftWithinBand(sorted, fair)` |
| `src/lib/scheduler-pool-tick.ts` | `drivePool`：`ledger scheduler-pool` 之前（不排序） | `claimSlot(db, …, { policy })` |
| `src/lib/scheduler-autostart-run.ts` | `pickCandidate`：项目内可开工节点（卡未开，按节点有效档位） | `autostartNodes(db, …)` |
| `src/lib/manual-merge-queue.ts` | `manualTurn`：`queued`；`owedToAuto` 之前 | `sortByPriority(db, "manual_merge", …)`、`contestOwed(mergeContest(…), …)` |
| `src/lib/scheduler-merge-train-tick.ts` | 组新车的候选（在途列车不经过这里） | `sortByPriority(db, "train_boarding", …)` |
| `src/lib/scheduler-pass.ts` | auto tick 之后 | `flushPrioritySamples(manager)` |

写口登记：`src/manager/ledger-scheduler-recovery-cmds.ts`（`...priorityOrderCmds`）、`shared-ledger-gate-cli-services.ts`（调度身份白名单）、
`scheduler-v2-skip-paths.ts`（`SKIP_LEDGER_COMMANDS` 与 `SCHEDULER_PASS_PATHS`）、`scheduler-v2-ledger-cmds-args.ts`、`scheduler-v2-skip-effects.ts`。

## 上线

先保持 observe，PM 核一轮真实派单、派审、合并样本（`data.op=priority-sort-sample`，按 `entry` 分组）
确认三类入口都有样本、差异原因可解释后，再按 owner 新原话 `priority-mode prioritySort --mode on`。
