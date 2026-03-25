# Claude Orchestrator

通过 Discord 远程管理多个 Claude Code session。基于 Claude Code 原生 Channel 协议 + 自定义 Bridge 实现多 session 路由。

## 架构

```
Discord (一个 bot, 一个 token)
  ↕
Bridge (bridge.ts, pm2, ws://localhost:3847)
  ↕ WebSocket                    ↕ JSONL Watcher
  ├── channel-server → Master    ├── 监听 session 文件
  ├── channel-server → Agent A   ├── tool use 实时推送
  └── channel-server → Agent B   └── 合并后发到 Discord
```

**消息入站**：Discord → Bridge → channel-server (MCP) → Claude Code
**消息出站**：Claude Code → reply MCP tool → channel-server → Bridge → Discord
**Tool 流式**：Claude Code 写 JSONL → Watcher 检测 → Bridge 推到 Discord

## 文件结构

```
src/
  bridge.ts              主入口：Discord client + WebSocket server + 事件路由
  bridge/
    config.ts            共享配置常量
    components.ts        Discord UI 组件 + typing indicator
    discord-api.ts       Discord API 操作
    management.ts        管理按钮/菜单处理（跳过 LLM 直接执行）
    screenshot.ts        终端截图（ANSI → HTML → PNG）
    jsonl-watcher.ts     JSONL 文件监听 → tool use 实时推送
  channel-server.ts      MCP channel 代理（每个 Claude Code 进程一个实例）
  manager.ts             Agent 生命周期 CLI
  launcher.ts            大总管 tmux session 守护进程
  lib/
    bridge-client.ts     共享的 Bridge WebSocket 请求工具
  ansi2html.ts           ANSI 转义码 → 带颜色 HTML
  html2png.ts            HTML → PNG（Playwright headless Chrome）
  discord-reply.ts       Bash fallback：直接通过 Bridge 发消息
master/
  CLAUDE.md              大总管的行为指令
legacy/
  bot.ts                 旧版自定义 Bot（回退用）
```

## 功能

- **多 Agent 管理**：create / resume / kill / restart / list / sessions
- **Discord UI**：按钮、下拉菜单、Slash Commands（/screenshot /interrupt /status）
- **管理按钮跳过 LLM**：状态、监工、销毁、重启 → 瞬间响应，零 token
- **JSONL 流式输出**：tool use 实时推送到 Discord（📖 Read · 💻 Bash · ✏️ Edit）
- **终端截图**：ANSI 颜色渲染 PNG，锁屏可用
- **打断按钮**：Discord 一键 Ctrl+C
- **[DONE] 标记**：typing indicator 精确控制
- **恢复会话**：自动创建 Discord 频道 + 终端预览截图
- **大总管守护**：pm2 + launcher 自动重启，确认弹窗自动处理
- **安全限制**：--disallowedTools 禁止 rm -rf、git push --force 等

## 运行

```bash
# 启动
pm2 start ecosystem.config.cjs

# Agent 管理
bun src/manager.ts create <name> <dir> [purpose]
bun src/manager.ts resume <name> <sessionId> [dir]
bun src/manager.ts kill <name>
bun src/manager.ts restart [name]
bun src/manager.ts list
bun src/manager.ts sessions [search]
```

## 环境变量

```
DISCORD_BOT_TOKEN     Discord bot token
DISCORD_GUILD_ID      Discord server ID
ALLOWED_USER_IDS      允许的 Discord 用户 ID（逗号分隔）
BRIDGE_PORT           Bridge WebSocket 端口（默认 3847）
CONTROL_CHANNEL_ID    #agent-大总管 频道 ID
```

## tmux 结构

所有 Agent 是 `master` session 里的 window（iTerm2 -CC 模式下每个是一个 tab）：

```
master session
  ├── window 0: 大总管 (Claude Code + channel)
  ├── worker-orchestrator
  ├── worker-predict
  └── worker-...
```

本地：`tmux -S /tmp/claude-orchestrator/master.sock -CC attach`
