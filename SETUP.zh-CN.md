# 安装指南

[English](./SETUP.md) · **简体中文**

本指南从一台全新的 macOS 或 Linux 机器开始，完整走一遍 Claudestra 的部署流程。预计耗时 **20~30 分钟**，大部分时间在 Discord Developer Portal 的网页上点来点去。

如果只想要简洁版，看 [README](./README.zh-CN.md#安装) 里的快速安装。

---

## 目录

1. [前置依赖](#1-前置依赖)
2. [创建 Discord 应用和 Bot](#2-创建-discord-应用和-bot)
3. [把 Bot 邀请到你的服务器](#3-把-bot-邀请到你的服务器)
4. [准备服务器并收集 ID](#4-准备服务器并收集-id)
5. [安装 Claudestra](#5-安装-claudestra)
6. [运行配置向导](#6-运行配置向导)
7. [注册 MCP server](#7-注册-mcp-server)
8. [启动 pm2 服务](#8-启动-pm2-服务)
9. [第一次对话](#9-第一次对话)
10. [从终端 attach](#10-从终端-attach)
11. [升级](#11-升级)
12. [卸载](#12-卸载)
13. [疑难排查](#13-疑难排查)

---

## 1. 前置依赖

Claudestra 主要在 macOS 上测试过，Linux 理论上可行但未全面验证。

安装五个必需工具：

```bash
# tmux
brew install tmux                                         # macOS
sudo apt install tmux                                     # Debian/Ubuntu

# Bun — bridge 和 manager 的运行时
curl -fsSL https://bun.sh/install | bash

# pm2 — 进程守护
npm install -g pm2

# Claude Code — 必须 v2.1.80 及以上（需要 Channel 支持）
npm install -g @anthropic-ai/claude-code
```

可选但推荐：

```bash
# macOS 更安全的删除（移动到回收站而不是 rm -rf）
brew install trash
```

验证版本：

```bash
tmux -V          # 3.x+
bun --version    # 1.x+
pm2 --version    # 5.x+
claude --version # 2.1.80+
```

---

## 2. 创建 Discord 应用和 Bot

1. 打开 [Discord Developer Portal](https://discord.com/developers/applications)。
2. 点击右上角 **New Application**，起个名字（比如 `claudestra`），确认创建。
3. 左边栏进入 **Bot** 页面。
4. 点 **Reset Token**，**复制新 token** 并保存到安全的地方。稍后会写入 `.env`。
5. 向下滚动到 **Privileged Gateway Intents**，**三个全部打开**：
   - `PRESENCE INTENT`
   - `SERVER MEMBERS INTENT`
   - `MESSAGE CONTENT INTENT`
6. 点页面底部的 **Save Changes**。

> **为什么要三个 intent 都开？** Bridge 监听消息内容来路由回复，观察成员在线状态控制 typing indicator，拉取成员列表来校验白名单。少一个，bot 就会在无提示情况下忽略消息。

---

## 3. 把 Bot 邀请到你的服务器

1. 左边栏进入 **OAuth2 → URL Generator**。
2. **SCOPES** 勾选：
   - `bot`
   - `applications.commands`
3. **BOT PERMISSIONS** 勾选：
   - View Channels
   - Send Messages
   - Read Message History
   - Manage Channels（bridge 会自动为每个 agent 建频道）
   - Attach Files
   - Add Reactions
   - Embed Links
4. 复制页面底部生成的 URL，在浏览器里打开，授权到你要管理的服务器。

Bot 现在应该出现在服务器成员列表里，最初是离线状态。完成第 8 步启动 pm2 后会上线。

---

## 4. 准备服务器并收集 ID

### 4.1 打开 Discord 开发者模式

Discord 里：**用户设置 → 高级 → 开发者模式 → 开**。

这样右键菜单里会多出"复制 ID"。

### 4.2 创建控制频道

在你的服务器里建一个普通文字频道，比如 `#claudestra-control`。这是大总管监听的频道。

### 4.3 收集四个 ID

右键对应对象，选 **复制 ID**：

| ID | 怎么拿 |
|----|--------|
| **Bot Token** | Developer Portal Bot 页面（第 2.4 步） |
| **Guild ID** | 右键服务器图标 |
| **User ID** | 右键任意位置你自己的名字/头像 |
| **Control Channel ID** | 右键刚建的控制频道 |

这四个备好，配置向导会依次问你。

---

## 5. 安装 Claudestra

### 方案 A — 一条命令

```bash
curl -fsSL https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh | bash
```

安装脚本会：

- 检查 `git`、`tmux`、`bun`、`pm2`、`claude` 五个依赖，缺的会给出安装命令。
- 把仓库克隆到 `~/repos/claudestra`（可用 `CLAUDESTRA_DIR` 覆盖）。
- 执行 `bun install` 并安装 Playwright 的 Chromium（用于终端截图）。
- 打印下一步命令。

### 方案 B — 手动 clone

```bash
git clone https://github.com/shawnlu96/claudestra.git ~/repos/claudestra
cd ~/repos/claudestra
bun install
npx playwright install chromium
```

你可以 clone 到任意目录。Claudestra 在运行时通过 `import.meta.dir` 解析自己的位置，不绑定 `~/repos/claudestra`。

---

## 6. 运行配置向导

```bash
cd ~/repos/claudestra
bun run setup
```

向导会问你 7 个问题：

1. **Discord Bot Token** — 来自第 2.4 步
2. **Guild ID** — 第 4.3 步
3. **User ID** — 你自己的，第 4.3 步
4. **Control Channel ID** — 第 4.3 步
5. **Bridge 端口** — 默认 `3847`，有冲突再改
6. **你的称呼** — 大总管在回复里怎么叫你
7. **MCP 名称** — 默认 `claudestra`，别动除非你知道为什么

然后它会：

- 写入 `.env`。
- 把 `master/CLAUDE.md.template` 渲染成 `master/CLAUDE.md`（替换你的名字）。
- 打印第 7、8 步的命令。

---

## 7. 注册 MCP server

把 Claudestra 的 channel-server 注册为全局 MCP server，让每个 Claude Code 进程都能加载：

```bash
# 如果之前注册过，先移除
claude mcp remove claudestra -s user 2>/dev/null

# 注册
claude mcp add claudestra -s user -- bun run ~/repos/claudestra/src/channel-server.ts
```

如果第 6 步用的不是默认的 `MCP_NAME`，这两条命令里都要替换成你自己的名字。

---

## 8. 启动 pm2 服务

```bash
cd ~/repos/claudestra
pm2 start ecosystem.config.cjs
pm2 save
```

首次安装还要开启开机自启：

```bash
pm2 startup
# pm2 会打印一条 sudo 命令，复制下来跑一次
```

ecosystem 文件会启动三个进程：

| 进程 | 作用 |
|------|------|
| `discord-bridge` | Discord 网关 + WebSocket 路由 |
| `master-launcher` | 保持大总管 tmux session 存活，自动处理 Claude Code 确认弹窗 |
| `cron-scheduler` | 执行定时任务并汇报结果 |

验证都在线：

```bash
pm2 list
```

三个都应该是 `online` 状态。

---

## 9. 第一次对话

在任意设备上打开 Discord，进入你的控制频道，发一句：

> @claudestra 你好

几秒内应该看到一条欢迎消息加三个按钮：**Agent 状态**、**历史会话**、**新建 Agent**。随便点一个——因为管理按钮绕过 LLM，响应是瞬间的。

如果没反应，去 [疑难排查](#13-疑难排查)。

---

## 10. 从终端 attach

回到工位后，可以直接跳进任何正在运行的 session。

```bash
# iTerm2: 每个 session 变成一个原生 tab
tmux -S /tmp/claude-orchestrator/master.sock -CC attach

# 普通模式: Ctrl-B + W 选 window
tmux -S /tmp/claude-orchestrator/master.sock attach
```

每个 agent 是 `master` tmux session 里的一个 window。master window（window 0）本身是大总管——监听你控制频道的那个 agent。

---

## 11. 升级

从 Discord 里让大总管升级：

> 检查更新

或者

> 升级一下代码

大总管会执行：

```bash
bun src/manager.ts version   # 查看状态
bun src/manager.ts update    # git pull + pm2 restart
```

也可以手动做：

```bash
cd ~/repos/claudestra
git pull
pm2 restart ecosystem.config.cjs
```

结果一样，Discord 那条路径只是在手机上更方便。

---

## 12. 卸载

```bash
pm2 delete discord-bridge master-launcher cron-scheduler
claude mcp remove claudestra -s user
trash ~/repos/claudestra ~/.claude-orchestrator /tmp/claude-orchestrator
# 没装 trash 的话用 rm -rf
```

从 Discord 移除 bot：服务器设置 → 成员 → 右键 bot → 移除。要彻底删除 bot，去 Developer Portal 把应用删掉。

---

## 13. 疑难排查

### Bot 在线但不回消息

检查 Privileged Intents。三个都必须在 Developer Portal 上开启。Discord 会静默丢弃 bot 没权限接收的事件。

```bash
pm2 logs discord-bridge --lines 50
```

看有没有 `received message` 日志。没有就是 intent 的问题。

### Bot 响应按钮但不响应文字

很可能你的 user ID 不在 `ALLOWED_USER_IDS` 里。重跑 `bun run setup` 或直接改 `.env`，然后 `pm2 restart discord-bridge`。

### 大总管一直不上线

```bash
pm2 logs master-launcher --lines 50
```

常见原因：

- Claude Code 登录过期——在终端里跑一次 `claude` 重新登录。
- MCP server 没注册——重做第 7 步。
- `master/CLAUDE.md` 缺失——重跑 `bun run setup`。

### 手机上 screenshot 命令失败

Discord 每个客户端会缓存 slash 命令最多一小时。第一次从 global 命令切换到 guild 命令时，手机可能还是老的。重启 Discord App 就清了。

### `bun run setup` 找不到 `master/CLAUDE.md.template`

你可能在仓库目录外跑的。始终先 `cd ~/repos/claudestra`。

### Bridge 一直重启

```bash
pm2 logs discord-bridge --err --lines 100
```

通常是 bot token 错了、过期、或者 `.env` 里有错字。去 Developer Portal 重新生成 token，重跑 `bun run setup`。

---

## 关键路径

| 路径 | 内容 |
|------|------|
| `~/repos/claudestra`（或 clone 的位置） | 源码 |
| `~/repos/claudestra/.env` | 运行时配置（gitignored） |
| `~/repos/claudestra/master/CLAUDE.md` | 渲染后的大总管指令（gitignored） |
| `~/.claude-orchestrator/registry.json` | 活跃 agent 注册表 |
| `~/.claude-orchestrator/cron.json` | 定时任务定义 |
| `~/.claude-orchestrator/cron-history.json` | 最近执行记录 |
| `/tmp/claude-orchestrator/master.sock` | 私有 tmux socket |
| `~/.claude/projects/` | Claude Code session JSONL 文件（resume 时的数据源） |

---

## 接下来

- 读 [CLAUDE.zh-CN.md](./CLAUDE.zh-CN.md) 了解架构细节（给贡献者和 agent 看的）。
- 看 `tests/cron.test.ts` 了解 cron 表达式语法。
- 试试 `send_to_agent` MCP 工具，搭建多 agent 协作流程。
- 设置一个每天早上跑的定时任务，让它汇报到你的控制频道。
