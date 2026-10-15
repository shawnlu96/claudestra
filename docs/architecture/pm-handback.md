# PM 接手后的流程断点（agents-PMHAND1）

PM 接手一张自动卡（手派作者 / 审查、人工合并、人工结清部署）之后，自动路径要能接上。本卡收五个断点，不新增接管入口。

## 五处口径

| # | 断点 | 现在的规则 | 代码 |
|---|------|-----------|------|
| 9补 | 手派作者领单被 retired 绑定挡 | retired 的作者绑定视同无绑定；领单列表（`bindingAllows`）与领单门（`claimValid`）共用 `liveBinding`。active 绑定照旧核 agent / session | `src/lib/pm-handback.ts`、`order-take.ts`、`memory-retrieve-take.ts` |
| 9补2 | 无绑定作者建不了审查 | `createReviewer` 三种来源（绑定作者 cwd / peer PR 仓库 / 出借项目目录）都没有时，本项目仓库卡（非私仓、非外仓 PR）退到 scheduler.json 的 `repoDir`，照旧 `prepareReviewHead` 取 head、开独立审查 worktree。私仓卡照旧退人工 | `src/lib/pm-handback-review-dir.ts` |
| 11a | 交回后报 review_unsolicited | 审查结论的事件序号 **严格小于** 本卡最近一次 PM 交回（`workflow_resume` 且 `manual: true`）且不是 AUTOACK1 采纳 / S2F9 中心审查、也没有派单回执；或是交回前 PM 用 `ledger review` 写的旧式无结构结论（读成 invalid，按本轮最新 review 事件的序号判）→ 不算本轮（这一判定在 review_invalid / review_unsolicited 两道之前），规划器对当前 head 正常派审，意图 reason 以 `[PMHAND1 交回前结论不算本轮]` 开头。这次派审看的是 `handbackSnapshot`：本轮交回前**每一条**不算数的审查事件（结构化或旧式，逐条按「读到它为止」判，不只最新一条）都从视图里去掉，不会被 `reviewerHistory` 读成原审查者而报 reviewer_replaced；算数的（AUTOACK1 / S2F9 / 正规派单回执）留着，连续性与独立性约束照旧；交回前规划、已 `done` 的本节点审查意图视为已取消，不再把派审卡在 `in_flight`；交回后规划的、或仍 pending / submitted / unknown 的照旧在途去重（意图列表不删，attempt 编号照旧递增）。交回之后才出现的无回执结论照旧 escalate review_unsolicited，交回后的无结构结论照旧 review_invalid | `scheduler-plan.ts` reviewStep、`pm-handback.ts` |
| 11b | 自己的 hold 挡自己 | hold 事件的 actor 即设 hold 的人；之后（seq 更大）**同一人**的 `manual-merge-request` 对人工合并队列（`requestRefusal`）和统一队列视图（`cardWait`）视为解除。owner 的 hold 只有 owner 的请求能解除；别人的请求、hold 之前的请求照旧 `owner_hold`。自动卡的 hold 语义不变 | `pm-handback.ts` `standingHold`、`manual-merge-queue-facts.ts`、`merge-queue-facts.ts` |
| 12 | 人工结清部署后不 verify | 恢复键 `verifyAfterResolve`（权限类高风险，缺省 observe）。部署运行被 PM / master / owner 以 `done` 结清（`deploy_resolve` 事件 actor 不是 scheduler）、合并的 reviewedHead = 卡当前 head、运行意图 specRev = 卡 specRev、卡在 live：on → deploy tick 按 driveVerify 同规则先 dry-run，dry-run 未过不记、不豁免；dry-run 通过后的正式核对带 `--pass-only`：重新采集事实、检查单与豁免规则不变，未过时不写任何 verify 事件（返回 `recorded: false` 和 checks / blocking），见下段；observe → 记一条 `recovery_observe`；off → 不出候选。结清为 cancelled / failed 的不 verify | `pm-handback-verify.ts`、`scheduler-verify-gate.ts`、`scheduler-deploy-tick.ts` |

`schedulerCanVerify` 只判「哪些运行有资格」（deployed 自动卡，或上面的 resolved-done）。它在 `ledger-write.ts` 之下，不能读恢复策略（依赖环），所以 `verifyAfterResolve` 的档位由唯一的调度器调用方（`pm-handback-verify.ts`）读两次：dry-run 前一次，dry-run 返回后、正式 `ledger verify` 前再读一次（权限类键在动作边界重核），中途切成 off / observe 就不跑正式核对（observe 照记一条观察）。正式 `ledger verify` 会重新采集事实，dry-run 通过后仍可能未过：`--pass-only`（`src/manager/ledger-verify.ts`，只有这里带）让未过的那次不落账，卡留在 live、10 分钟后再试（每次用自己的 dedup 键 `deploy-verify:<intent>:<try 时刻>`）；不带该参数的手动 verify / driveVerify 照旧记失败；通过即进 verified，PM 自己 `ledger verify` 后卡也不在 live，都不再是候选。

## 样本事件

每次生效记一条 note（actor scheduler，`data.op = "pm_handback"`，dedupKey `pm-handback:<type>:<task>:<head>`，按卡 + head + 类型去重）：

- `retired_binding`（9补）：领单时越过了 retired 绑定
- `review_dir_fallback`（9补2）：审查 checkout 退到项目仓库
- `handback_review`（11a）：带标记的派审意图（deploy tick 每项目扫一次补记）
- `hold_lift`（11b）：同一人的请求解除了 hold（deploy tick 每项目扫一次补记）
- `resolve_verify`（12，on 档记通过后）

observe 档的 12 另记 `recovery_observe`（mechanism `verifyAfterResolve`）。

测试：`tests/pm-handback.test.ts`、`tests/pm-handback-review-dir.test.ts`、`tests/memory-retrieve-take-pmhand.test.ts`、`tests/manual-merge-queue-pmhand.test.ts`、`tests/scheduler-verify-gate-pmhand.test.ts`。
