# delivery-flow-P1 · 本人正式交付与受控接管自动派审（设计）

状态：设计稿（specRev 1，基线 head `61f24b83c2998e0f5aa75a34f8945eb28c73e146`）。本卡只出方案，不改产品、配置、安全规则，不启用任何机制。
目标：执行者做完后**本人**直接走正式交付并进入正式审查派单，PM 不再做常规代码交付中转；PM 只在接管时显式授予一次「交付后自动交回派审」资格，其余仍按现有人工流程。

---

## 0. 现状核对（只读，均为基线代码）

### 0.1 交付入口

| 入口 | 位置 | 身份 / 授权 | 已有保护 | 缺的 |
|---|---|---|---|---|
| CLI `ledger deliver <task> --from build\|fix --head` | `src/manager/ledger-write-cmds.ts:229` `deliverCmd` → `src/lib/ledger-write.ts:218` `deliver` | `requireOwnOrManager`（`src/manager/ledger-context.ts:116`）：`task.agent` 本人或 PM / master / owner；actor 由 `DISCORD_CHANNEL_ID` 算 | `checkShippedHead`、`checkReviewHead`、`--dedup` 回放、可选 `--rev/--branch` CAS、终态拒绝、证据只收路径 | 不核 origin head、不核 PR、不核会话绑定；PM 也能代交（这正是要避免成为常规路径的「PM 代交付」） |
| MCP `deliver`（派单工具） | `src/lib/order-tools.ts:27` 定义 → `src/bridge/order-tools.ts:55` → `src/lib/order-deliver.ts:73` `deliverOrder` | `routeOrderTool` 先过 `requireVerified`（`src/lib/order-tool-route.ts:28`）；`orderId` 必须在 `currentOrders(db, call)` 里 | 小写 40 位 SHA；`deliverDedupKey(orderId, head)` 回放且须本人事件；bridge 自己 `git ls-remote` 核 origin head；open PR 唯一且 base=main；`--rev/--branch` 前置条件在 CLI 事务内 CAS；`deliveredScope` | 只认 `currentOrders` 产出的 orderId，见 0.2 |
| 出借 worker（`agent-lend-*`） | `src/bridge/order-tools.ts:72` `isLendCaller` → `bridge/lend-tools.ts` | 整条分走，到不了本机台账工具 | — | 不在本卡范围 |

### 0.2 MCP 的真实缺口（不是「manual 卡都交不了」）

`src/lib/order-take.ts` `scanOrders`：卡在 `build/fix`、`stepAtStage` 的执行者是 `executorKind=agent` 且等于调用方、`bindingAllows`（未退役的 author 会话绑定须是调用方本人本会话）、且没借出去（`lentAway`）时，就产出一张单：

- 调度派的：orderId = 当前阶段的 dispatch intent id；
- **PM 手动派的：orderId = `manualOrderId(task, step, round)` = `<task>:<step>:r<round>`**。

所以手动派、当前执行者本人、会话没换的 manual 卡**今天就能**用 MCP `take_order` + `deliver` 正式交付。真正交不了的只有这几种（「手动本机接续」落在这里）：

1. **会话换代**：auto 卡被 PM 接管（`workflow-set --mode manual --reason`，`src/lib/ledger-scheduler-write.ts:97`）后，`scheduler_sessions` 里 author 绑定仍是旧会话；换会话 / 换 agent 接续 → `bindingAllows` 拒 → 无单 → `not_current_order`。
2. **步骤执行者不是调用方**：PM 改了 `task.agent` 但 steps 里当前步执行者没改，或执行者是 `peer_agent` / `human`。
3. **仍算借出**：`lend_orders` 有 `pooled/claimed/unknown` 行（含 unknown 副作用未对账）→ `lentAway` 隐藏本单。
4. **阶段不对**：卡停在 `review/blocked`（例如外发闸拒后未退回 fix）。

外发闸：`offerLendCore`（`src/lib/ledger-lend.ts:177`）在 `redactOrderForPeer`/`renderOrderWire` 抛 `OrderRenderError` 时整笔不写、提示「留在本机做」。拒后**不产生** lend_orders 行，所以本机修复走的是上面第 1/2 类缺口，而不是外发闸本身。

### 0.3 自动交回（今天只认合并撤销）

- `src/lib/scheduler-autostart-resume.ts` `resumeVerdict`：workflow=manual、卡在 review、最近一条 mode 事件 T 是 `merge_resolve(cancelled/failed)` 或 `fallback_manual(merge_retry_requires_pm…)`；T 之后有 `task.agent` 本人的 deliver，head ≠ 被撤销 head、= 卡上 head，且紧前一条 stage 事件是同一 actor 推到 review（`stage.seq === d.seq - 1`）。
- `modeEvent` 把 `workflow` 事件中 `mode≠manual` / `takeover` / `hold` 都算 mode 事件：**PM 接管、hold 一出现就压过 T，不交回**（设计如此，保留）。
- `src/lib/ledger-autostart-resume.ts` `autoResume`：只给 `scheduler` 身份，事务内重判 rev/workflowRev/开关/`resumeVerdict` 后走 `resumeCore`（`src/lib/ledger-scheduler-resume.ts:34`）；`resumeCore` 撤池单、拒 `submitted/unknown` 意图、取消 pending、置 auto 并记 `workflow_resume` 事件。
- PM 手动入口 `resumeAutoWorkflow`（同文件 :22）走同一核心。
- 结论：今天「外发闸拒→本机修复→本人交付」之后，必须 PM 再 `workflow-resume` 才会派审——这是本卡要去掉的中转。

### 0.4 测试现状

存在：`tests/scheduler-autostart-resume.test.ts`、`tests/ledger-scheduler-resume.test.ts`、`tests/order-tool-route.test.ts`、`tests/order-deliver-pr.test.ts`、`tests/order-deliver-scope*.test.ts`、`tests/order-executor.test.ts`、`tests/scheduler-pool-takeover.test.ts`。
不存在（源码注释引用但仓库里没有）：`tests/order-deliver.test.ts`、`tests/order-take.test.ts`。实施节点需新建。

---

## 1. 能做 / 需新模块 / PM 选择 一览

| 需求 | 判定 | 依据 |
|---|---|---|
| 当前执行者本人、会话未换的 manual 卡 MCP 交付 | **已能做**，只需在 roles 文档写明走 `take_order`+`deliver` | 0.2 `manualOrderId` |
| 当前执行者 CLI 交付 | **已能做**（但不核 origin / PR / 会话，不能作为自动交回依据） | 0.1 |
| 接管后换会话的本人 MCP 交付 | **需小改**：授予时由 PM 原子换绑 author 会话（§2） | `bindingAllows` |
| 接管后交付自动派审 | **需新模块** `scheduler-resume-grant.ts` + 扩 verdict（§3） | 0.3 |
| on / observe / off 开关 | **需小改**：`meta.autostart` 加字段（§4） | `readSwitch` |
| 结构化 fix 材料 | **已大半具备**（`fixContext`/`wireFindings`），只补来源引用（§5） | `order-take.ts` `fixContext` |
| 是否给某张卡授予资格、有效期多长 | **PM 选择**（每次接管时决定），默认不授予 | — |
| 开关默认值上线后改 on | **PM / owner 选择**，本卡不改 | — |

---

## 2. 执行者本人 MCP 直接交付（向后兼容）

原则：**wire 不变**，`deliver` 仍只收 `orderId`，不新增 `taskId` 入参——任何 agent 都不能凭 taskId 交别人的卡；worker 不获得任何新调度权限。

### 2.1 接续的唯一合法形态

人工接续的单号沿用 `manualOrderId(task, step, round)`，`currentOrders` 产出它的条件不放宽，仍需同时满足：

- 卡在 `build/fix`；当前步 `executorKind=agent` 且 `executor = call.agent`（来自已验证身份，不来自参数）；
- 未退役的 author 绑定 = `call.agent` + `call.sessionId`（会话为空则拒，与现状一致）；
- 无未结出借单。

换会话的接续不由 worker 自己解决，而由 PM 在接管授予时**换绑**（§3.2 `grant` 同事务内插入新 author 绑定）。`scheduler_sessions` 有唯一索引 `(taskId, role) WHERE state != 'retired'`（`src/lib/scheduler-sessions.ts:215`），旧会话的退役归 `scheduler-retire.ts`（归档 / kill 回执），所以授予**不**直接改旧行：旧绑定未到 `retired` 时带新会话的授予直接拒（`conflict`，提示先走现有退役），已退役才插入新绑定。PM 不授予时，接续仍可走 CLI（现状），只是不会自动派审。

### 2.2 MCP deliver 保持的检查（不改顺序，`src/lib/order-deliver.ts` 头注释 1–6 条）

wire 校验 → dedup 回放（必须本人事件）→ 当前单 → origin `ls-remote` head 完全一致 → open PR 唯一 / base main / head 一致 → `--rev --branch` 事务内 CAS → `deliveredScope`。

### 2.3 唯一改动：交付事件记下「经哪张单、哪个会话」

`deliverOrder` 调 `ledgerWrite` 时追加两项，只取自 `VerifiedCall`：`--order=<orderId>`、`--session=<call.sessionId>`；`deliverCmd` 接收后原样写进 deliver 事件 `data.orderId / data.session / data.via="order_tool"`。CLI 直接调用不带这些字段（字段缺失 = 不是正式单路径），所以 CLI 交付**永不**满足 §3 的自动交回条件。
说明：本机 agent 都是同用户 shell，CLI 旗标可被伪造（`src/lib/caller-witness.ts` 已写明同一前提）；因此 §3 不单信这两个字段，还要求调度服务在交回前**自己**再 `ls-remote` 核 origin head（§3.4），并在事务里核绑定与 dedup 键 `deliverDedupKey(orderId, head)` 存在且 actor 一致。

---

## 3. 受控接管后的自动交回（一次性资格）

### 3.1 状态转移

```
auto ──PM workflow-set manual --reason --resume-grant──▶ manual[grant G]   (T = 带 G 的 workflow 事件)
manual ──PM workflow-grant --reason──────────────────▶ manual[grant G]   (T = op:"resume_grant" 事件)
manual[G] ──执行者 MCP deliver（新 head，stage→review 紧邻）──▶ review/manual[G 待兑现]
review/manual[G] ──scheduler-auto-resume（同一事务判定+resumeCore）──▶ review/auto   (workflow_resume{grant:G.id})
                                                              └─ 下一轮 auto tick 正常派审（原审查派单、回执、跨模型、UI/CI 闸全不变）
任何更晚的 mode 事件（hold / 再接管 / 回 auto / fallback_manual / 合并撤销）──▶ G 作废（不再是最近 T）
```

- 普通接管（不带 `--resume-grant`）、hold（manual→manual 带 reason，`ledger-scheduler-write.ts:105`）**不带资格**，行为与今天一致。
- 兑现即消费：`workflow_resume` 本身是 mode 事件，兑现后 G 不再是最近 T，重复 deliver / 重启 / 再次 tick 都不会二次交回；不需要单独的「已用」标记，也不改写任何历史事件。

### 3.2 授予接口（只给真 PM：`requireRealPm`，调度助理 / scheduler / 执行者都不行）

- `ledger workflow-set <task> --mode manual --reason <r> --resume-grant [--grant-session <sid>] [--grant-ttl-h <n>]`（auto→manual 时）
- `ledger workflow-grant <task> --rev <taskRev> --workflow-rev <wfRev> --reason <r> [--grant-session <sid>] [--grant-ttl-h <n>]`（已 manual 时）

事务内写入事件 `data.resumeGrant`：

```
{ id: "grant:<task>:<eventSeq>", agent: task.agent, session: <sid|当前 author 绑定>, specRev: task.specRev,
  branch: task.branch, priorHead: task.headSHA, round: task.round, expiresAt: now + ttl(默认 24h, 上限 72h) }
```

前置：卡 `code`、非终态、有 `task.agent`/`branch`；无 `submitted/unknown` 意图；无 `pooled/claimed/unknown` 出借单；`--rev/--workflow-rev` CAS。若给了 `--grant-session` 且与现绑定不同，同事务换绑（§2.1）。授予不改 stage、不派单。

### 3.3 判定 `grantVerdict`（新，纯函数，`src/lib/scheduler-resume-grant.ts`）

在现 `resumeVerdict` 里：取最近 mode 事件 T；若 T 是合并撤销 → 走原分支（不变）；若 T 带 `resumeGrant` 或 `op==="resume_grant"` → 走 `grantVerdict`；其它 → 拒（与今天一致）。`modeEvent` 增认 `op==="resume_grant"`。全部成立才 ok：

1. workflow=manual，卡在 review，非 done/cancelled；
2. T 的 actor 在授予时已核为真 PM（写入时核；判定再核 actor ∈ 项目 PM 名单且非 team 调度助理，防名单变化后过期身份）；
3. `now < expiresAt`；
4. `task.specRev / branch / agent` 与 G 一致；author 未退役绑定 = `G.agent + G.session`；
5. T 之后最新 deliver d：`actor = G.agent`、`data.via="order_tool"`、`data.session = G.session`、`data.orderId = manualOrderId(task, step, G.round)`（同一轮）、该 dedup 键的事件就是 d；
6. `d.headSHA ≠ G.priorHead` 且 `= task.headSHA`；紧前一条 stage 事件 `seq = d.seq-1`、`to=review`、同 actor（复用原检查）；
7. T 之后没有：别人的 deliver / stage、`resume_grant` 以外的 mode 事件、新的 lend `refused`/`unknown`、未答的 `class=blocker` ask（「模型拒绝」/需要人：执行者以 blocker 报拒做或安全阻塞时不自动恢复）；
8. 无 `pooled/claimed/unknown` 出借单（unknown 副作用未对账）。

`resumeCore` 自己再拒 `submitted/unknown` 意图与池单 stray（不变）。

### 3.4 执行（扩现有 tick / CLI，不新开入口）

- `autoResumeTick`（`scheduler-autostart-resume.ts:85`）：判定 ok 后，若是 grant 分支，先 `ls-remote origin <branch>`（复用 `remoteHeadAt`，`src/lib/lend-git.ts`）核 = `d.headSHA`，不一致 / 查不到 → 不交回、通知 PM 一次（memo 键 `grant:<task>:<d.seq>`）。
- 然后调现有 `ledger scheduler-auto-resume <task> --rev --workflow-rev --max-workers`，加 `--checked-head <sha>`；`autoResume`（`ledger-autostart-resume.ts`）事务内**再跑一遍** `resumeVerdict`（含 grant 分支）、开关、`checked-head = d.headSHA = task.headSHA`，然后 `resumeCore(..., { auto: true, grant: G.id, trigger: T.seq, deliver: d.seq })`。
- 并发：两个 resume（两个 tick / tick 与 PM 手动 resume）由 `tx` + `taskRev/workflowRev` CAS 保证只有一个成功，另一个 `raced` 静默；调度服务本身有租约（`assertLease`）。
- 重启：memo 丢失最多多通知一次；已交回的卡 mode=auto 不再进候选，不会多派审。

### 3.5 明确不交回的情形

普通 manual / 普通接管 / hold；取消或终态；过期；换 agent / 会话 / spec / branch；head 未变或 origin 不符；仍有 unknown 意图或出借单；有 blocker ask；CLI 交付（无 `via`）；PM 代交（actor ≠ G.agent）；合并撤销**不会**伪造 grant（grant 只来自真 PM 的两个命令，合并撤销分支与 grant 分支互斥按 T 的 op 区分）。

---

## 4. 开关与共存

- `meta.autostart`（`readSwitch`）JSON 增 `resumeGrant: "off" | "observe" | "on"`；**缺省 = off**。feature 级继承现 `switchOff` 规则。
- `off`：`--resume-grant` / `workflow-grant` 照常可记录（仅事件，无副作用），tick 不判 grant 分支。PM 想交回仍用 `workflow-resume`。
- `observe`：tick 只计算 `grantVerdict` 并写调度服务自己的日志（`would_resume` / 拒绝原因）；**不写台账、不通知 PM、不跑 ls-remote**（日志标 `remote: unchecked`）。
- `on`：§3.4 全流程。
- 原 orderId 流程、合并撤销自动交回、PM `workflow-resume`、CLI deliver 全部不变并共存。
- 外发闸、原审查报告、跨模型审查派单、审查派单回执、UI 截图、CI 合并闸**全不改**：交回后由原 auto tick 派审；若派审要外发且闸拒，沿用 refuse-first（留本机 / 退人工 / 报阻塞），**不转换、不删减内容去过闸**；该退回产生新 mode 事件，G 已作废，不会循环。

PM 职责收窄为：决定是否授予、处理异常（rejected 通知、blocker、范围、UI 截图验收）。

---

## 5. 结构化 fix 材料

现状：`order-take.ts` `fixContext` 已经只带本轮本 head 的结构化 finding（`wireFindings`：`findingId/family/severity/probe`，probe 截断）与 `上一轮审查报告：<path>` 一行；出借外发再过 `redactOrderForPeer`（ids 不可改写，含敏感即拒）。

设计（最小增量）：

- 只传 `findingId, family, severity, probe(≤WIRE_LIMITS.probe)`；**不新增字段进 wire**，避免 OrderWire v1 兼容问题。
- 来源引用放 `inputs` 现有那一行，扩为 `上一轮审查报告：<path>（sha256:<前16位>，review 事件 #<seq>）`；原报告文件不改、不复制。
- worker 需要全文：本机走同一 `take_order` 授权（报告路径本地可读）；出借 worker 只能经现有 relay 外发（`peerTextRefusal` / 订单闸），拒了就拒，**不得**用附件、另开通道、截断或改写绕过；拒绝 → PM 收到阻塞提示，留本机修。
- 不改 `peerSecretHit` / `redactForPeer` 规则（另有 owner 待批的左边界卡，不并入）。
- 回归：`tests/order-wire-render.test.ts`（含敏感 probe 仍拒）、`tests/lend-order-chunks.test.ts`（inputs 行长度）、新 `tests/order-take.test.ts`（fix 单带 sha / seq 引用）。

---

## 6. 实施拆分（唯一文件 owner 与 globs）

| 节点 | 唯一 owner 文件 | 测试 globs |
|---|---|---|
| I1 交付事件记来源 | `src/lib/order-deliver.ts`、`src/manager/ledger-write-cmds.ts`（`deliverCmd` 收 `--order/--session`）、`src/lib/ledger-write.ts`（`deliver` data） | `tests/order-deliver.test.ts`（新） |
| I2 授予与换绑 | `src/lib/scheduler-resume-grant.ts`（新：grant 写入、`grantVerdict`）、`src/lib/ledger-scheduler-write.ts`（`--resume-grant`）、`src/manager/ledger-scheduler-cmds.ts`（旗标与 `workflow-grant`） | `tests/scheduler-resume-grant.test.ts`（新） |
| I3 判定与执行 | `src/lib/scheduler-autostart-resume.ts`、`src/lib/ledger-autostart-resume.ts`、`src/manager/ledger-autostart-cmds.ts`（`--checked-head`）、`src/lib/scheduler-autostart.ts`（开关字段） | `tests/scheduler-autostart-resume.test.ts` |
| I4 fix 材料来源 | `src/lib/order-take.ts`（`fixContext` 的 inputs 行） | `tests/order-take.test.ts`（新）、`tests/order-wire-render.test.ts` |
| I5 文档 | `roles/executor.md`（本人 MCP 交付说明） | — |

依赖：I1 → I3；I2 → I3；I4 独立。每节点只动自己的 owner 文件；不动 `src/lib/dispatch-redact.ts`、`order-wire-render.ts` 规则、任何配置。

---

## 7. 回归矩阵

记号：现=现代码已覆盖 / 新=需新测。期望全部在临时 HOME/STATE/RUNTIME 的内存台账上跑，不碰生产。

| # | 场景 | 期望 | 依据 / 测试 |
|---|---|---|---|
| 1 | 执行者本人、会话未换、manual 卡 MCP deliver | 成功，事件带 `via/orderId/session` | 现（单）+新 I1 |
| 2 | 他人 agent 用对方 orderId deliver | `not_current_order`，台账不动 | 现 `currentOrders` + 新 |
| 3 | 同 agent 换会话（未授予换绑） | `not_current_order` | 现 `bindingAllows` + 新 |
| 4 | 旧会话已退役，PM 授予时绑新会话，新会话 deliver | 成功；旧会话再交 `not_current_order`；旧会话未退役时授予 `conflict` | 新 I2 |
| 5 | 卡分支被 PM 改（wrong branch）期间交付 | CLI CAS `conflict`，不写 | 现 `deliver` expect |
| 6 | stale rev / specRev 变化后 | 交付 CAS 拒；grant 判定 specRev 不符不交回 | 现 + 新 I3 |
| 7 | 同 orderId+head 重复 deliver | 回放同一事件；不二次交回 | 现 dedup + 新 |
| 8 | 交付 head = priorHead | 不交回 | 新 I3 |
| 9 | 合法 fresh head + grant + on | 交回 auto 一次，下一轮派审 | 新 I3 |
| 10 | 合法 fresh head + grant + observe | 无任何台账写入 / 通知 | 新 I3 |
| 11 | 合法 fresh head + grant + off / 缺省 | 不判、不交回 | 新 I3 |
| 12 | 普通接管（无 grant） / hold | 不交回（与今天一致） | 现 `modeEvent` 用例 |
| 13 | grant 后又 hold 或再接管 | 不交回 | 新 |
| 14 | grant 过期 | 不交回 | 新 |
| 15 | `unknown` 意图或 unknown 出借单 | not_eligible / rejected 通知 PM 一次 | 现 `resumeCore` + 新 |
| 16 | 交回后派审外发闸拒 | refuse-first 留本机 / 退人工，内容不改；G 不复用 | 现 `offerLendCore` + 新 |
| 17 | 执行者 blocker ask 未答（模型拒做） | 不交回 | 新 |
| 18 | CLI 交付（无 `via`）或 PM 代交 | 不交回 | 新 |
| 19 | origin head 与交付 head 不一致 | 不交回，通知一次 | 新 I3 |
| 20 | 调度服务重启后重跑 tick | 已交回卡不再处理；未交回卡最多再通知一次 | 现 memo 语义 + 新 |
| 21 | 两个并发 resume（tick×2 或 tick+PM） | 一个成功，另一个 `raced` 静默 | 现 CAS + 新 |
| 22 | 合并撤销路径（V1 10-01 金样本） | 行为不变 | 现 `scheduler-autostart-resume.test.ts` |
| 23 | 旧普通卡（无 workflow / 迁移前） | 交付与今天一致，无 grant 分支 | 现 |
| 24 | 非真 PM（调度助理 / 执行者）授予 | `forbidden` | 新 I2 |

---

## 8. 本卡不做

不改产品代码、配置、secret / 脱敏规则；不启用开关；不读生产状态；不做全套调度架构重设计。
