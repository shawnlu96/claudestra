# 共享台账 V2 · 阶段二（卡在中心、任意成员推进 / 换主场）设计与拆分

本稿只出设计和节点拆分，不写代码、不改测试、不改 DAG。基线 main 27cd5f32（2026-10-09）。
它替代 [shared-ledger-v2-x12-split.md](shared-ledger-v2-x12-split.md)（下称「拆分稿」）里 X12A–F 的节点表，
并重写 [shared-ledger-v2.md](shared-ledger-v2.md)（下称「v2 稿」）里 X13 / X15 的依赖与验收线。两稿的不变量全部保留：
execution 默认关；本机缓存 / outbox 不算授权；中心不可用直接失败，不回退本机权威。

中心服务端在私有仓库。本稿不读、不写私仓内容，中心侧只写公开契约（`src/lib/shared-ledger-contract-v2*.ts` 等）层面的需求，
每条标「中心侧，PM 在私仓开卡」。本文出现的实例只叫本机 / peer A / peer B。

## 0. 结论速览

- 拆分稿 18 条 X12 职责里：0 条已完整覆盖，11 条部分覆盖（模块已在 main 但没接线，或阶段一只做了规划侧），7 条未做；
  #1–3、#5、#6 共 5 条的中心侧部分（原 X12A/X12B）转成 §5 的中心侧需求。X13 的 9 条（含换主场）、X15 的 5 条职责无一完整覆盖，
  其中 6 条可复用契约或阶段一的批次导入模式（部分覆盖）。
- 公开仓剩余工作拆成 **21 个节点**（§3）：每个 ≤2 小时，合计 38 小时实现；fileGlobs 两两不重叠（§4 核对输出）。
- **首批 12 个节点可同时开工**（只依赖已在 main 的 X7/X8/X9/X10/X11 及本稿冻结的接口），第二批 2 个，之后串行汇合。
- 关键路径（每卡另加 1 小时审查）：S2K → S2C → S2T → S2F → X13 → X13H → X15 → X15R = 22.5 槽小时，再加中心侧等待 W。
- 中心侧 8 条需求（§5）；契约只增不改，单列契约节点 S2K（§5.2）。
- 每个改调度 / 合并主流程的节点都受按项目的 `off / observe / on` 开关控制，默认 off；`on` 只对放行清单里的项目生效（§2.2，
  演练项目由 owner 事前授权、正式项目由 X15R 签字放行）；执行权切换失败或上线后出问题都有回到阶段一的路径（§7）。

## 1. 现状对照表

依据只用公开仓 main（27cd5f32）的代码与文档。「合并」列是 main 上的合并提交短号。
路径简写：`…-v2-<x>.ts` 即 `src/lib/shared-ledger-contract-v2-<x>.ts`；未写目录的 `shared-ledger-*.ts`、`scheduler-*.ts`、`ledger-*.ts` 均在 `src/lib/`。
「已在 main 未接线」的判断依据：`grep -rln <模块名> src web scripts` 除模块自身和同族文件外无引用（2026-10-09 实测）。

### 1.1 已上线、与阶段二相关的节点索引

| 节点 | 合并 | 做了什么（公开仓位置） |
|---|---|---|
| X0 | c675fb2d | V2 契约：命令表含 `home.change` / `migration.commit`（`src/lib/shared-ledger-contract-v2-commands.ts:61-63`）、角色与 executionOnly 策略（:79-87）、回执（:92-96）、迁移清单（`…-v2-transfer.ts:143-177`）、回执查询（`…-v2-transfer.ts:178-181`）、事务外观（`…-v2-transaction.ts:64-130`） |
| X1–X6、X14 | cf0eb7b2 等 | 中心域模块；已由 cloud-CL1 迁出公开仓（a1180a97，#636），公开仓不再有 `src/shared-ledger/**` |
| X7 | 09f803ec | 执行客户端与写门：`shared-ledger-exec-gate.ts:46-69`、`shared-ledger-exec-client.ts:36-78`、`shared-ledger-exec-local.ts:28-91`；**未接线** |
| X8 | 60e78cfc | 调度中心闸与独立部署：`scheduler-central.ts:29-63`、`scheduler-central-worker.ts:26-60`、`scheduler-central-deploy.ts:19-70`；**未接线** |
| X9 | 66d6de35 | 出借中心代理与 outbox：`ledger-lend-central.ts:32-148`；**未接线** |
| X10 / X11 | 2582cdb6 / 250e69a2 | 网页开卡编辑与审批组件 `web/features/collab/shared/task/**`、`approve/**`；只有样式被 N7W 复用，组件**未挂载** |
| TV1 | 34b52a1f | 团队视图数据源（`web/features/collab/team-source*.ts`），删除了旧 shared-view / shared-ledger 页面 |
| C6 | b2b1a790 | 批次导入 prepare / commit / revoke（`src/lib/shared-ledger-import-run.ts:93-262`），batch 回执续做 |
| N7K / N7KD | 510825c0 / 35c2622b | 提案契约、绑卡 / 撤销绑定体（`…-v2-feature-proposals.ts:133-142`）、`featureBaseDigest` |
| N7B / N7B2 / N7W | af2020d5 / 2390531b / de1ce16a | 本机提案通路与本机 API（`src/bridge/local-api/shared-feature-proposals.ts:1-5`）、网页提案表单与 owner 审批卡 |
| N7X / N7X2 / N7X3 | 5f598157 / 3debd3d4 / c247f0dd | 中心副本（planning + centerPlanned，`shared-ledger-center-replica.ts:1-10`、`:190-191`）、start_node 先中心认领（`shared-ledger-center-start.ts:1-26`）、改图转 revise 提案（`shared-ledger-center-revise.ts:1-5`） |
| N7X4 / N7X5 / N7X5F / N7X5G | 85cfd3fa / 0c787026 / a9147965 / 4933fb9f | 中心已绑本机无认领提示、撤销中心绑定（`shared-ledger-center-unbind.ts:1-10`） |
| N8 / N8A–N8A4 | 594f8435 / 761a19af / 4603fa27 / 195a24c4 / 27cd5f32 | 协作视图入口；进行中 feature 自动只读共享（`shared-ledger-auto-share.ts:1-12`，按项目 off/observe/on：`shared-ledger-auto-share-state.ts:13`、`:49`） |
| N8M / N8MK / N8MA / N8F | 9647bef3 / b9003ed7 / 2d6fb5a7 / 3bd74fa5 | 来源 DAG 新版本上传（`shared-ledger-source-dag-push.ts:1-6`）、镜像新鲜窗口 |

阶段一的形态：feature 的规划在中心（提案、副本），**卡和执行仍在主场本机台账**；本机模式文件只有 source / planning 两种在用
（`shared-ledger-mode.ts:10-13`），全仓没有任何代码把 `authorityMode` 写成 `execution`（`grep -rn 'authorityMode: "execution"' src scripts` 无结果）。

### 1.2 拆分稿 §4 的 X12 职责（`shared-ledger-v2-x12-split.md:129-148`）

| # | 职责（原节点） | 状态 | 依据 | 新去向 |
|---|---|---|---|---|
| 1 | 统一事务组合：域 schema 安装 + 单事务 + 事件 + 不可变回执（X12A） | 中心侧未知，公开仓未做 | 只有事务外观 `…-v2-transaction.ts:64-130`；域模块已迁出（a1180a97） | CS1 |
| 2 | 跨域端口（X12A） | 同上 | `…-v2-transaction.ts:32-36` 只定义 `V2DomainModule` | CS1 |
| 3 | 全部命令入口核模式 / epoch / 代际 / bootId（X12A，中心权威） | 部分：本机预检有、未接线；中心侧未知 | `shared-ledger-exec-gate.ts:51-69`（模式 :59-62、栅栏 :63-64、主场 :66） | CS1；本机侧 S2F |
| 4 | execution 总开关默认关（X12A 中心 / X12F 本机） | 部分：本机模式默认 source，无 execution 开关 | `shared-ledger-mode.ts:57-60` | CS1 + S2S（开关与放行清单）+ S2F |
| 5 | 中心真实路由、commands 分派、migrations、reads/identity（X12B） | 中心侧未知，公开仓无 `/v2/` 路由 | `grep -rn "/v2/teams" src web` 无结果 | S2K（路由契约）+ CS2 |
| 6 | 本人 / 服务身份映射，不收 body actor，403 不泄露（X12B） | 部分：V1 签名凭据与公共鉴权已有 | `shared-ledger-mode.ts:116-124`；N8MA 2d6fb5a7 | CS2 |
| 7 | 真实 reply 建中心业务 ask，三入口共用记录（X12C） | 未做；阶段一只有提案审批走中心 | X7 `createAsk/answerAsk` `shared-ledger-exec-client.ts:79-83` 无调用方；提案审批 de1ce16a | S2A |
| 8 | ask 薄接线，runtime permission / AUQ 留本机（X12C） | 未做 | `src/bridge/asks.ts:284` `commitAnswer` 只写本机 askDb | S2A |
| 9 | 出借：主场代理中心 claim / beat / result，恢复先查回执（X12D） | 部分：X9 模块在、未接线 | `ledger-lend-central.ts:89-147`；`src/bridge/lend-tools.ts` 未引用 | S2L |
| 10 | 独立部署链四处接线、每步在线核验（X12D / X12F） | 部分：X8 模块在、未接线 | `scheduler-central-worker.ts:23-26` 注释「X12 routes --deploy-job here」；`src/scheduler.ts:62-64` 仍走本机 | S2M + S2F |
| 11 | 自动阶段 / 调度 pass 不对 execution feature 本机推进（X12D） | 部分：自动开工对非 source feature 停 | `scheduler-autostart.ts:129`；`scheduler-pass.ts:112` 无模式判断 | S2D + S2I + S2J |
| 12 | TV1 数据源接线：开卡 / 改字段 / 审批 / 能力禁用（X12E） | 部分：提案表单与审批卡已上（规划侧），执行字段未接 | N7W de1ce16a；X10/X11 组件无挂载 | S2W |
| 13 | 本机 API 代理与 DTO（X12E） | 部分：提案本机 API 已有，执行命令无 | `src/bridge/local-api/shared-feature-proposals.ts:1-5` | S2E |
| 14 | DAG / 订单 MCP 在 execution 上走中心（X12E） | 部分：start_node 先认领、改图转提案；deliver / verdict 未做 | `shared-ledger-center-start.ts:1-26`、`shared-ledger-center-revise.ts:1-5`；`src/bridge/order-tools.ts:57` 仍本机 | S2E |
| 15 | 中心客户端单例、真实传输、模式文件（X12F） | 部分：V1 签名客户端与模式文件在，V2 传输无 | `shared-ledger-mode.ts:81-104`；X7 `ExecTransport` `shared-ledger-exec-client.ts:16-20` 无实现 | S2T + S2F |
| 16 | 持久写门：本机台账写入口对 execution 一律拒（X12F） | 部分：规划写门有（改图 / 绑卡 / 开节点），卡的阶段 / 交付 / 审查写入无门 | `shared-ledger-gate.ts:6-31`、`ledger-dag-write.ts:179`、`:245`、`:277`；`ledger-tx.ts:26-33` 无模式判断 | S2G |
| 17 | manager 命令：回执查询 / outbox 显式重交（X12F） | 未做 | `src/manager/ledger.ts:79-81` 命令表无此类；X9 `recover` `ledger-lend-central.ts:139-147` 无调用方 | S2F |
| 18 | 热点文件接入（X12F 等） | 未做 | 见 §3.3 | 各节点例外 |

### 1.3 X13（`shared-ledger-v2.md:250-259`，拆分稿 `:415-416`）

| # | 职责 | 状态 | 依据 | 新去向 |
|---|---|---|---|---|
| 1 | 暂停新派单 | 未做（无按 feature 冻结字段） | `shared-ledger-mode.ts:13` 模式只有 authority/sharedPlanning/mirror/centerPlanned | S2G（`migrating` 字段）+ S2D（冻结路由）+ X13 |
| 2 | 迁前备份 | 部分：导入批次自带备份 | `shared-ledger-import-run.ts:159`（批次备份清理） | X13 |
| 3 | 处理活单 / unknown | 未做 | X8 journal `scheduler-central-journal.ts`、X9 outbox 无汇总读 | X13 |
| 4 | 映射、规格副本、审查证据核全 | 部分：契约有清单与证据位 | `…-v2-transfer.ts:143-171`（evidence 八项、mappings 完整） | X13 + CS3 |
| 5 | 旧单结清或显式导入核租约 | 部分：契约要求 `leases.length === 0`、旧单状态 | `…-v2-transfer.ts:155-158` | X13 |
| 6 | 持久门 + 全组切换 + 中心租约 | 部分：模式文件在写锁下原子切换 | `shared-ledger-mode.ts:78-104` | X13 + S2G + S2R |
| 7 | 失败查 batch 回执，不恢复旧权威 | 部分：V1 导入已是此模式 | `shared-ledger-import-run.ts:135`、`:181`；N8A 自动批次 `shared-ledger-auto-share.ts:7-9` | X13 |
| 8 | 中心 `executionEnabled` 与本机模式同由批次回执驱动（拆分稿 §7.2） | 未做 | 无 | X13 + CS3 |
| 9 | 换主场（v2 稿 :49、:51；契约已有 `home.change`） | 未做 | `…-v2-commands.ts:61-62` 只有形状 | X13H + CS4 |

### 1.4 X15（`shared-ledger-v2.md:271-279`，拆分稿 `:417`）

| # | 职责 | 状态 | 依据 | 新去向 |
|---|---|---|---|---|
| 1 | 本机 / peer A / peer B 网页开卡、借单、审查到 owner 合并闭环 | 未做 | 无 e2e；`tests/shared-ledger-v2-e2e*` 不存在 | X15（合成）+ X15R（真实） |
| 2 | 失租、崩溃、丢回执、断网、活单迁移、unknown 逐项留证 | 部分：X8 / X9 单模块测试覆盖失租与丢回执 | `scheduler-central.ts:35-62`、`ledger-lend-central.ts:69-73` | X15 |
| 3 | 旧备份冻结、升代际、回执对账 | 中心侧 + 未做 | 契约 `parseGeneration` `…-v2-scheduling.ts:56-63` | CS7 + X15R |
| 4 | 全部节点通过才开放 execution | 未做 | 无开关 | S2S 放行清单 + X15R 放行 |
| 5 | 真实传输 ↔ 真实中心路由冒烟（拆分稿 §7.3） | 未做 | 无 V2 传输 | X15R |

## 2. 阶段二目标形态与冻结接口

### 2.1 形态

1. **卡在中心**：一组 feature 经 X13 迁到 execution 后，tasks / 依赖 / 步骤 / 工作流 / 业务 ask / 出借订单 / 调度意图都由中心单写。
   主场本机台账里的卡行变成**执行投影**：只由 S2P 的专用投影写入器按中心快照写入（不经 `ledger-write` 公开函数），其余本机写入口一律被 S2G 写门拒绝。
   这样现有调度、worker、网页读本机行的代码不用全改，读到的是中心状态。
2. **任意成员推进**：成员在自己的 bridge（网页 / CLI / MCP）发 V2 命令（`task.new` / `task.set` / `task.spec` / `dep.*`、业务 ask 答复），
   中心按角色核准（`…-v2-commands.ts:79-87`）；需要副作用的步骤（派单、阶段、合并、部署）只由主场在租约与意图下执行（S2R / S2I / S2J / S2M）。
   成员不能控制别人的执行者（v2 稿 :42-43）。DAG 改动继续走阶段一的提案通路（N7B / N7X3），中心对 execution feature 同样受理（CS6）。
3. **换主场**：owner 授权 + 旧主场停推 + 活单结清 + unknown 核清后，`home.change` 递增 epoch；旧主场 S2R 失租即停，新主场 S2R 领租（X13H）。
4. **回到阶段一**：切换前失败 = 本机模式不变，阶段一继续；切换后要回退 = X13B 走中心 revert，feature 回 planning（中心副本），卡回主场本机台账。

### 2.2 冻结接口（节点间只靠这些，不互相 import 实现；改动先回 PM 改本稿）

**开关与放行清单**（S2S 实现，S2F 读后注入各端口）：`src/lib/shared-ledger-v2-switch.ts` 导出
`readStage2Switch(localProjectId, dir?, now?): "off" | "observe" | "on"`（文件 `shared-ledger-v2-switch.json`，0600，缺省 / 损坏 = off，
写法照 `shared-ledger-auto-share-state.ts:13-49`）、`writeStage2Switch(localProjectId, mode, dir?)` 与放行清单读写
（文件 `shared-ledger-v2-release.json`）。放行条目 `{ kind: "drill" | "release"; askId; grantedAt; expiresAt? }`，只由 owner 经 S2F CLI 写：
`drill` = 演练项目的事前授权（必带 `expiresAt` ≤ 7 天，项目须是专为演练新建的本机项目，见 §6）；`release` = X15R 签字后的正式放行。
**`on` 只在有有效条目时生效**：写 `on` 时无条目拒绝；读时条目缺失 / 过期 / 撤销，`readStage2Switch` 返回 `observe`（降级不升级）。
撤销 = `ledger shared-exec release <项目> --revoke`，立即生效（下一次读即 observe）。

**模式字段**（S2G 实现）：`SharedLedgerMode` 增两个可选字段，校验写进 `shared-ledger-mode.ts` 的 `modeFile`：

- `centerExecution?: { centerId; teamId; projectId; centerFeatureId; epoch }`，只允许 `authorityMode === "execution"`；
- `migrating?: { batchId; kind: "execute" | "revert" | "home" }`，任意 authorityMode 可带，存在即冻结该 feature 的本机派单与写入。

**路由规则**（冻结；S2D 的 `schedulerV2Route` 实现，S2F 以端口 `route(taskId)` 注入 S2I / S2J / S2M / S2L / S2A / S2E，各节点不自己判）。
按顺序取第一条命中：
1. 卡属 feature 带 `migrating`（任意 authorityMode、任意开关档）→ `skip`：不派单、不推阶段、不合并、不部署、写命令返回 409 `migrating`；
   回执未知期间 `migrating` 保持，故一直 skip，直到 X13 / X13H / X13B 按回执清掉它；
2. 非 execution → `local`（原路径）；
3. execution 且开关有效档为 `on` 且端口非 null → `central`；
4. 其余（execution + off / observe / 端口 null）→ `skip`。

**投影写入**（S2G 冻结授权、S2P 实现写入器）。阶段一的 `createTask` / `importTask` / `moveStage` 对投影都走不通
（规划门 `shared-ledger-center-claims-gate.ts:11-20` 不认 execution；非 spec 建卡只给 owner / import，`ledger-checks.ts:109-118`、`:285-286`；
`applyMove` 要现算角色，`ledger-write.ts:195-218`），所以投影**不经 `ledger-write` 公开函数**，照副本专用写入器的先例
（`shared-ledger-center-replica-write.ts:1-6`、`:62-103`：自己 `tx` + 直接 SQL + `insertEvent`）另写一个专用写入器：
- S2G 在 `src/lib/shared-ledger-v2-write-gate.ts` 导出 `PROJECTION_ACTOR = "shared-ledger-v2-projection"` 与
  `withProjectionScope(db, ref: { featureId; centerSeq; batchId? }, fn)`：进入时核 `centerSeq` 大于该 feature 已落投影事件的最大 centerSeq，
  且 feature 处于 `execution + centerExecution`（无 `migrating`）或带 `migrating` 且 `ref.batchId === migrating.batchId`；通过后在同步事务内置一个
  模块级令牌，`fn` 返回 / 抛出即清。
- 写门（`ledger-tx.ts` 的 `insertEvent`）对 execution / migrating feature 只放行「actor = `PROJECTION_ACTOR` 且令牌在、令牌 featureId 与目标卡一致」
  的事件，并强制事件 data 带令牌的 `centerSeq` 与 `featureId`；令牌外用投影身份字符串一律拒。
- S2P 的 `src/lib/shared-ledger-v2-projection-write.ts` 是**唯一**以投影身份写的模块：`tx(db, () => withProjectionScope(db, ref, () => …))` 里
  直接 upsert tasks / deps / steps 行（阶段、round、headSHA 照快照落，不过阶段机，因为中心已按角色核过），每张卡一条 `kind: "task"`、
  `data.op: "center-projection"` 事件。它要 import `ledger-tx`，所以 S2P 认领 `tests/ledger-migrate.test.ts` 白名单加 1 行（§2.3）。

**configure 端口**（传 `null` 或从未调用 = 中心未接好：execution feature 的入口一律 `unavailable`，非 execution 卡走原路径）：

| 节点 | 文件 | 导出 |
|---|---|---|
| S2A | `src/bridge/shared-ledger-v2-asks.ts` | `configureSharedAsks(port: { mode(p): Switch; clientFor(p): SharedLedgerExecClient \| null; featureOfTask(taskId): ExecFeatureRef \| null } \| null)` |
| S2L | `src/bridge/shared-ledger-v2-lend.ts` | `configureLendCentral(port: { mode(p): Switch; transportFor(p): LendCentralTransport \| null; grant: LendCentralGrantDeps; outboxDir: string } \| null)` |
| S2E | `src/bridge/shared-ledger-v2-entry.ts` | `configureSharedExecEntry(port: { mode(p): Switch; clientFor(principal, p); snapshot(principal, p, featureId); receipt(principal, query) } \| null)` |
| S2D | `src/lib/scheduler-v2-pass.ts` | `configureSchedulerV2Pass(port \| null)`；`schedulerV2Route(taskId): "local" \| "skip" \| "central"` |
| S2I | `src/lib/scheduler-v2-intent.ts` | `configureSchedulerV2Intents(port \| null)`（port 含 `route(taskId)`，下同）；`withSchedulerV2Intents(deps: AutoTickDeps): AutoTickDeps` |
| S2J | `src/lib/scheduler-v2-merge.ts` | `configureSchedulerV2Merge(port \| null)`；`withSchedulerV2Merge(external: MergeExternal, project): MergeExternal` |
| S2M | `src/lib/scheduler-v2-deploy.ts` | `centralDeployDeps(openClient, route)`；`runDeployJobV2(path, deps)` |
| S2R | `src/lib/scheduler-v2-lease.ts` | `startStage2Leases(port): { stop(); current(featureId): V2Fence \| null }` |
| S2P | `src/lib/shared-ledger-v2-projection*.ts` | `writeExecutionProjection(db, view, ref)`（投影写入器）；`syncExecutionProjection(db, port: { snapshot(p, featureId): Promise<unknown> })` |
| S2T | `src/lib/shared-ledger-v2-transport.ts` | `createStage2Transport(conn)`：X7 `ExecTransport`、X9 `LendCentralTransport`、X8 `SchedulerCentralClient`、快照 / 迁移 / 回退读写 |

`ExecFeatureRef = { localFeatureId; projectId; centerFeatureId; epoch }`；`p` 为本机项目 id；`Switch` 即上面的三态。

**本机 API**（S2E 实现，S2W 调用）：`GET /api/v1/shared-exec/features/{featureId}?project=`、`POST /api/v1/shared-exec/commands`、
`GET /api/v1/shared-exec/receipts/{requestId}?project=&operationId=&commandDigest=`、`GET /api/v1/shared-exec/asks/{askId}?project=`。
用 `shared-exec` 前缀而非拆分稿的 `/shared-ledger/v2/`，避免被 `src/bridge/local-api/index.ts:48` 的 `sharedLedgerGateProxy` 族先吞掉。
actor 只由 Principal 映射，body 带 actor / role 返回 400。

### 2.3 热点文件规则

热点 = 任务列出的 `src/bridge.ts`、`src/scheduler.ts`、`src/manager/ledger.ts`、`src/lib/scheduler-pass.ts`，
加上 2026-09-09 起非 merge 提交 ≥15 次的文件（`git log --no-merges --since=2026-09-09 --format=%h -- <f> | wc -l`，2026-10-09 实测）：
`src/manager/ledger.ts`(75)、`src/lib/scheduler-auto-tick.ts`(63)、`src/lib/scheduler-merge-driver.ts`(36)、`web/features/collab/collab-view.tsx`(32)、
`src/lib/ledger-write.ts`(29)、`src/bridge/local-api/index.ts`(29)、`src/lib/scheduler-auto-deps.ts`(27)、`src/lib/scheduler-pass.ts`(27)、
`src/bridge/asks.ts`(21)、`src/bridge/ask-entry.ts`(21)、`src/bridge/order-tools.ts`(16)、`src/lib/scheduler-merge-external.ts`(16)、
`tests/ledger-migrate.test.ts`(52)；参考 `src/bridge.ts` 188、`src/scheduler.ts` 12。

热点文件不进任何节点 fileGlobs。新逻辑放新文件，热点只加 ≤3 行接入（`git diff --numstat` 新增 ≤3、删除 ≤3），每个热点只指定一个节点接：

| 热点 | 接入节点 | 接什么 |
|---|---|---|
| `src/bridge/asks.ts`（`:284` commitAnswer） | S2A | 入口调 `sharedAskAnswer(i)`，共享 ask 交中心后直接返回 |
| `src/bridge/ask-entry.ts`（`:259` initAskWiring） | S2A | 调 `initSharedAskWiring()` |
| `src/lib/scheduler-pass.ts`（`:112` schedulerPass） | S2D | 逐卡前 `schedulerV2Route(taskId) === "skip"` 时跳过 |
| `src/lib/scheduler-auto-deps.ts`（`:160` autoTickDeps 返回） | S2I | 返回值包一层 `withSchedulerV2Intents(...)` |
| `src/lib/scheduler-merge-external.ts`（`:39` 返回） | S2J | 返回值包一层 `withSchedulerV2Merge(..., project)` |
| `src/bridge/local-api/index.ts`（`:47-53` FAMILIES） | S2E | 加 `handleSharedExecApi` 族（import + 1 行） |
| `src/bridge/order-tools.ts`（`:57` deliver） | S2E | execution 卡的 deliver 先交 `sharedExecDeliver` |
| `src/lib/ledger-write.ts` | S2G | 预计 0 行（写门在 `ledger-tx.ts`）；只在某写入口不经 `insertEvent` 时补 `assertLocalWrite`；投影不走这里 |
| `tests/ledger-migrate.test.ts`（`:346` ledger-tx 白名单） | S2P | 白名单加 `lib/shared-ledger-v2-projection-write.ts` |
| `web/features/collab/collab-view.tsx` | S2W | execution feature 挂执行面板 |
| `src/bridge.ts`（`:3290` 附近 init 区） | S2F | import 后调 `initSharedLedgerV2()` |
| `src/scheduler.ts`（`:62-64` --deploy-job） | S2F | 守护进程起 `initSchedulerV2()`；deploy-job 分支传 `centralDeployDeps(...)` |
| `src/manager/ledger.ts`（`:79-81` COMMANDS） | S2F | 并入 `SHARED_EXEC_CMDS` |

`src/lib/scheduler-auto-tick.ts`、`src/lib/scheduler-merge-driver.ts` 不接任何节点：调度与合并的切入点分别在 auto-deps 与 merge-external 的端口层。

## 3. 新节点表

| key | 一句话 | 依赖 | 估时 | 热点例外 |
|---|---|---|---|---|
| S2K | 契约：V2 路由、快照视图、回退请求（只增不改） | 无 | 1.5h | 无 |
| S2A | 业务 ask 全链路改走中心 | 无 | 2h | asks.ts、ask-entry.ts |
| S2L | 出借代理与中心结果回写接线 | 无 | 2h | 无 |
| S2G | execution 写门、模式字段与投影授权 | 无 | 2h | ledger-write.ts（预计 0 行） |
| S2S | 阶段二开关与放行清单 | 无 | 1.5h | 无 |
| S2D | 调度 pass 路由闸（local / skip / central） | 无 | 1h | scheduler-pass.ts |
| S2R | 主场租约领取、续租与失租停推 | 无 | 2h | 无 |
| S2I | 自动派单 / 阶段经中心意图执行 | 无 | 2h | scheduler-auto-deps.ts |
| S2J | 合并闸经中心意图与 owner 授权 | 无 | 2h | scheduler-merge-external.ts |
| S2M | 独立部署 job 接中心 | 无 | 1.5h | 无 |
| S2E | 本机执行 API 与 MCP 工具入口 | 无 | 2h | local-api/index.ts、order-tools.ts |
| S2W | 网页执行面板接 TV1 数据源 | 无 | 2h | collab-view.tsx |
| S2T | V2 签名传输（执行 / 出借 / 调度 / 迁移） | S2K、S2C | 2h | 无 |
| S2C | 合成 fake center（测试夹具） | S2K | 1.5h | 无 |
| S2P | 投影专用写入器与快照同步 | S2K、S2G | 2h | ledger-migrate.test.ts |
| S2F | 本机组合根、开关注入与 CLI | S2T、S2C、S2A、S2L、S2G、S2S、S2D、S2R、S2I、S2J、S2M、S2E、S2P | 2h | bridge.ts、scheduler.ts、manager/ledger.ts |
| X13 | 整组执行权迁移（planning → execution）与批次回执 | S2F、S2C、CS1、CS2、CS3 | 2h | 无 |
| X13H | 换主场（home.change） | X13、CS4 | 1.5h | 无 |
| X13B | 退回阶段一（execution → planning） | X13、CS5 | 1.5h | 无 |
| X15 | 合成三实例闭环与故障演练 | X13H、X13B、S2W | 2h | 无 |
| X15R | 真实三实例演练与放行记录 | X15、CS8 | 2h | 无 |

依赖图（CS* 是 §5 的中心侧需求，外部前置）：

```text
S2K ─┬► S2C ─┬► S2T ─┐
     │       └───────┼──────────────┐ (S2C 也直连 S2F、X13)
S2G ─┴────────► S2P ─┤
S2A S2L S2S S2D S2R S2I S2J S2M S2E ─► S2F ─► X13 ─┬► X13H ─┬► X15 ─► X15R
CS1 CS2 CS3 ───────────────────────────────► X13   └► X13B ─┘   ▲
S2W ────────────────────────────────────────────────────────────┘
```

- 首批（无未完成前置）12 个：S2K、S2A、S2L、S2G、S2S、S2D、S2R、S2I、S2J、S2M、S2E、S2W。
  第二批 S2C（等 S2K）、S2P（等 S2K、S2G）；第三批 S2T（等 S2C：其验收 3 要对 fake center 往返）。
- 关键路径（每卡 +1 小时审查）：S2K(1.5+1) → S2C(1.5+1) → S2T(2+1) → S2F(2+1) → X13(2+1) → X13H(1.5+1) → X15(2+1) → X15R(2+1)
  = 22.5 槽小时，另加中心侧 CS1–CS3 就绪等待 W；S2G → S2P 支路 6 槽小时，短于 S2K → S2C → S2T 的 8 槽小时。
  首批 12 卡在 6 槽下两波（约 6 槽小时），不在关键路径上。全图 38 实现小时 + 21 审查小时。
- 用到 S2C 夹具的验收（S2T 验收 3、S2F 验收 3、X13 全部）都把 S2C 列为直接前置，不靠传递依赖。
- S2F 之前没有任何执行权变化：各节点在开关 off（默认）时零中心请求、零行为变化（各自验收线写明）；S2S 合并前不存在能读出 `on` 的放行条目。

## 4. 核对：fileGlobs 两两不重叠

脚本解析本文附录每个节点的 fileGlobs / 例外 / 依赖，做五件事：
(1) 用 `git ls-files` + `Bun.Glob.match` 逐对算现有文件交集，并按受限语法（单个 `*` 或目录尾 `/**`）算未来路径相交；
(2) 例外文件必须是已跟踪的热点、不在任何 glob 里、每个只被一个节点认领；(3) 热点文件不落进任何 glob；
(4) 依赖无环、估时 ≤2；(5) 列出首批可并行节点。外部依赖（CS*）只记名不参与比较。

脚本全文在 [shared-ledger-v2-stage2-check.md](shared-ledger-v2-stage2-check.md) §1（在仓库根执行；解析本文附录）。

实测输出（工作树 head 27cd5f32 + 本稿第 2 版，2026-10-09；末行脚本输出为一行，此处按 7 个一行折排）：

```text
nodes=21 pairs=210 (all existing/planned 0/0) hours=38
hot exceptions=S2A:src/bridge/asks.ts, S2A:src/bridge/ask-entry.ts, S2G:src/lib/ledger-write.ts, S2D:src/lib/scheduler-pass.ts, S2I:src/lib/scheduler-auto-deps.ts, S2J:src/lib/scheduler-merge-external.ts, S2E:src/bridge/local-api/index.ts, S2E:src/bridge/order-tools.ts, S2W:web/features/collab/collab-view.tsx, S2P:tests/ledger-migrate.test.ts, S2F:src/bridge.ts, S2F:src/scheduler.ts, S2F:src/manager/ledger.ts
unclaimed hot=src/lib/scheduler-auto-tick.ts, src/lib/scheduler-merge-driver.ts
acyclic=yes external deps=CS1,CS2,CS3,CS4,CS5,CS8
first wave=12 S2K,S2A,S2L,S2G,S2S,S2D,S2R,S2I,S2J,S2M,S2E,S2W
per node tracked/globs/exceptions:
  S2K 0/2/0, S2A 6/8/2, S2L 4/6/0, S2G 2/4/1, S2S 0/2/0, S2D 0/2/1, S2R 0/2/0
  S2I 0/2/1, S2J 0/2/1, S2M 3/5/0, S2E 2/5/2, S2W 0/5/1, S2T 0/2/0, S2C 0/2/0
  S2P 0/2/1, S2F 0/5/3, X13 0/3/0, X13H 0/3/0, X13B 0/3/0, X15 0/1/0, X15R 0/1/0
```

脚本只证明本稿节点之间不重叠。X0 的 `src/lib/shared-ledger-contract-v2*.ts` 已合并完成，不再是在途卡，S2K 新文件落在其前缀下不算冲突。
PM 开工前请按最新 DAG 重跑，并与在途外部卡的 fileGlobs 再比一次；热点「≤3 行」由各节点验收线的 `git diff --numstat` 兜底。

## 5. 中心侧需求与契约节点

### 5.1 中心侧需求（均为「中心侧，PM 在私仓开卡」）

只写按公开契约中心需要新增或改的路由 / 行为，不写实现位置。

- **CS1 V2 组合根与单事务**：用 `createTransactionOwner`（`…-v2-transaction.ts:64`）把 tasks / asks / artifacts / leases / intents / lend / workflows
  七个域装进同一事务；每条命令「查回执 → 重新授权 → 核代际 / bootId / epoch → `V2_COMMAND_POLICY` 角色 + 服务动作 + orderId →
  executionOnly 命令在该 feature 未开放 execution 时返回 `execution_not_shared` → 域写入 → 一条事件 + 一条不可变回执」，任一失败整体回滚。
  execution 按 feature 开放，默认关，只由 CS3 的迁移提交打开。（中心侧，PM 在私仓开卡）
- **CS2 V2 路由与身份**：按 S2K 冻结的 `V2_ROUTES` 提供 commands / receipts / asks / features 快照 / lend 视图五条路由，形状过 S2K 的 parse；
  沿用 V1 签名凭据；actor 只从凭据映射（`parseActor` `…-v2-transfer.ts:32-36`），body 带 actor/role 返回 `invalid_field`；
  跨项目、不存在、无读权限返回字节相同的 403；撤成员即拒。出借结果用主场 service 凭据代表订单，orderId 只取自中心订单记录。（中心侧，PM 在私仓开卡）
- **CS3 迁移路由**：`POST …/migrations`（`parseMigration` dry-run / commit，`…-v2-transfer.ts:172`）与 `GET …/migrations/{batchId}`（回 `parseMigrationResult` 或 unknown）。
  对阶段一已在中心发布的 feature（V1 记录、提案、home bind），以 `authorityFrom: "planning"` 迁入时复用原记录，不另建重复 feature；
  提交即把 feature 的 authorityMode 置 execution、记 epoch、开 capabilities；同 batchId 同 digest 重放返回原结果，不同 digest 返回 `dedup_mismatch`。
  迁后 V1 详情如实报 `authorityMode: execution`（本机副本同步遇非 planning 即跳过，`shared-ledger-center-replica.ts:147`，本机无需改）。（中心侧，PM 在私仓开卡）
- **CS4 换主场**：受理 `home.change`（`…-v2-commands.ts:61-62`）：核 owner 授权 ask 的 `home.change` 动作、四项证据、`nextEpoch = epoch + 1`；
  同事务撤销旧主场调度租约，旧 epoch 的任何写入返回 `stale_epoch`。（中心侧，PM 在私仓开卡）
- **CS5 退回阶段一**：按 S2K 的 `parseRevertRequest` 受理 `POST …/reverts`、`GET …/reverts/{batchId}`：核 owner 授权、无活租约 / 活订单 / unknown，
  把 feature 置回 planning、epoch+1，回执带最终快照（`parseFeatureView`）供主场落回本机；回退后 V2 执行命令一律 `execution_not_shared`。（中心侧，PM 在私仓开卡）
- **CS6 提案通路覆盖 execution feature**：N7 提案（new / revise，`…-v2-feature-proposals.ts`）对 execution feature 继续受理；
  revise 批准后在同事务更新 V2 dag 与 `dag.bind`，绑定节点的 task 用 `task.new` 建在中心，不再要求主场本机先开卡（阶段一的 home bind 只用于 planning）。（中心侧，PM 在私仓开卡）
- **CS7 代际与备份**：从旧备份恢复须冻结、升 serviceGeneration、撤旧租约（`parseGeneration` `…-v2-scheduling.ts:56-63`），
  并让 receipts 路由对恢复前未确认的请求返回 unknown 而非 committed。（中心侧，PM 在私仓开卡）
- **CS8 部署与放行**：CS1–CS7 部署到中心并通过 S2C fake center 用到的同一组契约夹具（`…-v2-routes-fixtures.ts`）回放；
  另备一个只供演练的中心团队 / 项目，与正式团队的成员、feature、凭据作用域互不相通（演练凭据对正式项目一律 403）。
  这是 X15R 的前置。（中心侧，PM 在私仓开卡）

### 5.2 契约节点 S2K（参照 X0 冻结规矩）

现契约缺三样：路由路径常量与回包解析（拆分稿 §3.1 只在文档里）、feature 快照视图形状、退回请求 / 结果。
S2K 只**新增** `src/lib/shared-ledger-contract-v2-routes*.ts`，不改 `V2_COMMAND_NAMES`（`parseCapabilities` 要求全部命令键，
`…-v2-transfer.ts:23-31`，加命令会让旧中心的 capabilities 回包解析失败），不改任何已有导出。
冻结规矩照 v2 稿 §2 X0：S2K 合并后，其他节点发现缺字段一律回 PM 改本稿再开契约补丁卡，不在接线节点私加；中心侧经公开契约消费同一文件。

## 6. X13 / X15 的新依赖与验收线

- **X13**：deps 由 `X12, C6` 改为 `S2F, S2C, CS1, CS2, CS3`（S2F 传递覆盖全部 S2 接线；C6 已合并 b2b1a790）。fileGlobs 不变。
  执行权开关：项目开关有效档必须为 `on`（即有 drill 或 release 放行条目，§2.2），否则拒绝开批。回执：批次 id 落本机 journal，
  丢响应先 `GET migrations/{batchId}`，绝不换新 batchId 重提。冻结：写 `migrating` 后按 §2.2 路由规则第 1 条该 feature 一律 skip，
  与开关档无关。失败回滚：提交前任何失败清掉 `migrating`、模式不变（阶段一继续）；提交 unknown 时保持 `migrating`（继续冻结）、
  只做查询，不恢复旧权威也不开 execution。
- **X13H（新）**：换主场，deps `X13, CS4`。**X13B（新）**：退回阶段一，deps `X13, CS5`。两者并行。
- **X15**：deps 由 `X13` 改为 `X13H, X13B, S2W`；只用合成台账 + S2C fake center，fileGlobs 只留 `tests/shared-ledger-v2-e2e*.test.ts`。
- **X15R（新）**：真实三实例演练，deps `X15, CS8`；认领原 X15 的 `docs/testing/shared-ledger-v2-drills.md`。
  演练步骤见下；演练通过且 owner 签字后，owner 才给第一个正式项目写 `release` 条目，PM 再把它从 observe 改 on 并跑 X13。

**演练授权与正式放行（解开「先演练才能开 on、演练又要开 on」的循环）**：
- 演练项目：三台各新建一个只供演练的本机项目（名字以 `s2-drill-` 开头，仓库是专建的空演练仓库，不挂任何正式 feature），
  只连 CS8 的演练中心团队 / 项目。只有它能拿 `drill` 条目。
- 事前授权：X15R 开工前 owner 答复一条授权 ask（列出三台的演练项目名与有效期 ≤7 天），owner 用该 askId 跑
  `ledger shared-exec release <演练项目> --drill --ask <askId> --until <时间>`。S2S 拒绝给非 `s2-drill-` 项目写 drill 条目。
- 边界：drill 条目只让该演练项目的开关读出 `on`；正式项目仍被 §2.2 规则压在 observe 以下；演练凭据经 CS8 对正式项目 403。
- 撤销：任何一步未达预期，或演练结束，owner 跑 `--revoke`（或到期自动失效）→ 演练项目读出 observe，路由回 skip。
- 正式放行：X15R 文档 owner 签字后，owner 对正式项目写 `release` 条目（带签字 askId），之后才允许正式项目开 on、跑 X13。

X15R 三实例演练步骤摘要（本机 = 主场 H，peer A = 成员 M，peer B = 出借执行者 W）：

1. 三台都更新到含 S2F 的 main，各自项目开关 `observe` 跑一天，`ledger shared-exec observe-log` 无异常决定、中心请求数 0 写。
2. 按上面的事前授权写 drill 条目，H 演练项目开关 `on`；在演练项目建一个阶段一 feature（发布到演练中心、无活单），
   跑 `bun scripts/shared-ledger-execution-migrate.ts <feature> --dry-run`，再 commit；核三台网页都显示 execution。
3. M 在网页开卡（`task.new`）→ H 投影出现该卡 → H 调度经意图派单 → W 经出借领单 → 交付 → H 派审 → 审查通过。
4. owner 在 M 的网页答复合并授权 ask → H 合并闸经 merge 意图合并 → 回执 committed；记录每步 requestId / operationId。
5. 故障逐项：H 中途断中心（期望 unknown、资源占住、不重试）；W 交付时断网（期望 outbox、恢复只对账）；中心重启（bootId 变，旧租约失效）。
6. 换主场 H → M（X13H），核旧主场停推、M 领租后续推；再退回阶段一（X13B），核卡回到 M 本机台账、阶段一提案 / 副本照常。
7. 每步截图与命令输出脱敏后写入 drills 文档；任何一步未达预期即停，`--revoke` 演练条目，按 §7.3 回退。

## 7. 风险与开关

### 7.1 开关矩阵（按本机项目，默认 off；`ledger shared-exec switch <项目> off|observe|on`，S2F 提供；on 须有放行条目，否则读作 observe）

| 节点 | off | observe | on |
|---|---|---|---|
| S2A ask | 全部本机原路径 | 记录「本该走中心」的决定到 observe 日志，零中心写 | execution 卡业务 ask 走中心 |
| S2L 出借 | 原路径 | 记录决定，零中心写 | execution 订单经 X9 客户端 |
| S2D/S2I 调度 | execution 卡 skip（不本机推进） | skip + 记录将建的意图 | execution 卡经中心意图 |
| S2J 合并 | execution 卡不合并 | 不合并 + 记录 | merge 意图 + owner 授权 |
| S2M 部署 | central job 一律 blocked | blocked + 记录 | 每步在线核验 |
| S2E/S2W 入口 | execution 命令 503 unavailable | 只读快照可用，写命令 403 `execution_not_shared` | 全开 |
| 带 `migrating` 的卡（全部节点） | skip / 写命令 409 `migrating` | 同左 | 同左（路由规则第 1 条先于开关） |
| S2G 写门 | **始终生效**：execution / migrating feature 的本机写一律拒，只放行投影令牌内的投影写（不受开关影响） | 同左 | 同左 |

要点：execution feature 在 off / observe 下是**停住**而不是回退本机权威——要回本机执行必须走 X13B。
非 execution 的卡在三档下行为完全一样（共存验收线）。observe 只用于阶段一 feature 的影子比对。

### 7.2 共存验收线（每个改调度 / 合并主流程的节点都写进其规格：S2D、S2I、S2J、S2M、S2L、S2A）

1. off：节点相关旧测试全过（列文件）；对非 execution 卡与 execution 卡各跑一遍，中心传输 spy 调用 0 次。
2. observe：同一合成台账跑两遍（off 一遍、observe 一遍），本机 ledger events、registry 和 worktree 动作完全一致，observe 日志有对应决定，中心写 0 次。
3. on + 非 execution 卡：与 off 结果逐字段相等。
4. on + execution 卡 + 端口 null：返回 / 记录 `unavailable`，本机写 0 次。
5. 带 `migrating` 的卡（planning / execution 各一例，开关 on）：中心写 0 次、本机副作用 0 个（路由规则第 1 条）。

### 7.3 执行权切换失败 / 回到阶段一（主场执行）

| 时点 | 现象 | 处理 | 结果 |
|---|---|---|---|
| X13 dry-run 前后 | 前置不满足（活单、unknown、规格副本缺） | 拒绝开批，清 `migrating` | 阶段一不变 |
| X13 commit | 中心拒绝（4xx） | 清 `migrating`，模式不变，删本批临时备份 | 阶段一不变 |
| X13 commit | 丢响应 / 503 | 保持 `migrating`（本机派单 / 写入继续冻结），只 `GET migrations/{batchId}`；committed 才落模式，unknown 每次重查，3 次仍 unknown 报 PM | 冻结待核，不开 execution |
| 已切 execution | 中心长时间不可用 | 自动停（写门 + skip），在途 worker 成果留 outbox | 不回退本机权威 |
| 已切 execution | 决定回退 | 开关 observe（或撤放行条目）→ X13B：冻结、结清活单 / unknown、`POST reverts`、落最终快照、模式回 planning + centerPlanned | 回到阶段一（主场本机执行） |
| 换主场 | `home.change` 未确认 | 新旧主场都不领租，只查回执 | 停住待核 |

## 8. 公开内容自检

本稿不含私仓路径、私仓提交号、主机信息、凭据、人名或业务 / 商业内容；提交号均为公开仓 main 的合并提交。
审查员可跑 [shared-ledger-v2-stage2-check.md](shared-ledger-v2-stage2-check.md) §2 的 grep（对本文与该文件；除命令自身所在行外应无命中，其余命中须人工复核）。

## 附录 · 节点规格草稿（PM 审后拷成正式规格）

每份四节：背景 / PM 定 / 范围 / 验收线（缺 = P1）。共同禁区：不改 `src/lib/relay-protocol.ts` 与 relay 帧；不碰生产状态目录；
`src/lib` 不反向 import `src/bridge` 或 `web`；web 与 src 不互相 import；新模块 ≤400 行、测试 ≤600 行；只用自己的测试前缀；
不改 X7 / X8 / X9 文件（`src/lib/shared-ledger-exec-*.ts`、`src/lib/scheduler-central*.ts`、`src/lib/ledger-lend-central*.ts`）；
验收只用合成台账（临时 STATE_DIR）+ fake transport / S2C fake center，不读生产。

### S2K · 契约：V2 路由、快照视图、回退请求
deps：无；估时：1.5 小时。

**背景**：拆分稿 §3.1 的五条 V2 路由只存在于文档；快照视图与退回阶段一没有契约（本稿 §5.2）。

**PM 定**：只新增文件，不改已有导出与 `V2_COMMAND_NAMES`；路径以 `/v2/teams/{teamId}/projects/{projectId}/` 为根。

**范围**：
- `src/lib/shared-ledger-contract-v2-routes*.ts`
- `tests/shared-ledger-v2-stage2-contract*.test.ts`

**验收线**：
1. `V2_ROUTES` 覆盖 commands / receipts / asks / features / lend / migrations / migration 查询 / reverts / revert 查询九项，每项 method、path 构造器、请求与回包 parse 齐全；path 构造器拒绝含 `/`、`..` 的 id。
2. `parseFeatureView` = `{teamId, projectId, serverSeq, serviceGeneration, feature, dag, tasks, dependencies, steps, workflows, pendingAsks, capabilities}`，复用 X0 的 parse；task / feature 跨 scope 拒绝。
3. `parseRevertRequest`（batchId、featureIds、expectedEpoch、authorizationAskId、evidence 四项全 true）与 `parseRevertResult`（nextEpoch、最终 `parseFeatureView`）。
4. `…-v2-routes-fixtures.ts` 给每项一组合法与非法样例；测试逐项过 / 拒，并断言 `V2_COMMAND_NAMES` 与 `parseCapabilities` 未变（快照比对）。

### S2A · 业务 ask 全链路改走中心
deps：无；估时：2 小时。

**背景**：拆分稿 X12C；X7 `createAsk / answerAsk / cancelAsk / expireAsk / checkAuthorization`（`shared-ledger-exec-client.ts:79-83`）无调用方。

**PM 定**：只对 execution feature 的业务 ask 生效；runtime permission、AUQ、非共享 ask 一行不动；本机 askDb 只存展示映射（中心 askId → 本机消息）。

**范围**：
- `src/bridge/shared-ledger-v2-asks*.ts`
- `src/bridge/ask-reply.ts`
- `src/bridge/ask-dismiss.ts`
- `src/bridge/ask-expire.ts`
- `src/bridge/ask-locate.ts`
- `src/bridge/local-api/asks.ts`
- `src/manager/ledger-read-cmds.ts`
- `tests/shared-ledger-v2-stage2-asks*.test.ts`
- 例外 `src/bridge/asks.ts`：≤3 行，`commitAnswer` 入口调 `sharedAskAnswer(i)`
- 例外 `src/bridge/ask-entry.ts`：≤3 行，`initAskWiring` 里调 `initSharedAskWiring()`

**验收线**：
1. fake ExecTransport：execution 卡 reply → 恰好 1 条 `ask.create`，本机 askDb 无批准记录；非 execution 卡 → 0 条中心命令。
2. 同一 ask 从聊天 / 卡片 / Discord 三入口答复都打到同一中心 askId；第一次成功后其余返回中心冲突，本机不产生第二次批准。
3. 中心不可用：答复报错、askDb 不变；`ledger ask-check` 对该 ask 退出码非 0，且必须在线发 `authorization.check`（新 requestId），本机旧 approved 不能放行。
4. 撤销走 `ask.cancel`、过期只读中心状态，不在本机判过期。
5. §7.2 共存验收线五条；runtime permission / AUQ 现有测试全过（列文件）；两个例外文件 numstat 各 ≤3/≤3。

### S2L · 出借代理与中心结果回写接线
deps：无；估时：2 小时。

**背景**：拆分稿 X12D 出借部分；X9 `LedgerLendCentralClient`（`ledger-lend-central.ts:32-148`）未接线。

**PM 定**：只对 execution feature 的订单生效；绑定写本机 journal，恢复沿用原绑定，不重新钉到新租约；worker 只碰自己的订单。

**范围**：
- `src/bridge/shared-ledger-v2-lend*.ts`
- `src/bridge/lend-tools.ts`
- `src/bridge/lend-dispatch.ts`
- `src/bridge/local-api/lend.ts`
- `src/bridge/local-api/lend-inbox.ts`
- `tests/shared-ledger-v2-stage2-lend*.test.ts`

**验收线**：
1. fake LendCentralTransport：worker 交付 execution 订单 → `lend.result` 恰好 1 次，本机 `ledger-write.deliver` spy 0 次；换 orderId 返回 `forbidden`。
2. 首次 command 抛 unavailable → 结果进 outbox；重启再调只对账（`ready`）；显式 `recover(…, true)` 才重交且 requestId 不变。
3. beat 只续本订单（`lend.renew`），ended 观测报 `unknown_operation` 不续租。
4. §7.2 共存验收线五条；非 execution 订单的现有出借测试全过（列文件）。

### S2G · execution 写门、模式字段与投影授权
deps：无；估时：2 小时。

**背景**：拆分稿 X12F 写门；现规划写门不拦阶段 / 交付 / 审查写入（`ledger-tx.ts:26-33`）；X13 需要冻结字段与中心映射；
投影写不能走 `ledger-write` 公开函数（§2.2「投影写入」），要一个只给投影写入器的授权口。

**PM 定**：写门不受开关影响、始终对 execution 与 `migrating` 生效；投影只按 §2.2 的 `withProjectionScope` 令牌放行，
不认裸 actor 字符串；本卡不提供把模式写成 execution 的入口（只有 X13 写）。

**范围**：
- `src/lib/shared-ledger-v2-write-gate*.ts`
- `src/lib/shared-ledger-mode.ts`
- `src/lib/ledger-tx.ts`
- `tests/shared-ledger-v2-stage2-gate*.test.ts`
- 例外 `src/lib/ledger-write.ts`：≤3 行，预计 0 行

**验收线**：
1. 临时台账一张属于 feature F 的卡，F=execution 时 `ledger-write` 全部导出写函数（表驱动）都抛 forbidden，tasks 行与 events 与调用前一致；把 extra 清空 / 改归属再写的四个反例按旧归属拒绝并整体回滚。
2. F 带 `migrating` 时同样拒；F=planning / source 时原行为不变（现有 ledger 测试全过，列文件）。
3. 投影令牌：`withProjectionScope` 内以 `PROJECTION_ACTOR` 在 `tx` 里直接 SQL 改卡 + `insertEvent`（测试内联一个最小写入器，
   不经 `ledger-write`）放行，事件 data 带令牌的 centerSeq / featureId；centerSeq 不大于已落最大值、feature 不符、`migrating` 时 batchId 不符
   各拒绝；令牌外以 `PROJECTION_ACTOR` 调 `ledger-write.setTask` / `moveStage` 拒绝；`fn` 抛错后令牌已清（下一次裸写仍拒）。
4. 模式校验：`centerExecution` 只能配 execution、不能与 `centerPlanned` 共存；旧模式文件原样可读。
5. `ledger-tx.ts` 仍只被原名单 import（`tests/ledger-migrate.test.ts` 不改即过；本卡新文件不 import `ledger-tx`）。

### S2S · 阶段二开关与放行清单
deps：无；估时：1.5 小时。

**背景**：§2.2「开关与放行清单」；X15R 需要演练项目事前授权与正式放行分开，避免为验收绕过总开关。

**PM 定**：只提供读写函数，不提供 CLI（S2F 接）；有效档 = 开关档与放行条目取低；drill 条目只给 `s2-drill-` 前缀项目、必带 ≤7 天到期；
写条目要带 askId，不在本卡核 ask（S2F CLI 只认 owner 身份调用）。

**范围**：
- `src/lib/shared-ledger-v2-switch*.ts`
- `tests/shared-ledger-v2-stage2-switch*.test.ts`

**验收线**：
1. `readStage2Switch` 缺省 / 损坏 = off；开关与清单文件 0600、加锁、原子替换（照 `shared-ledger-auto-share-state.ts:13-49` 的测试写法）。
2. 写 `on` 无有效条目 → 拒绝；有 drill / release 条目 → 读出 on；条目过期（假时钟）/ 撤销 / 清单损坏 → 读出 observe，开关文件本身不改。
3. 给非 `s2-drill-` 项目写 drill、drill 无到期或超 7 天、条目缺 askId → 各拒绝；release 条目无到期限制。

### S2D · 调度 pass 路由闸
deps：无；估时：1 小时。

**背景**：拆分稿 X12D 调度部分；`scheduler-pass.ts:112` 对 execution feature 无判断。

**PM 定**：`schedulerV2Route` 严格按 §2.2 路由规则的顺序：`migrating`（任意模式、任意档）→ skip 先判；再非 execution → local；
execution + 有效档 on + 端口非 null → central（交 S2I）；其余 skip。开关有效档经端口读（S2F 注入 S2S 的 `readStage2Switch`）。

**范围**：
- `src/lib/scheduler-v2-pass*.ts`
- `tests/shared-ledger-v2-stage2-pass*.test.ts`
- 例外 `src/lib/scheduler-pass.ts`：≤3 行，逐卡前 skip 判定

**验收线**：
1. 表驱动 3 模式 × 3 开关 × 有无 migrating × 端口有无 全组合，路由与 §2.2 / §7.1 一致；凡带 migrating 一律 skip。
2. 合成台账跑真实 `schedulerPass`（经 `scheduler-pass.ts` 接入行）：planning + `migrating{execute}` + on、
   execution + `migrating{home}` + on 两例都零派单、零 ledger 事件、S2I 端口 0 次调用；skip 的卡 ledger events 计数不变；observe 档写一条 observe 日志。
3. §7.2 共存验收线五条；`scheduler-pass.ts` numstat ≤3/≤3。

### S2R · 主场租约领取、续租与失租停推
deps：无；估时：2 小时。

**背景**：v2 稿 §1 「仅登记主场领 scheduler_leases，60 秒租期 / 15 秒续租，bootId / epoch」（`shared-ledger-v2.md:46-47`）；公开仓无续租循环。

**PM 定**：只为 `centerExecution` 且主场 = 本实例的 feature 领租；中心时钟为准；失租立即停该 feature 的新副作用，不自动重领到新 epoch。

**范围**：
- `src/lib/scheduler-v2-lease*.ts`
- `tests/shared-ledger-v2-stage2-lease*.test.ts`

**验收线**：
1. fake client + 假时钟：启动发 `lease.acquire`，之后每 15 秒 `lease.renew`；`current(F)` 返回中心回执里的 fence。
2. renew 返回 `stale_epoch` / `lease_expired` / 连续 unavailable 超过租期：`current(F)` 立刻为 null，`onLost` 被调一次，不再自动 acquire。
3. 进程重启（新 bootId）：不沿用旧 fence，重新 acquire；`stop()` 发 `lease.release`。
4. 端口 null 或开关非 on：0 次中心请求。

### S2I · 自动派单 / 阶段经中心意图执行
deps：无；估时：2 小时。

**背景**：拆分稿 X12D「scheduler-apply 对 execution 改提交中心 intent」；X8 `executeSchedulerCentral`（`scheduler-central.ts:29-63`）无调用方。

**PM 定**：只包 `autoTickDeps` 的 manager / ensure 等副作用端口；每个副作用前 `intent.create` → `executeSchedulerCentral` → `operation.result`；不改 auto-tick 规划逻辑。

**范围**：
- `src/lib/scheduler-v2-intent*.ts`
- `tests/shared-ledger-v2-stage2-intent*.test.ts`
- 例外 `src/lib/scheduler-auto-deps.ts`：≤3 行，返回值包 `withSchedulerV2Intents`

**验收线**：
1. 路由只取端口 `route(taskId)`（不自读模式）；route=skip（含 migrating）的卡 0 次中心请求、0 个副作用。
   route=central 的卡：派 worker 前恰好 1 次 `intent.create`（action dispatch、稳定 operationId）+ 每步 `intent.check`；成功后 `operation.result` 1 次。
2. 副作用中途失租：结果 unknown、resourceHeld=true，后续副作用 0 次，不本机重试。
3. 阶段推进对 execution 卡发 `task.stage` 中心命令，本机 `applyMove` spy 0 次（由 S2P 投影回本机）。
4. route=local 的卡端口完全透传（对象相等 / spy 计数一致）；§7.2 共存验收线五条；`scheduler-auto-deps.ts` numstat ≤3/≤3。

### S2J · 合并闸经中心意图与 owner 授权
deps：无；估时：2 小时。

**背景**：v2 稿 §1「合并 / 发版 / 授权仅 owner」；契约要求 merge 意图必带授权 ask（`…-v2-commands.ts:127`）；合并队列现直接 `merge`。

**PM 定**：只包 `MergeExternal.merge` 与 `updateBranch`；按 PR 找到投影卡，取端口 `route(taskId)`：local 透传，skip（含 migrating）返回 wait 不合并，
central 走意图；缺有效 owner 授权时返回 wait 并提示，不合并。

**范围**：
- `src/lib/scheduler-v2-merge*.ts`
- `tests/shared-ledger-v2-stage2-merge*.test.ts`
- 例外 `src/lib/scheduler-merge-external.ts`：≤3 行，返回值包 `withSchedulerV2Merge`

**验收线**：
1. execution 卡：merge 前 `authorization.check`（action merge）+ `intent.create`（action merge、head = expectedHead）+ `intent.check`；成功后 `operation.result` 带 mergeSha。
2. 授权缺失 / 过期 / 绑定不符，或 route=skip（feature 带 migrating）：底层 merge spy 0 次，返回可读原因。
3. merge 调用超时：记 unknown，不重试；下一轮先对账。
4. 非 execution 卡 inspect / freshness / merge 全透传；§7.2 共存验收线五条；`scheduler-merge-external.ts` numstat ≤3/≤3。

### S2M · 独立部署 job 接中心
deps：无；估时：1.5 小时。

**背景**：拆分稿 X12D 部署部分；X8 `runSchedulerCentralDeployJob`（`scheduler-central-worker.ts:26-60`）未接线。

**PM 定**：route=central 的卡的部署 job 请求附 `schedulerCentralDeployment`（`scheduler-central-deploy.ts:19-23`）；route=skip（含 migrating）不建 job；
worker 见 `central` 字段走 X8 路径，缺 `deps.central` 直接 blocked。

**范围**：
- `src/lib/scheduler-v2-deploy*.ts`
- `src/lib/scheduler-deploy-job.ts`
- `src/lib/scheduler-deploy-worker.ts`
- `src/lib/scheduler-deploy-steps.ts`
- `tests/shared-ledger-v2-stage2-deploy*.test.ts`

**验收线**：
1. fake client 第 1 步后 `intent.check` 抛 `stale_epoch`：第 2 步 argv 从未执行，结果 unknown、resourceHeld=true，`result.json` 记 unknown。
2. central job 缺 `deps.central` → blocked、0 条 argv；非 central job 走原路径，旧部署测试全过（列文件）。
3. §7.2 共存验收线五条。

### S2E · 本机执行 API 与 MCP 工具入口
deps：无；估时：2 小时。

**背景**：拆分稿 X12E 去掉网页部分；阶段一已有提案本机 API（N7B）与 start_node 先认领（N7X2）。

**PM 定**：路由用 §2.2 的 `shared-exec` 前缀；MCP：execution 卡的 start_node 走 `task.new` + `dag.bind`、deliver 走 `task.deliver`、submit_verdict 走 `task.review`；非 execution 不变。

**范围**：
- `src/bridge/shared-ledger-v2-entry*.ts`
- `src/bridge/local-api/shared-exec*.ts`
- `src/bridge/dag-tools.ts`
- `src/bridge/review-tools.ts`
- `tests/shared-ledger-v2-stage2-entry*.test.ts`
- 例外 `src/bridge/local-api/index.ts`：≤3 行，FAMILIES 加 `handleSharedExecApi`
- 例外 `src/bridge/order-tools.ts`：≤3 行，deliver 先问 `sharedExecDeliver`

**验收线**：
1. POST commands body 带 actor 返回 400；端口收到的 actor 等于 Principal 映射；receipts 端口收到完整五个查询字段，committed / unknown 原样透传，写调用 0 次。
2. 端口 null → 503 unavailable；observe 档写命令 403 `execution_not_shared`，快照 GET 可用。
3. execution 卡调 deliver → 端口收到 `task.deliver`，本机 `ledger-write.deliver` spy 0 次；非 execution 卡 spy 1 次。
4. 两个例外文件 numstat 各 ≤3/≤3；`/api/v1/shared-ledger/*` 现有测试全过（证明未被新族吞掉）。

### S2W · 网页执行面板接 TV1 数据源
deps：无；估时：2 小时。

**背景**：拆分稿 X12E 网页部分；X10 `TaskEditor` / X11 `ApprovalPanel` 已在 main 未挂载；TV1（34b52a1f）的数据源。

**PM 定**：只在 execution feature 上挂面板；不新做视觉系统，复用 X10/X11 组件；能力开关来自中心 capabilities；本机 API 按 §2.2 契约以 fetch 对接（S2E 未合并也可开发）。

**范围**：
- `web/lib/api/shared-ledger-v2*.ts`
- `web/lib/i18n-dict-shared-ledger-v2*.ts`
- `web/features/collab/shared/exec/**`
- `tests/web-shared-ledger-v2-stage2*.test.ts`
- `tests/web-dom-shared-ledger-v2-stage2*.test.ts`
- 例外 `web/features/collab/collab-view.tsx`：≤3 行，execution feature 挂执行面板

**验收线**：
1. capabilities 中 `task.new.enabled=false` 时按钮 disabled、title 为 reason；数据过期显示过期提示；member 看不到签署按钮。
2. DOM 测：开卡提交后 fetch spy 恰好 1 次 POST `/api/v1/shared-exec/commands`，body 过 `parseCommand` 镜像校验；409 进入 X10 冲突态；状态未知只提示查回执。
3. 显示主场、执行地、中心 serverSeq；web 不 import src（扫 import）；`collab-view.tsx` numstat ≤3/≤3；中英文文案齐。

### S2T · V2 签名传输
deps：S2K、S2C；估时：2 小时。

**背景**：拆分稿 X12F 传输；X7 `ExecTransport`、X9 `LendCentralTransport`、X8 `SchedulerCentralClient` 都无实现。

**PM 定**：签名复用 V1 `SharedLedgerClient`；网络错误统一 `unavailable`，4xx 原样带回 code；不缓存授权。

**范围**：
- `src/lib/shared-ledger-v2-transport*.ts`
- `tests/shared-ledger-v2-stage2-transport*.test.ts`

**验收线**：
1. fake fetch 对 `V2_ROUTES` 每项断言 method、路径、签名头、body 不含 actor；回包过 S2K parse，不合格即 `invalid_field`。
2. fetch reject / 超时 → `unavailable`；403 → `V2ContractError("forbidden")`；receipts 的 404 只在契约规定时映射为 null。
3. 三个适配器各对 S2C fake center 跑通一条命令往返。

### S2C · 合成 fake center
deps：S2K；估时：1.5 小时。

**背景**：PM 定「验收线要能跑：合成台账 + fake center，不读生产」；X13 / X15 需要有状态的中心替身。

**PM 定**：只是测试夹具，内存实现 `V2_ROUTES` 的最小语义（回执幂等、epoch / 租约 / 意图 / 订单状态、迁移 / 回退、注入故障）；不当中心实现参考。

**范围**：
- `tests/helpers/shared-ledger-v2-fake-center*.ts`
- `tests/shared-ledger-v2-stage2-fake-center*.test.ts`

**验收线**：
1. 同 requestId 同体重放回同回执、不同体 `dedup_mismatch`；旧 epoch `stale_epoch`；`executionOnly` 命令在未迁 feature 上 `execution_not_shared`。
2. 故障注入：丢响应（已提交但不回）、503、重启换 bootId、升 serviceGeneration，各有一条自测。
3. 迁移 commit / revert 改变 feature authorityMode 与 epoch，查询路由 committed / unknown 正确。

### S2P · 投影专用写入器与快照同步
deps：S2K、S2G；估时：2 小时。

**背景**：§2.1 形态 1、§2.2「投影写入」：`createTask` 的规划门、`checkNewTask` 的非 spec 限制、`applyMove` 的角色核对都会拒投影
（`shared-ledger-center-claims-gate.ts:11-20`、`ledger-checks.ts:109-118`、`ledger-write.ts:195-218`）；写法照副本专用写入器
（`shared-ledger-center-replica-write.ts:62-103`）。

**PM 定**：`shared-ledger-v2-projection-write.ts` 是唯一以 `PROJECTION_ACTOR` 写的模块：import `ledger-tx` 的 `tx` / `insertEvent` 与 S2G 的
`withProjectionScope`，直接 upsert tasks / deps / steps 行，不调 `ledger-write` 任何写函数、不 import `applyMove`；centerSeq = 快照 serverSeq，
经令牌传给写门；X13 / X13B 调用时带本批 batchId。同步只拉快照、新于已落才写；不回写中心。

**范围**：
- `src/lib/shared-ledger-v2-projection*.ts`
- `tests/shared-ledger-v2-stage2-projection*.test.ts`
- 例外 `tests/ledger-migrate.test.ts`：≤3 行，ledger-tx 白名单加 `lib/shared-ledger-v2-projection-write.ts`

**验收线**：
1. 真实写入（真 S2G 写门、临时台账）：feature 置 execution + centerExecution，快照 v1 新建一张 build 阶段、round 2 的卡与步骤，
   v2 改阶段 / head；本机行与快照逐字段一致，事件 actor 为投影身份、带 centerSeq 且只增不减。
2. 迁移中路径：feature 为 planning + `migrating{execute, batchId:B}`，带 B 写入已有阶段一卡成功，带别的 batchId 或不带拒绝。
3. 旧 / 相等 serverSeq 快照 0 写；快照跨 feature / 跨项目拒绝；投影写后以 owner 身份调 `ledger-write.setTask` 仍被写门拒。
4. `tests/ledger-migrate.test.ts` 只改白名单 1 行，numstat ≤3/≤3，其余用例全过。

### S2F · 本机组合根、开关注入与 CLI
deps：S2T、S2C、S2A、S2L、S2G、S2S、S2D、S2R、S2I、S2J、S2M、S2E、S2P；估时：2 小时。

**背景**：拆分稿 X12F；把 §2.2 各端口在 bridge 与 scheduler 两个进程里接上。

**PM 定**：凭据只来自本机配置（`resolveSharedLedgerCredential`，`shared-ledger-mode.ts:116-124`），缺失注入 null；按 Principal + 项目缓存单例，不跨 Principal 共用；
S2D 的 `schedulerV2Route` 作为 `route` 注入 S2I / S2J / S2M / S2L / S2A / S2E；CLI 不提供写 execution 模式的入口；`release` 子命令只认 owner。

**范围**：
- `src/lib/shared-ledger-v2-wiring*.ts`
- `src/lib/scheduler-v2-wiring*.ts`
- `src/bridge/shared-ledger-v2-wiring*.ts`
- `src/manager/ledger-shared-exec-cmds*.ts`
- `tests/shared-ledger-v2-stage2-wiring*.test.ts`
- 例外 `src/bridge.ts`：≤3 行，import 后调 `initSharedLedgerV2()`
- 例外 `src/scheduler.ts`：≤3 行，守护起 `initSchedulerV2()`，deploy-job 分支传 `centralDeployDeps(...)`
- 例外 `src/manager/ledger.ts`：≤3 行，并入 `SHARED_EXEC_CMDS`

**验收线**：
1. 凭据缺失：所有 configure 收到 null，各入口返回 unavailable；凭据存在：S2A 与 S2E 同 Principal / 项目拿到同一 client，跨 Principal 不复用。
2. CLI：`ledger shared-exec switch|release|receipt|recover|observe-log`；`recover` 先查回执、租约、版本，不带 `--resubmit` 时 submit 0 次；
   非 owner 调 `release` 拒绝；`release --revoke` 后同进程下一次路由即 skip。
3. 端到端（S2C）：一张 execution 卡从中心 `task.new` → S2P 投影 → S2I 派单意图 → S2L 结果 → S2P 再投影，本机非投影写 0 次。
4. 开关 off 时 bridge / scheduler 启动零中心请求；三个例外文件 numstat 各 ≤3/≤3。

### X13 · 整组执行权迁移与批次回执
deps：S2F、S2C、CS1、CS2、CS3；估时：2 小时。

**背景**：v2 稿 X13（`shared-ledger-v2.md:250-259`）、拆分稿 §7.2；阶段一批次导入（`shared-ledger-import-run.ts:93-262`）的 prepare / commit / revoke 模式。

**PM 定**：第一版只迁阶段一中心副本 feature（planning + centerPlanned）；先 dry-run 再 commit；本机模式只在中心 committed 后切；
开批要求有效档 on（drill 或 release 条目，§2.2）：演练项目凭 drill 条目即可试迁，正式项目要等 X15R 签字后的 release 条目。

**范围**：
- `scripts/shared-ledger-execution-migrate.ts`
- `src/lib/shared-ledger-v2-migration*.ts`
- `tests/shared-ledger-v2-migration*.test.ts`

**验收线**：
1. 前置：有效档非 on（含 on 但无放行条目）、有活 worker / 活出借单 / X8 journal 或 X9 outbox 有 unknown、规格副本缺 → 拒绝开批，`migrating` 不落。
2. 正常：写 `migrating` → 备份 → 建清单（evidence 八项、mappings 完整，过 `parseMigrationManifest`）→ dry-run → commit → S2P 带本批 batchId 落快照
   → 写 `{execution, centerExecution}` 并清 `migrating`。写 `migrating` 之后到清掉之前，真实 `schedulerPass` 对该 feature 零派单。
3. 中心 4xx：清 `migrating`、模式不变、备份按批次清理，阶段一行为不变（副本同步、提案照常）。
4. 丢响应：保持 `migrating`，重跑只 `GET migrations/{batchId}`，绝不换 batchId；期间路由一直 skip；committed 后补落模式，unknown 不开 execution。
5. 全程只在 S2C 隔离夹具；写门在切换后立即拒本机写（复用 S2G 表驱动用例一条）。

### X13H · 换主场
deps：X13、CS4；估时：1.5 小时。

**背景**：v2 稿 :49、:51「超时不自动换主场；owner 确认旧端停推及 worker / lend 单结清或核清再增 epoch」；契约 `home.change`（`…-v2-commands.ts:61-62`）。

**PM 定**：只由 owner 在新主场或旧主场发起；四项证据由本机核实后才可置 true；不做自动换主场。

**范围**：
- `scripts/shared-ledger-execution-home.ts`
- `src/lib/shared-ledger-v2-home*.ts`
- `tests/shared-ledger-v2-home*.test.ts`

**验收线**：
1. 旧主场：写 `migrating{kind:home}`、S2R stop 并释放租约、核活单 / unknown 为 0 后才发；任一不满足拒绝；
   带 `migrating{home}` 期间开关 on 下真实 `schedulerPass` 零派单、S2I 零中心意图。
2. 回执 committed：旧主场模式 epoch 更新且不再领租；新主场 S2R 以新 epoch 领租，旧 epoch 的意图被 fake center 拒 `stale_epoch`。
3. 回执未知：两端都不领租，只查回执；owner 授权缺失 / 过期返回中心错误，状态不变。

### X13B · 退回阶段一
deps：X13、CS5；估时：1.5 小时。

**背景**：本稿 §7.3；v2 稿 :61「已有中心新提交不能直接回旧本机库，须冻结、导出核对后单独迁回」。

**PM 定**：开关先降到 observe；退回后 feature 回 planning + centerPlanned（阶段一形态），卡落回主场本机台账：最终快照经 S2P 以投影身份写入（带 centerSeq 与批次标记），写完才把模式改回 planning。

**范围**：
- `scripts/shared-ledger-execution-revert.ts`
- `src/lib/shared-ledger-v2-revert*.ts`
- `tests/shared-ledger-v2-revert*.test.ts`

**验收线**：
1. 前置不满足（活租约、活单、unknown）拒绝；满足时 `POST reverts` → committed → 最终快照落本机 → 模式回 planning + centerPlanned → 清 `migrating`。
2. 退回后本机写门放行原规划规则（`shared-ledger-gate.ts:6-31` 行为与迁前一致），中心 V2 执行命令 `execution_not_shared`。
3. 丢响应只查 `GET reverts/{batchId}`；unknown 时保持冻结，不自行放开本机写。

### X15 · 合成三实例闭环与故障演练
deps：X13H、X13B、S2W；估时：2 小时。

**背景**：v2 稿 X15（`shared-ledger-v2.md:271-279`）的合成部分；真实演练拆到 X15R。

**PM 定**：三个临时 STATE_DIR 代表本机 / peer A / peer B，共用一个 S2C fake center；不连生产、不读 peer 配置。

**范围**：
- `tests/shared-ledger-v2-e2e*.test.ts`

**验收线**：
1. 闭环：peer A 成员开卡 → 本机投影 → 意图派单 → peer B 借单交付 → 本机派审 → owner 授权 → merge 意图 → 回执 committed。
2. 故障逐项各一条：失租、worker 崩溃、丢回执、断中心、活单迁移被拒、unknown 不重试；每条断言资源占用与回执状态。
3. 换主场与退回阶段一各一条；旧备份恢复（fake center 升代际）后 receipts 对未确认请求返回 unknown。
4. 开关 off 时三实例零中心写；全部用例列出所跑文件。

### X15R · 真实三实例演练与放行记录
deps：X15、CS8；估时：2 小时。

**背景**：v2 稿 X15「全部节点通过才开放 execution」、拆分稿 §7.3 真实传输 ↔ 真实路由冒烟。

**PM 定**：在真实中心（CS8 的演练团队 / 项目）与本机 + 两台 peer 的 `s2-drill-` 演练项目上按 §6 七步演练；开 on 只凭 owner 事前授权的 drill 条目，
不碰任何正式项目开关；证据脱敏写文档；任何一步失败即停并 `--revoke`；本卡不改代码。

**范围**：
- `docs/testing/shared-ledger-v2-drills.md`

**验收线**：
1. `V2_ROUTES` 每项真实往返一次，状态码与形状记录在案。
2. §6 七步逐项有命令输出 / 截图（脱敏、实例只叫本机 / peer A / peer B），失败项写明现象与回退结果。
3. 演练前记录 drill 授权 askId 与到期时间；演练后三台 `--revoke` 并贴 `readStage2Switch` 读出 observe 的输出。
4. 文档末尾列放行条件与 owner 签字位；签字前正式项目没有 release 条目、有效档不得为 on（贴三台 release 清单输出为证）。
