# Codex 运行时

Claudestra 可以把 OpenAI Codex CLI 的交互式会话当作 agent 托管，和 Claude Code、Pi 并列（v2.24+）。
Codex agent 同样有频道、能对话、能重启和收编，历史面板和工具流也能看到它。

```bash
bun src/manager.ts create <name> <dir> [purpose] --runtime codex [--model <codex-model>] [--effort low|medium|high|xhigh]
bun src/manager.ts resume <name> <threadId> [dir] --runtime codex [--fork]
```

Web 端的新建弹窗只在 bridge 报告 Codex 可用时显示这个选项（`GET /api/v1/runtimes`）。
会话列表里每条带有 `manageable` 字段，收编按钮按它显示。

## 它怎么工作

实现集中在 `src/lib/runtimes/codex.ts`，它是一个 `ManagedRuntimeAdapter`；manager 走的是和
另外两种运行时同一条 `launchInWindow` 流程。

| 环节 | 做法 |
|------|------|
| 可用性 | `available()` 按登录 shell 解析 `codex`。npm 装的 node 壳会被换成原生二进制，否则按 pane 找进程、按 pane 杀进程都会落到壳上。然后探测 `codex queue --help`，旧版没有这个子命令，也就没有入站通路。结果缓存 5 分钟 |
| 新建会话 | `prepareSession` 先跑一轮 `codex exec --json`，用来引导出 thread id。原因是新线程在第一轮之前没有 rollout，`codex queue` 会报 `no rollout found`。引导轮**不挂** claudestra MCP 和 hooks，否则引导进程会抢注频道，还会多报一次 Stop |
| 启动命令 | new 和 resume 都用 `codex resume <id>`，fork 用 `codex fork <id>`（`lib/codex-launch.ts` 的 `buildCodexCommand`）。claudestra MCP、Stop/Interrupt hooks、目录信任、`developer_instructions` 全都经 `-c` 内联传入，**不写** `~/.codex/config.toml` |
| 就绪 | channel-server 是 Codex 起的 MCP 子进程，它向 bridge 注册成功后，会给 tmux 窗口写 `@claudestra_ready=1`，和 Pi 扩展用的是同一个标记 |
| 入站 | channel-server 的 `CodexQueueSink` 先查活，确认本 TUI 进程持有该线程的写锁，再调用 `codex queue --thread <id> --message <text>`。消息按 Claude Code 同款 `<channel …>` 包装，并带上 `reply_via` 提示 |
| 回合结束 | `hooks.Stop` 和 `hooks.Interrupt` 都调用 `typing-hook.ts`，再转到 bridge 的 `/hook`。Interrupt 被映射成 StopFailure，因为打断时 Codex 不发 Stop |
| 打断 | 按 Esc，且只该在回合进行中按（`control.interruptOnlyWhenBusy`）。空闲的 Codex 收到 C-c 会直接退出（实测 0.8s） |
| 退出 | 清场 + `/quit`，见下面「退出序列」。`/quit` 会带走 MCP 子进程；强杀则不会，channel-server 会盯着父进程，父进程没了自己退出 |
| fork 后的新 id | `discoverSessionId` 读 pane 子进程（原生 codex）持有的 `~/.codex/thread-writer-locks/<id>.lock`，并排除源 id |
| 历史 / 工具流 | rollout 由 registry 里的 sessionId 定位（`findCodexSessionPath`）。register 帧**不自报** sessionFile，因为 `~/.codex/sessions` 里还有用户自己的私人会话。翻译是有状态的，每个文件一份 `newCodexTranslateState`：code-mode 的 `exec` 按轮丢掉，引导轮整轮丢掉（包括那句 "OK"） |

### waitReady 的判据

- `@claudestra_ready=1`：就绪。
- pane 出现 `already has an active writer`，**并且** pane 下已经没有子进程：返回 `occupied`，说明线程被别的进程（另一个 TUI，或 ChatGPT.app 的 app-server）占着写，codex 打完这句就回到 shell。restart 会据此自动改用 fork 重试。
- pane 出现 `Hooks need review`、`Do you trust`、`Update available` 这三种对话框中的任何一种，**并且**带有对话框结构（`1.` 选项行或 `Press enter to continue`）：返回 `blocked-dialog`，立即失败，**绝不替用户按 Enter**。这三个对话框本来都已经被启动参数关掉了，还弹出来就说明 Codex 版本变了，或者参数没生效，需要人来看。更新框默认高亮的是「Update now」。

以上两条都只看 pane 末尾 15 个非空行。原因是 resume 的 TUI 会先把历史对话渲染进 pane，这一步早于
`@claudestra_ready`。如果看整屏，历史里提到这些字样的会话就会被误判：误判成 blocked-dialog，窗口和
频道会被清理掉；误判成 occupied，会被送去 fork 重试。
- 窗口回到 shell，并且 pane 下已经没有子进程：返回 `exited`。

复用窗口时，beforeLaunch 会先给 pane 拍一个基线，所以上一次启动留在屏幕上的报错不会被重复计数。

### 退出序列（绝不连发 Esc）

manager 的 restart / kill、web 的重启按钮、launcher 自动更新后的重启，全都走
`runtimes/graceful-exit.ts` 的 `gracefulExitWindow`。Claude Code 和 Pi 用默认清场：打断键连发 3 轮
（间隔 800ms），再补一次守卫 Esc。Codex 不能这样做：它的 Esc 连按是 backtrack 手势。空闲时按第一下会
出现「esc again to edit previous message」，第二下会打开历史回溯遮罩（「q to quit … enter to edit
message」），再按就往前翻旧消息。接着键入 `/quit` 时，`q` 会关掉遮罩，剩下的 `uit` + Enter 被当成一轮
用户消息发给模型（0.153.4 实测）。时序再差一点，Enter 会落在遮罩上，变成「编辑并重发旧消息」。

所以 Codex 声明了自己的 `exitPrelude`（`runtimes/codex-exit.ts`），按下面的顺序处理：

1. pane 底部已经是 shell：直接返回，不按任何键。
2. 回溯遮罩开着（底部有 `to edit message`）：按一次 `q` 关掉。**不按 Enter。**
3. 回合在跑（底部有 `esc to interrupt`）：**只按一次** Esc，然后等状态行消失（最多 10s）。
4. 空闲：一个键都不按。

之后键入 `/quit` + Enter。退出阶段如果又看到遮罩，`onExitPane` 只补按一次 `q`，同样不按 Enter；
还是退不出去，就走强杀兜底（C-c / C-c / C-d；空闲的 Codex 收到 C-c 本来就会退出）。

bridge 的打断（Discord 按钮、`/interrupt`、`POST /api/v1/agents/:name/interrupt`）都经
`interruptWindow` 读 `control.interruptOnlyWhenBusy`：回合在跑才按一次 Esc，空闲时一个键都不按
（API 返回 `idle: true`，Discord 回报「当前空闲，无需打断」）——空闲时的 Esc 会把 TUI 停在回溯遮罩里。
Discord 入站消息也不会触发抢占（`preemptOnHumanMessage = false`），消息由 `codex queue` 排到下一轮。

### 权限

只支持 `bypassPermissions`（对应 `--dangerously-bypass-approvals-and-sandbox`）。其余档位在 Codex 里
会弹审批框，而 permission-watcher 认不出 Codex 的界面，没人去点，agent 就会一直卡住。所以这类
配置在 `prepareSession` 或 `buildLaunchCommand` 阶段就直接报错。

## 限制与已知约束

### developer_instructions 只在建线程时生效

职责、project 上下文和频道回复规则是经 `developer_instructions` 注入的。但它**只在 exec 引导建线程的
那一轮**写进上下文：TUI 的 `codex resume` / `codex fork` 即使带了新的 `-c developer_instructions`，
也不会写进去（0.153.4 实测）。因此：

- **重启和收编之后，第一条投递的消息前面会附一段简短前言**（`codexContextPreamble`）。它和
  `developer_instructions` 来自同一个函数 `codexRoleLines`，包含身份、职责、project 名册和回复规则。
  前言以 base64 形式放在 `CLAUDESTRA_CODEX_PREAMBLE` 环境变量里，交给 channel-server；只有投递成功
  才算用掉，失败的话下一条消息再附一次。前言带有 `[claudestra:context]` 标记，历史翻译会把它剥掉，
  只保留后面的 `<channel>` 消息。
- 完整的频道规则很长，只在建线程时出现一次。之后每条入站 `<channel>` 都带有 `reply_via` 属性，
  作为兜底。

### 依赖的 Codex 内部机制

下面几项都不是公开接口，Codex 升级后可能变化。相关解析都写成了纯函数，变了只需要改一处：

- `~/.codex/thread-writer-locks/<id>.lock`：用来查活，确认线程确实开在本 TUI 里；也用来发现 fork 后的新 id。见 `lib/codex-thread.ts`。锁文件名不是我们写的，不像 UUID 的一律不认：既不会写进 registry，也不会让通道切过去。
- TUI 的屏幕文案 `esc to interrupt`（回合在跑）和 `to edit message`（回溯遮罩）：退出清场靠它们判断。文案变了的后果是：该按的一次 Esc 没按，或者遮罩没被关掉，最终由强杀兜底。
- `codex queue`（底层是 `~/.codex/queue_1.sqlite`）：对**没被任何 TUI 加载**的线程，它照样返回成功，消息会存起来，等下次有人 resume 这个线程时再重放。所以投递前一定先查活，线程不在线就不入队，并把原因告诉发消息的人。
- TUI 靠轮询取队列里的消息，从投递到回合开始有秒级延迟。端到端实测中，从推送到收到 reply 大约 15 秒，这里面包含了模型本身的耗时。

### `--dangerously-bypass-hook-trust` 的安全姿态

我们注入的 Stop/Interrupt hooks 需要免审才能生效，否则 hooks 的 Active 为 0，回合结束不会上报。
这个开关会**一并放行**用户级 hooks 和项目目录 `.codex/` 下的 hooks。这和 Claude Code agent 默认
`bypassPermissions`、Pi 默认 `--approve` 属于同一档：托管的 agent 本来就是以用户身份运行的不受限
shell。不要把 Codex agent 指向你不信任的仓库。

### Codex 会自己往 config.toml 追加信任记录

启动参数里用内联表 `projects={"<cwd>"={trust_level="trusted"}}` 声明目录信任，我们自己不写文件。
但 Codex 仍可能往 `~/.codex/config.toml` 追加 `[projects."<cwd>"] trust_level = "trusted"`，端到端
实测时 config.toml 的 sha 确实变了。ChatGPT.app 内置的 app-server 也会并发写这个文件。Claudestra
不回滚这些改动；如果介意，可以定期清理这些记录。

## 验证

- 单测：`tests/codex-runtime.test.ts` 用注入依赖加假窗口覆盖适配器，`tests/codex-exit.test.ts` 钉住退出按键序列（Codex 绝不连发 Esc，CC / Pi 的默认序列不变）以及只看 pane 尾部的就绪判据，`tests/codex-launch.test.ts` 覆盖启动命令，`tests/codex-thread.test.ts` 覆盖投递与查活，`tests/codex-session*.test.ts` 覆盖翻译。
- 端到端：`bun scripts/codex-adapter-e2e.ts --dir <scratch>`。它使用独立的 tmux socket 和一个只绑 127.0.0.1 的假 bridge，走适配器本身，依次验证：引导 → 就绪 → 投递 → reply → Stop → 空闲退出 → resume 同一线程 → 前言送达 → 上下文还在 → 回合进行中退出。两次退出都调用生产的 `gracefulExitWindow`，并断言三件事：回到 shell、不超过 20s（没有走到强杀）、rollout 里没有多出一轮。会真实消耗 Codex 额度，并在 `~/.codex` 留下一个会话。
