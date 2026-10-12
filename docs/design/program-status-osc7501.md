# OSC 7501 程序状态协议：tmux 下可行性实验 + 接入设计（PST-1 设计稿）

状态：**只是设计稿**。本稿不改任何生产代码、不开任何开关；实现卡等本稿审过、owner 选定方案后再加进 feature。

## 0. 出处与环境

- 规范：<https://www.superlogical.com/rex/docs/build/program-status>（发布说明 <https://mitchellh.com/writing/program-status-osc7501>）。
  本稿只引用要点，不复制全文。
- tmux 上游：<https://github.com/tmux/tmux/issues/5713>（2026-10-09 开，Open，项目看板状态 Waiting；维护者认为为时尚早，
  要等更多终端和程序采用，并指出 pane 标题、OSC 9 进度、OSC 133 已覆盖类似需求）。
- 实验环境：Claude Code **2.1.296**（native 安装）、Pi **1.1.0**（`@earendil-works/pi-coding-agent`）、tmux **3.6a**、macOS。
- 实验 1–7、9 在私有 tmux socket（`-L pst1exp`，`-f /dev/null`）里做，被测程序用 `env -i` + 隔离的 HOME / TMPDIR 启动（无凭据、
  无用户 hooks / MCP）。实验 8 需要已登录的 CC，按规格改用开发沙箱（`bun run sandbox up --port 23971 --root /tmp/cs-pst1`，
  自己的 tmux server 与 bridge，做完 `clean`），CC 以 `--permission-mode default --strict-mcp-config --setting-sources project,local
  --model haiku` 启动（不加载用户 hooks / MCP）。全程**没碰**生产 `master.sock`、registry、台账；读生产数据只有两次只读：本执行者
  自己的 `~/.claude/sessions/<pid>.json`（§3.4），以及按 cwd 只读轮询沙箱那个 CC 会话的同类文件（实验 8）。
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
0.27ms b'\x1b]7501;?\x1b\\'
0.64ms b'\x1bP>|tmux 3.6a\x1b\\\x1b[?1;2;4c'
7501_reply_at=1 da1_at=25 verdict=SUPPORTED
{"ev": "probe_answered", "raw": "b'\\x1b]7501;?\\x1b\\\\'", ...}
```

结论：tmux 在同一次读里就回了 XTVERSION + DA1（< 1 ms）；中转在看到探测的那一刻往子 pty 写回复，比 tmux 的 DA1 早约 0.4 ms 到达（第一轮实测 0.36 / 0.88 ms，同样先到），
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

本实验没有凭据；`blocked/permission`、`blocked/question`、`done` 的实机字节见 §2.6（沙箱里已登录的 CC）。

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

### 2.5.1 半截序列、超长、中止与 EOF（实验 9，`partial.sh` → `partial.jsonl` / `partial-pane.txt`）

不能假定程序总会把序列写完，中转也不能一直扣住终端输出。原型最终版的规则（实现卡照此写单测）：

| 情况 | 处理 | 缓冲上限 / 时限 |
|---|---|---|
| 块尾是 `ESC ] 7501 ;` 的前缀（如单个 `ESC`、`ESC ] 75`） | 扣住，等下一块拼起来再判 | ≤ 6 字节；从第一次扣住起最多 0.5 s，到点**原样放行**（它不是 7501） |
| 已认出 `ESC ] 7501 ;`、还没看到 BEL / ST | 扣住正文 | ≤ 4096 字节；从第一次扣住起最多 0.5 s，到点**丢弃**并记日志，然后恢复透传 |
| 正文里出现 CAN / SUB | 按 VT 解析器惯例中止：丢弃这段，CAN / SUB 本身吃掉，后面恢复透传 | — |
| 正文里出现 `ESC` 后跟的不是 `\` | 视为新序列开始：丢弃这段 7501，从这个 `ESC` 起恢复透传 | — |
| 正文超过 4096 字节 | 整条丢弃；剩余正文进入丢弃态，丢到 BEL / ST / 中止字节为止，**不当普通文本漏给终端** | 丢弃态最多 0.5 s，到点恢复透传 |
| EOF / 子进程退出时还扣着东西 | 半个前缀放行，未结束的 7501 正文丢弃 | — |

到点放行 / 丢弃的代价：一个真被拆开、间隔超过 0.5 s 的上报会丢一次。规范规定每份上报整条替换、程序只在变化时发，丢一次的后果是
这次状态变化没收到；所以接线方不能把「最后收到的状态」当成必然最新（见 §4.1 的新鲜度规则）。

原始输出（每行一种情况，`A2` / `B2` … 是紧跟在异常片段后的普通文本，全部按时出现在画面上）：

```
A1 A2-after-unterminated          ← 永不结束的 "\x1b]7501;state=wor"，1.2 s 后的普通文本
B1 B2-bold-after-abort            ← 正文里遇到 ESC [ 1 m，粗体照常生效
C1 C2-after-CAN                   ← CAN 中止
D2-after-oversize                 ← 5000 字节正文 + ST，剩余正文没有漏成文本
E1 E2-split-200ms-ok              ← 拆成两块、间隔 200 ms，仍被正确解析为 state=done
F1 F2-lone-esc-flushed            ← 块尾单个 ESC 等了 1 s，到点放行，粗体照常生效
H2-after-split-oversize           ← 超长正文被拆成两块写入，丢弃态吃到 ST 为止
G1                                ← 子进程以未结束片段退出

{"ev": "unterminated_drop", "raw": "b'\\x1b]7501;state=wor'", ...}
{"ev": "aborted_drop", "raw": "b'state=idle'", ...}        (ESC 中止)
{"ev": "aborted_drop", "raw": "b'state=idle'", ...}        (CAN 中止)
{"ev": "oversize_drop", "n": 5039, ...}
{"ev": "report", "raw": "b'state=done'", "fields": {"state": "done"}, ...}
{"ev": "oversize_drop", "n": 5018, ...}
{"ev": "unterminated_drop", "raw": "b'\\x1b]7501;state=work'", ...}   (EOF)
{"ev": "child_exit", "status": 0, ...}
```

原型演进中踩过的两处坑都已写进上表：第一版「半截前缀超时放行」让后半截绕过解析；第二版「一律等下一块」会把终端输出无限期扣住、
超长正文的剩余部分还会漏成文本。实验 1 / 3 / 5 / 6 用最终版重跑，结果不变（实验 3 的重跑输出 `cc-relay-final.jsonl`）。

### 2.6 实验 8：已登录的 CC，7501 与 PID 文件同时抓（`run5.sh` + `pidpoll2.py`，开发沙箱）

沙箱 tmux 里经中转启动已登录的 CC（Haiku，默认权限模式），依次：`echo` 回合（自动放行）→ 让它用 Write 建文件（弹权限）→ Esc 拒绝
→ 让它调 AskUserQuestion（弹提问）→ Esc 取消 → 两次 C-c 退出。同时按 cwd 只读轮询它的 `~/.claude/sessions/<pid>.json`。

中转日志 `sbx-relay.jsonl`：

```
{"ev": "probe_answered", "raw": "b'\\x1b]7501;?\\x07'", "t": 1791804022.018}
{"ev": "report", "raw": "b'state=idle:app=claude-code'", ..., "t": 1791804022.69}
{"ev": "report", "raw": "b'state=working:app=claude-code'", ..., "t": 1791804040.667}
{"ev": "report", "raw": "b'state=done:app=claude-code'", ..., "t": 1791804049.059}
{"ev": "report", "raw": "b'state=working:app=claude-code'", ..., "t": 1791804063.362}
{"ev": "report", "raw": "b'state=blocked:app=claude-code:kind=permission:msg=YXBwcm92ZSBXcml0ZTogL3ByaXZh…'",
 "fields": {..., "kind": "permission", "msg": "approve Write: /private/tmp/cs-pst1/work/pst/a.txt"}, "t": 1791804064.761}
{"ev": "report", "raw": "b'state=idle:app=claude-code'", ..., "t": 1791804082.113}
{"ev": "report", "raw": "b'state=working:app=claude-code'", ..., "t": 1791804086.588}
{"ev": "report", "raw": "b'state=blocked:app=claude-code:kind=question:msg=YW5zd2VyOiBQaWNrIEEgb3IgQi4gKEEgwrcgQik='",
 "fields": {..., "kind": "question", "msg": "answer: Pick A or B. (A · B)"}, "t": 1791804087.644}
{"ev": "report", "raw": "b'state=idle:app=claude-code'", ..., "t": 1791804106.776}
{"ev": "report", "raw": "b'state=clear'", "fields": {"state": "clear"}, "t": 1791804110.281}
{"ev": "child_exit", "status": 0, "t": 1791804110.847}
```

PID 文件 `sbx-pidfile.jsonl`（同一进程，pid 35041）：

```
{"t": 1791804022.829, "status": "idle",    "waitingFor": null,                "statusUpdatedAt": 1791804022689}
{"t": 1791804040.771, "status": "busy",    "waitingFor": null,                "statusUpdatedAt": 1791804040671}
{"t": 1791804049.089, "status": "idle",    "waitingFor": null,                "statusUpdatedAt": 1791804049059}
{"t": 1791804063.391, "status": "busy",    "waitingFor": null,                "statusUpdatedAt": 1791804063361}
{"t": 1791804064.877, "status": "waiting", "waitingFor": "permission prompt", "statusUpdatedAt": 1791804064760}
{"t": 1791804082.211, "status": "idle",    "waitingFor": null,                "statusUpdatedAt": 1791804082112}
{"t": 1791804086.665, "status": "busy",    "waitingFor": null,                "statusUpdatedAt": 1791804086587}
{"t": 1791804087.698, "status": "waiting", "waitingFor": "input needed",      "statusUpdatedAt": 1791804087644}
{"t": 1791804106.797, "status": "idle",    "waitingFor": null,                "statusUpdatedAt": 1791804106776}
```

结论：

- 两条通道每次转换都对得上，`statusUpdatedAt` 与对应 7501 上报的到达时间相差 ≤ 4 ms（同一次内部状态变化）。
- PID 文件能分出「等权限」（`permission prompt`）和「等回答」（`input needed`）；7501 另带弹窗文字（msg）和 `done`。
  PID 文件里回合完成与被打断都是 `idle`。
- 被 Esc 打断的回合在 7501 里是 `idle`（不是 `done`）。
- CC 正常退出时**自己**发 `state=clear`，中转不需要补发（§3.1）。
- 仍未实测：`error`、`blocked/auth` 以外的出错路径、后台 subagent 子记录、OSC 133 `A` 与 `working` 的先后。留给 PST-4。

## 3. 各方案评估

### 3.1 方案 (a)：agent 进程与 tmux 之间加一层 pty 中转 —— 可行

做法：启动命令从 `claude …` 变成 `<relay> claude …`。中转开一个新 pty 跑子进程，自己的 stdin/stdout 接 tmux pane：
输入原样转给子进程；输出逐字节扫描 `ESC ] 7501 ;`，探测立刻回 `OSC 7501 ; ? ST`、上报按规范校验后交给 bridge，二者都不往 tmux
透传（tmux 本来也丢）；其余字节原样透传。SIGWINCH 把 pane 尺寸同步给子 pty。子进程退出则中转带同样状态退出。

记录生存期按规范：子进程退出（或 OSC 133 `A`）时只丢 `working` / `blocked` 记录，`done` / `error` 保留，由产品侧的清除策略决定
何时清（例如该 agent 下一回合开始、或 owner 在 web 上看过）。中转**不合成** `clear`：程序自己发的 `clear` 照单全收（CC 正常退出
会自己发，实验 3 / 8）；崩溃、被杀这种没发 `clear` 的退出，中转只记一条「子进程已退出」，由读取方按上面的规则处理。

| 影响面 | 结论 | 依据 |
|---|---|---|
| 按键输入 / `send-keys`（含 `-l`、Enter、C-c） | 无影响，字节原样过 | 实验 3 |
| 窗口尺寸 | 需中转转发 SIGWINCH；做了就正常 | 实验 3 resize；Bun 实现注意 `Bun.Terminal` resize 后要手动给子进程发 SIGWINCH（`src/bridge/web-terminal.ts` 头注释） |
| copy-mode、`capture-pane`、所有画面判据 | 无影响：tmux 看到的输出除 7501 外逐字节相同，copy-mode 是 tmux 自己的 | 实验 3 / 6 |
| web 终端（`tmux attach` 的 PTY） | 无影响，中转在 pane 里面 | 拓扑推导 |
| `#{pane_current_command}` | **会变**：从 `claude` / 版本号变成中转的进程名 | `src/bridge/ctx-boundary-inject.ts` 的 `CC_COMMAND_RE` 会判 `notCc` 拒绝注入，必须同步改；`src/lib/lend-pane-archive.ts` 只记录 |
| 进程树多一层 | 按祖先链 / 子树判的都不受影响；「有子进程 = 活着」把中转算作子进程，因此中转必须随子进程退出 | `cc-sessions.ts`、`worker-liveness.ts`、`agent-liveness.ts`、`tmux-helper.ts windowHasChildProcess` |
| 杀进程救援（`windowChildPids` → kill） | 杀到中转 → 子 pty 挂断 → CC 收 SIGHUP 退出；效果与现在等价 | `src/manager.ts`、`src/manager/acp-lifecycle.ts` |
| 忙闲判定 | 现有判据不受影响；新信号按 §5.1 的信任规则作为额外输入 | — |
| 延迟 / 资源 | 每块输出多一次拷贝（探测应答 0.27–0.36 ms）；块尾恰好是半截序列时最多扣 0.5 s（§2.5.1）；每个 agent 多一个常驻进程 | 实验 1；Bun 实现每个约几十 MB 常驻内存，在意可换编译型小程序 |
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
- 规范本身不给程序读记录（只有探测回复），所以 tmux 光是「回答探测、按 pane 存」还不够，Claudestra 还需要读的途径。#5713 的
  提议里已经包含这部分：Suggestion 第 2 项提出按 pane 的 format（`pane_ps_state` / `pane_ps_kind` / `pane_ps_progress` /
  `pane_ps_app` / `pane_ps_msg`，起初只存根记录），第 4 项提出 `pane-status-changed` hook。如果上游照此实现，Claudestra 就能用
  `display -p '#{pane_ps_state}'` 读、用 hook 收推送，不再需要中转（子记录除外）。
- 但上游**尚未接受**：issue 仍是 Open / Waiting，维护者表示要先看别的终端和程序是否采用，没有排期。
- 自维护 tmux 分支：要跟 Homebrew 升级、要给所有用户装，代价远大于中转。**本卡没有做补丁原型**，这里的「不推荐」是成本判断，
  不是验证过不可行。
- 结论：跟踪上游；上游合入后，把 (a) 的中转换成读 format / 收 hook（接线方只认 §4.1 的状态记录，换来源不影响消费方）。

### 3.4 方案 (d)：其它

**(d1) 读 CC 的会话 PID 文件状态 —— 可行，且不碰终端。**
CC 把 `status` / `waitingFor` / `statusUpdatedAt` 写进 `~/.claude/sessions/<pid>.json`，与 7501 的主记录同源（同一个 `blockedOn`
映射：permission prompt / input needed / dialog open）。Claudestra 已经在读这个文件（`src/lib/cc-sessions.ts` 解析了 `status`），
但目前没用于忙闲。

- 证据：实验 8（§2.6）在已登录的 CC 上抓到完整转换：idle → busy → idle（完成）、busy → `waiting` + `permission prompt`、
  busy → `waiting` + `input needed`，与同一时刻的 7501 上报一一对应。另有只读看本执行者自己会话文件的一条：
  `{'kind': 'interactive', 'status': 'busy', 'waitingFor': None, 'statusUpdatedAt': 1791802294229, 'tmux': 'master:@3939.%3939', 'version': '2.1.296'}`
  （`statusUpdatedAt` 正是收到开工单的时刻）。隔离实验（`ev-pidfile.jsonl`）未登录，只采到 `idle`。
- 比 7501 少的：没有 done / error / auth 的区分（完成与打断都是 idle）、没有 msg、没有子记录。
- 比 7501 多的：不改启动命令和进程树；文件带 `tmux` 字段（pane 定位）和 pid，归属清楚；bridge 重启后直接可读。
- 风险：这是 CC 的内部文件格式、没有承诺（7501 是公开协议）。实现要「认不出就当没有」，并把格式探针接进 doctor。

**(d2) 其它想过但否掉的**：在 tmux 外层换成我们自己托管的 PTY（等于重写 tmux 拓扑，代价最大）；`allow-passthrough`（CC 不会把
7501 包成 DCS passthrough）；控制模式 `-CC`（同样不转发未知 OSC）。

## 4. 推荐方案与备选

**推荐：两步走。**

1. **先做 (d1)**：CC agent 读 PID 文件的 `status` + `waitingFor`，作为忙闲 / 等人的**辅助信号**接入（§5）。零拓扑变化，读不到即
   退回现状。实验 8 已证明它能分出忙、闲、等权限、等回答。
2. **再做 (a)**：pty 中转作为「OSC 7501 支持」本体，按 agent 开关、默认关、灰度。它补上 (d1) 没有的 done / error / auth、
   msg 和子记录，也给 Pi 和将来别的程序一条统一入口。两条来源各存各的记录，按 §4.1 合并。

**备选**：只做 (a)（若 owner 只要公开协议、不想依赖 CC 内部文件）；Pi 单独用 (b) + `PI_PROGRAM_STATUS=1`（不需要中转）。
(c) 跟踪上游 #5713，合入后用 tmux 的 format / hook 替换中转（§3.3）。

### 4.1 状态记录与新鲜度

**三种时间分开记，不混用：**

| 时间 | 含义 | 来源 |
|---|---|---|
| `changedAt` | 程序内部状态**变化**的时刻 | 7501：中转收到这条上报的时刻（程序只在变化时发）；PID 文件：`statusUpdatedAt` |
| `sampledAt` | 我们**读到**这条记录的时刻 | 中转写文件 / bridge 读 PID 文件的时刻 |
| 生产者存活 | 发这条状态的进程**此刻**还在不在 | pid + 进程启动时间（`procStart` / `ps -o lstart`）一起核，防 pid 复用 |

**每个来源一份独立记录**（`source` = `osc7501` / `pidfile`），各自带：state / kind / progress / msg（PID 文件只有 status /
waitingFor）、`changedAt`、`sampledAt`、生产者身份（CC pid + 启动时间；7501 另加中转 pid + 启动时间）、源版本（CC `version`、
中转版本）。中转写自己的文件（如 `~/.claude-orchestrator/program-status/<agent>.osc7501.json`，tmp + rename 原子写）；PID 文件不
复制，bridge 读时现场取。中转与 bridge 之间没有网络面；bridge 重启后照读。

**合并规则（读取方，纯函数，PST-2 单测）：**

1. 生产者已不在（pid 不存在或启动时间对不上）→ 这份记录的 working / blocked 作废；done / error 只留作显示。
2. 生产者还活着 → 记录**一直有效，不按年龄过期**（规范没有心跳，长时间不变化就是没变化）。
3. 两份都有效时，取 `changedAt` 更晚的那份；**不拿一方的 `sampledAt` 去比另一方的 `changedAt`**——定期读到的旧 PID 文件，它的
   `changedAt` 仍是旧的，压不过更新的 7501 上报。`changedAt` 相差 ≤ 50 ms 视为同一次变化（实验 8 实测 ≤ 4 ms），取 7501
   （信息更全）。
4. 两份 state 归一化后（busy↔working、waiting↔blocked、idle↔idle/done）仍矛盾且 `changedAt` 差 > 50 ms：取更晚的，记一条日志；
   同一 agent 1 分钟内反复矛盾才报警（可能是中转丢了上报，§2.5.1）。
5. 7501 记录的「最后一条」不保证最新（中转可能因 0.5 s 时限丢过一条）：所以规则 3 里 PID 文件更晚的变化可以覆盖它。

### 4.2 回退方式

- 开关：agent 设置里一项（默认关）+ 全局急停环境变量；关掉后下一次启动即回到裸 `claude …`。
- 运行中：两份记录都缺失 / 生产者已不在 → 判据自动回到现有 hook + 画面那一套（§5.2「现有判据」列全部还在）。
- 中转自身：起不来就 `exec` 原命令。

## 5. 拿到状态后接到哪里

### 5.1 信任规则：程序状态只能让决定更保守

程序状态来自 agent 进程（§6），可以被它伪造。所以分两类用：

- **否决（可直接用）**：程序状态说「忙 / 等人」就可以让一个动作**不做或推迟**——押后消息、不发 C-c、不清上下文、不重启、
  不换模型。被伪造的最坏结果是该 agent 自己的消息被押后，可被现有超时与人工按钮解开。
- **放行（不能单独用）**：程序状态说「闲」**永远不足以单独放行**会丢回合、丢输入或不可逆的动作（launcher 自动更新后重启全员、
  clear、换模型、kill、C-c 打断）。这些动作仍要现有的画面 / 进程证据确认空闲；程序状态只能在两者一致时缩短等待，二者矛盾时
  按「忙」处理并记日志。
- 显示、开 / 结「待你处理」卡、押后队列这类可逆动作，用合并后的状态即可。

### 5.2 消费点（只到文件级）

| 消费点 | 文件 | 怎么用 | 现有判据 |
|---|---|---|---|
| 主回合忙闲（押后闸 / flush / Autopilot） | `src/lib/turn-state.ts`、`src/bridge/turn-probe.ts` | 新增输入 `program`（§4.1 合并结果）。押后 / flush 可直接用；新增 `blocked` 主态 | 「事件态卡 thinking + 两帧空闲 + 8 s 安静」（`stuckThinkingIdle`）在程序状态与画面都说闲时可提前收敛；spinner 判忙**保留**；**压缩判定保留**（两条来源压缩时都只说忙） |
| 抢占打断（C-c） | `src/bridge/preempt.ts`、`src/lib/interrupt-gate.ts` | **只作否决**：blocked/permission 时绝不发 C-c（发了等于替人拒绝）；idle / done 时不发 | 是否发 C-c 仍由画面判忙决定 |
| launcher / 自动更新的空闲闸 | `src/lib/busy-windows.ts`、`src/launcher.ts`（调用方，只读核对） | **只作否决**：程序状态说忙 / 等人就不放行；说闲时仍要 `paneLooksIdle` 等现有判据同意 | `paneLooksIdle` 与 TUI 契约探针保留为放行条件 |
| clear / 换模型前的「回合中」检查 | `src/lib/wall-screen.ts`、`src/bridge/api-routes.ts`（换模型那段） | **只作否决**，同上 | 现有判据保留为放行条件 |
| 卡死检测 | `src/bridge/wedge-watcher.ts` | 只影响告警：working 长时间无会话写入 = 疑似卡死；blocked 不报卡死 | 画面判据保留 |
| 待你处理（运行时弹窗） | `src/bridge/ask-runtime.ts`、`src/bridge/permission-watcher.ts` | blocked + permission / question 开卡，离开 blocked 结案；msg 只当展示文本；新增 auth → 「只有 owner 能做」类卡 | **作答仍靠画面**：选项布局和按键从画面读，permission-watcher 保留；只把「开 / 结案」的触发换成信号 |
| web 侧栏 / 协作视图徽标 | `src/bridge/event-bus.ts`、`src/bridge/agents-list-route.ts`、`web/features/chat/components/agent-row.tsx`、`web/features/chat/sidebar-entries.ts`、`web/features/collab/` | 新事件类型带 state / kind / progress / msg；徽标区分「工作中 / 等你 / 完成 / 出错 / 要登录」 | `paneLooksWorking` 黄点保留兜底 |

### 5.3 与现有信号的关系（一个状态一个权威源）

- **Stop / Notification hook（事件态 `agent_status`）**：继续负责「回合结束」的收尾动作（drain watcher、完成提示、清安全计时器）——
  这些是动作，不是状态判断，不变。
- **忙闲判断**：可逆动作按「合并后的程序状态 > 事件态 > 画面」取值；不可逆动作按 §5.1 的否决规则，放行条件仍是现有判据。
  程序状态与事件态冲突时，`probeTurnAt` 现有的「把卡住的 thinking 收成 done」只在程序状态和画面都说闲时做。
- **jsonl watcher**：只管内容流（工具调用、文字），不管状态，不变。
- **permission-watcher**：从「发现弹窗」退为「读弹窗内容 + 作答」；发现由信号触发，画面发现保留兜底。
- **ACP 宿主（Codex / Pi ACP / 出借宿主）**：宿主本来就知道回合状态（`acp-turn-status`），**不套中转、不读 PID 文件**；
  turn-state 里对非 CC 运行时忽略程序状态。
- **Pi（tmux 模式）**：已有扩展按事件上报，保持为权威；7501 只在将来需要 blocked 对话框时作补充。
- **(a) 与 (d1) 同时存在时**：按 §4.1 合并，两份记录都保留，消费方只看合并结果。

## 6. 安全

上报来自 agent 进程，是**不可信数据**：

- 解析严格按规范：state 白名单；整条 ≤ 4096、msg 解码 ≤ 2048、title ≤ 192、app ≤ 32、id ≤ 128 字节；base64 解不开或解码后含
  C0 / DEL / C1 控制字符 → **整条丢弃**（不是只丢字段，实验 5 已按此实现）；未知键忽略；半截 / 超长 / 被中止的序列按 §2.5.1 处理。
- 显示：msg / title 只当纯文本（web 不进 innerHTML / markdown，Discord 转义 markdown 与 @），中和零宽和双向控制字符，截断显示。
- **不当指令**：msg 绝不拼进任何 agent 的上下文；若要转述（如给 PM 汇总），必须包成「来自 X 的状态文本（数据）」。权限弹窗的 msg
  带被审批操作的原文（实验 8：`approve Write: <路径>`，路径和命令都可能被攻击者控制），只能当展示文本。
- 伪造：agent 本来就是以用户身份运行的不受限 shell（见 `CLAUDE.md` 安全一节），它能发假的 7501、改自己的 PID 文件，也能写同用户
  可写的任何状态文件。读取时核对生产者身份（§4.1：pid + 启动时间，且 pid 在该 agent 的 pane 进程树里）只能挡住「张冠李戴」，
  挡不住 agent 伪造自己。所以信任边界按 §5.1：**程序状态只能否决，不能单独放行**会丢回合或不可逆的动作。
- 频率：同一 agent 的推送限速（规范也要求终端对外部效果限速），防止刷屏。

## 7. 建议的实现卡（供 PM 用 rewrite_dag 加节点）

| 卡 | 内容 | fileGlobs 草案 | 依赖 |
|---|---|---|---|
| PST-2 | 7501 解析、每来源状态记录与合并（纯函数 + 原子读写 + 单测：拆包、§2.5.1 每一行、畸形上报、长度、控制字符、§4.1 合并规则 1–5、生产者身份与 pid 复用） | `src/lib/program-status*.ts`、`tests/program-status*.test.ts` | — |
| PST-3 | (d1) 读 CC PID 文件状态接入忙闲判定（按 §5.1：可逆动作直接用，不可逆动作只作否决） | `src/lib/cc-sessions.ts`、`src/lib/turn-state.ts`、`src/bridge/turn-probe.ts`、`src/lib/busy-windows.ts`、`src/lib/wall-screen.ts`、`src/lib/doctor*.ts`、`tests/turn-state*.test.ts`、`tests/cc-sessions*.test.ts` | PST-2 |
| PST-4 | (a) pty 中转程序 + 启动接线（按 agent 开关、默认关、急停变量）+ `pane_current_command` 适配；生存期按 §3.1（不合成 clear） | `src/pst-relay.ts`、`src/lib/claude-launch.ts`、`src/lib/agent-settings.ts`、`src/bridge/ctx-boundary-inject.ts`、`tests/pst-relay*.test.ts`、`tests/claude-launch*.test.ts` | PST-2 |
| PST-5 | 待你处理与抢占接线（blocked → 运行时卡、blocked/permission 不发 C-c、auth 卡；抢占 / clear / 换模型只作否决） | `src/bridge/ask-runtime.ts`、`src/bridge/permission-watcher.ts`、`src/bridge/preempt.ts`、`src/lib/interrupt-gate.ts`、`src/bridge/wedge-watcher.ts`、`tests/ask-runtime*.test.ts`、`tests/interrupt-gate*.test.ts` | PST-3 |
| PST-6 | web 徽标（事件类型 + 列表字段 + 侧栏 / 协作视图展示，纯文本渲染） | `src/bridge/event-bus.ts`、`src/bridge/agents-list-route.ts`、`web/features/chat/components/agent-row.tsx`、`web/features/chat/sidebar-entries.ts`、`web/features/collab/**`、`web/lib/chat/stream-shape.ts` | PST-3 |

说明：

- PST-3 与 PST-4 都只依赖 PST-2，可并行；PST-4 上线前要在沙箱（`bun run sandbox up`）里用真实会话补测 §2.6 仍未覆盖的：`error`、
  后台 subagent 子记录，以及 OSC 133 `A` 与 working 的先后顺序（规范要求终端在 133 `A` 时丢 working / blocked；CC 在回合开始时
  会发 133 `A`，中转要确认这样不会吞掉紧随其后的 working）。
- PST-5 改 `src/lib/busy-windows.ts` / `src/lib/wall-screen.ts` 的放行条件时，只能**加**否决，不能把现有画面判据从放行条件里拿掉
  （§5.1）；验收里要有「程序状态说闲、画面说忙 → 不放行」的用例。
- 若 owner 选「只做 (a)」，去掉 PST-3，PST-5 / PST-6 改为依赖 PST-4。
- Pi 的 (b) 方案（`PI_PROGRAM_STATUS=1` + pipe-pane）不单独开卡，等确有需要再加。
