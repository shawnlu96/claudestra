# 自动开卡：先建本机作者、后放 peer 的生命周期（LIFEPRE1 设计稿）

状态：**只是设计稿**（模板 code v3，依赖 LIFE1 verified）。本稿不改运行流程、注册表、回收器、配额、worker 家族和机器设施；
发布本稿**不批准**实现、不打开任何开关、不提前收任何现有窗口（N8A8 / S2L2 的窗口等 LIFE1 按正常条件收尾，不手动 kill / force 清）。
真正实现另立规格。

依据（均按 head `6656cf46` 的代码核过）：`src/lib/scheduler-autostart-run.ts`、`src/lib/dag-tools-steps.ts`、
`src/lib/scheduler-local-runtime-start.ts`、`src/lib/scheduler-local-author.ts`、`src/lib/scheduler-auto-tick.ts`（`ensure`）、
`src/lib/scheduler-spec-resume*.ts`、`src/lib/ledger-scheduler-resume.ts`、`src/manager/create-lifecycle.ts`、
`src/lib/agent-lifecycle*.ts`、`src/lib/scheduler-agent-pool-ledger.ts`、`src/lib/scheduler-sessions.ts`、`src/lib/scheduler-retire.ts`。

## 0. 现象与核查边界

线索（只当核查线索，不当结论）：N8A8 的本机作者登记（台账事件 66722）之后，写单实际派给了 peer（Sekai）；正式卡在、`tasks.agent`
为空，那个本机窗口没有 `scheduler_sessions` 作者绑定，但 LIFE1 的 `worker_agents` 仍登记它为该卡 author；巡检把它报成「无任务」。
S2L2 同类。

本稿作者是出借 worker，手里的台账是出借方本机台账（只读查过，不含 N8A8 / S2L2）。所以 §1 给的是**由代码推出的可核合成时序**，
每一步都写明发起方台账里该看哪条记录来证实或推翻；不靠 agent 名字猜身份，也不把那个未用窗口当 peer 作者或审查来源。

## 1. 实际发生的先后（验收线 1）

### 1.1 三种记录各管什么

| 记录 | 谁写、何时写 | 说明 |
|---|---|---|
| `worker_agents`（LIFE1 登记） | `manager create --card <卡> --card-role author` **在 create 里**：预留 → 打 kind=worker → CAS 激活，写 `op=worker_register` 事件 | 只证明「这个会话是为这张卡建的」，不证明它是作者、接过单 |
| `scheduler_sessions`（调度绑定） | `ledger scheduler-session-bind`，在 `ensure` 拿到 `ready` 之后 | 调度器认定的作者 / 审查会话；`transport='peer'` 的行是 peer 作者 |
| `tasks.agent`（执行者） | start_node 的 `task-set` 步；或晚建作者的 `scheduler-autostart step … local-author` | 本机作者；peer 作者不写它 |
| 槽计数（CAP1 `workingSeats`） | 只读 `scheduler_sessions`（非 peer、未退役）、在途 `ensure_session` 意图、start_node / 本机 claim 落的 `tasks.agent` | **不读 `worker_agents`**；registry 名字也不占槽 |

`cardWorkerIndex` 按 `worker_agents` > `scheduler_sessions` > `tasks.agent` 合并，因此一个只有登记行的 agent 在索引里就是「该卡 author」，
即便它从没接过单。

### 1.2 三条开卡路径的调用序

**A. 自动开卡当场选 peer**（`autostartTick → localAutostartNode → openCard → runStart`）：preflight 选 peer → claim 带 `--peer` →
`task-new → workflow-set auto → restate 跳过（decision + stage spec→restate）→ dag-bind`。**这条路径不建本机 agent**，不会出现本问题。

**B. 自动开卡当场选本机**（`runStart` 本机分支）：`task-new → worktree → prompt → agent（manager create，LIFE1 登记）→ task-set → workflow-set auto → dag-bind`
（`dag-tools-steps.ts` `agentSteps` / `cardSteps` / `runStart`）。agent 步把结果分两类：

- **B-owned**：回执名 = 预检名、registry 里有、create 前没有 → `owned`。之后任一步失败，`rollback` 逆序 undo：kill 这个 agent、
  workflow / task-new 的 undo 把卡退人工并取消。不会留下「卡活着、agent 空、登记在」。
- **B-unknown**（本问题的第二条可达路径）：create 实际完成了 LIFE1 登记，但回执超时 / Promise 抛错 / 回执名对不上，而 registry 里有这个名字
  → `unknown`，agent 步失败且 `holds()` 非空。`runStart` 只把**当前这一步**交给 rollback（agent 的 undo 对 unknown 不 kill），
  其余已做的 `task-new`、`worktree`、`prompt` 一律记成 leftovers「没撤」；`task-set`、`workflow`、`bind` 还没执行。
  结果：**活的 spec 卡（无 workflow 行，即非 auto）、`tasks.agent` 空、已登记的本机窗口**，claim 被 `settle --outcome failed`
  并通知 PM（`scheduler-autostart-run.ts` `fail`）。`tests/dag-tools-start-identity.test.ts`「create 已登记」两例覆盖回执超时与抛错后保全活卡。

| # | B-unknown 之后 | 发起方台账里核什么 |
|---|---|---|
| B1 | 自动开卡 claim | `op=autostart_claim`（`taskId`） |
| B2 | agent 步 create：LIFE1 预留 → 激活 | `op=worker_register`（actor=scheduler，`card`=该卡） |
| B3 | 回执丢失/抛错，registry 有名 → unknown，只撤当前步 | `op=autostart_settle outcome=failed failedStep=agent`，`leftovers` 含「没撤（agent … 归属不明）」 |
| B4 | PM 收到失败通知后对卡 `workflow-set --mode auto`（或 `workflow-resume`） | `op=workflow mode=auto`（这一条让 `specSince` 重新起算） |
| B5 | 下一轮 `specResumeTick`：卡 spec/auto、无绑定、`tasks.agent` 空、claim 已结清 → 放行，`startPlacement` 给 peer | `op=spec_placement`，stage spec→restate |
| B6～B8 | 同下表 C8、C9 | 同 C8、C9 |

**C. 晚建本机作者 + 后放 peer**（第一条可达路径）：

| # | 动作 | 代码 | 发起方台账里核什么 |
|---|---|---|---|
| C1 | 卡处于 spec、auto，规划出本机 `ensure_session`（复述节点要本机作者） | planner；`scheduler_intents` | intent 行：`action=ensure_session`、`node`、`status` 变化 |
| C2 | 认领：`pending→submitted`，开始建 | `scheduler-auto-tick.ts ensure` | intent `receipt` 含 `claimed; ensure author <家族>` |
| C3 | `ensureLocalAuthor → launch`：worktree、`manager create --card --card-role author` | `scheduler-local-author.ts` | `op=worker_register` 事件（线索里的 66722 应是这一条），actor=scheduler |
| C4 | 等 registry 出 sessionId（≤90 s），再核目录/项目/家族，写 `local-author` step（`tasks.agent`） | 同上 | 有没有 `local-author` step 事件；`tasks.agent` 是否被写过 |
| C5 | C4 任一处没走完：guard 抛错（意图或卡变了、`extra.placement` 变 peer、配置变）、90 s 没 session、目录不符、写回失败 | 同上 | intent 停在 `submitted`，租约到期后被结成 `unknown`（「已认领建 session，但台账没有绑定；不重建，交 PM 核对」）；或直接 `unknown` 回执 |
| C6 | 有人对账：`scheduler-settle` 把 unknown 结掉，或转人工后 `workflow-resume` 交回自动（resume 要求没有 submitted/unknown 意图） | `ledger-scheduler-resume.ts` | `scheduler-settle` / `op=workflow_resume` 事件 |
| C7 | `specResumeTick`：`specPlaceBlock` 只看 `scheduler_sessions` 作者绑定、`dag-start:*:task-set`、peer 租约 / 单、在途意图——**不看 `worker_agents`**，于是放行 | `scheduler-spec-resume*.ts` | `op=spec_placement` decision、stage spec→restate「远端卡复述跳过」 |
| C8 | 写单派给 peer（Sekai），peer 作者绑定 `transport=peer` | lend 派单 | `lend_orders`、`lend_write_leases`、`scheduler_sessions(transport=peer)` |
| C9 | 本机窗口：没有绑定、没有 `tasks.agent`、没收过单；LIFE1 仍按登记认它是 author；卡在 restate/build，不满足任何回收规则 | `agent-lifecycle.ts` | `worker_agents` active 行；巡检「无任务」 |

结论：根因是**两份身份记录不同步**——LIFE1 登记在 create 里就落定（B2 / C3），调度器的作者认定（`tasks.agent` / 绑定）晚一步写；
中间一断，放置门（B5 / C7）只看后者，就会在本机登记仍在的情况下把作者放到 peer。N8A8 / S2L2 是 B-unknown 还是 C5 的哪一个分支、
B4 / C6 是谁做的，要在发起方台账按两张表逐条核实（区分点：有没有 `autostart_settle failedStep=agent`，还是 `ensure_session` intent）；
两条都核不上，本稿 §2 不适用，须重开本稿。另一个相邻缺口：PM 用 `task-set --agent` 认领本机窗口后，现有 `specPlaceBlock` 只认
`dag-start:*:task-set` 写的 `tasks.agent`，仍会放 peer（§2 放置门一并覆盖）。

### 1.3 这时三个计数各说什么

- 登记卡归属：`cardWorkerIndex` 认它为该卡 author（source=`worker_agents`）。
- 实际作者身份：peer 作者（`scheduler_sessions` transport=peer）。本机窗口**不是**作者，也不能当审查来源。
- 槽计数：C5 意图 `unknown` 期间算 `creating:` 占一个本机座位；对账结成 cancelled 后不再算。B-unknown 从头就不占座（没有 intent、
  没有 `tasks.agent`）。两种情况窗口物理上都还在跑，本机槽池**少算一个真实窗口**。

## 2. 两种窄方案与取舍（验收线 2）

**方案 P（选它）：peer 放置已合法确定时不建本机作者；本机作者登记未了结时不放 peer。** 两道门都在现有判断点上加读，
不加执行器；每道门的「拦下之后谁接」都落到现有、会通知 PM 的出口上。

1. **建前门**（C3 之前：`launch` 里 `claimed()` 取得 intent 之后、`checkout` / `manager create` 之前）。**只作用于未固定放置的卡**：
   `extra.placement` 缺省 / 非 `local`、非 `peer:*`。
   - `local` 固定：start_node 的显式选择优先，`specPlaceBlock` 本就以「start_node 已固定放置」拒接，建前门**不判**，照旧建本机。
   - `peer:*` 固定：现有 `claimed()` 已拒，不变。
   - 未固定：同一端口算 `startPlacement(auto)`；给 `peer` **且** `specPlaceBlock(db, task, wf, { ignoreIntent: intent.id })` 为 null
     （即撤掉这条 ensure 后下一轮 `specResumeTick` 确实会接手）才返回 `wait`（intent cancelled）。否则（`specPlaceBlock` 另有阻塞、
     或 placement 是 local / refused）照旧建本机——不会出现「门让开、放置也不接」的空转。
   - 去重：让开时 intent 结成 cancelled，回执固定以「建前门：」开头（持久在 `scheduler_intents`）。再到建前门时，若本卡同 `specRev`
     已有这样一条 cancelled `ensure_session` 且其后没有 `op=spec_placement`，第二次不再让，照旧建本机，并记一条 `local_author_gate` note
     （同 specRev 只记一次）。判据全在台账，重启不丢；至多多等一轮。
2. **放置门**（B5 / C7）：`specPlaceBlock` 增一类「**待 PM**」阻塞——本卡有本机作者身份但调度器未认定：
   `cardWorkerIndex` 里 `worker_agents` 来源的活 author，其会话不在任何本卡 `scheduler_sessions` 绑定里；或 `tasks.agent` 非空且不是
   `dag-start:*:task-set` 写的（PM 手工认领）。返回值分 `{ kind: "hold", reason, agent, sessionId }` 与原有字符串两类。
   - 原有字符串仍静默跳过（下一轮重算）。
   - `hold`：`placeOne` 不再返回 null，而是调用现有 `ledger scheduler-fallback-manual <task> --reason "本机作者登记未了结：<agent>/<session>"`，
     `duplicate !== true` 时 `notifyPm` 一次。fallback 在事务里把卡转 manual、取消 pending intent、按 `workflow.rev` 去重；
     卡转 manual 后不再是 spec/auto 候选，不会每轮重复。写口 `scheduler-spec-place` 事务里重核到 `hold` 同样回 conflict，不落 peer。
   - PM 的恢复动作都是现有命令：(a) 认它为作者：`ledger task-set <task> --agent <agent>` 后 `workflow-resume`；
     `ensure` 见 `tasks.agent` 在 registry 就走 `refOf` 绑定，放置门因 `tasks.agent` 非空继续拦 peer，卡走本机复述。
     (b) 不认、要放 peer：需新增一条 PM 豁免记录（§3 接口缺口），本稿不造；豁免前卡停在 manual，窗口不动，等 PM。

**方案 Q（不选）：真实放置变化后按唯一入口处理未用窗口。** 放到 peer 后再收本机窗口，要在卡未完结时退掉一条登记。现有入口都做不到
（§3）：要么新增退役规则 + 审批，要么误杀可能仍在工作的 unknown 会话。它修的是后果，C 路径照样每次多建一个窗口。

方案 P 带来的新问题与处理：

| 情形 | P 下的行为 | 可恢复 / 无双作者 / 无漏登记 / 保全来源 |
|---|---|---|
| placement 失效（预留过期、peer 槽被占） | 建前门拿到 `refused`/`local` 就照旧建本机；已放 peer 的卡按现有 lend 重派 / 回收路径 | 本机与 peer 不同时成立；登记只在真建时写 |
| `local` 固定卡 | 建前门不判；放置门不改「start_node 已固定放置」 | 与今天逐字一致，start_node 的选择优先 |
| 建前门让开后放置没落 | 第二次照旧建本机，记 note | 不空转；最多多等一轮 |
| 授权撤销 | `startPlacement` 不再给该 peer → 建前门放行本机建 | 撤销前已派的单走现有 lend 回收，本稿不改 |
| peer 不可达 | 同上，按现有放置重试 / 冷却；不会因「可能放 peer」卡死本机 | 放置门只拦「有未了结本机登记」，不拦本机正常建 |
| 并发开卡（两轮 tick / start_node 与自动） | 建前门与放置门都在调度租约内、放置写在 `scheduler-spec-place` 事务里重核 `specPlaceBlock` | 同一卡两门互斥：有活登记就不放 peer，已 pin peer 就不建本机 |
| 重启 | 进程内状态不参与判定：两门只读台账（`worker_agents`、`scheduler_sessions`、intents 含「建前门：」回执、`extra.placement`、`local_author_gate` note） | 重启后同一判断；C5 的 unknown 仍交 PM，不重建 |
| PM 如何获知 | C5：现有 `unknown` 只 held 不通知，本稿不改；它被 settle / resume 后进放置门 → `hold` → fallback-manual + 一次通知。B-unknown：开卡失败通知 + resume 后同一 `hold` 出口 | 每次交回自动至多一次转人工、一次通知（按 workflow.rev 去重） |
| 已存在的 N8A8 / S2L2 窗口 | 放置门只影响**今后**的放置；已放 peer 的卡不回滚、窗口不动 | 等 LIFE1 正常条件（卡完结或 merge/live/blocked 且空闲）收 |

## 3. 早于终态回收的审批与接口缺口（验收线 3）

本稿不要求早收。若未来要在卡完结前收未用窗口，缺口如下（**均未实现，本稿不造**）：

- `scheduler-session-retire` 不适用：它要求卡在 `RETIRE_STAGES`（verified/cancelled）、有 `action=retire` 的本卡意图、且存在
  `scheduler_sessions` 行；未用窗口三者都没有。不能假设它能 kill 未结绑定。
- LIFE1 `planLifecycle` 没有「卡未完结、作者从未接单」的规则：作者只在 merge/live/blocked 且空闲时收，内存兜底跳过 restate/build/review/fix。
  要收须新增一条规则，执行仍走唯一入口 `runLifecycle`（核会话 → archive → `manager remove` → 自身 checkout → 临时目录）和
  `ledger scheduler-worker-retire` 记账，不另造 kill / archive 执行器。
- 证据缺口：「从未用过」要有可证事实（该会话无任何派单回执、`idleMs` 已知、无 live turn、非 lend worker、会话与登记一致、
  无 ask / 待交副作用）。任一为 unknown 一律保留。
- 审批缺口：缺一条按 agent+session 的 PM 批准记录（现有命令里没有）；无批准不收。
- 豁免缺口（§2 放置门恢复 (b)）：缺一条 PM 写的「本卡不认此本机登记为作者」记录（建议 `ledger spec-place-waive <task> --agent --session`，
  PM / owner 身份，写 decision 事件）；放置门见到同一 agent+session 的豁免才放行。它只解除放置门，不收窗口；窗口仍等 LIFE1 终态。
- 诊断必须从真实 `cardWorkerIndex` 查卡；不得为消巡检重建卡、改 `tasks.agent` 或补写绑定。

## 4. 实现草案（验收线 4，另立规格时用）

**开关**：`scheduler.json` 项目级 `peerAuthorGate: "off" | "observe" | "on"`，缺省 `observe`（与 LIFE1 `lifecycle` 同口径）。
- off：逐字等于今天。
- observe：两门只算不拦，命中时记一条去重的 note（卡 + agent + 会话 + 哪道门），不调 fallback-manual；巡检把「无任务」改报为「本机作者登记未了结，卡已放 peer」。
- on：两门生效。

**拟改文件（预算）**：

| 文件 | 改动 | 预算 |
|---|---|---|
| `src/lib/scheduler-spec-resume-write.ts` | `specPlaceBlock` 增 `hold` 类（读 `cardWorkerIndex` + 非 start_node 的 `tasks.agent`）、`ignoreIntent` 选项；写口重核 | ≤ 30 行 |
| `src/lib/scheduler-spec-resume.ts` | `placeOne` 遇 `hold` → `scheduler-fallback-manual` + 去重 `notifyPm` | ≤ 15 行 |
| `src/lib/scheduler-local-author.ts` | 建前门：仅未固定卡；peer 且 `specPlaceBlock(ignoreIntent)` 为 null 才 `wait`；二次不让 + note | ≤ 30 行 |
| `src/lib/scheduler-auto-deps.ts` | 把放置端口（`specResume` 同一份 `place`）接进 `LocalAuthorEnv` | ≤ 10 行 |
| `src/lib/scheduler-config.ts` | 三态开关解析 | ≤ 15 行 |
| 巡检 / 侧栏读侧（LIFE2 所用读者） | 只改文案分类，数据仍出自 `cardWorkerIndex` | ≤ 15 行 |
| `tests/` 对应文件 | 下表反例矩阵 | — |

**共存**：旧路径 A/B 不变；CAP1 统一家族池与 `workingSeats` 不改（observe 只报「物理窗口多于座位」，不改计数）；LIFE1 的登记、索引、
回收规则与执行入口不改；LWR1（终态出借 worker 归档）scope 不吸收本问题。

**真实 CLI 反例矩阵**（实现单在沙盒台账上逐条跑，断言台账结果）。生产顺序是同一 pass 里 `specResumeTick` 先于 `schedulerAutoTick`：
普通 spec/auto 卡在 peer 有空位时会先被放置，根本到不了 `ensure`——那是 baseline（第 0 行），不是建前门的反例。
建前门反例必须先让一条 pending `ensure_session` 挡住 `specResumeTick`，再让放置变化。

| # | 前置状态与命令序 | 期望（on） | 期望（observe） |
|---|---|---|---|
| 0 | baseline：spec/auto 卡、无 pin、peer 有空位 → `scheduler` 一轮 | `spec_placement peer`、stage restate、0 次 `manager create` | 同 on（两门都未触发、无 note） |
| 1 | 无 pin；peer 满。以调度身份 `ledger scheduler-plan <task> --node restate --action ensure_session --rev … --workflow-rev … --seq …` 落 pending intent（等价于上一轮 `specResume` 得 local、`autoTick` 计划了 ensure 尚未认领）；释放 peer 槽（结清占槽的 `lend_orders` / 预留）→ `scheduler` 一轮：`specResume` 因 pending intent「已在途」跳过，`autoTick` 重算同一计划并认领 ensure | 建前门 `wait`，intent cancelled，0 次 `manager create`；第三轮 `spec_placement peer` | 第二轮照旧 `manager create` + 绑定；note「建前门命中」；不放 peer |
| 1L | 同 1，但卡 `extra.placement=local`（start_node 固定） | 照旧建本机；无 note；`specResume` 始终「已固定放置」 | 同 on |
| 1Q | 同 1，但 `queueFrozen` 在第二轮前冻结后又解冻（`specPlaceBlock` 另有阻塞） | 建前门不让，照旧建本机 | 同 on |
| 1R | 同 1，建前门让开后、第三轮前 peer 槽又被占 → 放置得 local，autoTick 再计划 ensure，peer 又空 | 第二次到建前门不再让，建本机，记一次 `local_author_gate` note | 同 1 observe |
| 2 | C 路径：同 1 的前置但 peer 一直满；ensure 中 `manager create` 成功、`local-author` 写回失败 → intent unknown → `scheduler-settle` → PM 放开 peer 槽 → `workflow-resume` → 一轮 | `scheduler-fallback-manual` 落「本机作者登记未了结」，PM 收到一次通知；无 `spec_placement` | 放 peer；note + 巡检新文案；不转人工 |
| 2B | B-unknown：自动开卡本机分支，`manager create` 已登记但回执超时（`CREATE_TIMEOUT_MS` 桩）→ `autostart_settle failed failedStep=agent` → PM `workflow-set --mode auto` → 一轮 | 同 2 on | 同 2 observe |
| 2D | 2 之后 PM 再 `workflow-resume` 一次（未处理） | 新 workflow.rev 再转人工一次、通知一次；同 rev 重放 `duplicate=true` 不重发 | 不转人工 |
| 3 | 同 2，PM 走 `task-set --agent <该窗口>` 再 `workflow-resume` | 放置门因 `tasks.agent` 拦 peer；`ensure` 走 `refOf` 绑定，本机复述 | 放置门不拦，照现有缺口放 peer；记 note（off 与 head 一致） |
| 4 | 卡已 `extra.placement=peer:X` | 建前门拒建（现状即如此） | 同 |
| 5 | 授权撤销 / peer 下线后同 1 | 建本机，正常登记 + 绑定 | 同 |
| 6 | 两个 tick 并发、start_node 并发 | 只有一方成功；无双作者 | 同 |
| 7 | 调度服务在 C3 与 C4 之间重启 | 重启后 intent → unknown → PM；不重建、不放 peer | 放 peer 前记 note |
| 8 | 对 2 的窗口跑 `scheduler-session-retire` | 拒（不在 RETIRE_STAGES / 无绑定） | 同 |
| 9 | LIFE1 `lifecycle` observe 跑一遍 | 未用窗口不进 actions（卡未完结） | 同 |
| 10 | 开关 off | 与 head 逐字一致（快照测试，含 1、2、2B、3） | — |

**验收（实现单）**：`bun run check`、guard 严格模式、入口 build、PR 准确 head 的全量 CI 绿，独立跨家族审查；推演与测试不得声称
生产回收已执行。

## 5. 上线后（PM）

本稿发布不批准实现、不开开关、不退役任何当前 N8A8 / S2L2 窗口。现有窗口等 LIFE1 正常条件收尾，不手动 kill / force 清理。
