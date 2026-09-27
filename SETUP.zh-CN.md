# 安装指南

[English](./SETUP.md) · **简体中文**

**最短路径：跑 `bun run setup`**。交互式向导会一步一步带你走完所有步骤，每一步都把指引内嵌在终端里——你根本不需要读这个文档。

本文档的存在意义：

- 向导报错时查问题。
- 了解向导在幕后做了什么。
- 偏好手动配置的人用作参考。

> **两个前门，Web 是默认那个。** 向导默认装 **Web 客户端**——可安装到手机主屏的
> PWA，带流式聊天、实时远程终端、聊天记录搜索。它是一份静态文件（`web/out`），由
> bridge 自己托管：没有第二个服务、没有账号密码——浏览器**配对**一次（`claudestra pair`
> 出二维码 / 链接 / 8 位码）以后打开直接进。向导还会帮你配好手机访问：默认走中继
> （所有机器同一个地址，手机什么都不装、回车即官方中继），也可以选 Tailscale。
>
> **Discord 是可选项**（要自己去开发者后台建 bot，多 5 个步骤），在向导的「选择前端」
> 那步勾上才会问。本文档下面的 Discord 章节只对选了它的人有意义。
> Web 端的细节见 **[web/SETUP.md](./web/SETUP.md)**。

---

## 快速开始

```bash
# 1. 装前置工具（已有的跳过）
brew install tmux                             # macOS
curl -fsSL https://bun.sh/install | bash      # Bun
npm install -g @anthropic-ai/claude-code      # Claude Code 2.1.80+

# 2. Clone 代码，跑向导
curl -fsSL https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh | bash
cd ~/repos/claudestra
bun run setup
```

> **提示：** `raw.githubusercontent.com` 有 ~5 分钟缓存。刚发完新版本立即拉安装脚本，建议带个时间戳绕过 CDN 缓存：
>
> ```bash
> curl -fsSL "https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh?t=$(date +%s)" | bash
> ```

就这样。向导负责剩下的一切：检查依赖、带你创建 Discord bot（内嵌链接 + 一步一步说点哪里）、收集所有需要的 ID、写 `.env`、渲染 `master/CLAUDE.md`、注册 MCP、装好三个 launchd daemon。

### 跨 Claudestra 协作（HTTP peer）

两个 Claudestra 实例共享专精 agent，不需要共享 Discord 服务器、不需要第二个 bot、更不用给对方文件系统 / SSH 权限 —— peer 之间就是互为 API 客户端：各自持有对方签发的、按 agent 圈定 scope 的 Bearer token。

**一键邀请（v2.15+，推荐）** —— 两步完成，零表单：

1. **A 生成邀请**：Web 客户端 设置 → Peer 协作 → 「生成邀请」（勾选要开放的 agent），或 `bun src/manager.ts peer-invite-new --agents <a,b>`。连着中继时得到的是一条链接（`https://<中继>/i#…`），没中继是一段邀请串。发给对方（走任意私聊渠道）。
2. **B 点开**（链接直接落到他自己 Claudestra 的加入页，点一下完成）**或粘贴**：设置 → Peer 协作 → 「加入」，或 `bun src/manager.ts peer-join-auto '<邀请>'`。B 的 bridge 自动回调 A 完成登记——搞定，A 会收到接入通知。

邀请串一次性、24h 过期（过期/撤销都会连带吊销内嵌 token；`peer-invite-list` / `peer-invite-revoke <id>` 管理待兑换的）。B 粘贴加入时**默认不开放自己的任何 agent**——这是单向授权（B 可调用 A 开放的 agent）；要对称访问，B 也生成一张邀请发回去即可，条目会自动合并成同一个 peer。

旧的三步握手（`peer-http-invite` / `peer-http-join` / `peer-http-accept`）仍然可用——对方跑的是 v2.15 之前的版本时用它。

之后任何 agent 都能 `send_to_agent({ target: "<agent>@<peer>", text: "..." })` 跨机调用 —— bridge 直接 POST 对方的 `/api/v1` 消息端点，对方回复自动 push 回调用方，不用轮询。`peer-http-list` 看 peer 列表 + 握手状态；`peer-http-remove <peer>` 删 peer + 撤销你签出的 token，访问即时切断。

注意事项：

- **token scope 就是权限模型**：只有邀请里勾选的 agent 可被调用，越界一律 403。之后想改开放范围用 `peer-http-scope <peer> --agents ...`，不用重新握手。
- **大总管永远不可分享** —— v2.15 起硬规则，`--force` 也不放行（历史 peer token 里列了 master 的也会在 API 层被截断）。
- **非 external agent 要 `--force`**：给不是 `--external` 创建的 agent 签 token 需要加 `--force`（Web UI 里是确认弹层）—— 和你自己对话共享上下文的 agent 不该随手暴露（R1 守卫）。
- **连通性**：走中继（下一节，默认）什么都不用做——两边都只有一条出站连接，peer 地址就是 `relay://<指纹>`。没中继时两边 bridge 要能直接互访：bridge 默认只监听 `127.0.0.1`，记得设 `BRIDGE_BIND`（生成邀请时如果还是回环会直接警告），再给它们一条私有通路——两台机器都装 [Tailscale](https://tailscale.com)（邀请串会自动优先用 Tailscale 地址）、任何内网互通，或 HTTPS 反代。

### 从外面访问：中继（默认）或 Tailscale

中继是默认的那条路，手机和对方电脑上什么都不用装。你的 bridge 只向外连一条 WebSocket 到中继；中继托管网页，**一个地址** `https://<中继域名>/` 走天下，`/m/<指纹>/api/v1/…` 转给你正在看的那台机器的 bridge，并转发别的实例对你的 peer 调用（peer 地址写 `relay://<指纹>`）。不需要公网 IP、不开端口、不配证书。Tailscale 是另一条路（流量只走你自己的私有网络，不经任何第三方），向导「手机访问」一步选 2 就走它——`tailscale serve` 指向 **bridge 端口**，地址是 `https://<mac>.<tailnet>.ts.net/`。

`bun run setup` 的「手机访问」一步默认就配中继：回车用官方中继 `wss://relay.sunstriker.cc`，装完直接打出配对二维码，手机扫一下就配好。手动配等价于：

1. `.env` 加一行，重启 bridge：

   ```
   RELAY_URL=wss://relay.example.com    # 用哪台中继（官方托管或自建）
   RELAY_NAME=mini                      # 可选：中继目录里的显示名（也是旧版子域名标签）；不配就按主机名生成
   ```

   bridge 日志会打出 `🛰 中继: 已连接 …`。机器在中继上的身份是密钥指纹（`claudestra relay-status`），不是主机名。
2. 电脑上运行 `claudestra pair`：打印二维码、链接（`https://relay.example.com/pair#…`）和一个 8 位码（10 分钟有效、只能用一次）。手机相机扫码、任何浏览器打开链接、或在 `https://relay.example.com/` 输入短码——输短码的要在终端（或网页「设备」面板）点头确认。之后这个浏览器持有由**你自己的 bridge** 签发的设备凭据，没有密码这回事；一个浏览器可以配对多台机器，顶栏切换。Web 客户端的 Peer 面板也有「配对新设备」按钮。
3. 邀请变成链接：设置 → Peer 协作 → 「生成邀请」得到 `https://relay.example.com/i#…`，对方点开就到他自己的 Claudestra 的加入页；没装的人会被引导先安装。

一句实话：这版中继是 TLS 的终点、也托管网页的 JS，看得见隧道里的明文（包括设备 cookie）——信任托管中继等于信任它的运营方，和任何 SaaS 一样。自己跑一台见 [docs/relay/self-host.md](docs/relay/self-host.md)，协议与边界见 [docs/relay/protocol.md](docs/relay/protocol.md)，整体设计见 [docs/design-hosted-frontend.md](docs/design-hosted-frontend.md)。

### 装完有什么

- **多 agent 编排** — `#control` 里的大总管给每个 agent 开独立 Discord 频道、路由消息、挂截图、处理打断。
- **自动更新** — Claudestra 自身每 30 分钟查一次 release；Claude Code CLI 每 7 天查一次。两个都用 `bun src/manager.ts auto-update <target> on|off` 切换。
- **Discord slash 自动补全** — `~/.claude/skills/` 的 user skill、已装插件、每个 agent 的项目级 `<cwd>/.claude/skills/`、以及精选的 Claude Code 内置命令（`/cost` `/context` `/compact` `/mcp` `/review` …）都会注册成 Discord slash 命令，每 30min 自动重扫。
- **TUI modal 适配** — 数字菜单（`/model`）和水平滑杆（`/effort`）转成 Discord 按钮；bridge 处理不了的 modal 点 🤖 升级到大总管处理。
- **Cron 定时任务** — `cron-add` / `cron-list` / `cron-history`；临时起 agent 跑 prompt 报告再销毁。
- **Wedge 检测** — agent 的 tmux pane 30+ 分钟没变化且没 idle → @你 + 一键 Esc / Ctrl+C 救回按钮。
- **`manager.ts cost` + `metrics`** — 从 JSONL 汇总 token 消耗 + bridge 事件日志聚合。
- **新消息自动打断** — 你在 Discord 发新消息时，如果 agent 正在干活，bridge 自动 Ctrl+C 让新消息覆盖当前任务。
- **多前端 API（v2.6+）** — Bearer token 鉴权的 HTTP API（`/api/v1` + SSE `/events`），任何前端都能接上你的 agent：`bun src/manager.ts token-add <name> --agents <a,b|*>` 签发按 agent 限定范围的 token。下面的 Web 客户端完全建在这套 API 上。
- **Web 客户端（v2.10+）** — 可 PWA 安装：流式聊天（工具卡 + diff 着色）、实时远程终端、聊天记录搜索、Skills 面板、后台任务子会话。一份静态包，由 bridge 自己（或中继）托管；浏览器用配对码而不是登录。构建、配对、手机访问见 [web/SETUP.md](./web/SETUP.md)。
- **会话归档与历史（v2.8+）** — 每个退役 session 的 JSONL 自动快照到 `~/.claude-orchestrator/archive/`，外加每日全量扫描；聊天记录不再被 Claude Code 的 `cleanupPeriodDays` 清掉，agent 被 kill 之后历史照样可读。
- **后台活动子线程（v2.8+）** — subagent 和后台 shell 任务各开一条 Discord thread 流式输出（完成后自动归档），不再刷爆 agent 主频道。
- **Claude Code agents-mode 防护（v2.7+）** — 检测并自愈 Claude Code 后台 agent 守护进程造出的「分身」session（← 键误触陷阱）：`/agents` 清单面板、一键收编/清理、restart 自动 `--fork-session` 重试。

---

## 向导到底做了什么

`bun run setup` 会走一串编号步骤 —— 具体几步取决于你选了哪些前端（Discord 多五步；Web 客户端多两步：「构建 Web 前端」= `npm install` + `npm run build` 导出到 `web/out`，以及「手机访问」），通常 8~13 步，外加开头的语言选择：

1. **检查系统依赖** — 确认 `git` / `tmux` / `bun` / `claude` 都装了，缺的给出安装命令。
2. **创建 Discord 应用** — 打开 Developer Portal，告诉你点哪个按钮。
3. **获取 Bot Token** — 让你 Reset Token 并粘贴，校验格式。
4. **开启 Privileged Intents** — 提醒你必须打开的三个 intent（少一个 bot 就静默丢消息）。
5. **邀请 Bot** — 带你走 OAuth2 URL Generator，告诉你精确的 scope 和 permission。
6. **收集 Discord ID** — 打开开发者模式，依次问 Guild ID / User ID / 控制频道 ID，每个都校验是 17-20 位 snowflake。
7. **个人偏好** — 你的称呼、MCP 服务名（默认 `claudestra`）、Bridge 端口（默认 `3847`）。
8. **收尾** — 写 `.env`（选了 Web 就带上 `BRIDGE_STATIC_DIR=<仓库>/web/out`）、渲染 `master/CLAUDE.md`，然后可选地自动跑 `bun install` + `playwright install` + `claude mcp add` + `manager.ts install-cli`（写入并加载三个 launchd daemon）。

向导跑完后，本机浏览器打开 `http://127.0.0.1:3847/`（或它打印的手机地址）；配了 Discord 的在控制频道随便说句话，大总管几秒内就会回。

---

## 配置参考

向导会写入 `.env`，包含这些变量：

| 变量 | 用途 |
|------|------|
| `DISCORD_BOT_TOKEN` | Developer Portal 上拿到的 bot token |
| `DISCORD_GUILD_ID` | 你的 Discord 服务器（guild）ID |
| `ALLOWED_USER_IDS` | 允许跟 bot 对话的 Discord 用户 ID（逗号分隔） |
| `CONTROL_CHANNEL_ID` | 大总管的控制频道 ID |
| `BRIDGE_PORT` | WebSocket 端口（默认 `3847`） |
| `USER_NAME` | 大总管在回复里怎么叫你 |
| `MCP_NAME` | `claude mcp add` 用的 MCP 服务名（默认 `claudestra`） |
| `BRIDGE_STATIC_DIR` | 网页静态包的绝对路径（`<仓库>/web/out`）；选了 Web 前端才写——bridge 在 `http://127.0.0.1:<BRIDGE_PORT>/` 托管它 |
| `RELAY_URL` / `RELAY_NAME` | 连哪台中继（手机访问）、可选的显示名——见上文「从外面访问」 |

直接改 `.env`，然后重载 bridge：

```bash
launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge
```

运行时开关存在另一个文件 —— `~/.claude-orchestrator/config.json`，通过 `bun src/manager.ts auto-update ...` 管理：

```bash
bun src/manager.ts auto-update status              # 看当前状态
bun src/manager.ts auto-update claudestra on|off   # 本项目自动更新（30 分钟轮询）
bun src/manager.ts auto-update claude on|off       # Claude Code CLI 自动更新（周轮询）
```

两个默认都是 `on`。配置文件在首次写入时懒创建，不需要手动初始化。

---

## 手动安装（不用向导）

如果你真的想跳过向导：

```bash
git clone https://github.com/shawnlu96/claudestra.git ~/repos/claudestra
cd ~/repos/claudestra
bun install
npx playwright install chromium

cp .env.example .env
# 编辑 .env，填 7 个变量

sed "s/{{USER_NAME}}/你的名字/g" master/CLAUDE.md.template > master/CLAUDE.md

claude mcp add claudestra -s user -- bun run $(pwd)/src/channel-server.ts

# 写入 ~/Library/LaunchAgents/com.claudestra.{bridge,launcher,cron}.plist 并加载，
# 同时把 `claudestra` 命令装到 ~/.local/bin
bun src/manager.ts install-cli
```

---

## 升级

默认情况下 Claudestra 和 Claude Code 都会后台自动升级，你什么都不用做。Claudestra 每 30 分钟查一次，Claude Code 每周一次，只有在所有 agent 空闲时才会真正升级。升级前后 `#control` 频道 @ 你一次。

**想关闭自动升级：**

```bash
bun src/manager.ts auto-update claudestra off   # 停止本项目自动升级
bun src/manager.ts auto-update claude off       # 停止 Claude Code CLI 自动升级
```

**想手动触发升级：**

从 Discord 让大总管升：

> 检查一下有没有更新

或者

> 升级一下代码

执行：

```bash
bun src/manager.ts version   # 看状态
bun src/manager.ts update    # git pull + 重载三个 launchd daemon
```

手动的话：

```bash
cd ~/repos/claudestra
git pull
bun src/manager.ts install-cli   # 重写并重载三个 daemon
```

---

## 卸载

```bash
# 1. 停掉并卸载三个 launchd daemon，然后删掉它们的 plist。
#    只 bootout 不删 plist 是最典型的错误：bootout 只停当前这次，
#    KeepAlive 会在下次登录时把它们原样拉回来。
for svc in bridge launcher cron; do
  launchctl bootout "gui/$(id -u)/com.claudestra.$svc" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/com.claudestra.$svc.plist"
done

# 2. 摘掉 MCP server 与 CLI wrapper
claude mcp remove claudestra -s user
rm -f ~/.local/bin/claudestra

# 3. 手动编辑 ~/.claude/settings.json，删掉其中指向
#    src/hooks/typing-hook.ts 的 Stop / StopFailure / Notification 三个 hook
#    （这个文件里可能还有别的工具注册的 hook，别整段删）

# 4. 删代码与全部运行时状态
trash ~/repos/claudestra ~/.claude-orchestrator /tmp/claude-orchestrator
```

`~/.claude-orchestrator` 里有 registry、config（自动更新开关）、cron 任务、API token、peers 和会话归档 —— 删掉它等于清空所有运行时状态，包括聊天历史快照。

只想暂停 bot 而不丢状态的话，停 daemon 但保留 plist 和状态目录：

```bash
for svc in bridge launcher cron; do launchctl bootout "gui/$(id -u)/com.claudestra.$svc"; done
```

从 Discord 移除 bot：服务器成员列表 → 右键 bot → 踢出。要彻底删除 bot，去 Developer Portal 把 application 删掉。

---

## 疑难排查

### 先跑这个：`doctor`

```bash
bun src/manager.ts doctor          # 人类可读；给程序用加 --json
```

一条命令体检整套安装，坏了的地方直接告诉你该跑什么修：运行时版本（bun / claude /
tmux）、`.env` 是否完整与文件权限、Discord 门禁里有没有合法 owner、三个 launchd
daemon、3847 端口是不是恰好一个监听者且 HTTP 通、MCP 注册与 typing hooks、以及
registry 里每个 agent 是否还有活着的 tmux window。它是**只读**的——不会自己启动或
修改任何东西。

要找人帮忙的时候，**先把这段输出贴上**。

### 装完先会这三招：看活没活、看日志、重启

Claudestra 跑成三个 launchd user agent。下面的命令在任何目录下都能用。

```bash
# 活没活？（第一列是 PID，"-" 表示已加载但没在跑）
launchctl list | grep claudestra

# 日志 —— 每个 daemon 的 stdout / stderr 是分开的两个文件
tail -f ~/.claude-orchestrator/logs/bridge.out      # 路由、注册、投递
tail -f ~/.claude-orchestrator/logs/bridge.err      # 堆栈报错
tail -f ~/.claude-orchestrator/logs/launcher.out    # 大总管守护、agent 复活
tail -f ~/.claude-orchestrator/logs/cron.out        # 定时任务

# 重启单个服务（-k 先杀掉再重载）
launchctl kickstart -k "gui/$(id -u)/com.claudestra.bridge"

# 重装/修复三个 plist 和 `claudestra` 命令
bun src/manager.ts install-cli
```

bridge 重启后大约要 15 秒才恢复：各 agent 的 channel-server 按指数退避重连，别急着判定出故障。

### 向导找不到 `master/CLAUDE.md.template`

在仓库目录里跑：`cd ~/repos/claudestra && bun run setup`。

### Bot 在线但不回消息

检查 **Privileged Intents**。三个必须全部在 Developer Portal 开启。少一个 Discord 就会静默丢弃 bot 无权接收的事件。

```bash
tail -n 50 ~/.claude-orchestrator/logs/bridge.out
```

没有 "received message" 日志 = intent 问题。

### Bot 响应按钮但不响应文字

你的 user ID 很可能不在 `ALLOWED_USER_IDS` 里。重跑 `bun run setup`，或直接改 `.env` 后用 `launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge` 重载。

### 大总管一直不上线

```bash
tail -n 50 ~/.claude-orchestrator/logs/launcher.out
```

常见原因：

- Claude Code 登录过期 → 在终端跑一次 `claude` 重新登录。
- MCP server 没注册 → 重跑 `bun run setup` 或手动 `claude mcp add`。
- `master/CLAUDE.md` 缺失 → 重跑 `bun run setup`。

### Bridge 一直重启

```bash
tail -n 100 ~/.claude-orchestrator/logs/bridge.err
```

通常是 bot token 错了或 `.env` 有错字。去 Developer Portal 重新生成 token，重跑 `bun run setup`。

### Slash 命令缺失或过期

Discord 每个客户端缓存 slash 命令最多 1 小时。如果你刚装了 Claude Code 插件或在 `~/.claude/skills/` 里写了新 skill，Discord 自动补全里没出现：

1. 等最多 30min（bridge 自动重扫并重新注册）**或** `launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge` 立即强制重扫
2. 然后重启 Discord 手机/桌面 App 清客户端缓存

Claudestra 升级后 Discord 里命令列表还是老的 —— 同样处理。

---

## 关键路径

| 路径 | 内容 |
|------|------|
| `~/repos/claudestra` | 源码（或 clone 的位置） |
| `~/repos/claudestra/.env` | 运行时配置（git 忽略） |
| `~/repos/claudestra/master/CLAUDE.md` | 渲染后的大总管指令（git 忽略） |
| `~/.claude-orchestrator/registry.json` | 活跃 agent 注册表 |
| `~/.claude-orchestrator/config.json` | 自动更新开关（首次 `auto-update` 调用时懒创建） |
| `~/.claude-orchestrator/cron.json` | 定时任务 |
| `~/.claude-orchestrator/cron-history.json` | 最近执行记录 |
| `~/.claude-orchestrator/metrics.jsonl` | Bridge 事件日志，`manager.ts metrics` 的数据源 |
| `/tmp/claude-orchestrator/master.sock` | 私有 tmux socket |
| `~/.claude/projects/` | Claude Code session JSONL 文件（`manager.ts cost` 的数据源） |

---

## 接下来

- **Web 客户端细节** — [web/SETUP.md](./web/SETUP.md)：构建静态包、配对设备、在家庭网络之外用手机访问（默认中继，Tailscale 可选）、bridge 前面的 HTTPS 终结（tailscale serve 或 Caddy + `tailscale cert`）、证书续期、端口清单，以及退掉 2026-09 之前那个 `com.claudestra.web` 服务（`claudestra migrate-web-state` → `claudestra retire-web`）。
- 读 [CLAUDE.zh-CN.md](./CLAUDE.zh-CN.md) 了解架构（给贡献者和 agent 看的）。
- 试试 `send_to_agent` MCP 工具搭建多 agent 协作流。
- 建个每天早上跑的定时任务，让它汇报到控制频道。
