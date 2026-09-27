# Claudestra Web 客户端 — 安装与运行

[English](./SETUP.md) · **简体中文**

Claudestra 的 **Web 前端**——Discord 之外的第二个前门。它是一份 **Next.js 静态导出**
（`web/out`）：没有自己的服务器、没有登录数据库。bridge 自己托管这些文件并应答所有 API；
浏览器靠**配对**拿到设备凭据，不是登录。

你会得到：

- **多会话流式聊天** — 每个 agent 一个会话，工具调用渲染成实时卡片（运行中 = 蓝 / 完成 = 绿 / 失败 = 红），
  Write/Edit 显示语法高亮 diff，打断与权限 / AskUserQuestion 提示是可交互卡片。
- **实时远程终端** — agent 的 tmux pane 真实读写镜像，带移动端控制栏（Esc / Tab / 方向键 / Ctrl-C / …）。
- **聊天记录搜索** — 全部会话（在线 + 归档）全文检索，侧栏全局搜或顶栏搜当前会话。
- **Skills 面板** — 在输入框旁一个按钮里浏览并启动所有发现的 skill / slash 命令；可置顶，其余按使用频率排序。
- **后台任务子线程** — subagent 与后台 shell 流到可折叠面板，不刷爆主会话。
- **一个浏览器多台机器** — 每台配对一次，顶栏切换。
- **可安装为 PWA** — 添加到手机主屏得到全屏 App 体验，带 Web Push（经中继，或 bridge 直托管时自签 VAPID）。
- 个人资料自定义（你和 Claude 的头像 / 昵称）、会话管理（新建 / kill / 重启 / 清空 / 多选删除）、每个 agent 的初始消息。

> 架构与内部实现见 [`web/CLAUDE.md`](./CLAUDE.md)。线上契约（鉴权、历史分页、SSE 事件）见
> [`docs/web-frontend-guide.md`](../docs/web-frontend-guide.md)；托管前端设计（配对、中继路径模式、
> 信任边界）见 [`docs/design-hosted-frontend.md`](../docs/design-hosted-frontend.md)。
> 本文只讲「怎么构建、怎么托管、怎么从外面进来」。

---

## 前置条件

- **Node.js ≥ 20** + npm —— 只用来**构建**（Next 16 / React 19）。之后没有任何 Node 进程在跑，bridge（Bun）托管产物。
- **Claudestra Bridge 必须在跑**（`bun run setup` 把它装成 `com.claudestra.bridge`；不接 Discord 的 Web-only 见
  [Web-only 后端](#web-only-后端不接-discord)）。
- 没有别的：不需要 SSH / 远程登录、不需要 `.env.local`、不需要签 API token。

## 1. 构建

```bash
cd web
npm install
npm run build          # → web/out（静态导出）
```

不需要 monorepo：`@do-md/zenith` 与 `@do-md/common` 已 vendor 在 `web/.packages/`（已提交，经 `tsconfig.json` paths 解析）。

`bun run setup` 的「构建 Web 前端」一步做的就是这件事；`claudestra update` / `bun src/manager.ts install-cli`
在最后一次触及 `web/` 的提交变了时自动重建 `web/out`（`src/lib/web-build.ts`：先克隆旧的 `.next` 与 `out`，
构建失败就换回去，所以坏构建不会让网页 404）。bridge 按请求读 `out/`——构建完不用重启。

## 2. 托管

`.env` 里有这一行 bridge 就托管静态包：

```
BRIDGE_STATIC_DIR=/absolute/path/to/claudestra/web/out
```

`bun run setup` 选了 Web 前端会自动写；手动加的话加完 `launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge`。
然后打开 `http://127.0.0.1:3847/`（你的 `BRIDGE_PORT`）。`GET /app-config.json` 告诉页面它处于 *direct* 模式
（`{ mode: "direct", fp, machineName }`）；经中继时同一份 bundle 以 *relay* 模式打 `/m/<指纹>/api/v1`。

`bun src/manager.ts doctor` 有一组「前端静态包」：构建时效、`BRIDGE_STATIC_DIR` 指向的目录里有没有 `index.html`；
「launchd daemon」组里若 2026-09 之前的 `com.claudestra.web` plist 还在会提醒退场。

## 3. 配对浏览器

没有密码。浏览器成为你这台机器的一个**设备**：

```bash
claudestra pair                      # 自己：全部 agent + master + 终端 + 管理
claudestra pair --guest ana --agents a,b --no-terminal   # 给别人：限定范围的访客
claudestra pair --url https://mac.tail0000.ts.net        # 直连入口：给这个地址出二维码 / 链接
```

它打印二维码、链接（`<入口>/pair#<指纹>.<秘密>`）和一个 8 位码（10 分钟有效、只能用一次）。扫码或打开链接立刻配好；
在 `/pair` 输短码则手机进入「等待确认」，直到你在终端（或设备面板）点头——猜到码的人进不来。凭据是**你自己的 bridge**
签发并校验的 HttpOnly cookie；在设备面板或 `DELETE /api/v1/devices/:id` 可随时撤销任何设备。本机浏览器（回环）自动配对。
`/login` 直接跳到 `/pair`。

## 4. 开发

```bash
npm run dev            # → http://localhost:33333，怎么指向一台 bridge 见 web/CLAUDE.md
```

macOS 坑：全局 `NODE_ENV=production` 会盖掉 dev 模式 → `NODE_ENV=development npm run dev`。

---

## 5. 从手机访问（远程访问）

Claudestra 的全部意义就是用手机操控工作站。按推荐顺序：

### 中继（默认——一个地址，什么都不装）

`bun run setup` 的「手机访问」一步默认配这个：bridge 向外连一条 WebSocket 到中继，**`https://<中继域名>/`**
就是你配对过的每台机器的网页——自带 HTTPS，PWA 与推送都能用。用 `claudestra pair`（二维码）配对，或在中继首页输短码。
细节、自建与信任边界：[../docs/relay/README.md](../docs/relay/README.md)。下面几条路给不想经中继的人。

### 同一个 Wi-Fi（降级）

`BRIDGE_BIND=0.0.0.0` 时 bridge 监听所有网卡，同一网络的设备可打开 `http://<你的 Mac 局域网 IP>:3847/`
（IP 在「系统设置 → Wi-Fi → 详细信息」，或 `ipconfig getifaddr en0`）。配对：`claudestra pair --url http://<局域网 IP>:3847`。
明文 HTTP：没有 service worker、推送、语音输入——测试够用，出门就断。

### Tailscale（你自己的私有网络，不经第三方）

[Tailscale](https://tailscale.com) 给每台设备一个稳定私有 IP（WireGuard）——不端口转发、不暴露公网，个人免费。
向导「手机访问」一步选 2 会带你走完：

1. 工作站和手机都装 Tailscale，登录同一个 tailnet。
2. 让 Tailscale 在 **bridge 端口**前面终结 TLS（向导会先问再执行）：

   ```bash
   tailscale serve --bg http://127.0.0.1:3847
   # → https://<机器名>.<tailnet>.ts.net
   ```

   这个地址只在 tailnet 内可达，但带浏览器信任的证书——装 PWA 的理想入口。经 `tailscale serve` 进来的请求从
   127.0.0.1 到达 bridge 并带 `X-Forwarded-For`，bridge 把它们按**非回环**处理，反代不会继承控制路由的回环豁免。
3. 配对：`claudestra pair --url https://<机器名>.<tailnet>.ts.net`。

### 公网反向代理（进阶，只有清楚自己为什么需要时才用）

在自己的域名上用 Caddy/nginx 带 TLS 反代 bridge 端口。注意：

- **绝不**把 `3847` 裸转发到公网；在反代加限流 / IP 白名单。配对流程有暴力破解限制，但暴露面仍是你的机器。
- **peer** 的 `/api/v1/*` 路由到 peer 专用入口端口（见下文），不要指向 bridge 端口。

### 安装为 PWA

只要 App 能经 HTTPS 访问（或接受 HTTP 的降级模式）：

- **iOS Safari** — 打开地址 → 分享 → **添加到主屏幕**。全屏启动（standalone），带图标与安全区布局。
- **Android Chrome** — 打开地址 → ⋮ 菜单 → **安装应用**（或接受安装横幅）。

> iOS 在安装时缓存 manifest —— 大版本升级后如果图标或全屏行为不对，删掉主屏图标重新添加。

---

## 从 2026-09 之前的 web 服务升级

托管前端之前 web 客户端是独立的 Next.js 服务（`com.claudestra.web`、3333 端口、SSH 登录、`~/.claude-orchestrator/web/`）。
升级到会托管 `web/out` 的 bridge 之后：

1. `claudestra migrate-web-state` —— 把 `~/.claude-orchestrator/web/` 打包进 `~/.claude-orchestrator/backups/web-<时间戳>.tgz`，
   再把 8 张设置表（资料、agent 设置、skill 偏好、推送订阅、隐藏区间、已读标记、APNs 设备）和 `groqApiKey` 复制进 bridge 的
   `web-state.sqlite`。幂等；旧数据原地不动。
2. 打开新入口（`http://127.0.0.1:3847/`、中继或你的 Tailscale 地址），配对一次，确认能聊、能收推送。
3. `claudestra retire-web` —— `BRIDGE_STATIC_DIR` 没在托管（`/app-config.json` 不应答）**或**没有第 1 步的备份时拒绝；
   否则 `launchctl bootout` 旧 daemon、把 plist 挪到 `~/.claude-orchestrator/backups/com.claudestra.web.plist.<时间戳>`，
   并打印回滚命令。`~/.claude-orchestrator/web/` 永不删除。

第 3 步没做完之前 `doctor` 会一直提醒旧 plist。Passkey、TOTP 与 SSH 登录已不存在；浏览器会话 cookie `cstra_session`
换成设备 cookie `cstra_dev`。

---

## `tailscale serve` 不配合时的 HTTPS 方案（Caddy + `tailscale cert`）

`tailscale serve`（上一节）是零配置路径，先试它。某些 macOS GUI 安装会报
`The Tailscale GUI failed to start (CLIError error 3)`、写不了 serve 配置。退路：自己签 tailnet 证书，让 Caddy 终结 TLS。
Caddy 还给你 HTTP/2——裸 TCP 隧道只有 HTTP/1.1，Safari 每域 6 连接会被串行化，手机上很慢。

```bash
brew install caddy
mkdir -p ~/.claude-orchestrator/tls ~/.claude-orchestrator/caddy
tailscale cert \
  --cert-file ~/.claude-orchestrator/tls/mac.crt \
  --key-file  ~/.claude-orchestrator/tls/mac.key \
  <machine>.<tailnet>.ts.net
```

`~/.claude-orchestrator/caddy/Caddyfile`：

```
{
	auto_https off
	admin off
}

https://<machine>.<tailnet>.ts.net:443 {
	tls /Users/YOU/.claude-orchestrator/tls/mac.crt /Users/YOU/.claude-orchestrator/tls/mac.key
	# 响应压缩——客户端走慢链路时不是可选项。bridge 不压缩；没有它一份几百 kB 的聊天
	# 历史 JSON 裸传，在丢包的跨境链路上能拖到 10s+（2026-07-24：560 kB → 102 kB，
	# 13.9s → 0.3s）。SSE 安全：caddy 的 encode 逐事件 flush，已验证不缓冲。
	encode zstd gzip
	handle {
		reverse_proxy 127.0.0.1:3847
	}
}
```

（同机其它项目可以往这份 Caddyfile 里加自己的路由——那是它们和 Caddy 之间的事，此处不管。）

然后一个 LaunchAgent（label 自取，`RunAtLoad` + `KeepAlive`），`ProgramArguments` 跑
`/opt/homebrew/bin/caddy run --config /Users/YOU/.claude-orchestrator/caddy/Caddyfile`，日志指向
`~/.claude-orchestrator/caddy/`，用 `launchctl bootstrap gui/$(id -u) <plist>` 拉起。

- **只注册一个** caddy LaunchAgent。Caddy 用 `SO_REUSEPORT` 绑 443，重复注册会静默起第二份一起负载同一端口而不是报错。
- 现代 macOS 非 root 进程可以绑 443（通配地址）。
- Caddy 会设 `X-Forwarded-For`，bridge 因此把经反代的请求当非回环（见 Tailscale 一节）——正是想要的。
- **证书续期** —— `tailscale cert` 的证书约 90 天，这里不会自动续。`bun scripts/renew-ts-cert.ts` 查过期，默认只演练；
  `--apply --reload-label <你的 caddy label> --notify` 在剩不到 30 天时续签、重启 Caddy、失败发 #control。
  要自动化就用 LaunchAgent 每天跑一次（`StartCalendarInterval`，`WorkingDirectory` = 仓库根以便加载 `.env`）；没到期的日子什么都不改。

### Peer 走同一个 HTTPS 入口

Claudestra peer（调你 agent 的其它实例）可以走这个 HTTPS 入口而不是 bridge 端口，新 peer 不需要防火墙白名单——只要能路由到这台机器（比如在 Tailscale 里分享给他）。

1. 挑一个空闲回环端口做 peer 入口，写进仓库 `.env`，如 `PEER_INGRESS_PORT=3848`，重启 bridge。它只服务带 peer token 的 `/api/v1`——没有控制路由、没有 websocket、没有设备 cookie。
2. 在 `ts.net` 站点块里、web 的 `handle` **之前**把 `/api/v1/*` 路由过去：

   ```caddyfile
   handle /api/v1/* {
       reverse_proxy 127.0.0.1:3848
   }
   ```

   peer 用专用端口而不是 bridge 端口：bridge 端口还承载设备 cookie 会话与控制路由，而 peer 入口才是设计上给别的机器打的那个面。
3. `peer-invite-new` 之后自动把 `https://` 地址写进邀请（先经入口探 `/api/v1`，探不通退回 bridge 地址）。`.env` 设 `PEER_PUBLIC_URL` 可强制指定基址。

用 `tailscale serve` 的话，`bun run setup` 在你同意配 HTTPS 时会加等价的 `--set-path /api/v1` 处理器并写 `PEER_INGRESS_PORT`。走中继则这些都不需要——peer 地址是 `relay://<指纹>`。

没有 HTTPS 入口、bridge 也仍只听回环（默认）？也不用开 bridge 端口：`peer-invite-new` 会把同一个 peer 专用入口开到所有网卡（`.env` 的 `PEER_INGRESS_PUBLIC=1`，仅在有 peer token 时），并把 `http://<tailnet IP>:<那个端口>` 写进邀请。bridge 端口继续只听回环。

### 丢包链路上的协议选择（h2/h3 vs 纯 h1）

Caddy 默认说 h2 + h3，干净网络上这就是你想要的。在**高 RTT、丢包**的路径上（如跨境 ~200 ms、可见丢包）默认反而会*输给*纯 HTTP/1.1：
h2 把所有流复用在一条 TCP 上，丢一个包所有流一起队头阻塞；h3/QUIC 避开了这点但走 UDP，这类路径上的中间运营商常限速或黑洞。
症状：经 Caddy 浏览比直连 `:3847` 慢得多（直连用浏览器的 6 条并行 h1 连接）。修法——全局选项里强制 h1：

```
{
	servers {
		protocols h1
	}
}
```

照抄前要知道的代价：浏览器对 h1 限**每域 6 连接**，web 应用每个打开的标签页占一条 SSE 长轮询（开着远程终端再加一条）——
多个标签同时开会耗尽配额，表现为请求一直 "pending" 而网络其实没问题。干净链路保留 h2/h3 默认；只在上述丢包模式真出现时才用 h1。

### 同一 tailnet 上用自定义域名（当 `*.ts.net` 解析不了时）

有些网络完全解析不了 `*.ts.net`（如中国大陆的 DNS 过滤）——tailnet 链路本身好好的，浏览器却拿不到 IP。
修法：把**你自己的域名**指到 tailnet IP，在同一个 Caddy 里为它终结 TLS。流量依旧只走 Tailscale——tailnet 的
`100.x.y.z` A 记录从公网不可路由，这只是多一个入口，不是多一份暴露。

1. **DNS**：加 A 记录 `claude.your-domain.com → 100.x.y.z`（机器的 tailnet IP，`tailscale ip -4`）。Cloudflare 上用 **DNS-only**（灰云）——代理（橙云）显然到不了 tailnet IP。
2. **证书**：`tailscale cert` 只签 `*.ts.net`，所以用 **DNS-01** 签 Let's Encrypt（主机不需要公网可达——正合适）。例如用 [acme.sh](https://github.com/acmesh-official/acme.sh) 和 Cloudflare API token：

   ```bash
   acme.sh --issue --dns dns_cf -d 'your-domain.com' -d '*.your-domain.com'
   acme.sh --install-cert -d 'your-domain.com' \
     --fullchain-file ~/.claude-orchestrator/tls/custom/fullchain.pem \
     --key-file       ~/.claude-orchestrator/tls/custom/key.pem \
     --reloadcmd "launchctl kickstart -k gui/$(id -u)/<你的 caddy label>"
   ```

3. **Caddy**：往同一份 Caddyfile 追加第二个站点块（**不要**起第二个 caddy——见上面的单实例警告）：

   ```
   https://claude.your-domain.com:443 {
   	tls /Users/YOU/.claude-orchestrator/tls/custom/fullchain.pem /Users/YOU/.claude-orchestrator/tls/custom/key.pem
   	encode zstd gzip
   	handle {
   		reverse_proxy 127.0.0.1:3847
   	}
   }
   ```

   校验 + 重启：`caddy validate --config <Caddyfile>`，然后 `launchctl kickstart -k gui/$(id -u)/<你的 caddy label>`。
4. **自动续期**：每天跑 `acme.sh --cron`（launchd/crontab）。和 `tailscale cert` 那条路不同，DNS-01 续期完全无人值守——上面的 `--reloadcmd` 会用新证书重启 Caddy。`ts.net` 站点块可以并存作为第二入口。

## 端口表

| 端口  | 绑定         | 用途 |
|-------|--------------|------|
| 443   | 全部（tailnet 可达） | `tailscale serve` 或 Caddy TLS/h2 → 3847 |
| 3847  | 127.0.0.1（默认） | Bridge：HTTP API + WebSocket **+ 网页**（`BRIDGE_PORT` / `BRIDGE_BIND` / `BRIDGE_STATIC_DIR`） |
| 3848… | 127.0.0.1 | peer 专用 `/api/v1` 入口（`PEER_INGRESS_PORT`，setup 挑选） |
| 33333 | 所有网卡 | Next.js dev server（仅开发） |

请求路径：手机 → 中继（或 Caddy / tailscale serve `:443`）→ Bridge `:3847`（静态文件 + `/api/v1`，设备 cookie）→ tmux / Claude Code。

---

## Web-only 后端（不接 Discord）

不想要 Discord bot，就让 Bridge 跑 **Web-only 模式**——它检测到没有 `DISCORD_BOT_TOKEN` 就跳过所有 Discord 初始化，
照样托管静态包并提供 web 需要的 `/api/v1` + `/api/v1/events`。

### 后端的一次性前置准备

1. **tmux ≥ 3.2**（`brew install tmux`）。agent 是 tmux 窗口；实时远程终端需要 grouped session。
2. **注册 channel-server MCP**，Claude Code 会话才能连到 Bridge：
   ```bash
   claude mcp add "${MCP_NAME:-claudestra}" -s user -- ~/.bun/bin/bun run <repo>/src/channel-server.ts
   ```
3. **注册 Stop / Notification hook**（web UI **必需**）到 `~/.claude/settings.json`，回合结束（`done`）才会发出——没有它输入框永远解不开锁、流式消息永远不会定稿成 Markdown：
   ```jsonc
   "hooks": {
     "Stop":        [{ "matcher": "", "hooks": [{ "type": "command", "command": "<bunAbs> <repo>/src/hooks/typing-hook.ts" }]}],
     "StopFailure": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<bunAbs> <repo>/src/hooks/typing-hook.ts" }]}],
     "Notification":[{ "matcher": "", "hooks": [{ "type": "command", "command": "<bunAbs> <repo>/src/hooks/typing-hook.ts" }]}]
   }
   ```
   `typing-hook.ts` 在没有频道上下文时静默退出，对无关的 Claude Code 会话无害。

### 启动 Bridge（前台）

```bash
# 在仓库根
unset DISCORD_BOT_TOKEN
CONTROL_CHANNEL_ID=local-master-control BRIDGE_STATIC_DIR=$(pwd)/web/out bun run src/bridge.ts
```

### 创建一个 agent

```bash
bun src/manager.ts create <name> <existing-dir> [purpose]
```

> 工作目录**必须已存在**。别用 `/tmp`——它的 `/private` 软链会让 Claude Code 的会话 jsonl slug 落错地方。

### 常驻（推荐，macOS launchd）

提供了包装脚本：

- `scripts/web-only-bridge.sh` — 幂等地确保 `master` tmux 会话存在，然后以 Web-only 模式 exec Bridge。
- `scripts/web-only-launcher.sh` — 可选；让大总管 Claude Code 常驻 window 0 并自动跳过启动时的信任 / bypass 提示。

把它们接到**正常安装用的同一组 LaunchAgent label**——`com.claudestra.bridge` 与 `com.claudestra.launcher`——
带 `RunAtLoad` + `KeepAlive`。Web-only 只是不同的*启动命令*，不是不同的服务；另起 label 会让机器上的 daemon 名与
本仓库任何文档都对不上（对从未 load 过的 label 执行 `launchctl kickstart` 只会回 exit 113）。
**两者必须共用同一个 `CONTROL_CHANNEL_ID`。** 改了 bridge 代码之后重载：

```bash
launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge
```

---

## 参考

- [`web/CLAUDE.md`](./CLAUDE.md) — 内部架构、数据流、PWA 注意事项。
- [`docs/design-hosted-frontend.md`](../docs/design-hosted-frontend.md) — 配对、设备凭据、中继路径模式、信任边界、迁移顺序。
- [`docs/web-frontend-guide.md`](../docs/web-frontend-guide.md) — `/api/v1` + `/events` 契约（鉴权、历史分页、SSE 事件类型）。
- [`docs/design-multi-frontend.md`](../docs/design-multi-frontend.md) — 多前端设计（chat_id 键空间、NeutralMessage、ChatAdapter）。
