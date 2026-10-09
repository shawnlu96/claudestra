# SFAIL4 · 巡检恢复后过时押后告警的最小接线（设计）

状态：设计稿 r3（specRev 1，基线 head `cc5c5ddf8c83b34ca4f9658bb9f0d1f07bd9d4bb`，依赖 SFAIL1 已合入）。对应 r1 P2 `stale-queued-after-recovery`。r2 按 SFAIL4 r1 审查改：发送边界状态（§3.1–3.2）、queued→delivered→ok 迁移（§3.4）、复用唯一恢复策略入口（§4）。r3 按 SFAIL4 r2 审查（`sfail4-unproven-unsent`）改：发送边界簿记与策略模式**彻底解耦**——任何模式（on / observe / off / 失读回落 off / port 抛错 / 身份异常）下，登记信封越过任何可信发送边界都**无条件**置 `attempted`，策略只决定「可撤候选是否真的撤」，不决定「是否记边界」（§2 不变式 I1、§3.2 全部发送边界、§4、§6 #16–#19）。
本卡只新增本文件：不改源码 / 测试 / 配置 / 队列数据，不撤回任何通知，不碰生产，不创建策略键。**本文不宣称漏洞已修**，也不产出 PASS、取消回执或 owner 授权；后续实现另开节点、另登记文件范围。

---

## 0. 现状核对（只读，均为基线代码）

### 0.1 生产者：`ledgerAuditFailures`

`src/bridge/ledger-audit-failure.ts`（57 行）：

- 状态全在闭包内存：`notices: Map<project, Notice>`，`Notice = { identity:{messageId,threadId,ts}, content, attempts, next, receipt? }`。
- `fail(kind)`：连续第 3 轮起按项目建一份 notice（`newMessageId("audit-failure")` + `newThreadId()`），经 `ports.notify(to, content, identity)` 投；`receipt` 为 `sent` 或 `queued{messageId}` 后不再投，`failed` 按 `retryDelay` 退避重试。
- `ok()`：`rounds/nextLookup/lookupAttempts/diagnostic` 归零并 **`notices.clear()`**。
- ticker（`ledger-audit-service.ts`）有 `running` 守卫，同一 ticker 的 `fail()` 与 `ok()` 不交错；`ok()` 现为同步。

**缺口（即 P2）**：`receipt.kind === "queued"` 的那封此时还躺在押后队列里；`clear()` 只丢了生产者自己的簿记，队里的信封原样留着，PM 下一次 Stop / 扫描时照样收到一条「连续失败至少 3 轮」的过时告警。内存 `.clear()` 不是取消。

### 0.2 投递口：`notifyText`

`src/bridge/ledger-audit-service.ts:57`：

- 信封：`from:{kind:"bridge",label:"ledger-audit"}`，`intent:"notification"`，`meta:{triggerKind:"bridge_synth", waitForIdle:true, ...identity}`——`messageId/threadId/ts` 由生产者给定。
- 判忙（`d.busy` 或 `probeTurn`+`agentMsgMustWait`）→ `d.hold(env)`（bridge.ts:3294 接到 `heldLocalMsgs.holdEnv`）→ 返回 `queued{messageId}`。
- 不忙 → `d.deliver(env)`；**只看 `outcome.kind`**：`deliverToLocal` 在判忙竞态里自己押回时返回 `{kind:"sent", note:"queued"}`（bridge.ts:871），这里会被记成 `sent`。这是第二个已知缺口：生产者以为已送达，实际在队里。
- `notifyText` 不把它造的 `env` 交回给调用方——生产者手里只有 `messageId`。

### 0.3 押后队列与落盘：`HeldQueue` / `PersistedMap`

- `PersistedMap`（`src/bridge/persisted-map.ts`）：每次 `set/delete` 整表 tmp+rename 落 `held-messages.json`，剥掉 `ws`；重启读回的是**新对象**。
- `HeldQueue.hold` 按**信封对象同一性**去重（`i.env === item.env`），不按 messageId；`remove` 在投出之后才摘（至少一次，收件方按 message_id 去重）；`claim/release` 是进程内每频道单投递者锁。
- `ageHeld`：30 分钟 still-queued、24 小时 `gave-up`（`notifyHeldSettled(env,"gave-up")`）。`discard`（kill）→ `"discarded"`。
- 结局监听：`onHeldSettled(env, outcome)`（`held-queue.ts`，`talk.ts:176` 在用）与 `onHeldDelivered(channelId, env)`（`held-flush.ts`，`team-router.ts:225` 在用）。**已有、真实的送达回调**，本设计只订阅，不另造。

### 0.4 flush / 最后一刻核对

- `flushHeld`（`src/bridge/held-flush.ts`）：`claim` 后遍历快照，每条 `d.deliver(env, to, stillWanted)`，`stillWanted = () => held.get(ch)?.includes(item)`；`error`/`shouldRetry` 留队；`sent` 且 `note==="queued"` 停；`sent` → `touch` + `notifyHeldSettled("delivered")` + `deliveredHooks`；**其余（含 `dropped`）直接 `held.remove`，不发结局事件**。
- `deliverToLocal`（bridge.ts:810）：bridge.ts:864 一处合并核对 `stillWanted()` / `turnCuts.noticeWanted(env)` / `resumeStillWanted(env)`，任一为假返回 `dropped "已从押后队列撤下"`。**之后还有两个 await**：`sessionGone(...)`（865）与 `inboundLedgerGate(...)`（874，只记账 / 押后，不自己发），然后才 `to.ws.send`（876）。所以 864 不是「最后一刻」——这点对「恢复后零过时发送」是硬约束（§3.2）。
- **发送边界之后结果未知**：876 的 `ws.send` 与其后的 `noteDelivered` / `emitEvent` / pending 登记共用 875–937 的 `try/catch`，任何一步抛错都返回 `error`；`flushHeld` 对 `error` 留队（held-flush.ts:181）。所以「仍在队里、没有 lease」**不能**证明没发出去——send 之后抛错的那条也是这个样子。
- flush 送达顺序：`notifyHeldSettled(env,"delivered")` 与 `deliveredHooks` **先于** `held.remove`（held-flush.ts:195-200）；inbox ack 走 `inboxDelivered` 同样发 `delivered`。
- 先例：`resumeStillWanted` + `planOf` + `cancelResumePlan`（`src/bridge/quota-wall-wiring.ts:170-197`）是「生产者撤销自己尚未送出的押后信封」的现成写法；`turnCuts.noticeWanted`（`turn-cuts.ts:259`）是「过时就不投」的另一先例。二者都**只在投递口做判定、不另起队列**。

### 0.5 inbox / PM 转交

- `check_inbox`（`src/bridge/inbox.ts`）只领 `takeable`：`held.idleInboxAllowed(i) ?? (inboxTakeable(i) || isAskNotice(i))`。告警是 `from.kind==="bridge"` → `heldKindOf = "other"`，`inboxTakeable` 为假；`isInternalIdleNotice` 对它为真，但 `configureIdleBatch` 在生产里**没有调用方**（`HeldIdleControl` 未配置 → `idleInboxAllowed` 返回 undefined）。结论：**基线生产里告警不会被 inbox 领走、不会有 lease**；但设计必须对未来开启 idle 模式后的 lease 保守。
- `roleHandoffs`/`handOver`（`src/bridge/pm-held-transfer.ts`、`held-flush.ts`）：PM 换代后旧 PM 队里的角色消息（告警不属 `staysWithAddressee`）会转给当班 PM——**同一个 env 对象**移队，`env.to` 会被 `markPmTransfer` 改写。所以身份不能绑在 `env.to.channelId` 上。

### 0.6 结论：没有现成的「按身份精确取消」端口

另：生产者 `fail()` 存下 `receipt` 后不再更新（ledger-audit-failure.ts:47-52），`queued` 那封后来被 flush 送达，`Notice` 里仍是 `queued`。

现有能撤押后信封的只有：`HeldQueue.remove(channelId, item)`（要求持有 item 对象）、`discard`（整频道）、`cancelResumePlan`（只认续跑 label）、以及投递口的三个 wanted 判定。**没有**给 ledger-audit 用的取消口，下面所述均为需新增的最小接线。

---

## 1. 方案候选与选定

| # | 方案 | 优点 | 问题 | 结论 |
|---|---|---|---|---|
| A | `ok()` 时在 `heldLocalMsgs` 里按 messageId / label 找到并 `remove` | 直观 | 要绕过频道锁（与在投的 flush 抢）；按 messageId/label 认 = 规格禁止；send 后 error 留队的、inbox lease 的都无法证明；重启后对象已换 | 否 |
| B | 投递口在 `ws.send` 紧前加一个生产者自有的**发送闸**（仿 `resumeStillWanted`）：以进程内信封对象登记为身份；闸放行即记「已越过发送边界」；只撤「恢复后、从未越过发送边界、从未有 lease」的；其余放行并在结局确定后补一条「已恢复」 | 复用唯一投递口与已有 dropped 语义；不碰锁、不改队列结构；未知结果一律保守 | 需把判定挪到真正最后一刻（864 之后有 await） | **选定** |
| C | 投递时改写正文为「已恢复」 | 不丢消息 | 同 messageId 内容变了，收件方按 id 去重会吃掉 / 混淆；改写持久化消息；对已领取未 ack 的无效 | 否 |
| D | 生产者另落一份「已发告警」簿 | 重启可认领 | 第二套持久状态，盘上材料可被改写后冒充身份；规格禁止第二套队列 | 否 |

选 B 的理由：它和 `resumeStillWanted` 是同一形状（生产者只对自己造的信封说「不要了」，判定放在 `deliverToLocal` 的所有 await 之后），flush / inbox / ack / 至少一次 / 去重的既有规则一行不改；唯一不同是**失败方向相反**——续跑「未知计划不放行」（误投一条「继续」有害），告警「未知身份 / 未知结果放行」（吞掉一条告警会掩盖未知结果）。

---

## 2. 身份与生产者绑定（规格 1）

**身份源 = 进程内对象同一性**：生产者经 `notifyText` 造好 `env` 后、调 `hold`/`deliver` **之前**，把这个 env 对象登记进 `WeakMap<Envelope, AuditNoticeRecord>`（模块级，见 §5 文件 1）。同一个 record 对象同时挂在生产者的 `Notice.record` 上——生产者和投递口看的是**同一份状态**，不靠 receipt 推断（审查 #2）。

```
AuditNoticeRecord = {
  kind: "alert" | "followup", project, incident, messageId, threadId,
  phase: "pending" | "attempted" | "delivered" | "ended" | "cancelled",
  recovered: boolean,          // 本 (project, incident) 已由 ok() 宣告恢复
  superseded: boolean,         // 仅 followup：同项目新事故已开始
}
```

- `project`：来自 `ports.targets()`（`readAuditFailureTargets` → 规范台账只读解析的当班 PM），不来自正文。
- `incident`：生产者内单调代次，`ok()` 后的下一次 `fail` 建新 notice 时 +1；同一 project 不同代次各有各的 messageId（SFAIL1 已保证新事故新 id，`ledger-audit-service-failure.test.ts` 第二个用例）。
- `messageId/threadId`：即 `Notice.identity`，登记时与 `env.meta` 比对一致才登记。
- `notifyText` 改为返回 `{ receipt, env }` 内部形状（或接受 `register(env)` 回调）——只在生产者自己的调用里拿到 env 对象，不对外暴露。

发送闸 `auditSendGate(env): boolean`（`deliverToLocal` 唯一调用点，§3.2）。**r3 结构：先记边界的前提、再问策略；策略读取只能在「撤 / 不撤」二选一里起作用，永远不能跳过 `attempted` 写入。**

1. `registry.get(env)` 取不到 → **true**，无副作用（owner / peer / 普通 agent 消息、审批卡、`ledger-ask:*`、其他项目、其他代次、重启从盘上读回的、`holdFirst` 押回时重建的信封，全部原路走）。
2. 取到 `rec`。在 `try` 里算「可撤候选」`cand`：`env.from.kind==="bridge" && env.from.label==="ledger-audit" && env.meta.messageId===rec.messageId` **且** `rec.phase==="pending"` **且** `findHeld(env)` 找得到条目且该条目**无 `lease` 字段** **且**（`kind==="alert" && rec.recovered`）或（`kind==="followup" && rec.superseded`）。身份字段不符、`findHeld` 抛错 / 找不到 → `cand=false` 并诊断（不能证明）。
3. 仅当 `cand` 为真才读策略（§4），也在 `try` 里：`on` → `rec.phase="cancelled"`，返回 **false**（唯一的 false 出口）。`observe` → 记一次「本会撤下」。`off`、失读回落 off、port 抛错、未知返回值 → 什么都不做。三者都落到第 4 步。
4. **收尾（写在 `finally` 语义里，第 2–3 步任何抛错也执行）**：若 `rec.phase==="pending"` 则置 `"attempted"`；返回 **true**。

**不变式 I1（r3 核心）**：对任一已登记 env，`auditSendGate` 返回 true 之后 `rec.phase !== "pending"`。它不依赖策略模式、不依赖身份核对是否通过、不依赖 `findHeld` 是否可用；唯一能让一条已登记信封越过 876 而 phase 仍 `pending` 的方式是闸返回 false，而那时它没有被发送。由 I1 得：**phase 为 `pending` ⇔ 该对象从未越过任何可信发送边界**（配合 §3.2 的「全部发送边界都调用闸或 `auditMarkAttempted`」）。这就是「未发送证明」的唯一来源；lease 缺失、仍在队里、策略曾为 off 都不是证明，也不再被用作证明。

第 4 步是审查 r1/r2 #1 的修法：**闸放行这一刻就是发送边界**，之后无 await 直达 `ws.send`；从此不论 `send` 之后哪一步抛错、`error` 留队多少次、策略后来怎么切，这条都不再是 `pending`，永不被撤。`attempted` 只由闸（及 §3.2 的 `auditMarkAttempted`）写，不能由 lease 字段缺失、条目还在队里、策略切换或任何盘上材料反推回 `pending`。

r2 反例（off 下 send 后 error → 切 on → `ok()` → 再 flush 被撤）在 r3 下的走法：off 下 flush → 闸第 2 步 `cand=false`（未 recovered）→ 第 4 步 `pending→attempted` → send 计数 1 → 返回 error 留队；切 on，`ok()` 置 recovered，见 phase=attempted 只挂起跟进；再 flush → 第 2 步 phase 非 pending，`cand=false` → true → 重投（至少一次），sends=2，不撤。策略文件损坏 / port 抛错临时落 off 再恢复 on 同理（第 3 步只在 cand 为真时才读策略，而读失败也走第 4 步）。

不做的事：不按正文 `[ledger-audit-failure]` 前缀、不按 label 单独、不按 messageId 前缀 `audit-failure` 删任何东西；也不扫描别的频道队列。label / 前缀只允许用于**诊断日志计数**（§3.6）。

---

## 3. 生命周期与竞态（规格 2、3）

### 3.1 phase 迁移表（唯一写入点）

| 事件 | 写入方 | 迁移 |
|---|---|---|
| `notifyText` 登记 env | 生产者 | 新建 `pending` |
| 发送闸放行（§2 第 4 步；**任何策略模式**，含 off / observe / 失读 / port 抛错 / 身份不符） | `deliverToLocal` 876 前 | `pending → attempted` |
| inbox `take` 写 lease、idle release 适配器最终发送前（§3.2 其他边界） | `auditMarkAttempted(env)`，**不读策略** | `pending → attempted` |
| 发送闸撤下（§2 第 3 步，仅 on 且 cand） | 同上 | `pending → cancelled` |
| `notifyText` 直投返回 `sent` 且无 `note` | 生产者 | `→ delivered`（闸已置 attempted，此处确认） |
| `notifyText` 直投返回 `sent, note:"queued"`（判忙竞态押回，§0.2） | 生产者 | 保持 `pending`（闸未走到）；`receipt` 记 `queued` |
| `onHeldSettled(env,"delivered")`（flush 与 inbox ack 都发） | 生产者订阅 | `→ delivered` |
| `onHeldSettled(env,"gave-up"\|"discarded")` | 生产者订阅 | `attempted → ended`（结果未知）；`pending → ended`（从未发） |
| 策略切换 / 策略读失败 / 恢复 | 无 | **不是迁移事件**：不回退、不补写，phase 只由发送边界与结局事件决定 |

`delivered` / `ended` / `cancelled` 是终态，不回退。`error` / `shouldRetry` / `note:"queued"` 押回都不是迁移事件——条目留队，phase 维持（`attempted` 仍是 `attempted`）。

### 3.2 发送闸位置与正在发送

闸必须是 `ws.send` 前**最后一个同步检查**：在 bridge.ts 876 `to.ws.send(...)` 紧前（`inboundLedgerGate` 的 await 之后、`takeAfterInterrupt` 之前）加 `if (!auditSendGate(env)) return { envelope: env, outcome: { kind: "dropped", reason: "巡检已恢复，撤下未送出的告警" } }`。864 **不**加（864 之后还有 await，在那里置 attempted 会把「之后被押回、根本没发」的也算成已越边界，虽保守但让恢复后可撤的告警变少；在那里只读不写也无增益）。JS 单线程下：

- 闸在 `ok()` 之前 → 已 `attempted`，其后发出与否都按「可能已送达」处理（§3.4），不算过时发送。
- 闸在 `ok()` 之后、phase 仍 `pending`、无 lease → `on` 下 `dropped`；flush 走既有 `held.remove` 分支；不发 `notifyHeldSettled`，网页「排队中」镜像与基线 `stillWanted` 撤下一致。
- 初次直投只发生在 `fail()` 内，`running` 守卫保证 `ok()` 不插入，所以直投路径不会出现「recovered 且 pending」。

**全部发送边界（I1 的前提）**。信封内容离开 bridge 交给收件方的路只有三条，实现卡必须三条都接上，否则 I1 不成立：

| 边界 | 位置 | 接法 |
|---|---|---|
| ws 推送 | `deliverToLocal` bridge.ts:876（直投、flush、`roleHandoffs`→`deliverPmLocal` 都汇到这里） | `auditSendGate(env)`，同步、紧贴 send |
| inbox 领取 | `src/bridge/inbox.ts` take 分支给条目写 `lease` 处（约 239–256，`live` 过滤之后、返回正文之前） | 对每个写 lease 的条目调 `auditMarkAttempted(it.env)`：**无条件**（不读策略），只做 `pending→attempted`，恒无返回值、不改领取结果 |
| idle release 适配器 | `held-queue.ts:174` `withIdleBatch` 的 release 回调最终 send 前（生产未配置，§0.5） | 若最终经 `deliverToLocal` 则已覆盖；否则在最终 send 前对 batch 每条调 `auditMarkAttempted` |

`auditMarkAttempted` 与闸第 4 步共用同一函数体；它不撤任何东西，所以不受策略、身份核对、`findHeld` 影响。实现卡若找到第四条把押后信封内容交出去的路，须同样接上，否则不得把策略置 `on`（验收 #6、#19）。闸第 2 步的「无 lease」保留为冗余防线（lease 已写必然已 `attempted`），不再是证明。

### 3.3 恢复时（`ok()`）

`ok()` 不再只 `clear()`。对每份 notice 取 `rec = notice.record`（没有 record = 从没成功登记过 → 直接丢簿记），置 `rec.recovered = true`，再按 **phase**（不是 receipt）：

| phase | 处理 |
|---|---|
| `pending` | 什么都不做；闸下次遇到且策略为 on 即撤（§2 第 3 步）。若一直没遇到而走到 `gave-up`/`discarded` → `ended`，从未发出，不补跟进 |
| `attempted` | 结果未知且仍可能被重投：**不撤**；跟进挂起，等结局事件（delivered / gave-up / discarded）再置为「待发」 |
| `delivered` | 跟进置「待发」（**审查 #2 的 queued→delivered→ok 分支**：flush 回调时 active，只改 phase；ok() 读 phase 得知已送达） |
| `ended`（从 attempted 来） | 跟进置「待发」（可能已被看到，如实补） |
| `cancelled` | 不可能（cancelled 只在 recovered 之后发生）；出现即诊断 |

然后丢 `notices`（簿记），但 record 由 WeakMap / 跟进表持有，`ok()` 之后到达的结局事件仍能找到它：订阅回调见 `rec.recovered && phase` 进入 `delivered`/`ended(自 attempted)` → 置「待发」。

### 3.4 送达后明示已恢复（跟进）

- 「待发」跟进存在生产者内 `followups: Map<project, { incident, threadId, origMessageId, rec?, attempts, next }>`，每 (project, incident) 至多一份，**不清在 `ok()` 的 `clear()` 里**。
- 只在 ticker 轮次里尝试发送（`ok()` 末尾 / 之后的 `ok()` 轮次），按现有 `retryDelay` 退避；不加计时器。结局回调只改状态，不发网络。
- 发送走同一 `notifyText`，新 messageId（`newMessageId("audit-recovered")`），**沿用原 threadId**，正文由 `src/lib/ledger-audit-failure.ts` 新增固定文案生成（「项目 X 台账巡检已恢复，此前 <原 messageId> 告警所述失败已结束」），不含命令输出。跟进本身也登记 record（`kind:"followup"`）。
- 收件人按当时的 `ports.targets()` 重解析；解析不到就诊断、留待下轮，不回落 owner / master。
- **新事故作废**：同 project 新一轮 `fail()` 建新 notice 时，未发出的跟进直接丢；已发出但还在押后队里的跟进置 `rec.superseded = true`，由闸按「pending 且无 lease」撤下，越过边界的照投（审查附注）。
- 排序：跟进只在原告警到达终态（delivered / ended）后才待发，原告警此时已出队或不再重投，不会出现「已恢复」先于原告警到达。代价：`attempted` 后反复 `error` 留队的那条，跟进要等到它送达或 24h `gave-up`；期间如实诊断「<messageId> 发送结果未知，恢复提示待原告警结局后补发」。

### 3.5 其他状态

| 状态 | 处理 | 依据 |
|---|---|---|
| queued，未领、未在投（pending） | 下一次 flush 到 876 前闸判可撤 → dropped → 出队 | §3.2 |
| flush 已 `claim`、await 中、`ok()` 插入 | 闸在 await 之后读，仍 pending → 撤；不抢锁 | 判定在投递者自己手里 |
| send 之后抛错 / `error` 留队 / 再次 flush | 已 `attempted` → 不撤、照重投（至少一次不变），终态后补跟进 | §2 第 4 步、I1、审查 #1 |
| 上述发送发生时策略为 off / observe / 失读 / port 抛错，之后切 on 并 `ok()` | 同上：边界簿记与策略无关，已 `attempted` → 不撤 | §2 I1、§4、审查 r2 |
| 闸处身份字段不符 / `findHeld` 异常 | 放行并置 `attempted`，该对象永久失去可撤资格 + 诊断 | §2 第 2、4 步 |
| inbox 已领未 ack（有 lease） | 领取时已 `auditMarkAttempted` → 不撤；ack → `delivered` → 跟进；lease 过期、字段被删都不回 `pending` | 不逆转可能已送达的 |
| 恢复前已经 flush 送达（queued→delivered→ok） | 回调时 active：phase=delivered；ok() 读到 delivered → 跟进 | §3.3、审查 #2 |
| 恢复后又失败 | 旧代次 record 仍 recovered（pending 的继续可撤）；新代次新 notice / env / messageId；旧代次未发的跟进作废 | §3.4 |
| PM 换代（roleHandoffs 转交） | 同一 env 对象移队，登记仍命中；转交投递经 deliverPmLocal → deliverToLocal，闸同样生效；`env.to` 改写不影响身份 | §0.5 |
| PM 频道 / SID 换代、ws 重连 | flush 按 channelId 取最新连接，env 对象不变；告警不带 `expectSession` | — |
| 额度闸 / codex 第二道闸 / 入站账押后 | 都在 876 之前返回，闸未走到 → phase 不变；`holdFirst` 若是重建对象则登记不命中 → 原路 | 不能证明就保留 |
| 24h `gave-up` / kill `discarded` | 既有逻辑出队；phase → ended；record 随 env 被 GC | 不改 |
| bridge / producer 重启、盘上恢复 | 盘上读回是新对象，生产者闭包也是新的 → 一律不命中 → **照原路投递**（可能过时，但不伪造取消、不补无凭跟进） | 崩溃换代保守 |

### 3.6 诊断（未能证明时如实说）

- 闸命中但字段不一致、`findHeld` 抛错 / 找不到、策略读失败 → 判 true（保留）并 `console.error` 一次（按 messageId 去重）。
- 启动时可选：按 `from.label==="ledger-audit"` 统计盘上恢复的告警条数并打一行「N 条巡检告警从重启前恢复，无法核对是否过时，按原样投递」——只计数，不删、不改。

### 3.7 不变的语义

ack（`ackBatch` / `inboxAckable`）、送达回调（`onHeldDelivered`、`onHeldSettled`、`team-router`）、至少一次（投出后才 `remove`，`error` 留队）、按对象去重的 `hold`、message_id 去重、`claim/release` 锁、`ageHeld` 阈值全部不改。没有第二套队列、计时器、网络通道；闸只能把**生产者自己登记且可证明未越过发送边界的对象**从「投」变成「不投」，对任何其他信封恒为 true 且无副作用，不构成新的权限后门。

---

## 4. 策略入口（规格 4，审查 #3）

复用仓库现有唯一恢复策略入口，不另造开关：

- 入口：`src/lib/recovery-policy.ts` 的 `RecoveryPolicyPort = (project, mechanism) => RecoveryPolicy`，文件版实现 `recoveryPolicy(project, key)`；写入只走现有 `ledger scheduler-recovery`（`setRecovery`）。
- 后续实现在 `RECOVERY_KEYS` 追加一个键（暂名 `auditNoticeRecovery`，1 行）；**本卡不加键、不写 recovery-policy.json、不启用**。
- 注入：`LedgerAuditDeps.policy?: RecoveryPolicyPort`，bridge.ts:3294 构造处传 `recoveryPolicy`；单测注入假 port。发送闸的策略读同样经这个 port（闸由生产者模块导出，port 在 `startLedgerAudit` 时交给它）。
- 读取时机：每次决策当场读，按 record 的 `project`，不缓存快照（与 `recovery-runtime-ports.ts` 同规）。只在 WeakMap 命中后才读，其余信封零开销。
- 有效模式（全由现有 `recoveryPolicy` 给出，本设计不改其规则）：`keys.auditNoticeRecovery` → 项目 `mode` → 缺省 **observe**；文件读不了 / 非法 / 未知键 → **off** 并带诊断；port 抛错 → 本机制按 off（仿 `ask-recovery.ts:48-50`）。
- **策略管效果，不管簿记**（r3）：登记 env、phase 迁移（§3.1 全表）、`ok()` 置 `recovered`、跟进「待发」状态登记，在所有模式下都照做，都是生产者进程内状态，不发网络、不改队列、不改投递结果。策略只在两处起作用：闸第 3 步「cand 为真时撤不撤」、跟进「待发时发不发」。
  - `off`：闸恒 true（但照常 `pending→attempted`）；跟进不发；投递行为、队列、ack 与基线逐字节相同——旧路径原样共存，差别只在生产者内存簿记。
  - `observe`（生效默认）：同 off 的投递行为；「本会撤下 <messageId>」「本会补发已恢复 <project>/<incident>」各按 (project, incident, action) 在进程内去重后 `console.log` 一次。bridge 对台账只读（`ledger-audit-service.ts` 头注），所以不走 `recordObserved` 落台账，沿用 `ask-expire.ts` 的 askReminder observe 日志先例；如评审要求落台账，须另登记 CLI 侧写入，不在 bridge 里开写口。
  - `on`：§2–§3 全部生效。
- 模式在发送、`ok()` 与闸之间任意切换（含 port 抛错 / 文件损坏临时落 off 再恢复）：以闸**当场**读到的为准，且只影响 cand 为真的那一次决定。因为 phase 不随模式变：off/observe/失读期间越过边界的 → 已 `attempted`，切 on 后不可撤；off 期间从未越过边界、`ok()` 已置 recovered 的 → 仍 `pending`，切 on 后被撤（它确实没发过，撤下正确）；`on→off` → cand 也放行并置 `attempted`（旧路径）。不存在「某模式下发送却不留边界记录」的路径。
- 身份门（任何模式都不可越过）：只认进程内登记的 env 对象；盘上 JSON、recovery-policy.json 内容、正文、label、messageId 前缀、外部 API / peer 传入字段都不能让闸返回 false。策略只能把机制从 on 降到 observe / off，不能扩大可撤范围。

---

## 5. 后续实现的最小文件与估算

| 文件 | 改动 | 估算 |
|---|---|---|
| `src/bridge/ledger-audit-failure.ts` | 代次计数；record / phase 迁移；`ok()` 按 phase 处理；`followups` 表与新事故作废；WeakMap 登记 + `auditSendGate(env)` / `auditMarkAttempted(env)` 导出（收尾写 attempted 在 finally 里）；订阅 `onHeldSettled`；policy port 读与 observe 日志 | +80 / −3 |
| `src/bridge/ledger-audit-service.ts` | `notifyText` 在 hold/deliver 前登记 env 并回传；`note==="queued"` 记 `queued`（§0.2）；`findHeld` / policy 端口接线；ok 轮次发跟进 | +20 / −3 |
| `src/lib/ledger-audit-failure.ts` | `auditRecoveredText(project, messageId)` 固定文案 | +4 |
| `src/lib/recovery-policy.ts` | `RECOVERY_KEYS` 追加 `auditNoticeRecovery` | +1 / −1 |
| `src/bridge.ts` | 876 前一行发送闸；3294 传 `findHeld` 与 `recoveryPolicy` | +4 |
| `src/bridge/inbox.ts` | take 写 lease 处对每条调 `auditMarkAttempted`（§3.2 边界 2） | +2 |
| `tests/ledger-audit-notice-recovery.test.ts`（新） | §6 矩阵 | ~+260 |
| `tests/ledger-audit-service-failure.test.ts` | queued-note 用例 | ~+20 |
| `tests/recovery-policy.test.ts` | 新键默认 / 继承 / 失读 off（若既有遍历 `RECOVERY_KEYS` 的断言需补） | ~+6 |

总计源码约 112 行。若评审认为 bridge.ts 内联不便测试，可把「876 前闸 + dropped 构造」抽成 `src/bridge/` 下一个导出函数供 deliverToLocal 与测试共用（+10 行，另登记文件）。`withIdleBatch` 的 release 适配器若最终不经 `deliverToLocal`，须另登记其所在文件接 `auditMarkAttempted`（§3.2 边界 3）。

---

## 6. P1 验收矩阵（后续实现卡；须旧红新绿）

全部用真实 `HeldQueue(null)`、真实 `flushHeld` / `onHeldSettled`、真实 `ledgerAuditTicker`/`ledgerAuditFailures`；deliver 桩须调用与 `deliverToLocal` 同一个 `auditSendGate`，且在闸与 send 之间无 await；策略经注入 port（可在用例中途改返回值或抛错）置 `on`，除非用例另说。#16/#17 是 `sfail4-unproven-unsent` 的复现测试，实现卡须先按 r2 文字闸写出并确认红，再按 §2 r3 结构转绿。不接受只测纯函数或只测正常路径。

| # | 场景 | 旧（基线） | 新 |
|---|---|---|---|
| 1 | 3 轮失败 → PM 忙押后 → 成功一轮 → flush | 过时告警被投出（红） | 零发送；条目出队；无 delivered 事件；无跟进 |
| 2 | 同上，但 flush 已 claim、deliver 内 await 期间 `ok()` | 投出（红） | 876 前闸判可撤 → dropped |
| 3 | **send 后抛错**：押后 → flush 时闸放行、桩 `send` 计数 +1 后返回 `error`（条目留队、无 lease）→ `ok()` → 再 flush | 重投 | **不撤**（sends=2，至少一次）；送达后恰一条已恢复；若改为 24h gave-up 也恰一条（审查 #1 探针反例转绿） |
| 4 | **queued→delivered→ok**：押后 → 恢复前 flush 成功 → `ok()` | 无恢复提示（红：events=1, followups=0） | phase=delivered；ok() 轮次恰一条已恢复，原 threadId、新 messageId（审查 #2 探针反例转绿） |
| 5 | 恢复前已直投送达 | 无恢复提示（红） | 恰一条已恢复 |
| 6 | idle 模式 on、告警被 check_inbox 领走未 ack 后恢复；另测领取后 lease 字段被删再 flush | — | 领取即 `attempted`；不撤；ack 后补一条；ack 语义不变；release 适配器路径同样置 attempted |
| 7 | 恢复后再失败 3 轮 | 新告警正常 | 旧代次 pending 仍被撤，新代次照投，id 不同；旧代次未发跟进作废，已押后未越边界的跟进被撤 |
| 8 | 邻居保留：同频道 owner、peer、本机 agent、ask 答复、审批卡、`ledger-ask:*`、另一项目 / 另一代次告警、正文复制了 `[ledger-audit-failure]` 的 agent 消息、label 伪造为 ledger-audit 的盘上条目 | 全投 | 全投，顺序与基线一致；闸对它们无副作用 |
| 9 | PM 换代：告警押在旧 PM 队，恢复后 roleHandoffs | 转交后投出（红） | 转交路径同样 dropped，当班 PM 零过时消息 |
| 10 | bridge / producer 重启（从落盘 JSON 构造新 HeldQueue + 新 ticker）后恢复 | 投出 | 仍投出（保守）+ 一行诊断；不报「已撤」、不补跟进 |
| 11 | `deliver` 返回 `{sent, note:"queued"}`（直投竞态押回） | 记成 sent、恢复后照投（红） | 记成 queued、phase pending，恢复后被撤 |
| 12 | 陈旧 lease / 锁 / CAS：lease 过期后的重投、`claim` 失败、`findHeld` 抛错或找不到、env 字段被改、phase 已 attempted 时外部删 lease 字段 | — | 全部保留原消息 + 诊断，不出队；attempted 不回退 pending |
| 13 | 异常回滚：跟进投递失败、`targets()` 抛错、结局回调抛错 | — | 原告警处理不受影响；跟进按退避在 ok 轮重试，新代次作废；不回落 owner |
| 14 | 预算：持续成功 20 轮、多项目、同一告警多次 error 重投 | — | 每 (project, incident) 跟进 ≤1；`runManager` 调用仍只有 `ledger audit --json`；无新计时器 |
| 15 | 策略：port 返回 off / observe(缺省) / on；port 抛错；recovery-policy.json 损坏；项目 mode 与 key 覆盖继承；ok 与闸之间切换 | — | off 与基线同投递行为；observe 只多去重日志、零撤、零跟进；抛错 / 损坏 = off + 诊断；继承按 `recoveryPolicy` 既有规则 |
| 16 | **审查 r2 反例**：策略 off → 押后 → flush 闸放行、桩 send 计数 +1 后返回 `error`（留队、无 lease）→ 切 on → `ok()` → 再 flush | r2 文字闸模型：phase=pending→cancelled、sends=1、remaining=0（红） | phase=attempted；不撤，sends=2；送达后恰一条已恢复；全程无 `pending` 回写 |
| 17 | 同 #16，但首次 flush 时 port 抛错 / recovery-policy.json 损坏（临时 off），之后修复为 on；再测 observe→on | 同上（红） | 同 #16：不撤；每次策略读失败恰一行诊断 |
| 18 | 对照：off 下押后、**从未 flush** → off 下 `ok()` → 切 on → flush | 投出过时告警 | phase 仍 pending、recovered=true → 撤下，零发送（off 期间簿记照做，真未发的仍可撤） |
| 19 | I1 性质测试：对已登记 env，随机组合 {on, observe, off, port 抛错, 文件损坏} × {身份字段被改, `findHeld` 抛错 / 找不到, 有 / 无 lease} × {直投, flush, handOver, inbox take} 走一遍，凡发生 send 或领取，之后 phase≠pending；再以任意模式序列 `ok()` + flush，send 过的对象撤下次数恒 0 | — | I1 恒成立；仅「从未 send/领取 + recovered + on」被撤 |

---

## 7. 不在本卡

源码 / 测试 / 配置改动、`RECOVERY_KEYS` 加键、recovery-policy.json 写入、生产启用、已有过时告警的人工清理、对已送达消息的任何撤回。后续实现按 §5 文件清单另登记节点与 fileGlobs，独立审查。本文不宣称过时告警缺口已修。
