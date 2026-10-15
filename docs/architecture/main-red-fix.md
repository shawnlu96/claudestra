# main / Nightly red → scheduler (agents-MAINRED1)

main 上 CI（`ci.yml` 的 push run）或 Nightly（`nightly.yml`）红了，不再等 PM 看日志、写卡、绑定：调度器自己发现，已知偶发先重跑一次，
其余写一个修复节点和一份正式规格交自动开卡；本机制写的修复卡到 merge 时还能自动拿主线 CI 修复绑定。Nightly 只是被读，从不进合并闸、
不改 requiredChecks；不自动 revert；一个故障一张卡，不跨项目。

## 开关（recovery-policy.json，`ledger scheduler-recovery <p> <mode> --key <键>`）

| 键 | off | observe | on |
| --- | --- | --- | --- |
| `mainRedFix` | 不读 gh、不写任何东西 | 读与判定照做，按 main SHA + workflow 记一条「本会重跑 / 本会写修复节点 <feature>/<键>」，不重跑不写 | 重跑、写节点与规格 |
| `mainRedRepairBind`（权限类） | 不绑 | 只记「本会绑定」，绑定仍由 PM 手做 | 为本机制写的卡写修复绑定 |

两个键都在 OBSGATE1 前缺省 observe，由规格「## 上线后 PM」的自动转正行交 OBSAUTO1 转正。`mainRedRepairBind` 进高风险分类
（`recovery-key-class.ts`）按「谁后合并谁加」处理。

## 流程

1. **发现**（`main-red-fix-tick.ts`，autostart tick 的 pmWakeTicks 之一）：每个项目每 10 分钟最多读一次，不看有没有合并意图。
   每个 workflow 读 main 上最近 20 个 run（`main-red-fix-gh.ts`，结构化 argv、30 秒超时），取最新一个**已完成且结论 success / failure**
   的 run：还在跑、cancelled、skipped 跳过；它是 success 就没有红（被后续绿 run 覆盖的红不算）。同一 run 按 run id + attempt 只处理一次
   （台账事件 `main-red-fix:handled:<project>:<run>:<attempt>`）。
2. **先重跑已知偶发**：失败日志按 `ci-failure-class.ts` 归类（没有 PR，改动集为空）；环境故障，或失败测试文件全在有效的已知偶发清单
   （`ci-known-flaky.ts`）里 → 台账先占这个 run 唯一一次重跑（`main-red-fix:rerun:<project>:<run>`），再 `gh run rerun --failed`。
   新 attempt 绿 → 记一条 pm-todo，不写节点；仍红 → 按非偶发写节点，不再重跑。重跑命令本身失败 → 记 pm-todo，当轮按非偶发写。
   日志超长（被截断）一律不算偶发。
3. **写修复节点 + 正式规格**（`ledger scheduler-main-red-fix --op fix`，一个事务）：
   - 归属：push 红 → 第一个变红的 main 提交（从红 run 往回到上一个 success）合进来的 PR → 台账里 `pr` 指向它的卡所在 feature；
     查不到、feature 不是 active / 没 DAG / 有待批改版，或是 Nightly 红 → 兜底 feature（缺省 `merge-arch`）。
   - 键：责任卡键 + `R` + 序号（键不是纯大写字母数字时用 `CIRED`），Nightly 用 `NIGHTLY` + 序号；跳过已有节点、已占卡号、已有规格文件；
     卡号过 `cardIdGate`。
   - 范围：失败测试文件 + 责任卡节点的 globs；两者没交集时只给失败测试文件；一个失败测试文件都没有 → 不写，记 pm-todo。
   - 规格写到 `<ledger>/docs/tasks/<卡号>.md`（自动开卡的正式路径，静置 60 秒后接走），过 spec-lint（`lintObservation`、`lintUiSpec`、
     卡首模板 code）和 dag-write-scrub 的同一文本检查（本地路径 / 主机名 / 敏感串；main SHA 是该仓库的提交）；日志片段经
     `scheduler-merge-ci-log-cut.ts` 截取、绝对路径只留相对尾巴、逐行 `quoteExternal`。过不了不写，记 pm-todo。
   - 节点经 `composeRewrite` / `rewriteDag` 写入（review-converge-followup.ts 的写法：feature PM 代记，dedup 按 run）；规格文件随后写，
     写失败整个事务回滚。
   - 跳过：PM 已为同一 faultKey 绑定修复卡；同一 workflow 已有本机制写的、未 verified 的节点且失败 check 集合相同 → 不写，原卡记一条 note。
   - 作者家族：现有派单没有按卡指定家族的口子，照常由派单选。
4. **修复绑定**（`--op bind`）：本机制写的卡到 merge、main 读出的 faultKey 与写节点时记下的相同 → on 档写一条与 `ledger main-ci-repair`
   同格式的绑定（feature PM 代记，事件带 `source=mainRedFix, by=scheduler`），`ledger main-ci-repair <卡> --revoke` 照样撤销；撤销过的卡
   不再自动绑。不是本机制写的卡一律拒。
5. **结论改拉取**：重跑结果、写了哪个节点、为什么没写都只经 `recordPmTodo`（kind `main_red_fix`）进 `ledger pm-todo`；只有「兜底 feature
   也写不进」和「同一故障修复卡已失败 2 次」（同 workflow、同失败集合的本机制节点已取消 / 已 verified 仍复发）推一条 action 级通知。

## 写口与接线

- 唯一写口 `ledger scheduler-main-red-fix <project> --op observe|rerun-claim|rerun-result|fix|bind --facts <JSON>`（`main-red-fix-cmds.ts`）：
  只给有租约的调度身份、项目在自动调度里；manager/ledger.ts 展开命令表并把 `MAIN_RED_FIX_SERVICE` 并进调度身份白名单（同 PMAUTO1）。
- tick 只读（调度连接 query_only），写都经 env.ledger；读写共用 `main-red-fix-place.ts` 的放置判断，observe 预览与 on 写入同一答案。
- 自动绑定的台账写口：`scheduler-main-ci-wiring-write.ts` 的 `recordMainRedRepair`（只收 `source=mainRedFix`、调度身份）。

## 与现有路径共存

mainCiPause、ROLLBACK1 回执、PM 手动 `main-ci-repair` / revert、`stage` / `workflow-resume` / `manual-merge-request` 都照旧；本机制写的卡
与普通自动开卡的卡同路。

测试：`tests/main-red-fix.test.ts`（纯函数、gh 端口）、`tests/main-red-fix-tick.test.ts`（假 gh + 合成台账 + 临时 docs + 假时钟，端到端）。
