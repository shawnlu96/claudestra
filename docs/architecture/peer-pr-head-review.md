# peer PR：审查通过后作者又推（merge-arch-PEERHEAD1）

起因：PR1593 / 1598 / 1602 / 1603 审查通过、进合并队列后作者又推了提交，系统把卡退给人工，PM 每次手动「登记新 head → 派审只看增量 → 通过后重新排人工合并」。本卡把这条路收进调度器：登记新 head 后把卡交回自动，自动路径派增量审、通过后自动合并。

## 两个开关

| 键 | 管什么 | 缺省 | off |
|---|---|---|---|
| `peerPrHeadReview` | 到顶判定读结论；登记作者新 head（自动卡与 manual 卡）；只审增量 | on（OBSGATE1 新键规则） | 逐字回到现状：按轮次判到顶，manual 卡不看，不读仓库、不写登记 |
| `peerPrRequeue` | 恢复机制 `peerPrHeadResume`：把登记进 review 的 manual 卡交回 auto | observe（`recovery-key-class.ts` 登记为 permission；与伞键 `manualRecovery` 一起读，取更严） | 照样登记，但不交回、不记样本、不通知 |

`peerPrHeadReview` 的样本走 `recordObserved`（`peer-pr-head-review.ts headSample`），去重键 = 卡 + 步骤 + 新 head。`peerPrRequeue` 的样本由恢复注册表的统一写口记（`scheduler-manual-resume --mechanism` observe：每个状态版本一条，数据带完整证明）。

## 1. 到顶判定读结论

`unresolvedP1Rounds`（纯函数）：本卡当前 specRev 的各轮最后一条审查结论，从最近一轮往前数，连续仍有 P1（或 block / 读不出）的轮数；pass 断开，没结论的轮不算也不断；规划器降级的 P1 不算。`peer-pr-observe.ts` 的两处判到顶（fix 卡、结论后新 head）在 on 下改读它；observe 下仍按轮次判，新规则会放行时记一条样本。round 照旧单调递增、上限不变。

- PR1602：r1 P1 → r2 pass → 新 head 退 fix：连续 P1 = 0，不再误判，进第 3 轮。
- PR1603：r1 P1 → r2 P1 → 新 head：连续 P1 = 2，照旧到顶退人工。

## 2. manual 卡登记新 head（`peer-pr-ledger.ts headWrite`）

tick（`cardsTick`）在开关非 off 时也扫 manual peer 卡，但只做一件事：GitHub 上的 head 与卡不同、稳定、本轮已有结论且结论通过时，取回新 head 后调 `ledger peer-pr-observe`（manual 卡走 headWrite）。事务里全部重核：

- 卡是 peer 卡、manual、在 review / fix / merge；hold、卡暂停、队列冻结、安全留证、待答审批任一在就不动（`flowBlock`；peer 卡没有 feature）；
- 新 head 是纯合 main → 不动，交 main-carry / CARRY2；最近的结构化结论不是通过 → 不动，交 PM；
- merge 阶段：未结的人工合并请求一律撤销（`manual_merge_revoke`，`byScheduler: peerPrHeadReview`），已占槽且在 ready / await_ci 的运行同一事务 `cancelMergeRun`；运行在 updating / merging / unknown，或卡上有别的未结意图 → 整笔不动，交给合并 driver；
- 然后 PM 角色 merge|review → fix、peer 身份 deliver：进 review，round + 1，写登记事件。卡仍是 manual。

自动卡（`observeWrite`）在 on 下同样写登记，并同样先过 `flowBlock`（冻结等一律不换 head、不进轮、不登记）；off / observe 照旧。

## 3. 只审增量

登记事件（note，peer 看不到；去重键 卡 + 轮次 + 新 head）`op: peer_pr_head_review`：`{cause: "author_push", oldHead, newHead, priorReviewSeq, round, specRev, scope, why, flow}`。`review-converge-order.ts convergeOrderLines` 遇到本轮的登记，工单范围写成 `git diff old..new`（作者新改动）+ 上轮 P1 / P2 定向复验，不依赖 SCOPE_ROUND，也不套合 main 重审。新 head 不是后继（force-push）、规格变了、增量对象缺失：`scope: full`，工单写明原因。

## 4. 交回自动（`peer-pr-head-review-resume.ts peerPrHeadResume`）

manual 卡不进调度，派审只在自动路径里。所以登记之后，由现有的人工卡恢复注册表（`manual-recovery-release.ts`，先例 ciManualResume）把卡交回 auto。机制只判断，不写：

- 码只认 `review_unresolved`；sticky 码（pm_hold、pm_takeover、owner_hold、safety_refusal、foreign_repo）、hold 进的 manual、活的人工请求、冻结、未答 ask、未结意图、安全留证由注册表公共底座统一拒；
- judge：peer 卡、在 review；当前轮 + 当前 head 是本流程在 manual 下登记的 author_push（带 oldHead / newHead / priorReviewSeq）；登记晚于这次进 manual；登记之后 head 没再变；登记前最近一条结论就是登记里那条、结构化、同 spec、pass；本轮还没有结论；
- `entryHead`：登记换了 head，进 manual 时记的 head 是旧的。机制只在上面那条登记成立且 oldHead == 进 manual 时的 head、newHead == 卡上 head、此后没有别的 head 变化时担保旧 head，`manualBase` 才按它比；否则返回 null，照旧拒「head 已变」。不实现 entryHead 的机制与 MAN2 逐字不变。指纹仍含当前 head / round / specRev，事务内重核走同一个 entryHead。

交回只走 `scheduler-manual-resume --mechanism`（指纹、事务内重核、`resumeCore`）。交回后全是现有自动路径：调度器向绑定的审查员派本轮审查（工单按第 3 条只审增量）；pass → 自动合并（GitHub 合并照旧绑 head、看 CI）；changes → fix 等作者推。审查中作者又推：结论之后 peer tick 现查 PR head 不符，规划器不放行，结论不会授权新 head，新 head 按自动卡路径再登记一轮。

档位：off 不判；observe 不交回，注册表记一条「本会交回」样本，peer tick 据这条样本给 PM 发一次通知（同一新 head 一次，项目级记录，不改卡的事实、不再生新样本），卡留在 review 的新 head 上，PM 手动派审；on 交回。

## 不推送

整条路只写台账；作者照常收到每轮审查结论（`peer-pr-push.ts` 扫所有 peer 卡）。PM 只在两种情况听到：observe 下那一次「本会交回」；自动路径里照旧的到顶。注册表交回时的那条是 info 级（只记卡片，不送 PM）。

测试：`tests/peer-pr-head-review.test.ts`。
