# 私仓卡合并交给调度器（merge-arch-MERGEAUTO1）

私仓卡（fileGlobs 写 `repo:<owner>/<name>/…`，`card-repo.ts privateCardRepo`）到 merge 阶段时，本机有该私仓检出的，走和公仓同一条合并流水线（同一个合并意图、同一个 merge run、同一个项目合并槽、同一套退回 / 合并后记账）；没有检出的照旧 `foreign_repo` 交 PM。

## 开关 `privateRepoMerge`

| 档 | 规划器（`scheduler-plan.ts` stageStep） | 合并驱动（`scheduler-merge-driver.ts` driveMerge） |
| --- | --- | --- |
| off | `foreign_repo` 交 PM，逐字不变 | inspect 抛 ForeignRepoError → foreignEnd 交 PM，逐字不变 |
| observe | 照旧交 PM，另记一条「本会自动合并 / 不能自动合并：<原因>」（按卡 + head 一条） | 同左 |
| on | 有检出：不 escalate，照常规划合并意图；没检出：照旧交 PM，记「交 PM：本机没有 <仓库> 的检出」 | 私仓分支接管（下节） |

回退：`scheduler-recovery … off --key privateRepoMerge`。所有记录都是 `recordObserved` 的 note（mechanism = privateRepoMerge，target = 卡，actionKey 以 head 开头），on 档每次尝试（merged / merged-by-pm / wait / wait-serial / bounce-ci / bounce-conflict / review / gh-fail-N / pm）一条，供 agents-OBSAUTO1 核。

## 哪些私仓能自动合并（`private-merge-gate.ts`）

卡的 `privateCardRepo` 与 PR 链接是同一仓库，项目不是 mergeHandoff，且项目 dirs 里能用 `repoDirFor` 找到 origin 指向该仓库的检出（按项目 + 仓库缓存 5 分钟）。不新增配置文件。原因只写仓库名，不写本地路径。

## 驱动里的私仓分支（`private-merge.ts`）

driveMerge 的 try 里第一件事问 `privateMergeDrive`；返回 null（off、observe、没检出、人工合并请求 `mmq:`、没有交 PM 的钩子）就走原路径。接管时只做「核 head + 核 checks + match-head 合并」，不 update-branch、不进 train / union：

1. **同仓串行**：看台账 `scheduler_merges` 里该私仓未结的 run（ready / updating / await_ci / merging）：已在 merging 的先走，否则最早建的先走，其余等（进程重启不丢）。
2. **PR**：MERGED 且 head = 审查 head、有合并提交 → 按已合并记账（PM 手动合过，不再 `gh pr merge`）；CLOSED、base 不是 main、合进的不是审查 head → 交 PM；OPEN 但 head 变了 → `await_review` 回审（漂移规则）；draft / mergeable 未算出 → 等；CONFLICTING → 冲突退回。
3. **CI**：读该仓 main 分支保护的 required status checks；读不到（404 无保护或没要求、403 无权限）就要求该 head 上全部 check 已完成、没有失败、至少 1 条 pass（skipping 不算失败）；一条 check 都没有 → 交 PM「私仓没有可核的 CI」。在跑 → 等，同一 head 从第一次等起满 2 小时交 PM 一次。红 → 走台账现有的合并退回（`退回 fix（ci_fail）` 回执）；台账只认本项目 requiredChecks 里的名字，私仓的检查名不在其中时退回会被台账拒，所以这种情况交 PM 并写明原因，不落 unknown。
4. **合并**：认领 `merging` → driver 的 recheck（beforeSend）→ `gh pr merge <n> --repo <仓库> --merge --match-head-commit <审查 head>` → 回读：只有 MERGED、head 一致、有合并提交才记 merged（收据写明不走本项目自动部署；部署 tick 照旧按 FOREIGN_DEPLOY_NOTE 结清）。
5. **出错**：gh 任一步出错 / 超时 → 本轮不动，下轮重试；同一 head 连续 3 轮出错交 PM。交 PM 一律走驱动原有的 foreign_repo 钩子：先 `scheduler-fallback-manual`，再以「合并未发出」回执推 unknown，台账按人工取消结束 run（放槽、不冻结队列）。

gh 一律结构化 argv、有界超时、在私仓检出里跑；失败只报类别和退出码（`gh pr view 失败（exit 1）`），私仓 stderr、远端 URL、本地路径都不进台账或通知（`private-merge-gh.ts`）。

## 文件锁收窄（privateMergeNarrow 保留）

on 档不再交 PM，于是由本路径在 run 处于 ready 时按 privateMergeNarrow 的档收窄一次（`private-merge-ledger.ts`）：复用 `narrowTarget` / `replaceCardFileLocks` 和交 PM 分支同一个去重键 `privateNarrowKey(卡, head)`，读 PR 改动复用 `handoffFiles`；失败保留整把锁，只记步骤和退出码。交 PM 的分支仍由 `scheduler-merge-handoff-private.ts` 收窄。

## 共存

- PM 直接 `gh pr merge`：下一轮读到 MERGED + 合并提交，按已合并记账，不重复合并。
- manual 卡不规划合并意图；`manual-merge-request`（`mmq:` 意图）不进本路径，行为不变。
- 公仓卡、peer PR 卡的合并路径不变。
- 主线 CI 闸（mainCiDrive）在 driveMerge 之前：项目 main CI 暂停时私仓 run 也等（暂停态读 PR 走项目 gh，ForeignRepoError 被当作读失败等下一轮）。

## 已知限制

- 私仓 required check 名不在本项目 requiredChecks 里时，红 CI 交 PM 而不是自动退回 fix（台账的退回证据校验）。
- merge pipe / ciQueueFull 若读到私仓卡的 PR，会经项目 gh 报 ForeignRepoError 记入本轮 failed，不影响合并本身。
