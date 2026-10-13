# 叫醒成本：按每次叫醒计量任意 agent 的请求和上下文（PMCOST1）

`cost` 只给出整个会话 / agent 的总量，看不出「是谁叫醒了 agent、每次叫醒烧了多少上下文」。`wake-cost` 把 registry 里某个 agent 的**当前会话**按叫醒切开，给出每次叫醒的来源、请求数和上下文，以及分位数、步数桶和压缩后底线，作为 PMSLIM1 / PMROUTE1 / MEMIDX1 等瘦身卡的前后对照。

代码：`src/lib/wake-cost.ts`（切分、来源归类、聚合、人读表、周汇总），CLI `src/manager/wake-cost.ts`。单测 `tests/wake-cost.test.ts`、`tests/wake-cost-cmd.test.ts`（只用合成数据和临时目录）。

## 命令

```bash
bun src/manager.ts wake-cost --agent <名> [--today | --week | --since <ISO|ms>] [--json] [--write-weekly]
```

- 不带窗口 = 整个当前会话；`--week` 复用 `lib/usage-window.ts`（周额度周期，拿不到重置时刻退回滚动 7 天），输出 `window.source` 写明 `week:quota` / `week:rolling`。
- 无 `--json` 输出人读表（步数桶、来源、分位数、合计行）；`--json` 输出完整报表，含逐次叫醒明细 `wakes[]`。两者的合计同源。
- **只读**：不改会话、不 ingest、不写 usage 库，所以不需要 on / observe / off 开关（不改变调度、投递或会话）。
- `--write-weekly`（只配周窗口，不写窗口时默认周）显式把**无正文**汇总（去掉 `wakes[]` 明细、不含生成时刻）原子覆盖写到 `<状态目录>/wake-cost/<周起点 ISO>.json`；同窗口同数据重写逐字相同。本卡不加自动定时器。

## 口径

**叫醒**：按原始顺序，每条**不是纯 tool_result** 的 user 记录开一次叫醒，止于下一次叫醒或 EOF。混合文本与 tool_result 的 user 也算新边界；`system/compact_boundary` 本身不叫醒（其后的压缩续接 user 记录才叫醒，归「压缩续接」）。每轮 `end` 为下一次叫醒边界的时间，尾轮为最后一条记录的时间。文件头的元数据（`file-history-snapshot`、permission-mode 等）不算叫醒；文件头若在首个边界前确有请求（续接会话），那段请求单列一次 `other / no-boundary-head`。

与 token 账（`docs/architecture/token-usage.md` 的「轮」）不同：那边跳过 isMeta 附加、压缩摘要；这里技能正文、压缩续接各算一次叫醒并单独归类，因为要看的是「谁让 agent 又跑了一趟」。

**来源**（`classifyWakeSource`，纯函数，先看结构字段、不读正文；`reason` 只写规则代号，不带正文、用户名或 id）：

| 来源 | 依据 |
| --- | --- |
| `owner` | channel 头 `trigger="user_discord"`（非 api）、`trigger="ask_answer"` |
| `dispatch`（调度 / 台账 / 巡检 / 监工） | `is_bridge` / `user="bridge:*"`、`trigger="system"` / `bridge_synth`、agent 名是 scheduler / ledger / patrol / supervisor / watchdog 等 |
| `executor` | 其它 agent（`is_agent` / `agent_tool`）、`peer_http` |
| `task_notification` | `origin=task-notification` 或 `<task-notification` |
| `skill` | `Base directory for this skill:` 开头的技能正文 |
| `compact_resume` | `isCompactSummary`、压缩续接固定开头 |
| `other` | 其余；`api="true"`（头里分不出 owner 与访客）、终端直接输入、未知文本都归这里——**不猜 owner** |

**请求 / 步数**：叫醒内去重后、带 usage 的 assistant 响应数（不是工具调用数）。去重键复用 `jsonl-cost.ts usageDedupKey`（`message.id` + `requestId`，同一响应取最后写的那行 usage）；PM 实测脚本 `pm_wake_detail.py` 只按 `message.id`，两者只在同一 `message.id` 配不同 `requestId` 时有差。同一响应被抄到后面（fork / resume）仍归首次出现的那次叫醒。

**token**：输出 `input`、`cacheRead`、`cacheCreation`、`output`；`contextTotal` 只合前三项。

**聚合**：
- `requestContext`：每个请求的 contextTotal；`wakeCost`：每次叫醒的 contextTotal。各给 p10 / p50 / p90 / max，排序后取 `floor(p×(n−1))`，空样本为 null。
- `compactFloor`（压缩后底线）：每个 `compact_boundary` 后**首个有效去重请求**的上下文，给样本数与分位数；没压缩过就是 n=0 / null，不拿未压缩会话的最小值充数。
- `buckets`：按请求数 0、1–3、4–10、11+ 分桶，列叫醒数、请求数、contextTotal、占比（0–1，总量为 0 时为 0）。`bySource` 同理，另附各 reason 的次数。

**窗口**：扫描始终从文件头开始，用窗口前最近的边界归属请求，只累加时间戳落在窗口内的请求；开始于窗口前的叫醒标 `windowTruncated`，窗口内一个请求都没有的不输出。最后一次叫醒止于 EOF，标 `unfinished`（可能还在跑）。坏 JSON 行跳过并计入 `badLines`，缺 usage 的 assistant 不计。

## 覆盖范围（首版）

- 只算 registry 里该 agent 的**当前会话**，`coverage` 写明会话 id 前 8 位和首末记录时间；归档、fork 的跨会话归属不做，不声称覆盖全周全历史。
- 只支持 Claude Code。registry 里 runtime 不是 `claude-code`、或会话文件被 `session-source` 认成别的运行时，输出 `status: "unsupported"`；找不到会话文件输出 `status: "unknown"`，都不给同口径数字。

## 上线后

当班 PM 只读跑一次周窗口，记覆盖范围、叫醒数、11+ 步成本占比、压缩后底线；后续瘦身卡用同一窗口长度对照，不挂新的后台盯盘。
