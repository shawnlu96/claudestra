# Token 账：Claude 会话按轮落库（T83）

把每个 Claude Code 会话按「轮」切开，存进独立的 `~/.claude-orchestrator/usage/usage.sqlite`（不碰台账 `ledger.sqlite`），给后续的 Codex 采集（T2）、归到任务步骤（T3）和界面（T4）用。

代码：`src/lib/usage-classify.ts`（切轮判定、来源摘要、调用）、`usage-store.ts`（库结构与清理）、`usage-ingest.ts`（导入）、`usage-query.ts`（读），CLI `src/manager/usage.ts`。单测 `tests/usage-classify.test.ts`、`tests/usage-ingest.test.ts`。

## 命令

```bash
bun src/manager.ts usage ingest [--since <ISO|ms>] [--db <path>]      # 增量导入 + 清理超期明细，输出 JSON
bun src/manager.ts usage turns <agent> [--today|--since <ts>] [--json] [--limit N] [--no-ingest]
bun src/manager.ts usage summary [--today|--since <ts>] [--json] [--no-ingest]
```

`turns` / `summary` 默认先增量导入一趟。`--db` 指定别的库文件（对账、测试用，不写生产库）。bridge 每天在归档兜底扫描（`bridge/archive-sweeper.ts`）之后以子进程跑一次 `usage ingest`。

## 什么算一轮

一轮 = 从一条**外来输入**开始，到下一条外来输入之前的最后一次调用为止。

算外来输入（开新一轮）：
- 人敲的字（`origin.kind = human`，老格式没有 origin 的普通文本）、斜杠命令（`<command-name>`）；
- channel 消息（Discord / Web / API / agent 之间，`origin.kind = channel`）、peer 消息；
- **忙时被队列吸收进当前回合的 channel 消息**（`attachment.type = queued_command`、`commandMode = prompt`）：它是另一条外来输入，从它起算新一轮，之前的调用归上一轮；
- 空闲时送来的后台任务通知（`origin.kind = task-notification`）、定时任务 / 唤醒（`isMeta` + `scheduledTaskId`）；
- 子 agent 文件里的第一条 prompt（记为 `subagent`）。

不算（接在当前轮里）：工具结果、`[Request interrupted by user…` 打断标记、`isMeta` 附加（图片说明、skill 正文、stop hook 反馈）、compact 摘要、自动续跑（`auto-continuation`）、本地命令 / `!` 命令的输出、忙时插进当前回合的后台任务通知。

**中断后续做**：打断标记归被打断的那一轮；之后人再说一句（「继续」也好、新要求也好）就是新的一轮。bridge 抢占时送来的那条插话同理，是新的一轮。

同一条 channel 消息既进了队列附件、又落成 user 记录时（按 `message_id` 认），算同一轮。文件从一轮中间开始（fork / 续写的副本）时，开头那段调用单独成一轮，来源记 `continued`。

## 每轮记什么

agent、sessionId、是否子 agent（sidechain）、开始时间（外来输入的时间）、结束时间（最后一次调用）、调用次数；input / cacheCreation / cacheRead / output 四项之和；**看到的上下文** = 本轮单次调用里 input + cacheCreation + cacheRead 的最大值；工具调用次数和按名字计数（同一个 tool_use id 只算一次）；模型；来源类型和来源摘要。

来源摘要 = 渲染后的正文（channel 剥掉注入头、命令还原成 `/x 参数`、通知取 `<summary>`）压成一行，**先整段脱敏再截到 80 字**。脱敏认：`sk-ant-` / `sk-` / `ghp_` 等 GitHub token / `xox?-` / AWS key / JWT / Discord bot token / 32 位以上十六进制 / 40 位以上字母数字混合串 / `Bearer xxx` / 名字里带 token、secret、password、api_key 的 `键=值`。

## 数字怎么保证不重不漏

- **调用去重**：`calls` 以 `message.id + requestId` 为主键（与 `cost` 同一个键，`lib/jsonl-cost.ts` 的 `usageDedupKey`；没有 id 的老记录用条目 uuid）。同一响应拆成多行时各项取最大值（= 最后写完整的那行）。跨文件同样去重：归档快照、fork 抄过去的历史行都不会再算一次，调用归第一个读到它的文件。读文件的顺序是：在册 agent 的当前会话 → `archive/` → `~/.claude/projects` 其余。
- **轮的数字不单独存**：`turns` 只存轮头（来源、开始时间、归属），合计、看到的上下文都是查询时从 `calls` 聚合，重复导入不可能翻倍。
- **增量**：`files` 表按文件记读到的字节偏移，只读完整的行（文件尾没写完的半行等下一趟），当前所在的轮也记在里面，下一趟接着归。文件变短（被重写）就从头重读，靠主键去重。每块（8MB）一个事务，中途被杀也只是下一趟重读那一块。

## 归属

在册 agent 的当前 sessionId → 该 agent；`archive/<agent>/<sessionId>…`（kill / 换代 / 每日兜底时拷的快照，master 的历代会话在 `archive/master/`）→ 目录名；都认不出 → `unowned`，不丢。子 agent 文件（`<sessionId>/subagents/…`、workflow 目录）记到父会话的主人，轮上标 `sidechain`。先记成 `unowned`、后来归档认出主人的会话，下一趟导入时整体改过去（只改 `unowned` 的，不在两个具名 agent 之间搬）。

只收 Claude Code 的记录：Codex（T2 另做）和 Pi 的文件按 `runtimeForSessionPath` 认出来跳过。

## 保留

- 明细（`calls` / `turns` / `tools`）保留 30 天（本地日期，从今天 00:00 往前数 30 天）；**更早的记录导入时直接跳过**，不回填，因为清理之后再读到同一会话的副本时已经没有主键可以挡重复。
- `daily`（日 × agent × 模型）永久。导入时把涉及的日子记进 `dirty_days`，导完按明细重算那天；那天明细已清掉就不再动它（它是唯一的记录）。改归属时同样只影响还有明细的日子。

## 与 `cost --today` 对账

`summary --today` 与 `cost --today` 用同一个「今天」起点（`currentUsageWindow().dayStart`）和同一个去重键。`cost` 只看在册 agent 当前会话的主文件，所以差异只会来自：`unowned`（没登记的会话：owner 自己开的终端、cron 临时 agent 的旧会话…）、归档里的旧会话（agent 今天 /clear、重启换过会话，或已被 kill）、子 agent 文件（按 agent 单列 `sidechainTokens`）。另外跨文件去重会让某个 agent 比 `cost` 少：同一次调用出现在两个文件里时只归一个。
