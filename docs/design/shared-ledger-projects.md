# i28-PRJ1 · 共享项目中心化：团队在中心建项目，成员加入

状态：设计稿，specRev 1；代码核对基线 `2bb679d3`。只出设计，不改代码。
**结论：共享项目的唯一身份是团队在中心建的项目记录（`centerId + teamId + projectId`），不用 git remote，也不靠名字或目录推断。**
**本机 projects.json 只管「这台机器上的代码在哪」；本机项目和中心项目的对应关系只记在 `shared-ledger-bindings.json`，一对一，由 owner 在卡上点选决定。**

相关：[`shared-ledger.md`](shared-ledger.md)（中心单写、身份与权限、导入迁移）。
本文的「owner」仍按该文定义：团队 / 项目授权名单里指定的本人，不是任意机器的本机 owner。

## 0. 起因与现状

- 两台 peer 入组后侧栏没有「团队 · 全部 feature」。原因：各机器的本机项目 id 各起各的（两台 peer 本机叫 `claudestra`，中心叫 `claude-orchestrator`），
  入组时 [`joinSharedLedger`](../../src/lib/shared-ledger-join.ts) 在没传 `--project` 时用 `localProjectId = 中心 projectId`，绑到了本机不存在的项目。
  i28-JN4 让 owner 在卡上选本机项目，把绑定修对；本文定长期做法。
- 中心表（[`migrations.ts`](../../src/shared-ledger/migrations.ts)）：`projects(teamId, id, code)` 只有 id 和代号，没有显示名、创建人、成员；
  项目成员关系散在 `join_codes.projectId` 和 `credentials.grants` 里。建项目、发码目前只有离线运维脚本 `shared-ledger-admin invite`。
- 本机：[`projects.ts`](../../src/lib/projects.ts) 的 `ProjectDef{id,name,dirs,personal?}`；
  [`shared-ledger-gate-bindings.ts`](../../src/lib/shared-ledger-gate-bindings.ts) 的 `{centerId, teamId, projectId, localProjectId}`（0600，按 localProjectId 去重）；
  凭据在 `shared-ledger-credentials.json`（0600，每个中心项目一条）；
  [`shared-ledger-gate-proxy.ts`](../../src/lib/shared-ledger-gate-proxy.ts) 按绑定 + 凭据选中心身份。
- 入组传递：JN1 一次性入组码（实例私钥签名兑换）；JN2 加固；JN3 由 peer bridge 把码递给对方、对方 owner 点卡入组
  （[`shared-ledger-join-offer.ts`](../../src/bridge/shared-ledger-join-offer.ts)）；JN4 卡上选本机项目。

## 1. 项目身份

### 1.1 结论

共享项目 = 中心 `projects` 表的一行，主键 `(teamId, id)`；全局引用写成 `centerId/teamId/projectId`。
- **不用 git remote**：同一仓库可被两个团队项目使用（如主线和一个实验分叉），一个项目也可以跨多个仓库（本机 project 本来就允许多目录）；
  remote 地址还会改名、换托管、带凭据。身份只认中心记录。
- **不按名字 / 本机 id 对应**：本机 id 由各机器自己起，会撞名也会不同名（这次事故就是）。
- 中心 `projectId` 建好后**不可改**（features、dag、凭据 grants、id_map 都引用它）；能改的只有显示名。

### 1.2 中心项目记录字段

| 字段 | 说明 | 谁定 |
|---|---|---|
| `teamId` | 所属团队 | 建项目时的团队，不可改 |
| `id` | 中心项目 id，`[a-z0-9][a-z0-9_-]{0,31}`（与本机 `PROJECT_ID_RE` 同形，方便默认同名） | 建项目时由创建人填或按显示名自动生成；不可改 |
| `code` | 现有代号列，保留 | 同 id 默认 |
| `name` | 显示名，自由文本（CJK 可），≤ 64 字 | 项目 owner，可改（带 rev） |
| `createdBy` | 创建人 personId | 中心写入，不可改 |
| `createdAt` / `updatedAt` | 时间 | 中心写入 |
| `status` | `active` / `archived` | 项目 owner |
| `rev` | 改名 / 归档的 CAS 版本 | 中心 |

新表 `project_members(teamId, projectId, personId, role, status, addedBy, addedAt)`：
`role ∈ owner | member`（与 shared-ledger.md §4 的项目 owner / member 一致），`status ∈ invited | active | removed`。
`members` 表加 `teamRole ∈ owner | member`（缺省 member）：团队 owner 才能建项目。

**中心不存任何机器上的目录**（沿用 shared-ledger.md §3.1「不含机器目录」）。每个成员机器的本地目录由**那台机器的 owner 在本机定**，
存本机 projects.json 的 `dirs`；中心只知道「哪个 person / instance 是成员」。

### 1.3 和本机 projects.json 的对应

```
中心 projects(teamId,id)  ←1:1→  shared-ledger-bindings.json 一行  ←1:1→  本机 projects.json 一项(id)
```
- 对应关系**只**记在 `shared-ledger-bindings.json`（已有，0600、加锁写、只由本机认证过的 manager 写）。
  加一条不变式：一台机器上，同一个 `(centerId, teamId, projectId)` 最多绑一个本机项目，同一个本机项目最多绑一个中心项目（现在只保证后者）。
- projects.json **不加**中心字段。备选是给 `ProjectDef` 加 `shared:{centerId,teamId,projectId}`：好处是一个文件看全；
  坏处是 projects.json 是宽松读、多处写的管理数据，而绑定决定 gate proxy 用哪份凭据，属于安全面。推荐保留单一来源，
  网页 / CLI 显示时把两份文件 join 起来（「本机项目 claudestra ↔ 团队项目 Claudestra」）。
- 本机项目 id 和中心 id **允许不同**。新建本地项目时默认取中心 id（撞了再加 -2），显示名默认取中心显示名。
- **个人项目**（`isPersonalProject` 为真：标了 personal 或目录是伞形根 / 解析不了）**永远不能绑定中心项目**，也不能从它发起建中心项目；
  已绑定的项目不能再改成 personal（改之前要先在网页「退出团队项目」）。空目录的新本地项目不算个人项目（规则只看 personal 标记与已有目录），
  目录设上之后再按规则判定，命中伞形根即拒绝保存。

## 2. 谁建项目

**结论：团队 owner 在网页点「新建团队项目」，由系统调中心 API 建；本机不再各自起共享项目。**

- 入口：网页「团队」面板 → 「新建团队项目」按钮 → 表单（显示名、可选 id、可选「把本机现有项目作为我的本地项目」）→ 提交。
- 系统执行：本机 bridge 用 owner 本人（`owner:self`，kind=person）对该中心的凭据签名调用 `POST /v1/projects`；
  中心核 `members.teamRole = owner` 后在一个事务里写 `projects` + `project_members(创建人, owner, active)` + 事件。
- 创建成功后，创建人本机立即走 §3.2 同一张「本机对应哪个项目」卡（表单里已选了本机项目则直接写绑定，不再弹卡）。
- 团队 PM（agent）**不能直接建**：PM 用的是 service 身份，只能开一张 authorize 卡「建议新建团队项目 X」，owner 点「建」后由 bridge 用 owner 身份执行
  （复用 ask-bind 绑定参数，和 JN3 入组卡同一套校验）。理由：建项目会扩大谁能读写什么，属于项目 owner 的决定（shared-ledger.md §4）。
- 改名 / 归档：项目设置页按钮，`PATCH /v1/projects/:id`（带 rev，CAS 冲突回 409 并给出当前值）。

中心 API（新增，契约写在新文件，见 §6 N1）：

| 方法 | 用途 | 权限 |
|---|---|---|
| `GET /v1/projects` | 列出调用者所在团队里自己是成员的项目（团队 owner 看全部） | 有效成员凭据 |
| `POST /v1/projects` | 建项目 `{id?, name}` | teamRole=owner |
| `PATCH /v1/projects/:id` | 改名 / 归档 `{rev, name?, status?}` | 项目 owner |
| `GET /v1/projects/:id/members` | 成员列表（代号、角色、状态） | 项目成员 |
| `POST /v1/projects/:id/invites` | 为某 person（已有或新建代号）铸一次性入组码，返回码给**调用方 bridge** | 项目 owner |
| `POST /v1/projects/:id/members/:personId/remove` | 移出项目（不移出团队） | 项目 owner |

`/invites` 返回的码只进 bridge 内存，立即走 JN3 offer 发给 peer，不落 owner 机器磁盘、不进网页、不进日志（沿用 JN1/JN3 的码纪律）。

## 3. 成员加入

### 3.1 流程（全部按钮）

1. 项目 owner 在项目页点「邀请成员」，在已握手的 peer 列表里选一台（可多选），可附一句话。
2. owner 机器 bridge：`POST /v1/projects/:id/invites` 拿码 → 按 JN3 `POST /api/v1/shared-ledger-join-offer` 递给对方 bridge。
   offer 体新增非机密字段 `project: {teamId, projectId, name}`，**只用于卡面显示和预选**，兑换后以中心 grant 为准，不一致即判失败。
3. 对方 bridge 开授权卡「加入团队项目 Claudestra？」，卡上就是本机项目选择（见 3.2）。owner 点「加入」。
4. 对方 bridge：兑换码（JN1，实例私钥签名）→ 中心把 `project_members` 置 active → 本机写凭据 → 按卡上选择新建或绑定本地项目 → 写绑定 → 回执给邀请方。
5. 侧栏「团队 · 全部 feature」按绑定出现该项目。

### 3.2 本机怎样得到这个项目

卡上给出单选（JN4 的选项卡形态，扩展「新建」一项）：

- **A. 新建本地项目（推荐默认）**：id 默认 = 中心 id（撞名加 -2），显示名 = 中心显示名，`dirs` 先空；
  卡回执里带「设置目录」按钮，打开网页现有项目编辑框选目录（网页表单，不跑命令）。之后在这些目录里建的 agent 自动归属。
- **B. 绑定到已有本地项目**：列出本机所有「非个人、尚未绑定任何中心项目」的项目。
- 预选规则（只是预选，owner 可改，绝不静默生效）：有一个未绑定的非个人本地项目，其 id 或显示名与中心 id / 显示名相同（忽略大小写）→ 预选 B 指向它；否则预选 A。
  **不读 git remote、不按目录猜**。

推荐 A 为默认的理由：
- 中心项目是「团队的」，本机已有项目是「我的」，两者边界常常不同（本机项目可能多挂了私人目录或别的仓）；新建能让边界由 owner 明确划定。
- A 不会把本机已有 agent / 台账默默拉进共享视图；B 会让该项目所有 agent 立即在团队里可见（读面），需要 owner 有意选择。
- 这次事故的机器都已有同仓的本地项目，此时按名字预选 B 能一步到位，所以预选规则覆盖了「已有」场景。

备选「入组时全自动按目录 / remote 匹配」不采纳：owner 已明确不用 git；按目录猜会把 worktree、审查 clone 等误认。

### 3.3 已入组成员再加入第二个项目

沿用「每项目一个码、一份凭据」（`writeSharedLedgerCredential` 已按项目分条保存）：invite 指定已有 personId，同一实例兑换后新增一条 per-project 凭据，
旧凭据不动。备选是中心给已有实例追加 grant、本机签名拉取刷新（少一次码），但要新协议；V1 不做，记为后续。

## 4. 和现有机制的关系

| 现有机制 | 处理 | 说明 |
|---|---|---|
| JN1 一次性入组码、实例私钥签名兑换（`/v1/join`） | **保留** | 成为「邀请」按钮背后的传输手段；人不再看到、复制码 |
| JN2 加固（instanceId 抢占保护、限流） | **保留** | 不变 |
| JN3 peer offer / 授权卡 / 回执 | **保留并扩展** | offer 加 `project` 显示字段；卡加本机项目选择；回执不变 |
| JN4 卡上选本机项目 | **合并** | 并入 §3.2 的入组卡和 §5 的迁移卡，成为同一个选择组件 |
| `shared-ledger-bindings.json` | **保留，加不变式** | 唯一的对应关系来源；加 `(centerId,teamId,projectId)` 唯一；写入拒绝个人项目 |
| `shared-ledger-join` 不带 `--project` 时绑到同名 id | **弃用该默认** | 改为必须带明确本机项目（由卡给出）；CLI 不带则报错要求选择 |
| `manager shared-ledger-join` / `shared-ledger-offer` CLI | **保留为系统内部 / 运维兜底** | 不出现在任何人需要操作的步骤里 |
| `shared-ledger-admin invite`（离线脚本） | **保留为运维兜底**，日常由 `POST /v1/projects/:id/invites` 取代 | 首个团队 owner 的引导仍由部署单完成（见 §5.1） |
| 本机 `project-add` | **保留** | 只建本机项目（个人或本地）；不再有「本机建项目后推到中心」 |
| 本机 `project-assign` / `project-merge` / `project-edit` | **保留** | 只管 agent→本机项目、目录；合并 / 删除一个已绑定项目时先拒绝，提示先「退出团队项目」 |
| 导入（`import prepare/commit/activate`） | **保留，前置条件改变** | 只能导入到**已在中心存在**、且本机已绑定的项目；不再借导入隐式创建中心项目 |
| 个人项目 | **保留规则** | 永不外借、永不上中心：不能绑定、不能发起建中心项目、不能被导入 |

## 5. 迁移

### 5.1 中心（一次，随中心版本升级自动跑）

中心 schema v4 迁移（事务内、幂等）：
1. `projects` 加 `name/createdBy/createdAt/updatedAt/status/rev`。现有行：`name = code`，`status = active`，`createdBy` = 规则 3 选出的团队 owner。
2. 建 `project_members`，从**已用且未吊销**的 `join_codes` 和有效 `credentials.grants` 回填 `(person, project, member, active)`。
3. `members.teamRole`：持有该团队 `project` 动作服务凭据的 person（即导入身份所代表的本人，见 shared-ledger.md §10.4）标为 owner，
   并在其已有项目里把 `project_members.role` 设为 owner。若命中 0 或多于 1 人，迁移不猜：全部保持 member，网页显示「团队 owner 待确认」，
   由部署单（已有的 owner 批准流程）指定；在此之前建项目按钮置灰，其余功能不受影响。
4. 不改任何 projectId、featureId、凭据哈希；现有 bearer 全部继续有效。

迁移后 owner 在项目设置页把 `claude-orchestrator` 的显示名改成「Claudestra」（按钮）。**中心 id `claude-orchestrator` 不改名**——改 id 会牵动 features、
dag、id_map、全部 grants，收益只是好看；显示名已解决可读性。

### 5.2 每台机器（bridge 升级后启动时自动核对）

新的「共享项目核对」在 bridge 启动和每次入组后运行，只读计算，有问题才开卡：
- 读 bindings + credentials + projects.json，逐条判定：
  - **正常**：绑定的本机项目存在、非个人、凭据可读 → 不打扰。
  - **悬空**：绑定的 `localProjectId` 在 projects.json 里不存在（这次的事故形态）→ 开「这个团队项目对应本机哪个项目？」卡（§3.2 同一组件，预选按名字规则）。
  - **重复**：同一中心项目绑了多个本机项目 → 同一张卡让 owner 留一个。
  - **个人**：绑到了个人项目 → 卡上只能改选或新建，不能保留。
  - **有凭据无绑定**：凭据里有项目但没有绑定 → 同一张卡补绑定。
- owner 点选后，系统在锁内改写 bindings（写前备份为 `shared-ledger-bindings.json.bak-<时间>`，0600），**凭据文件不碰**；改完再读回核对一次。

三台机器各自会发生什么：

| 机器 | 现状（预期） | 升级后发生的事 |
|---|---|---|
| 本机（中心所在、owner 机器） | 本机项目即导入来源，已与 `claude-orchestrator` 正确绑定；持 person + service 凭据 | 核对为「正常」，不开卡；中心迁移把 owner 标为团队 owner；owner 点按钮改显示名 |
| HedeMacBook-Pro | 本机项目 `claudestra`；入组时绑定可能指向不存在的 `claude-orchestrator`（JN4 若已修则正常） | 若已被 JN4 修好：不开卡。否则核对为「悬空」→ 开卡，按显示名「Claudestra」预选本机 `claudestra`，owner 点「确认」即改绑；凭据保留 |
| Sekai | 同 HedeMacBook-Pro | 同上 |

不丢东西的保证：凭据文件全程只读；bindings 只在 owner 点选后改、改前备份；中心不改任何 id；本机 projects.json 只在选「新建」时追加一项。
核对卡被忽略或过期 = 什么都不变（与今天一样），下次启动再提示。

## 6. 拆分（可并行的 PR 节点）

依赖：节点之间只通过本文 §2、§3、§5 写定的接口对接，可同时开工；N4、N5 的端到端验收在 N1–N3 合并后补跑。
**规格例外（热点文件）**：下列文件允许多个节点改，但每个节点只能**追加一处注册行**、不改已有行：
`src/shared-ledger/server.ts`（路由表，仅 N1）、`src/bridge/api-routes.ts`（N4、N5 各一行）、`src/bridge/ask-entry.ts`（N6 一行启动钩子）。

### N1 · 中心项目记录与成员 API

- 目标：中心 schema v4（§5.1）；`GET/POST/PATCH /v1/projects`、成员列表、`/invites`、移出；teamRole 与 project role 权限检查；契约与 fixture。
- fileGlobs：`src/shared-ledger/projects*.ts`、`src/shared-ledger/migrations.ts`、`src/lib/shared-ledger-contract-v2-projects*.ts`、`tests/shared-ledger-center-projects*.test.ts`
- 规格例外：`src/shared-ledger/server.ts` 只追加路由注册。
- 验收线：
  1. v3 库升级到 v4 幂等，已有 projectId / 凭据 / features 不变，现有 bearer 读写全部通过；
  2. 非团队 owner 建项目 403，非项目 owner 邀请 / 改名 / 移出 403，改名 rev 冲突 409 带当前值；
  3. `/invites` 码只出现在响应体，日志、事件、错误文本不含码（测试断言）；
  4. teamRole 回填遇 0 或多个候选时不设 owner；
  5. 移出项目后该 person 对该项目的读写立即 403，对同团队其他项目不受影响。

### N2 · 本机绑定模型与入组兑换

- 目标：bindings 加 `(centerId,teamId,projectId)` 唯一与个人项目拒绝；`joinSharedLedger` 必须传明确的本机项目或 `create` 指令（新建本地项目 id/名默认值逻辑）；
  join 结果核对中心 grant 与 offer 显示字段一致；`shared-ledger-join` CLI 去掉「默认同名」。
- fileGlobs：`src/lib/shared-ledger-gate-bindings.ts`、`src/lib/shared-ledger-gate-proxy-join-pins.ts`、`src/lib/shared-ledger-join.ts`、
  `src/lib/shared-ledger-project-link*.ts`（新：建或绑本地项目）、`src/manager/shared-ledger-join-cmd.ts`、`tests/shared-ledger-project-link*.test.ts`、`tests/shared-ledger-join-{cmd,e2e,harden,center}.test.ts`（已有，改默认后要跟着改）
- 规格例外：无（新建本地项目通过现有 `writeProjects`，不改 `projects.ts`）。
- 验收线：
  1. 绑定个人项目、同一中心项目绑第二个本机项目、本机项目绑第二个中心项目均拒绝且不写盘；
  2. 未指定本机项目时 join 报错且不兑换码；
  3. 选「新建」时生成 id 撞名加后缀、显示名取中心名、dirs 为空，不是个人项目；
  4. 兑换后 grant 的 projectId 与 offer 显示的不一致 → 不写凭据不写绑定；
  5. 现有凭据文件在所有失败路径下字节不变。

### N3 · 中心项目客户端

- 目标：`SharedLedgerClient` 增加 projects 列表 / 建 / 改 / 成员 / 邀请 / 移出方法，按 N1 契约校验响应；错误文本固定、不回显响应体。
- fileGlobs：`src/lib/shared-ledger-client*.ts`、`tests/shared-ledger-client-projects*.test.ts`
- 规格例外：无。
- 验收线：
  1. 每个方法签名用 owner:self person 凭据，按 N1 契约 fixture 往返通过；
  2. `invites` 返回的码只作为返回值，不进任何日志 / 异常文本（测试断言）；
  3. 409 返回当前值供 UI 显示；403/404 固定文案。

### N4 · bridge 侧：建项目、邀请、入组卡

- 目标：本机 local-api `POST /api/v1/shared-projects`（建）、`PATCH …/:id`、`POST …/:id/invite {peers[], note}`、`GET …`（含本机绑定 join 视图）；
  邀请 = 调 N3 拿码 → JN3 offer（加 `project` 字段）；入组卡改为 §3.2 单选（新建 / 已有项目），点「加入」后用 N2 执行；PM 建议建项目的 authorize 卡。
- fileGlobs：`src/bridge/local-api/shared-projects*.ts`、`src/bridge/shared-ledger-join-offer.ts`、`src/bridge/local-api/shared-ledger-join-offer.ts`、
  `src/lib/shared-ledger-join-offer.ts`、`src/manager/shared-ledger-offer.ts`、`tests/shared-ledger-join-offer*.test.ts`（已有）、`tests/shared-projects-api*.test.ts`
- 规格例外：`src/bridge/api-routes.ts` 只追加一行路由注册。
- 验收线：
  1. 只有全权管理凭据（owner）能调这些端点，guest / peer 403；
  2. 码从中心响应到 offer 请求体全程不落盘、不进日志与卡面（测试扫描日志 / 卡文本）；
  3. 入组卡上未选本机项目不能「加入」；预选规则按 §3.2，且不读 git、不按目录猜；
  4. offer 的 `project` 字段与兑换 grant 不符 → 判 failed，回执 failed，不写绑定；
  5. PM 建议卡：仅 owner 点「建」才调用中心，参数被改则 ask-check 拒绝。

### N5 · 网页：团队项目页

- 目标：团队面板「新建团队项目」表单、项目设置（改名 / 归档 / 成员 / 邀请 peer / 移出）、本机对应关系显示与「设置目录」「退出团队项目」按钮；
  侧栏「团队 · 全部 feature」按绑定列项目、用中心显示名。
- fileGlobs：`web/features/collab/shared-projects/**`、`web/lib/shared-projects*.ts`、`web/features/chat/components/team-group.tsx`
- 规格例外：无（`team-panel.tsx` 不改；新入口以 `shared-projects/` 内组件挂在 `team-group.tsx`）。
- 验收线：
  1. 建项目、改名、邀请、移出、设置目录、退出全部是按钮 / 表单，界面上没有任何需复制执行的命令；
  2. 非团队 owner 看不到或灰显建项目按钮，非项目 owner 看不到邀请 / 移出；
  3. 409 冲突展示当前值并可一键重试；
  4. 界面不显示入组码、bearer、中心响应原文；
  5. PM 截图验收：建项目 → 邀请 → 对方入组后侧栏出现该项目。

### N6 · 迁移核对（本机）

- 目标：§5.2 的「共享项目核对」：启动 / 入组后只读判定，异常开卡（复用 N4 卡组件的数据形态，但卡逻辑在本节点文件里），点选后锁内备份并改写 bindings、读回核对。
- fileGlobs：`src/lib/shared-ledger-project-audit*.ts`、`src/bridge/shared-ledger-project-audit*.ts`、`tests/shared-ledger-project-audit*.test.ts`
- 规格例外：`src/bridge/ask-entry.ts` 只追加一行启动钩子；写绑定调用 N2 导出的 `setSharedLedgerBinding`（不改其文件）。
- 验收线：
  1. 正常、悬空、重复、个人、有凭据无绑定五种状态各有测试，正常状态不开卡；
  2. 改写前生成 0600 备份，凭据文件全程字节不变；
  3. 卡过期 / 忽略时绑定不变，下次启动再提示且不重复开同一张卡（dedupKey）；
  4. 模拟 HedeMacBook-Pro / Sekai 现状（本机 `claudestra`、绑定指向不存在的 `claude-orchestrator`）→ 卡预选 `claudestra`，点确认后侧栏可见团队 feature；
  5. 模拟本机（owner 机器）现状 → 不开卡。

### 节点文件范围两两不重叠核对

N1 只在 `src/shared-ledger/`、`src/lib/shared-ledger-contract-v2-projects*`（中心 `src/shared-ledger/join.ts` 不改）；N2 在绑定 / join / project-link / join CLI；N3 只在 `shared-ledger-client*`；
N4 在 bridge local-api 新文件与 join-offer 三件；N5 只在 `web/`；N6 只在 `*project-audit*`。热点文件已列为规格例外并限定为追加一行。
测试文件同样分开：`tests/shared-ledger-join-offer*` 归 N4，`tests/shared-ledger-join-{cmd,e2e,harden,center}` 归 N2，其余各节点用新前缀。

## 7. 需要 owner 拍板的点（均有默认，不阻塞实施）

1. 本机对应关系是否放进 projects.json——默认**不放**，保持 bindings 单一来源（§1.3）。
2. 入组卡默认选项——默认「新建本地项目」，有同名未绑定项目时预选「绑定已有」（§3.2）。
3. 中心 id `claude-orchestrator` 是否改名——默认**不改**，只改显示名（§5.1）。
4. PM 能否直接建项目——默认**不能**，只能开建议卡（§2）。
