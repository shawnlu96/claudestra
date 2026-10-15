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
| `sync` | 其他 agent（不含 scheduler / master / pm-switch）发来的消息：oneShot（只按 `level` 分流、不看正文，见下文「通知级别」），或首行开头写「只同步」；等回复（非 oneShot）的「只同步」只认单行，首行以下还有内容就立即送；**整段正文**任一行都不能带失败、冻结、事故、告警、交付、提问、问号、「请」、方案 / 下一步 / 意见 / 怎么办 / 能否等字样（摘要只留首行，后面几行的要紧事或请求一进队就看不见了） |

下面这些总是立即送：owner 和人类消息、API / peer 消息、卡片答复（`ask_answer`）、其他 bridge 通知（含 `ledger` 的执行者提问和交付，以及本功能自己的单独摘要 `pm-digest`，防自环）、调度器的其他通知，以及等回复的 agent 消息。

## 拉取（`ledger pm-digest-pull`，按项目，缺省 `on`）

PM 不需要实时知道常规进展，要的时候自己拉（owner 10-15 定）。拉取开着时，下面第 2、3 步都不做：可合并的消息照常进队、返回 `note: "digest"`，但不搭在任何消息前面，定时器也不单独送；PM 用 `ledger pm-digest --list` 看队里的条目，放满 24 小时没人拉的出队（原始内容在卡片、台账、处理员草稿里）。切 `off` 回到下面的推送摘要；即使推送，owner / peer 的消息（`from.kind` 为 `user` / `api`）也不搭摘要，因为拼进正文的摘要会显示在对方自己的消息气泡里。

## 送出时机（开关 `on`，拉取 `off`）

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
- **必填，不标编译不过**（agents-NOTICETYPE1）：`notifyProjectPm(..., { level })`、`sendLedgerNotice({ ..., pmLevel })`、`sendToPm(env, project, to, text, level)`、`notifyTaskPm(..., label, level)`，以及各模块注入的 `notifyPm(task | project, text, level)` 端口，级别参数都是必填的 `PmNoticeLevel`。逐个调用点按语义标：要 PM 动手 / 决定 / 失败 / 安全标 `action`；进度、已自动处理、仅供知悉标 `info`；拿不准标 `action`。`asInfo(() => ...)` 保留为兼容（没过类型检查的调用方才会落到它的隐式级别），被它包住的调用照样显式写 `"info"`。`tests/pm-notice-level-types.test.ts` 用 `@ts-expect-error` 钉住「少了级别编译不过」，`tests/pm-notice-level-guard.test.ts` 扫 src 不许 `level: undefined` / `as any` / `as never` 绕过。
- 标 `info` 的例子：上线后待办（`scheduler-post-verify.ts`）、残留进程观察报告（`card-proc-reap.ts`）、合并交接进度（`scheduler-merge-handoff-tick.ts`）、主线 CI 未开暂停时的通知、manual 已自动交回、等跨家族 peer、spec 等放置、观察期自动转正、合并列车的非告警进度、带默认做法到时自动定的执行者提问（`order-ask.ts`）。
- **分流**：`classifyPmPush` / `classifyPmRoute` 见到结构化级别（调度器、bridge 合成通知、agent 的 oneShot）就只认它——`action` 立即送，`info` 进摘要（分流开关 `on` 时调度器 / 台账的 `info` 照旧只记一笔、不进摘要）。正文正则（`URGENT_RE` / `HALT_RECHECK_RE`，`pmBodyUrgent`）只剩没有级别、也不是 oneShot 的外来消息（老版本 peer、老格式 bridge 消息、等回复的 agent 消息）在用。
- **样本记录口**：归类记录带 `levelSource: "structured" | "regex"`（规格里写作 source；记录已有表示发送方的 `source` 字段，所以另起名），`ledger pm-digest` 的统计可以按它看本项目入口是否都走了结构化级别。没有新恢复键——类型强制不是运行时开关。

### agent 的 oneShot：`send_to_agent({ oneShot: true, level })`

- `send_to_agent` 有可选参数 `level`（`action` / `info`），经 bridge 写进信封 `meta.pmLevel`。bridge 只在 **oneShot** 且值严格是 `action` / `info` 时放行 agent 帧带的级别（`frameLevel`，`pm-notice-level.ts`）；等回复的帧、非法值一律丢；调度器帧（没注册频道的系统进程）照旧认。级别只影响 PM 侧立即送 / 摘要的分流，不碰身份和信任。
- PM 侧：oneShot + `action` → 立即送；oneShot + `info` → 进摘要、不送；**没标级别的 oneShot（不论中英文、不论正文写什么）→ 不送、进摘要队列（条目带 `unleveled`），`ledger pm-todo` 把它们列出来（发送方 · 首行，卡号在 task）**，PM 拉取时处理。系统发送方（scheduler / master / pm-switch）不算「其他 agent」，没标级别时照旧原规则。
- 审批 / 要 PM 决定的 `send_to_agent` 由发送方标 `level: "action"`（立即叫醒）；纯进度标 `info`。例：`send_to_agent({ target: "agent-pm", oneShot: true, level: "action", text: "agents-X1: please approve the migration plan (PR #12)" })`；`send_to_agent({ target: "agent-pm", oneShot: true, level: "info", text: "agents-X1 进度：第 2 步已过" })`。master / 执行者模板里的这条说明由 PM 在模板侧补。
- 只在摘要开关 `on` 时生效（`observe` / `off` 照常逐条投，模式语义不变）。回退：`ledger pm-digest-pull <project> off` 把摘要队列改回推送，没标级别的 oneShot 随下一封立即送的消息或 4 小时窗口摘要送到 PM，不会只躺在 pm-todo 里。

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
