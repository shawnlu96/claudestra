# Claude Orchestrator

从手机 Discord 管理多个本地 Claude Code session。在 Mac 前用终端，离开时用手机，无缝切换。

## 它解决什么问题

Claude Code 是一个终端工具——你得坐在电脑前才能用。Claude Orchestrator 让你可以：

- 在手机 Discord 上跟任意 Claude Code session 对话
- 同时管理多个 session（每个有独立 Discord 频道）
- 回到 Mac 时在 iTerm2 里直接继续（同一个进程）
- 实时看到 Claude 在做什么（tool use 流式推送）

## 架构

```
你的手机 (Discord)
    ↕
Discord Bot（一个 token，多个频道）
    ↕
Bridge（Bun 进程，pm2 管理）
    ↕ WebSocket
    ├── channel-server ↔ Claude Code (session A)
    ├── channel-server ↔ Claude Code (session B)  ← 每个是 tmux 里的一个 window
    └── channel-server ↔ Claude Code (session C)
    ↕ JSONL Watcher
    └── 监听 session 文件，tool use 实时推到 Discord

你的 Mac (iTerm2)
    ↕ tmux -CC attach
    └── 看到所有 session 的终端，直接打字交互
```

**关键设计**：基于 Claude Code 原生 Channel 协议（MCP），不是屏幕截取。Bridge 解决了官方插件一个 token 只能绑一个 session 的限制。

## 前置要求

- macOS + [Bun](https://bun.sh) + [tmux](https://github.com/tmux/tmux)
- [Claude Code](https://claude.ai/claude-code) v2.1.80+（需要 Channel 支持）
- Discord Bot（[创建指南](https://discord.com/developers/applications)）
- [pm2](https://pm2.io) 进程管理

## 安装

```bash
git clone <repo-url> ~/repos/claude-orchestrator
cd ~/repos/claude-orchestrator
bun install

# 安装 Playwright 浏览器（用于终端截图渲染）
npx playwright install chromium

# 安装 Claude Code Discord channel 插件
claude plugin install discord@claude-plugins-official
```

## 配置

```bash
cp .env.example .env
# 编辑 .env，填入：
# DISCORD_BOT_TOKEN=你的bot-token
# DISCORD_GUILD_ID=你的server-id
# ALLOWED_USER_IDS=你的discord-user-id
# BRIDGE_PORT=3847
# CONTROL_CHANNEL_ID=control频道id
```

Discord Bot 需要以下权限：
- Send Messages, Manage Channels, Read Message History
- Privileged Intents: Message Content, Server Members, Presence

将 channel-server 注册为全局 MCP server：
```bash
claude mcp add discord-bridge -s user -- bun run ~/repos/claude-orchestrator/src/channel-server.ts
```

## 启动

```bash
# 启动 Bridge + 大总管守护
pm2 start ecosystem.config.cjs
pm2 save

# 开机自启（首次需要）
pm2 startup
```

## 使用

### 手机 Discord

在 `#agent-大总管` 频道：
- 发消息或点按钮管理 agent
- `/status` — 查看所有 agent 状态
- `/screenshot` — 截取当前频道 agent 的终端
- `/interrupt` — 打断当前 agent

在 agent 频道（如 `#orchestrator`）：
- 直接发消息跟 Claude Code 对话
- 实时看到 tool use 流式输出

### Mac 终端

```bash
# 连接所有 session（iTerm2 原生 tab）
tmux -S /tmp/claude-orchestrator/master.sock -CC attach

# 或普通模式（Ctrl+B, S 切换 session）
tmux -S /tmp/claude-orchestrator/master.sock attach
```

### Agent 管理 CLI

```bash
bun src/manager.ts create <name> <dir> [purpose]    # 新建 agent
bun src/manager.ts resume <name> <sessionId> [dir]   # 恢复历史会话
bun src/manager.ts kill <name>                        # 销毁 agent
bun src/manager.ts restart [name]                     # 重启 agent
bun src/manager.ts list                               # 列出所有 agent
bun src/manager.ts sessions [search]                  # 浏览历史会话
```

## 项目结构

```
src/
  bridge.ts              Discord 网关 + WebSocket 路由 + 事件处理
  bridge/
    config.ts            共享配置
    components.ts        Discord UI 组件 + typing indicator
    discord-api.ts       Discord API 操作
    management.ts        管理按钮处理（跳过 LLM）
    screenshot.ts        终端截图（ANSI → HTML → PNG）
    jsonl-watcher.ts     JSONL 监听 → tool use 实时推送
  channel-server.ts      MCP channel 代理
  manager.ts             Agent 生命周期 CLI
  launcher.ts            大总管 tmux 守护
  lib/
    bridge-client.ts     Bridge WebSocket 请求工具
  ansi2html.ts           ANSI → HTML
  html2png.ts            HTML → PNG (Playwright)
  discord-reply.ts       Bash fallback 回复工具
master/
  CLAUDE.md              大总管行为指令
```

## 工作原理

1. **Bridge** 持有唯一的 Discord 网关连接，多个 channel-server 通过 WebSocket 注册各自的频道 ID
2. Discord 消息到达 → Bridge 路由到对应的 channel-server → MCP notification 推送给 Claude Code
3. Claude Code 调用 reply MCP tool → channel-server → Bridge → Discord 回复
4. JSONL watcher 监听 session 文件，tool use 事件实时转发到 Discord（补充 reply 的正式回复）
5. 管理按钮（状态、监工、销毁、重启）直接由 Bridge 执行 manager.ts，不经过 LLM

## License

MIT
