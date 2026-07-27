# Claudestra Web 客户端

[English](./CLAUDE.en.md) · **简体中文**

Claudestra 的 Next.js Web 前门（Discord 之外的第二入口）。可 PWA 安装、自托管 VAPID Web Push（零第三方账号）、多会话流式 Chat。

**2026-07-10 起数据面全面走多前端 API**（`docs/web-frontend-guide.md` +
`docs/design-multi-frontend.md`）：BFF 消费 Bridge 的 `/api/v1/*`（Bearer token）与
`/api/v1/events`（SSE），早期的 `/web/*` 网关与 web-hub 已删除。web 独有的那几个
端点（interrupt / AUQ 回传 / 生命周期 / Web-only 模式）都是在这套 API 上 additive 加的。

## 技术栈 & 端口

- Next.js 16 + React 19 + TypeScript + Tailwind 4 + daisyUI；状态管理 zenith（`@do-md/zenith`，复制式 `.packages/`）。
- 端口：**dev 33333 / 生产 3333**（避让 claude-os 的 22222/2222）。
- 运行时是标准 Node/npm（`npm run dev`），**独立于仓库根的 Bun 后端**（bridge/manager 那套）。两套依赖树互不干扰。

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

## 鉴权模型（复用 claude-os SSH/PAM + Bearer）

- 登录：`verifySSH` 连本机 SSH 校验账号密码 → 写 SQLite session → HttpOnly cookie `cstra_session`（7天）。
- 双认证 `isAuthed()`：浏览器 cookie session，或外部脚本 `x-api-key === INTERNAL_API_KEY`。
- **分层**：`proxy.ts` 只拦「页面」（无 cookie → /login）；API 路由各自在 handler 调 `isAuthed()`（遵 prin-475132；且 proxy 跑 edge 运行时读不到 `.env.local`）。
- cookie 名用 `cstra_session`（不是 claude-os 的 `cos_session`）——localhost 下 cookie 按 host 不按端口隔离，必须避名。
- **BFF → Bridge 的鉴权**：`CLAUDESTRA_API_TOKEN`（`.env.local`）。签发：
  `bun src/manager.ts token-add web-ui --agents '*,master' --force --terminal`（master 必须显式列，`"*"` 不含；
  `--terminal` 显式授予远程终端 = 宿主 shell 级访问，独立于 messaging scope，不加则 🖥️ 终端 403，chat/历史/中断照常）。
  BFF 在 server 端带 `Authorization: Bearer`，浏览器永不直连 3847，也天然绕开
  EventSource 不能带 header 的坑（guide §4.3）。

## 数据流（/api/v1 + /events）

会话 = 一个 claudestra agent。前端每打开一个 agent：先拉历史（`GET /api/chat/history`），
再建一条持久 SSE 流（`GET /api/chat/stream`）；`send` fire-and-forget（wait=0），输出经流回来。

- **列表**：`loadAgents` → Bridge `GET /api/v1/agents?include=stopped`。master 由 Bridge
  置入（token scope 显式含 master），前端映射为 `__master__` 置顶（👑 大总管，不显 kill/restart）；
  stopped agent 保留入口（历史经归档 API 仍可读——会话归档的意义就在这）。
- **发消息**：`POST /api/v1/agents/:name/messages {text, wait:0}` → 202。agent 离线 409。
- **流式**：BFF 订阅 `GET /api/v1/events`（fetch-based SSE，带 Bearer），按
  `agent ∈ {name, agent-name}` 过滤，把 BridgeEvent 翻译成前端 WebStreamEvent（协议 v1 不变）：
  `agent_status(thinking/done)→status/done`、`tool_start→tool(running)`（tool_done 不重复推卡）、
  `assistant_text→text`、`chat_message(out)→text`（reply() 的最终回复）、`question→ask`、
  `question_cleared→ask-cleared`（fork 事件）、`auto_deny→text(🚫)`。连流后补拉
  `GET /api/v1/agents/:name/pending` replay 挂起的 AUQ 卡（对应旧 web-hub 的 pendingInteraction）。
- **历史**：`GET /api/v1/agents/:name/history` 取 session 清单（mtime 降序，live+归档合并，
  对已 kill agent 有效）→ 最新 session 的尾部 300 条 → 映射 ChatMessage[]
  （compactSummary 跳过；system compact 线渲染成轻提示）。**BFF 不再直读 jsonl / registry。**
- **唤醒对齐 = cursor 差量同步（v2.16，Telegram getDifference 同构）**：全量加载时
  服务端附 `lastSeq`（合并气泡前最后一条原始记录的 jsonl 行号——不能用气泡 id 推，
  组内后续记录会被重复拉），chat-store 存游标 `{sessionId, lastSeq}`。回前台/点推送
  进入时 `syncDelta` 只拉 `?session=&after=` 差量（几条几 KB，8s 短超时+1s 快重试），
  视图重组 = 现有 h 气泡 + 差量 + 幸存乐观消息 + 直播保全（对账在 `survivingPending`，
  与全量共用）；**先差量后开流**（串行，防直播气泡被视图重组过滤），流不带 `since`
  （重放与差量必然重复）。BFF 差量分支先查清单做轮转检测（pinned≠newest →
  `rotated:true`）；轮转/差量超一页/连败 → 自动回退全量。跨境链路唤醒到上屏从
  ~14s 降到 ~0.5-2s（2026-07-28 实测追平 533ms）。
- **大总管**：Bridge 侧 `findApiAgent("master")` 特判（fork）——messages/history/interrupt/answer
  对 master 透明可用。master 没有 jsonl-watcher，实时只有 reply 的 `chat_message(out)` + done；
  历史从 jsonl 读所以带工具卡。

## 富交互（中断 / 权限卡 / AskUserQuestion 卡）

三者都「Bridge 事件下行 → 前端渲染卡片 → BFF 回传 fork 端点 → tmux 按键」，复用 Discord
侧同款 keystroke 逻辑（buildAuqKeystrokes / 权限 keySeqMap + 发键前 tmuxCapture 重验）：

- **AUQ**：`question` 事件（jsonl-watcher 检测，data.questions）→ ask 卡 →
  `POST /api/v1/agents/:name/answer {kind:"auq", action, selections[][]}`。应答后双侧
  （API/Discord 按钮）发 `question_cleared` 收卡；迟到订阅用 `/pending` 补拉。
- **中断**：streaming 时 composer 出「■ 停止」→ `POST .../interrupt` → C-c（master → master:0）。
- **清空会话（🧹）**：侧栏列表项按钮 → 确认弹窗（可编辑「开机指令」，per-agent 持久化
  在 settings 表）→ `POST .../clear`（Bridge 打原生 /clear + 后台轮转 sessionId/归档/
  watcher 重绑）→ 本地视图清零 → 开机指令非空则自动作为第一条消息发出（可见可审计，
  知识注入藏在指令文本里，产品层对图谱零感知）。master 可 clear 但无需开机指令
  （CLAUDE.md 自动重载）。⚠ CC 原生 auto-memory 跨 /clear 存活（原生行为）。
- **权限卡 ⚠ 已知缺口**：迁移后权限弹窗**事件下行暂缺**（permission-watcher 只面向
  Discord 且 web-only 模式未启动它）——卡片不会自动弹出；上行 `answer {kind:"permission"}` 保留
  （发键前 Bridge 重验弹窗在场）。agent 默认 bypassPermissions，此卡本就罕见。session-idle
  应答已随迁移移除。

## PWA 容器方案（真机踩坑收敛的不变式，勿单点改动）

> 完整通用版沉淀在用户知识库 `iOS-PWA-standalone-全屏容器与安全区避坑.md`。以下为本项目落点。

iOS standalone 的「铺满屏底 + 纹丝不动 + 安全区无缝」由这几件事共同构成（2026-07-10 六轮真机迭代收敛）：

0. **【真凶·最隐蔽】globals.css 里 html 千万别锁死高度**——`html,body{height:100%}` 会让
   iOS standalone 把 `position:fixed` 钳到「安全区内缩的短视口」，`fixed inset-0` 的 `bottom:0`
   **到不了真正屏底**（列表+会话底部都浮在安全区上方一截）。迷惑点：此时 `env()` 仍正常、容器每层
   `height` 也各自铺满 844——是短视口本身没到底。改用 **`body{min-height:100vh}` + html 不锁高度**
   （对齐 claude-os）即铺满。同理 html/body 别加 `overflow:hidden`（同样钳短视口）。
1. **应用壳根容器 `fixed inset-0 overflow-hidden`**（chat.tsx）**是锁滚动的全部**：出流 →
   body 无流内容 → 文档天然不滚；滚动只在内部 `overflow-y-auto`。⚠ 不要改回 in-flow `h-dvh`
   ——body 有 100dvh 流内容会被拖着微滚/橡皮筋、加载停偏移位，已证伪。
2. **安全区 padding 归各面板自己垫、带自身 bg**：TopBar/会话列表头 `env(safe-area-inset-top)`、
   composer/列表 footer 底部。⚠ 不放应用壳根层——根是 base-100，压在 base-200 列表上就是
   上下色差条（claude-os 把 pt-safe-top 放根层，正是它没解决的那个毛病）。
3. **底部一律 `max(env(safe-area-inset-bottom), 常规间距)` 不叠加**——home 条区本身够高，
   `env + 12px` 双层叠出「过高的底部」。
4. **画布色跟随当前面板**：iOS 给布局视口外/安全区条带涂「画布色」（body 设了 bg 用 body 的，
   否则用 html 的）→ body 一律不设 bg（layout.tsx），chat.tsx 按视图给 `<html>` 挂/摘
   `canvas-list` 类（globals.css：列表=base-200 / 会话=base-100），条带永远与所在页同色。
5. 改 viewport/manifest 后 iOS 需**删主屏图标重新添加**才生效（安装时缓存）。
5b. **模态框/任何 position:fixed 浮层必须 createPortal 到 body**——移动端会话页在
   transform 横滑容器内（chat.tsx translate-x），CSS 规定 transform 祖先成为 fixed
   的定位基准：容器内渲染 .modal 会整个定位到屏幕外一屏（点了「没反应」，返回列表
   时容器滑回弹窗才「突然出现」）。桌面 translate=0 复现不了，必须窄视口验证。
6. **排查方法**：别肉眼猜截图。塞临时诊断浮层读 `navigator.standalone`/`innerHeight`/探针
   `env()` 实测值，并在 `fixed bottom:0` 画条线看它到没到屏底——一张截图定位。
   图标重生成：`node scripts/make-icons.mjs`（sharp，manifest 在 app/manifest.ts）。

## 运行 & 排障

- **实际在跑的 launchd 服务**（`launchctl list | grep claudestra` 一看便知，别照抄记忆里的名字——
  这里曾长期写着 `com.claudestra.web-bridge` / `.web-launcher`，而那两个标签根本不存在，
  按它 kickstart 会拿到 exit 113）：
  - `com.claudestra.bridge` — 后端 Bridge（Web-only 模式也是它，只是不设 DISCORD_BOT_TOKEN）
  - `com.claudestra.web` — Next.js 生产服务（plist 必须 `exec ./node_modules/.bin/next start`，见下条）
  - `com.claudestra.launcher` / `com.claudestra.cron` — 后端守护，与 web 无关
  - `com.claudestra.tls-proxy` — Caddy 做 h2 TLS 终结

  改后端代码 → `launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge`（等 15-20s）；
  改 web 代码 → `cd web && npm run build && launchctl kickstart -k gui/$(id -u)/com.claudestra.web`。
- **⚠ 正式服务 `com.claudestra.web` 的 plist 必须 `exec ./node_modules/.bin/next start`，
  不能 `npm run start`**：npm 中间层被 kickstart 杀掉时子 next-server 可能成孤儿——它没有
  监听端口但推送派发器（出站 SSE+出站推送）还活着，每条推送必重复（2026-07-16 泄漏一个，
  用户连收 5 天双推送才发现）。兜底：dispatcher 有跨进程端口锁（127.0.0.1:3339，
  `PUSH_LOCK_PORT` 可调），任何进程组合下只有一个推送者；排障时 `lsof -iTCP:3339` 看谁持锁。
- 起 dev：`npm run dev`（已在跑别重开；探测 `curl localhost:33333`）。
- **⚠ 本机 shell 全局有 `NODE_ENV=production`**：用 `NODE_ENV=development npm run dev` 强制。
- **⚠ `INTERNAL_API_KEY` 全局导出会盖过 `.env.local`**：`env -u INTERNAL_API_KEY` 起 dev。
- **⚠ BRIDGE_HTTP_URL 必须用 `127.0.0.1` 不是 `localhost`**：Bridge 只绑 IPv4，localhost 的
  ::1 歧义会让 Node fetch 偶发 connect 10s 超时（"fetch failed"）。
- **⚠ /events SSE 空闲断流（已修）**：Bun.serve 默认 HTTP idleTimeout≈10s，早期的 30s ping
  活不到第一轮——事件间隙 >10s 的订阅者被静默掐掉。fork 已改为连接即发 `: connected` + 5s ping
  （bridge.ts handleEventsRequest）。流「偶尔收不到」时先查这里有没有被改回去。
- **⚠ turbopack 冷启动**：dev 重启后的头几个 API 请求可能 401/502（env/编译未就绪），刷新即好。
- **⚠ curl 验证 CSS 会看到陈旧 chunk**：turbopack dev 对静态 CSS chunk 不因 curl 请求重编译，
  新样式经 HMR 推给真浏览器/整页刷新才生效——「curl grep 不到新规则」≠ 没编译进去，先在浏览器里确认。
- cookie 7 天过期后页面自动跳 /login，重登即可。
- Next 16 冷知识：`_` 开头目录不路由；macOS 无 `timeout`，测 SSE 用 `curl --max-time N`。
