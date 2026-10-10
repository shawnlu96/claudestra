# 预算回收断言的组合 CI 失败：诊断（dispatch-recovery-MTRDIAG1，仅诊断）

状态：**诊断设计稿**。本文只新增这一个文件：不改源码、测试、配置、合并门、CI 预算、`passes` / `budgetMs` / 超时 / guard，
不改运行中的服务、台账、timer 或 launchd。**合并本文不等于 CI 已修好、根因已修复或实现已获批**；修法另立实现规格（§7）。
两张原卡（MANREFD1、N8A8B）由正式 serial fallback 按各自准确 head 继续走合并闸；本文不手合红组合头、不拿拆车绿顶替当前头、
不补 rerun 额度、不冻其它工作、不回写原报告。原报告与私有原证据保持不动。

基线 head：`0f8457af160d`。下文行号都指这个基线。完整 SHA、原始日志只留本机证据目录；正文一律 12 位。

## 1. 结论先行

| 问题 | 结论 | 证据级别 |
|------|------|----------|
| 组合车厢 shard 4 真红吗 | 是。唯一失败 `tests/scheduler-merge-reclaim.test.ts:63`，期望 `["merged", ["yield","reclaim"]]`，实得 `["ready", ["yield"]]`；4501 pass / 10 skip / 1 fail，exit 1，非超时、非 137 | CI 原日志（§2.3） |
| 组合源和拆车源有没有碰调度代码 | 没有。三份源相对基线只动 `docs/`、`web/features/collab/`、两个 `tests/web-team-source-*` 文件；`src/lib/`、`tests/scheduler-*` 字节不变 | GitHub compare（§2.2） |
| 分片清单 / 顺序不同导致 | **已排除为确定性原因**：组合 shard 4 与拆车 b（PR977）shard 4 的 375 个文件内容和顺序完全相同，后者绿 | 两份 CI 日志逐行比对（§2.4） |
| 失败签名能否解释 | 能，且只需一个机制：`passPace` 的 phase 保底是**按墙钟**（`budget / 3`，`budgetMs: 1` 时 0.33 ms）而不是按张数；mergeTick / deployTick / auto tick 都在**第一张卡之前**就问 `yieldNow()`，且 mergeTick、deployTick 无游标、按 `eventSeq` 从最老的意图开始（让过路的 T3 永远排第一）。只要某 phase 建立后、首次检查前跨过一个毫秒边界，该 phase 本轮就 0 张卡；列车成员拿不到推进 → 槽一直被成员占着 → 回收永远不触发 → T3 停在 `ready`、只有 `yield` | 本机受控实验 3/3 复现同一签名、对照组 3/3 绿（§4） |
| CI 那一次是不是就是这个机制 | **未证明**。CI 日志没有每 phase 的 elapsed / cursor，无法回放那 40 轮；只能说该机制是目前唯一能复现完全相同签名、且与“同源同清单拆车绿”相容的假设 | §5 |
| 是不是产品回归 | **未证明是**。生产预算 60 s（保底 20 s），phase 建立到首次检查只有微秒级，墙钟保底在生产上几乎不会失效；但 `scheduler-yield.ts:47` 写的“每个有活的 phase 每轮至少开一张卡”在实现上不成立，是潜在缺陷，测试参数 `budgetMs: 1` 把它放大成墙钟敏感 | §5、§6 |
| 偶发 / 无关？ | 不下这个结论。“拆车两绿 + 本机单跑绿”只说明不是确定性失败，不说明与组合无关或已定位 | — |

## 2. 来源对照

### 2.1 四个准确源与父链

| 角色 | SHA（12） | 父 | 相对基线 |
|------|-----------|----|----------|
| 基线 main | `0f8457af160d` | — | — |
| 组合 head（PR974，`train/2i-txen1`） | `7dc8d0921bf2` | `b72ff3e8ff72`（= `0f8457af160d` + `1f36ea9b446e`）、`94e31f4a1001` | ahead 8 / behind 0 |
| 拆车 a head（PR976，`train/2i-txen1a`，MANREFD1） | `4b6b6e0d111f` | `0f8457af160d`、`1f36ea9b446e` | ahead 2 / behind 0 |
| 拆车 b head（PR977，`train/2i-txen1b`，N8A8B） | `1c8d7fd07be7` | `0f8457af160d`、`94e31f4a1001` | ahead 6 / behind 0 |

N8A8B 链：`3213b8aa4efe` → `8d03b478d1f5` → `900737be7c3d` → `ee93fb521e34` → `94e31f4a1001`（父链起点 `c3f384f0a726`）。
MANREFD1：`1f36ea9b446e`（父 `a2b255b2a121`）。三个 PR 目前都是 CLOSED（列车流程关临时 PR，不是合并）。

CI 是 `pull_request` 事件，实际检出的是 GitHub 临时合并引用 `refs/remotes/pull/<n>/merge`：组合 `74251941…`（“Merge 7dc8d0921bf2 into 0f8457af160d”）、
拆车 a `ff791e17…`、拆车 b `cdaff71a…`。三个 head 都是基线的直接后代，临时合并的树应等于 head 的树；临时引用事后已取不到
（`git/commits` 404），这一点按推理记，未直接核对。组合 head 的树 `ab326e6a2db9` 已在本机用“基线 + compare 列出的 5 个文件”重建并逐字节核对一致。

### 2.2 源差异

| 文件 | 组合 | 拆车 a | 拆车 b |
|------|------|--------|--------|
| `docs/design/manual-review-refusal-source.md`（新增 +136） | ✓ | ✓ | — |
| `tests/web-team-source-fields.test.ts`（+6/−1） | ✓ | — | ✓ |
| `tests/web-team-source-mirror-behind.test.ts`（新增 +193） | ✓ | — | ✓ |
| `web/features/collab/team-source-adapter.ts`（+11/−8） | ✓ | — | ✓ |
| `web/features/collab/team-source-shared.ts`（+24/−8） | ✓ | — | ✓ |

组合 = 两车文件的并集，无交叉文件、无冲突解决。`src/lib/scheduler-*`、`tests/scheduler-merge-reclaim*.ts` 在四个源里完全相同。

### 2.3 组合失败 job（原始日志）

- run `37918613714`（CI，pull_request，attempt 1），10:36:13Z 建、10:52:00Z 完成，结论 failure。
- 失败 job `113780810182` “test shard 4 of 4”，10:36:16Z–10:49:30Z；runner 镜像 ubuntu24 `20261004.327.1`；`setup-bun` `bun-version: 1.3.14`，日志首行 `bun test v1.3.14 (0d9b296a)`。
- 命令：`bun run --silent test:shard 4/4 > files.txt`，`bun test "${files[@]}" | tee -a shard.log`（bash `-e -o pipefail`）。
- 结果：`4501 pass / 10 skip / 1 fail`，`Ran 4512 tests across 375 files. [764.54s]`，`Process completed with exit code 1`。不是超时，不是 137。
- 失败用例：`MTR1 … > every phase yields its budget each pass …`，耗时 182.96 ms，断言 `:63`：
  `- "merged" + "ready"`，`turns` 少了 `"reclaim"`。同文件其余 4 个 full-pass 用例和下一个 describe 全绿。
- 汇总 job `113786018250` “typecheck + test + guard” 因 shard 4 非 success 而 failure（10:51:56Z–10:51:59Z）；其余 5 个 job（shard 1/2/3、web、desktop）success。
- **初始日志读取失败不是“没有失败日志”**：`gh api …/jobs/113780810182/logs` 默认拒绝输出（“the response contains terminal escape sequences”）；
  加 `--allow-escape-sequences` 后完整取到 7632 行原日志。

### 2.4 拆车全部终态与分片清单

| 运行 | 源 | 7 个 job | shard 4 结果 | MTR1 `:62` 用例 |
|------|----|----------|--------------|-----------------|
| `37918613714`（组合，PR974） | `7dc8d0921bf2` | 5 success + shard 4 failure + 汇总 failure | 4501/10/1，764.54 s | **fail** 182.96 ms |
| `37920084508`（拆车 a，PR976） | `4b6b6e0d111f` | 全 success（含汇总 `113790930791`） | 4491/11/0，748.10 s | pass 131.60 ms |
| `37920090426`（拆车 b，PR977） | `1c8d7fd07be7` | 全 success（含汇总 `113790912946`） | 4502/10/0，656.85 s | pass 233.20 ms |

shard 4 文件清单（从各 job 日志 `##[group]tests/…` 抽取）：组合与拆车 b **375 个文件、顺序完全一致**；拆车 a 少
`web-team-source-mirror-behind.test.ts`，LPT 分法使末尾 5 个文件不同，`scheduler-merge-reclaim.test.ts` 在三者中都位于第 242 位、前后邻居相同。
本机用组合树跑 `bun scripts/ci-test-shard.ts 4/4` 得到的清单与 CI 日志逐行相同。三次都是 Bun 1.3.14、同一 workflow。

历史：最近 40 个失败的 CI run（最早 2026-10-07T21:13Z）里逐个扫失败 test job 原日志，这一断言只在 `37918613714` 出现过一次；
同窗口 success run 至少 208 个（列表上限 300，下界）。被取消的 run 未扫。

## 3. 场景与真实路径

`tests/scheduler-merge-reclaim.test.ts:59-66` 用 `starvation(w, { passes: 40, budgetMs: 1 })`（`tests/scheduler-merge-reclaim-world.ts:212`）：
T3 先占槽在 `ready`，第一轮（默认 60 s 预算）里列车 tick 组 T1+T2，mergeTick 让 T3 把槽借给列车（turn `yield`）；之后每轮
`w.pass({ budgetMs: 1 })` 走真实 `schedulerPass`（`src/lib/scheduler-pass.ts:113`）：

```
trainTick → mergeTick(pace.phase()#0) → deployTick(#1) → reclaimLentSlots(不吃预算) → manual.claim
  → observe(#2) → auto.resume(#3) → specResume(#4) → lockYield → autoTick(#5) → auto.start → lendTakeover → retire(#6) → lifecycle
```

T3 回收（turn `reclaim`）的前提（`src/lib/scheduler-merge-reclaim.ts:33-41`）：列车不再 hold、`merge:p` 槽空、T3 最近一次 turn 是 `yield`、无漂移。
槽要空，必须是列车成员 T1、T2 各自被 mergeTick 推进到 match-head 合并、被 deployTick 观察到部署结束放槽；T2 的合并意图还要 auto tick 规划。
所以 T3 能否在 40 轮内合并，取决于 #0、#1、#5 三个 phase 每轮至少推进到成员那张卡。

时间 / 预算来源（`src/lib/scheduler-yield.ts:50-55`）：

- `deadline = 轮开始 Date.now() + budgetMs`；`floor = phase 建立时 Date.now() + budgetMs / 3`；
- `yieldNow() = (now ≥ deadline && now ≥ floor) || 有 update 在等`。`Date.now()` 是整毫秒，`floor` 带小数：`budgetMs: 1` 时
  `floor = t0 + 0.333`，等价于“**phase 建立后只要跨过一个毫秒边界就让**”。trainTick 本身耗时数毫秒，`deadline` 通常在 mergeTick 之前就已过。

各 loop 的检查位置：

| phase | 位置 | 首卡前检查？ | 游标 |
|-------|------|--------------|------|
| mergeTick #0 | `src/lib/scheduler-service.ts:58-60`（先 `skipTask` 再 `yieldNow`） | 是 | **无**，`ORDER BY eventSeq`，T3（world 里 `eventSeq=2`）永远第一 |
| deployTick #1 | `src/lib/scheduler-deploy-tick.ts:108`、`:118`、`:135` | 是；`:118` 对 T3（`ready`，随后 `continue`）也先检查 | **无**，`ORDER BY eventSeq` |
| autoTick #5 | `src/lib/scheduler-auto-tick.ts:436`、`:442` | 是（`:436` 先把 `yieldNow` 交给 manual resume） | 有，`pace.cursor.auto`（`:443`） |

`schedulerV2PassPace`（`src/lib/scheduler-v2-pass.ts:67-69`，`745c1fb7` 引入，已在基线里）给每个 phase 加了 `skipTask` 路由查询（`getTask` 等），
mergeTick 在首次 `yieldNow` 之前就会调它；它增加的是 phase 建立到首检之间的耗时，没有改判断规则。它与组合失败的关系**未证明**（拆车也含它，照样绿）。

## 4. 本机实验（scratchpad，非产品、非生产复现）

环境：macOS arm64，本机 Bun 1.3.10（CI 1.3.14）；`env -i` 起子进程，私有 `HOME` / `TMPDIR` / `CLAUDESTRA_STATE_DIR` / `CLAUDESTRA_RUNTIME_DIR`，
`PATH` 最前是只记日志、`exit 1` 的假 `gh` / `launchctl`，无凭据、无网络副作用。E1/E2/探针跑完假桩日志为空；E3b 全分片里有别的测试两次调用假 `gh api repos/o/r/compare/…`（夹具的假仓库，被假桩拦下），没有调用 `launchctl`。
复用原 `reclaimWorld` / `starvation`，原 40 passes / 1 ms 与两条断言不变；不复制 helper、不另造调度入口。

| # | 假设 / 目的 | 变量 | 观察 | 上限 | 结果 | 退出 |
|---|-------------|------|------|------|------|------|
| E1 | 原用例单跑能否本机复现 | 无（`-t "every phase yields its budget"`，原仓库） | 通过数 | 30 次 | 30 pass / 0 fail | 全 0 |
| E2 | 整文件（含前面 3 个 full-pass 用例的进程内状态）能否复现 | 无（原文件 17 用例） | 通过数 | 10 次 | 10/10 pass | 全 0 |
| E3 | 组合树 shard 4 全清单同序能否复现 | 无（重建的组合树，375 文件） | 该用例结果 | 1 次 | 见 §4.1 | 见 §4.1 |
| P1 | 观测：每轮 T3/T1/T2 phase、槽、列车阶段、turn | 观测探针 | 轨迹 | 1 次 | T1 第 2 轮合并、T2 第 4 轮、第 5 轮列车 cleanup、第 6 轮回收、约第 9 轮 T3 merged | 0 |
| P2 | 观测：mergeTick 每次 `yieldNow` 的 `dt`/`now`/`deadline`/`floor` | scratchpad 副本 `passPace` 加记录（只在 `budget<1000` 时） | 首检让出次数 | 1 次 | 首检 `dt` 0.05–0.11 ms；第 7 轮首检在 0.108 ms 就跨毫秒边界让出（0 张卡） | 0 |
| C0 | 受控时钟：`Date.now` 每调一次前进 1 / 5 ms（模拟极慢机器） | 全局替换（仅探针进程） | T3、turns | 各 1 次 | 前进 0：merged、`[yield,reclaim]`；前进 1 和 5：**`ready`、`[yield]`、calls 为空** | 0 |
| C1 | **H1**：phase 建立后、首检前多出 ≥1 ms 就让该 phase 0 张卡，成员卡推不动 → 失败签名 | 副本里在第 k 个 phase 建立后 `sleepSync(1)`；k=0（mergeTick） | T3、turns、mergeTick 首检让出 | 3 次 | 3/3 `ready`、`[yield]`、calls 空，40/40 轮首检即让 | 0 |
| C2 | 同 H1，k=1（deployTick） | 同上 | 同上 | 3 次 | 3/3 `ready`、`[yield]`、只 `match-head:T1`（部署永远观察不到） | 0 |
| C3 | 同 H1，k=5（autoTick） | 同上 | 同上 | 3 次 | 3/3 `ready`、`[yield]`、`match-head:T1, deploy:T1`（T2 永远没被规划） | 0 |
| C4 | **反证**：同样多 1 ms，但加在与场景无关的 observe（k=2），整轮同样变慢 | k=2 | 同上 | 3 次 | 3/3 merged、`[yield,reclaim]` | 0 |
| C5 | 修法假设：保底改成“首检不让”（按张数）够不够 | 副本 `yieldNow` 首调只看 update 请求；k=0/1/5 | 同上 | 各 3 次 | k=5：3/3 绿；k=0：3/3 仍红（首张永远是借出的 T3）；k=1：3/3 仍红（`:118` 的首检被 T3 的 `continue` 用掉） | 0 |

C0–C5 都是控制实验：人为把 phase 建立到首检的间隔拉到 ≥1 ms，**不是** CI 那次的回放，也不是生产复现。
C4 说明失败不是“整轮变慢”本身，而是“特定 phase 首检前跨毫秒边界”；C5 说明单改保底不够，mergeTick / deployTick 的“无游标、最老优先、首卡可能是不推进的借出方”同样是必要条件。

### 4.1 E3 全分片

第一次调用由我自己的 shell 错误把 375 个路径拼成了一个参数，Bun 1.3.10 启动即 panic（exit 133，0 个测试）——无效实验，不计入。
按正确参数重跑一次（E3b，组合树、CI 同序 375 文件、本机 Bun 1.3.10）：`4435 pass / 10 skip / 26 fail / 4 errors`，`Ran 4471 tests across 375 files. [624.48s]`，exit 1。
**目标用例 `every phase yields its budget` 绿（66.78 ms）**，同文件 5 个 full-pass 用例全绿；未复现。
26 个失败都在别的文件（大号意图 / 收敛 CLI、v23 迁移守卫、tmux 分屏宿主等），用例数也比 CI 少 41 个。本机环境与 Bun 版本都和 CI 不同，
这 26 个失败的原因**未逐项核对**：不当作 CI 结论，也不判定它们与本诊断无关或不算问题，作为未知项单独记账；这里只如实记下退出码，不把这次全分片说成绿。

## 5. 可检验的因果假设

**H1（主假设，已在受控条件下证实机制，CI 那次未证实）**：`budgetMs: 1` 时每个 phase 的“保底”只有 0.33 ms 墙钟，而 mergeTick / deployTick / autoTick
都在第一张卡之前检查。慢 runner 上 phase 建立到首检（SQL 查询、`skipTask` 路由查询、首卡前的 `continue`）更容易跨毫秒边界，于是该 phase 本轮 0 张卡；
mergeTick / deployTick 无游标、按 `eventSeq` 最老优先，借出的 T3 又永远排第一，成员卡只在“整段都没跨毫秒边界”的轮次里才前进。
成员需要的有效轮次凑不够 40 轮 → 列车停在 `testing/settling`、槽被 T1 占着 → `reclaimLentSlots` 每轮因“列车 hold / 槽忙”跳过 → `ready` + `[yield]`。

- 支持：签名完全一致（C0–C3）；无关 phase 加同样延迟不红（C4）；同源同清单拆车可以绿（非确定性，与墙钟敏感相容）；本机快机器 40 轮内绿（E1/E2）。
- 反证所需：在 CI 同规格 runner 上带 P2 那种 phase 记录跑原用例，若失败轮次里 mergeTick/deployTick/autoTick 首检并未让出，则 H1 被否。
  这需要改测试或产品加观测，本卡不做，列入 §7。
- 失败那次 182.96 ms 落在绿的区间（131.60–233.20 ms）内，耗时本身既不支持也不否定 H1。

**H2（状态污染 / 跨文件影响）**：已排除为确定性原因（§2.4 同清单拆车 b 绿）。非确定性的跨文件影响未排除也未证明；shard 4 中排在它前面的文件
有 `mock.module`（`account-usage-dashboard`、`api-agents-list-recovery`、`cli-wrapper-script`），只替换 tmux / registry / 统计等模块，
未见替换 `Date.now`、`performance.now`、调度 / 合并 / yield 模块。

**H3（组合改动本身）**：无证据。组合只改 `web/` 与 web 测试、docs，与调度路径无 import 关系；且同一份文件在拆车 b 绿。

**H4（真正的进度饥饿产品回归）**：未证明。生产 `PASS_BUDGET_MS = 60_000`（`scheduler-yield.ts:14`），保底 20 s，首检前的微秒级耗时不会触发；
但“无游标 + 首卡前检查”使 mergeTick / deployTick 在**确实超预算**的轮次里永远从最老意图开始，这个形状本身就是潜在的 head-of-line 饥饿，与 `:47` 注释承诺不符。

## 6. 区分：哪一类

| 类别 | 判断 |
|------|------|
| 真正进度饥饿（生产） | 未证明；潜在形状存在（§5 H4） |
| 状态污染 | 进程内：E2 整文件 10/10 绿，未见；跨文件：同清单拆车绿，未见确定性污染 |
| 全局 mock / 跨文件影响 | 未见证据（§5 H2） |
| 单纯 wall-clock 敏感 | **是目前唯一有受控复现支撑的类别**：测试用 `budgetMs: 1` 把墙钟保底压到亚毫秒，结果取决于 runner 速度 |

## 7. 后续最小改动范围（需另立正式实现规格，本文不授权）

不提高 `passes` / `budgetMs` / timeout / guard，不删、不放宽 `ready` / `merged` / `reclaim` 断言，不加新机制。两条路二选一，由 PM 定：

**A. 产品侧（推荐，使 `scheduler-yield.ts:47` 的承诺成立）**
- 文件：`src/lib/scheduler-yield.ts`（`passPace`：每个 phase 第一张卡前不因预算让出，只因 update 请求让出）；
  `src/lib/scheduler-service.ts` mergeTick 与 `src/lib/scheduler-deploy-tick.ts` deployTick（只在“真的要处理的卡”前检查，或像 autoTick 一样带游标轮转），
  具体取舍按 C5：只改 `passPace` 不够。
- 旧红新绿保护：`tests/scheduler-yield.test.ts` 用注入 `now`（`passPace` 已有 `opts.now`）造“首检已过 floor”→ 旧实现首检让出（红）、新实现不让（绿）；
  mergeTick / deployTick 各一条“最老意图是借出方 + 首检即超预算”的定向用例，旧红新绿。原 MTR1 用例与两条断言原样保留。
- 不变量：update 请求仍立即让出；单卡内步骤不打断；合并槽 CAS、租约、slot 让出 / 取回、漂移检查、独立审查保护不动。
- 部署边界：普通代码卡走合并闸；不碰正在运行的服务、launchd、timer。

**B. 夹具侧（只在 PM 判定生产行为不改时）**
- 让 world 的 pass 用受控时钟驱动 `passPace`：需要 `PassOpts` 能把 `now` 传给 `passPace`（`scheduler-pass.ts:121` 现在不传），因此仍要动产品文件的签名；
  测试语义保持“每轮每个 phase 都超预算”，用确定性时钟让 `now` 在每轮开始后即越过 `deadline`，而不是靠真实毫秒边界。
- 风险：B 只让测试确定，不修 H4 形状；若选 B，`:47` 注释应改成与实现一致。

未定位部分的下一步：在实现卡里先按 §5 的反证方法补观测（只在测试进程里），再决定 A/B；没有新证据前不宣称 CI 根因已修复。

### 勘误（MTRBUD1）

- §2.4 组合运行一行原写“6 success”，7 个 job 实为 5 success（shard 1/2/3、web、desktop）+ shard 4 failure + 汇总 failure，已改；原 run / job / 测量不变。
- §4.1 原把本机 26 个失败写成“与本诊断无关 / 不算问题”，未经逐项归因，已改为“环境 / 版本不同、原因未逐项核”。
- 实现卡 MTRBUD1 按 §7 A 兑现了“有工作的 phase 每轮至少开始一张”的承诺（`passPace` 首检不因预算让出、mergeTick 带游标、deployTick 只在要开始的卡前问预算）。
  这只修首卡保障；CI 那一次的根因（§5 H1 在 CI 上）与生产饥饿（H4）仍**未证明**，不因此倒写为已定位或已修好。

## 8. 校验记录

均在本分支提交 `docs(MTRDIAG1)` 后、本机 Bun 1.3.10 上跑：

| 项 | 命令 | 结果 |
|----|------|------|
| 类型检查 | `bun run typecheck`（先 `web/` 内 `bun install --frozen-lockfile`、`node scripts/gen-build-info.mjs`） | 第一次 exit 1（`web/` 依赖未装，60 个 TS 错误全在 `web/`）；装好后 exit 0 |
| guard（严格） | `GUARD_BASE=0f8457af160d… GUARD_STRICT=1 bun run guard` | exit 0，“guard ✓（3680 个文件，严格模式）” |
| 原入口打包 | CI 同款 8 个入口 `bun build src/<entry>.ts --target=bun`（输出到 scratchpad） | 8/8 成功 |
| 定向测试 | E1 / E2（§4） | 30/30、10/10 绿 |
| 全量 `bun run check` | — | **未跑**；全量以准确 head 上的 CI 为准 |
| 准确 head 正式 CI | — | 本文提交时**未跑**（推送与开 PR 由出借服务做），结果以合并闸为准 |
| 独立跨族文档复验 | — | **未做**，由审查环节做 |

## 9. 本机证据（不入库）

scratchpad 下：组合 job 原日志、两张拆车 shard 4 原日志、三份分片清单、历史扫描结果、E1/E2 每次日志、E3b 日志、探针源码与输出、观测副本补丁。
完整 SHA 与 run / job id 的对应只在那里和 GitHub 上核对；正文不复制原始长哈希。
