# Web 客户端目录结构（逐文件说明）

`web/` 是 Next `output: "export"` 的纯静态站：`npm run build` 产出 `out/`，由中继（`RELAY_STATIC_DIR`）或 bridge
（`BRIDGE_STATIC_DIR`）按导出布局发出（`src/lib/static-site.ts`），浏览器直接打 bridge 的 `/api/v1/*`。没有服务端目录，
没有 `app/api`。本文说每个目录 / 文件现在负责什么、为什么放在那里；请求与事件怎么流转见 [data-flow.md](./data-flow.md)。
设计依据是 `docs/design-hosted-frontend.md`（§4 配对、§5 凭据、§7 推送、§13 接口契约）。纯逻辑模块的测试在仓库根
`tests/web-*.test.ts`——bun test 直接编译 web 源码，所以这些文件不能依赖 dom lib 的类型（见各文件头注）。

## 目录结构

```
next.config.ts          output:"export"、images.unoptimized；turbopack.root 钉在 web/（否则扫进仓库根的 worktree 软链 panic）；
                        productionBrowserSourceMaps：client-log 里的错误栈要靠 .map 还原（scripts/resolve-stack.mjs）
scripts/gen-build-info.mjs   prebuild：commit / webCommit（最后一个动过 web/ 的非 .md 提交）/ 仓库版本 → lib/build-info.ts
                        （随 bundle 走，webpack 缓存随内容失效）+ public/build-info.json（托管方读它报 webCommit）。两份都 gitignore；
                        同目录 make-icons.mjs / make-native-assets.mjs / tls-proxy.ts 是图标、iOS 壳资源、本地 HTTPS 调试代理
app/                    全是客户端组件；静态导出没有服务端重定向，所有分流在浏览器里判
  layout.tsx            <html> 元数据、viewport-fit=cover、裸 <script src="/boot.js">（必须同步、先于 React）
  page.tsx              /：配过机器或 direct 模式 → /chat，否则 → /pair
  chat/page.tsx         /chat：<MachineGate><Chat/></MachineGate>
  pair/page.tsx         /pair：<PairScreen/>
  login/page.tsx        /login → /pair（带原 hash）；老书签与壳里存的地址还会指到这里，删了就 404
  join/page.tsx         /join：协作邀请确认页，邀请码在 #（或 ?i=web+claudestra:… 协议登记跳回）；未配机器由 MachineGate 送去 /pair?next=
  i/page.tsx            /i：邀请落地页 → /join#…；中继没配静态站时才画自己的落地页（src/relay/front.ts）
  manifest.ts           PWA manifest（force-static）：start_url /chat、protocol_handlers web+claudestra → /join?i=%s
  globals.css           Tailwind 4 + daisyUI 主题、.chat-domd 排版、canvas-list 画布色、hljs 配色
public/
  boot.js               React 之前同步跑的五段：主题 / 自定义 CSS 变量首帧落地、25s 启动看门狗（lib/i18n.tsx 挂载时置 __cstraMounted）、
                        iPad 壳键盘模式、卡顿 / 触摸丢失探针、React 提交突发探针；打点基址读 localStorage 镜像 cstra_api_base。
                        搬成静态文件是为了托管方能开 script-src 'self' 的 CSP——改回内联脚本页面起不来
  sw.js                 只做 Web Push：push 无条件展示 + badge；notificationclick 向发通知那台机器回 read / notify-read
                        （payload.fp → /m/<fp>，没有就读 IndexedDB meta.current），聚焦已有窗口 postMessage 或 openWindow
  icons/                PWA / apple-touch 图标（node scripts/make-icons.mjs）
lib/                    无 React 的共享逻辑（i18n.tsx 例外）
  app-config.ts         GET /app-config.json → {mode:"relay",relayBase,…} | {mode:"direct",fp,machineName,…}，只拉一次；
                        拉不到按 direct 单机兜底（fp=LOCAL_FP，否则 next dev 对着本机 bridge 没法用）。machineBase = "/m/<fp>" 或 ""
  machines.ts           MachineStore：IndexedDB `cstra` 库 machines 表 {fp,name,addedAt,lastUsedAt,principalId?}，不存凭据；
                        当前机器镜像到 meta.current（sw.js 读）与 localStorage cstra_api_base（boot.js / client-log 读）；
                        health repair = 凭据被拒；onSwitch 先于换当前触发（api/client.ts 借此中止旧机器的在途请求）
  pairing.ts            配对纯逻辑：`#<fp>.<secret>` 解析、短码整形、HMAC-SHA256 挑战应答（与 src/lib/pairing-codes.ts 同算法）、设备名、回环判定
  version-check.ts      bundleStale（优先比 webCommit，拿 HEAD 比会让只改 src/ 的提交也亮黄字）/ machineTooOld（apiVersion）/ clientTooOld（minClient）
  build-info.ts         @generated（gitignore）：CLIENT_COMMIT / CLIENT_WEB_COMMIT / CLIENT_VERSION
  client-log.ts         前端 → 当前机器 client.log 的唯一出口（同时喂 devtools 事件环）；iOS 没有 console，事故取证只有这条时间线
  native.ts             Capacitor iOS 壳识别与插件句柄（ServerConfig / Keyboard / StatusBar / SplashScreen）；web 不打包 @capacitor
  i18n.tsx i18n-dict.ts 中文原文即 key；lang 存 localStorage cstra_lang（缺省看 navigator.language），切换时同步到 bridge /settings
  theme.ts css-pref-store.ts theme-vars(-parse).ts font-prefs(-parse).ts chat-prefs(-parse).ts
                        按设备存的外观偏好：*-parse 是无 import 的纯函数，store 把预生成 CSS 写进 localStorage 供 boot.js 首帧注入
  tap-rescue.ts keep-in-viewport.ts   WebKit 抬手后节点变了不派 click 的合成兜底；弹层不出屏
  api/                  唯一允许写 fetch("/api/…") 的地方（client.ts 之外仅两处刻意绕开：devices.ts codeLookup 打中继同源、
                        system.ts postClientLogLine 要 keepalive）
    client.ts           api / apiRaw / apiStream：基址 = machineBase(显式或当前机器)，credentials:"include"，非 GET/HEAD 自动加
                        x-cstra-device: 1；超时 GET 15s / 其它 60s / 0=SSE。发出时捕获目标机器进 inflight 表：切机器 abort、
                        中继模式响应回来机器已换则抛 machine_switched；401 → machines.markRepair + DeviceInvalidError
    agents.ts           create / kill / restart / remove / archive / pi-update / resume、runtimes、模型目录与切换
    chat.ts             sendMessage（JSON 或 multipart，wait=0）、interrupt、clear、answerPermission / answerAuq、skills、tasks、搜索、hidden
    history.ts          fetchHistory（全量 / after 差量 / before 翻页 + 跨 session 拼接）、隐藏区间 10s 缓存、selfIds（whoami 按机器缓存 5 分钟）
    stream.ts           openAgentEventStream：订阅 /events(?since=)，本地按 agent 过滤、翻译成协议 v1、连流补拉 /pending /bg-tasks，
                        重新编码成 `data: <事件+eid>` 字节流，心跳转 [DONE]
    devices.ts          challenge / pair(proof|code) / pair/status / local / codes/lookup / devices 列表与撤销；每个调用显式传 {fp}
    push.ts             VAPID 公钥（relay 取 app-config，direct 问 /push/config）、订阅增删、markRead（read + notify-read）、reads、APNs
    settings.ts         /settings /profile /skills/prefs /config/claude-defaults /auto-compact /memory-hygiene /update/*：形状还原成组件既有 props
    system.ts           /host、/stats、/relay/*、/remote-access、peers / cron / projects 分发、会话清单与归档、后台任务、转写、client-log
    terminal.ts         terminalStream（SSE）/ terminalInput / terminalResize；grant 缺 terminal 则 403
    version.ts          fetchVersion（relay 读 app-config；direct 问 /version）与 fetchMachineVersion（永远问当前机器：apiVersion / minClient）
  chat/                 协议与纯变换（lib → features 单向，这里不许 import features）
    events.ts           WebStreamEvent 协议 v1（tool / text / reply / done / ask / bg-* / compact / telemetry…）+ AnchoredStreamEvent.eid
    stream-shape.ts     BridgeEvent → WebStreamEvent 翻译表、agentNameVariants、pendingEvents / bgReplayEvents、frameData
    history-shape.ts    中性记录 → ChatMessage：同回合连续 assistant 合成一泡、按钮点击 payload 回填 label、附件剥离、
                        「哪条是我发的」= selfIds（api:<principalId>，owner 缺省 api:owner:self，加 whoami.ownerIds）
    agents.ts           loadAgents（/agents?include=stopped，master 置顶为 __master__）、apiAgentName / uiAgentName
    attachments.ts      附件标记解析与 /api/v1/attachments/<name> URL；attachment-name.ts 与 src/lib/attachment-name.ts 逐字一致
    inline-buttons.ts   `[[{#id .style}label]]` 行内按钮微语法——与 src/lib/inline-buttons.ts 逐字节一致（twin，parity 测试钉住）
    reply-clicks.ts     reply 组件按行独立作答的 rowKey / 历史还原
  push/client.ts        Web Push 订阅 / 退订 / 跨端已读补清（一个 origin 一份订阅；换公钥先退订）；push/native.ts 是壳的 APNs 版
features/machines/
  use-machines.ts       bootMachines()：拉配置 → 注入基址算法 → 装清单，整站只跑一次；useMachines() 快照 {list,current,health,multi}
  machine-gate.tsx      /chat /join 的门：direct 自动补唯一机器；relay 无机器 → /pair?next=；当前机器 repair 时压「重新配对」横幅
  machine-switcher.tsx  顶栏切机器（relay 且 ≥2 台才出现）：machines.setCurrent → 中止旧机器请求 → chat-store.resetForMachine
  use-version-check.ts  回前台且 ≥60s 一查 → {stale, machineOld}（update-toast 消费）；use-version.ts 只拉一次做署名
features/pair/          pair-flow.ts 三条流程的编排（无 React）→ use-pair-flow.ts 阶段状态机 → pair-screen.tsx 表单 / 等待卡
features/chat/          Chat 本体；无 React 的纯逻辑单独成文件，都有 tests/web-*.test.ts
  type.ts stream.ts     ChatMessage / AgentSession / PendingAsk…；StreamSink + processStreamEvent + consumeSSEStream
  chat-store.ts         zenith 中枢（只许缩）：openGen 门控历史、streamGen 门控流；send / postSend；openStream 的 10s 握手超时、
                        25s 无字节看门狗、1s→10s 退避重连；resetForMachine；DeviceInvalidError 时停止自动重连
  reconnect-policy.ts   maybeReconnect 的决策纯函数：skip / probe / fast(?since) / delta(after=游标) / full
  view-compose.ts       历史到达时「历史 + 幸存乐观消息 + 直播回合」重组视图（loadMessages 与 syncDelta 共用）
  live-merge.ts         直播 ↔ 历史判重按 {sid, seq}（coveredByCursor / pruneLiveBubbles）；无 seq 的老事件退回时间戳规则
  history-hydrate.ts    wire 上只发 segments，这里派生回 content / toolCalls / replyText
  send-dedupe.ts        同 agent 同载荷 1.5s 内只发一次；去标点空白后相同 5s
  其余 *.ts             侧栏排序 / 菜单 / 拖拽 / 分享导出 / 草稿 / 旁白折叠 / 邀请 / 主机信息 / 模型目录 / 时间格式 / 滚动吸底 /
                        选择模式 / slash 匹配 / 键盘视口……各自文件头写明职责与对应测试；boot-report.ts 在 agents 首次就绪时打 [boot] 计时
  components/
    chat.tsx            应用壳（fixed inset-0）：注册 /sw.js、SW message → openAgent、?agent= 深链、visibility / focus / pageshow /
                        cstra-resume → maybeReconnect + refreshAgents（15s 轮询）、7s reconcileVisibleChat、未读 → 标题与角标
    sidebar.tsx         会话列表 + MachineSwitcher + 版本署名 + 未纳管 / 归档分区；agent-row / agent-menu / agent-dnd / project-group 是零件
    message-list.tsx    消息渲染：tool-rows / progress-note / narration-fold / msg-time / seg-groups / reply-components /
                        permission-card / ask-question-card / attachments 都挂在这里
    auth-img.tsx        API 附件带凭据取：fetch → blob → object URL（中继模式要拼机器基址，不能直接 <img src>）
    composer.tsx        输入框（附件、语音转写、slash 面板、引用、草稿）；update-toast.tsx「新版本已就绪 · 点击刷新」/「这台机器需要升级」胶囊；
                        splash.tsx 全屏启动页；install-banner / push-banner 引导
    settings-modal.tsx + settings/   八页：general（push-section）/ sessions / appearance（theme-vars / font / chat-prefs）/ connect
                        （remote-access、壳内 shell-server）/ peers / security（devices-section：本机器已配对设备 + 本浏览器的机器清单）/ labs / claude
    其余 *.tsx          manage-panel / peers-* / cron-modal / projects-modal / stats-panel / unmanaged-sessions / archived-sessions /
                        bg-task-panel / cc-task-panel / skills-sheet / session-search / share-dock / share-ui / invite-intake；
                        responsive-shell / nav-context / centered-modal 是浮层与导航基建
features/terminal/      terminal-button（入口：窄屏 #terminal 伪路由全屏页 terminal-page，宽屏 terminal-modal）、
                        terminal-view（xterm v6 + fit + webgl 尽力；SSE 下行 → term.write，onData 8ms 微批串行 POST，RO 防抖 resize）、control-bar
features/devtools/      开发者模式（?dev=1 / 设置 → 实验）。dev-only 代码只能在这里，业务代码只留 isDevMode() 一行；见 docs/web-dev-mode.md
components/domd/        助手 markdown 的 do-md 只读封装：index.tsx（行内规则 = 默认集 + 行内按钮 / chip）、inline-button.tsx、normalize-md.ts、prism.ts
```

## 放置规则（改动前先看）

- **web 与 src 互不 import。** 两边都要的逻辑只能做 twin（`inline-buttons.ts`、`attachment-name.ts`），在 `scripts/guard/config.ts`
  登记并有 parity 测试；改一边不改另一边 guard 直接红。
- **lib 只 import lib**；`lib/chat/*` 不许引 `features/*`（`attachments.ts` 自己声明 AttachmentView 就是为此）。
- **所有 HTTP 请求经 `lib/api/client.ts`。** 新端点加到 `lib/api/<域>.ts` 做形状包装，组件不写 fetch；否则切机器时在途请求不会被中止、
  401 也不会变成「重新配对」横幅。
- **机器相关的状态都挂在 fp 上**（缓存键、请求、SW 回执）。异步完成后再读 `machines.currentFp()` 的写法会在切机时把数据落错机器。
- `chat-store.ts` / `chat.tsx` / `message-list.tsx` / `composer.tsx` 在 guard 基线里只许缩：新能力先写成独立模块（纯逻辑 + 测试），大文件只留一行调用。
- 只在 `out/` 里存在的东西（`build-info.json`、`_next/static`）由托管方按 `src/lib/static-site.ts` 服务：HTML 永不长缓存、
  `_next/static` 永久缓存。改导出布局要中继与 bridge 两边一起验。
