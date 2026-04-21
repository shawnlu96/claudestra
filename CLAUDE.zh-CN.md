# Claudestra — 架构文档

[English](./CLAUDE.md) · **简体中文**

本文档描述 Claudestra 的内部架构，面向贡献者、修改代码的 agent、以及排查生产问题的人。新用户请先看 [SETUP.zh-CN.md](./SETUP.zh-CN.md)。

## 系统概览

Claudestra 是一个多 session 编排器，基于 Claude Code 原生的 **Channel 协议**（MCP 的一个扩展）。一个 Bridge 进程把单个 Discord bot token 扇出到多个 Claude Code session——每个 session 作为一个独立的 channel 监听者注册。

```
 Discord (一个 bot, 一个 token)
        │
        ▼
 Bridge  ── bridge.ts, pm2 管理, ws://localhost:3847
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

## 项目结构

```
src/
  bridge.ts              主入口：Discord client、WebSocket server、事件分发、slash 命令
  bridge/
    config.ts            共享运行时常量
    components.ts        Discord UI 组件 + typing indicator
    discord-api.ts       Discord API 封装（建/删频道、编辑消息等）
    management.ts        管理按钮/菜单的直接执行处理器（绕过 LLM）
    screenshot.ts        终端截图流水线（ANSI → HTML → PNG）
    jsonl-watcher.ts     JSONL session 监听 → 流式 tool call 摘要
  channel-server.ts      每个 session 的 MCP 代理（stdio MCP ↔ Bridge WebSocket）
  manager.ts             Agent 生命周期 + 定时任务 + 版本/更新 CLI（JSON 输出）
  cron.ts                定时任务调度守护进程（pm2 管理）
  launcher.ts            大总管 tmux session 守护（pm2 管理）
  setup.ts               交互式安装向导
  hooks/
    typing-hook.ts       Claude Code Stop/Notification hook → Bridge HTTP 端点
  lib/
    bridge-client.ts     共享 Bridge WebSocket 请求封装
    tmux-helper.ts       共享 tmux 命令封装（tmuxRaw, isIdle, sendLine, …）
    claude-launch.ts     统一 Claude Code 启动命令构造（flags, MCP_NAME, shell 转义）
  ansi2html.ts           ANSI 转义码 → 彩色 HTML
  html2png.ts            HTML → PNG（Playwright headless Chromium）
  discord-reply.ts       Bash fallback：通过 Bridge 直接发消息
master/
  CLAUDE.md.template     大总管行为指令模板（setup.ts 渲染）
  CLAUDE.md              渲染后的本地副本（gitignored）
tests/
  cron.test.ts           Cron 解析器 + 调度器测试套件（46 个用例）
install.sh               一键安装脚本
SETUP.md / SETUP.zh-CN.md    面向用户的安装指南
```

## 功能

- **多 agent 编排** — 创建、恢复、销毁、重启、列表、浏览历史。
- **Agent 间通信** — `send_to_agent(target, text)` MCP 工具通过 Bridge 直接向另一个 agent 的上下文注入消息。
- **定时任务** — cron 表达式拉起临时 agent、执行 prompt、汇报、清理。
- **Discord UI** — 按钮、下拉菜单、slash 命令（`/status`、`/screenshot`、`/interrupt`、`/cron`）。
- **管理按钮跳过 LLM** — 状态、监工、销毁、重启、定时任务按钮由 Bridge 直接执行，零 token 成本、瞬间响应。
- **流式 tool 输出** — jsonl-watcher 近乎实时地把 `Read · Edit · Write · Bash · Grep` 推到 Discord。
- **终端截图** — ANSI 转 PNG 流水线，屏幕锁定也能看。
- **一键打断** — Discord 按钮向目标 agent 的 tmux window 发 `Ctrl+C`。
- **精确空闲检测** — Claude Code `Stop` / `Notification` hooks 精确驱动 Discord typing indicator；30 分钟安全超时兜底。
- **大总管守护** — pm2 管理的 launcher 保持大总管 tmux session 存活，自动处理 Claude Code 确认弹窗。
- **安全限制** — 每个 spawn 的 agent 都带 `--disallowedTools`，禁止 `rm -rf`、`git push --force`、`git reset --hard`、`chmod 777` 等破坏性命令。

### 跨 Claudestra peer 协作

其他跑同一套 upstream 的 Claudestra 实例之间可以共享各自的专精 agent，不用彼此开 SSH / 文件系统权限。v1.9.x 这条线改得挺多，下面是 v1.9.26 的当前态。

- **Shared `#agent-exchange` 频道** — peer bot 加入你 guild 时 bridge 自动建 `#agent-exchange`，把 peer bot 限死在这一个频道（只给 View/Send，其他频道 Deny）。跨 peer 的所有通信都走这儿。grant / revoke / hello 通告是 HTML-comment 编码的 `PeerEvent` marker，两边 bridge 都解析。
- **显式 exposure** — `bun src/manager.ts peer-expose <agent> <peer|all> --purpose "..."` 把本地 agent 显式开放给指定 peer bot。存在 `~/.claude-orchestrator/peers.json`。peer 侧 bridge 通过广播学到，自动缓存在对方的 `peers.json` 里。
- **Direct 模式路由（v1.9.21+，新 exposure 默认）** — peer 发请求到 `#agent-exchange`：你的 bridge 查 `exposures[peer].mode === "direct"` → **直接把消息注入目标 agent 的 ws**，绕过 master。agent 直接 reply 到 `#agent-exchange` `@` peer-bot。6 跳老链路变 2-3 跳，两边 master 都退出 happy path。兼容的 `via_master` 模式（v1.8–v1.9.0 行为）用 `--mode via_master` 保留，适合需要 LLM 路由决策的场景。
- **对称路由（v1.9.22+）** — 你在 `#agent-exchange` `@` peer bot：本地 bridge 识别到你只 @ 对方不 @ 我方，skip 转给 master；peer bridge 在 foreign `#agent-exchange` 收事件后，同样走 direct 路由到对方 agent。两个方向都快。
- **多候选消歧义（v1.9.26+）** — 多条 direct exposure 匹配时先走关键词（C：消息正文里命中某个 agent 名 ⇒ 路由）；没唯一命中 ⇒ 发 Discord 按钮让用户点（D：零 LLM turn、零 master 介入）。
- **跨 peer `send_to_agent`** — agent 用 `send_to_agent({ target: "peer:<peer_bot_name>.<agent_name>" })` 或短格式 `target: "<agent>@<peer>"` 调 peer agent。bridge 发消息到 shared `#agent-exchange` `@` peer bot，记 pending；对方回复时 bridge push 回 caller 的 ws 作为合成 `[🤖 peer X/Y 回复] ...` 用户消息。不用再 fetch_messages 轮询。
- **信任模型** — 简化的"信任传递"：peer bot 被 expose 给某 agent ⇒ 对应 peer 的 human users（已经在对方 `#agent-exchange` 里的）自动受信。没有额外的 allowlist 同步，频道成员身份就是信任边界。
- **推回代替轮询（v1.9.21+）** — `route_to_agent`（本地）和 `handlePeerRouteToAgent`（跨 peer）都记 `pendingAgentCalls` / `pendingPeerCalls`。target 发 reply 时 bridge 合成内部 "message" 事件推回 caller ws。caller 直接 end_turn 等被 push 唤醒即可。
- **Reply 兜底（v1.9.21+，v1.9.25 定版）** — 每条 Discord 入站消息 bridge 挂一个按 channel 的 pending。目标 session Stop hook 触发时还没调 `reply()` → bridge 读 JSONL 抽最近一段 assistant text，代它 post 到 Discord（footer `_📋 [bridge 兜底] …_`）。没有 NAG 注入（v1.9.20 的 NAG 方案被弃用 —— 污染 context、误触发）。只在 `Stop` / `StopFailure` 跑，不在 `Notification` 跑，免重复 post。
- **`[EOT]` 线程结束标记** — agent 在结束性回复末尾加 `[EOT]`；收到端 bridge 识别到就 drop 不 forward，防止两个 bot 在 `#agent-exchange` 里互相 ack 死循环。

## 运行时命令

```bash
# 首次部署：收集 Discord 配置、写 .env、渲染 master/CLAUDE.md
bun run setup

# 启动全部（bridge + launcher + cron-scheduler）
pm2 start ecosystem.config.cjs

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

# 跨 Claudestra peer 协作（v1.9+）
bun src/manager.ts peer-status                                             # 看 peer bots / 我开放的 / 对方开放给我的
bun src/manager.ts peer-expose <agent> <peer|all> --purpose "..."          # 默认 mode=direct（bridge 直接路由）
bun src/manager.ts peer-expose <agent> <peer> --mode via_master --purpose "..." # 走老的 master 路由链路
bun src/manager.ts peer-revoke <agent> <peer|all>                          # 撤销 exposure
bun src/manager.ts invite-link --peer                                      # 生成给 peer 的最小权限邀请链接

# 版本
bun src/manager.ts version   # 当前版本 + 是否有更新
bun src/manager.ts update    # git pull + pm2 restart ecosystem.config.cjs（只重启 Claudestra 自己 3 个进程）

# 测试
bun test
```

## 环境变量

| 变量 | 用途 |
|------|------|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_GUILD_ID` | Discord 服务器（guild）ID |
| `ALLOWED_USER_IDS` | 允许与 bot 对话的 Discord 用户 ID（逗号分隔） |
| `CONTROL_CHANNEL_ID` | 大总管的控制频道 ID |
| `BRIDGE_PORT` | WebSocket 端口（默认 `3847`） |
| `MCP_NAME` | `claude mcp add` 时用的 MCP server 名称（默认 `claudestra`） |
| `USER_NAME` | 大总管在回复里对操作者的称呼 |
| `BRIDGE_URL` | channel-server 的 WebSocket 目标地址（可选覆盖） |
| `MASTER_DIR` | 大总管 tmux session 的工作目录（可选覆盖） |

## tmux 拓扑

每个 agent 是同一个 `master` session 里的一个 **window**。这样 `tmux -CC attach` 可以把每个 agent 展示成 iTerm2 的原生 tab。

```
master (session, 私有 socket: /tmp/claude-orchestrator/master.sock)
  ├── window 0: 大总管
  ├── worker-alpha
  ├── worker-bravo
  └── worker-...
```

本地 attach：

```bash
tmux -S /tmp/claude-orchestrator/master.sock -CC attach
```

## 关键不变量

- 大总管是 `master` tmux session 的 window 0。pm2 的 `master-launcher` 保证它存在且正在运行 Claude Code。
- 每个 agent 的 Discord channel ID 记录在 `~/.claude-orchestrator/registry.json` 里。Bridge 用这个 registry 把入站的 Discord 消息路由到对应的 channel-server。
- MCP server 名（`MCP_NAME`）必须在三处保持一致：`claude mcp add`、channel-server 注册、jsonl-watcher 的 tool 过滤前缀。它集中在 `src/bridge/config.ts` 和 `src/lib/claude-launch.ts`。
- Agent 名字在 create/resume 时走 shell 元字符黑名单校验，在 kill/restart 时宽松归一，以兼容历史 CJK 命名的 worker。
- Tool call 展示通过 `WATCHER_CONFIG.debounceMs`（默认 1500ms）去抖，避免在 tool 爆发时触发 Discord 限流。

## 贡献提示

- **发布流程**：commit 和 `git push` 到 `main` 可以自主执行。`git tag v*` + `gh release create` **每次都必须先获得 owner 明确同意** — 不要自己主动发 release。GitHub 上只保留最新一个 release，之前版本视为不兼容会被删除。
- `tmux-helper.ts` 和 `claude-launch.ts` 是 tmux 命令和 Claude Code 启动参数的**唯一权威位置**。新文件里不要再内联这些。
- 需要绕过 LLM 的管理按钮放到 `bridge/management.ts`。把 `id` 同时加到 `handleMgmtButton` 和对应的面板构造器。
- 提交前跑 `bun test`，并对每个入口都跑一次 `bun build src/<entry>.ts --target=bun`（`bridge`、`channel-server`、`manager`、`launcher`、`cron`、`setup`）快速抓类型错误。
- Cron 测试套件覆盖解析器和下次触发时间计算，但不跑真实 agent——集成测试在 sandbox Discord server 里手动做。
