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

### 1.2 两条开卡路径的调用序

**A. 自动开卡当场选 peer**（`autostartTick → localAutostartNode → openCard → runStart`）：preflight 选 peer → claim 带 `--peer` →
`task-new → workflow-set auto → restate 跳过（decision + stage spec→restate）→ dag-bind`。**这条路径不建本机 agent**，不会出现本问题。

**B. 自动开卡当场选本机**：`… → worktree → manager create（LIFE1 登记）→ task-set agent → workflow → bind`。`task-set` 失败时回滚会
kill 本次确认建的 agent（`owned`），归属不明的留 `unknown`，卡被回滚取消。也不产生「卡活着、agent 空、登记在」。

**C. 晚建本机作者 + 后放 peer**（本问题的唯一代码可达路径）：

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

结论：根因是**两份身份记录不同步**——LIFE1 登记在 create 里就落定（C3），调度器的作者认定（C4 / 绑定）晚一步写；中间一断，
放置门（C7）只看后者，就会在本机登记仍在的情况下把作者放到 peer。N8A8 / S2L2 是否正是 C5 的哪一个分支、C6 是谁做的，要在发起方台账
按上表逐条核实；如果核出来不是 C 路径，本稿 §2 的方案不适用，须重开本稿。

### 1.3 这时三个计数各说什么

- 登记卡归属：`cardWorkerIndex` 认它为该卡 author（source=`worker_agents`）。
- 实际作者身份：peer 作者（`scheduler_sessions` transport=peer）。本机窗口**不是**作者，也不能当审查来源。
- 槽计数：C5 意图 `unknown` 期间算 `creating:` 占一个本机座位；对账结成 cancelled 后不再算——但窗口物理上还在跑，
  本机槽池此时**少算一个真实窗口**。

## 2. 两种窄方案与取舍（验收线 2）

**方案 P（选它）：peer 放置已合法确定时不建本机作者；本机作者登记未了结时不放 peer。** 两个方向各一道门，都在现有判断点上加读，
不加执行器：

1. 建前门（C3 之前）：`ensureLocalAuthor` 的 `claimed()`/guard 已拒 `extra.placement=peer:*`；再加一条——这张 spec/auto 卡此刻
   `startPlacement` 给出 `peer`（有效预留、授权内）就不建，返回 `wait`（意图 cancelled，下一轮由 `specResumeTick` 放 peer）。
2. 放置门（C7）：`specPlaceBlock` 增读 `cardWorkerIndex`：本卡有 `worker_agents` author 活登记、且其会话不在任何 `scheduler_sessions`
   绑定里 → 返回「本机作者登记未了结」，不放 peer、不派复述单，转 PM 对账（与 C5 的 unknown 同一个出口）。
   PM 的出口只有两个现有动作：认它为作者（走现有绑定 / `task-set`），或等 LIFE1 正常收尾后再交回自动。

**方案 Q（不选）：真实放置变化后按唯一入口处理未用窗口。** 放到 peer 后再收本机窗口，要在卡未完结时退掉一条登记。现有入口都做不到
（§3）：要么新增退役规则 + 审批，要么误杀可能仍在工作的 unknown 会话。它修的是后果，C 路径照样每次多建一个窗口。

方案 P 带来的新问题与处理：

| 情形 | P 下的行为 | 可恢复 / 无双作者 / 无漏登记 / 保全来源 |
|---|---|---|
| placement 失效（预留过期、peer 槽被占） | 建前门拿到 `wait`/`local` 才建本机；已放 peer 的卡按现有 lend 重派 / 回收路径 | 本机与 peer 不同时成立；登记只在真建时写 |
| 授权撤销 | `startPlacement` 不再给该 peer → 建前门放行本机建 | 撤销前已派的单走现有 lend 回收，本稿不改 |
| peer 不可达 | 同上，按现有放置重试 / 冷却；不会因「可能放 peer」卡死本机 | 放置门只拦「有未了结本机登记」，不拦本机正常建 |
| 并发开卡（两轮 tick / start_node 与自动） | 建前门与放置门都在调度租约内、放置写在 `scheduler-spec-place` 事务里重核 `specPlaceBlock` | 同一卡两门互斥：有活登记就不放 peer，已 pin peer 就不建本机 |
| 重启 | 进程内状态不参与判定：两门只读台账（`worker_agents`、`scheduler_sessions`、intents、`extra.placement`） | 重启后同一判断；C5 的 unknown 仍交 PM，不重建 |
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
- 诊断必须从真实 `cardWorkerIndex` 查卡；不得为消巡检重建卡、改 `tasks.agent` 或补写绑定。

## 4. 实现草案（验收线 4，另立规格时用）

**开关**：`scheduler.json` 项目级 `peerAuthorGate: "off" | "observe" | "on"`，缺省 `observe`（与 LIFE1 `lifecycle` 同口径）。
- off：逐字等于今天。
- observe：两门只算不拦，命中时记一条去重的 note（卡 + agent + 会话 + 哪道门），巡检把「无任务」改报为「本机作者登记未了结，卡已放 peer」。
- on：两门生效。

**拟改文件（预算）**：

| 文件 | 改动 | 预算 |
|---|---|---|
| `src/lib/scheduler-spec-resume-write.ts` | `specPlaceBlock` 增「未了结本机作者登记」一条（读 `cardWorkerIndex`） | ≤ 20 行 |
| `src/lib/scheduler-local-author.ts` | 建前门：注入的放置端口给 peer 时返回 `wait` | ≤ 25 行 |
| `src/lib/scheduler-auto-deps.ts` | 把放置端口接进 `LocalAuthorEnv` | ≤ 10 行 |
| `src/lib/scheduler-config.ts` | 三态开关解析 | ≤ 15 行 |
| 巡检 / 侧栏读侧（LIFE2 所用读者） | 只改文案分类，数据仍出自 `cardWorkerIndex` | ≤ 15 行 |
| `tests/` 对应文件 | 下表反例矩阵 | — |

**共存**：旧路径 A/B 不变；CAP1 统一家族池与 `workingSeats` 不改（observe 只报「物理窗口多于座位」，不改计数）；LIFE1 的登记、索引、
回收规则与执行入口不改；LWR1（终态出借 worker 归档）scope 不吸收本问题。

**真实 CLI 反例矩阵**（实现单在沙盒台账上逐条跑，断言台账结果）：

| # | 构造 | 期望（on） | 期望（observe） |
|---|---|---|---|
| 1 | spec/auto 卡，peer 有空位 → `scheduler` 一轮 | 不调 `manager create`；`ledger scheduler-spec-place --peer` 落 | 照旧建本机；记一条 note |
| 2 | `manager create --card T --card-role author` 成功后 `local-author` 写回失败 → intent unknown → `scheduler-settle` → `workflow-resume` | `scheduler-spec-place` 回 conflict「本机作者登记未了结」 | 放 peer；note + 巡检新文案 |
| 3 | 同 2，但 PM 走 `task-set --agent` 认领 | 走本机绑定，不放 peer | 同 on |
| 4 | 卡已 `extra.placement=peer:X` | 建前门拒建（现状即如此） | 同 |
| 5 | 授权撤销 / peer 下线后同 1 | 建本机，正常登记 + 绑定 | 同 |
| 6 | 两个 tick 并发、start_node 并发 | 只有一方成功；无双作者 | 同 |
| 7 | 调度服务在 C3 与 C4 之间重启 | 重启后 intent → unknown → PM；不重建、不放 peer | 放 peer 前记 note |
| 8 | 对 2 的窗口跑 `scheduler-session-retire` | 拒（不在 RETIRE_STAGES / 无绑定） | 同 |
| 9 | LIFE1 `lifecycle` observe 跑一遍 | 未用窗口不进 actions（卡未完结） | 同 |
| 10 | 开关 off | 与 head 逐字一致（快照测试） | — |

**验收（实现单）**：`bun run check`、guard 严格模式、入口 build、PR 准确 head 的全量 CI 绿，独立跨家族审查；推演与测试不得声称
生产回收已执行。

## 5. 上线后（PM）

本稿发布不批准实现、不开开关、不退役任何当前 N8A8 / S2L2 窗口。现有窗口等 LIFE1 正常条件收尾，不手动 kill / force 清理。
