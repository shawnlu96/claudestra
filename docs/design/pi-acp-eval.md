# 评估：Pi agent 走 ACP（替代 tmux + TUI）

> spike 分支 `spike/pi-acp-eval`，2026-10-01。全部实测在沙箱或 scratch 目录里完成，用的是 pi 0.99.1 + deepseek-v4-flash（便宜档）。
> 证据日志放在 [`pi-acp-eval/`](./pi-acp-eval/) 下，里面不含 key。

## 结论（先看这段）

- **推荐路线：(a) 在仓库里写一个自家的 ACP→pi rpc 小适配器；宿主继续只说 ACP。工具走 Pi 原生 MCP 挂 channel-server，和 Codex 完全同一条路。**
  决定性的实测是 Pi 0.99 的扩展 API `pi.registerMcpServer()`：它能按会话把 channel-server 挂成 MCP server，模型看到的是 `mcp__claudestra__*`，调用 reply 后 bridge 收到 `reply` 帧（[03](./pi-acp-eval/03-pi-native-mcp.log)）。
  这样一来，宿主的工具代理、出站确认、回合队列、失败分类都能原样复用。Pi 专有的东西只剩适配器这一处。
- **社区适配器（pi-acp 等）不用**（owner 已拍板）。实测也证实它接不上：它不理 `session/new` 的 mcpServers，没有 set_model，没有 resume，不支持 steering，`/new` 会被当成普通文字发给模型（[02](./pi-acp-eval/02-pi-acp-community.log)）。
- 另外还跑通了一个**直连 rpc 小宿主**原型（`src/pi-rpc-host.ts`，不经 ACP 宿主）：7 项全部在沙箱里过了（[04](./pi-acp-eval/04-sandbox-e2e-direct-host.log)）。它证明 rpc 模式本身完全够用。但它是把宿主另起一套，不符合「先复用 ACP 宿主、降低维护成本」的方向，所以只当可行性证据，不推荐落地。
- 工作量：路线 (a) 约 3–4 人日，含测试和一轮审查，拆法见 §4。

## 1. 两条自家路线怎么选：(a) 自写适配器 vs (b) 宿主直接说 pi rpc

| | (a) 自写 ACP↔pi rpc 适配器 | (b) 宿主加一种 Pi 会话实现 |
|---|---|---|
| 宿主改动 | 小：只去掉写死 Codex 的约 10 处（§6），协议层一行不动 | 大：`AcpHost` 现在直接依赖 `AcpSession` 和 ACP 的 update 翻译器，得先抽出会话接口，再补一个 Pi 事件→CC 形状的翻译器；`host.ts` 已经 400 行，在尺寸上限上 |
| 新代码 | 适配器约 350 行 + 测试 | Pi 会话约 250 行 + 翻译器；宿主重构的 diff 另算 |
| 跟 Pi 升级 | 只改适配器。rpc 协议有公开的 `rpc-types.ts`，契约稳定 | Pi 的变化会渗进宿主内部 |
| 可测性 | 适配器单独起进程，用宿主现有的 ACP 单测套路就能测；沙箱里还能替掉 stub | 要改宿主现有测试 |
| 进程数 | 多一跳（宿主→适配器→pi） | 少一跳 |
| 供应链 | 在自己仓库里，不用钉第三方 | 同左 |

**选 (a)**。改动集中在一个新文件里，宿主保持单一协议，Pi 升级只影响适配器。多一跳的代价是一次 stdio 转发，可以忽略。

适配器要做的映射（左边 ACP，右边 pi rpc）：

- `initialize` → 声明 `sessionCapabilities.resume` 和 `_meta.steering.supported`
- `session/new`：自己生成 id，起 `pi --mode rpc --session-id <id> …`；`session/resume` 用同一条命令（Pi 的 `--session-id` 是 open-or-create，没有 Codex 那种引导轮）
- `session/prompt` → `prompt`，等到 `agent_settled` 再回 `stopReason`；被打断回 `cancelled`
- `session/cancel` → `abort`
- `_session/steering` → 带 `streamingBehavior:"steer"` 的 `prompt`
- `session/set_config_option`：model 对应 `set_model`，thought_level 对应 `set_thinking_level`
- 事件：`message_update.text_delta` → `agent_message_chunk`；`tool_execution_start/update/end` → `tool_call` / `tool_call_update`。MCP 调用在 `rawInput` 里带上 `server/tool`，宿主的翻译器（`updates.ts`）靠它拼 `mcp__claudestra__reply`，reply 的识别和隐藏都照旧。
- 忙闲：发 `session_info_update`，但 `_meta` 用中性的键，不冒充 `_meta.codex`，宿主那边一起改（见 §6）。

## 2. rpc 能力逐项对宿主需求（都已实测）

| 宿主需要 | pi rpc 怎么给 | 实测 | 缺口 / 注意 |
|---|---|---|---|
| 流式正文 | `message_update`（text_delta）、`message_end` | ✅ [01] | — |
| 工具调用显示 | `tool_execution_start / update / end`（带 args、result、isError） | ✅ [01][04] | — |
| 忙 / 完成 | `agent_start` / `agent_settled`；`agent_end` 之后可能还有重试或压缩，要以 settled 为准 | ✅ [01] | — |
| 打断 | `abort`：bash 当场被杀，回合 settle | ✅ [01][04] | — |
| 回合中插话 | `prompt` + `streamingBehavior: steer/followUp` | ✅ [04] | 不带这个参数，回合中直接报错 |
| /clear | `new_session` | ✅ [01][04] | 新会话 id 由 Pi 生成，不是我们指定的，要走 set-session 轮转。宿主更简单的做法是自己换一个新的 `--session-id` 重起 pi |
| 重启后恢复 | `--session-id <id>` 打开已有会话 | ✅ [04]：重启后答出重启前记下的暗号；崩溃重起后接回 /clear 之后的新会话 | — |
| 切模型 / 思考档 | `set_model`、`set_thinking_level` | ✅ [01] | 思考档会按模型收敛（deepseek 上设 low，实际成了 high），宿主要用回包里的实际值 |
| 能力档（pi-env、`--pi-base minimal`） | 还是命令行参数，rpc 模式下一样生效 | ✅ | ⚠ `--no-extensions` 会把**内置的 MCP 支持也关掉**，工具走 MCP 时必须补 `-e builtin:mcp`（[03] 就是这么起的） |
| session 文件翻译（`session-source.ts`） | 同一批文件、同一目录（`PI_CODING_AGENT_DIR/sessions/`），格式不变 | ✅ [04]：历史 API 能读出 | — |
| 扩展弹对话框 | `extension_ui_request`（select / confirm / input / editor） | 原型里自动回「取消」 | **缺口**：真要接的话，接到宿主的权限卡上；不接就一律取消 |
| 我们自己的工具 | 两条路都通：①扩展自己的 ws（[01]）②扩展调 `registerMcpServer` 挂 channel-server（[03]） | ✅ | 路线 (a) 用 ②；① 会和宿主同时向 bridge 登记，抢同一个频道 |
| 用量 / 上下文 | `get_session_stats`；社区适配器给过 `usage_update` | 未接 | 适配器按回合发 `usage_update` |
| 调用方身份（T85） | 宿主出示凭据，和 Codex 一样 | 未测 | channel-server 经宿主的回环代理出站，不改 |

还缺的只有两项：**扩展对话框**（没接）和**用量上报**（没接）。其余都已具备。

## 3. 原型（沙箱）

### 3a. 直连 rpc 小宿主（已跑通，作为可行性证据，不推荐落地）

- `src/pi-rpc-host.ts`（96 行）+ `src/lib/pi-rpc.ts`（66 行，纯函数）+ `tests/pi-rpc.test.ts`。
  在 tmux 窗口里起 `pi --mode rpc <原来那套参数>`，把窗口里的一行输入翻成 rpc 命令：`/clear` 对应 `new_session`，`/quit` 退出，其余都当 prompt。bridge 一行没改。
- 沙箱里经 `/api/v1` 端到端跑了一遍（[04]）：
  1. 发消息 → bash → reply 回到调用方，SSE 里有 `tool_start` / `tool_done` / `assistant_text`
  2. 历史 API 能读
  3. web 停止按钮打断了 `sleep 30`
  4. `pi-settings` 切到 deepseek-flash、思考档改 high
  5. 重启后同一个 session-id，记忆还在
  6. /clear 后上下文清空，registry 轮转到新会话
  7. 杀掉 pi 子进程：宿主带退出码 137 回到 shell，bridge 看到断开；再重启能接回会话

  其中第 6 项依赖 §7 里的 bug 1 修复。修之前，轮转会 120s 后静默超时（[04] 里 before/after 的 session id 相同就是这个）。修好后的 bridge 日志：`🧹 clear 轮转完成 agent=agent-pia 75544594->01a0f344`。

### 3b. 路线 (a) 的两个关键零件（已单独验证）

- **rpc 模式下扩展照常加载**（[01]）：ws 登记、入站消息、`reply`、`/hook Stop`、rpc 和 ws 两条打断路径、扩展命令（`/claudestra-thinking` 回 `disposition=handled`）、`new_session` 后带新 id 重新登记、关 stdin 干净退出，全部通过。
- **Pi 原生 MCP 挂 channel-server**（[03]）：`pi --mode rpc -ne -e builtin:mcp -e mcp-reg.ts`，其中 `mcp-reg.ts` 就是一行 `registerMcpServer("claudestra", {command: bun, args: [channel-server.ts], env, exposure: "direct"})`。结果：channel-server 在 0.3s 内向 bridge 登记；bridge 推过去的 channel 通知 Pi 不认，这符合预期，因为入站由宿主经 prompt 投递；模型调用 `mcp__claudestra__reply` 后，bridge 收到 `{"type":"reply",...}`。

**路线 (a) 本身的端到端还没在沙箱里接起来。** 适配器还没写，这是实现卡的第一步（§4）。

## 4. 工作量、风险、要拍板的点

### 工作量（路线 a）

| 块 | 估计 |
|---|---|
| `src/lib/acp/pi-adapter/`：ACP 服务端 ↔ pi rpc 映射（§1 列表）+ 单测 | 1.5 天 |
| 宿主去 Codex 化（§6 的约 10 处），`acp-lifecycle` 放开 pi，`runtimes/pi-acp.ts`（没有引导轮，比 codex-acp 简单） | 1 天 |
| 能力档：`-e builtin:mcp` 加一个挂 MCP 的小扩展（取代 `claudestra-extension.ts` 的通道部分）；pi-settings 路由改走 `acpSettings` | 0.5 天 |
| 沙箱策略重新设计 + 审（§5）、沙箱 e2e、迁移（存量 Pi agent 从 tmux 切到 acp，参照 codex 的 migration） | 1 天 |

### 风险

- **沙箱放开 Pi 是安全边界的改动**（§5），必须单独设计、单独审。
- Pi 的 rpc 协议还在 0.x，字段会变。缓解办法：适配器只依赖 `rpc-types.ts` 的公开字段，另加一个契约测试，用固定的 pi 版本录一段事件流回放。
- `--no-extensions` 会关掉内置 MCP，这是个静默的坑：能力档忘了补 `-e builtin:mcp`，结果就是模型看不到 reply，也不报错。要在启动命令构造处强制加，并加单测钉住。
- 迁移之后，`src/pi/claudestra-extension.ts`（612 行）的通道部分就可以退役，但 TUI 版 Pi 要不要继续留，需要定（见下面第 1 点）。
- 思考档按模型收敛，web 上显示的值要以回包为准，否则会显示错。

### 要 owner 拍板的点

1. **Pi 的默认 transport 切成 acp 之后，tmux + TUI 版还留不留？**
   - 留：扩展要维护两份通道逻辑。
   - 不留：打开窗口就只看得到日志，不能在 TUI 里手动接管 Pi。Codex acp 现在就是这样。
2. **扩展弹对话框怎么处理**：接到宿主的权限卡，还是一律取消？现在装的扩展里没有会弹框的；接权限卡约多 0.5 天。
3. **路线 (a) 还是 (b)**。建议 (a)，理由见 §1。

## 5. 本 spike 放宽的沙箱闸门（只留在 spike 分支，正式实现要重新设计、单独审）

为了在沙箱里跑 Pi，放宽了以下几处：

- `lib/sandbox.ts` `assertSandboxRuntime`：当 `PI_CODING_AGENT_DIR` 恰好等于 `<沙箱根>/pi-agent` 时放行 `runtime=pi`。
- `lib/sandbox-env.ts`：沙箱环境加了 `PI_CODING_AGENT_DIR`；`sandboxManagerRefusal` 不再拒 `--runtime pi`。
- `lib/sandbox-sessions.ts`：set-session 的会话 cwd 检查也会查 Pi 的会话文件。
- `lib/pi-launch.ts`：沙箱里 Pi 固定走 rpc 小宿主，启动前缀带上 `PI_CODING_AGENT_DIR`。

随之改了两条单测（`tests/sandbox.test.ts`：env 期望值多了 `PI_CODING_AGENT_DIR`；`--runtime pi` 从拒绝改成放行）。

没管住的地方（正式实现要补）：
- Pi 进程和扩展不经 `sandbox-outbound` 的出站闸，Pi 自己会连模型 provider。
- Pi 的全局扩展发现没有关：沙箱没带 piEnv 档案时，会加载 `PI_CODING_AGENT_DIR` 下的扩展。当时那个目录只放了 models.json 和 settings.json。

凭据只拷了 deepseek 这一家的 provider 配置，放在沙箱根下，权限 0600；`~/.pi` 全程只读。

## 6. 泛化宿主要改的地方（写死 Codex 的点）

| 位置 | 写死的内容 | 改法 |
|---|---|---|
| `manager/acp-lifecycle.ts:30` | `runtime !== "codex"` → 回退 tmux | 改成按 runtime 查 ACP 能力 |
| `lib/acp/host.ts:97` | 登记帧 `runtime: "codex"` | 取 `cfg.runtime` |
| `lib/acp/host.ts:337` | `codexReplyHint` / `wrapChannelContent` | 提示文字做成中性的（它只讲 `mcp__<name>__reply` 怎么用） |
| `lib/acp/adapter-proc.ts` | `CODEX_MCP_ENV_VARS`、`CODEX_CONFIG` 深合并 mcp_servers、`CODEX_PATH`、`INITIAL_AGENT_MODE`、`CLAUDESTRA_RUNTIME: "codex"`、日志前缀 `[codex-acp]` | 拆成按 runtime 的 `adapterEnv`；Pi 版通过环境变量把 proxy 地址交给挂 MCP 的扩展 |
| `lib/acp/adapter-proc.ts` `acpAgentCommand` | 沙箱外是 codex-acp 的安装路径（`install.ts` 钉版本加哈希校验） | Pi 适配器在仓库里，直接 `bun <路径>`，不需要 install / resolve |
| `lib/acp/session.ts` + `updates.ts` `threadStatusOf` | 忙闲认 `_meta.codex.threadStatus`；`systemError` 的文案 | 读一个中性键，两个适配器都发 |
| `lib/acp/failures.ts` | `codexErrorInfo === "usageLimitExceeded"`、「Codex 回合失败」 | 按 runtime 给分类表 |
| `lib/acp/clear.ts` | `BOOTSTRAP_PROMPT` 引导轮（Codex 新线程要跑一轮才落盘） | Pi 不需要，按能力跳过 |
| `lib/acp/permissions.ts` | 卡片标题「Codex 请求授权」 | 带上 runtime 名 |
| `lib/acp/readiness.ts` | 整个文件是 Codex CLI / app-server 探测 | 给 Pi 加一个 `pi --version` 探测 |
| `src/acp-host.ts` | `noteAcpCodexRunning`、`CODEX_READY_OPTION` | 就绪标记本来就是同一个 `@claudestra_ready`，改名即可 |
| `lib/acp/stub.ts` / `lib/sandbox.ts` | 沙箱只许起 stub | 见 §5 |

估计约 1 人日（已含在 §4 里）。

## 7. 顺带发现的两个现有 bug（不在 spike 里，交 PM 另开 PR；改法见 [`05-existing-bugs.patch`](./pi-acp-eval/05-existing-bugs.patch)）

1. **Pi 的 /clear 会话轮转 120s 后静默超时。**
   - 现象：清了上下文，但 registry、watcher、历史还停在旧会话上。日志：`🧹 clear 轮转超时 agent=…（未见新 session jsonl…）`。
   - 根因：三个入口（`api-routes.ts:1313`、`api-slash.ts:120`、`discord-interactions.ts:584`）调 `scheduleClearRotation` 时都没传 runtime，于是缺省到 CC 的会话目录里找新会话，Pi 的新会话永远找不到。
   - 改法：在 `scheduleClearRotation` 里补一行 `runtime ??= clients.get(channelId)?.runtime`，一处改完，三个入口都修好。沙箱实测修后能轮转成功。TUI 版 Pi 走同一条代码，也中招。
2. **用量抓取器往非 CC 窗口里敲 `/status`。**
   - 根因：`stats-dashboard.ts` `findIdleScrapeTarget` 只排除了 `runtime === "codex"` 的窗口。
   - 现状下 Pi 的 TUI 不画 `❯`，所以碰巧没被选中；任何画出 `❯` 的非 CC 窗口都会被敲。
   - 改法：只认 CC 窗口，即 `a.runtime && a.runtime !== "claude-code"` 的都排除。

## 附：社区适配器 pi-acp 0.0.34 的源码与实测要点（owner 已决定不用，留档）

- 包：`pi-acp@0.0.34`，npm integrity 已核对（`sha512-MrCp37…Bkkg==`），没有安装脚本，依赖是 `@agentclientprotocol/sdk`、`zod`、`cross-spawn`。
- 行为：起 `pi --mode rpc --no-themes [--session <path>]`，没法加参数，只能靠 `PI_ACP_PI_COMMAND` 包一层。会写 `~/.pi/pi-acp/session-map.json`，会读 `~/.pi/agent/prompts|extensions`、`~/.agents/skills`。`session/delete` 和新建失败时会 **unlink 会话文件**。没看到联网代码。
- mcpServers 只存不用：实测传进去一个会写标记文件的 server，没有被起。
