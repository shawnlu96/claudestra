# 系统概览（完整版）

> 2026-09-23 从 `CLAUDE.zh-CN.md` 原样搬出：每个会话都加载的那份文件要保持精简（`scripts/guard` 对它按字节棘轮）。下文的版本号与事故记录是历史，以代码为准。

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
