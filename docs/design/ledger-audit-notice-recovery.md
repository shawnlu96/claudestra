# SFAIL4 · 巡检恢复后过时押后告警的最小接线（设计）

状态：设计稿（specRev 1，基线 head `cc5c5ddf8c83b34ca4f9658bb9f0d1f07bd9d4bb`，依赖 SFAIL1 已合入）。对应 r1 P2 `stale-queued-after-recovery`。
本卡只新增本文件：不改源码 / 测试 / 配置 / 队列数据，不撤回任何通知，不碰生产，不创建策略键。**本文不宣称漏洞已修**，也不产出 PASS、取消回执或 owner 授权；后续实现另开节点、另登记文件范围。

---

## 0. 现状核对（只读，均为基线代码）

### 0.1 生产者：`ledgerAuditFailures`

`src/bridge/ledger-audit-failure.ts`（57 行）：

- 状态全在闭包内存：`notices: Map<project, Notice>`，`Notice = { identity:{messageId,threadId,ts}, content, attempts, next, receipt? }`。
- `fail(kind)`：连续第 3 轮起按项目建一份 notice（`newMessageId("audit-failure")` + `newThreadId()`），经 `ports.notify(to, content, identity)` 投；`receipt` 为 `sent` 或 `queued{messageId}` 后不再投，`failed` 按 `retryDelay` 退避重试。
- `ok()`：`rounds/nextLookup/lookupAttempts/diagnostic` 归零并 **`notices.clear()`**。

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
- `deliverToLocal`（bridge.ts:810）：bridge.ts:864 一处合并核对 `stillWanted()` / `turnCuts.noticeWanted(env)` / `resumeStillWanted(env)`，任一为假返回 `dropped "已从押后队列撤下"`。**之后还有两个 await**：`sessionGone(...)`（865）与 `inboundLedgerGate(...)`（874），然后才 `to.ws.send`（876）。所以 864 不是「最后一刻」——这点对「恢复后零过时发送」是硬约束（§3.2）。
- 先例：`resumeStillWanted` + `planOf` + `cancelResumePlan`（`src/bridge/quota-wall-wiring.ts:170-197`）是「生产者撤销自己尚未送出的押后信封」的现成写法；`turnCuts.noticeWanted`（`turn-cuts.ts:259`）是「过时就不投」的另一先例。二者都**只在投递口做判定、不另起队列**。

### 0.5 inbox / PM 转交

- `check_inbox`（`src/bridge/inbox.ts`）只领 `takeable`：`held.idleInboxAllowed(i) ?? (inboxTakeable(i) || isAskNotice(i))`。告警是 `from.kind==="bridge"` → `heldKindOf = "other"`，`inboxTakeable` 为假；`isInternalIdleNotice` 对它为真，但 `configureIdleBatch` 在生产里**没有调用方**（`HeldIdleControl` 未配置 → `idleInboxAllowed` 返回 undefined）。结论：**基线生产里告警不会被 inbox 领走、不会有 lease**；但设计必须对未来开启 idle 模式后的 lease 保守。
- `roleHandoffs`/`handOver`（`src/bridge/pm-held-transfer.ts`、`held-flush.ts`）：PM 换代后旧 PM 队里的角色消息（告警不属 `staysWithAddressee`）会转给当班 PM——**同一个 env 对象**移队，`env.to` 会被 `markPmTransfer` 改写。所以身份不能绑在 `env.to.channelId` 上。

### 0.6 结论：没有现成的「按身份精确取消」端口

现有能撤押后信封的只有：`HeldQueue.remove(channelId, item)`（要求持有 item 对象）、`discard`（整频道）、`cancelResumePlan`（只认续跑 label）、以及投递口的三个 wanted 判定。**没有**给 ledger-audit 用的取消口，下面所述均为需新增的最小接线。

---

## 1. 方案候选与选定

| # | 方案 | 优点 | 问题 | 结论 |
|---|---|---|---|---|
| A | `ok()` 时在 `heldLocalMsgs` 里按 messageId / label 找到并 `remove` | 直观 | 要绕过频道锁（与在投的 flush 抢）；按 messageId/label 认 = 规格禁止；inbox lease / 正在发送的无法证明；重启后对象已换 | 否 |
| B | 投递口加一个生产者自有的 wanted 判定（仿 `resumeStillWanted`），以**进程内信封对象登记**为身份；不能证明就放行；送达走现有结局回调补一条「已恢复」 | 复用唯一投递口与已有 dropped 语义；不碰锁、不改队列结构；重启/未知一律保守 | 需把判定挪到真正最后一刻（864 之后有 await） | **选定** |
| C | 投递时改写正文为「已恢复」 | 不丢消息 | 同 messageId 内容变了，收件方按 id 去重会吃掉 / 混淆；改写持久化消息；对已领取未 ack 的无效 | 否 |
| D | 生产者另落一份「已发告警」簿 | 重启可认领 | 第二套持久状态，盘上材料可被改写后冒充身份；规格禁止第二套队列 | 否 |

选 B 的理由：它和 `resumeStillWanted` 是同一形状（生产者只对自己造的信封说「不要了」，判定放在 `deliverToLocal` 的所有 await 之后），flush / inbox / ack / 至少一次 / 去重的既有规则一行不改；唯一不同是**失败方向相反**——续跑「未知计划不放行」（误投一条「继续」有害），告警「未知身份放行」（吞掉一条告警会掩盖未知结果）。

---

## 2. 身份与生产者绑定（规格 1）

**身份源 = 进程内对象同一性**：生产者在 `notifyText` 造好 `env` 后、调 `hold`/`deliver` **之前**，把这个 env 对象登记进 `WeakMap<Envelope, AuditNoticeRecord>`（模块级，见 §5 文件 1）。

```
AuditNoticeRecord = { project, incident, messageId, threadId, state: "active" | "recovered" | "sent" }
```

- `project`：来自 `ports.targets()`（`readAuditFailureTargets` → 规范台账只读解析的当班 PM），不来自正文。
- `incident`：生产者内单调代次，`ok()` 后的下一次 `fail` 建新 notice 时 +1；同一 project 不同代次各有各的 messageId（SFAIL1 已保证新事故新 id，`ledger-audit-service-failure.test.ts` 第二个用例）。
- `messageId/threadId`：即 `Notice.identity`，登记时与 `env.meta` 比对一致才登记。

判定 `auditNoticeWanted(env)`：
1. `registry.get(env)` 取不到 → **true**（不是自己造的这个对象：owner / peer / 普通 agent 消息、审批卡、`ledger-ask:*`、其他项目、其他代次、重启从盘上读回的、`holdFirst` 押回时重建的信封，全部原路走）。
2. 取到，再核 `env.from.kind==="bridge" && env.from.label==="ledger-audit" && env.meta.messageId===rec.messageId`，任一不符 → true 并诊断（对象被别处改过，不能证明）。
3. `rec.state==="recovered"` 且 §3.1 的「可证明未送达」条件成立 → **false**；否则 true。

不做的事：不按正文 `[ledger-audit-failure]` 前缀、不按 label 单独、不按 messageId 前缀 `audit-failure` 删任何东西；也不扫描别的频道队列。label / 前缀只允许用于**诊断日志计数**（§3.5）。

---

## 3. 生命周期与竞态（规格 2、3）

### 3.1 恢复时（`ok()`）

`ok()` 不再只 `clear()`：对每份 notice——
- `receipt` 为空（从没投成功）：没有在途信封，直接丢簿记。
- `receipt.kind==="queued"`：把对应 record 置 `recovered`，然后才丢 notice。**不 remove 队列条目**，取消只发生在投递口。
- `receipt.kind==="sent"`（已直投送达）：已送达不可逆，记入「待补已恢复」名单（§3.4）。

「可证明未送达」= record 为 `recovered` **且** 该 env 所在押后条目**从未有过 lease**（`HeldItem.lease` 字段不存在；lease 会落盘，过期后字段仍在）。判定时生产者通过注入的只读查找 `findHeld(env) → HeldItem | undefined`（遍历 `heldLocalMsgs` 按 `i.env === env`）取 lease；找不到条目 → 无法证明，判 true 并诊断。（`notifyText` 的直投只发生在 `fail()` 内，而 ticker 的 `running` 守卫保证 `fail()` 与 `ok()` 不交错，所以「恢复后才首次直投」不会出现；PM 转交途中条目在投完前一直留在原队，`findHeld` 能找到。）

### 3.2 正在发送

判定必须是 `ws.send` 前**最后一个同步检查**：在 bridge.ts 876 `to.ws.send(...)` 紧前（`inboundLedgerGate` 的 await 之后）加 `if (!auditNoticeWanted(env)) return dropped`。864 那一处可同时加（尽早不押回、不再判忙），但只有 876 前那一处保证「判定为 true 之后、发送之前没有任何 await」，`ok()` 无法插进来。JS 单线程下：

- 判定在 `ok()` 之前 → 已 `ws.send`，属于恢复前送达，走 §3.4 补「已恢复」，不算过时发送。
- 判定在 `ok()` 之后 → `dropped`，flush 走 `held.remove`（既有分支）；初次直投路径 `notifyText` 得 `failed`，`ok()` 已过，生产者不再重试。

`dropped` 不发 `notifyHeldSettled`，网页「排队中」镜像与基线 `stillWanted` 撤下行为一致；实现时如需要可在生产者里额外记一行「已撤下 <messageId>」诊断，不增加事件类型。

### 3.3 其他状态

| 状态 | 处理 | 依据 |
|---|---|---|
| queued，未领、未在投 | 下一次 flush 走到 876 前判 false → dropped → 出队 | §3.2 |
| flush 已 `claim`、await 中 | 同上；不需要抢锁 | 判定在投递者自己手里 |
| inbox 已领未 ack（有 lease） | **不取消**：内容已作为工具结果交出，可能已被看到；ack 照原规则出队，`inboxDelivered` → `notifyHeldSettled("delivered")` → §3.4 补已恢复 | 不逆转可能已送达的 |
| lease 过期回到 Stop 重投 | 仍有 `lease` 字段 → 不取消、照投，送达后补已恢复 | 同上；message_id 不变，收件方去重 |
| 恢复后又失败 | 旧代次 record 保持 recovered（继续可撤）；新代次是新 notice、新 env、新 messageId，`active`，不受影响 | 代次绑定 |
| 恢复前又成功送达 | §3.4 | — |
| PM 换代（roleHandoffs 转交） | 同一 env 对象移到当班 PM 队，登记仍命中；`env.to` 改写不影响身份 | §0.5 |
| PM 频道 / SID 换代、ws 重连 | flush 按 channelId 取最新连接，env 对象不变；告警不带 `expectSession`，`sessionGone` 不影响 | — |
| 额度闸 `markWall` / `releaseWall` / codex 第二道闸 | 条目与 env 不变则照判；`holdFirst` 若持有的是同一 env 照判，若是重建对象则登记不命中 → 原路保留 | 不能证明就保留 |
| 24h `gave-up` / kill `discarded` | 既有逻辑出队；record 随 env 被 GC（WeakMap） | 不改 |
| bridge 重启 / 盘上恢复 | 盘上读回的是新对象，生产者闭包也是新的 → 一律不命中 → **照原路投递**（可能是过时告警，但不是伪造的取消） | 崩溃换代保守 |

### 3.4 送达时明示已恢复

生产者订阅已有的 `onHeldSettled`：`outcome==="delivered"` 且 `registry.get(env)` 的 record 为 `recovered`，或 `ok()` 时 `receipt.kind==="sent"` 的 → 每个 (project, incident) **最多一条**「已恢复」跟进：
- 走同一个 `notifyText`，新 messageId（`newMessageId("audit-recovered")`），**沿用原 threadId**，正文由 `src/lib/ledger-audit-failure.ts` 新增的固定文案生成（如「项目 X 台账巡检已恢复，此前 <原 messageId> 告警的失败已结束」），不含命令输出。
- 收件人按当时的 `ports.targets()` 重解析；解析不到就诊断，不回落 owner / master。
- 投递失败按现有 `retryDelay` 退避、只在后续 `ok()` 轮次重试，新代次 `fail` 建 notice 时作废未发出的跟进。不加计时器。
- 跟进本身也是普通押后信封；它排在原告警之后（同频道 FIFO、同为 bridge 消息），不会先于原告警到。

### 3.5 诊断（未能证明时如实说）

- 判定命中但字段不一致、`findHeld` 抛错 → 判 true（保留）并 `console.error` 一次。
- 启动时可选：按 `from.label==="ledger-audit"` 统计盘上恢复的告警条数并打一行「N 条巡检告警从重启前恢复，无法核对是否过时，按原样投递」——只计数，不删、不改。

### 3.6 不变的语义

ack（`ackBatch` / `inboxAckable`）、送达回调（`onHeldDelivered`、`team-router`）、至少一次（投出后才 `remove`）、按对象去重的 `hold`、message_id 去重、`claim/release` 锁、`ageHeld` 阈值全部不改。没有第二套队列、计时器、网络通道；判定只能把**生产者自己登记的对象**从「投」变成「不投」，对任何其他信封恒为 true，不构成新的权限后门。

---

## 4. 策略入口（规格 4）

现状：ledger-audit 告警**没有**策略键。最接近的是 `HeldIdleControl.mode: "on"|"observe"|"off"`（`held-queue.ts`，实例内注入，生产未配置）和 `config-store` 的 `autoCompact.cardWorkers`（与本事无关）。

方案 B 在生产通知主流程（`deliverToLocal`）加了一个判定，属于新机制。建议沿用 `HeldIdleControl` 的注入式写法，而不是新建配置键：
- `LedgerAuditDeps.recoveryCancel?: "on" | "observe" | "off"`，由 bridge.ts:3294 的构造处传入；**缺省 `off`** = `auditNoticeWanted` 恒 true、`ok()` 行为与基线一致（旧路径原样共存）。
- `observe`：照常登记与判定，但判定结果只记日志「本会撤下 <messageId>」，返回 true；不发跟进。
- `on`：§3 全部生效。
- 切换由后续实现卡的 PM 定；本文不创建键、不启用。

身份门（任何模式都不可越过）：只认进程内登记的 env 对象；盘上 JSON、正文、label、messageId 前缀、外部 API / peer 传入的字段都不能让判定返回 false。

---

## 5. 后续实现的最小文件与估算

| 文件 | 改动 | 估算 |
|---|---|---|
| `src/bridge/ledger-audit-failure.ts` | 代次计数；`ok()` 置 recovered 而非仅 clear；模块级 `WeakMap` 登记 + `auditNoticeWanted(env)` 导出；订阅 `onHeldSettled` 发一次性跟进；mode 注入 | +50 / −2 |
| `src/bridge/ledger-audit-service.ts` | `notifyText` 在 hold/deliver 前登记 env；`outcome.note==="queued"` 记为 `queued`（§0.2 缺口）；`findHeld` / mode 端口接线 | +15 / −2 |
| `src/lib/ledger-audit-failure.ts` | `auditRecoveredText(project, messageId)` 固定文案 | +4 |
| `src/bridge.ts` | 876 前一行最后判定（864 可同步加入）；3294 传 `findHeld` 与 mode | +4 |
| `tests/ledger-audit-notice-recovery.test.ts`（新） | §6 矩阵 | ~+220 |
| `tests/ledger-audit-service-failure.test.ts` | 视需要补 queued-note 用例 | ~+20 |

总计源码约 70 行。若评审认为 bridge.ts 内联判定不便测试，可把「864/876 两处 wanted 合取」抽成 `src/bridge/` 下一个导出函数供 deliverToLocal 与测试共用（+10 行，另登记文件）。

---

## 6. P1 验收矩阵（后续实现卡；须旧红新绿）

全部用真实 `HeldQueue(null)`、真实 `flushHeld`、真实 `ledgerAuditTicker`/`ledgerAuditFailures`，deliver 桩须调用与 `deliverToLocal` 同一个最后判定函数；不接受只测纯函数或只测正常路径。

| # | 场景 | 旧（基线） | 新 |
|---|---|---|---|
| 1 | 3 轮失败 → PM 忙押后 → 成功一轮 → flush | 过时告警被投出（红） | 零发送；条目出队；无 delivered 事件 |
| 2 | 同上，但 flush 已 claim、deliver 内 await 期间 `ok()` | 投出（红） | 876 前判 false → dropped |
| 3 | 恢复前已直投送达 | 无任何恢复提示 | 恰一条「已恢复」，原 threadId，新 messageId |
| 4 | idle 模式 on、告警被 check_inbox 领走未 ack 后恢复 | — | 不撤；ack 后补一条已恢复；ack 语义不变 |
| 5 | 恢复后再失败 3 轮 | 新告警正常 | 旧代次仍被撤，新代次照投，id 不同 |
| 6 | 邻居保留：同频道 owner、peer、本机 agent、ask 答复、`ledger-ask:*`、另一项目 / 另一代次告警、正文复制了 `[ledger-audit-failure]` 的 agent 消息、label 伪造为 ledger-audit 的盘上条目 | 全投 | 全投，顺序与基线一致 |
| 7 | PM 换代：告警押在旧 PM 队，恢复后 roleHandoffs | 转交后投出（红） | 转交路径同样 dropped，当班 PM 零过时消息 |
| 8 | bridge 重启（从落盘 JSON 构造新 HeldQueue + 新 ticker）后恢复 | 投出 | 仍投出（保守），并有一行诊断；不报「已撤」 |
| 9 | `deliver` 返回 `{sent, note:"queued"}`（直投竞态押回） | 记成 sent、恢复后照投（红） | 记成 queued，恢复后被撤 |
| 10 | 陈旧 lease / 锁：lease 过期后的重投、`claim` 失败、`findHeld` 抛错、env 字段被改 | — | 全部保留原消息 + 诊断，不出队 |
| 11 | 异常回滚：跟进投递失败、`targets()` 抛错 | — | 原告警处理不受影响；跟进按退避在 ok 轮重试，新代次作废；不回落 owner |
| 12 | 预算：持续成功 20 轮、多项目 | — | 每 (project, incident) 跟进 ≤1；`runManager` 调用仍只有 `ledger audit --json` |
| 13 | mode `off` / `observe` | — | off 与基线逐字节同行为；observe 只多日志、零撤、零跟进 |

---

## 7. 不在本卡

源码 / 测试 / 配置改动、策略键创建、生产启用、已有过时告警的人工清理、对已送达消息的任何撤回。后续实现按 §5 文件清单另登记节点与 fileGlobs，独立审查。
