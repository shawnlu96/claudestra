# E2b R1：可验证审查证据与互认分级

> 状态：specRev 1 的设计初稿，待另一家族完整设计审、监工定验收及 owner 明确批准。
> 本文只定义证据导出、接收和判断；合入不启用生产互认，不授权实现接收器、免审或改变合并闸。
> A 是执行实例，B 是仓库实例；第三实例的审查者也必须有自己的认证来源。
> 正式协议以 [E2b 协议](./e2b-protocol.md) 和 [常设授权](./e2b-standing-authorization.md) 为约束。
> P1 正式协议是本卡的前置约束；仓库现有协议稿标题为 P2，不表示本 R1 已获实现批准。
> 全文仅用字段定义和合成标识；不附生产报告、私有台账、个人机器路径或真实密钥。

## 1. 目标、现状与权威

R1 要让 B 能回答：谁在什么订单、epoch、规格和提交上审了什么，结论由什么事实支持，证据是否仍适用于当前卡。
包完整性、身份来源、审查范围、交接资格、互认候选和合并许可分别判断，任何一项成立都不能代替其余项。

当前代码的导出格式是 v1：

- [`review-evidence.ts`](../../src/lib/review-evidence.ts) 组装 manifest、轮次、身份声明和工件。
- [`review-evidence-collect.ts`](../../src/lib/review-evidence-collect.ts) 读取本地台账、报告、模型记录和 Git 范围。
- [`review-evidence-verify.ts`](../../src/lib/review-evidence-verify.ts) 核包内字节、引用、finding 和最终声明；本地 ok 不是 B 的审查票据。
- [`pool-review-proof.ts`](../../src/lib/pool-review-proof.ts) 核现有池审查的意图、订单、claim、签名回执、MCP 票据与原请求。

这些模块是现状依据；本文的 export v2 契约、接收判断与逐卡配置尚未实现。
不能把本地 MCP 入账事件中的 `via:mcp`、body 的 `verified:true`、署名或文件路径升级成独立可验签的跨实例票据。
可信实例的签名是该实例对其内部事实负责的证明；它不能抵抗恶意签发实例或同 OS 用户篡改全部内部记录。
B 仍须信任钉住的实例来源，并做独立抽查；哈希相同只证明字节相同。

## 2. 共同绑定与 head/base 的语义

### 2.1 Subject：真正被审查的对象

每份包有不可变的 `subject`，每轮也保存当时的 subject；不能事后用当前卡覆盖历史值。

| 字段 | 必须证明的事实 |
|---|---|
| `repository`、`pr`、`branch`、`baseRef` | 正规仓库及 PR；baseRef 固定 main；B 从 GitHub 独立读取 |
| `head`、`base`、`mergeBase` | 完整 40 位 commit OID；head 是审查目标，base 是当时 PR main 的 commit，mergeBase 为净 diff 起点 |
| `specRev`、`specDigest` | 正整数版本及规格原文 UTF-8 字节的 SHA-256；specDigest 对应协议的 specSha256 |
| `specArtifactId`、`acceptanceArtifactId` | 规格与验收线的工件引用，版本与原文对应 |
| `taskId`、`homeTaskId`、`orderId` | 执行卡、仓库卡、实际派单；必须核订单归属，不从文件名猜 |
| `delegationId`、`epoch` | E2b 正式委托及当前单调 epoch；不可用审查轮次或 leaseGen 替代 |
| `registrationId` | 非委托 MHO1 的正式登记；与 delegation 二选一，沿用 P2 的无 epoch 登记语义 |
| `materialDigest`、`scopeDigest` | 冻结材料集合及完整范围声明摘要；与派单当时的值对应 |

`epoch` 与拒审接续的 `refusalEpoch` 分列；池订单的 `leaseGen` 也分列，三者不互换。
普通池审查没有 E2b 委托时 delegation/epoch 必须显式为空，仍须核订单及 leaseGen。
每个空值带 `notApplicable` 理由；必须存在而缺失的字段不能用空值、0 或合成 SID 补齐。

### 2.2 Execution：探针运行或 replay 的上下文

每次运行保存 `executionHead`、`executionBase`、`runtime`、`environmentArtifactId`、`purpose: original|replay`。
这些值描述执行位置，不能替代 `subject.head/base`。运行的是另一个提交时必须列出差异、映射依据和限制。
replay 产生的是新证据，不能证明历史运行实际发生，也不能继承原审查者的签名或 PASS。

历史包出现 `round.base == round.head`、同时 `subject.base` 不同，不能据此认定审查范围为空或完整。
接收方应分别记录原字段，要求原派单和审查范围证据，无法确认真正基准就判 `scope_unknown`，回完整审。
v2 每轮使用 `reviewSubject` 与 `execution` 两个明确对象，禁止继续复用含混的 round.base。

### 2.3 范围与冻结材料

完整范围工件列出 startHead、subject base/head、mergeBase、变更路径、文件模式、重命名、二进制及 submodule OID。
保存完整净 diff 原始字节摘要和生成命令；不以路径名单、patch 前缀或 fix diff 冒充整卡审查。
E2b 还要核 startHead→head 的净 diff 与 excludeSurfaces；PR 净 diff 和授权范围是不同检查。
最终审只覆盖修复片段或未闭 finding 的，必须标 `coverage: partial`，不能声称完整跨家族终审。

`materials[]` 包括规格、派单正文、历轮报告、fix 材料及其他实际送审附件；逐项列 ID、版本、字节数和摘要。
集合摘要绑定排序、角色及各项摘要。接收方从冻结派单重算，与报告和提交票据对应。
主体、范围、材料、specRev/specDigest 或 epoch 漂移均使候选失效，即使 head 不变。

## 3. 实例、SID 与实际模型家族

### 3.1 身份与出处链

`instanceKeyId` 为协议规定的完整公共身份：规范 Ed25519 公钥字节 SHA-256 的 64 位小写 hex。
peer 展示名、短指纹、agent 名都不是实例主键；同名换 key 是新主体，旧授权和资格不继承。
公钥从 B 已认证并钉住的 peer 记录读取，包里自带公钥仅供一致性核对。

作者、每轮审查者、导出者、第三实例分别记录：

- 完整 instanceKeyId、agentId、真实 SID、runtime、角色、订单、epoch/leaseGen 和生效时间窗。
- 当时认证入口保存的 session_bind、take_review、submit_verdict 等事件 ID、序号、时间和摘要。
- 来源实例签名的事实证明或可取回的工具票据、签名用途、schema 版本、keyId 和原请求摘要。
- 派单意图→订单→claim/领单→真实 session→提交→入账事件的引用链，标出每一环由哪台实例认证。

不能用 registry 当前 SID 追认历史 SID，不能从 `lend:<peer>:<order>` 展示 SID 推导真实执行 SID。
所有作者都纳入核对，包含实际写入最终 head 的修复者；第三实例审查必须核其自身来源链。
认证传输只证明 A 发来这份材料，不自动证明 A 引用的 C 实例审查；C 的票据另验钉住来源。
若 B 没有可信 C 来源或历史认证事件，标 `source_untrusted`，转 B 独立完整审。

### 3.2 模型证据与统一映射

runtime、配置模型、实际模型 ID、模型家族分开记录。Claude Code 运行时可能接第三方模型，不能据运行时猜家族。
模型工件列 provider/model ID、响应或 turn ID、时间窗、SID、去重规则、采样/截断范围和观察来源。
Claude/Pi 的 response_model 与 Codex rollout 的 request_model 明确分列；后者不能写成供应商响应证明。
缺失 turn_context、时间窗不覆盖实际执行、记录截断、多家族切换或不明 ID 都记 unknown，拒互认。

v2 使用 B/owner 冻结的 `familyMapVersion` 和精确模型映射表，家族值沿用 `claude|codex|<已批准家族>|unknown`。
`gpt-*` 的批准精确 ID 映射到 codex，`claude-*` 的批准精确 ID 映射到 claude；前缀示意不是任意模型的自动白名单。
其他供应商和新增模型必须先登记；不采用 v1 的首字母词法推导作为资格证据。
`family` 与 `model.family` 必须都是同一映射结果；运行时家族声明保存为 `runtimeFamilyClaim`，不混入实际家族。
两者不一致、映射版本不支持或 claim 与观察冲突，拒互认并给出各原值及原因，不能静默改标签。

审查者必须独立于所有实际作者，使用不同真实 SID，实际家族与所有作者不同；换 agent 名或换机器不构成跨家族。
本地拒审例外的 `crossModel:false` 不能被输出成跨家族事实，池审查仍遵守现有跨家族规则。

## 4. Export v2：字节、清单与证明

### 4.1 包与签名覆盖

拟定格式 `claudestra.review-evidence`、`version:2`；不是对现有 v1 实现的改动承诺。
包具有 bundleId、createdAt、expiresAt、producer、subject、scope、identities、rounds、closures、probes、ci、artifacts 和 producerCheck。
manifest JSON 要求 UTF-8、无重复键、版本化严格字段；未知版本或字段语义不明则拒互认。

每项 artifact 必须有唯一 ID、规范相对路径、kind/mediaType、bytes、sha256、provenance 和必需角色。
清单引用按 ID 解析，路径仅定位包内字节。manifest 不把自身列为 artifact，不留循环自哈希。
另存 manifest 原始字节 SHA-256 与整包原始字节 SHA-256；包重压缩时生成新整包摘要，不能冒原包。
逻辑对象摘要使用现有 [`canonical-json.ts`](../../src/lib/canonical-json.ts) 的版本化规则：对象键排序、数组顺序保留。
只接受有限 JSON 值与安全整数，不允许 undefined/NaN 或重复键；规范对象摘要与原始传输字节摘要分列。
传输证明签绑定版本、bundleId、发收双方完整 keyId、subject、订单、epoch、manifestSha256、bundleSha256 及时间窗。
签名用途与现有 lend review ticket、handoff 分开，不能拿一个用途的签名当另一个用途。
新用途需正式协议和 owner 冻结；R1 不自行发行新终审票据。

接收方验钉住公钥及用途后，重算下载原字节、解包后 manifest 和每一项工件摘要；签名不能代替逐项核字节。
同 bundleId、同 subject、同摘要重试返回已有接收事实；同绑定换内容拒绝并保留冲突证据。
旧 epoch、旧授权、旧订单、其他接收实例的有效签名不能用于当前资格。
验签成功也须读取当前授权状态；历史证明可以留存，撤销或过期后不能用于开始新效果。

### 4.2 原文与获准副本

| 字段 | 规则 |
|---|---|
| `originalSha256`、`originalBytes`、`originalRef` | 对原始字节单独计算；受控原件能取回核对，不能只给不可核的哈希 |
| `approvedCopyArtifactId`、`approvedCopySha256` | 获准提供给 B 的副本字节及独立摘要；与原文摘要不混用 |
| `transform`、`approvalRef` | 脱敏/路径替换规则版本、操作者、时间、原件与副本摘要绑定的正式批准来源 |
| `provenance` | original、approved_copy、reconstructed 或 replay；每种来源保留独立 ID |

新格式先形成无个人机器路径的正规证据记录，用引用 ID 和 artifact 相对路径描述来源。
报告内容、探针命令、错误信息和旧台账中的绝对路径也要在正式副本批准中处理，不能只改 manifest.path。
公开文档只给合成数据；原件保留在有权限的证据存储，不把生产数据或密钥复制进公共仓库。
原件含秘密且没有合法核验渠道时拒绝出口或拒互认，转完整审；不以脱敏需要为理由弱化材料闸。

副本批准只决定该副本能否作为材料送达，不证明审查结论或等同原文。
既有被材料闸拒绝的原文必须保留原摘要和拒绝记录，不能改写、删附件、改名后重投规避策略。
改写报告需要正式新材料版本和重新判断；旧票据只证明旧摘要，不能为改写副本自动背书。

### 4.3 原始与重建来源

原始工件记录产生工具、实例/SID、订单、时间、执行记录 ID 与生成时摘要。
重建工件列 `reconstructedFrom[]`、输入摘要、重建命令、环境、操作者和新生成时间；无法追溯即 unknown。
reconstructed/replay 的字节即使与原件相同，也不能证明原执行、原身份或原关闭发生。
它们只能辅助独立复核；必需原始运行、票据或关闭证据缺失仍拒资格，不回填一个假的 original 标志。

### 4.4 安全解析与完整性诊断

只读暂存后解析；不执行报告里的命令，不加载脚本，不让包指定宿主路径或触发台账写入。
拒绝绝对路径、..、反斜杠逃逸、NUL、重复 ID/路径、symlink/hardlink、设备、非普通文件、清单外文件与大小溢出。
拟定默认限额：manifest 1 MiB、工件 20 MiB/项、256 项、解包总量 64 MiB；压缩与解包均计量，超限拒互认。
调整限额另需配置审批，不截断后继续判断；JSON、签名和压缩解析错误保留 reason。

完整性结果分别列 `expectedCount`、`retrievedCount`、`verifiedCount`、missingIds、badHashes、unresolvedRefs 和 provenanceProblems。
这三个计数只统计 artifacts，manifest 的取回与验签/哈希状态单列；包条目计数（含 manifest）另列，不能混用口径。
既有包原字节及生产方结论原样保存；接收方诊断放在独立记录，不往原 manifest 添字段并当原件重新验签。

## 5. 审查轮次、finding、关闭和票据

### 5.1 每轮必需事实

每次派审都记录 reviewId、round、reviewSubject、执行上下文、orderId/leaseGen、审查者、实际模型证据和材料摘要。
保留 completed、changes、block、refused、failed、cancelled、incomplete、skip 等实际状态及原因，不能过滤失败轮制造连续 PASS。
轮次顺序来自可核事件序号和订单链，不由文件名或导出数组决定。
全量派审清单与全量提交清单相互对账；缺轮、缺提交或未知尝试使历史不完整。

每个 finding 保留稳定 findingId、问题分类 family、severity、描述、原探针、位置和证据引用。
finding.family 是问题分类，不是模型家族。结构化计数由 B 重算，与报告、原提交和票据逐项比较。
降级记录独立列批准来源、事件、原严重度、新严重度和后续卡；不能抹掉历轮 P0/P1。

关闭记录包含 raisedReviewId/findingId、fixCommit 或 sameHead 理由、关闭 disposition、复核订单/轮次/审查者及探针证据。
必须证明复核派单确实包含该旧 finding，复核对它给出明确结论并绑定正确材料与 subject。
「下一轮没写」不是独立关闭证明；若沿用现有遗漏式关闭算法，还须核旧 finding 完整送审、完整复核记录及对应来源。
重开 finding 继续用同一 ID；P2 保留项列后续跟踪，不冒 closed。缺结构化 finding 的人工轮不能自动推出关闭。
任何当前未闭 P0/P1 使互认候选拒绝；失败/取消/skip 不计成功，也不能关闭 finding。
已正式重新派单且完成复核的历史失败可保留诊断；它不能覆盖未结尝试或填补必需证据缺口。

### 5.2 人工报告与 MCP 票据分列

| 类型 | 能证明什么 | 不能证明什么 |
|---|---|---|
| humanReport | 原文/副本及其 SHA、署名声明、描述与本地测试结果 | 已领单、真实 SID、验签入账、跨家族自动资格 |
| mcpSubmissionRecord | 认证入口保存的原工具调用及其绑定 | 仅有 via:mcp 字段不能证明外部可验签票据 |
| signedReviewTicket | 现有正式用途下签名与 payload、take、订单、session、gen 等字段一致 | 不能证明未覆盖的 base/specDigest/epoch；不能扩展它的权限 |
| admissionReceipt | 对应实例正式入账事件及签名回执 | 不能代替 subject、材料和当前授权核验 |
| consumerAssessment | B 独立证据核验及抽查结果 | 不是 submit_verdict，也不是生产 PASS 或合并许可 |

现有池票据依 [`pool-review-proof-ticket.ts`](../../src/lib/pool-review-proof-ticket.ts) 原字段与用途核验。
必须取回原接收请求，重算去 ticket 的 logical payload 摘要，核 take、claim、gen、SID 和签名入账回执。
原请求 transportSha、逻辑 payloadSha、报告原文摘要及副本摘要分别保存，不能互相替代。
v1 ticket 未覆盖 base/specDigest/委托 epoch，v2 必须从认证派单和正式委托证明补齐这些绑定；不能往旧票据伪加字段。
人工 CLI lend submit、no_order、裸 peer verdict、只有报告路径等按原人工来源处理，不能补造假的 B 票据。
若没有现有正式票据及来源链，包仍可用于人工完整审参考，但 consumerReady 必须为 false。

## 6. 探针和当前 head 自身 CI

### 6.1 探针事实

每项 probe 记录 probeId、绑定 reviewId/findingId、subject、execution、purpose、命令 argv、shell 类型及相对 cwd。
环境工件列 OS/架构、runtime/工具版本、依赖锁摘要、沙箱标识、必要环境变量名和非敏感值、输入数据来源。
秘密值不导出；影响复现且无法核验的隐藏输入要明确列缺口，不声称可复现成功。
保存开始/结束时间、退出码、signal、timeout、实际 status、stdout/stderr/截图/其他产物 ID、摘要与原始出处。
进程失败、取消、skip、未运行、缺工件或日志截断均不算成功；exit 0 也须满足探针预期断言。
报告引用截图或测试输出时每个引用都须解析到真实工件；`probeArtifacts:[]` 与文字「见截图」不能算覆盖。
独立 replay 用 B 自己的新 probeId、SID 和环境记录，与原 probe 并列，不覆盖原结果。

### 6.2 CI 绑定与新鲜度

每个 CI 事实记录 repository、workflow ID/路径、workflow commit、event、runId、runAttempt、job/check ID、check 名称。
还须记录 headSHA、base SHA（适用时）、开始/完成时间、status、conclusion、日志/工件摘要及可查询的来源引用。
B 从 GitHub 认证渠道重读实际 run/check，核可信 workflow 和必需检查集合，不能只信 A 的 CI 声明或徽章。
只认当前 PR head 自身的 completed/success；base/main CI、别的 PR、旧 attempt、合成 merge ref 的绿灯不替当前 head。
failed、cancelled、skipped、neutral、timed_out、action_required、missing、unknown 和未完成都挡资格。
同名检查也须核其 workflow、runAttempt 和产生来源，不能拼不同 run/head 的工件充一份成功运行。

本仓库三项最终检查以当前 [CI workflow](../../.github/workflows/ci.yml) 为准：
`typecheck + test + guard`、`web typecheck + lint`、`desktop typecheck + cargo test`。
第一项还要求四个 shard 的 head、工件与覆盖对账通过，不能把某个 shard 绿视作总闸绿。
最终必需集合由 B 的现有配置决定；本地 `bun run check` 是仓库自查，不能替代上述最终 head 的 CI。
纯 main carry 后仍核新 head 自身 CI；本文不豁免 UI owner 截图验收。

## 7. B 接收与分级判断

证据判断模块的拟定 Interface 是只读 `assess(bundleBytes, trustedContext) → assessment`。
trustedContext 来自 B 的订单/协议/授权/Git/CI 事实；包内报告只能当数据，不能提供信任配置。
此 Seam 把格式、字节、来源、范围与新鲜度的复核集中在一个 Module 内；R1 不实现 Adapter 或台账写口。
handoff 接收及其持久事务属于 P2，assessment 只能作为它引用的一个结果。

核验依次进行，任何拒绝都保留具体 reason 与工件 ID：

1. 认证实例、钉住 key、签名用途/时间、接收者绑定、当前授权、订单与 epoch；核重放和冲突。
2. 原包/manifest/逐项字节、引用完整性、原文与副本批准、原始与重建来源，建立缺项诊断。
3. B 独立读 PR/head/base、规格摘要、冻结材料和整卡范围；逐轮核 subject 与 execution。
4. 认证 SID、模型来源与统一 family 映射，订单→领单→提交→票据→入账链及独立审查身份。
5. 全轮 findings、关闭证据与计数；核覆盖范围、探针真实产物和当前 head 自身 CI。
6. 用完整 diff 分类风险面，检查逐卡配置与独立抽查要求，输出结果；不写 PASS、reviewSeq 或推进阶段。

输出包括 consumerInstance、bundle/manifest SHA、绑定摘要、配置 revision、核验时间、失效时间及 reasons[]。
分别输出 `integrity`、`provenance`、`coverage`、`freshness`、`riskClass`、`producerReady` 和 `consumerReady`。
producerReady 只保留导出方原声明；consumerReady 由 B 自己算，不能赋值为 producerReady 或本地 ok。
consumerReady=true 只表示可提议证据核对与独立定向抽查；当前流程仍完整审查，未来也不等于生产终审。
decision 仅为 `rejected|full_review_required|eligible_for_spotcheck`，不提供 `pass` 输出。

### 7.1 风险分级

| 面 | 允许提出的审查方式 |
|---|---|
| 普通文档 | 完整证据核对和 B 独立定向抽查；涉及安全/授权规则的文档按核心面 |
| 隔离测试 | 完整证据核对和独立抽查；能改 CI 闸、共享 fixture 权限或调用宿主的按核心面 |
| 叶模块 | 必须证明无核心面写入、权限效果或调度依赖；否则完整审 |
| UI | 完整证据核对与独立抽查；UI 的鉴权、授权入口仍核心面，owner 截图验收保留 |
| 身份、鉴权、权限、台账写入 | B 独立完整审 |
| 授权租约、出借协议、整卡协议 | B 独立完整审 |
| 调度、合并、部署、CI 门 | B 独立完整审 |
| 宿主 shell、密钥、security | B 独立完整审 |

分类看实际效果、调用关系及完整 diff，不按扩展名、路径标签或 A 自报低风险决定。
混合卡任一改动触核心面则整卡 B 独立完整审；分类不明、未知依赖或核心面证据不足也完整审。
抽查由 B 独立审查者在正确 subject 上选择：至少覆盖每条验收线的证据、每个变更路径及全部关闭 finding 的关键断言。
B 可加选攻击面和重放探针，A 不决定抽查结果；抽查不足、有新 P0/P1 或结果与原报告冲突则退完整审/修复。
抽查只生成 B 的核验材料，不制造现有订单未产生的 PASS；生产审查入账仍走正式入口。

### 7.2 Head 失效及唯一沿用例外

head 改变立即使既有候选失效；重新导出、接收和核验，不能只换 manifest.subject.head。
仅原 canonical 纯 main 完整净 diff 证明可按现有正式规则沿用原有效审查事实。
必须核原有效 PASS 来源、仓库/origin、固定 mainHead、双父链、完整原始净 diff 字节及 SHA、证明事件和授权。
不能用 patch-id、changedFiles 相等、截断输出、replay 成功或 A 自报 carries 代替 canonical 证明。
冲突解决、额外提交、submodule/binary 内容变化、非 main 父提交、链缺口、切换 baseRef 或 spec/材料变化均拒。
base OID 的变化也须由同份 canonical 纯 main 证明覆盖且现有路径允许，不能自由换基准；读 Git 失败均拒。
MHO1 跟随与本地合并有各自 canonical 实现；只允许现有路径原本支持的证明，不能互换算法扩大权限。
证明函数本身不造 PASS，不开启未接线能力；B 独立重算且仍核新 head CI、当前授权及未撤回状态。
沿用记录保留 old/new head、原/新 base 和每跳来源，不篡改旧报告或签名；迁移后的资格与审批重新绑定当前 subject。

## 8. 模式、逐卡授权和退回

| 模式 | 实际效果 |
|---|---|
| off（缺省或配置损坏） | 不据 R1 选择审查路线；B 按现有完整审。可人工导出诊断，导出不打开互认 |
| observe | 可只读核包、记录独立诊断与拟议抽查；不改变派审、订单、材料闸、阶段、合并或部署 |
| on（未来需另批实现） | 仅对有效逐卡低风险许可提出核对与 B 独立抽查；证据缺项退完整审。现有生产闸继续核 |

mode 不继承 MODELX 的开关，项目 on 也不授权所有卡。对已有卡追认默认拒，试行只限获批低风险新卡。
off/observe 的 consumerReady 一律为 false；observe 可另列 wouldBeEligible 诊断，不得将它当可消费的资格。
未来 on 也必须满足有效逐卡许可及全部核验要求，才可形成抽查候选；独立抽查仍须完成，核心面始终完整审。
拟定 `RecognitionCardGrant` 由 B 受权入口签发，保存 approvalId、监工与 owner 批准引用、配置 revision、mode。
它还绑定 A/B 完整 keyId、仓库、卡/PR、订单、delegation/registration、epoch、head/base、specRev/specDigest。
许可列完整 scope/materialDigest、bundle/manifest SHA、风险面、允许核对/抽查动作、startsAt、expiresAt、revokedAt 和原因。
不允许 wildcard 卡、无限有效期、自动续期或把模式更改当 owner 批准。监工定验收，owner 决定生效规则及范围。
任何必要绑定变更使旧许可失效，重核批准；许可只能缩小正式授权，不能放宽 excludeSurfaces 或现有权限。

B 在每次开始核验/抽查以及消费结果前重读许可与配置；缓存 ready 不具有持续授权。
同时重核当前卡/PR 的 subject、订单、epoch、材料/范围、未闭 finding、交接/撤回状态及 head 自身 CI，防止核验后漂移。
assessment 绑定这份快照；原有正式入口在产生效果前按自身事务与闸再核，不能凭旧快照越过当前状态。
撤销、切 off、撤回交接、授权过期或来源失信后停止新效果，撤掉未消费候选；在途与 unknown 按 P2 对账。
未知结果保持占位/冻结并交正式对账，不能假记取消成功、自动合并或重发写效果。
撤销保留历史原件和诊断，不能为了降低完整审的工作量继续消费旧候选。

来源不可信、缺工件、subject/范围/材料/epoch 漂移、失败/取消/skip 或任何无法核验的条件：拒绝互认，B 独立完整审。
完整审的合法入口仍须先满足有效 handoff 等 P2 条件；有交接缺口时保持 pending，不能用完整审回退绕过接收闸。

### 8.1 MODELX 与材料闸

provider policy 拒审交现有正式 MODELX：有效本机批准、mode on、冻结材料重核、新拒审 epoch、按原规则换家族。
本 R1 不把「来源不可信」或「证据缺项」改成拒审豁免，不安排同模型再试、不偷偷减少材料或重写报告。
MODELX 产生的同家族例外必须明示 approvalId、refusalEpoch、materialDigest 和 crossModel:false，不能获得跨族互认资格。
池审查没有同家族 MODELX 豁免记录；本机例外不可搬成 peer/池审查自动证明。
新审仍拒、批准撤销、材料/head/specRev 漂移或 runtime 不可用仍按原流程停手/退人工。
证据核验、重建和 replay 必须受同样材料与权限闸；R1 不成为拒审旁路。

## 9. 与正式 HandoffEvidence 共用而不混淆

identity/provenance 与 P2 共用完整实例 keyId、真实 SID、认证来源及 subject/specDigest；不重复发明身份主键。
HandoffEvidence 引用 bundleId 和 manifestSha256，报告引用 artifactId/sha256；不传个人机器路径。
证据下载成功或 assessment ready 不能代替经 peer 正式送达、B 持久接收并回执的交接。
未收到有效交接不激活自动卡 PR、不进队列；无效/缺项/已撤回的交接不激活 B 后续效果。
交接资格不是 PASS、互认或 B 合并许可；A 本地 P1 不能由 B 旧 PASS 盖掉，反向亦然。
head 继承只走 §7.2 的 canonical 纯 main 证明；旧 handoff 或旧 review 不能覆盖新 subject。

交接撤回先停止新效果，可靠回执、撤回墓碑、在途效果与 unknown 对账以 P2 §2.4/§6.4 为准。
区分 withdraw_received（停止新效果）与 withdraw_confirm（已结清）；迟到交接先核墓碑，不能恢复撤回资格。
R1 只描述消费这些事实的约束，不提前实现 receiver、激活 PR 或修改 P2 的持久事务/序列规则。

## 10. 限定试行与真实格式演练的设计输入

2026-10-06 的明确批准仅覆盖最多 3 张低风险新卡：证据核验、B 独立定向抽查、最终 head 自身 CI 均不省。
核心面完整审、合并闸不改，材料缺项立即回完整审；这不是永久互认、产品改动或实现授权。
私有试行名单、批准记录和生产包不进入本文；试行登记/数量由 B 的正式受控记录核验，R1 文档不新增或消耗试行名额。
未来 on 还须另批实现及逐卡配置；不能用这次有限试行反推默认 on。

PR774 的实际格式演练作为输入事实：原 partial 包取回 10/13 项，manifest 和整包 SHA、9 项实际 artifact 字节/hash 一致。
identity、submission、events 三项缺失；生产方 ready:true 不能证明完整资格。
这说明「下载到部分且已有工件 hash 正确」与「全部必需出处可核」是两项独立检查，必须同时保留结果。
原包 probeArtifacts 为空而报告引用测试截图，应列 unresolved probe references，不补造截图或探针成功。
round.base/head 与 subject.base 的差异依 §2.2 诊断，不能把运行/replay 基准写成审查基准。
family 与 model.family 的分歧依 §3.2 映射核查；自报 family/verified 不能补身份链。
正规引用 ID 与相对路径只能在新的获准格式产生，不能改已有被闸拒原文绕闸。
上述事实不表示演练已取得 B 终审；不为方便审查创造假的 B 票据、新终审或补齐历史事实。

## 11. 负例验收表

以下全用合成 fixture，默认断言 consumerReady=false、无 PASS/自动 PR 激活/合并/部署效果；另外核精确原因和保留诊断。
同摘要合法重试可返回旧接收事实，但必须再次核当前授权，不能恢复已失效资格。

| 负例 | 接收方预期与核验点 |
|---|---|
| 两实例同名/短指纹相同但完整 key 不同 | identity_mismatch；钉住 key 不同，不继承授权 |
| body 改 instance/family/verified 或伪 SID | provenance_invalid；认证事件和 session/ticket 绑定不变 |
| 第三实例票据只由 A 签转述，无 C 可信来源 | source_untrusted；A 传输签名不冒 C 工具认证 |
| 同订单换 SID/gen，借 registry 当前 SID 填历史 | order_binding_mismatch；真实 take 与 submit 全链核 |
| 同包重放到另一 B/卡/订单/epoch | replay_binding_mismatch；签名接收者、订单和当前 epoch 核 |
| 同 bundleId/序号换 manifest 或内容 | content_conflict；保存原摘要与冲突，正式协议冻结 |
| 旧授权已过期/撤销，包尚未过期 | authorization_invalid；当前许可重读，停新效果 |
| 错 head、错 base、错 specRev/specDigest | subject_mismatch；B 独立读卡/PR/规格，不能信 body |
| head 不变，材料/范围/主体/epoch 变化 | binding_drift；候选和逐卡批准失效 |
| round.base=head 冒整卡基准，replay head 冒 subject | scope_unknown；保留原值，分开 execution/reviewSubject |
| 修改正文并重算 hash，自带新公钥签包 | signature_or_source_invalid；公钥只能取自钉住来源 |
| manifest hash 假值、缺项或同 ID 拼不同工件 | integrity_invalid；原包及所有实际字节独立重算 |
| 工件 hash 相同但来自另一订单/运行 | artifact_binding_mismatch；不止核 hash，还核出处与绑定 |
| 改写报告仍引用旧票据/旧原文 hash | approved_copy_invalid；原文/副本分别 hash 与批准绑定 |
| 包含个人路径，删被拒附件后重投 | material_gate_required；保留原材料摘要和拒绝，禁止规避 |
| 重建/重放标 original，缺原始事件 | provenance_unknown；重建不能补历史执行/票据 |
| 报告引用截图，probeArtifacts 为空/截图缺失 | missing_artifact；列全部 unresolvedRefs |
| exit 0 但断言失败，或失败/取消/skip 当成功 | probe_not_success；核 status、断言及真实工件 |
| 隐去失败轮、缺 finding、遗漏旧 finding 当关闭 | history_incomplete；全量尝试对账及明确关闭证据 |
| P0/P1 未闭，另一侧旧 PASS 或人工署名补 | findings_open；不互相覆盖，不补造 MCP 票据 |
| runtime=claude 但实际第三方/unknown，映射冲突 | family_unverified；family/model.family 统一且可核 |
| 换机器/agent 名但实际作者和审查同家族 | cross_family_missing；真实 SID 与所有作者家族核 |
| MODELX 同家族例外写成跨族或用于池互认 | recognition_rejected；保留 crossModel:false，按原 MODELX |
| 文档/UI 标签掩盖鉴权、CI 门或宿主效果 | full_review_required；完整 diff/依赖分类核心面 |
| 旧/main/merge-ref CI、同名假 check、混 run 拼工件 | ci_binding_invalid；当前 head、自身 runAttempt 与可信 workflow 核 |
| CI failure/cancel/skip/neutral 或 shard 缺失 | ci_not_success；现有三项检查与分片完整覆盖 |
| head 更新，只改 manifest；净 diff 截断/submodule 漏项 | head_invalidated；重核 canonical 完整字节/父链 |
| 无 handoff、撤回先到、unknown 未结却用 ready 激活 | handoff_ineligible；保持 pending，核墓碑及 P2 对账 |
| symlink/../重复路径、压缩膨胀或 JSON 重复键 | package_unsafe；只读解析拒绝，无宿主执行 |
| off/observe 配置、许可撤销但沿用缓存 ready | mode_or_grant_invalid；现有完整审，新效果为零 |

正例也必须有：完整合成包、真实验证的合成订单/签名链、明确异家族、全部工件、独立抽查及 head 自身 CI。
正例预期只到 eligible_for_spotcheck；在本设计阶段以及 off/observe 模式，生产路径仍完整审。
另测 mixed 核心面始终完整审、合法 canonical carry 留原件且核新 head CI、有效交接仍不直接获得 PASS。

## 12. 设计验收与后续批准

监工按本节定验收，执行者只起草；本卡不自行宣称另一家族审查或 owner 批准已完成。

1. 另一家族在本设计最终 head 上完整审查：身份/来源、subject、关闭、包/签名、风险分级、失效/撤回与负例逐项核。
2. 记录真实审查订单、SID、实际家族、报告原文/获准副本与 findings；修复复验沿用 findingId，不造票据或终审。
3. 仓库自查跑 `bun run check`，检查文件范围、长度、Markdown 引用及无生产数据/个人路径/真实密钥。
4. 最终提交的自身 CI 由现有合并闸核三项检查；旧 head 和本地 PASS 不能替代，CI 未完成不称验收通过。
5. 监工明确确认验收，owner 明确批准最终规则；批准引用绑定最终 head、specRev/specDigest、范围及模式。
6. 后续实现单另行授权，才能实现 export v2/receiver/配置；先完成负例、回退与撤销验收，再讨论生产开关。

本设计合入后生产默认 off；有限试行依原受控批准执行。永久互认及任何免审、MODELX/材料闸或生产流程变更均未获授权。
