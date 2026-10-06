# E2b 讨论输入：R1 审查证据字段草案

> 状态：**讨论输入，不冻结协议、不授权实现**。供监工冻结 P2 / R1 时取用；字段名、签名用途、版本号都可以改。
> 本文只写字段：每个字段的含义、现在由哪个模块产出（没有的标「设计，未实现」）、谁签、怎么核、缺了怎么办。
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

## 1. 通用规则（每个字段都适用）

| 规则 | 内容 | 现有依据 |
|---|---|---|
| 公共引用 ID | 包内互相引用一律用 artifact `id`，不用路径；跨实例引用用卡号、orderId、PR URL、完整 SHA | v1 `Files.add` 返回 id（`review-evidence.ts:124`） |
| 相对路径 | 包内路径只许相对、无 `..`、无符号链接 | 已实现：`safeRelPath` / `plainFile`（`review-evidence-verify.ts:24-41`） |
| **内容里不出现绝对路径** | 不只是包内文件名，**JSON 字段值、报告正文、回执原件**都不许出现 home 目录或任何绝对路径 | **设计，未实现**：v1 自检只查文件路径，不扫内容（见 §6） |
| 原始字节哈希 | `sha256` 对交付的原始字节算；manifest 不内嵌自身哈希 | 已实现：`Files.add`（`review-evidence.ts:127`） |
| 不加强声明 | 台账没有的就写 null / `unknown`，不推断成更强的说法 | 已实现：`buildBundle` 头注释与 `modelClaim` |
| 未知值不归一 | 认不出的家族、runtime 记 `unknown`，不默认成 claude / codex | 已实现：`modelFamily` 返回 `unknown`；`reviewCallerOf` 拒 Pi |

## 2. 字段

列说明：**来源**写产出它的现有模块；**签**写谁的密钥覆盖它；**核验**写 B 怎么核；**缺失**写 fail-closed 行为。

### 2.1 包与出证实例

| 字段 | 含义 | 来源 | 签 | 核验 | 缺失 |
|---|---|---|---|---|---|
| `format` / `version` | 字面量 `claudestra.review-evidence` / 2（暂记，见 §7 Q1） | `buildBundle` 写 1 | 随 manifest | 精确匹配 | 不认的版本拒收 |
| `bundleId` / `createdAt` | 出证方生成的唯一 ID、UTC 时间 | `ledger-review-export-cmd.ts:30` | 随 manifest | 同 ID 同摘要幂等，同 ID 不同字节拒 | 拒收 |
| `origin.instance.publicKey` | A 实例 Ed25519 公钥**全文**（base64url） | `instanceKeySync()`（`instance-key.ts`）；v1 只导出 16 位指纹 | — | 与 B 侧钉住的 A 公钥逐字节相等（`peer-keys.ts` `PinnedPeerKey.publicKey`） | 拒收；不接受只给指纹 |
| `origin.instance.fingerprint` | 公钥 **SHA-256 全 64 位 hex** | **设计，未实现**：现有 `keyFingerprint` 只取前 16 位四位分组（`instance-key.ts:25`） | — | B 用公钥重算 | 只给 16 位短指纹的视为 v1，按 v1 规则人工 |
| `origin.exporter` | 导出命令的执行者 | `c.deps.actor` | 随 manifest | 只作记录，不作授权依据 | 可空 |
| `signature` | A 实例私钥对 manifest 原始字节 SHA-256 的签名 | **设计，未实现**：`SIGN_PURPOSES`（`instance-signature.ts:43`）没有证据包用途，需新增用途（如 `claudestra-review-evidence-v2`），由监工拍板 | A 实例 | `verifyPurpose` 同一套原语 | 拒收 |

说明：只钉 A 实例，不证明 A 内部哪个 session 干了什么；那部分见 §2.3 的来源链。
B 现在通过已认证的 peer 附件通道收包时，传输层摘要已能把 manifest 字节和发送方绑定；独立签名是为了包离开通道后（转存、归档、再审）仍可验。

### 2.2 审查对象：head / base / specRev 分开记

v1 的 `subject.base` 来自 `--base`、`deliver_scope` 记录的 PR baseRefOid、或 `git merge-base`（`review-evidence-collect.ts:98-104`），
而每轮 `rounds[].base` 是另一次 `merge-base <head> origin/main`（`review-evidence.ts:167`）。两者口径不同却同名，R1 拆开：

| 字段 | 含义 | 来源 | 签 | 核验 | 缺失 |
|---|---|---|---|---|---|
| `subject.repo` / `subject.pr` | `owner/repo` 与完整 PR URL | 从 `task.pr` 解析（`review-evidence.ts:223`） | manifest | B 自己查 PR 的仓库与编号 | 拒收 |
| `subject.runHead` | 交付并被最终审查的 head，完整 40 位 | `task.headSHA` / `--head` | manifest | 等于 PR 当前 head；不等即失效（carry 例外见 §2.6） | 拒收 |
| `subject.compareBase` | 比较 diff 用的 base，完整 40 位 | `baseOf()`（`review-evidence-collect.ts:98`） | manifest | B 用同一 base 重算 `git diff --name-only` 与 `scope.files` 比 | 拒收 |
| `subject.compareBaseSource` | base 怎么来的：`pr_base_ref`（deliver_scope 记录的 PR baseRefOid）/ `merge_base_origin_main` / `explicit` | v1 有自由文本 `baseSource`（`review-evidence.ts:220`），R1 改成枚举 | manifest | 只收枚举值；`explicit` 要附理由 | 未知取值拒收 |
| `rounds[].runHead` / `rounds[].runBase` | 该轮实际审查的 head 与该轮比较 base | v1 `rounds[].head` / `rounds[].base` | manifest | 只有最后一轮通过的必须等于 `subject` 那一对 | 最后一轮缺任一个拒收；历史轮缺可收、标 `incomplete` |
| `subject.specRev` / `subject.specArtifact` | 规格版本与规格原文 artifact | `task.specRev`；`inputs/spec.md` | manifest + 哈希 | 与 B 卡规格版本、B 发出的规格摘要比对 | 拒收 |
| `subject.acceptanceArtifact` | 验收线原文 | `acceptanceOf()`（`review-evidence.ts:241`） | 哈希 | 与规格原文同源重算 | 拒收 |
| `rounds[].specRev` | 该轮进入 review 时的规格版本 | 进 review 的 stage 事件（`review-evidence.ts:168`） | manifest | 最后一轮必须等于 `subject.specRev` | 同上 |

### 2.3 审查者身份与来源链

| 字段 | 含义 | 来源 | 签 | 核验 | 缺失 |
|---|---|---|---|---|---|
| `rounds[].reviewer.agent` / `sessionId` | 审查者 agent 与会话 | 台账 review 事件 `reviewer` / `reviewerSessionId`（`review-verdict.ts:135`） | A 实例（随 manifest） | 与来源链里的领单、交结论事实一致 | 最后一轮缺任一个拒收 |
| `rounds[].reviewer.instance` | 审查者所在实例的完整公钥 + 64 位指纹 | **设计，未实现**；本机审查等于 `origin.instance`，出借池审查是出借方实例 | 本机：A；出借：出借方票据 | 出借方公钥要和 A 侧钉住的一致（`pool-review-proof-admit.ts` `readPinnedKey`） | 拒收 |
| `rounds[].reviewer.verification` | 身份怎么核的：`mcp_bound_session`（结论经 MCP 从绑定 session 写入，`via:"mcp"`）/ `pool_ticket`（出借票据链完整）/ `claim_only` | v1 只有布尔 `verified = via==="mcp"`（`review-evidence.ts:163`）；枚举是设计 | A 实例 | `claim_only` 不能当最终轮 | 最终轮是 `claim_only` → 退人工 |
| `rounds[].reviewer.provenance` | 来源链，按顺序：派审意图 → 领单事实（`TakeFact{orderId, gen, agent, session, at}`）→ 交结论事件 → 出借时的票据与入账回执 | 本机：`review-order.ts` `takeReview` + `review-verdict.ts` `submitVerdict` 的台账事件；出借：`pool-review-proof-ticket.ts` `ReviewTicket` + `pool-review-proof-admit.ts` | 本机：A 实例；出借：出借方实例签票据（`claudestra-lend-review-ticket-v1`） | 逐环比对 orderId / head / specRev / round / session；票据用出借方钉住公钥 `ticketProblem` 验 | 任一环缺 → 该轮不算自动来源，退人工（同 `poolReviewRefusal` 口径） |
| `rounds[].reviewer.identityReceipt` | 上面来源链的原件 artifact | v1 `identity.json`（`review-evidence.ts:142`） | 哈希 | 原件字节与哈希一致 | 拒收 |
| `rounds[].orderId` | 真实存在的审查单 | review 事件 `orderId` 或派审意图 id | manifest | 与来源链一致 | 最终轮缺 → 退人工 |
| `rounds[].status` | `completed / incomplete / refused / cancelled` | `reviewEntries()`（`review-evidence.ts:94`） | manifest | 只有 `completed` 有 verdict | 不认的值拒收 |

边界：B 能核的只有「这些事实出自 A 实例（或出借方实例）的签名」。A 内部「审查者不是作者」「session 真是那个模型」在实例边界外仍是 A 的声明，R1 只让它可追溯、不让它变成 B 的直接验证。

### 2.4 家族：runtime 家族、台账家族、模型家族三层映射

现在代码里「family」有三层，含义不同，R1 必须分开写，不能互相替代：

| 层 | 取值 | 来源 | 用途 |
|---|---|---|---|
| `runtime` | `claude-code` / `codex` / `pi` / `unknown` | registry 的 runtime（`agentRuntime`，`caller-identity.ts:56` 给已验证调用方带上） | 会话跑在哪个宿主 |
| `ledgerFamily` | `claude` / `codex` / null | `runtimeFamily`（`review-order.ts:38`）、`ledgerFamily`（`order-ledger-exit.ts:20`）：claude-code→claude，codex→codex，Pi→null（拒） | 台账跨族判断用的 `AuthorFamily`（`ledger-scheduler.ts:12`） |
| `model.family` | 模型 id 前缀的字面标签，如 `claude`、`gpt`、`deepseek`；看不出就 `unknown` | `modelFamily()`（`review-evidence.ts:74`），只从会话记录 `modelEvidence` 抽，**不用** registry 配置的模型 | 实际跑的模型，供 B 判断「跨族」是否成立 |

R1 字段：

| 字段 | 含义 | 来源 | 核验 | 缺失 |
|---|---|---|---|---|
| `reviewer.runtime` / `reviewer.ledgerFamily` / `reviewer.model.{provider,id,family,sourceArtifact}` | 三层各记一份 | 见上表；`model.json` 为会话记录摘要（`review-evidence.ts:144`） | B 用 `familyMap` 自己算「作者 vs 审查者」是否跨族 | `model.family=unknown` 时不推断，交 B 的策略（多半退人工） |
| `familyMap` | 本包用到的映射表：`{runtime → ledgerFamily}` 与 `{model.family 前缀 → 厂商族}`，带版本 | **设计，未实现**；现在映射散在 `runtimeFamily` / `modelFamily` 代码里 | B 用自己的表重算；两边不一致以 B 为准 | 缺表 → B 用自己的表，并在接收记录里标出 |
| `authors[]` | 写这个 head 的全部作者，同样三层 | `authorsOf()`（`review-evidence.ts:180`） | 多作者时每家都要出现；不从 GitHub 账号或配置默认推断 | 作者为空 → 拒收 |

拒审换家族（MODELX）的轮次，`crossModel=false` 和 approvalId 照原样带上（盘点 §2.2），不能在 R1 里写成跨族通过。

### 2.5 逐轮 finding 与关闭证据

| 字段 | 含义 | 来源 | 签 | 核验 | 缺失 |
|---|---|---|---|---|---|
| `rounds[].verdict` / `p0` / `p1` / `p2` | 该轮结论与计数 | review 事件（`review-verdict.ts:135`） | manifest | 与 findings 计数一致（v1 自检已做，`reviewRecord`） | 不一致拒收 |
| `rounds[].findingsArtifact` | 规范 `ReviewFinding` 原样：findingId、family（问题类别，不是模型族）、severity、probe 等 | `storedFindings`（`review-verdict.ts:49`） | 哈希 | 不另造 schema | 旧记录无结构化 findings → 该包 `final.openCounts=null`（v1 已如此，`review-evidence.ts:215`），B 不能当干净 |
| `rounds[].reportArtifact` | 报告原文 | `fileInside(reviewsDir)`（`review-evidence-collect.ts:49`） | 哈希 | 原样保留，不改写 | 最终轮缺 → 拒收 |
| `closuresArtifact` | 每条 finding 的关闭：`{reviewId, findingId, disposition: closed/retained, confirmingReviewId, fixCommit, reproducerArtifacts[], note}`；retained P2 还要 `followup` | `computeClosures`（`review-evidence-closures.ts`）；`fixCommit` 与 `followup` 在 v1 里不全，**部分设计** | 哈希 | 关闭必须由后一轮审查报告确认，不能只凭作者自查；跨所有轮算未关闭项 | 有未关闭 P0 / P1 → 拒收 |
| `final` | 最终通过轮、`openCounts{p0:0,p1:0,p2:N}`、保留的 P2 | `buildBundle`（`review-evidence.ts:216`） | manifest | B 重算 | 最后一轮不是 pass → 拒收 |
| `rounds[].downgraded` | 被降级的 finding 与降级事件 | `downgradeOf()`（`review-evidence.ts:235`） | manifest | 降级要有台账事件 | 无事件的降级视为未关闭 |

### 2.6 工件来源与哈希、head 变化

| 字段 | 含义 | 来源 | 签 | 核验 | 缺失 |
|---|---|---|---|---|---|
| `artifacts[]` | `{id, path, bytes, sha256, mediaType, kind}` 全量清单 | `Files.inventory`（`review-evidence.ts:123`） | manifest | 每个引用能解析、路径唯一、字节与哈希一致（`inventory()`，`review-evidence-verify.ts:64`） | 任一项不符拒收 |
| `artifacts[].origin` | 工件从哪来：`reviewer_written`（审查者在 `-work/` 下写的探针）/ `spec_given` / `ledger_record` / `git_derived` / `session_derived` | **设计，未实现**；v1 只有 `kind` | manifest | 探针必须有 origin；`reviewer_written` 要能对到该轮审查者 | 缺 → 视为不可信探针，不作关闭依据 |
| `artifacts[].producedBy` | 探针的执行记录 artifact：命令、非敏感环境与工具版本、退出码、完整输出、相关新旧 SHA | **设计，未实现**；v1 只收 `-work/` 下文件（`probeFiles`，`review-evidence-collect.ts:61`），不区分源与输出 | 哈希 | B 不自动执行，只看记录是否完整 | 只有摘要没有输出 → 不作关闭依据 |
| `carries[]` | 交回后 head 每跳 `{from, to, mainParent, basis: auto-merge/net-diff, diffHash}` | MHO1 `merge_handoff_carry`（`scheduler-merge-handoff.ts:37-39`）与 `mainMergeCarry`（`scheduler-main-merge-carry.ts:48`）；单跳 `singleMainCarryProof`（`review-main-carry-proof.ts:184`） | A 实例 | B 用自己的 canonical 净 diff 算法重算；两套算法差异见盘点 §2.3 | 对不上 → 证据失效，回 B 的完整审查 |

head 换了且不是被证明的纯 main 合入，整包作废，不按「大部分还对」部分采纳。

### 2.7 CI 绑定

| 字段 | 含义 | 来源 | 核验 | 缺失 |
|---|---|---|---|---|
| `ci.head` | CI 跑的 head，必须等于 `subject.runHead` 或最后一跳 carry 的 `to` | **设计，未实现**；本机合并闸在 `scheduler_merges.reviewedHead` 记（`scheduler-merge.ts:137`） | B 自己查 GitHub 该 head 的检查 | 缺 → 只当「无 CI 证据」，B 的 CI 闸照跑 |
| `ci.requiredChecks[]` | A 侧要求的检查名与结果 `{name, bucket, url}` | 本机：`beginMergeRun` 固定清单，`scheduler-merge-driver.ts:39` 判全 pass；但 mergeHandoff 项目不在 A 侧跑合并闸 | 只作参考 | 同上 |

**CI 证据永远只是参考。** B 的合并闸以 B 自己在当前 head 上查到的结果为准；R1 不提供「A 侧 CI 绿了所以免检」。

## 3. v1 → R1 差异表

| 项 | v1（`ledger review-export` 现状） | R1 草案 | 理由 |
|---|---|---|---|
| 版本 | `version: 1` | 2（或 v1 加新键，§7 Q1） | 改了 base 的含义 |
| 实例身份 | `origin.instanceFingerprint`：16 位短指纹 | 公钥全文 + 64 位指纹 | Shawn：完整公钥身份；盘点 §2.4 说短指纹不能声称完整身份 |
| 包签名 | 无；靠传输通道摘要 | A 实例对 manifest 摘要签名（新签名用途） | 包离开通道后仍可验；新用途需批 |
| base | `subject.base` 与 `rounds[].base` 同名不同口径 | `compareBase` + 枚举来源；`runHead` / `runBase` 分开 | Shawn：compare base 和 run head 分开 |
| 审查者核法 | 布尔 `verified` | `verification` 枚举 + `provenance` 来源链 | Shawn：session 事件 / 票据来源链 |
| 审查者实例 | 无 | `reviewer.instance` | 出借池审查时审查者不在 A |
| 家族 | `family` 一个字段 + `model.family` | `runtime` / `ledgerFamily` / `model.family` + `familyMap` | Shawn：family 与 model.family 映射 |
| 探针 | `kind: probe-source` + 哈希 | `origin` + `producedBy` 执行记录 | Shawn：探针来源与哈希 |
| 关闭 | `closures.json`，`fixCommit` / `followup` 不全 | 补齐 | 关闭要能追到修复提交 |
| carry | 无 | `carries[]` | head 漂移的唯一合法沿用方式 |
| CI | 无 | `ci`（只作参考） | Shawn：CI 绑定 |
| 绝对路径 | 自检只查文件路径；内容里会带（§6） | 内容也禁止，自检扫描 | UFL-1 演练 3 个文件被扣 |
| 交接 | 无 | `handoff`（§4） | 交接即资格 |

## 4. 交接即资格：HandoffEvidence 怎么随 R1 送达

**边界（Shawn 10-07 02:07）：交接只代表入场资格——B 可以开始按 R1 核证据——不等于审查通过、不等于互认、不等于合并许可。**

现状：MHO1 交回时，台账记 `merge_handoff` 事件，`data.evidence` 是 `HandoffEvidence v1`
（`scheduler-merge-handoff.ts:24-34`，字段表见 [merge-handoff.md](../architecture/merge-handoff.md)「Evidence」一节）：
`{v, pr, head, specRev, template, authorFamily, review{round, verdict, reviewerFamily, reportPath, p2, reviewSeq}}`。
它只在 A 本机台账上，「证据怎么到 owner 那边」当时明确不在范围内。

R1 提案：

1. manifest 加 `handoff` 段，原样带 `HandoffEvidence` 的字段，**去掉 `review.reportPath`**（它是本机绝对路径），改成 `review.reportArtifact`（指向同包里该轮报告的 artifact id）。
2. 另加 `handoff.eventRef = {taskId, eventSeq}`（A 台账上 `merge_handoff` 事件的序号）和 `handoff.carries`（同 §2.6 的 `carries[]`）。
3. 一致性要求，B 逐条核，任一不符就拒收整包：
   - `handoff.head` = `subject.runHead`（或经 carries 到达当前 PR head）；
   - `handoff.specRev` = `subject.specRev`；
   - `handoff.review.round` / `reviewSeq` 指向 `rounds[]` 里最终那一轮；
   - `handoff.authorFamily` / `review.reviewerFamily` 与 §2.4 的 `ledgerFamily` 一致；
   - `handoff.template` 在 B 给 A 的授权范围内（security 照盘点仍不进池审查）。
4. 送达方式：随 R1 包走同一个已认证的 peer 附件通道；不另开通道，不用 GitHub 评论当凭证。
5. B 收到后能做的只有「入场」：在 B 卡上记一条导入事件、开始按 R1 核证据并按互认范围决定抽查或完整再审。
   **不得**据此自动标审查通过、跳过 CI、标 merge-ready 或合并。
6. 交接后 head 有非纯 main 的变化：按 merge-handoff 现有规则交 PM，原交接资格失效，要重新交接。

现状差距：`HandoffEvidence` 的 `authorFamily` / `reviewerFamily` 只有 `claude` / `codex` 两值，没有 runtime 和 model 层；R1 由 §2.4 补，`handoff` 段不重复。

## 5. 脱敏示例（占位值，不可导入）

```json
{
  "format": "claudestra.review-evidence",
  "version": 2,
  "bundleId": "<taskId>-<head12>-<uuid>",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "origin": {
    "instance": { "publicKey": "<A-ed25519-public-key-base64url>", "fingerprint": "<64-hex-sha256-of-public-key>" },
    "exporter": "<exporting-agent>"
  },
  "subject": {
    "repo": "owner/repo", "pr": "https://github.com/owner/repo/pull/123",
    "runHead": "<40-hex>", "compareBase": "<40-hex>", "compareBaseSource": "pr_base_ref",
    "specRev": 2, "taskId": "<A-task>", "specArtifact": "spec", "acceptanceArtifact": "acceptance"
  },
  "familyMap": { "v": 1, "runtime": { "claude-code": "claude", "codex": "codex", "pi": null } },
  "authors": [{
    "agent": "<author-agent>", "sessionId": "<session>", "runtime": "claude-code", "ledgerFamily": "claude",
    "model": { "provider": null, "id": "<model-id>", "family": "claude", "sourceArtifact": "author-1-model" },
    "verification": "mcp_bound_session", "identityReceipt": "author-1-identity"
  }],
  "rounds": [{
    "reviewId": "r1-<seq>", "round": 1, "runHead": "<40-hex>", "runBase": "<40-hex>", "specRev": 2,
    "orderId": "<real-order-id>", "status": "completed", "verdict": "pass", "p0": 0, "p1": 0, "p2": 1,
    "reviewer": {
      "agent": "<reviewer-agent>", "sessionId": "<session>", "runtime": "codex", "ledgerFamily": "codex",
      "instance": { "fingerprint": "<64-hex>" },
      "model": { "provider": null, "id": "<model-id>", "family": "gpt", "sourceArtifact": "r1-<seq>-model" },
      "verification": "mcp_bound_session",
      "provenance": ["intent:<intent-id>", "take:<orderId>@gen<n>", "review-event:<seq>"],
      "identityReceipt": "r1-<seq>-identity"
    },
    "reportArtifact": "r1-<seq>-report", "findingsArtifact": "r1-<seq>-findings", "probeArtifacts": ["r1-<seq>-probe-1"]
  }],
  "closuresArtifact": "closures",
  "final": { "reviewId": "r1-<seq>", "verdict": "pass", "openCounts": { "p0": 0, "p1": 0, "p2": 1 }, "retainedP2": [] },
  "handoff": {
    "v": 1, "pr": "https://github.com/owner/repo/pull/123", "head": "<40-hex>", "specRev": 2, "template": "code",
    "authorFamily": "claude", "eventRef": { "taskId": "<A-task>", "eventSeq": 0 },
    "review": { "round": 1, "verdict": "pass", "reviewerFamily": "codex", "reportArtifact": "r1-<seq>-report", "p2": 1, "reviewSeq": 0 },
    "carries": []
  },
  "ci": { "head": "<40-hex>", "requiredChecks": [{ "name": "<check>", "bucket": "pass", "url": "https://github.com/owner/repo/actions/runs/<id>" }] },
  "artifacts": [
    { "id": "r1-<seq>-probe-1", "path": "artifacts/r1-<seq>/probe.test.ts", "bytes": 0, "sha256": "<64-hex>",
      "mediaType": "text/plain", "kind": "probe-source", "origin": "reviewer_written", "producedBy": "r1-<seq>-probe-1-run" }
  ],
  "signature": { "purpose": "<to-be-frozen>", "sig": "<base64url>" }
}
```

## 6. 绝对路径：v1 里会漏出来的位置（R1 要堵）

v1 自检 `safeRelPath` 只管包内文件名。下面这些位置会把本机绝对路径写进**内容**，是 UFL-1 演练被扣文件的同类来源：

| 位置 | 为什么带绝对路径 | R1 做法 |
|---|---|---|
| `rounds/<id>/submission.json` 里的 review 事件 `data.path` | `submitVerdict` 要求 `reportPath` 是绝对路径（`review-verdict.ts:63`） | 改成 `reportArtifact` 引用；原事件导出前把该字段替换为 artifact id，并在包里注明替换 |
| `identities/*/identity.json` 里的 deliver 事件 | deliver 事件 `data.evidence` 原样存交付时给的证据路径（`ledger-write.ts:245`） | 改成证据 artifact id，或只留文件名 |
| `inputs/ledger-events.json` 里的 `task.spec` 等 | 卡上存的规格路径 | 只导出卡号与 specRev，规格走 `specArtifact` |
| `HandoffEvidence.review.reportPath` | 「a local path」（merge-handoff.md） | 见 §4 第 1 条 |

R1 自检要加一条：扫描 manifest 与所有文本类 artifact，命中「以 `/` 开头的绝对路径」或 home 目录形态的串就 `ready:false`。
**设计，未实现**；只能替换引用、不能截断或改写报告原文——报告原文里的路径要回到出证前由审查者改写，或该包不发。

## 7. 留给 P2 冻结的问题（不在本文决定）

1. 升 `version: 2`，还是在 v1 上加新键（merge-handoff 约定「改含义才升版本」，§2.2 改了 base 含义，倾向升 2）。
2. 证据包签名是否新增 `SIGN_PURPOSES` 用途；v1 草案原写「不新增加密用途」。
3. 64 位完整指纹的线格式与和现有 16 位短指纹的兼容期。
4. `familyMap` 由谁维护，B 的表与 A 的表不一致时的处理（本文倾向以 B 为准）。
5. canonical 纯 main 净 diff 算法以哪一边为权威（盘点 §2.3：本地 `singleMainCarryProof` 与 MHO1 `mainMergeCarry` 是两套）。
6. 互认面（哪些改动只需证据核对 + 抽查）——本文不涉及，见 [A 侧设计稿](https://github.com/shawnlu96/claudestra/pull/773) §7。

接线点（留给后续实现卡，本卡不做）：R1 导出改 `review-evidence*.ts`；内容级绝对路径扫描加进 `review-evidence-verify.ts`；
签名用途加进 `instance-signature.ts`；B 侧导入是新入口，不复用 `take_review` / `submit_verdict`。
