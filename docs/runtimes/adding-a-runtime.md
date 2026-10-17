# 加一个运行时

一个运行时 = **一份描述 + 注册表里一行**。描述写在 `src/lib/runtimes/` 下它自己的文件里，登记在 `src/lib/runtimes/index.ts` 的 `RUNTIMES`。
宿主、就绪闸、运行时目录、transport 选择、bridge 侧策略都只读描述里的字段，不按 id 分支。
现在登记了四个：claude-code（tmux）、pi（tmux + acp）、codex（tmux + acp）、opencode（只有 acp）。

- 契约类型：`src/lib/runtimes/contract.ts`（ACP 段）、`src/lib/runtimes/types.ts`（会话来源、生命周期、`RuntimeEntry`）。
- 防腐：guard 的 `pattern:runtime-literal` 统计 `src/lib/runtimes/` 以外按运行时 id 字面量分支的写法
  （`runtime === "x"` / 模板字面量、`rt.id !== "x"`、`switch (runtime)`、`managedFor("x", …)` 等），**按文件计数**（`pattern:runtime-literal:<文件>`），
  每个文件只许减少，新文件出现即红；搬到别的文件也算新增。新代码要区分运行时，就往描述里加字段。
- 证明契约够用的测试：`tests/runtime-contract-fake.test.ts` 只在测试里登记一个假 ACP 运行时，没改 runtimes/ 以外的文件，
  就能起宿主、收发消息、打断，运行时目录也能列出来。

## 注册表的一行（`RuntimeEntry`）

| 字段 | 说明 |
|---|---|
| `source` | 会话来源（`SessionSourceAdapter`）：扫会话、定位文件、把一行翻成 Claude Code 形状。能以 tmux 起的运行时直接给 `ManagedRuntimeAdapter` |
| `acp?` | ACP 段（`AcpRuntimeSpec`）。声明了才能走 `transport=acp`；`source` 是只读来源、或就是 `acp.managed`（OpenCode）时，这个运行时**只能**走 acp |
| `listModels?` | 模型列表入口（签名已定，实现在 OCR-3）。OpenCode 的清单暂时还在 `runtimes/catalog.ts` 的 `MODEL_LISTS`：`lib/opencode-models.ts` 经 `claude-settings-runtime.ts` 回头 import 注册表，挂到这一行会成环，OCR-3 拆环后挪过来 |

`RUNTIMES` 的顺序有意义：`sourceIdForPath` 按这个顺序问「这条路径是不是你的」。

## A. 走 ACP 的运行时（新运行时缺省走这条）

在 `src/lib/runtimes/<id>-acp.ts`（可以拆出 `<id>-acp-host.ts`）里提供：

1. **会话来源** `SessionSourceAdapter`（历史面板、会话列表、归档靠它）：`scanSessions` / `sessionPath` / `findSessionById` /
   `listSessionsForCwd` / `ownsPath` / `sessionIdFromPath` / `translateLine`；行格式要跨行上下文的，实现 `newTranslator`。
2. **宿主描述** `AcpHostRuntime`（在 `src/acp-host.ts` 进程里用）：
   - `agentCommand(env, bunBin, clean)`：起哪个适配器；出借 worker（`clean`）不支持就返回 `{ error }`；
   - `adapterEnv(spec)`：适配器的环境；`mcpServers(spec)`：交给 `session/new|resume` 的 MCP server（channel-server 走配置文件的就给 `[]`）；
   - `compactFrom`：压缩完成认哪个来源——`claudestra-meta`（Pi 适配器的中性记号）、`compaction-update`（ACP 的 compaction_update，Codex）、
     `command-end`（什么都不发，宿主发的 /compact 那一轮结束就算，OpenCode）；
   - `translator?(mcpName)`：其余翻译差异（`deferPendingTools` 工具调用等 in_progress 再起头、`mcpUnderscoreServers` 把 `<mcp>_<tool>` 改名），
     `lib/acp/updates.ts` 按选项翻；以后的差异也加在这里；
   - `enforceLaunch?(session, model)`：接上会话后自己施加并核对启动配置（OpenCode：不认的模型会静默回落到免费缺省，不过就拒起）；
   - `label` / `logLabel`：卡片与日志里的称呼；`clearBootstrap?`：`/clear` 后的新会话要先跑的一轮。
3. **就绪闸** `ready(autoInstall, deps)`：`transport` 命令、建 agent、doctor 用同一个判据；`autoInstall` 时可以顺手装缺的依赖。
4. 可选：`agentProblem(info, env)` 按 agent 配置再拦一道；`catalogProbe()` 让运行时目录先跑它，过了就算可用。
5. **生命周期**：用 `genericAcpRuntime({ source, host, ready, isValidSessionId, launchEnv? })`（`src/lib/runtimes/acp-generic.ts`）
   拼出 `AcpRuntimeSpec`：new / fork 先起一个短命适配器 `session/new`（或 `session/fork`）拿服务端给的会话 id，常驻宿主再按它接上；
   窗口里跑 ACP 宿主，就绪标记是 `@claudestra_ready`，退出时给宿主发 SIGTERM，registry 记 `transport=acp`。
   启动命令里再要加的环境变量放在 `launchEnv`（引导进程和常驻宿主用同一份）。有特殊启动流程（Codex 的引导轮、Pi 的能力档、
   OpenCode 的模型必填 + 拒建删空会话）的才自己写 `ManagedRuntimeAdapter`（参考 `runtimes/opencode-acp.ts`）。
   会话文件不是现成落盘的（OpenCode 在 SQLite 里），来源实现 `freshArchivePath`，归档先要一份最新的。
6. **登记**：`RUNTIMES` 加一行 `{ source, acp: <ID>_ACP }`。

要补的测试：

- 启动命令逐字钉住（参考 `tests/pi-acp-runtime.test.ts`、`tests/codex-acp-adapter.test.ts`）；
- 宿主描述：`adapterEnv` / `mcpServers` 不泄露回环代理 token（参考 `tests/acp-host-runtime.test.ts`）；
- 翻译差异：`tests/acp-updates*.test.ts` 加这个运行时的 `session/update` 样本；
- 适配器真起一次：照 `tests/runtime-contract-fake.test.ts` 的宿主链，把 stub 换成真适配器的录制样本或 stub 模式。

## B. tmux 版运行时（窗口里跑运行时自己的 TUI，比如 Claude Code、tmux 版 Pi）

在 `src/lib/runtimes/<id>.ts` 实现 `ManagedRuntimeAdapter`：

- `control: RuntimeControl`：打断键、人类消息到达时要不要抢占、忙闲信号从哪来、模型怎么生效、能不能套用 CC 的屏幕判据、插话方式；
- 启动：`available` / `prepareSession?` / `buildLaunchCommand` / `beforeLaunch?` / `waitReady`；
- 退出：`exitCommand` / `exitPrelude?` / `onExitPane?`；fork：`forkBaseline?` / `discoverSessionId?`；
- registry：`registryFields` / `noteTag` / `callerCred?`；`inbound` / `turnEnd` 只是声明，给 doctor 和前端展示用。

要补的测试：`tests/runtime-lifecycle.test.ts`（假窗口跑就绪 / 退出）、`tests/runtimes-registry.test.ts`（注册表）、`tests/runtime-bridge-gates.test.ts`（bridge 侧策略）。
既有 tmux 版又有 ACP 版：登记一行 `{ source: <tmux 适配器>, acp: <ACP 段> }`，`transportsOf` 给 `["tmux", "acp"]`。

## 留下来的按 id 分支（迁不进描述，新运行时也不用碰）

基线 182 处（86 个文件，按文件登记；合入 main 时如实登记了 OpenCode / Codex 只读档带进来的分支），guard 只许它减少。按类别分：

- **Codex / Pi 自己的迁移与回退**：`manager/acp-lifecycle.ts`（Pi 在沙箱里跳过探测、Pi 的 ACP 起不来同窗口回退 tmux、Pi 不支持 `--fork`、
  adopt 时 Pi 选 transport、Codex 重启时缺适配器暂退 tmux、沙箱里不起两家的 TUI）、`manager/acp-migration.ts`、`manager/pi-acp-migration.ts`、
  `manager/acp-adapter.ts`、`manager/acp-retire.ts`、`lib/acp/migration.ts`。这些都是老 agent 从 tmux 迁到 acp 的包袱；只有 ACP 版的运行时
  在入口就分流了（`transportsOf` 没有 tmux），走不到这些分支。
- **Codex 只读档**（`lib/codex-readonly.ts`，合入 main 时带进来）：只读模式是 Codex 自研适配器的预设，别的运行时没有这一档。
- **Codex 的适配器选择与版本对账**：`src/acp-host.ts`（起之前按协议判自研 / 上游、每次起适配器前记运行版本）、`lib/codex-auto-update.ts`、
  `bridge/codex-turn-failure.ts`、`lib/doctor-acp.ts`（codex-acp 配套、Pi 版本两组体检）。都绑着 Codex / Pi 的外部可执行文件。
- **两家的命令表与设置入口**：`lib/runtime-commands.ts`（Pi / Codex 自己的斜杠命令）、`bridge/api-slash.ts`（Pi 的 `/new`、
  Codex 的 `save-compact` / `save-clear`、ACP 版 Pi 的内置命令）、`bridge/runtime-settings-routes.ts`（`/agents/:a/pi-settings`、`codex-settings` 这两个 URL）。
  没有命令表的运行时回落到普通消息 / CC 技能，不报错；模型 / 推理强度的通用入口由 OCR-3 的 `listModels` 接上。
- **版本更新提示**：`lib/update-hints.ts`（CC / Pi / Codex 各自的版本源和升级按钮）。没声明的运行时不出提示。
- **Claude Code 专属**（TUI 屏幕判据、`/status` 用量、技能注册表、CC 会话文件）：`bridge/preempt.ts`、`lib/turn-cuts.ts`、`bridge/turn-cuts.ts`、
  `lib/skill-library.ts`、`lib/agent-skills.ts`、`lib/launcher-restore-gate.ts`、`lib/session-archive.ts`、`lib/worker-session.ts`、`lib/display-model.ts` 等。
  它们问的是「是不是 Claude Code」。
- **OpenCode 带进来的（OCR-4）**，逐条：
  - 已挪进描述：`bridge/api-slash.ts`（不在命令表里的 `/xxx` 落回普通消息：改成「Codex 或任何 ACP 会话（ACP 版 Pi 另有处理）」）、
    `lib/display-model.ts`（不显示推理强度：改读适配器的 `noEffort`）、`lib/launcher-restore-gate.ts`（hook 报回合结束的运行时：改成「不是 Claude Code」）、
    `lib/session-archive.ts`（归档前等一次导出：改成来源的 `freshArchivePath`）、宿主描述（`runtimes/opencode-acp-host.ts`）、`manager/acp-lifecycle.ts`（只走 ACP / 就绪闸）。
  - 留下：`lib/registry.ts` `agentRuntime()`（见下一条缺口）、`lib/agent-skills.ts` / `manager/skills.ts` / `lib/skill-library.ts`（技能开关按运行时的技能目录，
    OpenCode 不支持按 agent 启停）、`lib/runtime-commands.ts`（OpenCode 自己的命令表，和 Pi / Codex 的一样按运行时）、`lib/sandbox.ts`
    （沙箱放行哪些运行时是安全决定，新运行时缺省拒，要逐个核过再加）、`lib/session-archive.ts` 找不到源时的提示文字、web 的新建弹窗。
- **已知缺口：`lib/registry.ts` 的 `agentRuntime()`** 把 pi / codex / opencode 以外的 runtime 一律折成 `claude-code`（`AgentRuntime` 是联合类型，
  `tests/pi-launch.test.ts` 钉住「未知值走老路」），经它判断的调用方会把新运行时当成 Claude Code：上下文边界面板（`bridge/ctx-boundary.ts` 的显示部分；
  自动压缩先看 `transport === "acp"`，不受影响）、额度闸暂停（`bridge.ts` wallPaused）、manager 的花名册、技能开关。归档已改成不经它（`lib/session-archive.ts`）。
  根治要让它查注册表，但 `registry.ts` 在 runtimes/ 的 import 图里，直接引注册表会成环；下一个运行时接进来时先拆这个环。
- **调度器 / 台账的模型家族**（`claude` / `codex` 审查员族、出借池的 runtime 槽位）：`lib/scheduler-*`、`lib/recovery-*`、`lib/card-role-definitions.ts`、`lib/lend-return-local.ts`、
  `bridge/fleet/` 等。这里的「runtime」是审查族 / 槽位的概念，不是 agent 运行时，不归这份契约管。
- **web/**：新建 agent 弹窗的运行时下拉和说明文字、运行时徽标、技能设置页都按 id 写死。后端的 `GET /api/v1/runtimes`
  （`runtimes/catalog.ts`）会列出新运行时，但网页下拉只认 pi / codex / opencode，徽标认不出时什么都不画。要在网页上能选新运行时、显示徽标，
  得单独改 web（本卡不改网页 UI）；API / CLI 建 agent 不受影响。

以后要把上面某一类收进描述，就在 `AcpRuntimeSpec` / `RuntimeControl` 上加字段，迁完一处 baseline 跟着降。
