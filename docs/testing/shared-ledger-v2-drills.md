# 共享台账 V2：故障恢复与三实例闭环演练清单（X15）

本文件是 **execution 开放前的人工核对清单**。每项演练都对应 `tests/shared-ledger-v2-e2e*.test.ts` 里的一个用例（下表「用例」列，
`describe › test` 两级名称），步骤和预期与用例断言一一对应；人工核对时逐项跑用例、对照「预期」与「留证」。

> **全部节点通过才开放 execution。** 按设计稿 `docs/design/shared-ledger-v2.md` §5，execution 总开关绑定 X0–X15 全部 16 个节点的
> 验收证据，不只看 X12 合并，也不只看本清单全绿。**本卡（X15）不打开总开关**，也不做正式试迁；正式试迁另需 owner 授权。

## 演练环境

- **中心**：S2C 合成中心（`tests/helpers/shared-ledger-v2-fake-center*`），挂在 `127.0.0.1` 的随机本地端口上，三实例都走真实的
  S2T 签名传输（`createStage2Transport`）连它。中心实现在私有仓库，这里只验证公开仓库的客户端、写门和恢复流程。
- **三个实例**：本机（主场 + owner）、peer A（成员）、peer B（执行方）。每个实例一个临时目录（`mkdtemp`），各有自己的模式文件、
  X7 执行闸与客户端、X7 本机 outbox、读缓存（`SharedLedgerCache`）和 X8 本机日志。
- **执行方**：peer B 跑真实的借方循环（`lend-loop` / `lend-drive`，依赖用 `tests/lend-harness.ts` 的假件），领中心写单经本机真实的
  出借接口（`sharedLendApi` → `openLendCentral` → `LedgerLendCentralClient`，本机以该单的 lend 服务身份签名）到中心。peer B 的假
  worker 每起一个就往 peer B 演练目录的 `worker-starts.jsonl` 记一行；「启动几次」只按这份记录数，不拿中心的 `lend.claim` 条数代替
  （执行方重启后可能不再领单就又起 worker）。辅助在 `shared-ledger-v2-e2e-executor.test.ts`。
- **合并**：假 `gh` 放在演练根目录的 `bin/` 里，经 PATH 调用，每次调用记进 `gh.log`；`pr view` 回报已合并。不连真实 GitHub。
- **隔离**：不连生产 bridge、不读生产状态目录；X13 迁移只在临时根目录内跑（`assertDrillRoot`）。
- **留证**：每项演练里转成 unknown 或待重交的条目，逐项写进演练根目录的 `drills/<演练>.json`（本机侧 / 中心侧各一份证据），
  用例写完再读回核对条目。
- 运行：`bun test tests/shared-ledger-v2-e2e`（15 个用例，约 2 秒）。

## 判定口径（每项故障演练都要满足）

1. **unknown 逐项留证**：转 unknown 的每一条（意图 / 命令 / 订单 / 迁移批次）都有本机证据（X8 日志状态、outbox 条目、冻结记录）和
   中心证据（意图状态、资源锁、回执查询结果）。
2. **没有盲目重试**：用例逐条断言中心收到的命令序列（类型 + 状态）；重跑只回放本机日志，中心不多收任何写命令。
3. **没有重复启动**：假 gh 调用次数只有一次；执行方 worker 的启动记录（`worker-starts.jsonl`）对同一订单只有一条
   （`expectStartedOnce`）。这条断言的灵敏度由 2.6 的反例用例证明。

## 1. 三实例闭环（验收线 1）

用例：`X15 验收线 1：网页开卡 → 借单 → 写 → 审查 → owner 合并（三实例 + 本地端口中心） › 每一步的中心命令、回执和行状态都对上；合并只经 owner 授权跑一次假 gh`
（文件 `shared-ledger-v2-e2e-loop.test.ts`）

| 步骤 | 谁 | 中心应收到 | 预期 |
|---|---|---|---|
| 网页开卡 | peer A 浏览器 → peer A bridge `/shared-exec/commands` → X7 | `task.new 200` | 回执记在 peer A 成员名下；卡主场随 feature 是本机；带 actor / role 的体在 bridge 就 400、中心零调用 |
| 设工作流、领租、推阶段 | 本机 | `workflow.set` / `lease.acquire` / `task.stage` 各 `200` | 租约持有者是本机、bootId 是本机的 |
| 借单写 | 本机建单 → peer B 领单并交付 | `lend.create 200`，`lend.claim 200` + `lend.result 200` | 订单 pooled → claimed → done，回执都在 peer B 名下；订单结果不改整卡（仍 build） |
| 回写交付 | 本机 | `task.deliver 200` | 卡到 review，head = peer B 交付的提交 |
| 审查 | 本机建 review 单 → peer A 领单 pass → 本机回写 | `lend.create`、`lend.claim`、`lend.result`、`task.review` 各 `200` | 卡到 merge，reviewedHead 对上 |
| 成员越权 | peer A 试发合并意图 | 无 | 本机闸 `wrong_home`，中心零调用 |
| owner 授权 | 本机 owner 在中心建业务 ask 并答复 | `ask.create` / `ask.answer` / `intent.create` 各 `200` | ask answered / approved，答复人是 owner |
| 合并 | X8 在本机锁内跑假 gh | 动作前后各一轮 `authorization.check` + `intent.check`，再 `operation.result`，全 `200` | 假 gh 恰好一次、带审查过的 head；意图 done、资源全放 |
| 收尾 | 本机 | `task.stage 200` + `lease.release 200` | 卡 done；中心序列单调；三实例快照一致；同一合并再跑只回放、不调 gh |

补充用例：`… › 网页入口拿不到 peer A 客户端（别的 principal）→ 503，中心零调用`。

## 2. 故障演练（验收线 2）

### 2.1 失租

用例：`X15 演练 · 失租：动作在途时主场租约过期 › 合并结果转 unknown，资源继续占着；重跑只回放、重领租也不重发，假 gh 只跑一次`

- 步骤：待合并卡 + owner 授权的合并意图 → X8 跑假 gh，动作进行中中心时钟越过 60 秒租期 → 重跑 → 本机重领租（新任期）→ 再重跑 →
  在线复核旧意图 → 同文件新派单。
- 预期：动作后复核 `intent.check 409`，上报 `operation.result 409`（lease_expired），结果 unknown、`resourceHeld`；中心意图仍
  submitted、资源仍 held、不记任何结果；两次重跑都只回放日志（中心只多收那次 `lease.acquire`）；旧意图在新任期里复核被拒；
  同文件新派单 `resource_busy`；假 gh 一次。
- 留证：`drills/lease-loss.json`（本机日志 unknown + gh 次数 / 中心意图 submitted + 资源 held）。

### 2.2 主场进程崩溃

用例：`X15 演练 · 崩溃 › 主场进程在假 gh 之后被 SIGKILL：重启的主场只回放 started 日志，不再合并；新 boot 拿不走旧租约，旧意图过不了新任期`

- 步骤：独立 bun 进程当本机主场，开自己的签名传输和本机日志跑合并，假 gh 跑完立刻被 `SIGKILL` → 重启的主场（测试进程）对同一操作再跑
  → 新 bootId 领租（旧租约还活着时、过期后各一次）→ 用旧上下文在线复核。
- 预期：子进程退出信号 SIGKILL；中心只收到动作前那轮复核；本机日志停在 `started`；重启后回放 unknown，中心零调用、假 gh 不再跑；
  新 boot 在旧租约存活时 `resource_busy`，过期后领到新任期；旧意图（旧 boot）复核被拒，意图保持 submitted、资源 held。
- 留证：`drills/home-crash.json`。

补充用例：`… › 中心进程重启：回执与行都在，重放已提交命令拿回原回执；主场租约作废、需重领，旧意图保持 submitted 等对账`
（中心换 bootId、代际不变；X7 先查回执，已提交命令不再发；没有租约时 X8 判 blocked，假 gh 零次）。

### 2.3 丢回执（转 unknown 对账）

用例 1：`X15 演练 · 丢回执：中心已提交，回包丢了 › X7：阶段命令回包丢失 → unavailable；显式对账查回执 committed，同一 requestId 不再发送、不重复写`

- 预期：中心记 `task.stage dropped`（已提交、回包丢），本机得到 unavailable、客户端标记不可用；显式查回执 committed；
  同一命令再走 X7 只拿回原回执，中心序列不动、不多收写命令。留证：`drills/lost-receipt-stage.json`。

用例 2：`… › X8：合并结果上报丢回包 → unknown 留在本机日志；重跑只回放；按 requestId 查回执确认中心已记 done`

- 预期：`operation.result dropped`，本机日志 unknown（结果 succeeded 已持久）；重跑只回放；按结果摘要定的 requestId 查回执
  committed，意图 done、资源已放；假 gh 一次。留证：`drills/lost-receipt-merge.json`。

### 2.4 断网（中心不可用）

用例：`X15 演练 · 断网：中心不可用 › 只读缓存与草稿、最近成功时间；派单 / 阶段 / 合并 / 开卡全停；在途成果进 outbox；恢复后显式核对再重交一次`

- 步骤：peer B 的借方循环经本机出借接口领一张写单、起 worker（中心 `lend.claim` 1 条、启动记录 1 条）→ 关闭中心端口 → 三实例刷新、读缓存、存草稿、发派单 / 阶段 / 开卡 / 授权复核、跑合并、
  peer B 交付 → 端口恢复 → 等待 → peer B 显式核对后重交。
- 预期：
  - 三实例在线刷新 unavailable，读缓存仍在（带最近成功时间、不报倒退）；缓存里的 ask 只作显示（`displayOnly`、非权威）；本机草稿可存。
  - 派单、阶段、网页开卡、业务授权复核都 unavailable（不回退本机权威、不拿缓存的 approved 当授权）；客户端状态显示不可用 +
    断网前的最近成功时间。
  - 合并在动作前 blocked，假 gh 零次。
  - peer B 的结果发不出去，只进它的本机 outbox（`pending_submission`、非权威）；peer B 的借方循环在断网期间照跑并重启，
    单子仍 started、不起第二个 worker；整个断网期间中心零请求。
  - 恢复后不会自动发送：中心日志不变、订单仍 claimed、outbox 仍待重交。
  - 显式重交前核对：回执 unknown（没提交过），订单仍 claimed，leaseGen / 头 / 规格版本与 outbox 条目一致，租约未过期 → 重交一次
    `lend.result 200`，订单 done。本机显式核对领单（`recoverLendCentral(…, "claim", true)`）只对账、`freshClaim: false`，peer B 再重启
    一次：中心 `lend.claim` 仍 1 条，启动记录仍 1 条。恢复后合并照常跑一次（假 gh 一次），本机阶段命令同样显式重交成功。
- 留证：`drills/offline.json`（peer B outbox 条目与启动次数、中心领单次数，本机阶段命令）。

### 2.5 迁移过程中有活单

成员台账用真实 schema（`openLedger` + `createTask` + 出借单行）：本机持有卡和借给 peer B 的 claimed 单，peer B 持有同一单。
迁移前这张单走旧出借路径：peer B 的借方循环向本机领单（本机旧接口用 harness 的假应答，订单字段与本机台账行一致）并起 worker，
启动记录 1 条、订单行的 worker 就是这个 worker。每个用例在迁移这一步之后都让 peer B 的循环再跑并重启两次：单子仍 started，
启动记录仍只有 1 条（`expectStartedOnce`）。

- 用例 1：`X15 演练 · 迁移过程中有活单 › 在途出借单没声明：本机与 peer B 逐项拒绝，三成员模式不动，中心零调用`
  - 预期：`refused`，逐项 `lend_not_declared:order`、`lend_unsettled:old-order`、`lend_unsettled:peer-b:old-order`；中心零调用；三成员仍 planning；peer B 单不动。
- 用例 2：`… › 显式导入并核对租约（gen 1 / 头）：整组切到 execution、中心领租；订单不重发，peer B 的在途单原样保留`
  - 预期：`switched`，epoch 2，一次迁移提交 + 中心领租；三成员模式 execution（绑中心 feature + epoch 2）；中心零 `lend.*` 命令；
    本机 / peer B 的订单行仍 claimed、gen 1、原 head、原 worker（即 peer B 启动记录里的那个）。
- 用例 3：`… › 切换回包丢失：全组冻结在 migrating 门后，按批次回执留证（committed），迁移命令不重试`
  - 预期：`frozen`（step switch），中心只收到一次迁移提交（dropped）和一次批次查询（committed）；三成员都挂 `migrating` 门；
    `frozen.json` 记 frozen_pending_pm、批次 committed、三成员 hold；冻结后不领租、不发执行命令。留证：`drills/migration-live-order.json`（含 peer B 启动次数）。

### 2.6 执行方启动观测（判定口径 3 的正反例）

文件 `shared-ledger-v2-e2e-starts.test.ts`。两例都先让 peer B 的借方循环领中心写单、起 worker（启动记录 1 条），再把 peer B journal 里这张单
退回 `cloned`（起了 worker、没来得及记 started 就崩溃时的样子）。

- 正例：`X15 演练 · 执行方启动观测 › peer B 重启时 journal 停在 cloned：按记下的 worker 名在 registry 认领，回到 started，不起第二个`
  - 预期：重启后单子回到 started，假 worker 只建过一次，启动记录 1 条，中心 `lend.claim` 1 条。
- 反例：`… › 反例：执行方丢了 journal 进度与 registry 里的 worker 再跑一轮，起了第二个 worker；启动记录抓到，只看领单次数抓不到`
  - 步骤：另外清空 peer B 的 registry 再重启。
  - 预期：启动记录变成 2 条，`expectStartedOnce` 抛错（各演练用的就是这条断言）；中心 `lend.claim` 仍是 1 条——只数领单发现不了重复启动。

### 2.7 领单回包丢失（重新领单只对账）

用例：`X15 演练 · 领单回包丢失 › 中心已 claimed、回包丢了：首轮不记 declined；下一轮重新领单只对账、不重复领、不重开租约；worker 只启动一次`
（文件 `shared-ledger-v2-e2e-claim.test.ts`）

| 步骤 | 中心应收到 | 预期 | 留证 |
|---|---|---|---|
| 对 `commands` / `lend.claim` 注入 drop，peer B 借方循环拉挂单后领单 | 回执查询、订单视图、`lend.claim dropped` | 中心订单 claimed 给 peer B、租约 gen 1；本机出借接口回 `503 unavailable`；peer B 的单留在 asked（不记 declined），日志「下轮再试」 | `drills/lost-claim-receipt.json`（peer B 首轮状态） |
| 下一轮重新领单 | 只有回执查询（committed）和订单视图，不再收 `lend.claim` | peer B 单 claimed、leaseGen 1；中心 leaseGen / leaseUntil 不变（不开第二个租约） | 同上（重新领单时中心收到的请求） |
| 往下起 worker，再重启两次 | 无新的 `lend.claim` | 单 started；启动记录 1 条（`expectStartedOnce`），假 worker 只建过一次；中心 `lend.claim` 全程 1 条（dropped） | 同上（启动次数、中心订单状态与 leaseGen） |

## 3. 旧备份恢复（验收线 3）

用例：`X15 验收线 3：旧备份恢复 › 冻结 → 升代际 → 撤旧租约 → 核对已确认回执；序列倒退报警并重建缓存；丢掉的合并只留证不重跑`
（文件 `shared-ledger-v2-e2e-restore.test.ts`）

| 顺序 | 步骤 | 预期 |
|---|---|---|
| 0 | 备份前改一次卡；备份；备份后再改一次并完成一次 owner 合并 | 本机日志 confirmed，三实例缓存记下高水位 |
| 1 | 冻结 | 三成员都拿到 update 维护锁，各自调度拿不到维护锁 |
| 2 | 升服务代际 | 中心用旧备份恢复：代际 1 → 2，`restoredFrom` 记备份的代际与序列 |
| 3 | 撤旧租约 | 恢复后没有主场租约；按旧代际发的 `lease.renew` / `lease.acquire` 都 `409 stale_generation`，零写入 |
| 4 | 核对已确认回执 | 备份前的回执仍 committed；备份后的逐项 unknown，合并上报回执 unknown、意图不在了；逐项写进 `drills/restore.json`（不静默丢提交） |
| 5 | 序列倒退报警、重建缓存 | 三实例刷新时读缓存报 `rollback`（序列低于高水位）；丢掉缓存重建后是代际 2 的完整快照、不再报警 |
| 6 | 解冻 | 丢掉的合并只回放本机日志，不调 gh、不调中心，由 owner 按证据处理；主场在代际 2 下重新领租，旧代际不复用 |

## 已知局限（夹具层，不是本卡要修的产品缺陷）

- 合成中心的迁移提交不导入 `lendOrders`：迁移活单用例 2 只能断言「不重发、两侧订单行原样」，导入后订单在中心继续结算要等私有仓库
  中心或夹具补齐后再加用例。
- 合成中心本身只按执行方实例身份收出借命令；X9 主场代理（本机该单的 lend 服务身份）由 `shared-ledger-v2-e2e-world.test.ts` 里的
  夹具处理器补上：核对是这张单的主场、这张单的服务身份后，按执行方规则照常处理。断网演练里 peer B 的结果仍由 peer B 直接发
  （X7 outbox 的重交路径），领单走主场代理。
- 迁移前的旧出借路径用 harness 的假主场应答，没有接本机真实的旧出借接口（`src/bridge/local-api/lend.ts`）。
- 合成中心没有 `task.deliver` / `task.review` / `lend.renew` / `operation.reconcile` 的语义：前两者由 `shared-ledger-v2-e2e-world.test.ts`
  里的最小夹具处理器补上（只用于本组用例），后两者本组不涉及；unknown 的人工对账在演练里止于「留证 + 继续占资源」。
- 设计稿要求的「真实三实例」闭环（三台机器各自的生产 bridge）不在本卡范围：本卡是隔离夹具上的自动化验收，生产切换另需 owner 授权。

## 待修的产品缺陷（已报 PM，等修复卡）

暂无。

已修：

- **领单待定被借方当成拒绝**（已修，i28-LENDCLAIM1 合并提交 `98219c4b7fa5`）：中心 `lend.claim` 已提交但回包丢失（或领单时中心不可用）时，
  本机出借接口（`src/bridge/shared-ledger-v2-lend-api.ts` 的 `pending()`）回 `503 unavailable`；借方 `claimOrder`（`src/lib/lend-drive.ts`）
  原先只把 transport / bad_response / max_open 当「下轮再试」，会把这张单永久记成 declined。修复后 `unavailable` 与转发结论同样当可重试。
  对应用例见 2.7：`X15 演练 · 领单回包丢失 › 中心已 claimed、回包丢了：首轮不记 declined；下一轮重新领单只对账、不重复领、不重开租约；worker 只启动一次`。

## execution 开放前的人工核对

1. `bun test tests/shared-ledger-v2-e2e` 15 个用例全绿，上表每一项的预期与留证都对得上。
2. X0–X15 全部 16 个节点各自的验收证据齐全（X12 合并、X13 迁移演练、本清单）。
3. 上面「已知局限」逐条确认有对应的后续卡或接受说明；「待修的产品缺陷」的修复卡已合并并补上对应用例。
4. 以上全部满足后，由 owner 另行决定是否打开 execution 总开关；本卡不打开它。
