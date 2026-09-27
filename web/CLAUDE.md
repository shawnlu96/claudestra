# Claudestra Web 客户端

[English](./CLAUDE.en.md) · **简体中文**

Claudestra 的 Next.js Web 前门（Discord 之外的第二入口）：**纯静态导出**（`output: "export"`），由中继（`RELAY_STATIC_DIR`）或 bridge（`BRIDGE_STATIC_DIR`）托管，浏览器直接打 bridge 的 `/api/v1/*`。没有服务端、没有 BFF、没有登录体系——登录 = 设备配对（`docs/design-hosted-frontend.md`）。

## 技术栈

- Next.js 16 + React 19 + TypeScript + Tailwind 4 + daisyUI；状态管理 zenith（`@do-md/zenith`，复制式 `.packages/`）。
- 依赖树独立于仓库根的 Bun 后端。dev：`npm run dev` → http://127.0.0.1:33333（`scripts/dev-proxy.ts`：页面转 next dev，`/api/v1` 转本机 bridge）；产物：`npm run build` → `out/`（Turbopack 在 worktree 里认不出软链 node_modules，用 `npx next build --webpack`）。

## 目录结构

逐文件说明见 [docs/web/layout.md](../docs/web/layout.md)。

```
app/                  页面：/ 分流 · /chat · /pair 配对 · /login → /pair · /join /i 协作邀请。全是客户端组件，无 api/
features/chat/        Chat：type / stream（协议 v1）/ chat-store（zenith 中枢）/ components
features/machines/    机器清单：MachineGate（配置 + 清单就位再渲染，凭据失效横幅）、MachineSwitcher、版本检查
features/pair/        配对页：扫码挑战应答 / 手输短码轮询 / 本机一键
features/terminal/    远程终端；features/devtools/ 开发者面板（docs/web-dev-mode.md）
lib/app-config.ts     /app-config.json → relay | direct（缺失按 direct 单机兜底）
lib/machines.ts       IndexedDB 机器清单 {fp,name,addedAt,lastUsedAt,principalId?}，不存凭据；当前机器镜像给 SW / boot.js
lib/api/client.ts     唯一的 fetch 出口：基址 /m/<fp> 或 ""，credentials include，非 GET 带 x-cstra-device，401 → 机器标 repair
lib/api/<域>.ts       agents / chat / history / stream / settings / system / push / terminal / devices / version：BFF 的形状包装在这里
lib/chat/             history-shape / stream-shape（原 BFF 的纯变换）、events（协议 v1）、attachments、inline-buttons（twin）
public/boot.js        原 layout 内联脚本（主题 / 看门狗 / 探针），静态文件才能过 script-src 'self'
public/sw.js          Web Push：点通知向发通知那台机器回 read
```

防腐规则与仓库根一致（根 CLAUDE.md「防腐规则」）；web 与 src 互不 import，共用逻辑只能是 twin。

## 身份与请求

- 一个浏览器 × 一台机器 = 一条 HttpOnly cookie `cstra_dev`（中继 Path=/m/<fp>/），bridge 签发与校验；JS 拿不到，`<AuthImg>` 取附件走 fetch+blob。
- 所有请求经 `lib/api/client.ts`：**发出时捕获目标机器**，切机器中止旧机器在途请求 / SSE，迟到响应不落到新机器；`DeviceInvalidError` 由 MachineGate 横幅统一提示，组件不用各自处理 401。
- 「哪条是我发的」= `chatId === "api:owner:self"`（guest = 配对回的 principalId）+ whoami 的 ownerIds（`lib/chat/history-shape.ts`）。
- 版本：`lib/version-check.ts`——有 webCommit 精确比，否则比 HEAD；机器 apiVersion 过低 → 「这台机器需要升级」。

## 数据流

打开 agent：`fetchHistory`（bridge `/agents/:name/history[/:sid]`）→ `openAgentEventStream`（订阅 `/events`，本地按 agent 过滤 + 翻译 + 连流补拉 `/pending` `/bg-tasks`）；`send` fire-and-forget，输出经流回来。完整说明见 [docs/web/data-flow.md](../docs/web/data-flow.md)。必须守住：

- **唤醒对齐 = cursor 差量**：游标 `{sessionId, lastSeq}`，先差量后开流（串行），流不带 `since`；轮转 / 超一页 / 连败回退全量。
- **直播 ↔ 历史判重按 seq**（`features/chat/live-merge.ts`），别用时间戳猜。
- **重复发送闸**（`send-dedupe.ts`）：同 agent 同载荷 1.5s 内只发一次。
- 中断 / 权限卡 / AUQ：事件下行 → 卡片 → `POST /agents/:name/{interrupt,answer}` → tmux 按键。权限卡下行暂缺（permission-watcher 只面向 Discord）。

## PWA 容器（真机收敛的不变式，勿单点改动）

0. **html 别锁高度**：`html,body{height:100%}` 让 iOS standalone 把 fixed 钳到安全区内缩的短视口，底部到不了屏底。用 `body{min-height:100vh}`；html/body 不加 `overflow:hidden`。
1. 应用壳根 `fixed inset-0 overflow-hidden`（chat.tsx）就是全部滚动锁；别改回 in-flow `h-dvh`。
2. 安全区 padding 归各面板自己垫、带自身 bg；不放根层（色差条）。底部 `max(env(safe-area-inset-bottom), 常规间距)` 不叠加。
3. 画布色跟随面板：body 不设 bg，chat.tsx 给 `<html>` 挂 / 摘 `canvas-list`。
4. 模态框 / fixed 浮层必须 `createPortal` 到 body（移动端会话页在 transform 横滑容器内）；改 viewport/manifest 后 iOS 要删主屏图标重加。
5. 排查开 `?dev=1` 看视口实测值；图标 `node scripts/make-icons.mjs`。

## 运行 & 排障

- 后端只有 `com.claudestra.bridge`（+ launcher / cron）；**没有 web 服务**。改后端 → `launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge`；改 web → `npm run build`，托管方拿 `out/`。
- dev 代理替 next dev 设好 `NODE_ENV=development`（本机 shell 全局是 production）；bridge 在代理眼里是同源本机，`/app-config.json` 也由它答（direct 模式）。
- `/events` SSE：bridge 连接即发 `: connected` + 5s ping；流「偶尔收不到」先查这里没被改回去。
- 排障日志在 bridge 的 client.log（`POST /api/v1/client-log`，boot.js 与 `lib/client-log.ts` 都打这里）。
- Next 16：`_` 开头目录不路由；macOS 无 `timeout`，测 SSE 用 `curl --max-time N`。
