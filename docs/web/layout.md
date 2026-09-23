# Web 客户端目录结构（逐文件说明）

> 2026-09-23 从 `web/CLAUDE.md` 原样搬出：每个会话都加载的那份文件要保持精简（`scripts/guard` 对它按字节棘轮）。下文的版本号与日期是历史，以代码为准。

## 目录结构

```
app/
  page.tsx              → redirect /chat
  chat/page.tsx         Chat 页面（<Chat/>）
  login/page.tsx        SSH 账号登录
  api/
    auth/{login,logout,me}/  鉴权（公开，自处理）
    agents/             GET 列表（代理 /api/v1/agents?include=stopped，master 置顶）；
                        POST 新建（代理 /api/v1/agents，fork 端点）
    agents/kill/        POST（代理 /api/v1/agents/:name/kill，fork 端点）
    agents/restart/     POST（代理 /api/v1/agents/:name/restart，fork 端点）
    chat/send/          POST（代理 /api/v1/agents/:name/messages，wait=0）
    chat/stream/        GET SSE（订阅 /api/v1/events → 按 agent 过滤 → 翻译成 WebStreamEvent）
    chat/history/       GET ?agent=（代理 /api/v1/agents/:name/history[/:sid]，live+归档）
    chat/clear/         POST（代理 /api/v1/agents/:name/clear，fork 端点）
    chat/interrupt/     POST（代理 /api/v1/agents/:name/interrupt，fork 端点）
    agents/settings/    GET/PUT per-agent 前端配置（init_message 开机指令，web SQLite）
    peers/              GET 清单 / POST {action} 分发（代理 /api/v1/peers*，peer 管理 UI 的 BFF）
    chat/permission/    POST（代理 /api/v1/agents/:name/answer kind=permission）
    chat/auq/           POST（代理 /api/v1/agents/:name/answer kind=auq）
    terminal/stream/    GET SSE 纯透传（代理 /api/v1/agents/:name/terminal?cols=&rows=，fork 端点；
                        浏览器断开→上游 abort→Bridge 销毁 PTY+viewer session）
    terminal/input/     POST {id,d:base64}（代理 /api/v1/terminal/:id/input，逐键/微批，Bridge 不限流）
    terminal/resize/    POST {id,cols,rows}（代理 /api/v1/terminal/:id/resize）
features/terminal/      远程终端（会话详情 🖥️ 按钮 → 实时镜像 tmux + 可输入）
  terminal-button.tsx   TopBar 入口（active 会话 + master 都有；stopped 隐藏）。形态分流：
                        窄屏(<sm) → hash 伪路由 #terminal 全屏页（左滑/返回键退出，同 #chat
                        导航栈）；宽屏 → 大模态框。⚠ 手机端别用模态框——软键盘 + daisyUI
                        居中模态是结构性冲突（塌陷/露背/背面可滚，真机两轮实测）
  terminal-page.tsx     移动端全屏页（createPortal + fixed inset-0 不透明底；软键盘时内容层
                        钉 visualViewport (top=offsetTop,h=height) + --term-safe-bottom 归零）
  terminal-modal.tsx    桌面模态框（无键盘逻辑）
  terminal-view.tsx     @xterm/xterm v6 + fit + webgl(尽力)；SSE 下行 base64 帧→term.write，
                        onData 8ms 微批+串行链→input POST（字节序），RO 防抖 150ms→resize POST。
                        连接延迟 50ms（dev 双 effect 取消传导 race，见 prin-645ac3）。
                        ?noWebgl=1 强制 DOM renderer（后台 tab 自动化验证用，WebGL hidden 不 paint）；
                        window.__claudestraTerm debug 句柄（读 buffer 验数据面）
  control-bar.tsx       控制键条（Esc/Tab/⇧Tab/方向/⏎/^C/^O + ⌨️ 聚焦唤软键盘；
                        onPointerDown preventDefault 防抢焦点收键盘）
                        ⚠ 滚动语义：CC TUI 在 alternate screen（无终端滚动缓冲，tmux pane
                        history 也为空）——看转录历史用 ^O（CC transcript 模式，可滚）；
                        viewer session 已开 tmux mouse（shell 场景滚轮进 copy-mode 可用）
features/devtools/      开发者模式：设置 → 实验 → 「开发者模式」或 URL `?dev=1`；右下角徽章（FPS · 最大
                        帧间隔 · 提交突发）点开 → 面板。⚠ 所有 dev-only 代码只能在这里，业务代码只留
                        isDevMode() / devCount() 一行接入点；打点经 lib/client-log 自动双写进面板；
                        提交突发从 layout.tsx 的 cstra:commit-burst 事件计数，produce 速率读 __cstraProduceTrail。
                        临时调参范式（先让用户在面板上拖，定稿再写死）见 docs/web-dev-mode.md
  dev-mode.ts           总开关：localStorage `cstra_devmode` + `?dev=` 解析（纯逻辑，bun test 覆盖）；
                        isDevMode() 同步读给热路径；不直接引用 window（根 tsconfig 无 dom lib）
  dev-events.ts         事件环（200 条）+ 计数器 + 每秒速率采样器；devEventFromLog 把 client.log 行的
                        `[tag]` 翻成 kind，壳/PWA 的运行时错误标成 error
  dev-registry.ts       分区注册表 registerDevSection(id, mount)：临时探针自己注册进面板
                        （调用上方 3 行内必须有 `dev-section: YYYY-MM-DD` 注释，tests/web-dev-sections 守卫）
  dev-mount.tsx         订阅开关 → next/dynamic 加载面板（stats.js / lil-gui 不进普通用户 bundle）；
                        打 html[data-dev]；window.__cstraDev 给控制台用
  dev-meters.ts         采样 hook：stats.js 三格（FPS / MS / 帧间隔）、rAF 最大帧间隔、输入到下一帧
                        （Safari 无 Event Timing → pointerdown→双 rAF 手测）、long task（Safari 无 → n/a）
  dev-panel-sections.ts 内置分区：性能 / 渲染基准 / Store / 视口（standalone / inner / visualViewport / 安全区实测 /
                        底部对齐线 / 元素轮廓——容器规则 6 那个反复手写的浮层）/ 动作
  bench-section.ts      渲染基准：rAF 步进把 #cstra-msgs 从顶滚到底，帧间隔 p50/p95/最大 + DOM/气泡数 + long task
                        → 一行结论进事件列表（docs/design-render-perf.md 阶段 0 的尺子，改渲染前后同口径对比）
  bench-stats.ts        上面那把尺子的纯统计（percentile / summarizeFrames / formatBench，bun test 覆盖）
  dev-overlay.tsx       面板壳：徽章 ↔ 面板、lil-gui 生命周期（注册分区变了整个重建）、事件列表。
                        portal 到 body，根元素 stopPropagation（portal 合成事件会冒泡到横滑手势）
features/chat/
  type.ts               ChatMessage / AgentSession / ToolCallView / PendingPermission / PendingAsk
  stream.ts             consumeSSEStream + processStreamEvent + StreamSink（协议 v1，迁移零改动）
  chat-store.ts         zenith 中枢（agents/messages/streaming + pendingPermission/pendingAsk；
                        openGen 门控历史加载，streamGen 门控流；createAgent/killAgent/restartAgent；
                        interrupt/resolvePermission/submitAsk/cancelAsk）
  components/           sidebar / new-agent-modal / message-list（permission-card + ask-question-card）
                        / composer（streaming 时出「停止」）/ chat(Provider)
lib/
  db/                   getDb + auth migration（数据根 ~/.claude-orchestrator/web/db）
  services/auth.service.ts  verifySSH(ssh2) + session CRUD
  api-auth.ts           isAuthed（cookie 或 x-api-key 双认证）
  chat/
    bridge-api.ts       /api/v1 客户端中枢：BRIDGE、Bearer 头、bridgeGet/bridgePost、
                        apiAgentName（__master__ ↔ master 映射）
    agents.ts           loadAgents（GET /api/v1/agents?include=stopped → AgentSession[]）
    events.ts           WebStreamEvent 前端协议 v1（tool/text/status/done/permission/ask…）
proxy.ts                Next16 proxy：只拦页面 cookie；API 由 handler 自守
```
