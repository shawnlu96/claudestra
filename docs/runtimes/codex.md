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
| 打断 | 按 Esc。空闲的 Codex 收到 C-c 会直接退出（实测 0.8s） |
| 退出 | `/quit`。它会带走 MCP 子进程；强杀则不会，channel-server 会盯着父进程，父进程没了自己退出 |
| fork 后的新 id | `discoverSessionId` 读 pane 子进程（原生 codex）持有的 `~/.codex/thread-writer-locks/<id>.lock`，并排除源 id |
| 历史 / 工具流 | rollout 由 registry 里的 sessionId 定位（`findCodexSessionPath`）。register 帧**不自报** sessionFile，因为 `~/.codex/sessions` 里还有用户自己的私人会话。翻译是有状态的，每个文件一份 `newCodexTranslateState`：code-mode 的 `exec` 按轮丢掉，引导轮整轮丢掉（包括那句 "OK"） |

### waitReady 的判据

- `@claudestra_ready=1`：就绪。
- pane 出现 `already has an active writer`：返回 `occupied`，说明线程被别的进程（另一个 TUI，或 ChatGPT.app 的 app-server）占着写。restart 会据此自动改用 fork 重试。
- pane 出现 `Hooks need review`、`Do you trust`、`Update available` 这三种对话框中的任何一种：返回 `blocked-dialog`，立即失败，**绝不替用户按 Enter**。这三个对话框本来都已经被启动参数关掉了，还弹出来就说明 Codex 版本变了，或者参数没生效，需要人来看。更新框默认高亮的是「Update now」。
- 窗口回到 shell，并且 pane 下已经没有子进程：返回 `exited`。

复用窗口时，beforeLaunch 会先给 pane 拍一个基线，所以上一次启动留在屏幕上的报错不会被重复计数。

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

- `~/.codex/thread-writer-locks/<id>.lock`：用来查活，确认线程确实开在本 TUI 里；也用来发现 fork 后的新 id。见 `lib/codex-thread.ts`。
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

- 单测：`tests/codex-runtime.test.ts` 用注入依赖加假窗口覆盖适配器，`tests/codex-launch.test.ts` 覆盖启动命令，`tests/codex-thread.test.ts` 覆盖投递与查活，`tests/codex-session*.test.ts` 覆盖翻译。
- 端到端：`bun scripts/codex-adapter-e2e.ts --dir <scratch>`。它使用独立的 tmux socket 和一个只绑 127.0.0.1 的假 bridge，走适配器本身，依次验证：引导 → 就绪 → 投递 → reply → Stop → `/quit` → resume 同一线程 → 前言送达 → 上下文还在。会真实消耗 Codex 额度，并在 `~/.codex` 留下一个会话。
