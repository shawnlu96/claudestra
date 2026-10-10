# LSTINIT1 · 自动恢复新窗口停在 shell 初始化提示：诊断设计

状态：诊断设计稿（specRev 1，基线 head `6656cf461acd`，依赖 LSTGUARD1 已 verified）。本卡只改本文件，
不改 `src/`、测试、guard、默认恢复开关、服务或机器配置，没有对生产 tmux 发键或建窗口。
来源：正式安全审查事件 66007 的 P2 `restore-new-window-init-prompt-silent-skip`。原审查只读了源码；
本文 §3 的结果来自**隔离假 tmux/ps + 真实 manager 子进程 + 真实 `LauncherRestoreGate`** 的组合，**不是生产复现**，
本文也不称生产里已经发生过、或原 P2 已关闭。

一句话结论：在隔离组合里，自动恢复对「可靠缺窗」只建一次窗口；新窗口若在唯一一次发键前探测时停在 Y/n 之类初始化提示，
本次恢复记 skip、零发键；之后每轮 `manager list` 把它报成 `active / idle=false`，恢复门不再选它，
没有告警、没有计数——**这个窗口会一直停着，除非有人手动处理**（§3 S2，两次重复一致）。
现有安全行为（不按名字回退、不再建、不答提示）全部成立；缺的只是「卡住了要告诉人」。本文设计一条**不发键**的有界诊断，
默认 `observe`，任何发键处理另列审批（§7），本卡不授权实现。

---

## 1. 当前路径（只读，基线代码）

| 步骤 | 位置 | 行为 |
|---|---|---|
| 观测 | `src/manager.ts` `cmdList` → `restoreObservations`（`src/manager/restart-expect-restore.ts:48`） | 先读窗口库存再读 registry 身份，写成 `restoreExpect`；库存读失败返回 `{}`，launcher 拿到空串 |
| 选人 | `src/launcher.ts:699` `restoreGate.select` | 只选 `status === "dead"`；失败计数 ≥3 熔断 |
| 恢复 | `src/launcher.ts:725` → `manager restart --restore-expect <raw> -- <agent>` | 一次一个，300s 子进程预算 |
| 复核 | `restoreSkip`（`restart-expect-restore.ts:73`） | 身份 + 窗口列表一致；`windows` 非空时还要 `dead` 为真（第 85 行，否则 `restored or liveness unknown`），探测后再核一次 |
| 建窗 | `src/manager.ts:1332` | `windows=[]` 才 `new-window -P -F #{window_id}`，拿到 `@W` 钉为 `restoreTarget` |
| 发键 | `launchInWindow`（`manager.ts:718–721`）+ `restoreLaunchGuard`（`restart-expect-restore.ts:105`） | 恢复路径**不**等 shell、**不**跑 `clearShellInitPrompts`；每次 `cancel / literal / enter` 前 `check()`：身份 + 库存 `[@W]` + `dead` 探测（`enter` 前改探子进程） |
| 记账 | `launcher-restore-gate.ts:217` | `skipped` → 退回预约的那次计数，不告警 |
| 下一轮 | `cmdList` dead 判据（`manager.ts:1502`，`probeDeadShellWindows`） | 窗口在、两次采样都 `isAtShell`、且确无子进程才 `dead` |

人工 `manager restart <agent>`（不带 `--restore-expect`）与旧 supervisor `--expect` 路径仍走 `waitShell` + `clearShellInitPrompts`，本文不碰它们。

## 2. 卡住的状态（定义）

记 `@W` 为本次恢复刚建的窗口。卡住 = 同时满足：
1. 恢复结果是 `skipped`，且本次运行确实建了 `@W`（只有 `windows=[]` 才会建）；
2. 之后的观测里该 agent 的同名窗口**仍且仅是** `@W`，registry 身份（`created/sessionId/channelId/cwd` 等）未变；
3. `@W` 不是 dead（`isAtShell` 不成立、或有子进程、或采样失败），也不是 Claude Code 空闲。

此时没有任何路径会再碰它：`list` 报 `active`、恢复门不选、wedge watcher 见下。

**wedge watcher（仅源码阅读，未跑）**：`src/bridge/wedge-watcher.ts:243`——无子进程但 pane 不像 shell 时只记一行
「掉线判据不一致…本轮不报」，不发通知。即使存在通知，那也是 agent 频道的掉线按钮，不是给 PM 的恢复诊断。本文不依赖它。

## 3. 隔离组合实跑

**边界**：每个场景一个 `mkdtemp` 私有目录作 HOME/TMPDIR/state/runtime；`PATH=<私有 bin>:/usr/bin:/bin`（本机 `/usr/bin`、`/bin` 下没有 tmux），
假 tmux/ps 只读写私有目录，manager 发的 tmux 命令都带私有 `-S <dir>/state/run/master.sock`；`BRIDGE_URL` 指向 9 号死端口；
子进程环境走 `tests/test-env.ts` 的 `testChildEnv`（测试标记生效）。没有碰生产 registry、tmux、服务。跑完核过 `$TMPDIR` 下 0 个残留目录。
探针脚本在作者 scratchpad（`probe.ts`，最终版 sha256 前 16 位 `8b90e684c90e9f56`，不入仓；S12、S13 是后加的场景，前 11 个场景的判定代码未改）。真实部分：`src/manager.ts restart / list` 子进程、
`restoreObservations`、`LauncherRestoreGate`（`select` / `restart` 记账）。**假的部分**：tmux/ps 行为、pane 文本、Claude 就绪
（发 Enter 后假 tmux 直接画出就绪画面），所以「launch 成功」只说明发键路径走通，不说明真 Claude 起来了。

初始库存 `master\t@0`（空库存时 `list-windows` 输出空行，`live.windows` 抛 `invalid window inventory`，与真实 tmux 不符，故补一行 master）。
「后续轮」= 真实 `manager list` → 真实 `gate.select` → 只对 `dead` 的再 `restart`，模拟 launcher 巡检。S1–S12 两轮完整重复（run1 / run2），S13 跑两次，结果一致。

| # | 组合 | 恢复结果 | 新建窗口 | 发键 | 后续轮 | gate failures / 告警 |
|---|---|---|---|---|---|---|
| S1 | 新窗口立即出 shell（`host repo % `） | ok | 1 | `-l` 1 + `Enter` 1，都 `-t @7` | — | 0 / 0 |
| S2 | 停在 `[oh-my-zsh] Would you like to update? [Y/n] ` | skipped：`restored or liveness unknown` | 1 | **0** | 2 轮都 `active, idle=false`，`restoreExpect` 无，`select` 空；无新建、无发键 | 0 / **0** |
| S3 | 提示只在第 1 次 capture 出现，之后变 shell | skipped（同 S2） | 1 | 0 | — | 0 / 0 |
| S4 | 提示在 skip 后消失（人工答了 / 超时） | 第 0 轮 skipped | 1（全程） | 第 0 轮 0；第 1 轮 `-l`+`Enter` 到 `@7` | 第 1 轮 `dead`、`restoreExpect.windows=["@7"]` → 同一窗口恢复成功，**不再建** | 0 / 0 |
| S5 | 建窗后出现同名第二窗口 `@8` | skipped：`restore identity/state changed` | 1 | 0 | — | 0 / 0 |
| S6 | 建窗后 registry `sessionId` 换代 | skipped：`restore identity/state changed` | 1 | 0 | — | 0 / 0 |
| S7 | shell 提示但已有子进程 | skipped：`restored or liveness unknown` | 1 | 0 | — | 0 / 0 |
| S8 | 建窗后库存读失败 | skipped：`tmux list-windows … 失败` | 1 | 0 | — | 0 / 0 |
| S9 | 建窗后 capture 失败 | skipped：`restored or liveness unknown` | 1 | 0 | — | 0 / 0 |
| S10 | 观测时库存未知（`restoreObservations` 返回 `{}`，launcher 传空串） | skipped（JSON 解析失败） | **0** | 0 | — | 0 / 0 |
| S11 | 停在 Y/n 且有子进程 | skipped：`restored or liveness unknown` | 1 | 0 | — | 0 / 0 |
| S13 | S2 之后再用**原始**缺窗观测重放 | skipped：`restore identity/state changed` | 0（全程 1） | 0 | — | 0 / 0 |
| S12 | 非 shell 提示但以 `>` 结尾（`Proceed with setup? >>> `） | ok | 1 | **`-l`+`Enter` 发进了提示** | — | 0 / 0 |

逐项核对：可靠缺窗全程最多 1 次 `new-window`；库存未知（S10）不当缺窗、0 次建窗；所有拒绝（S2–S11、S13）后新增键 = 0；
没有任何场景按名字回退、kill、再建或回答提示。S3 说明恢复路径只有一次「发键前采样」，提示随后消失也不会在本次重试。

**证据与推测分开**：
- 已实跑（隔离）：上表全部；`isAtShell` 纯函数对 `[Y/n]`、`(y/N)`、`[yes/no]:`、`Password:`、`Press any key…`、空 pane 均为 false，对 `conda init? >>> ` 为 true。
- 仅源码阅读：wedge watcher 不报（§2）；生产 zsh 真会在新窗口弹这类提示（`clearShellInitPrompts` 注释的历史描述）。
- 推测、未验证：生产中出现频率；真实 oh-my-zsh 提示的确切画面；提示是否会自己超时消失。

## 4. 缺口

| # | 缺口 | 证据 | 本文处理 |
|---|---|---|---|
| G1 | 建窗后 skip 的窗口无人知晓，长期停住 | S2 | §5 诊断（主线） |
| G2 | manager 的 skip 结果不带「本次建了 `@W`」，launcher 无法把 skip 与新建窗口绑定 | 源码：结果行只有 `name/ok/skipped/error` | §5 需加只读输出字段 |
| G3 | `isAtShell` 只看行尾形状，以 `>`/`$`/`%`/`#` 结尾的非 shell 提示被当成 shell，恢复会把启动命令发进去 | S12（假 pane） | 只记录；不属 skip 诊断，修判据须另立卡（§7 R3） |
| G4 | dead 探测 capture 用名字目标 `master:=<agent>`，不是 `@W` | 源码 `list-dead-probe.ts`；探测前后库存都核为 `[@W]` 缓解 | 诊断里只用 `@W` 读；不在本文改 |

## 5. 设计：不发键的有界诊断

### 5.1 复用的端口（不新增 writer 或权限）
- **唯一 writer**：`LauncherRestoreGate` 的 `transaction`（文件锁 + 原子写 `launcher-restore-gate.json`）。诊断状态放进同一 `Entry` 的新可选子对象 `initDiag`，
  在同一事务里读写；不新增状态文件、不新增锁。`validState` 相应放行该字段（实现卡的事）。
- **PM 通知**：沿用 gate 的 `announce` → `notify({ source: "launcher", chatId: CONTROL_CHANNEL_ID })`，与「熔断 / 目录缺失」同一路，先持久化再发。
- **只读状态**：`list-windows -F #{window_name}\t#{window_id}`、`capture-pane -t @W`、`windowHasChildProcess(@W)`；全是读，不发键。
- **租约**：只在 `restoreDeadAgents` 的同一轮内做（受 `restartWaveUntil` 约束），不另起定时器。

### 5.2 起点与身份绑定
- manager 恢复路径在 `restore.skipped()` 返回时，若本次 `recreated`，在结果行加只读字段 `createdWindow: "@W"`（G2）。
  不改 skipped 判定、退出码或计数；不带 `--restore-expect` 的路径不输出该字段。
- gate `restart()` 看到 `skipped` + `createdWindow` 时，在**同一事务**里写 `initDiag = { window: "@W", generation, since: now, rounds: 0, logged: false, notified: false, unknownSince: null, unknownLogs: 0 }`。
  `logged`（本机日志 claim）与 `notified`（PM 通知 claim）是两个独立的持久化 claim，互不代替（见 §5.4）。
  `failures` 照旧退回（skip 仍是 skip，不重算成失败或成功）。
- 绑定键 = `(agent, generation(created, sessionId, channelId, cwd), @W)`。`generation` 复用 gate 已有的定义。

### 5.3 每轮判定（只读）
每轮 `select` 时，对持有 `initDiag` 的 agent：
0. **未知 ≠ 换代**：下列任一读不出时，本轮记为 unknown——registry 不可读、库存（`list-windows`）读失败、`capture-pane` 失败、子进程探测为 `null`。
   unknown 轮：**保留** `initDiag` 的绑定键、`since`、`rounds`、`logged`、`notified` 原样不动，`rounds` 不加（暂停计数）；
   若 `unknownSince = null` 则置为 `now`，且 `unknownLogs < 3` 时在同一事务里 `unknownLogs++` 落盘后写**一行本机 launcher 日志**
   （agent、`@W`、哪一项不可读；不发 PM、不猜 owner / master、不旁路 gate）。同一段连续 unknown 只记一行；整个绑定键最多 3 行，抖动也有界。
   下一次读得出时清 `unknownSince = null`，从上次的 `rounds` 继续数（恢复可读后同身份可再次达到长期卡住阈值并诊断一次）。
1. registry **读成功**且：该 agent 的 `list` 行确实不存在，或 `generation` 确实变了 → 删 `initDiag`（换代退出），不通知。
   只有权威的「读到了、且不一致」才算退出；读不到走第 0 条。
2. 库存**读成功**且该名字不是恰好 `[@W]`（没了、换了、多了同名）→ 删 `initDiag`。库存读失败走第 0 条。
3. `list` 报 `dead` → 删 `initDiag`，走正常恢复（S4 的路径），诊断不插手。
4. `list` 报 `active` 且 `idle=true` → 已恢复，删 `initDiag`。
5. 否则读 `capture-pane -t @W` 与 `windowHasChildProcess(@W)`：capture 失败或子进程 `null` → 走第 0 条（unknown，不计数）；
   成功 → `rounds++`，并记分类 `kind`：pane 尾部命中 `Y_N_PROMPT_RE` 且无子进程 = `init-prompt`，其余 = `unknown-prompt`（**不猜 dead、不猜内容**）。
6. `rounds ≥ 3` 且 `now - since ≥ 5 min` → 长期卡住。两个 claim 各自判定、各自「先落盘再产生效果」：
   - `observe` 或 `on`，且 `logged=false` → 先置 `logged=true` 落盘，再写一行本机 launcher 日志（长期卡住）。
   - 仅 `on`，且 `notified=false` → 先置 `notified=true` 落盘，再发一次 PM 通知。`observe` 下 `notified` 不动。
   落盘失败（gate 写不进）→ 本轮不产生对应日志 / 通知，下轮重试；不会出现「已产生效果但 claim 没落盘」导致重启后重复。

通知只含：agent 名、`@W`、分类、卡住时长、建议（`/screenshot` 看画面，人工处理后巡检会按 dead 自动接手，或 `manager kill`）。
**不带 pane 原文**（可能含路径、凭据提示）。分类只是提示，不触发任何动作。

### 5.4 去重、重启、多项目
- **与正常恢复分开去重**：`initDiag.logged / notified / unknownLogs` 独立于 `failureAlert / missingAlert / lastFailureAlert`，互不清除；
  同一绑定键长期卡住日志一行、PM 通知最多一次、unknown 日志最多 3 行。
- **observe ↔ on**：`logged` 只抑制重复日志，从不抑制通知；`notified` 只由 on 模式置位。observe 期间已写过日志（`logged=true, notified=false`）
  后切到 on → 下一轮满足阈值即发**一次** PM 通知，不再重复日志；on → observe → on 不会二次通知（`notified` 已为 true）。
  切到 off → 不读不写，记录原样冻结；再切回 observe / on 时从冻结状态继续，两个 claim 保持原值。
  `@W` 或 `generation` 变化即删记录，新一次建窗 skip 会是新的绑定键。
- **launcher 重启**：状态（含 `logged / notified / unknownLogs / unknownSince`）在 gate 文件里，重启后接着数，不重复日志、不重复通知；`since` 用墙钟，重启期间不补发。
- **多项目 / 多机**：gate 按 agent 名，registry 名字全局唯一；只诊断**本机 manager 本次建出的** `@W`，不看别的机器或别人的窗口。
  没有 `CONTROL_CHANNEL_ID`：on 模式不置 `notified`（无可投递目标，不算已通知），只写本机日志，不猜 owner / master 频道。
  registry / 库存 / capture 不可读：见 §5.3 第 0 条，保留绑定、暂停计数、有界本机日志。
  gate 状态本身不可读：无法读写 `initDiag`，本轮不判、不删、不写，只在内存里每次 launcher 进程最多记一行本机日志；
  不绕过 gate（状态不可读本来就走 `stateFault` 暂停恢复），恢复可读后按原记录继续。
- **不增授权**：诊断不调用 `restart`、不改 `failures`、不改 `select` 的选择结果。

### 5.5 开关：on / observe / off（默认 observe）
| 模式 | 读 | 写 gate 状态 | 日志 | PM 通知 | 发键 |
|---|---|---|---|---|---|
| off | 无 | **零附加写**（不写 `initDiag`；已有的不再更新） | 无附加 | 无 | 无 |
| observe（默认） | §5.3 只读 | `initDiag`（含 `logged`、`unknownLogs`；不置 `notified`） | 卡住时每绑定键一行（`logged` 去重）；unknown 每绑定键 ≤ 3 行 | 无 | 无 |
| on | 同上 | 同上，另置 `notified` | 同上 | 每绑定键一次（`notified` 去重，与 `logged` 无关） | **无** |

`manager` 的 `createdWindow` 字段与模式无关（只是结果描述）。开关的读取位置、生产默认值的改动、把生产设为 `on`，都不由本文批准。

## 6. 候选比较

| 方案 | 做法 | 风险 | 证据 | 结论 |
|---|---|---|---|---|
| A 不动 | 维持现状 | G1 继续沉默 | S2 | 不选 |
| **B 只读诊断 + PM 通知（§5）** | 只读 + gate 同事务记账 + 现有通知 | 新状态字段的兼容；分类误报只影响一条通知 | S1–S13 的安全行为不变 | **推荐** |
| C 恢复内多采样 | skip 前在同一 restart 里多等几次 | 拉长持锁；仍要发键；**不放宽预算**的前提下收益只覆盖 S3 | S3 | 暂不做，需另行评估 |
| D 自动答 `n`（旧 `clearShellInitPrompts`） | 发键 | 对未知提示 / 同名新窗 / 他人进程产生效果 | 规格禁止 | **拒绝** |
| E kill 后重建 | 删窗再建 | 违反「只建一次」，可能杀掉人工正在处理的窗口 | 规格禁止 | **拒绝** |

## 7. 未来实现范围、依赖与审批（本卡不授权）

**R1（实现 §5，需正式实现卡）**
- 范围：`src/manager.ts`（skip 结果加 `createdWindow`）、`src/lib/launcher-restore-gate.ts`（`initDiag` 字段与 §5.3 判定）、
  `src/launcher.ts`（传入只读探测与开关）、对应 `tests/`。不改 `restart-expect-restore.ts` 的复核与发键闸。
- 依赖：LSTGUARD1（已 verified）。
- 审批：实现卡 + 跨族审查；开关默认 observe，切 on 另需 owner 拍板。
- 隔离测试矩阵（真实 manager + 假 tmux，同 §3 边界）：S1–S13 全量回归（新建次数、零键、记账不变）；
  新增：S2 三轮后 observe 写 `initDiag` 不通知、on 恰一次通知；launcher 重启后不重复；`@W` 消失 / 同名第二窗 / `sessionId` 换代 / 变 dead / 变 idle 各自清记录；
  库存或 capture 失败轮不计数；**registry 暂时不可读 → 同身份恢复可读且 `@W` 仍停 Y/n**：记录与计数保留、不可读期间零新增窗口 / 零键、
  恰一行 unknown 本机日志、恢复后最终恰一次长期卡住诊断（observe 一行日志 / on 一次通知）；registry 读成功但 `generation` 变 → 删记录；
  unknown 抖动 ≥ 4 段时日志封顶 3 行；observe 写过日志后重启不重复日志，再切 on 恰一次通知，on→observe→on 不二次通知；
  无 `CONTROL_CHANNEL_ID` 时 on 不置 `notified`；gate 状态不可读时 `initDiag` 字节不变；off 时 gate 文件字节不变；人工 `restart` 与 supervisor `--expect` 正负例原样通过。

**R2（受保护的提示处理，需单独实施前审批，非本卡）**——仅在 PM 收到 §5 通知后**手动点按钮**触发，最小范围：
- 只针对绑定键完全一致的 `@W`，只对 `kind=init-prompt` 且 pane 尾部仍精确命中 `Y_N_PROMPT_RE`；只发一次 `n` + `Enter`，各键前复核：
  库存恰为 `[@W]`、`generation` 未变、pane 仍是同一提示、无子进程；两次复核之间不留未复核的 await。
- 不对同名新窗、他人进程、未知提示生效；任何复核失败即放弃，不重试、不升级为 kill / 再建。之后由正常巡检按 dead 接手。
- 需要：owner 批准发键能力、按钮权限边界、独立安全审查。

**R3（G3 形状误判，另立卡）**：`isAtShell` 对非 shell 提示的误判属于 dead / 发键判据本身，影响面超出本诊断，须单独评估与审批。

## 8. 本卡校验（如实）

- diff 只有本文件。`bun run typecheck`、`GUARD_STRICT=1 bun run guard`、`git diff --check` 结果见交付自查。
- 本地全量 `bun test` 未跑；全量以 PR 准确 head 的正式 CI 为准；独立跨族审查以审查回执为准，本文不预填。
- 实现与生产效果另验；原 P2 不因本文发布自动关闭。
