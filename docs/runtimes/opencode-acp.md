# OpenCode `acp` 能不能直挂 Floka 的 ACP 宿主（OCR-1B 实测结论）

- **测的版本**：`opencode-ai` 1.19.2（npm 全局包，initialize 回包 `agentInfo` = `OpenCode 1.19.2`）；测试日期 2026-10-16。
- **怎么测的**：`scripts/opencode-acp-probe.ts` 起 `opencode acp --cwd <临时目录>`，按宿主 `src/lib/acp/session.ts` 的线路逐帧对话；
  回包和流式更新直接交给宿主自己的 `checkInitialize`（`lib/acp/protocol.ts`）、`permissionCard`（`lib/acp/permissions.ts`）、
  `createAcpTranslator`（`lib/acp/updates.ts`）去判和翻，看宿主代码一行不改时能拿到什么。原始往返已脱敏，放在 `tests/fixtures/opencode-acp/`。
- **隔离**：`HOME` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` 全部指到会话临时目录，cwd 是一个空临时目录；
  没碰 owner 的家目录、`~/.pi`，也没碰任何交易项目目录。用的模型全是免费模型（`opencode/big-pickle`、`opencode/deepseek-v4.1-flash-free`、
  `opencode/mimo-v2.6-flash-free`），没登录、也没有 key。
- 下面每条都标了 **【实测】**（有夹具或探针输出为证）或 **【推断】**（读帮助或现象推出来的，没有专门测）。

## 结论：直连可行（不写适配器进程，宿主侧按运行时加三处小改）

`opencode acp` 讲的就是 ACP v1，宿主现有的判定和处理代码不改也能用：initialize 的兼容判定直接通过；session/new、resume、load、prompt、cancel、
set_config_option、request_permission 的形状都和宿主预期一致。真正的差距只有三处，都是**流式条目怎么翻**的问题，
给 `createAcpTranslator` 加按运行时的参数就能补，不需要像 Pi / Codex 那样另起一个适配器进程：

1. **工具调用起头太早**：`tool_call`（pending）只带工具名（`title: "bash"`），入参 `rawInput` 是空的或只有 cwd；真正的命令和参数在随后的
   `tool_call_update`（in_progress）里才来。宿主现在一见 `tool_call` 就吐 `tool_use`，结果命令显示成 `bash`，MCP 调用的入参是 `{}`。
2. **MCP 工具名对不上**：OpenCode 把 MCP 工具叫 `<server>_<tool>`（实测 `probe_ping`），也不带 `_meta.is_mcp_tool_call`。
   bridge 认 reply 靠 `mcp__<server>__reply` 或裸名 `reply`（`lib/session-history-parse.ts` 的 `isReplyTool`、`bridge/jsonl-watcher.ts`、
   `lib/acp/transcript.ts`），`claudestra_reply` 一个都对不上。
3. **压缩完成没有信号**：`/compact` 能用、OpenCode 也真的压缩了，但不发 `compaction_update`，也不发 `session_info_update`。
   宿主现有的两种来源（`claudestra-meta` / `compaction-update`，见 `host.ts` 里选来源的那一行）都等不到边界。

上面三处要是交给一个薄适配器进程去改字段，等于为了改三个字段多维护一个进程、一份协议转发和一份重启逻辑；在 translator 里加参数更省事，
也和现在「按运行时选压缩来源」是同一种做法。

## 逐条对照

### 1. initialize 能力表 【实测】夹具 `initialize.jsonl`

| 字段 | OpenCode 回的 | 宿主怎么用 | 结论 |
|---|---|---|---|
| `protocolVersion` | `1` | `checkInitialize` 只认 v1 | 能 |
| `agentCapabilities.loadSession` | `true` | 接回线程的必要能力之一 | 能 |
| `sessionCapabilities` | `resume` / `fork` / `list` / `close` 都声明了 | 有 resume 就用 resume，不回放历史 | 能（`hostVerdict: {ok:true, resume:true, fork:true}`） |
| `mcpCapabilities` | `http` / `sse`（stdio 是 ACP 基线，不用声明） | channel-server 走 stdio | 能（见第 7 条） |
| `promptCapabilities` | `image` / `embeddedContext` | 宿主只发文本 | 能 |
| `authMethods` | `opencode-login`（提示去终端跑 `opencode auth login`） | 宿主不调 authenticate | 免费模型用不上（见第 8 条） |
| `agentInfo` | `{name:"OpenCode", version:"1.19.2"}` | 记进日志 | 能 |
| `_meta.steering` | 没有 | 可选能力，缺了就降级：忙时到的消息排队等下一轮 | 能（降级） |
| `_meta.claudestra.cancelReturnsQueue` | 没有 | 缺了就发 `session/cancel` 通知 | 能（降级） |

宿主 initialize 时还会带 `_meta.jetbrains.air`（AIR 的结构化失败）；探针没带这一段。【推断】OpenCode 不认识的 `_meta` 会忽略，
不影响握手；结构化失败拿不到，失败只能从 session/prompt 的 JSON-RPC 错误里分类（见第 2 条末尾）。

### 2. 会话生命周期

- **session/new** 【实测】`session-new.jsonl`：回 `sessionId`（形如 `ses_…`）和 `configOptions`（`model`、`mode` 两个 select），
  没有老式的 `models` / `modes` 字段。会话一建就写进库（没跑任何 prompt 的会话也查得到），所以 `/clear` 用不着引导轮（`clearBootstrap` 不填）。
  建完马上推一条 `available_commands_update`（`customize-opencode` / `init` / `review`）。
- **session/resume** 【实测】`load-resume.jsonl`：在**另一个** `opencode acp` 进程里按 sessionId 接回 basic 场景的会话，只回 `configOptions`、
  不回放历史；接着问「之前跑过什么命令」，答得出 `ls -1`，说明上下文完整接回。宿主有 resume 时优先用它，正好对上。
- **session/load** 【实测】同一夹具：会回放历史，内容是 `user_message_chunk`、`agent_thought_chunk`、`agent_message_chunk`，以及一次性带全了的 `tool_call`。
  宿主只有在没 resume 时才用它，OpenCode 用不上这条路。
- **session/prompt** 【实测】`prompt-tool-call.jsonl`：回 `{stopReason:"end_turn", usage:{inputTokens, outputTokens, totalTokens, thoughtTokens, cachedReadTokens}}`；
  `stopReason` 在宿主认的集合里。
- **session/cancel** 【实测】`cancel.jsonl`：等 shell 工具跑起来（`sleep 60`，in_progress）再发 `session/cancel` 通知，**31 ms** 后 prompt 就回
  `stopReason:"cancelled"`。跑着的命令被杀掉，工具以 `status:"completed"`、输出 `User aborted the command` 收尾（注意不是 `failed`，
  宿主的 tool_result 不会标 `is_error`）。打断后马上再发一轮，正常回 `end_turn`。
  另有一次单独观察（原始帧被后来的重跑覆盖了，没有夹具）：在模型**还没出任何流式更新**时就 cancel，同样很快回 `cancelled`，
  但被打断的那条用户消息留在了上下文里，下一轮模型先把它做了。那次随后卡到超时，是探针当时给权限请求回了个不合法的 `{}`，属于探针的 bug，
  宿主不会这样回（宿主只回 `selected` 或 `cancelled`）。
- **fork / list / close**：声明了，【推断】按 ACP 规范可用，本卡没测（宿主的 fork 只在 fork 操作时需要）。

宿主还会靠 `session_info_update` 里的 `threadStatus`（active / idle）判断「线程在跑」，以及发现适配器自己开的回合（`session.ts` 的 `running` 和 `onSelfTurn`）。
OpenCode 一条 `session_info_update` 都不发【实测，所有场景都没有】。影响：
宿主自己发起的回合靠 `loop.busy` 跟踪，照样准；适配器自己开的回合跟不到。【推断】OpenCode 在 ACP 下没有自发回合（没有 Pi 那种子任务回调），所以没有损失。

回合失败：探针没碰到限流 / 免费模型下线，**失败的形状没测到**【推断】。OpenCode 没有 AIR，失败只会以 session/prompt 的 JSON-RPC 错误出现，
宿主会走 `classifyPromptError` 兜底分类；分类准不准，OCR-2 要找一次真失败（比如设一个已下线的模型名）补测。

### 3. 流式更新和 transcript / turn 要的字段 【实测】

| 更新 | OpenCode 的形状 | 宿主翻出来的 | 结论 |
|---|---|---|---|
| `agent_message_chunk` | 增量文本，带 `messageId` | 按 messageId 攒成一条 assistant 文本 | 能 |
| `agent_thought_chunk` | 推理增量（big-pickle 有；deepseek-v4.1-flash-free 那一轮没出） | 不吐（和 Codex 一致） | 能 |
| `tool_call`（pending） | `title`= 工具名（`bash` / `write` / `probe_ping`），`kind`（`execute` / `edit` / `other`），`rawInput` 是空的或只有 `{cwd}` | 当场吐 `tool_use`，命令成了 `"bash"`，MCP 入参 `{}` | **要补**（结论第 1 处） |
| `tool_call_update`（in_progress） | `title`= 真命令（`ls -1`），`rawInput` 带全参数；可能重复两三次，有时带输出快照 `content` | 宿主只合并字段，不再起头 | 推迟起头后能 |
| `tool_call_update`（completed / failed） | `content`（文本）+ `rawOutput:{output, metadata:{exit, truncated}}` | tool_result 取到 `content` 里的文本；拒绝授权是 `failed` → `is_error` | 能 |
| 命令输出增量 | 没有 `_meta.terminal_output_delta`，输出在 in_progress 快照和 completed 时整段给 | 拿到整段输出 | 能（降级：长命令跑的时候看不到增量） |
| `usage_update` | `{used, size, cost:{amount, currency}}`，免费模型 cost=0 | `context_usage`（tokens / window=200000） | 能 |
| `config_option_update` | 切模型后推送整份 configOptions | `model_state` | 能 |
| `plan` | 没观察到；【推断】OpenCode 的待办是 `todowrite` 工具，会以普通工具调用出现，不是 ACP 的 `plan` | 按普通工具显示 | 能（降级） |
| `available_commands_update` | 斜杠命令表 | 不进条目 | 能 |
| `session_info_update` / `compaction_update` | 不发 | 见第 2 条和第 6 条 | 降级 / 要补 |

### 4. 权限请求 【实测】夹具 `permission.jsonl`

- **什么时候来**：OpenCode 缺省放行 cwd 内的读写和 shell（basic、mcp 场景里一次都没问）；碰到 cwd 外的路径（它叫 `external_directory`）才发
  `session/request_permission`。例：`cat ../perm-a.txt`。
- **形状**：`toolCall:{toolCallId, title:"cat ../perm-a.txt", kind:"other", status:"pending", rawInput:{command, directories, patterns}}`，
  选项 `once`（allow_once）/ `always`（allow_always）/ `reject`（reject_once）。标准 ACP 形状。
- **宿主能不能接**：能，`permissions.ts` 不用改。`permissionCard` 生成的卡片是「OpenCode 请求授权：cat ../perm-a.txt」，正文是命令，三个按钮的颜色也对。
  第一次回 `selected once`，命令照常跑完（输出 `AAA`）；第二次回 `cancelled`（宿主没人点时的回法），工具以 `failed` 收尾，
  输出是 `The user rejected permission to use this specific tool call.`，模型继续往下走，回合正常 `end_turn`。
- **要定的**：Codex agent 是全权限、平时不弹卡。OpenCode agent 要不要同样放开 `external_directory`，是产品决定。
  【推断】可以用 OpenCode 配置里的 `permission` 段放开（启动时经 `OPENCODE_CONFIG_CONTENT` 交给它），具体键名 OCR-2 要按 1.19.2 的配置 schema 实测。
  另外 `always` 会被 OpenCode 自己记住（库里有 `permission` 表）【推断】，卡片上要不要留这个选项也一并定。

### 5. 模型 【实测】夹具 `model-switch.jsonl`、`session-new.jsonl`

- **列可用模型**：session/new 回包的 `configOptions` 里 `id:"model"` 那个 select 就是完整列表；没登录时是 12 个 `opencode/*-free` 加 `opencode/big-pickle`。
  CLI 的 `opencode models opencode` 只列了 10 个（少了 `glm-5.3-flash-free`、`ll-alpha-free`），**以 ACP 回包为准**。
- **免费模型名的写法**：`opencode/<id>`，例如 `opencode/big-pickle`、`opencode/deepseek-v4.1-flash-free`。列表会随 OpenCode 服务端增减。
- **按会话换模型**：`session/set_config_option {configId:"model", value:"opencode/deepseek-v4.1-flash-free"}` → 回包和 `config_option_update` 里
  `currentValue` 都换了；库里 `session.model` 变成 `{id:"deepseek-v4.1-flash-free", providerID:"opencode", variant:"low"}`，
  这一轮的 assistant 消息也是用它跑的。值不在列表里回 `-32602`（`model not found`）。宿主的 `setConfig`（先 `configRefusal` 本地挡，再调）不用改。
- **启动时给缺省模型**：`opencode acp` 没有 `-m` 参数（`opencode acp --help` 里没有）。用环境变量 `OPENCODE_CONFIG_CONTENT='{"model":"opencode/mimo-v2.6-flash-free"}'`，
  session/new 回的 `currentValue` 就是它。这个变量不写盘，不碰任何配置文件。
- **注意，跟设计「不默认走免费模型」相关**：什么都不配的时候，OpenCode **自己的缺省就是免费的 `opencode/big-pickle`**。
  所以 OCR-2 必须要求建 agent 时显式给模型（`--model`），每次起进程都把它带进 `OPENCODE_CONFIG_CONTENT`，resume 之后再
  `set_config_option` 校一次；不能指望 OpenCode 的缺省值。
- **推理强度**：库里的 `variant:"low"` 说明 OpenCode 内部有档位，但 1.19.2 的 configOptions 没有把它暴露成选项，宿主的 `reasoning_effort` 用不上【实测：configOptions 里只有 model、mode】。

### 6. 会话记录、压缩、清空

- **记录落在哪** 【实测】：`$XDG_DATA_HOME/opencode/opencode.db`（SQLite，WAL；没设 XDG 时就是 `~/.local/share/opencode/opencode.db`）。
  表 `session`（`id`、`directory`= cwd、`title`、`model`、token 统计、`time_compacting` …）、`message`、`part`（`data` 列都是 JSON）。
  部件类型实测有：`step-start` / `reasoning` / `tool` / `step-finish` / `text` / `compaction`。
- **按 sessionId 找回** 【实测】：`opencode export <sessionID>` 输出 JSON `{info, messages:[{info, parts}]}`；`opencode session list` 列出全部会话；
  ACP 里 resume / load 按 id 跨进程都能接回。
- **给 session-source 的建议**【推断】：库结构是 OpenCode 内部的、没承诺稳定，读历史优先走 `opencode export <id>`（一个子进程、一份 JSON），
  把 part 翻成 Claude Code 形状（`text` → assistant 文本，`tool` → tool_use + tool_result，`compaction` → compact_boundary）。
  不想起子进程时用 `sqlite3 -readonly` 读同一份库（只读，别和正在跑的 opencode 抢写锁）。
- **压缩** 【实测】夹具 `compact.jsonl`：把 `/compact` 当普通 prompt 发，回 `end_turn`；摘要以 `agent_message_chunk` 正文流出来（宿主会把它当一条
  assistant 文本记下）。库里多了一条 `mode:"compaction"`、`summary:true` 的 assistant 消息和一个 `compaction` 部件，说明真的压缩了。
  `/compact` 不在 `available_commands_update` 里，但 OpenCode 认。**没有任何压缩完成的 ACP 信号**（结论第 3 处）。
  【推断】OpenCode 在上下文快满时会自己压缩，同样不会有信号，宿主就漏掉这条边界（显示上的降级，不影响回合）。
- **清空** 【实测】：没有 `/clear` 命令；宿主的 `/clear` 本来就是在同一个进程里 session/new 一个新会话再换 registry（`clear.ts`），
  OpenCode 的 session/new 马上落库，不需要引导轮。

### 7. MCP：能不能挂我们的 channel-server 【实测】夹具 `mcp-stdio.jsonl`

- session/new 的 `mcpServers` 带一项 stdio server（`{name:"probe", command:<bun>, args:[探针, "--mcp-echo"], env:[{name:"PROBE_ECHO", value:"1"}]}`）。
  OpenCode 起了它，模型调到了工具（`probe_ping`），结果是 `pong:hello:env=1`，**说明 env 也交到了子进程**。
- 所以可以照 Pi 的做法（`host-runtime.ts` 的 `piMcpServers`）：把 channel-server 当 stdio MCP 交给 session/new|resume，
  `BRIDGE_URL`（指向宿主的回环代理 `acp/tool-proxy.ts`，带一次性 token）放在这一项的 env 里。不用改 OpenCode 的配置文件，也不用另起代理。
- 工具名是 `<server>_<tool>`，`kind:"other"`；入参在 in_progress 那条更新里才有（`rawInput:{text:"hello"}`）；没有 `_meta.is_mcp_tool_call`。
  名字映射见结论第 2 处。本次没触发 MCP 工具授权，【推断】OpenCode 对 MCP 工具缺省放行。

### 8. 鉴权 【实测】

- 免费模型**不用登录、不用 key**：隔离目录里没有任何凭据，`opencode providers list` 显示 `0 credentials`，所有场景都跑通了。
- 凭据存在 `$XDG_DATA_HOME/opencode/auth.json`（`opencode providers list` 自己报的路径；本次不存在，没打印任何值）。登录走 `opencode auth login`，
  也就是 initialize 里 `authMethods` 的 `opencode-login`；宿主不需要调 ACP 的 `authenticate`。
- OpenCode 会在 `$XDG_CACHE_HOME/opencode/` 缓存 `models.json`；首次 initialize 要 1.4–6.6 s（取模型列表），免费模型首字延迟 2–60 s 不等（同一模型差别也很大）。

### 安装 【实测】

- `npm i -g opencode-ai`（按规格经 `resolveNpm()` 找到 nvm 下的 npm）装了 2 个包，`<nvm>/bin/opencode` 是指向包里原生可执行文件的软链。
- launchd 下的 PATH 没有 nvm 目录：OCR-2 起进程时要用 `resolveNpm().binDir + "/opencode"` 的绝对路径，不能裸调 `opencode`（和 npm 本身是同一个坑）。

## OCR-2 实现清单

预估：一个执行者 2–3 天（大头是 translator 的三处改动加测试，以及历史读取）。

| 文件 | 改什么 |
|---|---|
| `src/lib/acp/host-runtime.ts` | `AcpRuntime.id` 加 `"opencode"`；`RUNTIMES.opencode`：`agentCommand` 起 `[opencode 绝对路径, "acp", "--cwd", cwd]`；`adapterEnv` 在 `hostEnvBase` 上加 `OPENCODE_CONFIG_CONTENT`（模型 + 权限策略）；`mcpServers` 照 `piMcpServers` 交 channel-server；`label: "OpenCode"`；不填 `clearBootstrap` |
| 新 `src/lib/acp/opencode-bin.ts` | 用 `resolveNpm()` 定位 `opencode`，找不到给可读的错误（doctor / readiness 复用） |
| `src/lib/acp/updates.ts` | `createAcpTranslator` 加按运行时的选项：①`tool_call` 入参为空时推迟到第一条带 `rawInput` 的更新（或终态）再吐 `tool_use`，命令取那时的 `title`；②MCP 工具名映射：`<mcpName>_<tool>` → `mcp__<mcpName>__<tool>`（只认宿主交下去的 server 名，免得误伤内置工具）；③新压缩来源 `command-end`：`/compact` 那一轮 `end_turn` 就出 `compact_boundary`，并把这一轮的摘要正文收成边界、不当 assistant 回复 |
| `src/lib/acp/host.ts` | 选压缩来源那一行（现在按 `rt.id === "pi"` 二选一）改成读 `AcpRuntime` 上的字段，OpenCode 用 `command-end`；把上面 translator 选项按运行时传进去 |
| 新 `src/lib/runtimes/opencode-acp.ts` | 仿 `pi-acp.ts`：启动命令、宿主环境（`CLAUDESTRA_ACP_RUNTIME=opencode`、模型）、readiness |
| `src/lib/runtimes/index.ts`、`types.ts`、`catalog.ts` | 注册 `opencode`（`ACP_ADAPTERS`、运行时清单），网页新建弹窗读 `GET /api/v1/runtimes` 就能看到 |
| 新 `src/lib/opencode-session.ts` + `src/lib/session-source.ts` | 历史：`opencode export <id>` → Claude Code 形状（text / tool / compaction）；`session-source` 按运行时分派 |
| `src/manager/`（create 那一族） | `manager create --runtime opencode --model <provider/model>`；**没给 `--model` 就拒**（OpenCode 自己的缺省是免费模型，见第 5 条）；模型记进 registry，供重启时带上 |
| `tests/acp-updates.test.ts` | 用本卡夹具（`prompt-tool-call.jsonl`、`mcp-stdio.jsonl`、`compact.jsonl`、`cancel.jsonl`）测三处补丁和打断后的 tool_result |
| `tests/acp-host-runtime.test.ts` | opencode 运行时的命令、env、mcpServers |
| `docs/runtimes/opencode-acp.md` | 补「权限策略最后怎么定」「失败形状实测」两节 |

OCR-2 开工前要先定的两件事：OpenCode agent 是否像 Codex 一样放开 `external_directory` 授权（第 4 条）；`always` 选项留不留。

## 夹具清单（`tests/fixtures/opencode-acp/`）

每行一帧：`{t: 距进程启动的毫秒, dir: "host→agent" | "agent→host", msg: JSON-RPC 原文}`。本机路径换成了 `<tmp>` / `<home>` / `<repo>` / `<bun>`。

| 文件 | 内容 |
|---|---|
| `initialize.jsonl` | initialize 请求与回包 |
| `session-new.jsonl` | session/new、set_config_option、`available_commands_update`、`config_option_update` |
| `prompt-tool-call.jsonl` | 一轮带 shell 工具调用的 prompt（`ls -1`）：思考、tool_call 全过程、正文、用量 |
| `cancel.jsonl` | 工具在跑时 session/cancel → `cancelled`，以及打断后的下一轮 |
| `permission.jsonl` | 两次 `session/request_permission`：一次 allow_once、一次 cancelled |
| `mcp-stdio.jsonl` | session/new 挂 stdio MCP，模型调 `probe_ping` |
| `load-resume.jsonl` | 另起进程 session/load（回放）+ session/resume + 续聊 |
| `compact.jsonl` | `/compact` 一轮 |
| `model-switch.jsonl` | 启动缺省模型、set_config_option 换模型、非法模型名的 -32602 |

复现：`bun scripts/opencode-acp-probe.ts <场景> --home <隔离目录> --cwd <空目录> --out <输出目录>`，场景和参数见脚本文件头。
夹具合不合规（四类都在、没有本机路径、initialize 过 `checkInitialize`、权限请求能出卡）由 `tests/opencode-acp-probe.test.ts` 守着。

## 接入后（OCR-4）：怎么建 / 怎么换模型 / 已知限制

实现照上面的清单：宿主直连 `opencode acp`（`lib/acp/host-runtime.ts` 的 `RUNTIMES.opencode`），三处差距在 `lib/acp/updates.ts` 的
`TranslatorOptions` 里补（工具调用等 in_progress 再起头、`<mcp>_<tool>` 改名、压缩来源 `command-end`）；生命周期在
`lib/runtimes/opencode-acp.ts`，历史在 `lib/runtimes/opencode-source.ts` + `lib/opencode-session.ts`。

### 怎么建

- 先装：`npm i -g opencode-ai`（按 nvm 的 bin 目录找，`OPENCODE_BIN` 可指定；launchd 下不靠 PATH）。
- 命令行：`bun src/manager.ts create <name> <dir> --runtime opencode --model opencode/big-pickle`。只有 ACP 一条路（`--transport tmux` 拒）。
- 网页：新建 agent 弹窗的「运行时」选 OpenCode，模型必填：输入框带候选（`opencode models` 的清单，经 `GET /api/v1/runtimes` 的 `models` 字段），也能手填 model id。
- 手填的值和命令行一样校验：建会话后按**会话自己的 configOptions** `set_config_option` 一次，OpenCode 不认（回包列出可选值）就拒建、清掉频道和窗口，不留起不来的 agent。
- **模型必填**：不给 `--model`（网页不选）直接拒，原因写在报错里——OpenCode 自己的缺省是免费的 `opencode/big-pickle`，免费期数据可能被拿去训练，
  交易类项目不能默认用。早拒在 `manager/create-args.ts`（建频道 / 窗口之前），启动命令再兜底一次（resume / restart 没模型也拒）。
- 模型记进 registry 的 `model`；每次起 `opencode acp` 经 `OPENCODE_CONFIG_CONTENT` 带上，接回会话后宿主再 `set_config_option` 校一次。
- 新会话：短命的 `opencode acp` 做一次 session/new 拿 `ses_…`，不跑引导轮；职责与频道规则走首条入站前言（OpenCode 没有追加系统提示的入口）。
- 权限：对齐 Codex 的 agent-full-access，`OPENCODE_CONFIG_CONTENT` 的 `permission` 全放行（含 cwd 外的 `external_directory`、`doom_loop`），
  `question` 拒（无人值守，问了没人答）。平时不弹授权卡；万一弹了，卡片形状与 `always` 选项照宿主通用逻辑（`permissions.ts` 不改）。
- 沙箱实例里 OpenCode 的家目录、配置、库、缓存全在沙箱根的 `acp-home/` 下（`opencodeDirsEnv`），不碰 owner 的 `~/.local/share/opencode`。

### 怎么换模型

- `bun src/manager.ts set-claude <agent> --model <provider/model>` 写 registry，再 `restart <agent>`：宿主起来按新模型 `set_config_option`，
  校验用的是会话自己的 configOptions（不是 `opencode models`），所以清单里少的免费模型照样能选。
- 值不在 OpenCode 的模型表里时 set_config_option 回 `-32602`（`model not found`），宿主记日志、照常起（与 Codex 的 setConfig 同口径）。

### 已知限制

- 新建弹窗的候选来自 `opencode models`，可能比 ACP session/new 回包少几个免费模型：2026-10-16（OCR-1B）实测少 `glm-5.3-flash-free`、`ll-alpha-free`；
  2026-10-17 复测两份一致（都是 10 个，成员和前一天又不同）。原因没查实【推断】：两边都读 `$XDG_CACHE_HOME/opencode/models.json` 这份目录缓存，
  它在后台按时刷新，前后两次调用隔着一次刷新就会不一样。拿会话那份全表要建会话，会在 OpenCode 库里留空会话，所以弹窗不这么做；
  缺的可以手填（按会话 configOptions 校验，见上）。
- 网页 agent 设置里的「换模型」（`/agents/:name/{pi,codex}-settings`）还没接 OpenCode，先用上面的命令行。
- 压缩：只认宿主发的 `/compact`（那一轮结束出边界，摘要不当回复）；OpenCode 自己在上下文快满时的自动压缩没有任何信号，宿主看不到这条边界。
  `/compact` 那一轮被打断也会记一条边界（flush 拿不到 stopReason）。
- 没有 steering：忙时到的消息排队等下一轮；没有命令输出增量（长命令跑完才看到输出）；没有 `/clear` 命令（宿主照旧 session/new 换会话）。
- 出借 worker（干净环境）不起 OpenCode。tmux 版不做。
- 历史：读 `opencode export <id>` 的镜像（`~/.claude-orchestrator/opencode-sessions/<id>.jsonl`），按 OpenCode 库文件的 mtime 刷新。
