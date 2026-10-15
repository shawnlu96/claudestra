# 工作优先级排序（prioritySort）

PRIO1 登记的三档（`now` → `next` → `later`）在这里变成名额竞争的先后。
入口只有 `src/lib/scheduler-priority-order.ts`；各调度入口不自己比较档位。
机器放置（`localPriority`、借出 priority）不归本模块，照旧决定卡去哪台机器。

## 次序规则

对同一名额竞争的合法候选，依次比较：

1. 有效档位（显式 → 继承 feature → 系统缺省 `next`）。读不到的卡按系统缺省，不会被提档。
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
重复 tick 不刷记录；候选、档位版本或结果变了才新记一条。写失败只打日志，不影响调度。

## API

- `sortByPriority(db, entry, items, keyOf, opts)`：在读到竞争列表的地方调用，用返回的 `applied` 代替原列表。
  `opts.pinned` 标出运行中 / 已上车 / 已提交的工作：原位不动、不被抢占。
- `claimFirst(db, entry, items, keyOf, gate, opts)`：实际认领前调用。现读档位与开关，
  按次序找第一张 `gate` 放行的卡（`gate` 就是现有依赖、锁、容量、权限、审查闸的判断，返回 null 放行）。
  排在前面被挡住的高档卡记为卡点，名额给下一张合法卡；不会越过任何闸门。
- `liftWithinBand(result, item)`：既有提升（预算补偿欠的卡、公平队首）的替代。
  on 项目的卡只提到同档最前，不越过更高档的合法卡；off / observe 照旧直接提到队首。
- `mergeContest(db, project, manualTaskId, autoTaskIds)`：人工队首与自动候选争合并槽。
  只有严格更高档才定胜负；同档返回 `tie`，交回现有人工/自动公平规则（owedToAuto、eventSeq）。
  observe 下 `winner` 恒为 `tie`，`would` 记本会的结论。

入口名：`author`、`review`、`local_slot`、`lend_slot`、`autostart`、`manual_merge`、`merge_contest`、`train_boarding`。

## 不做的事

- 不抢占已运行 worker，不撤销已提交的合并，不拆正在组装 / 跑 CI 的列车；调档只影响尚未认领的候选与下一班车。
- 恢复、结果对账、必须完成的收尾不进新派单名额竞争，继续走现有保底份额。
- scheduler 不会自动升档；低档长期等待由 PM 看样本后找 owner。

## 接线（每处一行调用，待 PM 精准例外）

本单 globs 只含新模块、测试与本文档。以下接线点需 PM 逐项登记精准例外后各加一行，不整文件重排：

| 文件 | 函数 | 调用 |
| --- | --- | --- |
| `src/lib/scheduler-auto-tick.ts` | `schedulerAutoTick`：`ordered = mergeFirst(...)` 之后；`fair` 提升改走 `liftWithinBand` | `sortByPriority(db, "author", ordered, (c) => ({ project: c.project, taskId: c.taskId }))` |
| `src/lib/scheduler-autostart-run.ts` | 自动开工候选列表读出处 | `sortByPriority(db, "autostart", …)` |
| `src/lib/scheduler-pool-tick.ts` / 本机名额入口 | 名额认领前 | `claimFirst(db, "local_slot" / "lend_slot", …)` |
| `src/lib/manual-merge-queue.ts` | `manualTurn`：`queued` 取队首前；`owedToAuto` 之前 | `sortByPriority(db, "manual_merge", queued, …)`、`mergeContest(...)` |
| `src/lib/scheduler-merge-train-tick.ts` | `trainCandidates` 返回值交给 `formTrain` 前 | `sortByPriority(db, "train_boarding", cands, …)` |

审查派单（`review`）与作者派单共用 auto tick 的卡列表；按 `plan.action` 区分入口名时同样一行。

## 上线

先保持 observe，PM 核一轮真实派单、派审、合并样本（`data.op=priority-sort-sample`，按 `entry` 分组）
确认三类入口都有样本、差异原因可解释后，再按 owner 新原话 `priority-mode prioritySort --mode on`。
