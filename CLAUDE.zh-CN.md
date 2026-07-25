# Claudestra — 架构文档

[English](./CLAUDE.md) · **简体中文**

本文档描述 Claudestra 的内部架构，面向贡献者、修改代码的 agent、以及排查生产问题的人。新用户请先看 [SETUP.zh-CN.md](./SETUP.zh-CN.md)。

## 系统概览

Claudestra 是一个多 session 编排器，基于 Claude Code 原生的 **Channel 协议**（MCP 的一个扩展）。一个 Bridge 进程把单个 Discord bot token 扇出到多个 Claude Code session——每个 session 作为一个独立的 channel 监听者注册。

```
 Discord (一个 bot, 一个 token)
        │
        ▼
 Bridge  ── bridge.ts, launchd 管理, ws://localhost:3847
        │
        ├── WebSocket 路由              ├── JSONL Watcher               ├── HTTP Hooks
        │                               │                               │
        │   channel → master            │   tool call → Discord         │   Stop       → 停止 typing
        │   channel → agent A           │   claude 文本 → Discord        │   Notification → 兜底
        │   channel → agent B           │   合并 + 去抖                   │   30 分钟安全超时
        │   ...                         │                               │
```

**消息流向：**

- **入站** — Discord → Bridge → channel-server (MCP) → Claude Code session。
- **出站** — Claude Code 调用 `reply` 工具 → channel-server → Bridge → Discord。
- **流式 tool call** — Claude Code 写 JSONL → jsonl-watcher 监听 → Bridge 推送格式化的 tool 摘要到 Discord。

每个 Claude Code session 都有自己的 `channel-server` 子进程，作为 stdio MCP server 运行。channel-server 一边跟 Claude Code 讲 MCP，另一边跟 Bridge 讲轻量的 WebSocket 协议。

## 项目结构

```
src/
  bridge.ts              主入口：Discord client、WebSocket server、事件分发、slash 命令
  bridge/
    router.ts            v2.0.0+ Envelope/Endpoint 类型 + parseAddress + threadId 助手；v2.6.0+ parseChatId（带 transport 前缀的统一 chat_id 键空间）+ ApiUserEndpoint
    adapters.ts          v2.6.0+ ChatAdapter 接口 + 注册表（出站按 transport 分发，Discord 是第一个 adapter）
    event-bus.ts         v2.6.0+ 进程内事件总线（seq + 每 agent 环形缓冲，tool 调用/文本/状态 → SSE 事件流）
    config.ts            共享运行时常量
    components.ts        Discord UI 组件 + typing indicator
    discord-api.ts       Discord API 封装（建/删频道、编辑消息等）
    management.ts        管理按钮/菜单的直接执行处理器（绕过 LLM）
    screenshot.ts        终端截图流水线（ANSI → HTML → PNG）
    jsonl-watcher.ts     JSONL session 监听 → 流式 tool call 摘要 + assistant 文本流 + Stop 时同步 drain
    slash-catalog.ts     CC 内置 slash 命令的硬编码清单（挑了 Discord 上好用的那批）
    slash-registry.ts    运行期发现的 skill 注册表（按 scope）+ 每频道解析器
    wedge-watcher.ts     检测卡死 >30min 且非空闲的 agent → Discord 告警；v2.7+ 链路哨兵（窗口活着但 channel-server 掉线 >5min → 修复按钮）；v2.14+ 告警同时推 `session_anomaly(kind=link_down)`，web 端也看得到
    sessions-inventory.ts v2.7+ 机器级中立会话清单：`claude agents --json` + jobs 状态 + registry 对账 → 分身检测
    session-reconciler.ts v2.7+ 每 10 分钟后台对账：发现新分身 → Discord 告警带清理/收编按钮 + session_anomaly 事件
    bg-activity-watcher.ts v2.8+ 后台活动追踪：按 agent 会话发现 subagent jsonl 与后台 shell 输出 → 流进各自的子区（ChatAdapter.provisionThread）+ bg_task_* SSE 事件；v2.14+ Web 来源的回合只发事件不建子区
    archive-sweeper.ts   v2.9+ 每日归档兜底：每 24h 给所有活跃 agent 的会话 jsonl 做快照（幂等 copy-if-larger）——补上崩溃/从未退役这些退役时归档覆盖不到的缺口
  channel-server.ts      每个 session 的 MCP 代理（stdio MCP ↔ Bridge WebSocket）
  manager.ts             Agent 生命周期 + 定时任务 + 版本/更新 CLI（JSON 输出）
  cron.ts                定时任务调度守护进程（launchd 管理）
  launcher.ts            大总管 tmux session 守护（launchd 管理）
  setup.ts               交互式安装向导
  hooks/
    typing-hook.ts       Claude Code Stop/Notification hook → Bridge HTTP 端点
  lib/
    bridge-client.ts     共享 Bridge WebSocket 请求封装
    tmux-helper.ts       共享 tmux 命令封装（tmuxRaw, isIdle, sendLine, …）
    claude-launch.ts     统一 Claude Code 启动命令构造（flags, MCP_NAME, shell 转义）
    config-store.ts      运行期配置 ~/.claude-orchestrator/config.json（自动更新开关、语言）
    skills.ts            SKILL.md 发现——user / plugin / project 三个来源 + 硬编码的原生命令
    jsonl-cost.ts        解析 ~/.claude/projects 的 JSONL → 按模型汇总 token
    peers.ts             peers.json 数据模型（v2.11+ 只剩 HTTP peer）+ 握手串编解码 + 原子写
    principals.ts        v2.6.0+ API token 身份/scope/限流（~/.claude-orchestrator/principals.json）
    doctor.ts            v2.14+ 只读安装体检，`manager.ts doctor` 的实现（运行时/配置/daemon/bridge/MCP/agent）
    link-policy.ts       v2.14+ channel-server 被 bridge 顶替后该重连还是退出——纯函数，有单测
    net-addr.ts          v2.14+ 探测本机对外地址（Tailscale CGNAT 优先，其次 RFC1918），peer 握手 `--url` 的来源
    registry.ts          v2.9+ registry.json 唯一读取器（字段归一含 cwd/dir 兼容）；写入仍只归 manager.ts
    bg-jobs.ts           v2.7+ bg job 清理配方：杀进程 → 等 daemon 静默 → 隔离目录 → respawn 时 roster 根治（v2.9.1：daemon 的 ~/.claude/daemon/roster.json workers 花名册才是 respawn 权威依据 —— 无其他 worker 受累时 kill worker + transient daemon 并删条目）
    session-archive.ts   v2.8+ 会话退役归档：kill/fork 换代/adopt/resume 换 session 时快照 jsonl 到 ~/.claude-orchestrator/archive/<agent>/（对抗 CC cleanupPeriodDays）
    session-history.ts   v2.9+ 只读历史解析：live + 归档 jsonl → 中性分页消息，支撑 GET /api/v1/agents/:name/history
  ansi2html.ts           ANSI 转义码 → 彩色 HTML
  html2png.ts            HTML → PNG（Playwright headless Chromium）
  discord-reply.ts       Bash fallback：通过 Bridge 直接发消息
master/
  CLAUDE.md.template     大总管行为指令模板（setup.ts 渲染）
  CLAUDE.md              渲染后的本地副本（gitignored）
tests/                     24 个文件 368 个用例——只覆盖纯逻辑；bridge.ts 本身没有隔离单测
                           （Discord client + ws + peers.json 耦合太重），那部分靠沙箱会话实测兜底
  agent-stats.test.ts      按 agent 的用量汇总，compact 感知
  ask-user-question.test.ts TUI 里的 AskUserQuestion 识别 + 按键合成
  bg-jobs.test.ts          Claude Code bg job 清理配方（roster 根因修复）
  claude-launch.test.ts    启动 flag 构造：权限模式、effort、模型别名
  cron.test.ts             Cron 解析器 + 调度器
  doctor.test.ts           v2.14+ 安装体检：daemon 退出码判定 + 报告排版
  event-bus.test.ts        v2.6.0+ seq 单调性、每 agent 环形缓冲、订阅者互不影响
  http-peer.test.ts        v2.11+ HTTP peer 握手串编解码 + 回复提取
  jsonl-cost.test.ts       JSONL token 用量汇总
  link-policy.test.ts      v2.14+ channel-server 被顶替后怎么办——「stdio 活着就绝不退出」
  modal-parser.test.ts     tmux modal 识别
  net-addr.test.ts         v2.14+ 对外地址探测：CGNAT/RFC1918 边界、绝不返回回环
  permission-watcher.test.ts 权限弹窗身份识别（去重键）
  principals.test.ts       v2.6.0+ token 签发 / scope / 限流 / 终端授予
  principals-snowflake.test.ts v2.14+ Discord ID 校验——占位符变成 principals.json 里
                           永久假 owner 的链路上唯一的把关点
  registry.test.ts         v2.9+ registry 字段归一（cwd/dir 兼容）
  router.test.ts           v2.0.0+ Envelope / Endpoint / parseAddress / makeResponseEnvelope
  session-archive.test.ts  v2.8+ copy-if-larger 快照语义
  session-history.test.ts  v2.9+ jsonl → 中立消息：reply 提取、meta 过滤、翻页
  sessions-inventory.test.ts v2.7+ 分身检测 / 会话对账
  skills.test.ts           SKILL.md 发现
  slash-registry.test.ts   slash 命令注册表的按频道解析
  stats-resets.test.ts     用量窗口重置检测
  web-gateway.test.ts      v2.13+ ws 控制面的跨源判定（drive-by RCE 防护）
install.sh               一键安装脚本
SETUP.md / SETUP.zh-CN.md    面向用户的安装指南
```

## 功能

- **多 agent 编排** — 创建、恢复、销毁、重启、列表、浏览历史。
- **多前端 API（v2.6.0+）** — 核心与 Discord 解耦（设计文档 `docs/design-multi-frontend.md`）：`GET /events` SSE 实时事件流（断线补发）、`POST /api/v1/agents/:name/messages` token 鉴权入站消息（同步 wait / multipart 传文件 / 轮询兜底）。token 按 agent 圈定 scope（`token-add <名> --agents a,b`，未标 `--external` 的 agent 需 `--force`），API 对话默认镜像回 Discord 频道供审计。接 Telegram 等新前端 = 实现一个 ChatAdapter，核心零改动。Bridge 默认只绑 `127.0.0.1`（`BRIDGE_BIND` 放开）。
- **Claude Code agents 模式集成（v2.7+）** — CC 2.1.x 的 bg agent 体系（daemon、respawn、← 键 agents 视图）与 tmux 前台模型互相打架：误按 ← 会把前台会话 fork 成 bg 分身、静默炸断 Discord 链路（2026-07-09 事故）。适配三层：**可见性** —— `SessionsInventory` 聚合 `claude agents --json` + jobs state + registry 对账成中性会话清单（分身检测），Discord `/agents` 面板（详情/收编/清理按钮，LLM-free）、`GET /api/v1/sessions`、`POST /api/v1/sessions/:id/cleanup|adopt`（全权 token，202 + `session_anomaly` SSE 事件）三端共用；**自愈** —— `restart` 撞「running as a background agent」自动改 `--fork-session` 重试并探测新 session id 回写 registry，`adopt <名> <sessionId>` 收编分身，`resume --fork` 收编野生会话；**守护** —— permission-watcher 秒级自动 Esc 逃逸 agents 视图、wedge-watcher 链路哨兵（窗口活着但 channel-server 掉线 >5min → 修复按钮）、10 分钟对账器发现新分身即告警带处置按钮。清理配方（`lib/bg-jobs.ts`，事故实证）：杀 bg 进程（绝不杀 `--fork-session` 正主）→ 等 daemon 静默 → 隔离 job 目录 → 顽固 respawn 检测转官方 TUI。
- **bg 活动子区（v2.8+）** — agent 的后台工作各开一个子会话，不污染主频道。`bridge/bg-activity-watcher.ts` 轮询每个注册 agent 的 session，发现两类活动：**subagent**（`~/.claude/projects/<slug>/<sessionId>/subagents/agent-*.jsonl`，与主会话同格式）和**后台 shell 任务**（`/tmp/claude-<uid>/<slug>/<sessionId>/tasks/*.output`）。新文件出现 → `ChatAdapter.provisionThread` 在 agent 频道下开子区（Discord thread，将来 Telegram topic），工具调用/文本/shell 输出以 2.5s debounce 流入；3 分钟无增长 → 发结束总结 + 归档子区。生命周期同步 SSE（`bg_task_started/update/completed`），web 前端可脱离 Discord 渲染每任务进度线。重启安全：首轮 poll 只记 baseline 不重播存量。**会话归档**（`lib/session-archive.ts`）：session 退役（kill / fork 换代 / adopt / resume 替换 / 手动 `manager.ts archive <name>`）即快照 jsonl（含 subagents）到 `~/.claude-orchestrator/archive/<agent>/` —— CC 的 `cleanupPeriodDays` 会清源文件，归档才是聊天历史的持久层。只在源更大时覆盖；对话内容留在文件里，不入库（owner 2026-07-10 拍板的存储设计）。v2.9+ 增加每日兜底扫描（`bridge/archive-sweeper.ts`）：每 24h 对所有 active agent 补一次快照，长寿命从不退役的 session 也有归档。SSE `bg_task_*` 事件携带稳定 `id`（文件 basename：subagent id / shell taskId），不外泄服务器路径。
- **只读历史 API（v2.9+）** — 归档的 web UI 侧出口：`GET /api/v1/agents/:name/history` 列 agent 的全部 session（live + 归档合并，live 更大时优先），`GET /api/v1/agents/:name/history/:sessionId` 返回中性分页消息（`?limit=100&before=<seq>` 像聊天视图一样往前翻页；`?subagent=agent-xxx` 读 subagent 对话）。解析在 `lib/session-history.ts`（纯函数，有单测）：user/assistant/compact 边界条目 → `{seq, ts, role, text, tools[], compactSummary?}`，meta 条目和 tool_result 载荷被过滤，工具调用经 jsonl-watcher 的 `formatTool` 渲染。token scope 规则与 messages 端点一致；agent 被 kill 后归档仍可读（这正是归档的意义）。sessionId/subagent 参数拼路径前做白名单校验。
- **Agent 间通信** — `send_to_agent(target, text)` MCP 工具通过 Bridge 直接向另一个 agent 的上下文注入消息。
- **定时任务** — cron 表达式拉起临时 agent、执行 prompt、汇报、清理。
- **Discord UI** — 按钮、下拉菜单、slash 命令（`/status`、`/screenshot`、`/interrupt`、`/cron`）。
- **`reply()` 的交互组件** — 按钮行、单选下拉，以及 v2.14+ 的 `multiselect`：勾若干项一次提交。Discord 用原生 `max_values`（选完即交），web 端渲染成 checkbox + 提交按钮。两端回投同一种格式 `[select:<id>:<v1>,<v2>]`（值逗号分隔），agent 侧一套解析吃两端。选项之间不互斥时优先用多选，一个来回胜过好几轮。
- **链路掉线告警（v2.14+）** — `wedge-watcher` 的 link sentinel（tmux 窗口活着但 channel-server 掉线 >5min）除了发 Discord 频道，也推 `session_anomaly(kind=link_down)` 事件，web 端渲染成醒目提示。此前这条只发 Discord，而 web 用户在 MCP 断开时得不到任何信号。
- **管理按钮跳过 LLM** — 状态、监工、销毁、重启、定时任务按钮由 Bridge 直接执行，零 token 成本、瞬间响应。
- **流式 tool 输出** — jsonl-watcher 近乎实时地把 `Read · Edit · Write · Bash · Grep` 推到 Discord。
- **终端截图** — ANSI 转 PNG 流水线，屏幕锁定也能看。
- **一键打断** — Discord 按钮向目标 agent 的 tmux window 发 `Ctrl+C`。
- **精确空闲检测** — Claude Code `Stop` / `Notification` hooks 精确驱动 Discord typing indicator；30 分钟安全超时兜底。
- **大总管守护** — launchd 管理的 launcher 保持大总管 tmux session 存活，自动处理 Claude Code 确认弹窗。
- **防手滑护栏（不是安全边界）** — 每个 spawn 的 agent 都带 `--disallowedTools` 黑名单（`rm -rf`、`git push --force`、`git reset --hard`、`chmod 777`、fork bomb）。规则是**对命令字符串做前缀匹配**，等价写法（`/bin/rm -rf`、`rm -fr`、`find … -delete`、`python -c`、变量拼接）都能绕过，且没有 `PreToolUse` 钩子兜底。加上 `DEFAULT_PERMISSION_MODE` 就是 `bypassPermissions`（见 `lib/claude-launch.ts`），每个 agent 实质上是一个以用户身份运行的无限制 shell —— 黑名单只防意外，挡不住任何有意为之的 prompt。

### 跨 Claudestra peer 协作

其他跑同一套 upstream 的 Claudestra 实例之间可以共享各自的专精 agent，不用彼此开 SSH / 文件系统权限。

**HTTP peers（v2.11+，唯一跨实例通道）** — peer 之间互为 API 客户端：双方各给对方签一个限定 scope 的 Bearer token（`Principal.peer` 标记），`send_to_agent("<agent>@<peer>")` 直接 POST 对方 bridge 的 `/api/v1/agents/:name/messages`（带 `wait`，超时回落 thread 轮询 30s × 10min）。入站复用现有多前端 API（scope 403 / mirror / history 全部生效）；注入头渲染成 🤝 peer 请求，peer 入站不抢占正在跑的回合、不走 slash 透传。对方回复以合成消息 push 回 caller（与本地 `send_to_agent` 同一套 UX）；所有失败（网络 / 鉴权 / 离线 / 超时）都会报告给 caller，绝不静默。开放 = token scope；撤销 = `peer-http-remove`（token 即刻失效）。状态存 `peers.json` 的 `httpPeers[]`（0600、原子写）。老的 Discord peer 机制（共享交换频道、exposure、bot 互 @ 路由）已在 v2.11 移除。v2.11.1+ 增加管理面：`GET /api/v1/peers`（清单 + 入站 scope + 本地 agent 表）、`POST /api/v1/peers/{invite,join,accept}`（握手）、`POST /api/v1/peers/:name/{test,scope,remove}` —— 全部仅限全权 token，mutation 委托 `runManager`，CLI 的 R1 校验保持唯一裁判。Web 端渲染为「设置 → Peer 协作」（scope 编辑、连通测试、三步握手全 UI 化）。

## 运行时命令

```bash
# 首次部署：收集 Discord 配置、写 .env、渲染 master/CLAUDE.md
bun run setup

# 启动全部（bridge + launcher + cron-scheduler）
bun src/manager.ts install-cli   # 写入并加载 3 个 launchd daemon

# Agent 生命周期
bun src/manager.ts create   <name> <dir> [purpose]
bun src/manager.ts resume   <name> <sessionId> [dir] [--fork]  # --fork: 分支副本收编野生/被占用会话
bun src/manager.ts adopt    <name> <sessionId>   # 把 bg 分身收编为正式会话并重启
bun src/manager.ts archive  <name>               # 立即快照该 agent 当前 session 的对话 jsonl 到归档
bun src/manager.ts kill     <name>
bun src/manager.ts restart  [name]
bun src/manager.ts list
bun src/manager.ts sessions [search]

# 定时任务
bun src/manager.ts cron-add     <name> "<cron>" <dir> <prompt...>
bun src/manager.ts cron-list
bun src/manager.ts cron-remove  <name|id>
bun src/manager.ts cron-toggle  <name|id>
bun src/manager.ts cron-history [name|id]

# 跨 Claudestra peer 协作 — v2.11+ HTTP peers（不依赖 Discord，直接走 /api/v1；
# 三步握手，串通过任意私密渠道传递。设计见 docs/design-http-peers.md）
bun src/manager.ts peer-http-invite <name> --agents <a,b> [--url <我方bridge地址>] [--force] [--rotate]  # A: 打印邀请串（--url 不给则自动探测：Tailscale 优先，其次内网）
bun src/manager.ts peer-http-join <name> '<邀请串>' --agents <x,y> --url <我方地址> [--force]           # B: 存下 A 并打印回执
bun src/manager.ts peer-http-accept <name> '<回执串>'                                                  # A: 完成握手
bun src/manager.ts peer-http-test <name>          # GET 对方 /agents — 验证连通 + scope
bun src/manager.ts peer-http-list                 # 列 HTTP peers + 握手状态
bun src/manager.ts peer-http-scope <name> --agents <a,b|*> [--force]  # v2.11.1+: 原地改入站 scope（token 不变，立即生效）
bun src/manager.ts peer-http-remove <name>        # 删 peer + 撤销我方签发的 token
# send_to_agent 的 target 语法："<agent>@<peer>" 或 "peer:<peer>.<agent>"

# 体检（只读；出问题时第一个该跑的）
bun src/manager.ts doctor [--json]

# 版本
bun src/manager.ts version   # 当前版本 + 是否有更新
bun src/manager.ts update    # git pull + 重载 3 个 launchd daemon

# 自动更新开关（两者默认开；launcher 定期轮询，只在所有 agent 空闲时才升级）
bun src/manager.ts auto-update status
bun src/manager.ts auto-update claudestra on|off   # Claudestra 自更新（30 分钟轮询）
bun src/manager.ts auto-update claude on|off       # Claude Code CLI（每周轮询）

# 多前端 API token（v2.6.0+；scope = 按 agent 的白名单，"*" = 除 master 外全部）
bun src/manager.ts token-add <name> --agents <a,b|*> [--force] [--no-mirror] [--terminal]  # --terminal = 远程终端(宿主 shell 级)独立授予
bun src/manager.ts token-list
bun src/manager.ts token-revoke <tokenId|name>
bun src/manager.ts create <name> <dir> --external   # 标记 agent 可安全对外（R1 守卫）

# token 用量统计（解析 ~/.claude/projects/<slug>/<sessionId>.jsonl）
bun src/manager.ts cost [--agent <name>] [--today|--week]

# 测试
bun test
```

## 环境变量

| 变量 | 用途 |
|------|------|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_GUILD_ID` | Discord 服务器（guild）ID |
| `ALLOWED_USER_IDS` | 允许与 bot 对话的 Discord 用户 ID（逗号分隔） |
| `CONTROL_CHANNEL_ID` | 大总管的控制频道 ID |
| `BRIDGE_PORT` | WebSocket 端口（默认 `3847`） |
| `MCP_NAME` | `claude mcp add` 时用的 MCP server 名称（默认 `claudestra`） |
| `USER_NAME` | 大总管在回复里对操作者的称呼 |
| `BRIDGE_URL` | channel-server 的 WebSocket 目标地址（可选覆盖） |
| `MASTER_DIR` | 大总管 tmux session 的工作目录（可选覆盖） |
| `BRIDGE_BIND` | HTTP/ws 绑定地址（默认 `127.0.0.1`；`0.0.0.0` 对外开放，反代/TLS 自理） |
| `BRIDGE_CORS_ORIGIN` | v2.10+ CORS 白名单：逗号分隔 origin 或 `*`（默认不设 = 不发 CORS 头） |
| `BRIDGE_STATIC_DIR` | v2.10+ bridge 直接托管的静态目录（含 SPA fallback；默认不设 = 关闭） |

## tmux 拓扑

每个 agent 是同一个 `master` session 里的一个 **window**。这样 `tmux -CC attach` 可以把每个 agent 展示成 iTerm2 的原生 tab。

```
master (session, 私有 socket: /tmp/claude-orchestrator/master.sock)
  ├── window 0: 大总管
  ├── worker-alpha
  ├── worker-bravo
  └── worker-...
```

本地 attach：

```bash
tmux -S /tmp/claude-orchestrator/master.sock -CC attach
```

## 关键不变量

- 大总管是 `master` tmux session 的 window 0。`com.claudestra.launcher` 这个 launchd agent 保证它存在且正在运行 Claude Code。
- 每个 agent 的 Discord channel ID 记录在 `~/.claude-orchestrator/registry.json` 里。Bridge 用这个 registry 把入站的 Discord 消息路由到对应的 channel-server。
- MCP server 名（`MCP_NAME`）必须在三处保持一致：`claude mcp add`、channel-server 注册、jsonl-watcher 的 tool 过滤前缀。它集中在 `src/bridge/config.ts` 和 `src/lib/claude-launch.ts`。
- Agent 名字在 create/resume 时走 shell 元字符黑名单校验，在 kill/restart 时宽松归一，以兼容历史 CJK 命名的 worker。
- Tool call 展示通过 `WATCHER_CONFIG.debounceMs`（默认 1500ms）去抖，避免在 tool 爆发时触发 Discord 限流。
- **`channel-server` 生命周期（v2.14+）**：一切都由一条约束推导——**channel-server 没有守护者**，Claude Code 既不会 respawn 死掉的 stdio MCP server，也不会自动重连，所以它一旦退出就是该 agent 永久失联。两条规则：（1）**握手之后才注册**。`mcp.oninitialized` 是连 bridge 的闸门，野进程光把 `channel-server.ts` 跑起来抢不到频道——这很要紧，因为 `DISCORD_CHANNEL_ID` 由 Claude Code 注入并被**所有 Bash 子进程继承**，在 agent 自己的仓库里手滑跑一次就会顶掉正在服务的连接。留了 30s 兜底，SDK 不回调也照常注册。（2）**被顶替不等于该死**。收到 `replaced` / `close(4001)` 时看 stdio 还在不在：Claude Code 仍在用本进程就退避重连、把频道拿回来（3s→60s，且计数要稳定持有 30s 才归零，两个活实例只会退化成慢速轮换，不会 3 秒一轮互抢）；只有 `mcp.onclose` 才是正当退出。判定逻辑独立在 `lib/link-policy.ts` 并有单测。`code 1000`（bridge 重启）仍按瞬断处理 → 指数退避重连。

## 贡献提示

- **发布流程**：commit 和 `git push` 到 `main` 可以自主执行。`git tag v*` + `gh release create` **每次都必须先获得 owner 明确同意** — 不要自己主动发 release。GitHub 上只保留最新一个 release，之前版本视为不兼容会被删除。
- `tmux-helper.ts` 和 `claude-launch.ts` 是 tmux 命令和 Claude Code 启动参数的**唯一权威位置**。新文件里不要再内联这些。
- 需要绕过 LLM 的管理按钮放到 `bridge/management.ts`。把 `id` 同时加到 `handleMgmtButton` 和对应的面板构造器。
- 提交前跑 `bun run check`（= `tsc --noEmit` + `bun test`）。**`bun build` 不做类型检查** —— 它对 `const x: number = "str"` 直接放行，此前"用它快速抓类型错误"的说法是错的。每个入口仍要 `bun build src/<entry>.ts --target=bun` 跑一遍（`bridge`、`channel-server`、`manager`、`launcher`、`cron`、`setup`），它能抓到类型检查覆盖不到的模块解析错误。CI 在每次 push / PR 上跑这三件事。
- Cron 测试套件覆盖解析器和下次触发时间计算，但不跑真实 agent——集成测试在 sandbox Discord server 里手动做。
