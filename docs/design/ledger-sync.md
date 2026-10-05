# 台账同步：中心一份、本机一份、一直同步

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

本稿只出设计，不改代码、不改 [shared-ledger-v2.md](shared-ledger-v2.md)（要改的写在 §4）。基线 a61fe524。
目标：每台机器都有一份可读、可离线写的台账副本，中心也有一份，两边持续同步；同时不丢掉 V2 已经立住的业务不变量（阶段 CAS、租约、授权、合并部署只做一次）。

**一句话结论**：不引入现成 CRDT 库。采用「**按项目同步流与来源分条的只增日志（G-Set）+ 版本向量增量同步 + 混合逻辑时钟（HLC）排序 + 本机物化视图**」承载可合并数据；阶段、租约、锁、意图、合并部署、授权等一律「**中心定序**」，本机只排队显示「待同步」，生效以中心回写为准。中心定序的结果本身也作为一个来源（`center`）的日志条目复制到各机，所以读永远读本机。

## 1. 算法选型

### 1.1 候选对比

所有数字取自 2026-10-03 当天的 npm registry 元数据（`registry.npmjs.org/<pkg>/latest` 的 `version`/`license`/`dist.unpackedSize`）和 GitHub API（`api.github.com/repos/<repo>` 与 releases）；体积是 npm **解包体积**，不是运行时内存。

| 候选 | 是什么 | 适用面 | 成熟度（出处） | 体积 | 许可证 | Bun/TS 可用性 | 现成 SQLite 方案 |
|---|---|---|---|---|---|---|---|
| cr-sqlite | SQLite 扩展，把表变成 CRR：行按主键并集，列级 LWW + 因果长度集（CLSet）删除，`crsql_changes` 虚表收发变更 | 关系表多主复制 | npm `@vlcn.io/crsqlite` 最新 0.16.3（2024-01-17）；GitHub 最新 release v0.16.3 同日；仓库仍有推送（2026-08）。README 自述计数器、富文本 CRDT「仍在实现」，「因果事件日志」是「v2 才实现」 | 12.2 MB（含预编译二进制） | 仓库 MIT；npm 包标 Apache 2 | 需 `Database.loadExtension`；**macOS 自带 SQLite 禁止加载扩展，须先 `Database.setCustomSQLite()` 指定 dylib**（Bun 文档） | 它本身就是 |
| Automerge | JSON 文档 CRDT，Rust 内核编译成 WASM | 单文档协作（富文本、嵌套对象） | `@automerge/automerge` 3.5.0（2026-09-16），活跃 | 47.5 MB | MIT | WASM，TS 类型齐 | 无官方 SQLite 存储；需要自己把文档二进制存 BLOB |
| Yjs | 文档 CRDT（Y.Map/Y.Array/Y.Text），生态大 | 实时协作编辑器 | `yjs` 13.6.33（2026-09-23），活跃 | 2.3 MB | MIT（仓库 LICENSE） | 纯 JS | 社区持久化 provider（如 y-op-sqlite），存的是 Y 更新而不是可查询的表 |
| Loro | 文档 CRDT（Fugue 文本、可移动列表/树、LWW Map），文本合并借鉴 Eg-walker | 富文本与结构化文档，历史回放 | `loro-crdt` 1.16.4（2026-09-30），活跃 | 20.8 MB | MIT | WASM，TS 类型齐 | 无；同样是文档二进制 |
| 自建事件日志复制 | 每个来源一条只增日志（G-Set），`(project, stream, origin, streamSeq)` 唯一；版本向量求差量；HLC 给跨来源全序；本机按规则物化成现表 | 「日志 + 物化视图」型业务库 | 算法均为经典结论：CRDT/G-Set/版本向量见 Shapiro 等 2011；HLC 见 Kulkarni 等 2014 | 0 依赖；预计新代码 < 1500 行 | 自有 | 原生 `bun:sqlite` | 现有 `events` 已带 `origin/originSeq` 且有唯一索引，`ledger-origin.ts` 注释写明「给以后同步到中心服务留位」 |
| （附）sqlite-sync | SQLite 扩展，CRDT 同步（CLSet、Delete-Wins、Add-Wins、G-Set、块级 LWW） | 关系表 | 1.2.0（2026-09-28），活跃 | — | **Elastic License 2.0（修改版），生产或托管使用要商业授权**（仓库 LICENSE.md/README） | 扩展，同 cr-sqlite 的 macOS 限制 | 它本身就是 |

出处：

- cr-sqlite：<https://github.com/vlcn-io/cr-sqlite>（README「Approach 1/2」「Notes」节）；建表兼容性检查源码 `core/rs/core/src/tableinfo.rs` 的 `is_table_compatible`。
- 因果长度集：Yu & Rostad 2020，DOI 10.1145/3380787.3393678。
- Bun 加载扩展：<https://bun.com/docs/runtime/sqlite>（`loadExtension`、`setCustomSQLite` 小节）。
- Automerge：<https://github.com/automerge/automerge>、<https://automerge.org/docs/hello/>。
- Yjs：<https://github.com/yjs/yjs>（README Providers 节）、<https://docs.yjs.dev/>。
- Loro：<https://github.com/loro-dev/loro>（README 特性列表与致谢节：Fugue 文本、Eg-walker 改编）。
- Eg-walker：Gentle & Kleppmann，「Collaborative Text Editing with Eg-walker: Better, Faster, Smaller」，<https://arxiv.org/abs/2409.14252>。
- Fugue：<https://arxiv.org/abs/2305.00583>。
- CRDT 综述与 G-Set、版本向量：Shapiro 等，INRIA RR-7687，<https://inria.hal.science/inria-00609399>。
- HLC：Kulkarni 等，「Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases」，<https://cse.buffalo.edu/tech-reports/2014-04.pdf>。
- sqlite-sync：<https://github.com/sqliteai/sqlite-sync>。

### 1.2 逐个结论

- **cr-sqlite：不采用。** ① 台账表结构直接不兼容：`is_table_compatible` 拒绝「主键之外还有唯一索引」「主键可空」「AUTOINCREMENT」的表。`events` 三条全中（`seq` AUTOINCREMENT、`dedupKey UNIQUE`、`events_origin_seq` 唯一索引）；`tasks.id TEXT PRIMARY KEY` 没写 NOT NULL，SQLite 里可空；`lend_orders_live`、`dag_proposals_pending` 这类**部分唯一索引恰恰是业务不变量**，要转成 CRR 就得先删掉。② 列级 LWW 正是 §2 反例 A 里会出错的语义。③ 最近一次发版在 2024-01，macOS 下还要换 SQLite 动态库，等于改整个进程的 SQLite。
- **Automerge / Yjs / Loro：不作为台账底座，不采用。** 它们合并的是「一份文档」，不是可查询的表：PM 和脚本要查卡阶段，就得先把文档物化成表，物化这一层还是要自己写；它们同样不保证业务不变量（§2）。体积 2–48 MB，换来的能力只有「长文本并发编辑」一项用得上。
- **Loro 是长文本合并的唯一候选，但第一期不引入。** 台账里会被两边同时编辑的长文本只有「规格草稿」。第一期草稿冲突按多值寄存器处理：两版都留，提示人挑。§7 原型量出并发编辑草稿的频率，超过 owner 定的门槛才另开节点接 Loro（选它而不选 Yjs/Automerge：MIT、Eg-walker 系的历史体积更小、活跃）。
- **sqlite-sync：不采用**，因为许可证（ELv2，生产要商业授权）与仓库公开 MIT 不兼容。
- **自建事件日志复制：采用。** 台账本来就是「只增事件 + 现状表」：`events` 有只增触发器、带 `origin/originSeq`；`dag_versions`/`dag_bindings` 不可改；现状表都带 `rev`。把「复制日志、本机物化」做成正式机制，比把现状表塞进通用 CRDT 改动小，也让每类字段的合并规则写在我们自己的代码里，可以审查。

### 1.3 采用方案的形状

- **来源（origin）**：每个本机副本一个，沿用 `ledger_instance.origin` 4 位前缀；中心自己是保留来源 `center`。
- **日志条目**：`(project, stream, origin, streamSeq, hlc, kind, target, payload, class, context)`。
  `stream ∈ {merge, ordered-result}`，每个 `(project, stream, origin)` 独立连续计数，从 1 起；与本机旧 `events.originSeq` 不同。
  dot = `(project, stream, origin, streamSeq)`；日志主键就是 dot。`local` 数据不分配同步序号，不进入同步日志。
  白名单与脱敏在分配序号前完成；白名单升级使用新的流世代并经快照初始化，不在既有流里过滤掉已编号条目。
  `context` 是逐写 MV 因果上下文（§2.1），不是传输游标；非 MV 写可为空。
- **HLC**：64 位，高 48 位物理毫秒、低 16 位逻辑计数，沿用 Kulkarni 算法 1/2。
  传输/持久化用固定 16 位小写十六进制字符串，解码与比较用 BigInt；不把 64 位值转成 JS Number 或有符号 SQLite INTEGER。
  中心在 push、历史导入、快照生成前核结构、非负值、整数位宽，以及 `physical ≤ min(centerNow + 60000, 2^48-1-86400000)`。
  centerNow 是中心受监控墙钟；来源提供的时间或 vv 不得覆盖它。中心自身时间异常时停止接收，不能放宽界限。
  超界条目返回 `hlc_out_of_bounds`，只进诊断隔离区，不进入规范日志/快照、不物化、不推进任何副本 HLC。
  已被来源编号的拒收条目不准静默删除或重写：仅冻结该来源项目流的接收前缀，其他流继续同步。
  恢复需中心发新流世代、以已接受前缀快照初始化，并把未接受的本地编辑作为新写重发；旧 dot 与原文保留审计。
  stream 身份包含 kind 与 generation；世代变更不复用旧游标，不能伪装成 seq 从头开始。
  中心通过已认证传输提供 admission 元数据（dot、内容摘要、接收时 centerNow、epoch）；
副本用 admission 的已认证 centerNow 核同一接收上界（含位宽安全界），不用副本当前时间重判日志合法性。
  admission 必须绑定项目/dot/摘要/epoch，校验后才用其中 centerNow；它不改副本可信时间锚。
  合法日志若超副本当前候选时间界，只进入持久化 clock-pending，不隔离、不冻结来源接收前缀；校时或时间推进后按标准算法观察。
  绕过中心的裸来源条目、无 admission 的快照或本机异常原文只能隔离，不能借历史重放把超界值注入时钟。
  合法且在界内的漂移条目仍按标准算法推进 HLC（不改 OS 墙钟），观察后的新写严格大于它，保持后写覆盖。
  来源分配 dot 前也核本地候选时间；离线参照最近认证中心时间加同一 boot 的单调经过时间，不直接信突然跳变的墙钟。
  跨 boot 失去可靠时间锚时，编辑先保存为未编号草稿，重连校时后再提交；不能假装这些草稿已经 LWW 生效。
  收和发共用标准 HLC 候选计算：先取 local/remote/可信 now 的最大 physical，再按相等分支算 logical；
  logical 超 65535 时向 physical 进位并归零。若候选只超出当前时间上界，而未超位宽安全上界，进入 clock-pending，
  不拒收已合法 admission、不告误警、不提交候选时钟，也不把待收内容物化为已观察值。
  暂缓新的 HLC/dot 分配，待可信单调时间走到 `candidatePhysical-60000` 后重新计算并原子提交，严格大于 remote；
  不能忙等，借现有事件循环定时重试。延期接收先持久化合法日志与待观察队列，传输进度和物化进度仍分开。
  在 `centerNow+60000, logical=65535` 边界，接收/发送进位均延期至少 1ms，再用同一收发算法重试；不直接赋值造后写时间。
  若候选超过不随时间增长的位宽安全上界，或可信时间锚失效，则拒绝分配/保持隔离并告警，不能无限等或回绕。
  收发的硬上界耗尽处理不改变此前合法日志；时间上界延期也不提前分配 seq，因此不制造新缺口。
  HLC 不用于租约/授权过期，仍由中心墙钟及 epoch 判定。全序 = `(hlc, origin, streamSeq)`。
- **版本向量**：`{project → stream → origin → 已连续持久化的最大 streamSeq}`；只交换获授权项目的向量。
  向量只能由本机已收到的连续条目或已验证快照推进，不能直接复制响应里的中心高水位。重复 dot 幂等。
  项目授权是整个项目同步流的权限；若要行级隐藏，必须建立独立授权流，不准在同一流内删掉条目后继续沿用向量。
- **物化**：本机按 §2 的规则把日志折叠成现有表名（`tasks`、`items`……），所以现有读代码和 `ledger show` 不用改。可合并字段按 `(hlc, origin, streamSeq)` 折叠；定序字段**只**认 `center` 来源的 `ordered-result` 条目。中心结果按项目流序号连续原子物化，缺口后先缓冲，不能乱序触发唯一约束。
- **中心**：既是一个来源（定序结果），也是中转（存全部来源的 `merge` 条目、向各机分发）。中心不需要懂业务合并，只按项目鉴权、按版本向量分发；定序命令的处理沿用 V2 的 X1/X2/X4/X5/X6/X14。

## 2. 哪些可以合并，哪些必须由中心定序

### 2.1 规则（两类）

**可合并（merge）**：本机先写、立刻生效，之后同步。规则只用这四种：

- **G-Set**：只增集合，按 dot 并集。用于事件、备注、评论、原话。
- **LWW 寄存器（按 HLC）**：同一字段取 `(hlc, origin, streamSeq)` 最大的那次写。只用于「后写覆盖前写不违反任何不变量」的单值字段，比如非唯一标题、一句话、优先级。
- **多值寄存器（MV）**：每次写入事务冻结已观察到的本项目因果上下文为 `context`，并产生新 dot。
  context 编码为各流连续前缀加缺口之上的已观察 dots 集合；包含已物化候选与本源前序写，不能只取传输连续 vv。
  若写 B 的 context 覆盖写 A 的 dot，B 覆盖 A；不可比则两个值都保留。HLC 只作展示排序，不能推导因果。
  物化保留所有未被任何已知写 context 覆盖的 dots（包括删除/挑选写的因果墓碑），乱序时迟到的被覆盖值不能复活。
  人工挑选先读当前全部候选，提交携带覆盖这些候选的 context 的新值；未观察到的新并发写仍保留，继续提示挑选。
  快照保留候选 dots 与已覆盖 context；压缩不能丢墓碑。跨项目不携带因果信息，避免泄露未授权流。
  用于规格草稿等长文本；传输请求 vv 的后续增长不会改动已存的逐写 context。
- **按键合并的 Map**：`extra` 这类 JSON 拆成命名键，每个键单独套上面的规则。

**中心定序（ordered）**：本机只发命令，**不在本机生效**。中心按到达顺序串行执行，每条命令带前置条件（期望 `rev`/`from` 阶段/`specRev`/`head`/`epoch`/`operationId`），满足就提交，并写一条 `center` 来源的结果条目，复制回各机；不满足就拒绝，返回当前值（沿用 V2 的 409 形状）。

**只留主场（local）**：不进日志，不出本机。

判断标准：如果两个副本离线各写一次、合并之后**会让某个业务不变量失效，或者某个外部动作做两次**，就归 ordered；只是显示内容变一下的，归 merge。

### 2.2 逐表逐字段

覆盖范围以本机台账 `.tables`（27 张）和建表 / 迁移代码（`src/lib/ledger-*-schema.ts`、`ledger-store.ts`、`ledger-steps.ts`、`lend-journal.ts`、`lend-peer-cooldown.ts`、`ledger-asks-schema.ts`）为准，另含迁移代码里有、本机 `.tables` 未见的 `lend_meta` 和迁移临时表 `asks_next`。中心自己的表（`src/shared-ledger/**`）是中心的实现，不属于本机副本，不在此表。

| 表 | 可合并字段（规则） | 中心定序字段 | 只留主场 |
|---|---|---|---|
| events | 仅 §2.2.1 备注/评论/原话白名单 G-Set，键为同步 dot；仅这些观察记录的 dedupKey 来源内唯一 | §2.2.1 所有业务状态/授权/幂等锁事件，中心跨来源业务键唯一；operationId 另做请求幂等 | `seq`（本机自增，只作本地游标）；`kind` 不在同步白名单里的事件 |
| items | `title`/`oneLine`/`next`/`priority`（LWW）；`ownerWords`（G-Set 追加，不覆盖）；`extra` 的备注类键（Map） | `status`（`done`/`dropped` 会影响下属卡调度） | — |
| tasks | `title`（LWW）；`extra` 的备注 / 标签类键（Map） | `stage`/`stageBefore`/`round`/`kind`/`agent`/`pm`/`assignee`/`assigneeKind`/`branch`/`pr`/`headSHA`/`spec`/`specRev`/`model`/`featureId`/`itemId`/`rev`；行的创建 | `extra` 里的本机路径类键 |
| meta | 展示类键（LWW） | `pms` 等授权名单键（要 owner 确认）、`autostart` 调度开关 | 本机目录类键（如 docs 目录） |
| task_deps | — | 整表（增删边、`cond`、`state`） | — |
| feature_deps | `note`（LWW） | 边的增删 | — |
| features | `ownerWords`（G-Set） | `title`（项目内唯一，中心定序改名）/`status`/`currentVersion`/`rev`；行的创建 | — |
| dag_versions | — | 整行（不可改；版本号唯一）。「DAG 节点描述」的修改不改版本行，写成可合并的节点备注 `(featureId, nodeKey)`（G-Set/LWW） | — |
| dag_proposals | 提案草稿（本机 MV，未提交前不同步） | 提交、批准、驳回、作废（同 feature 只能有一条 pending） | — |
| dag_bindings | — | 整表 | — |
| asks | 附在 ask 上的评论 / 补充说明（G-Set） | 业务 ask 的创建、`state`/`answer`/`bind`/`expiresAt`/`supersedes`/`assignee`（沿用 V2 X2） | `chatId`/`threadId`/`discordMessageIds`/`outboxMessageId`/`fromChannelId`；`source ∈ {auq, permission}` 的整行（V2：终端权限 / AUQ 不上中心） |
| task_steps | — | 整表（`state`/`verdict`/`headFrom`/`headTo`/`claims`/`verified`） | — |
| task_workflows | — | 整表（`mode` 切换会改调度行为） | — |
| scheduler_intents | — | 整表（V2 X5） | — |
| scheduler_resources | — | 整表（资源锁） | — |
| scheduler_merges | — | 整表（合并只能一次） | — |
| scheduler_deploys | — | `intentId`/`taskId`/`project`/`prRef`/`mergeSha`/`phase`/`rev`/`label`/`outcome`/`liveness`/`deployedAt`/`createdAt`/`updatedAt` | `receipt`/`reason` 原文（V2：原输出留执行端；中心只收摘要） |
| scheduler_sessions | — | — | 整表（V2：不迁会话） |
| scheduler_meta | — | — | 整表（本机调度器的租约 / 启动信息） |
| lend_orders | — | 其余全部列，含身份、head/specRev/repo/branch/base、leaseMs、receipt/reason、beat/beatAt、seenAt 和时间戳（V2 X6；只同步白名单摘要） | `wire`/`text` 原文（只同步 `sha256`） |
| lend_write_leases | — | 整表（写租约） | — |
| lend_push_queue | — | — | 整表（本机投递队列） |
| lend_peers | — | — | 整表（本机 bridge 观测到的对端容量 / 指纹） |
| lend_peer_cooldowns | — | — | 整表（本机观测） |
| lend_meta | — | — | 整表 |
| audit_findings | — | — | 整表（可以从同步过来的数据在本机重算，不同步） |
| audit_baseline | `since`（取最大值，单调） | — | — |
| ledger_instance | — | — | 整表（本机身份前缀，绝不能同步） |
| asks_next | — | — | 迁移中途的临时表，不是数据 |
| sqlite_sequence | — | — | SQLite 内部表 |

**全列默认规则（现有列穷尽，不能把未点名列理解为可合并）**：

- 整表 ordered/local 的行覆盖全部列；混合表先取上表显式规则，其余现有列全部 ordered。
  `items.rev/createdAt/updatedAt`、`features.createdBy/createdAt/updatedAt`、`tasks` 时间戳均因此是 ordered。
  merge 写不改权威 rev/updatedAt；另在同步元数据中派生展示时间，不能让 LWW 时钟充当 CAS rev。
- `events` 按 §2.2.1 先分整行 merge/ordered/local，各列随整行不可变；旧 origin/originSeq 只作历史标识，不能作新流游标。
  `audit_baseline.project/rule` 是不可变集合键，`since` 取最大。meta 的 project/key 是不可变键；未登记的 value 键 local，禁止同步。
- `items/tasks.extra`、asks.extra 未登记键默认 local；只有已登记备注键可合并，控制/授权键 ordered，路径键 local。
  上表未单列的 asks 业务列（包括 source/kind/title/context/body/options/allowText/kindHint/blocking/urgency、去重与身份列）全部 ordered。
  comments 和草稿是新日志对象，不擅自把已有 asks.body 或 dag_proposals.nodes 改成 MV。
- `scheduler_deploys` 中心一次事务更新 phase/outcome/liveness/deployedAt/rev，结果条目带完整行，副本原子物化。
  deployed 必须同时 success/dead，unknown 必须 dead；不逐列提交。receipt/reason 原文 local，只另传脱敏摘要。
- `lend_orders` 的 wire/text 原文 local，receipt/reason、repo/branch/base、beat 等 ordered 值仅允许公开仓库标识和脱敏结构摘要。
  绝对路径、凭据、原输出不入日志；摘要与原文分开存，不能用同步摘要覆盖主场原文。
  `lend-journal.ts` 的同名表属于独立执行端 journal，不是 ledger 的订单表，其全部列 local（含 settle/work/notices）。
- 未知新列/新表一律拒绝同步并报 schema 不兼容，不能自动套默认 ordered；SY0 必须先更新分类清单。
  本节默认规则只覆盖当前迁移已有列；迁移临时表与 sqlite_sequence 全列 local。

「规格正文」：已发布的 `specRev` 是不可变的批准副本（V2 X3），发布动作是定序写（会让在途订单失效）；未发布的草稿是 MV 合并。「owner 原话收件箱」= `items.ownerWords`/`features.ownerWords` 的 G-Set 追加加上 `note` 事件。

### 2.2.1 events 的权限与幂等键分类

先分类，再分配同步序号；规则只能匹配显式 kind/op/前缀和数据 schema，不推测「是否像锁」。
SY0 冻结枚举与 schema，任何未登记 op 都拒绝同步；控制前缀/op 行优先于观察例外；控制 kind 行显式排除已匹配的 import 观察例外。
AUQ/permission/秘密与路径先走本机敏感数据闸，不因匹配其他行而开放同步。

| 机械匹配 | 类别与规则 |
|---|---|
| key.startsWith(`autostart:`/`autostart-settle:`/`scheduler:`/`lend:`/`lend-`)，或 kind=`scheduler` | ordered：中心业务键唯一，结果只认 center |
| `(kind=feature, op=autostart_claim/autostart_settle)`，或 op=`new/stage/approve/dag_rewrite/dag_bind/autostart/claim/settle/authorize/lease/deploy/merge` | ordered：控制 op 枚举，按相应中心命令 schema 校验；不满足 schema 则拒绝 |
| kind=`note` 且 op 为空或 `comment/ownerWords/node-note`，非控制前缀，匹配纯观察 schema | merge：观察 schema 只容许文本与备注引用，不能带执行指令/授权/控制字段 |
| `(kind=note, key=import:log:/import:morning: 前缀, data.imported=true)` 或 `(kind=decision, key=import:inbox: 前缀, data.imported=true, data.transcribed=true, data.source=ownerInbox)` | merge：明确是历史转录原话/日志，不作为审批；data.status 仅历史标签，不触发阶段/ask 答复 |
| kind 在 `stage/item/task/meta/dep/deliver/review/deploy/verify/rollback/freeze/unfreeze/ask/ask_expire/ask_cancel/ask_reopen/assign_reopen/dispatch/escalate/step/accept/feature` 集合，或非上述 import 观察的 decision | ordered：控制 kind 完整枚举；只由匹配 schema 的中心命令生成结果 |
| AUQ/permission、本机会话、秘密或路径原文 | local：不分配同步序号 |
| 其余 kind/op/键组合 | local 留存且对同步返回 unknown_event_policy；先更新 SY0 枚举才能开放，不自动当 ordered 或 merge |

`task/item/feature/meta` 等业务审计必须从对应中心命令生成；SY0 把现有全部控制 op 映射到枚举，
未列入映射的控制 op 不能执行。不能因一个新 op 只写了「幂等」注释就通过鉴权。

**merge 去重的存储迁移**：保留 `events.dedupKey UNIQUE`，不直接把来源 raw key 插入这一列。
merge 的存储键为无歧义规范 JSON 元组 `['sync-merge-v1', project, origin, sourceDedupKey]`；没有 raw key 时用完整 dot。
ordered 继续保留原业务 key；拒绝业务 key 使用 merge 存储键的保留编码空间，避免两种命名空间碰撞。
来源 raw key 和 class 进入新增同步投影元数据；`toEvent`/导出展示 raw key，merge 的查询/去重走带 project/origin 的共享 helper。
已迁移项目的业务 `getEventByDedup` 只查 ordered 原键，不能把 merge 记录当授权事件；
未迁移 local 项目保持现有原键读法，但采用中心后不能再用历史 local 事件授予执行权。导入观察的读写改走 merge helper。
SY1 只提供可调用的迁移函数及内存/影子库夹具：生成命名空间键、保存旧 seq/dot 映射、核行数/索引及重建触发器。
真正的 `LEDGER_MIGRATIONS` 注册、schema 版本升级、`REQUIRED_COLUMNS` 接线由 SY7 在 ledger-store.ts 完成；
SY1 不改 ledger-store.ts，也不声称函数已自动应用于运行库。SY0 契约先声明新增的 `syncClass/sourceDedupKey` 投影列，
syncClass/sourceDedupKey 都是由已验证同步条目派生的不可变投影元数据，不是可由 PM 编辑的业务字段。
列分类夹具兼容旧 schema 与升级后 schema；未知新列仍失败，不能以宽松忽略把迁移漏列藏掉。
运行时不修改既有事件。不同来源同一 import hash 可各留一行；同来源同一 raw key 幂等，内容不一致报冲突。
中心业务锁仍用原业务键，不能统一来源命名空间化而放松全局幂等。恢复 off 也不反向取消已采用的存储编码。

中心保留 `(project, businessDedupKey)` 唯一约束；相同业务键、不同 operationId 返回已存在 claim/结果，
不能授予第二份执行权。claim 绑定获选执行器与中心租约/epoch；重复请求的另一执行器只收到 duplicate，不能复用赢家授权。副本里收到中心 claim 只是显示事实；每个执行 step 仍在线向中心事务核 claim/epoch/settle，
离线直接拒绝 claim/settle 与据此开卡，不能凭缓存 claim 执行。重试未知结果先查回执，不盲重放外部动作。
旧 `autostart-settle:<seq>`、eventSeq 等引用必须迁成中心稳定 claim dot/ID；本地 seq 只作查询别名；claim 归属与建卡因果检查改用中心绑定/结果序号，而非比较各副本自增 seq。

导入时保存映射并重写引用，不能跨机比较本地 seq 或沿用来源内锁键。历史 ordered 事件只作迁移证据，
由中心冻结导入事务重建规范结果与业务键索引；不能作为来源 merge 条目上传重新授予写权。

### 2.3 反例

**反例 A：合并后状态一致，但业务出错（所以 `stage` 和 `lend_orders` 归定序）。**
卡 T 在 `build`，`rev=7`。本机 1 离线，PM 让它 `build→review` 并给 T 开了一张出借审查单 O1；本机 2 同时离线，调度器也把 T 推进到 `review`，开了出借单 O2。按 LWW 合并，`stage` 两边都是 `review`，确实收敛了；`lend_orders` 按主键并集后有 O1、O2 两行，`lend_orders_live`（一卡一张活单）被违反。cr-sqlite 根本不允许建这条唯一索引。结果是两个借来的工位审同一个 head，算力花了两次，回写还会相互覆盖 verdict。换成合并，危害更大：`scheduler_merges` 两边各自 `merging`，同一个 PR 会被触发两次合并 / 部署。
同类：两边离线各加一条边 `A→B` 和 `B→A`，`task_deps` 并集后成环，而 DAG 无环是建图时核过的不变量；两边各自 `dag-rewrite` 出 `version=3`，主键冲突时 LWW 只留一份，另一份的 `dag_bindings` 就指向不存在的版本。

**反例 B：定序写离线排队后被中心拒绝。**
PM 在本机离线时执行 `stage T review→merge`（期望 `rev=9`、`from=review`、`head=abc`），本机把它放进待同步队列，显示「待同步」，`tasks.stage` 仍是 `review`。离线期间中心收到审查员的 `changes` verdict，已把 T 定序成 `fix`，`rev=10`。重连后队列提交，中心核 `from=review` 不成立，返回 409 和当前值 `{stage: fix, rev: 10, head: abc}`。本机把这条命令标记为「被拒」，不自动用 `rev=10` 重发（语义已经变了：当初要合并的版本已被审出问题），通知发起人（§3.3）。如果本机当初按乐观写已经把 `stage` 改成 `merge`，并据此开出合并意图，这个错误就已经产生外部副作用了，所以定序字段在本机只显示、不生效。

## 3. 本机副本怎么用

### 3.1 读

一律读本机副本（物化表 + 待同步覆盖层），离线也能读。每次读的结果都附带 `syncedAt`（最近一次成功和中心对齐的时间）和 `pending`（本机待同步条数）。离线超过阈值（默认 10 分钟，可配置）时，界面和 CLI 输出带「离线」标记，沿用 V2 §7「显示最近成功时间」。

### 3.2 可合并写

本机事务里同时写日志条目和可物化表，立即生效，然后推送。
目标行尚未被中心创建时，不造临时权威行、不丢条目：持久化日志及 pending-materialization 索引，标记依赖待到达。
接收向量表示日志持久化（可以推进），另记物化进度；收到中心建行结果或加载快照后，对该目标重折叠所有已存 merge 写，原子清理待物化索引。
重启扫描未处理依赖，重复投递幂等；无合法创建结果的目标保持 pending 并可诊断，不能声称视图已完全收敛。
物化函数先应用连续中心结构结果再折叠目标 merge 日志，所以传输分页顺序不是业务依赖顺序。冲突不需要人处理：LWW 和 G-Set 自动收敛；MV 字段出现并发值时留两版，标「待挑选」，挑选是一次新的可合并写。

### 3.3 定序写

1. 命令落本机 `sync_outbox`：`operationId`（稳定，沿用 V2 X5）、命令、前置条件、发起人、发起时间、来源 HLC。
2. 在线：同步发给中心，等回执（超时按 V2：先查回执，再决定 unknown，不盲重发）。
3. 离线：状态是「待同步」。界面和 `ledger show` 上这张卡显示「待同步：review→merge（发起人、时间）」，但权威字段不变。
   以下命令**离线直接拒绝、不排队**：授权 / 批准、合并、部署、发版、租约获取、出借派单（沿用 V2 §7「V2 派单 / 阶段 / 合并 / 发版停」）。可以排队的只有：阶段迁移申请、卡和事项的创建、feature 改名、改派、DAG 提案提交、业务 ask 创建。
4. 重连回放：按 outbox 顺序逐条提交，同一张卡上前一条被拒，后面所有依赖它的条目一起标记「被拒（前序失败）」，不再提交。
   中心只在命令声明 `replay: precondition` 时才接受，并且必须**原样**核前置条件，不替发起人把期望值改成新值。
5. 被拒：outbox 条目标记 `rejected`，带上中心当前值和拒绝原因码。通知发起人：发起人是 agent，就往它的频道发一条；发起人是人，就建一条本机 `owner_action` 提醒。CLI 下次运行开头打印。
   发起人可以「按当前状态重新发起」，这会生成新的 `operationId` 和新的前置条件，不复用旧的。
6. 待同步条目超过 24 小时（可配置）没交，就标记「过期」，不自动提交，等发起人确认。

### 3.4 同步协议

传输走现有共享台账服务（`src/shared-ledger/server.ts` 所在服务、经本人 bridge 代理），**不改 relay 协议 / 帧 / 版本**（V2 §6 禁区）。

- **推（push）**：`POST /sync/push {vv, entries[]}`，只推本来源的 `merge` 条目，每批不超过 500 条或 256 KB。中心核项目权限、白名单 `kind`、`class`，幂等落库，返回中心版本向量。本机写后 1 秒防抖推送。
- **拉（pull）**：`POST /sync/pull {vv, limit}` 返回 `{entries[], vv, more}`，覆盖所有来源（含 `center`）里本机缺的差量，按 `(project, stream, origin, streamSeq)` 分页；响应 vv 是中心高水位提示。
- **订阅**：`GET /sync/watch?vv=…`，长轮询或 SSE 都可以，有新条目时返回 `{changed: true}`，本机收到后发起 pull。订阅只是提示，不承载数据。保底每 30 秒拉一次，每 10 分钟做一次完整向量比对。
- **断线恢复**：分项目流版本向量就是断点，重连后从向量处继续，不需要额外的游标。某项目流来源的 `streamSeq` 不连续时，只把向量推进到连续处，并请求补这一段区间。中心发现某项目流来源序号倒退（备份恢复）时，按 V2 §7「序列倒退告警重建」：本机冻结该来源、整段重拉。
- **授权变化**：新增项目权限从该项目快照及向量初始化，旧项目向量不动；重新授权已撤销项目也重建，不复用残留游标。撤销时清掉该项目接收向量与快照元数据，拒绝旧授权世代请求；响应不暴露其他项目高水位。
- **定序命令**不走 push，走 V2 的命令端点（X7 客户端），结果以 `center` 条目经 pull 回来。
- **压缩**：`merge` 日志不删除；中心每天按项目做快照（物化表的导出 + 版本向量）。快照含流世代、MV context/墓碑；新机器先拉快照，再按向量补差量；条目超过 90 天且已进快照的，本机可以裁剪（中心保留）。

## 4. 和现有设计（shared-ledger-v2）的关系

### 4.1 原则层面的改动

| V2 原文 | 本稿 |
|---|---|
| §1「各机只读缓存」 | 改：各机是**可写副本**，但只有可合并字段能写；定序字段仍然只读 |
| §1「追加观测之外不搞多主事件合并或客户端时间最后写赢」 | 改：允许对 §2.2 白名单字段做多主合并，用 HLC 而不用客户端墙钟；白名单之外的仍然禁止 |
| §7「中心不可用……不自动排队」 | 改：§3.3 的可排队命令可以排队，但**显式显示、不生效、回放时原样核前置条件**；授权 / 合并 / 部署 / 发版 / 派单仍然离线拒绝（不变） |
| §1 中心单写、CAS、409 冲突、operationId、epoch、unknown 对账 | 保留，定序写就是它 |
| §4 安全、§5 租约与意图、§6 禁区 | 保留 |

### 4.2 X 系列逐张

- **保留不动**：X0（契约；同步 DTO 另放 SY0 的新文件，不改 X0 文件）、X1、X2、X3、X4、X5、X6、X8、X9、X11、X14。
- **保留，验收线追加一条，由 SY 节点承担，不改 X 卡文件**：
  - X7（执行客户端）：outbox 从「只存结果」扩到 §3.3 的可排队命令，由 SY3 实现，X7 只需要暴露命令提交接口（已有）。
  - X10（开卡 / 编辑界面）：「待同步 / 被拒 / 离线」标记由 SY9 提供组件。
  - X12（串接）：SY7 在 X12 之后接线（见 §8）。
  - X13（迁移）：迁入 execution 时，可合并字段不再收回本机写权。
  - X15（三实例演练）：增加「两副本离线各写再同步」一项，夹具由 SY6 提供。
- **作废**：无整张作废的卡。作废的是 V2 的一条约束：「已迁入共享规划的 feature 本机不能改图」，改为下一节的做法。

### 4.3 已迁入共享规划的 feature 怎么回到「本机也可写」

- 可合并字段（非唯一标题、一句话、原话、备注、节点备注、评论）：本机直接写，不管 feature 在 source/planning/execution 哪一档。
- 图（`task_deps`、`dag_*`）：本机可以离线编辑 DAG 提案草稿，提交是定序写（同 feature 只能有一条 pending），批准仍然由 owner 走 V2 X2。所以「本机能改图」是指「本机能起草、能离线排队提交」，不是本机直接生效。
- 阶段等执行字段：同 §3.3。

### 4.4 迁移步骤与回退开关

开关 `ledgerSync.mode = off | observe | on` 按项目设置，但**同步显示模式不决定执行权威**。
另有中心持久化的 `authority=local|center` 与单调 authorityEpoch；一旦采用 center，本机任意模式都不能恢复本地定序权。
本机把权威/epoch、项目身份和存储世代写入独立的 `<state-root>/ledger-authority/<project>.json`，不存进 ledger.sqlite。
**存量首次升级 preflight（SY7）**：只允许原安装的受控升级，不是「缺 complete 就初始化」。
升级锁内冻结旧写；原安装在任何备份恢复之前签发一次性 upgrade-session（绑定安装随机身份、项目身份、库世代），
仅留在当前升级进程/其库外 prepared journal；数据库、项目登记、旧 schema 版本都不能签发或重建该凭据。
签发入口仅由正在运行的原安装升级握手调用，不能从新进程读取旧库推断；恢复/导入/新机启动入口不调用它。
仅见旧版本文件、旧 schema 或旧登记而没有原进程握手，来源无法确认，拒绝签发并按 unknown 处理。
恢复命令必须在启动 ledger 入口之前进入 recovery 状态；不能先让旧库按首次升级开放写再核身份。
清单来自该受控升级冻结的本机项目注册/共享规划登记：明确 never-shared 的存量项目写 local 标记，
明确已共享的项目保留 center 标记或在线核中心；归属不清记 unknown，不因没有 marker 就推断 local。
在同一 prepared journal 中消费 upgrade-session，逐项 atomic JSON 落盘，全部有记录才提交 activation-complete；
新入口检查 complete 才运行。崩溃只允许凭原安装完整 prepared journal 续作，不能凭恢复数据库重造 prepared。
已有 center 标记绝不覆盖成 local；完成后销毁会话能力。schema 版本只作附加检查，旧备份也有旧版本，不能作为首次升级证明。
采用中心前先把 journal 的 everCenter 置 true（单调不可清），再写 center marker，二者落盘后中心才解除冻结。
标记、journal、安装身份均在库外，不进 ledger-backup；新项目创建命令生成新项目身份，不接管数据库中的既有身份。

**恢复路径与可用性取舍**：完整、未回滚的原安装 journal 尚在时，never-shared 项目可离线核 complete、
项目/世代、everCenter=false 及无 V2 共享登记，显式重建丢失 marker；不存在的中心不参与这条路径。
已采用 center 的项目、journal 丢失/回滚、库外状态整体恢复、新机器或只恢复旧 ledger-backup，均进入 unknown；
preflight 不运行，不签发 upgrade-session，不凭旧登记、local 标记、旧 schema 或导出的 journal 快照授予原身份执行权。
原项目继续只读，身份可确认的中心项目可排队并在线核中心 epoch 后恢复；不能把无中心响应当作 never-shared 证明。
never-shared 项目若也丢失完整安装证明，不能安全地离线恢复**同一项目身份**：旧备份无法证明备份之后未采用 center。
其离线灾备出口是 owner 显式 `recover-local --fork-new-project`：生成全新项目/安装身份，初始化全新 local 标记与 journal，
仅导入白名单备注/规格/原话作为新 merge 写；不复制阶段、租约、授权、outbox、调度意图、资源锁或执行动作。
旧项目仍 unknown，不改旧 center epoch，不把新项目注册为旧项目别名，也不重放旧合并/部署；新执行图须重新规划并取得新授权。
这不是原身份的自动恢复；命令展示身份改变及执行状态不继承，由 owner 确认。无中心的 local 项目仍有离线恢复工作资料的出口。
若要求同身份、同执行状态的无损灾备，必须保存原安装的完整未回滚状态；只有旧台账备份时不承诺这一能力。

本地入口启动及每次定序写检查标记与恢复状态，不只检查 mode。缺失、损坏、身份/世代不匹配均拒本地执行。
台账恢复不覆盖库外 center 标记；已迁移项目恢复旧库先冻结、在线核 epoch/重建视图后再开放，离线只读或排队。
新装机器与恢复整体库外状态不能复用 local 执行能力；上述新身份离线 fork 不违反原项目 center 权威不可回退。


1. **首次 off（尚未迁移，authority=local）**：现状，本地 feature 的本机库仍是权威，共享 feature 按 V2。
2. **首次 observe（authority=local）**：只把历史作为无执行权的影子证据，写影子库并比对；中心不得受理这个项目的执行命令。
   不开放多副本同时执行；这里的影子同步不等于采用中心执行权威，历史 claim 不授予中心或第二副本执行权。
3. **进入 on**：中心组织项目级冻结屏障，停止所有成员旧执行写，核成员确认与旧租约/在途动作，备份并导入规范快照。
   历史按项目/白名单/脱敏分流，merge 分配新流序号；ordered 历史按 §2.2.1 中心重建，不作为 merge 上传。
   中心持久化 authority=center、新 epoch 后解除屏障；不能确认的成员隔离，其旧 epoch 命令拒绝。进入条件及观察天数由 owner 定。
4. **已迁移 on→observe（authority 仍 center）**：停止新的本地 merge 乐观写，改向中心提交 merge 后经同步确认再显示；
   原 on 模式尚未推完的 merge 日志保留并继续补传，不丢弃、不重编号；新的提交日志落 pending，但不先改确认视图。
   定序写继续只走中心与 §3.3 outbox，离线高风险命令仍拒绝，不切回旧本地阶段机。
   原副本保持只读已确认视图/必要结果接收，影子库用于诊断；不允许用旧本机库生成合并意图。
5. **已迁移 →off（authority 仍 center）**：冻结该机可合并写及后台同步；读冻结副本并标陈旧。
   在线定序命令仍走中心，离线按 §3.3 处理；收到回执可显式刷新只读结果，执行决策必须重新在线核中心，不信冻结缓存。
   导出中心日志/结果仅作备份恢复，不把执行权威交给本机；已迁移项目的旧本地定序入口在所有模式都拒绝。
6. **不提供 center→local 权威回退**：另开项目级迁移设计与 owner 决策；必须先中心冻结所有成员与执行器、撤销旧 epoch/租约、对账在途动作，
   不属于单机切开关或导出数据。其他成员保持 on 时，某成员 observe/off 也不会产生第二个权威。


## 5. 安全

- 中心不存 Git / 部署凭据、密钥、模型登录文件（沿用 V2 §4）。同步条目在推送前过白名单：`kind` 白名单，`payload` 过现有脱敏（`src/lib/shared-ledger-scrub.ts`），本机绝对路径一律拒绝（不能变成远程链接）。
- 只留主场的字段：见 §2.2「只留主场」列（聊天 / 频道 id、AUQ 和权限类 ask、出借单原文、部署原输出、会话、本机身份前缀、对端指纹与容量观测、调度器本机状态）。这些字段在 `class=local`，同步层在出口就丢掉，中心收到会拒收并告警。
- 鉴权：push/pull/watch 都按 V2 的本人 / 服务身份 + 项目范围鉴权；只拉到有权限的项目；不接受 body 里的 actor。条目的 `origin` 必须和凭据绑定的实例一致，不能冒充别的来源写日志。
- **撤销成员**：中心吊销凭据，此后 push/pull 返回 403。本机收到 403 后：
  1. 冻结该项目副本（只读，不再推）；
  2. 删除来自**其他来源**的条目和物化行，保留本来源条目（那是自己写的数据），保留 outbox 供导出；
  3. 提示「副本已撤销」。
  已经下载过的副本无法保证追回（沿用 V2 §4），所以中心只给成员同步其有权限项目的数据，私密附件默认不入日志。

## 6. PM / 脚本不直接碰 SQLite

PM 和脚本今天直接用 `sqlite3` 只读查询。同步上线后，物化表由同步层维护，表结构可能调整，所以改为只走 `ledger` 命令（输出一行 JSON）。仓库里 `git grep sqlite3` 只有两处探活用的 `select 1`，常用查询来自 PM 习惯，下面按需求列出：

| PM 常用查询 | 现有命令 | 缺什么（后续节点） |
|---|---|---|
| 某张卡的阶段 / head / round / 最近事件 | `ledger show <task> [--events N]` ✅ | — |
| 项目里所有卡 | `ledger show`（不带参数）✅ | 按阶段 / 执行者 / feature 过滤：`ledger cards --stage --assignee --feature`（SY5） |
| 卡的步骤与审查结论 | `ledger steps <task>` ✅ | — |
| 依赖 / DAG | `ledger deps`、`feature-deps`、`feature-show`、`dag-show` ✅ | — |
| 某张卡的出借单 | `ledger lend-orders <task>` ✅ | 全项目活单：`ledger lend-orders --live`（SY5） |
| 对端容量 | `ledger lend-peers` ✅ | — |
| 写租约 | 无 | `ledger leases [task]`（SY5） |
| 调度意图 | `ledger scheduler-diff`（观察和实际的对比）✅ | 原始意图列表：`ledger intents [task] --status`（SY5） |
| 资源锁 | 无 | `ledger resources [--task]`（SY5） |
| 事件流 | `ledger show --events N` ✅（按卡） | 按时间 / 类型 / 来源增量：`ledger events --since <seq\|hlc> --kind --origin`（SY5） |
| 待回答 asks | `ledger ask-check`（单条核对）✅ | 列表：`ledger asks --state open`（SY5） |
| 同步状态 | 无 | `ledger sync-status`（版本向量、syncedAt、outbox 条数）、`ledger sync-diff`（SY5） |
| 临时分析 | `ledger export --sqlite <file>` ✅（导出快照后随便查） | — |

SY5 上线后，在 PM 规则文档里把 `sqlite3` 查询改为上表命令（独立仓库外交付，由 PM 负责人维护；不属于 SY7）。

## 7. 原型验证计划

在 SY6 做一个确定性模拟器（单进程，一个中心加两个副本，可注入离线、时钟漂移、乱序、重复投递），只用本仓库代码，不连生产。

- **负载**：按本机台账的真实量级参数化。用 `ledger export` 只读统计「每日事件数、每日定序命令数、按 kind 的分布、payload 大小分布」，只把统计值作为参数，不把生产内容带进夹具或仓库。分别跑 ×1 和 ×10 两档。
- **场景**：
  1. 两副本各离线 1 小时、8 小时、24 小时，各自写；
  2. 同一卡同字段的并发 LWW 写；
  3. 反例 A 和反例 B 原样复现；
  4. 中心从旧快照恢复（序列倒退）；
  5. 撤销成员；
  6. §10 及第2/3轮证据的全部反例（历史 HLC 大漂移绿灯由新上界测试替代），包括扩权补历史、MV 两种历史与迟到写、同名改写拒绝、部署 CHECK 原子物化。
- **要量的指标**：

| 指标 | 定义 | 门槛（owner 定） |
|---|---|---|
| 收敛时间 | 最后一个副本重连到三方物化表逐行相等，p50 / p99 | p99 ≤ ___ 秒 |
| 合并冲突数 | LWW 覆盖次数、MV 产生两版的次数，按每千条写计 | MV ≤ ___ / 千条 |
| 定序拒绝率 | 离线排队命令重连后被拒的比例 | ≤ ___ % |
| 不变量违反 | 成环、一卡多活单、版本号重复、本机定序字段被本地改动、`local` 字段出本机 | 必须 = 0（硬门槛） |
| 日志体积 | 每副本每天新增字节；中心 90 天总量 | ≤ ___ MB / 天 |
| 同步流量 | 一次重连的字节数 | ≤ ___ KB |
| 全量重建 | 从快照加日志重建物化表的耗时 | ≤ ___ 秒 |
| 读延迟 | `ledger show` 在副本上的 p99，相对 off 模式的退化 | ≤ ___ % |

- **判断「选型成立」**：不变量违反为 0，且其余指标全部在 owner 填的门槛内。任何一项不满足，就回到 §1 重评（特别是：MV 冲突超标时接 Loro）。

## 8. 实现节点

规矩沿用 V2 §2：每卡最多半天（4 小时实现含针对测试，审查另计 1 小时）；新模块 ≤ 400 行、测试 ≤ 600 行；每卡专属测试前缀；验收线缺任一条即 P1。
所有新文件都用 `ledger-sync` 前缀或 `src/lib/ledger-sync/` / `src/ledger-sync/` 目录，`git ls-files` 当前没有任何文件匹配。只有 SY7 碰热文件，而它依赖 X12。

### SY0 · 冻结同步契约

key：SY0；oneLine：冻结同步条目、版本向量、outbox、模式开关的 DTO 与错误码；deps：无；估时：1小时。
fileGlobs：

- src/lib/ledger-sync-contract*.ts
- tests/ledger-sync-contract*.test.ts

验收线：条目 / HLC / 向量 / class / outbox / 拒绝码有类型和夹具；§2.2 字段与 §2.2.1 event op/幂等前缀分类表作为常量导出，并有测试逐列核对 27 张表的建表语句，新增列没有分类就测试失败；预留 syncClass/sourceDedupKey 的旧/新 schema 夹具，SY7 接线后要求列实际存在。

### SY1 · 来源日志、HLC 与版本向量

key：SY1；oneLine：本机来源日志、HLC 时钟和版本向量差量；deps：SY0；估时：3小时。
fileGlobs：

- src/lib/ledger-sync/log/**
- tests/ledger-sync-log*.test.ts

验收线：提供迁移函数与影子库夹具，实跑后两来源同 import hash 不撞 UNIQUE、触发器仍只增；注册/升级版本/列检查属于 SY7；各 `(project, stream, origin)` 的 streamSeq 连续、dot 幂等；HLC 发送和接收规则、校验中心时间+60秒与位宽安全上界、越界隔离且不推进 HLC；界内 HLC 严格推进，收和发边界计数溢出进入延期队列，可信时间推进后重试，不误告警、不提前分配 dot；硬位宽耗尽拒写；向量差量对缺口只推进到连续处；`class=local` 不分配流序号，不出日志。

### SY2 · 物化规则

key：SY2；oneLine：按字段分类把日志折叠成现有表；deps：SY0；估时：3小时。
fileGlobs：

- src/lib/ledger-sync/merge/**
- tests/ledger-sync-merge*.test.ts

验收线：跨流先收 merge 后收 center 建行不丢写、重启后待物化继续折叠；autostart/scheduler/lend claim 必须中心唯一且只认 center、缓存 claim 不授予离线执行权；逐写 context、顺序覆盖/并发保留/挑选后迟到不复活；feature 改名只能走中心；G-Set / LWW / MV / Map 四种规则在任意投递顺序下结果相同（性质测试）；定序字段只认 `center` 条目；反例 A 夹具里不出现两张活单和环。

### SY3 · 定序 outbox 与回放

key：SY3；oneLine：定序命令排队、回放、拒绝通知；deps：SY0；估时：3小时。
fileGlobs：

- src/lib/ledger-sync/outbox/**
- tests/ledger-sync-outbox*.test.ts

验收线：离线可排队清单和直接拒绝清单与 §3.3 一致；回放原样核前置条件、前序被拒后级联标记；反例 B 夹具标记被拒并产生通知；过期不自动提交。

### SY4 · 中心同步端点

key：SY4；oneLine：中心 push/pull/watch 与快照；deps：SY0；估时：3小时。
fileGlobs：

- src/shared-ledger/sync/**
- tests/ledger-sync-server*.test.ts

验收线：跨项目 [p:1,q:1,p:2] 不产生游标缺口，扩权/重授权重建；按项目鉴权、`origin` 和凭据绑定、拒收 `local`、绝对路径与越界 HLC；
副本落后中心的时间锚只使合法 admission 延期观察、不隔离或冻结来源；
admission 与新世代恢复不泄露隔离原文、不影响其他来源；差量分页、序号倒退告警；撤销后返回 403；每日快照可用于新机初始化。只导出模块，挂路由由 SY7 做。

### SY5 · 只读命令补齐

key：SY5；oneLine：PM 查询改走 ledger 命令；deps：SY0；估时：3小时。
fileGlobs：

- src/manager/ledger-sync-read-cmds.ts
- src/lib/ledger-sync-read*.ts
- tests/ledger-sync-read*.test.ts

验收线：§6 表里「缺」的命令全部实现，输出一行 JSON；off 模式直接读本机库，on 模式读副本；导出命令表常量，注册到 `ledger.ts` 由 SY7 做。

### SY6 · 两副本模拟器与指标

key：SY6；oneLine：离线双写模拟与 §7 指标报告；deps：SY1, SY2, SY3, SY4；估时：3小时。
fileGlobs：

- scripts/ledger-sync-sim*.ts
- tests/ledger-sync-sim*.test.ts
- docs/testing/ledger-sync-sim.md

验收线：§7 六个场景都能跑、输出指标表；负载只吃统计参数，不带生产内容；不变量违反为非 0 时退出码非 0；报告留空门槛，等 owner 填。

### SY8 · 撤销与副本清理

key：SY8；oneLine：403 后冻结并清理他源数据；deps：SY0；估时：2小时。
fileGlobs：

- src/lib/ledger-sync/revoke/**
- tests/ledger-sync-revoke*.test.ts

验收线：冻结后不再推送；删除他源条目和物化行，保留本源条目和 outbox；可导出；有提示。

### SY9 · 待同步 / 被拒 / 离线界面标记

key：SY9；oneLine：网页上的同步状态组件；deps：SY0；估时：2小时。
fileGlobs：

- web/features/collab/sync/**
- tests/ledger-sync-ui*.test.ts

验收线：卡片展示「待同步 / 被拒 / 离线（最近成功时间）/ MV 待挑选」；被拒可以「按当前状态重新发起」；只导出组件，挂到页面由 SY7 做。

### SY7 · 串接与模式开关

key：SY7；oneLine：把同步层接进 ledger 命令、bridge、网页和调度，并提供 off/observe/on 开关；deps：SY1, SY2, SY3, SY4, SY5, SY8, SY9，外加 V2 的 X12（跨 DAG 依赖，由 PM 在 rewrite_dag 时连上）；估时：4小时。
fileGlobs：

- src/lib/ledger-sync-mode*.ts
- src/ledger-sync/wiring/**
- src/lib/ledger-sync/wiring/**
- src/manager/ledger.ts
- src/lib/ledger-write.ts
- src/lib/ledger-store.ts
- src/lib/ledger-tx.ts
- src/shared-ledger/service.ts
- src/bridge/local-api/shared-ledger.ts
- web/features/collab/shared/shared-view.tsx
- tests/ledger-sync-wiring*.test.ts

验收线：observe 模式只写影子库、出 `sync-diff`；on 模式写命令按 §2 分流；回退两档可用并有备份，采用 center 后所有模式定序仍走中心、旧本地执行入口拒绝、单机回退不降 authorityEpoch；
原安装受控首次升级凭一次性 upgrade-session 原子初始化存量 never-shared local 标记，断网阶段写照常；
prepared 崩溃凭完整原安装 journal 续作、complete 后丢 marker 拒写；
新机/旧备份/库外状态全丢不重跑 preflight；
完整未回滚 local journal 离线恢复 marker，证明全丢时显式新身份 fork 只导入 merge 资料、旧身份仍拒执行且不复制动作/授权；
迁移函数在 ledger-store 的 LEDGER_MIGRATIONS/schema 版本/REQUIRED_COLUMNS 接线后，生产入口方可应用；
库外 center marker 缺失/损坏拒写、恢复迁移前备份离线仍拒本地定序；热文件里只加一行接入。ledger-tx/ledger-store 的存储/读取薄接入负责 canonical key 与来源范围，避免业务 SQL 误认 merge 为 claim。
lib 接入逻辑放 `src/lib/ledger-sync/wiring/`，仅依赖 lib；上层组合放 `src/ledger-sync/wiring/`。
lib 通过注入接口获得传输与通知，不导入 shared-ledger、bridge、manager 或上层 wiring；上层单向依赖 lib。
仓库外 PM 规则由 PM 负责人在 SY5 命令验证完成后独立交付，交付前登记实际文件清单并与在跑卡检查冲突；
本设计不访问或指定真实机器路径，SY7 不改该规则，也不以规则已修改作为验收证据。PM 切换前必须核对该独立交付回执。

### 8.1 并行性与冲突规避

- SY1、SY2、SY3、SY4、SY5、SY8、SY9 彼此没有祖先关系，fileGlobs 两两不相交（下面的检查命令实测）；SY0 先行，SY6 依赖 SY1–SY4，SY7 汇合。
- **和 V2 X 系列**：除 SY7 外，SY 卡的 fileGlobs 与 X0–X15 两两不相交。`src/shared-ledger/sync/**` 不在 X12 的文件清单里（X12 列的是 `src/shared-ledger/*.ts` 具体文件），也不在 X1–X6、X14 的子目录里。SY7 与 X12 共有 `src/manager/ledger.ts`、`src/lib/ledger-write.ts`、`src/shared-ledger/service.ts`、`src/bridge/local-api/shared-ledger.ts`、`web/features/collab/shared/shared-view.tsx`，所以 SY7 必须依赖 X12，排在它合并之后。
- **和在跑卡（JN4、PJ1、X12S、PRJ1）**：这几张卡的 fileGlobs 不在本仓库里，本卡无法核对。规则如下：
  1. SY0–SY6、SY8、SY9 只新建 `ledger-sync` 前缀的新文件，不改任何已有文件；SY1 提供迁移函数，SY7 才注册到已有 ledger-store 并升级 schema，和任何改已有文件的在跑卡都不会冲突。唯一可能撞上的是在跑卡也新建 `ledger-sync*` 前缀的文件；当前 tracked 文件为 0，PM 开工前按最新 DAG 跑下面的检查确认。
  2. SY7 改热文件，开工前 PM 按最新 DAG 跑检查；与 PJ1、JN4、X12S 有交集就给 SY7 加对应依赖，排在它们之后。
  3. 本设计不阻塞 PJ1、X12S、PRJ1：它们按 V2 继续做；本稿对 V2 的改动（§4.1）通过 SY 节点落地，不要求它们改验收线。
- **检查命令**（沿用 V2 附录的受限 glob 语法：只允许单个文件名前缀星号或目录尾 `/**`）：

```sh
bun run - <<'JS'
import { readFileSync } from 'node:fs';
function parse(path, re) {
  const doc = readFileSync(path, 'utf8'), out = new Map();
  const parts = doc.split(re);
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1].split(/\n## |\n### \d/)[0];
    const deps = body.match(/deps：([^；]+)；/)[1].match(/\b(?:X|SY|C)\d+\b/g) ?? [];
    const paths = [...body.split('验收线：')[0].matchAll(/^- ([a-z][^\n ]+)$/gm)].map(m => m[1]);
    if (!paths.length) throw Error(parts[i]);
    out.set(parts[i], { deps, paths });
  }
  return out;
}
const nodes = new Map([...parse('docs/design/shared-ledger-v2.md', /\n### (X\d+) · /),
                       ...parse('docs/design/ledger-sync.md', /\n### (SY\d+) · /)]);
const files = new TextDecoder().decode(Bun.spawnSync(['git', 'ls-files', '-z']).stdout).split('\0').filter(Boolean);
const split = p => p.endsWith('/**') ? [p.slice(0, -2), ''] : p.split('*');
function symbolic(a, b) {
  if (!a.includes('*')) return new Bun.Glob(b).match(a);
  if (!b.includes('*')) return new Bun.Glob(a).match(b);
  const [ap, as] = split(a), [bp, bs] = split(b);
  return (ap.startsWith(bp) || bp.startsWith(ap)) && (as.endsWith(bs) || bs.endsWith(as));
}
const ancestor = (a, b) => nodes.get(b)?.deps.some(d => d === a || ancestor(a, d)) ?? false;
const exp = k => files.filter(f => nodes.get(k).paths.some(p => new Bun.Glob(p).match(f)));
let pairs = 0, bad = [];
for (const a of nodes.keys()) for (const b of nodes.keys()) {
  if (a >= b || !(a.startsWith('SY') || b.startsWith('SY'))) continue;
  if (ancestor(a, b) || ancestor(b, a)) continue;
  const hit = exp(a).filter(f => exp(b).includes(f)).length;
  const planned = nodes.get(a).paths.some(x => nodes.get(b).paths.some(y => symbolic(x, y)));
  if (hit || planned) bad.push(`${a}/${b}`);
  pairs++;
}
const sy = [...nodes.keys()].filter(k => k.startsWith('SY'));
console.log('sy nodes=' + sy.length + ' checked pairs=' + pairs + ' overlaps=' + (bad.join(' ') || 'none'));
console.log('tracked files under SY globs except SY7=' + sy.filter(k => k !== 'SY7').reduce((n, k) => n + exp(k).length, 0));
JS
```

本轮实测输出（修订后的 globs，执行上面内嵌脚本；设计规划检查，不是同步实现测试）：

```text
sy nodes=10 checked pairs=171 overlaps=none
tracked files under SY globs except SY7=0
```

## 9. 公开内容自检

- 本稿只用「本机 / 中心 / 副本 / peer A」这类泛称，不写生产节点标题、对端名、地址、令牌、人名；表规模只写「27 张」这种结构信息，不写生产行数。
- 文中链接全部指向公开的论文、官方文档或开源仓库。
- 检查命令（无匹配返回 1 为预期；`https?://` 的匹配需要人工确认都是 §1.1 列出的公开出处）：

```sh
git grep --no-index -nEI \
  '([0-9]{1,3}\.){3}[0-9]{1,3}|Bearer[[:space:]]+[[:alnum:]_-]+|BEGIN.*PRIVATE KEY|@[[:alnum:]-]+\.(com|net|org|io|cn)' \
  -- docs/design/ledger-sync.md
```

公开内容人工复核：此前新增内容仅含合成 F/G/p/q/a/b 标识与仓库相对模块路径，未加入生产标识、私有商业计划或真实机器路径。§1 来源与选型保持原稿。

## 10. 修订反例验证（设计验证，非代码测试）

以下是可逐步复核的纸面状态推演，未运行同步实现或模拟器；SY6 后续必须转成自动化夹具。

- **复现测试：vector-scope**。旧日志 a:1=p、a:2=q、a:3=p，只授权 p 得 [1,3]，连续游标停 1；
  若跳 3，扩权 q 后遗漏 a:2。新日志为 (p,merge,a):[1,2] 与 (q,merge,a):[1]；
  p 游标到 2，不查询 q；扩权时 q 从快照/零向量到 1，p 保持 2。local/非白名单不占序号，因此不再有永久缺口。
- **复现测试：mv-context**。旧 a1@100=x、b1@200=y 在两种历史字段完全相同，无法区分。
  新设计顺序历史 b1.context={a:1}（同项目流），候选只有 y；并发历史 b1.context={}，候选 x/y。
  挑选 c1.context={a:1,b:1} 后只有 c1；先收 c1 再收 a1/b1 仍仅 c1，墓碑阻止复活。
  未观察到的 d1 与 c1 并发则保留 c1/d1，不能声称挑选消除了未来未见的写。
- **复现测试：title-unique**。F/G 初始标题不同，各离线要求改 same。旧本机立即 LWW，
  F→G 与 G→F 回放都触发唯一索引失败，赢家取决于回放。新设计本机只排队，旧标题保持；
  中心先受理 F 的 operationId，在事务内核项目唯一并递增 rev，G 被拒 title_taken，回执含当前值。
  两副本按中心结果序号物化同一赢家；G 保留原名并通知发起人，不能改 rev 自动重试。反向中心到达顺序可以有不同赢家，
  但这是中心定序的合法选择，每个已定序历史的副本结果一致；重复 operationId 返回原回执，不再次改名。
- **复现测试：field-coverage**。旧部署条目只有 phase=deployed/outcome=success，漏 liveness，
  套现有 CHECK 时失败。新条目同事务携带 liveness=dead 与完整 ordered 行，满足两个 CHECK。
  旧 items.rev/时间戳、lend_orders 的租约期限和 head 等无规则；新全列默认 ordered 且显式排除原文/local，
  不允许副本把这些列当 LWW；未知新列直接拒绝并要求先更新分类。这是字段分类与约束的设计验证，未跑内存迁移测试。
- **复现测试：module-direction**。旧 lib 薄接入若 import src/ledger-sync 即违反依赖规则；
  新本机核心及 lib wiring 均在 src/lib 内，外部传输/通知以接口注入，上层只向 lib 导入，无反向 import。
- **复现测试：rules-ownership**。旧 SY7 验收要求改未归属规则文件，glob 检查无法覆盖；
  新 SY7 验收移除此改动，PM 负责人独立登记仓库外文件清单、核冲突并交回执，之后才切换 PM 操作规则。

### 10.1 本轮实际仓库检查（不等于同步实现验证）

- `bun run check`：typecheck 通过；11771 pass / 20 skip / 1 fail，945 文件，608.61 秒；check 退出 1。
  唯一失败是 `sandbox-isolation` 的启动/使用/重启/退出夹具，第二次 up 报其临时端口占用（期望 0，实际 1）。
- 单独复跑 `bun test tests/sandbox-isolation.test.ts`：5 pass / 1 fail，69.73 秒；换了临时端口仍在同一断言失败。
  没改测试或基线，不声称全量通过；问题在本单文档范围之外，需另行修复后再过合并闸。
- 独立 `bun run guard` 通过；六入口 bridge/channel-server/manager/launcher/cron/setup 的 Bun build 全部退出 0。
- §8 glob 脚本实跑：10 个 SY 节点，171 对，overlaps=none，除 SY7 外现有匹配文件数 0；`git diff --check` 通过。
- 子进程用最小环境与临时 HOME，代码夹具不读取生产台账；未运行新的同步实现测试。

### 10.2 第2轮复现测试与修订结论

复现测试：event-claims、rollback-authority、cross-stream-order、hlc-skew。
完整合成脚本及确切结果见 [第2轮验证证据](ledger-sync-r2-evidence.md)；属于已运行的设计模型验证，非同步实现代码测试。

- event-claims：旧来源内去重并集产生两份执行权，红；新中心项目业务键 UNIQUE 只留一份，绿。
  §2.2.1 同时约束实际实施必须中心核 step、稳定 claim 引用与迁移，模型只验证唯一键核心反例。
- rollback-authority：旧单机回退把阶段机归本地、中心仍为 fix，本地 merge 并执行，红；新 observe 保持 center 权威，零本地 merge 动作，绿。
- cross-stream-order：旧未知目标丢写，建行后 title=initial，红；新日志缓冲建行后重折叠为 edited，绿。
- hlc-skew：旧忽略远端 HLC 推进，观察后新写仍小于未来写，红；新按标准接收/发送递增 HLC 严格大于远端，绿。

### 10.3 第3轮复现与契约参数

下列参数是 SY0/SY1/SY7 本期契约常量，不是 §7 owner 待定的性能门槛。

```json ledger-sync-safety-v1
{
  "maxFutureMs": 60000,
  "physicalReserveMs": 86400000,
  "markerOutsideLedger": true,
  "centerAuthoritySticky": true,
  "mergeStorageKey": "namespaced",
  "bootstrapExistingLocal": true,
  "hlcBoundaryAction": "defer",
  "bootstrapRequiresLiveUpgrade": true,
  "lostInstallationRecovery": "new-identity-merge-only",
  "replicaAdmissionBound": "authenticated-centerNow"
}
```

复现测试：hlc-bound、authority-marker、event-class-ambiguity、authority-operation-sequence。
脚本、旧红新绿确切输出与本轮检查见 [第3轮验证证据](ledger-sync-r3-evidence.md)。这是已运行的合成契约模型，非同步实现测试。

- hlc-bound：旧稿允许来源的 1 天未来/48 位上限条目进入时钟，红；新契约先核中心接收上界，两个均隔离，其他源仍可写，绿。
  界内 +30 秒漂移的逻辑计数溢出生成下一毫秒、后写大于已观察值，满足界限；自然位宽耗尽拒写不回绕。
- authority-marker：旧假定标记同库恢复后变 local，离线执行 merge，红；新恢复旧 DB 不能覆盖库外 center，排队且零执行动作，绿。
- event-class-ambiguity：旧两来源同 import hash 插入全局 UNIQUE 失败，红；新按 project/origin/rawKey 编码后保留两行，绿。
- authority-operation-sequence：第2轮设计的中心权威语义本来正确，但直接赋值证据未验证操作。
  新模型逐步运行切模式、离线申请、中心改 fix、重连拒绝序列，基准与修订稿均绿；
  把路由突变成 observe/off 本地执行后同一测试红，说明能检出原反例。模型未替代未来 SY7 的实际状态机测试。

第2轮证据保留当轮实际结果；其中「1 天漂移照收」模型与直接赋值的 rollback 绿灯不作为本轮通过依据，已由上述有界与操作序列模型替代。

### 10.4 第4轮反例与模型范围

复现测试：marker-bootstrap、hlc-edge、hlc-function-causality、bootstrap-restore。
完整模型和确切结果见 [第4轮验证证据](ledger-sync-r4-evidence.md)，仍是设计参考模型，不是同步实现代码测试。

- marker-bootstrap：旧首次升级无标记，never-shared local 项目阶段写被拒，红；新 preflight 提交 local 标记后离线写成功，绿。
  complete 后删除 marker 再跑 preflight 不会重建 local；已有 center 标记不被覆盖，恢复旧 DB 仍不能本地执行。
- hlc-edge：旧时间上界上的逻辑进位被拒/收路径未规定，红；新 receive/send 候选计算进位后延期，可信时间 +1ms 重试成功，绿。
  等待时不改时钟、不物化、不分配 dot；硬位宽耗尽仍拒绝，不伪称所有拒写都能等待解决。
- hlc-function-causality：旧契约标准 HLC 算法本来正确（绿），弱的是旧证据；新用同一 receive/send 函数验证 +30s 溢出及边界，绿。
  把接收突变成忽略 remote 后相同因果断言红，说明证据能检出错误，而非手写构造后写更大的值。
- bootstrap-restore：旧无首次初始化步骤导致恢复/升级流程不能完成，红；新 prepared 中禁止写、重试完成后 local 写正常且 center 保持拒绝，绿。

SY1 迁移函数/夹具与 SY7 注册的归属已拆清，SY0 提前声明新列；未修改任一运行代码或生产状态。
第3轮证据的 HLC 手写结果构造仅为历史记录，当前界内/边界证明以第4轮收发状态机为准。

### 10.5 第5轮恢复身份与 admission 复现

复现测试：bootstrap-rerun、local-disaster-recovery、replica-bound-skew。
旧 r4 Bootstrap 模型在新机恢复旧登记后确实授予 local（断言退出 1）；修订契约把首次原安装升级与恢复分成入口。
同身份旧备份无法离线证明 never-shared，因此全丢灾备仅允许新身份 merge-only fork，不复活旧执行权。
脚本与先红后绿结果见 [第5轮验证证据](ledger-sync-r5-evidence.md)，模型不替代 SY7 实际入口/身份保护测试。
