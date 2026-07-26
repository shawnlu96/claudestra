# Fork 差异清单（do-md/claudestra vs shawnlu96/claudestra）

> 本 fork 的使命：给 Claudestra 加一个可 PWA 安装、**自托管 VAPID Web Push**（零第三方账号）的 **Next.js Web 客户端**
> （`web/`，Discord 之外的第二前门）。2026-07-10 起全面采纳 upstream 的多前端解耦架构
> （`docs/design-multi-frontend.md` + `docs/web-frontend-guide.md`），fork 侧只保留
> upstream 没有的能力，全部以 `[fork]` 注释标记、遵守 additive-only 合同。
> **merge upstream 时的原则：冲突全取 upstream，再按本清单核对 fork 增量是否需要重挂。**

> **2026-07-11 更新**：已合并 upstream v2.10（`bridge/api-routes.ts` 路由拆分 +
> `bridge/web-gateway.ts` 的 CORS / SSE query-token / 静态托管），并把**完整 fork（含 `web/`）**
> 回并上游 —— PR [shawnlu96/claudestra#3](https://github.com/shawnlu96/claudestra/pull/3)（待审）。
> ⚠ 随该 merge，fork 的 `/api/v1` 端点已从 `bridge.ts` **迁到 `src/bridge/api-routes.ts`**
> （作者把 `/api/v1` 路由块整体拆成独立模块）。下方清单凡写「bridge.ts」的 `/api/v1` 补丁点，
> 现落点均为 `api-routes.ts`；`latestSessionIdForCwd` 也迁入 `api-routes.ts`，
> `scheduleClearRotation` 留 `bridge.ts` 经 `initApiRoutes` 注入。

## fork 独有目录（upstream 无，merge 不冲突）

- `web/` — Next.js Web 客户端（BFF 消费 upstream /api/v1 + /events，见 `web/CLAUDE.md`）
- `scripts/web-only-bridge.sh` / `scripts/web-only-launcher.sh` — launchd 常驻封装
- `src/bridge/local-adapter.ts` — local ChatAdapter（见下）
- 本文件

## src/ 内的 fork 增量（merge 后需核对的补丁点）

### Web-only 模式（无 DISCORD_BOT_TOKEN 可跑）
- `bridge/config.ts`：`WEB_ONLY = !process.env.DISCORD_BOT_TOKEN`
- `bridge.ts` 末尾启动块：WEB_ONLY 分支跳过 Discord 登录，只跑
  bg-activity-watcher / archive-sweeper / metrics（Discord 专属初始化全部跳过）
- `bridge/local-adapter.ts` + 注册：provisionConversation 返回 `local-<uuid>`
  合成会话地址（manager create 零改动），出站 no-op（web 走 /events + 历史 API）
- `bridge/router.ts` parseChatId/formatChatId：`local-` 前缀 → transport "local"
- `bridge.ts` ws case：create_channel 按 WEB_ONLY 选 adapter；delete/rename_channel、
  announce_focus 对 local-* no-op

### additive /api/v1 端点（upstream 缺口，落地后应切换删除；v2.10 merge 后落 `bridge/api-routes.ts`）
- `POST /api/v1/agents/:name/interrupt` — tmux C-c（master → master:0）
- `POST /api/v1/agents/:name/answer` — AUQ submit/cancel（buildAuqKeystrokes）+
  权限弹窗 allow/allow_session/deny（发键前 tmuxCapture 重验）
- `GET /api/v1/agents/:name/pending` — 挂起交互补拉（SSE 迟到订阅者 replay）；
  additive 加 `thinking: boolean`（该 agent 此刻是否在回合中，见「事件与状态」getAgentStatus），
  web composer 连流时读它同步「暂停」态
- `POST /api/v1/agents` + `POST /api/v1/agents/:name/{kill,restart}` — 生命周期，仅全权 token
- `POST /api/v1/agents/:name/clear` — 远程调用 CC 原生 /clear（tmuxSendLine 打
  `/clear`，与 slash 转发同款通道；发键前 paneLooksIdle 验 idle，回合中 409）。
  非 master 返回 202 后后台轮转收尾（scheduleClearRotation：poll 新 jsonl →
  manager set-session 归档旧会话+切 registry → watcher 重绑；同 cwd 多 agent 时
  跳过属于他人的 sid）。master 只发键（CLAUDE.md 人设自动重载，无 registry/watcher）。
  clear 后发不发「开机指令」是 web 前端（用户层）的事，端点零感知——语义分层：
  Shawn 看到的是原生 /clear，图谱注入藏在前端配置的消息文本里。
  ⚠ 实测：CC 原生 auto-memory（projects/<slug>/memory/）会跨 /clear 存活——
  上下文清零但 CC 自己的记忆层还在，这是 CC 原生行为不是 bug。
- **Web 远程终端**（`src/bridge/web-terminal.ts` 新文件 + bridge.ts 三处挂点：import /
  `/api/v1/` 分发前拦截 / 启动 sweep）：`GET /api/v1/agents/:name/terminal?cols=&rows=`
  （SSE：PTY 输出 base64 帧；连接即建 `Bun.Terminal` + `tmux attach` 到 grouped
  viewer session `webterm-<id>`，断开即销毁）+ `POST /api/v1/terminal/:id/{input,resize}`。
  三端点**不走 SlidingWindowLimiter**（逐键输入秒超 30/min；Bearer + termId 属主校验不变）。
  🔒 鉴权（合并后 code review B2 收敛）：终端 = **宿主 shell 级访问**（可 Ctrl-C 逃出 CC
  落到裸 shell、绕过 `--disallowedTools`），故要求 `terminalAllowed`（token 需 `token-add
  --terminal` 显式授予 terminal scope，不复用裸 messaging scope）；并发有 MAX_TERM_SESSIONS
  上限（含在途占坑，防并发绕过）。⚠ 两个不变式：resize 后必须手动 `proc.kill("SIGWINCH")`
  （Bun.Terminal 子进程无 controlling tty，TIOCSWINSZ 生效但内核不发信号，PoC 实证）；
  SSE 连接即发首包 + 5s ping（Bun idleTimeout 坑，同 handleEventsRequest 修复）。
  需 Bun ≥1.3.5（Bun.Terminal）+ tmux ≥3.2（grouped session 窗口索引与 master 一致，实测）。
- `GET /api/v1/agents` 增强：`?include=stopped` 入列已停止 agent；master 入列
  （scope 显式含 "master" 才可见）
- `findApiAgent` master 特判：channelId=CONTROL_CHANNEL_ID、cwd 取 channel-server
  注册信息、sessionId probe 最新 jsonl → messages/history/interrupt/answer 对 master 透明

### 事件与状态
- `bridge/event-bus.ts`：`question_cleared` 事件类型（additive）——AUQ 应答/取消后
  web 收卡；Discord AUQ 按钮 + API answer 双侧发射
- `bridge/event-bus.ts`：`getAgentStatus(agent)`（additive）——O(1) 追踪每个 agent 最近一次
  `agent_status`（thinking/done）。`emitEvent` 里旁路更新一个 `agentStatuses` map。供
  `/pending` 的 `thinking` 字段用（web composer 刷新/切回/回前台连流时同步「暂停」态）。
  bridge 重启清零（同 ring 的 R6，权威回合边界靠 Stop hook 的 done）。单测在 tests/event-bus.test.ts。
- `bridge/ask-user-question.ts`：`registerAuqState` 把状态注册与 Discord 渲染解耦
  （web-only / post 失败时 answer 端点仍有状态可用）；jsonl-watcher 调用点先注册后渲染

### 修复（应上报 upstream）
- **历史 API 丢所有 channel 用户消息**（lib/session-history.ts）：channel 送达的
  入站消息（web/API/Discord/agent↔agent）在 CC jsonl 里是 `isMeta:true` +
  `<channel …>` 包装的 user 记录，被 `isMeta` 一刀切过滤 → 任何 web 前端的历史
  里都没有用户消息，回合结构随之丢失（连续 assistant 粘连）。修复：新增
  `unwrapChannelMessage`（剥 wrapper + `[🌐/🤖 …]` framing header、提取 `user`
  属性为 `from` 字段），isMeta 分支先尝试解包再过滤；`HistoryMessage` 增
  `from?: string`（additive）。测试：tests/session-history.test.ts
  `unwrapChannelMessage` describe 块。
- **/events SSE 空闲断流**（bridge.ts handleEventsRequest）：Bun.serve 默认 HTTP
  idleTimeout≈10s，upstream 的 30s ping 活不到第一轮，事件间隙 >10s 的订阅者被静默
  掐掉（实测 10.7s close）。修复：连接即发 `: connected` + ping 5s。
- **API 回复事件重复**（bridge.ts reply ws case）：api: 目的地的回复 deliverToApi
  已埋点 chat_message(out)，reply case 再发一次 = 同一条回复两个事件。修复：api
  transport 跳过 reply case 的埋点。
- **agentInScope R1 漏洞**（lib/principals.ts）："agent-master" 变体未按 master 处理，
  `"*"` token 可经前缀变体绕过 master 排除。修复：两个名字都算 master。

### 其它
- `manager.ts` token-add：允许显式 `master` scope 值（--force；大总管接入 web 用）
- `manager.ts` set-session <name> <sessionId>：归档旧会话 + registry 切 sessionId
  （clear 轮转收尾用；registry 写入保持 manager 唯一写者不变式）
