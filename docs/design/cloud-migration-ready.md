# cloud-CL1P：当前主线迁移准备清单

> **cloud-CL1 迁移后定位说明（2026-10-05 补记；只加此说明，正文历史结论未改）**
>
> 本稿正文中的 `src/shared-ledger.ts`、`src/shared-ledger/**`、`scripts/shared-ledger-admin.ts`、
> `src/lib/shared-ledger-member-admin.ts`、`deploy/shared-ledger/**` 是写作时公共仓库里的**历史路径**，正文保持原样。
> 按公开迁移 PR [shawnlu96/claudestra#636](https://github.com/shawnlu96/claudestra/pull/636) 的映射（该 PR 删除的 68 项源资源与 本稿 [§2](#2-source--target-完整manifest) 逐项一致），cloud-CL1 迁移后中心实现位于私有仓库 `floka-ai/cloud`：
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
> 正文里涉及它们的部署 / 运维 / admin 命令不再是公共仓库的可执行入口。V1/V2 权威、X12 后续设计、部署数据 / 中心身份 / 端口 / 证书均不因本说明改变。本稿是 CL1P 准备清单，下文"CL1 迁移尚未实施"、私仓为空等陈述是当时的证据，保留不改；PR #636 是按 §2 实施的公开侧 PR。

## 结论与证据边界

这是 CL1 的可审准备产物，CL1 迁移尚未实施。P1/P2、X12S、PP1/PP2不重复设计。
当前可开始制定双仓隔离迁移写单；尚不能宣称双仓已锁定或私仓可独立构建。
模块级纯协议边界还有一个精确残留：Artifacts URL 的地址谓词模块包含动态 Tailscale 查询依赖。
PM已裁定由PP3最小公共抽取；CL1等待CL1P+PP3真正verified，不接受tree shaking代替纯模块边界。

- 扫描公开 main：`6ee0a4eafe378c9d8375f17d61e997e8b615b8b0`。
- `git ls-remote origin refs/heads/main` 与 `origin/main` 同值，2026-10-05 本机实核。
- 准备分支：`feat/cloud-cl1-prep`；初始 HEAD：`2f7fa09adf43e1f1c892eb1ca9f317260e3a0c62`。
- origin：`https://github.com/shawnlu96/claudestra.git`。
- 初次正式 CLI `ledger show cloud-CL1P`：build、rev5、specRev1、manual/code3、作者 agent-task-cloud-cl1p/Codex。
- 当前 main 相对准备分支的变化是 PR595 后台 shell 修复；中心、协议和所列消费者文件没有变化。
- 私仓 `floka-ai/cloud` 仍空、无默认分支/refs是派单方刚核的事实，本卡未自行访问私仓验证。
- 未读取生产认证、Keychain、原始生产 DB/peers/principals；未 clone/push 私仓、迁移、部署或启 V2。
- mem0 的 memory_search 工具本会话不可调用，未把其它记忆写入工具当作搜索替代。

依据为正式 CL1/CL1P、已通过 r2 合同、旧空仓 Git 计划和点名 P2 报告。
报告是历史数据，静态310/418不再当协议 allowlist。下面全部名单重新解析当前 main。

## 1. 复算方法与计数

本机 Bun1.3.14、锁定 oxc-parser0.150.0。`git ls-tree -r --name-only origin/main`枚举，
每个文件通过`git show origin/main:<path>`读取，不依赖工作区未提交文件。
AST递归识别 import/export from、字面量 import()、TSImportType；混合说明符分别记录 runtime/type。
相对.js按实际.ts/.tsx/index.ts解析；node内建单列为平台依赖。测试中显式 web/node_modules 类型路径
是安装依赖，不能误当仓库源码或忽略中心内部未解析路径。

- 中心/admin TS种子57；member-admin1；部署资源5；域README5：源资源迁移68。
- 直接中心/部署 import 测试33；反向 fixture 消费闭包51。
- 旧P2：直接32、闭包46。新增5见逐文件表，不能删断言凑回46。
- 公共消费入口23（member-admin迁为私有）；应用PP1/PP2实际入口替换后的模块runtime图29、含type图29。
- 两张图均没有 paths/registry/config-store/ledger-store/ledger-asks/本机scheduler/bridge/manager。
- 图的29项不等于29项都是纯函数模块。net-addr动态import tailscale仍在图内，见第3节。
- 去重后的 protocol named exports 共122个；使用精确显式导出，无 export *。

附录提供可移植完整复算与named-export生成步骤，输出计数/集合/符号直接与正文比较；
不能用不区分类型的文本正则或仅测试新入口存在来替代闭包。已有边界测试实现可复用：
`tests/cloud-protocol-core-boundary.test.ts`、`tests/cloud-protocol-lend-boundary.test.ts`。
它们同规则证明旧入口穿透、新纯入口干净，并隔离导入检查无本机状态落盘。

## 2. source → target 完整manifest

以下均为CL1唯一迁移作者所有；目标路径相对私有 cloud 仓库。
部署资源由同一作者负责打包，后续A/B不争抢迁移写锁。
| source | target |
|---|---|
| `deploy/shared-ledger/README.md` | `deploy/ledger-center/README.md` |
| `deploy/shared-ledger/backup.ts` | `deploy/ledger-center/backup.ts` |
| `deploy/shared-ledger/closure.ts` | `deploy/ledger-center/closure.ts` |
| `deploy/shared-ledger/deploy.sh` | `deploy/ledger-center/deploy.sh` |
| `deploy/shared-ledger/remote.sh` | `deploy/ledger-center/remote.sh` |
| `scripts/shared-ledger-admin.ts` | `services/ledger-center/scripts/shared-ledger-admin.ts` |
| `src/lib/shared-ledger-member-admin.ts` | `services/ledger-center/src/admin/member-admin.ts` |
| `src/shared-ledger.ts` | `services/ledger-center/src/shared-ledger.ts` |
| `src/shared-ledger/artifacts/approval.ts` | `services/ledger-center/src/shared-ledger/artifacts/approval.ts` |
| `src/shared-ledger/artifacts/index.ts` | `services/ledger-center/src/shared-ledger/artifacts/index.ts` |
| `src/shared-ledger/artifacts/paths.ts` | `services/ledger-center/src/shared-ledger/artifacts/paths.ts` |
| `src/shared-ledger/artifacts/schema.ts` | `services/ledger-center/src/shared-ledger/artifacts/schema.ts` |
| `src/shared-ledger/artifacts/spec.ts` | `services/ledger-center/src/shared-ledger/artifacts/spec.ts` |
| `src/shared-ledger/artifacts/urls.ts` | `services/ledger-center/src/shared-ledger/artifacts/urls.ts` |
| `src/shared-ledger/asks/README.md` | `services/ledger-center/src/shared-ledger/asks/README.md` |
| `src/shared-ledger/asks/authorization.ts` | `services/ledger-center/src/shared-ledger/asks/authorization.ts` |
| `src/shared-ledger/asks/index.ts` | `services/ledger-center/src/shared-ledger/asks/index.ts` |
| `src/shared-ledger/asks/lifecycle.ts` | `services/ledger-center/src/shared-ledger/asks/lifecycle.ts` |
| `src/shared-ledger/asks/policy.ts` | `services/ledger-center/src/shared-ledger/asks/policy.ts` |
| `src/shared-ledger/asks/proposals.ts` | `services/ledger-center/src/shared-ledger/asks/proposals.ts` |
| `src/shared-ledger/asks/schema.ts` | `services/ledger-center/src/shared-ledger/asks/schema.ts` |
| `src/shared-ledger/asks/storage.ts` | `services/ledger-center/src/shared-ledger/asks/storage.ts` |
| `src/shared-ledger/commands.ts` | `services/ledger-center/src/shared-ledger/commands.ts` |
| `src/shared-ledger/exec-tasks/README.md` | `services/ledger-center/src/shared-ledger/exec-tasks/README.md` |
| `src/shared-ledger/exec-tasks/import.ts` | `services/ledger-center/src/shared-ledger/exec-tasks/import.ts` |
| `src/shared-ledger/exec-tasks/index.ts` | `services/ledger-center/src/shared-ledger/exec-tasks/index.ts` |
| `src/shared-ledger/exec-tasks/journal.ts` | `services/ledger-center/src/shared-ledger/exec-tasks/journal.ts` |
| `src/shared-ledger/exec-tasks/planning.ts` | `services/ledger-center/src/shared-ledger/exec-tasks/planning.ts` |
| `src/shared-ledger/exec-tasks/policy.ts` | `services/ledger-center/src/shared-ledger/exec-tasks/policy.ts` |
| `src/shared-ledger/exec-tasks/schema.ts` | `services/ledger-center/src/shared-ledger/exec-tasks/schema.ts` |
| `src/shared-ledger/exec-tasks/storage.ts` | `services/ledger-center/src/shared-ledger/exec-tasks/storage.ts` |
| `src/shared-ledger/exec-tasks/tasks.ts` | `services/ledger-center/src/shared-ledger/exec-tasks/tasks.ts` |
| `src/shared-ledger/exec-workflows/README.md` | `services/ledger-center/src/shared-ledger/exec-workflows/README.md` |
| `src/shared-ledger/exec-workflows/dag.ts` | `services/ledger-center/src/shared-ledger/exec-workflows/dag.ts` |
| `src/shared-ledger/exec-workflows/events.ts` | `services/ledger-center/src/shared-ledger/exec-workflows/events.ts` |
| `src/shared-ledger/exec-workflows/index.ts` | `services/ledger-center/src/shared-ledger/exec-workflows/index.ts` |
| `src/shared-ledger/exec-workflows/policy.ts` | `services/ledger-center/src/shared-ledger/exec-workflows/policy.ts` |
| `src/shared-ledger/exec-workflows/schema.ts` | `services/ledger-center/src/shared-ledger/exec-workflows/schema.ts` |
| `src/shared-ledger/exec-workflows/storage.ts` | `services/ledger-center/src/shared-ledger/exec-workflows/storage.ts` |
| `src/shared-ledger/exec-workflows/workflows.ts` | `services/ledger-center/src/shared-ledger/exec-workflows/workflows.ts` |
| `src/shared-ledger/feature-state.ts` | `services/ledger-center/src/shared-ledger/feature-state.ts` |
| `src/shared-ledger/identity.ts` | `services/ledger-center/src/shared-ledger/identity.ts` |
| `src/shared-ledger/import-history.ts` | `services/ledger-center/src/shared-ledger/import-history.ts` |
| `src/shared-ledger/imports.ts` | `services/ledger-center/src/shared-ledger/imports.ts` |
| `src/shared-ledger/intents/checks.ts` | `services/ledger-center/src/shared-ledger/intents/checks.ts` |
| `src/shared-ledger/intents/index.ts` | `services/ledger-center/src/shared-ledger/intents/index.ts` |
| `src/shared-ledger/intents/storage.ts` | `services/ledger-center/src/shared-ledger/intents/storage.ts` |
| `src/shared-ledger/join.ts` | `services/ledger-center/src/shared-ledger/join.ts` |
| `src/shared-ledger/leases/README.md` | `services/ledger-center/src/shared-ledger/leases/README.md` |
| `src/shared-ledger/leases/boots.ts` | `services/ledger-center/src/shared-ledger/leases/boots.ts` |
| `src/shared-ledger/leases/domain.ts` | `services/ledger-center/src/shared-ledger/leases/domain.ts` |
| `src/shared-ledger/leases/generation.ts` | `services/ledger-center/src/shared-ledger/leases/generation.ts` |
| `src/shared-ledger/leases/schema.ts` | `services/ledger-center/src/shared-ledger/leases/schema.ts` |
| `src/shared-ledger/leases/types.ts` | `services/ledger-center/src/shared-ledger/leases/types.ts` |
| `src/shared-ledger/lend/README.md` | `services/ledger-center/src/shared-ledger/lend/README.md` |
| `src/shared-ledger/lend/actions.ts` | `services/ledger-center/src/shared-ledger/lend/actions.ts` |
| `src/shared-ledger/lend/checks.ts` | `services/ledger-center/src/shared-ledger/lend/checks.ts` |
| `src/shared-ledger/lend/index.ts` | `services/ledger-center/src/shared-ledger/lend/index.ts` |
| `src/shared-ledger/lend/migration.ts` | `services/ledger-center/src/shared-ledger/lend/migration.ts` |
| `src/shared-ledger/lend/results.ts` | `services/ledger-center/src/shared-ledger/lend/results.ts` |
| `src/shared-ledger/lend/storage.ts` | `services/ledger-center/src/shared-ledger/lend/storage.ts` |
| `src/shared-ledger/lend/wire.ts` | `services/ledger-center/src/shared-ledger/lend/wire.ts` |
| `src/shared-ledger/migrations.ts` | `services/ledger-center/src/shared-ledger/migrations.ts` |
| `src/shared-ledger/projections.ts` | `services/ledger-center/src/shared-ledger/projections.ts` |
| `src/shared-ledger/reads.ts` | `services/ledger-center/src/shared-ledger/reads.ts` |
| `src/shared-ledger/server.ts` | `services/ledger-center/src/shared-ledger/server.ts` |
| `src/shared-ledger/service.ts` | `services/ledger-center/src/shared-ledger/service.ts` |
| `src/shared-ledger/store.ts` | `services/ledger-center/src/shared-ledger/store.ts` |
中心各域目录相对结构保留，尤其journal/store不借搬家改变权威语义。
公共保留全部客户端/cache/mode/exec-gate/local/outbox、ledger-lend-central*、scheduler-central*、
bridge/manager/web及第3节协议源。公共 member-admin 不再直接 import 中心 Store；
本机消费者需要管理时保留传输接口，不能复制中心DB实现。

### 测试及fixture逐项归属

P=私仓 `services/ledger-center/<source>`；M=混合测试，私仓保留中心断言/fixture，公共保留消费者契约断言；
U=公共保留浏览器消费者。M/U迁移后通过合成HTTP fixture或公共纯fixture继续测试，不能让公共CI访问私仓。
中心 fixture 移动不等于把所有反向消费者整份删除；表中的每个旧46项均保留断言。
| source | 当前依赖 | 归属 |
|---|---|---|
| `tests/shared-ledger-c6-control.test.ts` | 反向fixture | P |
| `tests/shared-ledger-c6-fixture.test.ts` | 直接 | M |
| `tests/shared-ledger-c6-members.test.ts` | 反向fixture | M |
| `tests/shared-ledger-c6-migration.test.ts` | 反向fixture | M |
| `tests/shared-ledger-deploy.test.ts` | 直接 | P |
| `tests/shared-ledger-feature-state.test.ts` | 直接 | P |
| `tests/shared-ledger-gate-proxy.test.ts` | 直接 | M |
| `tests/shared-ledger-import-history.test.ts` | 反向fixture | P |
| `tests/shared-ledger-integration-api.test.ts` | 直接 | M |
| `tests/shared-ledger-join-center.test.ts` | 直接 | M |
| `tests/shared-ledger-join-cmd.test.ts` | 直接 | M |
| `tests/shared-ledger-join-e2e.test.ts` | 直接 | M |
| `tests/shared-ledger-join-harden.test.ts` | 直接 | M |
| `tests/shared-ledger-join-offer.test.ts` | 直接 | M |
| `tests/shared-ledger-server-auth.test.ts` | 反向fixture | P |
| `tests/shared-ledger-server-cas.test.ts` | 反向fixture | P |
| `tests/shared-ledger-server-contract.test.ts` | 反向fixture | P |
| `tests/shared-ledger-server-fixture.test.ts` | 直接 | P |
| `tests/shared-ledger-server-import.test.ts` | 反向fixture | P |
| `tests/shared-ledger-server-policy.test.ts` | 直接 | P |
| `tests/shared-ledger-server-projection.test.ts` | 反向fixture | P |
| `tests/shared-ledger-server-restart.test.ts` | 反向fixture | P |
| `tests/shared-ledger-server-review.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-artifacts.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-asks-fixture.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-asks-proposals.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-asks.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-intents.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-leases-boots.test.ts` | 反向fixture | P |
| `tests/shared-ledger-v2-leases-fixture.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-leases-generation.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-leases.test.ts` | 反向fixture | P |
| `tests/shared-ledger-v2-lend-server-connections.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-lend-server-fixture.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-lend-server-migration.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-lend-server-wire.test.ts` | 直接 | M |
| `tests/shared-ledger-v2-lend-server.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-tasks-globs.test.ts` | 反向fixture | P |
| `tests/shared-ledger-v2-tasks-harness.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-tasks-import.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-tasks-results.test.ts` | 反向fixture | P |
| `tests/shared-ledger-v2-tasks.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-workflows-dag.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-workflows-events.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-workflows-harness.test.ts` | 直接 | P |
| `tests/shared-ledger-v2-workflows.test.ts` | 直接 | P |
| `tests/web-shared-ledger-browser.test.ts` | 反向fixture | U（新增） |
| `tests/web-team-parity-browser-center.test.ts` | 直接 | U（新增） |
| `tests/web-team-parity-browser-fixture.test.ts` | 反向fixture | U（新增） |
| `tests/web-team-parity-browser.test.ts` | 反向fixture | U（新增） |
| `tests/web-team-parity-drag-selection-browser.test.ts` | 反向fixture | U（新增） |
新增5个web文件全部是公共UI消费者，其中web-team-parity-browser-center直接import中心；
其余通过浏览器fixture反向依赖中心。必须将合成中心输出从本机台账materialize消费者拆开，
公共只消费协议/纯fixture或fake HTTP，不保留旧中心路径。JN4H正在修改join-offer消费者，见第5节等待条件。
C6 fixture的本机materialize/client/mode与中心构造必须拆开，不能整份搬ledger-store进私仓。
join-center中的joinSharedLedger仍是公共消费者；lend-server-wire的新旧wire兼容断言两端保留。
中心测试的旧instance-key签验改消费纯instance-signature并显式合成key，不能读取默认本机key。
私仓测试的test-env支持固定公开vendor/tests/test-env.ts或另受审测试工具入口，不复制算法；
公共contract-fixtures/contract-v2-fixtures仍固定vendor消费，中心fixture同级引用按表结构解析。
不能照旧P2一律把公共 bridge/manager 引用改为 vendor 路径，制造私仓中心依赖全套本机运行环境。
## 3. protocol精确入口与闭包

拟定入口：`services/ledger-center/src/protocol.ts`，公共gitlink在`vendor/claudestra`。
下面只列现中心实际消费的去重符号；重复从v2 barrel和子模块导入的名字只导出一次。
CL1必须修改私仓中心调用点：

- store canonicalJson：ask-bind → canonical-json。
- join isPublicKey/verifyPurpose：instance-key → instance-signature。
- join DTO/常量/纯函数：shared-ledger-join → shared-ledger-join-protocol。
- lend LeaseState/LEASE_MS_DEFAULT：lend-wire → lend-wire-types。
- lend offerBody/OfferRequest：lend-wire-v2 → lend-offer-protocol；
  `parseV2Request("offer", body)` → `parseOfferRequest(body)`，原返回ok/value/error语义保持。

以上是私仓调用点修改，不在本准备卡改公共中心。三个新纯核心和两出借入口已存在于main。
```ts
export {
  canonicalJson,
} from "../../../vendor/claudestra/src/lib/canonical-json.ts";
export {
  redactForPeer,
} from "../../../vendor/claudestra/src/lib/dispatch-redact.ts";
export {
  isPublicKey, verifyPurpose,
} from "../../../vendor/claudestra/src/lib/instance-signature.ts";
export {
  findPath,
} from "../../../vendor/claudestra/src/lib/ledger-deps.ts";
export {
  canTransition, nextTaskState,
} from "../../../vendor/claudestra/src/lib/ledger-stages.ts";
export {
  offerBody, parseOfferRequest,
} from "../../../vendor/claudestra/src/lib/lend-offer-protocol.ts";
export type {
  OfferRequest,
} from "../../../vendor/claudestra/src/lib/lend-offer-protocol.ts";
export {
  LEASE_MS_DEFAULT,
} from "../../../vendor/claudestra/src/lib/lend-wire-types.ts";
export type {
  LeaseState,
} from "../../../vendor/claudestra/src/lib/lend-wire-types.ts";
export {
  isPrivateAddr, isTailscaleAddr,
} from "../../../vendor/claudestra/src/lib/net-addr.ts";
export {
  isLoopbackAddress,
} from "../../../vendor/claudestra/src/lib/same-host.ts";
export {
  SHARED_LEDGER_AUTH_HEADERS, authenticateSharedLedgerRequest, sharedLedgerCommandDigest, sharedLedgerCredentialHash,
} from "../../../vendor/claudestra/src/lib/shared-ledger-auth.ts";
export type {
  SharedLedgerCredential, SharedLedgerPrincipal, SharedLedgerSignedRequest,
} from "../../../vendor/claudestra/src/lib/shared-ledger-auth.ts";
export {
  sharedLedgerManifestDigest, sharedLedgerProjectionDigest,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-transfer.ts";
export {
  parseCommand,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-commands.ts";
export type {
  V2Command,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-commands.ts";
export {
  parseFeature,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-dag.ts";
export type {
  V2Feature,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-dag.ts";
export {
  assertFence, v2ObjectDigest,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-integrity.ts";
export {
  parseLendClaim, parseLendLease, parseLendOrder, parseLendResult,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-lend.ts";
export type {
  V2LendLease, V2LendOrder, V2LendResult,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-lend.ts";
export {
  parseStep, parseTask, parseWorkflow,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-tasks.ts";
export type {
  V2Executor, V2Step, V2Task, V2Workflow,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-tasks.ts";
export {
  assertTransactionContext,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-transaction.ts";
export type {
  V2DomainModule, V2SchemaContext, V2Statement, V2TransactionContext,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-transaction.ts";
export {
  parseMigrationManifest,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-transfer.ts";
export type {
  V2MigrationManifest,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-transfer.ts";
export {
  fail, id, positive,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-validation.ts";
export type {
  V2Fence,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2-validation.ts";
export {
  V2_LEASE_MS, V2_RENEW_MS, array, integer,
  nullable, object, parseArtifact, parseAsk,
  parseAuthorizationBind, parseDag, parseDependency, parseEvent,
  parseExecutor, parseGeneration, parseIdMapping, parseIntent,
  parseItem, parseLease, parseOperationResult, parseProposal,
  parseReceipt, parseResource, resourceKey, resourcesOverlap,
  text, timestamp,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2.ts";
export type {
  Infer, V2Artifact, V2Ask, V2AuthorizationBind,
  V2Dependency, V2Event, V2Generation, V2Intent,
  V2Item, V2Lease, V2OperationResult, V2Proposal,
  V2Receipt, V2Resource,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-v2.ts";
export {
  assertSharedLedgerMutation, validateDag,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract-validation.ts";
export {
  SHARED_LEDGER_CAPABILITIES, SHARED_LEDGER_MAX_BODY_BYTES, SharedLedgerError,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract.ts";
export type {
  SharedLedgerCommand, SharedLedgerCommandResult, SharedLedgerDag, SharedLedgerErrorResponse,
  SharedLedgerFeature, SharedLedgerFeatureDetail, SharedLedgerImport, SharedLedgerImportControl,
  SharedLedgerImportManifest, SharedLedgerImportReceipt, SharedLedgerImportResult, SharedLedgerImportVerification,
  SharedLedgerProjection, SharedLedgerProjectionResult, SharedLedgerTaskProjection,
} from "../../../vendor/claudestra/src/lib/shared-ledger-contract.ts";
export {
  SHARED_LEDGER_JOIN_PATH, SHARED_LEDGER_JOIN_PURPOSE, formatSharedLedgerJoinCode, parseSharedLedgerJoinCode,
  sharedLedgerInstanceId, sharedLedgerJoinFields,
} from "../../../vendor/claudestra/src/lib/shared-ledger-join-protocol.ts";
export type {
  SharedLedgerJoinGrant,
} from "../../../vendor/claudestra/src/lib/shared-ledger-join-protocol.ts";
```
协议入口位于service/src，../../../回到cloud根。私有中心/admin自身路径在服务内解析；
不得将member-admin经protocol暴露，不得各域散布vendor路径。

### runtime模块闭包（29）
```text
src/lib/canonical-json.ts
src/lib/dispatch-redact.ts
src/lib/instance-signature.ts
src/lib/ledger-deps.ts
src/lib/ledger-stages.ts
src/lib/lend-offer-protocol.ts
src/lib/lend-wire-types.ts
src/lib/lend-wire-v2-schema.ts
src/lib/net-addr.ts
src/lib/redact-fields.ts
src/lib/same-host.ts
src/lib/shared-ledger-auth.ts
src/lib/shared-ledger-contract-schema.ts
src/lib/shared-ledger-contract-transfer.ts
src/lib/shared-ledger-contract-v2-asks.ts
src/lib/shared-ledger-contract-v2-commands.ts
src/lib/shared-ledger-contract-v2-dag.ts
src/lib/shared-ledger-contract-v2-integrity.ts
src/lib/shared-ledger-contract-v2-lend.ts
src/lib/shared-ledger-contract-v2-scheduling.ts
src/lib/shared-ledger-contract-v2-tasks.ts
src/lib/shared-ledger-contract-v2-transaction.ts
src/lib/shared-ledger-contract-v2-transfer.ts
src/lib/shared-ledger-contract-v2-validation.ts
src/lib/shared-ledger-contract-v2.ts
src/lib/shared-ledger-contract-validation.ts
src/lib/shared-ledger-contract.ts
src/lib/shared-ledger-join-protocol.ts
src/lib/tailscale.ts
```
### 含type模块闭包（29）

```text
src/lib/canonical-json.ts
src/lib/dispatch-redact.ts
src/lib/instance-signature.ts
src/lib/ledger-deps.ts
src/lib/ledger-stages.ts
src/lib/lend-offer-protocol.ts
src/lib/lend-wire-types.ts
src/lib/lend-wire-v2-schema.ts
src/lib/net-addr.ts
src/lib/redact-fields.ts
src/lib/same-host.ts
src/lib/shared-ledger-auth.ts
src/lib/shared-ledger-contract-schema.ts
src/lib/shared-ledger-contract-transfer.ts
src/lib/shared-ledger-contract-v2-asks.ts
src/lib/shared-ledger-contract-v2-commands.ts
src/lib/shared-ledger-contract-v2-dag.ts
src/lib/shared-ledger-contract-v2-integrity.ts
src/lib/shared-ledger-contract-v2-lend.ts
src/lib/shared-ledger-contract-v2-scheduling.ts
src/lib/shared-ledger-contract-v2-tasks.ts
src/lib/shared-ledger-contract-v2-transaction.ts
src/lib/shared-ledger-contract-v2-transfer.ts
src/lib/shared-ledger-contract-v2-validation.ts
src/lib/shared-ledger-contract-v2.ts
src/lib/shared-ledger-contract-validation.ts
src/lib/shared-ledger-contract.ts
src/lib/shared-ledger-join-protocol.ts
src/lib/tailscale.ts
```

与runtime29项逐项相同：类型扫描没有新增文件。二者分别遍历并对集合完整比较，
不是用 runtime 结果代填 type。公共声明的type必须随固定gitlink可解析，禁止skipLibCheck。
平台依赖为Node/Bun标准库，私仓须显式安装相应类型；不需要根产品npm运行依赖。

### 残留边界与最小解耦卡

最短链：`artifacts/urls.ts → net-addr.ts → import("./tailscale.js")`。
net-addr消费的isPrivateAddr/isTailscaleAddr本身纯；模块还暴露网卡/地址探测，tailscale包含CLI查询与设施操作。
same-host消费isLoopbackAddress本身纯，模块也含networkInterfaces/cache。
当前named-export dry bundle成功，tree shaking消去Tailscale查询；这证明精确符号包可构建，
不能证明完整29文件都是纯模块。模块扫描也未发现被明确禁止的registry/config/paths/DB/scheduler链。

已正式归属PP3（DAG v7，任务`b5cf-cloud-PP3`，当前build，尚未verified）：

```text
src/lib/address-predicates.ts
src/lib/net-addr.ts
src/shared-ledger/artifacts/urls.ts
tests/cloud-protocol-address*.test.ts
tests/net-addr*.test.ts
```

PP3唯一拥有isPrivateAddr/isTailscaleAddr纯叶模块抽取、net-addr旧路径兼容re-export、
公共artifacts/urls仅换import。same-host的isLoopbackAddress不扩围，平台node:os不通向本机配置/DB。
此卡只记录PP3归属，不替它写产品代码、不等它完成才交准备稿。
PP3验证合并后，CL1重新固定公共gitlink，protocol相应改显式导出address-predicates的两谓词；
模块图预计从29去掉net-addr/tailscale并增加address-predicates为28，必须实际复算，不能把预计写作已证明。
禁止复制算法、更改接受/拒绝语义、改Tailscale设施；B/F不并行拥有该抽取。

## 4. A–F实际仓库、fileGlobs与依赖

r2合同覆盖X12S旧稿的旧依赖/身份/receipt/journal/TV1分配。以下是实施卡应锁范围，不是本卡写授权。
### A：私有 cloud
前置：CL1、X6；journal必要原语调整唯一归A。

```text
services/ledger-center/src/shared-ledger/v2-wiring.ts
services/ledger-center/src/shared-ledger/v2-center*.ts
services/ledger-center/src/shared-ledger/v2-ports*.ts
services/ledger-center/tests/shared-ledger-v2-wiring-center*.test.ts
services/ledger-center/src/shared-ledger/exec-tasks/journal.ts
```
### B：私有 cloud
前置：A；完成公开纯签名/服务身份/V2 action契约发布。

```text
services/ledger-center/src/shared-ledger.ts
services/ledger-center/src/shared-ledger/service.ts
services/ledger-center/src/shared-ledger/commands.ts
services/ledger-center/src/shared-ledger/migrations.ts
services/ledger-center/src/shared-ledger/reads.ts
services/ledger-center/src/shared-ledger/identity.ts
services/ledger-center/src/shared-ledger/v2-routes*.ts
services/ledger-center/tests/shared-ledger-v2-wiring-routes*.test.ts
services/ledger-center/src/admin/member-admin.ts
```
公开必要例外具体拟锁：`src/lib/instance-signature.ts`、`src/lib/shared-ledger-auth.ts`、
`src/lib/shared-ledger-contract-v2-transfer.ts`、`src/lib/shared-ledger-contract-v2-commands.ts`及对应协议测试；
V2Actor/parseActor现来自transfer，V2_COMMAND_NAMES来自commands；不把V1 Action自动升级成V2。
服务登记schema由B私仓migrations所有。
新增action/服务DTO若需独立协议文件，正式B锁中先列具体文件；不得以shared-ledger-contract*宽锁抢占F。
### C：公共 claudestra
前置：CL1、X2、X7。

```text
src/bridge/shared-ledger-v2-asks*.ts
src/bridge/ask-reply.ts
src/bridge/ask-dismiss.ts
src/bridge/ask-expire.ts
src/bridge/ask-locate.ts
src/bridge/local-api/asks.ts
src/manager/ledger-read-cmds.ts
tests/shared-ledger-v2-wiring-asks*.test.ts

```
薄接线唯一owner：`src/bridge/asks.ts`、`src/bridge/ask-entry.ts`（各≤3行）。
clientFor接已认证Principal+projectId，创建/过期用明确已登记服务Principal。
### D：公共 claudestra
前置：CL1、X8、X9。

```text
src/bridge/shared-ledger-v2-lend*.ts
src/bridge/lend-tools.ts
src/bridge/lend-dispatch.ts
src/bridge/local-api/lend.ts
src/bridge/local-api/lend-inbox.ts
src/lib/scheduler-v2-wiring*.ts
src/lib/scheduler-deploy-job.ts
src/lib/scheduler-deploy-worker.ts
src/lib/scheduler-deploy-steps.ts
src/lib/scheduler-apply.ts
tests/shared-ledger-v2-wiring-exec*.test.ts
src/lib/ledger-lend-central.ts
```
薄接线唯一owner：`src/lib/scheduler-pass.ts`、`src/lib/scheduler-auto-deps.ts`（各≤3行）。
receipt端口传完整team/project/request/operationId/commandDigest和绑定V2Actor；恢复先GET，默认不重交。
### E：公共 claudestra
前置：CL1、X7、X10、X11、TV1。

```text
src/bridge/shared-ledger-v2-entry*.ts
src/bridge/local-api/shared-ledger.ts
src/bridge/dag-tools.ts
src/bridge/order-tools.ts
web/lib/api/shared-ledger.ts
web/lib/api/shared-ledger-v2*.ts
web/lib/i18n-dict-shared-ledger.ts
tests/shared-ledger-v2-wiring-web*.test.ts
tests/web-dom-shared-ledger-v2-wiring*.test.ts
web/features/collab/team-source.ts
web/features/collab/team-source-shared.ts
web/features/collab/team-source-adapter.ts
web/features/collab/team-source-context.ts
web/features/collab/shared/team-ops.tsx
```
薄接线唯一owner：`src/bridge/local-api/index.ts`（≤3行，可能0行）。
TV1旧已删除的shared-view/shared-ledger.tsx不再锁；项目query/header必须等于已认证绑定。
### F：公共 claudestra
前置：B、C、D、E（无法表达B协议子产物时依赖完整B）。

```text
src/lib/shared-ledger-v2-wiring.ts
src/lib/shared-ledger-v2-transport*.ts
src/lib/shared-ledger-v2-write-gate*.ts
src/lib/shared-ledger-mode.ts
src/lib/ledger-dag-write.ts
src/lib/ledger-tx.ts
src/bridge/shared-ledger-v2-wiring.ts
src/manager/ledger-shared-exec-cmds.ts
tests/shared-ledger-v2-wiring-local*.test.ts

```
薄接线唯一owner：bridge.ts、scheduler.ts、manager/ledger.ts、lib/ledger-write.ts（各≤3行）。
缓存键含Principal种类/ID、center/team/project/instance、credentialVersion；缓存不替代逐次在线授权。
B公开契约例外与F消费串行；A只用唯一exec_events/exec_command_receipts日志。
X13等待B+F+C6；X15等待X13；X15通过仍不等于批准生产切换。
SY7不得再依赖已取消旧X12，应等待B/F并串行接热点；SY4中心路径映射随CL1。
C/D/E目前均保留CL1前置，不能以空闲槽或旧稿“可立即开工”取消。


### 当前正式CL1计划锁与需要补齐的实施范围

正式CLI `ledger dag-show b5cf-b5cf-cloud`当前v7，CL1 planned且未绑任务；实际fileGlobs：

```text
.github/workflows/ci.yml
deploy/shared-ledger/**
package.json
scripts/shared-ledger-admin.ts
src/lib/shared-ledger-member-admin.ts
src/shared-ledger.ts
src/shared-ledger/**
tests/shared-ledger-center-migration*.test.ts
tsconfig.json
```

CL1正式依赖CL1P+PP3；PP1/PP2为verified。本清单没有自动扩大DAG写锁。
当前CL1 globs尚不覆盖表中46个旧测试的删除/拆分、公共新增纯消费者fixture，或私仓repo+目录。
派实施写单前必须把逐文件测试操作与私仓实际repo/globs登记成两仓范围；
还缺`scripts/guard/knip.json`及`scripts/guard/baseline.json`两项精确写锁：
knip第6行仍注册src/shared-ledger.ts；公共删除时必须移除该entry，不能留悬空入口。
这是受guard保护的配置变更，实施前登记CL1范围并按PM批准的具体方案留痕，不能越锁。
baseline仅为raised[]增加新的{key:"guard:scripts/guard/knip.json",from:0,to:0,why}记录，
why≥10字符并在提交说明重述；旧i28-C2记录不能复用。不提高计数/阈值、不改其它guard规则。
删除前后分别留存GUARD_STRICT=1 guard/knip输出与未用符号差集，
特别核第3节公共协议仅供中心消费的导出；新增未用项要调整真实公共消费/归属，不能ignore或扩baseline消红。
这是具体范围缺口，不能用上述单仓生产globs或本准备卡文档锁冒称双仓已锁。
A–F第4节范围是r2展开后的实施合同；当前cloud DAG没有A–F任务写锁，不能把合同等同活锁。

派CL1写单前逐项执行并留证（本卡未执行）：

1. PP3真正verified并合并后固定新公共完整SHA，复算协议入口/闭包；不沿用预计28项。
2. 将第2节68个源→目标登记为私仓新增、公共待删除，公共删除等待私仓构建产物。
3. 测试逐文件登记：P整份移到services/ledger-center/<source>；M私仓保留中心断言片段，公共原路径保留消费者断言；
   U原路径保留浏览器断言，仅替换中心fixture依赖。各行的fixture支持操作一并登记，不用shared-ledger*宽锁代替。
4. 明确公共合成HTTP/纯fixture新增路径后补该路径锁，先等JN4H再拆join-offer；不把fixture中心算法复制回公共仓。
5. 登记knip.json/baseline.json精确范围与新raised留痕方案，保存严格删除前后knip差集；未用项保持真失败。
6. 同一本机作者建立第6节两独立Git目录/分支，复核私仓仍空，记录两仓实际HEAD/目录/活写锁；任一事实未知仍阻塞。
7. 将私仓src/scripts/tests/deploy/package/锁文件/tsconfig/CI实际globs写入私仓repo锁；
   公共迁移和薄接线另锁，完成兼容SHA矩阵后才派实施写单，不凭本准备卡doc锁开工。

## 5. 当前followup/恢复卡交叉与锁

只读正式任务文档核范围。当前台账show仅核本卡rev/作者，不读取生产DB来推测其它卡锁。
下面区分范围交叉与实际活锁；未查到活锁不等于没有活锁。

- CL1P仅docs/design/cloud-migration-ready.md，与这些实现卡零交叉。
- CL1源迁移68项与followup/dispatch-recovery生产文件零交叉；
  但CL1混合测试拆分与JN4H的`tests/shared-ledger-join-offer*.test.ts`交叉。
  须等followup-reliability-JN4H合并并固定SHA，再拆该测试；不并写它。
- C的`src/bridge/ask-expire.ts`与dispatch-recovery-ASKR交叉；
  须等ASKR合并固定SHA，再进行C过期薄接线，不能修改其恢复策略。
- F热点`src/manager/ledger.ts`与dispatch-recovery-CFG交叉；
  F须等CFG合并再薄注册，不抢同一热点。
- D的ledger-lend-central接口与D其它测试范围不含R1/MAT的ledger-lend、pool或fix-materials；
  C/F也不因其名相近去改恢复卡文件。静态范围零交叉不能授权改其它恢复组合接线。
- FB1P、PM3S、PM5R、PM6V、PMSWR、SBH2、SC1H及其测试均未落入CL1/A–F精确范围。
- AUD/DEL/MANUAL/MODEL/PLACE/PLAN/G1/FB2/R1/MAT的当前文档范围与上列精确A–F无直接交叉；
  未来若扩大热点范围，必须重新比对，不能把这份静态核对当永久冻结证明。
- B公开纯协议调整须等PP1/PP2已合并基线（当前满足）及PP3真正verified；F等待B。

实际开工阻塞：没有私仓refs/工作目录/活锁的本机独立证据；本卡禁止clone/迁移，所以未创建它们。
正式CL1派写前，由同一本机作者经授权调度入口核两个repo+globs+活写租约，
形成唯一作者锁记录与完整SHA；不能“agent互相同意”代替owner对机器设施或权限的决定。

## 6. 空仓Git与构建/删除次序

现计划保持两独立目录，不使用本机主仓作为私仓依赖：

- 公共实施worktree拟定`~/.claude-orchestrator/worktrees/cloud-cl1-public`，分支`feat/cloud-cl1-public`。
- 私仓拟定`~/.claude-orchestrator/worktrees/cloud-cl1-private`，独立Git根；
  空仓initial main只README/规范/ignore；产品迁移分支`feat/ledger-center-move`。
- 上述目录/分支尚未创建。原空仓计划需要在私仓git操作前复核仍空，出现任何他人提交就停止对齐。
- 公共root运行部署pack closure入口会因删中心而变化，须由CL1唯一作者改package/tsconfig/CI薄接线；
  另精确包含scripts/guard/knip.json中心entry删除，以及baseline.json仅raised[]的强制留痕。
  前后严格guard/knip对照不可省；未用导出失败必须修真实归属，禁止扩阈值/ignore。
  不加私仓认证，不放宽guard、不修改baseline掩盖删除后失败。
- 私仓新增service package.json/bun.lock/tsconfig.json/bunfig.toml与CI：
  安装、严格typecheck、center/admin build、迁移域测试、隔离升级/回滚fixture。
- 私仓固定`vendor/claudestra`完整gitlink；起点为上述mainSHA，PP3合并后重新固定其完整SHA。
  记录.gitmodules URL、Gitlink、构建锁摘要；不追浮动main、不依赖邻接本机目录。
- 先私仓可构建产物和PR，再公共删除/引用调整PR；公共main删除不得早于私仓可审产物。
- 两PR交叉记录完整公共兼容SHA/私仓head/CI/产物摘要。私仓目前没有head/PR/CI，明确写未产生。
- 每仓干净clone验独立安装/check/build；公共安装和CI完全无需私仓权限。
- 部署包只换代码源/入口，原数据路径/中心身份/主场/端口/证书/备份策略保持。
  isolated fixture证明升级与回滚，不能根据目录迁移自动启V2、发生产服务授权或切执行权威。
- 此卡不新增launchd/监听/反代/TLS/crontab，故未操作机器设施。真实部署另卡另批准。

CL1P只交本公共文档分支；正式deliver须本人CLI带rev/branch/PR/full HEAD，
随后独立Claude审查。准备完成不冒充CL1或A–F已完成。

## 7. 验证记录

- 4个cloud-protocol-core/lend测试文件在env-i等价白名单环境、临时HOME/STATE/RUNTIME/TMPDIR通过。
- 拟protocol精确named-export入口typecheck通过：strict/noEmit、skipLibCheck=false、Bun类型显式设置。
- dry bundle通过：30模块（29公共模块+入口），78.97KB，未启动服务或调用外部API/模型。
- dry bundle未包含readTailscaleStatus/tailscaleCliCandidates/resolveTailscaleCli；
  仅证明树摇后的符号闭包，不覆盖模块级残留边界。
- 本准备worktree `bun run check`通过：tsc、13,271 tests/0 fail、GUARD_STRICT=1 guard均exit0。
- bridge/channel-server/manager/launcher/cron/setup六入口Bun build均exit0。
- 验证日志根：`/var/folders/g6/j4_mfcfx14vdp0ffl9p5k_xc0000gn/T/cl1p-verify-yc4s2t46/`；
  run-0.log为纯协议定向测试，run-1.log为全量check，run-2…7.log为上述六入口build。
- 结果索引及strict协议TS配置为作者本机临时记录；跨机复现以附录和PR同head CI为准。
- 本文附录扫描器已在隔离HOME/STATE/RUNTIME/TMPDIR实际复跑，exit0，输出57/68/33/51。
- 当前main的私仓干净clone/CI/迁移域测试未跑；公开PR同head CI由正式合并闸核，不假填CI通过。
- r1返修只补knip精确范围/raised留痕和完整可移植生成器；复现guard-scope-1文档检查旧红新绿。
- r1完整生成器已隔离复跑：57/68/33/51、23入口、29/29闭包、122导出名和type标签逐项一致。
  生成入口再经strict TS（skipLibCheck=false）及dry bundle验证通过。
- r1提交前重新执行全量check（13,271 tests/0 fail、strict guard）及六入口build，全部exit0。
- 私仓CI、真实切换、升级回滚演练均未执行；不能写作通过。

## 附录：可移植静态图与named-export完整生成器

以下代码保存为公开clone根的临时脚本，安装本仓锁定oxc-parser；argv[2]传公开clone绝对路径。
只读Git对象，无中心启动或网络查询。扫描基准固定为正文完整SHA，不使用浮动main。
named-export生成只收中心/admin直接import的说明符，逐说明符区分type；
按第3节五项替换、去重后输出精确列表。closure与test闭包可用下面核心重新复算。

```ts
import { parseSync } from "oxc-parser";
import { resolve, dirname, relative } from "node:path";
const ROOT = resolve(process.argv[2] ?? process.cwd());
const SHA = "6ee0a4eafe378c9d8375f17d61e997e8b615b8b0";
const git = (...args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", ROOT, ...args]);
  if (p.exitCode !== 0) throw Error(p.stderr.toString());
  return p.stdout.toString();
};
const files = git("ls-tree", "-r", "--name-only", SHA).trim().split("\n");
const sources = new Map(files.filter(f => /\.tsx?$/.test(f))
  .map(f => [f, git("show", `${SHA}:${f}`)]));
type Symbol = { name: string; type: boolean };
type Edge = { to: string; type: boolean; symbols: Symbol[] };
const cache = new Map<string, Edge[]>();
function edges(f: string): Edge[] {
  if (cache.has(f)) return cache.get(f)!;
  const parsed = parseSync(f, sources.get(f)!);
  if (parsed.errors.length) throw Error(f);
  const out: Edge[] = [];
  const add = (spec: unknown, type: boolean, node?: any) => {
    if (typeof spec !== "string" || !spec.startsWith(".")) return;
    const b = relative(ROOT, resolve(ROOT, dirname(f), spec));
    const to = [b.replace(/\.js$/, ".ts"), b.replace(/\.js$/, ".tsx"),
      b, b + ".ts", b + "/index.ts"].find(x => files.includes(x));
    if (!to) {
      if (b.includes("/node_modules/")) return;
      throw Error(`${f}:${spec}`);
    }
    const symbols = (node?.specifiers ?? []).map((s: any) => ({
      name: s.imported?.name ?? s.imported?.value ?? s.local?.name,
      type: type || s.importKind === "type",
    }));
    out.push({ to, type, symbols });
  };
  function walk(n: any): void {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration",
      "ImportExpression", "TSImportType"].includes(n.type)) {
      const onlyType = n.type === "TSImportType" || n.importKind === "type" ||
        n.exportKind === "type" || !!n.specifiers?.length &&
        n.specifiers.every((s: any) => (s.importKind ?? s.exportKind) === "type");
      add(n.source?.value ?? n.argument?.value ?? n.argument?.literal?.value, onlyType, n);
    }
    if (n.type === "CallExpression" && n.callee?.name === "require") {
      add(n.arguments?.[0]?.value, false);
    }
    Object.values(n).forEach(walk);
  }
  walk(parsed.program);
  cache.set(f, out);
  return out;
}
function closure(seeds: string[], types: boolean): string[] {
  const seen = new Set(seeds), q = [...seeds];
  while (q.length) for (const e of edges(q.shift()!)) {
    if (!types && e.type) continue;
    if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
  }
  return [...seen].sort();
}
const center = files.filter(f => f === "src/shared-ledger.ts" ||
  f.startsWith("src/shared-ledger/") && f.endsWith(".ts") ||
  f === "scripts/shared-ledger-admin.ts");
const moved = files.filter(f => center.includes(f) ||
  f.startsWith("src/shared-ledger/") || f.startsWith("deploy/shared-ledger/") ||
  f === "src/lib/shared-ledger-member-admin.ts");
const tests = files.filter(f => f.startsWith("tests/") && f.endsWith(".ts"));
const direct = tests.filter(f => edges(f).some(e => moved.includes(e.to)));
const fixture = new Set(direct);
let changed = true;
while (changed) {
  changed = false;
  for (const f of tests) if (!fixture.has(f) &&
    edges(f).some(e => fixture.has(e.to))) {
    fixture.add(f); changed = true;
  }
}
console.log(center.length, moved.length, direct.length, fixture.size);
const replacements: Record<string, string> = {
  "src/lib/ask-bind.ts": "src/lib/canonical-json.ts",
  "src/lib/instance-key.ts": "src/lib/instance-signature.ts",
  "src/lib/shared-ledger-join.ts": "src/lib/shared-ledger-join-protocol.ts",
  "src/lib/lend-wire.ts": "src/lib/lend-wire-types.ts",
  "src/lib/lend-wire-v2.ts": "src/lib/lend-offer-protocol.ts",
};
const entries = new Map<string, { runtime: Set<string>; types: Set<string> }>();
for (const f of [...center, "src/lib/shared-ledger-member-admin.ts"]) {
  for (const e of edges(f)) {
    if (!e.to.startsWith("src/lib/") || e.to.endsWith("shared-ledger-member-admin.ts")) continue;
    const to = replacements[e.to] ?? e.to;
    if (!entries.has(to)) entries.set(to, { runtime: new Set(), types: new Set() });
    const d = entries.get(to)!;
    for (const symbol of e.symbols) {
      const name = to.endsWith("lend-offer-protocol.ts") && symbol.name === "parseV2Request"
        ? "parseOfferRequest" : symbol.name;
      (symbol.type ? d.types : d.runtime).add(name);
    }
  }
}
const roots = [...entries.keys()].sort(), seen = new Set<string>(), protocol: string[] = [];
for (const f of roots) for (const kind of ["runtime", "types"] as const) {
  const names = [...entries.get(f)![kind]].sort().filter(n => !seen.has(n));
  names.forEach(n => seen.add(n));
  if (names.length) protocol.push(`export ${kind === "types" ? "type " : ""}{\n` +
    names.map(n => `  ${n},`).join("\n") + `\n} from "../../../vendor/claudestra/${f}";`);
}
console.log(JSON.stringify({ roots, runtime: closure(roots, false),
  type: closure(roots, true), namedExports: seen.size, direct, fixture: [...fixture].sort() }));
console.log(protocol.join("\n"));
// 57/68/33/51；roots=23，runtime/type=29/29，namedExports=122。
```

扫描整个模块保留静态动态import边，所以会检出net-addr→tailscale，
即使dry bundle树摇掉不使用函数也不从模块证据中删该链。
中心+公共29模块没有require()或额外TSImportType边，新增扫描分支不改变这次计数。
