# 调度器自动开卡与自动交回（i28-A1）

调度服务不再等 PM 调 `start_node`，也不再等 PM 手动 `workflow-resume`：

- **自动开卡**：子 DAG 里依赖已满足、规格卡已定稿、文件范围不冲突的计划节点，下一轮（≤ pollMs）由调度服务走完 start_node 的整套流程：建卡、worktree、执行者、开 auto、绑节点。
- **自动交回**：合并被撤销后切成 manual 的卡，执行者交付新 head 后，下一轮由调度服务做一次 workflow-resume。

两件事都在 `scheduler.json` 的 `autoDispatch: true` 块里运行：交回放在 auto tick 之前，交回的卡同一轮就能派审；开卡放在 auto tick 之后，每轮最多开一张。

| 模块 | 职责 |
|------|------|
| `src/lib/scheduler-autostart.ts` | 门的判定（纯函数 + 只读台账），调度服务、claim 事务、feature-show 三处共用 |
| `src/lib/scheduler-autostart-run.ts` | 调度侧开卡：对账 → 选候选 → 额度 → 重读规格 → claim → preflight → 再读规格 → runStart → settle |
| `src/lib/scheduler-autostart-resume.ts` | 交回判定 `resumeVerdict` 与每轮的交回步骤 |
| `src/lib/scheduler-autostart-deps.ts` | 生产接线（路径、registry、git 加 `whileOwned`、带租约的 manager） |
| `src/lib/ledger-autostart*.ts` | 台账侧：claim / step / settle、开关、自动交回的事务 |
| `src/manager/ledger-autostart-cmds.ts` | `ledger scheduler-autostart`、`scheduler-auto-resume`、`autostart-set` 三条子命令，以及 feature-show 的 `autostart` 字段 |

## 开卡的门

只看这样的 feature：项目在 scheduler.json 里 enabled、开了 autoDispatch、并且已列出；feature 是 active，且已建 DAG。节点要过下面全部的门：

1. **节点**：在当前版本里，状态是 planned，还没绑卡。
2. **车道**：在 `featureLanes().startNow` 里，与 show_dag 同一口径。依赖都满足（code 卡到 live / verified / done 算满足）；文件范围不和本图在做的节点重叠，也不和项目里别的开着、带 fileGlobs 的卡重叠。
3. **提案**：这个 feature 没有等 owner 批的重写提案。
4. **规格卡**：放在 `ledger/docs/tasks/<卡号>.md`，最后修改已满 60 秒；卡首（标题之后、第一个 `## ` 之前）没有 `自动开卡：关` 这一行。起草先写到 `drafts/` 下，挪到正式路径就算放行。
5. **开关与冻结**：项目和 feature 的开关都开着，队列没冻结。
6. **容量**：持有 `slot:<project>:*` 的卡，加上 auto 模式、还没到 live 以后、也还没拿到槽的卡，合计少于 maxActiveWorkers。满了就排队，不通知。
7. **额度**：Claude 的周窗口（weekly / weekly_scoped）用量低于线，线缺省 70%。到线就不开，同一窗口只通知 PM 一次。读不到额度不拦，下游撞额度另有报警。
8. **PM**：PM 名单里第一个不是调度助理的人。卡上的 pm 和派单说明里的 {PM} 都填他；名单里没有这样的人就不开。
9. **arm**：arm = 规格卡内容 + 节点 fileGlobs + 模板一起算的哈希。同一个 arm 只要 claim 过，不论结果如何都不再开。PM 改了规格卡或节点范围才会重新武装。

`ledger feature-show <feature>` 输出里的 `autostart.nodes` 列出每个未绑卡的节点此刻卡在哪道门，`gate: null` 表示下一轮就开。额度门只在调度服务里看。

## 模板声明

卡首写一行 `模板：code|ui|security`，冒号全角半角都行，值不分大小写。不写就是 code。版本取 `scheduler-template.ts` 里该模板现有的最高版（运行时从 `templateFor` 探出来，不写死；今天是 code 3，ui / security 2），模板加了新版，自动开的卡就跟着用新版。值不认识或写了两行，就不开卡：照常写一条 claim 并结为 failed，通知 PM 一次。

模板在 workflow-set 那一步由 claim 决定，所以卡从落库那一刻起就是声明的模板。N4 给 start_node 加上模板参数后，由后合并的一方改用那个参数。

## claim 的生命周期

调度身份对一张卡的写权，只由这张卡活着的 claim 授予。

- **claim**（`ledger scheduler-autostart claim`，一个事务）：先重核台账里的全部门，再查这个节点没有未结的 claim，全过才在 feature 上写一条 `autostart_claim` 事件。卡号、agent、分支、PM 都由台账按 start_node 的缺省规则算出，不收调用方给的值。dedupKey 是 `autostart:<feature>:<节点>:<arm>`，同一 arm 再来就返回 duplicate。
- **step**（`… step <claim> <子命令> …`）：runStart 发出的台账写（task-new、task-set、workflow-set、dag-bind，以及回滚时的 stage→cancelled）都改写成 step，每步一个事务。事务里先核 claim 还没结、目标和 claim 一致；建卡之后的每一步（核对、开 auto、绑节点、回滚）还要求这张卡就是本 claim 建的，并且卡上的执行者仍是 claim 的 agent。PM 中途把卡改给别的执行者，就等于接手了这张卡，调度不再碰它，连回滚都不做，剩下的写进 leftovers。卡的字段一律取 claim 和节点。执行者在建卡时就写进去，所以 task-set 只做核对。
- **授权钩子**：lib 里只有两处，钩子由 `ledger-autostart-grant.ts` 的 `autostartGrant` 判定，只认 `ctx.actor === "scheduler"`，并且 ctx 带着 step 在同一事务里核过的 claim。
  - `setWorkflow` 的 actorMayConfigure；
  - `bindNode` 的 requireManager。
  回滚取消卡时按 pm 角色走 `applyMove`。三处都由 `tests/ledger-autostart-claim.test.ts` 用源码断言钉住。
- **settle**：dedupKey 是 `autostart-settle:<claim>`，有三种结果：
  - done：节点已绑；
  - failed：带 code、failedStep、rolledBack、leftovers；
  - unknown。
  结了以后，这个 claim 不再授权任何写。

调度侧的顺序如下：

1. **对账**：每轮开头处理还没结的 claim。节点已绑就结为 done；否则结为 unknown，并通知 PM 一次，不重开。本进程正在开的节点（从 claim 之前到结清之后登记在进程内）跳过，所以同一进程里并发的另一轮不会收回在跑的 claim 的写权。跨进程不用登记：只有拿到调度租约的进程才跑得了，前一个持有者的台账写和 create 都会报 lease-lost，它留下的 claim 就是断掉的。
2. **选候选**，等额度门，再按规格卡重新算一次 arm（还要过静置、卡首开关、模板这几道门）。等的这段时间里规格卡或节点范围变了，就安静放弃，下一轮按新内容重判。然后写 claim。
3. **preflight**：被拒就结为 failed；返回 already（节点已经被开过）就结为 done，不通知。之后再读一次规格卡，变了就结为 failed（code `spec_changed`），什么都还没建，通知 PM 一次；新内容是新的 arm，下一轮重判。runStart 本身只要几秒，期间改规格卡等同于 PM 刚用 start_node 开完就改规格：执行者读到的是新规格，模板以 claim 为准。
4. **runStart**：失败时 runStart 自己倒序回滚，只撤本次建的东西。之后结为 failed，并给 PM 发一条通知，写明在哪一步失败、回滚了什么、留下了什么。卡号被回滚的那张卡占着时，通知里提示用 start_node 带 taskId 手动开。

开卡成功不通知，台账事件和 DAG 图上都看得到。

runStart 调用 manager 时由适配器处理：台账写改成 step；`create` / `kill` 走不带调度身份、带服务租约的 manager，只许操作本 claim 的 agent；其它调用一律抛错，这一步按失败处理并进入回滚。

**和 PM 的 start_node 并发**：两边靠台账裁决。

- 卡号相同时，task-new 的唯一性会拒掉后来的一方。如果调度这边输了，就安静收手：结为 failed，但不通知。
- 卡号不同时，dag-bind 的「节点已绑」检查加上 feature 的 CAS 会拒掉后来的一方。

输的一方只撤自己建的东西。

## 自动交回

判定读本卡的事件、workflow、scheduler_merges 和 intents（`resumeVerdict`）。`ledger scheduler-auto-resume` 在事务里再判一遍才写。

- **触发事件 T**：本卡最近一条「切 manual / 回 auto」的事件，必须是下面两种之一：
  - `merge_resolve`，且 outcome 是 cancelled 或 failed；
  - `fallback_manual`，且原因以 `merge_retry_requires_pm：` 开头。
- **不交回**：最近一条是 PM takeover、PM hold、其它原因的 fallback_manual、workflow_resume、开 auto 的 workflow 事件或 deploy_resolve。只改模板或退路的 manual→manual 不算拦。
- **交付**：T 之后最近一次交付必须满足下面全部条件：
  - 由执行者本人交付；
  - head 不等于被撤销合并的 head：结清的合并取 `scheduler_merges.reviewedHead`，planner 退回的取被取消意图的 head；
  - 卡上的 headSHA 就是这个 head；
  - 卡在 review，最近一条 stage 事件就是这次交付带来的。
- **其它条件**：workflow 是 manual，项目与 feature 的开关开着，autoDispatch 开着且项目已列出。

交回走的是 PM `workflow-resume` 的同一个核心（`ledger-scheduler-resume.ts resumeCore`）。事件仍是 workflow_resume，actor 是 scheduler，另记 `auto: true, trigger, deliver`。按结果分别处理：

- 卡或流程已被改过，或 PM 抢先交回了：算输了竞争，不出声。
- 核心拒绝（还有结果未定的意图，或池单没对账）：通知 PM 一次，按交付去重，同一次交付不再重试。去重记在进程内，重启后最多再试、再通知一次。

队列冻结不拦交回，和 PM 手动交回一样，由 planner 在 build / fix / merge 上自己停。

## 开关与 hold

- **开关**：`ledger autostart-set on|off [--feature <id>] [--line <50–100>] --reason <为什么> [--project <id>]`，由项目 PM / master / owner 执行，写进 meta 的项目级 key `autostart`，同时记一条审计事件。
  - 关项目：这个项目既不自动开卡，也不自动交回；
  - 关 feature：只影响它的节点和它们绑的卡；
  - `--line`：改 Claude 周额度线。

  owner 的「一键关」是 PM 发按钮，owner 点了之后由 PM 代为执行这条命令。
- **PM hold**：要让卡留在人工，用 `ledger workflow-set <task> … --mode manual --reason <为什么>`。对已经是 manual 的卡，这条命令也会照样记一条带 `hold` 的 workflow 事件，自动交回见到它就不碰这张卡。卡在 blocked 时本来就不会交回。

## 合并待 PM 处置提醒（MQWAKE1）

人工合并请求（MQ1）失效后，合并只是安静地结束，PM 不一定知道要动手。自动开卡 tick 每轮在缺规格 / 上线后提醒之后跑一次 `mergePmTick`（`src/lib/scheduler-merge-pm-tick.ts`），把「需要 PM 实际动作」的卡告诉 PM。只告知，不修复：不批准、不登记截图、不改请求 / 审查 / 阶段 / 意图 / 合并槽，也不等容量、不建执行者。

- **候选**（`scheduler-merge-pm-wait.ts mergePmCandidate`，纯读，tick 预筛与台账写事务共用）：merge 阶段的 code 卡，两支——① workflow manual，卡上最新一条人工合并请求曾被受理、没被 PM 撤回、现在是 void；② 卡上没有人工请求（manual 未提交或 auto 卡），当前 head 截图门不过而代码审查仍正规成立（审查不成立是作者 / 审查员的事，不叫 PM）。两支都要求卡上没有 pending / submitted / unknown 的调度意图（外部合并效果未定的一律不碰，也不结清）；项目不是仓库方交接。失效原因只读结构化事实：当前 head 的截图门（`uiMergeRefusal`）、当前审查是否正规成立（`reviewRefusal`）、请求绑定的 head / specRev / 轮次 / 审查 / 截图摘要是否变了。请求仍排队 / 等待、有有效替代请求、离开 merge，都不算。
- **正文**：卡号、简短原因、当前绑定（head 前 12 位 / specRev / 轮次 / 审查 seq）和下一步。截图门不过时写「在当前 head 重拍 → PM 核图 / 登记 ui-approve（符合原沿用门时才沿用）→ 再提交绑定新 head/spec/round/review 的 manual-merge-request」（auto 卡没有提交请求这一步）；非 UI 失效按真实原因给步骤，不带重拍。不含路径、截图内容、会话标识或原始外部错误。
- **收件人**：仍合法的 feature PM（`featurePm`），否则项目当班 PM；调度助理、不在 PM 名单的一律不收。
- **阻塞实例**：键 = 卡 + 请求 + 当前 head / specRev / 轮次 / 审查 / 摘要 + 原因的哈希。绑定任一项再变（新 head、PM 新验收）就是新的阻塞实例。
- **记账**（`scheduler-merge-pm-ledger.ts`，`ledger scheduler-autostart merge-pm <卡> record <键> | sent <意图 seq> --mode --pm`，调度身份、带租约守卫）：BEGIN IMMEDIATE 里重算候选，开关模式、阻塞键、收件人任一和预读不符就 conflict；正文与 dedup 键只在这里算，带 `--text` / `--dedup` 一律拒。只写本卡 note 事件（op `merge_pm_wait`）。
  - observe：每个阻塞实例一条 would 记录，不发。
  - on：写发送意图（同一实例 30 分钟一条）→ 发前再按只读连接重算，开关不再是 on、键或收件人变了就不发 → `sendToPm`（生产带本轮存活检查）→ 发出才写 `merge-pm-sent:<卡>:<键>`（台账写确认时开关须仍是 on，否则 conflict、不写）。发送失败或发送端回 false 不写确认，30 分钟后重试；确认之后同一实例不再发，重启也一样。
  - off：零写零发。
- **开关**：`autostart-set on --merge-pm-wait on|observe|off --reason … [--project]`，项目 PM / master / owner，缺省 observe；与 `--spec-wait` 互不借用。上线先 observe 看 would 记录的候选、去重与收件人，再由 PM 决定是否 on。
- **失败**：租约丢了 → SchedulerStopped 照原路径传播；其它失败只进本轮 failed，不盖开卡等原有错误。
