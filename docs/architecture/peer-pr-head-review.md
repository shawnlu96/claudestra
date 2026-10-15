# peer PR：审查通过后作者又推（merge-arch-PEERHEAD1）

起因：PR1593 / 1598 / 1602 / 1603 审查通过、进合并队列后作者又推了提交，系统把卡退给人工，PM 每次手动「登记新 head → 派审只看增量 → 通过后重新排人工合并」。本卡把这条路收进调度器。

## 两个开关

| 键 | 管什么 | 缺省 | off |
|---|---|---|---|
| `peerPrHeadReview` | 到顶判定读结论；manual 卡自动登记新 head；只审增量 | on（OBSGATE1 新键规则） | 逐字回到现状：按轮次判到顶，manual 卡不看，不读仓库、不写登记 |
| `peerPrRequeue` | 增量复审通过后调度器代排人工合并 | observe（`recovery-key-class.ts` 登记为 permission） | 不代排、不记样本、不通知 |

样本走 `recordObserved`（`peer-pr-head-review.ts headSample`），去重键 = 卡 + 步骤 + 新 head：`register:<head>`、`verdict:<head>`、`requeue:<head>`；数据带旧 / 新 head、旧 pass 的 seq、结清的请求 / 意图、派审轮次、复审结论、新请求 seq（observe 下是可直接执行的请求参数）。观察期核对用通用适配器（`observation-plan-evidence.ts`），可按样本自动转正。

## 1. 到顶判定读结论

`unresolvedP1Rounds`（纯函数）：本卡当前 specRev 的各轮最后一条审查结论，从最近一轮往前数，连续仍有 P1（或 block / 读不出）的轮数；pass 断开，没结论的轮不算也不断；规划器降级的 P1 不算。`peer-pr-observe.ts` 的两处判到顶（fix 卡、结论后新 head）在 on 下改读它；observe 下仍按轮次判，新规则会放行时记一条样本。round 照旧单调递增、上限不变。

- PR1602：r1 P1 → r2 pass → 新 head 退 fix：连续 P1 = 0，不再误判，进第 3 轮。
- PR1603：r1 P1 → r2 P1 → 新 head：连续 P1 = 2，照旧到顶退人工。

## 2. manual 卡受限自动复审（`peer-pr-ledger.ts headWrite`）

tick（`cardsTick`）在开关非 off 时也扫 manual peer 卡，但只做一件事：GitHub 上的 head 与卡不同、稳定、本轮已有结论，且结论通过（或本轮是本流程在 manual 下登记的）时，取回新 head 后调 `ledger peer-pr-observe`（已登记的调度命令；manual 卡走新分支）。事务里全部重核：

- 卡是 peer 卡、manual、在 review / fix / merge；hold、卡暂停、队列冻结、安全留证、待答审批任一在就不动（peer 卡没有 feature）；
- 新 head 是纯合 main（`mainMergeCarry` 证明）→ 不动，交 main-carry / CARRY2；
- 结论不是通过：只有本流程登记的轮才接着走，连续 P1 轮数到 maxRounds 就停（返回 top，tick 通知 PM 一次）；
- merge 阶段：未结的人工合并请求一律撤销（`manual_merge_revoke`，`byScheduler: peerPrHeadReview`），已占槽且在 ready / await_ci 的运行同一事务 `cancelMergeRun`；运行在 updating / merging / unknown，或卡上有别的未结意图 → 整笔不动，交给合并 driver；
- 然后 PM 角色 merge|review → fix、peer 身份 deliver：进 review，round + 1，写登记事件。

## 3. 只审增量

登记事件（note，peer 看不到；去重键 卡 + 轮次 + 新 head）`op: peer_pr_head_review`：`{cause: "author_push", oldHead, newHead, priorReviewSeq, round, specRev, scope, why, flow}`。`review-converge-order.ts convergeOrderLines` 遇到本轮的登记，工单范围写成 `git diff old..new`（作者新改动）+ 上轮 P1 / P2 定向复验，不依赖 SCOPE_ROUND，也不套合 main 重审。新 head 不是后继（force-push）、规格变了、增量对象缺失：`scope: full`，工单写明原因。自动卡（`observeWrite`）在 on 下同样写登记。

## 4. 通过后自动重新排合并（`headSettleWrite` + `manual-merge-queue.ts requeueByScheduler`）

本流程登记的轮出了结论、GitHub head 仍是卡上的 head 时（head 又变了就先登记新 head，中间版本的结论永远不排队）：

- changes / block → fix 等作者；连续 P1 到顶 → PM 一次；
- 通过 → merge，然后按 `peerPrRequeue`：on = `requeueByScheduler`，与 PM 请求同一套绑定 / 审查 / 拒绝校验（`writeRequest`），以 `scheduler` 身份提交，`data.byScheduler` 记依据（档位、旧请求 seq、本轮 pass 的 seq）；任何 wait（冻结、hold、暂停、待答审批、安全留证、未结意图）在事务内都拒，不排队；observe = 一条样本 + 给 PM 一次带 `ledger manual-merge-request …` 参数的通知（同一新 head 一次）。

合并照旧只认新 head 的审查和 CI，GitHub 合并照旧带 head 绑定；旧 pass 不授权新代码（旧请求已撤销，且 head 变了本就作废）。

## 不推送

除 observe 下的那一次代排通知、连续 changes 到顶的那一次，整条路只写台账；作者照常收到每轮审查结论（`peer-pr-push.ts` 扫所有 peer 卡）。

## 已知边界

manual 卡的复审派单沿用现有路径（本卡不改派单代码）：登记后卡在 review，审查由现有派审 / 出借路径接手，工单范围按上面第 3 条生成。

测试：`tests/peer-pr-head-review.test.ts`。
