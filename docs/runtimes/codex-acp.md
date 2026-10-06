# Codex over ACP（T60）

Codex agent 默认经 [Agent Client Protocol](https://agentclientprotocol.com) 驱动
[codex-acp](https://github.com/agentclientprotocol/codex-acp)（≥ 2.0.0，按本机 Codex 自动挑版本）。这样换来这些：
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

Codex 的窗口显示会话的只读视图（收到的消息、模型正文、工具调用和结果摘要、回合结束 / 失败原因，`lib/acp/transcript.ts`，脱敏、长结果截断）；宿主的连接日志只写 `logs/acp/<agent>/host.log`。`transport tmux` 可立即切回旧 TUI 路径；适配器或 CLI 不满足 ACP 条件时自动暂退 tmux。

## 状态

| PR | 内容 | 缺省行为 |
|----|------|----------|
| PR1（#225） | `src/lib/acp/` 纯库、transport 开关和 Codex ACP 策略 | Codex 仍走 tmux |
| PR2（#227） | ACP 宿主、bridge 接线、沙箱 stub、可靠投递与卡片代际 | 显式 `--transport acp` 可用 |
| 默认迁移 PR | Codex 新建 / 收编默认 ACP；升级时装适配器、迁移 registry、重启旧线程；doctor 检查及 tmux 回退 | ACP 优先，条件不足暂退 tmux |
| 删除 PR | 真机稳定并经审查后移除 Codex tmux 读屏 / 打字链路 | 仅 ACP |

升级时无参数 `migrate` 只做旧 worker→agent 迁移（旧版 updater 也这样调用）；bridge 重载并开始监听后才用 `migrate --startup` 自动执行 ACP 迁移，避免宿主接到旧 bridge。迁移幂等补齐旧 registry：可用则记 `transport: "acp"` 并重启接旧 thread；适配器下载 / 校验、Codex `app-server` 探测任一失败时，未迁移的记录记 `transport: "tmux", acpPending: true`，已有 ACP 记录保持原样，不打断正在跑的回合。重启 ACP 接旧线程失败也自动再起 tmux；人工执行 `transport <agent> tmux` 会清除待迁移标记，此后保持回退。暂退 tmux 的 agent 不在每次 bridge 重启时自动反复试；条件恢复后人工重跑 `manager migrate --acp`。失败的重启留标记给下次迁移，doctor 会点名。

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
- **打断复用 Pi 扩展的 abort 帧协议**（`abortVia: "extension"`）：宿主收到 `abort` 时会话里有回合（调度器在跑 / 排着，或适配器报着 active）就取消，然后回 `abort_ack`（`lib/acp/abort.ts`）。
  - codex-acp：发 `session/cancel` 通知，`voided` 为空。
  - Pi 适配器在 initialize 里声明 `_meta.claudestra.cancelReturnsQueue`，宿主改发 `_claudestra/cancel` 请求：适配器先 `clear_queue` 再 `abort`（pi 的 abort 会接着跑排队消息），清掉的交回宿主，宿主对回 steer 时记下的 message_id 填进 `voided`。叫停到 settle 之间（最多 60 秒）pi 续跑的轮再中止，这期间的插话不进 pi 的队列，停稳后另起一轮（同 `pi/abort-control.ts`）。
  - 按身份对（R18）：对声明了 `cancelReturnsQueue` 的适配器，宿主每条 `_session/steering` 带 `_meta.claudestra.deliveryId`（宿主生成，每条不同）。适配器按代一条一条发插话（pi 入队前要 await input hook，并发时实际入队顺序可能和发出顺序相反；一条卡住到 steer 超时就放开下一条），pi 回 queued、且发出到回包之间 steering 正好新增一条（`queue_update` 每次入队各报一次）才记账，正文取那条（input hook / 模板展开改写后的）；新增不止一条（扩展在回包前塞的、超时那条晚到的）就认不出，不记身份、只记日志——宁可漏报，不把已执行的报成「不会执行」；handled / started 没入队、超时的都不记。账本里是排在 pi 队列里还没出现在上下文里的插话（pi 的 user `message_start` 按先后销掉），`_claudestra/cancel` 回 `{cleared, clearedIds}`：`cleared` 照旧是正文，`clearedIds` 是其中能对回 deliveryId 的那几条。宿主有 `clearedIds`（数组）就只按身份判作废——正文相同的两条一条已执行、一条被清掉时只报被清掉的；没有（老适配器）才按正文对，行为不变。对不上身份的清掉条目（扩展自己排的、超时后才入队的）不报作废，只在宿主日志记一句「可能没有执行」，发送方收不到提示（要提示得 bridge 侧加通知，另议）。codex-acp 没声明这项，steer 参数和叫停都不变。
- **适配器自己开的回合**：线程从非 active 变 active 时宿主既没有 prompt 在途、也没有 steer 另起的回合在等，就当 external 槽跟到下一个 idle：期间升级闸答忙、叫停会取消，结束照常报 Stop / 补 reply（`session.ts` onSelfTurn → `turn.ts` track）。Pi 的扩展 `triggerTurn`、压缩后续跑走这条；codex-acp 只在宿主的 prompt / steer 期间变 active（它的 goal 续跑只经 `_session/goal`，宿主不调），行为不变。Pi 扩展的 notify / setStatus 脱敏后进宿主日志。

## 开关放在哪

- **registry**：每个 agent 有一个 `transport` 字段。旧记录缺字段仍由低层读成 tmux；升级迁移会补成 acp 或暂退 tmux。显式 tmux 是人工回退，迁移不会覆盖（`lib/registry.ts`、`runtimes/types.ts`）。
- **适配器**：`ManagedRuntimeAdapter.acp?: { control }`。没声明的运行时只能走 tmux，`transportsOf(runtime)` 据此回答能走哪些 transport。
- **会话来源**：rollout 发现、历史翻译与 token 扫描在 `lib/runtimes/codex-source.ts`，ACP 和 tmux 启动适配器共用。ACP 版直接组合这份来源与自己的生命周期，不继承 Codex TUI 的启动、退出或锁探测状态；这让将来删 tmux 路径时不会连历史一起删掉。
- **策略**：`controlFor(runtime, transport = "tmux")`。只有 transport=acp 且运行时声明了 ACP 段时才返回 ACP 的策略，其余情况都返回原来那份（`tests/runtime-transport.test.ts` 钉住缺省逐字不变）。

Codex 的 ACP 策略（`CODEX_ACP_CONTROL`）：

| 项 | 值 | 为什么 |
|----|----|--------|
| `interruptKeys` | `[]` | 窗口里只是会话的只读视图，宿主不读键盘，一个键都不发 |
| `abortVia` | `"extension"` | 打断走宿主的 `session/cancel` |
| `preemptOnHumanMessage` | `false` | 忙时用 steering 插进当前回合，和 Pi 的 steer 一样即时生效，不必掐掉回合 |
| `idleSource` | `"acp"` | `session/prompt` 没返回就是忙，屏幕判据一概不看；launcher 升级闸经 ws `turn_status` → `acp_call` `op:"turn"` 直接问宿主，查不到按忙挡住（`lib/acp-turn-gate.ts`） |
| `modelEnforcement` | `"config-option"` | 经 `session/set_config_option` 改，不重启 |
| `slashAsPrompt` | `true` | `/compact` 等当 prompt 文本发，由适配器转成 `thread/compact/start`（完成信号见「压缩完成信号」） |

## 适配器选择开关：上游 codex-acp 还是自研（CXF-S）

宿主起哪个 Codex 适配器由开关定：`upstream` = 上游 codex-acp（缺省，`acp-install` 装的那份），`self` = 仓库里的自研适配器
（`src/lib/acp/codex-adapter/`，[codex-adapter.md](./codex-adapter.md)）。**缺省全体上游，不动开关行为和以前一样。**

- **存在哪**：`<STATE_DIR>/codex-adapter.json`，`{ default, agents: { <agent>: upstream|self } }`；全局一处，单个 agent 覆盖（`lib/acp/codex-compat-switch.ts`）。
  没文件 = 全体上游；文件坏了读者按全体上游、写者拒写。
- **谁不归它管**：`CLAUDESTRA_ACP_AGENT` 手工覆盖仍最优先；沙箱永远是 stub；出借 worker 永远上游；create / fork 的引导轮固定用上游
  （新线程两边都是 `thread/start`，建好后宿主按开关接回）。
- **怎么切**（只在重启时生效：宿主启动时读一次）：

```bash
bun src/manager.ts codex-adapter                                  # 看全局、覆盖、每个 Codex agent 选中的和宿主上一次实际起的
bun src/manager.ts codex-adapter use self --agent <agent>         # 只把一个 agent 切到自研（先报 PM）
bun src/manager.ts codex-adapter use self                         # 全局切到自研（owner 拍板）
bun src/manager.ts codex-adapter clear --agent <agent>            # 删掉这个 agent 的覆盖，跟随全局
bun src/manager.ts codex-adapter rollback                         # 一条命令切回：全局上游、清掉所有覆盖
```

  改完只重启「宿主实际在跑的适配器 ≠ 新选择」的 transport=acp agent，走 `restart` 接旧线程那条路（session/resume，线程 id 不变）。
  **回合在跑的不切**：先经 bridge `turn_status` 问宿主（和升级闸同一个问法），只有明确答空闲的才重启；在跑或查不到的列进 `deferred`，
  开关已改，它下次重启时生效。`--no-restart` 只改开关。
- **选了自研时宿主怎么起**（`acp-host.ts` → `codex-compat.ts pickCodexAdapter`）：
  1. 起之前按 app-server 协议判本机 codex（`selfAdapterVerdict`，readiness 用同一判据），兼容就把组合身份打进 host.log
     （`组合身份 <id>（自研适配器 <指纹> + codex <版本> + schema <指纹>）`）；
  2. **不兼容和判不出（unknown）都不用自研，直接起上游**。和更新闸遇到 unknown 回 409 是同一个取舍：自研是没验证够的那一边，
     判不出就回到一直在用的上游（readiness 也照此：选了自研但判不过时按上游判就绪，`selfRefused` 写原因，不会因此暂退 tmux）；
  3. 起了自研但接不上线程（起来就退、initialize 被拒、resume 失败）→ 本宿主换上游再起一次（只换一次、不换回，没登录不换）；
     没装上游就照旧用自研并告警。接上之后崩溃（app-server 被杀把适配器带走）不算起不来，退避后重起的还是自研。
  宿主每次起适配器前把实际起的那个记进 `codex-running/<agent>.json` 的 `adapter`；doctor 据此报「选了自研、实际在跑上游」。
- **更新闸**：Codex 升级只看全局选择（单个 agent 的覆盖不改升级判据）；全局选了自研时按协议判 npm 候选，兼容才装。
  选了自研的单个 agent 碰上不兼容的新 Codex，重启时按上面第 2 条自己退回上游。
- **doctor**：有人选了自研才多两项——「自研适配器组合」（组合身份 + 协议判定；判不过时是 warn，带原因和 `rollback`），
  「自研适配器回退」（选了自研、宿主上一次实际起的是上游的 agent）。

上线门槛（独立契约、故障竞争、真 CLI 组合实测含 2.1.0 → 自研 → 2.1.0 线程接力、可撤回切换）的实测结果见
[codex-adapter.md「切换上线实测」](./codex-adapter.md#切换上线实测cxf-s)。

## 库（`src/lib/acp/`）

| 文件 | 职责 |
|------|------|
| `rpc.ts` | ndjson JSON-RPC 2.0 双向对端。手写，不加 SDK 依赖。<br>• 没注册处理器的请求回 -32601，绝不悬着不答。<br>• 入站先分清 request / notification / response；畸形响应（缺 jsonrpc、result/error 不是恰好一个）让请求失败，不算成功。<br>• 单行和未收完的半行都有字节上限（缺省 32 MiB，可配）：超了整条连接作废，日志只留截断摘要。<br>• 流断了，在途请求全部失败<br>• 失败带投递状态：已经尝试写出之后断线、超时、回包不合规、写入抛错是 `RpcLostError{sent:true}`，连接早就断了没写是 `sent:false` |
| `turn.ts` | 统一调度器：prompt、steering、适配器另起的外部回合、斜杠命令、补 reply 都按到达顺序进同一个队列，同一时刻只有一轮。<br>• 有 steering 在途就不开新回合、也不算空闲：`startedNewTurn` 在新回合**开始**时就回，回包到之前那一轮已经在跑。<br>• 外部回合在适配器里已经在跑，先等它（它的结束信号由 IO 在处理回包的同一刻挂上，结束得再早也不漏）。<br>• 插不进的 steering 在原位置变回 prompt，并发失败也不乱序；steer 不设短超时，超过 30 秒仍等待原请求，不因本地超时重复投递。<br>• 例外：`deliveredUnknown`（已经写给适配器、拿不到可信结果）不变回 prompt，只出一张不可重试的卡，附原文，由人决定要不要重发。<br>• 斜杠命令独占下一轮 prompt，不走 steering。<br>• 回合结束按 Stop hook 契约上报；bridge 回 block 就排一轮 `<hook_prompt>`，仍排在在跑的外部回合之后 |
| `updates.ts` | `session/update` 翻成 Claude Code 形状的条目，和 rollout 翻译同形 |
| `failures.ts` | 两种失败形态：AIR `sessionFailure` 按 id 去重；legacy 的 `usageLimitExceeded` JSON-RPC 错误按回合去重。另外处理 `-32000` 未登录；失败会翻成错误条目。<br>• 用户输入写出后拿不到可信结果（`deliveryUnknownCause`）：`retry:false` + `deliveryUnknown`，不触发 60 秒自动续跑 |
| `config.ts` | configOptions 的解析和本地校验，顶栏要的 `model_state`，额度卡的选项 |
| `permissions.ts` | `session/request_permission` ↔「待你处理」卡。fail closed：取消、超时、答了不认识的 id，一律回 cancelled |
| `session.ts` | 一条 ACP 会话：initialize（声明 AIR + 终端输出）、接线程、prompt / steer / cancel / 改配置、权限请求转宿主。线程状态按序号缓存，steer 回包那一刻（rpc 同步钩子）登记外部回合的结束；适配器退出时所有等待以失败结束。<br>• prompt / steer 的输入写出后断线、超时、回包不合规、写入抛错，或适配器回 `deliveredUnknown` / `data.deliveryUnknown`（Pi 适配器写给 pi 后超时）：prompt 以投递不明的失败收尾，steer 回 `deliveredUnknown`，都不 reject（reject 会被调度器改回 prompt 重发） |
| `host.ts` | 宿主本体：连 bridge、起适配器（退出就退避重起、接回同一个线程）、入站渲染（与 CodexQueueSink 同款）、流式条目按序号送（确认才出队）、回合末全部确认才报 Stop、失败 / 权限转卡、改配置 |
| `adapter-proc.ts` | 起哪个 ACP agent（codex-acp / 沙箱里固定的本仓 stub，见 `stub.ts`）、它的环境（CODEX_PATH、full access、CODEX_CONFIG 挂 channel-server）、stdio 接成线路 |
| `bridge-link.ts` | 宿主到 bridge 的 ws：register 带 transport=acp、abort:true；断了退避重连，被顶替也不退出 |
| `tool-proxy.ts` | 回环工具代理：127.0.0.1 随机端口 + 一次性 token（在 BRIDGE_URL 里），吞 register、只转白名单请求类型，requestId 按连接改写 |
| `resolve.ts` | 读 registry 元数据，挑能配本机 Codex 的最高正式版（≥ 2.0.0、tarball 只认 registry.npmjs.org、范围只认 `^`/`~`/精确） |
| `install.ts` | 适配器安装：按 registry 的 `dist.integrity` 验包，装进 `codex-acp-<版本>/`，`current.json` 指针决定用哪个 |
| `protocol.ts` | ACP 协议版本常量（宿主、Pi 适配器、stub 共用）与 initialize 回包判定：版本、必要能力、`agentInfo`；不兼容抛 `AcpIncompatibleError`（见下节） |

bridge 那头：`bridge/acp-link.ts`（宿主的帧 → watcher 推送 / 卡片 / 配置；卡上的按钮经 `POST /agents/:name/answer {kind:"acp"}` 回宿主）、`bridge/acp-state.ts`（哪些频道此刻由宿主登记：打断走 abort 帧、watcher 不尾读 rollout、权限巡检 / Codex 回合失败收尾 / Stop 的屏幕复核都跳过它的窗口）。

## 协议版本与能力（`lib/acp/protocol.ts`）

宿主只讲 ACP v1（`ACP_PROTOCOL_VERSION`；规范里 V2 还是草案）。initialize 回包由 `checkInitialize` 判：

| 回包 | 结果 |
|------|------|
| `protocolVersion` 不是 1，或者没回 | 不兼容 |
| `agentCapabilities.sessionCapabilities.resume` 和 `agentCapabilities.loadSession` 都没有 | 不兼容：接不回已有线程 |
| fork 操作，而没声明 `sessionCapabilities.fork` | 不兼容；fork 只在 fork 时才要求 |
| 带了 `agentInfo.{name, version}` | 记进会话（`AcpSession.agentInfo`）；宿主「已接上线程」那行日志、拒起原因里都带上 |

不兼容时走现有的启动失败通路，不另开一条：
- 宿主出一张「<运行时> 回合失败」卡（`acp_failure`：不可重试的 error、固定 key `incompatible`，正文写明原因）；拒起那一刻 bridge 还没登记上，就登记后补发（bridge 按题面去重）。
- 宿主不标就绪、不再重起适配器（重起换不来别的结果），排着的和之后的回合当场按失败收尾：报 StopFailure，错误条目不触发自动续跑。
- manager 等不到就绪（就绪超时），`recoverFailedAcpLaunch` 按接线程失败处理：退回 tmux（沙箱除外）。
- create / fork 的引导（`runtimes/codex-acp.ts` 的 `bootstrapThread`）在 initialize 就失败，原因原样带出。

### 可选能力缺失时怎么降级

可选能力缺了不拒起，按下表降级。表里每一行在 `tests/acp-protocol.test.ts`「可选能力缺失时怎么降级」都有一条：对真的宿主，有和没有这项能力各跑一遍。改了行为，表和测试要一起改。

| 能力 | 怎么判定有没有 | 缺了怎么办 |
|------|----------------|------------|
| steering | initialize 的 `_meta.steering.supported === true` | 忙时的消息排队，等这一轮结束再当下一轮 prompt 发（不发 `_session/steering`） |
| cancelReturnsQueue | initialize 的 `_meta.claudestra.cancelReturnsQueue === true`（Pi 适配器有，codex-acp 没有） | 叫停改发 `session/cancel` 通知，回执里的作废列表为空 |
| compaction_update | 适配器在回合里发 `compaction_update`（宿主总是声明 `session.compaction`；只管 Codex，Pi 的压缩边界走 `_meta.claudestra.compacted`） | 压缩照样由适配器做，但不出压缩边界，只看到一个「Compact conversation」工具调用 |
| AIR sessionFailure | prompt 回包带 `_meta.jetbrains.air.sessionFailure` | 按 legacy 认：只有额度用完（JSON-RPC 错误带 `usageLimitExceeded`）认得出，按回合去重；其它失败只是一段正文 |
| terminal_output_delta | `tool_call_update` 带 `_meta.terminal_output_delta` | 看不到命令输出，工具结果只剩适配器收尾时给的内容或退出码 |
| `promptCapabilities.image` | initialize 的 `agentCapabilities.promptCapabilities.image` | 附件只以本地路径（`[attachment: …]` 行）写进正文。有这项能力也一样：宿主还不发图片块 |

共享契约测试 `tests/acp-contract/`：同一组场景（initialize 与协议检查、接回线程、一轮文字回复、叫停、失败上报）按驱动跑，现在有 stub 和 Pi 回放两个驱动；新驱动照 `drivers.ts` 的 `ContractDriver` 实现、加进 `DRIVERS` 即可。维护流程见 [acp-maintenance.md](./acp-maintenance.md)。

## 和 tmux 的行为差异

- **补 reply**：tmux 下 Stop hook 在 Codex 收尾前拦下，同一轮接着答。ACP 没有 hook，宿主在 prompt 返回后上报 Stop；bridge 判定没回复（`lib/reply-nudge.ts`）时，宿主另起一轮很短的 prompt 补发提示，只补一次。所以**网页上会多一个短回合**。提示包成 `<hook_prompt>`，rollout 里和 tmux 的 hook 回灌同形，历史面板照旧显示成系统提示。
- **撞额度**：不再停在菜单上，所以 T63 的菜单护栏在 acp 下用不上。额度卡的选项是「等重置」加上 configOptions 里的其它模型，不做推荐（owner 的规矩，问题 d）；owner 点了才调 `set_config_option`，绝不自动选。重置时间照旧从 rollout 读（`codex-usage.ts`），ACP 不给这个。
- **不可重试的回合失败**（策略拦截、请求被拒、上下文耗尽）：除了「<运行时> 回合失败」卡，这一轮的 StopFailure 到时 bridge 给开这一轮的 send_to_agent 请求方各推一条，带失败原文（`bridge/turn-failure.ts` → `stop-settle.ts failedTurn`）；它中途 reply 过一句、回程槽已被消化的也推。owner 开的一轮看卡；peer 开的由挂着的 API 请求带回 `API Error: <原文>`（它已经答过一句、请求结掉了就没有回推通道）；它自己续跑的一轮不推。
- **思考**：`agent_thought_chunk` 不显示，和 tmux 下 rollout 的 reasoning 一致。
- **子线程**：试点不声明 subagents 能力。子会话照旧写 rollout，历史扫描不变。

## 已知边界与限制

- **claudestra MCP 的接法。** ACP `mcpServers` 里的同名 server，如果 `~/.codex/config.toml` 已经定义了，会被适配器**静默丢掉**（`CodexAcpClient.ts`），本机的 config.toml 恰好有 `claudestra`。所以 channel-server 经 `CODEX_CONFIG` 的 `mcp_servers.claudestra.*` 传入（`lib/acp/adapter-proc.ts`），和 tmux 下 `-c mcp_servers.claudestra.*` 覆盖是同一个语义（Codex 把它深合并到 config.toml 之上）。环境白名单去掉了 `TMUX` / `TMUX_PANE` / 前言：标就绪、打字投递、前言在 acp 下都归宿主。
- **Pi 走 ACP 时的挂载闸（残余风险）。** Pi 的 mcp.json 里有同名 server 会静默顶掉扩展挂的 channel-server，所以切 acp / 起宿主、适配器起 pi 前、pi 的 `session_start` 时都查撞名，任何一处不过就拒（`lib/acp/pi-adapter/mcp-clash.ts`，三处调用见 `lib/runtimes/pi-acp.ts`、`pi-adapter/main.ts`、`pi-adapter/mcp-mount.ts`）。挂载闸查的是磁盘上的 mcp.json，不是 Pi 已加载的快照；在加载与检查之间改写再恢复配置的同机进程不防（没有系统级隔离时这类进程本来就能直接改 Pi 配置）。以后可改为 channel-server 回宿主握手确认实际挂上的是自己的实例。
- **Pi 走 ACP 时 channel-server 不靠 builtin:mcp。** 用户装了注册 `/mcp` 的第三方 MCP 扩展（如 pi-mcp-adapter）时 pi 不加载 builtin:mcp，经 `registerMcpServer` 挂的 server 没人连，模型没有 reply、宿主却照报就绪。现在挂载扩展用 pi 公开导出的 `createMcpExtension` 自己连（只连交给它的 server，不注册 `/mcp`、不接别的扩展注册的 server、不动 `mcp_servers` 提示段），第三方扩展的工具（pi-mcp-adapter 的 `mcp` / `mcpScript`）照常在；`session_start` 等到 `mcp__<MCP_NAME>__reply` 真进了模型的工具表才报挂载 OK，最多等 20s，等不到就拒会话，`migrate --pi` 走已有的回退 tmux（`pi-adapter/mcp-mount.ts`，`tests/pi-acp-mount-tools.test.ts`）。
- **沙箱只用 stub（owner 定的）。** 沙箱端到端不碰真 Codex 的登录和 `~/.codex`，用 `scripts/acp-stub.ts` 这个假的 ACP agent（只讲协议、不连模型，但会像 Codex 一样按 `CODEX_CONFIG` 起 channel-server、真的调 reply），把宿主、代理、bridge、网页整条链路测通。真模型只在合并后切 Shawn 本机的 agent-codex 时跑。沙箱闸门放「codex + `--transport acp`」，适配器固定起本仓的 `scripts/acp-stub.ts`（真实路径要在本仓里，`lib/acp/stub.ts`）；外部的 `CLAUDESTRA_ACP_AGENT` 是任意 argv，沙箱不继承、不认，带着它建 / 切 acp 直接拒。ACP 这条链（宿主、适配器、它起的 channel-server）的 `HOME` / `CODEX_HOME` 挪到沙箱根下的 `acp-home`；沙箱里的 Claude Code agent 仍用真 HOME（登录在那里）。tmux 版 Codex 照旧拒（`lib/sandbox.ts assertSandboxRuntime`）。
  - **不许**用软链或复制 `auth.json`：ChatGPT 登录的 refresh token 会轮换，一边刷新，另一边就失效。
  - `~/.codex/sessions` 是共享的，和 `~/.claude` 一样。
- **AIR 与终端输出。** 宿主声明了 AIR `sessionFailure`（所有回合失败都结构化，不只是额度），同时声明 `clientCapabilities._meta.terminal_output_delta: true`——声明 AIR 而不声明它，命令输出就收不到了。
- **适配器安装。** codex-acp 的 GitHub release 上没有任何附件，所以直接下 npm registry 上的包文件（2.0.x 约 270KB）：只解出 `dist/index.js` 放到状态目录的 `acp/codex-acp-<版本>/`，用我们自己的 bun 跑，并记下它的哈希——宿主每次启动都核对，装好后被改过就拒起。设了 `CODEX_PATH` 它不会加载那份 344MB 的 `@openai/codex`；不进 package.json。
  - **信任链（改了 T60 的设计，待 Shawn 确认）**：原先版本钉死、sha256 写死在代码里，每个 Codex 小版本都要改代码发版。现在版本、配套范围（`dependencies["@openai/codex"]`）和 sha512 都取自 registry 元数据，下载后按 `dist.integrity` 比对，对不上拒装。信任 registry 的理由：Codex 本身就是 `npm install -g` 从同一个 registry 装的，registry 被攻破时 Codex 早已失守，写死 sha 不多挡什么。tarball 地址必须逐字是 `registry.npmjs.org/@agentclientprotocol/codex-acp/-/codex-acp-<该版本>.tgz`（只查前缀的话，元数据能把新版本指到旧版本的包上）；包文件边下边计数（8MB 上限，content-length 超限直接拒），解压也有 32MB 上限。
  - **版本与回退**：`acp/current.json` 指针（tmp+rename 原子写，临时名带 pid + 随机数）决定用哪个版本；旧目录都留着，指针指回去即回退。
  - **状态只有一处判定**：`install.ts currentCodexAcp` 返回 ok / null（什么都没装）/ broken，含入口文件和 entrySha256 校验；宿主起适配器、readiness、横幅、`codex-update` 端点、doctor 都读它。broken（指针读不出、指向的版本标记 / 入口 / 哈希对不上）时一律 fail-closed：不算已装、不算配套，网页不给「更新并重启」、端点 409，宿主告警提示跑 `acp-install`。
  - **老安装**：没有指针、而且状态目录里只有 `codex-acp-2.0.0` 这一个版本目录，才认作老安装（配套 `^0.158.0`）；指针丢了而旁边还有别的版本目录就是 broken，不回退 2.0.0。老安装旁边要装新版本时，先把 2.0.0 写成显式指针，装的过程中它一直可用。
  - **切指针只经对账**（`reconcileCodexAcp`）：按磁盘上此刻的 Codex 挑版本并装好（锁外，要联网；registry 不通、或最新候选下载 / 安装失败，就用本地已装、完好且配套的最高版本），再在 `acp/.pointer.lock`（`lib/file-lock.ts`）里重探一次 Codex——版本没变才切，变了就按新版本重来（最多三轮，之后明确报错）。`acp-install`、readiness、`codex-update` 收尾都走它，并发时最后对账的一方看到的是最终的 Codex，所以结果一定配套或明确报错，不靠长时间持锁。
  - **谁来装**：`manager acp-install` 对账到能配本机 Codex 的最新适配器；readiness（迁移 / 新建 / 重启 / 切 transport）在没装、坏了或不配本机 Codex 时也对账，对账失败而已装的完好就沿用（离线不会判成未就绪）。
- **Codex 升级。** Claudestra 不自动升 Codex（launcher 只自动升 Claude Code）。迁移 / 新建 / 重启先用 `codex app-server --help` 探测能力，不能只信退出码：旧 CLI 会把未知子命令当提示词并以 0 退出。宿主还会核对本机 Codex 与当前适配器的配套范围；不匹配先告警。
  - 配套范围只有一份：当前适配器标记里的范围原文（`install.ts codexPairsWithAdapter`）。宿主告警、网页更新提示、`codex-update` 端点和 doctor 都读它。
  - 网页「更新并重启」（`bridge/runtime-update.ts`）：npm latest 配当前适配器就直接 `npm install -g @openai/codex@<latest>`；不配但 registry 上有能配它的适配器时，先把适配器装进它自己的目录（不切指针）再装 Codex。两个分支在 npm 成功后都走同一个收尾：按磁盘上的 Codex 对账切指针（那一刻仍没装过任何适配器就跳过），成功才重启点按钮的 agent。适配器装失败 Codex 不动；Codex 装失败指针没动过，不用回滚；对账失败回 500 并说明。Codex 落盘到对账之间有很短的错配窗口，这期间别的 ACP agent 恰好重启会用上旧适配器 + 新 Codex，已知且可接受。其余在跑的 ACP agent 不动，下次重启自然用上新指针和新 Codex。
  - 不配套时宿主只告警、照常起。但 restart 时如果接线程失败，会退回 tmux TUI（`manager/acp-lifecycle.ts recoverFailedAcpLaunch`，registry 改成 `transport:"tmux"` 加 `acpPending`）。所以错配真让 app-server 协议对不上时，表现可能是某次 restart 后悄悄回落到 tmux，而不是报错。doctor 显示当前适配器的版本和配套范围，「Codex 与适配器配套」报 warn，只报告，不改行为。
  - 网页横幅的规则（`lib/update-hints.ts`，registry 的适配器列表缓存 6 小时，列表请求不等网络；冷缓存那一轮先显示「等适配器」，同时触发后台刷新，下一轮轮询出按钮）：
    - npm 上的新版不在当前配套范围里、registry 上也找不到能配它的适配器：只给文字，不给「更新并重启」按钮，端点也回 409；找得到就照常给按钮；
    - 已装版本本身就不配当前适配器、也找不到能配的：ACP agent 的「重启生效」同样只给文字（找得到时 restart 经 readiness 换适配器，照常给按钮）；
    - npm latest 是预发布版（带 `-alpha` 之类后缀）时不提示更新，端点也回 409。
  - 运行版本的来源：宿主每次起适配器之前，对 `CODEX_PATH` 异步跑一次 `--version` 并记下（最多等 10 秒，超时记「未知」照常起）（`codex-version.ts noteAcpCodexRunning`）。rollout 里的 `cli_version` 是建线程时的版本，不能用；initialize 只报适配器自己的版本。
- **新建要跑一轮引导。** 新线程在第一轮之前不落盘，所以 create 时起一个短命的适配器，`session/new` 后跑一轮 `[claudestra:bootstrap]`（和 tmux 下 `codex exec` 引导同一个做法，历史里整轮丢掉），职责与频道规则经 `developer_instructions` 在这一轮写进线程。宿主之后一律接已有线程：适配器声明了 `session/resume` 就用它（不回放历史），否则 `session/load`；首条入站附职责前言（与 tmux 同一份）。
- **fork 与 /clear**：`resume --fork --runtime codex` 经 `session/fork` 建新线程、重新订阅并跑一轮引导，registry 只记新 id。网页 `/clear` 和聊天里的 `/clear` 在宿主空闲时挂起入站、`session/new` 建线程、严格应用钉住的模型/强度并跑引导；完成后经 manager 带旧 id 条件更新 registry，等 bridge 确认新 watcher 才回成功。轮换期间的新消息排队进新线程；条目带 sessionId，旧 watcher 不会误确认。忙时或仍有未确认输出时回 409。引导或 registry 失败时不报成功，适配器重起接回旧线程；registry 已写而 watcher 暂不可用时如实返回未就绪、后台重试。其它斜杠命令（`/compact` 等）原样当一轮 prompt 交给宿主，由适配器自己认。
- **网页直播的 seq。** 宿主推上来的条目没有 rollout 行号：watcher 给它们本地序号、sid 带 `acp:` 前缀，前端据此不拿它们跟 rollout 的历史游标比，退回按时间戳合并（bridge 直投的 reply 本来就这样）。代价：回合中途刷新网页时，直播气泡的剔重没有按行号那么精确。以后要补，可以让宿主读 rollout 对齐行号。
- **流式条目按确认收尾。** 宿主的条目进有界出站队列，按序号一批批送；bridge 没挂好 watcher 时回 false，宿主退避重送，连续失败 8 次便记丢失并跳过这批。bridge 按 hostId + 序号跳过已处理前缀；单条坏记录和序号缺口按丢失计数确认，避免整批无限重送或重复正文。bridge 回包带累计丢失数，宿主在该轮按 StopFailure 报「可能丢了条目」。回合末等队列清空才报 Stop；90 秒等不到确认、bridge 重连、或队列超过 5000 条溢出也按 StopFailure 报。回合在适配器里接着跑，宿主按 channel-server 的退避重连。
- **权限卡、额度卡的按钮带卡的代际。** 权限请求按频道排队、一次出一张；每张卡新生成代际，旧卡、答过的一律 409、不授权。作答先原子认领，再经宿主确认它还在等才算答上。宿主等 10 分钟没人答、适配器退出时按取消回适配器并撤卡；宿主断线撤卡，重连后把还在等的补发上来（新卡、新代际）。额度卡同理：同一个失败又报一次沿用这张卡，换了一次失败就是新卡，旧卡的按钮作废。
- **排障。** 没有 TUI 可看了：会话看 agent 的 tmux 窗口；宿主日志（接上哪个线程、bridge 连接、适配器重起）在 `logs/acp/<agent>/host.log`，适配器的在同目录 `APP_SERVER_LOGS`。

## 用法

```bash
bun src/manager.ts create <name> <dir> [purpose] --runtime codex  # 缺省 ACP；首次自动下载并校验适配器
bun src/manager.ts migrate --acp                                 # bridge 启动后自动执行，也可重跑失败的迁移
bun src/manager.ts doctor                                        # 看适配器、CLI、暂退与待重启
bun src/manager.ts transport <agent> tmux                         # 一键回退、记住人工选择
bun src/manager.ts transport <agent> acp                          # 条件恢复后手动切回（自动 restart）
bun src/manager.ts codex-adapter rollback                         # 自研适配器出问题：一条命令全体切回上游 codex-acp
```

模型 / 推理强度：网页设置里照常切，acp 下经宿主调 `set_config_option`，**不重启**、回合进行中也能改；registry 同时记一份，重启后照样生效。

## 沙箱实测（stub）

```bash
bun run sandbox up --port <N> --static web/out
bun scripts/sandbox.ts manager create acpx <沙箱里的目录> 测试 --runtime codex --transport acp --port <N>
```

stub 的注入：正文带 `[stub:slow]` = 慢回合（等打断），`[stub:quota]` = 撞额度（结构化失败），`[stub:noreply]` = 这轮不调 reply（测补 reply）；起宿主时环境变量 `STUB_AUTH_REQUIRED=1` = 没登录（出登录卡），`STUB_INITIALIZE=<JSON>` = 按 JSON merge patch 改 initialize 回包（`null` 删键，测协议不兼容和可选能力缺失）。`/compact` 后面带 `[stub:compact-fail]` = 压缩失败，`[stub:compact-slow]` = 压缩等打断，`[stub:compact-dup]` = 完成信号连发两次；缺省压缩成功（形状见下节）。

## 压缩完成信号（codex-compact-N2 核对）

只读核对，没起 app-server、没登录、没连模型，也没读本机已装的适配器。2026-10-04 按 `lib/acp/resolve.ts` 的规则在临时目录取包：

- **包**：`@agentclientprotocol/codex-acp` **2.1.1**（registry 元数据 `dist-tags.latest`；配本机记录的 `codex-cli 0.159.3`，`pickAdapterFor` 选中，范围 `^0.159.1`）。tarball `https://registry.npmjs.org/@agentclientprotocol/codex-acp/-/codex-acp-2.1.1.tgz`，sha512 与元数据 `dist.integrity` 一致（`sha512-dppZxW3f…Uibu1qQ==`）。读的是包里的 `dist/index.js`（bundle，下面的名字是其中的源文件段）。
- **协议**：`compaction_update` 与 `clientCapabilities.session.compaction` 在 ACP 官方 schema 源码（`agentclientprotocol/agent-client-protocol` `20361dd2`，`agent-client-protocol-schema/src/v1/client.rs`）里标着 **UNSTABLE**、feature `unstable_session_compaction`：「不属于正式规范，随时可能改」。

| 问题 | 2.1.1 的实际行为（出处） |
|------|------------------------|
| `session/prompt("/compact")` 何时返回 | 压缩**结束后**才回。`AvailableCommands.tryHandleCommand` 的 `compact` 分支 await `CodexAcpClient.runCompact` → `CodexAppServerClient.runCompact`：发 `thread/compact/start` 后一直等到 `item/completed{contextCompaction}`、`thread/compacted`，或这一轮 `turn/completed`（非 inProgress）才 resolve。`/compact` 后面的文字被忽略（保留清单传不进去） |
| 成功时的回包 | `{stopReason:"end_turn"}`（`CodexAgent.prompt` 的「Prompt handled by a command」分支） |
| 完成的 `session/update` | 宿主声明了 `session.compaction` → `compaction_update{compactionId, status}`：开始 `in_progress`，结束 `completed`；同一 id 到终态后不再发（`CodexSessionCompactions.finish`）。没声明 → 只有标题「Compact conversation」的 `tool_call` / `tool_call_update completed`（AIR `_meta.jetbrains.air.contextCompaction`），旧版 `thread/compacted` 是一句文字或 notice |
| 失败 | 声明了能力：`compaction_update{status:"failed", error}`（这一轮 `turn/completed` failed 或不再重试的 `error`）、被打断是 `cancelled`；回包是 JSON-RPC 错误或 AIR `sessionFailure`，打断是 `stopReason:"cancelled"`；连接断开 → 请求失败 |

**宿主的接法**：`session.ts` 的 `CLIENT_CAPABILITIES` 声明 `session.compaction: {}`；`updates.ts` 只在 Codex 上认 `compaction_update`，只有 `completed` 才翻成 `compact_boundary`（同一 `compactionId` 只出一次，`in_progress` / `failed` 是进度句，`cancelled` 和未知状态不出东西）；`compactMetadata.trigger` 由宿主定：这一轮是宿主发的 `/compact` 就是 `manual`，否则 `auto`。Codex 的翻译器不认 `_meta.claudestra.compacted`，Pi 的不认 `compaction_update`，来源只看宿主按运行时认定的那一种。宿主收下 slash（`acp_call` 回 `ok:true`）、命令入队、压缩开始都**不是**完成。没有 token 数（`compaction_update` 不带），watcher 显示「📦 上下文已压缩」。

**核实过的版本清单：仅 2.1.1。** 能力是 unstable 的，换版本要重核这一节；N4 的能力闸按这份清单放行。这不代表 Codex 已经有完整的 save-compact（还缺 N1/N3/N4/N5）。

**空闲时的 `session/cancel`**：
- 适配器回完 `session/prompt` 之后才到的 cancel：`CodexAgent.cancel` → `interruptSessionTurn` → `getInterruptibleTurnId`。此时 `currentTurnId` 已在 prompt 的 finally 里清空、`pendingTurnStarts` 已删，日志一句「no current turn」就**丢弃**，不记到下一轮。
- 但「回包还在 stdio 里」的那个窗口（save-compact 方案 §2.4）：prompt 的 finally 里先 await 了几步（`waitForSessionNotifications`、文件变更报告、`dispose`）才清 `currentTurnId`，这期间到的 cancel 会对**已结束的那一轮**发 `turn/interrupt{threadId, turnId}`；报「no active turn」时，只要这个 session 又有 prompt 在跑（下一业务轮）就按 25/50/100/200/400 ms 重试同一个旧 turnId。app-server 会不会把旧 turnId 的 interrupt 落到当前在跑的轮上，取决于 app-server（Rust，不在这个包里），**没核实：unknown**。
- 结论：**证明不了不会影响下一轮**。N1 的 `cancel_slot` 对在跑的槽只能回 `uncancellable`（「正在压缩，不能中途取消」）；排队中的槽撤掉不发任何东西，照常可用。本卡没有开启任何「运行中取消」的路径。

