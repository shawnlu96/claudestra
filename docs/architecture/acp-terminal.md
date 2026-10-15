# ACP 终端视图

ACP 宿主（`src/acp-host.ts`）在 agent 的 tmux 窗口里画会话：tmux attach 和网页终端看到的就是它。它只按 **ACP 标准 `session/update` 事件**来画，不为任何 harness 写特例：新接一个 harness，只要适配器把它的事件翻成 ACP 标准，窗口里的元素就全有。全部自研，不依赖第三方 TUI 库。

## 分层

```
适配器（codex-adapter/、pi-adapter/、codex-acp …）     ← harness 的差异只在这一层
   │  ACP 标准 session/update
   ▼
updates.ts   翻成条目（推给 bridge / 网页聊天流，不因视图改变）
   │
transcript.ts   条目 → 段（先脱敏再截断：正文 200 行 / 6000 字、工具成功只报行数、失败留末尾 4 行）
transcript-replay.ts   宿主重启 / 迁移后回放会话文件最近 20 段（同样经 transcript.ts，先脱敏再截断）
   │                                    原始 session/update（同一条，紧跟在它翻出的段后面）
   ▼                                          ▼
tui/screen.ts ── show(段) ───────────── update(更新)
   ├─ blocks.ts    认段的种类（只看段格式），画定稿样子：工具头 / 结果 / 计划 / 收到的消息 / 审批 / 回合分隔
   ├─ message.ts + markdown.ts   正文逐行按 Markdown 排（流式由 transcript-stream.ts 只放整行）
   ├─ live.ts      底栏里正在发生的：在跑的工具（段 + 紧跟的更新按 toolCallId 配对）、思考预览、模型 / 上下文 / 压缩中
   ├─ footer.ts    多行输入框 + 状态栏
   ├─ painter.ts   唯一的写出口：定稿写在底栏上面（进 tmux 滚动记录），底栏擦掉重画
   └─ text.ts      按显示宽度折行 / 截断（中日韩两格、组合 emoji 不拆；断点两边有宽字就地断），每行 ≤ 列数 − 1
tui/guard.ts   任何一次调用抛错 → host.log 记原因、退回 tty-screen.ts 的逐行视图并重放这次调用
```

视图层（`tui/**`、`tty-*.ts`、`transcript*.ts`）不 import 任何 harness 模块，也不按 runtime 名分支——`tests/acp-tui-boundary.test.ts` 钉着；同一串事件按 Pi 和 Codex 的翻译配置喂，输出逐字相同——`tests/acp-tui-screen.test.ts`。

## 用到的标准事件

| 事件 | 画成什么 |
|---|---|
| `agent_message_chunk` | 正文，边收边按 Markdown 排（标题、列表、引用、粗体 / 斜体 / 行内代码 / 链接、带框代码块、表格；表格整张到齐才排，放不下改竖排） |
| `agent_thought_chunk` | 底栏暗色预览最后一整行（半行不显示），正文 / 工具一来就收起；适配器标了 `_meta.claudestra.display` 的整块由 updates.ts 变成 ✻ 段，视图拿紧跟着的这条更新的原文按行重排（`clipThought`：先脱敏，最多 4 行、200 字，截了注明「共 N 行」或只有一行时「共 N 字」），暗色进滚动记录、底栏不再预览 |
| `tool_call` / `tool_call_update` | 在跑时在底栏原地转圈计时，完成 / 失败时连同结果落进滚动记录一次；`kind` 只在名字看不出来时标（Bash 不挂「执行」，other 不标） |
| `plan` | 清单：✓ 完成、▸ 进行中、○ 待办，标题带完成数 |
| `usage_update` | 状态栏「上下文 46%（91k/200k）」 |
| `config_option_update`（及宿主出给 bridge 的 configOptions） | 状态栏模型、effort |
| `compaction_update` | 状态栏「压缩中」，completed / failed / cancelled 结束 |
| `session/request_permission`（宿主出卡时） | 黄框审批块，选项一行一个；输入框里显示作答提示 |

收到的消息（owner / 别的 agent / bridge 注入）由宿主直接显示：青色竖线，首行是来源和时间。回合结束 / 打断 / 失败是一道带时间的满宽分隔线（和输入框的线一样长），后面空一行。
正文、工具组、思考、计划、审批、失败 / 提示之间各空一行（窄屏也留）；一组连着的工具之间不空，任何别的行都结束这一组。

**重启 / 迁移后**：session/resume 不回放历史，宿主在 TTY 上先画一行顶部提示（`ACP 会话 名字 · 线程 前 8 位 · /help 看命令`，不放本机路径，连接日志用 `/log` 看），再从会话文件尾巴（只读末尾 1 MB）回放最近 20 段：前面一行「已接续会话 · 下面是最近 N 条（更早的见网页）」，后面一道「以上是接续前的记录」。找文件、选翻译器按运行时由宿主交进来（session-source.ts），回放模块本身不认运行时。新会话没有文件就不画。

## 给新 harness 接入

只在适配器里做：把 harness 的事件翻成上表的标准事件。工具调用带上 `kind`（ACP 的 ToolKind 枚举）和 `toolCallId`，结束时发 `status: completed | failed`；计划发 `plan`；压缩开始 / 结束发 `compaction_update`（Pi 适配器目前只发 `_meta.claudestra.compacted`，所以 Pi 的状态栏不会显示「压缩中」——留给后续卡：pi-adapter 补发 `compaction_update` 的 in_progress / completed）。视图层不需要改。

## 画法与不变式

- **不设滚动区、不用绝对坐标**：底栏永远紧跟最后一行定稿；写定稿 = 擦掉底栏、写定稿、重画底栏。光标只用 `\r`、`ESC[2K`、`ESC[1A`，tmux attach 和网页终端都认。光标隐藏，输入框里画假光标；退出时还原。
- **不整屏重画历史**：写出去的定稿行之后不再动，往上擦的行数只有底栏那几行（测试按每次写出逐个核）。
- **改窗口宽度**：变窄时 tmux 已把旧底栏折成几行，`tty-status.ts foldsOf` 按 tmux 3.6a 的重排规则算折数（宽字 = 字 + 一个占位格，占位格可单独折到下一行；22 列实测「等」×19 折成 7/7/5、「─」×39 折成 22/17）一起擦掉再按新宽度画。滚动记录里的旧内容由 tmux 自己重排，视图不重画。
- **流式**：transcript-stream.ts 只放整行（半行可能是半个密钥），跨行打码规则用探针压住会变的行；终稿到了只补没显示的部分，对不上就整段重画一次。
- **资源**：定时器每秒调一次 `tick()`，底栏没变不写任何字节（空闲时 0 输出）；只有回合进行中计时 / 转圈每秒变一次。一轮 200 条事件渲染约 10–40 ms。
- **兜底**：stdout 不是 TTY 时宿主照旧一段一行纯文本（`stampTranscript`），不走视图；`CLAUDESTRA_ACP_TUI=0` 直接用逐行视图。

## 输入框键位（沿用逐行视图的规则，`tty-input.ts`）

- 回车发送；粘贴进来的换行（bracketed paste）留在正文里，输入框分行显示，最多 6 行，超出显示末尾并注明上面还有几行。终端不支持粘贴标记时每个回车都发一条（和以前一样）。
- Esc：回合中打断，空闲时清空输入；Ctrl-C：回合中打断，空闲时 2 秒内连按两次退出宿主；Ctrl-U 清空。
- 审批：整行只打 `y` / `n` / 序号再回车作答，别的内容照常当消息发；网页卡片也能答，先到先得。
- `/model`、`/effort`、`/clear`、`/compact`、`/log`（连接日志在哪）、`/help` 是终端命令，其余 `/xxx` 照普通消息发。

## 截图与实测

- `bun run tui-shots <目录>`：在私有 tmux 服务器里跑本脚本的演示模式（同一轮会话夹具 `tests/helpers/acp-tui-session.ts`），无头 Chrome 里的 xterm.js 截图；`before` = 逐行视图，`after` = 新视图。场景 `--views home,busy,restart,perm`（回合结束 / 进行中 / 刚重启 / 审批在等）。拍「改之前的新视图」：把脚本和夹具拷进旧代码树的副本里跑 `--variants after --phase before`。`--pane <目标>` + `TMUX_SOCKET` 截沙箱里已有的 pane。
- 沙箱里 Codex 只能起仓库 stub：正文带 `[stub:showcase]` 会把思考、计划、Markdown、3 次工具调用（1 次失败）各演一遍，配 `[stub:perm]`、`[stub:slow]` 测审批和打断。
