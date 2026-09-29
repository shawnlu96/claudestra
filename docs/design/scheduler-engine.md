# T68 调度引擎设计（待 owner 审定）

## 目标与边界

台账是唯一事实来源。确定性代码读取任务、步骤、依赖、事件和 ask，按版本化流程模板决定下一步，记录决定，派给已选定的执行者，并在结果回账后继续。PM 负责规格与 DAG、放行复述、例外和 owner 决策；模型可以建议分工，但不能代替引擎推进阶段。第一版只自动接管明确启用的 `code` 任务；`ui`、`security`
是其模板变体。`investigate`、`ops` 和历史卡维持人工流程，直到各自模板另行设计。

本稿依据 `src/lib/ledger-stages.ts`、`ledger-steps*.ts`、`ledger-deps*.ts`、`ledger-handler.ts`、`team-route.ts`、`src/bridge/team-router.ts`、
`src/manager/ledger-dispatch-cmds.ts`、`ledger-audit*.ts`、`src/manager/ledger-verify.ts`，以及团队文档与 T48/T49 规格。现有阶段机、作者校验、审查包、完成检查单均复用，不另写平行规则。

## 运行位置

**建议独立的本机调度进程**，由 launchd 保活；这是设计选择，注册服务须 owner 拍板。长时间的 CI、合并和部署不应挂在会因自身部署而重启的 bridge 中。它只做轮询、计划和恢复，不持有独占的内存状态。bridge 继续负责已认证的人类交互、ask、现有消息投递和 SSE；台账写入走 `runManager` /
`ledger scheduler-*` CLI，延续「自动化由 CLI 写，bridge 的普通读连接只读」的边界。调度进程以 `PRAGMA data_version` 加定期全量对账触发，唤醒丢失不影响正确性。新服务启动前先查现有 launchd 同类服务；不复用生产状态做测试。

第一批 PR 只交纯函数和沙箱中的 CLI，不安装服务。上线开关默认关闭；owner 同意服务形态后才增加 launchd 注册。若暂不批准独立服务，纯规划器和写入协议仍可交付，生产自动调度不上线。

## 台账状态与事务边界

- 沿用 `tasks.stage` 和 `task_steps`：`spec → restate → build → review ↔ fix → merge → live → verified → done`。`ui_check`、对抗式审查、部署步骤是模板节点，不额外复制一套任务阶段；模板游标从已完成的步骤、事件和 ask 推导。
  `blocked`/`cancelled` 停止自动执行，恢复时重算。
- 任务绑定 `workflow={template, version, mode, fallback}`；版本在启用时钉住，模板升级不会悄悄改在途任务。`mode=manual|observe|auto`：`observe` 只写候选计划和差异，不派单、不推阶段；`auto` 才执行。模板及参数由 PM 在任务规格中确认，
  缺必填字段不启用。
- 新增持久的 `scheduler_intents`（与台账同一 SQLite、迁移只追加；消息 outbox 仍由 T48 持有），记录 `taskId、causalSeq、taskRev、node、action、recipient、dedupKey、status、attempt、receipt、leaseUntil、reason`。每个决定同时追加
  actor=`scheduler` 的事件，含模板版本、输入事件号、守卫结果、选择理由和 intent key；协作视图能直接解释「为何派给谁」。事件种类与新表同一迁移加入，不能只写日志。事件不携带密钥或报告全文。
- 计划与占槽在 `BEGIN IMMEDIATE` 内对 `task.rev`、最新事件 seq、模板版本和模式做 CAS；同一事务插入 intent、决定事件、资源占用。重复触发命中同一个键只返回旧 intent。阶段移动复用 `applyMove` / `recordReview` 等现有判门；新增
  `scheduler-apply` 仅接受模板列明的移动和系统动作，不能给 `scheduler` 泛化 PM 权限。CLI 必须在事务里复核因果条件，不能先在进程里判断、过几秒盲写。
- 投递和外部命令不可能与 SQLite 事务做到严格一次。先持久化 intent，再尝试执行；T48 回执、Codex session id、CI/PR/部署事实写回台账后才完成 intent。重启遇到未知结果先查接收回执或外部事实，能确认才重试；合并、部署结果不明时停队列交 PM，不凭超时重做。租约只允许重新对账，
  不等于许可重做副作用。
- 所有自动阶段推进都带 `--from`、因果 seq、完整 head 和稳定 dedupKey。人工或 peer 抢先推进、改规格、换 head、撤销授权时 CAS 失败，丢弃旧计划并重算；不覆盖人工决定。`queueFrozen`、依赖变化、ask 撤销均立即阻止新的派发。

## 数据模板与规划器

模板是仓库里的版本化数据（TS 只读对象或 JSON，逐项 schema 校验），解释器只认有限的条件与动作名；不执行模板里的 shell 文本。示意：

```yaml
id: code
version: 1
nodes:
  - {id: restate, at: spec, wait: restate_delivered, gate: pm_restate_approval, next: write}
  - {id: write, at: build, dispatch: write, wait: deliver, next: regular_review}
  - {id: regular_review, at: review, dispatch: review, wait: review_result, branch: review_result}
  - {id: fix, at: fix, dispatch: fix, wait: deliver, next: same_reviewer_resume}
  - {id: merge, at: merge, gate: pm_merge_authorization, adapter: merge_queue}
  - {id: verify, at: live, adapter: ledger_verify, next: done}
variants:
  ui: {before: merge, gate: owner_screenshot_ask}
  security: {before: merge, node: adversarial_review}
```

解释器只返回 `Wait | Decide | Dispatch | Apply | Escalate` 的计划，不碰 I/O。判定统一读取 `blockedBy/depViews`（`code` 上游须到 live/verified/done，不能把 merge 当满足）、
`stepsOf/authorOf/reviewerCheck`、`nextReview/owesAdversarial`、现有合并闸和 `ledger verify`。缺审查种类、head、规格或证据时 fail closed，升级 PM。审查人由卡上步骤分配和目录建议给出，规划器只验证硬约束；T53 的模型建议以后接入，
不成为执行时的隐形决定。

`review` 先只记结构化结论，不由审查方同时 `--to` 推阶段；引擎在同一条审查事件上决定下一步。旧卡仍允许现有 `review --to`。新卡若审查方带了 `--to`，写入层拒绝，避免人工与引擎双推。`pass` 且无待审轮次走 PM 的合并闸；P0 或无法判断的 `block` 升级 PM；P1 的 `changes`
自动进 fix；仅 P2 时停在 PM 看 diff 的闸，通过后才进 merge 或下一轮安全审查，不再派完整复验。P1 修好后固定给同一具体审查者（同一 Codex session 或 peer 声明的审查者）复验；审查者不可用则停给 PM 改派，改派须重新校验不同作者、跨模型要求。

结构化审查结果需有稳定的 `findingId`、`family`、等级、探针原文和报告路径。连续同一 `family` 的 P1 第 2 次出现时，下一份修复单明确写规格卡的退路 `fallback`；第 3 次仍出现则停止自动返工，附三轮结论升级 PM。不能可靠归类、没有退路或报告缺原文时提前交 PM，不用模型猜类别，
也不把不同问题简单按总轮数算同类。报告、探针视为不可信数据，固定标题引用、限长并脱敏；超限或脱敏后无法验收的 peer 单停下交 PM，不发不完整任务单。

## 执行适配器

所有适配器实现同一契约：`prepare(intent, snapshot) → workOrder`、`submit(workOrder, key) → receipt|unknown`、`reconcile(key, receipt) → pending|complete|failed|unknown`。
结果只通过已校验的台账事件返回；聊天回复是回执，不是完成证据。适配器不得直接推任务阶段，不能藏下一步状态。入参含任务、步骤、轮次、specRev、完整 head、审查身份、执行位置和模板版本；失败写明可重试与否。

1. **本机 session**：按 `task_steps.executorKind=agent` 找 Claude Code、Codex 或 Pi 的现有 Claudestra session，经 T48 统一派单和 bridge `deliver` 投递。未知 runtime 只影响启动方式，不影响步骤契约。
  投递忙时走既有持久押后队列；以 T48 的接方回执为准，15 分钟无回执提醒 PM 改派。创建/重启 agent 仍由 PM 控制，调度器不暗中起进程。
2. **peer**：只发对方项目 PM 入口，复用 T48 的委托格式、脱敏、常设授权/逐卡 accept 和 `peer-ledger` 写回。未 accept 不能发送步骤单。`peer` 权限仍由 T47 的步骤归属判；对方自报的作者/模型在事件里标 `claim`，本机无法强证时不伪称通过硬规则。断线重试保留同一委托键，
  不能发出两张卡。
3. **一次性 Codex 审查**：每卡首次在 `/tmp` 的隔离 worktree 副本跑 `codex exec`，复验用 `codex exec resume <session id>`；session id、命令退出、审查的完整 head 和报告目录写台账。
  新报告放 `statePath("ledger", "reviews", "<T>-r<N>")/report.md`。保留旧 `ledger dispatch` 的 `.md` 路径读取能力；改路径须迁移审查包生成器，不能静默破坏旧卡。
  Codex 审查进程只读生产状态，不能写作者 worktree。若会话丢失，暂停给 PM 决定新审查者；不把新会话假装原审复验。
4. **合并队列**：把 `pm-kit/merge-queue.sh` 的 update-branch → CI → merge 和 `deploy-full.sh` 的部署步骤拆成仓库模块与显式配置。只消费 PM 授权的 intent，项目队列串行。update-branch 改 head 后必须重新跑相关检查与审查，旧 head
  的 pass 不沿用；CI、候选 SHA、merge SHA、部署版本与验证证据逐步记账。部署目标从配置取得，不把个人地址、IP、分享页路径写进代码。失败冻结队列并交 PM 处理回滚；`git tag`、GitHub Release 没有自动 action，永远用 owner 的 authorize ask 单独决定。

`ui` 模板的截图 ask 绑定任务、specRev、head、前后截图摘要；只认 owner 已认证的答复。授权、发版也分别建 bind 完整参数的 ask，过期、拒绝或 head 变化都不放行。merge 的 PM 闸与 owner 的 UI/发版闸分开：owner 点截图不等于授权合并或发布。安全模板在常规审查后追加对抗式终审；
现有作者校验只管「审的人不是写的人」，跨模型家族还需新增校验。缺独立审查者或模型家族证据时停，不用豁免绕过。

## 并发与文件冲突

项目配置 `maxActiveWorkers`，只统计已派且未交付/撤销的写、修步骤；审查与 PM 的串行合并槽单列。每卡在规格中声明 glob 和共享资源/接口；入队时与已占用卡做规范化 glob 交集，能拿到 diff 时再补实际文件。声明未知或交集判不清按冲突排队，不能依赖「git 暂无冲突」放行。占槽和文件锁在台账事务内申请，
释放以交付、取消、PM 确认失败等事件为依据；agent 离线或租约过期只告警，不自动把可能仍在写的锁借给别人。排队顺序为项目内稳定的任务优先级、建卡时间、任务 ID；PM 可经记账调整优先级。

## 与现有组件的接缝

- `team-route` / `team-router`：自动模式任务的通知改为 T49 的状态唤醒或 T48 的派单回执；旧路由仍服务人工卡和项目级升级。用同一个按任务模式的谓词过滤，避免 deliver/review 同时触发旧提示与引擎任务单。`ledger-handler` 仍作为看板「谁在接」的只读投影，不作为推进器。
- `ledger-audit`：保持独立巡检、只报未回执、未知外部结果、缺人、卡住和引擎停摆；不得替引擎再派活。自动模式的 review 未推进属于调度器 backlog，超过阈值才告警。巡检和调度器用相同 intent/event key 关联，避免重复升级。
- T48 提供**唯一**任务单生成、通道、脱敏、持久重试与回执；本设计只生成派单意图和约束，不另建消息 outbox。引擎 intent 引用 T48 的 dispatch-order key。若 T48 尚未合并，先做 planner 与假适配器测试，真实投递 PR 等它合并后接入。
- T49 提供**唯一**跨实例/本机状态唤醒，按事件 seq 去重。引擎决定事件、回执事件不触发相互唤醒；只有接手者变化和需人处理的状态才唤醒。T49 未合并时只开本机沙箱试跑，不能靠轮询聊天代替 peer 唤醒。

## 迁移与验证

1. **PR A：纯模板与规划器。** 枚举节点、守卫、分叉、冲突计算、结构化审查结果；对现有台账快照做只读回放。验收：状态机矩阵、P1 连续计数/P2 闸、安全终审、上游回退、两卡抢热点文件的单测；无后台服务。
2. **PR B：台账意图与 CLI。** 追加迁移、CAS/去重、模式开关、审查结构化字段、决定事件、审查方不能代推自动卡。验收：两进程争同一任务只有一笔意图；崩溃后重算不重复派；历史卡写法不变；协作视图显示原因。
3. **PR C：本机/peer/Codex 适配。** 接 T48/T49，隔离 Codex 审查副本、报告和 session 恢复。验收：沙箱内本机三种 runtime、peer accept/断线/重复投递、Codex 同卡 resume；送达不等于完成。
4. **PR D：合并队列与 ask 闸。** 将脚本逻辑移入仓库、目标配置化，接 owner 截图/授权 ask 和 PM 合并闸。验收：update-branch 换 head 会退审；CI 红或部署未知冻结；重启不会重复 merge/deploy；无自动 tag/release。所有外部动作只在隔离沙箱和假服务测。
5. **PR E：运行服务与渐进切换。** 先 `observe` 对照人工推进并展示差异；再由 PM 对单张新卡开启 `auto`，最后按项目逐步扩。切换期一个任务只能有一名推进者：人工卡走旧路由，自动卡只由调度 CLI 推；PM 可暂停并接管，接管时撤销未执行意图、保留已发工作的回执，核对后才可恢复。服务注册、生产试跑和部署另经
  owner 决定。

每个 PR 跑 `bun run check`；涉及入口构建与 bridge 真实链路时，在隔离沙箱追加相应验证。部署前对现有台账做只读回放和 schema 升级副本测试，绝不从 worktree 向线上库写。热点文件净增不超过 0，新代码放新模块；`src/lib` 只依赖 `src/lib`。

## 风险与待 owner 拍板（最多五项）

1. **服务形态**：是否批准独立 launchd 调度进程？推荐批准；它能跨 bridge 自身部署恢复。批准前只交付沙箱能力，不注册系统服务。
2. **合并授权**：推荐每张卡由项目 PM 放行一次，随后引擎自动执行串行 update-branch、CI、merge、deploy；如果要求 PM 逐节点确认，吞吐较低但外部副作用更可控。无论选哪种，tag/release 始终单独问 owner。
3. **同类 P1 与退路**：推荐规格卡必填结构化 `fallback`，审查结果必填稳定 `family`；缺字段就暂停交 PM。请确认是否接受把这两项作为自动模式准入条件。
4. **旧卡切换**：推荐仅新卡逐张 opt-in，旧卡完结前保持人工；是否需要迁入已有在途卡？若需要，须先逐张核对审查者、head、报告和未回执派单。

外部动作的严格一次语义无法保证；设计目标是「可重放计划、可核对结果、结果不明时停下」，不能把网络超时当成失败后直接重做。peer 模型与作者身份只能凭对方声明时，界面和事件都显式标出这个边界。
