# Codex 原生压缩与「先存交接再压缩」实施方案（codex-compact-P1）

本文只做核对和规划，**不改产品代码，也没有压缩任何真实会话**。核对基线：main `a538824a`。
结论先说：
- 今天 Claudestra **没有** Codex 版的 save-compact。fleet 对非 claude-code 运行时的 `compact` / `save-compact` 一律跳过。
- 网页 `/compact` 发给 Codex ACP agent 时，拿到的 202 只表示「宿主收下了」，不表示压缩已经完成。
- 宿主现在也收不到 Codex 压缩完成的信号。

下面先列现状，再给可以拆给执行者的小节点。

## 1. 现状核对（准确入口）

### 1.1 fleet 规划 / 执行

| 环节 | 入口 | 对 Codex 的现状 |
|------|------|----------------|
| 动作白名单 | `src/lib/fleet-plan.ts:10` `FleetActionKind`（含 `compact` / `save-compact` / `lp-compact`） | 动作与运行时无关 |
| 运行时闸 | `fleet-plan.ts:22` `ccOnly()`：除 `text` 以外全部算 CC 专属；`fleet-plan.ts:150` `notApplicable()` → `运行时不支持（codex）` | **Codex 直接 skip，不发任何东西** |
| 执行者换法 | `src/bridge/fleet/service.ts:163` `actionFor()`，依据 `src/lib/ctx-boundary-policy.ts:142` `effectiveAction` / `:148` `isExecutor` | 执行者（`agent-task-*` 或 linked worktree）跑 save-compact 时改成 compact，免得覆盖 PM 的 HANDOFF |
| 发键 | `src/bridge/fleet/runner.ts:146` `compact()` → `service.ts:252` `injectCompact`（`bridge/ctx-boundary-inject.ts`） | 读的是 tmux 屏幕和 CC 文案，Codex ACP 窗口里只有宿主日志，这条路不能复用 |
| 「完成」口径 | `runner.ts:156-162`：看到 spinner 或 `Compacting conversation` 就报 `done`，detail 是「已开始压缩」 | CC 这边也只确认「已开始」。Codex 版必须区分「已受理」和「已完成」（见 §2.4） |
| 防重复 | 三层，性质不同（见下） | 都是给 tmux 发键设计的，Codex ACP 都用不上，需要新的持久单飞（§2.5） |

防重复的三层要分开看：
- `runner.ts:229` `inFlight`：进程内 `Set`，**以 agent 名为键**，bridge 重启就清空。只防同一进程里两个批量动作同时处理同一个 agent。
- `withWindow`：进程内的窗口执行权，**以 tmux 窗口为键**，同样不落盘。
- 15 分钟注入守卫：**已经落盘**。`ctx-boundary.ts:383` 启动时 `loadInjectState("live")`，`ctx-boundary-inject.ts:23,93-101` 把守卫换成 `PersistedMap`（`ctx-boundary-injected.json`），`:156-158` `noteCompactInjected` 写入，bridge 重启后还在。它以 tmux 窗口为键（`windowKey`），只记「发过压缩键」，不记压缩是否完成。

### 1.2 权限 / 范围

- 网页：`src/bridge/local-api/fleet.ts`，`canRunFleet` 只放行 owner 本人的全 scope manage 凭据；`agentInScope` 决定能动谁，设备没授权 master 就碰不到 master。
- MCP `fleet` 工具：`src/bridge/fleet/ws.ts` + `src/lib/fleet-caller.ts`。
  - 按连接认出调用方，只放行 master、台账 pms 和 `fleet.callers`。
  - `scopeForCaller` 去掉 master、调用方自己，以及 PM 管不到的项目。
  - **自我压缩闸**：`fleet-caller.ts:60` `INTERRUPTS_SELF` / `:80`。点名自己做 compact 类动作，整个请求都拒，因为它会打断调用方当前这一轮。
- 本机 CLI（ws 非 MCP）：`LOCAL_CLI` 不含 master，`text` / 自定 keep / 点名 master 一律拒。
- 斜杠直通：`src/bridge/api-slash.ts`。
  - `:91` peer 的斜杠文字永远当普通消息，所以 external / peer 不能触发压缩。
  - 直通只给 owner（`isOwnerPrincipal`，否则 403）。
- 远端出借 worker 只读，不进候选（`service.ts:106` `remoteWorkers`）。

### 1.3 ACP session 命令 / 适配器链

1. **网页 `/compact`**：`api-slash.ts:113` 命中 `src/lib/runtime-commands.ts:17`。`CODEX_BUILTIN_PASSTHROUGH` 里的 `compact` 标了 `turn: true`。
2. **交给宿主**：`api-slash.ts:59` `acpSlashPassthrough` → `src/bridge/acp-link.ts:216` `acpSlash`，发帧 `{op:"slash"}`。
3. **宿主入队**：`src/lib/acp/host.ts:357` 收到 `op:"slash"` 后调 `loop.submitCommand(text)`，**同步回 `{ok:true}`**，这时只是入队。
4. **网页回包**：`api-slash.ts:65` 回 **HTTP 202 `accepted: true`**，再 `markThinking`。这只是「已受理」。
5. **独占一轮**：`src/lib/acp/turn.ts:106` `submitCommand`，`next()`（`:156`）让 command 槽独占一轮 `session/prompt`。
5b. **没有去重**：连续两次 `/compact` 会走两次 `acpSlash`，宿主两次 `submitCommand`，`turn.ts:106-110` 排两个 command 槽，也就是压缩两轮。
6. **适配器转换**：`src/lib/runtimes/acp-control.ts:9` / `runtimes/types.ts:215`（`slashAsPrompt`）。按注释，codex-acp 会把 `/compact` 文本转成 app-server 的 `thread/compact/start`。

### 1.4 compacted 事件链

| 来源 | 落点 | 对 Codex 是否成立 |
|------|------|------------------|
| CC jsonl `system/compact_boundary` | `bridge/jsonl-watcher.ts:438` → SSE `compact_done`、放行 held（`bridge.ts:497-503`） | CC 才有 |
| ACP `session_info_update._meta.claudestra.compacted` | `src/lib/acp/updates.ts:157` → `compact_boundary` | **只有本仓的 Pi 适配器会发**（`acp/pi-adapter/map.ts:36`）。第三方 codex-acp 不会带 `_meta.claudestra` |
| Codex rollout | `src/lib/codex-session.ts` 只翻 `session_meta` / `event_msg` / `response_item` / `turn_context` | **没有翻压缩记录**，watcher 永远看不到 Codex 的压缩边界 |
| 「正在压缩」状态 | `getAgentStatus(a) === "compacting"` 由 `bridge/permission-watcher.ts:506-518` 读屏幕设置；没有屏幕启发式的运行时整块跳过 | Codex ACP 永远不会进入 `compacting` 状态 |
| 自动压缩边界 | `bridge/ctx-boundary.ts:241` / `:296` 只认 `claude-code` | Codex 不参与（本方案也不改） |

**上游语义（如实注明：本地未核实）**
- 仓库里没有 codex-acp 和 codex app-server 的源码：适配器不在 `package.json`，只装在状态目录。按本单限制没有去读那份安装副本。
- 本机只跑了 `codex --version`，结果是 `codex-cli 0.159.3`。没有调用 app-server，也没有调用模型。
- 按 openai/codex 公开的 app-server 文档，`thread/compact/start` **立即返回空结果**，压缩进度再经 turn / item 通知流出来（`contextCompaction` 条目），rollout 里另落压缩记录。
- 这三点都没有逐版本核对过。因此 **N2 的第一步必须在临时目录核对当前 pinned 的 codex-acp 和 app-server 协议**，确认三件事：
  - `session/prompt("/compact")` 的返回时机：是压缩完才返回，还是一开始就返回；
  - 压缩完成时发的是哪一种 `session/update`；
  - 压缩失败时以什么形态返回。

  核对之前，**任何地方都不得把「已受理」报成完成**。

### 1.5 保存交接（save）现状

- `skills/save-compact/SKILL.md` 是 **Claude Code 技能**：
  - HANDOFF.md 写到 `~/.claude/projects/<slug>/memory/`；
  - 由 `src/hooks/recall-hook.ts` 在 CC SessionStart 时注入；
  - 最后一步是 CC 的 `/compact`。
- Codex 没有这个 memory 目录，也没有 SessionStart hook，所以 **不能说 Claude 的 save-compact 技能已经支持 Codex**。
- `runtime-commands.ts:4` 也故意不把 CC 技能列进 Codex 的命令面板。
- 执行者在 worktree 里写 memory 会盖掉 PM 的 HANDOFF（`ctx-boundary-policy.ts:138` 的注释）。Codex 版必须从路径设计上杜绝这件事。

### 1.6 busy / 押后 / 租约（压缩期间要保持持久）

- **押后队列落盘**：`bridge/held-queue.ts` 落到 `~/.claude-orchestrator/held-messages.json`，bridge 重启不丢；`check_inbox` 租约 `INBOX_LEASE_MS` 为 15 分钟（`:30-31`）。
- **ACP busy 的来源**：`turn.ts` 的 `AcpTurnLoop.busy`，bridge 经 `acpHostTurnBusy`（`acp-link.ts:225`）询问宿主。
- **已知缺口（N1 要修）**：`turn.ts:126`。command 槽在跑时 `pumping=true`，新的入站会走 `io.steer`，**被 steer 进正在压缩的那一轮**。
  - 这可能把消息并进压缩前的历史，或者被上游拒掉后退回 prompt，行为取决于上游，没有核实过。
  - 原则上，压缩期间的入站必须排在压缩之后，不能插进压缩这一轮。

## 2. 目标行为

### 2.1 顺序（Codex save-compact）

1. **受理**：校验权限，检查单飞（同一 agent 同一时刻只有一个 op），写入 op 记录（`accepted`），然后马上回包。
2. **等安全点**：
   - 宿主空闲：`AcpTurnLoop.busy === false`；
   - 该频道押后队列里没有待投的非 `other` 条目，`check_inbox` 租约也不在期内。

   不满足就排队等，**不打断当前回合、不越过未处理的收件箱**。这样自调用也安全：当前工具结果所在的那一轮先跑完，op 才开始。
3. **保存（saving）**：用一轮普通 prompt 让 agent 调新 MCP 工具 `save_handoff`。
   - 落盘路径由 bridge 根据**连接认出的 agent 名**决定，忽略请求里任何路径或身份字段；
   - 写入原子化（tmp+rename，复用 `lib/file-lock.ts`）；
   - 校验大小和非空。
4. **判定保存结果**：回合结束时 bridge 核对这个 op 的交接文件，op id 和时间都要比受理晚，才转入 `saved`。
   - 没写、超时、回合失败或被取消 → `failed: save` / `cancelled`，**不压缩**。
5. **压缩（compacting）**：先把 op 记成 `compacting{dispatched:false}` 并落盘，**落盘成功后**才发 `acpSlash("/compact <保留清单>", opId)`（复用 `fleet.compactKeep`）；宿主回执到了再记 `dispatched:true`。
   - 顺序的用意：磁盘上只要还是 `saved`，就一定没发过压缩；一旦是 `compacting`，就可能发过，重启后不能自动重放（§2.5）。
   - 落盘失败 → `failed: compact`（原因写「状态没写进去，没发」），交接保留。
6. **完成判定**：
   - 只有拿到 N2 核实过的完成信号，才转 `compacted`，同时发 `compact_done` 并放行押后；
   - 失败 / 被取消 / 超时 → `failed: compact` / `cancelled`。此时**交接文件保留**，界面明确写「交接已存，压缩没成功」。
7. **压缩之后**：下一条入站消息附一行指针「交接在 <路径>，先读」，与首条入站附职责前言同一机制。是否注入正文，由 PM 在 N4 定（默认只给指针）。

### 2.2 交接文件位置（只写本 agent 授权的位置）

- 路径：`STATE_DIR/handoff/<registry 名>/HANDOFF.md`。经 `lib/paths.ts statePath` 拼出来，名字只允许 registry 里登记过的 agent。
- 不写 `~/.claude/projects/*/memory`，也不写 cwd。所以执行者和 PM 不可能互相覆盖，worktree 也无从改到主仓的交接。
- 工具 schema 里**没有路径参数**；跨 agent 写（名字与连接不符）直接拒绝，并记一条日志。

### 2.3 权限 / 范围保持

- 入口沿用现有的闸，**不新增放宽**：
  - 网页：owner 全 scope + `agentInScope`；
  - MCP `fleet`：`scopeForCaller` + `allowedForCaller`，master 不进批量；
  - 斜杠直通：只给 owner，peer 的斜杠文字仍按普通消息处理；
  - 远端 worker 只读。
- **external / peer 凭据一律不能触发压缩**，连「请求自压」都不行，因为只有本机连接认出的 agent 才能调用相关工具。
- **actor 留痕**：op 记录和 `auditFleet` 都带 `actor` / `via`，与现在的 fleet 留痕同一口径。

### 2.4 状态 / 失败 / 取消的反馈

- 状态机：
  - save-compact：`accepted → waiting → saving → saved → compacting → compacted`；
  - compact-only（fleet `compact`、网页 `/compact`，见 §2.6）：`accepted → waiting → compacting → compacted`，跳过 saving / saved，不写交接。
- 任一步都可能落到 `failed{stage, reason}` 或 `cancelled{stage}`。
- 对外回包：
  - 网页和 fleet 结果的 `outcome` 只用 `queued`（已受理 / 等待）、`done`（**仅 `compacted`**）、`skipped`、`failed`；
  - 受理时回 `queued` 加 op id，不回 `done`。
- 后续进度：每次状态迁移发 SSE（新事件 `compact_op`），并在 agent 频道发一行知会。
- 取消：**按 op 取消**，不复用现有的停止按钮。
  - 现有 `abortAcpTurn`（`acp/abort.ts:19-24`）取消的是会话当前的回合，不认 op；它也不删宿主 `AcpTurnLoop` 里排着的 command 槽。直接复用会有两个错：等待期间点取消会打断别人的业务轮（可能正是自调用工具所在的那一轮）；command 已排队时取消，当前轮停了，压缩却在下一轮照跑。
  - 所以 op 发给宿主的槽都带 `opId`（N1），宿主新增 `cancel_slot{opId}`：槽还在队列里就**删掉**并回 `revoked`；正在跑的就是这个 op 的槽才回 `running`；不在了回 `gone`。
  - 各阶段：

    | 阶段 | 取消做什么 | 结果 |
    |------|-----------|------|
    | accepted / waiting | 只在 bridge 撤掉等待，**不碰会话** | `cancelled{waiting}` |
    | saving，槽还在排队 | `cancel_slot` → `revoked` | `cancelled{saving}`，不压缩 |
    | saving，槽在跑 | `cancel_slot` 回 `running` 后，才对这一轮 `session.cancel` | 回合结束后 `cancelled{saving}`，不压缩 |
    | saved | 只在 bridge 结束 op | `cancelled{saved}`，交接保留 |
    | compacting，槽还在排队 | `cancel_slot` → `revoked`，压缩不会再跑 | `cancelled{compacting}`，交接保留 |
    | compacting，槽在跑 | 同上，只取消属于本 op 的这一轮 | 见下方竞态规则 |

  - **竞态**：最终状态以宿主报的这个槽的实际结局为准，不以点击为准。取消回执之前完成信号已经到了 → `compacted`；宿主回 `gone` 且没有完成信号 → 等槽的 prompt 结局再定。界面先显示「正在取消」，不提前写「已取消」。
  - 现有停止按钮照旧只管当前回合。它停掉的恰好是 op 的槽时，op 跟着记 `cancelled{阶段}`；停的是别的回合，op 不受影响。
- 不能用时的解释（都不发任何东西）：

  | 情况 | 结果 |
  |------|------|
  | 离线 | `skipped：不在线` |
  | tmux 版 Codex | `skipped：Codex tmux 版不支持（切到 ACP）` |
  | Pi | 沿用现状，本方案不改 |
  | 适配器没声明能力，或版本未核实 | `skipped：适配器不支持可确认的压缩` |
  | busy | `queued：回合结束后执行` |

### 2.5 幂等 / 不丢消息

- **单飞**：op 记录落盘到 `STATE_DIR/codex-compact-ops.json`（tmp+rename），键是 agent。
  - 有未终结的 op 时，再点一次直接返回同一个 op id，不重复保存、不重复压缩、不多跑模型；
  - bridge 重启后从记录续上：
    - `waiting` / `accepted`：重新等安全点；
    - `saving`：向宿主查 `slot_status{opId}`。宿主还排着 → `cancel_slot` 撤掉后记 `failed: interrupted`；宿主在跑或已跑完 → 等它的结局，按 §2.1 第 4 步判保存结果；宿主不在 / 不认这个 op → `failed: interrupted`。都不重放保存。
    - `saved`：交接已存、压缩**一定没发**（§2.1 第 5 步的落盘顺序保证）。先核对交接文件还在且 op id 对得上：
      - 对得上，且 `saved` 不超过 30 分钟 → 重新等安全点，然后照常进入 compacting（只会发这一次）；
      - 文件不在 / 对不上 / 超过 30 分钟 → 记 `failed: interrupted{saved}`，交接保留，界面写「交接已存，压缩没发，可以再点一次」。
    - `compacting`：先查 `slot_status{opId}`（宿主是独立进程，bridge 重启时它可能还在跑这个槽）。在排队 / 在跑 → 继续跟它的结局；已结束 → 按完成信号判；宿主不在、不认这个 op、或 `dispatched:false` 且宿主没有这个槽 → `failed: interrupted`。**任何情况都不自动重放 `/compact`**，避免重复消耗。
  - 终结状态（`compacted` / `failed` / `cancelled`）之后再点，才建新 op。`failed: interrupted{saved}` 后再点 save-compact，新 op 照常重新保存，不复用旧交接（旧文件会被同 agent 的新交接原子替换）。
- **消息**：压缩期间入站一律排在压缩之后（N1）。押后队列、租约和台账任务进度不受影响：它们都在磁盘上，本流程只读不写。
- **不开定时**：
  - 不新增 cron，也不新增自动触发；
  - ctx-boundary 的自动注入继续只管 CC；
  - 不消耗 owner 的第二张重置卡，不改额度闸。
- **压缩本身会耗模型**：只在 owner 或 PM 明确点击 / 调用时发生。

### 2.6 统一入口：fleet compact 与网页 `/compact` 也走 op

- Codex ACP 的所有压缩入口都调同一个函数 `requestCodexCompact({agent, kind, keep, actor, via})`（N4 的 `entry.ts`），它负责能力闸、权限之后的单飞、落盘 op、回包：
  - fleet `compact` / `save-compact`（网页批量面板、MCP `fleet` 工具、本机 CLI）；
  - 网页 `/compact`、`/save-compact` 发给 Codex ACP agent 时（`api-slash.ts` 不再直通 `acpSlashPassthrough`）；
  - MCP `request_self_compact`（只登记本 agent 自己的 op）。
- `kind: "compact"` 走 compact-only 分支，不写交接；`kind: "save-compact"` 走完整流程。
- **能力闸**：适配器版本不在 N2 核实过的清单里 → 回 `skipped：适配器不支持可确认的压缩`，**什么都不发**。这会改变现状：今天网页 `/compact` 对 Codex 会直通宿主，改后未核实的版本不再发。
- **单飞**：有未终结的 op 就返回它，不论 kind。正在 compact-only 时点 save-compact，返回旧 op 并说明「正在压缩，结束后再点」，不排第二个。
- 回包：受理回 `queued` + op id（网页 HTTP 202），只有 `compacted` 才是 `done`。
- Pi 的 `/compact` 直通、CC 的发键路径都不改。

## 3. 节点拆分（给 PM 落正式代码节点）

每个节点都要附 `bun run check` 通过。新文件 ≤ 800 行（测试 ≤ 600），函数 ≤ 100 行；大文件只加一行调用。

### N1 · ACP 宿主：命令槽不 steer + 槽带 op id、可撤销（无依赖）

- **globs**：`src/lib/acp/turn.ts`、`src/lib/acp/host.ts`、`src/lib/acp/abort.ts`、`src/bridge/acp-link.ts`、`tests/acp-turn.test.ts`、`tests/acp-self-turn.test.ts`
- **改动**：
  - command 槽在跑时，新入站排在命令之后，不 steer；
  - `submitCommand(text, opId?)`，另加独占一轮、不与普通 prompt 合批的 `op` 槽（给 saving 用；现在 `next()` 会把相邻 prompt 拼成一轮）；
  - `cancelSlot(opId)` → `revoked` / `running` / `gone`；`slotStatus(opId)`；宿主 `call` 新增 `op:"cancel_slot"`、`op:"slot_status"`，`acp-link.ts` 加对应调用；
  - 槽结束时宿主上报 `{opId, outcome}`。
- **旧红 → 新绿**：
  - command 槽在跑时 `submit()` 返回 `"queued"`、不调 `io.steer`，下一轮才跑。现状返回 `"steer"`，红。
  - 排队中的 command 槽 `cancelSlot` 后不会开回合（`io.prompt` 不被调用）；现状没有这个方法，红。
  - 正在跑别的回合时 `cancelSlot(本 op)` 回 `revoked`，**不调 `session.cancel`**；现状 abort 只会取消当前回合，红。
  - `op` 槽不和前后 prompt 合并成一轮。
  - 原有 steer、abort（`acp-self-turn.test.ts`）测试保持绿。

### N2 · 核实上游协议 + Codex 压缩完成信号（无依赖，先做）

- **globs**：`src/lib/acp/updates.ts`、`src/lib/acp/session.ts`、`src/lib/acp/host.ts`、`scripts/acp-stub.ts`、`src/lib/acp/stub.ts`、`tests/acp-updates.test.ts`、`tests/acp-compact-stub.test.ts`（新）、`docs/runtimes/codex-acp.md`
- **步骤**：
  1. 在临时目录按 `lib/acp/resolve.ts` 的规则下载 pinned codex-acp 包，读 `dist/index.js`，并参照 app-server 的公开 schema，记下 §1.4 那三件事。只读，不起 app-server，也不登录。
  2. 宿主把核实过的完成信号翻成 `compact_boundary`，上报的语义要和 Pi 的 `_meta.claudestra.compacted` 一致。
  3. 如果上游根本没有可靠的完成信号，宿主改为把「`session/prompt` 返回 + rollout 中出现新的压缩记录」两者都满足才算完成。这时还需要扩 `codex-session.ts`，把这一条追加进 globs。
- **stub**：
  - `/compact` 按指令进入不同模式：`[stub:compact-ok]`、`[stub:compact-fail]`、`[stub:compact-slow]`（等待取消）；
  - 只讲协议、不连模型。
- **旧红 → 新绿**：
  - stub 走 `compact-ok` 时，watcher 应收到 `compact_boundary`。现状收不到，测试为红。
  - `compact-fail` 报 StopFailure，不产生边界。

### N3 · 交接存储 + `save_handoff` 工具（无依赖）

- **globs**：`src/lib/agent-handoff.ts`（新，存储）、`src/lib/compact-tools.ts`（新，`SAVE_HANDOFF_TOOL` 声明 + `saveHandoffTool` 调 bridge，写法同 `lib/fleet-tool.ts`）、`src/channel-server.ts`（工具列表 `:600` 加一项、`:742` dispatch 加一个 `case`）、`src/bridge/handoff-route.ts`（新，按连接认身份）、`src/bridge.ts`（ws 消息分派加一行，同 `:2220` `fleet_*` 的写法）、`tests/agent-handoff.test.ts`（新）、`tests/compact-tools.test.ts`（新）
- **新绿**：
  - 写到 `STATE_DIR/handoff/<名>/HANDOFF.md`，原子写，带 op id 和时间；
  - 不在 registry 的名字拒绝；
  - 名字和连接不符时拒绝；
  - 超过上限（例如 16 KB）拒绝；
  - 不触碰 `~/.claude` 下的任何路径（测试里用临时 HOME 断言）；
  - 工具声明没有路径 / 名字参数；`saveHandoffTool` 把参数原样交 bridge，身份只由连接决定（现状没有这个工具，红）。

### N4 · Codex save-compact 编排器（依赖 N1、N2、N3）

- **globs**：`src/bridge/codex-compact/ops.ts`（新，状态机和落盘）、`src/bridge/codex-compact/run.ts`（新，等安全点 → 保存 → 压缩 → 判定）、`src/bridge/codex-compact/cancel.ts`（新，按 op 取消，§2.4）、`src/bridge/codex-compact/recover.ts`（新，重启续接，§2.5）、`src/bridge/codex-compact/entry.ts`（新，`requestCodexCompact` 统一入口 + 能力闸，§2.6）、`tests/codex-compact-ops.test.ts`（新）、`tests/codex-compact-cancel.test.ts`（新）、`tests/codex-compact-stub.test.ts`（新，临时 stub 集成）
- **新绿**（全部跑在临时 STATE_DIR + stub 上）：
  - 保存失败时不发 `/compact`；
  - 压缩失败时交接文件还在，状态是 `failed: compact`，不报 `done`；
  - 重复受理返回同一个 op id，stub 只收到一次 `/compact`；
  - 安全点在 busy 或有押后条目时等待，不发东西；
  - compact-only：不调 `save_handoff`，直接 compacting；
  - 连续两次 `requestCodexCompact(kind:"compact")` 返回同一 op id，stub 只收到一次 `/compact`；
  - 适配器版本不在核实清单 → `skipped`，stub 什么都没收到；
  - 完成信号到达前结果一直是 `queued`，没有 `done`；
  - 重启续接：`saving` 宿主不认 → `failed: interrupted`、不重放；`saved` 断点（交接已存、未发压缩）重启 → 等安全点后 stub 只收到一次 `/compact`；`saved` 超过 30 分钟 → `failed: interrupted{saved}`、交接还在，再点一次建新 op；`compacting` 宿主还在跑 → 跟到结局，stub 没有收到第二次 `/compact`；
  - 落盘顺序：模拟 `compacting` 写盘失败 → 不发 `/compact`；
  - 取消：waiting 时取消，stub 上正在跑的业务轮不被 cancel、正常结束；command 已排队未开始时取消 → stub 从未收到 `/compact`、状态 `cancelled{compacting}`；完成信号与取消回执竞态 → 以完成信号为准记 `compacted`；
  - 押后队列文件在 op 前后逐字不变。

### N5 · 入口接线（依赖 N4；`request_self_compact` 还依赖 N3 的 `compact-tools.ts`）

- **globs**：`src/lib/fleet-plan.ts`、`src/bridge/fleet/service.ts`、`src/bridge/fleet/runner.ts`、`src/lib/fleet-caller.ts`、`src/bridge/api-slash.ts`、`src/lib/runtime-commands.ts`、`src/lib/compact-tools.ts`（加 `REQUEST_SELF_COMPACT_TOOL` 与调用）、`src/channel-server.ts`（`:600` 列表、`:742` dispatch 各加一项）、`src/bridge/codex-compact/self-route.ts`（新，按连接认出调用方、只能给自己登记）、`src/bridge.ts`（ws 消息分派加一行）、`tests/fleet-plan.test.ts`、`tests/fleet-runner.test.ts`、`tests/fleet-caller.test.ts`、`tests/api-slash.test.ts`、`tests/runtime-commands.test.ts`、`tests/compact-tools.test.ts`
- **改动**：
  - `ccOnly` 改为按动作和运行时判断：`compact` / `save-compact` 支持 `codex` 且 transport 是 acp；`lp-*` 仍只支持 CC。
  - fleet runner 对 Codex ACP 的 `compact` 和 `save-compact` 都只调 `requestCodexCompact`（N4 `entry.ts`），不走发键。执行者在 Codex 下也可以存交接，因为路径按 agent 隔离，不再需要改成 compact；这条差异写进 dryRun 说明。
  - `api-slash.ts`：Codex ACP 的 `/compact`、`/save-compact` 改调 `requestCodexCompact`，回 202 + op id；能力闸不过回 409 + 原因，不发。Pi 的 `/compact` 仍走 `acpSlashPassthrough`。
  - 自压：保持 `INTERRUPTS_SELF` 拒绝，不让 fleet 点名自己。另提供 MCP `request_self_compact`（没有 agent 参数），只登记 op、等安全点，所以不会中断当前工具结果。
- **旧红 → 新绿（被替代的旧断言）**：
  - `fleet-plan` 中「codex 的 compact 报 `运行时不支持（codex）`」改为只对 tmux 版 Codex 成立；
  - `fleet-runner` 对 Codex ACP 的 `compact` 结果是 `queued`，不是 `done`。
- **新绿**：
  - 网页对 Codex ACP 连发两次 `/compact`：两次都回同一个 op id，宿主假件只收到一次 `slash`（现状两次，红）；
  - 适配器未核实：`/compact` 回 409，宿主假件一次都没收到（现状 202，红）；
  - `request_self_compact` 只能登记调用方自己，传任何名字字段都被忽略；peer / external 连接调用被拒。
- **保留**：master 排除、PM 项目范围、peer 斜杠当普通消息、远端只读，这些断言原样保持绿。

### N6 · 网页反馈（依赖 N5，ui 卡，截图由 PM 验收）

- **globs**：
  - bridge：`src/bridge/event-bus.ts`（新事件 `compact_op`）、`src/bridge/local-api/fleet.ts`（加 `GET /fleet/compact-op?agent=`、`POST /fleet/compact-op/cancel`，与 `/fleet/run` 同一个 `canRunFleet` + `agentInScope` 闸）
  - 网页：`web/lib/api/fleet.ts`（`requestCompact` 只把 `done` 当完成、`queued` 返回 op id；新增 `followCompactOps`，订阅 `/events?types=compact_op`，写法同 `followLpEvents`；`cancelCompactOp`）、`web/features/fleet/fleet-panel.tsx`（结果列显示阶段、订阅事件）、`web/features/fleet/fleet-actions.tsx`（op 未终结时压缩按钮置灰并显示「取消压缩」）、`web/features/chat/components/ctx-badge.tsx`、`web/features/chat/components/ctx-warn-banner.tsx`（「存记忆 + Compact」显示阶段，不再在 `queued` 时写成功）
  - 测试：`tests/web-fleet-api.test.ts`、`tests/event-bus.test.ts`、`tests/fleet-routes.test.ts`、`tests/web-stream-shape.test.ts`
- **内容**：显示 op 各阶段，失败时说明是哪一步。取消按钮调 `cancelCompactOp`（按 op 取消，§2.4），**不复用**输入框的停止按钮。
- **旧红 → 新绿**：
  - `requestCompact` 拿到 `queued` 时仍算受理成功（按钮不可再点），但文案是「已受理」并带 op id，不写完成；`web-fleet-api.test.ts:11`「已排队算成」的旧断言按此补文案断言（现状直接显示 bridge detail，红）；
  - `followCompactOps` 只把 `compact_op` 事件交给回调；
  - `/fleet/compact-op/cancel` 对没有 manage 凭据的设备回 403、对 scope 外的 agent 回 403；
  - `compact_op` 事件的形状进 `web-stream-shape` 断言。

### N7 · 文档（随 N5 合并）

- **globs**：`docs/runtimes/codex-acp.md`、`docs/architecture/fleet-ops.md`、本文件
- **内容**：写明 Codex 版的语义差异，并删掉本文中已经落地的「未核实」字样。

## 4. 测试与需要用户原生操作的部分

- **最小真实协议 stub 集成**：只用 `scripts/acp-stub.ts`，配临时 STATE_DIR / HOME（`tests/` 现有的 acp stub 用法）。
  - 覆盖：宿主 ↔ stub 的 `session/prompt("/compact")`、完成和失败信号、`save_handoff` 工具回路、单飞（含网页 `/compact` 连发）、能力闸、按 op 取消（waiting / 已排队 / 竞态）、`saved` 与 `compacting` 断点重启。
  - 不碰真实 Codex、`~/.codex`、`auth.json`，不碰生产 bridge，也不调用模型。
- **需要 owner 原生操作的时机**：N5 合并后，由 owner 在自己的一个 Codex ACP agent 上手动点一次「存交接再压缩」。只有这一步会真正调用 `thread/compact/start` 并消耗模型。执行者和 CI 一律不做。
  - 验收看三点：交接文件落在 `STATE_DIR/handoff/<名>/`；完成卡只在完成信号到达后出现；压缩期间发的一条消息在压缩之后才被处理。
- **在此之前**：任何文档、回包或卡片都不得宣称 Codex 已经支持压缩，也不得宣称 Claude 的 save-compact 技能已经支持 Codex。现状下 fleet 对 Codex 仍然 skip，网页 `/compact` 仍只返回「已受理」。
