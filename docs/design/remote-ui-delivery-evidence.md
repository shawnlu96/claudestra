# UISOURCE1 · 远端 UI 工件正式来源与导入（设计）

状态：设计稿（specRev 1，基线 head `a3f64491575b4335968001602e5d8214b577e6b4`，依赖 UISDEL1 已合入：#936 `fecd04d2` / `d88b795b` / `8b87121b`）。
对应 r2 `lend-drive-gap` P2：**本文只登记缺口与方案，不关闭它**。本卡只改本文件；不改产品代码、配置、安全规则，不新增发送端、PNG 传输、
网络导入、可读根或生产开关，不启用任何机制。合并本设计**不批准**实现，也**不批准**启用任何新传输；实现卡与传输卡各自另开、各自过 security 独审与 owner 批准（§7）。

一句话：今天远端 ui 卡交付里「imported 工件」的可信度只来自磁盘上一份**谁都能手写**的 `provenance.json`；本文把「远端工件已认证入库」定义成**台账里的一行事实**
（只由已认证入口在事务里写、绑定 peer / 指纹 / worker / 单号 / 租约代数 / 卡 / head / specRev / 轮次 / 清单摘要 / 实际字节），交付核对改为只认这行事实；
在这行事实的写入口（导入传输）获批之前，远端 ui 交付一律缺来源 → 按现有 `uiDelivery` 策略 fail-closed（on 拒 / observe 记一条 / off 旧路径），
继续走现有合法人工流程。

---

## 0. 现状核对（只读，均为基线代码）

### 0.1 真实入口链

**A. 远端写单交付（出借方 B → 借入方 A）**

| # | 位置 | 做什么 | 与 ui 证据的关系 |
|---|---|---|---|
| A1 | `src/lib/lend-submit.ts`（`WorkInput { summary; selfCheck }`） | B 的一次性 worker `manager lend submit` 交「工作副本 HEAD + 摘要 + 自查」，核 cwd / 会话 / 窗口进程链后落 B 的 journal `work` | **没有** uiEvidence 字段，也不收截图 |
| A2 | `src/lib/lend-drive.ts:274` `publishWork` | B 的调度服务推送分支、开 PR，拼 `payload.deliver = {v, orderId, head, evidence, summary, selfCheck}`，落 journal `result_pending + payloadSha` | **不带** `uiEvidence`；正文上限 `BODY_MAX_BYTES = 96 KiB` |
| A3 | `lend-drive.ts` `forwardResult` → `lendRequest(..., "result")`（`src/manager/lend-call.ts` → `POST <A>/api/v1/lend/result`） | 原字节重发；回执按 orderId / sha256 / taskId + `verifyReceipt` 验签才算入账 | 只搬 A2 的正文 |
| A4 | `src/bridge/local-api/lend.ts` | 只收 E2E 解开的内层请求、对方公钥已钉、请求头钥匙即钉的那把且验签过（`requestContextOf(req).e2e`、`peerSignatureState`） | 认证到 **peer** 一级 |
| A5 | `src/manager/ledger-lend-cmds.ts:245` `bridgeCall`（`ledger lend-write -- <peer> <raw>`，owner 身份） | `parseLendRequest` → `lend-wire.ts:149` `parseDeliverWire(r.deliver)`；幂等键 = 原文 sha256 | **wire 已接受** `deliver.uiEvidence`（UISDEL1 加的可选字段） |
| A6 | `src/lib/ledger-lend-result.ts:185` `writeLendDeliver` | 事务外后各一遍 `check`（单属此 peer、`claimed`、租约未过、`gen`、family、分支、PR、卡未移动、步骤仍绑 `worker@peer`）；`deliveryBranchMatches`（`src/lib/fix-strategy-remote-branch.ts:25`）核钉钥指纹；`remoteHead` 核远端 head | 事务内 `deliver(..., uiEvidence: req.deliver.uiEvidence, ui: uiDeliverPort({peer, worker, orderId}))` |
| A7 | `src/lib/ledger-write.ts` `deliver` → `src/lib/ledger-deliver-ui.ts:121` `planUiDelivery` | 按 `uiDelivery` 策略：off 不读；observe 核、记一条去重 note、不拦不写；on 缺 / 错就抛 `LedgerError`（带 `lend: "invalid"`），整笔不写 | `port.peer` 在 → 只认 `source: "imported"`，根 = `<state>/ledger/ui-artifacts/imported/<peer>/<orderId 冒号换下划线>/` |
| A8 | `ledger-deliver-ui.ts:71` `provenance()` | 读该目录下 `provenance.json`（≤ 64 KiB）：`v===1`、`peer/worker/orderId/head` 与本单相等、`files[ref].sha256` | **这就是今天全部的「来源认证」**（见 §0.2 G2） |
| A9 | `ledger-deliver-ui.ts:107` | 每张图按 `openAttachment`（`O_NOFOLLOW` + realpath 在根内 + 同 inode）读 ≤ 10 MiB，算实际 sha256，与清单声明、provenance 声明都相等才过 | on：写 `extra.screenshots`（本机真实路径）/ `screenshotsDigest`，事件 `data.uiEvidence` 带 `bytesVerified: true` 与 `peer` |
| A10 | `ledger-lend-result.ts` 回执 | `sign([orderId, bodySha, eventSeq, taskId])`，`lend_orders` 置 `done/resultSha/receipt` | 回执签的是**整份请求体 sha**，所以 uiEvidence 若随请求体来，也被同一回执覆盖 |

**B. 出借接管（A 侧，B 交付通道挂死）**：`src/lib/lend-pr-takeover-ledger.ts` `takeoverLend` → `deliver(..., ui: uiDeliverPort({peer}))`，**不带** uiEvidence（`d88b795b` 有意如此）：on 下 ui 卡接管按 `missing` 拒，observe 下记一条，off 旧路径。

**C. 本机交付**：MCP `deliver`（`src/lib/order-deliver.ts` → CLI `ledger deliver --ui-evidence`）与 CLI `deliver`（`src/manager/ledger-write-cmds.ts` `deliverCmd`，`uiDeliverPort()` 无 peer）：只认 `source: "local"`，根 = `<state>/ledger/ui-artifacts/<taskId>/`。本文不改这条（本机写图的人就是交付者，信任来自本机身份核对），只在 §5 说明共存。

**D. 截图被谁看、谁批准**：`src/lib/scheduler-ui-gate.ts` / `scheduler-ui-merge-refusal.ts` / `ledger-ui-approve.ts`（`docs/architecture/scheduler-ui-gate.md`）：默认 PM `ledger ui-approve --head --digest`，`ownerVisual` 卡走 owner 认证 ask；批准绑 head / specRev / round / `screenshotsDigest`。**登记截图永远不是批准**（UISDEL1 不变式），本文保持。

### 0.2 缺口（r2 `lend-drive-gap` P2 的具体内容）

- **G1 没有发送端**：A1/A2 从不产生 uiEvidence，远端 ui 交付在 on 下必然 `missing`（observe 下每张卡每轮一条 note）。这是**已知且本卡不补**的缺口：补它就是新发送端 / PNG 传输，按规格另立卡。
- **G2 来源只是一份文件**：A8 认 `provenance.json` 只核「文件存在 + 字段相等」。`<state>/ledger/ui-artifacts/imported/` 在本机 OS 用户可写范围内，**没有任何代码写它**（全仓 grep 无写入方），也没有台账行与之对应。于是本机任何同用户进程（PM、本机 worker、手误的脚本）手写 `imported/<peer>/<order>/provenance.json` + 图片 + 算好 sha，就能在 on 下让一次**真实的远端交付**登记出 `bytesVerified: true, peer: …` 的截图——形式上像「远端已认证」，实际来源是本机手写。这正是规格说的「用 JSON 存在冒认证」。
- **G3 绑定不全**：`provenance.json` 不绑 taskId / specRev / round / 清单摘要 / 租约代数 / 钉钥指纹 / 字节数；同一 `<peer>/<order>` 目录对任何 head 以外的变化都无感（见 §3 矩阵）。
- **G4 无入库时刻与撤单关系**：文件没有「何时、经哪条认证请求、在单处于什么状态时」进来的记录；撤单 / 收回 / 租约过期后补放的文件与之前放的不可区分。
- **G5 登记后可变**：on 登记的 `extra.screenshots` 是 imported 根下的可写路径；登记后被改，PM 看到的图与 `screenshotsDigest` 可能不再一致（本机 local 根同样如此，属既有性质；§4.6 只对 imported 收紧）。
- **G6 预算未界定**：单图 ≤ 10 MiB、≤ 16 张（最多约 160 MiB/单），没有单笔总量、单 peer 总量上限，也没有与出借单原预算（`MAX_WRITE_RUN_MS`、`LEND_BODY_MAX`）的关系。

---

## 1. 两类事实，必须分开

| | 本机可手写 provenance（今天） | 正规已认证入库事实（本文定义） |
|---|---|---|
| 载体 | `imported/<peer>/<order>/provenance.json` 文件 | 台账表 `ui_artifact_imports` 的一行（§2），与 `lend_orders` 同库同事务 |
| 谁能产生 | 任何能写 state 目录的本机进程 | 只有已认证导入入口：bridge 已验 E2E + 钉钥签名的 peer 请求 → owner 身份 CLI → 事务内写（同 A4→A5→A6 的信任链，§4.1） |
| 能证明什么 | 什么都不证明（只是「有人放了个文件」） | 「peer P（钉钥指纹 F）在单 O 第 g 代租约、卡 T 第 r 轮 / specRev s / head h 上，经一次已认证请求交来了这几份字节，A 当场算的 sha 是这些」 |
| 交付核对认不认 | **不认**（改后只作诊断，不参与放行） | 唯一认的来源 |
| 缺了怎么办 | — | `import_unrecorded`：按 `uiDelivery` 策略 fail-closed（§4.4） |

规矩：**文件存在 ≠ 来源成立**。目录、文件名、`provenance.json` 内容一律只当「位置」，来源只看台账行；台账行也只当「这些字节来自这一单」，不是批准（批准仍只在 §0.1 D）。

---

## 2. 入库事实的数据模型（拟议，未实现）

新表（`src/lib/ledger-ui-import.ts` 建表，同 `lend_orders` 的迁移方式）：

```
ui_artifact_imports(
  importId     TEXT PRIMARY KEY,   -- = sha256(orderId|manifestDigest)，幂等键
  orderId      TEXT NOT NULL,      -- lend_orders.orderId
  peer         TEXT NOT NULL,      -- = lend_orders.peer = 认证请求的 peer
  peerFp       TEXT NOT NULL,      -- 写入时该 peer 钉住的公钥指纹（deliveryBranchMatches 同一来源）
  worker       TEXT NOT NULL,      -- = lend_orders.worker
  leaseGen     INTEGER NOT NULL,   -- = 写入时 lend_orders.leaseGen
  taskId       TEXT NOT NULL, specRev INTEGER NOT NULL, round INTEGER NOT NULL,  -- round = 目标审查轮 = 写单.round + 1（同 uiEvidence.round，见 §3 轮次映射）
  head         TEXT NOT NULL,      -- 40 位；写入时须 = 远端订单分支 head（remoteHead 同口径）
  manifestDigest TEXT NOT NULL,    -- = uiEvidenceDigest(清单)，A 自己重算
  files        TEXT NOT NULL,      -- JSON [{ref, sha256, bytes}]，sha256 / bytes 均为 A 对收到字节当场算的
  totalBytes   INTEGER NOT NULL,
  requestSha   TEXT NOT NULL,      -- 那次认证请求原文 sha256（与回执同口径）
  state        TEXT NOT NULL,      -- 'imported' | 'void'（撤单 / 收回 / 卡移动后作废，只增不删）
  actor TEXT NOT NULL, createdAt INTEGER NOT NULL, voidedAt INTEGER, voidReason TEXT
)
UNIQUE(orderId, head)               -- 一单一 head 只一份清单
```

同事务追加一条 `ui_import` 事件（target = taskId），供审计与 PM 视图；不写 `extra`，不动卡阶段。

存放：字节落 `<state>/ledger/ui-artifacts/imported/<peer>/<order_>/<manifestDigest>/<ref>`（**沿用** UISDEL1 已有的 imported 根，不新增可读根）；先写同目录下临时名、fsync、校验 sha、`rename` 进位，文件 0444、目录 0555；事务提交前目录已就位，提交失败则删掉临时目录（孤儿目录没有台账行，永远不被认，§3 U2）。

---

## 3. 字段绑定与缺字段矩阵

✓ = 有且被核；△ = 有但只是声明 / 不被核；✗ = 没有。「拟」列是 §4 改后交付核对实际比较的项。

| 字段 | uiEvidence 清单 | provenance.json（今） | lend_orders | DeliverRequest / 回执 | 拟：import 行 | 拟：交付核对比较 |
|---|---|---|---|---|---|---|
| peer | ✗ | △（字符串相等） | ✓ | ✓（认证请求的 peer） | ✓ | 行.peer = port.peer.peer |
| 钉钥指纹 | ✗ | ✗ | ✗ | ✓（`deliveryBranchMatches`） | ✓ | 行.peerFp = 当前钉钥指纹（换钥即失效） |
| worker | ✗ | △ | ✓ | ✓（步骤 `worker@peer`） | ✓ | 行.worker = port.peer.worker |
| orderId | ✗ | △ | ✓ | ✓ | ✓ | 行.orderId = port.peer.orderId |
| leaseGen | ✗ | ✗ | ✓ | ✓（`req.gen`） | ✓ | 行.leaseGen = 交付时 `lend_orders.leaseGen` |
| taskId | ✓ | ✗ | ✓ | ✓ | ✓ | 行.taskId = 清单.taskId = 卡 id |
| specRev | ✓ | ✗ | ✓ | ✗ | ✓ | 行.specRev = 清单.specRev = 卡.specRev |
| round（目标审查轮） | ✓（目标轮） | ✗ | ✓（单当前轮，build/fix 写单 = 卡.round） | ✗ | ✓（目标轮） | 行.round = 清单.round = 单.round + 1 = 卡.round + 1（交付时卡在 build/fix） |
| head | ✓ | △ | ✓（起点） | ✓（远端核过） | ✓ | 行.head = 清单.head = 交付 head |
| 清单摘要 | ✓（自证） | ✗ | ✗ | ✗ | ✓（A 重算） | 行.manifestDigest = 清单.digest |
| 每图 sha256 | △（声明） | △（声明） | ✗ | ✗ | ✓（A 算） | 实际字节 sha = 行.files[ref].sha256 = 清单声明 |
| 字节数 / 总量 | ✗ | ✗ | ✗ | ✗ | ✓ | 实际 bytes = 行.files[ref].bytes；总量 ≤ 上限 |
| 入库时单状态 | ✗ | ✗ | ✓ | ✓ | ✓（写时须 `claimed`） | 行.state = `imported` |
| 认证请求 | ✗ | ✗ | ✗ | ✓（E2E + 签名 + 回执） | ✓（requestSha） | 只要求存在；不复核签名（写入时已核） |

缺任一 ✓ 项的比较 → 该次交付的 ui 来源不成立，问题码见 §4.4。

**轮次映射（单 / 卡当前轮 ≠ 目标审查轮）**：`lend_orders.round` 是挂单时卡的当前轮（`ledger-lend.ts` 以 `task.round` 写入），build / fix 写单期间卡停在 `build` / `fix`，`task.round` 不变；uiEvidence.round 按既有口径是**交付后进入的 review 轮**——`ledger-deliver-ui.ts` `check` 取 `target = task.stage === "review" ? task.round : task.round + 1`，`order-deliver-ui.ts` schema 同写「= 单上 round + 1」。导入只发生在单 `claimed`、卡在 build / fix 时，于是：

- 导入口核：`清单.round === 单.round + 1 && 单.round === 卡.round && 卡.stage ∈ {build, fix}`；不满足 → `import_mismatch`（round）。
- 行.round 存目标轮（= 清单.round），**不另存单轮**：单轮由 `orderId` → `lend_orders.round` 推导，需要时 join，不冗余。
- 交付核对：沿用 `check` 的 `target`，比较 `行.round === 清单.round === target`；不新写第二套轮次算法。

| 例 | 单 / 卡 | 合法清单.round | 行.round | 错误构造 → 结果 |
|---|---|---|---|---|
| 首轮 build | 单 `r0`、卡 build round 0 | 1 | 1 | 清单填 0 → `parseUiEvidence` / 导入口拒；按 0 入库不可能 |
| 后续 fix | 单 `r1`、卡 fix round 1 | 2 | 2 | 清单填 1（当前轮）→ 导入 `import_mismatch`；即便旧行 round=1 存在，交付 `wrong_round` |
| fix 后再 fix | 单 `r2`、卡 fix round 2 | 3 | 3 | 复用上一轮 round=2 的行（同单不可能；新单新 orderId）→ `import_unrecorded` |

---

## 4. 设计

### 4.1 写入口（**本卡不实现，导入传输卡另批**）

唯一合法写入路径复用现有信任链，不另造认证：B → `POST /api/v1/lend/<导入端点>`（A4 同一套：E2E 内层、钉钥、签名）→ bridge 以 owner 身份调 `ledger lend-ui-import -- <peer> <raw>`（A5 同形）→ 事务内：

1. 复用 `ledger-lend-result.ts` `check` 的单状态核对（属此 peer、`claimed`、租约未过、`gen` 相等、卡未移动、步骤仍绑 `worker@peer`）与 `deliveryBranchMatches`；**撤单 / 收回 / 过期 / unknown 一律拒**（`cancelled` / `lease_expired`），不落字节。
2. `parseUiEvidence` 严格解析清单（UISDEL1 同一解析器），`source` 须 `imported`，taskId / specRev 与单、卡当前值相等，round 按 §3 轮次映射核为目标轮（= 单.round + 1 = 卡.round + 1，卡在 build / fix）；`remoteHead` 核 head 是订单分支当前 head。
3. 对收到的每份字节自己算 sha / bytes，与清单逐项相等；总量与张数过 §4.5 上限。
4. 幂等：同 `importId` 且 files 逐项相同 → 回旧回执；同 `(orderId, head)` 不同清单 → `conflict`，不覆盖。
5. 写行 + `ui_import` 事件；回执 `sign([orderId, requestSha, importId, taskId])`（复用 `deps.sign` 实例钥）。

传输形态（字节放进请求体分片、还是另一条通道）属于导入传输卡，本文不选、不批。该卡未获批之前**这张表没有任何写入方**，于是所有远端 ui 交付都落到 §4.4 的 `import_unrecorded`——这是有意的 fail-closed 状态，不是 bug。

### 4.2 交付核对改法（`ledger-deliver-ui.ts`，实现卡做）

`port.peer` 在时，把 A8 `provenance()` 换成 `importedFact(db, peer, e)`：

- 查 `ui_artifact_imports WHERE orderId=? AND head=? AND state='imported'`，按 §3 最右列逐项比较；当前钉钥指纹经端口注入（`UiDeliverPort` 加 `peerFp?: string`，由 `writeLendDeliver` 把它已拿到的 `fp` 传进来，不另查）。
- 根 = `imported/<peer>/<order_>/<manifestDigest>/`，仍用 `openAttachment` 读、仍重算实际 sha、再与行比较字节数。
- `provenance.json` **不再参与放行**；存在与否、内容如何都不改变结果（可在 observe note 里作为诊断提一句「有手写来源文件，未计入」）。
- 本机 `local` 分支一字不改。

### 4.3 幂等、重放与撤单迟到

- 交付重放沿用 `uiReplaySame`（同 dedupKey 只认同一清单摘要）和 `writeLendDeliver` 的 `resultSha` 幂等；import 行由 `UNIQUE(orderId, head)` + `importId` 幂等。
- 撤单 / 收回 / 租约过期：`sweepLend` / `takeoverLend` / reclaim 在把 `lend_orders` 移出 `claimed` 的**同一事务**里把该单 `imported` 行置 `void`（实现卡改这些写点，只追加一行 UPDATE）；之后迟到的导入按 §4.1 第 1 步拒，迟到的交付按 A6 `check` 拒，二者都碰不到 void 行。
- 收回后重借是新 orderId：旧行的 orderId 对不上，不会被新单借用。

### 4.4 缺来源时的行为（fail-closed，与现有策略共存）

新增问题码，全部走既有 `planUiDelivery` 的 mode 分支，不加开关：

| 码 | 条件 | off | observe | on |
|---|---|---|---|---|
| `import_unrecorded` | 没有 `state='imported'` 的行 | 旧路径，不读 | 一条去重 note，不拦不写截图 | 拒交付，整笔不写 |
| `import_mismatch` | 行在，但 §3 任一比较项不等 | 同上 | 同上 | 同上 |
| `import_void` | 行已作废 | 同上 | 同上 | 同上 |
| `import_fp_changed` | 行.peerFp ≠ 当前钉钥 | 同上 | 同上 | 同上 |
| 既有 `hash_mismatch` / `artifact_missing` / `too_large` | 字节层 | 同上 | 同上 | 同上 |

`provenance_invalid` / `provenance_mismatch` / `not_imported` 三个旧码随 `provenance()` 一起退役（实现卡同步改测试里被替代的断言）。

### 4.5 字节上限与原预算

- 不放大任何现有上限：单图仍 ≤ `FILE_MAX` 10 MiB、≤ 16 张；新增**单单总量** ≤ 32 MiB、单 peer 同时 `imported` 未结单总量 ≤ 128 MiB（超了导入拒 `invalid`，不截断）。数值写成常量，改大须走审批（§7）。
- 导入不延长租约、不改 `MAX_WRITE_RUN_MS` / `LEND_BODY_MAX`：字节传输时间计在原写单预算内；交付正文仍只带清单（≤ 16 条 × 短字段，远小于 96 KiB）。
- 入库只增不删；清理（单 `done` + 卡合并或作废 N 天后删目录、行置 `void`）列为实现卡的后续项，不在本卡。

### 4.6 隔离与只读消费

- 字节只在 `imported/<peer>/<order_>/<manifestDigest>/` 下，按 peer → 单 → 清单三级隔离；跨 peer 没有共享路径，路径也不是权威（权威是行）。
- 0444 / 0555 只防误改，不防同用户恶意（同 `lend-submit.ts` 的 T85 威胁模型：防误投不防伪造）；真正的防线是**交付时**与行比较实际字节（重算 sha / bytes）。
- **不由本方案关闭的既有缺口（归 UIHASH1）**：交付之后，`ledger-ui-approve.ts` 只比较输入 `--digest` 与 `task.extra.screenshotsDigest`，`scheduler-ui-gate.ts` 只发路径与已存摘要，二者都**不重 hash 图片**。同用户可在交付后 chmod 换图，PM 看到的是新字节、批准的仍是旧摘要且照过。现有批准是「摘要字符串绑定」，**不是实际字节校验**；本设计不改这点，也不把它描述成字节验证。
- 消费方（`scheduler-ui-gate.ts` 给 PM 发路径、`ui-approve`）只读这些路径，不在其中执行、不解析图片以外的内容；不新增任何可读根（imported 根 UISDEL1 已在 `UI_ARTIFACT_ROOT` 下）。

---

## 5. 与现有流程共存

- `uiDelivery` = off：远端 / 本机都走 UISDEL1 之前的旧路径，本设计零影响。observe（默认）：远端 ui 交付继续每单每轮一条 `import_unrecorded` note，不拦，卡照常进 review。on：远端 ui 交付在导入卡获批前一律被拒——**这与今天 on 下的实际效果相同**（今天 G1 已让它 `missing`），只是关掉了「手写 provenance 绕过」这条路。
- 合法人工流程不变：远端 ui 卡交付后 PM 按现有方式在本机看 PR / 本机复现截图、经 manager 身份的现有卡写入（`ledger task-set --extra`）登记 `extra.screenshots` / `screenshotsDigest`、再 `ledger ui-approve --head --digest`（ownerVisual 走 owner ask）。这条路的信任来自 PM 本人身份与 ui 闸，不来自 import 行，本设计不碰。
- 接管（0.1 B）不带 uiEvidence，行为不变；接管后由 PM 走人工流程。
- 不绕 security 独审、不绕 UI 批准：import 行只证明「字节来自这一单」，从不写 `answer.owner`、`ui_approved` 或任何决策事件。

---

## 6. 反例（每条写成实现卡的回归测试，先红后绿）

| # | 类 | 构造 | 今天 | 改后 |
|---|---|---|---|---|
| R1 | 手写冒认证 | on；真实远端交付带合法清单；本机手写 `imported/<peer>/<order_>/provenance.json` + 图（sha 全对），无 import 行 | **通过**，登记 `bytesVerified: true, peer` | `import_unrecorded` 拒，整笔不写 |
| R2 | 重放：同单旧清单换 head | 行绑 head h1；B 推 h2 后用 h1 的清单（改 head 重算 digest）交付 | provenance 只核 head，若手改 provenance 即过 | 无 `(orderId,h2)` 行 → `import_unrecorded` |
| R3 | 重放：同单同 head 换清单 | 已入库清单 D1；再导入 D2 | 无幂等概念 | 导入 `conflict`；交付带 D2 → `import_mismatch` |
| R4 | 重放：同请求重发 | 同原文导入两次 | — | 第二次回旧回执，无第二行 |
| D1 | 字节漂移（交付前） | 入库后、交付前改一张图 | provenance 声明与实际不符时拒（`not_imported`） | `hash_mismatch`（与行比） |
| D2 | 漂移：规格 / 轮次 | 入库后 PM 改规格（specRev+1）或卡回 fix 再交 | provenance 不绑，照过 | `import_mismatch`（specRev / round） |
| D4 | 轮次映射：首轮 build | 单 r0、卡 build 0；清单 round=1 导入并交付 / 清单 round=0 | — | round=1 通过；round=0 导入拒（`import_mismatch`），交付 `wrong_round` |
| D5 | 轮次映射：后续 fix | 单 r1、卡 fix 1；清单 round=2 / 清单 round=1 | — | round=2 通过；round=1 导入 `import_mismatch`，交付 `wrong_round` |
| D3 | 漂移：字节数 | 同 sha 不可能不同长，但行.bytes 与实际不等（截断写入） | 无 | `import_mismatch` |
| X1 | 跨 peer | peer Q 的单 O2 交付，清单 ref 指向 peer P 单 O1 的已入库文件 | 根按 Q 拼，P 的文件不可见 → `artifact_missing`（已防） | 同（行按 orderId+peer 查不到） |
| X2 | 跨 peer：目录名伪造 | 手建 `imported/Q/O2_/` 拷入 P 的图 + 手写 provenance | 通过 | 无行 → `import_unrecorded` |
| X3 | 换钥 | 导入后 peer 重钉公钥再交付 | 不感知 | `import_fp_changed` |
| L1 | 撤单迟到：导入 | 单已 `cancelled` / 过期后 B 才发导入 | （无导入口） | 导入按 `check` 拒，不落字节 |
| L2 | 撤单迟到：交付 | 导入成功 → 撤单（行置 void）→ 交付 | A6 `check` 已拒 `cancelled` | 同；即便绕过 check，`import_void` |
| L3 | 收回重借 | 旧单 O1 已入库，收回后新单 O3 交付复用 O1 清单 | 手拷目录即过 | O3 无行 → `import_unrecorded` |
| U1 | 未知效果：回执丢 | A 写行成功、响应丢，B 重发同原文 | — | 幂等回旧回执 |
| U2 | 未知效果：崩在中间 | 字节已 rename 进位、事务未提交即崩 | — | 孤儿目录无行，永不被认；重发同原文重新走一遍，目录同名覆盖前先核 sha |
| U3 | 未知效果：单 `unknown` | `lend_orders.status='unknown'` 时导入 / 交付 | 交付已拒 | 导入也拒；PM 对账前不入库 |
| P1 | 策略共存 | off / observe / 失读回落 off 下跑 R1 | off 不读；observe 记 note | 同：off 不读；observe 记 `import_unrecorded`，均不写截图 |

---

## 7. 拟改文件与审批清单

**实现卡（下一张，code 模板，需 security 独审）——只做 §4.2–4.4、§4.3 的作废写点，不含任何传输：**

| 文件 | 改什么 |
|---|---|
| `src/lib/ledger-ui-import.ts`（新） | 建表、`importedFact` 查询、`voidImports(db, orderId, reason)` |
| `src/lib/ledger-deliver-ui.ts` | `provenance()` → `importedFact`；新问题码；`UiDeliverPort.peerFp` |
| `src/lib/ledger-deliver-ui-port.ts` | 端口透传 `peerFp` |
| `src/lib/ledger-lend-result.ts` | `writeLendDeliver` 把已拿到的 `fp` 传进端口 |
| `src/lib/ledger-lend.ts`（`sweepLend` / 撤单写点）、`src/lib/lend-pr-takeover-ledger.ts`、收回写点 | 同事务 `voidImports` |
| `tests/ledger-lend-write-ui.test.ts`、`tests/order-deliver-ui.test.ts`、新 `tests/ledger-ui-import.test.ts` | §6 全部反例；替换依赖 provenance.json 的旧断言（superseded_assertion） |
| `docs/architecture/scheduler-ui-gate.md` | 补一段「远端截图来源只认 import 行」 |

**导入传输卡（再下一张，需 owner 批准 + security 独审 + 跨族审）**：B 侧产出截图并把清单放进 `publishWork` 正文、导入端点与 `ledger lend-ui-import`、字节在线格式。**本设计不批准、不预设它的形态。**

**需要人拍板的边界（实现 / 传输卡开工前逐项过）：**

1. 新增 lend 端点或扩大 lend 正文上限（owner + security）。
2. §4.5 任何上限的放大（owner）。
3. 任何新可读根、或让 imported 根以外的路径进入 `extra.screenshots`（security）。
4. `uiDelivery` 生产切 on（owner；本设计不改默认 observe）。
5. 让 import 行影响 ui 批准语义（不允许；如有需要另立设计）。

---

## 8. 验证说明

本卡只交设计：没有实现探针，§6 的「今天」列是按基线代码逐行推演（`ledger-deliver-ui.ts:71-115`、`ledger-lend-result.ts:151-235`、`lend-drive.ts:274-299`），不是运行结果，不能当作实现已验证。
本分支跑了 `bun run typecheck`、`bun test`、`GUARD_STRICT=1 bun run guard` 和 CI 同款八个入口 `bun build`（结果见交付自查）；全量以 PR head 上 CI 三项为准，另请独立跨族审查。
