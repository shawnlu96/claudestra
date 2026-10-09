# 自动卡上的 PM 干预收窄（设计稿）

状态：讨论稿（已撤回合并资格），待 owner 与 Shawn 评审；本稿不改代码、不开实现。卡：PMR-1。依据：`docs/design/scheduler-engine.md`（T68）、
`docs/team/orchestration-team.md`、`src/lib/manual-reason.ts`，以及 2026-10-07 当天的台账事件。行号以写稿时的 origin/main（`af3c493a`）为准。

owner 的要求（10-07 23:21 / 23:25）：自动流程像 dynamic workflow 一样由代码约束，**进了流程就不能中途手工干预，直到达到设计预期**；中间只允许「停止、放弃、重启」这一类动作。

T68 当初的取舍是：自动决定由 `scheduler` 身份写；PM 的手动操作保留真实 actor，并在事件里标 manual；每张卡带 `fallback: manual`。
这套做法在 10-07 暴露了两个问题：

- **PM 的手动面其实没有收窄**。PM 在自动卡上仍能推阶段、结清意图、绑定会话、切 manual 后自己记审查。这些操作大多不标 manual，也不推送给 owner。
- **引擎碰到没覆盖的情况就退给 PM**，由 PM 手工把流程走完，引擎本身的缺口没有被修。

本稿按规格分 7 节：干预面盘点、引擎退回点盘点、目标模型、Shawn 侧与跨实例影响、迁移分期与验收测试、代价与风险、待定问题。

记号说明：
- **PM** 指 `isManager` 认的人，即 PM 名单（含调度助理）+ master + owner（`src/lib/ledger-checks.ts:220`、`src/lib/ledger-stages.ts:18`）。
- **真 PM** 指 `requireRealPm` / `actorMayConfigure` 认的人，即排除调度助理（`src/manager/ledger-context.ts:107`、`src/lib/ledger-scheduler-settle.ts:17`）。
- 下面所有路径都相对仓库根目录。

## 1. 干预面盘点

### 1.1 身份与可见性的前提

- **身份是自报的**。`resolveActor`（`src/manager/ledger-identity.ts:17-31`）按以下顺序判定：
  - 带出借 worker 标记的，一律拒绝（`:24-25`）；
  - 没有 `DISCORD_CHANNEL_ID` 但带 `CLAUDESTRA_AGENT`：按这个标记认 registry 里的 agent，认不出就拒绝（`:27`）；
  - 两个标记**都没有**：`owner`（`:27`）；
  - 在控制频道里：`master`；在某个 agent 频道里：就是那个 agent。

  所以 agent 只要在自己的 shell 里同时 unset `DISCORD_CHANNEL_ID` 和 `CLAUDESTRA_AGENT`，就能成为 `owner`（`:3`）；出借 worker 做不到。
  因此 CLI 上的 `owner` **不能**当作「owner 本人批准」。真正能证明 owner 本人点过的，只有 bridge 认证入口写进 ask 答复里的正面标记：
  `ownerAnswered`（`src/lib/ledger-asks.ts:53`）。DAG 的 scopeChange 审批已经这样用了（`src/lib/ledger-dag-write.ts:218`）。
- **scheduler 身份**：环境变量 `CLAUDESTRA_SCHEDULER_SERVICE=1`，且没有频道号（`src/manager/ledger.ts:137-142`）。
  它只能跑 `SCHEDULER_SERVICE_COMMANDS` 里的命令（`src/lib/shared-ledger-gate-cli-services.ts:1`），不能跑 `stage` / `review` / `workflow-set` / `freeze` / `deliver`。
- **推送面很窄**。`src/lib/team-route.ts:140-156` 只把 `escalate` / `deliver` / `review` 三类事件推给 PM 或调度助理；
  引擎的退回人工也只推给 PM（`src/lib/scheduler-auto-tick.ts:124` → `src/lib/pm-notify.ts:10`）。
  **owner 除了 ask 卡片以外收不到任何推送**，下表「owner 可见」一列写「台账」的，意思是只能自己去网页台账里看。

### 1.2 CLI：`bun src/manager.ts ledger <子命令>`

| 命令 | 处理入口 | 谁能用 | 能改什么 | 标 manual | owner 可见 |
|---|---|---|---|---|---|
| `stage` | `src/manager/ledger-write-cmds.ts:207` | 角色由 `src/lib/ledger-write.ts:195` 判；review→merge 要真 PM（`:213`）并过合并闸（`:214`） | **阶段**；`applyMove`（`src/lib/ledger-write.ts:189`）**不看 workflow 模式** | 否 | 台账 |
| `task-set` | `ledger-write-cmds.ts:186` | 执行者 / PM；shipped 后改 head 会被 `checkShippedHead`（`:175-181`）拒绝 | **head / PR** / branch / agent / extra | 否 | 台账 |
| `deliver` | `ledger-write-cmds.ts:233` | 执行者 / PM | **head / PR**，build/fix→review | 否 | 推 PM |
| `review` | `ledger-write-cmds.ts:264` | 自动卡只收绑定审查员（`src/lib/scheduler-auto-review.ts:72`），`--to` 在 auto 卡上一律拒（`:24`）；`--waive adversarial` 要真 PM（`ledger-write-cmds.ts:298`） | **审查结论 / 豁免** | 否 | 推 PM |
| `resume-grant` | `ledger-write-cmds.ts:252` | 真 PM | 一次性交回自动的授权 | ? | 台账 |
| `freeze` / `unfreeze` | `ledger-write-cmds.ts:328` | PM | **冻结**（`meta.queueFrozen`） | 否 | 台账 |
| `workflow-set` | `src/manager/ledger-scheduler-cmds.ts:83` | 真 PM 或 autostart 授权（`src/lib/ledger-scheduler-write.ts:96`） | **workflow 模式**；切 manual 时撤掉 pending 意图 | 只有接管 / 留人工时标（`ledger-scheduler-write.ts:146-147`） | 台账 |
| `workflow-resume` | `ledger-scheduler-cmds.ts:107` | 真 PM（`src/lib/ledger-scheduler-resume.ts:31`） | **模式** manual→auto；有 submitted / unknown 意图时拒绝（`:52`） | 是 | 台账 |
| `scheduler-plan` | `ledger-scheduler-cmds.ts:120` | scheduler / 真 PM（`ledger-scheduler-write.ts:170`） | **意图** + 资源 | 非 scheduler 时标（`:239`） | 台账 |
| `scheduler-settle` | `ledger-scheduler-cmds.ts:144` | scheduler / 真 PM（`ledger-scheduler-settle.ts:34`）；结 unknown 要非 scheduler 且带回执（`:35`） | **意图状态** | 非 scheduler 时标（`:50`） | 台账 |
| `scheduler-session-bind` | `ledger-scheduler-cmds.ts:184` | scheduler / 真 PM（`src/lib/scheduler-sessions.ts:43`） | **会话绑定** | 非 scheduler 时标（`:128`） | 台账 |
| `scheduler-merge-begin` / `-step` | `ledger-scheduler-cmds.ts:223` / `:227` | scheduler / 真 PM（`src/lib/scheduler-merge.ts:57`） | 合并 run；unknown 时冻结队列（`:272`） | **否** | 台账 |
| `scheduler-merge-resolve` | `ledger-scheduler-cmds.ts:235` | 真 PM，scheduler 不行（`scheduler-merge.ts:298`） | 结 unknown 合并，并**强制转 manual** | 是（`:316`） | 台账 |
| `scheduler-fallback-manual` | `src/manager/ledger-scheduler-observe-cmds.ts:67` | scheduler / 真 PM（`src/lib/scheduler-fallback.ts:18`） | **模式**→manual，撤意图 | 非 scheduler 时标（`:41`） | 推 PM |
| `restate-approve` | `src/manager/ledger-scheduler-auto-cmds.ts:19` | 真 PM，仅 auto 卡 | 放行复述（decision） | 否 | 台账 |
| `scheduler-stage` | `ledger-scheduler-auto-cmds.ts:32` | 只有 scheduler；只许 `restate>build` / `review>fix` / `review>merge`（`src/lib/scheduler-apply.ts:26`） | **阶段** | — | 台账 |
| `restate-hold` / `restate-release` | `src/manager/ledger-restate-cmds.ts:13` / `:18` | 真 PM，仅 code v3 auto 卡（`ledger-scheduler-write.ts:254`） | 复述刹车 | 否 | 台账 |
| `ui-approve` / `ui-reject` / `ui-owner-visual` | `src/manager/ledger-ui-cmds.ts:7` / `:16` / `:25` | 真 PM | UI 验收（reject 退回 fix） | 否 | 之后的 UI ask |
| `submit-verdict` | `src/manager/ledger-verdict-cmds.ts:41` | bridge 一次性票据 + 审查员 session | **审查结论** | 否 | 推 PM |
| `main-carry` | `src/manager/ledger-main-carry-cmds.ts:22` | 真 PM，scheduler 不行（`src/lib/review-main-carry-manual.ts:130`） | **head** + 沿用审查 | ? | 台账 |
| `manual-merge-request` / `-revoke` | `src/manager/ledger-manual-merge-cmds.ts:33` / `:42` | 真 PM | 手动合并队列 | ? | 台账 |
| `lend-takeover` | `src/manager/ledger-lend-takeover-cmds.ts:18` | scheduler / 真 PM | 出借卡 **head / PR**（经 deliver） | 否 | ? |
| `lend-cancel` / `lend-reclaim` | `src/manager/ledger-lend-cmds.ts:346` / `:348` | PM | 出借单 / 写租约 | ? | 台账 |
| `scheduler-manual-resume` 等 | `src/manager/ledger-scheduler-recovery-cmds.ts:33` | 只有 scheduler，并受恢复策略约束 | **模式**→auto | ? | 台账 |
| `scheduler-autostart` / `scheduler-auto-resume` | `src/manager/ledger-autostart-cmds.ts:119` / `:128` | 只有 scheduler | 建卡、**模式**、**阶段** | — | 推 PM |
| `scheduler-merge-handoff` | `src/manager/ledger-scheduler-deploy-cmds.ts:19` | 只有 scheduler | **阶段** merge→live | — | 台账 |
| `verify` | `src/manager/ledger-verify.ts:199` | PM；scheduler 只能验自己部署的卡，且不能豁免 | **verify**，live→verified | 否 | 台账 |
| `step` | `src/manager/ledger-step-cmds.ts:44` | PM | 步骤接手人 | 否 | 唤醒执行者 |
| `dispatch` / `escalate` | `src/manager/ledger-dispatch-cmds.ts:128` / `:144` | PM | 派审记录 / 升级 | 否 | 推 PM（`--to owner` 也是推 PM） |
| `peer-pr-intake` / `peer-pr-observe` | `src/manager/ledger-peer-pr-cmds.ts:43` / `:60` | scheduler / 真 PM | intake 建 peer 卡（auto security）；observe 把新的稳定 head 交给 auto peer 卡：fix 阶段直接 deliver，review 阶段已有结论时先 review→fix（`src/lib/peer-pr-ledger.ts:105-120`），改 **head / 阶段** | 否 | 台账 |
| `peer-write` | `src/manager/ledger-peer.ts:71` | 只有 bridge（peer 角色） | **阶段** / **结论** / **head** | 否 | ? |
| `dag-rewrite` / `dag-bind` | `src/manager/ledger-dag-cmds.ts:85` / `:93` | PM | 卡的 feature、fileGlobs、文件锁 | 否 | 只有 `--scope-change` 时推 owner ask |
| `dag-approve` | `ledger-dag-cmds.ts:92`（处理入口 `:63-67`） | PM（`src/lib/ledger-dag-write.ts:254`），并且要求审批 ask 是 owner 本人批准的（`:218`） | 让待批的 DAG 提案生效，可能取消在途节点、改卡的 fileGlobs | 否 | owner 已批 |
| `decision` / `deploy` / `rollback` | `ledger-write-cmds.ts:316` / `:321` / `:326`（共用 `managerEvent`，`:305`） | PM | 只追加事件，不改阶段 / head / 模式；但 `deploy` / `rollback` 是部署事实，验收（`verify`）会读到 | 否 | 台账 |
| `lend-offer` / `lend-reoffer` | `src/manager/ledger-lend-cmds.ts:335` / `:342`（处理入口 `:196-209`） | PM（`:200`） | 把这张卡本轮的审查 / 开工 / 修复挂进出借池。**auto 卡已拒绝**（`src/lib/ledger-lend.ts:187`）；reoffer 先撤后挂（`:277-278`），在同一事务里被同一条拒绝回滚 | 否 | 台账 |
| `pm-switch` | `src/manager/pm-switch.ts:48` | owner，或 owner 答过的 authorize ask（`:15`） | PM 名单 | 否 | **owner ask** |

**这张表的完整性靠注册表保证，而不是靠手列。**

- 所有 `ledger` 子命令都在 `src/manager/ledger.ts:76-106` 的 `COMMANDS` 注册表里，上表是 10-07 这一天按「能不能改 auto 卡」手工筛出来的。
- 限权实现时**不按这张表逐条封口**，而是在注册表上给每个写命令标一个分类：
  `scheduler-only`（只有 scheduler 能用）、`typed-action`（四个动作）、`takeover-only`（auto 卡上只在接管期放行）、`project-level`（不碰单卡，豁免须写理由）、`read`。
- **默认拒绝**：没有分类的写命令在 auto 卡上一律拒绝；测试断言注册表里每个命令都有分类（第 5 节 T21），新命令不会成为绕行路径。

### 1.3 MCP 工具与 HTTP 入口

- **MCP 工具的统一闸**：`routeOrderTool` 要求已核验身份（`src/lib/order-tool-route.ts:29-31`），写操作再以调用方频道跑上面的 CLI，所以 1.2 的角色检查会再判一遍。
  - `deliver`（`src/lib/order-deliver.ts:78`）：只能交自己当前的单。
  - `submit_verdict`（`src/bridge/review-tools.ts:27`）：只认审查员已核验的 session。
  - `plan_feature` / `rewrite_dag` / `start_node`（`src/bridge/dag-tools.ts:144` / `:159` / `:193`）：走 `isManager`，调度助理也能用。
    其中 `start_node` 会以 `workflow-set --mode auto` 开卡（`src/lib/dag-tools-steps.ts:241`）。
- **HTTP 入口**：
  - `POST /api/v1/ledger/:project/asks/:id/answer`（`src/bridge/local-api/asks.ts:69`）：owner 作答，写入 `answer.owner`，是 owner 批准的唯一正面来源。
  - `POST /api/v1/peer-ledger/tasks/:id`（`src/bridge/local-api/peer-ledger.ts:30`）→ `peer-write`。
  - `POST /api/v1/lend/*`（`src/bridge/local-api/lend.ts:103`）。
  - `POST /api/v1/projects/:p/pm`（`src/bridge/local-api/project-pm.ts:33`）→ `pm-switch`。
  - `GET` 类接口全部只读。

### 1.4 合并硬闸

`checkMergeGate`（`src/manager/ledger-field-checks.ts:52-61`）只查一件事：对抗式审查的欠账（`owesAdversarial`，`:37-46`）。

- **适用范围**：`review --to merge`、PM 手动 `stage review→merge`、`blocked→merge` 三条路都要过这道闸。
- **不查的东西**：workflow 模式、是否跨模型、是否是同一 head 上的通过，这些只在 scheduler 的合并意图里查（`requireReviewedMerge`，`src/lib/ledger-scheduler-write.ts:42-71`）。
- **结果**：真 PM 用 `stage --from review --to merge` 推一张 auto 卡，只受这一道闸约束，而且事件不标 manual。

## 2. 引擎退回人工点盘点

### 2.1 退回是怎么落地的

- **真退回**走 `Card.escalate`（`src/lib/scheduler-auto-tick.ts:120-128`）→ `fallbackToManual`（`src/lib/scheduler-fallback.ts:14-44`）。
  它会把模式改成 manual，写一条 `fallback_manual` 事件，撤掉 pending 意图，并给 PM 推一条「退回人工，请接手」（`scheduler-auto-tick.ts:124`）。
  退回理由必须能归到 `MANUAL_REASON_CODES`（`src/lib/manual-reason.ts`）里；归不进去就只能停在 held（`scheduler-auto-tick.ts:122`），而且**谁也不通知**。
- **静默停住**的情况有三种：
  - 意图停在 `unknown`（`src/lib/scheduler-plan.ts:126`、`scheduler-auto-tick.ts:399`）：每个 tick 都 held，模式仍是 auto，不通知；
  - 合并 run 进入 unknown（`src/lib/scheduler-merge.ts:272`）：冻结整个项目的合并队列；
  - 退回理由无法分类（上一条）。
- **owner** 只有在 manual 卡停滞超过 `manualAfterMs` 之后，才会收到一张卡（`src/lib/recovery-manual.ts:1-10`）。

### 2.2 主要退回点

| 位置 | 触发条件 | 结果 |
|---|---|---|
| `scheduler-plan.ts:147` / `:149` / `:155` / `:158` | session 对不上、作者家族不对、审查员被换、审查员不独立 | escalate |
| `scheduler-plan.ts:203` | fix 阶段读不到上一轮完整审查报告 | escalate `fix_report` |
| `scheduler-plan.ts:206` | fix 阶段上一轮没有 P1（而且不是合并冲突回弹，`src/lib/scheduler-merge-conflict.ts:218`） | escalate `fix_report` |
| `scheduler-plan.ts:302-353` | 合并前审查缺失 / 不成立 / changes / UI 未批、反复冲突、重试要 PM、verify 失败 | escalate |
| `scheduler-plan.ts:367` | 模板、kind 或 specRev 变了（`workflow_drift`） | escalate（改规格的唯一出路是 `workflow-resume`） |
| `scheduler-plan.ts:372` | 卡在 blocked | wait「等 PM 解除」 |
| `scheduler-auto-tick.ts:167` / `:179` / `:190` | 建 session 已认领但没绑上、建 session 结果不明、绑定写入失败 | **意图记 unknown，静默 held** |
| `scheduler-auto-tick.ts:182-184` | 建 session 返回 manual | escalate |
| `src/lib/scheduler-auto-deps.ts:79` / `:83` / `:93` | Codex 审查员走 `--runtime codex --transport acp` 建；建失败或 90 秒内没拿到 session id | unknown |
| `src/lib/scheduler-create-retry.ts:66` | 只有「失败、已清理、registry 没有残留」才改成退避重试，其余原样返回 unknown | unknown |
| `src/lib/scheduler-merge-handoff-tick.ts:205-206` | 首次交接时 PR 已不是 OPEN，或 head 和台账不一致 | escalate「不交接：PR MERGED…」 |
| `scheduler-merge-handoff-tick.ts:160-161` + `src/lib/scheduler-main-merge-carry.ts:55` | 交接后 PR head 变了，而且不是「原审查 head + 一个 main 提交」的单跳合并 | escalate |
| `src/lib/scheduler-merge-external.ts:94` | 本机合并链超过 `policyHops`（mainCarry 没开就只认一跳） | 退回 review 重审 |
| `src/manager/ledger-write-cmds.ts:175-181` | merge 及以后阶段改 head（PM 也一样） | 拒绝：「先由 PM 退回 fix」 |
| `src/lib/scheduler-service.ts:80-83` | 合并 run 进行中 head 或阶段漂移 | run 进入 unknown，冻结队列 |

### 2.3 背景 (a) 事件对到退回点（10-07 台账）

| 事件 | 卡 / 事件号 | 退回点 |
|---|---|---|
| (a1) ensure_session 卡在 unknown | LCK-2 #3433、ACPV-1 #3499、CXU-1 #3516、OPR-2 #3691 | `scheduler-auto-tick.ts:179` → `:399` 静默 held。根因：create 已经成功，但 stdout 先打了一行 `[acp]` 日志，JSON 解析失败 |
| (a2) Codex 审查员首建失败 | ALG-1 #3697 | `scheduler-auto-deps.ts:79` → `:83`（Codex 返回错误），`scheduler-create-retry.ts:66` 原样透传 unknown，之后同 (a1)。另有 E2BA-1 #3196，审查员 Codex 内部错误 → `runtime_unavailable` |
| (a3) 修复报告缺件 / 修复阶段没有 P1 | LCK-1 #2585、ACPT-2 #4208、GRS-1 #4326、ACPV-1 #3706、E2BA-1 #3183/#3241/#3437/#4661/#4728、E2BR-1 #4662/#4743、CXF-D #2504 | `scheduler-plan.ts:206`（无 P1）/ `:203`（缺报告，E2BR-1 #4743）。**全部**是紧跟在 PM 手动 merge/review→fix 之后触发的，见 3.5 |
| (a4) 仓库方在交接前已合并 | LCK-2 #3632 | `scheduler-merge-handoff-tick.ts:205-206`；之后 PM 手推 merge→live #3665、live→verified #3708 |
| (a5) 两跳 main 合并的 carry 认不出 | ADVA-1 #4542 | `scheduler-main-merge-carry.ts:55` → `scheduler-merge-handoff-tick.ts:161`（父提交不是「审查 head + main」）；之后 PM 手推 merge→live #4555、live→verified #4558 |
| (a6) merge 阶段改 head 被拒 | CXF-D #2490（PR head ≠ 台账 head，`merge_unknown`）、#2501 | 改 head 由 `ledger-write-cmds.ts:175-181` 拒绝，提示「PM 退回 fix」；PM 照做后（#2501）又触发 (a3) #2504 |

### 2.4 背景 (b) 事件：PM 走的是哪个入口，它和退回点的关系（10-07 台账）

| 事件 | 卡 / 事件号 | 现在的入口 | 和退回点的关系 |
|---|---|---|---|
| (b1) 仓库方提 P1 后 merge→fix | LCK-1 #2584、ACPT-2 #4206、GRS-1 #4325、ACPV-1 #3705、E2BA-1 #3182/#3240/#3436/#4659、E2BR-1 #4660、CXF-D #2501 | `ledger stage --from merge --to fix`（`src/manager/ledger-write-cmds.ts:207-219`）→ `moveStage` / `applyMove`（`src/lib/ledger-write.ts:189`）。只有 review→merge 和 blocked→merge 这两种走法要过闸（`:212-217`），merge→fix 只判角色，**不看 workflow 模式**，也不标 manual | 仓库方的 P1 只在消息里，没有进台账的审查结论，于是规划器在 fix 阶段找不到 P1，触发 `scheduler-plan.ts:206`（或缺报告时触发 `:203`）`fix_report` → `fallbackToManual`（`scheduler-fallback.ts:14`）。PM 再用 `workflow-resume` 交回（`src/lib/ledger-scheduler-resume.ts:31`），例如 #2630、#4213、#4346、#3870。也就是 (a3) 全部由 (b1)/(b2) 引起 |
| (b2) 规格澄清后 review→fix | E2BR-1 #4741、E2BA-1 #4727/#3201/#3219 | 同上，`stage --from review --to fix`（`ledger-write-cmds.ts:207-219`）；规格卡改了，但没有正式 bump specRev | 同上触发 `:203` / `:206`（#4743、#4728）。如果 bump 了 specRev，就会触发 `scheduler-plan.ts:367` 的 `workflow_drift`，同样退回人工。两条路都要绕 `workflow-resume` 才能交回 |
| (b3) 切 manual 后手动 review 救卡 | ALG-1 #3751/#3813/#3814/#3817/#3853/#3854/#3855 | ① `scheduler-settle`（`src/lib/ledger-scheduler-settle.ts:29-50`）结清建审查员的 unknown 意图；② 手动建审查员并 `dispatch`（`src/manager/ledger-dispatch-cmds.ts:128`）；③ `workflow-set --mode manual`（`src/lib/ledger-scheduler-write.ts:92-107`，auto→manual 标 takeover / manual，`:146-147`），这一步之后 `review` 不再限定绑定审查员（`src/lib/scheduler-auto-review.ts:72`）；④ `review` 记 pass（`ledger-write-cmds.ts:264`）；⑤ `stage` 推 merge→live→verified | 起点是 (a2) 的 unknown 静默停住（`scheduler-auto-tick.ts:399`）。手动这一路**绕过了**引擎的跨模型审查绑定和 `requireReviewedMerge`（`ledger-scheduler-write.ts:42-71`），只剩合并闸（`ledger-field-checks.ts:52`）一道检查 |
| (b4) 手动 settle / session-bind | ACPV-1 #3552/#3553、CXU-1 #3554/#3555、LCK-2 #3556/#3557、OPR-2 #3730/#3731、ALG-1 #3751 | `scheduler-settle`（`ledger-scheduler-settle.ts:29-50`，结 unknown 要非 scheduler 且带回执，`:35`）+ `scheduler-session-bind`（权限 `src/lib/scheduler-sessions.ts:42-43`，非 scheduler 写入标 manual，`:128`） | 解除的是 (a1) 的 unknown 停住（`scheduler-auto-tick.ts:179` → `:399`）。卡一直保持 auto，PM 等于替引擎完成了对账。ALG-1 #3751 把一个**实际失败**的建审查员意图结成了 done，是误结 |

## 3. 目标模型

### 3.1 原则

1. **自动卡只由引擎推进**。PM 在自动卡上只有四个**有类型的动作**：暂停、放弃、从某一步重启、规格变更。四个动作各有一个专用命令和一种事件，
   由引擎（或在引擎的事务里）落地。其他写入口在 auto 卡上一律拒绝。
2. **其余干预只能在「接管」状态下做**。接管要 owner 在界面上 authorize 批准，有时限，每一步都推送给 owner，结束时交还引擎并对账。
3. **引擎没覆盖的情况停卡，不退给 PM 手工走完**。停卡时写明原因并进 owner 收件箱，修好引擎后用「重启」接着走。
4. **只看工具面**：本模型约束的是 Claudestra 给的 CLI / MCP / HTTP；同一 OS 用户直接改库不在防护范围内，见第 6 节。

### 3.2 新增的卡状态

workflow 的 `mode` 增加两个值：`paused` 和 `takeover`；再增加一个引擎写的 `stopped` 状态（作为 mode 的值或 hold 码，实现期再定）。

- `auto`：引擎推进。PM 只能用四个动作。
- `paused`：引擎不派新单，在途的单照常收结果，PM 可以继续。
- `stopped`：引擎碰到没覆盖的情况。卡不动，进 owner 收件箱。PM 只能重启、放弃或申请接管。
- `takeover`：owner 批准的人工窗口。允许用 1.2 里的全部手工命令，每一步都推送给 owner。
- 存量 `manual` 卡与旧卡：行为完全不变（见 4.6）。

### 3.3 四个有类型的动作

以下所有命令都带 `--rev <task rev>` 和 `--reason`，做 CAS；由真 PM 发起（调度助理不行），事件 actor 记真实身份，`data.manual=true`，`op` 写下面给的固定名字。

**① 暂停 `ledger card-pause <task>` / 继续 `ledger card-continue <task>`**

- 前置条件：卡是 auto 模式，阶段不是终态；`merging` / `deploying` 状态的合并 run 不能暂停，只能等它结清（`scheduler-merge.ts` 本来就不允许中断不可重做的动作）。
- 写入：`op:card_pause` 事件，模式改为 `paused`；在同一个事务里撤掉 pending 意图（复用 `ledger-scheduler-write.ts` 的 `closePoolOrders` + 撤意图）。在途的 submitted 意图保留，回执照收。
- 引擎：规划器看到 `paused` 返回 wait，和现在 blocked 的处理一样（`scheduler-plan.ts:372`）。
- 继续：写 `op:card_continue`，模式改回 auto，按当前事实重新规划。暂停期间 specRev 变了的话，继续会被拒，要求走规格变更。
- 和现有能力的关系：现在的 `stage --to blocked` 和 `workflow-set manual`（`pm_hold`）在 auto 卡上都会被关掉，由这一对命令取代。

**② 放弃 `ledger card-cancel <task>`**

- 前置条件：没有 `merging` / `deploying` / unknown 状态的合并 run；如果有，命令会提示先等结清，或者申请接管。
- 写入：`op:card_cancel`，阶段 → `cancelled`；撤掉所有 pending 意图和池单；释放卡级 worker 槽与文件锁；作者和审查员 session 记 retire 意图，由引擎按现有 retire 流程收尾。
- 不做的事：不自动关 PR、不删分支（见 7-Q4）。
- 引擎：终态卡不再规划。

**③ 从某一步重启 `ledger card-restart <task> --from restate|write|review|fix|merge`**

- 前置条件：
  - 卡是 auto、paused 或 stopped 模式；
  - 不存在 submitted 或 unknown 的意图。如果有，先由引擎自核（见 3.4 第 3 条），核不清的要申请接管；
  - `--from` 必须是模板里在当前阶段**之前**、或就是当前这一步的节点。往后跳一律拒绝，比如不能从 review 直接「重启」到 merge。
  - `--from fix` 时，台账里必须有可作为修复输入的东西：上一轮的 P1 结论，或本 specRev 的规格增量（见 ④）。两样都没有就拒绝，这正好补上了 (a3) 的漏洞。
- 写入：`op:card_restart {from, causalSeq}`；撤掉 pending 意图；阶段由引擎用 `scheduler-stage` 按模板退回到这一步（需要扩充 `ENGINE_MOVES`，`scheduler-apply.ts:26`）。
  需要重建的 session 由引擎按模板 `ensure_session` 重建。
- 引擎：模式改回 auto，从这一步重新派单。stopped 卡的「修好引擎再走」也用这条命令。

**④ 规格变更 `ledger card-spec-change <task> --spec-sha <规格卡内容哈希>`**

- 前置条件：规格卡内容哈希和上次记录的不一样；卡不是终态；没有 `merging` / `deploying` / unknown 的合并 run。
- 写入：`op:spec_change {fromRev, toRev, specSha, delta}`，`specRev+1`；其中 `delta` 是新增或改动的验收行，在服务端从规格卡 diff 出来，PM 不能手填。
  这一条取代现在「改 specRev → 规划器报 `workflow_drift`（`scheduler-plan.ts:367`）→ 退回 manual → `workflow-resume`」的绕行路线。
- **退到哪一步由模板决定，PM 不能指定**：

  | 当前阶段 | 引擎去向 |
  |---|---|
  | spec / restate | 回 restate，重新复述 |
  | build | 留在 build，给作者推一条规格增量单 |
  | review / fix | 进 fix；修复单的输入就是 `delta`（视同 P1，family=`spec_delta`），规划器不再因为「没有 P1」而退回 |
  | merge，交接前 | 撤掉合并意图，进 fix（输入同上） |
  | merge，已交接、PR 还开着 | 撤回交接（交接卡记一条撤回），进 fix |
  | merge，PR 已合并 / live / verified | 拒绝；要另开跟进卡（DAG 加节点），原卡照常走完 |

- 引擎：模式保持 auto，按新 specRev 重新规划；同类 P1 的计数按 specRev 重算（T68 已经这样规定）。

### 3.4 接管

1. **申请**：`ledger takeover-request <task> --reason <为什么> --minutes <时长，默认 60，上限 240>`。
   - 申请人是真 PM。命令会开一张 `authorize` ask 给 owner，绑定参数 `{action:"card_takeover", task, taskRev, workflowRev, specRev, grantee, minutes}`。
   - 绑定和哈希机制复用 `src/lib/ask-bind.ts`，即 DAG scopeChange 审批用的那一套。
2. **生效**：`ledger takeover-begin <task> --ask <id>`。
   - 在一个事务里核对：ask 已答、`ownerAnswered`（`src/lib/ledger-asks.ts:53`）、owner 点的是批准按钮、参数哈希一致、没过期、调用方就是 `grantee`、卡的 rev 没变。
   - 全部通过才写 `op:takeover_begin`，模式改为 `takeover`，并撤掉 pending 意图。
   - 卡的 rev 一变，这份批准就作废，要重新申请。
3. **接管期间**：
   - 1.2 的全部手工命令都对这张卡放行，但调用方必须是 `grantee`。
   - 每条写入都附带 `takeoverId`，并以 `inform` 形式推给 owner，内容是一句话说明谁用什么命令做了什么。
   - 引擎不规划这张卡。
   - 时限到了，由引擎写 `op:takeover_expired`，卡转为 `stopped`，不会自动交回。
4. **结束**：`ledger takeover-end <task>`，由引擎执行对账：
   - 没有 submitted 或 unknown 的意图；阶段是模板认识的节点；台账 head 等于 PR head；
   - 当前阶段需要的证据齐全，例如 merge 阶段要求当前 head 上有跨模型 pass（复用 `requireReviewedMerge`）。

   对账通过就写 `op:takeover_end`，交回 auto；不通过就转为 `stopped`，并把对账差异写进原因。
5. **owner 本人**：owner 在终端里操作，同样要走「申请 → 网页点批准」。因为 CLI 上的 `owner` 身份是自报的，见 1.1。是否给 owner 网页留一个一键接管入口，见 7-Q2。

### 3.5 引擎没覆盖的情况：停卡

- **停卡代替退回人工**：`fallbackToManual` 改为转 `stopped`。
  - 写入：理由码（沿用 MAN1 的表）、事实，以及「修好什么之后可以重启」。
  - 通知：同时进 owner 收件箱（`owner_action` ask，一个卡加一个状态版本只开一张）和 PM。
- **把静默停住改成可见**：意图 unknown 停住、合并 run 进入 unknown 冻结、退回理由无法分类，这三种同样转 `stopped` 并进收件箱。
  在此之前，引擎要先**自核**一次：比如建 session 的结果，看 registry 里有没有这一行、有没有 session id、家族对不对。核得清就由引擎自己结清和绑定，核不清再停卡。
- **属于 PM 职责的停点**：同类 P1 已到第三轮、`verify_failed`、UI 被拒这几种，停卡后 PM 用四个动作处理即可（改规格采用 fallback、放弃、重启），不需要接管。
- **退回点的分类**：第 2 节的每个退回点在实现时都要归入下面三类之一。
  - (i) 引擎自核能解决；(ii) PM 用四个动作能解决；(iii) 只能修引擎或接管。

  分类表随代码一起落在 `manual-reason.ts` 里。

### 3.6 背景 (a)、(b) 的事件在新模型下怎么走

| 事件 | 10-07 的做法 | 新模型 |
|---|---|---|
| (a1) ensure_session unknown | PM 手动 `scheduler-settle` + `scheduler-session-bind`（b4） | 引擎自核：registry 有这一行、有 session id、家族对，就由引擎自己结清和绑定；核不清就 `stopped` 进收件箱。`[acp]` 那行日志干扰解析属于引擎 bug，修好后重启。PM 手动结清或绑定要接管 |
| (a2) Codex 审查员首建失败 | PM 手动建审查员、`dispatch`，切 manual 后手动记 review（b3） | 先自核；失败且已清理就退避重试（现有 `scheduler-create-retry.ts`）；重试到上限则 `stopped`。runtime 修好后 `card-restart --from review`。要人工代审只能接管 |
| (a3) fix_report | PM 改阶段之后被引擎退回 | 改规格走 ④，`delta` 成为修复输入，`:206` 不再触发；`--from fix` 的重启也要求有修复输入 |
| (a4) 交接前已合并 | PM 手推 merge→live→verified | 引擎补规则：PR 已合并，且合并提交包含已审查 head（审查 head 是它的祖先，其余父提交都在 main 上），就由引擎推 live；不满足就 `stopped`。PM 手推要接管 |
| (a5) 两跳 carry 认不出 | PM 手推 merge→live | 引擎按 `mainCarry` 策略支持多跳，逐跳核对「只合入了 main」；不支持或核不过就 `stopped`。PM 手推要接管 |
| (a6) merge 阶段改 head 被拒 | PM 退回 fix 后重新 deliver | 改 head 的唯一合法来源是：引擎认可的 carry；或改规格 / 重启进 fix 之后，执行者重新 deliver。PM `task-set --head` 在 auto 卡上拒绝 |
| (b1) 仓库方提 P1 后 merge→fix | PM `stage merge→fix`，随即触发 (a3) | PM 把 P1 写进规格卡的验收追加，然后 `card-spec-change`。引擎按 3.3④ 的表撤回交接、进 fix，修复输入是 `delta`。P2 不进规格卡，只记 note |
| (b2) 规格澄清后 review→fix | PM `stage review→fix` | 同 (b1)：改规格卡，然后 `card-spec-change` |
| (b3) 切 manual 后手动 `ledger review` 救卡（ALG-1） | `workflow-set manual` 加手动建审查员、手动 dispatch、手动 review、手推阶段 | 正路是 `stopped` → 修好 runtime → `card-restart --from review`。owner 认为必须当天出货的，PM 申请接管，在接管窗口里做同样的事，每一步推送给 owner，最后对账交还 |
| (b4) 手动 settle / session-bind | PM 直接写 | 引擎自核（a1）；核不清就停卡；要人工结清必须接管 |

## 4. 对 Shawn 侧和跨实例的影响

1. **同一套代码**。Shawn 的 PM 用的是同样的命令，限权同样作用在他那边的 auto 卡上，批准接管的是**他那个实例的 owner**，因为 ask 只在本实例 bridge 认证。
   开关放在 `scheduler.json` 里，按实例、按项目设置（`pmRails: off|observe|on`）。每个实例自己决定什么时候开，彼此不互相强制。
2. **出借卡（lend）**：
   - 卡归借入方。限权只作用在借入方本机的这张 auto 卡上。
   - 出借方 worker 本来就不能以本机身份写台账（`src/manager/ledger-identity.ts:24`），只能经 `lend-*` 接口交结论或交付，这部分不变。
   - `lend-cancel` / `lend-reclaim` 是「放弃」或「换放置」，归入 ②③：在 auto 卡上要改走 `card-cancel` / `card-restart`，由引擎调用现有的出借撤单逻辑。
   - `lend-takeover` 是引擎自己的恢复路径，保留给 scheduler。PM 手动调用视为接管。
3. **跨实例交接卡（合并交给仓库方）**：
   - 我方卡在交接之后，由引擎跟踪 PR 状态（`scheduler-merge-handoff-tick.ts`）。
   - 对方提的 P1 / CI 要求，按 3.6 (b1) 走「先落规格卡，再改规格」，和已有的约定一致（P1 先落规格卡，消息只当加速）。
   - 对方在交接前就合并了，按 (a4) 由引擎判断。
   - 对方实例上的卡（他的 PM 管他的卡）不受我方开关影响。
4. **跨实例 intake 时机：仓库方只在收到交接后才 intake**。
   - **现象**：仓库方调度器看到 PR 就自己 intake、审查，甚至排进自动合并，不等我方交接。#806、#851 交接前就被合并；#855 在 build 阶段被审了两轮；
     #858（本卡）我方本地 r1 没过就被判通过、进了合并队列。
   - **根因**：intake 只按 PR 推断。`classifyPr`（`src/lib/peer-pr-intake.ts:19`）对配置里的作者、非 draft、head 稳定的开着的 PR 直接收卡，只有 draft 才等（`:31`）。
     我方的交接只在本机台账写 `merge_handoff` 事件并告诉本机 PM（`src/lib/scheduler-merge-handoff.ts:93`），**不发给仓库方**。
   - **规则**：交接 = 我方台账的 `merge_handoff` 事件，经正式交接消息送达对方。按 PR 推断（开着、非 draft、CI 绿、有新提交）都**不算**交接。
   - **证据格式**：`{v:1, kind:"merge_handoff"|"handoff_withdraw", instance, card, pr, head, handoffSeq, specRev, reviewDigest}`（`reviewDigest` = 本机跨模型审查报告与结论的 sha256），
     经 HTTP peer 通道（`/api/v1`，对方给我方的 scoped token 认证）投递，不走 PR 评论或标签（同仓写权限的人都能伪造）。
   - **协议状态**：上面的交接证据字段和下面对方 `peer-pr-intake` 强制 `--handoff`，是**新协议设计**，不是对既有 P2 / R1 冻结字段的替换；须单独对齐设计、经 owner 批准后实施。
   - **我方要改**（默认做法）：① 执行者开 PR 一律用 draft（`gh pr create --draft`），交接时由引擎 `gh pr ready`，撤回交接（3.3④）时转回 draft；
     ② 写 `merge_handoff` 的同时，向仓库方 PM 入口发一条正式交接消息：卡号、PR、交接 head、`handoffSeq`、本机审查证据摘要；撤回时也发一条，走 T48 outbox 保证重投。
   - **对方要改**（默认做法）：① intake 的前置条件，从「开着的非 draft PR」改成「收到并入账的交接消息，且 PR head = 交接 head，或者是从交接 head 只合入 main 的 carry」；
     没收到交接的 PR 一律 wait，不审、不排合并；`peer-pr-intake`（`src/manager/ledger-peer-pr-cmds.ts:43-57`）加 `--handoff <对方台账里入账的交接事件号>` 必填，事务内复核 PR 号、head、未撤回；
     ② 收到撤回消息时，把卡移出合并队列，回到 wait；③ 过渡期，draft 已经会让 `classifyPr` 等待，我方先改 ① 就能挡住大部分情况。
   - **已越界的在途卡**：对方上线闸时，把没有交接记录、但已 intake 的卡统一转 wait（在途合并意图按其 merge 流程结清，不新排）；我方对这些 PR 先转 draft 并发 hold，交接后再按正常流程走。
   - 双方都改完之前，我方 PM 对仓库方提前给出的结论（审过、进队列）**不认作交接**，照常发 hold（本卡 #858 就是这样处理的）。
5. **peer 角色写入**：`peer-write` 是受托方经 peer 台账写委托卡，只能做 PEER_STEP_MOVES 列出的阶段移动（`src/lib/ledger-stages.ts`），不属于 PM 干预，保持现状。
6. **保持现状的范围**：
   - workflow 是 `manual` 的卡、没有 workflow 行的旧卡、`investigate` / `ops` 卡，行为完全不变（带 `railsVersion` 的卡不会再变回 manual，见第 5 节 P2）；
   - 开关打开前已经是 auto 的在途卡，在 observe 期只记审计；
   - 到限权期，在途卡仍按卡上记录的开关版本执行，**不追溯**。新卡开卡时把 `railsVersion` 写进 workflow。

## 5. 迁移与分期

- **P0：只读（审计 + 推送）**。
  - 在 auto 卡上，按「操作 + 角色」分类：人工干预补上 `data.manual=true` 和 `intervention`（stage / task-set / review / freeze / merge-step / ui / restate / dag 这些现在不标的，见 1.2）。
    正常订单结果提交**豁免**，不算干预：执行者交自己当前单的 `deliver`、绑定审查员的 `submit_verdict` / `review`、peer 在 PEER_STEP_MOVES 内的 `peer-write`、`lend-write` 回结果、`order-taken`、`ask`。
  - 每次写入同步以 `inform` 推给 owner，并在台账页显示「人工干预」徽标。
  - 引擎静默 held 超过 N 分钟时推 owner。
  - 不拒绝任何命令。
- **P1：四个动作上线**。
  - 新增 `card-pause` / `card-continue` / `card-cancel` / `card-restart` / `card-spec-change`，引擎接住这些动作。
  - 引擎补 (a1) 自核、(a4) 已合并识别、(a5) 多跳 carry。
  - 旧命令在 auto 卡上照常可用，但会提示应改用哪个动作，并推送 owner。
- **P2：接管上线并限权**。
  - 新增 `takeover-request` / `-begin` / `-end`。
  - 1.2 里的手工命令在 auto 卡上，除非处于接管期，否则一律拒绝，错误信息写明应走哪个动作或去申请接管。
  - **同期堵住退回口**（带 `railsVersion` 的卡，按调用身份分开）：引擎（actor=`scheduler`）调 `fallbackToManual` 一律转 `stopped`（P2 先只推 PM + owner inform，收件箱卡片在 P3），不再回 manual；
    PM / master 调 `workflow-set --mode manual` 或 `scheduler-fallback-manual`（`scheduler-fallback.ts:18` 现放行真 PM）在非接管期**直接拒绝**、不转 stopped，错误写明改用 `card-pause` / `card-cancel` 或 `takeover-request`。manual 只能经接管进入。
    做不到这一条就不开 P2：否则引擎一退回，卡按 4.6 恢复旧权限，P2 等于不提供完整约束。
- **P3：停卡进收件箱**。
  - 停卡（含 P2 起的 `stopped`）与三种静默停住都进 owner 收件箱。
  - `workflow-resume` 在 auto / stopped 卡上被 `card-restart` 取代，仍保留给 manual 卡使用。

### 验收测试清单

每一期都用临时库加沙箱 CLI 跑，测试文件放 `tests/pm-rails*.test.ts`。

| # | 期 | 测试（期望） |
|---|---|---|
| T1 | P0 | auto 卡上 PM `stage` / `task-set` / `freeze` / `scheduler-merge-step` 各写一次，每条都有 `manual:true` 和 `intervention` 并生成 owner inform；执行者交自己当前单的 deliver、绑定审查员 submit_verdict、peer 正常交付不标、不推；PM 代交 deliver 或代记 review 照样标 intervention 并推 |
| T2 | P0 | 意图 unknown 停住超过阈值，推送 owner 一次；同一状态版本不重复推送 |
| T3 | P1 | `card-pause` 撤掉 pending 意图，submitted 保留；规划器返回 wait；`card-continue` 后重新规划 |
| T4 | P1 | 合并 run 处于 merging 时 `card-pause` / `card-cancel` 被拒 |
| T5 | P1 | `card-cancel`：阶段变 cancelled，槽、锁、池单都释放，生成 retire 意图，PR 不动 |
| T6 | P1 | `card-restart --from review`（stopped 卡）重建审查员 session 并派审；`--from` 指向后面的节点被拒；存在 unknown 意图时被拒 |
| T7 | P1 | `card-restart --from fix`，在既没有 P1 也没有 delta 的情况下被拒 |
| T8 | P1 | `card-spec-change` 按 3.3④ 的表逐行验证去向（restate / build / review / fix / merge 交接前 / 交接后 / 已合并被拒）；fix 单以 delta 作为输入；`scheduler-plan.ts:206` 不触发 |
| T9 | P1 | 规格卡哈希没变时 `card-spec-change` 被拒；PM 手填 delta 不被接受 |
| T10 | P1 | (a1) 复现：create 输出前面多一行日志，引擎自核后自己绑定，不需要人工 |
| T11 | P1 | (a4) PR 已合并且包含审查 head，引擎推 live；不包含时转 stopped |
| T12 | P1 | (a5) 两跳 main 合并在 `mainCarry=on` 时被认；含非 main 提交时转 stopped |
| T13a | P2 | rails 卡上引擎（actor=scheduler）`fallbackToManual` 落到 `stopped` 而非 manual，之后 PM 手工命令仍被拒（不经 manual 拿回权限） |
| T13b | P2 | rails 卡（auto / paused / stopped）非接管期，PM 的 `workflow-set --mode manual` 与 `scheduler-fallback-manual` 被拒，卡模式不变、不转 stopped，错误给出四动作 / 接管出口 |
| T13 | P2 | 不在接管期时，auto 卡上 PM 的 `stage`、`task-set --head`、`scheduler-settle`、`scheduler-session-bind`、`review`、`freeze`、`main-carry`、`manual-merge-request`、`lend-cancel` 逐条被拒，错误信息给出出口 |
| T14 | P2 | `takeover-begin`：ask 没答 / 非 owner 作答（`external` 或缺少 `owner` 标记）/ 驳回 / 哈希不符 / 过期 / 调用方不是 grantee / 卡 rev 已变，逐条被拒 |
| T15 | P2 | 接管期间 grantee 的每一条写入都带 `takeoverId`，并推送 owner；别的 PM 写入被拒 |
| T16 | P2 | 接管到期后引擎写 expired，卡转 stopped；`takeover-end` 对账失败（有 unknown 意图 / head≠PR / 缺跨模型 pass）时转 stopped，成功时转 auto |
| T17 | P2 | 调度助理调用这四个动作或 `takeover-request` 都被拒 |
| T18 | P2 | manual 卡、旧卡、investigate / ops 卡上的全部旧命令行为不变（回归） |
| T19 | P3 | 每个退回点都转 stopped，并且一个卡加一个状态版本只开一张 owner_action ask；无法分类的理由也进收件箱 |
| T20 | 全期 | `pmRails=off` 时以上行为都不出现；Shawn 侧开关独立 |
| T22 | 对方 | （交接协议经 owner 批准后）没有入账交接事件的 PR 不 intake（wait）；`--handoff` 指向的事件 PR/head 不符或已撤回被拒；收到撤回后卡移出合并队列；已越界在途卡上线后转 wait |
| T21 | P2 | `src/manager/ledger.ts` 的 `COMMANDS` 注册表里每个命令都有限权分类（1.2 末）；新加一个没有分类的写命令时测试失败；没有分类的写命令在 auto 卡上被拒 |

## 6. 代价与风险

- **停卡会变多**。10-07 一天里约 30 次 PM 手工推进（包括 b1–b4 和 a4/a5 的手推），在新模型下都会变成停卡或接管。
  P1 期的引擎补丁（自核、已合并识别、多跳 carry、规格增量当作修复输入）预计能吸收其中大部分：(a1)(a3)(a4)(b1)(b2)(b4)。剩下的才需要 owner 介入。
- **救援速度取决于 owner 的响应时延**。owner 不在线时，停住的卡就一直停着。可以缓解但不能消除：
  用常设授权预先批准某几类接管（7-Q3，owner 已定暂不允许）；停卡不阻塞别的卡（槽和锁在 stopped 时是否释放，见 7-Q5）。
- **可以被绕过**。所有 agent 都以 owner 的用户身份运行，并且是 bypassPermissions：
  - 它可以同时 unset `DISCORD_CHANNEL_ID` 和 `CLAUDESTRA_AGENT`，在 CLI 上变成 `owner`（`src/manager/ledger-identity.ts:3`、`:27`；带出借 worker 标记的会先被 `:24-25` 拒绝）；
  - 可以直接写 `ledger.sqlite` 或状态文件；
  - 可以读 `.env` 拿到 bot token 伪造按钮（`docs/team/orchestration-team.md:54`）。

  所以这里的保证**只在工具面上成立**：
  - **保证**（P2 起，且引擎退回口已同期堵上，见第 5 节；P0/P1 只有审计和推送）：只用 Claudestra 工具的 agent，在 auto 卡上除了四个动作以外改不了状态；接管必须有 owner 在认证入口点过的批准；每次接管写入都推给 owner。审计只覆盖正规写入口。
  - **不保证**：直接写库不一定留下事件（UPDATE 可以不插事件，也能伪造带 `takeoverId` 的事件或改审计记录）；独立对账（台账状态 vs PR / registry / 意图）可能发现部分状态差异，但不保证发现直接写库；防不住铁了心的本机 agent；不能让 CLI 上的「owner」等于 owner 本人；不能阻止 GitHub 侧的人工操作（比如仓库方手动合并，这类只能由引擎识别和停卡）。
- **规格变更被当成逃生口**。PM 可能为了把卡推回 fix 而去改规格。这一点由三条约束限制：规格卡必须真的有改动；delta 由服务端 diff 出来；每次规格变更都推给 owner。
- **实现成本**：P1–P2 要动 `ledger-write-cmds.ts` 和 `ledger-scheduler-cmds.ts` 这两个在基线里的大文件。按防腐规则，逻辑放进新模块，大文件里只加一行调用。

## 7. 待定问题（7.1 括号里是建议默认值，不代表 owner 已决定；7.2 已由 owner 定）

**7.1 仓库方已给口径**（Shawn 10-09 逐条意见，见 PMR-1 规格卡「验收追加 3」；是仓库方意见，附约束，最终仍待 owner 定）：
- **Q2 owner 自己动手**：owner 在网页上是否可以「一键接管并直接执行」，省掉申请那一步？（默认可以，但仍然写 `takeover_begin` 事件、受时限约束。约束：必须有真实的 owner 认证（bridge 认证入口上的 owner 作答，同 3.4 第 2 条），批准绑定卡号和 rev、有时限；CLI 上 actor 叫 `owner` 不算，不能一键越过，见 1.1。）
- **Q4 放弃时 PR 怎么处理**：（默认不关 PR、不删分支。约束：说明卡已放弃的 PR 评论是公开发言，要有明确的授权口径才发；口径没定之前只记台账、不评论。）
- **Q5 stopped 卡是否释放 worker 槽和文件锁**：（默认 30 分钟内保留；重启时重新申请。约束：超过 30 分钟也只释放已结清、没有 submitted / unknown 外部效果的槽和锁；在途的不按时间回收。）
- **Q6 仓库方提的 P2**：要不要也走规格变更？（默认不走：仍记 P2，只记 note，不改阶段。约束：需要改验收时可以补规格卡、走 3.3④（以 `spec_delta` 进 fix），但不能伪装升级成 P1。）
- **Q10 规格变更在 build 阶段的处理**：在 build 阶段改规格，是只推一条增量单，还是让执行者重新复述？（默认只推增量单；delta 删除或改写了已有验收行就退回 restate。约束：是否 restate 由服务端 diff 出的真实 delta 和验收变更判定，不靠文本启发式；范围、「不碰」、需要 owner 定这类授权相关小节的改动也要触发 restate，否则会漏掉授权变化。）

**7.2 owner 已定（10-09）**（owner 只定了这 5 个设计默认值，不代表批准实现）：
- **Q1 接管时长**：默认 60 分钟，上限 240 分钟；**不能续期**，到期后重新申请。
- **Q3 常设授权**：**不允许**常设授权；等 P2 跑一周看停卡频率再议。
- **Q7 Shawn 侧开关节奏**：**两边各自决定**开关；我方先在 claudestra 项目开 P0 一周。
- **Q8 manual 卡**：**不纳入**限权，只做 P0 审计。
- **Q9 调度助理**：**不能**用四个动作，和现在 `requireRealPm` 的口径一致。
