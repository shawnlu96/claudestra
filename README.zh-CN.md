# Claudestra

[English](./README.md) · **简体中文**

> 通过 Discord 远程管理本地运行的多个 Claude Code session。

Claudestra 让你在自己的电脑上运行 Claude Code，然后从任何地方（手机、平板、另一台电脑）通过 Discord 指挥它。每个 session 都活在 tmux 里，所以当你回到工位，可以直接 `tmux attach` 继续同一个进程。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-fbf0df.svg)](https://bun.sh)
[![Claude Code](https://img.shields.io/badge/requires-claude--code_2.1.80%2B-d97757.svg)](https://claude.com/claude-code)

---

## 它解决什么问题

Claude Code 是一个只能在终端里用的工具——不在电脑前你就用不了。Claudestra 在你本地的 session 前面搭了一道持久化的 Discord 门，让你可以：

- 从手机上跟任意一个正在运行的 Claude Code session 对话。
- 并行跑多个 session，每个 session 对应一个独立的 Discord 频道。
- 回到工位后 `tmux attach`，直接接入**同一个**进程。
- 实时看到 Claude 在执行的 tool call（Read / Edit / Bash / Grep）。
- 设置定时任务：自动拉起临时 agent 执行 prompt、汇报结果、销毁。

## 工作原理

```
 你的手机 (Discord)
        │
        ▼
 Discord Bot  ──  一个 token，多个频道
        │
        ▼
 Bridge (Bun 进程, pm2 管理)     ws://localhost:3847
        │
        │  WebSocket  ├──  channel-server ◄─► Claude Code (session A)
        │             ├──  channel-server ◄─► Claude Code (session B)
        │             └──  channel-server ◄─► Claude Code (session C)
        │
        │  JSONL watcher
        └──  监听每个 session 文件，把 tool call 推到 Discord

 你的 Mac (iTerm2)
        │  tmux -CC attach
        └──  每个 session 是一个原生 tab
```

Claudestra 基于 Claude Code 的**原生 Channel 协议（MCP）**，不是屏幕抓取。Bridge 进程充当扇出层，把 Discord 消息路由到对应的 `channel-server` 实例，绕过了官方插件"一个 token 只能绑一个 session"的限制。

## 功能

### 核心编排
- **多 agent 管理** — 创建、恢复、销毁、重启、列表、历史会话浏览。
- **Agent 间通信** — `send_to_agent(target, text)` MCP 工具直接把消息注入到另一个 agent 的上下文。
- **定时任务** — 声明式 cron 表达式，自动创建临时 agent、执行 prompt、通知 Discord、清理。
- **跨 Claudestra 协作（v1.8+，v1.9 重新设计）** — 朋友 bot 进来后 bridge 自动建 `#agent-exchange` shared 频道。用 `peer-expose <agent> <peer>` 显式开放指定 agent 给指定 peer。v1.9.21+ `direct` 模式：bridge 把 peer 请求**直接路由到目标 agent，两边 master 都不介入** —— 6 跳压到 2-3 跳。v1.9.22+ 对称路由：你在 `#agent-exchange` `@` peer bot，peer bridge 同样直接路由到他 agent，两个 master 都退出 happy path。v1.9.26+ 消歧义：多候选 exposure 时 bridge 发 Discord 按钮让用户点选（零 LLM turn）。agent 可用 `send_to_agent({ target: "peer:alice.future_data" })` 跨 peer 调用。
- **管理按钮跳过 LLM** — 状态、监工、销毁、重启、定时任务等按钮由 Bridge 直接执行，零 token，瞬间响应。

### Discord UI
- **交互式组件** — 按钮、下拉菜单、Slash 命令。
- **Skill 自动补全（v1.5+）** — `~/.claude/skills/` 的 user skill、已装插件、项目级 `<cwd>/.claude/skills/`、Claude Code 的 bundled skills、以及精选的 CC 内置命令（`/cost` `/context` `/compact` `/mcp` `/review` `/effort` `/model` ...）全部注册成 Discord slash 命令。每 30 分钟自动重扫。
- **TUI Modal 适配（v1.5+）** — 数字菜单（`/model`）和水平滑杆（`/effort`）转成 Discord 按钮；bridge 处理不了的 modal 点 🤖 升级给大总管处理。
- **流式 tool 输出** — JSONL watcher 把 `Read · Edit · Write · Bash · Grep` 实时推到 Discord。
- **终端截图** — ANSI → PNG，锁屏也能看 agent 终端。
- **一键打断** — Discord 按钮发 `Ctrl+C`。
- **新消息自动打断（v1.5+）** — Claude 干活时你发新消息，bridge 自动先 Ctrl+C 再转发，实现"改主意就改主意"，不会排队。
- **精确空闲检测** — 通过 Claude Code 的 `Stop` / `Notification` hooks 驱动 Discord typing indicator。

### 可靠性和运维
- **自动更新（v1.3+，可配置 v1.4+）** — Claudestra 自身每 30 分钟查 GitHub；Claude Code CLI 每 7 天查一次。只在所有 agent 空闲时才升级。`bun src/manager.ts auto-update <target> on|off` 切换。
- **重启电脑后保留（v1.7.9+）** — setup 时自动配好 `pm2 startup`；重启后 launcher 会自动把 registry 里所有 agent 用 `claude --resume` 拉回到原 Discord 频道。
- **Session-idle Discord 按钮（v1.3+）** — Claude Code 弹出 resume 对话框时，Discord 收到三个按钮（从摘要恢复 / 恢复完整 / 不再询问）；master 自动确认保持常驻。
- **Wedge 检测（v1.6+）** — agent 的 tmux pane 30 分钟没变化且非 idle → @你 + 一键 Esc / Ctrl+C 救回按钮。
- **自我更新** — `bun src/manager.ts update` 做 `git pull` + `pm2 restart ecosystem.config.cjs`（只重启 Claudestra 自己 3 个进程，不影响你其他 pm2 应用）。

### 可观测性
- **Token 用量统计（v1.6+）** — `bun src/manager.ts cost [--agent <n>] [--today|--week]` 从 Claude Code 的 JSONL 汇总 per-agent / per-model 消耗。
- **事件日志（v1.7+）** — append-only `~/.claude-orchestrator/metrics.jsonl` 记录所有 bridge 事件（slash_invoked / agent_completed / agent_wedged / error ...）。`bun src/manager.ts metrics` 聚合。
- **Master TUI 代理（v1.7+）** — master 可以通过 `tmux-screenshot` / `tmux-capture` / `tmux-send-keys` / `tmux-wait-idle` CLI 远程驱动任意 agent 的终端，用来处理 bridge 识别不了的 TUI modal。

### 安全和工具
- **`--disallowedTools` 安全护栏** — 每个 agent 都拦 `rm -rf`、`git push --force`、`chmod 777` 等；通过 `manager.ts permissions` 切换预设（`default` / `strict` / `readonly` / `paranoid`）。
- **一键 Bot 邀请链接（v1.8.1+）** — `bun src/manager.ts invite-link [--peer]` 从 token 解 Application ID，自动拼好 Discord OAuth URL。`--peer` 生成给朋友用的最小权限链接。

## 环境要求

| 工具 | 最低版本 | 安装方式 |
|------|---------|---------|
| macOS 或 Linux | — | — |
| [Bun](https://bun.sh) | 1.x | `curl -fsSL https://bun.sh/install \| bash` |
| [tmux](https://github.com/tmux/tmux) | 3.x | `brew install tmux` |
| [pm2](https://pm2.keymetrics.io/) | 5.x | `npm install -g pm2` |
| [Claude Code](https://claude.com/claude-code) | 2.1.80+ | `npm install -g @anthropic-ai/claude-code` |
| Discord Bot | — | [Developer Portal](https://discord.com/developers/applications) |

## 安装

### 一条命令

```bash
curl -fsSL https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh | bash
```

安装脚本会检查依赖、克隆仓库、执行 `bun install` + `playwright install`。之后运行交互式配置向导：

```bash
cd ~/repos/claudestra
bun run setup
```

### 手动安装

```bash
git clone https://github.com/shawnlu96/claudestra.git ~/repos/claudestra
cd ~/repos/claudestra
bun install
npx playwright install chromium
bun run setup
```

完整流程（创建 Discord 应用、开启 Privileged Intents、收集 ID）请看 **[SETUP.zh-CN.md](./SETUP.zh-CN.md)**。

## 日常使用

### 手机 Discord

在控制频道里：

| 命令 | 作用 |
|------|------|
| `/status` | 列出所有 agent 及其状态 |
| `/screenshot` | 把当前频道 agent 的终端渲染成 PNG |
| `/interrupt` | 给当前 agent 发 `Ctrl+C` |
| `/cron` | 打开定时任务管理面板 |

在任意 agent 频道里直接打字——消息会直达对应的 Claude Code session，tool call 边执行边推回来。

### 本地终端

```bash
# iTerm2 原生 tab 模式
tmux -S /tmp/claude-orchestrator/master.sock -CC attach

# 普通 tmux
tmux -S /tmp/claude-orchestrator/master.sock attach
```

每个 agent 是 `master` session 里的一个 window。用 `Ctrl-B n/p` 切换，或者直接点 iTerm2 的 tab。

### CLI 参考

```bash
# Agent 生命周期
bun src/manager.ts create   <name> <dir> [purpose]
bun src/manager.ts resume   <name> <sessionId> [dir]
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

# 版本 / 更新
bun src/manager.ts version                          # 当前版本 + 是否有新版
bun src/manager.ts update                           # git pull + pm2 restart（只 Claudestra 3 个进程）
bun src/manager.ts auto-update status               # 查看自动更新开关
bun src/manager.ts auto-update claudestra on|off    # Claudestra 自更新（30 分钟轮询）
bun src/manager.ts auto-update claude on|off        # Claude Code CLI 更新（周轮询）

# 可观测性
bun src/manager.ts cost [--agent <n>] [--today|--week]   # per-agent token 用量
bun src/manager.ts metrics [--today|--week|--since <ISO>] [--agent <n>] [--raw]

# 权限（每个 agent 独立的 disallowedTools 预设）
bun src/manager.ts permissions list
bun src/manager.ts permissions presets
bun src/manager.ts permissions get <name>
bun src/manager.ts permissions set <name> --preset <default|strict|readonly|paranoid>
bun src/manager.ts permissions reset <name>

# Bot 邀请链接（v1.8.1+）
bun src/manager.ts invite-link           # 给自己用的完整权限链接
bun src/manager.ts invite-link --peer    # 给朋友的最小权限链接

# 跨 Claudestra peer 协作（v1.9+）
bun src/manager.ts peer-status                                     # 看 peer bots / 我开放的 agent / 对方开放给我的能力
bun src/manager.ts peer-expose <agent> <peer|all> \
  --purpose "..."                                                  # 把 agent 开放给 peer（默认 direct 模式）
bun src/manager.ts peer-expose <agent> <peer> --mode via_master    # 走老的 master 路由链路（不推荐）
bun src/manager.ts peer-revoke <agent> <peer|all>                  # 撤销 exposure（peer 的 capability 会自动被清）

# 低级 tmux 控制（给 master 兜底处理 bridge 认不出的 TUI modal）
bun src/manager.ts tmux-screenshot <agent>
bun src/manager.ts tmux-capture <agent> [lines]
bun src/manager.ts tmux-send-keys <agent> <keys...>
bun src/manager.ts tmux-wait-idle <agent> [ms]
```

## 配置

安装时配置在 `.env`（由 `bun run setup` 创建）：

| 变量 | 用途 |
|------|------|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_GUILD_ID` | Discord 服务器（guild）ID |
| `ALLOWED_USER_IDS` | 允许与 bot 对话的 Discord 用户 ID（逗号分隔） |
| `CONTROL_CHANNEL_ID` | 控制（master）频道 ID |
| `BRIDGE_PORT` | WebSocket 端口（默认 `3847`） |
| `USER_NAME` | 大总管在回复里对你的称呼 |
| `MCP_NAME` | MCP server 名称（默认 `claudestra`） |

运行时开关存 `~/.claude-orchestrator/config.json`（通过 `manager.ts auto-update` 管，首次调用时懒创建）：

| key | 用途 |
|-----|------|
| `autoUpdate.claudestra` | Claudestra 自更新，30 分钟轮询（默认 `true`） |
| `autoUpdate.claudeCode` | Claude Code CLI 更新，周轮询（默认 `true`） |

`~/.claude-orchestrator/` 下其他状态文件：`registry.json`（active agent）、`cron.json` + `cron-history.json`、`metrics.jsonl`。

## 项目结构

```
src/
  bridge.ts              Discord 网关 + WebSocket 路由 + 事件分发
  bridge/
    config.ts            共享运行时常量
    components.ts        Discord UI 组件 + typing indicator
    discord-api.ts       Discord API 封装
    management.ts        管理按钮的直接执行处理器
    screenshot.ts        终端截图（ANSI → HTML → PNG）
    jsonl-watcher.ts     JSONL session 监听 → 流式 tool call
    slash-catalog.ts     精选的 CC 内置 slash 命令清单
    slash-registry.ts    Skill 运行时注册表 + 按频道 resolver
    permission-watcher.ts 运行时权限弹窗 → Discord 按钮
    wedge-watcher.ts     检测卡死 agent（pane 不变且非 idle）
  channel-server.ts      每个 agent 的 MCP 代理
  manager.ts             Agent 生命周期 + cron + 版本 + metrics + tmux 控制 CLI
  cron.ts                定时任务调度守护进程（pm2 管理）
  launcher.ts            大总管 tmux session 守护（pm2 管理）
  setup.ts               交互式安装向导
  hooks/
    typing-hook.ts       Claude Code Stop/Notification hook → typing indicator
  lib/
    bridge-client.ts     共享 Bridge WebSocket 请求封装
    tmux-helper.ts       共享 tmux 命令封装
    claude-launch.ts     统一 Claude Code 启动命令构造
    config-store.ts      运行时自动更新开关（~/.claude-orchestrator/config.json）
    skills.ts            SKILL.md 发现（user / plugin / project）
    jsonl-cost.ts        Claude Code JSONL → per-model token 汇总
    metrics.ts           Append-only bridge 事件日志
  ansi2html.ts           ANSI 转义码 → 彩色 HTML
  html2png.ts            HTML → PNG（Playwright）
  discord-reply.ts       Bash fallback：通过 Bridge 直接发消息
master/
  CLAUDE.md.template     大总管行为指令模板（setup 时渲染）
tests/                   78 个用例跨 5 个文件
  cron.test.ts           Cron 解析器 + 调度器
  modal-parser.test.ts   TUI modal 检测
  skills.test.ts         SKILL.md 发现 + 名字规范化
  slash-registry.test.ts Skill resolver + 按 agent 隔离
  jsonl-cost.test.ts     Token 汇总
install.sh               一键安装脚本
SETUP.md / SETUP.zh-CN.md    完整安装指南
```

## 贡献

欢迎 issue 和 PR。核心思路很简单，复杂的部分主要集中在 tmux 边界情况、Discord 限流、Claude Code channel 生命周期等。提 PR 前请：

1. `bun test` — 保证 78 个测试用例全绿。
2. `bun build src/bridge.ts --target=bun`（每个入口都跑一下）— 快速抓出类型错误。
3. 在一个 sandbox Discord server 里跑通完整用户流程。

## License

[MIT](./LICENSE)
