# 团队视图 ↔ 本机协作视图 1:1 核对与实施规格（team-parity-P1）

> 规格 specRev 1 · 基线 `a538824a` · 只读核代码，本页是唯一改动；产品代码一行没改。
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
8. **第一批马上可以开写（不依赖 CL1、不改契约）**：P1-A（去掉误调用和假 0）、P1-B（用上已经读到的字段、
   修掉假「今日完成」和边归属）、P1-C（真正"同一份数据双喂"的对照夹具）、P1-I（权限差异显式化）。
   需要 PM 拍板的是 P1-D（V1 冻结契约做只增不改的读口扩展）和 P1-G（审查计数能不能出境）。

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
  并且只有中心在 capabilities 里声明支持之后才发**，不能直接往 V1 里加字段（否则老中心会拒收整包，导致现有公开数据降级）。

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
| DAG 对比 | `fetchDagDiff` | 直接抛 `'Shared version comparisons are unavailable'`（英文原文进 UI） |
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
| G4 | 依赖边：建立者 / 时间 / 状态 | `LedgerDepView.createdBy/createdAt/state` | `createdBy: f.updatedBy`、`createdAt: f.updatedAt`（feature 级冒充边级）；`state: null` | 契约里没有边元数据 | **F**（错误归属，`v4-props.tsx:105` 显示「{who} 建于…」）＋D | P1-B |
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
| T5 | 最近 3 件事 | `events` → `recentThree` | 整块不显示 | `events: []`；中心 `source_event_mirrors` 存了 `{sourceSeq,sourceTaskId,type,at,summary=kind}` | **C**（只有类型和时间）；原文属 E | P1-D/E/F |
| T6 | 回放这条任务 | `collab-replay*.ts` 吃 events | 不显示 | 同 T5 | C（能回放类型 / 时间轴）＋E（原文） | P1-F |
| T7 | 审查（轮次、结论、P0/P1/P2） | `reviewRows(events)` / `lastReview` | 不显示 | 投影里只有 `events.type = "review"`，没有计数和结论 | D（计数、结论枚举）＋E（审查原文） | P1-G/H（需要 PM 定能不能出境） |
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
| M3 | 今日完成 | `metrics.endTs ?? updatedAt` ≥ 零点（`collab-model.ts homeView.todayDone`） | `updatedAt = projection.observedAt`，`metrics: {}` → 镜像今天刷过就把所有 done 都算进去；实测因夹具 `observedAt` 早于今天显示 0（本地 4） | `team-source-adapter.ts teamOverview` | **F**（假数据）；真正修复要完成时刻（D） | P1-B（先改成暂无）→ P1-H |
| M4 | 审查轮次 / P0P1 修掉 | `metrics.reviewRounds`、events | `unknownMetrics` → 「暂无」 | `team-source-shared.ts unknownMetrics: true` | D（已经诚实地显示暂无） | P1-H |
| M5 | 平均等复核 | `reviewWaitPendingMs` | 「—」 | D | D | P1-H |
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
节点之间 fileGlobs 不重叠；每个节点都要「旧红新绿」：先写一个能复现当前错误、在 main 上为红的测试，修完变绿。

### 5.1 第一批 · 马上可以开写（不等 CL1，不改契约）

#### P1-A · 团队视图不再误调本机接口，不显示假 0（公开 · web）

- **范围 globs（11）**：`web/features/collab/team-source.ts`、`web/features/collab/team-source-shared.ts`、
  `web/features/collab/collab-view.tsx`、`web/features/collab/use-collab-extra.ts`、`web/features/collab/work/use-work-board.ts`、
  `web/features/collab/work/work-board-view.tsx`、`web/features/collab/use-team-activity.ts`、`web/features/collab/team-panel.tsx`、
  `web/features/collab/dag/use-dag-panes.tsx`、`tests/web-team-parity-calls*.test.ts`、`tests/web-team-parity-metrics*.test.ts`
- **契约字段**：`CollabSource` 增加可选项 `local?: false`（或者 `unavailable?: ReadonlySet<"lastSeen"|"workBoard"|"presence"|"ownerWaits"|"teamPanel">`）；
  `sharedCollabSource` 声明这几项都不可用。本机源不声明，行为完全不变。
- **读写权限**：只读；不新增任何网络请求。
- **验收线**：注入团队源后，`/me/last-seen/*`、`/ledger/shared-ledger:*/work`、`/team/activity?project=shared-ledger:*`、
  `/peers/contacts`、`/team/quota` 都是 0 次请求；「在场 agent」「待你处理」显示「暂无」（带 title 说明原因），不显示 0；
  「谁在干活」标签在团队视图里隐藏，或者显示「仅主场可见」；本机视图的截图和请求序列不变。
- **旧红新绿**：在 happy-dom 里挂 `CollabView` + 注入团队源，记录 fetch 路径。main 上能抓到 `/me/last-seen/shared-ledger:` → 红；修完 → 绿。
- **依赖**：无。

#### P1-B · 用上读口已经给的字段，去掉假数据（公开 · web 适配层）

- **范围 globs（7）**：`web/features/collab/team-source-adapter.ts`、`web/features/collab/team-source-dag.ts`、
  `web/features/collab/dag/shared-product-model.ts`、`web/features/collab/team-source-steps.ts`（新建，steps → stepLine 的纯函数）、
  `tests/web-team-source.test.ts`、`tests/web-team-source-fields*.test.ts`、`tests/web-team-source-product*.test.ts`
- **契约字段（只读现有字段）**：`TaskProjection.assigneeCode` → `LedgerTaskView.agent`，以「成员代号」显示，加标记让详情不出现
  「打开会话」；`steps[]`（`sourceStepId = step:round`）→ `stepLine{steps, active}`；`asks[]` → 阻塞提问数；`head` → 短 SHA；
  `executorInstanceId` → 执行实例（像 id 的不显示原文）；`Feature.projection` + `stale()` → 总览和详情里的「镜像过期」提示；
  `Feature.counts` 和节点算出来的进度做交叉校验，不一致时以中心 `counts` 为准并打 warn。
- **去假数据**：边的 `createdBy/createdAt` 不再填 feature 级的值，改为空，EdgePage 显示「暂无」（改 adapter 的输出，
  不改 `v4-props.tsx`）；`updatedAt` 继续用 observedAt，但在 `metrics` 里明确标 `endTs: null`，团队源声明 `todayDone` 未知，
  指标条显示「暂无」（和 P1-A 共用 `unavailable` 机制，P1-B 只改 adapter / source 的输出）。
- **读写权限**：只读。
- **验收线**：同一个夹具下团队详情显示负责人代号、步骤线、阻塞提问数、镜像状态；「今日完成」显示「暂无」，不再按 observedAt 计数；
  边页不再把 feature 修改人当成边的建立者；没有 UUID 被当成标题（沿用 `looksLikeId`）。
- **旧红新绿**：`teamOverview` 单测：给 3 张 done 的卡、`observedAt = now`，main 上算出 `todayDone = 3` → 红，修完是「未知」→ 绿；
  `assigneeCode` 在 main 上被丢 → 红。
- **依赖**：P1-A 的 `unavailable` 键（只依赖类型，可以并行，最后合并时按 P1-A → P1-B 的顺序）。

#### P1-C · 真正"同一份数据双喂"的对照夹具（公开 · 测试）

- **范围 globs（6）**：`web/features/collab/shared/team-fixture-gen.ts`、`web/features/collab/shared/fixture-harness.tsx`、
  `web/features/collab/shared/home-fixture-gen.ts`（新建）、`tests/web-shared-ledger-browser.test.ts`、
  `tests/web-team-parity-browser*.test.ts`、`tests/helpers/team-parity-matrix.ts`
- **契约字段**：夹具从**一份本机台账形状的数据**出发（`LedgerOverview` + 每张卡的 `TaskDetail`，events 带完整的 `data`，
  再加 DAG 的 `versions[]`），用一个和 `mirrorTaskProjections` 字段规则相同的纯函数推出 `FeatureDetail`。
  本地路由只返回本地数据，**不准再用 `teamDagBoard` / `sharedProductBoard` 喂本地**。
- **读写权限**：只在测试进程里起回环服务器；截图目录由环境变量指定，不进 git。
- **验收线**：1200 / 390 × 浅 / 深 × 本地 / 团队，首页、任务详情（手机先进 feature 再点卡）、版本页、对比页、谁在干活、团队标签各一张；
  每个区块输出 `{section, local: present|absent, team: present|absent|home_only}`，和 `team-parity-matrix.ts` 里写死的期望矩阵
  （就是本页 §3 的 A–F 分类）逐项比对。之后每补一个节点，只能把对应项从 absent 改成 present，不能悄悄改期望。
- **旧红新绿**：把现有的「本地 DAG 由 teamDagBoard 生成」改掉之后，矩阵检查能抓到 T3 / T5 / T7 的差异（在 main 的
  harness 下这些差异看不到）。
- **依赖**：无（可以和 A / B 并行；A / B 合并后更新期望矩阵）。

#### P1-I · 权限差异显式化（公开 · web 视图）

- **范围 globs（5）**：`web/features/collab/collab-detail.tsx`、`web/features/collab/collab-detail-model.ts`、
  `web/features/collab/collab-i18n.ts`、`web/lib/i18n-dict-shared-ledger.ts`、`tests/web-team-parity-home-only*.test.ts`
- **契约字段**：`InjectedSource` 增加 `homeOnly?: ReadonlySet<"events.text"|"review.text"|"sessions"|"say"|"spec.full">`。
  对应区块显示「仅主场可见」占位，不是整块消失。DAG 对比的英文报错改成 i18n 文案。
- **读写权限**：只读。
- **验收线**：团队详情里「最近 3 件事」「审查」「参与者 · 打开会话」在没有数据时显示「仅主场可见 / 暂无」，有可出境数据时
  （P1-F / P1-H 之后）显示数据但不显示原文；本机视图不变。
- **旧红新绿**：main 上团队详情没有「审查」区块（整块隐藏）→ 断言占位存在 → 红；修完 → 绿。
- **依赖**：无（文案和 P1-A 的「暂无」统一）。

### 5.2 第二批 · 读口契约（公开协议投影 / 共享读 API）

#### P1-D · V1 只增不改的读口：版本历史和活动流水（公开 · 契约 + 客户端 + bridge 代理 + web 传输）

- **范围 globs（12）**：`src/lib/shared-ledger-contract-reads.ts`（新建，不改冻结文件里的已有类型）、
  `src/lib/shared-ledger-contract-responses.ts`、`src/lib/shared-ledger-client.ts`、`src/bridge/local-api/shared-ledger.ts`、
  `src/lib/shared-ledger-gate-proxy.ts`、`web/lib/api/shared-ledger.ts`、`web/lib/api/shared-ledger-reads.ts`（新建）、
  `src/lib/shared-ledger-contract-fixtures.ts`、`tests/shared-ledger-contract-reads*.test.ts`、`tests/shared-ledger-client-reads*.test.ts`、
  `tests/shared-ledger-gate-proxy*.test.ts`、`tests/web-shared-ledger-reads*.test.ts`
- **契约字段**：
  - `GET /v1/teams/{team}/features/{id}/versions` → `{schemaVersion:1, teamId, serverSeq, versions: {version, reason, nodes, bindings, at: number|null, by: string|null}[]}`；
    `by` 是成员代号（`actorCode`），不是人名。
  - `GET /v1/teams/{team}/features/{id}/activity/{afterServerSeq}` → `{serverSeq, items: ({src:"center", serverSeq, kind, by, at} | {src:"home", sourceSeq, taskId, type, at})[], truncated}`；
    `taskId` 是中心 id；**不含任何原文**（投影上来的 `summary` 本身就等于 kind）。
  - capabilities 新增 `read.versions`、`read.activity`（`enabled:false` 时 web 退回现状）。
  - 路径参数不用 query：现有代理遇到 `new URL(req.url).search` 一律 400。`actionFor` 的正则只放行上面两条 `read`。
- **读写权限**：read grant，和 `features/{id}` 同一道门；跨项目一律 403，响应体相同（沿用 X12 §3.1 的原则）。
- **验收线**：代理对这两条路径按 `read` 选凭据、按 projectId 过滤；老中心（没有 capability）时 web 不发请求；
  响应解析器拒收多余字段；改 `shared-ledger-gate-proxy.ts` 时按 CLAUDE.md 的规定在 baseline 里留 `raised[]` 记录。
- **旧红新绿**：main 上代理对 `features/x/versions` 返回 400 → 红；修完 → 绿。客户端解析器对带 `text` 字段的 activity 拒收（绿，防止原文漏出）。
- **依赖**：**PM 批准在冻结的 V1 上做只增不改的扩展**（class=design；默认做法：新文件 + capability 门控，不改已有类型）。不依赖 CL1。

#### P1-E · 中心实现版本 / 活动读口（**私有 floka-ai/cloud**）

- **范围**：floka-ai/cloud 里中心的 reads / service 路由（具体 glob 由私有仓库给）；公开仓库**不实现**。
- **契约字段**：按 P1-D。`versions` 从 `dag_versions` / `source_dag_mirrors` 读（`data.reason` 已有），`at/by` 按 `events`
  里 `kind IN ('dag.init','dag.rewrite','import')` 的 serverSeq 关联；`activity` 从 `events` 和 `source_event_mirrors` 合并按序输出。
- **读写权限**：只读；鉴权和 `detail()` 相同。
- **验收线**：契约测试用公开仓库的 `shared-ledger-contract-fixtures.ts` 夹具，双方都通过。
- **依赖**：**CL1（固定 gitlink）** + P1-D 契约合并。

#### P1-F · 团队视图用上版本 / 活动（公开 · 共用 UI 适配层）

- **范围 globs（6）**：`web/features/collab/team-source-history.ts`（新建）、`web/features/collab/team-source-dag.ts`、
  `web/features/collab/team-source-shared.ts`、`web/features/collab/dag/dag-diff.ts`、`tests/web-team-source-history*.test.ts`、
  `tests/web-team-source-activity*.test.ts`
- **契约字段**：`versions` → `VersionMeta{version, reasonKind: v1 ? "initial" : "requirement_change", reasonText: reason, proposedBy: by ?? "", approvedBy: null, createdAt: at ?? 0, cancels: [], scopeChange:false, askId:null}`。
  `reasonKind` 不是中心给的，UI 上标「类型未记录」，不能把映射值当成事实显示。
  `snapshot` 从对应版本的 nodes 生成；对比用两份快照在前端算（新增纯函数，产出 `DagDiffResponse` 形状）。
  `activity` → `TaskDetail.events{kind:type, text:"", actor: by|"主场", data:{}}`，给「最近 3 件事」和回放用（只有类型 / 时间）。
- **读写权限**：只读；capability 关着时保持 P1-I 的「暂无」。
- **验收线**：P1-C 矩阵里 G5 / G7 / G8 / T5 / T6 从 absent 变成 present（原文仍然是 home_only）；不出现 "unavailable" 英文。
- **旧红新绿**：`teamDagFeature(board, id, 1)` 在 main 上抛错 → 红；有 versions 时返回快照 → 绿。
- **依赖**：P1-D（类型）；联调依赖 P1-E。写代码和单测可以用假数据先行，**不用等 CL1**。

### 5.3 第三批 · 投影契约扩展（需要 owner / PM 定出境范围）

#### P1-G · 投影可选字段：时间线 / 完成时刻 / 轮次 / 审查计数（公开导出端 + 私有中心）

- **公开范围 globs（10）**：`src/lib/shared-ledger-contract-projection-ext.ts`（新建）、`src/lib/shared-ledger-contract-transfer.ts`、
  `src/lib/shared-ledger-projector.ts`、`src/lib/shared-ledger-export.ts`、`src/lib/shared-ledger-scrub.ts`、
  `src/lib/shared-ledger-mirror.ts`、`tests/shared-ledger-projector-ext*.test.ts`、`tests/shared-ledger-client-scrub-ext*.test.ts`、
  `tests/shared-ledger-export-ext*.test.ts`、`tests/shared-ledger-mirror-ext*.test.ts`
- **契约字段（全部可选；只有中心 capability `projection.ext1` 开着才发）**：
  `TaskProjectionExt{stageSince:number|null, completedAt:number|null, round:number, timeline:{stage, from, to}[], reviews:{round, verdict:"pass"|"changes"|"reject", p0, p1, p2, at}[]}`，
  事件扩展 `stage` 类型带 `{from, to}`（只用阶段枚举）。**不含任何自由文本**。
- **出境闸**：所有字段都过 `scrubSharedLedger`（数字 / 枚举也走一遍，防止出现未知字段）；mirror entry 上新增显式开关
  `ext1Consent`（默认关，开启走现有导出预检，`shared-ledger-export.ts` 的 refusal 报告列出新字段）。不开 → 和现在完全一样，
  **现有的公开数据不降级**。
- **私有部分**：中心接收和存储扩展字段、`detail()` 在 `capabilities` 开着时回传（floka-ai/cloud，依赖 CL1）。
- **验收线**：没有 capability 时发出的包和 main 上逐字节一致（快照测试）；有 capability 但没有 consent 时也一致；
  两者都开时只多出上面这些字段；scrub 遇到夹带文本的 review 拒收。
- **旧红新绿**：投影快照测试，main 上没有 `timeline` → 新断言红；开 consent 后变绿；未开时的快照保持绿（防降级）。
- **依赖**：**owner / PM 决定审查结论和 P0/P1/P2 计数能不能出境**（class=design；默认：只出枚举和计数，原文永远 home_only）；
  中心那一半依赖 CL1 + P1-E 的部署通道。公开导出端可以先合并（capability 默认关，等于不生效）。

#### P1-H · 团队视图用上扩展字段（公开 · 共用 UI 适配层）

- **范围 globs（4）**：`web/features/collab/team-source-adapter.ts`、`web/features/collab/team-source-shared.ts`、
  `tests/web-team-source-ext*.test.ts`、`tests/helpers/team-parity-matrix.ts`（只更新期望值）
- **契约字段**：`stageSince/completedAt/round/timeline/reviews` → `LedgerTaskView.stageSince/metrics.endTs/round/lastReview`、
  `TaskDetail.timeline`、`events(kind:"review", data:{round, verdict, p0, p1, p2})`；`unknownMetrics` 只在 capability 关着时为 true。
- **验收线**：矩阵里 T2 / T3 / T7（计数）/ M3 / M4 / M5 变成 present；审查原文仍然是 home_only。
- **依赖**：P1-G（公开部分）；联调依赖私有中心。
- **和 P1-B 的冲突**：两个节点都改 `team-source-adapter.ts`，按顺序串行（P1-B 先），不并行派。

### 5.4 依赖图与真实阻塞

```
P1-A ─┐
P1-B ─┼─(合并后更新矩阵)─ P1-C
P1-I ─┘
P1-D ──(PM 批准只增扩展)──► P1-F（可以用假数据先行）
  └──► P1-E [私有 floka-ai/cloud，前置 CL1 gitlink] ──► P1-F 联调
P1-G 公开部分 ──(owner/PM 定审查出境)──► P1-H
  └── 中心一半 [私有，前置 CL1]
```

真实阻塞只有三处：**① PM 批准在 V1 冻结契约上做只增扩展（P1-D）；② owner / PM 定审查计数是否出境（P1-G）；
③ 私有中心的实现和部署（P1-E、P1-G 中心一半，前置 CL1）**。P1-A / B / C / I 不受任何一处阻塞。

---

## 6. 安全与出境（验收线 4）

- 沿用现有的四道闸，**一道不绕**：导出预检（`shared-ledger-export.ts` 的 refusal 报告）、主动共享（mirror entry 的
  `enabled` + 新的 `ext1Consent`）、签名（`SharedLedgerClient` 的 instance key 签名请求）、权限（credential grants：read / plan / project）。
- **永远不出境**：会话日志、任意文件、owner 消息、规格全文、审查 / 事件原文、本机 agent 名和 peer 名（成员只用代号 `actorCode`）、
  分支名、不在本机仓库里的 head（`mirrorTaskHeads` 规则不变）。
- 新增的读口只返回中心已经存了的、上传时已经过 scrub 的数据，不引入新的出境面；新增的投影字段只有数字 / 枚举 / 时间戳，
  并且双开关（中心 capability + 本机 consent）都开着才发。
- 防降级：现有字段、现有包的形状、现有 capabilities 一律不删不改；每个节点都带"不开新开关时和 main 上逐字节一致"的快照测试。

---

## 7. 交付自查对照

| 验收线 | 本页位置 | 状态 |
|---|---|---|
| 1 逐项对照 + 文件符号 / 契约证据 | §2、§3（47 行，分 A–F） | 完成；每行都有代码证据，不只依据设计注释 |
| 2 隔离合成同数据、1200 / 390、深浅、前后截图 | §4 | 部分完成：桌面首页 + 详情、手机首页已实测；手机详情、版本 / 对比、谁在干活 / 团队标签**没有验证**，已经写明；截图没上传 |
| 3 可执行小节点（globs ≤ 16、字段、权限、验收、旧红新绿、依赖、公开 / 私有区分） | §5 | 完成：8 个节点（4 个马上可写，1 个私有） |
| 4 沿用闸门、不降级、原文不出境 | §6 | 完成 |
| 5 完整方案 + 覆盖矩阵 + 第一批 + 真实阻塞 | §0、§3、§5.1、§5.4 | 完成 |
