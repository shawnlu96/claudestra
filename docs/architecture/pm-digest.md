# 当班 PM 推送摘要（agents-PMDIG1）

每条推送都会让 PM 带着几十万 token 的上下文跑一整轮。对不需要 PM 当场动手的推送，本功能先放进摘要队列，再合并送达，不再每条都叫醒 PM。

## 范围

- 只管**最终收件人是项目当班 PM**的本地投递（`activeProjectPm`，含 `pmRedirect` 转交之后的）。owner、peer、执行者，以及 feature PM 收到的消息都不受影响。
- 入口在 `deliverPmLocal`（`src/bridge/local-api/project-pm-delivery.ts`）。它只加了一行，把 `send` 包上 `pmDigest.wrap`（`src/bridge/pm-digest.ts`），所以转交、回程槽、API 回执和凭据核对的顺序都没变。
- 发送方（调度器、监工巡检、agent 的 `send_to_agent`）的行为和措辞都不改。

## 归类：`classifyPmPush`（`src/lib/pm-digest.ts`，纯函数）

只有下面四类可合并，其余一律立即送，拿不准的也立即送：

| 类 | 判据 |
|---|---|
| `post-verify` | 发送方 `scheduler`，首行以 `[上线后待办] <卡>` 开头 |
| `train` | 发送方 `scheduler`，单行，首行是合并列车的「第 N 层二分：」或「车厢 …（…）CI 红：」（调度服务自己接着二分、退修；列车作废、告警等其他列车通知照旧立即送） |
| `audit` | bridge `ledger-audit`，首行以 `[🔎 台账巡检]` 开头 |
| `sync` | 其他 agent（不含 scheduler / master / pm-switch）发来的消息：oneShot，或首行开头写「只同步」；等回复（非 oneShot）的「只同步」只认单行，首行以下还有内容就立即送；**整段正文**任一行都不能带失败、冻结、事故、告警、交付、提问、问号、「请」、方案 / 下一步 / 意见 / 怎么办 / 能否等字样（摘要只留首行，后面几行的要紧事或请求一进队就看不见了） |

下面这些总是立即送：owner 和人类消息、API / peer 消息、卡片答复（`ask_answer`）、其他 bridge 通知（含 `ledger` 的执行者提问和交付，以及本功能自己的单独摘要 `pm-digest`，防自环）、调度器的其他通知，以及等回复的 agent 消息。

## 送出时机（开关 `on`）

1. 可合并的消息不投递，记进项目摘要队列（落盘），返回 `sent / note: "digest"`。押后队列重投时也一样，到这里出队。
2. 立即送的消息投给这位 PM 时（按项目串行：读队列、拼摘要、发送、真送到出队是一个整体，并发的立即送和定时摘要不会各带一份），把队里的摘要插到正文前面（在转交抬头之后），一次投递送达。投出前先把这些条目记成被这封带走（`carriedBy` = 这封的**载体号** `pmDigest.carrier`，形如 `<message_id>#<随机>`，随信封落盘；同一封重拼沿用，不同信封哪怕 message_id 相同——同一条 Discord 消息的两次按钮点击——也各有各的），不再拼进别的摘要。结局三种：
   - 真送到（`sent` 且没有 `note` / `heldBy`）：条目出队。
   - 押在 PM 的押后队列（`note: "queued"` / `heldBy`）：押后队列落盘的就是带摘要的这份，PM 可能经 `check_inbox` 领走。摘要留在信封上，`pmDigest.ids` 记着这份带的条目；押后队列报结局（`onHeldSettled`）时，`delivered`（Stop 重投或收件箱确认）按**收件方实际拿到的那份**的 `ids` 出队，其余回队；`discarded` / `gave-up` 全部回队。`check_inbox` 领取不经投递时的当班检查，所以结清时再核一次：收件方已不是条目所属项目的当班 PM（例如切当班后前任领走了 owner 发给它的直聊），这些条目不算送到、回队，下个窗口交给当班 PM（前任已读到的那份摘要不撤回；领取前就剥离要改 `bridge/inbox.ts`，不在本卡范围）。重启后盘上的信封、摘要队列里的 `carriedBy` 都在，收件箱确认照样结清，窗口不会再发一遍。同一封在内存里被押回（hold 认出同一封不重写盘）时新拼进去的条目不在盘上那份的 `ids` 里，结清时回队。
   - 离线、失败：正文原样还原、条目回队。
   摘要块记在信封的 `pmDigest` 上，重投时按记录摘掉旧块、条目回队后重新拼，不会叠两层；改投给非当班 PM 时同样摘掉回队。定时器每轮先核对一次：`carriedBy` 指向的载体号已不在押后队列盘上任何信封里（投递途中崩溃等没报结局的情形）就放回队，宁可重一次不吞。
3. 队里最早一条等满 `PM_DIGEST_WINDOW_MS`（4 小时）后，定时器（每分钟一次）单独送一条摘要（bridge `pm-digest`，`waitForIdle`）。它经 bridge 启动时 `initTeamRouter` 交来的 router `deliver` 发出（`pmDigest.start`，team-router.ts 里一行），不借用任何单条押后消息的发送闭包；信封再经 `deliverPmLocal` 时由 wrap 在项目锁里现拼正文。如果这条摘要押在 PM 的押后队列里，一个窗口内不再起新的；它重投时队列已空就丢掉，不发空摘要。
4. 摘要每行的格式是「来源 · 卡号 · 首行原文（截断 120 字）」。同一来源同一张卡（没有卡号时按同一首行）合并成一行，并记次数 `（×n）`。

## 开关：`on` / `observe` / `off`（按项目，缺省 `observe`）

- `observe`：照常逐条投递，信封原样不动，只记录归类结果（`digest` 即本来会合并的）。
- `off`：不记录，也不排队。
- 从 `on` 切走后，队里剩下的条目在下一轮定时器立刻送出，不等窗口。

## 通知级别：发送方标 `action` / `info`（`src/lib/pm-notice-level.ts`，分流开关 `on` 时生效）

推给 PM 的系统通知由发送方在代码里标级别，分流只认这个结构化字段（信封 `meta.pmLevel`），不看正文文字，换语言、改文案都不影响：

- `action`：要 PM 当场动手，立即叫醒。`info`：常规，**不送 PM**，也不进摘要——发送方本来就把它记在卡片 / 台账里（上线后提醒、缺规格提醒、合并进度、主线 CI 状态都有台账记录），分流这里只记一笔统计（`ledger pm-digest` 的 `level.info`）。PM 按需拉：`ledger pm-todo` 列观察期已到、还没结的上线后待办（`--all` 连没到期的），配合看 DAG。
- 怎么标：`notifyProjectPm(..., { level })`；调用链深、不便改签名的发送点在外面包 `asInfo(() => deps.notifyPm(...))`（AsyncLocalStorage，同 `pmNotifyTarget`）；bridge 合成的台账通知走 `sendLedgerNotice({ ..., pmLevel })`。
- 已标 `info`：上线后待办与待写规格（`sendToPm`）、残留进程观察报告（`card-proc-reap.ts`）、合并交接进度（`scheduler-merge-handoff-tick.ts`）、主线 CI 未开暂停时的通知、带默认做法到时自动定的执行者提问（`order-ask.ts`）。没带默认做法的执行者提问标 `action`。
- 没标级别的通知照旧走原规则（正文保护字样，宁可多叫醒）；新加的系统通知要标级别。

## 暂存：`ledger pm-hold`（`src/lib/pm-hold.ts`，按项目，缺省 `off`）

PM 每被叫醒一次都要重读整段上下文，额度的大头是叫醒次数。暂存开着时，投给当班 PM 的推送在摘要 / 分流之前就被截下、全文落盘（`pm-hold.json`），不叫醒 PM：

- 豁免（照常立即送）：owner / 人类 / peer 对话（`fromKind` 为 `user` / `api`、`user_discord`、peer 回程 `peer_http`）、卡片答复（`ask_answer`）、整包信封自己（label `pm-hold`）。
- `hold`：一直攒，切回 `off` 后下一轮 tick 整包送一封；`batch --every N`：队里最早一条等满 N 分钟（缺省 60）整包送一封。
- 整包：同来源同正文合成一条带次数，单条截 3000 字，整包超 4 万字的留到下一包；真送到或押进 PM 队里才出队，没送到留队下一轮再试。暂存文件写不进时这条照常往下走（宁可叫醒，不吞）。
- 命令：`ledger pm-hold` 只读状态与队列条数；`ledger pm-hold <off|hold|batch> [--every N]` 要项目真 PM / master / owner。

## 状态与命令

- `statePath("pm-digest.json")`：摘要队列加最近 24 小时的归类记录，只有 bridge 写。`statePath("pm-digest-mode.json")`：各项目开关，只有命令写。代码在 `src/lib/pm-digest-store.ts`。
- bridge 重启后，队列从盘上读回。启动时 `initTeamRouter` 就挂上发送入口和定时器，不靠重启后的新流量，队里的条目按上面第 2、3 条照常送出。
- 状态文件损坏（JSON 坏或结构不对，含队列 / 记录里缺字段的元素）：读者报一次、按空看；写者拒写（`StateCorruptError`），不覆盖原文件。bridge 这时把本该入队的消息照常立即送，不吞。开关文件损坏按缺省 observe，`pm-digest-mode` 拒写报错。
- `ledger pm-digest [--project <id>]`：只读。列出最近 24 小时立即送和可合并的条数、按来源和理由的分布，以及队里还剩几条。命令本身只读状态文件、不写台账；已登记进 `src/manager/write-commands.ts` 的 `LEDGER_READ_SUBS` 和 `READER_ONLY_SUBS`：认不出身份的调用方带 `--project` 也能看，走只读连接、不经 `openLedger`；台账库不存在时与 `merge-queue` 一样报错，不建库。
- `ledger pm-digest-mode <on|observe|off> [--project <id>]`：项目的真 PM、master 或 owner 才能切。

## 上线后

先用 observe 跑 24 小时，用 `ledger pm-digest` 看分布，确认没有本该立即送的被归成可合并。然后由 PM 切到 `on`，并在卡上记一条 note，写明切换前后 24 小时 PM 被叫醒的次数。

## 测试

- `tests/pm-digest.test.ts`：归类，以及摘要行的格式。
- `tests/pm-digest-queue.test.ts`：队列、窗口、合并计数、失败时留队、押后信封带着摘要经收件箱确认 / 重启后结清不重发、作罢或消失时回队、observe 与改前逐条一致、off、重启（无新流量）、并发只带一份、定时摘要不用撤下的押后闭包、不自环、状态损坏拒写、统计。
- `tests/pm-digest-delivery.test.ts`：经 `deliverPmLocal` 转交到当班 PM 的端到端场景；定时摘要经启动时的 router deliver 走 `deliverPmLocal` 不再入队。
