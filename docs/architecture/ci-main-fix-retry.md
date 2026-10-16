# PR CI 红、失败测试与改动无关（merge-arch-CIUNREL1）

起因：PR1593（10-15 23:32）和 PR1598（10-16 00:00）在人工合并队列里因为 CI 红被退回 fix。两次失败的测试都不在 PR 改动的文件里，最后都是 PM 手动处理的：PR1593 重跑了失败的 job；PR1598 做了 update-branch、main-carry、补登审查、重新排队。

## 1. 超时日志解析（`scheduler-merge-ci-rerun-log.ts`）

PR1593 的真实日志（run 38745600454 的 attempt 1，shard 7）解析不出来，有两个原因：

- 超时用例被 bun 放弃以后，它挂着的 promise 过了一会儿才 reject，于是同一个测试文件的分组里多出一段 `# Unhandled error between tests`，bun 的汇总也多出 ` 1 error`。现在只在下面几种情况都成立时，把这段算到那条超时用例名下（`CiFailure.strays`）：这段在文件分组内；同组前面已经有一条超时的 `(fail)`；这段以分隔线收尾；里面每一帧栈（至少一帧）都在这个测试文件里。另外，汇总的 `N error` 必须正好等于这样归属的段数。其余情况照旧不可解析：前面没有超时、有一帧在别的文件、这段被截断、错误总数对不上。
- gh 现在把每一步都打成 `UNKNOWN STEP`，整 run 日志里的 gate job（`typecheck + test + guard`）读出来是整个 job，原先按步骤名识别 gate 判定的办法失效。现在整个 job 都按 gate 判定来核：Run 回显必须逐字是 gate 命令，判定和退出码各只有一行；job 里只要还有别的 `##[error]`、`error`、测试结果行、失败汇总或分组，就不算 gate 判定。

截断的日志、断言和超时混在一起的日志、缺少文件归属的日志，都照旧拒绝。按 job 截取的日志（`scheduler-merge-ci-log-cut.ts`，不在本卡范围）会丢掉错误段里的栈帧，所以那条路径照旧拒绝（fail-closed）。

夹具：`tests/fixtures/ci-log-timeout-pr1593-shard.txt`（失败分组 + 汇总段）、`…-gate.txt`（gate job，去掉了 runner 的主机信息）。

## 2. 各层的结论记进台账（`ci-main-fix-retry-decision.ts`）

串行合并闸在 CI 红时会依次走 CIF1 → CIF8 → CIF2，每层把结论记在本次调用的 `DecisionTrail` 上。在发出结果（重跑认领、update-branch 认领或退 fix）之前，把这份记录作为一条回执 `CI 恢复判定：{…}` 交给台账一次。这条回执不改合并运行。台账侧在 `ciBehindClaim` 的第一步写一条 note：`op=merge_ci_recovery_decision`，去重键为卡 + run + attempt。

note 的 data 包括：卡、PR、head、run / attempt、失败测试文件，每层的 `accept` / `reject` / `not_reached` 及原因码（如 `non_timeout`、`log_unparsed`、`main_not_changed`），预算剩余（rerun / behind，按台账当时的计数），各开关档位（ciKnownFlaky、ciLogPerJob、ciMainFixRetry），以及口径说明“只核对了失败测试文件，没做依赖分析”。原来的日志行全部保留。写入失败只打日志，不影响结果。

## 3. main 修好后重试一次（开关 `ciMainFixRetry`）

- **登记**：CIF2 只因为“main 在 merge-base 之后没改过失败文件”被拒，并且失败文件列表完整时，在同一条判定里写一条 `op=ci_wait_main_fix`（去重键为卡 + head + run）。data 带卡、PR、head、run、失败文件、当时的 main head、是不是 peer 卡、开关档位。同一张卡的同一组失败文件已经真正重试过一次的，不再登记。
- **作者消息**：`closeMergeRun` 退 fix 前调用 `markWaitMain`，在 `bounceWork` 的输入里加一句。peer 卡且开关为 on：“失败测试不在你的改动里，main 修好后系统会自动重试，你不用为这条改代码”；其余情况：“…main 修好后 merge origin/main 重新交付即可，不用为这条改代码”。
- **重试**（`ci-main-fix-retry-tick.ts`，在 scheduler-pass 的合并 tick 之后）：逐条看每张卡最新且 24 小时内的登记（超过 24 小时的直接跳过，不写 note），满足下面全部条件才重试：卡还在 fix；台账 head 等于登记的 head；PEERHEAD1 的 `flowBlock` 没有拦（冻结、hold、卡暂停、安全留证、未答 ask）；这条登记还没有重试样本；GitHub 上的 PR head 仍是登记的 head；main 在登记的 main head 之后有提交改过任一失败文件。

  满足时先写一条 `recordObserved` 样本（键为卡 + head + run，同时起预写标记的作用）：
  - on 档的 peer PR 卡：样本标 `executed: true`，然后带 `expected_head_sha` = 登记的 head 做一次 update-branch。GitHub 拒绝（422）只打日志。之后的新 head 交给 PEERHEAD1：自动卡登记新 head，round+1 后审查；manual 卡照旧受 peerPrRequeue 约束（headWrite 对纯合 main 的新 head 照旧不动，交给 PM）。
  - 本机执行者的卡，或开关为 observe：只记“本会重试”样本（`executed: false`），不做 update-branch。
- **授权逐次重读**：开关档位、卡（阶段、head、是不是 peer 卡）和 `flowBlock` 不跨 await 沿用。在 GitHub 读完之后重读一次；样本写完之后、发 update-branch 之前再读一次，这次读和发送之间没有 await。读 GitHub 期间冻结了、hold 了，或开关切到 off / observe，就不发。写完样本才被拦下时，补记一条撤回样本（`release:<head>:<run>:r<n>`，`released` = 那条样本的键），这条登记的下一次尝试换用键 `retry:<head>:<run>:r<n+1>`，拦截解除后仍能重试一次。撤回的样本不算“真正重试过”。撤回样本没记上的，按已用掉处理（不会再发）。
- **防重复**：靠 head 绑定。PR head 变了（已经重试过，或者作者推了新提交），登记就算用掉或作废；重启后再 tick 也因为样本已在、head 已变而不会再发。
- **开关**：缺省为 on（OBSGATE1 新键规则，不是高风险类）。observe 只登记并记样本；off 不登记、不改作者消息、tick 什么也不做，逐字回到现状。

## 不变的口径

超时只说明有重跑资格，main 改过只说明值得更新后重试，两者都不豁免 CI。合并始终要求当前绑定 head 的 CI 全绿，审查照旧：本卡不新造任何审查结论，也不沿用审查。

## 不在本卡（留给后续）

- 跨轮沿用审查：从 fix 直接交回合并。需要新的 manager 写口，还要改台账语义。
- 本机执行者的卡自动做 update-branch。
- CIF2 的 `mainSince()` 比的是 `PR head...当前 main`，不是 CI 实际测试用的合并基。

测试：`tests/ci-failed-log-parse.test.ts`、`tests/ci-main-fix-retry.test.ts`。
