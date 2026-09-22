# Claudestra — 架构文档

[English](./CLAUDE.md) · **简体中文**

面向贡献者和在本仓干活的 agent：架构地图、不变量、规则。新用户请先看 [SETUP.zh-CN.md](./SETUP.zh-CN.md)。功能细节在 [`docs/architecture/`](./docs/architecture/)——本文件只留每个会话都用得上的内容，它自己也在体量棘轮里。

## 防腐规则（`bun run check` 会拦，别绕）

1. **每次提交前跑 `bun run check`**（= `tsc --noEmit` + `bun test` + `bun run guard`）。guard 报红就**改代码，不许为了通过去改 `scripts/guard/baseline.json`**。baseline 唯一允许的自动变更是 `bun run guard:update`（只会收紧）。没有行内 ignore 注释。
2. **放宽必须留痕**：手改 baseline，并在它的 `raised[]` 里写 `{key, from, to, why}`（why ≥10 字），commit message 再写一遍。改闸门本身（`scripts/guard/` 下除 `baseline.json` 以外的任何文件——上限、`PUBLIC_ROUTES`、twins、`knip.json`）同样要**新增**一条 `{key: "guard:<路径>", from: 0, to: 0, why}`；`package.json` 的 `check`/`guard` 脚本和 CI 的 Guard 步骤也会被校验。guard 拿比较基准版本做 diff（CI：`GUARD_BASE` = PR 的 base / push 的 before；本地：与 `origin/main` 的分叉点），没记录的改动本地侥幸过了，CI 也会红。CI 是严格模式（`GUARD_STRICT=1`）：依赖（knip、oxc-parser）缺席导致规则被跳过也算失败。`--init` 重建基线只给主会话 / owner 在合并后用，agent 不要跑。
3. **体量上限**：新文件 ≤400 行（tests ≤600），新函数 ≤100 行，单行 ≤200 字符。baseline 里的大文件只许变小：往 `manager.ts` / `bridge.ts` / `api-routes.ts` / `chat-store.ts` 加功能 = 新建模块写逻辑，大文件里只留一行调用。把超长函数或重复块原样搬出去不算违规（这两项按全仓总量计）。
4. **写 helper 之前先搜**：`grep -rn "export function" src/lib | grep -i <关键词>`。规范位置：
   - tmux → `src/lib/tmux-helper.ts`（`windowTarget()`、`tmuxRaw`、`tmuxFire`、`tmuxInterrupt`）；禁止手写 `master:${x}` 和 `Bun.spawn(["tmux", …])`。已知例外：`bridge/web-terminal.ts` 的 PTY 参数、`lib/doctor.ts` 的 `tmux -V` 探测、Pi 扩展里的 `execFile`、`setup.ts`。
   - 启动参数 → `src/lib/claude-launch.ts`、`src/lib/launch-command.ts`、`src/lib/runtimes/`、`src/lib/pi-launch.ts`。
   - 路径 → registry 用 `src/lib/registry.ts`（`REGISTRY_PATH`），日志 `src/lib/log-paths.ts`，bun/npm 可执行文件 `src/lib/bun-path.ts` / `src/lib/npm-path.ts`，会话文件 `src/lib/session-source.ts`。
   - 文件锁 / 原子写 JSON → `src/lib/file-lock.ts`；原子写复用拥有该文件的模块里的 tmp+rename 写法（如 `src/lib/peers.ts`），要出现第三份就先抽到 `src/lib`。
   - bridge/cron 调 `manager.ts` → `runManager`（`src/lib/manager-client.ts` 落地后用它，否则 `src/bridge/management.ts`），禁止自己 spawn `bun src/manager.ts`；Bridge ws 请求 → `src/lib/bridge-client.ts`。
5. **依赖方向**：`src/lib` 只 import `src/lib`；`src/bridge/*` 不 import 入口文件（`src/*.ts`），也不 import 枢纽（`api-routes` / `management` / `web-terminal` / `web-gateway`）；watcher 之间不互相 import——共用纯函数下沉到 `src/lib`，运行时状态查询用注入。`web/` 与 `src/` 互不 import，确需两边各一份的登记进 `scripts/guard/config.ts` 的 twins。
6. **不许复制 6 行以上的逻辑**。需要「和 X 对齐」就抽函数去调用，不要写一句「与 X 保持一致」的注释。
7. **不许无声吞错**：`catch {}` / `.catch(() => {})` / `.catch(() => null)` 里必须写一句为什么丢了也没事（`/* ignore it */`、`/* 同上 */`、`/* non-critical */` 这类占位按吞错计）；能打日志就打日志。
8. **注释写「现在为什么这样、改了会坏什么」**，最多 6 行，不加 `v2.x+:` 前缀。版本演变、事故经过、谁哪天报的、原话引用都写进 commit message；注释里最多留一句「见 tests/x.test.ts」或「git log -S <符号>」。
9. **本文件是地图不是 changelog**：功能细节写到 `docs/<领域>/<主题>.md`，这里留一行指针（`CLAUDE.md` 的字节数在 baseline 里）。

## 系统概览

Claudestra 是基于 Claude Code 原生 **Channel 协议**（MCP 的扩展）的多会话编排器。一个 Bridge 进程把单个 Discord bot token（以及 HTTP/Web API）扇出到多个 Claude Code / Pi 会话，每个会话注册为独立的 channel 监听者。

```
 Discord (一个 bot, 一个 token)
        │
        ▼
 Bridge  ── bridge.ts, launchd 管理, ws://localhost:3847
        │
        ├── WebSocket 路由              ├── JSONL Watcher               ├── HTTP Hooks
        │                               │                               │
        │   channel → master            │   tool call → Discord         │   Stop       → 停止 typing
        │   channel → agent A           │   claude 文本 → Discord        │   Notification → 兜底
        │   channel → agent B           │   合并 + 去抖                   │   30 分钟安全超时
        │   ...                         │                               │
```

- 所有「消息语义」的操作都构造 `Envelope{from, to, intent, content, meta}` 再调 `deliver()`（`src/bridge/router.ts` 定义 `Endpoint` = local / user / api）。入站、出站 `reply`、agent↔agent `send_to_agent`、HTTP peer 回推都走这条路。
- 每个 Claude Code 会话有自己的 `channel-server`（stdio MCP ↔ Bridge WebSocket）；Pi 会话用 `src/pi/claudestra-extension.ts`，讲同一套 ws 协议。
- `jsonl-watcher` 追会话 JSONL，推送工具调用和 assistant 文本（1.5s 去抖），Stop hook 时同步 drain。
- 完整说明（消息流、Envelope 模型）：[docs/architecture/overview.zh-CN.md](./docs/architecture/overview.zh-CN.md)。

## 项目结构

每块一行；逐文件说明（历史、事故、理由）见 [docs/architecture/project-layout.zh-CN.md](./docs/architecture/project-layout.zh-CN.md)。

```
src/
  bridge.ts            入口：Discord client、ws server、deliver() 分发、slash 命令、Stop hook
  bridge/              bridge 模块——router（Envelope/Endpoint/chat_id）、adapters（ChatAdapter 注册表）、
                       event-bus（SSE）、api-routes（/api/v1）、management（免 LLM 按钮）、discord-api、
                       各 watcher（jsonl / bg-activity / permission / wedge / session-reconciler / model-drift）、
                       sessions-inventory、archive-sweeper、screenshot、web-terminal、web-gateway、config
  channel-server.ts    每会话一个的 MCP 代理（stdio MCP ↔ Bridge ws）
  pi/                  Pi agent 扩展（同一套 ws 协议 + Pi 自定义工具）
  manager.ts manager/  CLI 入口 + switch；各命令族在 manager/（core = registry / output / 参数解析；那里绝不 import manager.ts）
  cron.ts launcher.ts  launchd 守护：定时任务调度、master 会话守护 + 自动更新
  setup.ts cli/        安装向导、`claudestra` CLI
  hooks/               Claude Code hook：Stop/Notification → bridge、SessionStart 记忆召回
  lib/                 纯逻辑 / 共用逻辑——规范 helper 所在地（见防腐规则第 4 条）；仓库路径只经 lib/repo-root.ts
  runtimes（lib/ 下）   各 runtime 的启动与会话适配（claude-code / pi / codex）
web/                   Next.js PWA 客户端（有自己的 CLAUDE.md 和 npm 依赖树）
tests/                 纯逻辑 bun 测试（`bun test`）；bridge.ts 本身靠 sandbox 实测
scripts/guard/         防腐棘轮：规则、配置、baseline.json（见防腐规则）
docs/                  设计文档 + architecture/（本文件搬出去的细节）
master/                大总管指令模板（由 setup.ts 渲染）
```

## 功能

每项一行；完整说明见 [docs/architecture/features.zh-CN.md](./docs/architecture/features.zh-CN.md)（英文版更全：[features.md](./docs/architecture/features.md)）。

- **多 agent 编排** — 创建 / 恢复 / 销毁 / 重启 / 列表 / 历史，每个 agent 是一个 tmux window。
- **Project 归组** — 每个 agent 必属一个 project（`projects.json`，manager 是唯一写者）；大总管例外。
- **Agent 间消息** — `send_to_agent` 经 Bridge 直接注入另一个 agent 的上下文。
- **Codex 调用** — `ask_codex` 每次调用起一个本机 Codex CLI（`lib/codex.ts`），默认只读沙箱。
- **定时任务** — cron 表达式拉起临时 agent，跑 prompt、汇报、清理。
- **Discord + Web UI** — `reply()` 里的按钮 / 单选 / 多选、免 LLM 管理按钮、工具调用流式推送、截图、一键中断、skills 的 slash 补全。
- **多前端 API** — `GET /events` SSE、按 agent scope 的 Bearer `POST /api/v1/agents/:name/messages`、`ChatAdapter` 注册表；bridge 默认只绑 `127.0.0.1`。
- **Claude Code agents 模式适配** — 会话清单 + 分身检测、重启时 fork 自愈、adopt/cleanup（`lib/bg-jobs.ts`）。
- **后台活动子区 + 会话归档** — subagent / 后台 shell 各开子区；退役会话快照到 `~/.claude-orchestrator/archive/`（另有每日补扫）。
- **只读历史 API + 手动归档区** — `GET /api/v1/agents/:name/history`、归档/恢复端点，保留期只清手动归档区。
- **Pi agent 会话** — `runtime: "pi"` 经 Pi 扩展接入，能力档案（`pi-env`），会话记录翻译成 Claude Code 形状（`lib/session-source.ts`）。
- **HTTP peers** — 跨实例协作走 `/api/v1`，scope token + 一键邀请；大总管永不可分享。

## 安全姿态

- **防手滑护栏（不是安全边界）** — 每个 spawn 的 agent 都带 `--disallowedTools` 黑名单（`rm -rf`、`git push --force`、`git reset --hard`、`chmod 777`、fork bomb）。规则是**对命令字符串做前缀匹配**，等价写法（`/bin/rm -rf`、`rm -fr`、`find … -delete`、`python -c`、变量拼接）都能绕过，且没有 `PreToolUse` 钩子兜底。加上 `DEFAULT_PERMISSION_MODE` 就是 `bypassPermissions`（见 `lib/claude-launch.ts`），每个 agent 实质上是一个以用户身份运行的无限制 shell —— 黑名单只防意外，挡不住任何有意为之的 prompt。

## 运行时命令

```bash
# 首次部署：收集 Discord 配置、写 .env、渲染 master/CLAUDE.md
bun run setup

# 启动全部（bridge + launcher + cron-scheduler）
bun src/manager.ts install-cli   # 写入并加载 3 个 launchd daemon

# Agent 生命周期
bun src/manager.ts create   <name> <dir> [purpose]
bun src/manager.ts resume   <name> <sessionId> [dir] [--fork]  # --fork: 分支副本收编野生/被占用会话
bun src/manager.ts adopt    <name> <sessionId>   # 把 bg 分身收编为正式会话并重启
bun src/manager.ts archive  <name>               # 立即快照该 agent 当前 session 的对话 jsonl 到归档
bun src/manager.ts kill     <name>
bun src/manager.ts restart  [name]
bun src/manager.ts restart  --include-master   # v2.24+ 全体重启（含大总管）
bun src/manager.ts list
bun src/manager.ts sessions [search]

# Project 归组（v2.21+;每个 agent 必属一个 project,create 缺省按目录自动归属）
bun src/manager.ts project-add    <id> --dirs <a,b> [--name <显示名>] [--emoji <e>] [--desc <说明>]
bun src/manager.ts project-list
bun src/manager.ts project-edit   <id> [--name ..] [--emoji ..] [--dirs a,b] [--desc ..]
bun src/manager.ts project-remove <id>            # 有成员时拒绝
bun src/manager.ts project-assign <agent> <projectId>   # 转移归属,Discord 频道自动挪 category
bun src/manager.ts project-migrate                # 存量 agent 补 projectId（bridge 启动时自动跑）

# 定时任务
bun src/manager.ts cron-add     <name> "<cron>" <dir> <prompt...> [--effort <level>]   # 临时 agent 的档位,缺省 medium(v2.21.3+)
bun src/manager.ts cron-list
bun src/manager.ts cron-remove  <name|id>
bun src/manager.ts cron-toggle  <name|id>
bun src/manager.ts cron-history [name|id]

# 跨 Claudestra peer 协作 — HTTP peers（不依赖 Discord，直接走 /api/v1；
# 设计见 docs/design-http-peers.md）
# v2.15+ 一键邀请（推荐）：A 生成、B 粘贴，B 的 bridge 自动回调 A 的
# /api/v1/peers/redeem——免回执/accept。一次性、24h 过期，过期/撤销连带吊销
# 内嵌 token。B 加入时默认不反向开放任何 agent（单向授权）；对称访问 = B 也
# 生成一张邀请发回来。
bun src/manager.ts peer-invite-new --agents <a,b|*> [--url <我方bridge地址>] [--force]   # A: 打印一键邀请串（URL 自动探测 Tailscale 优先；BRIDGE_BIND 还是回环会警告）
bun src/manager.ts peer-join-auto '<邀请串>' [--agents <x,y>] [--url <我方地址>] [--force]  # B: 粘贴即完成（--agents = 可选的反向开放）
bun src/manager.ts peer-invite-list               # 待兑换邀请（顺带清扫过期 + 吊销其 token）
bun src/manager.ts peer-invite-revoke <inv_id>    # 作废未兑换的邀请 + 其内嵌 token
# 旧三步握手（对方跑 v2.15 之前的版本时用）：
bun src/manager.ts peer-http-invite <name> --agents <a,b> [--url <我方bridge地址>] [--force] [--rotate]  # A: 打印邀请串（--url 不给则自动探测：Tailscale 优先，其次内网）
bun src/manager.ts peer-http-join <name> '<邀请串>' --agents <x,y> --url <我方地址> [--force]           # B: 存下 A 并打印回执
bun src/manager.ts peer-http-accept <name> '<回执串>'                                                  # A: 完成握手
bun src/manager.ts peer-http-test <name>          # GET 对方 /agents — 验证连通 + scope
bun src/manager.ts peer-http-list                 # 列 HTTP peers + 握手状态
bun src/manager.ts peer-http-scope <name> --agents <a,b|*> [--force]  # v2.11.1+: 原地改入站 scope（token 不变，立即生效）
bun src/manager.ts peer-http-remove <name>        # 删 peer + 撤销我方签发的 token
# send_to_agent 的 target 语法："<agent>@<peer>" 或 "peer:<peer>.<agent>"
# 大总管永远不可分享给 peer（v2.15+ 硬规则，--force 也不放行；历史 peer token
# 列了 master 的在 agentInScope 层被截断）

# 体检（只读；出问题时第一个该跑的）
bun src/manager.ts doctor [--json]

# 版本
bun src/manager.ts version   # 当前版本 + 是否有更新
bun src/manager.ts update    # git pull + 重载 3 个 launchd daemon

# 自动更新开关（两者默认开；launcher 定期轮询，只在所有 agent 空闲时才升级）
bun src/manager.ts auto-update status
bun src/manager.ts auto-update claudestra on|off   # Claudestra 自更新（30 分钟轮询）
bun src/manager.ts auto-update claude on|off       # Claude Code CLI（每周轮询）

# 多前端 API token（v2.6.0+；scope = 按 agent 的白名单，"*" = 除 master 外全部）
bun src/manager.ts token-add <name> --agents <a,b|*> [--force] [--no-mirror] [--terminal]  # --terminal = 远程终端(宿主 shell 级)独立授予
bun src/manager.ts token-list
bun src/manager.ts token-revoke <tokenId|name>
bun src/manager.ts create <name> <dir> --external   # 标记 agent 可安全对外（R1 守卫）

# token 用量统计（解析 ~/.claude/projects/<slug>/<sessionId>.jsonl）
bun src/manager.ts cost [--agent <name>] [--today|--week]

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
| `BRIDGE_BIND` | HTTP/ws 绑定地址（默认 `127.0.0.1`；`0.0.0.0` 对外开放，反代/TLS 自理） |
| `BRIDGE_CONTROL_TOKEN` | v2.21.1+ 控制面 token：**非回环**访问裸路由（`/hook` `/stats` `/skills/rescan` `/agent/cleanup` `/events`）与 ws 升级（`route_to_agent` = 主机 RCE）时要求命中。回环永远豁免；`/api/v1/*` 走自己的 Bearer（peer 不受影响）。不设 = **fail-closed**：非回环控制访问一律拒（当前合法流量 100% 回环，默认零影响）。仅当确需远程直连这些路由时才设。 |
| `BRIDGE_CORS_ORIGIN` | v2.10+ CORS 白名单：逗号分隔 origin 或 `*`（默认不设 = 不发 CORS 头） |
| `BRIDGE_STATIC_DIR` | v2.10+ bridge 直接托管的静态目录（含 SPA fallback；默认不设 = 关闭） |

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

- 大总管是 `master` tmux session 的 window 0。`com.claudestra.launcher` 这个 launchd agent 保证它存在且正在运行 Claude Code。
- 每个 agent 的 Discord channel ID 记录在 `~/.claude-orchestrator/registry.json` 里。Bridge 用这个 registry 把入站的 Discord 消息路由到对应的 channel-server。
- MCP server 名（`MCP_NAME`）必须在三处保持一致：`claude mcp add`、channel-server 注册、jsonl-watcher 的 tool 过滤前缀。它集中在 `src/bridge/config.ts` 和 `src/lib/claude-launch.ts`。
- Agent 名字在 create/resume 时走 shell 元字符黑名单校验，在 kill/restart 时宽松归一，以兼容历史 CJK 命名的 worker。
- Tool call 展示通过 `WATCHER_CONFIG.debounceMs`（默认 1500ms）去抖，避免在 tool 爆发时触发 Discord 限流。
- **`channel-server` 生命周期（v2.14+）**：一切都由一条约束推导——**channel-server 没有守护者**，Claude Code 既不会 respawn 死掉的 stdio MCP server，也不会自动重连，所以它一旦退出就是该 agent 永久失联。两条规则：（1）**握手之后才注册**。`mcp.oninitialized` 是连 bridge 的闸门，野进程光把 `channel-server.ts` 跑起来抢不到频道——这很要紧，因为 `DISCORD_CHANNEL_ID` 由 Claude Code 注入并被**所有 Bash 子进程继承**，在 agent 自己的仓库里手滑跑一次就会顶掉正在服务的连接。留了 30s 兜底，SDK 不回调也照常注册。（2）**被顶替不等于该死**。收到 `replaced` / `close(4001)` 时看 stdio 还在不在：Claude Code 仍在用本进程就退避重连、把频道拿回来（3s→60s，且计数要稳定持有 30s 才归零，两个活实例只会退化成慢速轮换，不会 3 秒一轮互抢）；只有 `mcp.onclose` 才是正当退出。判定逻辑独立在 `lib/link-policy.ts` 并有单测。`code 1000`（bridge 重启）仍按瞬断处理 → 指数退避重连。

## 贡献提示

- **发布流程**：commit 和 `git push` 到 `main` 可以自主执行。`git tag v*` + `gh release create` **每次都必须先获得 owner 明确同意** — 不要自己主动发 release。GitHub 上只保留最新一个 release，之前版本视为不兼容会被删除。
- **批量发版，别连发**（owner 2026-07-08 在复盘 2.5 个月 59 个 release 后规定）：不紧急的改动先攒在 `main`，每个工作时段/每天结束时**合成一个 release**，包含自上次 release 以来的全部改动（参照 v2.5.4：五个功能/修复，一次发版）。只有生产挂掉的热修才值得立刻单独发。同一天连发多个 release（如 2026-04-25 发了 4 个）通常说明没验证就发了——先验证再发。版本语义要诚实：新的用户可见能力 = minor，哪怕很小；patch 只用于修复/重构/打磨。
- **版本号规则**（owner 规定，2026-04-20 自 v1.7.0 起细化）：
  - **Patch**（`x.y.Z`）— bug 修复、小增强、多几个 CLI 子命令、重构、测试、文档、UI 打磨。大多数改动属于这一档。如果这次 bump 专门是修 bug，还要用 `gh release delete <tag> --yes --cleanup-tag` **删掉有 bug 的那个 release**，让 Releases 列表里没有坏版本。打磨/小功能类 patch 不删上一个版本。
  - **Minor**（`x.Y.0`）— 真正新的、值得一句「现在你可以……」标题的用户可见能力。例：v1.3.0 Claude Code 自动更新、v1.5.0 Discord slash 补全。旧 minor 作为历史保留。
  - **Major**（`X.0.0`）— 破坏性变更或系统级重构。由 owner 手动 bump；不要自己主动升 major。
  - 判断法：写 release notes 时如果开头是「修了……」「加了个……」「补了测试」「重构了……」——那就是 **patch**。只有配得上标题的新能力才是 minor。
- `tmux-helper.ts` 和 `claude-launch.ts` 是 tmux 命令和 Claude Code 启动参数的**唯一权威位置**。新文件里不要再内联这些。
- 需要绕过 LLM 的管理按钮放到 `bridge/management.ts`。把 `id` 同时加到 `handleMgmtButton` 和对应的面板构造器。
- 提交前跑 `bun run check`（= `tsc --noEmit` + `bun test` + `scripts/guard`）。**`bun build` 不做类型检查** —— 它对 `const x: number = "str"` 直接放行，此前"用它快速抓类型错误"的说法是错的。每个入口仍要 `bun build src/<entry>.ts --target=bun` 跑一遍（`bridge`、`channel-server`、`manager`、`launcher`、`cron`、`setup`），它能抓到类型检查覆盖不到的模块解析错误。CI 在每次 push / PR 上跑这三件事。
- Cron 测试套件覆盖解析器和下次触发时间计算，但不跑真实 agent——集成测试在 sandbox Discord server 里手动做。
