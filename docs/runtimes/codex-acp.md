# Codex over ACP（T60）

Codex agent 默认经 [Agent Client Protocol](https://agentclientprotocol.com) 驱动
[codex-acp](https://github.com/agentclientprotocol/codex-acp)（v2.0.0）。这样换来这些：
- 切模型、切推理强度都不用重启；
- 打断干净（`session/cancel`），忙时的消息能插进当前回合（`_session/steering`）；
- 工具调用是流式的，进行中的命令也看得到；
- 撞额度时拿到的是结构化错误，不会停在 Codex 的选择菜单上；
- 不再依赖 Codex 的私有实现（写锁、`codex queue`、TUI 文案）。

代价也有：
- 适配器几乎每周跟着 codex 发版；
- 关键能力放在扩展里（JetBrains AIR、draft RFD）；
- 进程多一层；
- owner 不能再 attach 进 TUI 打字。

Codex 的窗口仍承载宿主日志。`transport tmux` 可立即切回旧 TUI 路径；适配器或 CLI 不满足 ACP 条件时自动暂退 tmux。

## 状态

| PR | 内容 | 缺省行为 |
|----|------|----------|
| PR1（#225） | `src/lib/acp/` 纯库、transport 开关和 Codex ACP 策略 | Codex 仍走 tmux |
| PR2（#227） | ACP 宿主、bridge 接线、沙箱 stub、可靠投递与卡片代际 | 显式 `--transport acp` 可用 |
| 默认迁移 PR | Codex 新建 / 收编默认 ACP；升级时装适配器、迁移 registry、重启旧线程；doctor 检查及 tmux 回退 | ACP 优先，条件不足暂退 tmux |
| 删除 PR | 真机稳定并经审查后移除 Codex tmux 读屏 / 打字链路 | 仅 ACP |

升级时无参数 `migrate` 只做旧 worker→agent 迁移（旧版 updater 也这样调用）；bridge 重载并开始监听后才用 `migrate --startup` 自动执行 ACP 迁移，避免宿主接到旧 bridge。迁移幂等补齐旧 registry：可用则记 `transport: "acp"` 并重启接旧 thread；固定版本适配器下载 / sha256、Codex `app-server` 探测任一失败时，未迁移的记录记 `transport: "tmux", acpPending: true`，已有 ACP 记录保持原样，不打断正在跑的回合。重启 ACP 接旧线程失败也自动再起 tmux；人工执行 `transport <agent> tmux` 会清除待迁移标记，此后保持回退。暂退 tmux 的 agent 不在每次 bridge 重启时自动反复试；条件恢复后人工重跑 `manager migrate --acp`。失败的重启留标记给下次迁移，doctor 会点名。

## 架构

```
bridge ──ws（channel-server / Pi 扩展同一套协议，register 带 runtime=codex、transport=acp）── acp-host（agent 的 tmux 窗口）
                                                                                              │ stdio ndjson JSON-RPC
                                                                                              ▼
                                                                                    codex-acp ── codex app-server
                                                                                              │ MCP stdio（Codex 起）
                                                                                              ▼
                                                                  channel-server（BRIDGE_URL → 宿主的回环工具代理）
```

- **宿主是这个频道在 bridge 上唯一的登记者。** 它收入站消息、驱动 ACP，并把流式条目、回合结束、失败、权限请求推给 bridge。宿主按 channel-server 的退避策略重连，所以 bridge 重启不会打断回合。
- **reply 等工具仍由 channel-server 提供，这个文件一行不改。** 它的 `BRIDGE_URL` 指向宿主开的回环代理。约束如下（Shawn 定，问题 a）：
  - 代理只绑 `127.0.0.1` 的随机端口。
  - 宿主生成一次性 token，经环境变量交给 channel-server；连接不带 token 的一律拒绝。
  - 代理吞掉 register，只转发 channel-server 现有的请求类型，其它帧不转发。
- **打断复用 Pi 扩展的 abort 帧协议**（`abortVia: "extension"`）：宿主收到 `abort` 就调 `session/cancel`，然后回 `abort_ack`。

## 开关放在哪

- **registry**：每个 agent 有一个 `transport` 字段。旧记录缺字段仍由低层读成 tmux；升级迁移会补成 acp 或暂退 tmux。显式 tmux 是人工回退，迁移不会覆盖（`lib/registry.ts`、`runtimes/types.ts`）。
- **适配器**：`ManagedRuntimeAdapter.acp?: { control }`。没声明的运行时只能走 tmux，`transportsOf(runtime)` 据此回答能走哪些 transport。
- **会话来源**：rollout 发现、历史翻译与 token 扫描在 `lib/runtimes/codex-source.ts`，ACP 和 tmux 启动适配器共用。ACP 版直接组合这份来源与自己的生命周期，不继承 Codex TUI 的启动、退出或锁探测状态；这让将来删 tmux 路径时不会连历史一起删掉。
- **策略**：`controlFor(runtime, transport = "tmux")`。只有 transport=acp 且运行时声明了 ACP 段时才返回 ACP 的策略，其余情况都返回原来那份（`tests/runtime-transport.test.ts` 钉住缺省逐字不变）。

Codex 的 ACP 策略（`CODEX_ACP_CONTROL`）：

| 项 | 值 | 为什么 |
|----|----|--------|
| `interruptKeys` | `[]` | 窗口里只是宿主日志，一个键都不发 |
| `abortVia` | `"extension"` | 打断走宿主的 `session/cancel` |
| `preemptOnHumanMessage` | `false` | 忙时用 steering 插进当前回合，和 Pi 的 steer 一样即时生效，不必掐掉回合 |
| `idleSource` | `"acp"` | `session/prompt` 没返回就是忙，屏幕判据一概不看 |
| `modelEnforcement` | `"config-option"` | 经 `session/set_config_option` 改，不重启 |
| `slashAsPrompt` | `true` | `/compact` 等当 prompt 文本发，由适配器转成 `thread/compact/start` |

## 库（`src/lib/acp/`）

| 文件 | 职责 |
|------|------|
| `rpc.ts` | ndjson JSON-RPC 2.0 双向对端。手写，不加 SDK 依赖。<br>• 没注册处理器的请求回 -32601，绝不悬着不答。<br>• 入站先分清 request / notification / response；畸形响应（缺 jsonrpc、result/error 不是恰好一个）让请求失败，不算成功。<br>• 单行和未收完的半行都有字节上限（缺省 32 MiB，可配）：超了整条连接作废，日志只留截断摘要。<br>• 流断了，在途请求全部失败 |
| `turn.ts` | 统一调度器：prompt、steering、适配器另起的外部回合、斜杠命令、补 reply 都按到达顺序进同一个队列，同一时刻只有一轮。<br>• 有 steering 在途就不开新回合、也不算空闲：`startedNewTurn` 在新回合**开始**时就回，回包到之前那一轮已经在跑。<br>• 外部回合在适配器里已经在跑，先等它（它的结束信号由 IO 在处理回包的同一刻挂上，结束得再早也不漏）。<br>• 插不进的 steering 在原位置变回 prompt，并发失败也不乱序；steer 不设短超时，超过 30 秒仍等待原请求，不因本地超时重复投递。<br>• 斜杠命令独占下一轮 prompt，不走 steering。<br>• 回合结束按 Stop hook 契约上报；bridge 回 block 就排一轮 `<hook_prompt>`，仍排在在跑的外部回合之后 |
| `updates.ts` | `session/update` 翻成 Claude Code 形状的条目，和 rollout 翻译同形 |
| `failures.ts` | 两种失败形态：AIR `sessionFailure` 按 id 去重；legacy 的 `usageLimitExceeded` JSON-RPC 错误按回合去重。另外处理 `-32000` 未登录；失败会翻成错误条目 |
| `config.ts` | configOptions 的解析和本地校验，顶栏要的 `model_state`，额度卡的选项 |
| `permissions.ts` | `session/request_permission` ↔「待你处理」卡。fail closed：取消、超时、答了不认识的 id，一律回 cancelled |
| `session.ts` | 一条 ACP 会话：initialize（声明 AIR + 终端输出）、接线程、prompt / steer / cancel / 改配置、权限请求转宿主。线程状态按序号缓存，steer 回包那一刻（rpc 同步钩子）登记外部回合的结束；适配器退出时所有等待以失败结束 |
| `host.ts` | 宿主本体：连 bridge、起适配器（退出就退避重起、接回同一个线程）、入站渲染（与 CodexQueueSink 同款）、流式条目按序号送（确认才出队）、回合末全部确认才报 Stop、失败 / 权限转卡、改配置 |
| `adapter-proc.ts` | 起哪个 ACP agent（codex-acp / 沙箱里固定的本仓 stub，见 `stub.ts`）、它的环境（CODEX_PATH、full access、CODEX_CONFIG 挂 channel-server）、stdio 接成线路 |
| `bridge-link.ts` | 宿主到 bridge 的 ws：register 带 transport=acp、abort:true；断了退避重连，被顶替也不退出 |
| `tool-proxy.ts` | 回环工具代理：127.0.0.1 随机端口 + 一次性 token（在 BRIDGE_URL 里），吞 register、只转白名单请求类型，requestId 按连接改写 |
| `install.ts` | 适配器安装：npm registry 包文件、版本钉死、sha256 写死，校验不过拒装 |

bridge 那头：`bridge/acp-link.ts`（宿主的帧 → watcher 推送 / 卡片 / 配置；卡上的按钮经 `POST /agents/:name/answer {kind:"acp"}` 回宿主）、`bridge/acp-state.ts`（哪些频道此刻由宿主登记：打断走 abort 帧、watcher 不尾读 rollout、权限巡检 / Codex 回合失败收尾 / Stop 的屏幕复核都跳过它的窗口）。

## 和 tmux 的行为差异

- **补 reply**：tmux 下 Stop hook 在 Codex 收尾前拦下，同一轮接着答。ACP 没有 hook，宿主在 prompt 返回后上报 Stop；bridge 判定没回复（`lib/reply-nudge.ts`）时，宿主另起一轮很短的 prompt 补发提示，只补一次。所以**网页上会多一个短回合**。提示包成 `<hook_prompt>`，rollout 里和 tmux 的 hook 回灌同形，历史面板照旧显示成系统提示。
- **撞额度**：不再停在菜单上，所以 T63 的菜单护栏在 acp 下用不上。额度卡的选项是「等重置」加上 configOptions 里的其它模型，不做推荐（owner 的规矩，问题 d）；owner 点了才调 `set_config_option`，绝不自动选。重置时间照旧从 rollout 读（`codex-usage.ts`），ACP 不给这个。
- **思考**：`agent_thought_chunk` 不显示，和 tmux 下 rollout 的 reasoning 一致。
- **子线程**：试点不声明 subagents 能力。子会话照旧写 rollout，历史扫描不变。

## 已知边界与限制

- **claudestra MCP 的接法。** ACP `mcpServers` 里的同名 server，如果 `~/.codex/config.toml` 已经定义了，会被适配器**静默丢掉**（`CodexAcpClient.ts`），本机的 config.toml 恰好有 `claudestra`。所以 channel-server 经 `CODEX_CONFIG` 的 `mcp_servers.claudestra.*` 传入（`lib/acp/adapter-proc.ts`），和 tmux 下 `-c mcp_servers.claudestra.*` 覆盖是同一个语义（Codex 把它深合并到 config.toml 之上）。环境白名单去掉了 `TMUX` / `TMUX_PANE` / 前言：标就绪、打字投递、前言在 acp 下都归宿主。
- **沙箱只用 stub（owner 定的）。** 沙箱端到端不碰真 Codex 的登录和 `~/.codex`，用 `scripts/acp-stub.ts` 这个假的 ACP agent（只讲协议、不连模型，但会像 Codex 一样按 `CODEX_CONFIG` 起 channel-server、真的调 reply），把宿主、代理、bridge、网页整条链路测通。真模型只在合并后切 Shawn 本机的 agent-codex 时跑。沙箱闸门放「codex + `--transport acp`」，适配器固定起本仓的 `scripts/acp-stub.ts`（真实路径要在本仓里，`lib/acp/stub.ts`）；外部的 `CLAUDESTRA_ACP_AGENT` 是任意 argv，沙箱不继承、不认，带着它建 / 切 acp 直接拒。ACP 这条链（宿主、适配器、它起的 channel-server）的 `HOME` / `CODEX_HOME` 挪到沙箱根下的 `acp-home`；沙箱里的 Claude Code agent 仍用真 HOME（登录在那里）。tmux 版 Codex 照旧拒（`lib/sandbox.ts assertSandboxRuntime`）。
  - **不许**用软链或复制 `auth.json`：ChatGPT 登录的 refresh token 会轮换，一边刷新，另一边就失效。
  - `~/.codex/sessions` 是共享的，和 `~/.claude` 一样。
- **AIR 与终端输出。** 宿主声明了 AIR `sessionFailure`（所有回合失败都结构化，不只是额度），同时声明 `clientCapabilities._meta.terminal_output_delta: true`——声明 AIR 而不声明它，命令输出就收不到了。
- **适配器安装。** codex-acp 的 GitHub release 上没有任何附件，所以 `manager acp-install` 直接下载 npm registry 上的 `codex-acp-2.0.0.tgz`（269KB），版本钉死，sha256 写死在 `lib/acp/install.ts`（`a8d48bdf70c0e3e585abbdce19f78765450d8fa6ada1da0fd53508e64315905b`），校验不过就拒装、不回退到 npm；只解出 `dist/index.js` 放到状态目录，用我们自己的 bun 跑，并记下它的哈希——宿主每次启动都核对，装好后被改过就拒起。设了 `CODEX_PATH` 它不会加载那份 344MB 的 `@openai/codex`；不进 package.json。
- **Codex 升级。** Claudestra 不自动升 Codex（launcher 只自动升 Claude Code）。迁移 / 新建 / 重启先用 `codex app-server --help` 探测能力，不能只信退出码：旧 CLI 会把未知子命令当提示词并以 0 退出。宿主还会核对本机 Codex 与适配器配套版本；不匹配先告警。升适配器要改 `install.ts` 的版本和 sha256，再重跑 `acp-install`。
  - 配套范围只有一份：`install.ts` 的 `CODEX_ACP_PAIRS`。宿主告警、网页更新提示、`codex-update` 端点和 doctor 都读它。
  - 不配套时宿主只告警、照常起；readiness（`checkAcpReady`）也不看版本。但 restart 时如果接线程失败，会退回 tmux TUI（`manager/acp-lifecycle.ts recoverFailedAcpLaunch`，registry 改成 `transport:"tmux"` 加 `acpPending`）。所以错配真让 app-server 协议对不上时，表现可能是某次 restart 后悄悄回落到 tmux，而不是报错。doctor 的「Codex 与适配器配套」会报 warn，只报告，不改行为。
  - 网页横幅的规则（`lib/update-hints.ts`）：
    - npm 上的新版不在配套范围里：只给文字，不给「更新并重启」按钮，端点也回 409；
    - 已装版本本身就不配套时，ACP agent 的「重启生效」同样只给文字；
    - npm latest 是预发布版（带 `-alpha` 之类后缀）时不提示更新，端点也回 409。
  - 运行版本的来源：宿主每次起适配器之前，对 `CODEX_PATH` 异步跑一次 `--version` 并记下（最多等 10 秒，超时记「未知」照常起）（`codex-version.ts noteAcpCodexRunning`）。rollout 里的 `cli_version` 是建线程时的版本，不能用；initialize 只报适配器自己的版本。
- **新建要跑一轮引导。** 新线程在第一轮之前不落盘，所以 create 时起一个短命的适配器，`session/new` 后跑一轮 `[claudestra:bootstrap]`（和 tmux 下 `codex exec` 引导同一个做法，历史里整轮丢掉），职责与频道规则经 `developer_instructions` 在这一轮写进线程。宿主之后一律接已有线程：适配器声明了 `session/resume` 就用它（不回放历史），否则 `session/load`；首条入站附职责前言（与 tmux 同一份）。
- **fork 与 /clear**：`resume --fork --runtime codex` 经 `session/fork` 建新线程、重新订阅并跑一轮引导，registry 只记新 id。ACP 下 `/clear` 暂未轮转，先切回 tmux；其它斜杠命令（`/compact` 等）原样当一轮 prompt 交给宿主，由适配器自己认。
- **网页直播的 seq。** 宿主推上来的条目没有 rollout 行号：watcher 给它们本地序号、sid 带 `acp:` 前缀，前端据此不拿它们跟 rollout 的历史游标比，退回按时间戳合并（bridge 直投的 reply 本来就这样）。代价：回合中途刷新网页时，直播气泡的剔重没有按行号那么精确。以后要补，可以让宿主读 rollout 对齐行号。
- **流式条目按确认收尾。** 宿主的条目进有界出站队列，按序号一批批送；bridge 没挂好 watcher 时回 false，宿主退避重送，连续失败 8 次便记丢失并跳过这批。bridge 按 hostId + 序号跳过已处理前缀；单条坏记录和序号缺口按丢失计数确认，避免整批无限重送或重复正文。bridge 回包带累计丢失数，宿主在该轮按 StopFailure 报「可能丢了条目」。回合末等队列清空才报 Stop；90 秒等不到确认、bridge 重连、或队列超过 5000 条溢出也按 StopFailure 报。回合在适配器里接着跑，宿主按 channel-server 的退避重连。
- **权限卡、额度卡的按钮带卡的代际。** 权限请求按频道排队、一次出一张；每张卡新生成代际，旧卡、答过的一律 409、不授权。作答先原子认领，再经宿主确认它还在等才算答上。宿主等 10 分钟没人答、适配器退出时按取消回适配器并撤卡；宿主断线撤卡，重连后把还在等的补发上来（新卡、新代际）。额度卡同理：同一个失败又报一次沿用这张卡，换了一次失败就是新卡，旧卡的按钮作废。
- **排障。** 没有 TUI 可看了：看 agent 的 tmux 窗口（宿主日志：收到的消息、接上哪个线程、回合失败、适配器重起）和 `APP_SERVER_LOGS`（状态目录 `logs/acp/<agent>/`）。

## 用法

```bash
bun src/manager.ts create <name> <dir> [purpose] --runtime codex  # 缺省 ACP；首次自动下载并校验适配器
bun src/manager.ts migrate --acp                                 # bridge 启动后自动执行，也可重跑失败的迁移
bun src/manager.ts doctor                                        # 看适配器、CLI、暂退与待重启
bun src/manager.ts transport <agent> tmux                         # 一键回退、记住人工选择
bun src/manager.ts transport <agent> acp                          # 条件恢复后手动切回（自动 restart）
```

模型 / 推理强度：网页设置里照常切，acp 下经宿主调 `set_config_option`，**不重启**、回合进行中也能改；registry 同时记一份，重启后照样生效。

## 沙箱实测（stub）

```bash
bun run sandbox up --port <N> --static web/out
bun scripts/sandbox.ts manager create acpx <沙箱里的目录> 测试 --runtime codex --transport acp --port <N>
```

stub 的注入：正文带 `[stub:slow]` = 慢回合（等打断），`[stub:quota]` = 撞额度（结构化失败），`[stub:noreply]` = 这轮不调 reply（测补 reply）；起宿主时环境变量 `STUB_AUTH_REQUIRED=1` = 没登录（出登录卡）。
