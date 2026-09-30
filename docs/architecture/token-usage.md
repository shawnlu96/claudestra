# Token 账：会话按轮落库（T83 Claude Code · T92 Codex · T95 算到卡上）

把每个 Claude Code 会话和 Codex 线程按「轮」切开，存进独立的 `~/.claude-orchestrator/usage/usage.sqlite`（不碰台账 `ledger.sqlite`），每一轮再按台账算到卡 / 步骤 / 轮次 / feature（文末「算到卡上」），给界面（T4）用。Codex 的差异集中在「Codex」一节。

代码：`src/lib/usage-classify.ts`（Claude 的切轮判定、来源摘要、调用）、`usage-codex.ts`（Codex rollout 的同一套）、`usage-store.ts`（库结构与清理）、`usage-ingest.ts`（导入）、`usage-attr.ts`（算到卡上）、`usage-query.ts`（读），CLI `src/manager/usage.ts`，只读 API `src/bridge/local-api/usage.ts`。单测 `tests/usage-classify.test.ts`、`tests/usage-ingest.test.ts`、`tests/usage-codex.test.ts`、`tests/usage-attr.test.ts`、`tests/usage-attr-api.test.ts`。

## 命令

```bash
bun src/manager.ts usage ingest [--since <ISO|ms>] [--prune] [--db <path>]   # 增量导入（--prune 顺带清超期明细），输出 JSON
bun src/manager.ts usage turns <agent> [--today|--since <ts>] [--json] [--limit N] [--no-ingest]
bun src/manager.ts usage summary [--today|--since <ts>] [--json] [--no-ingest]
bun src/manager.ts usage by-task <卡号> [--json]                 # 一张卡按 步骤 × 轮次 × agent
bun src/manager.ts usage by-feature <feature 名或 id> [--json]   # 一个 feature（或事项）按卡
bun src/manager.ts usage attribute [--today|--since <ts>] [--json] # 归属依据分布：未归属占多少、原因是什么
```

查询默认先增量导入一趟（导完按台账重算归属）。`--db` 指定别的库文件、`--ledger` 指定别的台账（对账、测试用，不写生产库；台账只读打开）。

谁来导（都在 `bridge/archive-sweeper.ts`，都是 manager 子进程，bridge 进程里不读文件）：
- bridge 起来 5 分钟后开始，**每 10 分钟**一趟 `usage ingest`（增量，通常 1 秒内）；上一趟没完就跳过这一趟。
- 每天归档兜底扫描之后一趟 `usage ingest --prune`，清 30 天前的明细。
- 查询命令查之前也导一趟。

几路之间靠库旁的文件锁 `usage.sqlite.ingest.lock` 串行（`lib/file-lock.ts`）：`ingest` 等锁最多 60 秒、查询最多 30 秒，等不到就说明别的进程正在导（多半是首轮全量）——`ingest` 把这一趟让出去，查询先查现有数据并在输出里注明。并发导入本身不会重复计数（主键去重），锁防的是同一批 GB 级文件被读两遍。导入是同步的，每读一块（8MB）、认领归属 / 清理之前各核对并续一次锁；失锁就停（输出 `aborted`），没做完的下一趟按偏移接着做。

## 什么算一轮

一轮 = 从一条**外来输入**开始，到下一条外来输入之前的最后一次调用为止。

算外来输入（开新一轮）：
- 人敲的字（`origin.kind = human`，老格式没有 origin 的普通文本）、斜杠命令（`<command-name>`）；
- channel 消息（Discord / Web / API / agent 之间，`origin.kind = channel`；老格式没有 origin、只有 `isMeta`，按完整的 `<channel …>` 包装认）、peer 消息；
- **忙时被队列吸收进当前回合的 channel 消息**（`attachment.type = queued_command`、`commandMode = prompt`）：它是另一条外来输入，从它起算新一轮，之前的调用归上一轮；
- 空闲时送来的后台任务通知（`origin.kind = task-notification`）、定时任务 / 唤醒（`isMeta` + `scheduledTaskId`）；
- 子 agent 文件里的第一条 prompt（记为 `subagent`）。

不算（接在当前轮里）：工具结果、`[Request interrupted by user…` 打断标记、`isMeta` 附加（图片说明、skill 正文、stop hook 反馈）、compact 摘要、自动续跑（`auto-continuation`）、本地命令 / `!` 命令的输出、忙时插进当前回合的后台任务通知。

**中断后续做**：打断标记归被打断的那一轮；之后人再说一句（「继续」也好、新要求也好）就是新的一轮。bridge 抢占时送来的那条插话同理，是新的一轮。

轮 id 用开轮那条记录自己的 `uuid`（channel 消息再带上输入身份）。同一条 channel 消息既进了队列附件、又落成 user 记录时算同一轮：按 `message_id` + 渲染后正文的哈希认（`inboundIdentity`）。只认 `message_id` 不够——同一张卡片上的几次按钮 / 选择共用卡片的 `message_id`，正文不同就是不同的输入。文件从一轮中间开始（fork / 续写的副本）时，开头那段调用单独成一轮，来源记 `continued`。

## 每轮记什么

agent、sessionId、是否子 agent（sidechain）、开始时间（外来输入的时间）、结束时间（最后一次调用）、调用次数；input / cacheCreation / cacheRead / output 四项之和；**看到的上下文** = 本轮单次调用里 input + cacheCreation + cacheRead 的最大值；工具调用次数和按名字计数（同一个 tool_use id 只算一次）；模型；来源类型和来源摘要。

来源摘要 = 渲染后的正文（channel 剥掉注入头、命令还原成 `/x 参数`、通知取 `<summary>`）压成一行，**先整段脱敏再截到 80 字**。脱敏认：标准 Base64（含 `+/`）40 位以上且大小写数字俱全的串（AWS secret 等）/ `sk-ant-` / `sk-` / `ghp_` 等 GitHub token / `xox?-` / AWS key / JWT / Discord bot token / 32 位以上十六进制 / 40 位以上字母数字混合串 / `Bearer xxx` / 名字里带 token、secret、password、api_key 的 `键=值`（引号括起来的值整段遮，值里可以有空格）。

## 数字怎么保证不重不漏

- **调用去重**：`calls` 以 `message.id + requestId` 为主键（与 `cost` 同一个键，`lib/jsonl-cost.ts` 的 `usageDedupKey`；没有 id 的老记录用条目 uuid）。同一响应拆成多行时各项取最大值（= 最后写完整的那行），**调用时间也取最后那行**（跨午夜的响应和 `cost --today` 一样算进今天；日期改了，原来那天和新的那天都重算 daily）。跨文件同样去重：归档快照、fork 抄过去的历史行都不会再算一次，调用归第一个读到它的文件。读文件的顺序是：在册 agent 的当前会话 → `archive/` → `~/.claude/projects` 其余。
- **轮的数字不单独存**：`turns` 只存轮头（来源、开始时间、归属），合计、看到的上下文都是查询时从 `calls` 聚合，重复导入不可能翻倍。
- **增量**：`files` 表按文件记读到的字节偏移，只读完整的行（文件尾没写完的半行等下一趟），当前所在的轮也记在里面，下一趟接着归。文件身份也记着（`dev:ino` + 已读部分开头和结尾各 4KB 的哈希）：文件变短、原路径换成了别的文件（轮转）、同一个 inode 截断后又写长，都从头重读，靠主键去重不翻倍。每块（8MB）一个事务，中途被杀也只是下一趟重读那一块。

## 归属

在册 agent 的当前 sessionId → 该 agent；`archive/<agent>/<sessionId>…`（kill / 换代 / 每日兜底时拷的快照，master 的历代会话在 `archive/master/`）→ 目录名；都认不出 → `unowned`，不丢。子 agent 文件（`<sessionId>/subagents/…`、workflow 目录）记到父会话的主人，轮上标 `sidechain`。先记成 `unowned`、后来归档认出主人的会话，下一趟导入时整体改过去（只改 `unowned` 的，不在两个具名 agent 之间搬）。

收 Claude Code 和 Codex；Pi 的文件按 `runtimeForSessionPath` 认出来跳过。

## 保留

- 明细（`calls` / `turns` / `tools`）保留 30 天（本地日期，从今天 00:00 往前数 30 天）；**更早的记录导入时直接跳过**，不回填，因为清理之后再读到同一会话的副本时已经没有主键可以挡重复。
- 清理只在每日那趟（`--prune`）做；10 分钟一趟的增量不删数据。
- `daily`（日 × agent × 模型）永久。导入时把涉及的日子记进 `dirty_days`，导完按明细重算那天：保留期内的日子一律照明细重算（调用挪去别的日子后可能变空）；保留期之前、明细已清掉的日子不再动它（它是唯一的记录）。改归属时同样只影响还有明细的日子。

## 与 `cost --today` 对账

`summary --today` 与 `cost --today` 用同一个「今天」起点（`currentUsageWindow().dayStart`）和同一个去重键。`cost` 只看在册 agent 当前会话的主文件，所以差异只会来自：`unowned`（没登记的会话：owner 自己开的终端、cron 临时 agent 的旧会话…）、归档里的旧会话（agent 今天 /clear、重启换过会话，或已被 kill）、子 agent 文件（按 agent 单列 `sidechainTokens`）。另外跨文件去重会让某个 agent 比 `cost` 少：同一次调用出现在两个文件里时只归一个。

## Codex（T92）

数据源：`$CODEX_HOME/sessions`（缺省 `~/.codex/sessions`；沙箱里 CODEX_HOME 不安全时跳过）下的 `rollout-*.jsonl`，以及归档里的 Codex 副本（`archive/<agent>/<thread>.jsonl`，按首行 `session_meta` 认）。只读这些会话文件，**不碰 `~/.codex/auth.json`、config 或任何凭据**；`session_meta` 里的账号 id 不入库。

- **文件**：`rollout-<ISO>-<threadId>.jsonl`，以及 `thread/revert` 之后的新段 `rollout-<ISO>-<threadId>_<rolloutId>.jsonl`（线程不变、文件换了）。共用的 `codexSessionIdFromFilename` 只认前一种，token 账自己两种都认。
- **一轮** = Codex 自己的 `turn_id`（`task_started` / `turn_context` 带），轮 id 是 `cx:<turn_id>`：revert 新段、归档副本里的同一轮还是同一行。轮中途追加的用户消息、同一轮的多条 `turn_context` 不切。一段从轮中间开始（没看到 `task_started`）时按 `token_usage_record.turn_id` 接回原来那一轮。来源类型和摘要取本轮第一条外来输入（复用 Claude 的判定：`<channel>` 包装、人敲的字；注入的 AGENTS.md / environment_context 不算），整轮没有就记 `other`。
- **一次调用** = 一次请求。新 Codex 每请求一条 `token_usage_record`，紧跟一条同数的 `event_msg/token_count`（`last_token_usage`）；老 Codex（本机 0.149）只有后者。两者落到同一个去重键 = 线程 + 五项原始计数（input / cached / cache_write / output / reasoning）：record 与 token_count、重复落盘的 token_count、revert 新段和归档副本带过去的旧记录都只算一次。不用时间戳（record 和 token_count 差几毫秒），不用 `response_id`（老版本没有）。本机 30 天 7259 次请求里，同一线程五项全同的两次不同请求为 0。全零的 token_count（只报限流）不算。
- **四项 + reasoning**：Codex 的 `input_tokens` 含命中缓存、`output_tokens` 含 reasoning。入库时 input = input − cached，cacheRead = cached，cacheCreation = cache_write，output = output − reasoning，reasoning 单列；五项之和 = `total_tokens`。看到的上下文 = 单次请求 input + cacheCreation + cacheRead（= Codex 的 input_tokens）。
- **`total_token_usage` 只用来对账**：它是进程级累计值，换进程 / resume 会重开，重开那一条丢了时做差会少算（本机 30 天少 0.6%），所以不拿它计数。
- **模型** = `turn_context.model`，是**请求**的模型（rollout 不记实际应答的模型，T91 查实）。查询结果带 `modelBasis: "request"`，文本视图在模型名后标「(请求)」；Claude 的是 `response`。
- **归属**：registry 里 Codex agent（tmux / ACP）的 `sessionId` 就是 thread id；其次归档目录名。子线程（`session_meta` 带父线程：subagent、guardian_review 等，判定复用 `codex-subthread.ts`）记到父线程的主人，标 `sidechain`、来源记 `subagent`。`codex exec` 一次性会话（ask_codex 等）和手开的会话认不出主人，记 `unowned`。
- 其余（按文件偏移 + 文件身份增量、锁、10 分钟增量、查询前导入、30 天清理）与 Claude 完全相同。

## 算到卡上（T95）

每一轮回答两个问题：为哪张卡、哪一步（复述 / 写 / 审 / 修 / 合并 / 验证）、第几轮花的；属于哪个 feature。结果写在 `turns` 的 `attr_task` / `attr_step` / `attr_round` / `attr_feature` / `attr_item` / `attr_basis` 六列，原始用量（`calls`、轮的其他列）不动。

**输入**全部来自台账（只读打开）：`tasks`（featureId、itemId、负责人）、`task_steps`（每一步第几轮派给了谁、何时派的；老卡没有步骤行时按负责人 / reviewer 推，同 `ledger-steps.ts` 的 `stepsOf`）、`events` 里的阶段事件、`scheduler_sessions`、各项目 `meta.pms`。

**按轮的开始时间判**，优先级从高到低：

1. **调度引擎绑定的会话**（`scheduler_sessions.sessionId` = 轮的 session / Codex thread）：整条会话属于那张卡，`basis = session`。步骤取这一刻卡所在的阶段，且要和会话角色对得上（author ↔ 复述 / 写 / 修，reviewer ↔ 审），对不上 step 记空。
2. **PM 与大总管**（任一项目 `meta.pms`、卡上的 `pm`、`master`）：一律 `coordination`（协调开销），不摊到卡上，哪怕它在某张卡上挂着执行者。
3. **步骤窗口**：阶段事件把一张卡切成一段段 `[起, 止)`；每段的执行者是这个阶段那一步（`STAGE_STEPS` 顺序：修没派人就退到写）的步骤行。同一步中途改派，在新那一行的派发时刻切开，之前归旧人、之后归新人。段开始时还没有行、行在段里或段尾 1 秒内才建的，从段开始就算它的（「修」那一行常在修完交付时才补派）。`blocked` 按卡住之前的阶段算；`spec`（PM 写规格）和 `verified` / `done` / `cancelled` 不开窗口。轮次取那一步的行；退到别的步骤时取阶段事件上的任务轮次。
   - 这一刻正好落在**一张卡**的窗口里 → `basis = step`。
   - 落在**两张以上**卡的窗口里 → `overlap`，不猜。

**未归属的原因**（`attr_task` 为空）：`coordination`、`overlap`、`outside_window`（台账里当过执行者，但这一刻不在任何窗口里，常见于台账阶段推晚了：在「规格」阶段就开工、审查阶段里已经在修）、`not_in_ledger`（台账里从没当过执行者：非台账管理的项目 agent）、`unowned`（会话不属于任何 agent）。

**feature**：卡上有 `featureId`（T84 新台账）就记它；另记卡的事项 `itemId`（还没迁进 feature 的卡挂在事项上）。`by-feature` 先按 id（全 id 或本机前缀后的 slug）精确找 feature / 事项，再按标题包含找，命中多个就列出来让人写 id；API 只认 id。

**何时算**：每次 `usage ingest`（bridge 10 分钟一趟、每日那趟、查询前那趟）导完就按台账**整体重算**一遍、只写变了的行（本机 30 天约 8 千轮，毫秒级）。所以规则改了、台账补推了阶段，下一趟全部跟着变；不需要迁移旧数据。明细清掉（30 天）之后的轮不再有归属，按卡的永久汇总不在本卡范围。

**只读 API**：`GET /api/v1/usage/task/:id`、`GET /api/v1/usage/feature/:id`，只给全权设备（`canAdministerPairing`：全 scope、非 peer、manage、设备凭据，与 `/ai-inventory` 同一道门），只读 usage 库现有数据（只读连接），不导入、不重算。
