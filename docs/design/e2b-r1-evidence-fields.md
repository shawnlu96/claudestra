# E2b 讨论输入：R1 审查证据字段草案

> 状态：R1 已由 B 侧于 2026-10-07 14:16Z 冻结（head `9a2052b83e3c4a233d3db450426074accdd4f37b`，blob `8c8594c3`，sha256 `c8881904fc151093fb6a4f1f8409bf89151b50b7784e14b87648ed790ec3ee9d`）；blob 开头「待…批准冻结」是冻结前写的自述。P2 blob `c2143324` / `55b81b56` 同批冻结。
> 冻结只冻设计。**本文是讨论输入，不授权实现**；冲突处按下列修订：
> 本文按 R1（`docs/design/review-evidence-recognition.md`）与 P2（`docs/design/e2b-protocol.md`、`docs/design/e2b-standing-authorization.md`）改写，冲突处一律采信 R1 / P2，不改协议。
> 本文只把 R1 的字段落到现有代码上：每个字段的含义、现在由哪个模块产出（没有的标「设计，未实现」）、谁签、怎么核、缺了怎么办。
> 签名用途、取包通道、获准副本的批准来源、开关都**另批**；本文不定。
> 角色沿用 [现有入口盘点](./e2b-current-entry-inventory.md)：B = 仓库方（收证据），A = 执行方（出证据）。

## 0. 基础与边界

- 起点是本机 `ledger review-export` 产出的 v1 证据包：命令 `src/manager/ledger-review-export-cmd.ts`，
  纯函数 `buildBundle`（`src/lib/review-evidence.ts`），读取 `collectSource`（`review-evidence-collect.ts`），
  自检 `verifyBundle`（`review-evidence-verify.ts`），关闭计算 `computeClosures`（`review-evidence-closures.ts`）。
  v1 草案文本在台账目录 `ledger/docs/review-evidence-v1/`，不在仓库里；本文按代码实际产出对照。
- 盘点 §2.2（审查领单、票据）和 §4（旧回执 / 无票据结论）是本文的事实前提：池审查票据链已实现，
  旧端、CLI、no_order、裸 peer verdict 仍走人工，R1 不回填自动证明。
- **R1 只是证据格式。** 它不导入结论、不写接收方台账、不标 merge-ready；互认范围、CI 闸、合并许可另外冻结。
- 所有「缺了怎么办」默认 **fail closed**：拒收或退人工，不降级成「只是少个字段」，不由接收方猜补。
- **必需证据缺失 ≠ 不适用。** 缺 `bundleSha256`、真实 SID、领单事件、模型证据，都记生产方自检 `producerCheck.ready=false` 并列缺项诊断，
  **不标 `notApplicable`**。`notApplicable` 只给 R1 §2.1 说的「按定义为空」的字段（如非委托卡的 delegationId / epoch）。

## 1. 通用规则（每个字段都适用）

| 规则 | 内容 | 现有依据 |
|---|---|---|
| 公共引用 ID | 包内互相引用一律用 artifact `id`，不用路径；跨实例引用用卡号、orderId、PR 编号、完整 SHA | v1 `Files.add` 返回 id（`review-evidence.ts:124`） |
| 相对路径 | 包内路径只许相对、无 `..`、无符号链接 | 已实现：`safeRelPath` / `plainFile`（`review-evidence-verify.ts:24-41`） |
| **对外内容不出现绝对路径** | JSON 字段值、报告、回执里的本机路径不对外送；原件不改，对外只给获准副本（§6） | **设计，未实现**：v1 自检只查文件路径，不扫内容 |
| 原始字节哈希 | `sha256` 对交付的原始字节算；manifest 不把自身列为 artifact，不留循环自哈希（R1 §4.1） | 已实现：`Files.add`（`review-evidence.ts:127`） |
| 不加强声明 | 台账没有的就写 null / `unknown`，不推断成更强的说法 | 已实现：`buildBundle` 头注释与 `modelClaim` |
| 未知值不归一 | 认不出的家族、runtime 记 `unknown`，不默认成 claude / codex | 已实现：`reviewCallerOf` 拒 Pi；v1 `modelFamily` 的前缀推导在 R1 下**不作资格证据**（§2.4） |

## 2. 字段

列说明：**来源**写产出它的现有模块；**签**写谁的密钥覆盖它；**核验**写 B 怎么核；**缺失**写 fail-closed 行为。

### 2.1 包与出证实例

| 字段 | 含义 | 来源 | 签 | 核验 | 缺失 |
|---|---|---|---|---|---|
| `format` / `version` | 字面量 `claudestra.review-evidence` / `2`（R1 §4.1） | `buildBundle` 写 1 | 传输证明覆盖 | 精确匹配 | 不认的版本拒收 |
| `bundleId` / `createdAt` / `expiresAt` | 出证方生成的唯一 ID、UTC 时间、失效时间 | `bundleId` / `createdAt`：`ledger-review-export-cmd.ts:30`；`expiresAt` **设计，未实现** | 传输证明覆盖 | 同 ID 同摘要幂等，同 ID 不同字节拒（`content_conflict`） | 拒收 |
| `manifestSha256` | manifest **原始字节**的 SHA-256 | v1 命令返回值里已有（`ledger-review-export-cmd.ts:35`），不进 manifest | 传输证明覆盖 | B 对下载的原字节重算 | 缺 → `ready:false` |
| `manifestCanonicalSha256` | 严格解析后的**规范对象**摘要，版本域 `claudestra.cjson/v2`（R1 §4.1.1） | **设计，未实现**：现有 `canonical-json.ts` 不做严格前置校验，不复用 | 传输证明覆盖 | 与 `manifestSha256` 分列，互不替代 | 缺 → `ready:false` |
| `bundleSha256` | 整包原始字节摘要；重压缩即新摘要，不能冒原包 | **设计，未实现**：归档格式另批，v1 只写目录 | 传输证明覆盖 | B 对下载的整包重算 | **必需证据缺失**：`ready:false` + 缺项诊断，不标 `notApplicable` |
| `producer.instanceKeyId` | A 实例完整 key id：规范 Ed25519 公钥字节 SHA-256 的 64 位小写 hex（R1 §3.1、P2 §2.1） | **设计，未实现**：现有 `keyFingerprint` 只取前 16 位四位分组（`instance-key.ts:25`），只能展示 | — | **公钥取 B 钉住的记录**（`peer-keys.ts` `PinnedPeerKey.publicKey`）重算 key id 比对；包里自带公钥只作一致性核对 | 拒收；短指纹不能当身份 |
| `producer.exporter` | 导出命令的执行者 | `c.deps.actor` | — | 只作记录，不作授权依据 | 可空 |
| `transferProof` | 传输证明：签绑定版本、bundleId、发收双方完整 keyId、subject、订单、epoch、`manifestSha256`、`bundleSha256` 及时间窗（R1 §4.1） | **设计，未实现**；`SIGN_PURPOSES`（`instance-signature.ts:43`）没有这个用途。**用途待正式协议 + owner 冻结，批之前不签** | A 实例（批准后） | 验钉住公钥及用途后，仍逐项重算字节；签名不代替核字节 | 批准前不出；包仍可作人工完整审参考，`consumerReady` 由 B 算、必为 false |

说明：签名只证明出自 A 实例，不证明 A 内部哪个 session 干了什么；那部分见 §2.3 的来源记录。
签名用途与现有 lend review ticket、handoff 分开，不能拿一个用途的签名当另一个用途（R1 §4.1）。

### 2.2 审查对象：subject 按 R1 §2.1

subject 按 R1 §2.1；base 与 mergeBase 分列。每份包有不可变 `subject`，每轮另存当时快照 `reviewSubject`，不能事后用当前卡覆盖历史值。

v1 的 `subject.base` 来自 `--base`、`deliver_scope` 记录的 PR baseRefOid、或 `git merge-base`（`review-evidence-collect.ts:98-104`），
每轮 `rounds[].base` 是另一次 `merge-base <head> origin/main`（`review-evidence.ts:167`）。两者口径不同却同名；R1 §2.2 禁止继续复用 round.base。

| 字段 | 含义 | 来源 | 核验 | 缺失 |
|---|---|---|---|---|
| `subject.repository` / `pr` / `branch` / `baseRef` | 正规仓库、PR、分支；`baseRef` 固定 `main` | v1 只从 `task.pr` 解析 repo 与 PR（`review-evidence.ts:223`）；`branch` 在卡上（`task.branch`）；`baseRef` 字面量 | B 从 GitHub 独立读取 | 拒收 |
| `subject.head` | 审查目标，完整 40 位 | `task.headSHA` / `--head` | 等于 PR 当前 head；不等即失效（唯一例外 R1 §7.2） | 拒收 |
| `subject.base` | 当时 PR main 的 commit，完整 40 位 | v1 `baseOf()` 的 `deliver_scope` 分支（PR baseRefOid，`review-evidence-collect.ts:100-101`）；**其余分支不满足此定义** | B 独立读 PR 当时的 base | 拒收 |
| `subject.mergeBase` | 净 diff 起点，完整 40 位 | v1 `baseOf()` 的 `git merge-base` 分支（`review-evidence-collect.ts:102-103`） | B 用 Git 重算 | 拒收 |
| `subject.specRev` / `specDigest` | 规格版本，与规格原文 UTF-8 字节的 SHA-256（= P2 `specSha256`） | `task.specRev`；`specDigest` **设计，未实现**（v1 只在 artifact 清单里有 spec 的 sha256） | 与 B 卡规格版本及 B 发出的摘要比对 | 拒收 |
| `subject.specArtifactId` / `acceptanceArtifactId` | 规格与验收线的工件引用 | v1 `specArtifact` / `acceptanceArtifact`（`review-evidence.ts:228`，`acceptanceOf()` `:241`） | 版本与原文对应 | 拒收 |
| `subject.taskId` / `homeTaskId` / `orderId` | 执行卡（A 卡）、仓库卡（= P2 `bTask`）、实际派单 | `taskId`：v1 有；`homeTaskId`、`orderId`：**设计，未实现**（依赖 A 侧委托表） | 核订单归属，不从文件名猜 | 拒收 |
| `subject.delegationId` + `epoch`，或 `registrationId` | E2b 正式委托及当前 epoch；非委托 MHO1 用 `registrationId`，二选一 | **设计，未实现**（P2 §2.2、§6.7） | B 核当前 epoch 与委托状态 | 非适用的一侧显式 null + `notApplicable`；该有而缺 → 拒收 |
| `subject.materialDigest` / `scopeDigest` | 冻结材料集合、完整范围声明的摘要 | **设计，未实现**；MODELX 已有材料摘要冻结（`scheduler-model-wiring.ts`，盘点 §2.2） | 与派单当时的值对应 | 拒收 |
| `refusalEpoch` / `leaseGen` | 拒审接续 epoch、池订单租约代数；与 `epoch` 三者**分列不互换** | `refusalEpoch`：MODELX `beginRefusalEpoch`；`leaseGen`：出借单 `gen`（`pool-review-proof-ticket.ts:16`） | 各核各的 | 不适用即 null + `notApplicable` |

每轮的当时快照与执行上下文：

| 字段 | 含义 | 来源 | 核验 | 缺失 |
|---|---|---|---|---|
| `rounds[].reviewSubject` | 该轮当时的 subject 快照（含 head、specRev 等），取代 v1 的 `rounds[].head` / 进 review 时 `specRev` | v1 `rounds[].head`、`specRev`（`review-evidence.ts:167-168`）只是其中两项 | 最终通过轮必须与 `subject` 一致（或经 R1 §7.2 canonical 证明沿用） | 最终轮缺 → 拒收；历史轮缺 → 历史不完整 |
| `rounds[].execution` | `{commit, parents[], ref, base, runtime, environmentArtifactId, purpose: original\|replay}`，实际 checkout / 执行的上下文（R1 §2.2） | **设计，未实现**；v1 的 `rounds[].base` **删除**，不迁移成它 | 描述执行位置，不替代 `reviewSubject`；与 head 不同时要列差异与映射依据 | 无法确认真正基准 → `scope_unknown`，回完整审 |

### 2.3 范围与冻结材料（R1 §2.3）

| 字段 | 含义 | 来源 | 核验 | 缺失 |
|---|---|---|---|---|
| `scope.artifactId`（完整范围工件） | startHead、subject base/head、mergeBase、变更路径、文件模式、重命名、二进制和 submodule OID、完整净 diff 原始字节 sha256 及生成命令 | v1 只有 `scope.paths`（`review-evidence.ts:229`）和 `scope.json` 的路径名单与命令（`:220-222`）；其余 **设计，未实现** | B 重算净 diff 原字节摘要；不以路径名单、patch 前缀或 fix diff 冒充整卡审查 | 拒收 |
| `scope.coverage` | `full \| partial`；终审只看修复片段或未闭 finding 的记 `partial` | v1 `scope.fullPrCovered`（`review-evidence.ts:219`）是其布尔前身 | B 重算；`partial` 不能声称完整跨家族终审 | `partial` → B 对未覆盖部分自审 |
| `materials[]` + 集合摘要 | 规格、派单正文、历轮报告、fix 材料及其他实际送审附件：逐项 ID、版本、字节数、摘要；集合摘要绑定排序、角色及各项摘要 | v1 有派单正文（`order-prompt.md`，`review-evidence.ts:160`）；其余 **设计，未实现** | B 从冻结派单重算，与报告和提交票据对应 | 拒收 |

主体、范围、材料、specRev / specDigest 或 epoch 漂移均使候选失效，即使 head 不变（R1 §2.3）。

### 2.4 审查者身份与来源记录

| 字段 | 含义 | 来源 | 核验 | 缺失 |
|---|---|---|---|---|
| `rounds[].reviewer.agent` / `sessionId` | 审查者 agent 与**真实** SID | 台账 review 事件 `reviewer` / `reviewerSessionId`（`review-verdict.ts:135`） | 与来源记录里的领单、提交一致；**不用 registry 当前 SID 追认历史 SID**（R1 §3.1） | 台账没有 SID → 记 `unknown` 并 `ready:false`（必需证据缺失），不取 registry |
| `rounds[].reviewer.instanceKeyId` | 审查者所在实例的完整 key id；公钥取 B 钉住的记录 | **设计，未实现**；本机审查等于 `producer.instanceKeyId`，池审查是出借方 | 出借方公钥要和 A、B 两侧钉住的一致（`pool-review-proof-admit.ts` `readPinnedKey`） | B 没有该实例可信来源 → `source_untrusted`，B 完整审 |
| `rounds[].records` | 按 R1 §5.2 **分列**四类来源记录：`humanReport` / `mcpSubmissionRecord` / `signedReviewTicket` / `admissionReceipt`；不导出核法枚举 | 见下表 | 每类只证明它能证明的事 | 见下表 |
| `rounds[].orderId` | 真实存在的审查单 | review 事件 `orderId` 或派审意图 id | 与来源记录一致 | 最终轮缺 → 退人工 |
| `rounds[].status` + `attempts[]` | 保留**全部**实际状态：completed、changes、block、refused、failed、cancelled、incomplete、skip 及原因；`attempts[]` 列全部派审与提交，逐一对账 | v1 只有四种（`reviewEntries()`，`review-evidence.ts:94`，派审未配上结论的记 incomplete / cancelled）；其余 **设计，未实现** | 全量派审清单与全量提交清单对账；顺序来自事件序号与订单链 | 缺轮、缺提交、未知尝试 → 历史不完整，拒互认 |

`rounds[].records` 四类记录与现有产出（结构化导出**设计，未实现**；v1 只把原始台账事件整份放进 `inputs/ledger-events.json` 和 `submission.json`）：

| 记录 | 能证明什么（R1 §5.2） | 本机审查的现有产出 | 池审查的现有产出 | 缺失 |
|---|---|---|---|---|
| `humanReport` | 取回的报告字节及其 SHA；署名、描述、测试结果只作声称值 `claimedResults` | `fileInside(reviewsDir)` 读的报告原文（`review-evidence-collect.ts:49`） | 同左（出借方回传的报告） | 最终轮缺 → 拒收 |
| `mcpSubmissionRecord` | 认证入口保存的原工具调用及其绑定 | 派审意图（`scheduler_intents`，action=review）→ 领单事件 `order_taken {id, sessionId}`（`order-mark.ts:41-55` `markOrderTaken`，bridge 在 take_review 返回后经 `recordTaken` `:98-114` 异步尽力记；`takeReview` 本身只返回订单，`review-order.ts:147`）→ review 事件 `{orderId, reviewerSessionId, reviewerFamily, via:"mcp"}`（`review-verdict.ts:135`） | 领单事实 `TakeFact{orderId, gen, agent, session, at}`（`recordTake`，`lend-journal.ts:210`） | 意图或提交缺 → 不算自动来源，退人工；**缺领单事件 = 必需证据缺失**：该轮只剩 `humanReport`，不算自动来源，`ready:false` 并记断链 |
| `signedReviewTicket` | 现有正式用途下签名与 payload、take、订单、session、gen 一致；不覆盖 base / specDigest / epoch | 无（本机审查没有票据） | `ReviewTicket`（`pool-review-proof-ticket.ts:15`，用途 `claudestra-lend-review-ticket-v1`），`ticketProblem` 用出借方钉住公钥验 | 池审查缺 → 退人工（同 `poolReviewRefusal` 口径） |
| `admissionReceipt` | 对应实例正式入账事件及签名回执 | 本机 review 事件本身是 A 台账入账 | `admitPoolEvidence`（`pool-review-proof-admit.ts:52`） | 池审查缺 → 退人工 |

- 只有 `via:"mcp"` 字段不能证明外部可验签票据；本机链没有 `gen`（租约代数只属于出借单），不能把本机领单写成 `TakeFact`。
- 留给后续卡：`order_taken` 现在是尽力留痕（写失败只记日志），按上表缺了就 `ready:false`；要让本机审查常态可用，需要单独开卡把领单留痕改成可靠写入。
- 第三实例 C 的审查：A 转交 C 签的票据原件和入账回执，记 C 的 `instanceKeyId`；B 无可信 C 来源即 `source_untrusted`，由 B 完整审（R1 §3.1）。
- 边界：签名只证明事实出自哪台实例；A 内部「审查者不是作者」在实例边界外仍是 A 的声明，R1 只让它可追溯。

### 2.5 家族：运行时声明与实际模型家族

R1 §3.2 把「family」分成运行时声明与实际家族，不能互相替代：

| 层 | 取值 | 来源 | 用途 |
|---|---|---|---|
| `runtime` | `claude-code` / `codex` / `pi` / `unknown` | registry 的 runtime（`agentRuntime`，`caller-identity.ts:56` 给已验证调用方带上） | 会话跑在哪个宿主 |
| `runtimeFamilyClaim` | `claude` / `codex` / null | `runtimeFamily`（`review-order.ts:38`）、`ledgerFamily`（`order-ledger-exit.ts:20`）：claude-code→claude，codex→codex，Pi→null（拒）；即台账 `AuthorFamily`（`ledger-scheduler.ts:12`） | 运行时家族**声明**，不混入实际家族 |
| `model.family` / `family` | 按 B / owner 冻结的 `familyMapVersion` 对**精确模型 ID** 做映射的结果：`claude` / `codex` / 已批准家族 / `unknown`；**不用前缀推** | **设计，未实现**；v1 的 `modelFamily()`（`review-evidence.ts:74`）是首字母词法推导，R1 下不作资格证据 | 实际跑的模型家族，B 据此判「跨族」 |

R1 字段：

| 字段 | 含义 | 来源 | 核验 | 缺失 |
|---|---|---|---|---|
| `reviewer.runtime` / `reviewer.runtimeFamilyClaim` | 见上表 | 见上表 | 只作声明，与观察冲突即拒 | 可为 `unknown` |
| `reviewer.family` | 实际家族，**必须等于** `model.family` | **设计，未实现** | 两者不一致 → 拒互认，给出各原值 | — |
| `reviewer.model.{provider, id, family, source, truncated, sourceArtifact}` | 模型证据：`source` = `response_model`（Claude / Pi）或 `request_model`（Codex rollout），两者分列；`truncated` 标会话记录是否截断 | v1 `modelClaim` 与 `model.json`（`review-evidence.ts:79`、`:144`），会话尾部 64 MiB 截断（`review-evidence-collect.ts:27`）；`source` / `truncated` 字段 **设计，未实现** | 时间窗不覆盖、截断、多家族切换、不明 ID → `unknown` | **模型证据缺失 = 必需证据缺失**：`ready:false` + 缺项诊断 |
| `familyMapVersion` | 只引映射表的版本号，不内嵌映射表 | **设计，未实现**；表由 B / owner 冻结 | 版本不支持即拒互认 | 未登记 → `family=unknown`，不按前缀推 |
| `authors[]` | 写这个 head 的全部作者（含实际写入最终 head 的修复者），同样各层分列 | `authorsOf()`（`review-evidence.ts:180`） | 不从 GitHub 账号或配置默认推断 | 作者为空 → 拒收 |

审查者必须独立于所有实际作者：不同真实 SID、实际家族与所有作者不同；换 agent 名或换机器不构成跨家族（R1 §3.2）。
MODELX 的同家族例外原样带 `approvalId`、`refusalEpoch`、`materialDigest` 和 `crossModel:false`，不能写成跨族通过（R1 §8.1）。

### 2.6 逐轮 finding 与关闭证据

| 字段 | 含义 | 来源 | 核验 | 缺失 |
|---|---|---|---|---|
| `rounds[].verdict` / `p0` / `p1` / `p2` | 该轮结论与计数 | review 事件（`review-verdict.ts:135`） | B 重算，与报告、原提交和票据逐项比较 | 不一致拒收 |
| `rounds[].findingsArtifact` | 规范 `ReviewFinding` 原样：findingId、family（问题类别，不是模型族）、severity、probe 等 | `storedFindings`（`review-verdict.ts:49`） | 不另造 schema | 旧记录无结构化 findings → `final.openCounts=null`（`review-evidence.ts:215`），不能自动推出关闭 |
| `closuresArtifact` | 每条关闭：raisedReviewId / findingId、fixCommit 或 sameHead 理由、disposition、复核订单 / 轮次 / 审查者及探针证据；retained P2 列后续跟踪 | `computeClosures`（`review-evidence-closures.ts`）；`fixCommit` 等字段 **部分设计** | 关闭必须由后一轮审查报告确认，**须证明复核派单含该 finding 并给明确结论；下一轮没写不算关闭** | 有未关闭 P0 / P1 → 拒收 |
| `final` | 最终通过轮、`openCounts{p0:0,p1:0,p2:N}`、保留的 P2 | `buildBundle`（`review-evidence.ts:216`） | B 重算 | 最后一轮不是 pass → 拒收 |
| `rounds[].downgrades[]` | 降级单独记：批准来源、事件、原严重度、新严重度、后续卡；不能抹掉历轮 P0 / P1 | v1 `downgradeOf()`（`review-evidence.ts:235`）只有事件序号与 findingId；其余 **设计，未实现** | 降级要有批准来源 | 无批准来源的降级视为未关闭 |

### 2.7 工件来源与哈希、head 变化

| 字段 | 含义 | 来源 | 核验 | 缺失 |
|---|---|---|---|---|
| `artifacts[]` | `{id, path, bytes, sha256, mediaType, kind, provenance, role}` 全量清单；`provenance` = original / approved_copy / reconstructed / replay（R1 §4.2-4.3） | v1 有前六项（`Files.inventory`，`review-evidence.ts:123`）；`provenance` / `role` **设计，未实现** | 每个引用能解析、路径唯一、字节与哈希一致（`inventory()`，`review-evidence-verify.ts:64`） | 任一项不符拒收 |
| `probes[]` | probeId、绑定 reviewId / findingId、subject、execution、purpose、argv、shell、相对 cwd、环境工件、起止时间、退出码、status、产物 ID 与摘要（R1 §6.1） | v1 只收 `-work/` 下文件（`probeFiles`，`review-evidence-collect.ts:61`），不区分源与输出；其余 **设计，未实现** | B 不自动执行；报告引用的截图 / 输出须解析到真实工件，否则列 `unresolvedRefs` | 只有摘要没有原始工件 → 不作关闭依据 |
| `carries[]` | 交回后 head 每跳 `{from, to, mainParent, basis, diffHash}`，**只是 A 的声明** | MHO1 `merge_handoff_carry`（`scheduler-merge-handoff.ts:37-39`）与 `mainMergeCarry`（`scheduler-main-merge-carry.ts:48`） | B 用自己的 canonical 纯 main 证明重算（R1 §7.2）；不能用 A 自报 carries 代替 | 对不上 → 证据失效，回 B 的完整审查 |

head 换了且不是被 canonical 证明的纯 main 合入，整包作废，不按「大部分还对」部分采纳。

### 2.8 CI 绑定（完整保留 R1 §6.2）

| 字段 | 含义 | 来源 | 核验 | 缺失 |
|---|---|---|---|---|
| `ci[].repository` / `workflow` / `event` / `runId` / `runAttempt` / `checkRunId` / `checkName` | workflow ID / 路径与 workflow commit、事件（`pull_request`）、run、attempt、job / check-run ID、检查名 | **设计，未实现**；本机合并闸只在 `scheduler_merges` 记 `reviewedHead` 与检查名清单（`scheduler-merge.ts:137`），`scheduler-merge-driver.ts:39` 判检查名全 pass | B 从 GitHub 认证渠道重读实际 run / check，核可信 workflow（`.github/workflows/ci.yml`，来自本仓库）与必需检查集合 | 缺 → 只当「无 CI 证据」，B 的 CI 闸照跑 |
| `ci[].subjectHead` | check-run 的 `head_sha`（被审 PR head），只用于把 check 绑到 PR | 同上 | 必须等于 `subject.head` | 同上 |
| `ci[].execution{commit, parents[], base}` | run **实际 checkout 并测试**的 OID：`pull_request` 下是 GitHub 合成的 merge 提交，从四片日志 `head=` 与汇总作业核对值读出；`parents` 恰为 [当时 main 提交, subject.head]；`base` = 第一父 | 同上 | 双亲：恰好两个父，第一父是当时 main 上的提交，第二父是 `subject.head`；展示的 `head_sha` 不能记作 `execution.commit` | 缺执行 OID 或取自展示值 → `ci_binding_invalid` |
| `ci[].status` / `conclusion` / 日志与工件摘要 | 每项检查的完成状态与原始来源引用 | 同上 | 三项必需检查（`typecheck + test + guard`、`web typecheck + lint`、`desktop typecheck + cargo test`）取自**同一 runId 的同一（最新）runAttempt**，均 completed / success；四片与汇总记录的执行 OID 一致、片号 / head / 文件数核对通过 | failed、cancelled、skipped、neutral、timed_out、action_required、missing、unknown、未完成都挡；拼不同 run / attempt 的工件 → `ci_binding_invalid` |
| base 漂移判据 | 核验和消费时 B 重读 PR 当前 base 分支 OID | — | 与 `ci[].execution.base` 不同 → `ci_base_drift`，须在新 base 上产生新 run | — |

**CI 证据永远只是参考。** B 的合并闸以 B 自己在当前 head 上重读的结果为准；`push` 事件（main）的 run 与本 PR 无关；
纯 main carry 后仍核新 head 自身 CI；R1 不提供「A 侧 CI 绿了所以免检」。

## 3. v1 → R1 差异表

| 项 | v1（`ledger review-export` 现状） | R1 | 依据 |
|---|---|---|---|
| 版本 | `version: 1` | `version: 2` | R1 §4.1 |
| 实例身份 | `origin.instanceFingerprint`：16 位短指纹 | `instanceKeyId`（64 位），公钥取 B 钉住的记录 | R1 §3.1、P2 §2.1 |
| 包摘要 | 只有命令返回的 manifest 摘要 | `manifestSha256` / `manifestCanonicalSha256` / `bundleSha256` 三者分列 | R1 §4.1 |
| 签名 | 无；靠传输通道摘要 | `transferProof`，用途待正式协议 + owner 冻结，批之前不签 | R1 §4.1 |
| subject | `repo` / `pr` / `head` / `base` / `specRev` / `taskId` | R1 §2.1 全套：repository / pr / branch / baseRef、head / base / mergeBase、specDigest、homeTaskId、orderId、委托或登记、材料 / 范围摘要 | R1 §2.1 |
| 每轮 base | `rounds[].base` 与 `subject.base` 同名不同口径 | 删除；改 `reviewSubject` + `execution` | R1 §2.2 |
| 范围 | `scope.paths` + `fullPrCovered` | 完整范围工件 + `coverage: full\|partial` + `materials[]` | R1 §2.3 |
| 审查者来源 | 布尔 `verified` | `rounds[].records` 四类分列，不导出核法枚举 | R1 §5.2 |
| 状态 | 四种 | 全部实际状态 + `attempts[]` 对账 | R1 §5.1 |
| 家族 | `family` + 前缀推导的 `model.family` | `runtimeFamilyClaim` / `family` = `model.family`（精确映射）/ `familyMapVersion` | R1 §3.2 |
| 关闭 / 降级 | `closures.json`、只有序号的降级 | 复核派单含该 finding 才算关闭；降级记批准来源与严重度 | R1 §5.1 |
| 探针 | `kind: probe-source` + 哈希 | `probes[]` 执行事实 + `artifacts[].provenance` | R1 §6.1、§4.2 |
| CI | 无 | `ci[]`：subjectHead 与 execution 分列、同 run 同 attempt、base 漂移判据（只作参考） | R1 §6.2 |
| 绝对路径 | 自检只查文件路径 | 原件不改，对外只给带 `approvalRef` 的获准副本 | R1 §4.2 |
| 交接 | 无 | 交接走 P2 handoff 消息，引用 `bundleId` 与 `manifestSha256`；manifest 不含 handoff 段 | P2 §6.1、R1 §9 |

## 4. 交接引用 R1 包

**边界：交接资格不是 PASS、互认或 B 合并许可（R1 §9、P2 §6.2）。**

HandoffEvidence 走 P2 的 handoff 消息（P2 §6.1），引用 R1 包的 `bundleId` 与 `manifestSha256`；**manifest 不含 handoff 段**。
报告不带本机路径，换成 R1 包里的条目 id 和 sha256。B 的接收与资格裁决、撤回墓碑都按 P2 §6.2、§6.4，本文不重复。

现状：MHO1 交回时 A 台账记 `merge_handoff` 事件，`data.evidence` 是 `HandoffEvidence v1`
（`scheduler-merge-handoff.ts:24-34`，字段表见 [merge-handoff.md](../architecture/merge-handoff.md)「Evidence」一节），只在 A 本机。
其中 `review.reportPath` 是本机路径，不进线上版本。

HandoffEvidence 的两个 family（`authorFamily` / `review.reviewerFamily`）只算 `runtimeFamilyClaim`，定性待 C1；不映射成 R1 的实际家族。

## 5. 脱敏示例（占位值，不可导入）

```json
{
  "format": "claudestra.review-evidence",
  "version": 2,
  "bundleId": "<taskId>-<head12>-<uuid>",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "expiresAt": "2026-01-08T00:00:00.000Z",
  "producer": { "instanceKeyId": "<64-hex>", "exporter": "<exporting-agent>" },
  "subject": {
    "repository": "owner/repo", "pr": 123, "branch": "<branch>", "baseRef": "main",
    "head": "<40-hex>", "base": "<40-hex>", "mergeBase": "<40-hex>",
    "specRev": 2, "specDigest": "<64-hex>", "specArtifactId": "spec", "acceptanceArtifactId": "acceptance",
    "taskId": "<A-task>", "homeTaskId": "<B-task>", "orderId": "<real-order-id>",
    "delegationId": "<delegation-id>", "epoch": 3,
    "registrationId": null, "registrationIdNotApplicable": "delegated card",
    "materialDigest": "<64-hex>", "scopeDigest": "<64-hex>",
    "refusalEpoch": null, "refusalEpochNotApplicable": "no MODELX refusal",
    "leaseGen": null, "leaseGenNotApplicable": "local review, no pool order"
  },
  "scope": { "artifactId": "scope", "coverage": "full", "materials": ["spec", "r1-<seq>-order"], "materialsDigest": "<64-hex>" },
  "familyMapVersion": "<frozen-version>",
  "authors": [{
    "agent": "<author-agent>", "sessionId": "<session>", "instanceKeyId": "<64-hex>",
    "runtime": "claude-code", "runtimeFamilyClaim": "claude", "family": "claude",
    "model": { "provider": null, "id": "<model-id>", "family": "claude", "source": "response_model", "truncated": false,
      "sourceArtifact": "author-1-model" }
  }],
  "rounds": [{
    "reviewId": "r1-<seq>", "round": 1, "orderId": "<real-order-id>", "status": "completed", "verdict": "pass",
    "p0": 0, "p1": 0, "p2": 1,
    "reviewSubject": { "head": "<40-hex>", "base": "<40-hex>", "specRev": 2, "specDigest": "<64-hex>", "epoch": 3 },
    "execution": { "commit": "<40-hex>", "parents": ["<40-hex>"], "ref": "<branch>", "base": "<40-hex>",
      "runtime": "codex", "environmentArtifactId": "r1-<seq>-env", "purpose": "original" },
    "attempts": [{ "intent": "<intent-id>", "status": "completed", "submissionEvent": "<seq>" }],
    "reviewer": {
      "agent": "<reviewer-agent>", "sessionId": "<session>", "instanceKeyId": "<64-hex>",
      "runtime": "codex", "runtimeFamilyClaim": "codex", "family": "codex",
      "model": { "provider": null, "id": "<model-id>", "family": "codex", "source": "request_model", "truncated": false,
        "sourceArtifact": "r1-<seq>-model" }
    },
    "records": {
      "humanReport": { "artifactId": "r1-<seq>-report", "claimedResults": "r1-<seq>-claims" },
      "mcpSubmissionRecord": { "intent": "<intent-id>", "takeEvent": "<seq>", "submissionEvent": "<seq>" },
      "signedReviewTicket": null, "signedReviewTicketNotApplicable": "local review",
      "admissionReceipt": { "event": "<seq>" }
    },
    "findingsArtifact": "r1-<seq>-findings", "downgrades": []
  }],
  "closuresArtifact": "closures",
  "final": { "reviewId": "r1-<seq>", "verdict": "pass", "openCounts": { "p0": 0, "p1": 0, "p2": 1 }, "retainedP2": [] },
  "probes": [],
  "ci": [{
    "repository": "owner/repo", "workflow": ".github/workflows/ci.yml", "event": "pull_request",
    "runId": "<run-id>", "runAttempt": 1, "checkRunId": "<check-run-id>", "checkName": "typecheck + test + guard",
    "subjectHead": "<40-hex>",
    "execution": { "commit": "<40-hex-merge>", "parents": ["<40-hex-main>", "<40-hex-head>"], "base": "<40-hex-main>" },
    "status": "completed", "conclusion": "success"
  }],
  "artifacts": [
    { "id": "r1-<seq>-report", "path": "rounds/r1-<seq>/report.md", "bytes": 0, "sha256": "<64-hex>",
      "mediaType": "text/markdown", "kind": "report", "provenance": "approved_copy", "role": "review-report",
      "originalSha256": "<64-hex>", "approvalRef": "<approval-ref>" }
  ],
  "producerCheck": { "ready": false, "problems": ["bundleSha256: archive format not yet approved"] }
}
```

manifest 外另记（不进 manifest）：`manifestSha256`、`manifestCanonicalSha256`、`bundleSha256`；`transferProof` 在用途批准前不出。
示例里 `producerCheck.ready=false` 是故意的：归档格式另批之前没有 `bundleSha256`，按 §0 记必需证据缺失。

## 6. 绝对路径：v1 里会漏出来的位置（R1 §4.2）

v1 自检 `safeRelPath` 只管包内文件名。下面这些位置会把本机绝对路径写进**内容**，是 UFL-1 演练被扣文件的同类来源：

| 位置 | 为什么带绝对路径 | R1 做法 |
|---|---|---|
| `rounds/<id>/submission.json` 里的 review 事件 `data.path` | `submitVerdict` 要求 `reportPath` 是绝对路径（`review-verdict.ts:63`） | 原事件不改，记 `originalSha256` / `originalRef`；对外只给带 `approvalRef` 的获准副本，`approvalRef` 未定时不出副本 |
| `identities/*/identity.json` 里的 deliver 事件 | deliver 事件 `data.evidence` 原样存交付时给的证据路径（`ledger-write.ts:245`） | 同上 |
| `inputs/ledger-events.json` 里的 `task.spec` 等 | 卡上存的规格路径 | 同上；规格本身走 `specArtifactId` |
| `HandoffEvidence.review.reportPath` | 「a local path」（merge-handoff.md） | 线上 HandoffEvidence 换成 R1 包里的条目 id 和 sha256（§4） |

自检要加一条：扫描 manifest 与所有对外文本类 artifact，命中绝对路径或 home 目录形态的串就 `ready:false`。**设计，未实现。**
原文不改写，只经获准副本送达，或拒绝出口转完整审；被拒原文保留原摘要和拒绝记录，不能删附件、改名后重投规避材料闸。

## 7. 留给后续冻结或批准的问题（本文不决定）

1. ~~版本号~~：R1 §4.1 已定 `version:2`。
2. 签名：原则已由 R1 §4.1（L123-124：用途与 lend ticket、handoff 分开；新用途需正式协议和 owner 冻结）定，用途列为待定项。
3. canonical 纯 main 净 diff 证明：按 R1 §7.2，MHO1 跟随与本地合并各用各的 canonical 实现，不互换算法（盘点 §2.3）。
4. 互认面（哪些改动只需证据核对 + 抽查）：按 R1 §7.1 由 B 的独立分类决定，本文不涉及。
5. 另批事项：取包通道、归档格式（决定 `bundleSha256`）、获准副本的 `approvalRef` 来源、`familyMapVersion` 登记、`order_taken` 可靠写入、开关。

接线点（留给后续实现卡，本卡不做）：export v2 走新文件，不改 v1 的 `review-evidence*.ts`；内容级绝对路径扫描与 `producerCheck` 随 v2 实现；
签名用途批准后才加进 `instance-signature.ts`；B 侧导入是新入口，不复用 `take_review` / `submit_verdict`。
