# codex app-server 实测（CX-0）

自研 Codex ACP 适配器动工前的真实 CLI 调研：直接驱动 `codex app-server`（不经任何适配器），在 stdio 上原样记录 JSON-RPC，
回答设计里的 Q0-1 ~ Q0-9。版本 **codex-cli 0.159.3**（npm 全局包，`codex` 是 node 写的 shim，真正的程序是包里的原生二进制）。
本文只放结论和脱敏片段；完整原始记录留在跑的人自己的临时目录，不进仓库。

## 怎么跑

```bash
bun scripts/codex-probe.ts --out <临时目录> [--only a,b] [--repeat N] [--codex <codex 可执行文件>]
```

- 场景定义在 `scripts/codex-probe-scenarios.ts`，每个场景一份目录：`rpc.jsonl`（`{t, dir: out|in|note, line}`，line 是线路上的原文）、
  `http.jsonl`（假 provider 收到的请求）、`egress.jsonl`（外网访问记录）、`result.json`（场景的观察结果，场景抛错时是 `{error}`）、
  `probe.json`（app-server 的 userAgent 和收尾报告）。运行目录下的 `meta.json` 记 codex 路径和各场景 initialize 回包里的版本号。
- 假 Responses 服务：`tests/helpers/fake-responses.ts`（单测 `tests/fake-responses.test.ts`）。剧本是 `(请求) => Reply`，
  Reply 有 text（可分段、段间延时）、tool（function_call）、hang（只发 `response.created` 然后挂住）、fail（流内 `response.failed`
  或 HTTP 错误码）、json（非 SSE）。`requestKind(req)` 读 `x-codex-turn-metadata` 头里的 `request_kind`，区分普通采样和压缩。
- 场景数按 `SCENARIOS` 的键算：29 个，不带 `--repeat` 跑一次全套就是 29 份记录，约 3 分钟。结论里的计数还包括调研期间
  针对单个场景的重复运行（比如 `clientid_track` 前后共跑了 6 次），各条写的是实际样本数。不进 `bun test`（要真的 codex）；
  收尾逻辑和假服务有离线单测（`tests/codex-probe.test.ts`、`tests/fake-responses.test.ts`）。

### 隔离与安全

- 每个场景 `mkdtemp` 一个根目录，下分 `home/`、`codex-home/`、`tmp/`、`work/`（线程 cwd）。启动前检查 CODEX_HOME：路径里有软链、
  落在真实 `~/.codex` 或 `~/.claude-orchestrator` 下、里面已有 `auth.json`，任一条成立就拒绝运行。
- 子进程 env 只有白名单：`PATH`、`HOME`（临时）、`CODEX_HOME`、`TMPDIR`、`LANG`，外加把 `HTTP(S)_PROXY` / `ALL_PROXY` 指向本地一个
  「记录目标后回 403」的代理（`NO_PROXY=127.0.0.1,localhost`）。没有 `OPENAI_API_KEY` / `CODEX_API_KEY`，外网访问只留记录、不放行。
- 记录到的外网访问（全套一次，均被拒，均不影响功能）：`chatgpt.com:443` 57 次、`github.com:443` 30 次、`api.github.com:443` 27 次。
- app-server 用 `Bun.spawn({detached: true})` 起在自己的进程组。运行中每 500ms（以及场景主动 EOF / 发信号之前）用 `ps` 登记它的
  所有后代，包括改过进程组的 MCP server 和命令（Q0-6）。场景结束或中途抛错都走同一个收尾：先写 `result.json`，再
  EOF 等 2s → 对 app-server 进程组和每个还活着的后代（各自**当前**的进程组 + pid）SIGTERM 等 1s → SIGKILL 等 1s，最后再扫一次，
  每步之后的存活者记进 `probe.json`。扫描一直持续到收尾结束：三段等待里每 100ms 补扫一次，每次发信号前用的都是刚扫出来的集合，
  所以宽限期里才派生、改了进程组的后代也会并进来。按 pid + 启动时间（`ps lstart`）认进程防 pid 复用，不碰探针自己所在的组。
  **已知上限**：存活时间短于扫描间隔（运行中 500ms、收尾时 100ms）、并且在两次扫描之间就脱离了 app-server（父进程退出、
  它被过继给 launchd）的后代不保证抓到。

### 假 provider 的配置（0.159.3 实测）

```toml
model = "fake-model"
model_provider = "fake"
# 自动压缩阈值这类键必须写在顶层；写进 [model_providers.fake] 会被忽略并收到 configWarning
# model_context_window = 10000
# model_auto_compact_token_limit = 5000

[model_providers.fake]
name = "fake"
base_url = "http://127.0.0.1:<port>/v1"   # 采样请求是 POST <base_url>/responses
wire_api = "responses"
request_max_retries = 0                    # 失败场景不重试，记录才干净
stream_max_retries = 0
```

不写 `env_key`、不设 `requires_openai_auth` 时请求不带 Authorization。二进制里 `ModelProviderInfo` 的其余字段（`env_key`、`http_headers`、
`env_http_headers`、`query_params`、`stream_idle_timeout_ms`、`supports_websockets` 等）这次没用到。模型名在目录里查不到时，
app-server 每轮发一条 `warning`「Model metadata for `fake-model` not found」，按回退元数据跑（`modelContextWindow` 258400）。
请求体：`model`、`instructions`、`input`、`tools`（这个模型家族给的是 `exec_command`、`write_stdin` 等 9 个）、`stream:true`、`store:false`、
`client_metadata`；头里有 `x-codex-turn-metadata`（含 `request_kind`）、`x-codex-beta-features: remote_compaction_v2`。

## 结论

| # | 结论 | 影响的设计条目 |
|---|------|----------------|
| Q0-1 | **被丢弃**。已 steer（回包给了 turnId）但还没被消费的输入，interrupt 之后不发给模型、不进 rollout、不进 `thread/read`、不进下一轮请求，也没有任何 item 事件。模型流式中途和命令执行中途两种情况结果相同。steer 的 userMessage item 只在**被消费时**才发（回合内下一次采样前），不是在 steer 回包时 | **B21 / R2 / D-f**：宿主收到 injected 的 steer 会被 interrupt 静默吞掉；适配器能识别（该 clientId 在回合以 interrupted 收尾前没出现过 userMessage），cancelReturnsQueue（CX-5）有可靠依据 |
| Q0-2 | 自定义 provider 下走**本地压缩**：仍是 `POST /v1/responses`（`request_kind:"compaction"`，`tools` 为空，input 末尾是压缩提示词），`/responses/compact` 从未被调用（尽管请求头声明了 `remote_compaction_v2`）。`thread/compact/start` 立即回 `{}`；压缩是**独立回合**：status active → `turn/started` → `item/started contextCompaction` → `item/completed contextCompaction` → `warning` → idle → `turn/completed completed`；**没有 `thread/compacted`**。失败：started 之后 systemError → `error{willRetry:false}` → `turn/completed failed`，**没有 item/completed**；被打断：同样没有 item/completed，`turn/completed interrupted`，历史不变。自动压缩发生在**用户回合内部**、采样之前（同一个 turn/started 下先 contextCompaction 再 userMessage） | **B27 / R3**：turnId 取压缩回合的 `turn/started` 可行；收尾以 `turn/completed` 的 status 为准，不能等 item/completed；自动压缩的边界来自普通回合里的 contextCompaction item |
| Q0-3 | 开始：**start 回包 < status active < `turn/started`**（专门的排序场景 40/40；全部记录里 197 次 turn/start 都是回包先到）；结束：**status idle < `turn/completed`**（全部 191 次 completed / interrupted 收尾都是 idle 先到）；**completed 从未早于 start 回包**。失败回合是 systemError（不发 idle）再 `turn/completed failed`（6/6）。确认延迟：`turn/start` n=197 p50 4ms、p90 18ms、max 101ms；`turn/steer` n=70 p50 2ms、p90 5ms、max 68ms。同一回合里原始 active 会重复出现（审批时 activeFlags 变化） | **I3**：PendingStart 早到缓冲在真实线路上没触发过，保留作防御即可；**I5**：原始 idle 先于 turn/completed，「不转发原始 active/idle、从回合派生」是必要的 |
| Q0-4 | 新一轮在跑时用旧 turnId（或编造的 id）interrupt → `-32600 "expected active turn id <旧> but found <新>"`，新一轮**不受影响**。空闲时（上一轮正常完成）→ 立即 `-32600 "no active turn to interrupt"`。**例外**：上一轮是被 interrupt 掉的，app-server 仍把它记成 interrupt 的「当前回合」：此时再 interrupt 它**不回包**，一直挂到**下一轮正常结束**才回 `{}`（下一轮没有被打断，跑满全程）。steer 不受影响（空闲时 `"no active turn to steer"`） | 解决 `codex-acp.md` 里记的 unknown：旧 turnId 不会落到新回合。**I4 / I13**：interrupt 必须有时限，回合收尾后不再发；interrupt 的回包不能当作「当前回合已被打断」的证据 |
| Q0-5 | 发与不发 `initialized`：各 20 轮，通知种类、先后、确认延迟、thread/read 结果都相同，没观察到差异 | **D-d**：两种都可以；保留工程默认值不会出问题 |
| Q0-6 | EOF 后 app-server **10–20ms** 退出（空闲、模型请求挂起中、命令执行中都是），退出码 0；SIGTERM（单 pid 或整组）19–77ms 退出。两条路径下 app-server 都会**主动清理** MCP 子进程（先 SIGTERM，忽略 SIGTERM 的也在退出前被杀掉）和正在跑的命令。**但 MCP server 和命令各自在独立进程组**（pgid = 自身 pid），不在 app-server 的组里：整组 SIGKILL 时 app-server 立刻死、MCP server 和 `sleep` 命令**变孤儿存活**（3s 后仍在）。npm shim 与原生二进制行为一致（shim 是组长，原生程序是同组子进程） | **I12**：0.8s 宽限期绰绰有余，不需要 `stopGraceMs`；但「T1 = 进程组，包括 channel-server 等 MCP 子进程」不成立——MCP 子进程只在 EOF/SIGTERM 路径上被 app-server 自己清掉，SIGKILL 路径必须把 app-server 的直接子进程（MCP server）列入清理集合，不能按 D-h 只报告 |
| Q0-7 | 审批请求 `item/commandExecution/requestApproval`（approvalsReviewer=user）：workspace-write 和 read-only 下要求越出沙箱的命令，形状相同（片段见下）。read-only 下普通写命令**不发审批**，直接被沙箱拒（模型收到 `operation not permitted`）；`untrusted` 策略对工作区内写命令也发审批（`reason:null`）。`availableDecisions` **null 0 次 / 共 10 次**，`experimentalApi:false` 时也照样带。取值是 `["accept", {"acceptWithExecpolicyAmendment":…}, "cancel"]`：**没有 decline，也没有 acceptForSession**。回 `decline`（不在列表里）照样被接受：命令被拒、模型收到 rejected by user、回合继续；回 `cancel` 则**整轮被打断**（`turn/completed interrupted`）。等审批时 status 是 `active{activeFlags:["waitingOnApproval"]}`，答完有 `serverRequest/resolved`；反向请求 id 从 0 开始 | **§2.4**：按设计的过滤规则只剩 {accept, cancel}；把 reject_once 映射成 cancel 会打断整轮——建议 reject_once 发 `decline`，cancel 只留给超时 / 收尾 / 宿主取消。null 分支没触发过 |
| Q0-8 | `thread/read{includeTurns:false}` 的 status 可靠：回合中 active（10/10，等审批时带 waitingOnApproval）；`turn/completed` 一到立即读是 idle（40/40）；interrupt 后 idle；**失败回合之后是 systemError**（立即和 300ms 后都是），直到下一轮开始才变 active。`includeTurns:true` 会触发 `deprecationNotice`（要求改用 `thread/turns/list`、`thread/items/list`） | **I13** 看门狗可以依赖它；判据里的 systemError 在每个失败回合后都会出现（包括一次 500），不只是系统级故障。**B17**：透传 systemError 时注意别和回合失败重复出卡 |
| Q0-9 | `clientUserMessageId` **原样落进 userMessage 的 `clientId`**：`item/started` 通知里就有，`thread/items/list`（data 每项是 `{turnId, item, startedAtMs, completedAtMs}`）能查到；回合结束后、压缩后、**app-server 重启 + `thread/resume` 后**都还在；失败回合的输入也在。不会发给 provider（P7 成立），但会写进 rollout（P8 要宿主侧确认读 rollout 时忽略）。**app-server 不按 clientId 去重**：同一 id 的 turn/start 发两次就跑两轮，steer 发两次模型就收到两条。**查不到却已接收 / 将执行的情况**：① steer 已确认但还没被消费时 items 里没有它（回合结束前一直查不到）；② turn/start 回包后 userMessage 要再过 24–55ms 才查得到；③ 新线程第一轮落盘前 `thread/items/list` 回 `-32601 "thread/items/list is not supported yet"`。**顺序**：连发的 steer（6 组，每组 3 或 8 条）回包顺序都等于发送顺序（6/6），落进 items 的顺序也是（5/5）；但不同 method 之间**不保序**：夹在 steer 中间的 items/list 先于前面的 steer 回包到达（5/6 组），和 turn/start 连发的 items/list 5/6 次先回包 | **I14 / R13**：「查到 = 已投递」成立；「同一连接后发请求有了回包 ⇒ 前面的已处理完」**不成立**，「没找到 = 未投递」那条分支保持关闭。steer 可以细化：等目标回合收尾后再查，查不到说明没执行、之后也不会执行（迟到的 steer 会因 expectedTurnId 对不上被拒，见 Q0-4）。**B58**：重发不会被 app-server 去重，「结果不明不得自动重排」必须保留。-32601 在对账时要当作「暂时查不到」，不能当成能力缺失 |

### 其他观察

- 每条 app-server 消息顶层多一个 schema 里没有的 `emittedAtMs` 字段，loose 解析要容忍。
- initialize 之后立刻有一条 `remoteControl/status/changed`，带本机主机名（`serverName`）和 `installationId`：不要原样写进日志或转发。
- 回合被 interrupt 时，正在跑的命令只有 `item/started commandExecution`，**没有 item/completed**；适配器要在回合收尾时补齐还开着的工具调用。
- HTTP 500 被映射成固定文案「We’re currently experiencing high demand…」，`codexErrorInfo:"internalServerError"`，provider 的原始错误信息不透出。
- interrupt 的回包写在 idle / turn/completed 之前（同一毫秒）。

## 关键片段（已脱敏）

路径、主机名、installationId 已替换；`<thread>`、`<turnA>` 等是本次运行的随机 id。

Q0-3：一轮的线路先后（`t` 是相对探针启动的毫秒，`resp#3` 是 turn/start 的回包）

```
228ms resp#3
243ms thread/status/changed active
243ms turn/started inProgress
...
274ms thread/status/changed idle
274ms turn/completed completed
```

Q0-1：steer 后 interrupt（`resp#4` 是 steer 回包 `{turnId}`，`resp#5` 是 interrupt 回包 `{}`），之后 STEER 文本在任何地方都没出现；下一轮请求的 input 末尾：

```
617ms resp#4
826ms resp#5
826ms thread/status/changed idle
826ms turn/completed interrupted
下一轮 input 末尾: "first prompt", "<turn_aborted>\nThe user interrupted the previous turn on pur…", "second prompt"
```

Q0-4：上一轮被 interrupt 后，再对它发 interrupt（`resp#5`），回包挂到下一轮正常结束：

```
 469ms → turn/interrupt {turnId:<turnA，已 interrupted>}
2490ms resp#6                        ← 下一轮 turn/start 回包
2495ms turn/started inProgress
5579ms resp#5  {}                    ← 挂了约 5.1s 的 interrupt 回包
5579ms thread/status/changed idle
5579ms turn/completed completed      ← 下一轮跑满，没有被打断
```

Q0-2：压缩请求（假 provider 侧记录）

```json
{"path":"/v1/responses","kind":"compaction","ntools":0,
 "inputTail":["You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n"]}
```

Q0-6：EOF 前的进程树与 SIGKILL 整组后的存活者

```
shim(node)  pgid=自己           ← Bun.spawn detached 的组长
└ codex     pgid=shim 的组
  ├ bun     pgid=自己           ← MCP server
  └ sleep   pgid=自己           ← 模型发起的命令
EOF:            10–20ms 退出；MCP 日志 "signal SIGTERM"；+0ms / +3s 存活者 []
SIGKILL(-pgid): 2ms 退出（137）；+0ms / +3s 存活者 ["bun", "sleep"]；MCP 日志只有 "stdin-eof"
```

Q0-7：审批请求的 params

```json
{"kind":"command","threadId":"<thread>","turnId":"<turnA>","itemId":"call_1","startedAtMs":0,"environmentId":"local",
 "reason":"probe needs to write outside the workspace","command":"/bin/zsh -lc 'echo probe > ../outside.txt'","cwd":"<work>",
 "commandActions":[{"type":"unknown","command":"echo probe > ../outside.txt"}],
 "proposedExecpolicyAmendment":["/bin/zsh","-lc","echo probe > ../outside.txt"],
 "availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["/bin/zsh","-lc","echo probe > ../outside.txt"]}},"cancel"]}
```

Q0-9：items/list 的一项、新线程上的报错、连发时的回包顺序

```
{"turnId":"<turnA>","item":{"type":"userMessage","id":"<item>","clientId":"cum-start",
 "content":[{"type":"text","text":"prompt with id","text_elements":[]}]},"startedAtMs":0,"completedAtMs":0}
{"error":{"code":-32601,"message":"thread/items/list is not supported yet"},"id":4}   ← 新线程第一轮落盘前
steer a,b,c,d → items/list → steer e,f,g,h   回包到达: a, items/list, b, c, d, e, f, g, h
```
