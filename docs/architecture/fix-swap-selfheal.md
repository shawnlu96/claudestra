# 换家族修复自愈（SWAPFIX1）

换家族修复（CONV2 other_family、GATESWAP1 fixLocalSwap）在执行层有三个断点，以前一律交 PM。本卡只在这三处加「先自救、拿不准照旧」，收敛审查、换家族的触发与规划不变；卡是 manual 时不自愈。

| 断点 | 恢复键 | 自愈动作 | 代码 |
|---|---|---|---|
| 9a 目标目录是另一位旧本机作者留下的干净树 | `fixLocalSwap` | 收回旧树，原样交给新作者 | `src/lib/fix-tree-proof.ts`、`src/lib/fix-strategy-worktree.ts`（`ForeignTreePort`）、`src/lib/fix-strategy-remote.ts`（`withForeignTree`） |
| 9b 写租约已被前一轮正规收回（ended） | `lendReclaimIntent` | 续用前次收回，不再收回第二次 | `src/lib/lend-reclaim-scheduler.ts`（`priorReclaim` / `resumeAfterReclaim`） |
| 2 作者会话只建一半（create 被 90 秒预算 kill） | `authorRebuild` | 经 manager kill 清掉半建窗口与占位，意图 cancelled，按退避重新规划 | `src/lib/fix-swap-halfbuilt.ts`，`src/lib/fix-strategy-lifecycle.ts` 两处调用 |

## 档位

不新增键，各自沿用现有档位（缺省 observe）：

- off：行为与改前逐字一致（9b 的错误文字也不变）。
- observe：只经 `recordObserved` 记一条 `recovery_observe`（「本会收回旧树 / 本会续用前次收回 / 本会清理重建」），然后照旧拒绝 / unknown。
- on：执行，并记一条同名 `fix_swap_selfheal` 台账 note（样本口）。

两类记录都按卡 + head + 动作去重（半建按第几次区分）；实现在 `src/lib/fix-swap-halfbuilt-sample.ts`。

## 9a 干净旧树收回

GATESWAP1 的 `treeRefusal` / `treeProofSync` 与本处共用 `fix-tree-proof.ts` 的同一判定（一个 git 询问生成器，分别以 await / 同步驱动，步骤与文字逐字相同）：树干净（调用方的完整脏检查）、HEAD 是已审修复 head、来源仓库的本地卡分支不在别的提交上。`foreignTreeRefusal` 在它之上再要求：不是软链、是来源仓库的 linked worktree、在本卡分支上、registry 里没有未 stopped 的会话以它为 cwd。全部成立才接手（不删除、不 reset，隔离 / 复核仍走原 `ready`）；任一不成立照旧 tree-refused 交 PM。

本机换家族（`fix-strategy-runtime.ts` `fixSwapStep`，PM 补的一处调用例外）与远端换家族（`localAfterReclaim`）共用 `withForeignTree`：给 lifecycle 的 `authorTree` 包一层端口，并返回一个门。接手的许可在三处读：`foreignTreeRefusal` 证明时；`ready()` 的 origin / 隔离 await 之后、交出目录之前同步再读一次（恢复键仍 on、registry 里没有别的活会话以它为 cwd），通过才记 on 样本；之后 create 与 bind 边缘经返回的门再同步读一次（排除本意图自己的作者名）。off 时端口不接手、门只是原来的门，行为逐字不变。

## 9b 续用已证明的前次收回

无 held 租约时，全部成立才返回 null 继续 `localAfterReclaim()`：

1. 租约行是 ended，且是同卡、同规格、同轮、同 head 的正式前次 `fix_strategy_reclaim`（它自己的 `scheduler:<前次意图>:reclaim` 去重键）的投影（peer、reason 一致）；
2. 前次意图是 cancelled，且没绑替换作者（无 `replacement` 事件、无它建的会话行）；
3. 没有 pooled / claimed / unknown 写单；
4. 远端分支 head 仍是卡 head（唯一的 await）。

await 之后在一个事务里重读恢复键（off 照旧原文拒绝；observe 只记观察后拒绝）、授权、租约与以上全部事实（以及 fixLocalSwap 的 lapse），再调用 `retireReclaimedPeerAuthor()` 退役旧 peer 作者。不写本意图的 reclaim 事件，不碰 CONV reborrow 的证明白名单。

续用之后建树、等 codex 槽、create 还有 await：`resumedReclaimGate` 作为 `localAfterReclaim` 的 label.gate，在 create 边缘（lifecycle 的 create 闸）与 bind 之前同步重读恢复键为 on 与上面第 1–3 条（含出现新的 pooled / claimed / unknown 写单、租约又被持有），任一不成立就等待，不建、不绑。

## 2 半建会话自动收拾重建

`createConvergenceWorker` 在 creating 超过 `CLAIM_LEASE_MS` 仍无 session id、要判 unknown 之前调用 `healHalfBuilt`：仅 fix_swap 作者、auto 卡；registry 该名字仍无 sessionId；窗口不在，或每个 pane 都是没有子进程的裸 shell（`worker-liveness.ts` 的严格 tmux / ps 读）。然后 `manager kill`（runManager，create-guard 清占位与窗口），确认 registry 已无该名字，意图结清为 cancelled（回执「半建会话已清理」）。tmux / ps 读取之后，kill 之前和结清之前各同步重读一次完整许可（auto 卡、authorRebuild 仍 on、意图仍 submitted 且卡未变、creating 认领仍是这个名字、registry 仍无 session id）；kill 按名字、没有 session，manager 子进程没有 `--fix-stop` 那样可带的会话授权，所以许可在派出子进程前同步读、子进程回来后再读，后读不成立就不结清（照旧 unknown）。kill 回「<名字> 不存在」（runKill 只在 registry 与窗口都没有时这样答）且 registry 无该名字，视同清理完成。规划器重新规划的换家族在建会话入口按 `createRetryDelay` 等退避（2 → 4 → 8 → 15 分钟）。同卡作者连续第 3 次半建、tmux 读不到、窗口有别的进程、registry 有 sessionId，一律照旧 unknown。

## 测试

`tests/lend-reclaim-scheduler.test.ts`（9b）、`tests/fix-strategy-worktree-foreign.test.ts`（9a）、`tests/fix-tree-proof.test.ts`、`tests/fix-swap-halfbuilt.test.ts`（2）。
