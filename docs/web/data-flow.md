# Web 客户端数据流（完整版）

浏览器直接打 bridge 的 `/api/v1/*`，中间没有服务端。一个浏览器 × 一台机器 = 一条 HttpOnly cookie `cstra_dev`
（bridge 签发；中继模式 `Path=/m/<fp>/`，直托管 `Path=/`），JS 拿不到。会话 = 一个 claudestra agent。
文件职责见 [layout.md](./layout.md)；接口形状以 `docs/design-hosted-frontend.md` §13 为准。

## 启动：app-config → 机器 → 版本

1. `public/boot.js` 先于 React 同步跑（主题首帧、25s 看门狗、探针），打点基址读 localStorage 镜像 `cstra_api_base`。
2. `bootMachines()`（整站一次）：`GET /app-config.json`（no-store、不带 cookie）→ `{mode:"relay", relayBase, …}` 或 `{mode:"direct", fp, machineName, …}`，
   拉不到按 direct 单机兜底（`fp="local"`）；给 `MachineStore` 注入 `machineBase`（relay `/m/<fp>`，direct `""`），从 IndexedDB 装清单。
3. `MachineGate`：direct → 清单里没有这台就补一条并设为当前；relay 且一台都没有 → `/pair?next=<原地址含 #>`。就位后才渲染 `<Chat/>`，
   否则 store 一开机就会打没有基址的请求。`Chat` 挂载：`GET /agents?include=stopped`、`GET /profile`、注册 `/sw.js`、按 `cstra_last_agent` 恢复会话。
4. 版本比对（`use-version-check.ts`，回前台且 ≥60s 一查）：`fetchVersion`（relay 用 app-config 的 webCommit / commit，direct 问 `/version`）与烤入
   bundle 的 `CLIENT_WEB_COMMIT` / `CLIENT_COMMIT` 比 → `stale`；`fetchMachineVersion` 永远问当前机器 `/version`：`apiVersion < 1` 为 `machineOld`，
   `minClient` 高于本 bundle 也算 `stale`。`update-toast.tsx` 空闲时浮胶囊：stale →「新版本已就绪 · 点击刷新」（`fetch(cache:"reload")` +
   `?_v=<commit>` 导航，`location.reload()` 拿不到新 bundle）；machineOld →「这台机器需要升级」，刷新解决不了所以不给按钮。
   webCommit 由托管方读 `out/build-info.json` 报出——比的是正在发的 bundle，不是托管方的 git HEAD。

## 配对（`/pair`，`features/pair/`）

三条路都以 `finishPairing` 收尾：机器进清单（带 `principalId`）、设为当前、跳 `?next=`（只认站内路径）或 `/chat`。
配对请求都显式传 `{fp}`——机器还不在清单里。

- **二维码 / 链接 `#<fp>.<secret>`**：`GET /m/<fp>/api/v1/devices/pair/challenge` → 浏览器算 `base64url(HMAC-SHA256(secret, challenge))` →
  `POST …/devices/pair {proof, deviceName}` → 200 + Set-Cookie + `{fp, machineName, principalId, grant, …}`。秘密只在 `#` 里，不经中继、不出浏览器。
- **手输 8 位短码**：relay 先 `POST /api/v1/codes/lookup {code}`（中继同源、无基址、限流）拿 fp，direct 跳过；`POST …/devices/pair {code, deviceName}`
  → 202 `{approvalId}`；每 1.5s `GET …/devices/pair/status?approval=` 轮询 ≤10 分钟：202 继续、200 = Mac 侧点头发了 cookie、410 = 拒绝 / 过期。
- **本机回环一键**（direct 且 hostname 是 localhost / 127.0.0.1 / ::1）：配对页点按钮才发 `POST /devices/local {deviceName}`（开机不自动发）；bridge 只认真实回环 socket，隧道进来 403。回 202 就显示展示码、轮询 `/devices/pair/status`（凭 bridge 种的 HttpOnly 领取 cookie，只有这个浏览器取得走），等已配对的全权设备在侧栏横幅里批准；点取消或离开配对页会 `POST /devices/local/cancel` 作废这条待批。

老链接 `#<短码>` 自动填进短码框走第二条路；`/login` 只是跳 `/pair`。

## 一次普通 API 请求（`lib/api/client.ts`）

`api(path, init, machine?)`：基址 = `machineBase(cfg, machine?.fp ?? 当前机器)`；`credentials:"include"`；非 GET/HEAD 加 `x-cstra-device: 1`
（缺了 bridge 回 403 `csrf`）；超时缺省 GET 15s / 其它 60s，`0` = 不限（SSE）。每个请求**发出时**捕获目标机器并登记进 inflight 表：

- **切机器**：`machines.setCurrent` 先触发 `onSwitch` → `abortMachineRequests(prevFp)` 中止旧机器全部在途请求（含 SSE）；响应回来时当前机器已换
  → 抛 `machine_switched` 不交付（显式传 `machine` 的配对请求除外）。随后 `chat-store.resetForMachine()` 断流、清空 agents / messages / 快照 / 游标重拉。
- **401**：一律算凭据无效 → `machines.markRepair(fp)` + 抛 `DeviceInvalidError`；`MachineGate` 的横幅统一提示「重新配对」（不清机器、不跳转，
  别的机器还能用），`chat-store` 收到它就停止自动重连；配对成功 `machines.add` 清 repair。
- **非 2xx**：`ApiError{status, body, code}`；`retryable` = body.retryable 或 503（链路重连中，调用方退避重试而不是报「已断开」）。
- 附件 `/api/v1/attachments/<name>` 由 `auth-img.tsx` fetch 成 blob 再用 object URL——中继模式要拼机器基址，不能直接 `<img src>`。

## 聊天流

**打开 agent**（`chat-store.openAgent`）：断旧流、`openGen++`、有缓存快照先秒开 → `loadMessages` → `openStream`；打开即 `POST /agents/:name/read`（跨端已读）。

- **历史**（`lib/api/history.ts` → `lib/chat/history-shape.ts`）：`GET /agents/:name/history` 取 session 清单（mtime 降序，live + 归档）→ 最新 session
  `…/history/:sid?limit=500`（轮转竞态时依次试最新 3 个）→ 剔掉 `/agents/:name/hidden` 的隐藏区间 → `toChatMessages` 把同回合的连续 assistant 记录
  合成一泡、按钮点击 payload 回填 label。「哪条是我发的」= `api:<principalId>`（owner 缺省 `api:owner:self`）+ `GET /whoami` 的 ownerIds（按机器缓存 5 分钟）。
  全量加载记游标 `{sid, lastSeq}`（合并前最后一条原始记录的 seq，不能用气泡 id 推）；唤醒时 `syncDelta` 只拉 `?after=<lastSeq>&limit=300`，
  轮转 / 超一页 / 连败回退全量；`before=` 向上翻页，翻空自动接更旧 session 的尾页。
- **流**（`lib/api/stream.ts` → `lib/chat/stream-shape.ts`）：`apiStream("/events?since=<eid>")` 是一条对 bridge 事件总线的 fetch-SSE（bridge 连上先发
  `: connected`，之后 5s 一 ping）。本地按 `agent ∈ {name, agent-name}` 过滤、翻译成协议 v1（`agent_status → status/done`、`tool_start → tool`、
  `assistant_text → text`、`chat_message(out) → reply`、`chat_message(in) → user-in`、`question → ask`、`bg_task_* → bg-*`），每条带 `eid = bridge seq`
  供断点重放；连流即补拉 `/agents/:name/pending`（thinking / compacting / 未答 AUQ）与 `/bg-tasks`；心跳转 `[DONE]`。`openStream` 有 10s 握手超时、
  25s 无字节看门狗；`reader.cancel()` 不关 iOS 底层连接，一律 `AbortController.abort()`；自然断流按 1s→10s 退避走 `maybeReconnect({fast:true})`。
- **重连决策**（`reconnect-policy.ts` 纯函数）：900ms 风暴地板（force 300ms）→ 同 agent 历史在飞 <25s 让路 → 历史浏览模式不动 → 流 30s 内有字节视为
  健康只布 12s 探针 → 短暂离开 <5min 且有 eid 走 `fast`（只重连流带 ?since）→ 有游标走 `delta`（**先差量后开流，串行；流不带 since**，否则重放与
  差量重复）→ 否则 `full`。force（点推送 / 重点当前会话）必须绕开 fast 与 delta：只有全量能补回 bridge 重启纪元切换后的静默缺口。
- **直播 ↔ 历史判重**（`live-merge.ts` / `view-compose.ts`）：watcher 事件带 `{seq, sid}`，游标说「≤ lastSeq 都已在历史里」——事件后到 `coveredByCursor`
  不画，事件先到则差量 / 全量应用时 `pruneLiveBubbles` 按 seq 剥掉；reply 段（bridge 直投无 seq）看历史里有无同文；没 seq 的老事件才退回时间戳 ±5s。
  每 7s `reconcileVisibleChat` 在回合中途流僵死时静默补差量。别再按时间戳猜重复。
- **发送**（`chat-store.send` → `lib/api/chat.ts`）：`send-dedupe` 闸（同 agent 同 wire 1.5s、去标点后相同 5s）→ 乐观用户气泡（按钮点击展示 label
  实发 `wire`）→ `POST /agents/:name/messages`：无附件 JSON `{text, wait:0}`（20s），有附件 multipart `text / wait / files[]`（60s，bridge 落 inbox 并注入
  `[attachment: 路径]`）。`retryable` / 503 退避重试最多 5 次；失败气泡标「未送达」留 File 给重发；`{slash:true}` = tmux 直通无回合，撤乐观气泡换系统线。
  输出经已打开的流回来，`user-in` 回声按归一化文本对账去重。
- 中断 / 权限卡 / AUQ：`POST /agents/:name/interrupt`、`POST /agents/:name/answer {kind:"permission"|"auq", …}` → bridge 打 tmux 键序列。
  权限卡下行暂缺（permission-watcher 只面向 Discord）。

## 终端（`features/terminal/`，`lib/api/terminal.ts`）

`apiStream("/agents/:name/terminal?cols=&rows=")` 一条 SSE：`{t:"open", id, cols, rows, wcols?, wrows?}` 给 termId 与 tmux window 实际尺寸（手机按它 resize
xterm 再自适应字号）、`{t:"o", d:base64}` → `term.write`、`{t:"resize"}`、`{t:"exit"}`。上行 `term.onData` → 8ms 微批 → **串行 promise 链**
`POST /terminal/:id/input {d:base64}`（并发 fetch 不保序）；ResizeObserver 防抖 150ms → `POST /terminal/:id/resize`，bridge 按 tmux 尺寸 clamp 后回真值。
15s 无字节 abort；可见时断到 error / exited 自动重连一次，回前台也重连。浏览器断开 = 流 abort → bridge 销毁 PTY 与 viewer session，
没有显式 close。grant 缺 `terminal` 则 403。

## 推送

- **订阅**（`lib/push/client.ts`，必须在用户手势里）：注册 `/sw.js` → `Notification.requestPermission` → VAPID 公钥（relay 取 app-config 的
  `vapidPublicKey`——中继是推送网关，用自己的私钥签名投递；direct 问 `GET /push/config`）→ 先退掉残留订阅（同一 registration 不能换 key 订）→
  `pushManager.subscribe` → `POST /push/subscriptions {subscription, userAgent}` 交给**当前机器**。一个 origin 一份订阅，relay 下每台已配对机器各自收一份。
  关闭 = `DELETE /push/subscriptions {endpoint}` + `unsubscribe`。原生壳走 Capacitor APNs，token 经 `POST /push/apns` 登记。
- **到达**（`public/sw.js`）：payload `{title, body, url, tag, agent, ts, type, fp, badge}`；无条件 `showNotification`（iOS 对「到达不展示」有惩罚），
  `badge` 同步 App 角标，`type:"dismiss"` 只关同 agent 的旧通知。
- **点击**：向发通知那台机器 `POST <base>/api/v1/agents/:agent/read` + `notify-read`，base 取 payload 的 fp（`/m/<fp>`），没有就读 IndexedDB `meta.current`；
  SW 的 fetch 自动带 cookie，头里手写 `x-cstra-device: 1`。然后聚焦已有窗口并 `postMessage {type:"cstra-open-agent", agent, fp}`（`chat.tsx` 原地
  `openAgent`），没有窗口 `openWindow(url)` → `/chat?agent=` 深链。
- **已读补清**：打开 / 回前台 `GET /reads` → 关掉本机通知中心里别处已读的存量通知（iOS 收不到 dismiss push，这是唯一通路）。

## 设备管理 / 退出（设置 → security，`settings/devices-section.tsx`）

`GET /devices`（要 `grant.manage`，否则 403 只看自己）列这台机器上所有已配对设备，本浏览器那条 `current:true`。`DELETE /devices/:id`：撤别人 = 那台设备
下线；撤自己 = 退出登录，bridge 回删 cookie，前端 `machines.remove(fp)` 摘掉机器记录，还有别的机器就切过去，否则去 `/pair`。「这个浏览器里的机器」
（relay 才显示）只删 IndexedDB 记录，不动 bridge 侧凭据；`MachineSwitcher` 的「添加另一台机器」回 `/pair`。
非全权设备（guest / 部分 scope）不拉列表，只给「本设备 + 退出登录」：`DELETE /devices/current` 撤这次请求用的那条，同样回删 cookie、摘机器、去 `/pair`。
