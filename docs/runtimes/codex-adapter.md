# 自研 Codex ACP 适配器（`src/lib/acp/codex-adapter/`）

代替上游 [codex-acp](https://github.com/agentclientprotocol/codex-acp) 2.1.0 的自研适配器：stdin/stdout 对宿主讲 ACP v1，子进程跑
`$CODEX_PATH app-server`（独立进程组）。为什么自研、上线门槛见 2026-10-05 的决定（mem0 b1986816）。

**现状：不接入生产。** `host-runtime.ts` 不会选它，只能用 `CLAUDESTRA_ACP_AGENT='["bun","<仓库>/src/lib/acp/codex-adapter/main.ts"]'` 手工起。
选择逻辑、版本闸和切换归 CXF-S。

代码注释里的 B / I / R / D 编号、「设计 §2.1 / §2.4」指的是 CX-0 前的设计稿。那份稿子不在仓库里，也没在台账、mem0 里找到。
本文按现有代码（CX-1、CX-2、CX2B、CX-3）整理，下文和代码不一致时以代码和测试为准。CX-0 实测结论在
[codex-app-server-probe.md](./codex-app-server-probe.md)，下文的「Q0-x」都指那里。

## 文件

| 文件 | 职责 |
|------|------|
| `main.ts` | 进程入口：读环境、起 app-server、接 stdio、装收尾。环境不合格不退出，initialize 回 -32603 带 `data.fatal`（宿主固定一张卡、不再重起） |
| `protocol.ts` | app-server 协议里我们读写的那一块（zod），USED 登记表；锁文件在 `tests/fixtures/codex-app-server/`，改了要重跑 `bun scripts/codex-schema/lock.ts` |
| `app-server.ts` | 传输层：JSON-RPC、握手、带校验和时限的调用、通知分 L / C / O 三类、反向请求注册 |
| `server.ts` | ACP 服务端：方法映射（下表）、按线程过滤通知 |
| `session-state.ts` / `session-config.ts` | 会话代际（new / resume 待确认、回滚）；模式预设、线程 config 覆盖层、configOptions |
| `turns.ts` | 回合状态机：一次只跑一轮，派生 active / idle，steer 串行，interrupt 只发一次，看门狗 |
| `events.ts` | 一轮里的 app-server 事件 → ACP `session/update`（下表） |
| `approvals.ts` | 审批 → `session/request_permission`，以及其余反向请求的策略 |
| `delivery.ts` | 投递对账：输入写出后拿不到可信结果时，只能证明「已投递」 |
| `failures.ts` | 回合失败 → AIR sessionFailure / idle 终态信封 / JSON-RPC 错误 |
| `shutdown.ts` / `proc-tree.ts` | 统一的受控收尾，app-server 后代分层清理 |

## ACP 方法映射

| ACP（宿主 → 适配器） | app-server | 说明 |
|------|------|------|
| `initialize` | `initialize` + `initialized` | 只握手一次。回 ACP v1、`sessionCapabilities.resume/fork`、`_meta.steering.supported`；`loadSession:false`。clientInfo 透传宿主的 |
| `session/new` | `account/read` → `thread/start` → `model/list`（翻完所有分页） | 没登录回 -32000。sessionId 就是线程 id，进入待确认 |
| `session/resume` | `account/read` → `config/read` → `thread/resume`（`excludeTurns:true`） | 进入待确认 |
| `session/fork` | `config/read` → `thread/fork` → `thread/unsubscribe` 新线程 | 只建不切，宿主随后在新进程里 resume |
| `session/prompt` | `turn/start`（带 `clientUserMessageId`、模式策略、模型、effort）；文本以 `/compact` 开头时发 `thread/compact/start` | 只收 text 块。回包等回合收尾才写，先发 idle 再回包 |
| `_session/steering` | 有回合在跑就 `turn/steer`，否则等上一轮收尾再 `turn/start` | 回 `injected` / `startedNewTurn` / `failed` / `deliveredUnknown` |
| `session/cancel`（通知） | `turn/interrupt`（每个 turnId 最多一次，3s 时限） | 还在等宿主答复的审批一律按 cancel 答。只认 `turn/completed interrupted` 为已打断 |
| `session/set_config_option` | 无 | 只改本地的 model / reasoning_effort，下一次 `turn/start` 生效 |
| 其余 | 无 | -32601 |

prompt 的回包都带 `usage` 和 `_meta.quota`（最近一次 `thread/tokenUsage/updated` 的 `last`，2.1.0 同款形状）。失败时另带 AIR sessionFailure
（宿主声明了 AIR），没声明 AIR 的宿主撞额度时收到带 `codexErrorInfo:"usageLimitExceeded"` 的 JSON-RPC 错误。

## 事件映射（`events.ts`）

形状对着 2.1.0 发给 **AIR 宿主**的那一份（我们的宿主在 initialize 里声明了 `jetbrains.air.version:1`，2.1.0 按 AIR 客户端发）。

| app-server | `session/update` |
|------|------|
| `item/agentMessage/delta`；`item/completed agentMessage`（没收到过增量时补整段） | `agent_message_chunk`（`messageId` = item id） |
| `item/started commandExecution` | `tool_call`（in_progress）。单个 read / search / listFiles 动作按下表；其余 `kind:"execute"`、标题去 shell 前缀、带 `rawInput` |
| `item/commandExecution/outputDelta` | `tool_call_update` 带 `_meta.terminal_output_delta.data`（宿主声明了才发） |
| `item/completed commandExecution` | `tool_call_update`：`completed`（exit 0）或 `failed`；没流过输出就把 aggregatedOutput 放进 `content` |
| `item/started` / `item/completed mcpToolCall` | `tool_call`（`kind:"execute"`，标题 `mcp.<server>.<tool>`，`_meta.is_mcp_tool_call`）/ `tool_call_update` 带 `rawOutput{result, error}` |
| `item/*` `contextCompaction`、`thread/compacted` | `compaction_update`（in_progress / completed；收尾时补 failed / cancelled） |
| `turn/plan/updated` | `plan`：`entries[{content: step, status, priority:"medium"}]`，`inProgress` 改写成 `in_progress` |
| `thread/tokenUsage/updated` | `usage_update{used: last.totalTokens, size: modelContextWindow}`，没有窗口（或 ≤0）不发 |
| 回合开始 / 收尾 | `session_info_update` 的 `_meta.codex.threadStatus` active / idle；idle 带 `_meta.claudestra.turn`（结局信封） |

命令的 kind 和标题（2.1.0 `commandActionFacts`），宿主据此翻成 Read / Grep / Bash：

| 动作 | kind | 标题 | 其它 |
|------|------|------|------|
| `read` | `read` | `Read file '<path>'` | `locations:[{path}]` |
| `search` | `search` | `Search for '<query>' in <path>`（缺哪个省哪段，都缺是 `Search`） | |
| `listFiles` | `read` | `List files in '<path>'` / `List files` | |
| `unknown` 或不止一个动作 | `execute` | 去掉 `bash|zsh|sh -lc` 前缀和整段单引号 | `rawInput:{command, cwd}` |

回合收尾时（不论什么 status），还开着的工具调用补一条 `failed`（被打断的命令只有 `item/started`）。

## 反向请求（`approvals.ts`）

生产跑 `agent-full-access`（approval=never），正常不会弹审批。出现了不能挂死，也不能默认放行。

| app-server 请求 | 处理 |
|------|------|
| `item/commandExecution/requestApproval` | 转 `session/request_permission`，宿主出「待你处理」卡（`lib/acp/permissions.ts`）。选项见下 |
| `item/fileChange/requestApproval` | 同上，选项固定四项：允许、本会话允许、拒绝、停下 |
| `item/permissions/requestApproval`（加沙箱权限） | 不问宿主，回 `{permissions:{}, scope:"turn"}`（什么都不给） |
| `mcpServer/elicitation/request` | 回 `action:"cancel"` |
| `item/tool/requestUserInput` | 回 `answers:{}` |
| 其它 | -32601（rpc 缺省） |

命令审批的选项（optionId 就是回给 app-server 的 decision）：

| optionId | 什么时候给 | 卡上的 kind | 效果（Q0-7） |
|------|------|------|------|
| `accept` | `availableDecisions` 里有 | allow_once | 命令照跑 |
| `acceptForSession` | `availableDecisions` 里有 | allow_always | 照跑，本会话同类不再问 |
| `decline` | 总给 | reject_once | 命令不跑，模型收到「rejected by user」，**回合继续**（不在列表里也被接受） |
| `cancel` | `availableDecisions` 里有 | reject_once | **整轮被打断**（`turn/completed interrupted`） |

带策略修订的对象决定（`acceptWithExecpolicyAmendment`、`applyNetworkPolicyAmendment`）不给：卡片答不出原样的修订内容。
`availableDecisions` 里没有 accept / acceptForSession 时不出卡，直接 cancel。联网审批的卡片标题写成「联网：<协议>://<主机>」；
带 `additionalPermissions` 的标题后面加「（并申请额外权限）」。

**fail closed**：下列情况一律回 `cancel`（整轮停下），不默认放行，也不挂着不答：

- 宿主回 `cancelled`（owner 取消、宿主 10 分钟没人答、出卡出错），或者选了不在卡上的 id、回包形状不对；
- `session/request_permission` 请求失败（宿主断开、线路作废）；
- 适配器自己的兜底时限到了（11 分钟，比宿主的 10 分钟长，正常由宿主先回 cancelled）；
- 宿主发 `session/cancel`，或者适配器开始收尾：还在等的审批当场按 cancel 答，app-server 才停得下这一轮；
- 审批不属于当前会话正在跑的那一轮（旧 turnId、别的线程），或者参数过不了校验：不出卡，直接 cancel。

已知不足：session/cancel 之后宿主那张卡不会被撤掉（ACP v1 没有撤回请求的办法），卡留到 owner 点或宿主 10 分钟超时，那时的答复适配器已经不认了。

## 和 codex-acp 2.1.0 的差异

用 `scripts/codex-acp-compare.ts` 对同一套回合各跑一遍（codex-cli 0.159.3、假 provider、隔离 CODEX_HOME），按宿主消费的形状比：
`lib/acp/updates.ts` 翻出来的条目、`threadStatusOf` 的状态序列、prompt 结局、授权卡。普通文本、终端命令、plan、打断四类回合**逐项相同**；
其余差异如下，都不影响宿主的判断。

| 场景 | 2.1.0 | 自研 | 为什么无害 |
|------|------|------|------|
| 读 / 搜 / 列目录命令的结果 | 不发输出，宿主的 tool_result 是空串 | 照样发输出增量，tool_result 有内容 | 只多了展示内容。工具名、入参（Read 的 file_path、Grep 的 pattern）两边相同 |
| 等审批时的线程状态 | 原样转发 app-server 的 active（`activeFlags` 带 waitingOnApproval，一轮里 3 次） | 每轮只派生一对 active / idle（I5） | 宿主只看最近一次是不是 active，不读 activeFlags；多出来的 active 不改变忙闲 |
| 授权卡选项 | 允许、允许并加执行策略修订、「No, and tell Codex…」（= cancel） | 允许、拒绝（decline）、拒绝并停下（cancel）；中文标签 | 宿主原样列出选项。少了策略修订（会永久改 execpolicy），多了 decline |
| owner 点「拒绝」 | 唯一的拒绝项是 cancel，整轮打断，prompt 结局 cancelled | 第一个拒绝项是 decline，命令不跑、回合继续，结局 end_turn | 按 CX-0 的建议：拒绝一条命令不该连回合一起停。要停整轮选「拒绝并停下这一轮」，效果同 2.1.0 |
| 等卡时被叫停 | 工具调用一直开着，没有收尾 | 收尾时补一条 failed 的 tool_result | 宿主的条目更完整；结局都是 cancelled，那条命令都没跑 |
| 每轮一条「Model metadata … not found」 | AIR sessionFailure 形式的 warning 通知 | 不转发（app-server 的 `warning` 归 O 类忽略） | 宿主不消费 `session_info_update` 里的 AIR 通知 |
| `terminal_info` / `terminal_exit`、tool_call 的 `name`、`content:[{type:"terminal"}]` | 有 | 没有 | 宿主不读这些字段（工具名按 kind 推，结果取输出或 content） |
| prompt 回包 `usage` / `_meta.quota` | 有 | 有，形状相同 | 宿主目前不读，只为形状一致 |

没有覆盖、不在宿主消费范围里的：`account/rateLimits/updated`（2.1.0 记下来备用，我们忽略）、goal、子会话、AIR 的 diff / 文件变更报告。

## 怎么验证

- 单测：`bun test tests/codex-adapter-*.test.ts`（假 app-server + 宿主真用的 `AcpSession`，`tests/helpers/codex-fake-app.ts`）。
  审批 `tests/codex-adapter-approvals.test.ts`，字段 `tests/codex-adapter-fields.test.ts`。
- 真 CLI 对照与冒烟：`bun scripts/codex-acp-compare.ts --out <目录>`（`--only self` 只跑自研）。每个适配器一个 mkdtemp 根（HOME、CODEX_HOME、TMPDIR、cwd），
  provider 指向本机假 Responses，代理指到死端口；不碰 `~/.codex`，不连生产 bridge。场景：文本、命令、读、搜、列目录、plan、
  审批允许 / 拒绝 / 等卡时叫停、打断。
- schema 漂移：`bun scripts/codex-schema/lock.ts --check`。
