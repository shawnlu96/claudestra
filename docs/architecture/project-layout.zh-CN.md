# 项目结构（逐文件说明）

> 2026-09-23 从 `CLAUDE.zh-CN.md` 原样搬出：每个会话都加载的那份文件要保持精简（`scripts/guard` 对它按字节棘轮）。下文的版本号与事故记录是历史，以代码为准。

## 项目结构

```
src/
  bridge.ts              主入口：Discord client、WebSocket server、事件分发、slash 命令
  bridge/
    router.ts            v2.0.0+ Envelope/Endpoint 类型 + parseAddress + threadId 助手；v2.6.0+ parseChatId（带 transport 前缀的统一 chat_id 键空间）+ ApiUserEndpoint
    adapters.ts          v2.6.0+ ChatAdapter 接口 + 注册表（出站按 transport 分发，Discord 是第一个 adapter）
    event-bus.ts         v2.6.0+ 进程内事件总线（seq + 每 agent 环形缓冲，tool 调用/文本/状态 → SSE 事件流）
    config.ts            共享运行时常量
    components.ts        Discord UI 组件 + typing indicator
    discord-api.ts       Discord API 封装（建/删频道、编辑消息等）
    management.ts        管理按钮/菜单的直接执行处理器（绕过 LLM）
    screenshot.ts        终端截图流水线（ANSI → HTML → PNG）
    jsonl-watcher.ts     JSONL session 监听 → 流式 tool call 摘要 + assistant 文本流 + Stop 时同步 drain
    slash-catalog.ts     CC 内置 slash 命令的硬编码清单（挑了 Discord 上好用的那批）
    slash-registry.ts    运行期发现的 skill 注册表（按 scope）+ 每频道解析器
    wedge-watcher.ts     检测卡死 >30min 且非空闲的 agent → Discord 告警；v2.7+ 链路哨兵（窗口活着但 channel-server 掉线 >5min → 修复按钮）；v2.14+ 告警同时推 `session_anomaly(kind=link_down)`，web 端也看得到
    sessions-inventory.ts v2.7+ 机器级中立会话清单：`claude agents --json` + jobs 状态 + registry 对账 → 分身检测
    session-reconciler.ts v2.7+ 每 10 分钟后台对账：发现新分身 → Discord 告警带清理/收编按钮 + session_anomaly 事件
    bg-activity-watcher.ts v2.8+ 后台活动追踪：按 agent 会话发现 subagent jsonl 与后台 shell 输出 → 流进各自的子区（ChatAdapter.provisionThread）+ bg_task_* SSE 事件；v2.14+ Web 来源的回合只发事件不建子区
    archive-sweeper.ts   v2.9+ 每日归档兜底：每 24h 给所有活跃 agent 的会话 jsonl 做快照（幂等 copy-if-larger）——补上崩溃/从未退役这些退役时归档覆盖不到的缺口
  channel-server.ts      每个 session 的 MCP 代理（stdio MCP ↔ Bridge WebSocket）
  manager.ts             Agent 生命周期 + 定时任务 + 版本/更新 CLI（JSON 输出）
  cron.ts                定时任务调度守护进程（launchd 管理）
  launcher.ts            大总管 tmux session 守护（launchd 管理）
  setup.ts               交互式安装向导
  hooks/
    typing-hook.ts       Claude Code Stop/Notification hook → Bridge HTTP 端点
    recall-hook.ts       v2.21.5+ SessionStart hook：把本项目 HANDOFF.md + `~/mem0-mcp/recall.py` 的输出（mem0 顶层召回）注入开场 context；永远 exit 0，10s 上限
  lib/
    bridge-client.ts     共享 Bridge WebSocket 请求封装
    tmux-helper.ts       共享 tmux 命令封装（tmuxRaw, isIdle, sendLine, …）
    claude-launch.ts     统一 Claude Code 启动命令构造（flags, MCP_NAME, shell 转义）
    config-store.ts      运行期配置 ~/.claude-orchestrator/config.json（自动更新开关、语言）
    skills.ts            SKILL.md 发现——user / plugin / project 三个来源 + 硬编码的原生命令
    jsonl-cost.ts        解析 ~/.claude/projects 的 JSONL → 按模型汇总 token
    peers.ts             peers.json 数据模型（v2.11+ 只剩 HTTP peer）+ 握手串编解码 + 原子写
    principals.ts        v2.6.0+ API token 身份/scope/限流（~/.claude-orchestrator/principals.json）
    doctor.ts            v2.14+ 只读安装体检，`manager.ts doctor` 的实现（运行时/配置/daemon/bridge/MCP/agent）
    link-policy.ts       v2.14+ channel-server 被 bridge 顶替后该重连还是退出——纯函数，有单测
    session-recall.ts    v2.21.5+ 召回 hook 的纯逻辑：Claude Code 项目 slug / HANDOFF.md 路径 / 幂等合并 SessionStart hook 进 ~/.claude/settings.json（本机有 recall.py 才注册）
    net-addr.ts          v2.14+ 探测本机对外地址（Tailscale CGNAT 优先，其次 RFC1918），peer 握手 `--url` 的来源
    registry.ts          v2.9+ registry.json 唯一读取器（字段归一含 cwd/dir 兼容）；写入仍只归 manager.ts
    projects.ts          v2.21+ project 数据模型（~/.claude-orchestrator/projects.json）：dirs[] + 按目录归属解析 + id slug；写入只归 manager.ts，bridge 只读
    bg-jobs.ts           v2.7+ bg job 清理配方：杀进程 → 等 daemon 静默 → 隔离目录 → respawn 时 roster 根治（v2.9.1：daemon 的 ~/.claude/daemon/roster.json workers 花名册才是 respawn 权威依据 —— 无其他 worker 受累时 kill worker + transient daemon 并删条目）
    baseline-keys.ts     v2.22.x bg-activity-watcher 的重启防重放作用域:按 agent×session 记首次进入监视(进程级单标志会把晚进入的 agent 存量 subagent 全量重播成「运行中」,2026-09-07 peer 报 109 张幽灵卡)
    reply-nudge.ts       v2.22.x Stop hook「补 reply」拦截规则:该 agent ws 上仍挂着未回复的请求 → 回 {block, reason} 让 Claude Code 续跑一次去调 reply(stop_hook_active / 已拦过 / 刚投递 <500ms 不拦)
    session-archive.ts   v2.8+ 会话退役归档：kill/fork 换代/adopt/resume 换 session 时快照 jsonl 到 ~/.claude-orchestrator/archive/<agent>/（对抗 CC cleanupPeriodDays）
    session-history.ts   v2.9+ 只读历史解析：live + 归档 jsonl → 中性分页消息，支撑 GET /api/v1/agents/:name/history
  ansi2html.ts           ANSI 转义码 → 彩色 HTML
  html2png.ts            HTML → PNG（Playwright headless Chromium）
  discord-reply.ts       Bash fallback：通过 Bridge 直接发消息
master/
  CLAUDE.md.template     大总管行为指令模板（setup.ts 渲染）
  CLAUDE.md              渲染后的本地副本（gitignored）
tests/                     只覆盖纯逻辑（实时数量以 `bun test` 为准）；bridge.ts 本身没有隔离单测
                           （Discord client + ws + peers.json 耦合太重），那部分靠沙箱会话实测兜底
  agent-stats.test.ts      按 agent 的用量汇总，compact 感知
  ask-user-question.test.ts TUI 里的 AskUserQuestion 识别 + 按键合成
  bg-jobs.test.ts          Claude Code bg job 清理配方（roster 根因修复）
  baseline-keys.test.ts    v2.22.x bg-activity baseline 作用域:同 agent-session 只 baseline 一次、换 session 重新 baseline、prune 按 agent 名
  reply-nudge.test.ts      v2.22.x Stop hook 补 reply 拦截:只拦 Stop、stop_hook_active 不拦、一次为限、挑最老
  claude-launch.test.ts    启动 flag 构造：权限模式、effort、模型别名
  cron.test.ts             Cron 解析器 + 调度器
  doctor.test.ts           v2.14+ 安装体检：daemon 退出码判定 + 报告排版
  event-bus.test.ts        v2.6.0+ seq 单调性、每 agent 环形缓冲、订阅者互不影响
  http-peer.test.ts        v2.11+ HTTP peer 握手串编解码 + 回复提取
  jsonl-cost.test.ts       JSONL token 用量汇总
  link-policy.test.ts      v2.14+ channel-server 被顶替后怎么办——「stdio 活着就绝不退出」
  modal-parser.test.ts     tmux modal 识别
  net-addr.test.ts         v2.14+ 对外地址探测：CGNAT/RFC1918 边界、绝不返回回环
  permission-watcher.test.ts 权限弹窗身份识别（去重键）
  principals.test.ts       v2.6.0+ token 签发 / scope / 限流 / 终端授予
  principals-snowflake.test.ts v2.14+ Discord ID 校验——占位符变成 principals.json 里
                           永久假 owner 的链路上唯一的把关点
  registry.test.ts         v2.9+ registry 字段归一（cwd/dir 兼容）
  router.test.ts           v2.0.0+ Envelope / Endpoint / parseAddress / makeResponseEnvelope
  session-archive.test.ts  v2.8+ copy-if-larger 快照语义
  session-history.test.ts  v2.9+ jsonl → 中立消息：reply 提取、meta 过滤、翻页
  session-recall.test.ts   v2.21.5+ 项目 slug、HANDOFF 路径、SessionStart hook 合并/移除的幂等性
  sessions-inventory.test.ts v2.7+ 分身检测 / 会话对账
  skills.test.ts           SKILL.md 发现
  slash-registry.test.ts   slash 命令注册表的按频道解析
  stats-resets.test.ts     用量窗口重置检测
  web-gateway.test.ts      v2.13+ ws 控制面的跨源判定（drive-by RCE 防护）
install.sh               一键安装脚本
SETUP.md / SETUP.zh-CN.md    面向用户的安装指南
```
