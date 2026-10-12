# OSC 7501 程序状态协议：tmux 下可行性实验 + 接入设计（PST-1 设计稿）

状态：**只是设计稿**。本稿不改任何生产代码、不开任何开关；实现卡等本稿审过、owner 选定方案后再加进 feature。

## 0. 出处与环境

- 规范：<https://www.superlogical.com/rex/docs/build/program-status>（发布说明 <https://mitchellh.com/writing/program-status-osc7501>）。
  本稿只引用要点，不复制全文。
- tmux 上游：<https://github.com/tmux/tmux/issues/5713>（2026-10-09 开，Open，项目看板状态 Waiting；维护者认为为时尚早，
  要等更多终端和程序采用，并指出 pane 标题、OSC 9 进度、OSC 133 已覆盖类似需求）。
- 实验环境：Claude Code **2.1.296**（native 安装）、Pi **1.1.0**（`@earendil-works/pi-coding-agent`）、tmux **3.6a**、macOS。
- 实验一律在私有 tmux socket（`-L pst1exp`，`-f /dev/null`）里做，被测程序用 `env -i` + 隔离的 HOME / TMPDIR 启动（无凭据、
  无用户 hooks / MCP），**没碰**生产 `master.sock`、registry、台账。唯一读生产数据的一次是只读看本执行者自己的
  `~/.claude/sessions/<pid>.json`（§3.4）。
- 实验脚本与原始输出：`~/.claude-orchestrator/ledger/reviews/PST-1-evidence/`（不进仓库）。下文贴的是其中的原始输出。

### 0.1 规范要点（本稿用到的）

- 上报 `ESC ] 7501 ; key=value(:key=value)* ST`（ST = `ESC \` 或 BEL），整条 ≤ 4096 字节。键：`state`（必填：idle / working /
  done / blocked / error，外加 `clear`）、`id`（子记录路径）、`kind`（blocked 专用：permission / question / auth）、
  `progress`（0–100）、`app`、`title` / `msg`（base64 UTF-8，解码后**不得含控制字符**，含换行和 Tab）。
- 探测：程序发 `OSC 7501 ; ? ST`，支持的终端回 `?`；程序紧跟一个 DA1（`CSI c`），**DA1 的回复先到 = 不支持**。规范也允许
  不探测直接发。
- 记录按「终端」（窗口 / 标签 / 分屏 / pane）各存一份；每份上报整条替换同 `id` 的记录；没有心跳。进程退出或 OSC 133 `A`
  时终端必须丢弃 working / blocked；done / error 留到终端自己决定清。
- 非法上报：state 缺失或不认识、超任一长度限制、base64 解不开、解码后含控制字符 → **整条丢弃**，不应用其中任何内容。
  文本不得当 markup 解释，显示时要中和不可见格式字符。
- 终端唯一回给程序的数据是探测回复：**记录本身没有读取接口**。所以 Claudestra 想拿到状态，必须站在字节流上。

## 1. 已知事实复核

| PM 列的事实 | 复核结论 | 证据 |
|---|---|---|
| CC 2.1.296 支持 7501 | 成立。`programStatus` 能力初始为 `{likely:false, source:"not asked yet"}`，只有 `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` 或 bg worker（`CLAUDE_CODE_SESSION_KIND=bg`）直接定为 false；**不看 `TMUX`** | 二进制反查，见 §1.1 |
| 没有强制开启的环境变量 | 成立（CC 侧）。Pi 有：`PI_PROGRAM_STATUS=1` 跳过探测直接发、`=0` 关 | Pi `pi-tui/dist/terminal.js`、`docs/terminal-setup.md` |
| tmux 回 DA1 不回 7501，未知 OSC 直接丢 | 成立（3.6a 实测） | §2.1 实验 1；tmux `-vv` 日志：`input_exit_osc: "7501;state=idle:app=demo" (end ST)` / `input_exit_osc: unknown '7501'` |
| 所以 CC 在 tmux 里判不支持、根本不发 | 成立 | §2.3 实验 3 对照组 |
| Pi 也要先确认终端支持 | 成立，但可用 `PI_PROGRAM_STATUS=1` 绕过 | §2.4 |

### 1.1 Claude Code 2.1.296 的实现（反查要点）

- 探测在 raw mode 第一次打开后的 `setImmediate` 里发：XTVERSION（`CSI > 0 q`）、可能的 `CSI ? u`、`OSC 7501 ; ? BEL` 与一个
  flush（DA1）并发；7501 的匹配器只认 `osc` 且数据以 `?` 开头。7501 回复先到 → `answer("programStatus", true, "probe: OSC 7501 reply")`；
  DA1 先到 → `answer(..., false, "probe: no reply to OSC 7501 ; ?")`。一旦定下就不再改（`answer` 对已定的返回 false），
  2000 ms 截止后未答也按 false。**不落盘**，每次启动重新探测。
- 主记录由界面状态映射（`rve`）：
  - 回合在跑，或空闲但有排队消息 → `working`（msg = 任务摘要，progress = 任务列表完成比例）；
  - 等用户 → `blocked`，kind 映射：permission prompt / sandbox request / worker request / goal proposal → `permission`，
    input needed → `question`，dialog open → 不带 kind；msg = 弹窗文字（如权限请求描述）；
  - 上一回合 completed → `done`；从未开始或被打断（stopped）→ `idle`；
  - 回合出错 → `error`；错误属于 authentication_failed / oauth_org_not_allowed / cloud_credential_error 且之后没重新登录 → `blocked` + `kind=auth`。
- 子记录：后台 subagent 各一条（`id` = 规整后的 agent id，`title` = 描述，working / blocked），最多 32 条；消失时发
  `state=clear:id=<id>`。
- 只在变化时发；退出时（restoreTerminalModes）补一条 `state=clear`。msg 上限 2048、title 192 字节，发前把控制字符换成空格。
- 另有一条**不经终端**的状态出口：CC 把 `status`（busy / idle / waiting / shell）和 `waitingFor`（permission prompt / input needed /
  dialog open …）写进 `~/.claude/sessions/<pid>.json`，与 7501 的 blocked 映射同源（同一个 `blockedOn`）。见 §3.4。

## 2. 实验：在 tmux 里拿到上报

### 2.1 实验 1 / 2：探测时序（谁先到）

`probe.py` 模拟 CC：同一次 write 发 `OSC 7501 ; ? ST` + XTVERSION + DA1，raw 模式下记录回复到达顺序（脚本 `run1.sh`）。

裸 tmux（`out1-plain.txt`）：

```
0.18ms b'\x1bP>|tmux 3.6a\x1b\\\x1b[?1;2;4c'
7501_reply_at=-1 da1_at=15 verdict=NOT_SUPPORTED
```

经 pty 中转（方案 a，`out2-relay.txt` / `relay-probe.jsonl`）：

```
0.36ms b'\x1b]7501;?\x1b\\'
0.88ms b'\x1bP>|tmux 3.6a\x1b\\\x1b[?1;2;4c'
7501_reply_at=1 da1_at=25 verdict=SUPPORTED
{"ev": "probe_answered", "raw": "b'\\x1b]7501;?\\x1b\\\\'", ...}
```

结论：tmux 在同一次读里就回了 XTVERSION + DA1（< 1 ms）；中转在看到探测的那一刻往子 pty 写回复，比 tmux 的 DA1 早约 0.5 ms 到达，
程序判为支持。

### 2.2 方案 (b)：`pipe-pane -O` 收 + `send-keys -H` 抢答（`run2.sh`）

`pipewatch.py` 挂在 `pipe-pane -O` 上，看到探测就 `tmux send-keys -H` 写回复：

```
0.86ms b'\x1bP>|tmux 3.6a\x1b\\\x1b[?1;2;4c'
6.68ms b'\x1b]7501;?\x1b\\'
7501_reply_at=25 da1_at=15 verdict=NOT_SUPPORTED
{"ev": "saw_probe_sent_reply", "lag_ms": 6.17}
```

DA1 在 tmux 解析输出时同步回出，外部进程再快也是毫秒级（实测 6–26 ms），**抢答必败**。但「收」是可行的：程序直接发的上报
在 `pipe-pane -O` 里原样可见（tmux 自己随后丢弃）：

```
{"ev": "report_seen", "raw": "b'state=idle:app=demo'"}
```

### 2.3 实验 3：Claude Code 2.1.296 在方案 (a) 下真的发了（`run3.sh relay`）

隔离 HOME（预置 `hasCompletedOnboarding` 与工作目录信任，未登录），CC 经中转跑在私有 tmux 里；之后用 `send-keys -l hello` + `Enter`
注入一条消息、`resize-window` 改尺寸、两次 `C-c` 退出。中转日志 `cc-relay.jsonl` 原样：

```
{"ev": "probe_answered", "raw": "b'\\x1b]7501;?\\x07'", "t": 1791802967.173}
{"ev": "report", "raw": "b'state=idle:app=claude-code'", "fields": {"state": "idle", "app": "claude-code"}, "t": 1791802967.198}
{"ev": "report", "raw": "b'state=working:app=claude-code'", "fields": {...}, "t": 1791802976.125}
{"ev": "report", "raw": "b'state=blocked:app=claude-code:kind=auth:msg=Tm90IGxvZ2dlZCBpbiDCtyBQbGVhc2UgcnVuIC9sb2dpbg=='",
 "fields": {"state": "blocked", "app": "claude-code", "kind": "auth", "msg": "Not logged in · Please run /login"}, "t": 1791802976.163}
{"ev": "winch", "t": 1791802982.629}
{"ev": "report", "raw": "b'state=clear'", "fields": {"state": "clear"}, "t": 1791802984.909}
{"ev": "child_exit", "status": 0, "t": 1791802985.299}
```

- CC 的探测用 BEL 结尾（`\x1b]7501;?\x07`），回复后 25 ms 内发出第一条 `idle`。
- 注入的消息让它进 `working`，未登录报错转 `blocked/auth`（msg 是 base64 的「Not logged in · Please run /login」）。
- 退出时自己发 `state=clear`。
- `send-keys` 注入、`C-c`、resize（120×40 → 90×30，画面横线随之变为 90 列，`ev-cc-relay-pane.txt`）都正常。

对照组（`run3.sh plain`：裸 tmux + 方案 b 的抢答）：`cc-plain.jsonl` 只有一行 `{"ev": "saw_probe_sent_reply", "lag_ms": 26.42}`，
**全程没有任何上报**。

未覆盖：没有凭据，抓不到 `blocked/permission`、`blocked/question`、`done`、子记录的实机字节；这些按 §1.1 的反查结果写，留给实现卡在
沙箱里用真实会话补测。

### 2.4 实验 4：Pi 1.1.0（`run4.sh`）

- piA：裸 tmux + `PI_PROGRAM_STATUS=1` + `pipe-pane -O` 收：`{"ev": "report_seen", "raw": "b'state=idle:app=pi'"}`。
- piB：pty 中转、不设覆盖：`probe_answered`（ST 结尾）后 3 ms 收到 `state=idle:app=pi`。

Pi 的 working / done / error / blocked（只覆盖扩展对话框和登录，没有权限弹窗）由它的 reporter 按 agent 事件发。Pi 本来就由
Claudestra 扩展（`src/pi/claudestra-extension.ts`）按事件上报忙闲，7501 对 Pi 是锦上添花。

### 2.5 实验 5 / 6：解析健壮性（中转原型）

畸形 / 恶意上报（`badreports.sh` → `bad.jsonl`）：

```
report_rejected  state=working:msg=<b64 "ok\x1b[31mred">          (bad: msg 含 ESC)
report_rejected  state=blocked:kind=question:msg=<b64 "line1\nline2">  (bad: msg 含换行)
report_rejected  state=pwned                                       (state 不认识)
report_rejected  state=done:msg=@@notbase64@@                      (base64 解不开)
report           state=done  msg="All good <b>x</b>"                (合法；尖括号只是文本)
```

拆包（`split.sh` → `split.jsonl`）：上报被拆成三次 write（`\x1b]75` / `01;state=work` / `ing\x1b\\`），中间夹普通文本和一个
OSC 2 标题。最终版中转正确拼回 `state=working`，画面只剩 `beforeafter`，标题照常透传到 tmux（`pane_title=my-title`）。

> 原型第一版在这里出过错：半截前缀等 50 ms 没下文就放行，后半截随之绕过解析、整条上报漏给 tmux 被丢。最终版改为**半截
> 前缀一律等下一块再判**（程序总会把转义序列写完）。实现卡要把这条写成单测。

## 3. 各方案评估

### 3.1 方案 (a)：agent 进程与 tmux 之间加一层 pty 中转 —— 可行

做法：启动命令从 `claude …` 变成 `<relay> claude …`。中转开一个新 pty 跑子进程，自己的 stdin/stdout 接 tmux pane：
输入原样转给子进程；输出逐字节扫描 `ESC ] 7501 ;`，探测立刻回 `OSC 7501 ; ? ST`、上报按规范校验后交给 bridge，二者都不往 tmux
透传（tmux 本来也丢）；其余字节原样透传。SIGWINCH 把 pane 尺寸同步给子 pty。子进程退出则中转带同样状态退出，并补一条「清空」。

| 影响面 | 结论 | 依据 |
|---|---|---|
| 按键输入 / `send-keys`（含 `-l`、Enter、C-c） | 无影响，字节原样过 | 实验 3 |
| 窗口尺寸 | 需中转转发 SIGWINCH；做了就正常 | 实验 3 resize；Bun 实现注意 `Bun.Terminal` resize 后要手动给子进程发 SIGWINCH（`src/bridge/web-terminal.ts` 头注释） |
| copy-mode、`capture-pane`、所有画面判据 | 无影响：tmux 看到的输出除 7501 外逐字节相同，copy-mode 是 tmux 自己的 | 实验 3 / 6 |
| web 终端（`tmux attach` 的 PTY） | 无影响，中转在 pane 里面 | 拓扑推导 |
| `#{pane_current_command}` | **会变**：从 `claude` / 版本号变成中转的进程名 | `src/bridge/ctx-boundary-inject.ts` 的 `CC_COMMAND_RE` 会判 `notCc` 拒绝注入，必须同步改；`src/lib/lend-pane-archive.ts` 只记录 |
| 进程树多一层 | 按祖先链 / 子树判的都不受影响；「有子进程 = 活着」把中转算作子进程，因此中转必须随子进程退出 | `cc-sessions.ts`、`worker-liveness.ts`、`agent-liveness.ts`、`tmux-helper.ts windowHasChildProcess` |
| 杀进程救援（`windowChildPids` → kill） | 杀到中转 → 子 pty 挂断 → CC 收 SIGHUP 退出；效果与现在等价 | `src/manager.ts`、`src/manager/acp-lifecycle.ts` |
| 忙闲判定 | 现有判据不受影响；新信号作为额外输入（§4） | — |
| 延迟 / 资源 | 每块输出多一次拷贝（探测应答 0.36 ms）；每个 agent 多一个常驻进程 | 实验 1；Bun 实现每个约几十 MB 常驻内存，在意可换编译型小程序 |
| 失败退化 | 中转起不来 → 启动脚本直接 `exec` 原命令（等于现状）；探测没被答 → CC 照旧判不支持、不发（等于现状）；中转中途崩溃 → 子进程随 pty 挂断退出，launcher 按现有路径重启 | 设计要求，实现卡验证 |

风险：中转是新的单点——它崩了 agent 就跟着退出。缓解：中转逻辑极小、不做任何网络 I/O（只写本地文件，§4.1）；按 agent 开关、
默认关、灰度；出事一键关回现状。

### 3.2 方案 (b)：`tmux pipe-pane -O` 抓原始输出 —— 只解决「收」

- 收：可行（实验 2 `pipe-report.jsonl`）。
- 探测：不可行（抢答必败，实验 2）。CC 没有强制开关，于是 **对 CC 无效**（实验 3 对照组）。
- 对 Pi：`PI_PROGRAM_STATUS=1` + `pipe-pane -O` 就够（实验 4 piA），不改进程拓扑。
- 影响：每个 pane 一条 pipe-pane 只能挂一个命令（与将来别的用途抢）；tmux server 重启或窗口重建后要重新挂；对按键、尺寸、
  copy-mode、`pane_current_command` 都无影响；失败即「收不到」= 现状。
- 若 CC 将来加类似 `PI_PROGRAM_STATUS` 的强制开关（可向上游提需求，是否提由 owner 定），(b) 就能覆盖 CC 而不需要中转。

### 3.3 方案 (c)：给 tmux 打补丁 / 等上游 —— 不推荐

- 现状：tmux 3.6a 丢弃 7501（`tmux-vv-osc.txt`），上游 #5713 Waiting，维护者明确不急。
- 就算 tmux 支持了，按规范「记录没有读取接口」，Claudestra 仍拿不到，除非 tmux 额外提供 format（类似 `#{pane_program_status}`）
  或 hook，这超出 #5713 的范围。
- 自维护 tmux 分支：要跟 Homebrew 升级、要给所有用户装，代价远大于中转。本卡没有做补丁原型。
- 结论：只跟踪上游，不投入。

### 3.4 方案 (d)：其它

**(d1) 读 CC 的会话 PID 文件状态 —— 可行，且不碰终端。**
CC 把 `status` / `waitingFor` / `statusUpdatedAt` 写进 `~/.claude/sessions/<pid>.json`，与 7501 的主记录同源（同一个 `blockedOn`
映射：permission prompt / input needed / dialog open）。Claudestra 已经在读这个文件（`src/lib/cc-sessions.ts` 解析了 `status`），
但目前没用于忙闲。

- 证据：只读看本执行者自己的会话文件（执行本卡期间）：
  `{'kind': 'interactive', 'status': 'busy', 'waitingFor': None, 'statusUpdatedAt': 1791802294229, 'tmux': 'master:@3939.%3939', 'version': '2.1.296'}`
  ——`statusUpdatedAt` 正是收到开工单的时刻；同机其它会话分别是 busy / idle。隔离实验（`pidpoll.py` → `ev-pidfile.jsonl`）
  抓到启动后的 `idle`；未登录时那次回合不到 50 ms 就结束，busy 没采到。
- 比 7501 少的：没有 done / error / auth 的区分、没有 msg、没有子记录。
- 比 7501 多的：不改启动命令和进程树；文件带 `tmux` 字段（pane 定位）和 pid，归属清楚；bridge 重启后直接可读。
- 风险：这是 CC 的内部文件格式、没有承诺（7501 是公开协议）。实现要「认不出就当没有」，并把格式探针接进 doctor。

**(d2) 其它想过但否掉的**：在 tmux 外层换成我们自己托管的 PTY（等于重写 tmux 拓扑，代价最大）；`allow-passthrough`（CC 不会把
7501 包成 DCS passthrough）；控制模式 `-CC`（同样不转发未知 OSC）。

## 4. 推荐方案与备选

**推荐：两步走。**

1. **先做 (d1)**：CC agent 的忙闲 / 等人以 PID 文件的 `status` + `waitingFor` 为准（新鲜度看 `statusUpdatedAt`、进程存活看 pid），
   画面判据退为兜底。零拓扑变化，失败即退回现状。
2. **再做 (a)**：pty 中转作为「OSC 7501 支持」本体，按 agent 开关、默认关、灰度。它补上 (d1) 没有的 done / error / auth、
   msg 和子记录，也给 Pi 和将来别的程序一条统一入口。上线后 (a) 与 (d1) 互相校验，不一致只记日志、按 §5.2 的优先级取值。

**备选**：只做 (a)（若 owner 只要公开协议、不想依赖 CC 内部文件）；Pi 单独用 (b) + `PI_PROGRAM_STATUS=1`（不需要中转）。
(c) 只跟踪。

### 4.1 状态怎么交给 bridge

中转（或 PID 文件读取方）不连 bridge，只写一份每 agent 一个的状态文件（如 `~/.claude-orchestrator/program-status/<agent>.json`，
tmp + rename 原子写，内容 = 校验后的根记录 + 子记录 + 收到时间 + 中转 pid）。bridge 按需读（判忙时）并用文件监听推 web。
理由：bridge 重启不丢、中转没有网络面、规范没有心跳，用「中转 pid 还活着 + 文件时间」判新鲜。

### 4.2 回退方式

- 开关：agent 设置里一项（默认关）+ 全局急停环境变量；关掉后下一次启动即回到裸 `claude …`。
- 运行中：状态文件缺失 / 过期 / 中转已死 → 判据自动回到现有 hook + 画面那一套（下表「保留兜底」全部还在）。
- 中转自身：起不来就 `exec` 原命令。

## 5. 拿到状态后接到哪里

### 5.1 消费点（只到文件级）

| 消费点 | 文件 | 怎么用 | 现有启发式 |
|---|---|---|---|
| 主回合忙闲（押后闸 / flush / 抢占 / Autopilot 共用） | `src/lib/turn-state.ts`、`src/bridge/turn-probe.ts` | 新增输入 `program`；新鲜的 working → busy，idle / done / error → idle，blocked → 新的 `blocked` 主态 | 「事件态卡 thinking + 两帧空闲 + 8 s 安静」（`stuckThinkingIdle`）**可退役**；spinner 判忙保留兜底；**压缩判定保留**（7501 / PID 文件压缩时都只说 working） |
| launcher / 自动更新的空闲闸 | `src/lib/busy-windows.ts`、`src/lib/tmux-helper.ts`（`paneLooksIdle` 调用方） | 有新鲜信号就用信号 | `paneLooksIdle` 保留兜底（TUI 契约探针照旧报警） |
| clear / 换模型前的「回合中」检查 | `src/lib/wall-screen.ts`、`src/bridge/api-routes.ts`（换模型那段） | 同上 | 保留兜底 |
| 卡死检测 | `src/bridge/wedge-watcher.ts` | working 长时间无会话写入 = 疑似卡死；idle / blocked 不再误报 | 画面判据保留兜底 |
| 待你处理（运行时弹窗） | `src/bridge/ask-runtime.ts`、`src/bridge/permission-watcher.ts` | blocked + permission / question 开卡，离开 blocked 结案；msg 只当展示文本；新增 auth → 「只有 owner 能做」类卡 | **作答仍靠画面**：选项布局和按键要从画面读，permission-watcher 识别弹窗形态保留；只把「开 / 结案」的触发换成信号 |
| 抢占打断 | `src/bridge/preempt.ts`、`src/lib/interrupt-gate.ts` | blocked/permission 时**绝不发 C-c**（发了等于替人拒绝）；idle / done 时不需要打断 | 画面判据保留兜底 |
| web 侧栏 / 协作视图徽标 | `src/bridge/event-bus.ts`、`src/bridge/agents-list-route.ts`、`web/features/chat/components/agent-row.tsx`、`web/features/chat/sidebar-entries.ts`、`web/features/collab/` | 新事件类型带 state / kind / progress / msg；徽标区分「工作中 / 等你 / 完成 / 出错 / 要登录」 | `paneLooksWorking` 黄点保留兜底 |

### 5.2 与现有信号的关系（一个状态一个权威源）

- **Stop / Notification hook（事件态 `agent_status`）**：继续负责「回合结束」的收尾动作（drain watcher、完成提示、清安全计时器）——
  这些是动作，不是状态判断。忙闲判断的优先级：**新鲜的程序状态 > 事件态 > 画面**。程序状态与事件态冲突时以程序状态为准，
  并把事件态收敛（现在 `probeTurnAt` 已有「以画面为准收成 done」这条路，换成以程序状态为准）。
- **jsonl watcher**：只管内容流（工具调用、文字），不管状态，不变。
- **permission-watcher**：从「发现弹窗」退为「读弹窗内容 + 作答」；发现由信号触发，画面发现保留兜底。
- **ACP 宿主（Codex / Pi ACP / 出借宿主）**：宿主本来就知道回合状态（`acp-turn-status`），**不套中转、不读 PID 文件**；
  turn-state 里对非 CC 运行时忽略程序状态。
- **Pi（tmux 模式）**：已有扩展按事件上报，保持为权威；7501 只在将来需要 blocked 对话框时作补充。
- **(a) 与 (d1) 同时存在时**：两者同源，不一致视为一方过期；取 `收到时间` 更新的一方，记一条日志，不报警。

## 6. 安全

上报来自 agent 进程，是**不可信数据**：

- 解析严格按规范：state 白名单；整条 ≤ 4096、msg 解码 ≤ 2048、title ≤ 192、app ≤ 32、id ≤ 128 字节；base64 解不开或解码后含
  C0 / DEL / C1 控制字符 → **整条丢弃**（不是只丢字段，实验 5 已按此实现）；未知键忽略；超长的半截序列丢弃并记日志。
- 显示：msg / title 只当纯文本（web 不进 innerHTML / markdown，Discord 转义 markdown 与 @），中和零宽和双向控制字符，截断显示。
- **不当指令**：msg 绝不拼进任何 agent 的上下文；若要转述（如给 PM 汇总），必须包成「来自 X 的状态文本（数据）」。权限弹窗的 msg
  可能带被审批命令的原文（攻击者可控），尤其不能当按钮文案以外的东西用。
- 伪造：agent 本来就是以用户身份运行的不受限 shell（见 `CLAUDE.md` 安全一节），它能伪造自己的状态，也能写别的 agent 的状态文件。
  所以程序状态只用于**可逆、低风险**的决定（押后、显示、开 / 结「待你处理」卡）；不可逆动作（kill、重启、拒绝权限）仍要画面或
  进程证据确认。状态文件放在 `~/.claude-orchestrator/` 下、0600，读时核对写入方 pid 属于该 agent 的 pane 进程树。
- 频率：同一 agent 的推送限速（规范也要求终端对外部效果限速），防止刷屏。

## 7. 建议的实现卡（供 PM 用 rewrite_dag 加节点）

| 卡 | 内容 | fileGlobs 草案 | 依赖 |
|---|---|---|---|
| PST-2 | 7501 解析与状态存储（纯函数 + 原子读写 + 单测，含拆包、畸形上报、长度、控制字符） | `src/lib/program-status*.ts`、`tests/program-status*.test.ts` | — |
| PST-3 | (d1) 读 CC PID 文件状态接入忙闲判定 | `src/lib/cc-sessions.ts`、`src/lib/turn-state.ts`、`src/bridge/turn-probe.ts`、`src/lib/busy-windows.ts`、`src/lib/wall-screen.ts`、`src/lib/doctor*.ts`、`tests/turn-state*.test.ts`、`tests/cc-sessions*.test.ts` | PST-2 |
| PST-4 | (a) pty 中转程序 + 启动接线（按 agent 开关、默认关、急停变量）+ `pane_current_command` 适配 | `src/pst-relay.ts`、`src/lib/claude-launch.ts`、`src/lib/agent-settings.ts`、`src/bridge/ctx-boundary-inject.ts`、`tests/pst-relay*.test.ts`、`tests/claude-launch*.test.ts` | PST-2 |
| PST-5 | 待你处理与抢占接线（blocked → 运行时卡、blocked/permission 不发 C-c、auth 卡） | `src/bridge/ask-runtime.ts`、`src/bridge/permission-watcher.ts`、`src/bridge/preempt.ts`、`src/lib/interrupt-gate.ts`、`src/bridge/wedge-watcher.ts`、`tests/ask-runtime*.test.ts`、`tests/interrupt-gate*.test.ts` | PST-3 |
| PST-6 | web 徽标（事件类型 + 列表字段 + 侧栏 / 协作视图展示，纯文本渲染） | `src/bridge/event-bus.ts`、`src/bridge/agents-list-route.ts`、`web/features/chat/components/agent-row.tsx`、`web/features/chat/sidebar-entries.ts`、`web/features/collab/**`、`web/lib/chat/stream-shape.ts` | PST-3 |

说明：

- PST-3 与 PST-4 都只依赖 PST-2，可并行；PST-4 上线前要在沙箱（`bun run sandbox up`）里用真实会话补测 permission / question /
  done / 子记录的实机字节（§2.3 未覆盖项），以及 OSC 133 `A` 与 working 的先后顺序（规范要求终端在 133 `A` 时丢 working /
  blocked；CC 在回合开始时会发 133 `A`，中转要确认这样不会吞掉紧随其后的 working）。
- 若 owner 选「只做 (a)」，去掉 PST-3，PST-5 / PST-6 改为依赖 PST-4。
- Pi 的 (b) 方案（`PI_PROGRAM_STATUS=1` + pipe-pane）不单独开卡，等确有需要再加。
