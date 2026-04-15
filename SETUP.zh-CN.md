# 安装指南

[English](./SETUP.md) · **简体中文**

**最短路径：跑 `bun run setup`**。交互式向导会一步一步带你走完所有步骤，每一步都把指引内嵌在终端里——你根本不需要读这个文档。

本文档的存在意义：

- 向导报错时查问题。
- 了解向导在幕后做了什么。
- 偏好手动配置的人用作参考。

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

就这样。向导负责剩下的一切：检查依赖、带你创建 Discord bot（内嵌链接 + 一步一步说点哪里）、收集所有需要的 ID、写 `.env`、渲染 `master/CLAUDE.md`、注册 MCP、启动 pm2。

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

从 Discord 里让大总管升级：

> 检查一下有没有更新

或者

> 升级一下代码

它会执行：

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

### 手机上 screenshot 命令失败

Discord 每个客户端缓存 slash 命令最多 1 小时。重启 Discord App 就清了。

---

## 关键路径

| 路径 | 内容 |
|------|------|
| `~/repos/claudestra` | 源码（或 clone 的位置） |
| `~/repos/claudestra/.env` | 运行时配置（git 忽略） |
| `~/repos/claudestra/master/CLAUDE.md` | 渲染后的大总管指令（git 忽略） |
| `~/.claude-orchestrator/registry.json` | 活跃 agent 注册表 |
| `~/.claude-orchestrator/cron.json` | 定时任务 |
| `~/.claude-orchestrator/cron-history.json` | 最近执行记录 |
| `/tmp/claude-orchestrator/master.sock` | 私有 tmux socket |
| `~/.claude/projects/` | Claude Code session JSONL 文件 |

---

## 接下来

- 读 [CLAUDE.zh-CN.md](./CLAUDE.zh-CN.md) 了解架构（给贡献者和 agent 看的）。
- 试试 `send_to_agent` MCP 工具搭建多 agent 协作流。
- 建个每天早上跑的定时任务，让它汇报到控制频道。
