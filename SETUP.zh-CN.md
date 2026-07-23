# 安装指南

[English](./SETUP.md) · **简体中文**

**最短路径：跑 `bun run setup`**。交互式向导会一步一步带你走完所有步骤，每一步都把指引内嵌在终端里——你根本不需要读这个文档。

本文档的存在意义：

- 向导报错时查问题。
- 了解向导在幕后做了什么。
- 偏好手动配置的人用作参考。

> **两个前门。** 本指南装的是 **Discord** 前端。v2.10 起还有一个 **Web 客户端**——
> 可安装到手机主屏的 PWA（Next.js），带流式聊天、实时远程终端、聊天记录搜索。
> 它可以和 Discord **并存**，也可以**完全替代** Discord（Web-only 模式，不需要
> bot token）。见 **[web/SETUP.md](./web/SETUP.md)**，里面有「Access from your
> phone」一章（Tailscale 远程访问 / PWA 安装）。

---

## 快速开始

```bash
# 1. 装前置工具（已有的跳过）
brew install tmux                             # macOS
curl -fsSL https://bun.sh/install | bash      # Bun
npm install -g pm2                            # pm2
npm install -g @anthropic-ai/claude-code      # Claude Code 2.1.80+

# 2. Clone 代码，跑向导
curl -fsSL https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh | bash
cd ~/repos/claudestra
bun run setup
```

> **提示：** `raw.githubusercontent.com` 有 ~5 分钟缓存。刚发完新版本立即拉安装脚本，建议带个时间戳绕过 CDN 缓存：
>
> ```bash
> curl -fsSL "https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh?t=$(date +%s)" | bash
> ```

就这样。向导负责剩下的一切：检查依赖、带你创建 Discord bot（内嵌链接 + 一步一步说点哪里）、收集所有需要的 ID、写 `.env`、渲染 `master/CLAUDE.md`、注册 MCP、启动 pm2。

### 跨 Claudestra 协作（v2.11+ HTTP peer）

两个 Claudestra 实例共享专精 agent，不需要共享 Discord 服务器、不需要第二个 bot、更不用给对方文件系统 / SSH 权限 —— peer 之间就是互为 API 客户端：各自持有对方签发的、按 agent 圈定 scope 的 Bearer token。握手三步 CLI 完成，邀请串 / 回执串走任意私聊渠道（DM、Signal 都行）：

1. **A 发起邀请**：`bun src/manager.ts peer-http-invite <peer> --agents <a,b> --url <A方bridge地址>`，打印邀请串（A 的地址 + 现签的、scope 限定在所列 agent 的 token）。把串发给 B。
2. **B 加入**：`bun src/manager.ts peer-http-join <peer> '<邀请串>' --agents <x,y> --url <B方bridge地址>`，把 A 存为 peer 并打印带 B 侧 token 的回执串。把回执发回 A。
3. **A 确认**：`bun src/manager.ts peer-http-accept <peer> '<回执串>'` —— 握手完成。双方各跑一次 `bun src/manager.ts peer-http-test <peer>` 验证连通 + 看对方开放了哪些 agent。

之后任何 agent 都能 `send_to_agent({ target: "<agent>@<peer>", text: "..." })` 跨机调用 —— bridge 直接 POST 对方的 `/api/v1` 消息端点，对方回复自动 push 回调用方，不用轮询。`peer-http-list` 看 peer 列表 + 握手状态；`peer-http-remove <peer>` 删 peer + 撤销你签出的 token，访问即时切断。

注意事项：

- **token scope 就是权限模型**：只有 `--agents` 里列出的 agent 可被调用，越界一律 403。之后想改开放范围，带 `--rotate` 重新握手。
- **非 external agent 要 `--force`**：给不是 `--external` 创建的 agent 签 token 需要加 `--force` —— 和你自己对话共享上下文的 agent 不该随手暴露（R1 守卫）。
- **传输建议**：`--url` 优先走 Tailscale / 内网；要过公网必须给 bridge 套 HTTPS 反代（口径同 `BRIDGE_BIND` 文档）。

### 装完有什么

- **多 agent 编排** — `#control` 里的大总管给每个 agent 开独立 Discord 频道、路由消息、挂截图、处理打断。
- **自动更新** — Claudestra 自身每 30 分钟查一次 release；Claude Code CLI 每 7 天查一次。两个都用 `bun src/manager.ts auto-update <target> on|off` 切换。
- **Discord slash 自动补全** — `~/.claude/skills/` 的 user skill、已装插件、每个 agent 的项目级 `<cwd>/.claude/skills/`、以及精选的 Claude Code 内置命令（`/cost` `/context` `/compact` `/mcp` `/review` …）都会注册成 Discord slash 命令，每 30min 自动重扫。
- **TUI modal 适配** — 数字菜单（`/model`）和水平滑杆（`/effort`）转成 Discord 按钮；bridge 处理不了的 modal 点 🤖 升级到大总管处理。
- **Cron 定时任务** — `cron-add` / `cron-list` / `cron-history`；临时起 agent 跑 prompt 报告再销毁。
- **Wedge 检测** — agent 的 tmux pane 30+ 分钟没变化且没 idle → @你 + 一键 Esc / Ctrl+C 救回按钮。
- **`manager.ts cost` + `metrics`** — 从 JSONL 汇总 token 消耗 + bridge 事件日志聚合。
- **新消息自动打断** — 你在 Discord 发新消息时，如果 agent 正在干活，bridge 自动 Ctrl+C 让新消息覆盖当前任务。
- **多前端 API（v2.6+）** — Bearer token 鉴权的 HTTP API（`/api/v1` + SSE `/events`），任何前端都能接上你的 agent：`bun src/manager.ts token-add <name> --agents <a,b|*>` 签发按 agent 限定范围的 token。下面的 Web 客户端完全建在这套 API 上。
- **Web 客户端（v2.10+）** — 可 PWA 安装的 Next.js 应用：流式聊天（工具卡 + diff 着色）、实时远程终端、聊天记录搜索、Skills 面板、后台任务子会话。安装 + 手机远程访问见 [web/SETUP.md](./web/SETUP.md)。
- **会话归档与历史（v2.8+）** — 每个退役 session 的 JSONL 自动快照到 `~/.claude-orchestrator/archive/`，外加每日全量扫描；聊天记录不再被 Claude Code 的 `cleanupPeriodDays` 清掉，agent 被 kill 之后历史照样可读。
- **后台活动子线程（v2.8+）** — subagent 和后台 shell 任务各开一条 Discord thread 流式输出（完成后自动归档），不再刷爆 agent 主频道。
- **Claude Code agents-mode 防护（v2.7+）** — 检测并自愈 Claude Code 后台 agent 守护进程造出的「分身」session（← 键误触陷阱）：`/agents` 清单面板、一键收编/清理、restart 自动 `--fork-session` 重试。

---

## 向导到底做了什么

`bun run setup` 分 8 个带编号的步骤：

1. **检查系统依赖** — 确认 `git` / `tmux` / `bun` / `pm2` / `claude` 都装了，缺的给出安装命令。
2. **创建 Discord 应用** — 打开 Developer Portal，告诉你点哪个按钮。
3. **获取 Bot Token** — 让你 Reset Token 并粘贴，校验格式。
4. **开启 Privileged Intents** — 提醒你必须打开的三个 intent（少一个 bot 就静默丢消息）。
5. **邀请 Bot** — 带你走 OAuth2 URL Generator，告诉你精确的 scope 和 permission。
6. **收集 Discord ID** — 打开开发者模式，依次问 Guild ID / User ID / 控制频道 ID，每个都校验是 17-20 位 snowflake。
7. **个人偏好** — 你的称呼、MCP 服务名（默认 `claudestra`）、Bridge 端口（默认 `3847`）。
8. **收尾** — 写 `.env`、渲染 `master/CLAUDE.md`，然后可选地自动跑 `bun install` + `playwright install` + `claude mcp add` + `pm2 start`。

向导跑完后，打开 Discord 在控制频道随便说句话，大总管几秒内就会回。

---

## 配置参考

向导会写入 `.env`，包含 7 个变量：

| 变量 | 用途 |
|------|------|
| `DISCORD_BOT_TOKEN` | Developer Portal 上拿到的 bot token |
| `DISCORD_GUILD_ID` | 你的 Discord 服务器（guild）ID |
| `ALLOWED_USER_IDS` | 允许跟 bot 对话的 Discord 用户 ID（逗号分隔） |
| `CONTROL_CHANNEL_ID` | 大总管的控制频道 ID |
| `BRIDGE_PORT` | WebSocket 端口（默认 `3847`） |
| `USER_NAME` | 大总管在回复里怎么叫你 |
| `MCP_NAME` | `claude mcp add` 用的 MCP 服务名（默认 `claudestra`） |

直接改 `.env` 然后 `pm2 restart discord-bridge` 就能生效。

运行时开关存在另一个文件 —— `~/.claude-orchestrator/config.json`，通过 `bun src/manager.ts auto-update ...` 管理：

```bash
bun src/manager.ts auto-update status              # 看当前状态
bun src/manager.ts auto-update claudestra on|off   # 本项目自动更新（30 分钟轮询）
bun src/manager.ts auto-update claude on|off       # Claude Code CLI 自动更新（周轮询）
```

两个默认都是 `on`。配置文件在首次写入时懒创建，不需要手动初始化。

---

## 手动安装（不用向导）

如果你真的想跳过向导：

```bash
git clone https://github.com/shawnlu96/claudestra.git ~/repos/claudestra
cd ~/repos/claudestra
bun install
npx playwright install chromium

cp .env.example .env
# 编辑 .env，填 7 个变量

sed "s/{{USER_NAME}}/你的名字/g" master/CLAUDE.md.template > master/CLAUDE.md

claude mcp add claudestra -s user -- bun run $(pwd)/src/channel-server.ts

pm2 start ecosystem.config.cjs
pm2 save
```

---

## 升级

默认情况下 Claudestra 和 Claude Code 都会后台自动升级，你什么都不用做。Claudestra 每 30 分钟查一次，Claude Code 每周一次，只有在所有 agent 空闲时才会真正升级。升级前后 `#control` 频道 @ 你一次。

**想关闭自动升级：**

```bash
bun src/manager.ts auto-update claudestra off   # 停止本项目自动升级
bun src/manager.ts auto-update claude off       # 停止 Claude Code CLI 自动升级
```

**想手动触发升级：**

从 Discord 让大总管升：

> 检查一下有没有更新

或者

> 升级一下代码

执行：

```bash
bun src/manager.ts version   # 看状态
bun src/manager.ts update    # git pull + pm2 restart
```

手动的话：

```bash
cd ~/repos/claudestra
git pull
pm2 restart ecosystem.config.cjs
```

---

## 卸载

```bash
pm2 delete discord-bridge master-launcher cron-scheduler
claude mcp remove claudestra -s user
trash ~/repos/claudestra ~/.claude-orchestrator /tmp/claude-orchestrator
```

`~/.claude-orchestrator` 目录里有 registry、config（自动更新开关）、cron 任务、metrics 日志 —— 删掉它就清空所有运行时状态。如果你只想暂停 bot 而不丢状态，就只 `pm2 stop` 不跑 `trash` 那行。

从 Discord 移除 bot：服务器成员列表 → 右键 bot → 踢出。要彻底删除 bot，去 Developer Portal 把 application 删掉。

---

## 疑难排查

### 向导找不到 `master/CLAUDE.md.template`

在仓库目录里跑：`cd ~/repos/claudestra && bun run setup`。

### Bot 在线但不回消息

检查 **Privileged Intents**。三个必须全部在 Developer Portal 开启。少一个 Discord 就会静默丢弃 bot 无权接收的事件。

```bash
pm2 logs discord-bridge --lines 50
```

没有 "received message" 日志 = intent 问题。

### Bot 响应按钮但不响应文字

你的 user ID 很可能不在 `ALLOWED_USER_IDS` 里。重跑 `bun run setup` 或直接改 `.env`，然后 `pm2 restart discord-bridge`。

### 大总管一直不上线

```bash
pm2 logs master-launcher --lines 50
```

常见原因：

- Claude Code 登录过期 → 在终端跑一次 `claude` 重新登录。
- MCP server 没注册 → 重跑 `bun run setup` 或手动 `claude mcp add`。
- `master/CLAUDE.md` 缺失 → 重跑 `bun run setup`。

### Bridge 一直重启

```bash
pm2 logs discord-bridge --err --lines 100
```

通常是 bot token 错了或 `.env` 有错字。去 Developer Portal 重新生成 token，重跑 `bun run setup`。

### Slash 命令缺失或过期

Discord 每个客户端缓存 slash 命令最多 1 小时。如果你刚装了 Claude Code 插件或在 `~/.claude/skills/` 里写了新 skill，Discord 自动补全里没出现：

1. 等最多 30min（bridge 自动重扫并重新注册）**或** `pm2 restart discord-bridge` 立即强制重扫
2. 然后重启 Discord 手机/桌面 App 清客户端缓存

Claudestra 升级后 Discord 里命令列表还是老的 —— 同样处理。

---

## 关键路径

| 路径 | 内容 |
|------|------|
| `~/repos/claudestra` | 源码（或 clone 的位置） |
| `~/repos/claudestra/.env` | 运行时配置（git 忽略） |
| `~/repos/claudestra/master/CLAUDE.md` | 渲染后的大总管指令（git 忽略） |
| `~/.claude-orchestrator/registry.json` | 活跃 agent 注册表 |
| `~/.claude-orchestrator/config.json` | 自动更新开关（首次 `auto-update` 调用时懒创建） |
| `~/.claude-orchestrator/cron.json` | 定时任务 |
| `~/.claude-orchestrator/cron-history.json` | 最近执行记录 |
| `~/.claude-orchestrator/metrics.jsonl` | Bridge 事件日志，`manager.ts metrics` 的数据源 |
| `/tmp/claude-orchestrator/master.sock` | 私有 tmux socket |
| `~/.claude/projects/` | Claude Code session JSONL 文件（`manager.ts cost` 的数据源） |

---

## 接下来

- **装 Web 客户端** — [web/SETUP.md](./web/SETUP.md)：PWA 聊天 + 实时终端 + 记录搜索，以及在家庭网络之外用手机访问的方案（推荐 Tailscale）；另含生产部署：launchd 常驻、HTTPS 终结（tailscale serve 或 Caddy + `tailscale cert`）、证书续期与完整端口清单。
- 读 [CLAUDE.zh-CN.md](./CLAUDE.zh-CN.md) 了解架构（给贡献者和 agent 看的）。
- 试试 `send_to_agent` MCP 工具搭建多 agent 协作流。
- 建个每天早上跑的定时任务，让它汇报到控制频道。
