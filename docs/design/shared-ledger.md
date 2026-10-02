# i28-C0 · 团队共享台账

状态：设计稿，specRev 1；代码核对基线 `f911e99f`。本稿不实施部署、不修改中继。
推荐：**中心服务是共享数据唯一写入方，机器提交命令，中心用事务 + CAS 定胜负；执行仍归卡的主场机器。**
目标是团队成员从自己的网页看同一份 feature / 子 DAG / 卡，并能添加 feature、共同改图。
本文的「owner」是项目授权名单明确指定的本人，不等于任意机器的本机 owner，更不等于 agent 自报的字符串。

## 0. 核实到的现状与第一版边界

- [`ledger-store.ts`](../../src/lib/ledger-store.ts)：`STATE_DIR/ledger.sqlite`，默认即 `~/.claude-orchestrator/ledger.sqlite`；
  WAL、写事务 `BEGIN IMMEDIATE`、读侧快照均只覆盖这一份本机库。没有共享数据库连接或跨机事务。
- [`ledger-feature-schema.ts`](../../src/lib/ledger-feature-schema.ts)、[`feature-dag.md`](feature-dag.md)：
  `features`、只追加的 `dag_versions`、`dag_proposals`、`dag_bindings` 已实现；不能只同步前两张表。
- [`ledger-origin.ts`](../../src/lib/ledger-origin.ts)：feature id 才带四位 origin；旧 task id 未改。
  `events(origin, originSeq)` 有唯一索引，但旧事件可为空；它是来源标记，不是合并算法，四位前缀也不保证跨机唯一。
- [`ledger-write.ts`](../../src/lib/ledger-write.ts)、[`ledger-dag-write.ts`](../../src/lib/ledger-dag-write.ts)：
  字段修改用 rev；阶段推进用 from；DAG 重写用 feature.rev，新版本、绑卡和事件同事务。并非所有命令都有 rev 前置。
- [`remote-capacity.md`](remote-capacity.md)、[`ledger-lend-schema.ts`](../../src/lib/ledger-lend-schema.ts)：
  出借 v2 已有 hello / beat / offer / claim / ask / result；订单、租约在发起方，出借方保留本机收据，不能浏览全部台账。
  跨机另有 HTTP peer 消息和 peer PR 等协作入口；这些也不是全台账同步。
- [`ledger-dag.ts`](../../src/bridge/local-api/ledger-dag.ts)、[`ledger.ts`](../../src/bridge/local-api/ledger.ts)：
  网页读本机 query-only 连接；`canReadLedger` 只放全权管理凭据，不放普通 peer。写入口主要仍是 CLI / DAG 工具。
- [`scheduler.ts`](../../src/scheduler.ts)、[`scheduler-pass.ts`](../../src/lib/scheduler-pass.ts)：
  scheduler.pid / maintenance 锁及 `scheduler_resources` 只做本机排他；出借池也由本机调度器持有。
- [`relay/server.ts`](../../src/relay/server.ts)、[`relay/protocol.md`](../relay/protocol.md)：
  中继负责身份、目录、转发，现有目录库不是业务台账；共享常量在 `src/lib/relay-protocol.ts`。

**V1（当天试用）= 共享规划 + 全量执行状态只读投影。** C1–C6 形成一个可验收闭环：
成员入组后，在自己的网页看全部已迁入项目的 feature / DAG / 卡，新增 feature、编辑其规划节点，看到 CAS 冲突。
中心权威管理 feature 和 DAG；现有卡执行记录仍只由其主场写，再上传投影。两类字段无双写，无通用事件合并。
所有已绑卡节点在 V1 原样继承，未绑卡节点可增删改和调整自己的依赖；不能借改图重排已开工卡。
V1 不从共享图开工、不开执行卡、不改已有卡、不改主场、不取消执行者、不处理范围变更审批；界面明确禁用并说明原因。
已有执行可按原授权继续，迁入 feature 的本机 DAG 写入口及自动开新节点必须先封住。
代价是迁入 feature 的后续自动开节点会暂停；尚需连续开工的 feature 应先只展示执行镜像，待 V2 再迁规划权威。
因此 V1 尚不是「整套共享调度已完成」；全员开卡、改卡及执行中心化是 V2（C7–C9）。

## 1. 拓扑、并发与 CAS

### 1.1 选中心单写

浏览器 → 自己的 bridge（核本人、脱敏）→ HTTPS 共享台账服务 → 独立 SQLite WAL。
CLI / PM 工具也走同一命令入口；中心事务写行、版本、事件、幂等回执，一次提交。
每台机器有独立只读共享缓存，不把中心 SQLite 放网络盘，不让本机直接写中心库文件。
选它是因为 DAG 版本、绑卡、任务阶段、授权必须一起检查；两台机器各自成功后再合并，CAS 也无法撤回已经派出的单。
「本机多写、事件上传中心再广播」仅适合追加观测；本案拒绝把它用于 DAG / 卡 / 授权，也不做按客户端时间的最后写赢。

V1 的例外明确到表：`task_mirrors` 是主场执行的缓存投影，中心不能据它触发执行，也不能用它覆盖规划。
V2 将 `tasks` / 依赖 / 步骤 / 调度意图迁成中心权威；主场发送命令和执行回执，不再本地成功后补同步。
切换按 feature 整组完成，API/页面显示 `authorityMode = source | planning | execution`：分别是全只读来源镜像、共享规划、共享执行。
source 不接受共享修改；planning 只写规划；execution 才写卡和调度。不能用 source 的旧图覆盖 planning，也禁止半张卡两种模式。
V2 必须等 C7–C9 全部通过才开放 execution；中间节点交付只提供禁用的能力，不提前切换存量卡。

### 1.2 谁赢，另一方看到什么

1. 修改提交 `requestId + expectedRev`；DAG 另带 `baseVersion`。中心先鉴权，再在写事务内重读、验证业务规则、比版本。
2. 两人读到 feature rev 7 / DAG v3；甲先取得写锁并提交，生成 v4 / rev 8。乙即使只改另一节点，也得到 HTTP 409。
   中心不写乙的 v5、不追加成功事件；返回 `code=conflict`、当前 rev/version、授权范围内的最新快照与修改者代号、时间。
3. 网页保留乙的草稿并显示「此图已更新，你的改动尚未保存」，并列草稿与最新图；提供「重读后编辑」「放弃草稿」按钮。
   乙人工调整后用 rev 8 和新 requestId 提交。CLI 输出当前版本、返回非零；禁止自动替换 rev 反复覆盖。
4. V2 同一卡：甲乙都读 rev 12，先提交者成功成 13；后提交者 409，包括改不同字段。stage / 分配 / 规格均不静默合并。
   阶段命令必须同时匹配 `expectedRev + from + specRev`；交付 / 审查另绑定订单、round、head，避免阶段绕回后的旧命令生效。
   V1 对卡编辑直接回 `execution_not_shared`，对只读镜像不伪装成可编辑任务。
5. 绑卡同时检查 feature.rev 和 task.rev；一次事务更新两者及绑定。任何冲突整笔回滚，不出现「图绑上了、卡没改」。
   两人同时新建同项目同名 feature，唯一索引只让一个成功，另一个 409 并指向已存在的 feature；不自动合并。
6. V2 范围变更生成 pending 提案：同一 feature 仅一份；其余重写 409 `pending_proposal`。
   owner 批准绑定提案摘要、基础版本和有效期，生效前按最新卡状态重验；过期、漂移或驳回均不换图。

现有 rev / `LedgerError(conflict)`、DAG 不可变快照和事务校验可以复用；**把数据库地址换掉并不能直接复用整个调用链**。
须补中心身份策略、命令 API、跨机 id、阶段 rev 前置、异步客户端；本机 `actor=owner` 不能透传为中心权限。
V1 用规划写入适配器查 `task_mirrors` 并逐字段冻结已绑节点；不能把镜像当旧 `tasks` 表直接调用会换绑/增 rev 的写函数。
现有 dedup 有的只比 target/kind/op，重放还可能读最新行；中心新增 `command_receipts`，不能只沿用这层宽松判断。
唯一键为 `(teamId, memberId, instanceId, requestId)`，保存规范化载荷摘要及当时响应；同键同载荷返回原结果，异载荷 409。
每次网络重试使用新传输签名、同 requestId；响应丢失先查回执。CAS 拒绝后重新编辑属于新命令，不沿用旧键。
签名正文带每次尝试的随机 attemptNonce；幂等摘要仅覆盖业务命令，排除 nonce/签名时间，避免同秒重签与业务幂等互相打架。
写事务提交后才发布通知；客户端按中心 `serverSeq` 拉快照 / 增量，客户端时钟和 sourceSeq 都不能决定覆盖顺序。

V1 API 契约（均在 `/v1/teams/:teamId` 下，中心从凭据取本人，不从载荷取角色）：

- `GET /features`、`GET /features/:id`：总表/子图，含一致性水位、当前 rev/version、执行投影来源与更新时间。
- `POST /commands`：只接受 `feature.new`、`feature.set`、`dag.init`、`dag.rewrite`；所有写入携 requestId，修改携 expectedRev。
  V1 拒绝 scopeChange、绑卡/开卡/阶段/审批动作；只暴露 title/description 等明确列出的规划字段，拒绝任意 SQL/字段透传。
- `GET /commands/:requestId`：只查本身份自己的回执；提交响应也返回不可变的结果版本与 serverSeq。
- `POST /imports`、`POST /projections`：仅导入授权身份/登记主场的服务身份可用，普通 member 不能伪造卡状态。
  导入包含 dry-run 与 commit；V1 初始导入须 owner 授权，导入包和增量均过相同脱敏闸。

## 2. 放哪、怎么连

推荐在东京中继所在机器新增**独立共享台账服务与独立库**，复用已有 TLS 反代，加独立 HTTPS 域名入口；不塞进中继转发循环。
这是拟议部署位置，不是已经部署；机器基建变更必须 owner 批准，实施前查现有服务、监听和反代，复用 TLS 终结。
各 bridge 出站 HTTPS 即可，不要求成员机器开放入站端口；V1 快照轮询，不新增 relay 帧或 SSE 依赖。
中心是所选团队业务数据的可信存储端，能读获准上传的明文；现有 peer 端到端加密不意味着中心也看不到数据。
不能接受此信任边界时，备选是在团队自管服务上运行同一接口，不偷偷改成多主同步。

凭据推荐：复用实例 Ed25519 私钥签请求，**另发绑定实例的本人级中心凭据**；不复用 peer token 或全权 bridge token。
原因是现有 peer token 由各接收机器授予，权限域不是团队台账；实例签名也只能证明哪台机器，不能证明是哪位成员。
中心保存凭据哈希、personId、完整实例公钥绑定、项目范围、角色、吊销/过期状态；本机安全存放凭据，浏览器不拿实例私钥。
签名复用 `instance-key.ts` 的方法、路径、时间、正文哈希及校验常量；共享路由独立命名，业务 requestId 放签名正文中。
中心无 legacy 未签名放行；验签、时间窗、防重放、载荷大小/读取超时、限流、权限校验缺一即拒绝。
重启仍需阻挡有效期内的旧写签名（持久化短期 replay 索引），幂等回执跨重启保留。
只有 owner 能邀请、撤销、换绑密钥；中心每次请求重验成员状态，不靠旧缓存决定写权限。

部署及回归不可改动：

- relay HTTP 的 `idleTimeout: 0` 保持；WebSocket 的独立超时也不借本功能调整。
- 既有 PROXY protocol / 受信反代层数和真实来源链保持，不为新服务重配现有中继入口。
- `src/lib/relay-protocol.ts` 是 relay 协议常量唯一来源，不复制、不换版本、不新增业务帧。
- `src/relay/**`、relay 目录库、线上代理配置均不在本设计交付的修改范围；未来部署单独审批。

## 3. 数据边界与敏感信息

### 3.1 中心权威数据

- V1：`teams/projects/members/instance_bindings`（代号、角色和项目范围，不含机器目录）、`features`、`dag_versions`、
  `dag_bindings`、中心规划 `events`、`command_receipts`、`import_batches/id_map`。DAG 版本及绑定保持只追加。
  新增 `feature_locations(featureId, homeInstanceId, authorityMode, epoch)`，规划主场先固定，V1 不能执行或迁主场。
  可编辑描述与来源原话分列，均保留作者/来源；成员补充的说明不能被标成 owner 原话。
  `dag_proposals` 与范围审批 V1 不激活；迁移时有 pending 的 feature 暂缓迁入，不导入可生效的旧授权。
- V2 再纳入 `items`、`tasks`、`task_deps`、`task_steps`、`task_workflows`、`dag_proposals`、业务 asks、执行 events。
  tasks 保留 title/kind/stage/round/specRev/rev、featureId、仓库坐标、branch/pr/head 等可共享业务字段；增 homeInstanceId。
  `extra` 必须拆成命名且有 schema 的字段，不能整包 JSON 透传。
- V2 中心持有 `scheduler_intents/resources`、调度租约和执行操作回执；资源键是团队项目 + 仓库/文件范围，不能用绝对路径。
  lend 订单/claim/lease/result 的权威状态随所属 feature 迁入中心，不能留两份都能接单的权威库。
  合并、部署日志上中心的是状态、head、审批引用、结果摘要；shell 参数和原始输出仍在执行端。

### 3.2 V1 只读投影及附件

- `source_dag_mirrors` 保存尚未迁入规划权威的 feature / 图快照；与 task_mirrors 一起供 source 模式展示。
  提升到 planning 沿用同一 id_map 标识，原 source 图封存，不再参与当前版读取，避免总表出现两份同名 feature。
- `task_mirrors` / `step_mirrors`：来自唯一登记主场，带 `sourceInstanceId/sourceTaskId/sourceRev/sourceSeq/observedAt`；
  白名单仅含显示所需的阶段、负责人代号、步骤状态、PR/head、依赖、规格摘要。它们不是中心可写的 `tasks`。
  同主场按 sourceSeq 接收批次，拒绝倒退；同水位同业务摘要幂等、不同摘要隔离报错，observedAt 不计入业务摘要。
  task.rev 和 step.rev 分别校验不倒退，不能用 task.rev 给整份含步骤/事件的投影判重；批次水位缺口重拉快照。
  投影失败时整批保留旧水位；不会因一张卡消失就自动删卡或判完成。
- 规划事件由中心产生；历史执行 events V1 只传脱敏的类型、时间、来源序号和状态摘要，归 `source_event_mirrors`。
  V2 才统一业务事件序列。不得把未经筛选的 `events.text/data` 当可信命令或直接追加中心执行状态。
- 规格原文、审查报告通常由 `tasks.spec` / 事件中的 path/evidence 指向本机文件（当前 `/docs/` 按 docsDir 读文件）。
  中心 V1 保存受审查的摘要、内容摘要值和可选仓库相对路径/commit 引用；本机绝对路径绝不直接变远程链接。
  原文尚未共享必须显示「全文仅在主场」，不能把脱敏摘要叫作原文或当完整执行材料。
  V2 附件存为不可变对象 `{artifactId, kind, taskId, specRev/head, digest, redactionVersion}`；上传的是明确批准共享的副本。
- asks：V1 只共享已有业务 ask 的 kind/state/blocking 摘要；答复仍在主场，不能在共享页批准。
  V2 业务决定/授权的 bind、到期时间、答复人及审计上中心；终端权限弹窗、模型 permission、聊天 AUQ 不上中心。
  原始全文哈希与共享副本哈希分列；授权绑定实际用于动作的内容，脱敏后变义必须重开规格/审批，不能挪用旧批准。

### 3.3 留本机与上传检查

留本机：worktree/仓库绝对路径、sessionId、tmux/ACP 状态、registry、聊天记录、环境变量、私钥/token、设备 cookie、通知路由。
`meta.docsDir`、scheduler_sessions、原始 scheduler 配置/进程锁、lend journal/工作目录均不整表上传。
模型配额与 lend 授权由各机 owner 管理；中心最多读去标识的容量和健康摘要，不获得开进程或改授权的权力。
agent 身份用于协作时是 `(instanceId, agentId)` 代号；无需上传本机会话标识、频道号或真实姓名。

上传路径统一经过：**本机字段白名单 → 脱敏/敏感命中检查 → 共享内容预览 → 签名上传 → 中心再次校验**。
复用 [`dispatch-redact.ts`](../../src/lib/dispatch-redact.ts) 与 [`peer-pr-redact.ts`](../../src/lib/peer-pr-redact.ts) 的能力，
补共享 schema 和本地身份字典；已有正则不能保证识别所有个人信息，迁移自由文本必须人工预览，日常输入明确标为团队可见。
已知密钥、地址、联系方式、用户名路径、未声明字段/附件命中则阻止上传，只在本机显示字段位置，不把命中原文打进日志。
中心二次拒绝不能替代上传前检查；草稿、缓存、错误日志、审计事件、导入包和 PR 摘要也遵守相同边界。

## 4. 身份与权限

成员身份 = 中心分配的 personId + owner 登记的实例公钥绑定；同一人多台机器分别注册，不能靠昵称合并。
自己的网页仍用设备配对；bridge 从已验证的本机会话映射到本人中心凭据，不接受 body 传来的 actor/role。
中心凭据的实例绑定与签名必须同时匹配；多个本机 `owner:self` 映射为不同中心 personId，不自动取得项目 owner 权。
PM/worker 使用单独、限定项目和动作的服务身份，记录代表谁/哪个订单，不能读取本人 owner 凭据或自报 owner。
V1 信任登记 bridge 对本机会话的认证；被攻陷主机可滥用其持有的授权，不能把实例签名宣传为独立的人身认证。

- 项目 member：可读本项目全量共享数据；可新增 feature、改 feature 标题/描述、重写允许的子 DAG，包含别人创建的规划。
  这些共享规划权限与本机 PM 名单分开建模，不能通过把所有人填成 `owner` 或放宽 `canReadLedger` 实现。
- V1 member：只能改未绑卡的节点；既有绑定、已绑卡节点的内容/依赖/估时原样保留；清楚显示限制。
  DAG 无环、同项目、已完成原样继承等规则仍有效；改 feature 描述不构成新的执行授权。
- V2 member：可开 spec 卡；可改别人卡的标题、计划说明等允许字段，均走 CAS、审计。已开工规格变更走新 specRev 与既有流程闸。
  分配执行者、改阶段、交付/审查各走独立动作和角色校验；generic PATCH 不能改 stage/head/主场/授权/工作流模式。
- 别人的机器：成员不能 create/kill/interrupt 执行者、读终端或改 registry。只可向主场发暂停/调整请求；
  主场在本机 owner 的有效授权内执行，跨机空位继续按出借授权领取订单，订单权限不扩张成整机管理权。
- **合并、发版、授权仍只有 owner**。调度服务只执行 owner 已明确授予且未过期、未越界的动作，成员不能代签或扩大授权。
  项目 owner 才能批准范围变更、入组/角色变更、主场迁移；机器 owner 才能授权本机算力，项目 owner 也不能替另一机器授权。
  中心不存 GitHub/部署凭据；实际合并/发版在获授权的主场执行，沿用现有审批要求。
- 403 / 冲突返回只包含请求者有权看的项目；移除成员后不再发新数据，清除该身份的在线缓存；已下载副本无法保证追回。

## 5. 调度归属和防止重复推进

主场与执行地点分开：`homeInstanceId` 决定谁推进卡，`executorInstanceId` 决定谁干活；借出去不改变主场。
V1 新图仅规划，主页明确「尚未接入执行」。原有卡仍只在原机跑；上传接口仅接受该主场的投影，别的实例不能写状态。
本机已迁入 feature 的 DAG 修改、dag-bind/start_node 和 autostart 一律挡住；现有卡的已授权流程不因共享规划自动变更。
V1 主场离线无人接管，镜像超过 30 秒显示过期；不以在线机器多就临时选一个调度器推进。

V2 不在中心启动 worker；在中心取得执行权再让主场做副作用：

1. `scheduler_leases(taskId, homeInstanceId, holderBootId, epoch, expiresAt)` 只允许登记主场领取；建议 60 秒租期、15 秒续租。
   中心时钟裁决；同卡同一时刻一个持有者。重启换 bootId / 新 epoch，旧 holder 不可继续写。
2. 新意图事务同时核卡 rev、specRev、workflowRev、依赖、owner 授权、租约 epoch 和共享资源占用；再写 intent 和 event。
   所有写入口核 epoch，不只是派单接口；本机文件锁仍保留，用于同机多进程保护。
3. 主场每次副作用前在线核租约/意图，操作用稳定 operationId，结果携 epoch 写回；取消和改主场不复用旧 epoch。
   检查与远端 Git/进程副作用之间并非原子；回执丢失记 unknown，先对账，不声称有通用 exactly-once。
4. 超时不自动把卡派给另一机器。换主场要 owner 确认旧实例停推、旧 worker/lend 单已结束或核清，再增 epoch。
   未核清的 unknown 意图继续占资源，不靠租期到期解锁后盲重试合并/开工。
5. 其它机器只经出借池接单。hello/beat/offer/claim/result 的外部 v2 形状保持；主场 bridge 代理中心命令，
   中心统一记录 claim、订单租约、结果；worker 回写仍校验订单 + leaseGen + head/specRev，不能直接改整张卡。

## 6. 网页总表与子 DAG

增加团队「全部 feature」入口，不再靠遍历本机 projects.json 拼成共享视图。
总表列：项目、feature、状态、完成/总节点数、阻塞数、主场代号、执行机器代号、最近更新、数据是否过期。
主场固定但多个执行点时展示机器集合；别把「在哪执行」误画成「谁有权推进」。缺失/过期单列，不能计为已完成。
点入 feature 复用现有 `web/features/collab/dag/` 图组件和版本差异；适配中心 DTO，继续区分快照状态与当前执行状态。
V1 表单支持新建 feature（归属项目、标题、描述、默认规划主场）、编辑计划节点、依赖、fileGlobs、估时及原因。
已绑卡节点上锁；另有草稿/冲突对比、主场在线状态和「全文仅在主场」提示，避免点击后才发现执行能力缺失。
团队成员分别从已配对的自己的网页进入同一 team/project，不必取得对方机器管理权限；新接口查团队 membership。
共享入口使用 `/api/v1/shared-ledger/*` 代理中心 `/v1/teams/:teamId/*`，保留旧 `/ledger/*` 的本机权限和行为。
V1 每 5 秒轮询增量/水位，页面重连或缺页重拉一致快照；响应含 `serverSeq`、`schemaVersion`、来源水位与 capabilities。
V2 可加 SSE 唤醒，但事件仅提示重拉；一次总表/子图从同一快照读取，不把两次不同水位拼成同一张图。
缓存键包括中心标识、team、person、project；切机器/成员中止旧请求，迟到结果不能落进另一身份缓存。
V1 挂在自己的 bridge 上，所以本机 bridge 离线时只能读已缓存内容；无机器在线也能写的独立中心登录网页留以后版。

## 7. 迁移、断网与恢复

V1 迁移按 feature（例如已有 i28）进行，不把整份 ledger.sqlite / WAL 拷到服务器：

只展示尚未迁规划权威的 feature 时，图也归 `source_dag_mirrors`，标记「本机管理，只读」；禁止与中心可编辑的版本混用。
这种展示不会封住原机调度；要共同编辑，必须完成下列写门和切换步骤，不能仅把只读标签去掉。

1. owner 选择团队项目、成员、默认主场和迁入集合；同名项目用显式映射，不按名字自动混成一个。
2. 主场备份，预检 pending 提案/未完成的改图事务；安装持久 `sharedPlanning` 写门，拒绝本机改图和开新节点。
   该门须覆盖 CLI、DAG MCP、autostart，不只关网页按钮；旧客户端只读。未完成提案处理好再迁，不能迁后自动获批。
   等待在途 start_node/绑卡步骤落定，未知状态阻断导入；实际写入和开进程前都重核写门，不能仅在预检时查一次。
3. 在读事务取 feature、全部 DAG 版本/绑定及卡投影、来源水位，生成字段白名单导出包；脱敏后人工预览。
   主场仍执行的卡可以前进；后续按增量水位补镜像，规划因写门保持固定。
4. 中心 dry-run 核项目、身份、id 映射、引用完整性、唯一标题、版本连续性及摘要；有冲突整批拒绝，绝不覆盖另一来源。
   全局主键由中心生成；`id_map(kind, sourceInstanceId, sourceId)` 唯一，旧 origin / slug / taskId 只是显示别名。
   DAG 节点 taskId、deps、绑定、事项引用统一重映射；同名卡不能只按 taskId 合并，旧四位 origin 碰撞也不构成同一来源。
5. `batchId + manifestDigest` 幂等提交，一次事务导入全组；重复返回同一结果，同 batch 不同摘要拒绝。
   中心事件用自己的 serverSeq；源事件键 `(sourceInstanceId, sourceSeq)` 去重，旧空 origin 事件仍以原 seq 定位。
   原事件的 origin/originSeq 保留为溯源元数据，不拿它们跨库的 UNIQUE 约束直接拼库。
6. 比对 feature 数、版本数、绑定数、卡数、摘要与水位，确认后启用中心规划路由，成员才能编辑。
   主场持久保存映射/导入回执并保留写门；中途崩溃先查 batch 回执，不能以超时当失败重开本机写入。
   后续镜像只更新执行字段，不能上传旧本机 DAG 把中心的新图覆盖回去。

V2 执行迁移另设闸：暂停新派单，处理活跃 worker/lend 单与未知副作用，核验快照，再整组将 authorityMode 切到 execution。
原始 scheduler_sessions / 进程锁不迁；建立中心执行租约前不恢复调度。旧订单要么结清，要么显式导入并核对租约，不重发。
新中央 id 与本机旧 id 的映射、规格副本与审查证据完整性都核清后才允许启动，不能只迁 feature 声称迁完。

中心不可用：共享规划只读缓存，显示最近成功时间；可保存本地未提交草稿，不自动排队、不给假成功，不回退本机权威写。
V1 主场现有执行继续并保留本机水位待补镜像；V2 新派单/阶段推进/合并/发版一律停，进行中的 worker 可保留工作成果，
其待交结果仅存本机 outbox，恢复后先查回执、核租约和版本，再显式重交；不因断网重复启动执行者。
备份推荐中心每日一致性快照及迁移前备份，试用期接受最多一天灾难恢复损失；要求更小 RPO 再加连续备份。
恢复旧备份先冻结写入、提升服务代际、撤销旧租约，核对客户端已确认回执；发现序列倒退须告警并重建缓存，不能静默丢提交。
V1 导入未开放写前可撤销试迁回本机；中心已有新提交后不得直接恢复旧本机库，须冻结中心、导出新版本并核对后单独迁回。

## 8. 子 DAG 草案与工期

以下 fileGlobs 是拟议实现范围，不是本单会修改的代码。V1 新模块先按契约并行，旧入口统一留 C5 串接；不改 guard 基线避限额。
估算含节点内针对性测试；假设三名执行者、复用现有图组件、owner 当天能批准试部署，V1 共约 14 人时、关键路径约 8 小时。
单人约两工作日；公网部署审批/人工脱敏预览另占等待时间，不能把「写完代码」报成上线。今天优先达成 V1 闭环，不拆掉权限闸赶工。

- **C1 [V1]**；oneLine：冻结 DTO、命令/冲突契约及成员身份校验；deps：[]；粗估：2 小时。
  fileGlobs：`src/lib/shared-ledger-contract.ts`, `src/lib/shared-ledger-auth.ts`, `tests/shared-ledger-auth.test.ts`。
  包含 token 与实例绑定、载荷摘要/重放规则、错误码、V1 capabilities、模拟请求/响应；不扩大原有 owner 判断。
- **C2 [V1]**；oneLine：中心单写规划服务、回执与镜像存储；deps：[C1]；粗估：3 小时。
  fileGlobs：`src/shared-ledger.ts`, `src/shared-ledger/**`, `tests/shared-ledger-server*.test.ts`。
  包含独立迁移、项目作用域、CAS、批次导入、快照/增量；V1 冻结已绑卡节点，拒绝执行 API。
- **C3 [V1]**；oneLine：本机身份映射、脱敏导出、中心客户端与缓存；deps：[C1]；粗估：3 小时。
  fileGlobs：`src/lib/shared-ledger-client.ts`, `src/lib/shared-ledger-export.ts`, `src/lib/shared-ledger-cache.ts`, `src/lib/shared-ledger-scrub.ts`。
  fileGlobs 续：`src/lib/shared-ledger-mode.ts`, `src/bridge/local-api/shared-ledger.ts`, `tests/shared-ledger-client*.test.ts`。
  使用假中心完成断网/重试测试；新增 export 模块提供 dry-run/迁移函数，不在此节点修改旧命令入口。
- **C4 [V1]**；oneLine：团队 feature 总表、新建/改图与冲突草稿；deps：[C1]；粗估：3 小时。
  fileGlobs：`web/features/collab/shared/**`, `web/lib/api/shared-ledger.ts`, `web/lib/i18n-dict-shared-ledger.ts`, `tests/web-shared-ledger*.test.ts`。
  先用契约夹具，现有图组件只通过 props 复用；必须含成员可见性、过期提示与 V1 执行限制。
- **C5 [V1]**；oneLine：串接真实入口、迁移写门与既有 DAG 图适配；deps：[C2,C3,C4]；粗估：2 小时。
  fileGlobs：`src/bridge/local-api/index.ts`, `src/bridge/dag-tools.ts`, `src/manager/ledger*.ts`, `src/lib/dag-tools*.ts`。
  fileGlobs 续：`src/lib/ledger-feature-{write,migrate}.ts`, `src/lib/ledger-dag-write.ts`, `src/lib/scheduler-autostart*.ts`。
  fileGlobs 续：`web/features/collab/collab-{entry,switch}.tsx`, `web/features/collab/collab-nav.ts`。
  fileGlobs 续：`web/features/collab/dag/**`, `tests/shared-ledger-integration*.test.ts`。
  热文件只加薄调用；逐入口核验旧写入被挡且旧卡仍可执行，不把所有成员变成本机 owner。
- **C6 [V1]**；oneLine：迁移命令与双成员验收、试部署说明；deps：[C5]；粗估：1 小时。
  fileGlobs：`scripts/shared-ledger-import.ts`, `tests/shared-ledger-migration*.test.ts`, `docs/design/shared-ledger.md`。
  完成备份/导入/回执核对演练及下列 V1 验收；部署说明只列所需条件，真正部署须另开 owner 批准的单。
- **C7 [V2]**；oneLine：中心任务/业务 asks/规格报告与命令迁移；deps：[C6]；粗估：1–2 天。
  fileGlobs：`src/shared-ledger/**`, `src/lib/ledger-{write,checks,dag-write,asks,asks-schema}.ts`, `src/manager/ledger*.ts`。
  fileGlobs 续：`src/bridge/local-api/asks.ts`, `tests/shared-ledger-execution*.test.ts`；晚于 C2/C5，复用其文件按此顺序改。
- **C8 [V2]**；oneLine：主场租约、调度意图和出借回写接中心；deps：[C7]；粗估：2–3 天。
  fileGlobs：`src/lib/scheduler-*.ts`, `src/lib/ledger-scheduler*.ts`, `src/lib/ledger-lend*.ts`, `src/bridge/lend*.ts`。
  fileGlobs 续：`src/bridge/local-api/lend*.ts`, `src/shared-ledger/**`, `tests/shared-ledger-scheduler*.test.ts`。
  与 C5/C7 的范围重叠，因此串行；须覆盖失租、崩溃、unknown、活单迁移和 owner 授权，不改 relay 协议。
- **C9 [V2]**；oneLine：共享开卡/改卡/审批 UI 与全流程演练；deps：[C8]；粗估：1 天。
  fileGlobs：`web/features/collab/shared/**`, `web/lib/api/shared-ledger.ts`, `tests/shared-ledger-e2e*.test.ts`, `docs/design/shared-ledger.md`。
  晚于 C4/C6/C8；验证从任一成员网页开 spec 卡、指定主场、借空位、回写审查到 owner 合并的闭环。

V1 验收固定为：

1. 两个不同成员各用自己的 bridge 看见同一导入 feature / 子图 / 卡；两人分别新增 feature 后，对方下一次轮询可见。
2. 两人同时改未绑节点，仅一人成功；另一人 409 保留草稿，重读编辑后可成功；修改已绑节点或卡执行字段均被拒绝。
3. 未入组、错实例、跨项目、成员冒充 owner 均拒绝；入组和共享权限不能带来合并/发版/授权或远控能力。
4. 同批迁移重跑无重复；碰撞、缺引用、敏感字段、pending 提案均阻断；迁后旧 CLI/MCP/autostart 不能改图开节点。
5. 中心重启、断网、回执丢失不假成功；镜像变旧有提示；本机导出不覆盖中心规划，恢复后查询回执再继续。
6. `bun run check` 与 PR CI 按仓库门禁核验；双网页人工验收、部署审批另留证据，不以单测替代。

C6 本轮按批准的替代方案核验 1–5：同一测试进程内起回环中心，peer A / peer B 各用独立状态目录、
实例密钥和成员凭据，真实 HTTP 客户端与写门执行；中心用系统分配的临时端口。证据为
`ledger/reviews/i28-C6-r0/` 的测试日志，不要求截图；两台真机 bridge / 双网页人工演练留给 X13。

## 9. 需要 owner 定的事（默认推荐，不阻塞本稿）

1. **V1 边界**：推荐先共享规划与执行投影，开卡/改卡/调度迁移走 V2；迁规划会暂停后续自动开节点，仍需连续执行的图先只读。
2. **托管和信任**：推荐东京同机独立服务/库、复用 TLS；接受中心可读共享数据，基建实施另行按钮批准。
3. **成员及主场**：推荐 owner 显式登记本人 + 实例 + 项目范围，成员都可改规划；现有卡主场不变，新 feature 默认创建者实例。
4. **共享内容**：推荐 V1 白名单元数据/脱敏摘要；规格全文和报告按内容批准后才上传，原文不默认全库公开。
5. **迁移与不可用策略**：推荐活跃 i28 先 source 只读共享，选无 pending 且可暂停开节点的 feature 试迁 planning；断网只读/草稿、不自动换主场。

## 10. 试部署说明（条件清单，实施须另开 owner 批准的部署单）

本卡只完成本机回环演练，不创建线上服务，不改 relay、反代或 LaunchAgent。公开演练材料统一使用「本机 / peer A / peer B」，
不得包含真实主机地址、域名、成员姓名、目录用户名、token 或私钥。下面的路径和名称均由部署单填入，不从测试记录复制。

### 10.1 机器、入口与隔离

- 中心需要一台可运行仓库指定 Bun 版本的机器、受限服务账号、持久磁盘和足够容纳数据库、WAL、导入包及备份的空间。
  单中心单写；数据库放本地可靠文件系统，不放共享网络盘，不与任何实例的执行台账共用路径。
- peer A、peer B 各保留自己的 bridge、状态目录和实例密钥；成员通过自己的已配对网页访问中心代理。
  登记 team/project/person/instance 和实例公钥，显式发放项目权限；导入身份单独授权，成员不持有 owner 或部署凭据。
- 域名与证书由 owner 在部署单确定。先盘点现有 TLS 终结、端口和服务管理配置；已有反代/TLS 必须复用，禁止另起一套竞争监听。
  中心应用仅监听回环，反代仅开放共享台账接口，启用请求大小、读超时和速率限制；不暴露 SQLite 或管理端口。
- 独立库路径、备份目录、日志目录、启动账号、资源上限、健康检查和停止命令必须明确且可验证。
  库、备份与凭据仅服务账号可读写；日志不记 Authorization、签名体、导入全文或本机私有路径。
  本机端口演练前检查占用，结束执行对应 `bun run sandbox down --root <沙箱根> --port <端口>`；中心只停止本次启动的进程。

### 10.2 备份与迁移前置条件

- owner 批准共享集合、项目映射、默认主场、成员名单和自由文本预览；未知身份、缺引用、敏感命中、pending 提案及在途/unknown 绑卡均阻断。
- 主场迁移前与中心导入前各做一致性快照；备份包含 schema 版本、内容摘要、批次回执及水位，测试恢复到独立路径。
  SQLite 正在写入时不能只复制主库文件遗漏 WAL。中心每日一致性备份另存故障域，试用 RPO 为一天；更小 RPO 另行批准连续备份。
- 主场先装持久写门，再导出白名单包；模式文件更新和台账 `BEGIN IMMEDIATE` 写锁串行。
  记录 batchId、manifestDigest、导入映射、校验结果和备份位置；恢复用同一批次，不重新生成标识绕过 unknown。
- 中心 dry-run 通过后才 commit；核对 feature、全部版本、绑定、卡投影、摘要及来源/中心水位后才开放共享规划。
  两个成员分别通过自己的 bridge 验证可见、轮询、CAS 草稿和权限拒绝后，部署单才可记录试用通过。

### 10.3 中止、断网与回滚

1. 备份或预检失败：停止这次迁移；尚未安装写门时保持原权威。安装写门后失败则保留写门，查清批次状态再处置。
2. 提交超时、中心重启或回执丢失：视为结果未知；恢复连接后先查同 batchId 的持久回执并核 manifestDigest。
   未确认前不宣称成功，不释放本机写门，不重复开节点，不把旧本机规划覆盖中心。
3. 导入后尚未开放成员写入：先取得中心撤销试迁的持久回执，再在本机写锁内恢复 source 模式。
   不能先开本机写门再请求中心撤销；撤销结果未知时继续冻结。
4. 已开放成员写入或已有新提交：禁止直接恢复迁前本机备份。先冻结中心写入、导出中心最新规划与水位、核对全部已确认回执，
   由 owner 另批迁回单，再切路由与本机权威；主场仍运行的旧卡执行记录不得被历史备份覆盖。
5. 中心灾难恢复：冻结入口，恢复一致性备份到独立路径，提升服务代际并核对客户端已确认回执。
   检测序列回退必须告警并重建缓存，核清丢失的提交后才开放；V1 无自动接管，V2 租约须另行撤销和重建。

### 10.4 迁移命令与恢复

在本机创建仅本机可读的 `local-plan.json`，填入已批准的标识；不放 bearer、私钥、真实地址或规格全文。
`summaries` 可填经预览的卡摘要与摘要 digest；留空时不上传规格正文。导入凭据先登记在本机 0600 的凭据文件中，
绑定 `owner:self`、本人实例和准确的 team/project/import 权限；客户端不接受从计划文件传入身份或角色。

```json
{
  "centerId": "<中心标识>",
  "teamId": "<团队标识>",
  "localProject": "<本机项目标识>",
  "projectId": "<中心项目标识>",
  "sourceInstanceId": "<本机实例标识>",
  "featureIds": ["<选中的feature标识>"],
  "batchId": "<本次唯一批次标识>",
  "summaries": {}
}
```

以下每步使用同一个本机状态目录及计划文件；先用隔离测试目录演练。正式迁移须在部署单明确本机目录后执行。

```sh
CLAUDESTRA_STATE_DIR="<本机状态目录>" bun scripts/shared-ledger-import.ts prepare local-plan.json
# 人工逐项检查输出的白名单包，保留其 manifestDigest；改动集合或摘要要重新预览。
CLAUDESTRA_STATE_DIR="<本机状态目录>" bun scripts/shared-ledger-import.ts commit local-plan.json "<已预览的manifestDigest>"
CLAUDESTRA_STATE_DIR="<本机状态目录>" bun scripts/shared-ledger-import.ts activate local-plan.json "<同一manifestDigest>"
# prepare 后、commit 前可本机撤销；commit 后仅在中心确认尚未 activate 时可撤销：
CLAUDESTRA_STATE_DIR="<本机状态目录>" bun scripts/shared-ledger-import.ts revoke local-plan.json "<同一manifestDigest>"
# 若 prepare 在 gating 阶段中断，没有 manifestDigest，可省略最后一个参数。
```

- `prepare` 生成一致性备份并安装写门，输出 C3 白名单预览；备份和恢复日志位于状态目录的 `shared-ledger-migrations/`，权限 0600。
- `commit` 先查同批回执，未知时才做中心 dry-run/单次 commit；回读实存的 feature、历史版本、绑定、卡、step、摘要和水位。
  此时仍是 source，成员不能改写，也未切本机路由。
- `activate` 再核对本机快照和中心回执，中心原子开放 planning 后才装本机 planning 模式和中心项目路由。
  任一回包丢失均保留写门，重跑原命令先查回执；不换 batchId，不以超时作为回滚依据。
- `revoke` 对尚未进入 `committing` 的 `gating` / `prepared` 批次在本机台账写锁内恢复 source 模式，并将日志记为 `aborted`；
  此路径不请求中心，也不需要中心凭据。`prepared` 必须提供人工预览的 digest；`gating` 可不提供。
  此后用新 batchId 可重新选择集合并 `prepare`。进入 `committing` 后必须先查询同批中心回执，只有中心确认 staged 已撤销才恢复写门。
  已开放共享规划不能通过此命令迁回；旧批次重跑不会影响后续新批次。
- 中心 schema 只追加导入生命周期表；升级前已有而缺生命周期回执的批次会拒绝自动启用或撤销，需人工核对历史权威。
