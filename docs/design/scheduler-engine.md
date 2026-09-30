# T68 调度引擎 v2

状态：设计定稿，分 PR 实施。覆盖 T68 与 T69。依据：任务卡 T68/T69、`docs/team/collab-view-v4.md`、`docs/runtimes/codex-acp.md`、现有台账与班子模块。旧稿见 Git 历史 `74c34005`。

## 目标与不变量

确定性代码读台账事件，按版本化流程模板决定下一步，派给 worker，收回结构化结果，推阶段、复验、合并部署。PM 只写规格与 DAG、放行复述、处理三轮同类 P1 例外、找 owner 处理 UI 截图与发版。新卡逐张 opt-in；在途卡仍人工推进。`investigate` / `ops` 暂不进入自动模式。

台账是唯一事实来源：引擎不把队列位置、审查会话、文件锁或已发命令只放内存。自动决定记 actor=`scheduler` 的事件；PM 手动操作保留真实 actor，并在数据中标记 manual。事件含输入事件号、模板版本、守卫、原因、执行者和 intent key。重启以台账重算；网络超时或进程退出不等于外部动作失败。无法证明安全重试时停下并记明原因。

## 运行形态与部署

独立 `scheduler` 进程由 launchd 保活，与 bridge、launcher、cron 并列。它不能因 bridge 自身部署而停止；bridge 保留 owner 身份认证、ask、SSE 和消息通道。调度器的自动写入经 `runManager` → 专用 `ledger scheduler-*` CLI，
沿用「自动化由 CLI 写台账」的边界。调度器自身只读快照；以 `PRAGMA data_version` 和周期对账触发计划，事件通知只负责降延迟。

`install-cli`、`update`、`doctor`、部署命令都要识别第四个服务。安装前查现有 LaunchAgent，避免重复注册；未配置或启动失败在 doctor 明报，bridge 照常运行。服务重启不自动重做结果不明的 merge/deploy。配置含项目 worker 上限、部署目标和启用范围；无个人地址、IP
或密钥字面量。生产服务随独立 PR 上线，先在沙箱验证。

## 台账模式与原子操作

沿用 `tasks.stage` 的合法跳转、`task_steps` 的执行者/作者/结论、`task_deps` 的 DAG、`ledger-handler` 的当前接手人、`ledger verify` 的完成检查单，不另写阶段机。任务绑定
`workflow={template,version,mode,authorFamily,fallback}`：`manual|observe|auto`；模式和模板版本在新卡启用时写定，后续改动要 CAS 和事件。作者模型家族、退路方案缺一即拒绝进入 auto。`observe` 只写稳定的计划差异，不执行。

新增 `scheduler_intents` 和资源占用表，同 ledger.sqlite 一次迁移追加；`LEDGER_SCHEMA_VERSION` 仍取迁移数组长度。intent 字段至少含 task、节点、因果 event seq、task rev、specRev、head、模板版本、动作、收件人、去重键、状态、回执/外部事实、
尝试次数。计划、占槽、决定事件同一 `BEGIN IMMEDIATE` 事务写入；重复键返回旧 intent。每个 `scheduler-apply` 在事务内重新核对 task rev、最新事件 seq、模式、head、依赖和队列冻结。只允许模板列明的阶段移动。专用 `scheduler` 身份只可使用调度计划、结算及合并 journal 命令，不能调用通用 PM 阶段移动、冻结或 owner 命令；CLI 从服务进程的专用启动上下文识别该身份，不借用 PM/master 的频道身份。人工调用保留实际 actor 并标记 manual。

外部动作遵循 `plan → durable intent → submit → receipt → reconcile → complete`。T48 持有消息 outbox，scheduler intent 只引用其 dispatch key，不造第二条消息队列。对可重试的派单沿用相同 idempotency key；
merge/deploy 等不可确定动作先查 PR、main SHA、构建产物与服务版本，仍不清楚就停队列交 PM。租约过期只触发核对，不授权重做。worker 完成以校验过的台账事件为准，聊天回复仅是回执。每个自动移动带 `--from`、完整 head、因果 seq 和 dedupKey；人工抢先更新使旧计划失效并重算。

## 版本化模板

模板是仓库里的数据，schema 只允许预定义 predicate/action 名，不可嵌 shell。内部节点细于现有 stage，当前节点由最近有效事件、步骤、ask 与 intent 推导。示意：

```yaml
id: code
version: 2
nodes:
  - {id: restate, stage: restate, wait: worker_restate, gate: pm_accept_restate}
  - {id: write, stage: build, dispatch: author_session, wait: deliver}
  - {id: review, stage: review, dispatch: adversarial_review_session, wait: review_result}
  - {id: fix, stage: fix, dispatch: author_session, wait: deliver, next: same_review_session}
  - {id: merge_deploy, stage: merge, action: merge_queue, guard: review_and_ci_green}
  - {id: verify, stage: live, action: ledger_verify, next: done}
variants:
  ui: {before: merge_deploy, gate: owner_screenshot_ask}
  security: {review: adversarial_cross_family_required}
```

默认每轮审查都是对抗式；不再先常规后对抗。每张卡一个独立执行 session、一个独立审查 session；同卡 P1 复验沿用原审查 session。作者 Codex → Claude Code 审，作者 Claude Code → Codex 审；Pi 或未知模型家族没有明确配对时不自动选 reviewer，停给 PM，不猜同家族。
`task_steps` 继续真校验作者不同人；新增模型家族校验：registry 能找到的本机身份一律核 runtime，不能凭 transport=peer 变成远端。远端绑定须逐字匹配本卡当前步骤的 <agent>@<peer> 委托；家族自报只能标 claim，不伪称本机已核实。

reviewer 只写结构化结论（head、verdict、P0/P1/P2、findingId、family、探针原文、报告路径、审查 session id），不得同时 `--to` 推自动卡。引擎观察审查事件后决定阶段；旧人工卡的 `review --to` 保持兼容。P1 的 `changes` 自动进 fix
并附报告要点与原探针；P0 或 `block` 暂停并升级。只剩 P2 时通知 PM 看 diff，同时继续自动合并流程，不再派复验；这是 04:27「只留三道闸」对原 P2 PM 闸的收窄。

同类 P1 的 `family` 先 NFKC、小写并去分隔符；同一个 `findingId` 跨轮沿用也算同类。复验派单附历轮 findingId/family，要求沿用旧 ID。连续第 2 轮仍出现，下一轮修复单写明「再不行退到 X」（X=规格的 fallback）；第 3 轮同类仍出现则暂停并升级 PM。无论标签如何变化，任意 P1 连续 4 轮也升级 PM，防止改名形成无限循环。缺稳定证据、探针或 fallback 时提前停给 PM；换 specRev 后重新计算。报告与探针是外来数据，固定标题引用、限长、脱敏后再派给 peer；
若脱敏破坏验收信息则停止派发。

`ui` 在合并前发 owner 截图 ask，绑定任务、specRev、完整 head 和截图摘要；过期、拒绝或 head 变化都不放行。`git tag` / release 永远单独走 owner authorize ask，引擎不自动运行。审查通过且 CI 绿后，其余合并部署节点自动走，无逐节点 PM 闸；更新分支造成 head
变化时旧审查失效，回 review 复验新 head。deploy 成功才进 live，`ledger verify` 通过进 verified，之后 archive + kill 本卡的执行与审查 session。

## Worker 主接口与适配器

引擎面向 `WorkerSession` 契约：`ensure(task, role, family) → sessionRef`、`submit(intent, workOrder) → receipt`、`observe(sessionRef) → running|result|unknown`、`cancel`、`archive`。
`sessionRef` 与 transport 存台账，不能只靠 tmux 窗口名。worker 的任务单包含 task/specRev/head/轮次/模板节点、输入、产出、验收、回写命令和 dedupKey。工作进程可以是 Claude Code、Codex、Pi 或 peer 实例，状态机不按形态分叉。

**ACP 是主要的 session 控制与结果接口**。T60 合并后，Codex 走 ACP 宿主的结构化回合、工具输出、失败、cancel；不解析 TUI 画面或向 tmux 发键。Claude Code/Pi 暂未声明 ACP 能力时经现有 channel 协议适配成同一 `WorkerSession` 契约；tmux
仅作为已有 session 的兼容回退，回退原因写台账，不能静默换路。ACP 适配器最后接入 T60 的稳定 API，先以 mock contract 测调度器。

本机 worker 用 T48 的统一派单与回执；跨实例只发对方项目 PM 入口，接受任务按 T47 的 accept/常设授权，步骤结果写 `peer-ledger`。T49 只负责状态变化时唤醒当前接手人，按事件 seq 去重；scheduler 决定与回执事件不触发来回唤醒。`team-route` 对 manual 卡照旧，对
auto 卡不再发旧的 deliver/review 指令，避免双派；`ledger-audit` 继续独立报失联、无回执、调度积压和未知外部结果，不代替引擎推阶段。

审查 session 的 worktree/权限与执行 session 隔离，只审指定 head。旧 `review-pack`/`ledger dispatch` 继续生成规格、验收与证据骨架，扩展为对抗式默认，并写入每卡 reviewer session。报告落
`statePath("ledger","reviews","<T>-r<N>")/report.md`；历史 `.md` 路径可读。verified 后自动归档和结束两类 session，先校验它们无在途回合、结果已入账、归档成功；不确定时保留 session 并告警。

## 并发、合并与外部效果

按项目配置 `maxActiveWorkers`；首个写/修派单取得卡级 worker 槽与文件锁，持续到 live/verified、整卡取消或 PM 明确释放，不随某个 dispatch intent 的 done 释放。卡已持有 worker 槽时，后续 write/fix 派单沿用该槽，跳过新占用容量检查；同一卡最多占一个槽，写入事务拒绝第二个槽。审查槽和合并槽单列。dispatch 的 done 仅代表派单回执，worker 交付以校验过的 deliver 事件为准，两者都不释放卡级锁。卡在规格中声明文件 glob、共享资源与接口。申请占槽和文件锁在台账事务内完成；不确定交集按冲突排队，不能以 git 当前无冲突代替声明。离线或租约到期只告警，不把可能仍在写的锁自动借出。依赖判定复用
`blockedBy/depViews`：code 上游到 live/verified/done 才满足，merge 不算。

合并队列把现有 `merge-queue.sh`、`deploy-full.sh` 的步骤搬进仓库，目标地址从配置注入。每项目串行：update-branch → 若 head 变，回审 → check/CI → merge → 部署 → 验证。记录候选 SHA、CI run、merge SHA、部署产物和核证事实。CI 红、
部署失败或外部结果未知时冻结队列，保留现场；不能靠超时自动重试不可逆操作。tag/release 不在自动 action 集。

## v4 DAG 与 T69

协作视图保持 v4 的大纲、因果线画布、团队区、属性区与时间轴，不改布局。现有 `task_deps` 给显式边（from/to/when/effective state 与判定事件）；`tasks` 给节点 stage、round、head；`task_steps` 与 `currentHandler` 给接手人；scheduler
intent 给当前动作/排队与具体原因；ask 给等 owner；audit finding 给异常。API 提供同一事务版本的投影与 `asOfSeq`，避免节点已前进而边仍是旧快照。回放按事件 seq 重建投影，不用临时内存游标。审查分叉只从 review 事件和实际阶段推，边仍只画任务依赖，不画派单消息；
派单/交付在团队区和时间轴显示。移动卡片或改变视图形态不在 T68。

T69 在 registry 明确标 `kind: "worker"`，用一个 manager 创建/标记入口服务手动创建、每卡 reviewer、调度助理和引擎创建的 worker。历史迁移只认明确的执行/调度角色或 `agent-task-*` 名称；单独的 `--task` 标签和 parent 不足以隐藏长驻主 agent。`kind: "main"` 是 owner 可设的显式撤标覆盖，后续 registry 写入与迁移不得重新打回。
master、PM、agent-codex 受保护。会话 API 输出 kind，Web 侧栏/会话列表/搜索默认过滤 worker，管理面板保留全部；直接 URL 与消息路由仍可访问。v4 DAG 节点和团队栏点击 worker 打开同一个会话，可看、插话、打断。待你处理的 ask 不经过该过滤，卡片点击照样进入 worker 会话。Discord 频道不变。UI PR 附前后截图，
owner 截图 ask 属上线闸。

## 分期、验收与切换

1. **PR A：台账状态与意图。** schema、任务模式、CAS、决定事件、资源占用与只读 DAG 投影；双进程争同一 intent 只成功一次。无真实 worker。
2. **PR B：规划器与模板。** 纯解释器、code/ui/security 分叉、依赖/并发、P1 三轮、跨模型校验、审查 session 绑定；快照回放同输入同计划。
3. **PR C：T69 与审查 session 编排。** 统一 worker 打标、幂等迁移、列表过滤/直达、ask 保留；每卡独立 reviewer 的创建与 verified 后安全归档。UI 前后截图。
4. **PR D：合并队列与服务。** 配置化 merge/deploy、CI/head 校验、冻结恢复、launchd 第四服务接 install/update/doctor/部署；沙箱中做崩溃恢复和假外部服务实测。
5. **PR E：worker 适配器与切换。** 待 T60 ACP 合入后接 ACP 主接口、本机 channel 回退、T48/T49/peer；先 observe，对新卡逐张开启 auto，旧卡继续 manual。重复通知、重启、断网、额度失败均以台账对账。

每个 PR 均跑 `GUARD_STRICT=1 bun run check`、相关入口构建与沙箱实测，再用一次性 `codex exec` 做一轮对抗自查；自查是开发验收，不是正式任务 reviewer。只 push 分支、开 draft PR；不合并、不动线上服务或生产库。新文件 ≤400 行、热点文件净增 ≤0，`src/lib`
只依赖 `src/lib`。切换期 `auto` 卡拒绝人工 `review --to`，但 PM 可记账暂停并接管；恢复自动前核对旧派单与外部效果。

## 已定（待 owner 复核）

- 独立 launchd scheduler 服务；install-cli/update/doctor/部署均纳入。服务故障不拖垮 bridge。
- 审查通过且 CI 绿自动合并部署。阻塞闸仅 UI 截图、tag/release、同类 P1 三轮；P2 给 PM 看 diff 但不阻塞。
- 自动卡必填作者模型家族与退路；只从新卡逐张 opt-in，在途卡不迁。
- 不清楚外部副作用是否已经发生时冻结并升级，宁可停住也不重复 merge/deploy；未知 runtime 家族不猜审查者。
- 卡级文件锁和 worker 槽持有到 live/verified 或整卡终止；单个意图结清不释放。归一 family 和沿用 findingId 之外，连续四轮任意 P1 是硬升级上限；换规格版本重新计数。
- 专用 scheduler actor 只能写调度专用命令；人工写入保留实际 actor 和 manual 标记。结果不明的 merge/deploy 即使被取消也不能自动换 key 重试，须有绑定原 intent 的 PM 明确重试决定及外部事实核对。
- 在自动重试决定的独立入口落地前，已取消的同轮 merge 一律停给 PM 手工核对并接管，调度器与台账写入口都拒绝换 key 重做。UI 合并的第二道写入闸查台账 authorize ask：owner 答复、未过期、非 guest，绑定当前 task/specRev/head/前后截图摘要；产生 ask 和投影视图的适配器仍在 PR E。
- T69 移除 worker 前的归档会复制 registry 的 kind 到归档标记；默认全文搜索读该标记过滤，显式指定 agent 仍可查。更早已移除且无标记的旧会话只按 `agent-task-*` 命名识别，不猜其他历史目录。
- 一次派多张卡给 peer 时，并发往对方项目 PM 入口投递，受本项目「对外委托槽」约束，不等待上一张完成。对方实例升级后，有常设授权且 owner 已设并发上限时，每卡自动建立一个执行 session 和一个跨模型审查 session，按本机相同模板推进；超过上限排队，前卡完成即补位。缺授权或上限时只接单排队并提示对方 owner。双实例沙箱验收：A 同时委托五张给 B，B 上限三，先起三组、后补两组。

## 进度

- 2026-09-30：v1 文档在 `74c34005`；v2 按 04:27 指示改为 ACP 主接口、v4 DAG 数据、T69、每卡跨模型对抗审查 session，并拆为五个实现 PR。
- PR A：新增台账 workflow、intent、资源占用与 v4 DAG 调度投影；新卡准入、项目事件 CAS、幂等重放、暂停取消、崩溃后的未知结果保锁均在临时库与沙箱 CLI 实测。
  一次性 Codex 对抗自查发现「glob 与实文件锁不相斥」「同任务可并存两个活跃意图」两个 P1，以及重放空白、同毫秒排序两个 P2；已逐项修复并补针对性测试。
- PR B：写入 v2 数据模板与纯规划器；新卡执行/复述/审查/修复/合并/核证/退役的每一步输出稳定意图或明确等待原因。
  审查必须绑定本卡 reviewer session、完整 head 和先前派单；P1 同类计数、第三轮升级、P2 通知 PM 后继续、UI ask 绑定及旧结果失效已做分支测试。
  一次性 Codex 自查指出旧轮派单冒认新轮、并行活跃意图两个 P1，以及历史 P1 证据和截图摘要绑定两个 P2；规划器现要求本轮派单回执、等待任何未结意图，并逐轮校验交付 head/计数、绑定截图摘要。
- PR C：registry 的唯一分类器在新建、保存与幂等迁移时标记 worker；会话列表和默认全文搜索过滤，管理面板保留全部，v4 任务详情从台账 session 绑定直接打开作者或审查员，会话 store 与待你处理直达保留原路。审查 session 在 v8 台账里按卡和角色唯一绑定，跨模型校验并持有同卡复验身份；verified 后先归档回执再停止，未知结果可凭核对回执续走。沙箱 bridge 实测迁移两次为 1/0，API 正确下发 worker/PM/codex kind。
  一次性 Codex 对抗自查找到四个 P2：归档后丢失 worker 标记、无 task.agent 的作者无法从 DAG 进入、绑定未核 intent 收件人、归档后停止前会话过早消失；均已修复并补测试。跨模型复审 r1 又要求本机 session 的家族核对 registry runtime，并让 owner 可撤误标、绑定时统一打标、管理面板可操作 worker。截图改走沙箱 headless 浏览器，不动 owner 屏幕。

- r2 修复：#233 本卡已持有槽时直接复用，台账拒绝第二槽；#235 本机 registry 优先核身份，peer transport 仅认本卡当前步骤明确委托，受保护长驻 session 在台账绑定前拒绝。最新 main 以 merge 合入，保留 T69、ACP 启动迁移与运行时归档源定位。
- PR E1：`WorkerSession` 契约（`lib/worker-session.ts`）与端口注入的适配器——Codex 走 ACP（额度/登录失败作结果上报、不重试），Claude Code 走 channel，未迁 ACP 的 Codex 才走 tmux 回退且回执必带原因，peer / Pi / 未知 runtime 退回 manual（`ledger scheduler-fallback-manual`）。台账 transport 仍记宿主形态，派单路径由 runtime+transport 推出，不加迁移。
  派单驱动先认领再投递，重启后无回执只认台账结果，否则交 PM。observe 用真实台账事实代换调度自有事实（步骤执行者即 session、PM 的 `ledger dispatch` 即派审回执）跑规划器，只写观察事件、决定不变不记；`ledger scheduler-diff` 每条一行对照 PM 实际动作。`ledger review` 增结构化结论（head/session/family/findings 四项同给）。沙箱一张 observe 卡走完交付→changes→修→pass，只有观察事件。
- E1 r1 修复（跨模型对抗审查 4 个 P1）：observe 的审查者 / session 只取结论之前的指派与 registry 当前 session，普通派审不算对抗式派审，推不出来的记「未知」；结论后没等观察就推阶段（`review --to`）一律记「未知」——当时的 session、步骤、授权台账只存现状，事后重跑会借用未来事实（r2 撤掉了回溯观察）；UI 卡只读投影真实截图 ask（开着 / 批准 / 拒绝 / 过期），owner 批准只认认证入口写的 `answer.owner` 标记（合并闸同一条）；派单在认领前核任务单、意图、卡当前版本与台账绑定的 session，消息端口带 session id，tmux 回退的每条回执（含失败）带原因。Pi 本段不自动派（缺已核实的家族配对），规格里的 Pi channel 适配顺延。
- PR E2a：新卡逐张开 auto（在途卡拒并说明，auto 退回人工须带原因），自动卡上 `review --to` 一律拒，结论只收台账绑定的 reviewer 从绑定 session 写（调用方会话取运行时环境 `CLAUDESTRA_SESSION_ID` / `CLAUDE_CODE_SESSION_ID`，registry 当前 session 与 runtime 家族、派审 head、审查目录所在 commit 都要对上），PM 要代记先退回人工；PM 用 `ledger restate-approve` 放行复述。`schedulerAutoTick` 每卡一步：先结清未结意图（pending 在事务外按「去掉本意图」重算核对，submitted 走 E1 对账），再规划执行；推阶段与截图 ask 只经 `scheduler-stage` / `scheduler-ui-ask`，两者都在写事务内重算计划、仍是同一意图才执行。作者 session = 卡上 PM 指定的执行者，reviewer = 按卡新建的跨家族 `agent-rv-<task>`，住在从执行者仓库拉出的独立 detached worktree（`statePath("worktrees","rv-<task>")`），每次派审前固定到被审 head，已跟踪文件被审查员改过就不覆盖、退回人工；权限模式仍是运行时默认（ACP 适配器写死 full-access），硬隔离留待后续；派单经 bridge 带期望 session（`expectSession`），路由时与押后补投前都按 registry 核对，换过会话就不投；只有带类型码的投递前拒绝算「没投」，其余错误一律记未知停给 PM。额度 / 登录失败（Codex 的运行时卡、Claude Code 的额度闸命中）按认领时刻归到那张派单，归不上的也退回人工并通知 PM；失联只标原因。截图 ask 过期或缺前后截图退回人工，只剩 P2 时进合并并通知 PM 看 diff。合并意图交 D 的队列；服务循环接上自动 tick 之前 `workflow-set --mode auto` 一律拒绝，D 合入后接线再放开。沙箱：两张卡由真 Claude Code 执行者与 ACP stub 审查员走到合并意图，UI 卡经 owner 设备凭据在网页端点批准；重启后零新增意图 / 事件。
