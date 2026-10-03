# 团队视图 ↔ 本机协作视图 1:1 核对与实施规格（team-parity-P1）

> 规格 specRev 1 · 基线 `a538824a` · r1、r2 按审查修订（见 §8）· 只读核代码，本页是唯一改动；产品代码一行没改。
> 目的：说清"同一个已授权 Feature，团队视图和本机视图哪些已经一样、哪些不一样、为什么不一样"，
> 再把差异拆成能直接派单的小节点。差异分三种处理：缺数据就补契约；中心已经有数据就补读口和适配；
> 权限不同的照常不开放，但要明确显示"仅主场可见"，不能用空白或 0 冒充，也不能当 bug 修。

---

## 0. 结论速览

1. **UI 已经是同一个**：`CollabView` 只换数据源（`team-source-context.ts` 的 `CollabSourceContext`），没有第二套 UI。
   差距不在组件里，而在 **数据契约、适配器和几条没走注入、直接调本机接口的旁路**。
2. **团队视图里有假数据和误调用（F 类，见 §3），应先修**：
   - 「今日完成」按 feature 镜像的 `observedAt` 算，不是按任务完成时间算：只要镜像今天刷新过，就会多数（§3 行 M3）；
   - 「在场 agent」「待你处理」在团队视图里固定显示 **0**，实际是「不知道」（§3 行 M1、W1）；
   - 依赖边的「谁建于何时」显示的是 feature 最后修改人（`feature.updatedBy`），归属不对（§3 行 G4）；
   - 用 `shared-ledger:{…}` 这种团队键去请求本机接口：`/me/last-seen/…`（GET+PUT，已在浏览器里实测到）、
     `/ledger/…/work`（谁在干活）、`/team/activity?project=…`（团队标签，代码路径证明）。
3. **中心已经存了、读口却没给（C 类）**：DAG 的全部历史版本和改图原因（`dag_versions` / `source_dag_mirrors`）、
   执行镜像事件（`source_event_mirrors`，只有 type/at）、中心事件流水（`events`：kind/actor/at）。
4. **读口已经给了、适配器却丢了（B 类）**：`TaskProjection.assigneeCode / steps / asks / head / executorInstanceId`，
   以及 `Feature.status / counts / projection` 的新鲜度。这些可以马上补，不用等中心。
5. **契约里本来就没有（D 类）**：阶段时间线、`stageSince`、完成时刻、轮次、审查结论计数、指标、处理人角色、
   版本的提出人/批准人/时间、执行者会话。要扩投影契约，导出端和中心都要改。导出端在公开仓库，
   中心实现在私有的 floka-ai/cloud，前置是 CL1 固定 gitlink。
6. **权限不同、按设计不开放（E 类）**：规格全文（`fullText: "home_only"`）、审查原文 / 事件原文、执行者会话日志、
   「对它说」「打开会话」、开卡 / 绑卡 / 阶段 / 审批（capabilities 置灰）、owner 消息。
7. **现有截图对照会把差距掩盖掉**：`tests/web-shared-ledger-browser.test.ts` 喂给"本地"那一侧的 DAG / 产品 / 任务详情，
   也是从团队数据推出来的（`teamDagBoard`、`sharedProductBoard`、`events: [] / timeline: []`），
   本地夹具同样 `agent: null`、`metrics: {}`，所以两边截图一致不能证明 1:1。§4 用独立夹具重测了一遍。
8. **第一批马上可以开写（不依赖 CL1、不改契约）**：P1-A（去掉误调用、假 0 和假「今日完成」，并声明未知 / 仅主场的类型）、
   P1-B（用上已经读到的字段、边归属改成「未记录」）、P1-C（真正"同一份数据双喂"的对照夹具）、
   P1-I（权限差异显式化 + 脱敏事件不再显示 undefined / 假「失败」）。A、C 立刻可写，B、I 等 A 合并（类型 + 串行文件，§5.0）。
   需要 PM 拍板的是 P1-D（V1 冻结契约做只增不改的读口扩展）和 P1-G（审查计数能不能出境）。
   扩展数据从中心回到浏览器走 P1-K 的独立读口（r2 补），不改冻结的 `features/{id}` 响应。

---

## 1. 依据、边界与假设

- **只读**：读了 `web/features/collab/**`、`web/lib/api/{ledger,shared-ledger,work-board,product-board,ledger-done}.ts`、
  `src/lib/shared-ledger-{contract,projector,scrub,export}.ts`、`src/shared-ledger/{reads,projections,commands,migrations,service}.ts`、
  `src/bridge/local-api/{shared-ledger,last-seen}.ts`、`docs/design/shared-ledger*.md`、`docs/team/collab-view-v4.md`
  和现有测试。没读生产 registry / 台账 / 认证 / Keychain，没连生产 bridge，没把任何截图传到外部。
- **证据等级**：§3 每一行都给出"文件 + 符号"作为代码证据；做过浏览器实测的单独标「实测」（§4），
  没实测的写「代码路径证明」或「未验证」。
- **CL1 / floka-ai/cloud 的理解**：规格要求私有中心的实施节点标 `floka-ai/cloud`，前置是"CL1 固定 gitlink"
  （把私有中心以固定提交的 gitlink 引入，用于契约联调）。本仓库 `docs/architecture/lend-claude-workers.md` 里的
  `i28-CL1` 是另一个意思（出借 Claude worker），**和这里无关**。本仓库 `src/shared-ledger/*` 是参考 / 测试用中心，
  本方案**不在这里实现中心新功能**，测试只用回环假服务器。如果 PM 对 CL1 的指代另有定义，以 PM 为准，节点依赖不受影响。
- **契约冻结**：`src/lib/shared-ledger-contract.ts` 开头写明是 "Frozen V1 wire contract"。scrub 遇到未知字段会拒绝上传
  （`shared-ledger-scrub.ts`："Unknown field names may themselves contain a secret"）。所以投影只能**加可选字段，
  并且只有中心在新的 `ext-capabilities.uploads` 里声明能收之后才发**，不能直接往 V1 里加字段（否则老中心会拒收整包，导致现有公开数据降级）。

---

## 2. 两条数据链路逐段对照

| 段 | 本机 Source | TeamSource |
|---|---|---|
| 注入 | 没有 Provider 时由 `useCollabSource` 回落到 `localCollabSource(project)`（`team-source.ts`） | `TeamSource → Session`（`shared/team-ops.tsx`）把 `sharedCollabSource(...)` + `ops` 放进 `CollabSourceContext` |
| 项目键 | 本机项目 id | `sharedCollabProject(identity)` = `"shared-ledger:" + JSON`（`team-source-key.ts`） |
| 总览 | `fetchLedger` → `GET /ledger/:p?dayStart=`（bridge T8c） | `session.list()` + `session.detail(id)` → `teamOverview()`（`team-source-adapter.ts`） |
| 任务详情 | `fetchLedgerTask` → `{task, events, timeline, steps?, stepLine?, sessions?}` | `teamTaskDetail()` 固定返回 `{task, events: [], timeline: []}` |
| 实时 | `followCollabEvents` → `/events?types=ledger,tool_*,agent_status,bg_task_*` | 每 5s 轮询 list，`serverSeq` 变了才发一条合成的 ledger 事件；没有 tool / agent / bg 事件 |
| DAG 看板 | `fetchDagBoard` `/ledger/:p/dag` | `teamDagBoard()`（`team-source-dag.ts`），`agents: []` |
| DAG 版本 | `fetchDagFeature` `/ledger/:p/dag/:f?version=` → `versions[]` + `snapshot` | `teamDagFeature()`：`versions: []`、`snapshot: null`；请求非当前版本时抛 "Shared historical snapshots are unavailable" |
| DAG 对比 | `fetchDagDiff` | 直接抛 `'Shared version comparisons are unavailable'`；`use-dag-board.ts:88` 只 `console.warn`，叠图不出（r1 更正：英文不进 UI） |
| 产品看板 | `fetchProductBoard` | `sharedProductBoard()`（`dag/shared-product-model.ts`），`cards: []`、`active: 0`、`eta: null` |
| 谁在干活 | `fetchWorkBoard` `/ledger/:p/work`（`work/use-work-board.ts`，**没走注入**） | 同一路径，`p` 变成团队键 → 本机 bridge 返回 404/403，卡在重试 |
| 上次以来 | `fetchLastSeen` / `markLastSeen` `/me/last-seen/:p`（`use-collab-extra.ts`，**没走注入**） | 同一路径用团队键：**实测** GET+PUT 都打到本机，bridge 判 `ledgerProjectExists` 后返回 404 |
| 审查员信号 | `fetchBgTasks(pm)`（`useReviewers`，按 `ov.meta.pms`） | `meta.pms: []`，不发请求（没有数据，但也不误调） |
| 待你处理 | `useAsks()` 按 `a.project === project` 过滤（`collab-view.tsx`） | 团队键永远对不上 → 恒为 0 |
| 成员 / 在场 | registry 里 `a.projectId === project` 的 agent + 缓存总览里的 agent / pm | 团队键对不上，任务的 `agent/pm` 又都是 null → 空集 → 「在场 agent 0」 |
| 团队标签 | `TeamPanel`：`/peers/contacts`、`/team/quota`、`/team/activity?project=` | 同一组本机接口，`project` 是团队键；显示的是**本机**的 peers/额度，不是团队成员 |
| 团队特有 | — | 「团队规划」（新建 / 编辑规划 / 409 重放 / 回执）、「团队操作」（四个执行按钮按 capabilities 置灰） |

---

## 3. 覆盖矩阵（验收线 1）

分类：**A** 一致；**B** 读口有、适配丢了；**C** 中心已存、读口没给；**D** 契约里没有；
**E** 权限不同、按设计不开放；**F** 团队视图里的假数据 / 误调用（bug）。

### 3.1 Feature / DAG 与版本历史

| # | 项 | 本机来源（文件 · 符号） | 团队现状（文件 · 符号） | 中心契约 / 存储证据 | 类 | 节点 |
|---|---|---|---|---|---|---|
| G1 | Feature 列表、标题、描述 | `fetchLedger` → `items` | `teamOverview` → `items` 取 `f.title / f.description` | `Feature.title/description` | A | — |
| G2 | 节点、标题、依赖、文件范围、估时 | `/ledger/:p/dag` → `BoardNode` | `teamDagBoard`：`oneLine/deps/fileGlobs/estimate` 全量；像 id 的键换成卡号 | `PlanNode` 全字段 | A | — |
| G3 | 节点阶段 / phase | bridge 按卡的 stage 算 | `stageOf(task.stage)`，没绑卡的是 `planned` | `TaskProjection.stage` | A（别名 write→build 等有损，见 `ALIAS`） | — |
| G4 | 依赖边：建立者 / 时间 / 状态 | `LedgerDepView.createdBy/createdAt/state` | `createdBy: f.updatedBy`、`createdAt: f.updatedAt`（feature 级冒充边级）；`state: null` | 契约里没有边元数据；`LedgerDepView.createdBy/createdAt/updatedAt` 是必填 string / number（`collab-model.ts:83-85`），`v4-props.tsx:105` 无条件 `hhmm()` | **F**（错误归属）＋D | P1-B（类型放宽为 null + 边页「未记录」） |
| G5 | 版本历史列表（版本号、原因） | `fetchDagFeature` → `versions: VersionMeta[]` | `teamDagFeature` → `versions: []` | 已存：`dag_versions(featureId,version,data)` / `source_dag_mirrors`，`data` 含 `reason`（`commands.ts saveDag`）；`reads.ts detail()` 只取 `f.version` | **C** | P1-D→P1-E→P1-F |
| G6 | 版本元数据：提出人 / 批准人 / 时间 / reasonKind / cancels | `VersionMeta` | 无 | `dag_versions.data` 里没有；`events(serverSeq,kind,actor,at)` 里有 `dag.init/dag.rewrite` 的 actor 代号和时间，可以按 serverSeq 关联；批准人、reasonKind 在 V1 规划模式中不存在 | C（actor / 时间）＋D / E（批准：V1 规划没有审批） | P1-E / P1-F |
| G7 | 历史版本快照 | `?version=n` → `snapshot.nodes` | 抛 "Shared historical snapshots are unavailable" | 同 G5，中心已存 | **C** | P1-D/E/F |
| G8 | 两版对比 | `fetchDagDiff` | 抛英文错误 | 两版快照可在前端用纯函数算 diff（等 G7） | C | P1-F |
| G9 | 等批的重写（pending） | `FeatureCard.pending` | `pending: null` | V1 `pending_proposal` 只是错误码，没有读口 | D/E（V1 不接受提案，`scopeChange` 禁用） | 不做（E） |
| G10 | 处理人 / 轮次 / 步骤线（节点上） | `BoardNode.handler/round/stepLine/since` | 全为 null | `TaskProjection.steps`（`step:round` + state）**已给**；`assigneeCode` **已给**；handler 角色、since 没有 | B（steps、assignee）＋D（since、角色） | P1-B / P1-G |
| G11 | 分支 / head | `BoardNode.branch` | `branch: null` | `TaskProjection.head`（只放已知 commit，`mirrorTaskHeads`）**已给**；分支名没有 | B（head）＋E（分支名不出境） | P1-B |
| G12 | 进度条 / counts | bridge 算 | `teamDagBoard` 按节点 phase 自己算 | 另有 `Feature.counts`（`refreshFeatureState`）没用上 | A（口径一致）/ B | P1-B（与 `counts` 交叉校验） |

### 3.2 任务详情（右侧属性 / 手机全屏）

| # | 区块 | 本机（`collab-detail.tsx`） | 团队（实测，见 §4） | 证据 | 类 | 节点 |
|---|---|---|---|---|---|---|
| T1 | 标题 / 规格摘要 | `task.title/spec` | 一致（卡号 + 标题，`looksLikeId` 防 UUID） | `specSummary` | A | — |
| T2 | 「现在」：阶段 + 停留时长 | `stageSince` → 「已经等了 9 小时」 | 只有「等审查 · 第 1 轮」，没有时长 | `stageSince: null`（adapter）；契约里没有 | D | P1-G/H |
| T3 | 阶段用时条 | `timeline` → `stageSegments` | 全是「—」 | `timeline: []`；契约里没有 | D | P1-G/H |
| T4 | 因果线（在等 / 谁在等它） | `deps` | 一致 | `PlanNode.deps` | A | — |
| T5 | 最近 3 件事 | `events` → `recentThree` | 整块不显示 | `events: []`；中心 `source_event_mirrors` 存了 `{sourceSeq,sourceTaskId,type,at,summary=kind}` | **C**（只有类型和时间，按 `data.redacted` 只显示类型 + 时间）；原文属 E | P1-I（消费者）→ P1-D/E/F |
| T6 | 回放这条任务 | `collab-replay*.ts` 吃 events | 不显示 | 同 T5 | E / D：回放要阶段证据（`collab-replay.ts` 读 `stage.data.to`），只有类型 / 时间的活动不能回放，否则全回落成 spec | P1-I（无证据不回放）→ P1-H（stage 扩展后才有） |
| T7 | 审查（轮次、结论、P0/P1/P2） | `reviewRows(events)` / `lastReview` | 不显示 | 投影里只有 `events.type = "review"`，没有计数和结论 | D（计数、结论枚举 `pass/changes/block`）＋E（审查原文） | P1-G/H（需要 PM 定能不能出境） |
| T8 | 参与者（执行者 / 审查员 / PM） | `agent/pm/sessions` | 「参与者」标题下是空的 | `assigneeCode`、`executorInstanceId` **已给**但被丢；审查员 / PM 没有 | B＋D | P1-B / P1-G |
| T9 | 打开会话 / 对它说 | `CollabSay`、`sessions` | 不显示 | 对端 agent 会话不归本人 | **E** | P1-I（显示「仅主场」） |
| T10 | 步骤线（write/review 第几轮） | `stepLine` | 没有 | `TaskProjection.steps` **已给** | B | P1-B |
| T11 | 阻塞提问 | 本机 asks | 没有 | `TaskProjection.asks{kind,state,blocking}` **已给** | B | P1-B |
| T12 | PR | `task.pr` | `#${pr}` 一致 | `TaskProjection.pr` | A | — |
| T13 | 团队操作 | — | 四个按钮置灰 + reason | `SHARED_LEDGER_CAPABILITIES` | E（按设计） | — |
| T14 | 规格全文 | 本机文件 | 「全文仅在主场」 | `fullText: "home_only"` | E | — |

### 3.3 事件 / 实时 / 进度统计

| # | 项 | 本机 | 团队 | 证据 | 类 | 节点 |
|---|---|---|---|---|---|---|
| E1 | 台账变更触发重拉 | `/events` 的 ledger 事件 | 5s 轮询 `serverSeq` | `team-source-shared.ts follow` | A（语义等价，延迟最多 5s） | — |
| E2 | 此刻动作（tool_start 等） | `reduceAction` | 无 | 对端工具调用不出境 | E | P1-I |
| E3 | 刚推进高亮（advance） | 比较前后 stage | 一致（同一套 `useCollab`） | — | A | — |
| M1 | 在场 agent | registry ∩ 项目 | **固定显示 0** | 团队键对不上 registry（`collab-view.tsx members`） | **F**（应为「暂无」） | P1-A |
| M2 | 进行中 | `metricsOf` | 一致 | — | A | — |
| M3 | 今日完成 | `metrics.endTs ?? updatedAt` ≥ 零点（`collab-model.ts homeView.todayDone`） | `updatedAt = projection.observedAt`，`metrics: {}` → 镜像今天刷过就把所有 done 都算进去；实测因夹具 `observedAt` 早于今天显示 0（本地 4） | `team-source-adapter.ts teamOverview` | **F**（假数据）；注意 `endTs: null` 修不了：`null ?? updatedAt` 仍回落 observedAt；真正修复要完成时刻（D） | P1-A（`unknownMetrics` 暂无）→ P1-H（按覆盖率） |
| M4 | 审查轮次 / P0P1 修掉 | `metrics.reviewRounds`、events | `unknownMetrics` → 「暂无」 | `team-source-shared.ts unknownMetrics: true` | D（已经诚实地显示暂无；但「暂无」只靠源级布尔，`metricsOf` 本身把缺省当 0） | P1-A（改成按总览给）→ P1-G/H |
| M5 | 平均等复核 | `reviewWaitPendingMs` | 「—」（和本机"没人在等"同一个符号，混淆） | `metricsOf` 无数据即 null | D | P1-A（未知显示「暂无」）→ P1-G/H |
| M6 | 周额度 / 协作消息 | 两边都是「暂无数据来源」 | 一致 | — | A | — |
| M7 | 产品看板卡片计数 | `fetchProductBoard` | `sharedProductBoard` 里 `active: 0`、`cards: []`、`eta: null` | `Feature.counts` 只有 total/completed/blocked/missing | B（active 可由投影 stage 算）＋D（eta） | P1-B |
| M8 | 已完成分页 | `ov.doneCursor` → `/ledger/:p/done` | 不带 cursor，不分页 | 团队一次全量读 | A（没有误调） | — |
| M9 | 镜像新鲜度 | — | 只在「团队规划」里显示「主场镜像过期 / 最新」 | `stale(f, now)`、`SHARED_LEDGER_STALE_MS` | B（总览、详情不提示过期，可能把过期状态当成实时） | P1-B |

### 3.4 待你处理 / 上次以来 / 谁在干活 / 团队标签

| # | 项 | 本机 | 团队 | 证据 | 类 | 节点 |
|---|---|---|---|---|---|---|
| W1 | 待你处理 | `useAsks` ∩ `project` ∩ `waitsOnOwner` | **固定显示 0** | 团队键对不上；中心没有「等你」语义，只有每张卡的 `asks{kind,state,blocking}` | **F**（应为「主场处理 · 阻塞 N」或暂无）＋E（owner 提问原文） | P1-A / P1-B |
| W2 | 上次以来卡片 | `/me/last-seen/:p?events=1` | **实测**：GET+PUT `/me/last-seen/shared-ledger:{…}` 打到本机，404，卡片不出现 | `use-collab-extra.ts useLastSeen`；`last-seen.ts` 里 `ledgerProjectExists` | **F**（误调）＋C（中心有 events 流水，可做团队版「上次以来」） | P1-A；以后 P1-F |
| W3 | 谁在干活 | `/ledger/:p/work` | 代码路径：`useWorkBoard(project)` 没走注入，用团队键请求本机 → 404/403 → 30s 轮询重试 | `work/use-work-board.ts`、`web/lib/api/work-board.ts` | **F** | P1-A（团队版用投影的 assignee + stage 拼「谁在干活」，没有就隐藏这个标签） |
| W4 | 团队标签 · 成员卡 | `/peers/contacts`、`/team/quota`、`/team/activity?project=` | 同样的本机接口；activity 用团队键 | `use-team-panel.ts`、`use-team-activity.ts` | **F**（数据源错位：显示的是本机 peers，不是团队成员）；团队成员列表在中心 `members(code)` 里，没有读口（C） | P1-A（团队视图里隐藏本机成员卡，只留「团队规划」）；以后再补成员读口 |

### 3.5 导航 / 手机与桌面

| # | 项 | 本机 | 团队 | 证据 | 类 |
|---|---|---|---|---|---|
| N1 | 入口 | 侧栏「协作视图」（`collab-entry.tsx`，探测 `/ledger/:p` 能读才显示） | 侧栏「团队 · 全部 feature」（`SharedEntry`，`/shared-ledger/context` 有身份才显示） | — | A（各自权限门） |
| N2 | 桌面三栏 / 标签 | `PaneLayout` + 产品 DAG / 子 DAG / 谁在干活 / 团队 | 同一组件；**实测** 1200 宽布局、大纲、筛选计数一致 | §4 | A（「谁在干活」见 W3） |
| N3 | 手机：顶栏「团队」「待你处理」、分段列表 | `narrow` 分支 | 同一组件；**实测** 390 宽首页肉眼对比一致（深浅色都是） | §4 | A（首页）；详情未验证 |
| N4 | 返回 / 切机器 / 切会话收起 | `collab-switch.tsx` | 同一路径；身份变化整个重挂（`TeamSource key=identityKey`） | — | A |
| N5 | 缓存 | `collab-cache.ts` 按 `fp|project` | 团队键不同，不会和本机串 | `keyOf` | A |

---

## 4. 同数据双喂实测（验收线 2）

### 4.1 做法

- 在工作副本里临时放了一个 `tests/zz-parity-scratch.test.ts`，跑完已删除，**没有提交**；截图只放在会话的 scratchpad 里，
  没进 git，也没上传。
- 打包入口用的是现有的 `web/features/collab/shared/fixture-harness.tsx`（真实的 `CollabView` + 真实的 `TeamSource`），
  浏览器是本机 Chrome headless，服务器是回环 `Bun.serve`，**没连生产 bridge**。
- 夹具：`generateTeamFixture({seed:7, features:2, nodes:6})`，给每张卡补上投影器（`mirrorTaskProjections`）真实会发的
  `steps / asks`。本地这一侧用**同样的卡号 / 标题 / 依赖 / 阶段**，再加上本机台账真实会有的字段：`agent/pm/round/stageSince/
  lastReview/metrics/lastEvent`；详情给 `events / timeline / sessions`；DAG 给 `version` 元数据、`versions[]` 和处理人。
- 尺寸：1200×900 和 390×900，浅色 / 深色，本地 / 团队，共 8 张首页图 + 4 张桌面详情图 + 4 张桌面版本尝试图。

### 4.2 结果

| 场景 | 本地 | 团队 | 结论 |
|---|---|---|---|
| 1200 首页（浅 / 深） | 指标条：在场 0 · 进行中 9 · **今日完成 4** · **审查轮次 22** · P0/P1 0 · 平均等复核 10 分 | 在场 0 · 进行中 9 · **今日完成 0** · **审查轮次暂无** · **P0/P1 暂无** · 平均等复核 — | 布局、大纲、筛选计数一致；指标差异符合 M3 / M4 / M5 |
| 1200 任务详情（i28-B3） | 现在（等了 9 小时）· 用时条有数 · 因果线 · 最近 3 件事 · 回放 · 审查 · 参与者 dev-0 + 打开会话 | 现在（没有时长）· 用时条全是 — · **团队操作** · 因果线 · 参与者（空） | 符合 T2 / T3 / T5 / T6 / T7 / T8 / T9 |
| 390 首页（浅 / 深） | 产品 DAG 两张卡 | 一模一样 | 一致。**注意**：两边产品看板用的是同一个 `sharedProductBoard`，只能证明布局一致，不能证明数据一致（M7） |
| 请求记录 | `/ledger/…`、`/ledger/…/dag`、`/product`、`/tasks/…`、`/events`、`/agents/agent-pm/bg-tasks`、`/me/last-seen/…` | `/shared-ledger/features[/…]`、**`GET+PUT /me/last-seen/shared-ledger:{…}`** | 证实 W2 的误调 |
| 页面报错 | 无 | 无 | — |

### 4.3 明确没有验证的部分（不能说视觉已经 1:1）

- **手机详情页**：390 宽下按标题点开详情超时（手机首页默认是产品 DAG 卡片列表，要先进 feature 才能看到任务），
  没截到图，T* 在手机上的表现只有代码路径证明。
- **版本 / 对比页**：脚本里的选择器没点中版本入口，G5–G8 只有代码证明（`teamDagFeature` 返回 `versions: []`，`diff` 抛错）。
- **谁在干活 / 团队标签**：这次没有切过去，W3 / W4 只有代码路径证明。
- 本地事件夹具缺了 `data.from/to`，所以本地「最近 3 件事」里出现 "undefined"。这是夹具的问题，不是产品 bug；
  P1-C 的正式夹具要按 `LedgerEventView` 补全。
- 截图只在本机看过；按规格不贴到公开 PR。P1-C 落地后由 PM 在本地目录验收。

---

## 5. 实施节点（验收线 3）

约定：「公开」= 本仓库 shawnlu96/claudestra；「私有」= floka-ai/cloud（中心实现）。所有公开节点不得改中心存储和服务；
每个节点都要「旧红新绿」：先写一个能复现当前错误、在 main 上为红的测试，修完变绿。

### 5.0 共通规则（r1 补）

- **类型归属**：新字段的类型声明只在一个节点里落，其余节点只消费。`CollabSource.unavailable / homeOnly`（`team-source.ts`）
  和 `LedgerOverview.unknownMetrics`（`collab-model.ts`）都归 P1-A；`InjectedSource extends CollabSource`
  （`team-source-context.ts`），所以加在 `CollabSource` 上的字段注入侧自动可见，**任何节点都不需要改 `team-source-context.ts`**。
  团队源的声明（`sharedCollabSource` 里填哪些键）也归 P1-A（`team-source-shared.ts`）。
- **未知 ≠ 0 ≠ 空串**：本机总览的 `metricsSummary`（`src/lib/ledger-read-cards.ts`）对 0 值**省略**字段，
  `metricsOf`（`v4/v4-model.ts`）又把缺省当 0 累加，所以"字段缺失"在本机等于 0。团队数据不能复用这个约定：
  未知只能通过 `unknownMetrics` / `unavailable` / `homeOnly` 或类型上的 `null` 表达，不准用缺字段、`0`、`""` 冒充。
- **重叠文件串行**：下表里的文件被多个节点改，按列出的顺序串行派单（前一个合并后，后一个 rebase 再开写），
  不重叠的节点可并行。

  | 文件 | 改它的节点（顺序） |
  |---|---|
  | `web/features/collab/team-source-shared.ts` | P1-A → P1-F → P1-H |
  | `web/features/collab/collab-model.ts` | P1-A → P1-B |
  | `web/features/collab/team-source-adapter.ts` | P1-B → P1-H |
  | `web/features/collab/team-source-dag.ts` | P1-B → P1-F |
  | `web/features/collab/team-source-history.ts` | P1-F 建 → P1-H（r2） |
  | `tests/helpers/team-parity-matrix.ts` | P1-C 建 → P1-F → P1-H（后两个只改期望值） |
  | `src/lib/shared-ledger-client.ts` | P1-D → P1-G（r4，只加 `projectionExt1()`）→ P1-K |
  | `src/lib/shared-ledger-gate-proxy.ts`、`src/bridge/local-api/shared-ledger.ts`、`src/lib/shared-ledger-contract-fixtures.ts`、`web/lib/api/shared-ledger-reads.ts` | P1-D → P1-K（r2） |
  | `src/lib/shared-ledger-auth.ts` | 只有 P1-G（r4） |
  | `src/lib/shared-ledger-contract-reads.ts`（`ext-capabilities` DTO，r3） | P1-D 建；P1-G / P1-K 只导入不改 |

  事件 / 回放 / 详情的消费者（`collab-detail-model.ts`、`collab-replay*.ts`、`collab-detail.tsx`）只归 P1-I；
  P1-F / P1-H 只改适配器产出的数据形状，不改这三个消费者。DAG 版本页的消费者（`dag/dag-props.tsx`、`dag/dag-types.ts`
  的 `VersionMeta`）只归 P1-F（r2），全仓库只有 `dag-props.tsx VersionRow` 读 `reasonKind / proposedBy / createdAt`。

### 5.1 第一批 · 马上可以开写（不等 CL1，不改契约）

#### P1-A · 团队视图不再误调本机接口，不显示假 0 / 假「今日完成」（公开 · web）

- **范围 globs（14）**：`web/features/collab/team-source.ts`、`web/features/collab/team-source-shared.ts`、
  `web/features/collab/collab-model.ts`、`web/features/collab/v4/v4-model.ts`、`web/features/collab/collab-view.tsx`、
  `web/features/collab/v4/v4-outline.tsx`、`web/features/collab/use-collab-extra.ts`、`web/features/collab/work/use-work-board.ts`、
  `web/features/collab/work/work-board-view.tsx`、`web/features/collab/use-team-activity.ts`、`web/features/collab/team-panel.tsx`、
  `web/features/collab/dag/use-dag-panes.tsx`、`tests/web-team-parity-calls*.test.ts`、`tests/web-team-parity-metrics*.test.ts`
- **契约字段（本节点声明类型，并给团队源填值）**：
  - `CollabSource.unavailable?: ReadonlySet<"lastSeen"|"workBoard"|"presence"|"ownerWaits"|"teamPanel">`：源级、静态。
  - `CollabSource.homeOnly?: ReadonlySet<"events.text"|"review.text"|"sessions"|"say"|"spec.full"|"replay">`：源级、静态；
    本节点只声明类型并在 `sharedCollabSource` 里填全集，**消费在 P1-I**。
  - `LedgerOverview.unknownMetrics?: readonly ("todayDone"|"reviewRounds"|"fixed"|"reviewWait")[]`：**按每次总览**给，
    缺省 = 全部已知（本机 bridge 永远不发，本机行为不变）。`Metrics.todayDone` 改成 `number | null`。
  - 删掉现有的 `CollabSource.unknownMetrics: boolean`（`team-source.ts`、`team-source-shared.ts`、`collab-view.tsx:187`），
    团队源的 `overview()` 包一层，给返回值填 `unknownMetrics` 全集（四项都未知）。P1-H 再把它改成按覆盖率算。
  - 本机源不声明任何一项，行为完全不变。
- **消费者**：`collab-view.tsx` 指标条按 `unknownMetrics` 显示「暂无」（含 todayDone、平均等复核：未知显示「暂无」，
  和本机"没人在等"显示的「—」区分）；`presence` 不可用时「在场 agent」显示「暂无」；`ownerWaits` 不可用时
  手机顶栏（`collab-view.tsx`）和桌面大纲（`v4/v4-outline.tsx`）「待你处理」显示「暂无」，不显示 0；
  `useLastSeen / useWorkBoard / useTeamActivity / useTeamPanel` 在对应键不可用时不发请求。
- **读写权限**：只读；不新增任何网络请求。
- **验收线**：注入团队源后，`/me/last-seen/*`、`/ledger/shared-ledger:*/work`、`/team/activity?project=shared-ledger:*`、
  `/peers/contacts`、`/team/quota` 都是 0 次请求；「在场 agent」「待你处理」「今日完成」「审查轮次」「P0/P1 修掉」「平均等复核」
  显示「暂无」（带 title 说明原因）；「谁在干活」标签在团队视图里隐藏，或者显示「仅主场可见」；本机视图的截图和请求序列不变。
- **旧红新绿**：① happy-dom 里挂 `CollabView` + 注入团队源，记录 fetch 路径：main 上能抓到 `/me/last-seen/shared-ledger:` → 红。
  ② 3 张 done 卡、`observedAt = now` 喂团队源：main 上指标条「今日完成 3」→ 红，修完「暂无」→ 绿。
  ③ 本机源同一夹具指标条数字不变（防回归）。
- **依赖**：无。

#### P1-B · 用上读口已经给的字段，去掉边上的假归属（公开 · web 适配层 + 边页）

- **范围 globs（11）**：`web/features/collab/team-source-adapter.ts`、`web/features/collab/team-source-dag.ts`、
  `web/features/collab/dag/shared-product-model.ts`、`web/features/collab/team-source-steps.ts`（新建，steps → stepLine 的纯函数）、
  `web/features/collab/collab-model.ts`、`web/features/collab/v4/v4-props.tsx`、`web/features/collab/shared/team-fixture-gen.ts`、
  `tests/web-team-source.test.ts`、`tests/web-team-source-fields*.test.ts`、`tests/web-team-source-product*.test.ts`、
  `tests/web-collab-edge-meta*.test.ts`
- **契约字段（只读现有字段）**：`TaskProjection.assigneeCode` → `LedgerTaskView.agent`，以「成员代号」显示（「打开会话」
  由 P1-I 的 `homeOnly.sessions` 挡）；`steps[]`（`sourceStepId = step:round`）→ `stepLine{steps, active}`；`asks[]` → 阻塞提问数；
  `head` → 短 SHA；`executorInstanceId` → 执行实例（像 id 的不显示原文）；`Feature.projection` + `stale()` → 总览和详情里的
  「镜像过期」提示；`Feature.counts` 和节点算出来的进度做交叉校验，不一致时以中心 `counts` 为准并打 warn。
- **边元数据诚实化（r1 改）**：`LedgerDepView.createdBy: string | null`、`createdAt: number | null`、`updatedAt: number | null`
  （`collab-model.ts`；本机 bridge 照旧给值，只是类型放宽）。团队 adapter 三项都给 `null`，不再填 feature 级的
  `updatedBy / updatedAt`。`v4-props.tsx DepBody`：任一为 `null` 时「判定依据」显示「建立者 / 时间未记录（团队数据没有边级元数据）」，
  不调 `hhmm`（避免 `hhmm(0)` 出 1970、`hhmm(null)` 出 Invalid Date）。`team-fixture-gen.ts` 跟着改成 `null`。
  全仓库 `LedgerDepView` 只有 `v4-props.tsx:105` 读这三个字段（`v4-selection.ts / v4-model.ts / causal-model.ts` 只用 from/to/state），
  所以类型放宽不波及别处；`tsc` 兜底。
- **「今日完成」**：由 P1-A 的 `unknownMetrics` 处理，本节点不再碰；`updatedAt` 继续用 observedAt（只用于排序）。
- **DAG 历史快照报错**：`teamDagFeature` 请求非当前版本时的英文 `Error`（`team-source-dag.ts:37`）只进 console
  （`dag/use-dag-board.ts:57`），界面上版本页停在「加载中」——真正的修复在 P1-F（有读口时返回快照，没读口时版本页显示「暂无」），
  本节点不改这行。
- **读写权限**：只读。
- **验收线**：同一个夹具下团队详情显示负责人代号、步骤线、阻塞提问数、镜像状态；边页显示「建立者 / 时间未记录」，
  不出现 feature 修改人、空名字、1970 或 Invalid Date；本机边页文字不变；没有 UUID 被当成标题（沿用 `looksLikeId`）。
- **旧红新绿**：`teamOverview` 单测：`assigneeCode` 在 main 上被丢 → 红；边 `createdBy === f.updatedBy` 在 main 上成立 → 红，
  修完为 `null` → 绿；`DepBody` 渲染 `createdAt: null` 的边不含 "1970" / "Invalid" → 绿。
- **依赖**：P1-A（`collab-model.ts` 串行，A 先）。

#### P1-C · 真正"同一份数据双喂"的对照夹具（公开 · 测试）

- **范围 globs（6）**：`web/features/collab/shared/fixture-harness.tsx`、`web/features/collab/shared/home-fixture-gen.ts`（新建）、
  `web/features/collab/shared/home-to-team-fixture.ts`（新建）、`tests/web-shared-ledger-browser.test.ts`、
  `tests/web-team-parity-browser*.test.ts`、`tests/helpers/team-parity-matrix.ts`
- **契约字段**：夹具从**一份本机台账形状的数据**出发（`LedgerOverview` + 每张卡的 `TaskDetail`，events 按 `LedgerEventView`
  带完整的 `data`：stage 的 `from/to`、review 的 `round/verdict/p0..p2`、verify 的 `result`；再加 DAG 的 `versions[]`），
  用一个和 `mirrorTaskProjections` 字段规则相同的纯函数推出 `FeatureDetail`。审查结论至少各有一条 `pass / changes / block`。
  本地路由只返回本地数据，**不准再用 `teamDagBoard` / `sharedProductBoard` 喂本地**。（`team-fixture-gen.ts` 归 P1-B，本节点不改。）
- **读写权限**：只在测试进程里起回环服务器；截图目录由环境变量指定，不进 git。
- **验收线**：1200 / 390 × 浅 / 深 × 本地 / 团队，首页、任务详情（手机先进 feature 再点卡）、版本页、对比页、谁在干活、团队标签各一张；
  每个区块输出 `{section, local: present|absent, team: present|absent|home_only|unknown}`，和 `team-parity-matrix.ts` 里写死的期望矩阵
  （就是本页 §3 的 A–F 分类）逐项比对。之后每补一个节点，只能把对应项往 present 方向改，不能悄悄改期望。
- **旧红新绿**：把现有的「本地 DAG 由 teamDagBoard 生成」改掉之后，矩阵检查能抓到 T3 / T5 / T7 的差异（在 main 的
  harness 下这些差异看不到）。
- **依赖**：无（可以和 A / B / I 并行；它们合并后更新期望矩阵）。

#### P1-I · 权限差异显式化 + 脱敏事件的诚实渲染（公开 · web 视图）

- **范围 globs（9）**：`web/features/collab/collab-detail.tsx`、`web/features/collab/collab-detail-model.ts`、
  `web/features/collab/collab-replay.ts`、`web/features/collab/collab-replay-player.tsx`、`web/features/collab/collab-i18n.ts`、
  `web/lib/i18n-dict-shared-ledger.ts`、`tests/web-team-parity-home-only*.test.ts`、`tests/web-collab-redacted-events*.test.ts`、
  `tests/web-collab-replay-evidence*.test.ts`
- **契约字段（只消费，类型在 P1-A）**：`source.homeOnly`。对应区块显示「仅主场可见」占位，不是整块消失：
  「最近 3 件事」原文、「审查」原文、「参与者 · 打开会话」「对它说」、规格全文、回放（`replay`）。
- **脱敏事件约定（r1 新增，供 P1-F 使用）**：`LedgerEventView.data.redacted === true` 表示"只有类型和时间，其余字段不出境"。
  消费者规则：
  - `eventLine`：`redacted` 时不读 `data.*`，只输出类型名 + 「（详情仅主场）」：stage → 「推进阶段（目标阶段仅主场）」、
    verify → 「线上验证（结果仅主场）」、review → 「审查（结论仅主场）」、deliver / deploy / rollback 同理；
    非 `redacted` 但缺字段时也不再拼 `undefined`：stage 缺 `to` → 「推进阶段」，review 缺 `verdict` → 「审查」不带结论，
    verify 的 `result` 不是 `pass/unknown/fail` 之一 → 「线上验证（结果未记录）」，**不再默认成「失败」**。
  - `reviewRows` / `participants`：跳过 `redacted` 的 review（审查区块显示「仅主场」占位，不出空行）。
  - `replayFrames`：初始阶段只在有证据时定（`task:new` 的 `patch.stage`）；没有证据前 `ReplayFrame.stage = null`
    （类型改 `Stage | null`），`stage` 事件缺 `to` 时阶段保持不变而不是回落 `spec`；新增 `hasStageEvidence(events)`，
    `hasReplay` 在没有任何阶段证据时返回 false，回放按钮位置显示「回放仅主场」（`homeOnly.replay`）。
    `collab-replay-player.tsx` 对 `stage: null` 的帧阶段条画成「阶段未知」。
- **读写权限**：只读。
- **验收线**：团队详情里「最近 3 件事」「审查」「参与者 · 打开会话」「回放」在没有数据时显示「仅主场可见 / 暂无」；
  有可出境数据时（P1-F / P1-H 之后）显示数据但不显示原文；本机视图（events 都带完整 data）文案和帧序列逐字不变。
- **旧红新绿**（纯函数，喂 `text:""` 的事件）：
  - `eventLine({kind:"verify", data:{result:"pass"}})` 在 main 上为「线上验证通过」（防回归，绿）；
    `eventLine({kind:"verify", data:{redacted:true}})` main 上「线上验证失败」→ 红，修完「线上验证（结果仅主场）」→ 绿；
  - `eventLine({kind:"stage", data:{}})` main 上「推到『undefined』」→ 红；
  - `eventLine({kind:"review", data:{}})` main 上「第 ? 轮：undefined · P0 ? …」→ 红；
  - `replayFrames` 喂三条 `redacted` 事件：main 上 `stage` 全是 `"spec"` → 红，修完全为 `null` 且 `hasReplay === false` → 绿；
  - 本机完整事件夹具（现有 `tests/web-collab-since.test.ts` 回放一节）保持绿。
- **依赖**：P1-A（只依赖 `homeOnly` 类型；可以先按类型并行写，合并按 A → I）。

### 5.2 第二批 · 读口契约（公开协议投影 / 共享读 API）

#### P1-D · V1 只增不改的读口：版本历史和活动流水（公开 · 契约 + 客户端 + bridge 代理 + web 传输）

- **范围 globs（12）**：`src/lib/shared-ledger-contract-reads.ts`（新建，不改冻结文件里的已有类型）、
  `src/lib/shared-ledger-contract-responses.ts`、`src/lib/shared-ledger-client.ts`、`src/bridge/local-api/shared-ledger.ts`、
  `src/lib/shared-ledger-gate-proxy.ts`、`web/lib/api/shared-ledger.ts`、`web/lib/api/shared-ledger-reads.ts`（新建）、
  `src/lib/shared-ledger-contract-fixtures.ts`、`tests/shared-ledger-contract-reads*.test.ts`、`tests/shared-ledger-client-reads*.test.ts`、
  `tests/shared-ledger-gate-proxy*.test.ts`、`tests/web-shared-ledger-reads*.test.ts`
- **契约字段**：
  - `GET /v1/teams/{team}/features/{id}/versions` → `{schemaVersion:1, teamId, projectId, serverSeq, versions: {version, reason, nodes, bindings, at: number|null, by: string|null}[]}`；
    `by` 是成员代号（`actorCode`），不是人名。
  - `GET /v1/teams/{team}/features/{id}/activity/{afterServerSeq}` → `{schemaVersion:1, teamId, projectId, serverSeq, items: ({src:"center", serverSeq, kind, by, at} | {src:"home", sourceSeq, taskId, type, at})[], truncated}`；
    `taskId` 是中心 id；**不含任何原文**（投影上来的 `summary` 本身就等于 kind，`shared-ledger-projector.ts:128`）。
  - **能力发现（r2 更正）**：不往现有 `capabilities` 里加键——`shared-ledger-contract-responses.ts:10-13` 对 `capabilities`
    逐键 `literal` 严格解析，加键会让老客户端拒收**所有** features 响应（现有公开数据降级）。改为新增
    `GET /v1/teams/{team}/ext-capabilities` →
    `{schemaVersion:1, teamId, reads:{versions:boolean, activity:boolean, ext1:boolean, activityExt:boolean}, uploads:{projectionExt1:boolean}}`
    （r3 加 `uploads`）。键集合封闭、全部必填，多键 / 缺键 / 非布尔整包拒收，拒收按"全关"处理。
    **读和写分开声明**：`reads.*` 只决定 web 发不发对应读请求；**只有 `uploads.projectionExt1 === true` 才允许导出端发 `ext1`**（P1-G），
    `reads.ext1 / reads.activityExt` 为 true 也不构成上传许可（只读中心 / 已存旧数据但停收的中心就是这种组合）。
    老中心 404 → 全部视为 false，web 不发对应请求、导出端发 V1 原包，退回现状。
    `SharedLedgerClient.extCapabilities()`（本节点新增）：仅 404 映射成全关常量 `EXT_CAPABILITIES_OFF`，其他远端错误照常抛
    （bridge 代理照现有规则回 503 / 原状态码，web 按"读不到 = 全关"处理）。**老的 `capabilities` 解析和 `SHARED_LEDGER_CAPABILITIES` 一字不改**。
    消费者：web 的 `reads.versions / activity`（P1-F）、`reads.ext1 / activityExt`（P1-K）；导出端的 `uploads.projectionExt1`（P1-G，直连中心，不经 bridge 代理）。
  - **bridge 代理分派（r3 写明）**：`actionFor` 在 `src/bridge/local-api/shared-ledger.ts:22-26`（不在 `shared-ledger-gate-proxy.ts`；
    gate-proxy 只按 `/shared-ledger/` 前缀选绑定，路径不用改），现有 GET 正则只认 `features[/id]` 和 `commands/id`，其余 400。
    本节点在 `read` 里**只加三条**：`ext-capabilities`、`features/{id}/versions`、`features/{id}/activity/{非负整数}`；
    `handleSharedLedgerApi` 的 GET 分支对应新增三支：`ext-capabilities` → `client.extCapabilities()` 原样回 200（团队级、只有布尔，不含项目数据，
    不做 projectId 过滤，但仍要求该 principal 对当前 projectId 有 read 凭据，否则 403）；`versions / activity` → 响应 `projectId !== deps.projectId`
    回 403 `project unavailable`（与 `feature()` 同一句）。其他路径仍 400，`ext1 / activity-ext` 两支归 P1-K。
  - 路径参数不用 query：现有代理遇到 `new URL(req.url).search` 一律 400。
- **读写权限**：read grant，和 `features/{id}` 同一道门；跨项目一律 403，响应体相同（沿用 X12 §3.1 的原则）。
- **验收线**：代理对三条路径按 `read` 选凭据，`versions / activity` 按 projectId 过滤；老中心（没有 capability）时 web 不发请求；
  响应解析器拒收多余字段；**能力发现三种中心各一条测试**（假中心 + 真实 `handleSharedLedgerApi`）：
  ① 新中心 `reads` 全 true、`uploads.projectionExt1:true` → 代理 200 原样、解析通过；② 只读中心 `reads` 全 true、`uploads.projectionExt1:false`
  → 解析通过且 `uploads` 为 false；③ 老中心 404 → `extCapabilities()` 得 `EXT_CAPABILITIES_OFF`、代理 200 全关；另加多键 / 缺 `uploads` 拒收。
  **旧响应不变**：现有 `features` / `feature` 夹具（含旧 `capabilities`）在改动前后都按原解析器通过、输出逐字相同（防降级，绿）；改 `shared-ledger-gate-proxy.ts` 时按 CLAUDE.md 的规定在 baseline 里留 `raised[]` 记录。
- **旧红新绿**：main 上代理对 `features/x/versions`、`ext-capabilities` 返回 400 → 红；修完 → 绿。客户端解析器对带 `text` / `data` 字段的 activity 拒收（绿，防止原文漏出）。
- **依赖**：**PM 批准在冻结的 V1 上做只增不改的扩展**（class=design；默认做法：新文件 + capability 门控，不改已有类型）。不依赖 CL1。

#### P1-E · 中心实现版本 / 活动读口（**私有 floka-ai/cloud**）

- **范围**：floka-ai/cloud 里中心的 reads / service 路由（具体 glob 由私有仓库给）；公开仓库**不实现**。
- **契约字段**：按 P1-D。`versions` 从 `dag_versions` / `source_dag_mirrors` 读（`data.reason` 已有），`at/by` 按 `events`
  里 `kind IN ('dag.init','dag.rewrite','import')` 的 serverSeq 关联；`activity` 从 `events` 和 `source_event_mirrors` 合并按序输出。
  **`GET …/ext-capabilities`（r3）也由本节点实现**：上线时 `reads.versions / activity` 为 true，`reads.ext1 / activityExt` 和
  `uploads.projectionExt1` 固定 false，直到 P1-G 中心一半上线再翻；同一份夹具（新中心 / 只读中心）作契约测试。
- **读写权限**：只读；鉴权和 `detail()` 相同。
- **验收线**：契约测试用公开仓库的 `shared-ledger-contract-fixtures.ts` 夹具，双方都通过。
- **依赖**：**CL1（固定 gitlink）** + P1-D 契约合并。

#### P1-F · 团队视图用上版本 / 活动（公开 · 共用 UI 适配层）

- **范围 globs（12，r2 加版本页消费者）**：`web/features/collab/team-source-history.ts`（新建）、`web/features/collab/team-source-dag.ts`、
  `web/features/collab/team-source-shared.ts`、`web/features/collab/dag/dag-diff.ts`、`web/features/collab/dag/use-dag-board.ts`、
  `web/features/collab/dag/dag-types.ts`、`web/features/collab/dag/dag-props.tsx`、`web/lib/i18n-dict-collab.ts`、
  `tests/web-team-source-history*.test.ts`、`tests/web-team-source-activity*.test.ts`、`tests/web-dag-versions-unknown*.test.ts`、
  `tests/helpers/team-parity-matrix.ts`（只改期望值）
- **未知版本元数据的类型（r2，本节点声明并消费）**：`dag-types.ts VersionMeta` 放宽为
  `reasonKind: ReasonKind | null`、`proposedBy: string | null`、`createdAt: number | null`（`approvedBy` 已是 `| null`）；
  `FeatureDetail` 加可选 `history?: "unavailable"`（缺省 = 可用；本机 bridge 永远不发，照旧给值，本机行为不变）。
  `PendingMeta = VersionMeta & …` 跟着放宽，团队的 `pending` 恒为 `null`，本机照旧有值。
- **契约字段**：`versions` → `VersionMeta{version, reasonKind: null, reasonText: reason, proposedBy: by, approvedBy: null, createdAt: at, cancels: [], scopeChange:false, askId:null}`：
  **不再把 v1 映射成 `initial`、其余映射成 `requirement_change`**——中心没有 reasonKind，就是 `null`；`by / at` 为 `null` 时原样 `null`，不填 `""` / `0`。
  `snapshot` 从对应版本的 nodes 生成，`snapshot.meta` 同上；对比用两份快照在前端算（新增纯函数，产出 `DagDiffResponse` 形状）。
- **版本页渲染（r2，`dag-props.tsx`）**：`VersionRow` 在 `reasonKind === null` 时图标用中性的 `history`、原因首行为空时文字为「类型未记录」
  （不查 `REASON_ICON / REASON_WORD`）；`proposedBy` 和 `approvedBy` 都为 `null` 时提出人一栏显示「提出人未记录」；`createdAt === null`
  时显示「时间未记录」，**不调 `hhmm`**（`hhmm(0)` 出 1970、`hhmm(null)` 出 1970 / Invalid Date）。`VersionsPage` 在
  `detail?.history === "unavailable"` 时不画列表、不开「对比」，显示「团队暂无历史版本」；`!detail` 的「正在读取…」只在真正加载中出现。
  三条新词条进 `i18n-dict-collab.ts`。本机三项都有值时 `VersionRow` 输出逐字不变。
- **capability 关着时**（`ext-capabilities` 404 或 `reads.versions:false`）：团队源 `dag.feature()` 对当前版本返回
  `{…, versions: [], snapshot: null, history: "unavailable"}`，不再抛；`use-dag-board.ts useDagVersions` 拿到的是正常结果，版本页不卡「加载中」；
  请求非当前版本的英文 `Error` 不再出现（`VersionsPage` 不会在 unavailable 时发起对比）。
- **活动 → 事件（r1 改）**：`activity` → `TaskDetail.events{seq, ts: at, kind: type, text: "", actor: by ?? "主场", data: {redacted: true}}`，
  **一律带 `redacted: true`，不伪造 `to / result / verdict`**；按 P1-I 的消费者规则只显示「类型 + 时间 + 详情仅主场」。
  「最近 3 件事」因此从 absent 变 present（类型 / 时间级），**回放仍是 home_only**：没有阶段证据，`hasReplay` 为 false，
  不会回放成 spec；等 P1-H 提供 stage `{from,to}` 后才有回放。
- **读写权限**：只读；capability 关着时保持 P1-I 的「暂无 / 仅主场」。
- **验收线**：P1-C 矩阵里 G5 / G7 / G8 / T5（类型 / 时间级）从 absent 变成 present，T6 保持 home_only；
  事件行里不出现 "undefined"、「线上验证失败」（除非数据确实是失败）；不出现 "unavailable" 英文；版本页不卡「加载中」；
  版本行不出现 1970 / Invalid Date / 「初版」「需求变了」这类中心没给的原因类型；capability 关时版本页显示「团队暂无历史版本」。
- **旧红新绿**：`teamDagFeature(board, id, 1)` 在 main 上抛错 → 红；有 versions 时返回快照 → 绿。
  活动适配：一条 `type:"verify"` 的 activity 经 adapter → `recentThree` 的文字不含「失败」→ 绿（main 上无此路径，先写断言为红）。
  版本页渲染（r2，`tests/web-dag-versions-unknown*.test.ts`，happy-dom 渲染真实 `VersionsPage`）：
  ① `VersionMeta{reasonKind:null, proposedBy:null, createdAt:null}`：main 上类型不允许、按 r1 映射（`at ?? 0`、`initial`）渲染出 "1970" 和「初版」→ 红，
  修完含「类型未记录」「时间未记录」、不含 "1970" / "Invalid" / 「初版」→ 绿；② `detail = {versions:[], history:"unavailable"}`：
  main 上 `versions` 空列表 + 无提示（或调用抛错时恒「正在读取…」）→ 红，修完「团队暂无历史版本」且「对比」按钮 disabled → 绿；
  ③ 本机完整 `VersionMeta` 的行文字和图标逐字不变（防回归，绿）。
- **依赖**：P1-D（类型）、P1-I（脱敏事件消费者规则，**必须先合并**，否则会出现 r0 审查里的 undefined / 失败）、
  P1-B（`team-source-dag.ts` 串行）、P1-A（`team-source-shared.ts` 串行）；联调依赖 P1-E。写代码和单测可以用假数据先行，**不用等 CL1**。

### 5.3 第三批 · 投影契约扩展（需要 owner / PM 定出境范围）

#### P1-G · 投影可选字段：时间线 / 完成时刻 / 轮次 / 审查计数 / 指标（公开导出端 + 私有中心）

- **公开范围 globs（15，r4 加 client / auth 两个传输文件）**：`src/lib/shared-ledger-contract-projection-ext.ts`（新建）、`src/lib/shared-ledger-contract-transfer.ts`、
  `src/lib/shared-ledger-projector.ts`、`src/lib/shared-ledger-export.ts`、`src/lib/shared-ledger-scrub.ts`、
  `src/lib/shared-ledger-mirror.ts`、`src/lib/shared-ledger-mirror-loop.ts`、`src/lib/shared-ledger-client.ts`（r4，只加 `projectionExt1()`）、
  `src/lib/shared-ledger-auth.ts`（r4，只加 `parsePayload` 的扩展解析开关）、`tests/shared-ledger-projector-ext*.test.ts`、`tests/shared-ledger-client-scrub-ext*.test.ts`、
  `tests/shared-ledger-export-ext*.test.ts`、`tests/shared-ledger-mirror-ext*.test.ts`、`tests/shared-ledger-mirror-loop-ext*.test.ts`、
  `tests/shared-ledger-auth-ext*.test.ts`
  （`extCapabilities()` 仍由 P1-D 在 `shared-ledger-client.ts` 里提供，本节点只调用不改；`src/bridge/local-api/shared-ledger.ts` 不在范围，bridge 代理保持只收 V1）
- **契约字段（全部可选；只有 P1-D `ext-capabilities` 的 `uploads.projectionExt1 === true` **且** 该 mirror entry 的 `ext1Consent` 开着才发；
  `reads.*` 不参与判断）**：
  ```
  TaskProjection.ext1?: {
    stageSince: number | null;
    timeline: { stage: Stage; from: number; to: number }[];
    reviews: { round: number; verdict: "pass" | "changes" | "block" | null; p0: number; p1: number; p2: number; at: number }[];
    metrics: { startTs: number | null; endTs: number | null; reviewRounds: number;
               p0: number; p1: number; p2: number; reviewWaitSince: number | null };
    eventExt: EventExt1[];   // r2：事件扩展放在卡的 ext1 里，不改 V1 的 projection.events 形状
  }
  EventExt1 =                 // 按 sourceSeq 对上 V1 projection.events 里同一条事件，sourceTaskId 即本卡
    | { sourceSeq: number; type: "stage";  from: Stage; to: Stage }
    | { sourceSeq: number; type: "review"; round: number; verdict: "pass" | "changes" | "block" | null; p0: number; p1: number; p2: number }
    | { sourceSeq: number; type: "verify"; result: "pass" | "fail" | "unknown" }
  ```
  - 类型定义和严格解析（键集合封闭、按 `type` 判别、枚举外值和任何 `text / data / summary / note` 键一律拒收）放在新文件
    `shared-ledger-contract-projection-ext.ts`，**上传（本节点）和读回（P1-K）共用同一份 schema**，避免两端各写一套。
  - `verdict` **沿用本机真实枚举 `pass|changes|block`**（`src/lib/ledger-steps.ts:47` 的 CHECK、`collab-step-line-model.ts:30,97`、
    `collab-detail-model.ts` 的 `VERDICT`），不引入 `reject`，不做转换；本机事件里不在这三个值里的结论投成 `null`（UI 显示「审查」不带结论）。
  - `metrics` **直接由导出端调用本机同一个 `taskMetrics()`（`src/lib/ledger-metrics.ts`）算**，保证同数据同数字：
    `reviewRounds = reviews.length`、`p0/p1/p2` 为各轮之和、`endTs` 即完成时刻；`reviewWaitSince = now - reviewWaitPendingMs`
    （传绝对时刻，接收端按自己的 now 重算 pending，避免镜像延迟把等待时长冻住）。
  - `ext1` 是"每张卡要么整块有、要么整块没有"：有 `ext1` 时其中 `null` 表示"本机也没有"（如未完成的 `endTs`），
    没有 `ext1` 表示"没授权 / 老镜像 / 老导出端"，**语义是未知，不是 0**。**不含任何自由文本**。
- **上传许可的取得路径（r3）**：导出端不经 bridge 代理，`shared-ledger-mirror-loop.ts` 每轮在 `pushSharedLedgerMirror` 前，
  只对 `ext1Consent` 开着的 entry、用该 entry 的同一个 service 凭据 / 实例签名客户端调 `client.extCapabilities()`（P1-D），
  得出 `ext1Upload = consent && caps.uploads.projectionExt1 === true`，经 `PushDeps.ext1Upload`（新增可选字段，缺省 false）传给投影；
  `MirrorClient` 接口加可选 `extCapabilities?()`，假客户端不实现 = false。404 / 任何错误 / 解析拒收 → false，**本轮照发 V1 原包，不计失败、不退避**
  （能力发现失败不能让现在能推的镜像停推）。consent 关时不发能力请求（和 main 一样零额外请求）。
  `ext1Upload` 为 true 时用新文件里的 `parseSharedLedgerProjectionExt` scrub 整包，为 false 时仍用现有 `parseSharedLedgerProjection`，代码路径和 main 相同。
- **扩展包的传输客户端（r4）**：现有 `SharedLedgerClient.projection()`（`src/lib/shared-ledger-client.ts:166-170`）在发请求前无条件
  `this.scrub(input, parseSharedLedgerProjection)`，而 V1 `taskProjectionSchema`（`shared-ledger-contract-transfer.ts:11-17`）是封闭键集合、没有 `ext1`，
  所以带 `tasks[].ext1` 的包走 `projection()` 会在本机抛错、**根本到不了中心**，下面的"中心 4xx 重发"分支也接不住。因此：
  - **`projection()` 一字不改**，继续用 V1 解析（bridge 代理 `src/bridge/local-api/shared-ledger.ts:64-66` 先用 V1 scrub 再调它，两层都拒 `ext1`，保持只收 V1）；
    **不放宽 `parseSharedLedgerProjection`**（它同时被 bridge 代理和中心 `shared-ledger-auth.ts:148-149` 用，放宽就破坏 V1-only）。
  - 新增 **`SharedLedgerClient.projectionExt1(input: SharedLedgerProjectionExt1)`**：`this.scrub(input, parseSharedLedgerProjectionExt)`
    （从 `shared-ledger-contract-projection-ext.ts` 导入，类型 `SharedLedgerProjectionExt1 = SharedLedgerProjection & {tasks: (SharedLedgerTaskProjection & {ext1?: TaskExt1})[]}` 也在该文件），
    同一个 `POST projections`、同一凭据 / 签名 / 超时，响应用同一 `parseSharedLedgerResponse("projection", …)` 和 `sourceInstanceId / sourceSeq` 校验。
  - `MirrorClient`（`shared-ledger-projector.ts:34`）加可选 `projectionExt1?(input: SharedLedgerProjectionExt1)`；投影端只有
    `ext1Upload && typeof client.projectionExt1 === "function"` 才带 `ext1` 并调它，否则按 V1 调 `projection()`（假客户端 / 老实现自动退回 V1）。
    中心非 409 的 4xx 后的 V1 重发调的是 `projection(stripExt1(payload))`，不是再调 `projectionExt1`。
  - **中心入站解析**：`shared-ledger-auth.ts parsePayload` 对 `project` 动作目前固定用 V1 解析；`authenticateSharedLedgerRequest` 加可选参数
    `{ projectionExt1?: boolean }`（缺省 false = 和 main 完全一样，带 `ext1` 的包回 400 `invalid_field`），为 true 时改用 `parseSharedLedgerProjectionExt`。
    中心（私有一半）在把 `uploads.projectionExt1` 置 true 的同一次发布里传 true；公开仓库只提供这个开关，不实现中心存储。
  **中心降级保护**：带 `ext1` 的包被中心以非 409 的 4xx 拒收时，同一轮立刻去掉 `ext1` 按 V1 重发一次；重发成功即算本轮成功，
  下一轮重新问能力。409 仍走现有快照重试（快照也按同一 `ext1Upload` 决定带不带）。bridge 的 `POST projections` 代理路径不变，仍只收 V1。
- **出境闸**：所有字段都过 `scrubSharedLedger`（数字 / 枚举也走一遍，枚举外的值拒收）；mirror entry 上新增显式开关
  `ext1Consent`（默认关，开启走现有导出预检，`shared-ledger-export.ts` 的 refusal 报告列出新字段）。不开 → 和现在完全一样，
  **现有的公开数据不降级**。
- **私有部分**：中心接收和存储 `ext1`（含 `eventExt`），能收时在 `ext-capabilities` 把 `uploads.projectionExt1` 置 true、
  读口就绪时把 `reads.ext1 / activityExt` 置 true（两者可以分别发布），并实现 P1-K 定义的 `ext1` / `activity-ext` 两条读口，**按卡 / 按事件原样回传**
  （没收到的不补默认值）；**不往现有 `features/{id}` 的 detail 响应里加 `ext1`**（r2 更正：V1 detail 的 `taskProjectionSchema`
  严格拒收多余键，加了会让老客户端整页读失败）。floka-ai/cloud，依赖 CL1。
- **验收线**：没有 capability 时发出的包和 main 上逐字节一致（快照测试）；有 capability 但没有 consent 时也一致；
  两者都开时只多出 `ext1` 和事件扩展；**能力 × consent 矩阵（r3，`tests/shared-ledger-mirror-loop-ext*.test.ts`，假中心 + 真实 mirror-loop）**：
  ① `uploads.projectionExt1:true` + consent → 包里有 `ext1`；② 只读中心（`reads` 全 true、`uploads.projectionExt1:false`）+ consent
  → 包和 main 逐字节一致（**只有读支持不得上传**）；③ 老中心 `ext-capabilities` 404 + consent → 逐字节一致、`failures` 不变；
  ④ 能力请求 503 → 同 ③；⑤ consent 关 → 假中心收不到 `ext-capabilities` 请求；⑥ 能力 true 但 `projections` 对带 `ext1` 的包回 400
  → 同一轮 V1 重发成功；scrub 遇到夹带文本或 `reject` 等枚举外值的 review 拒收。
  **真实传输链路（r4，`tests/shared-ledger-client-scrub-ext*.test.ts` + `tests/shared-ledger-auth-ext*.test.ts`，不用假 `MirrorClient`）**：
  ⑦ 投影端 → **真实 `SharedLedgerClient`** → 回环假中心（`127.0.0.1` 临时端口，入站用真实 `authenticateSharedLedgerRequest({projectionExt1:true})`，
  `ext-capabilities` 回 `uploads.projectionExt1:true`）+ consent 开 → 假中心收到的 `POST projections` 包体里 `tasks[].ext1` 原样存在、响应校验通过；
  ⑧ 同一个带 `ext1` 的包直接调 `client.projection()` → 本机抛 `invalid_field`，假中心**收到 0 个 `POST`**（V1 方法不放行扩展）；
  ⑨ 同一个包经 bridge 代理 `handleSharedLedgerApi` 的 `POST projections` → 400，假中心收到 0 个 `POST`（代理仍只收 V1，`shared-ledger.ts` 不改）；
  ⑩ 假中心用缺省 `authenticateSharedLedgerRequest()`（不开扩展）但 `ext-capabilities` 谎报 true → 带 `ext1` 的包被真实 400 拒收 → 同一轮
  `projection()` V1 重发成功（⑥ 的真实链路版）；⑪ consent 关 / 能力关时经真实 `SharedLedgerClient` 发出的 V1 包和 main 逐字节一致，
  `projection()` 对普通 V1 包的行为、请求体、签名字段不变（防降级）。
- **旧红新绿**：投影快照测试，main 上没有 `ext1` → 新断言红；开 consent 后变绿；未开时的快照保持绿（防降级）。
  **block 回归**：本机一条 `verdict:"block"`、`p0:1` 的 review → 投影 → 客户端解析（`shared-ledger-contract-transfer.ts`）
  → 结果仍是 `block`、`p0 = 1`（P1-H 接着验到 UI）。
- **依赖**：**owner / PM 决定审查结论和 P0/P1/P2 计数能不能出境**（class=design；默认：只出枚举和计数，原文永远 home_only）；
  **P1-D 已合并**（`extCapabilities()` 和 DTO；`shared-ledger-client.ts` 按 §5.0 串行 P1-D → P1-G → P1-K）；中心那一半依赖 CL1 + P1-E 的部署通道（`ext-capabilities` 路由由 P1-E 先上线）。
  公开导出端可以先合并（`uploads.projectionExt1` 不为 true 就不生效）。

#### P1-K · 扩展数据读回契约：中心 → bridge → 浏览器（公开 · 共享读 API + web 传输；r2 新增）

- **为什么单列**：P1-G 只定了上传，P1-D 的 activity 只有类型 / 时间且拒收 `text / data`；没有这一节点，`stage.to / review.verdict /
  verify.result` 到不了浏览器，P1-H 只能保持脱敏占位。
- **范围 globs（9）**：`src/lib/shared-ledger-contract-ext-reads.ts`（新建，读响应 DTO + 严格解析；元素 schema 从
  `shared-ledger-contract-projection-ext.ts` 导入，不另写）、`src/lib/shared-ledger-client.ts`、`src/lib/shared-ledger-gate-proxy.ts`、
  `src/bridge/local-api/shared-ledger.ts`、`src/lib/shared-ledger-contract-fixtures.ts`、`web/lib/api/shared-ledger-reads.ts`、
  `tests/shared-ledger-ext-reads*.test.ts`、`tests/shared-ledger-gate-proxy-ext*.test.ts`、`tests/web-shared-ledger-ext-reads*.test.ts`
- **读 DTO（全部是新路径，老客户端永远不会请求，所以不影响冻结的 V1 响应）**：
  - `GET /v1/teams/{team}/features/{id}/ext1` →
    `{schemaVersion:1, teamId, projectId, serverSeq, featureId, consent: boolean, tasks: {taskId, ext1: TaskExt1WithoutEventExt}[]}`；
  - `GET /v1/teams/{team}/features/{id}/activity-ext/{afterServerSeq}` →
    `{schemaVersion:1, teamId, projectId, serverSeq, featureId, consent: boolean, items: ({taskId} & EventExt1)[], truncated: boolean}`；
    `sourceSeq` 和 P1-D activity 的 `{src:"home", sourceSeq}` 一一对应，浏览器按 `(taskId, sourceSeq)` 合并。
  - 两条都只回 P1-G 上传时已经过 scrub 的枚举 / 数字 / 时间戳，**没有任何自由文本**；解析器对多余键、`text / data / summary / note`、
    枚举外值（含 `reject`）、`type` 不在 `stage / review / verify` 里的项一律拒收整包（不是丢单项后放行）。
- **缺省行为**：`ext-capabilities`（P1-D）404 或 `reads.ext1 / reads.activityExt` 为 false → web 不发请求，所有卡视为"没有 `ext1`"、
  所有事件保持 P1-F 的 `redacted: true`；capability 开但该 feature 没 consent → 中心返回 `consent:false` 和空数组（不补默认值），
  web 同样视为全部未知；某张卡 / 某条事件不在数组里 → 该卡 / 该事件未知。三种情况都**不会**变成 0 或「失败」。
- **web 传输类型**：`web/lib/api/shared-ledger-reads.ts` 新增 `TeamExt1Read`、`TeamActivityExtRead` 及 `fetchTeamExt1 / fetchTeamActivityExt`，
  响应先过同一严格解析再交给适配层；解析失败按"读不到"处理（未知），不抛到界面。
- **读写权限**：read grant，与 `features/{id}` 同门、同一 projectId 过滤（响应 `projectId !== deps.projectId` → 403）；
  `src/bridge/local-api/shared-ledger.ts` 的 `actionFor` 在 P1-D 的三条之后只再加这两条进 `read`，`handleSharedLedgerApi` 加对应两支
  （若改 `shared-ledger-gate-proxy.ts` 按 CLAUDE.md 在 baseline 里留 `raised[]` 记录）；本节点只读 `reads.ext1 / activityExt`，不读也不改 `uploads`；跨项目 403、响应体与现有一致。
- **验收线**：代理对两条路径按 `read` 选凭据；capability 关 / consent 关 / 部分卡缺失三种响应都解析成"未知"而不是默认值；
  夹带 `text` 的 review、`verdict:"reject"`、`result:"ok"` 的响应被拒收。
- **旧红新绿**：main 上代理对 `features/x/ext1`、`features/x/activity-ext/0` 返回 400 → 红，修完 → 绿；
  **导出 → 回环假中心 → 严格解析联通**：本机一条 `verify{result:"pass"}`、一条 `stage{from:"build", to:"review"}`、一条 `review{verdict:"block", p0:1}`
  经 P1-G 投影（consent 开）→ 回环假中心原样存回 → `activity-ext` 响应 → `parseActivityExt` 得到同样三项（main 上没有该解析器 → 红）；
  同一条 review 夹带 `text:"…"` 时整包拒收（绿，防原文漏出）。
- **依赖**：P1-D（文件串行 + `ext-capabilities`）、P1-G 公开部分（`shared-ledger-client.ts` 串行在 G 之后，r4；共用 `shared-ledger-contract-projection-ext.ts` 的 schema，只导入不改）；
  联调依赖 P1-G 的私有中心一半（CL1）。不需要 owner 再拍板（出境范围已在 P1-G 定）。

#### P1-H · 团队视图用上扩展字段（公开 · 共用 UI 适配层）

- **范围 globs（8）**：`web/features/collab/team-source-adapter.ts`、`web/features/collab/team-source-shared.ts`、
  `web/features/collab/team-source-history.ts`（r2：活动 + `activity-ext` 合并成事件）、
  `web/features/collab/team-source-metrics.ts`（新建，覆盖率 / 聚合纯函数）、`tests/web-team-source-ext*.test.ts`、
  `tests/web-team-source-ext-metrics*.test.ts`、`tests/web-team-parity-ext-e2e*.test.ts`（r2）、`tests/helpers/team-parity-matrix.ts`（只更新期望值）
- **数据来源（r2）**：卡级扩展只来自 P1-K 的 `fetchTeamExt1`，事件扩展只来自 `fetchTeamActivityExt`；团队源在 `overview()` / `task()`
  里并行读，读不到按"没有 `ext1`"处理。
- **字段映射（逐项，r1 补全）**：

  | 本机消费字段 | 来源（只在该卡有 `ext1` 时填） | 没有 `ext1` 时 |
  |---|---|---|
  | `LedgerTaskView.stageSince` | `ext1.stageSince` | `null`（显示无时长，现状） |
  | `TaskDetail.timeline` | `ext1.timeline` | `[]`（用时条「—」，现状） |
  | `metrics.endTs` | `ext1.metrics.endTs` | 不填 |
  | `metrics.reviewRounds / p0 / p1 / p2` | `ext1.metrics.*` | 不填 |
  | `metrics.reviewWaitPendingMs` | `reviewWaitSince === null ? null : now - reviewWaitSince` | 不填 |
  | `lastReview` | `ext1.reviews` 最后一条（`text: ""`，原文 home_only） | `null` |
  | `TaskDetail.events` 的 stage / review / verify | `activity-ext` 里同 `(taskId, sourceSeq)` 的项 → `data:{from,to}` / `{round,verdict,p0,p1,p2}` / `{result}`，**不带 `redacted`**（`team-source-history.ts`） | P1-F 的 `redacted: true` |

- **按覆盖率给 `unknownMetrics`（r1 改：不再"capability 开就全知"）**：对本次总览里的卡逐张判断有没有 `ext1`：
  - `reviewRounds` / `fixed`：参与求和的卡（`fixed` 只看合并及以后的卡）**全部**有 `ext1` 才已知，否则列入 `unknownMetrics`；
  - `todayDone`：所有 done / verified 卡都有 `ext1` 且 `metrics.endTs` 是数字才已知；有一张缺就未知
    （不能退回按 `observedAt` 算）；
  - `reviewWait`（r2 改）：**本次总览 `tasks` 里的每一张卡**都有 `ext1` 才已知——`metricsOf`（`v4/v4-model.ts:27`）对所有卡收
    `reviewWaitPendingMs`，而 pending 由 deliver / review 事件决定（`src/lib/ledger-metrics.ts reviewWaits`），和 stage 无关：
    build / ops、blocked、甚至 done 卡都可能有 pending（`tests/web-collab-v4-model.test.ts:23-30` 的 ops 卡就是 180000ms）。
    缺 `ext1` 时没有任何"已知不参与"的证据（V1 投影里只有 stage），所以不能按 stage 排除；有一张缺就整项「暂无」。
    已知且没人在等 → 「—」，未知 → 「暂无」；
  - 同理，`reviewRounds` 的"参与求和的卡"就是总览里的**全部卡**（`metricsOf` 对 `reviewRounds` 不按阶段过滤）；`fixed` 只看合并及以后
    的卡是对的——它按 V1 已有的 `stage` 过滤（`PAST_REVIEW`），stage 本身是已知证据。
  - capability 关、或 capability 开但该 feature 没 consent → 每张卡都没有 `ext1` → 四项全未知，和 P1-A 之后的现状逐字一致。
  - 指标条 title 写覆盖率（如「12 / 15 张卡有扩展数据」），不显示部分和冒充总数。
- **验收线**：矩阵里 T2 / T3 / T6（有 stage 扩展时）/ T7（计数和结论）/ M3 / M4 / M5 只在对应卡有 `ext1` 时变成 present；
  审查原文仍然是 home_only；同一份 P1-C 夹具（含 `block`）团队侧与本机侧的审查结论、轮次、P0/P1、今日完成数字相同。
- **旧红新绿**（三类覆盖 + 枚举）：
  - capability 开、consent 关（卡上都没 `ext1`）：按 r0 规则会把 `unknownMetrics` 清空、`metricsOf` 把缺省累加成 0 → 红；
    新规则四项「暂无」→ 绿；
  - 老卡 / 新卡混合（2 张有 `ext1`、1 张没有）：`reviewRounds` 未知、title 显示 2 / 3 → 绿；
  - 全部有 `ext1` 且含审查数据（`round 2, p0 1, p1 2`）：`metricsOf` 结果和本机同夹具相同（`reviewRounds`、`fixed` 非 0）→ 绿；
  - **平均等复核混合卡（r2，用真实 `metricsOf`）**：review 卡 pending 60000ms 有 `ext1`、build/ops 卡 pending 180000ms 没有 `ext1`：
    本机平均 120000、团队只能算出 60000；按 r1「只看 review 阶段卡」的规则判已知 → 显示 60000 ≠ 本机 → 红；
    r2 规则判 `reviewWait` 未知、显示「暂无」→ 绿。再加一张 blocked 的 build 卡（没有 `ext1`）同样判未知；
    两张都补上 `ext1` 后团队平均 = 本机 120000 → 绿。（本轮已用隔离探针跑过真实 `metricsOf`：
    `{homeAvg:120000, teamAvg:60000, r1Known:true, r2Known:false, r1KnownBlocked:true, r2KnownBlocked:false}`。）
  - 源审查为 `block`：适配后 `eventLine` 显示「拦下」、`reviewRows[].verdict === "block"`、`lastReview.verdict === "block"` → 绿。
    （步骤线的结论来自 V1 `steps`，那里只有 `state` 没有 verdict，仍显示无结论——列为已知差异，不在本节点伪造。）
  - **事件 / 回放联通（r2，`tests/web-team-parity-ext-e2e*.test.ts`）**：本机事件 `stage{from:"build",to:"review"}`、`verify{result:"pass"}`
    → P1-G 投影 → 回环假中心 → P1-K `activity-ext` 严格解析 → `team-source-history.ts` 合并 → 真实 `eventLine` / `replayFrames`：
    事件行分别为和本机同夹具同一文案的阶段推进行（目标阶段 review）和「线上验证通过」，回放帧阶段为 build → review，`hasReplay === true`，和本机同夹具逐字相同；
    main 上（或只有 P1-F）同链路输出「推进阶段（目标阶段仅主场）」「线上验证（结果仅主场）」、`hasReplay === false` → 新断言红，修完绿。
    同一条事件在 `activity-ext` 里缺失时仍是脱敏占位（绿）；夹带 `text` 的响应被 P1-K 拒收，事件保持占位（绿）。
- **依赖**：P1-G（公开部分）、**P1-K（读回契约 + web 传输，r2）**、P1-B（`team-source-adapter.ts` 串行，B 先）、
  P1-F（`team-source-shared.ts`、`team-source-history.ts` 串行，F 先）；联调依赖私有中心。

### 5.4 依赖图与真实阻塞

```
P1-A ──► P1-B（collab-model.ts 串行）
  └────► P1-I（homeOnly 类型）
P1-C（并行；A/B/I 合并后更新矩阵）
P1-D ──(PM 批准只增扩展)──► P1-F（还需 P1-I、P1-B、P1-A 已合并；可以用假数据先行）
  └──► P1-E [私有 floka-ai/cloud，前置 CL1 gitlink] ──► P1-F 联调
P1-D ──► P1-G 公开部分（r3：用 extCapabilities().uploads.projectionExt1 判断能否上传）
P1-G 公开部分 ──(owner/PM 定审查出境)──► P1-K（还需 P1-D；读回 DTO + 严格解析 + web 传输）──► P1-H（还需 P1-B、P1-F 已合并）
  └── 中心一半 [私有，前置 CL1：存 ext1 + 实现 ext1 / activity-ext 读口] ──► P1-K / P1-H 联调
```

真实阻塞只有三处：**① PM 批准在 V1 冻结契约上做只增扩展（P1-D）；② owner / PM 定审查计数是否出境（P1-G）；
③ 私有中心的实现和部署（P1-E、P1-G 中心一半，前置 CL1）**。P1-K 的公开代码和回环测试不等 CL1。P1-A / C 马上可写；P1-B / I 只等 P1-A 合并（类型和串行文件），
不受三处真实阻塞影响。

---

## 6. 安全与出境（验收线 4）

- 沿用现有的四道闸，**一道不绕**：导出预检（`shared-ledger-export.ts` 的 refusal 报告）、主动共享（mirror entry 的
  `enabled` + 新的 `ext1Consent`）、签名（`SharedLedgerClient` 的 instance key 签名请求）、权限（credential grants：read / plan / project）。
- **永远不出境**：会话日志、任意文件、owner 消息、规格全文、审查 / 事件原文、本机 agent 名和 peer 名（成员只用代号 `actorCode`）、
  分支名、不在本机仓库里的 head（`mirrorTaskHeads` 规则不变）。
- 新增的读口只返回中心已经存了的、上传时已经过 scrub 的数据，不引入新的出境面；新增的投影字段只有数字 / 枚举 / 时间戳，
  并且双开关（中心 `ext-capabilities.uploads.projectionExt1` + 本机 consent）都开着才发；读能力不构成上传许可。
- 防降级：现有字段、现有包的形状、现有 capabilities 一律不删不改；每个节点都带"不开新开关时和 main 上逐字节一致"的快照测试。

---

## 7. 交付自查对照

| 验收线 | 本页位置 | 状态 |
|---|---|---|
| 1 逐项对照 + 文件符号 / 契约证据 | §2、§3（47 行，分 A–F） | 完成；每行都有代码证据，不只依据设计注释 |
| 2 隔离合成同数据、1200 / 390、深浅、前后截图 | §4 | 部分完成：桌面首页 + 详情、手机首页已实测；手机详情、版本 / 对比、谁在干活 / 团队标签**没有验证**，已经写明；截图没上传 |
| 3 可执行小节点（globs ≤ 16、字段、权限、验收、旧红新绿、依赖、公开 / 私有区分） | §5 | 完成：10 个节点（A/B/C/I 第一批，其中 B、I 等 A 合并；E 私有；r2 新增 K 读回契约）；§5.0 写明类型归属、未知语义和重叠文件串行顺序；最大 globs 15（P1-G，r4），A 14、F 12、K 9、H 8 |
| 4 沿用闸门、不降级、原文不出境 | §6 | 完成 |
| 5 完整方案 + 覆盖矩阵 + 第一批 + 真实阻塞 | §0、§3、§5.1、§5.4 | 完成 |

---

## 8. r1 修订记录（对应上一轮审查 lend:team-parity-P1:s1:r1:a0）

| 审查项 | 问题 | 本版怎么改 |
|---|---|---|
| activity-shape | P1-F 把活动映射成 `text:"", data:{}`，`eventLine` 出 "undefined" / 把成功 verify 显示成「失败」，`replayFrames` 全回落 spec | 新约定 `data.redacted: true`（P1-I 定义消费者规则：只显示类型 + 时间 +「详情仅主场」；缺 `to / verdict / result` 时不拼 undefined、不默认失败；无阶段证据 `stage = null`、`hasReplay = false`）。P1-F 必须在 P1-I 之后合并，T6 改为 home_only 直到 P1-H 的 stage 扩展。补了成功 verify / 缺 to 的 stage / 缺 verdict 的 review / 纯脱敏回放四条旧红新绿（§5.1 P1-I）。 |
| optional-metrics | capability 开、consent 关时把未知变成 0；扩展只映射 endTs / lastReview，没有 reviewRounds / p0 / p1 / reviewWait 来源 | `unknownMetrics` 从源级布尔改成每次总览给的列表（P1-A 定义）；P1-G 的 `ext1.metrics` 由导出端直接调本机 `taskMetrics()` 算，给齐 `endTs / reviewRounds / p0..p2 / reviewWaitSince`；P1-H 逐字段映射表 + 按覆盖率判定已知 / 未知（有一张参与求和的卡缺 `ext1` 就「暂无」，不回落 observedAt）。补了 consent 关 / 新老混合 / 有审查数据三类测试。 |
| node-scope | P1-B 置空边元数据违反必填类型且 `v4-props.tsx` 不在范围；P1-I 要扩 `InjectedSource` 却不含定义文件；todayDone 未知不在 A 的键里 | §5.0 写明类型归属：`unavailable / homeOnly` 加在 `CollabSource`（`team-source.ts`，P1-A），注入侧经 `extends` 自动可见，不需要改 `team-source-context.ts`；`todayDone` 进 P1-A 的 `unknownMetrics`。P1-B 范围加入 `collab-model.ts`（边元数据放宽为 `null`）、`v4-props.tsx`（显示「未记录」不调 `hhmm`）、`team-fixture-gen.ts`。新增重叠文件串行表；各节点 globs ≤ 14。另更正：DAG 对比 / 历史快照的英文报错只进 console，界面是版本页卡「加载中」，归 P1-F 修。 |
| review-enum | `verdict` 写成 `pass|changes|reject`，和真实 `pass|changes|block` 不符 | 改用真实枚举 `pass|changes|block|null`，不做转换；scrub 拒收枚举外值；P1-G / P1-H 各补一条 `block` 从投影 → 解析 → 适配 → UI 的回归。 |

## 9. r2 修订记录（对应上一轮审查 lend:team-parity-P1:s1:r2:a0）

| 审查项 | 问题 | 本版怎么改 |
|---|---|---|
| node-scope | P1-F 要求版本页显示「未记录」/「团队暂无历史版本」，但实际消费者 `dag/dag-props.tsx`（`VersionRow` 无条件查 `REASON_ICON` + `hhmm(createdAt)`，`VersionsPage` 只有列表和「正在读取…」）不在范围；`createdAt: at ?? 0`、映射出的 reasonKind 会显示 1970 和假原因 | P1-F globs 加 `dag-props.tsx`、`dag-types.ts`、`i18n-dict-collab.ts` 和渲染测试（12 个）；`VersionMeta.reasonKind / proposedBy / createdAt` 放宽为 `null`，`FeatureDetail.history?: "unavailable"`，本机照旧给值；团队映射一律 `null` 不填 0 / 假枚举；`VersionRow` 的未知分支和 `VersionsPage` 的不可用分支写清；补三条渲染旧红新绿；§5.0 写明版本页消费者只归 P1-F。 |
| optional-metrics | `reviewWait` 只看 review 阶段卡是否有 `ext1`，而 `metricsOf` 对所有卡聚合 pending，build/ops 卡缺 `ext1` 时团队平均 60000 冒充本机 120000 | 改为总览里**全部卡**都有 `ext1` 才已知（缺 `ext1` 时 stage 不能证明不参与）；`reviewRounds` 同样按全部卡；`fixed` 按 V1 stage 过滤保留并说明理由。补混合 review/build、blocked 两条旧红新绿；本轮用真实 `metricsOf` 隔离探针复现：r1 规则 `known:true` 且 60000≠120000（红），r2 规则 `known:false`（绿）。 |
| event-readback | 事件扩展只有上传端，没有中心 → 浏览器的读契约；`verify.result` 无载体，P1-D 的严格 activity 解析拒收 | 新增节点 **P1-K**：`features/{id}/ext1` 和 `features/{id}/activity-ext/{after}` 两条新读口的 DTO、严格解析（与 P1-G 共用 schema，拒收文本 / 枚举外值）、capability / consent / 缺项三种缺省行为（都是未知，不是 0 / 失败）、gate-proxy 放行、web 传输类型；P1-G 的事件扩展改为放在卡 `ext1.eventExt` 里（不改 V1 `projection.events`）；P1-H 加 `team-source-history.ts` 合并和 verify pass + stage to 的「导出 → 中心响应 → 严格解析 → 事件行 / 回放」联通测试。 |
| （自查）能力发现 | P1-D 原写「capabilities 新增 read.*」，但 `shared-ledger-contract-responses.ts:10-13` 对 `capabilities` 逐键 `literal` 严格解析，加键会让老客户端拒收全部 features 响应 | 改为独立的 `GET …/ext-capabilities`，老中心 404 = 全关；同理 P1-G 不再往 V1 detail 响应里加 `ext1`。 |

## 10. r3 修订记录（对应 r3 审查，head 5354098）

| 审查项 | 问题 | 本版怎么改 |
|---|---|---|
| extension-capability-contract | 新 `ext-capabilities` DTO 只有 `reads`，P1-G 却按不存在的 `projection.ext1` 门控上传（加回旧 `capabilities` 又破坏严格兼容）；发现路由没有分派、中心实现和成功路径测试 | P1-D DTO 加 `uploads:{projectionExt1}`，读写分开，**只有 `uploads.projectionExt1` 授权上传**；`SharedLedgerClient.extCapabilities()`（404 → 全关常量，旧 `capabilities` 解析不动）；P1-G 写明导出端取得路径（mirror-loop 每轮、consent 开才问、直连中心、`PushDeps.ext1Upload`，失败一律按 V1 原包、不计失败）、中心拒收时同轮 V1 重发，globs 加 `shared-ledger-mirror-loop.ts` 和测试（12），依赖 P1-D；P1-D 写明 `actionFor` 实际在 `src/bridge/local-api/shared-ledger.ts:22-26`，`read` 加 `ext-capabilities / versions / activity` 三条及 `handleSharedLedgerApi` 三支（versions/activity 按响应 `projectId` 过滤，DTO 因此加 `projectId`，P1-K 两条同理）；P1-E 实现发现路由、P1-G 中心一半负责翻 `uploads / reads.ext1*`。测试：新中心（读写全开）/ 只读中心 / 老中心 404 三种发现响应 + 旧 features 夹具逐字不变；P1-G 能力 × consent 六格（只读中心 + consent 不得上传）。 |

## 11. r4 修订记录（对应 r4 审查，head f275d13）

| 审查项 | 问题 | 本版怎么改 |
|---|---|---|
| extension-client-scrub | P1-G 把 `shared-ledger-client.ts` 排除在范围外，但真实上传走 `SharedLedgerClient.projection()`，它在请求前用 V1 `parseSharedLedgerProjection` 二次 scrub（`shared-ledger-client.ts:166-168`），V1 task schema 没有 `ext1`（`shared-ledger-contract-transfer.ts:11-17`）→ 扩展包本机即被拒，到不了中心，"中心 4xx 重发"接不住；假 `MirrorClient` 测试绕过了这一层 | P1-G globs 加 `shared-ledger-client.ts`（新增 `projectionExt1()`，用 `parseSharedLedgerProjectionExt` scrub，同一 `POST projections` 与响应校验）和 `shared-ledger-auth.ts`（`authenticateSharedLedgerRequest` 可选 `projectionExt1` 开关，缺省 V1）及其测试，共 15 个；`projection()`、`parseSharedLedgerProjection`、bridge 代理一律不改，保持 V1-only；`MirrorClient` 加可选 `projectionExt1?`，没有就退回 V1；V1 重发调 `projection(stripExt1(…))`。§5.0 串行表把 client 改为 P1-D → P1-G → P1-K。新增真实链路测试 ⑦–⑪：投影 → 真实 `SharedLedgerClient` → 回环假中心（真实入站鉴权）收到 `ext1`；`projection()` 与 bridge 代理对同一扩展包本机拒收、假中心 0 请求；中心未开扩展解析时真实 400 → 同轮 V1 重发；普通 V1 上传逐字节不变。 |
