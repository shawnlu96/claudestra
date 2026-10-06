# 共享台账 V2 · X12 拆分方案（X12A–X12F）

> **cloud-CL1 迁移后定位说明（2026-10-05 补记；只加此说明，正文历史结论未改）**
>
> 本稿正文中的 `src/shared-ledger.ts`、`src/shared-ledger/**`、`scripts/shared-ledger-admin.ts`、
> `src/lib/shared-ledger-member-admin.ts`、`deploy/shared-ledger/**` 是写作时公共仓库里的**历史路径**，正文保持原样。
> 按公开迁移 PR [shawnlu96/claudestra#636](https://github.com/shawnlu96/claudestra/pull/636) 的映射（该 PR 删除的 68 项源资源与 [cloud-migration-ready.md §2](cloud-migration-ready.md#2-source--target-完整manifest) 逐项一致），cloud-CL1 迁移后中心实现位于私有仓库 `floka-ai/cloud`：
>
> - 中心入口与各域：`src/shared-ledger.ts`、`src/shared-ledger/**` → `services/ledger-center/src/shared-ledger.ts`、`services/ledger-center/src/shared-ledger/**`（相对结构不变）；
> - admin 入口：`scripts/shared-ledger-admin.ts` → `services/ledger-center/scripts/shared-ledger-admin.ts`；`src/lib/shared-ledger-member-admin.ts` → `services/ledger-center/src/admin/member-admin.ts`；
> - 部署资源：`deploy/shared-ledger/**` → `deploy/ledger-center/**`。
>
> 只有中心实现与部署/admin 迁走，**不是整个 shared-ledger 闭源**：公共协议（`src/lib/shared-ledger-contract*.ts` 等纯协议模块，
> 私仓经固定 gitlink `vendor/claudestra` 消费、由 `services/ledger-center/src/protocol.ts` 精确导出）与公共客户端
> （`src/lib/shared-ledger-client.ts`、cache/mode、`src/bridge/local-api/shared-ledger*.ts`、manager、`web/`）继续留在本公开仓库。
>
> 截至本说明，PR #636 **尚未合入**，生产**未**迁移；上述是迁移后的定位，不是已完成事实。合入后，公共仓库里的旧路径只作历史引用，
> 正文里涉及它们的部署 / 运维 / admin 命令不再是公共仓库的可执行入口。V1/V2 权威、X12 后续设计、部署数据 / 中心身份 / 端口 / 证书均不因本说明改变。

本稿只拆设计、不写产品代码。依据 [shared-ledger-v2.md](shared-ledger-v2.md) §1.1、§2 X12、§3、§4、§5，基线 main d9578da0。
读过的代码：main 上已合并的 X0（`src/lib/shared-ledger-contract-v2*.ts`）、X1 exec-tasks、X2 asks、X3 artifacts、X4 leases、X5 intents、X7 exec-client/gate/local、X10 task、X11 approve、X14 exec-workflows；
合并队列里的 X6 #434（`lend/i28-X6-9109` @a45d4c4a）、X8 #457（`lend/i28-X8-9109` @1dd11fb4）、X9 #455（`lend/i28-X9-9109` @7aa5df1d）。
这三张卡的 README 和注释都写了“只加一行接入，由 X12 执行”，下文 §2 把这些接入点逐个分到具体节点。

## 1. 为什么这样拆

原 X12 有 42 个 fileGlob 条目，估 4 小时，只能一个人写，而且要等 13 张前置卡。它其实是六块互不相干的接线：

| 层 | 接什么 | 现有冻结接口（不用等别的节点） |
|---|---|---|
| 中心·事务 | 七个域模块组成一个 SQLite 事务，再补上跨域端口 | `V2DomainModule`、`createTransactionOwner`，以及各域的 `*Dependencies` / `*Ports` 类型 |
| 中心·HTTP | `/v2` 路由、凭据 → `V2Actor`、快照读 | V1 `LedgerService.handle` 的签名鉴权 |
| 本机·业务 ask | reply/答复/撤销/过期/locate/ask-check 改走中心 | X7 `SharedLedgerExecClient.ask/command` |
| 本机·执行侧 | 出借代理（X9）、独立部署 job（X8）、调度 pass 闸 | X9 `LendCentralTransport`、X8 `SchedulerCentralWorkerDeps.openClient` |
| 本机·入口 | TV1 数据源接线、本机 API 代理、DAG/订单 MCP 工具 | X10 `TaskEditor`、X11 `ApprovalPanel`、X7 client |
| 本机·组合 | 真实传输、单例客户端、持久写门、CLI、热文件接入 | §3 的线契约和 configure* 接口 |

拆分原则：

1. 各节点只拿冻结接口（X0/X7/X8/X9 的类型，加上本稿 §3 冻结的线契约和 `configure*` 端口）开发，不互相 import 实现。真实对象由 X12F 在组合根统一注入。
2. 热文件不进任何节点的 fileGlobs。新逻辑放新文件，热文件只加 ≤3 行接入（`git diff --numstat` 新增 ≤3、删除 ≤3），每个热文件只指定一个节点来接。
   热文件的认定：任务列出的 `src/bridge.ts`、`src/scheduler.ts`、`src/manager/ledger.ts`、`src/lib/scheduler-pass.ts`，再加上近一个月（2026-09-01 起）非 merge 提交 ≥15 次的 X12 文件：
   `src/bridge/local-api/index.ts`(27)、`src/lib/ledger-write.ts`(26)、`src/bridge/asks.ts`(21)、`src/lib/scheduler-auto-deps.ts`(20)、`src/bridge/ask-entry.ts`(20)。
   参考次数：`src/bridge.ts` 171、`src/manager/ledger.ts` 53、`src/lib/scheduler-pass.ts` 18、`src/scheduler.ts` 11。
3. 每个节点有自己的测试前缀，都在原 `tests/shared-ledger-v2-wiring*.test.ts` 之下：`-center` / `-routes` / `-asks` / `-exec` / `-web` / `-local`。
4. 原 X12 的不变量全部保留：execution 总开关默认关；本机缓存和 outbox 不算授权；中心不可用时直接失败（fail-closed），不回退到本机权威。

## 2. 节点总表

| key | 一句话 | 依赖（开工前置） | 估时 | 热文件例外（≤3 行，由本节点接） |
|---|---|---|---|---|
| X12A | 中心 V2 组合根、跨域端口与单事务分派 | X6（X0–X5、X14 已合并） | 2h | 无 |
| X12B | 中心 V2 路由、身份映射与快照读 | X12A | 2h | 无 |
| X12C | 业务 ask 全链路改走中心 | X2、X7（已合并） | 2h | `src/bridge/asks.ts`、`src/bridge/ask-entry.ts` |
| X12D | 出借代理与独立部署 job 接线 | X8、X9 | 2h | `src/lib/scheduler-pass.ts`、`src/lib/scheduler-auto-deps.ts` |
| X12E | TV1 数据源接线、本机 API 与 MCP 工具入口 | X7、X10、X11（已合并）、TV1 | 2h | `src/bridge/local-api/index.ts` |
| X12F | 本机传输、组合根、持久写门与 CLI | X12C、X12D、X12E | 2h | `src/bridge.ts`、`src/scheduler.ts`、`src/manager/ledger.ts`、`src/lib/ledger-write.ts` |

依赖图：

```text
X6 ──► X12A ──► X12B ──┐
X8,X9 ─► X12D ─┐       ├──► X13（建议改依赖 X12B、X12F）──► X15
X2,X7 ─► X12C ─┼► X12F ┘
X7,X10,X11,TV1 ► X12E ┘
```

- X6/X8/X9 合并后，X12A、X12C、X12D 三个节点可以同时开工（≥3）；TV1 完成后 X12E 也可并行。X12C 的前置已在 main，可立即开工；X12E 必须等 TV1。
- 第二波：X12B（等 X12A）和 X12F（等 C/D/E）并行。
- 关键路径（前置含 TV1 全就绪后）：max(A+B, max(C,D,E)+F) = 6 槽小时（每卡 2 小时实现 + 1 小时审查）；TV1 未就绪时另加等待时间。至少 A/C/D 三路并行。
- X12F 与 X12B 互不依赖：X12F 的传输按 §3.1 线契约对 fake fetch 测试，X12B 用真实中心测同一张表。第一次真实端到端是 X13 / X15（建议见 §7）。

## 3. 冻结的跨节点契约（本稿定，节点不得私改，要改先回 PM 改本稿）

### 3.1 中心 V2 HTTP 线契约（X12B 实现，X12F 传输调用）

所有请求都沿用 V1 的 `SharedLedgerSignedRequest` 签名和凭据。body 里不放 actor/role；如果带了，直接 `invalid_field`。错误体统一用 X0 的 `parseError` 形状 `{code,message,requestId}`，HTTP 状态取自 `V2_ERROR_STATUS`。

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| POST | `/v2/teams/{teamId}/commands` | `V2Command`（`parseCommand`） | `V2Receipt`（`parseReceipt`） |
| GET | `/v2/teams/{teamId}/projects/{projectId}/receipts/{requestId}?operationId=&commandDigest=` | — | `{status:"committed",receipt}` 或 `{status:"unknown",requestId}`；digest 不符返回 `dedup_mismatch` |
| GET | `/v2/teams/{teamId}/projects/{projectId}/asks/{askId}` | — | `V2Ask` |
| GET | `/v2/teams/{teamId}/projects/{projectId}/features/{featureId}` | — | `{serverSeq,serviceGeneration,feature,tasks,steps,workflow,pendingAsks,capabilities}`，capabilities 每项过 `parseCapability` |
| GET | `/v2/teams/{teamId}/projects/{projectId}/lend/{orderId}` | — | X9 `LendCentralView` 形状 `{order,lease,task,now}` |

跨项目、不存在、无 read 权限三种情况一律返回同样的 403 体，不泄露别的项目是否存在。

### 3.2 中心组合根接口（X12A 导出，X12B 使用）

`src/shared-ledger/v2-center.ts` 导出 `createV2Center(db: Database, opts: { executionEnabled?: boolean; now?: () => number }): V2CenterHandle`，`executionEnabled` 默认 false：

```ts
interface V2CenterHandle {
  command(command: V2Command, actor: V2Actor): V2Receipt;               // 单个同步 SQLite 事务
  receipt(q: { teamId; projectId; requestId; operationId: string | null; commandDigest: string }, actor: V2Actor): V2Receipt | null;
  ask(q: { teamId; projectId; askId }, actor: V2Actor): V2Ask;
  snapshot(q: { teamId; projectId; featureId }, actor: V2Actor): unknown; // §3.1 第 4 行形状
  lendView(q: { teamId; projectId; orderId }, actor: V2Actor): unknown;   // §3.1 第 5 行形状
}
```

### 3.3 本机 configure 端口（C/D/E 导出，X12F 注入）

传入 `null` 或者从未调用过，都表示中心未接好：涉及共享 execution feature 的入口一律报 `unavailable`，不回退本机写。非共享卡和 source/planning 卡继续走原本机路径。

| 节点 | 文件 | 导出 |
|---|---|---|
| X12C | `src/bridge/shared-ledger-v2-asks.ts` | `configureSharedAsks(port: { clientFor(projectId: string): SharedLedgerExecClient \| null; featureOfTask(taskId: string): { featureId: string; projectId: string } \| null } \| null)` |
| X12D | `src/bridge/shared-ledger-v2-lend.ts` | `configureLendCentral(port: { transportFor(projectId: string): LendCentralTransport \| null; grant: LendCentralGrantDeps; outboxDir: string } \| null)` |
| X12D | `src/lib/scheduler-v2-wiring.ts` | `centralDeployDeps(openClient: SchedulerCentralWorkerDeps["openClient"]): SchedulerCentralWorkerDeps`；`runDeployJob(path, deps)` 的 `WorkerDeps` 新增可选 `central` |
| X12E | `src/bridge/shared-ledger-v2-entry.ts` | `configureSharedExecEntry(port: { clientFor(principal: Principal, projectId: string): SharedLedgerExecClient \| null; snapshot(principal: Principal, projectId: string, featureId: string): Promise<unknown>; receipt: SharedExecReceiptPort } \| null)` |

只读回执端口由 X12E 消费、X12F 注入，独立于 X7 client（不访问其私有 transport，也不调用 `command` 代查）：

```ts
type SharedExecReceiptPort = (
  principal: Principal,
  query: { teamId: string; projectId: string; requestId: string; operationId: string | null; commandDigest: string },
) => Promise<{ status: "committed"; receipt: V2Receipt } | { status: "unknown"; requestId: string }>;
```

F 必须从已认证 Principal 和 project 配置解析 actor/凭据，核验 team/project/read 权限，再调用 §3.1 的 GET receipts；query 的 teamId 不可覆盖凭据范围。传输 null 映射为 unknown，错误不能映射为 unknown；完整查询参数原样带到中心。snapshot 同样按 Principal 核读权限。E 仅透传查询结果，任何结果都不触发 submit 或 outbox 重交。

本机 API（X12E 实现，依赖 TV1、接 TV1 的数据源，不另起界面）：`GET /api/v1/shared-ledger/v2/features/{featureId}?project=`、`POST /api/v1/shared-ledger/v2/commands`、`GET /api/v1/shared-ledger/v2/receipts/{requestId}?project=&operationId=&commandDigest=`、`GET /api/v1/shared-ledger/v2/asks/{askId}?project=`。

## 4. 原 X12 职责 → 新节点对照

| 原 X12 职责（v2 §2 X12 / §3） | 新节点 |
|---|---|
| 统一事务组合（域模块 schema 安装 + `applyInTransaction` + 一条事件 + 不可变回执，任一失败全回滚） | X12A |
| 跨域端口（Lend `loadExecution/authorize/readStep/writeStep/appendEvent`、Tasks `feature/workflow/order`、Ask/Intent/Lease/Generation/Workflows 依赖、Artifact readers） | X12A |
| 全部命令入口核模式/epoch/serviceGeneration/bootId，副作用核授权（中心侧权威） | X12A |
| execution 仍禁用（总开关默认关） | X12A（中心）、X12F（本机） |
| 中心真实路由在 service 而非只 entry；commands 事务分派；migrations schema 安装；reads/identity 快照权限 | X12B |
| 本人/服务身份映射，不接受 body actor/role；403 不泄露其他项目；撤成员即拒 | X12B |
| 真实 reply 建中心业务 ask；Web/Discord/聊天共用记录；查询/locate/撤销/过期/ask-check 一致 | X12C |
| asks/ask-entry/ask-dismiss/ask-expire 及 CLI ask-check 只薄接线；runtime permission/AUQ/非共享 ask 保留本机 | X12C |
| 出借：主场 bridge 代理中心 claim/beat/result，worker 只限定订单，恢复先查回执 | X12D |
| 独立部署链：`scheduler.ts --deploy-job` → job/worker/steps 四处接线；每步在线核验；断中心或失 epoch 挡住后续、unknown 对账 | X12D（job/worker/steps/apply/pass 闸）、X12F（`scheduler.ts` 一行注入 openClient） |
| 自动阶段/调度 pass 不对 execution feature 做本机推进 | X12D |
| TV1 数据源接线（开卡/改字段/审批/能力禁用/过期显示） | X12E |
| 本机 API 代理和 DTO（web/lib/api、i18n） | X12E |
| DAG 和订单 MCP 工具在 execution feature 上改走中心 | X12E |
| 中心客户端单例、真实传输、模式文件；本机缓存/outbox 非授权权威 | X12F |
| 持久写门：本机台账写入口对 execution feature 一律拒绝 | X12F |
| manager 命令（回执查询 / outbox 显式重交），CLI 与 PM 同入口 | X12F（新命令）、X12C（ask-check） |
| 热文件接入（bridge / scheduler / manager ledger / ledger-write） | X12F；asks/ask-entry 归 X12C；scheduler-pass/auto-deps 归 X12D；local-api/index 归 X12E |

### 4.1 原 42 个 fileGlob 条目逐条去向

| # | 原条目 | 新节点 | 方式 |
|---|---|---|---|
| 1 | src/shared-ledger.ts | X12B | fileGlobs |
| 2 | src/shared-ledger/service.ts | X12B | fileGlobs |
| 3 | src/shared-ledger/commands.ts | X12B | fileGlobs |
| 4 | src/shared-ledger/migrations.ts | X12B | fileGlobs |
| 5 | src/shared-ledger/reads.ts | X12B | fileGlobs |
| 6 | src/shared-ledger/identity.ts | X12B | fileGlobs |
| 7 | src/manager/ledger.ts | X12F | 热文件例外 |
| 8 | src/lib/ledger-write.ts | X12F | 热文件例外 |
| 9 | src/lib/shared-ledger-mode.ts | X12F | fileGlobs |
| 10 | src/lib/ledger-dag-write.ts | X12F | fileGlobs |
| 11 | src/scheduler.ts | X12F | 热文件例外 |
| 12 | src/lib/scheduler-deploy-job.ts | X12D | fileGlobs |
| 13 | src/lib/scheduler-deploy-worker.ts | X12D | fileGlobs |
| 14 | src/lib/scheduler-deploy-steps.ts | X12D | fileGlobs |
| 15 | src/lib/scheduler-pass.ts | X12D | 热文件例外 |
| 16 | src/lib/scheduler-apply.ts | X12D | fileGlobs |
| 17 | src/lib/scheduler-auto-deps.ts | X12D | 热文件例外 |
| 18 | src/bridge/local-api/index.ts | X12E | 热文件例外 |
| 19 | src/bridge/local-api/shared-ledger.ts | X12E | fileGlobs |
| 20 | src/bridge/dag-tools.ts | X12E | fileGlobs |
| 21 | src/bridge/order-tools.ts | X12E | fileGlobs |
| 22 | src/bridge/lend-tools.ts | X12D | fileGlobs |
| 23 | src/bridge/lend-dispatch.ts | X12D | fileGlobs |
| 24 | src/bridge/local-api/lend.ts | X12D | fileGlobs |
| 25 | src/bridge/local-api/lend-inbox.ts | X12D | fileGlobs |
| 26 | src/bridge/local-api/asks.ts | X12C | fileGlobs |
| 27 | src/bridge.ts | X12F | 热文件例外 |
| 28 | src/bridge/asks.ts | X12C | 热文件例外 |
| 29 | src/bridge/ask-reply.ts | X12C | fileGlobs |
| 30 | src/bridge/ask-entry.ts | X12C | 热文件例外 |
| 31 | src/bridge/ask-dismiss.ts | X12C | fileGlobs |
| 32 | src/bridge/ask-expire.ts | X12C | fileGlobs |
| 33 | src/bridge/ask-locate.ts | X12C | fileGlobs |
| 34 | src/manager/ledger-read-cmds.ts | X12C | fileGlobs |
| 35 | web/features/collab/shared/shared-view.tsx | TV1 | PM 移交，不分给 A–F |
| 36 | web/features/collab/shared/shared-ledger.tsx | TV1 | PM 移交，不分给 A–F |
| 37 | web/lib/api/shared-ledger.ts | X12E | fileGlobs |
| 38 | web/lib/i18n-dict-shared-ledger.ts | X12E | fileGlobs |
| 39 | src/lib/shared-ledger-v2-wiring.ts | X12F | fileGlobs |
| 40 | src/shared-ledger/v2-wiring.ts | X12A | fileGlobs |
| 41 | src/bridge/shared-ledger-v2-wiring.ts | X12F | fileGlobs |
| 42 | tests/shared-ledger-v2-wiring*.test.ts | X12A–F | 按子前缀分：`-center`/`-routes`/`-asks`/`-exec`/`-web`/`-local` |

新增、原清单里没有的路径只有一个已有文件：`src/lib/ledger-tx.ts`（X12F，近一个月 6 次提交，不算热文件）。理由：`insertEvent` 是 `ledger-write.ts` / `ledger-dag-write.ts` / `ledger-deps-write.ts` 所有写入的共同落点，持久写门在这里的 `tx` 事务入口采集旧绑定，并在 `insertEvent` 检查旧/新绑定，避免任务更新先清空 extra 绕过门，也不用在 13 个写函数里各加一行。

## 5. 节点详情

每个节点的 fileGlobs 照 v2 §附录的受限语法写：只用单个文件名前缀 `*` 或目录尾 `/**`。“规格例外”一行一条，以 `- 例外 ` 开头，§6 的脚本按这个格式解析。

### X12A · 中心 V2 组合根、跨域端口与单事务分派

key：X12A；deps：X6；估时：2小时。
fileGlobs：

- src/shared-ledger/v2-wiring.ts
- src/shared-ledger/v2-center*.ts
- src/shared-ledger/v2-ports*.ts
- tests/shared-ledger-v2-wiring-center*.test.ts

规格例外：无。

### X12B · 中心 V2 路由、身份映射与快照读

key：X12B；deps：X12A；估时：2小时。
fileGlobs：

- src/shared-ledger.ts
- src/shared-ledger/service.ts
- src/shared-ledger/commands.ts
- src/shared-ledger/migrations.ts
- src/shared-ledger/reads.ts
- src/shared-ledger/identity.ts
- src/shared-ledger/v2-routes*.ts
- tests/shared-ledger-v2-wiring-routes*.test.ts

规格例外：无。

### X12C · 业务 ask 全链路改走中心

key：X12C；deps：X2, X7；估时：2小时。
fileGlobs：

- src/bridge/shared-ledger-v2-asks*.ts
- src/bridge/ask-reply.ts
- src/bridge/ask-dismiss.ts
- src/bridge/ask-expire.ts
- src/bridge/ask-locate.ts
- src/bridge/local-api/asks.ts
- src/manager/ledger-read-cmds.ts
- tests/shared-ledger-v2-wiring-asks*.test.ts

规格例外：

- 例外 src/bridge/asks.ts：≤3 行，在 `commitAnswer` 入口调 `sharedAskAnswer(i)`，共享 ask 交中心处理后直接返回
- 例外 src/bridge/ask-entry.ts：≤3 行，`initAskWiring` 里调 `initSharedAskWiring()`

### X12D · 出借代理与独立部署 job 接线

key：X12D；deps：X8, X9；估时：2小时。
fileGlobs：

- src/bridge/shared-ledger-v2-lend*.ts
- src/bridge/lend-tools.ts
- src/bridge/lend-dispatch.ts
- src/bridge/local-api/lend.ts
- src/bridge/local-api/lend-inbox.ts
- src/lib/scheduler-v2-wiring*.ts
- src/lib/scheduler-deploy-job.ts
- src/lib/scheduler-deploy-worker.ts
- src/lib/scheduler-deploy-steps.ts
- src/lib/scheduler-apply.ts
- tests/shared-ledger-v2-wiring-exec*.test.ts

规格例外：

- 例外 src/lib/scheduler-pass.ts：≤3 行，pass 开头用 `schedulerV2Skip(taskId)` 跳过 execution feature 的本机推进
- 例外 src/lib/scheduler-auto-deps.ts：≤3 行，`autoTickDeps` 返回的动作在 execution feature 上换成 `refuseCentral`

### X12E · TV1 数据源接线、本机 API 与 MCP 工具入口

key：X12E；deps：X7, X10, X11, TV1；估时：2小时。
fileGlobs：

- src/bridge/shared-ledger-v2-entry*.ts
- src/bridge/local-api/shared-ledger.ts
- src/bridge/dag-tools.ts
- src/bridge/order-tools.ts
- web/lib/api/shared-ledger.ts
- web/lib/api/shared-ledger-v2*.ts
- web/lib/i18n-dict-shared-ledger.ts
- tests/shared-ledger-v2-wiring-web*.test.ts
- tests/web-dom-shared-ledger-v2-wiring*.test.ts

规格例外：

- 例外 src/bridge/local-api/index.ts：≤3 行，只在 `/shared-ledger/v2/` 子路径没被现有 `sharedLedgerGateProxy` 族命中时才加一行族注册，预计 0 行

### X12F · 本机传输、组合根、持久写门与 CLI

key：X12F；deps：X12C, X12D, X12E；估时：2小时。
fileGlobs：

- src/lib/shared-ledger-v2-wiring.ts
- src/lib/shared-ledger-v2-transport*.ts
- src/lib/shared-ledger-v2-write-gate*.ts
- src/lib/shared-ledger-mode.ts
- src/lib/ledger-dag-write.ts
- src/lib/ledger-tx.ts
- src/bridge/shared-ledger-v2-wiring.ts
- src/manager/ledger-shared-exec-cmds.ts
- tests/shared-ledger-v2-wiring-local*.test.ts

规格例外：

- 例外 src/bridge.ts：≤3 行，import 后调 `initSharedLedgerV2()`
- 例外 src/scheduler.ts：≤3 行，`--deploy-job` 分支把 `centralDeployDeps(openSchedulerCentralClient)` 传给 `runDeployJob`
- 例外 src/manager/ledger.ts：≤3 行，import 后把 `SHARED_EXEC_CMDS` 并入命令表
- 例外 src/lib/ledger-write.ts：≤3 行，预计 0 行（写门在 `ledger-tx.ts`）；只在某个写入口不经过 `insertEvent` 时补一行 `assertLocalWrite`

## 6. 核对：fileGlobs 两两不重叠，42 条全覆盖

从仓库根运行。脚本做五件事：

1. 解析本文 §5 的六个节点（fileGlobs + 例外）和 v2 设计稿里除 X12 以外的 X0–X15；
2. 用 `git ls-files -z` 加 `Bun.Glob.match` 展开，逐对算现有文件交集（existing）和受限语法下的未来路径相交（planned）。六个新节点两两都比（含有依赖关系的对），另外和旧节点全部比一遍；
3. 例外文件不得出现在任何节点的 fileGlobs 里，每个热文件只能被一个节点认领；
4. 原 X12 的 42 个条目，每条都必须是某个新节点的 fileGlob、例外，或者（测试 glob 条目）被新节点的子前缀覆盖；PM 10-03 补指定的两个网页文件只记移交 TV1，不分给新节点；
5. 热文件清单必须全部落在例外里。

```sh
bun run - <<'JS'
import { readFileSync } from 'node:fs';
function parse(doc, re, stop) {
  const parts = doc.split(re), out = new Map();
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1].split(stop)[0];
    const head = body.split('规格例外：')[0].split('验收线：')[0];
    out.set(parts[i], {
      deps: (body.match(/deps：([^；]+)；/) ?? [, ''])[1].split(', '),
      paths: [...head.matchAll(/^- ([a-z][^\n ]+)$/gm)].map(m => m[1]),
      exceptions: [...body.matchAll(/^- 例外 ([^：]+)：/gm)].map(m => m[1]),
    });
  }
  return out;
}
const split = parse(readFileSync('docs/design/shared-ledger-v2-x12-split.md', 'utf8'), /\n### (X12[A-F]) · /, /\n## 6\./);
const old = parse(readFileSync('docs/design/shared-ledger-v2.md', 'utf8'), /\n### (X\d+) · /, /\n## 3\./);
const x12 = old.get('X12').paths; old.delete('X12');
const files = new TextDecoder().decode(Bun.spawnSync(['git', 'ls-files', '-z']).stdout).split('\0').filter(Boolean);
const sp = p => p.endsWith('/**') ? [p.slice(0, -2), ''] : p.split('*');
function symbolic(a, b) {
  if (!a.includes('*')) return new Bun.Glob(b).match(a);
  if (!b.includes('*')) return new Bun.Glob(a).match(b);
  const [ap, as] = sp(a), [bp, bs] = sp(b);
  if (sp(a).length !== 2 || sp(b).length !== 2) throw Error('glob syntax ' + a + ' ' + b);
  return (ap.startsWith(bp) || bp.startsWith(ap)) && (as.endsWith(bs) || bs.endsWith(as));
}
const expand = n => files.filter(f => n.paths.some(p => new Bun.Glob(p).match(f)));
function compare(a, na, b, nb) {
  const ea = expand(na), eb = expand(nb);
  const hit = ea.filter(f => eb.includes(f)).length;
  const planned = na.paths.filter(x => nb.paths.some(y => symbolic(x, y))).length;
  if (hit || planned) throw Error(a + '/' + b + ' overlap ' + hit + '/' + planned);
  return a + '/' + b + '=0/0';
}
const keys = [...split.keys()], rows = [];
for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++)
  rows.push(compare(keys[i], split.get(keys[i]), keys[j], split.get(keys[j])));
for (let i = 0; i < rows.length; i += 5) console.log(rows.slice(i, i + 5).join(' | '));
let oldPairs = 0;
for (const [a, na] of split) for (const [b, nb] of old) { compare(a, na, b, nb); oldPairs++; }
console.log('splitPairs=' + rows.length + ' splitVsOtherXPairs=' + oldPairs + ' (all 0/0)');
const allGlobs = [...split.values()].flatMap(n => n.paths);
const owners = new Map();
for (const [k, n] of split) for (const e of n.exceptions) {
  if (owners.has(e)) throw Error('hot file claimed twice ' + e);
  if (allGlobs.some(g => new Bun.Glob(g).match(e))) throw Error('exception inside fileGlobs ' + e);
  if (!files.includes(e)) throw Error('exception not tracked ' + e);
  owners.set(e, k);
}
const HOT = ['src/bridge.ts', 'src/scheduler.ts', 'src/manager/ledger.ts', 'src/lib/scheduler-pass.ts',
  'src/bridge/local-api/index.ts', 'src/lib/ledger-write.ts', 'src/bridge/asks.ts', 'src/lib/scheduler-auto-deps.ts', 'src/bridge/ask-entry.ts'];
for (const h of HOT) if (!owners.has(h)) throw Error('hot file not an exception ' + h);
const tv1 = new Set(["web/features/collab/shared/shared-view.tsx", "web/features/collab/shared/shared-ledger.tsx"]);
for (const f of tv1) if (allGlobs.some(g => new Bun.Glob(g).match(f)) || owners.has(f)) throw Error("TV1 file claimed " + f);
let viaGlob = 0, viaException = 0, viaSubPrefix = 0, viaTV1 = 0;
for (const entry of x12) {
  const n = [...split.entries()];
  if (tv1.has(entry)) viaTV1++;
  else if (n.some(([, v]) => v.paths.includes(entry))) viaGlob++;
  else if (owners.has(entry)) viaException++;
  else if (entry.includes('*') && n.some(([, v]) => v.paths.some(p => p.includes('*') && symbolic(p, entry) && p.startsWith(sp(entry)[0])))) viaSubPrefix++;
  else throw Error('X12 entry not covered ' + entry);
}
console.log('X12 entries=' + x12.length + ' fileGlobs=' + viaGlob + ' exceptions=' + viaException + ' testSubPrefix=' + viaSubPrefix + ' transferredTV1=' + viaTV1);
console.log('hot exceptions=' + [...owners].map(([f, k]) => k + ':' + f).join(', '));
for (const [k, n] of split) console.log(k + ' tracked=' + expand(n).length + ' globs=' + n.paths.length + ' exceptions=' + n.exceptions.length + ' deps=' + n.deps.join(','));
JS
```

第 1 轮修订后重跑实测输出（工作树 head d12d0b40，2026-10-03；不含产品代码变更）：

```text
X12A/X12B=0/0 | X12A/X12C=0/0 | X12A/X12D=0/0 | X12A/X12E=0/0 | X12A/X12F=0/0
X12B/X12C=0/0 | X12B/X12D=0/0 | X12B/X12E=0/0 | X12B/X12F=0/0 | X12C/X12D=0/0
X12C/X12E=0/0 | X12C/X12F=0/0 | X12D/X12E=0/0 | X12D/X12F=0/0 | X12E/X12F=0/0
splitPairs=15 splitVsOtherXPairs=90 (all 0/0)
X12 entries=42 fileGlobs=30 exceptions=9 testSubPrefix=1 transferredTV1=2
hot exceptions=X12C:src/bridge/asks.ts, X12C:src/bridge/ask-entry.ts, X12D:src/lib/scheduler-pass.ts, X12D:src/lib/scheduler-auto-deps.ts, X12E:src/bridge/local-api/index.ts, X12F:src/bridge.ts, X12F:src/scheduler.ts, X12F:src/manager/ledger.ts, X12F:src/lib/ledger-write.ts
X12A tracked=0 globs=4 exceptions=0 deps=X6
X12B tracked=6 globs=8 exceptions=0 deps=X12A
X12C tracked=6 globs=8 exceptions=2 deps=X2,X7
X12D tracked=8 globs=11 exceptions=2 deps=X8,X9
X12E tracked=5 globs=9 exceptions=1 deps=X7,X10,X11,TV1
X12F tracked=3 globs=9 exceptions=4 deps=X12C,X12D,X12E
```

脚本只证明 fileGlobs 不重叠。热文件“≤3 行”由各节点验收线里的 `git diff --numstat` 检查兜底；PM 开工前请按最新 DAG 重跑本脚本，外部新卡可能新占文件。

## 7. 对 X13 / X15 的建议（本卡不改它们的范围）

1. X13 deps 由 `X12` 改为 `X12B, X12F`（两者传递覆盖 A–F）。X13 的 fileGlobs 与六个新节点 0/0 不重叠（§6 已比）。
2. X13 的“持久门 + 全组切换”打开 execution 时，要同时翻 X12A 的 `createV2Center({executionEnabled})` 和 X12F 的本机模式文件。建议 X13 规格写明两处都由迁移批次回执驱动，任何一处失败都不开。
3. X15 建议加一条“真实 bridge 传输（X12F）↔ 真实中心路由（X12B）”冒烟：按 §3.1 每行各发一次，核对状态码和形状。X12B 和 X12F 都只对着 §3.1 测，第一次真对接在这里。
4. X12A 和 X12D 可能发现 X0 契约缺字段（例如 X8 注释提到的“中心 step 回执”）。按 v2 §2 的规矩，回 PM 补 X0，不在接线节点私加。

## 附录 · 规格草稿（PM 审后拷成正式规格卡）

每份五节：来源 / 目标 / 范围 / 验收线（缺 = P1）/ 依赖。所有节点共同的禁区：不改 `src/lib/relay-protocol.ts` 和 relay 帧；不碰生产状态目录；`src/lib` 不反向 import `src/bridge` 或中心；web 和 src 不互相 import；新模块 ≤400 行，测试 ≤600 行；只用自己的测试前缀。

### 附录 A · X12A 中心 V2 组合根、跨域端口与单事务分派

**来源**：v2 §2 X12“统一事务组合在 X12”、§1.1 中心单写/所有写入口核 epoch；X1/X2/X4/X6/X14 README 的“只加一行接入，由 X12 执行”；X6 `LendPorts` 注释。

**目标**：
1. `createV2Center(db, opts)`（§3.2）：用 `createTransactionOwner` 注册 X1 `execTasks*`、X2 `asks*`、X3 artifacts、X4 `lease*`/generation、X5 `intent*`、X6 `lend*`、X14 `execWorkflows*` 的 statements 和 schema，在一个 `BEGIN IMMEDIATE` 里依次调各域 `installSchema`；同时建 V2 自己的 `v2_command_receipts` 和 `v2_events` 表（serverSeq 复用 X1 journal：`recordCommit`/`findReceipt`）。
2. `command()` 单事务流程：按 `(teamId, personId, instanceId, requestId)` 查回执 → 命中且 digest 相同时先重新授权再原样返回；digest 不同返回 `dedup_mismatch` → `assertCurrentGeneration` / `assertCurrentBoot` / 核 feature epoch → `V2_COMMAND_POLICY` 角色类 + 服务动作 + `orderId` → `executionOnly` 命令在 `executionEnabled=false` 或 feature 不在 execution 时返回 `execution_not_shared` → 按 `type` 前缀分派到对应域的 `applyInTransaction` → 写一条事件 + 一条不可变回执 → 提交。任何 throw 都整体回滚。
3. `src/shared-ledger/v2-ports*.ts`：实现七个域要求的同步端口，只通过同一个 context 和各域导出的 reader（`readTask`、`readWorkflow`、`readSteps`、`readAsk`、`readLendRow`、`readGeneration` 等）读；不给任何宽松默认值。Lend 的 `writeStep` 只 CAS 单个 step，不调整卡的 deliver/review/stage。
4. `src/shared-ledger/v2-wiring.ts` 只做 re-export 和组装，供 X12B 和 X13 import。

**范围**：fileGlobs 见 §5；不改任何域目录、不改 X0 契约、不碰 HTTP。

**验收线**：
1. 七个域各挑一条代表命令（task.new、ask.create、artifact.put、lease.acquire、intent 提交、lend.create→claim→result、workflow.set）。用 `bun:sqlite` 内存库跑 V1 `migrate` 和 `createV2Center`，断言：返回的回执能过 `parseReceipt`；域表恰好新增目标行；`v2_events` +1；回执 +1。
2. 回滚：用测试端口让 `appendEvent` 在域写入之后 throw，断言所有域表、事件、回执的行数和调用前完全一致。
3. 幂等：同 requestId 同 body 重放，回执深相等且事件数不变；同 requestId 不同 body 返回 `dedup_mismatch`；对已撤销成员重放旧回执返回 `not_member`（先授权再重放）。
4. 总开关：以 `V2_COMMAND_POLICY` 为表驱动，`executionEnabled=false` 时每个 `executionOnly:true` 的命令都是 `execution_not_shared`，每个 `false` 的命令不因此被拒。
5. 栅栏：旧 serviceGeneration 返回 `stale_generation`，旧 epoch 返回 `stale_epoch`，未登记 bootId 被拒；member 发 owner 命令返回 `forbidden`；`orderId` 不同的服务身份发 lend.result 返回 `forbidden`。
6. lend.result 成功后，task 的 stage/head/homeInstanceId 不变，只有绑定 step 和订单变化。
7. 静态检查：测试读 `src/shared-ledger/v2-*.ts` 源码，断言不 import `src/bridge`、`web`、`src/lib/scheduler*`。

**依赖**：X6（PR #434）合并；X0–X5、X14 已在 main。

### 附录 B · X12B 中心 V2 路由、身份映射与快照读

**来源**：v2 §3“中心真实路由在 service 而非只 entry；commands 事务分派，migrations schema 安装，reads/identity 快照权限”、§4 身份与 403 规则。

**目标**：
1. `LedgerService.handle` 新增 `/v2/teams/...` 路由族，转给 `src/shared-ledger/v2-routes.ts`，形状严格按 §3.1。V1 路由和行为不变。
2. 凭据 → `V2Actor`：personId/instanceId 来自已核验凭据；member/owner 来自项目 grants；服务身份的 `serviceId`/`orderId` 只来自凭据。body 里出现 actor/role 字段返回 `invalid_field`。每次请求都 `recheck`，撤成员立即生效。
3. `migrations.ts` 把 shared_schema 升到 4，标记 V2 已安装（真正建表由 `createV2Center` 在同库完成）；`src/shared-ledger.ts` 入口创建 center 并注入 service，`executionEnabled` 不暴露成命令行参数（由 X13 迁移控制）。
4. `reads.ts`/`identity.ts` 补 V2 快照的 hasRead 和 project 过滤；`commands.ts` 只在必要时抽出共用 helper，V1 语义不变。

**范围**：fileGlobs 见 §5；不改 X12A 文件和域目录。

**验收线**：
1. 用现有 V1 测试的签名 helper 构造请求，对 `LedgerService.handle` 跑 §3.1 五行各一次：200 且形状过对应 parse 函数。
2. 重放同一 POST commands 拿到相同回执；receipts 路由在已提交时返回 committed、未提交时返回 unknown、digest 不符时返回 409 `dedup_mismatch`。
3. body 带 `actor`/`role`/`personId` 返回 400 `invalid_field`；P1 凭据读 P2 的 feature，与读不存在的 feature 返回的状态和 body 字节相同。
4. 凭据撤销或过期后，同一请求返回 `not_member`；服务凭据 orderId=O1 发 O2 的 lend 命令返回 403。
5. 迁移：v3 库打开后升到 4；再打开不重复执行；V1 现有测试（`tests/shared-ledger*.test.ts` 中非 v2 的那些）全过，测试报告列出所跑文件。
6. execution 总开关在默认入口下是关的：POST 一条 `executionOnly` 命令返回 403 `execution_not_shared`。

**依赖**：X12A。

### 附录 C · X12C 业务 ask 全链路改走中心

**来源**：v2 §3“共享卡业务 ask 按中心 id/feature 模式分流…”；§1.1 asks 行；X7 client 的 ask/command。

**目标**：
1. `src/bridge/shared-ledger-v2-asks.ts`：`configureSharedAsks`（§3.3）；`isSharedAsk(taskId)` 只按 `featureOfTask` 和 feature 的 execution 模式判断；`sharedAskCreate`/`sharedAskAnswer`/`sharedAskDismiss`/`sharedAskExpireSweep`/`sharedAskLocate`/`sharedAskCheck` 都通过 X7 client 发 `ask.*` 命令或读 ask。
2. 薄接线：`ask-reply.deliverReplyWithAsk` 遇到共享卡时建中心 ask；`asks.ts` 的 `commitAnswer`（例外 ≤3 行）把 Web、Discord、聊天三类答复统一转给中心；`ask-dismiss`、`ask-expire`、`ask-locate`、`local-api/asks`（列表合并中心 pending ask）、`ledger ask-check`（共享 ask 由中心核 bind/版本）。
3. 本机 askDb 只存展示用的通知映射（中心 askId → 本机消息），不存批准状态；runtime permission、AUQ、非共享 ask 一行不动。

**范围**：fileGlobs 和例外见 §5；不改 X7 文件，不改 `src/bridge.ts`。

**验收线**：
1. 用 fake `ExecTransport`（内存中心，记录收到的每条命令）：共享卡 reply → 恰好 1 条 `ask.create`，本机 askDb 不新增批准记录；非共享卡 reply → 0 条中心命令，本机 ask 照旧。
2. 同一共享 ask 分别从 `answerFromChat`、`answerFromCard`、`answerFromDiscord` 答复：三次都打到同一个中心 askId；第一次成功后，后两次返回中心的 `conflict`/已答复，本机不会产生第二次批准。
3. 中心不可用（transport throw unavailable）：答复返回错误，本机 askDb 状态不变，`ask-check` 对该 ask 退出码非 0。
4. `ask-check`：中心返回 `authorization_mismatch` 或 `authorization_expired` 时退出码非 0；本机缓存里即便有旧的 approved 也不能让它通过；调用 X7 `checkAuthorization` 在线发 `authorization.check`（新 requestId），验证当前 task/spec/workflow/head 的 liveBind，不以 GET ask 代替。
5. 撤销和过期：`ask-dismiss` 经 `cancelAsk` 发 `ask.cancel`，断言中心 ask.state 为 `cancelled` 且本机批准状态不变，`sweepExpired` 对共享 ask 只读中心状态，不在本机自行判过期。
6. runtime permission 和 AUQ 的现有测试原样通过（列出所跑文件）；`git diff --numstat` 显示 `src/bridge/asks.ts`、`src/bridge/ask-entry.ts` 各自新增 ≤3、删除 ≤3。

**依赖**：X2、X7（已合并），可立即开工。

### 附录 D · X12D 出借代理与独立部署 job 接线

**来源**：v2 §3“独立部署链 scheduler.ts --deploy-job → job/worker/steps 四处接线”“worker 显式建立中心客户端，每个实际步骤前在线核”；§1.1 出借行；X8 worker/deploy 注释、X9 `LedgerLendCentralClient` 注释。

**目标**：
1. 出借：`src/bridge/shared-ledger-v2-lend.ts` 的 `configureLendCentral`。共享 execution feature 的订单在 `lend-tools`（worker 的 deliver/verdict）、`local-api/lend`（peer 的 claim/result HTTP）、`lend-inbox`、`lend-dispatch`（beat）里，按订单绑定构造 `LedgerLendCentralClient`；绑定写进本机 journal，恢复时沿用原绑定。非共享订单不变。
2. 部署：`scheduler-deploy-job` 提交 central job 时附 `schedulerCentralDeployment(context, connectionId)`；`scheduler-deploy-worker.runDeployJob` 看到 `central` 字段时走 X8 的 `runSchedulerCentralDeployJob(path, deps.central)`，`deps.central` 缺失时直接 `blocked`，不退回本机部署；`scheduler-deploy-steps` 在需要时提供具名 step 边界。
3. 调度：`scheduler-apply` 对 execution feature 不再做本机阶段推进，改为提交中心 intent（通过 X8 gate）；`scheduler-pass`/`scheduler-auto-deps` 各 ≤3 行，调 `src/lib/scheduler-v2-wiring.ts` 的判定。

**范围**：fileGlobs 和例外见 §5；不改 `src/lib/scheduler-central*`、`src/lib/ledger-lend-central*`（X8/X9 文件）和 `src/scheduler.ts`。

**验收线**：
1. 出借：fake `LendCentralTransport` 场景下，worker 交付共享订单 → `lend.result` 恰好提交 1 次，本机 `ledger-write.deliver` 调用 0 次（spy）；body 里换别的 orderId 返回 `forbidden`。
2. 出借恢复：第一次 command 抛 unavailable 时结果进 outbox（status `outbox`）；重启后再调只做对账（status `ready`），不会自动重交；显式 `recover(...,true)` 才重交，而且用的是原 binding（断言 requestId 不变）。
3. 部署断中心：fake client 在第 1 步成功后让 `checkSchedulerCentral` 抛 `stale_epoch`。断言第 2 步的 argv 从未执行（run spy 只调用 1 次）；结果为 `unknown`，`resourceHeld=true`；`result.json` 写了 unknown；没有本机重试。
4. 部署失 epoch：执行中途 lease 失效，表面上本地成功也要记成 unknown（与 X8 语义一致），并且没有调用本机 `applySchedulerStage`。
5. central job 缺 `deps.central` 时返回 `blocked`，不执行任何 argv；非 central job 走原 `runDeployJob`，旧测试全过（列出文件）。
6. 调度：execution feature 的任务在 `schedulerPass` 里不产生本机 stage 事件（ledger events 计数不变）；`git diff --numstat` 显示 `scheduler-pass.ts`、`scheduler-auto-deps.ts` 各自新增 ≤3、删除 ≤3。

**依赖**：X8（#457）、X9（#455）合并。

### 附录 E · X12E TV1 数据源接线、本机 API 与 MCP 工具入口

**来源**：v2 §2 X10/X11“复用既有 UI 模式”、X12“网页壳及 DTO”“DAG 和订单 MCP”；§1.1“网页经本人 bridge、CLI/PM 同命令入口”。

**目标**：
1. 本机 API：`src/bridge/local-api/shared-ledger.ts` 加 `/shared-ledger/v2/*` 四条路由（§3.3 末段），actor 由 Principal 映射，不读 body；通过 `src/bridge/shared-ledger-v2-entry.ts` 的端口调 X7 client；独立 receipts 查询走 §3.3 的只读 receipt 端口。
2. 网页：依赖 TV1、接 TV1 的数据源，在同一个 CollabView 的数据适配层提供 execution feature 的 X10/X11 输入与命令 transport；不新增 shared-v2 界面，不改 TV1 的视图文件；`EXECUTION_ACTIONS` 的 enabled/reason 来自中心 capabilities；显示主场、执行地和“数据过期”（复用 `isDataStale`）；提交时状态未知只提示查回执。`web/lib/api/shared-ledger-v2.ts` 放 DTO 和 transport；i18n 补中英文。
3. MCP：`dag-tools`、`order-tools` 在 execution feature 上把 dag.* / task.deliver / task.review 改走端口；端口为 null 时返回 `unavailable`；非共享卡不变。

**范围**：fileGlobs 和例外见 §5；不改 `web/features/collab/shared/task/**` 和 `approve/**`（X10/X11），不认领 shared-ledger.tsx/shared-view.tsx（PM 移交 TV1）；网页只接 TV1 数据源。

**验收线**：
1. 本机 API：fake 端口场景下，POST commands 时 body 带 actor 返回 400；不带时端口收到的 actor 等于 Principal 映射值；receipts 端口收到已认证 Principal 及完整 teamId/projectId/requestId/operationId/commandDigest；committed/unknown 原样透传，submit/command spy 都为 0；跨项目拒绝、transport 错误返回错误且不伪装 unknown；端口为 null 时 503 `unavailable`。
2. TV1 数据源适配单测（沿用 TV1 与 X10/X11 夹具）：capabilities 中 `task.new.enabled=false` 时按钮 disabled，title 等于 reason；数据过期时显示过期提示；member 视角看不到签署按钮（复用 X11 `canSign`）。
3. DOM 测（`tests/web-dom-shared-ledger-v2-wiring*`）：开卡表单提交后，fetch spy 收到恰好 1 次 POST `/api/v1/shared-ledger/v2/commands`，body 过 `parseCommand`；收到 409 conflict 时进入 X10 冲突态。
4. MCP：execution feature 上调 `deliver` 工具 → 端口收到 `task.deliver`，本机 `ledger-write.deliver` spy 0 次；非共享卡 spy 1 次。
5. `git diff --numstat` 显示 `src/bridge/local-api/index.ts` 新增 ≤3、删除 ≤3（预计 0）；web 不 import src（测试扫描 import）。

**依赖**：X7、X10、X11（已合并）及 TV1；等 TV1 的数据源契约完成后开工。

### 附录 F · X12F 本机传输、组合根、持久写门与 CLI

**来源**：v2 §3“逻辑放新 wiring，旧文件薄调用”“本机缓存/通知映射/outbox 只作展示投递，不能当授权”；X7 gate 的 `ExecIdentity` 注释（“X12 supplies these from authenticated local transport”）；X8 `openClient` 注释。

**目标**：
1. `src/lib/shared-ledger-v2-transport.ts`：照 §3.1 实现 X7 `ExecTransport`、X9 `LendCentralTransport`、X8 `SchedulerCentralClient`，签名复用 `SharedLedgerClient`；网络错误统一成 `unavailable`，4xx 原样带回 code。
2. `src/lib/shared-ledger-v2-wiring.ts`：从 `shared-ledger-mode` 的本机凭据构造 `ExecIdentity`、`SharedLedgerExecGate`、`SharedLedgerExecClient`、`SharedLedgerExecLocal`（按已认证身份 + project 缓存单例，不能跨 Principal 共用身份）；`openSchedulerCentralClient(connectionId)` 只读本机配置。
3. `src/bridge/shared-ledger-v2-wiring.ts`：`initSharedLedgerV2()` 依次调 `configureSharedAsks`、`configureLendCentral`、`configureSharedExecEntry`；凭据缺失时注入 null（fail-closed）；向 E 注入 §3.3 独立只读 receipt/snapshot 端口。
4. 持久写门：`src/lib/shared-ledger-v2-write-gate.ts` 的 `assertLocalWrite(db, ctx, event)`，在 `ledger-tx.tx` 的 SQLite 事务开始、执行写回调之前采集 task 的旧共享绑定/模式，事务内保持此快照；`insertEvent` 同时核旧快照和新行绑定：任一归属 execution 模式时抛 `LedgerError("forbidden")`；导入身份由 X13 管，这里不放宽。`ledger-dag-write` 对 execution feature 的 rewrite/approve/bind 同样拒绝。
5. `shared-ledger-mode` 加 `sharedLedgerExecutionEnabled()`，默认 false，只读、本卡不提供写开关。
6. CLI：`src/manager/ledger-shared-exec-cmds.ts` 提供 `ledger shared-exec receipt <requestId>` 和 `ledger shared-exec recover <kind> [--resubmit]`。recover 先查回执、租约和版本，必须显式带 `--resubmit` 才会重交。

**范围**：fileGlobs 和例外见 §5；不改 X7/X8/X9 的文件。

**验收线**：
1. 传输：fake fetch 对 §3.1 每行断言 method、路径、签名头齐全、body 不含 actor；fetch reject 变成 `unavailable`；403 body 原样得到 `V2ContractError("forbidden")`。
2. 写门：临时台账里建一张 `extra.sharedFeatureId=F` 的卡，模式文件 F=execution 时，`moveStage`/`deliver`/`recordReview`/`setTask`/`rewriteDag` 每个都抛 forbidden，tasks 的 extra/rev/stage 及 events 与调用前完全一致；补 `setTask` 的 extra={}、删除 sharedFeatureId、替换为 planning feature/非共享 feature 四个反例，均按旧归属拒绝并整体回滚；F=planning 时原行为不变（表驱动覆盖 `ledger-write` 全部导出写函数）。
3. 组合：`initSharedLedgerV2()` 在凭据缺失时，三个 configure 都收到 null，并且调各自入口返回 `unavailable`；凭据存在时 C 的 clientFor 与 E 的 clientFor（同 Principal/project）返回同一缓存 client；D 的 transportFor 返回对应 project 的订单 transport，grant/outboxDir 等于配置依赖；E 的 receipt/snapshot 使用对应 Principal/project 的只读传输；跨 Principal 不复用别人的身份。
4. outbox 不是授权：`SharedLedgerExecLocal` 里有 pending result 时，`ask-check` 允许且必须在线发 `authorization.check` 校验 liveBind；分别计数 probe 与结果/副作用命令，断言 probe=1、outbox 结果/副作用重交=0。写门与 `recover` 不带 `--resubmit` 的 submit=0（只读对账可调用）；中心不可用时 ask-check 失败，pending 与 outbox 原内容不变。
5. `sharedLedgerExecutionEnabled()` 默认 false；源码扫描断言本卡没有新增任何写模式文件为 execution 的路径。
6. `git diff --numstat` 显示 `src/bridge.ts`、`src/scheduler.ts`、`src/manager/ledger.ts`、`src/lib/ledger-write.ts` 各自新增 ≤3、删除 ≤3。

**依赖**：X12C、X12D、X12E（需要它们导出的 configure 端口）。

## 第 1 轮审查项核对（设计验收，不冒充已实现节点的测试）

- P1 ask-cancel：核对 X0 `V2_COMMAND_NAMES` / ask 状态契约及 X7 client；命令为 `ask.cancel`、方法为 `cancelAsk`、撤销状态为 `cancelled`。附录 C.5 已改，已删除原无效撤销命令。
- P1 receipt-port：核对 X7 client 无公开 receipt 方法且 `command` 在未知回执后会 submit；§3.3 已冻结带 Principal 和五个查询字段的独立只读端口，F 注入、E 消费；E.1 验收分别断言完整参数、unknown 透传、写调用为零及读权限错误。
- P1 authorization-probe：核对 X7 `checkAuthorization` 发 `authorization.check`，中心 authorization 的 `liveBind` 核当前绑定；C.4 / F.4 保留在线 probe，并将 probe 与 outbox 结果/副作用重交分别计数，不再要求全部 command 为零。
- P2 write-gate-order：F 在事务回调前保留旧归属，事件落点同时核旧/新归属；F.2 加清空、删除、替换绑定反例，要求任务行和事件整体不变。
- P2 configure-assertion：F.3 按 C/E 客户端、D 订单 transport/grant/outboxDir、E 只读端口分别验收，不再比较三种不同端口的 client。
- PM TV1：§4.1 两个网页文件移交 TV1，§5 无其 fileGlob，也无新增 shared-v2 界面；E 依赖 TV1、接 TV1 的数据源。修订后原样运行 §6 脚本，15 对新节点和 90 对旧节点均 0/0；42 条为 30 fileGlobs + 9 例外 + 1 测试前缀 + 2 TV1 移交。
