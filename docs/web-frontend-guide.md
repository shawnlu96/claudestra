# Claudestra Web 前端接入指南

> [English](./web-frontend-guide.en.md) · **简体中文**

> 写给接手 Web UI 的开发者。目标：不用读完整个 codebase，就能把一个网页版控制台跑起来。
> 有问题让 owner 拉你进他的 Claudestra Discord 服务器，在 #agent-claudestra 频道直接问（那是一个常驻的 Claude 开发 agent，本文档也是它写的，它对 bridge 侧代码全知）。

## 0. 一句话背景

Claudestra 是一个多 Claude Code 会话编排器：一个 Bridge 进程管着 N 个跑在 tmux 里的 Claude Code 会话，目前唯一的前端是 Discord。从 v2.6 起核心已与 Discord 解耦，v2.8–v2.9 把数据面（实时事件流、历史对话、用量统计）全部铺好了 —— **Web UI 是这些铺垫的收口**。你不需要碰 tmux / Discord / MCP 的任何细节，只和 Bridge 的 HTTP API 打交道。

## 1. 必读材料（按顺序，约 1 小时）

1. **`CLAUDE.md`**（根目录，英文；`CLAUDE.zh-CN.md` 中文版）— 架构总览。重点读：System overview、Features 里的 "Multi-frontend API"、"Background-activity threads"、"Read-only history API" 三段。
2. **`docs/design-multi-frontend.md`** — 多前端架构的设计决策（为什么是 SSE + 只读历史 API 而不是数据库；NeutralMessage 冻结合同）。
3. **GitHub Release notes**：[v2.7.0](https://github.com/shawnlu96/claudestra/releases/tag/v2.7.0)（多前端 API 首发 + agents 模式适配）、[v2.9.0](https://github.com/shawnlu96/claudestra/releases/tag/v2.9.0)（历史 API + 归档）、v2.9.1（修复批）。
4. **git log** — 想深挖某个端点的来龙去脉时：`git log --oneline --grep="api\|history\|event" -20`，commit message 里写了每次改动的动机（中文）。
5. 代码里的权威定义（要看数据结构时直接读这三个文件，都有注释）：
   - `src/bridge/event-bus.ts` — SSE 事件类型与字段
   - `src/lib/session-history.ts` — 历史消息结构与分页语义
   - `src/lib/agent-stats.ts` — 用量/上下文统计结构

## 2. 架构 30 秒版

```
浏览器 (你要做的)
   │  HTTP / SSE
   ▼
Bridge  (bun, 默认 127.0.0.1:3847)     ← 你唯一的后端
   │
   ├─ tmux 里的 N 个 Claude Code 会话（每个 = 一个 "agent"）
   ├─ ~/.claude/projects/**.jsonl       ← 对话的权威源（Claude Code 自己写）
   └─ ~/.claude-orchestrator/archive/   ← 退役会话的归档快照（bridge 维护）
```

存储设计（owner 拍板，别提议加数据库）：**对话内容不入库**，Claude Code 写的 jsonl 文件是权威源；实时走 SSE，历史走只读 API 现场解析文件。

## 3. 鉴权模型

- 所有 `/api/v1/*` 端点走 Bearer token：`Authorization: Bearer <secret>`。
- Token 由 CLI 签发（目前没有管理 UI）：
  ```bash
  bun src/manager.ts token-add web-ui --agents '*'        # 全部非 master agent
  bun src/manager.ts token-add limited --agents alpha,bravo
  bun src/manager.ts token-list / token-revoke <name>
  ```
- **Scope**：token 带 per-agent 白名单，`*` = 全部。scope 外的 agent 一律 403。agent 名双向兼容（`worker` 和 `agent-worker` 等价）。
- 限流：120 req/min per token（60s 滑动窗口，源码硬编码，无 env 开关；SSE 长连接只在建连时算一次）。
- **Mirror**：通过 API 发给 agent 的消息，默认会镜像一份到该 agent 的 Discord 频道（审计用）。`token-add --no-mirror` 可关。
- 顶层 `/stats` 和 `/events`（不带 `/api/v1` 前缀）是**本机免鉴权版** —— bridge 默认只 bind `127.0.0.1`，信任本机。部署形态见 §7。

## 4. API 全景

Base URL：`http://127.0.0.1:3847`（`BRIDGE_PORT` 可改）。

### 4.1 读

| 端点 | 鉴权 | 用途 |
|---|---|---|
| `GET /stats` | 无（本机） | 全局快照：账号 5h/周 gauge + 每 agent 上下文/今日/本周用量 |
| `GET /api/v1/agents` | Bearer | scope 内 agent 列表（name/status/idle/purpose） |
| `GET /api/v1/agents/:name/history` | Bearer | 该 agent 的 session 清单（live + 归档合并） |
| `GET /api/v1/agents/:name/history/:sessionId` | Bearer | 分页对话消息（见 §6） |
| `GET /api/v1/sessions` | Bearer | 机器级 Claude 会话清单（含分身检测，`kind: interactive/background`） |
| `GET /api/v1/threads/:threadId` | Bearer | 发消息后轮询回复的兜底端点 |
| `GET /api/v1/files/:id` | Bearer | agent 回复里的附件下载（token 属主校验） |

### 4.2 写

| 端点 | 说明 |
|---|---|
| `POST /api/v1/agents/:name/messages` | 给 agent 发消息。JSON `{text, wait}`（wait≤300s 同步等回复）或 multipart（`text` + `files`，≤5 个 ≤10MB）。agent 离线 409；不等或超时 → 202 + `threadId`，用 threads 端点轮询 |
| `POST /api/v1/sessions/:id/cleanup` | 清理 bg 分身（202 后台执行，结果走 SSE `session_anomaly`）。仅全权 token |
| `POST /api/v1/sessions/:id/adopt` | 收编分身为正式会话。仅全权 token |

### 4.3 实时（SSE）

| 端点 | 鉴权 | 差别 |
|---|---|---|
| `GET /events` | 无（本机） | 全量事件 |
| `GET /api/v1/events` | Bearer | 按 token scope 过滤 agent |

- 标准 SSE：`id:` = 单调递增 seq，断线重连带 `Last-Event-ID` 可补发（进程内 ring buffer，bridge 重启后 seq 归零、缓冲清空 —— 前端要能容忍 seq 回退）。
- 事件 JSON：`{seq, ts, agent, chatId, type, data}`。
- `type` 全集（权威定义 `src/bridge/event-bus.ts`）：
  - `tool_start` / `tool_done` — 工具调用（data 含渲染好的摘要文本）
  - `assistant_text` — agent 流出的文本
  - `turn_duration` — 一轮对话耗时
  - `agent_status` — 状态变化（thinking/done 等，做"正在输入"指示）
  - `question` / `auto_deny` / `chat_message` — 权限弹窗、自动拒绝、聊天消息
  - `session_anomaly` — 分身出现/链路掉线/清理收编结果
  - `bg_task_started` / `bg_task_update` / `bg_task_completed` — 后台活动（subagent / bg shell）生命周期，data：`{kind: "subagent"|"shell", id, threadId, title?, lines?, durationMs?}`。`id` 是稳定标识（subagent id / shell taskId），用它做前端任务行的 key

**EventSource 认证（v2.10+ 已解决）**：浏览器原生 `EventSource` 不能带 Authorization header —— 用 `GET /api/v1/events?token=<secret>` 的 query 参数形式（所有 `/api/v1` 端点都接受 `?token=`，header 优先；非 SSE 调用仍建议走 header）。

## 5. /stats 数据结构要点

```jsonc
{
  "global": {
    "sessionPct": 41, "sessionResets": "5pm (Asia/Tokyo)",   // 账号 5h 窗口
    "weekPct": 22,    "weekResets": "Jul 15 at 6am (...)",   // 周窗口
    "scrapedAt": 1783660000000,   // gauge 抓取时刻 —— 渲染时标注年龄，别让用户误以为实时
    "raw": "...(/status 面板原文)..."
  },
  "agents": [{
    "name": "agent-x", "contextTokens": 239000, "contextEstimated": false,
    "model": "claude-fable-5-1",
    "today": {"tokens": 85000000, "requests": 12}, "week": {...}
  }]
}
```

- `contextEstimated: true` = 该 agent 刚 compact 完、还没新对话，上下文是估算值（渲染成 `~239K（刚 compact）`）。
- `sessionResets` 是上游 `/status` 面板原文，**观测过上游把 5pm 印成 5am**。判断可疑的约束：5h 窗口的 reset 必落在 `scrapedAt + 5h` 内。Discord 看板的做法是原样显示 + 超约束时加 ⚠️（不要自作聪明纠正，教训见 commit 7c45f38）。

## 6. 历史 API 详解（对话视图的主数据源）

```
GET /api/v1/agents/:name/history
→ { ok, agent, sessions: [{ sessionId, source: "live"|"archive",
     sizeBytes, mtime, createdAt, subagents: ["agent-xxx", ...] }] }

GET /api/v1/agents/:name/history/:sessionId?limit=100&before=<seq>&subagent=agent-xxx
→ { ok, agent, sessionId, source, messages: [...], total, hasMore }
```

- **分页语义**（聊天视图习惯）：默认返回最尾部 `limit` 条；向上翻页传 `before=<当前页第一条的 seq>`；`hasMore` 指本页之前还有没有。`seq` 是文件内行号，同一 session 内稳定。
- 消息结构：`{seq, ts, role: "user"|"assistant"|"system", text, tools?: [{name, summary}], compactSummary?, model?}`。
  - `role: "system"` 目前只有 compact 分隔线（"上下文已压缩"）—— 渲染成时间线上的分割条。
  - `compactSummary: true` = compact 生成的长摘要，不是真实用户输入 —— 建议默认折叠。
  - `tools[].summary` 是渲染好的一行摘要（如 `Read src/foo.ts`），直接展示即可。
- `source: "archive"` 的 session 属于已退役/已 kill 的会话 —— **照样可读，这正是归档的意义**。live 与归档同 id 并存时返回内容更全的那份。
- `subagents` 数组里的 id 传 `?subagent=` 可看子代理的完整对话（格式与主会话相同）。
- 实时 + 历史的衔接：进入对话视图先拉最后一页历史，再订阅 SSE 增量（`assistant_text` / `tool_*` / `chat_message` 按 `agent` 字段过滤）。两边没有统一的消息 id —— 简单做法是以历史为准、SSE 只做"活动指示"，或按 `ts` 去重。

## 7. 部署开关与已知边界

原「三堵墙」（CORS / EventSource 认证 / 静态托管）v2.10 起已全部拆掉，都是环境变量开关、默认关闭：

1. **CORS** — `BRIDGE_CORS_ORIGIN` 设逗号分隔的 origin 白名单（如 `http://localhost:5173`）或 `*`；不设 = 不发 CORS 头。开发期配你的 dev server origin 即可跨源直连。
2. **EventSource 认证** — `?token=` query 参数（见 §4.3）。
3. **静态托管** — `BRIDGE_STATIC_DIR` 指向前端构建产物目录，bridge 直接 serve（缺失的无扩展名路径回 `index.html`，SPA 路由可用；缺失的资源文件正常 404）。同源部署 = CORS 和 token query 都不再需要。

仍然存在的边界：

4. **Token 管理无 UI** — 签发/吊销只有 CLI。
5. **`BRIDGE_BIND` 默认 127.0.0.1** — 要从别的设备访问，设 `BRIDGE_BIND=0.0.0.0` 并自备反代 + TLS + 鉴权（顶层免鉴权端点会一起暴露，务必只在反代后开）。
6. SSE 无跨重启持久化 — `Last-Event-ID` 只在 bridge 存活期内有效，bridge 重启后 seq 归零，前端要能容忍。

## 8. 建议的 MVP 范围（owner 已认可的方向）

1. **Agent 列表页** — `/api/v1/agents` + `/stats` 合成：名字、状态、idle、上下文占用条、今日用量。
2. **对话视图** — 历史分页（§6）+ SSE 实时流入 + 底部发消息框（`messages` 端点，wait=60 同步等回复）。
3. **后台任务进度线** — `bg_task_*` 事件按 `id` 聚合，渲染每个 subagent / bg shell 的活动行（开始/滚动更新/完成+耗时）。
4. **用量面板** — `/stats` 的 web 版（参考 Discord 看板的呈现：`src/bridge/stats-dashboard.ts` 的 renderEmbed）。

技术栈随意（bridge 不关心）。部署形态最简路径：构建产物指给 `BRIDGE_STATIC_DIR`，bridge 同源直接 serve（零反代零 CORS）；开发期设 `BRIDGE_CORS_ORIGIN=http://localhost:5173` 之类即可跨源连线上 bridge。

## 9. 本地开发环境（自己起一套完整的）

前置清单：

| 依赖 | 说明 |
|---|---|
| macOS / Linux | tmux 依赖，Windows 需 WSL |
| bun、tmux、launchd | 运行时三件套（进程守护走 launchd，非 pm2）|
| Claude Code CLI | **登录你自己的 Claude 订阅账号** —— 本地 agent 的对话烧的是你自己的额度，测试时注意用量（`/stats` 里能看到） |
| 自建 Discord bot + 私人测试服务器 | **硬前置，绕不开**：`manager create` 建 agent 时要通过 bot 建 Discord 频道。建 bot + 拉进自己的测试服约 5 分钟，[SETUP.md](../SETUP.md) 有一步步截图流程 |

```bash
git clone https://github.com/shawnlu96/claudestra && cd claudestra
bun install
bun run setup        # 交互式向导：填 bot token / guild id / 你的 Discord user id
bun src/manager.ts install-cli   # 写入并加载 bridge / launcher / cron 三个 launchd daemon

# 造测试数据：建 1-2 个 agent（随便指个目录），聊几句就有历史/事件了
bun src/manager.ts create web-test ~/tmp/web-test "web UI 测试用"
bun src/manager.ts token-add web-dev --agents '*'
```

说明：bridge 的 HTTP server 启动不等 Discord 连接（`/stats`、历史 API 秒可用），但 bot token 必须有效，agent 生命周期全依赖它。

冒烟测试（对着活 bridge）：

```bash
TOKEN=<secret>
curl -s localhost:3847/stats | jq .global
curl -s -H "Authorization: Bearer $TOKEN" localhost:3847/api/v1/agents | jq
curl -s -H "Authorization: Bearer $TOKEN" "localhost:3847/api/v1/agents/<name>/history" | jq
curl -N localhost:3847/events                     # SSE 裸流
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"ping","wait":60}' localhost:3847/api/v1/agents/<name>/messages | jq
```

## 10. 协作约定

- **Bridge 侧改动（新端点、CORS、query token、静态托管）不要自己动手** —— 到 owner 的 Discord 服 #agent-claudestra 频道描述需求，bridge 侧由驻场 agent 实现并发版（走上游 `bun src/manager.ts update` 你本地就能拉到），通常当天完成。
- API 的**冻结合同**：`/api/v1` 下已有端点的响应字段只增不改不删（additive-only）。发现字段语义不清先问，别猜。
- 前端仓库建议独立开 repo（bridge 不需要和前端同仓库；将来若 bridge 托管静态文件，构建产物路径再约定）。
