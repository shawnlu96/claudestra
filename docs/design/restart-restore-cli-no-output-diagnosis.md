# LSTCLIDIAG1 · 模型恢复 CLI「非 0 退出且无输出」失败来源诊断

状态：诊断设计稿（specRev 1，基线 head `0f8457af160d`）。本卡只改本文件，不改源码、测试、预算、配置或生产状态。
本文**不称** CLI 或生产问题已修；需要实施时按 §7 另立正式实现卡或走 scope 审批。
LSTCLIDIAG2 收口（同样只改本文件）：按 LSTCLIDIAG1 审查回执的三条 P2（output-shape / pollution-evidence / next-evidence）收紧 §2、§3、§5、§7 的推断边界，
并在 §5.1 分列另一个真实样本；原 job、原 head、原失败签名与 §4 控制实验的事实不变。

一句话结论：原 job 的失败签名（第 144 行、`restart 进程非 0 退出且无输出`、变更日志恰 2 行、测试耗时 8014.32ms）
**与「父进程 8000ms 定时器在 Enter 之后、输出之前 SIGTERM 了子进程」完全一致**，隔离控制实验能逐字复出同一签名；
但原 job 没有记录 exit/signal/定时器是否触发，**不能证明**就是定时器所杀，也分不清子进程是「慢」还是「卡住」。
所以结论是**未定位**（候选已收窄，见 §5），下一步最小证据见 §7。

---

## 1. 来源核对（真实可核）

| 项 | 值 | 怎么核的 |
|---|---|---|
| 正式 run | `37919434460`（`shawnlu96/claudestra`，conclusion=failure） | `gh run view 37919434460 --json ...` |
| 源 head | MANEX1 `261af731de90`（分支 `lend/dispatch-recovery-MANEX1-9109`） | 同上 `headSha` / `headBranch` |
| 失败 job | `113783525895` · `test shard 4 of 4` · completed / failure（10:44:25Z–11:03:12Z） | `--json jobs` |
| Bun | CI `bun test v1.3.14 (0d9b296a)`（setup-bun `bun-version: 1.3.14`）；本机对照 1.3.10 | job 日志第 700、797 行附近 |
| 唯一失败 | `LSTGUARD1 real manager model-before-session: safe mutations and correct gate accounting [8014.32ms]`；shard 汇总 `4831 pass / 31 skip / 1 fail` | job 日志 |
| 失败位置 | `tests/restart-expect-restore-cli.test.ts:144:22` `else expect(why).toStartWith("skipped:")`，Received `"restart 进程非 0 退出且无输出"` | job 日志 |
| 不是 skip | `why` 不以 `skipped:` 开头，也就是网关**没**把它记成 skip；该文案来自 `src/lib/restart-result.ts:58` `restartFailureReason` | 源码 |
| 日志原件 | 规格写的本机 `evidence/manex1-261af-ci-shard4.log` **在本 clone 所在机器上找不到**；本卡从 GitHub 重新拉取同一 job 日志，存在 `<scratchpad>/ci/shard4.log`（1181908 字节，sha256 前 16 位 `e80fe2867ec85c27`） | `gh run view --job 113783525895 --log` |
| 源码一致 | 下列 9 个文件在 `261af731de90` 与基线 `0f8457af160d` 的 blob 相同：本测试、`tests/test-env.ts`、`src/manager.ts`、`src/manager/restart-expect-restore.ts`、`src/manager/restart-expect.ts`、`src/lib/launcher-restore-gate.ts`、`src/lib/restart-result.ts`、`src/lib/tmux-helper.ts`、`src/lib/runtimes/claude-code.ts`。两 head 的 compare 63 个文件里，与恢复链相关的只有 `src/launcher.ts`，而本测试不经过它（gate 来自 `src/lib/launcher-restore-gate.ts`，子进程入口是 `src/manager.ts`） | `gh api .../contents/<f>?ref=` 对比 `git rev-parse HEAD:<f>` |
| 不混根因 | 同一 run 的 shard 1（job `113783525917`）唯一失败是 `review offer without write input remains valid and records no write fingerprint`，属新 offer 元数据固定期望，与本问题**不是同一根因**，本文不讨论 | job 日志 |

耗时附注：同文件前一条 `lock-unknown` 在 10:51:45.037 记 pass，本条在 10:51:53.051 出失败栈，差约 8.01s；
同一 job 里兄弟用例 `model-before-window` 只用 3287.18ms，`model-valid` 5366.23ms。**「8014 ≈ 8000」本身不是超时证明**，
只作为 §5 的一个旁证；本文不据此推 timeout 或 137，也不按 CIF1 批准重跑。

## 2. 被测链路（只读，均为基线代码）

父（bun test 进程内）：`restoreObservations`（注入假 deps）→ `LauncherRestoreGate.select` → `gate.restart(agent, run)`，
`run` 里 `Bun.spawn` 真实 manager 子进程，并挂 `setTimeout(() => proc.kill(), 8000)`；整条用例预算 10_000ms。

子进程命令（argv，由源码还原；原 job 没打印）：
`[process.execPath, "--no-env-file", <repo>/src/manager.ts, "restart", "--restore-expect", <raw 观测 JSON>, "--", "agent-test"]`
（`LSTGUARD1_MANAGER_ENTRY` 可覆盖入口；全仓只有本测试读它，没有别的测试文件写它）。

子进程环境白名单（`testChildEnv` + 本测试覆盖）：`PATH=<私有 bin>:/usr/bin:/bin`、`HOME=<私有 dir>`、`TMPDIR=<私有 dir>`、
`CLAUDESTRA_STATE_DIR=<dir>/state`、`CLAUDESTRA_RUNTIME_DIR=<dir>/run`、`CLAUDESTRA_TEST=1`、`NODE_ENV=test`、
`BRIDGE_URL=ws://127.0.0.1:9`、`BRIDGE_PORT=9`，此外没有别的变量。假 tmux 收到的命令都带 `-S <dir>/run/master.sock`。

`model-before-session` 的预期路径：
1. 三轮死壳探测（每轮两次 `capture-pane -S -5`，中间睡 `DEAD_RESAMPLE_MS` 800ms）+ 身份复核；
2. 启动：`send-keys -t @1 -l -- <启动命令>`（变更 1），`send-keys -t @1 Enter`（变更 2）→ 假 tmux 置 ready、删 caller-cred；
3. `waitReady` 抓 `-S -10` 判就绪；
4. `enforceSessionModel` → `runSwitchCommand` 先抓 `-S -120`：`io.capture` 先 `check()` 通过，再由假 tmux 把 registry 换成新 sessionId；
5. 发 `/model` 前 `tmuxSendLine` 的 beforeEffect `check()` 发现身份变 → `RestoreSkipped` → `restore.skipped()` → stdout 打印
   `{"ok":false,"results":[{"name":"agent-test","ok":false,"skipped":"Error: restore identity/state changed",...}]}`，退出码 0；
6. 网关解析出 `skipped` → `why = "skipped:…"`，failures 回退到 0。

`why === "restart 进程非 0 退出且无输出"` 在 `restartFailureReason` 里**只**在以下条件同时成立时出现：退出码 ≠ 0；
stdout **没有解析到可识别的结果对象**；stderr 没有任何非空行。正常路径下 stderr 本来就是 0 字节（§4 实测），所以「无 stderr」不区分任何假设。

「没有解析到结果对象」不等于「stdout 不是 JSON」或「stdout 为空」：源码只在 `JSON.parse` 成功**且**结果是非空 object 时走对象分支，
其余一律落到退出码兜底。纯函数复核（直接 import 基线 `src/lib/restart-result.ts`，`ok:false`、`err:""`）：
stdout 为合法 JSON 原始值 `null` / `false` / `1` / `"text"`（另试 `true` / `0`）、空串、非 JSON 文本，**全部**返回同一句文案；
`[]` 与 `{}` 则走对象分支、返回 null（不报失败）。所以这句文案对原 stdout 只说明「不是可识别的结果对象」，具体内容与字节数不可追溯。

## 3. 原 job 诊断字段：已收集 / 原无法追溯

| 字段 | 原 job | 说明 |
|---|---|---|
| 正式 source / 基线 | 已收集 | §1 |
| 子进程 argv / 环境白名单 | 由源码还原（原 job 未打印） | §2；源码在两 head 间一致 |
| Bun 版本 | 已收集 | CI 1.3.14 |
| stdout 内容 / 字节 | **无法追溯** | 只能推出「没有解析到可识别的结果对象」；非 JSON、空串、合法 JSON 原始值都兼容（§2），不能写成已证明为空或非 JSON |
| stderr 字节 | 部分 | 只能推出「没有非空行」，确切字节数不可知 |
| exit code / signal | **无法追溯** | 只知 exit code ≠ 0；没有 signal，不能写 143 / 137 / SIGTERM |
| 父 8000ms 定时器是否触发 | **无法追溯** | 测试没记 |
| 键 / 变更调用序列 | 部分 | 第 120–123 行断言已过（失败在 144），所以变更日志**恰 2 行**、每行含 `-t @1`、无 `new-window`；完整 tmux 调用序列和时间点不可追溯（`finally` 里 `rmSync` 了私有目录） |
| gate failures 计数 | 未到 | 第 145 行在 144 之后，没有执行 |

## 4. 隔离控制实验（不是生产复现）

**边界**：只在 `mkdtemp` 私有 HOME/TMPDIR/state/runtime 与假 tmux/ps 里运行；本机 `/usr/bin`、`/bin` 下没有 tmux，假 tmux 命令也都带私有 socket；
`BRIDGE_URL` 指向 9 号死端口，子进程没有生产 registry、3847 端口或 IPC 权限；没有改真实 settings，没有对真实 tmux 发键。
观测副本放在 `<scratchpad>/obs/obs.test.ts`（sha256 前 16 位 `f0136732ceac39a1`），由原测试机械生成，相对原文只有这些改动：
import 改绝对路径；用例按 `OBS_MODES × OBS_REPS` 展开；假 tmux/ps 把每次调用（带毫秒时间戳）追加到 `<dir>/mutations.calls`（与断言用的 `mutations` 文件分开）；
`run` 里多记 elapsed / exitCode / signalCode / 定时器是否触发 / stdout、stderr 字节，写到 `OBS_OUT`；定时器毫秒数可用 `OBS_KILL_MS` 覆盖（默认 8000）。
受审源与全部断言原样保留；父进程的 `process.env`、`Date`、`Response`、全局定时器都没有改。

**运行上限**（事先定）：子进程总数不超过 60 个，到上限就停，不跑到绿为止。实际用了 46 个：

| 组 | 次数 | 条件 | 子进程耗时 ms | exit / signal / 定时器 | stdout / stderr 字节 | 变更行 | 结果 |
|---|---|---|---|---|---|---|---|
| 原文件基线（未改测试） | 22 | 全 22 模式各 1 次 | — | — | — | — | 22 pass（73.29s） |
| idle | 10 | before-session ×5、before-window ×5 | 4693–6256 | 0 / null / 否 | 222 / 0 | 2 | 全 pass |
| 时间剖面 | 3 | before-session | 5903–6263 | 0 / null / 否 | 222 / 0 | 2 | 全 pass |
| CPU 压力 | 5 | before-session，同时 30 个 `yes >/dev/null`（跑完即杀，已核 0 残留） | 5740–7325 | 0 / null / 否 | 222 / 0 | 2 | 全 pass |
| 定时器 3000（Enter 之前杀） | 2 | before-session | 3005–3010 | 143 / SIGTERM / 是 | 0 / 0 | **0** | 失败在第 120 行等价处（Expected length 2，Received 0），**签名与 CI 不同** |
| 定时器 3900（Enter 之后、输出之前杀） | 2 | before-session | 3905–3907 | 143 / SIGTERM / 是 | 0 / 0 | **2** | 失败在第 144 行等价处，Received `"restart 进程非 0 退出且无输出"`，用例耗时 3910–3920ms（比定时器多约 10–20ms）——**逐字等于 CI 签名** |
| 定时器 5600 | 2 | before-session | 4248–4265 | 0 / null / 否 | 222 / 0 | 2 | pass（本轮机器更快，跑完前没触发） |

本机时间剖面（子进程 spawn 起算，3 次一致）：0.77–0.94s 才出现第一次 tmux 调用（模块加载）；三轮死壳探测占到约 3.3–3.7s；
`-l` 启动命令约 3.4–4.8s，Enter 约 +0.17–0.35s，`-S -10` 就绪 +0.6s，`-S -120` 再 +0.15s，之后约 0.15s 内 skip 并退出。
即「Enter 之后到 stdout 输出」只有约 0.7–1.0s 的窗口，这是唯一能产出 CI 签名的定时器落点。

## 5. 假设分辨

| # | 假设 | 支持 | 反对 / 缺口 | 状态 |
|---|---|---|---|---|
| H1 | 真实子进程被父 8000ms 定时器 SIGTERM（落在 Enter 之后、stdout 输出之前） | 签名逐字一致：2 行变更 + 144 行 + 文案；CI 用例耗时 8014.32ms，与控制组「定时器 +10–20ms」同型 | 原 job 没有 signal 和定时器记录；8014≈8000 只是旁证；无法排除 H3 恰好同刻 | **最可能，未证实** |
| H1a | H1 下子进程「整体变慢」（CI 兄弟用例 3.3s，需慢约 2.4 倍以上） | 本机 30 路 CPU 压力已把耗时推到 7.3s，余量只剩 0.7s；探测链里约 2.4s 是固定 sleep（`DEAD_RESAMPLE_MS` 800ms × 3），其余随负载伸缩 | 5 次压力全绿；原 job 没有分阶段时间 | 不能与 H1b 区分 |
| H1b | H1 下子进程在 Enter 之后某个 await 上卡住（如 skill 重扫、`enforceSessionModel` 的 finally） | `HOME` 下没有 `.claude/settings.json`，finally 里的 3×1200ms 回写本应跳过；本机 46 次没见到卡住 | 原 job 没有调用序列 | 未排除 |
| H2 | 真实 CLI 自己非 0 退出且没有输出（拒绝 / 异常） | — | 拒绝路径都输出 JSON，退出码 0；未捕获异常会写 stderr，而原文案说明 stderr 没有非空行；本机 46 次 0 次复现 | 不太可能，未排除 |
| H3 | 外部杀进程（runner OOM / 137 等） | 同样会产生「非 0、无输出」 | 没有任何 OOM / 137 证据；与 8000ms 吻合说不通 | 无支持，不采信 |
| H4 | 捕获或跨文件污染（全局定时器 / `Date` / env） | — | 只有局部排查：同文件前 16 条与后 5 条同进程都正常；shard 4 里唯一用 `setSystemTime` 的文件（`scheduler-merge-ci-carried-e2e`，第 236 个）排在本文件（第 207 个）**之后**；`LSTGUARD1_MANAGER_ENTRY` 没有被别的测试写；用例的 `rmSync` / `mkdtemp` 每用例独立。缺口见下 | **未发现支持，未排除** |

H4 的上述排查只覆盖了几条具体路径，不足以排除整类捕获 / 跨文件污染。缺少的证据逐项是：
- **原 shard 前缀同进程对照**：§4 全部是单文件或本文件内展开运行，没有按原 shard 4 顺序把前 206 个文件放在同一 `bun test` 进程里再跑本用例；
- **父进程捕获链状态**：失败时 `Bun.spawn`、`Response` / 流读取、`proc.exited` 是否被前序文件的 `mock.module` / `spyOn` 等替换或残留，原 job 没有记录，本文也没逐文件核过；
- **父进程定时器状态**：失败时有无假定时器、`setSystemTime` 以外的时钟改动、挂起定时器数量，原 job 没有记录（上面「排序」只覆盖 `setSystemTime` 一种机制）；
- **子进程实际 env**：§2 的白名单由源码还原，原 job 没打印 spawn 时的真实环境；
- **前序遗留负载**：前序文件是否留下子进程或占用 CPU（会把 H4 与 H1a 搅在一起），原 job 没有进程 / 负载快照。

本机单跑全绿**不能**证明这是偶发，也不能证明与污染或 MANEX1 无关；MANEX1 相对基线没改恢复链上任何文件（§1）只是缩小了候选，不是因果排除。

### 5.1 另一个真实样本（分列，并非同签名）

UICARRY2 独立车 PR979（head `f4b10ae`，run `37923156800`）的 job `113795696504`（test shard 1 of 4）也在本测试文件失败：
`LSTGUARD1 real manager model-between-session` 在 `tests/restart-expect-restore-cli.test.ts:126:21` 期望变更日志长度 5、得 2，
用例耗时 3271.02ms，shard 汇总 `5066 pass / 8 skip / 1 fail`（本卡从 GitHub 重新拉取该 job 日志核对，原日志另留，不入仓）。
它与本文的原样本（MANEX1 shard 4 `model-before-session`、第 144 行、非 0 且无可识别输出、8014.32ms）**模式、失败行、断言和耗时都不同**，
3271ms 也远离 8000ms 定时器——不能套用 H1 的定时器解释，也不能与原样本做因果归类。**并非同签名，另需证据**；
本卡不为它扩大取证实现，不改原报告或原测试。

## 6. 安全边界保持（本卡不动）

身份 / 窗 ID 钉死、每次确认键前复核、拒绝路径零新增副作用、合法模型恢复（`model-valid` 6 行、why=null）、失败计数（skip 回退、launch-failure 记 1）
以及 10 秒用例预算、8000ms 子进程预算一律保持。本文不建议加预算、删改期望，也不建议把 nonzero 吞成 skip。

## 7. 下一步最小证据与候选修法（需另立正式实现卡 / scope 审批）

**C1（首选，只改测试，取证用）**——范围：仅 `tests/restart-expect-restore-cli.test.ts`，约 6 行。
在 `run` 闭包里把 `{ code, signal: proc.signalCode, fired, elapsedMs, outBytes, errBytes }` 存到外层变量；
第 142–144 行判 why 之前，先断言 `expect({ why, ...diag }).toMatchObject({ why: <原期望> })`，让失败输出自带诊断字段；
失败时把 `mutations` 与假 tmux 调用日志复制到 `$RUNNER_TEMP` 再 `rmSync`（假 tmux 加一行 `printf` 记调用，不改 case 分支）。
- 旧红 → 新红：现在定时器杀与 CLI 自退都报同一句文案；改后会带 `signal=SIGTERM fired=true` 或 `signal=null code=N`，加上最后一条 tmux 调用和时间点。
- C1 **能**做的只有两件：区分**已记录的终止来源**（父定时器 SIGTERM / 子进程自退的退出码 / 定时器未触发时的外部信号，即 H1 · H2 · H3 的分界），
  以及定位**最后已知阶段**（最后一次 tmux 调用及时间点）。
- C1 **不能**直接区分 H1a（整体慢）与 H1b（卡在某个 await）：一个 await 慢到预算之后才会完成、另一个永不完成，被同一 8000ms 预算终止时，
  都表现为 `fired=true`、SIGTERM、同一最后调用、之后无调用无输出——同一终止日志与两者都兼容。
- 要区分 H1a / H1b 还需另外的证据（不在 C1 内）：①子进程内各阶段的**开始 / 完成**时间点（死壳探测各轮、启动、`waitReady`、`enforceSessionModel` 及其 finally），
  能看出「每段都按比例变长」还是「某段只有开始没有完成」——这要在子进程侧打点，属产品改动，须单独 scope；
  ②**有限对照**：事先定次数上限，在隔离环境里只把观测窗口放长（不改测试预算）看被杀那一段最终是否完成，并与同 job 兄弟用例的阶段耗时比对。
- 保护映射：第 118–145 行全部断言原样保留，预算 8000 / 10_000 不变，skip 判据不变；只多出一层带诊断的断言。

**C2（视真实证据再定，产品侧，需单独 scope）**——只有 C1 **加上**上面的阶段观测 / 有限对照拿到真实证据证明是 H1a（整体慢），候选才是缩短**测试夹具**路径上的固定等待，
例如 `probeDeadShellWindows` 的三次 `DEAD_RESAMPLE_MS = 800` 睡眠（函数已有 `deps.sleep` 注入，但子进程走 `liveDeps`，
要给子进程开注入口就是产品改动，范围须单独审批），**不改**生产默认值；
若证据指向 H1b（卡在某个 await），按阶段观测里「有开始无完成」的那一段精确定位，再立实现卡。没有这些真实证据前不实施 C2；C2 的范围仍须单独审批。

**不做**：不加 8000 / 10_000 预算，不按 CIF1 批准重跑，不为诊断重启任何服务。LSTCLIDIAG1 与 LSTCLIDIAG2 都**不落** C1 或 C2。

## 8. 本卡校验（如实分列）

见交付自查；本文件是本卡唯一 diff。
