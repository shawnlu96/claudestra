# i28-PRJ1 · 共享项目中心化：团队在中心建项目，成员加入

状态：设计稿，specRev 1，第 2 轮审查后修订（保留首轮修复；补 owner-bootstrap / creator-credential / deploy-routes / mutation-ownership）；代码核对基线 `2bb679d3`。只出设计，不改代码。
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
新表 `project_invites(codeId PRIMARY KEY → join_codes.id, teamId, projectId, personId)`：把 `/invites` 铸的码和 `project_members` 行连起来，
兑换时据此在同一事务里把成员置 active（`join_codes` 行格式冻结不动，做法同现有 `join_issued_credentials`）。

**团队 owner 只来自明确记录**：`teamRole = owner` 只能由 (a) §5.1 的「确认团队 owner」按钮或 (b) 已有团队 owner 通过 API 指定 写入；
**任何凭据 grant（尤其 `service` 角色的 `project` / `import` 动作）都不推导、不提升 teamRole 或项目 role**。
`project` 动作只表示「可上传主场投影」，是限定项目的服务授权（shared-ledger.md §4：服务身份不能扩大授权）。

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
- 创建与本机可用性是两阶段：中心提交后先完成 §2.1 创建者凭据兑换和保存，再走 §3.2 绑定卡；表单已选本机项目时也必须等凭据落盘后才写绑定。
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
| `POST /v1/team/owners` | 增减团队 owner `{personId, op}`（不能移除最后一个） | teamRole=owner |

`/invites` 返回的码只进 bridge 内存，立即走 JN3 offer 发给 peer，不落 owner 机器磁盘、不进网页、不进日志（沿用 JN1/JN3 的码纪律）。

### 2.1 创建者凭据与恢复（creator-credential）

创建请求带稳定 `operationId`，中心以团队、创建人、operationId 去重，参数摘要不同则 409。
建 B 的事务同时写创建者 owner 成员行和一份限定 B、绑定本人实例的创建者兑换码记录（复用 JN1 / project_invites），
响应只给调用方 bridge；旧项目 A 的凭据不追加 grant、不替换。中心业务权限从 teamRole / project_members 核验，不能把 owner 塞成 service grant。
bridge 用本实例签名兑换 `/v1/join`，核对 center/team/project/person/instance 后，按项目追加 B 的 person 凭据到 0600 文件，原 A 条目保持不变；
读回确认后再建或绑本地项目，最后用实际 gate proxy 读取 B 的 feature 列表，成功才显示「项目已可用」。码和 bearer 不进网页、事件或日志。

失败恢复全部由「继续完成项目」按钮执行：创建响应丢失按 operationId 查询本人操作结果，不重复建 B；
兑换前失败可重试未使用码，码过期则中心吊销旧码、在相同操作下重发；兑换响应丢失或凭据落盘失败时，
中心不重显旧 bearer，由同一创建人和实例签名请求重发兑换码、吊销该操作的旧 B 凭据后重新兑换。
重发不改 A 或其他成员凭据；并发重发串行核操作版本，过时请求拒绝。本机保存失败不写绑定，显示「中心项目已建，本机待完成」；
绑定失败保留已保存的 B 凭据，§5.2 的有凭据无绑定卡继续完成，不删除中心项目、不中断 A。
此重发只用于创建者操作恢复，N1/N3/N4 实现专用 `POST /v1/projects/:id/creator-credential` 与 `GET /v1/projects/operations/:operationId` 本人操作状态查询契约，
恢复接口核原 A person 凭据、创建人和实例及当前成员/owner 状态，不要求已持 B 凭据；跨人/跨实例/已撤权均拒绝，查询不返回 bearer。
不是通用 grant 刷新。shared-ledger-v2 的本人/服务隔离保持；SYNC1 只消费绑定后的身份做同步，不负责签发凭据或扩大权限。

## 3. 成员加入

### 3.1 流程（全部按钮）

1. 项目 owner 在项目页点「邀请成员」，在已握手的 peer 列表里选一台（可多选），可附一句话。
2. owner 机器 bridge：`POST /v1/projects/:id/invites` 拿码 → 按 JN3 `POST /api/v1/shared-ledger-join-offer` 递给对方 bridge。
   offer 体新增非机密字段 `project: {teamId, projectId, name}`，**只用于卡面显示和预选**，兑换后以中心 grant 为准，不一致即判失败。
3. 对方 bridge 开授权卡「加入团队项目 Claudestra？」，卡上就是本机项目选择（见 3.2）。owner 点「加入」。
4. 对方 bridge：兑换码（JN1，实例私钥签名）→ 中心在**同一个兑换事务**里登记凭据、标码已用、按 `project_invites` 把 `project_members` 从 invited 置 active
   （任一步失败整体回滚，码不算用掉）→ 本机写凭据 → 按卡上选择新建或绑定本地项目 → 写绑定 → 回执给邀请方。
   中心兑换代码（`src/shared-ledger/join.ts`、`identity.ts`）的改动归 N1（§6）。
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
| `shared-ledger-bindings.json` | **保留，加不变式** | 唯一的对应关系来源；加 `(centerId,teamId,projectId)` 唯一；写入拒绝个人项目；改绑只走带旧值核对的替换操作（§5.2） |
| `shared-ledger-join` 不带 `--project` 时绑到同名 id | **弃用该默认** | 改为必须带明确本机项目（由卡给出）；CLI 不带则报错要求选择 |
| `manager shared-ledger-join` / `shared-ledger-offer` CLI | **保留为系统内部 / 运维兜底** | 不出现在任何人需要操作的步骤里 |
| `shared-ledger-admin invite`（离线脚本） | **保留为运维兜底**，日常由 `POST /v1/projects/:id/invites` 取代 | 首个团队 owner 由部署 owner 授权的成员网页按钮与中心受控执行通道引导（见 §5.1），不由脚本推导 |
| 本机 `project-add` | **保留** | 只建本机项目（个人或本地）；不再有「本机建项目后推到中心」 |
| 本机 `project-assign` / `project-merge` / `project-edit` | **保留** | 只管 agent→本机项目、目录；合并 / 删除一个已绑定项目时先拒绝，提示先「退出团队项目」 |
| 导入（`import prepare/commit/activate`） | **保留，前置条件改变** | 只能导入到**已在中心存在**、且本机已绑定的项目；不再借导入隐式创建中心项目 |
| 个人项目 | **保留规则** | 永不外借、永不上中心：不能绑定、不能发起建中心项目、不能被导入 |

## 5. 迁移

### 5.1 中心（一次，随中心版本升级自动跑）

中心 schema v4 迁移（事务内、幂等）：
1. `projects` 加 `name/createdBy/createdAt/updatedAt/status/rev`，全部 `ALTER TABLE … ADD COLUMN` 带常量默认值（`status` 默认 active、`rev` 默认 1、
   时间默认 0；`createdBy` 可空）；现有行：`name = code`，`createdBy = NULL`（历史项目没有可核验的创建人，不猜）。
2. 建 `project_members`、`project_invites`，从**已用且未吊销**的 `join_codes` 和**未过期、未吊销、成员 active** 的 `credentials.grants` 回填
   `(person, project, member, active)`。回填只给 `member` 角色，**不因 grant 的 role/actions 给 owner**。
3. `members` 加 `teamRole`（默认 member）。**迁移不回填任何 owner**：现有中心没有明确的团队 / 项目 owner 记录
   （入组只发 member / service，见 `join.ts` 的 `ROLE_ACTIONS`；`shared-ledger-admin invite` 也只发这两种），
   而 service grant 的 `project` / `import` 动作是限定项目的服务委托，不是 owner 证明，所以不能拿它推导。
   迁移后每个团队都处于「团队 owner 待确认」：建项目、邀请、改名、移出按钮置灰，读写 / 导入 / 投影等现有功能不受影响。
4. **既有写入者同版本改为显式列名**（与本迁移同一 PR，N1）：`identity.ts` 的 `registerCredential` 现在是
   `INSERT … INTO projects VALUES (?,?,?)`、`INTO members VALUES (?,?,?,?)`，加列后会报列数不符。改为：
   - `INSERT OR IGNORE INTO projects(teamId,id,code,name) VALUES (?,?,?,?)`（其余列走默认值；v4 起正常路径的码都指向已存在项目，
     只有离线 `shared-ledger-admin invite` 运维兜底还可能新建行，新行同样 `createdBy = NULL`）；
   - members 由 `INSERT OR REPLACE … VALUES` 改为 `INSERT … (teamId,personId,code,status) … ON CONFLICT(teamId,personId) DO UPDATE SET code/status`
     （`preserveMember` 时 `DO NOTHING`），**不触碰 `teamRole`**——否则 REPLACE 会把已确认的 owner 冲回 member。
   - `join.ts` 的兑换事务里追加 `project_invites` → `project_members.active` 更新（§3.1 第 4 步）。
   - 全仓核对：`projects` / `members` 的写入者只有 `identity.ts` 与 `shared-ledger-member-admin.ts`（后者是带列名的 `UPDATE … SET status`，不受影响）。
5. 不改任何 projectId、featureId、凭据哈希；现有 bearer 全部继续有效。

**确认团队 owner（owner-bootstrap，一次性引导，按钮）**：
- 不要求中心运行 bridge/网页，也不要求中心持本机 person 凭据。入口在获部署管理授权的 owner 成员机器网页；
  普通 peer、本机 owner 自报、service grant 均不能获得引导权限。
- 信任根是中心部署 owner 明确批准的部署管理通道（既有受控 SSH/系统执行器，不是 peer token）。
  系统先只读预检中心身份、团队、owner 数、目标 person 成员 active 状态与完整实例公钥；
  owner 在卡上核对并授权 `centerId + teamId + personId + instanceKeyDigest + operationId + expiry` 及预检摘要。
  参数漂移/过期/拒绝均不执行；部署管理通道未配置则显示「需部署 owner 配置执行通道」授权卡，系统完成后重开预检卡，不让人跑命令。
- 目标 person 取批准机器的有效 `owner:self` kind=person 中心凭据，并以实例签名证明持有；不取 service 凭据。
  若该机器也没有 person 凭据，部署 owner 点「登记本人并确认」：系统经同一受控通道在中心登记目标 person/实例并铸限定历史项目的 JN1 码，
  bridge 兑换、保存 person 凭据后才允许确认 owner。此初始登记不依赖项目 owner 的 `/invites`，因此不形成先入组/先有 owner 的循环。
- 系统经部署通道调用中心离线嵌入接口 `confirmTeamOwner`（与 admin 同一嵌入路径），立即事务复核授权摘要、有效期、
  团队 owner 数仍为 0、目标 person active、本人签名与已登记实例公钥一致；通过才写 teamRole=owner、
  将该人已有 active 项目 role 设为 owner 并写不含秘密的审计事件。没有新增无现任 owner 可调用的 HTTP 提权路由。
- 同机中心也走上述受控嵌入路径；独立 Linux 中心只需 API/离线执行器，无需安装 bridge 或保存成员 bearer。
  无通道/签名错误/目标非 active/只有 service 身份/并发已有 owner → 拒绝且角色不写；初始登记或落盘失败保留待完成状态，系统按钮经受控通道查询操作，再重发一次性码；丢兑换响应则只吊销该引导操作新发凭据后重兑，不覆盖历史凭据。
  执行回执丢失先按 operationId 经受控通道查询事件；同参数已成功则显示完成，不再次提升；参数不同拒绝。
- 之后增减 owner 只能由现任团队 owner 经 `POST /v1/team/owners`，引导关闭。部署通道能力属于机器基建授权，不能由 agent 代批。
  shared-ledger-v2 的显式本人身份、实例绑定、服务不能扩大授权保持；SYNC1 不登记 owner、不以同步凭据推导角色。

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
- owner 点选后，系统调用 N2 新增的**替换操作** `replaceSharedLedgerBindings({ expected, next })`（不用普通 `setSharedLedgerBinding`）：
  - `expected` = 开卡时读到的、与该中心项目 `(centerId,teamId,projectId)` 相关的全部绑定行（含悬空 / 重复 / 个人行），卡上带其摘要作版本；
  - `next` = owner 选定的那一行（已有本机项目，或「新建」后得到的本机 id）；
  - 在同一把 bindings 锁内：备份为 `shared-ledger-bindings.json.bak-<时间>`（0600）→ 重读并核对当前相关行与 `expected` 逐字相同（不同 = 卡已过时，拒绝、不写，
    下次核对重开卡）→ 删掉该中心项目的全部旧行 → 校验 `next`（目标本机项目存在、非个人、未绑别的中心项目）→ 写入 → 释放锁后读回核对。
  - 普通新增 `setSharedLedgerBinding` 保持拒绝冲突（同一中心项目已有绑定即拒绝）；只有带 `expected` 的替换能改掉旧映射。
  - **凭据文件不碰**。

三台机器各自会发生什么：

| 机器 | 现状（预期） | 升级后发生的事 |
|---|---|---|
| 本机（owner 成员机器，中心可独立部署） | 正确绑定；持 person + service 凭据 | 正常绑定不开核对卡；获部署管理授权后按 §5.1 确认团队 owner，再点按钮改显示名 |
| peer A | 本机 `claudestra`；可能绑到不存在的 `claude-orchestrator` | JN4 已修则不开卡；否则卡预选 `claudestra`，确认后原子替换悬空绑定、凭据保留；无部署管理授权不出现引导按钮 |
| peer B | 同 peer A | 同上 |

不丢东西的保证：绑定核对对凭据文件全程只读；owner 引导若需登记本人，仅追加对应 person 凭据、不覆盖现有条目；bindings 只在 owner 点选后经带旧值核对的替换操作改、改前备份；中心不改任何 id；本机 projects.json 只在选「新建」时追加一项。
核对卡被忽略或过期 = 什么都不变（与今天一样），下次启动再提示。

## 6. 拆分（可并行的 PR 节点）

依赖：节点之间只通过本文 §2、§3、§5 写定的接口对接，可同时开工；N4、N5 的端到端验收在 N1–N3 合并后补跑。
**规格例外（热点文件）**：下列文件允许多个节点改，但每个节点只能**追加一处注册行**、不改已有行：
`src/shared-ledger/server.ts`（路由表，仅 N1）、`src/bridge/api-routes.ts`（N4 一行）、`src/bridge/ask-entry.ts`（N6 一行启动钩子）。

### N1 · 中心项目记录与成员 API

- 目标：中心 schema v4（§5.1）；**既有写入者显式列名**（`registerCredential`）与兑换事务内 `project_invites → project_members.active`；
  `GET/POST/PATCH /v1/projects`、成员列表、`/invites`、移出、`POST /v1/team/owners`；团队 owner 引导的离线嵌入接口 `confirmTeamOwner`、初始本人登记及操作查询；创建者 B 凭据签发/重发与幂等操作查询；
  teamRole 与 project role 权限检查；契约与 fixture。
- fileGlobs：`src/shared-ledger/projects*.ts`、`src/shared-ledger/migrations.ts`、`src/shared-ledger/identity.ts`、`src/shared-ledger/join.ts`、
  `src/lib/shared-ledger-contract-v2-projects*.ts`、`tests/shared-ledger-center-projects*.test.ts`、`tests/shared-ledger-join-center.test.ts`（已有）、
  `deploy/shared-ledger/remote.sh`、`deploy/shared-ledger/README.md`、`tests/shared-ledger-deploy.test.ts`（§8 配套部署）
- 规格例外：`src/shared-ledger/server.ts` 只追加路由注册。
- 验收线：
  1. v3 库升级到 v4 幂等，已有 projectId / 凭据 / features 不变，现有 bearer 读写全部通过；
  2. 非团队 owner 建项目 403，非项目 owner 邀请 / 改名 / 移出 403，改名 rev 冲突 409 带当前值；
  3. `/invites` 码只出现在响应体，日志、事件、错误文本不含码（测试断言）；
  4. 迁移后所有团队 `teamRole` 均为 member、`createdBy` 为空；负例：团队里**唯一**持 `project`（或 `import`）动作 service grant 的 person 迁移后仍是 member、
     建项目 403；历史上过期 / 吊销 / 成员 removed 的 grant 不回填 `project_members`；
  5. 移出项目后该 person 对该项目的读写立即 403，对同团队其他项目不受影响；
  6. **升级后真实兑换回归**：v3 库（含已有成员与项目）迁到 v4 后，(a) 新 person 用 `/invites` 码兑换成功、`project_members` 同事务变 active；
     (b) 已有成员兑换第二个项目的码成功，原 `teamRole`（含 owner）与旧凭据不变；(c) 兑换中途失败（如签名错）则码未用、成员仍 invited；
     (d) 离线 `shared-ledger-admin invite` 兑换仍可用。直接对 v4 库 prepare `registerCredential` 的全部语句不报错；
  7. `confirmTeamOwner`：团队已有 owner、person 非 active、实例公钥不符、传入 service 身份 → 均拒绝且不写；成功后该人已有项目 role=owner、写事件；
     不存在任何 HTTP 路由能在无现任 owner 时写 teamRole；独立中心无 bridge/成员 bearer 时，经 owner 批准的受控通道登记本人再确认可完成，service grant 不参与提权。
  8. 仅持 A person 凭据的 owner 创建 B、兑换 B 后实际读取 B 成功，A 凭据仍可用；创建/兑换响应丢失、落盘失败、码过期、并发重发均可按 §2.1 恢复且不重复建项目。

### N2 · 本机绑定模型与入组兑换

- 目标：bindings 加 `(centerId,teamId,projectId)` 唯一与个人项目拒绝；新增带旧值核对的原子替换 `replaceSharedLedgerBindings({expected, next})`（§5.2，供 N6 调用）；`joinSharedLedger` 必须传明确的本机项目或 `create` 指令（新建本地项目 id/名默认值逻辑）；
  本机 edit/merge/remove 在写前共用绑定约束检查（包括目录改为伞形根、merge 两端及继承 personal 的结果），拒绝后不写 projects/agents/bindings；
  join 结果核对中心 grant 与 offer 显示字段一致；`shared-ledger-join` CLI 去掉「默认同名」。
- fileGlobs：`src/lib/shared-ledger-gate-bindings.ts`、`src/lib/shared-ledger-gate-proxy-join-pins.ts`、`src/lib/shared-ledger-join.ts`、
  `src/lib/shared-ledger-project-link*.ts`（新：建/绑与修改约束）、`src/manager/projects.ts`、`tests/shared-ledger-project-mutation*.test.ts`、`src/manager/shared-ledger-join-cmd.ts`、
  `tests/shared-ledger-project-link*.test.ts`、
  `tests/shared-ledger-gate-bindings-replace*.test.ts`、`tests/shared-ledger-join-{cmd,e2e,harden}.test.ts`（已有，改默认后要跟着改；`-center` 归 N1）
- 规格例外：无；N2 独占 `src/manager/projects.ts`，edit/merge/remove 只加薄调用到 project-link；新建通过现有 `writeProjects`，不改 lib/projects.ts。
- 验收线：
  1. 绑定个人项目、同一中心项目绑第二个本机项目、本机项目绑第二个中心项目均拒绝且不写盘；
  2. 未指定本机项目时 join 报错且不兑换码；
  3. 选「新建」时生成 id 撞名加后缀、显示名取中心名、dirs 为空，不是个人项目；
  4. 兑换后 grant 的 projectId 与 offer 显示的不一致 → 不写凭据不写绑定；
  5. 现有凭据文件在所有失败路径下字节不变；
  6. 替换操作：初态 `{claude-orchestrator→claude-orchestrator(不存在)}`，`expected` 为该行、`next` 为 `→claudestra` → 成功，结果只剩新行、备份 0600 且内容等于初态；
     重复绑定（同一中心项目两行）同样收敛为一行；`expected` 与盘上不符、`next` 指向个人项目 / 不存在项目 / 已绑别的中心项目 → 拒绝且文件字节不变；
     普通 `setSharedLedgerBinding` 对同一中心项目第二个本机项目仍拒绝。
  7. 已绑定项目 edit 成 personal/伞形目录、merge 任一端已绑定或结果继承 personal、remove 已绑定项目均拒绝，相关文件字节不变；退出解除绑定后可正常修改。

### N3 · 中心项目客户端

- 目标：`SharedLedgerClient` 增加 projects 列表 / 建 / 改 / 成员 / 邀请 / 移出方法，创建者凭据恢复/操作查询方法，按 N1 契约校验响应；错误文本固定、不回显响应体。
- fileGlobs：`src/lib/shared-ledger-client*.ts`、`tests/shared-ledger-client-projects*.test.ts`
- 规格例外：无。
- 验收线：
  1. 每个方法签名用 owner:self person 凭据，按 N1 契约 fixture 往返通过；
  2. `invites` 返回的码只作为返回值，不进任何日志 / 异常文本（测试断言）；
  3. 409 返回当前值供 UI 显示；403/404 固定文案。

### N4 · bridge 侧：建项目、邀请、入组卡

- 目标：本机 local-api `POST /api/v1/shared-projects`（建）、`PATCH …/:id`、`POST …/:id/invite {peers[], note}`、`GET …`（含本机绑定 join 视图）；
  邀请 = 调 N3 拿码 → JN3 offer（加 `project` 字段）；入组卡改为 §3.2 单选（新建 / 已有项目），点「加入」后用 N2 执行；PM 建议建项目的 authorize 卡；
  §5.1 部署 owner 引导卡与受控系统执行（不在 lib 导入中心代码），创建者凭据完成/恢复卡；personId 只取核验过的本人身份。
- fileGlobs：`src/bridge/local-api/shared-projects*.ts`、`src/bridge/shared-ledger-join-offer.ts`、`src/bridge/local-api/shared-ledger-join-offer.ts`、
  `src/lib/shared-ledger-join-offer.ts`、`src/manager/shared-ledger-offer.ts`、`tests/shared-ledger-join-offer*.test.ts`（已有）、`tests/shared-projects-api*.test.ts`
- 规格例外：`src/bridge/api-routes.ts` 只追加一行路由注册。
- 验收线：
  1. 只有全权管理凭据（owner）能调这些端点，guest / peer 403；
  2. 码从中心响应到 offer 请求体全程不落盘、不进日志与卡面（测试扫描日志 / 卡文本）；
  3. 入组卡上未选本机项目不能「加入」；预选规则按 §3.2，且不读 git、不按目录猜；
  4. offer 的 `project` 字段与兑换 grant 不符 → 判 failed，回执 failed，不写绑定；
  5. PM 建议卡：仅 owner 点「建」才调用中心，参数被改则 ask-check 拒绝；
  6. 团队 owner 确认：未获部署管理授权、团队已有 owner、以 service 请求提升 → 403；卡上 team/person/实例/摘要被改 → ask-check 拒绝；独立中心不装 bridge 也可完成首个 owner 引导。
  7. 创建 B 后必须保存 B 凭据并经 gate proxy 实读成功才报可用；故障显示继续完成按钮，A 凭据不变。

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
- 规格例外：`src/bridge/ask-entry.ts` 只追加一行启动钩子；改绑**只**调用 N2 导出的 `replaceSharedLedgerBindings`（不改其文件、不直接写 bindings、不用普通 setter）。
- 验收线：
  1. 正常、悬空、重复、个人、有凭据无绑定五种状态各有测试，正常状态不开卡；
  2. 改写前生成 0600 备份，凭据文件全程字节不变；
  3. 卡过期 / 忽略时绑定不变，下次启动再提示且不重复开同一张卡（dedupKey）；
  4. 模拟 peer A / peer B 现状（本机 `claudestra`、绑定指向不存在的 `claude-orchestrator`）→ 卡预选 `claudestra`，点确认后经替换操作
     bindings 只剩 `claude-orchestrator→claudestra`、侧栏可见团队 feature；开卡后 bindings 被他人改动 → 点确认被拒、不写、重新开卡；
  5. 模拟本机（owner 成员机器）正常绑定 → 不开绑定核对卡；引导卡由 N4 单独负责。

### 节点文件范围两两不重叠核对

N1 在 §8 的部署模板与独立部署测试、`src/shared-ledger/`（含 `identity.ts`、`join.ts` 两个既有写入者）、
  `src/lib/shared-ledger-contract-v2-projects*`；
N2 在本机绑定（含替换操作）/ 本机 join / project-link / join CLI / manager/projects.ts 修改入口；N3 只在 `shared-ledger-client*`；
N4 在 bridge local-api 新文件与 join-offer 三件；N5 只在 `web/`；N6 只在 `*project-audit*`。热点文件已列为规格例外并限定为追加一行。
测试文件同样分开：`tests/shared-ledger-join-offer*` 归 N4，`tests/shared-ledger-join-center` 归 N1，`tests/shared-ledger-join-{cmd,e2e,harden}` 归 N2，其余各节点用新前缀
（`shared-ledger-join-{cmd,e2e,harden}` 与 `-offer*` 字面不重叠）。N1 改 `join.ts` 不改其对外行为，N2 的 `harden` 测试照旧应通过。

## 7. 需要 owner 拍板的点（均有默认，不阻塞实施）

1. 本机对应关系是否放进 projects.json——默认**不放**，保持 bindings 单一来源（§1.3）。
2. 入组卡默认选项——默认「新建本地项目」，有同名未绑定项目时预选「绑定已有」（§3.2）。
3. 中心 id `claude-orchestrator` 是否改名——默认**不改**，只改显示名（§5.1）。
4. PM 能否直接建项目——默认**不能**，只能开建议卡（§2）。
5. 首个团队 owner 怎么定——默认部署 owner 在成员网页批准受控中心执行，点「确认我是团队 owner」按钮（§5.1）；不从任何服务凭据推导。

## 8. 配套部署交付（deploy-routes）

不增加第七个代码节点：N1 独占 `deploy/shared-ledger/remote.sh`、`deploy/shared-ledger/README.md` 与
`tests/shared-ledger-deploy.test.ts`，调整反代白名单并文档化部署 owner 引导执行器契约；N4 调用执行器接口，不改部署文件。
反代只放行 §2 的项目/成员/邀请/team owners 与 §2.1 本人操作查询和创建者恢复路径；HTTP 上没有 bootstrap 提权接口。
验收须从临时 HTTPS 反代入口真实请求：新路径到达处理器（合法成功、无权限 403，而非兜底 404），未知路径仍 404，
既有 features/commands/imports/projections/join 不退化，入组与创建者恢复限流、日志脱敏生效。
模板交付不等于部署授权：实际升级另开 owner 按钮部署单，先查服务/端口/TLS、复用现有设施，备份后更新并验证入口；失败保留旧配置，管理按钮显示不可用并可重试。
shared-ledger-v2 业务 API/权限语义不变；SYNC1 负责同步读写与投影，不负责反代部署、owner 引导或创建者凭据签发。
