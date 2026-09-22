# Web 客户端数据流（完整版）

> 2026-09-23 从 `web/CLAUDE.md` 原样搬出：每个会话都加载的那份文件要保持精简（`scripts/guard` 对它按字节棘轮）。下文的版本号与日期是历史，以代码为准。

## 数据流（/api/v1 + /events）

会话 = 一个 claudestra agent。前端每打开一个 agent：先拉历史（`GET /api/chat/history`），
再建一条持久 SSE 流（`GET /api/chat/stream`）；`send` fire-and-forget（wait=0），输出经流回来。

- **列表**：`loadAgents` → Bridge `GET /api/v1/agents?include=stopped`。master 由 Bridge
  置入（token scope 显式含 master），前端映射为 `__master__` 置顶（👑 大总管，不显 kill/restart）；
  stopped agent 保留入口（历史经归档 API 仍可读——会话归档的意义就在这）。
- **发消息**：`POST /api/v1/agents/:name/messages {text, wait:0}` → 202。agent 离线 409。
- **流式**：BFF 订阅 `GET /api/v1/events`（fetch-based SSE，带 Bearer），按
  `agent ∈ {name, agent-name}` 过滤，把 BridgeEvent 翻译成前端 WebStreamEvent（协议 v1 不变）：
  `agent_status(thinking/done)→status/done`、`tool_start→tool(running)`（tool_done 不重复推卡）、
  `assistant_text→text`、`chat_message(out)→text`（reply() 的最终回复）、`question→ask`、
  `question_cleared→ask-cleared`（fork 事件）、`auto_deny→text(🚫)`。连流后补拉
  `GET /api/v1/agents/:name/pending` replay 挂起的 AUQ 卡（对应旧 web-hub 的 pendingInteraction）。
- **历史**：`GET /api/v1/agents/:name/history` 取 session 清单（mtime 降序，live+归档合并，
  对已 kill agent 有效）→ 最新 session 的尾部 300 条 → 映射 ChatMessage[]
  （compactSummary 跳过；system compact 线渲染成轻提示）。**BFF 不再直读 jsonl / registry。**
- **唤醒对齐 = cursor 差量同步（v2.16，Telegram getDifference 同构）**：全量加载时
  服务端附 `lastSeq`（合并气泡前最后一条原始记录的 jsonl 行号——不能用气泡 id 推，
  组内后续记录会被重复拉），chat-store 存游标 `{sessionId, lastSeq}`。回前台/点推送
  进入时 `syncDelta` 只拉 `?session=&after=` 差量（几条几 KB，8s 短超时+1s 快重试），
  视图重组 = 现有 h 气泡 + 差量 + 幸存乐观消息 + 直播保全（对账在 `survivingPending`，
  与全量共用）；**先差量后开流**（串行，防直播气泡被视图重组过滤），流不带 `since`
  （重放与差量必然重复）。BFF 差量分支先查清单做轮转检测（pinned≠newest →
  `rotated:true`）；轮转/差量超一页/连败 → 自动回退全量。跨境链路唤醒到上屏从
  ~14s 降到 ~0.5-2s（2026-07-28 实测追平 533ms）。
- **重复发送闸（v2.23.2，`features/chat/send-dedupe.ts`）**：`send()` 上同 agent + 同 wire
  载荷 + 1.5s 内只发一次（带附件不参与）。触屏「发送」有 pointerup 直接执行与 click 兜底两条路，
  各自有防重窗口，但 owner 2026-09-19 实录仍漏出一次同句 0.7s 双发，第二条还抢占打断了正在跑的
  回合。逐条堵不如在唯一出口装闸；丢弃时打 client.log「丢弃 1.5s 内的重复发送」。同日第二例是
  iOS 听写：发送清空输入框后听写把**标点润色过的最终稿**写回框里，用户以为没发出去再点一次
  （两条正文只差「票。/票？」这类标点，间隔 2.16s）——所以再加一档「去标点空白后相同 + 5s」
  （`normalizeForDedupe`）。⚠ 只挡住重复投递；听写回写导致输入框不空这个根因没动（改输入路径
  风险高：React #185 / IME 失效都出在那条路上）。
- **直播 ↔ 历史判重按 seq（v2.23.2，`features/chat/live-merge.ts`）**：同一条 jsonl 记录
  两条路都会到（watcher 推事件 / 7s 对账拉差量），先后不定。watcher 的 tool/text 事件带
  `{seq, sid}`（记录的全文件行号 + 会话 id，BFF `recordSrc` 透传），历史游标 `{sid,lastSeq}`
  说「≤ lastSeq 都已在历史里」：事件后到 → `coveredByCursor` 命中不画（client.log
  「丢弃已入历史的直播事件」10s 合并计数）；事件先到 → 差量/全量应用时 `pruneLiveBubbles`
  按 seq 剥掉直播气泡里已覆盖的段/工具，剥空即丢；reply 段（bridge 直投无 seq）看历史里有无
  同文；没带 seq 的老事件退回时间戳 ±5s 规则。`mergeContiguousAssistant` 把长回合被差量切成
  的多段历史气泡拼回一泡。⚠ 别再用时间戳猜重复——流一延迟 / 两端时钟一偏就两份
  （owner 2026-09-17 两次截图）。
- **大总管**：Bridge 侧 `findApiAgent("master")` 特判（fork）——messages/history/interrupt/answer
  对 master 透明可用。master 没有 jsonl-watcher，实时只有 reply 的 `chat_message(out)` + done；
  历史从 jsonl 读所以带工具卡。
