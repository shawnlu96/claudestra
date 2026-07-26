# Claudestra Web 客户端 —— 安装与运行

[English](./SETUP.md) · **简体中文**

Claudestra 的 **Next.js Web 前端** —— Discord 之外的第二道前门。
它是一个标准的 **Node/npm** 应用，只跟 Bridge 的 HTTP API
（`/api/v1` + `/api/v1/events`）通信，**不内嵌** Bun 后端。

你会得到：

- **多会话流式 Chat** —— 每个 agent 一条会话，工具调用渲染成实时卡片
  （运行中 = 蓝 / 完成 = 绿 / 失败 = 红），Write/Edit 显示带语法高亮的
  diff，中断以及权限 / AskUserQuestion 提示都是可交互卡片。
- **实时远程终端** —— agent tmux pane 的真正可读写镜像，
  带移动端控制键条（Esc / Tab / 方向键 / Ctrl-C / …）。
- **聊天记录搜索** —— 跨所有会话（live + 归档）的全文搜索，
  可从侧栏全局搜，也可从顶栏按当前会话搜。
- **技能面板** —— 从输入框旁的按钮浏览并启动所有已发现的
  skill / 斜杠命令；可置顶常用项，其余按使用频率自动排序。
- **后台任务面板** —— subagent 和后台 shell 的输出流进可折叠面板，
  而不是刷屏主会话。
- **可安装为 PWA** —— 添加到手机主屏即获得全屏 app 体验，
  自托管 Web Push（VAPID 密钥首次使用时自动生成 —— 无需第三方
  账号，无需注册）。
- 个性化设置（你和 Claude 的头像 / 昵称）、会话管理
  （新建 / kill / restart / 清空 / 多选删除）、per-agent 开机指令。

> 架构与内部实现见 [`web/CLAUDE.md`](./CLAUDE.md)。两端之间的通信约定
> （鉴权、历史分页、SSE 事件）在
> [`docs/web-frontend-guide.md`](../docs/web-frontend-guide.md)。本文只讲
> 「怎么装、怎么跑」。

---

## 前置条件

- **Node.js ≥ 20** + npm（Next 16 / React 19）。Web 应用跑在 Node 上，
  与 Bun 后端完全分离 —— 两棵互相独立的依赖树。
- **Claudestra Bridge 必须在运行**，并且能通过 `BRIDGE_HTTP_URL`
  （默认 `http://127.0.0.1:3847`）访问到。两条路：
  - **A —— 你已经在跑带 Discord 的 Claudestra**（见 [`../SETUP.md`](../SETUP.md)）：
    Bridge、`claudestra` MCP server、Stop hook 都已经被 `bun run setup` 接好了。
    直接跳到 [安装 Web 应用](#1-安装-web-应用)。
  - **B —— 只要 Web，不要 Discord bot**：先看
    [以 Web-only 模式运行后端](#web-only-后端不接-discord)。
- **Bun** —— 只在跑后端和签发下面那个 API token 时才需要。
- **本机开启 SSH 登录。** Web 应用通过本地 SSH/PAM 校验你的操作系统
  账号（没有独立的账号体系）。macOS 上到
  *系统设置 → 通用 → 共享 → 远程登录* 打开；否则登录会失败。

---

## 1. 安装 Web 应用

```bash
cd web
npm install
```

不需要 checkout monorepo：`@do-md/zenith` 和 `@do-md/common` 已经内置在
`web/.packages/` 下（随仓库提交，通过 `tsconfig.json` 的 paths 解析）。
`@do-md/core-react` 跟其它依赖一样从 npm 安装。

---

## 2. 配置环境变量

```bash
cp .env.example .env.local
```

填 `.env.local`：

| 变量 | 必填 | 说明 |
|---|---|---|
| `CLAUDESTRA_API_TOKEN` | **是** | Bridge `/api/v1` 的 Bearer token。签发方式见下。BFF 在服务端携带它，浏览器永远看不到。 |
| `BRIDGE_HTTP_URL` | 是 | 默认 `http://127.0.0.1:3847`。**用 `127.0.0.1`，别用 `localhost`** —— Bridge 只绑 IPv4，`::1` 的歧义会造成偶发的 10 秒 `fetch failed` 超时。 |
| `INTERNAL_API_KEY` | 是 | 随机密钥（`openssl rand -hex 32`）。给脚本访问受保护 API 路由用的另一种鉴权方式（`x-api-key`）。 |
| `WEB_DEV_ORIGINS` | 否 | 逗号分隔的额外来源，允许它们访问 **dev** server 的 `_next` 资源 —— 你的 tailnet IP / 局域网 IP / `*.ts.net` 主机名。不配的话，从这些地址访问时 HMR websocket 握手会失败，dev 页面会反复重载。`next start` 不需要。 |
| `GROQ_API_KEY` | 否 | 语音转写。不设 → transcribe 端点返回 501；也可以在应用内的设置对话框里填。 |
| `COOKIE_SECURE` | 否 | 设成 `on` 会给 session cookie 打上 `Secure`。默认关闭，这样明文的局域网 / Tailscale 访问仍然可用。 |
| `PUSH_VAPID_SUBJECT` | 否 | 标识推送发送方的 `mailto:` 或 URL。 |
| `PUSH_LOCK_PORT` | 否 | 推送派发器的跨进程锁端口（默认 `3339`）—— 保证无论进程怎么组合，都只有一个派发器在发。 |
| `CLAUDESTRA_DATA_ROOT` | 否 | 覆盖数据目录（默认 `~/.claude-orchestrator/web`），里面放着鉴权 session + per-agent 设置的 SQLite。 |

**签发 API token**（在仓库根目录执行，`bun` 的路径按需替换）：

```bash
bun src/manager.ts token-add web-ui --agents '*,master' --force --terminal
```

- `--agents '*,master'` —— `*` 覆盖所有非 master 的 agent；
  **`master` 必须显式列出**（通配符不含它）。
- `--force` —— 表示你确认接受针对非 `--external` agent 的共享上下文防护提示。
- `--terminal` —— 授予**远程终端**（🖥️ 实时 tmux 功能）。这是
  **宿主 shell 级别的访问权**：在终端里可以 Ctrl-C 退出 Claude Code 进入
  裸 shell，绕过 `--disallowedTools`。它跟 messaging 是两种独立能力，
  所以必须显式授予。不想要 Web 终端就去掉 `--terminal` ——
  chat / 历史 / 中断都不受影响。

把打印出来的 token 填进 `CLAUDESTRA_API_TOKEN`。

---

## 3. 运行（开发）

```bash
npm run dev        # → http://localhost:33333
```

macOS 上的注意事项（仅当你的 shell 全局导出了这些变量时）：

- 全局 `NODE_ENV=production` 会盖掉 dev 模式 → `NODE_ENV=development npm run dev`。
- 全局 `INTERNAL_API_KEY` 会盖掉 `.env.local` → `env -u INTERNAL_API_KEY npm run dev`。
- Turbopack 冷启动：重启后头几个请求可能返回 401/502（env / 编译尚未就绪）
  —— 刷新一下即可。

## 4. 运行（生产）

```bash
npm run build
npm run start      # → http://localhost:3333
```

端口刻意选了非默认值（dev `33333` / 生产 `3333`），以免和同一台机器上的
兄弟应用撞车。

## 5. 登录

打开应用 → 会被重定向到 `/login`。输入你的**操作系统用户名 + 密码**
—— 通过本地 SSH 连接到 `127.0.0.1:22`（PAM）来校验。成功后会种下一个
7 天有效的 HttpOnly `cstra_session` cookie，然后落到 `/chat`。

新 agent 是在 chat 里跟大总管（👑 大总管）对话创建的 ——
设计上就没有单独的「新建会话」按钮。

---

## 6. 从手机访问（远程访问）

Claudestra 的全部意义就在于用手机指挥你的工作站。三档方案，
按推荐程度排序：

### 同一个 Wi-Fi（零配置）

`npm run start` 监听所有网卡，所以同一网段的任何设备都能打开
`http://<你的-mac-局域网-ip>:3333`（IP 在 *系统设置 → Wi-Fi → 详细信息*
里看，或者 `ipconfig getifaddr en0`）。用同一个操作系统用户名/密码登录。

适合快速验证；一出门就没用了。

### Tailscale（推荐）

[Tailscale](https://tailscale.com) 基于 WireGuard 给每台设备分配一个稳定的
私有 IP —— 不用端口转发，不用公网暴露，个人使用免费：

1. 在工作站和手机上都装 Tailscale，两边登录同一个 tailnet。
2. 从手机打开 `http://<机器名>:3333`（MagicDNS）或
   `http://100.x.y.z:3333`。

想要 **HTTPS**（PWA 的 service worker 和 Web Push 必需 —— 纯 HTTP 访问
下 chat 能用，但装出来的 PWA 是降级版），就让 Tailscale 用一张真证书
终结 TLS：

```bash
tailscale serve --bg 3333
# → https://<机器名>.<tailnet>.ts.net
```

这个 URL 只有在你的 tailnet 内部才能访问，但它带着浏览器信任的证书
—— 是安装 PWA 的理想入口。

### 公网反向代理（进阶，只有清楚自己为什么需要时才用）

在你自己拥有的域名下，用带 TLS 的 Caddy/nginx 挡在 `3333` 前面。注意：

- **绝对不要**把 `3333`（或 Bridge 的 `3847`）裸着端口转发到公网。Web
  登录用的是你的**操作系统账号密码** —— 爆破它就是爆破你这台机器。
- 在代理层自己加上限流 / IP 白名单 / 2FA。
- `BRIDGE_BIND` 保持 `127.0.0.1` —— 只有 Next.js 应用需要可达，
  浏览器从不直接跟 Bridge 通信。

### 安装为 PWA

一旦应用能通过 HTTPS 访问（或者你接受 HTTP 下的降级模式）：

- **iOS Safari** —— 打开 URL → 分享菜单 → **添加到主屏幕**。启动即全屏
  （standalone），带应用图标和安全区适配的布局。
- **Android Chrome** —— 打开 URL → ⋮ 菜单 → **安装应用**
  （或者接受安装横幅）。

> iOS 会在安装时缓存 manifest —— 大版本升级后，如果图标或全屏表现
> 看起来还是旧的，删掉主屏图标重新添加一次。

---

## 作为服务常驻（macOS launchd）

`npm run start` 会随终端一起死掉。想要常驻部署，就把 Web 应用注册成
LaunchAgent —— `~/Library/LaunchAgents/com.claudestra.web.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claudestra.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>exec ./node_modules/.bin/next start -p 3333</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/path/to/claude-orchestrator/web</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/claudestra-web.log</string>
  <key>StandardErrorPath</key><string>/tmp/claudestra-web.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudestra.web.plist

# 每次更新 web/ 代码之后：
cd web && npm run build && launchctl kickstart -k gui/$(id -u)/com.claudestra.web
```

- ⚠ **直接 `exec` 到 `next`，不要用 `npm run start`** —— launchd 杀掉这个
  job 时，中间那层 npm 进程可能留下一个孤儿 `next-server`。孤儿没有
  监听端口，但它的推送派发器还活着，于是每条 Web Push 都会**收到两遍**
  （2026 年 7 月的事故：重复通知持续了 5 天）。
- 推送派发器会在 `127.0.0.1:3339`（`PUSH_LOCK_PORT`）上取一把独占锁，
  这样即使两个 server 进程共存（生产 + dev，或者漏掉的孤儿），
  也只有一个在发推送。`lsof -iTCP:3339` 能看到谁持有锁。

## `tailscale serve` 不配合时的 HTTPS 方案（Caddy + `tailscale cert`）

`tailscale serve`（上一节）是零配置路径 —— 先试它。在某些 macOS GUI 版
安装上它会报 `The Tailscale GUI failed to start (CLIError error 3)`，
并且写不了 serve 配置。退路：自己签一张 tailnet 证书，让 Caddy 来终结
TLS。Caddy 还顺带给你 HTTP/2 —— 朴素的 TCP 隧道只有 HTTP/1.1，
会把 Safari 的「每主机六条连接」串行化，在移动端上慢得像爬。

```bash
brew install caddy
mkdir -p ~/.claude-orchestrator/web/tls ~/.claude-orchestrator/web/caddy
tailscale cert \
  --cert-file ~/.claude-orchestrator/web/tls/mac.crt \
  --key-file  ~/.claude-orchestrator/web/tls/mac.key \
  <machine>.<tailnet>.ts.net
```

`~/.claude-orchestrator/web/caddy/Caddyfile`：

```
{
	auto_https off
	admin off
}

https://<machine>.<tailnet>.ts.net:443 {
	tls /Users/YOU/.claude-orchestrator/web/tls/mac.crt /Users/YOU/.claude-orchestrator/web/tls/mac.key
	# 响应压缩 —— 客户端从慢速链路接入时，这一行不是可选项。
	# `next start` 和 bridge 都不做压缩；没有它，一份大的聊天历史
	# JSON（几百 kB）会原样传输，在有丢包的跨境链路上可能要 10 秒
	# 以上（2026-07-24：560 kB → 102 kB，13.9s → 0.3s）。SSE 是
	# 安全的：caddy 的 encode 按事件 flush，实测无缓冲。
	encode zstd gzip
	handle {
		reverse_proxy 127.0.0.1:3333
	}
}
```

（同一台机器上的其它项目可能会往这个 Caddyfile 里加自己的路由 ——
那是它们和 Caddy 之间的事，不在本文范围内。）

然后再来一个 LaunchAgent（骨架同上面的 `com.claudestra.web.plist`），
它的 `ProgramArguments` 跑
`/opt/homebrew/bin/caddy run --config /Users/YOU/.claude-orchestrator/web/caddy/Caddyfile`，
日志指到 `~/.claude-orchestrator/web/caddy/`。用同样的方式 bootstrap。

- 只注册**一个** caddy LaunchAgent。Caddy 用 `SO_REUSEPORT` 绑 443，
  所以重复注册不会响亮地失败，而是悄悄起了*第二份*副本，
  跟第一份在同一个端口上做负载均衡。
- 现代 macOS 上非 root 进程可以绑 443（通配地址）。
- **证书续期** —— `tailscale cert` 签出的证书约 90 天有效，
  在这个方案下不会自动续。用
  `openssl x509 -enddate -noout -in ~/.claude-orchestrator/web/tls/mac.crt`
  查过期时间，重跑上面那条 `tailscale cert` 命令，然后
  `launchctl kickstart -k gui/$(id -u)/<your-caddy-label>`。

### 丢包链路上的协议选择（h2/h3 vs 纯 h1）

Caddy 默认走 h2 + h3，网络干净时这正是你想要的。但在**高 RTT、有丢包的
链路**上（比如跨境 ~200 ms 且能看到明显丢包），默认配置可能*输给*纯
HTTP/1.1：h2 把所有东西复用到一条 TCP 连接上，于是单个丢包会让所有流
一起队头阻塞；h3/QUIC 能避开这点，但它跑在 UDP 上，而这类路由上的
中间运营商经常对 UDP 限速或直接丢弃。典型征兆：经 Caddy 访问明显比
直连 `:3333` 慢（直连用的是浏览器的六条并行 h1 连接）。解法 ——
在全局选项里强制 h1：

```
{
	servers {
		protocols h1
	}
}
```

照抄之前先了解代价：浏览器对 h1 限制**每主机 6 条连接**，而 Web 应用
每开一个标签页就占一条 SSE 长连接（开着远程终端还要再占一条）——
同时开几个标签页就可能把额度耗光，表现为网络明明正常、请求却卡在
"pending"。链路干净时保持 h2/h3 默认值；只有上面那种丢包模式确实出现
时才动 h1。

### 同一 tailnet 上用自定义域名（当 `*.ts.net` 解析不了时）

有些网络根本解析不了 `*.ts.net`（例如中国大陆的 DNS 过滤）——
tailnet 链路本身没问题，但浏览器拿不到 IP。解法：把**你自己的域名**
指向 tailnet IP，并在同一个 Caddy 里为它终结 TLS。流量仍然只走
Tailscale —— tailnet 的 `100.x.y.z` A 记录从公网不可路由，
所以这只是多了一个入口，并没有多一份暴露。

1. **DNS**：加一条 A 记录 `claude.your-domain.com → 100.x.y.z`
   （机器的 tailnet IP，`tailscale ip -4`）。在 Cloudflare 上要用
   **DNS-only**（灰云）—— 代理（橙云）显然到不了一个 tailnet IP。
2. **证书**：`tailscale cert` 只签 `*.ts.net` 名字，所以要通过 **DNS-01**
   签一张 Let's Encrypt 证书（主机不需要公网可达 —— 正好适合这里）。
   比如用 [acme.sh](https://github.com/acmesh-official/acme.sh) 配一个
   Cloudflare API token：

   ```bash
   acme.sh --issue --dns dns_cf -d 'your-domain.com' -d '*.your-domain.com'
   acme.sh --install-cert -d 'your-domain.com' \
     --fullchain-file ~/.claude-orchestrator/web/tls/custom/fullchain.pem \
     --key-file       ~/.claude-orchestrator/web/tls/custom/key.pem \
     --reloadcmd "launchctl kickstart -k gui/$(id -u)/<your-caddy-label>"
   ```

3. **Caddy**：往同一个 Caddyfile 里追加第二个 site block（**不要**再起
   一个 caddy —— 见上面的单实例警告）：

   ```
   https://claude.your-domain.com:443 {
   	tls /Users/YOU/.claude-orchestrator/web/tls/custom/fullchain.pem /Users/YOU/.claude-orchestrator/web/tls/custom/key.pem
   	encode zstd gzip
   	handle {
   		reverse_proxy 127.0.0.1:3333
   	}
   }
   ```

   校验 + 重启：`caddy validate --config <Caddyfile>`，然后
   `launchctl kickstart -k gui/$(id -u)/<your-caddy-label>`。
4. **自动续期**：把 `acme.sh --cron` 排成每天跑（launchd/crontab）。
   跟 `tailscale cert` 那条路不同，DNS-01 的续期是全自动的 ——
   上面的 `--reloadcmd` 会带着新证书重启 Caddy。`ts.net` 那个 block
   可以留着当第二个入口。

## 端口表（生产）

| 端口 | 绑定 | 用途 |
|-------|--------------|------|
| 443   | 全部（tailnet 内可达） | Caddy TLS/h2 → 3333（仅 Caddy 方案） |
| 3333  | 所有网卡 | Next.js Web 应用，生产 |
| 33333 | 所有网卡 | Next.js dev server |
| 3847  | 127.0.0.1    | Bridge HTTP + WebSocket（`BRIDGE_PORT`/`BRIDGE_BIND`） |
| 3339  | 127.0.0.1    | Web Push 派发器锁（`PUSH_LOCK_PORT`） |

请求路径：手机 → Caddy `:443`（TLS，仅 tailnet）→ Next.js `:3333`
（BFF，session cookie）→ Bridge `:3847`（Bearer token）→ tmux / Claude Code。

---

## Web-only 后端（不接 Discord）

如果你不想要 Discord bot，就让 Bridge 跑在 **Web-only 模式** —— 它检测到
没有 `DISCORD_BOT_TOKEN` 就跳过所有 Discord 初始化，同时照常提供
Web 应用需要的 `/api/v1` + `/api/v1/events`。

### 后端的一次性前置准备

1. **tmux ≥ 3.2**（`brew install tmux`）。agent 就是 tmux 窗口；
   实时远程终端需要 grouped session。
2. **注册 channel-server MCP**，好让 Claude Code 会话能连上 Bridge：
   ```bash
   claude mcp add claudestra -s user -- ~/.bun/bin/bun run <repo>/src/channel-server.ts
   ```
3. 在 `~/.claude/settings.json` 里**注册 Stop / Notification hook**
   （Web UI 必需），这样每一轮结束（`done`）才会被发出来 —— 没有它，
   Web 的输入框永远解不了锁，流式消息也永远不会定稿成渲染好的 Markdown：
   ```jsonc
   "hooks": {
     "Stop":        [{ "matcher": "", "hooks": [{ "type": "command", "command": "<bunAbs> <repo>/src/hooks/typing-hook.ts" }]}],
     "StopFailure": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<bunAbs> <repo>/src/hooks/typing-hook.ts" }]}],
     "Notification":[{ "matcher": "", "hooks": [{ "type": "command", "command": "<bunAbs> <repo>/src/hooks/typing-hook.ts" }]}]
   }
   ```
   `typing-hook.ts` 在没有 channel 上下文时会静默退出，
   所以对无关的 Claude Code 会话是无害的。

### 启动 Bridge（前台）

```bash
# 在仓库根目录执行
unset DISCORD_BOT_TOKEN
CONTROL_CHANNEL_ID=local-master-control bun run src/bridge.ts
```

### 创建一个 agent

```bash
bun src/manager.ts create <name> <existing-dir> [purpose]
```

> 工作目录**必须已经存在**。别用 `/tmp` —— 它的 `/private` 符号链接会
> 让 Claude Code 的 session jsonl slug 错位。

### 常驻（推荐，macOS launchd）

已经提供了封装脚本：

- `scripts/web-only-bridge.sh` —— 幂等地确保 `master` tmux session 存在，
  然后 exec 进 Web-only 模式的 Bridge。
- `scripts/web-only-launcher.sh` —— 可选；让窗口 0 里的大总管
  Claude Code 保持存活，并自动关掉它启动时的信任 / bypass 提示框。

把它们接进 LaunchAgent（`com.claudestra.web-bridge` / `com.claudestra.web-launcher`），
带上 `RunAtLoad` + `KeepAlive`。**两者必须共用同一个 `CONTROL_CHANNEL_ID`。**
改完 bridge 代码后，这样重载：

```bash
launchctl kickstart -k gui/$(id -u)/com.claudestra.web-bridge
```

---

## 参考

- [`web/CLAUDE.md`](./CLAUDE.md) —— 内部架构、数据流、PWA 注意事项。
- [`docs/web-frontend-guide.md`](../docs/web-frontend-guide.md) —— `/api/v1` +
  `/events` 协议（鉴权、历史分页、SSE 事件类型）。
- [`docs/design-multi-frontend.md`](../docs/design-multi-frontend.md) —— 多前端
  设计（chat_id 键空间、NeutralMessage、ChatAdapter）。
