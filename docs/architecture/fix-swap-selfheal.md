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

只接在远端换家族路径（`localAfterReclaim` 给 lifecycle 的 `authorTree` 包一层端口）；本机换家族路径 `fix-strategy-runtime.ts` 不在本卡范围，行为不变。

## 9b 续用已证明的前次收回

无 held 租约时，全部成立才返回 null 继续 `localAfterReclaim()`：

1. 租约行是 ended，且是同卡、同规格、同轮、同 head 的正式前次 `fix_strategy_reclaim`（它自己的 `scheduler:<前次意图>:reclaim` 去重键）的投影（peer、reason 一致）；
2. 前次意图是 cancelled，且没绑替换作者（无 `replacement` 事件、无它建的会话行）；
3. 没有 pooled / claimed / unknown 写单；
4. 远端分支 head 仍是卡 head（唯一的 await）。

await 之后在一个事务里重读授权、租约与以上全部事实（以及 fixLocalSwap 的 lapse），再调用 `retireReclaimedPeerAuthor()` 退役旧 peer 作者。不写本意图的 reclaim 事件，不碰 CONV reborrow 的证明白名单。

## 2 半建会话自动收拾重建

`createConvergenceWorker` 在 creating 超过 `CLAIM_LEASE_MS` 仍无 session id、要判 unknown 之前调用 `healHalfBuilt`：仅 fix_swap 作者、auto 卡；registry 该名字仍无 sessionId；窗口不在，或每个 pane 都是没有子进程的裸 shell（`worker-liveness.ts` 的严格 tmux / ps 读）。然后 `manager kill`（runManager，create-guard 清占位与窗口），确认 registry 已无该名字，意图结清为 cancelled（回执「半建会话已清理」）。规划器重新规划的换家族在建会话入口按 `createRetryDelay` 等退避（2 → 4 → 8 → 15 分钟）。同卡作者连续第 3 次半建、tmux 读不到、窗口有别的进程、registry 有 sessionId，一律照旧 unknown。

## 测试

`tests/lend-reclaim-scheduler.test.ts`（9b）、`tests/fix-strategy-worktree-foreign.test.ts`（9a）、`tests/fix-tree-proof.test.ts`、`tests/fix-swap-halfbuilt.test.ts`（2）。
