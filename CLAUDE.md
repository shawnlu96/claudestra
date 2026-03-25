# Claude Orchestrator

通过 Discord 管理多个 Claude Code session 的系统。基于 Claude Code 原生 Channel 协议 + 自定义 Bridge 实现多 session 路由。

## 架构

```
Discord (一个 bot, 一个 token)
  ↕
Bridge (bridge.ts, pm2 管理, ws://localhost:3847)
  ↕ WebSocket
  ├── channel-server → Master Claude Code (#agent-大总管)
  ├── channel-server → Agent (#orchestrator)
  └── channel-server → Agent (#predict, #ssh, ...)
```

## 组件

| 文件 | 用途 |
|------|------|
| `src/bridge.ts` | 共享 Discord 网关 + WebSocket 路由 + 管理按钮 + 截图 |
| `src/channel-server.ts` | MCP channel 代理，每个 Claude Code 进程一个实例 |
| `src/manager.ts` | CLI 工具：create/resume/kill/restart/list/sessions |
| `src/launcher.ts` | pm2 守护进程，确保大总管始终存活 |
| `src/ansi2html.ts` | ANSI 终端输出 → HTML（带颜色） |
| `src/html2png.ts` | HTML → PNG（Playwright headless Chrome） |
| `src/discord-reply.ts` | Bash fallback：直接通过 bridge 发 Discord 消息 |
| `src/bot.ts` | 旧版自定义 Bot（保留回退，不再使用） |
| `master/CLAUDE.md` | 大总管的指令集 |

## 运行

```bash
# pm2 管理
pm2 start ecosystem.config.cjs --only discord-bridge
pm2 start ecosystem.config.cjs --only master-launcher

# 手动管理 agent
bun src/manager.ts create <name> <dir> [purpose]
bun src/manager.ts resume <name> <sessionId> [dir]
bun src/manager.ts kill <name>
bun src/manager.ts restart [name]
bun src/manager.ts list
bun src/manager.ts sessions [search]
```
