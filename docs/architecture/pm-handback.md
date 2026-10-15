# PM 接手后的流程断点（agents-PMHAND1）

PM 接手一张自动卡（手派作者 / 审查、人工合并、人工结清部署）之后，自动路径要能接上。本卡收五个断点，不新增接管入口。

## 五处口径

| # | 断点 | 现在的规则 | 代码 |
|---|------|-----------|------|
| 9补 | 手派作者领单被 retired 绑定挡 | retired 的作者绑定视同无绑定；领单列表（`bindingAllows`）与领单门（`claimValid`）共用 `liveBinding`。active 绑定照旧核 agent / session | `src/lib/pm-handback.ts`、`order-take.ts`、`memory-retrieve-take.ts` |
| 9补2 | 无绑定作者建不了审查 | `createReviewer` 三种来源（绑定作者 cwd / peer PR 仓库 / 出借项目目录）都没有时，本项目仓库卡（非私仓、非外仓 PR）退到 scheduler.json 的 `repoDir`，照旧 `prepareReviewHead` 取 head、开独立审查 worktree。私仓卡照旧退人工 | `src/lib/pm-handback-review-dir.ts` |
| 11a | 交回后报 review_unsolicited | 审查结论的事件序号 **严格小于** 本卡最近一次 PM 交回（`workflow_resume` 且 `manual: true`）且不是 AUTOACK1 采纳、也没有派单回执 → 不算本轮，规划器对当前 head 正常派审，意图 reason 以 `[PMHAND1 交回前结论不算本轮]` 开头。交回之后才出现的无回执结论照旧 escalate | `scheduler-plan.ts` reviewStep、`pm-handback.ts` |
| 11b | 自己的 hold 挡自己 | hold 事件的 actor 即设 hold 的人；之后（seq 更大）**同一人**的 `manual-merge-request` 对人工合并队列（`requestRefusal`）和统一队列视图（`cardWait`）视为解除。owner 的 hold 只有 owner 的请求能解除；别人的请求、hold 之前的请求照旧 `owner_hold`。自动卡的 hold 语义不变 | `pm-handback.ts` `standingHold`、`manual-merge-queue-facts.ts`、`merge-queue-facts.ts` |
| 12 | 人工结清部署后不 verify | 恢复键 `verifyAfterResolve`（权限类高风险，缺省 observe）。部署运行被 PM / master / owner 以 `done` 结清（`deploy_resolve` 事件 actor 不是 scheduler）、合并的 reviewedHead = 卡当前 head、运行意图 specRev = 卡 specRev、卡在 live：on → deploy tick 按 driveVerify 同规则先 dry-run，只记通过（不记失败、不豁免）；observe → 记一条 `recovery_observe`；off → 不出候选。结清为 cancelled / failed 的不 verify | `pm-handback-verify.ts`、`scheduler-verify-gate.ts`、`scheduler-deploy-tick.ts` |

`schedulerCanVerify` 只判「哪些运行有资格」（deployed 自动卡，或上面的 resolved-done）。它在 `ledger-write.ts` 之下，不能读恢复策略（依赖环），所以 `verifyAfterResolve` 的档位由唯一的调度器调用方（`pm-handback-verify.ts`）在调 `ledger verify` 前读。verify 的 dedup 键与 driveVerify 相同（`deploy-verify:<intent>`），PM 自己 `ledger verify` 后卡已不在 live，不再是候选。

## 样本事件

每次生效记一条 note（actor scheduler，`data.op = "pm_handback"`，dedupKey `pm-handback:<type>:<task>:<head>`，按卡 + head + 类型去重）：

- `retired_binding`（9补）：领单时越过了 retired 绑定
- `review_dir_fallback`（9补2）：审查 checkout 退到项目仓库
- `handback_review`（11a）：带标记的派审意图（deploy tick 每项目扫一次补记）
- `hold_lift`（11b）：同一人的请求解除了 hold（deploy tick 每项目扫一次补记）
- `resolve_verify`（12，on 档记通过后）

observe 档的 12 另记 `recovery_observe`（mechanism `verifyAfterResolve`）。

测试：`tests/pm-handback.test.ts`、`tests/pm-handback-review-dir.test.ts`、`tests/memory-retrieve-take-pmhand.test.ts`、`tests/manual-merge-queue-pmhand.test.ts`、`tests/scheduler-verify-gate-pmhand.test.ts`。
