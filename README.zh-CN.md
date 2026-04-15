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

- **多 agent 管理** — 创建、恢复、销毁、重启、列表、历史会话浏览。
- **Agent 间通信** — `send_to_agent(target, text)` MCP 工具直接把消息注入到另一个 agent 的上下文。
- **定时任务** — 声明式 cron 表达式，自动创建临时 agent、执行 prompt、通知 Discord、清理。
- **Discord UI** — 按钮、下拉菜单、Slash 命令（`/status` `/screenshot` `/interrupt` `/cron`）。
- **管理按钮跳过 LLM** — 状态、监工、销毁、重启、定时任务等按钮由 Bridge 直接执行，零 token 成本，瞬间响应。
- **流式 tool 输出** — JSONL watcher 把 `Read · Edit · Write · Bash · Grep` 实时推到 Discord。
- **终端截图** — ANSI → PNG 渲染，锁屏状态也能看 agent 的终端。
- **一键打断** — Discord 里一个按钮就给对应 session 发 `Ctrl+C`。
- **精确空闲检测** — 通过 Claude Code 的 `Stop` / `Notification` hooks 驱动 Discord typing indicator。
- **自动更新** — 在 Discord 里用自然语言说"升级一下"就触发 `git pull` + `pm2 restart all`。
- **安全限制** — `--disallowedTools` 禁止 `rm -rf`、`git push --force`、`chmod 777` 等破坏性命令。

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
bun src/manager.ts version   # 查看当前版本和是否有更新
bun src/manager.ts update    # git pull && pm2 restart all
```

## 配置

所有运行时配置都在 `.env` 里（由 `bun run setup` 创建）。

| 变量 | 用途 |
|------|------|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_GUILD_ID` | Discord 服务器（guild）ID |
| `ALLOWED_USER_IDS` | 允许与 bot 对话的 Discord 用户 ID（逗号分隔） |
| `CONTROL_CHANNEL_ID` | 控制（master）频道 ID |
| `BRIDGE_PORT` | WebSocket 端口（默认 `3847`） |
| `USER_NAME` | 大总管在回复里对你的称呼 |
| `MCP_NAME` | MCP server 名称（默认 `claudestra`） |

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
  channel-server.ts      每个 agent 的 MCP 代理
  manager.ts             Agent 生命周期 + 定时任务 + 版本/更新 CLI
  cron.ts                定时任务调度守护进程（pm2 管理）
  launcher.ts            大总管 tmux session 守护（pm2 管理）
  setup.ts               交互式安装向导
  hooks/
    typing-hook.ts       Claude Code Stop/Notification hook → typing indicator
  lib/
    bridge-client.ts     共享 Bridge WebSocket 请求封装
    tmux-helper.ts       共享 tmux 命令封装
    claude-launch.ts     统一 Claude Code 启动命令构造
  ansi2html.ts           ANSI 转义码 → 彩色 HTML
  html2png.ts            HTML → PNG（Playwright）
  discord-reply.ts       Bash fallback：通过 Bridge 直接发消息
master/
  CLAUDE.md.template     大总管行为指令模板（setup 时渲染）
tests/
  cron.test.ts           Cron 解析器 + 调度器测试（46 个用例）
install.sh               一键安装脚本
SETUP.md / SETUP.zh-CN.md    完整安装指南
```

## 贡献

欢迎 issue 和 PR。核心思路很简单，复杂的部分主要集中在 tmux 边界情况、Discord 限流、Claude Code channel 生命周期等。提 PR 前请：

1. `bun test` — 保证 cron 测试套件全绿。
2. `bun build src/bridge.ts --target=bun`（每个入口都跑一下）— 快速抓出类型错误。
3. 在一个 sandbox Discord server 里跑通完整用户流程。

## License

[MIT](./LICENSE)
