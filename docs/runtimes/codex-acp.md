# Codex over ACP（T60 试点）

在 tmux 之外，Codex agent 还有第二条 transport：经 [Agent Client Protocol](https://agentclientprotocol.com) 驱动
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

试点期只接一个 agent，按 agent 切换，缺省照旧 tmux。

## 状态

| PR | 内容 | 缺省行为 |
|----|------|----------|
| PR1（本篇随它合入） | `src/lib/acp/` 纯库 + 单测；`transport` 开关（registry 字段、`controlFor(runtime, transport)`、Codex 适配器的 ACP 段） | 不变：没有任何入口能把 agent 切到 acp，所有调用方仍按 tmux 取策略 |
| PR2 | `src/acp-host.ts` 宿主、回环工具代理、`manager/acp-lifecycle.ts`（create / restart / resume / kill / transport / acp-install）、`bridge/acp-link.ts`、launcher 升级闸、沙箱放行 + 实测 | 同上，切了才生效 |

真机试点要等 PR2 合并，在 Shawn 本机的 agent-codex 上跑一周，由 PM 切换，owner 能看到。要回退，执行 `manager transport <agent> tmux` 即可。

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

- **registry**：每个 agent 有一个 `transport` 字段，只认 `"acp"`，缺省和认不出的值都按 tmux 处理（`lib/registry.ts`、`runtimes/types.ts` 的 `normalizeTransport`）。
- **适配器**：`ManagedRuntimeAdapter.acp?: { control }`。没声明的运行时只能走 tmux，`transportsOf(runtime)` 据此回答能走哪些 transport。
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
| `turn.ts` | 统一调度器：prompt、steering、适配器另起的外部回合、补 reply 都按到达顺序进同一个队列，同一时刻只有一轮。<br>• 有 steering 在途就不开新回合、也不算空闲：`startedNewTurn` 在新回合**开始**时就回，回包到之前那一轮已经在跑。<br>• 外部回合在适配器里已经在跑，先等它（它的结束信号由 IO 在处理回包的同一刻挂上，结束得再早也不漏）。<br>• 插不进的 steering 在原位置变回 prompt，并发失败也不乱序。<br>• 回合结束按 Stop hook 契约上报；bridge 回 block 就排一轮 `<hook_prompt>`，仍排在在跑的外部回合之后 |
| `updates.ts` | `session/update` 翻成 Claude Code 形状的条目，和 rollout 翻译同形 |
| `failures.ts` | 两种失败形态：AIR `sessionFailure` 按 id 去重；legacy 的 `usageLimitExceeded` JSON-RPC 错误按回合去重。另外处理 `-32000` 未登录；失败会翻成错误条目 |
| `config.ts` | configOptions 的解析和本地校验，顶栏要的 `model_state`，额度卡的选项 |
| `permissions.ts` | `session/request_permission` ↔「待你处理」卡。fail closed：取消、超时、答了不认识的 id，一律回 cancelled |

## 和 tmux 的行为差异

- **补 reply**：tmux 下 Stop hook 在 Codex 收尾前拦下，同一轮接着答。ACP 没有 hook，宿主在 prompt 返回后上报 Stop；bridge 判定没回复（`lib/reply-nudge.ts`）时，宿主另起一轮很短的 prompt 补发提示，只补一次。所以**网页上会多一个短回合**。提示包成 `<hook_prompt>`，rollout 里和 tmux 的 hook 回灌同形，历史面板照旧显示成系统提示。
- **撞额度**：不再停在菜单上，所以 T63 的菜单护栏在 acp 下用不上。额度卡的选项是「等重置」加上 configOptions 里的其它模型，不做推荐（owner 的规矩，问题 d）；owner 点了才调 `set_config_option`，绝不自动选。重置时间照旧从 rollout 读（`codex-usage.ts`），ACP 不给这个。
- **思考**：`agent_thought_chunk` 不显示，和 tmux 下 rollout 的 reasoning 一致。
- **子线程**：试点不声明 subagents 能力。子会话照旧写 rollout，历史扫描不变。

## 已知边界 / PR2 要处理的

- **claudestra MCP 的接法。** ACP `mcpServers` 里的同名 server，如果 `~/.codex/config.toml` 已经定义了，会被适配器**静默丢掉**（`CodexAcpClient.ts`），本机的 config.toml 恰好有 `claudestra`。所以 channel-server 改经 `CODEX_CONFIG` 的 `mcp_servers.claudestra.*` 传入，和 tmux 下 `-c mcp_servers.claudestra.*` 覆盖是同一个语义（Codex 把它深合并到 config.toml 之上）。
- **沙箱（问题 b）。** `CODEX_CONFIG` 是深合并，`{"mcp_servers":{}}` 清不掉 config.toml 里的 server。PR2 先实测能不能逐个用 `enabled=false` 关掉；关不掉的话，沙箱端到端就改用假的 ACP agent（stub：只说协议、不连真模型），把宿主、代理、bridge、网页这条链路测通。真模型只在合并后切真机时跑。
  - **不许**用软链或复制 `auth.json`：ChatGPT 登录的 refresh token 会轮换，沙箱那份一刷新，生产那份就失效。
  - `~/.codex/sessions` 是共享的，和 `~/.claude` 一样。
- **AIR 与终端输出。** 声明 AIR 之后，如果不同时声明 `clientCapabilities._meta.terminal_output_delta: true`，命令输出就收不到了。不声明 AIR 的话，除额度以外的回合错误都只是一段正文。宿主要声明 AIR `sessionFailure`，同时声明 terminal_output_delta。
- **适配器安装（问题 c）。** GitHub release 上没有任何附件，写在 readme-dev 里的平台 zip 实际并没有发布。替代方案待 Shawn 确认：从 npm registry 直接下载 `codex-acp-2.0.0.tgz`（269KB，`dist/index.js` 是打好包的单文件），版本固定，sha256 写死在代码里（`a8d48bdf70c0e3e585abbdce19f78765450d8fa6ada1da0fd53508e64315905b`），校验不过就拒装、不回退；解压到状态目录，用 bun 运行。设了 `CODEX_PATH` 时不会加载它依赖的 `@openai/codex`，也就不会带上那份 344MB。不进 package.json。
- **自动升级。** 只要 registry 里有 transport=acp 的 agent，launcher 就跳过 Codex 自动升级，并在 #control 提醒一次「请连适配器一起手动升级」。`CODEX_PATH` 锁本机的 codex。
- **排障。** 没有 TUI 可看了，要看宿主日志（tmux 窗口）和 `APP_SERVER_LOGS`。
