# QSRC1 · 额度来源分歧的诊断与一致性契约

> 只是诊断与设计文档。没有改任何 quota reader、调度器、出借、manager create、配置、额度线、身份或生产状态；
> 没有读生产凭据 / Keychain / 私有会话 / 真实 rollout，没有刷新生产缓存，没有请求提供方，没有起模型会话，没有发 lease / 订单 / 审查 epoch。
> 基线 head `8c08c97f3a0de747883953edf44010aa4af5163b`。实施另立精确正式卡；本文所列 owner 待定项在批准前**一律保持现线与原门**。

全文用四种标签区分可信度：

- **〔源〕** 已观察事实：在上述 head 的源码里逐行读到的行为（附 `文件:行`）。
- **〔探〕** 隔离探针：附录 A 的私有脚本用固定时钟、假 quota-state / 假 rollout / 假台账 meta，经**生产纯 reader**跑出的结果。只证明代码路径会这样算，不证明任何真实账户此刻的余额。
- **〔PM〕** 真实生产例子：字段原样取自 PM 只读实核材料，本文不补、不改、不推。
- **〔假〕** 假设 / 推断；**〔待定〕** 需要 owner 拍板的政策选择。

---

## 0. 结论摘要

1. 分歧的直接原因〔源〕〔探〕：两条路径喂给同一个 `selectQuotaLayers` 的**输入不同**，再由同一个 `quotaFor` 选层。
   - 路径 A（`quotaPoolTotals`，`src/lib/scheduler-agent-pool-quota.ts:21-22`）固定 `codexRollout: null`，Codex 只剩账户卡，于是拿到 `live_stale` 的 7d=95。
   - 路径 B（`readInventoryQuota`，`src/lib/ai-quota.ts:91-102`）会扫最近的 Codex rollout，账户卡不是 `live` 时多出一条 `codex.local`（identity `unknown`）；`quotaFor`（`ai-quota.ts:58-69`）在「卡非 live」时**只按 observedAt 取较新的那一整份**，不核账户、不核窗口是否同一代、不逐窗口比较，于是较新的 rollout 7d=0 整份胜出。
   - 出借额度线事实（`lend-quota-line-facts.ts`）、hello 周额度（`quota-week.ts`）、Codex 运行时门、本地兜底额度证明都吃路径 B。
2. 这不是「同账户同周的两个实时真值」：账户卡带账户键（`bound/assumed`）、rollout 不带任何账户身份（`codex-usage.ts:7` 注释、`quota-layers.ts:5-6`）。两份的 resetAt 不同〔PM〕，说明至少不能证明是同一窗口；但本文**不据此推断**换号、重置或提供方错误。
3. 现有代码在「卡非 live」时对两份做了**无身份核验的跨源 newest-wins**，这正是 PM 定 3 要排除的「跨账户合并」「更新 observedAt 自动胜出」。路径 A 恰好没走这个合并，所以两路分歧。
4. 本卡**不选**新优先级。第 5 节给最小一致性契约与三个实施选项，第 6 节列 owner 待定项；无批准时 CAP1 统一池、95 停接线、原门与 PM 例外全部不变，「后读到的 0」不构成恢复授权。

---

## 1. 真实调用链（PM 定 1）

### 1.1 共同底座〔源〕

| 层 | 位置 | 输入 | 账户绑定 | observedAt 含义 | resetAt | stale / unknown | 精度 |
|---|---|---|---|---|---|---|---|
| 订阅快照 → 远程视图 | `quota-scheduler.ts:73-95` `remoteViewOf` | `quota-state.json`（bridge 调度器写） | `st.current[p]` 指向的账户键，`identity` = `bound`/`assumed`，`uncertain` 标记 | 调度器成功读接口的时刻（`snap.observedAt`） | 接口给的 `resetsAtMs` | `stale` = 无快照 / 有 lastCode / 账户 uncertain / 超 `usageStaleMs`=10 分钟（`quota-policy.ts:25`） | `usedPct` 原数（DTO 0–100，可带小数） |
| Codex rollout | `codex-usage.ts:196-283` `lastRateLimitEvent`/`findLatestCodexQuota`/`toCodexQuota` | 全机最新 6 个 rollout 文件尾部 2MB 里最后一条 `token_count.rate_limits` | **无**（只有 plan_type 与会话 id；会话属于谁的登录不可知） | 那条 token_count 事件的 `timestamp`（真实观测，不是读取时刻） | rollout 的 `resets_at`（秒→ms） | 只有 `resetPassed`；无 stale 概念 | `Math.round` 成整数（`codex-usage.ts:158-160`） |
| statusline 缓存（Claude） | `usage-cache.ts:102-118` `readUsageCacheStale` | `usage-cache.json` / 手动读数 | **无** | `scrapedAt` | 缓存记的重置时刻；手动读数时只沿用「仍在同一窗口」的那个，否则 null | 无 | 原数 |
| 选层 | `quota-layers.ts:192-204` `selectQuotaLayers` | 上面三者 | 账户卡保留 key；`*.local` 一律 `identity:"unknown"` | 各自原样 | 原样，`resetPassed = now >= resetsAt` | 卡 `live`/`live_stale`/`none`；local 只在卡非 `live` 时出现 | — |
| 归一 | `ai-quota.ts:38-69` `fromEntry`/`quotaFor` | snapshot | **丢掉 account**：`InventoryQuota` 没有账户字段 | 选中那份的 observedAt | 原样；`resetPassed` 的窗口 `usedPct=null` | 任一窗口有数 = `known`；卡 live 有数直接用；否则 **known 的卡与 local 按 observedAt 取较新整份** | — |

关键缺口〔源〕：`quotaFor` 返回的 `InventoryQuota` 只有 `source` 没有账户键，下游无从知道这份数是哪个账户的。

### 1.2 各入口

| # | 入口 | 位置 | 读哪路 | 窗口种类 | 判据 / 阈值 | unknown / 失读时 | 适用角色与职责 |
|---|---|---|---|---|---|---|---|
| E-A1 | `quotaPoolTotals` | `scheduler-agent-pool-quota.ts:14-29` | **A**：同步读 `quota-state.json` + Claude statusline 缓存，`codexRollout: null` | weekly + weekly_scoped | `usedPct >= 线` → 这族统一池容量置 0。Claude 线 = 项目 `autostart.weeklyLinePct ?? 70`；Codex 线 = `codexWeeklyLine` 项目 `codexWeeklyLinePct`，缺省 85、合法 50–100（`quota-codex-line.ts`） | 文件缺失 = 无观测；坏文件记日志；unknown / resetPassed 窗口不置 0（容量保持） | CAP1 统一池的规划视图：`localAgentPool`（`scheduler-agent-pool-ledger.ts:68-73`）→ `scheduler-pool-facts.ts:138`、`recovery-plan-gap.ts:174`、`scheduler-agent-pool-context.ts:20`、`scheduler-agent-pool-snapshot.ts:9`，以及创建时的 `runtimePoolWait` |
| E-A2 | `runtimePoolWait` | `scheduler-agent-pool-runtime.ts:19-26` | **A**（经 `localAgentPool`） | 同上 | `running[family] >= totals[family]` → wait；totals 被 A 置 0 时即 `0>=0` 挡住 | 同上 | 受管 create 在锁内的第一道门（`withCodexSlot`，`scheduler-local-runtime-slots.ts:39-46`），仅在项目配置了 `agents` 限额时 |
| E-B1 | `poolQuotaWait` | `scheduler-agent-pool-runtime.ts:38-51` | **B** | weekly + weekly_scoped，跳过 `resetPassed` 与 `resetsAt<=now` | `usedPct >= 线`。Codex 线同 `codexWeeklyLineAt`；**Claude 线是 `DEFAULT_CODEX_LINE`=85**，不是 E-A1 用的 `weeklyLinePct`（缺省 70） | 读失败 / `status!=="known"` → 不拦（返回 null） | 受管 create 第二道门（配置了 agents 限额时，`slots.ts:49`） |
| E-B2 | `codexQuotaWait` | `scheduler-local-runtime-quota.ts:9-24` | **B** | 同上，另要求 `usedPct` 有限 | Codex 线 | 不拦 | 未配 agents 限额且 `checkQuota:true` 的受管 create（`slots.ts:50`） |
| E-B3 | `localCodexQuotaProof` | `recovery-local-fallback-plan.ts:50-61` | **B** | weekly + weekly_scoped，**必须每个都有数且未过 reset** | 正证明：都低于 Codex 线才 `ok` | 失读 / unknown / 无周窗口 / 过 reset → **不算证明（fail-closed）** | 本地兜底接管（恢复）前的额度证明 |
| E-B4 | `refreshQuotaFacts`/`factsNow` → `familyLine` | `lend-quota-line-facts.ts:43-125`、`lend-quota-line.ts:66-93` | **B**（60 秒缓存）→ `weekOf` → 合并进 `lend-quota-line-facts.json` | 只 `kind==="weekly"`（**不含 weekly_scoped**，`quota-week.ts:24`） | 出借家族线 `warnPct`/`stopPct`（缺省 70/80，`lend-quota-line-config.ts:25`），`>=`；`stop`→hello total 置 0、claim 末刻不领；`warn`→减半 | 失读 → 沿用本代窗口的旧事实；无事实 = `unknown` = **不收窄** | 出借方 hello slots（`lend-hello.ts:131`）、claim 末刻（`lend-drive.ts:135`）、网页 `/lend/quota-lines`（`bridge/local-api/lend-quota-lines.ts`） |
| E-B5 | `readWeekQuota` → hello `quota` | `quota-week.ts:42-52`、`lend-hello.ts:72-76`、`lend-deps.ts:180` | **B**（60 秒缓存） | 只 weekly | 无阈值，「只做参考，派单不看它」（`quota-week.ts:5`） | 失读 → `{}`；过 reset → 不报 | 借入方展示（`lend-peers-view.ts:46`）；**整数化后不带 source / observedAt** |
| E-B6 | `quotaViewOf` | `lend-health.ts:117-124`；`lend-deps.ts:198`、`lend-claude-worker-capacity.ts:40` | **B** | 所有 pct 窗口 | 只认 `usedPct >= 100`（满）→ 暂停借单到 resetAt | unknown → `full:null` | 出借 worker 撞额度后的暂停与 Claude 出借探针 |
| E-B7 | autostart Claude 门 | `scheduler-autostart-run.ts:122-133`、`scheduler-autostart.ts:97-99`、`scheduler-autostart-deps.ts:115` | **B**（Claude） | weekly + weekly_scoped | `weeklyLine`（缺省 70） | 不拦 | 自动开工、项目本地作者为 Claude 时 |
| E-W1 | 网页额度看板 | `bridge/quota-service.ts:100-121, 211-226` | 调度器实时 view + 本机 rollout（`withCodexQuota`）+ statusline | 全部 | 无阈值 | 账户卡与 `*.local` **并列展示**，不合并、不选层 | 仅展示 |
| E-W2 | 额度闸（Claude 撞墙） | `bridge/quota-service.ts:170-180` | 只认账户卡且 `layer==="live"` | 5h + 7d 取高 | 额度闸自己的规则 | 非 live → `pct:null` | Claude 撞墙恢复判据 |
| E-W3 | `ai-inventory` / doctor | `ai-inventory.ts:147-175` | **B** | 全部 | 无 | 照报 unknown | 展示 / 出借声明附带 |
| E-M1 | 手动 `manager create` | `manager.ts:2311-2316` → `cmdCreate`（`manager.ts:457`） | **无** | — | **不经任何额度门或统一池** | — | 用户 / PM 手开。用户自建会话不计统一池是既有 owner 约定 |
| E-M2 | 受管 create | `scheduler-local-runtime-start.ts`（`runLocalStart`/`localAutostart`/`localEnsure`）、`scheduler-local-author.ts:105` | 配 agents 限额：E-A2 + E-B1；未配：Codex 走 E-B2 | 见上 | 见上 | 见上 | 调度器开的作者 / 审查会话 |
| E-M3 | 修复策略 Codex create | `fix-strategy-lifecycle.ts:157` | **无额度门**：`withCodexSlot` 只给了 registry/lock/ledger，没给 `project`（不进 agents 限额分支）也没给 `checkQuota` | — | 只数全机 Codex 会话 ≤6 | — | 〔源〕已观察；是否故意由 owner 判断，本卡不改 |

〔源〕补充：E-A2 在 E-B1 之前执行（`slots.ts:42-49`），所以**配了 agents 限额的受管 create 在两路分歧时由路径 A 挡住**（总量 0），路径 B 放行也开不出来；单靠 B 判的入口是 E-B2（未配限额）、E-B3、E-B4、E-B5、E-B6、E-B7。

### 1.3 阈值一览〔源〕

| 线 | 存放 | 缺省 | 消费者 |
|---|---|---|---|
| 项目 Claude 周线 `weeklyLinePct` | 台账 meta `autostart` | 70 | E-A1、E-B7 |
| 项目 Codex 周线 `codexWeeklyLinePct` | 台账 meta `autostart` | 85（合法 50–100） | E-A1、E-B1(codex)、E-B2、E-B3 |
| `DEFAULT_CODEX_LINE` 常量 | 代码 | 85 | **E-B1 的 Claude 族**（与 E-A1 的 Claude 线不同源） |
| 出借家族线 warn/stop | `lend-quota-lines` 配置 | 70/80 | E-B4 |
| 满额 | 代码 | 100 | E-B6 |

〔PM〕真实例子中项目 Codex 线为 95。所有比较符都是 `>=`。

---

## 2. 两条路径为何得到不同选层输入及优先级（PM 定 2）

### 2.1 输入差异〔源〕

```
路径 A  quotaPoolTotals:  selectQuotaLayers({ remote: remoteViewOf(state, now, true),
                                             local: { claudeCache: readUsageCacheStale(now), codexRollout: null } })
路径 B  readInventoryQuota: selectQuotaLayers({ remote: remoteViewOf(state, now, enabled),
                                             local: { claudeCache, codexRollout: toCodexQuota(findLatestCodexQuota()) } })
```

`quotaPoolTotals` 文件头注释写明「同步规划只读缓存观测；创建时仍用完整 inventory reader」——不扫 rollout 是因为它在同步规划路径里、扫 rollout 是异步且不便宜。这是**有意的职责分工**（同步规划 vs 创建前复核），不是笔误；问题在于两份输入进入 `quotaFor` 后**选层规则会因多了一条 local 而翻转**。

### 2.2 选层优先级〔源〕

`quotaFor(snap, "codex")`：

1. 账户卡 `known` 且 `live` → 直接用卡。
2. 否则把 `known` 的卡（`live_stale`）与 `known` 的 `codex.local` 按 `observedAt` 降序取第一份**整份**（`ai-quota.ts:64-65`）。
3. 都不 known → 卡 / local / unknownQuota。

因此当卡为 `live_stale` 时：

- A：只有卡 → 卡（7d=95）。
- B：卡 vs local，local 观测更新 → local 整份（7d=0）。卡的 7d 窗口**被整份丢弃**，即使 local 根本没有 7d 窗口（见 E4）。

### 2.3 事实层再放大〔源〕

`lend-quota-line-facts.ts` 的 `mergeReport`/`combined` 同样按 observedAt newest-wins，并把胜出事实落盘。注释的本意是「真正更新的低读数（重置卡 / 账号修正）能恢复」，但实现**不核账户也不核 resetAt 是否同代**，所以：

- 一份无身份的 local 0 一旦落盘，在它自己的 resetAt 之前，任何观测更早的读数（包括同账户 `live_stale` 95）都盖不掉它（E7）。
- `weekOf` 只取 `kind==="weekly"`，丢掉 `weekly_scoped`；hello 的 `QuotaReport` 再丢掉 source 与 observedAt。

### 2.4 隔离复现〔探〕

附录 A 脚本，固定时钟 `T`，Codex 项目线 95，出借线 70/80，假账户 `acct-fake`（bound）。`A_*` 栏是**真实 `quotaPoolTotals`**（经 `CLAUDESTRA_STATE_DIR` 指向探针目录读假 `quota-state.json`、假台账 meta）；`B_*` 栏是**真实 `readInventoryQuota`**（注入假 state 与假 rollout）再交给真实 `poolQuotaWait`/`codexQuotaWait`/`localCodexQuotaProof`/`factOf`/`mergeReport`/`familyLine`/`reportOf`/`quotaViewOf`。

| 例 | 输入 | A：source / 账户 / observedAt / 7d@resetAt → 池 Codex 总量(配 2) | B：source / 账户 / observedAt / 7d@resetAt | B 各门输出 |
|---|---|---|---|---|
| E1 分歧本体 | 卡 live_stale（T-3h）5h=40、7d=95@T+30h；rollout（T-10m）5h=0、7d=0@T+140h | live_stale / acct-fake bound / T-3h / 95@T+30h → **0** | local_cache / **unknown** / T-10m / 0@T+140h | poolQuotaWait 放行；codexQuotaWait 放行；proof **ok**；线事实 0 `below` limit none；hello 0 |
| E2 rollout 更旧 | 同 E1，但 rollout 观测 T-5h | 同 E1 → 0 | live_stale / bound / T-3h / 95@T+30h | 三门均挡「达到 95% 线」；线事实 95 `stop` limit zero |
| E3 rollout 失读 | 同 E1，rollout 读抛错 | 同 E1 → 0 | 退回 live_stale 95 | 同 E2（B 结果随 rollout 能否读到而翻转） |
| E4 不完整窗口 | 同 E1，但较新 rollout 只有 5h=3 | 同 E1 → 0 | local_cache / unknown / T-10m / **无 7d** | poolQuotaWait、codexQuotaWait **放行**（卡的 95 被整份丢弃）；proof 拒「没有周额度窗口」；线事实 unknown、不收窄 |
| E5 已过 reset | 卡（T-40h）7d=95@T-1h，无 rollout | live_stale，7d `null(passed)` → **2**（不置 0） | 同 A，status unknown | 门放行；proof 拒「应已重置未确认」；线事实 unknown；`quotaViewOf.full=null` |
| E6 只有 local | 无账户卡；rollout 7d=0@T+140h | unknown → 2 | local_cache / unknown / T-10m / 0 | 门放行；proof **ok**；线事实 0 below |
| E7 重读不变新 | E3 的读数 + 已落盘事实 local_cache 0（T-10m，reset T+140h） | 同 E1 → 0 | 本次 live_stale 95 | 门挡（95）；**线事实仍是旧的 local_cache 0 `below`**；hello `weekReport` 却报 95 |

E1 精确重现了〔PM〕所述现象的**结构**：A 得 live_stale 95 → 有效 Codex 容量 0；B 及出借事实得 local_cache 0、重置时刻不同。E7 进一步显示同一台机器同一时刻：受管门说 95、出借线说 0、hello 参考说 95——三处互相矛盾。

〔探〕的边界：只说明代码在这些输入下怎么算。真实生产里那份 0 来自哪个登录、哪一代窗口，探针**不能**也**没有**回答。

### 2.5 真实生产例子〔PM〕

PM 只读实核：前一路（A）得 `live_stale/known` 7d=95、项目线 95、有效 Code 容量 0；后一路（B）及出借事实得 `local_cache/known` 7d=0，且重置时刻不同。原 N8A8F 曾以该 0 读数经手动 create（E-M1，不经调度门）开会话——这是**已报过程事实**，保留原样，不是额度批准，也不证明当时额度可用。真实 observedAt / resetAt 原值以 PM 材料为准，本文不复写也不推测。

---

## 3. 来源与冲突决策表（PM 定 3）

术语：**合格周事实** = 有窗口种类（weekly / weekly_scoped，带模型）、有限 usedPct、resetAt 在未来、真实 observedAt 不在未来、来源层明确、且**账户资格**已核（见 5.1）。

| # | 场景 | 现行为〔源〕〔探〕 | 契约要求（本文提议） | 反例（不允许） |
|---|---|---|---|---|
| D1 | 同账户同周（同账户键 + 同窗口种类 + 同 resetAt 代） | 卡 live 直接用；卡 stale 时与 local 比 observedAt | 同一身份同一代窗口内，取 observedAt 最新的那份；live 优先于同 observedAt 的 stale | 读取时刻冒充 observedAt；把重读到的旧快照当新 |
| D2 | 身份未知（rollout / statusline 无账户键） | 与账户卡按 observedAt 合并，可胜出（E1、E6） | **不得**进入受管门 / 停接解除的判定；只作展示参考，或作为「同样超线」的佐证（只能更保守） | 无身份 0 解除停接（E1）；无身份 0 构成恢复正证明（E1、E6 proof ok） |
| D3 | 不同账户（键不同或无法核同） | 无法识别，等同 D2 | 不合并、不比较新旧；各自独立呈现；以当前绑定账户（`st.current`）为准 | 跨账户取低 / 取高 / 取新；用 resetAt 日期猜是不是同一账户 |
| D4 | 不同窗口（5h vs 7d、weekly vs weekly_scoped、resetAt 不同代） | `quotaFor` 整份取舍；`weekOf` 丢 weekly_scoped | 逐窗口种类判；缺某窗口 = 该窗口 unknown，不能拿另一份缺的窗口覆盖已有窗口 | 较新 local 只有 5h，就丢掉卡的 7d=95（E4） |
| D5 | 过期 / 已过 reset 未确认 | usedPct→null，unknown；规划与运行时门不拦，proof 不认（E5） | 保持：unknown ≠ 0。是否 fail-open 维持各入口原职责（见 5.2） | 把 passed 推成 0；沿用旧值 |
| D6 | 真实新周已观测（同账户，新 resetAt 代的 live 读数） | 卡 live → 直接用 | 只有**同账户**的新代读数（live，或同账户 stale 但 resetAt 晚于旧代）才更新该窗口 | 无身份 rollout 的新 resetAt 被当成「已重置」 |
| D7 | live_stale 与更新的 local_cache 冲突 | B 取 local（E1），A 取卡（E1） | 冲突状态显式化为 `conflict`：停接 / 统一池保持较保守那侧，直到出现 5.3 的解除证据 | 后读到的 0 自动当恢复授权 |
| D8 | local 失读 / 缓存重读 | B 退回卡（E3）；事实层沿用旧事实（E7） | 失读 = 该源本轮无观测，不改结论；重读同一 observedAt 不算新观测 | 结论随 rollout 能否读到而来回翻转；重读把旧快照变新 |
| D9 | 不完整窗口（缺 7d / 缺 usedPct / 缺 resetAt） | proof 拒；门放行；线事实 unknown（E4） | 缺的窗口记 unknown；不得把同一身份已知的那个窗口覆盖掉 | 用「没有 7d」等价「7d=0」 |

---

## 4. 已有职责不为「统一」而删（PM 定 1 补充）

〔源〕各入口对 unknown 的处理**故意不同**，契约必须保留：

- 规划 / 运行时门（E-A1、E-A2、E-B1、E-B2、E-B7）：unknown **不拦**——调度不能因额度读不到而停摆，下游撞额度另有报警与暂停（E-B6、额度闸）。
- 恢复接管正证明（E-B3）：unknown **不算证明**——接管是额外动作，必须正面证明低于线。
- 出借线（E-B4）：unknown **不收窄**，交回 QP1 原有未知处理。
- 展示（E-W1、E-B5、E-W3）：如实标 unknown / 来源 / 观测时刻，不当 0 也不当满。

契约只统一「什么样的事实**有资格**进入判定」，不统一「unknown 时放不放」。

---

## 5. 最小一致性契约与实施选项（PM 定 4）

### 5.1 契约 C1：合格事实（全部入口共用的输入资格）

一份周额度读数要进入任一**判定**入口（E-A1/2、E-B1/2/3/4/6/7），必须同时具备：

1. `windowKind` + `windowMinutes`（+ weekly_scoped 的模型）；逐窗口独立，不整份取舍。
2. 有限 `usedPct`，保留原精度；比较前不再取整（整数化只在 hello 展示）。
3. `resetAt` 在未来；`observedAt` 是真实观测时刻、不在未来（沿用 `FUTURE_SKEW_MS`）。
4. `layer`（live / live_stale / local_cache）原样保留。
5. **账户资格**：`account.key` 等于当前绑定账户 `st.current[family]` 且 `uncertain=false`。不具备账户键的读数（rollout、statusline）资格 = `unbound`。

### 5.2 契约 C2：判定规则

- `unbound` 读数**只能让结论更保守**（例如它也 ≥ 线时可作为佐证），**不能**单独解除停接、构成恢复正证明或抬高统一池容量。
- 同一账户同一窗口种类：同代（resetAt 一致）取 observedAt 最新；新代仅当来自同账户。
- 冲突（D7）：判定入口取保守侧，状态标 `conflict` 并给出两份的 source / observedAt / resetAt，供网页与 PM 看。
- unknown 行为维持第 4 节各入口原职责，不在本契约里改。
- 展示入口（E-W1、E-B5、E-W3）可显示 unbound 读数，但要带「来源 / 身份未知 / 观测时刻」，不得标成可用额度。

### 5.3 契约 C3：解除停接 / 恢复需要的证据

满足任一：

1. 同账户 `live` 读数显示该窗口低于线；或
2. 同账户读数显示进入新的 resetAt 代且低于线；或
3. owner 明确的人工批准（按钮 / 记录在案）。

**不构成**解除证据：后读到的 0、无身份 rollout 0、resetAt 已过（未确认）、读不到、同一旧快照被重读。

### 5.4 实施选项（仅列出，不批准）

| 选项 | 做法 | 好处 | 代价 / 风险 |
|---|---|---|---|
| O1 最小：B 路判定不吃 unbound | `quotaFor` 增加「判定模式」：卡非 live 时，`*.local` 不参与判定选择，只回卡（或 unknown）；展示模式保持现状 | A/B 两路在判定上一致（都看卡）；改动面最小 | 卡长期 stale / 未配凭据的机器上，Codex 判定会更常是 unknown（门放行、proof 不 ok、出借线不收窄）——unknown 行为有变化需 owner 确认 |
| O2 逐窗口合格事实 | 新增 `QualifiedQuotaFact`（带账户键、窗口种类、layer、observedAt、resetAt），所有判定入口与 `lend-quota-line-facts` 改吃它；事实文件按账户键 + 窗口代分格 | 完整覆盖 D1–D9；修 E4、E7 | 改动面大（facts 文件格式、hello、网页）；需要迁移 |
| O3 只加冲突态 | 不改选层，只在 A/B 不一致时标 `conflict` 并让判定入口取保守侧 | 不改来源优先级 | 仍保留 unbound 合并；只是止血 |

推荐顺序〔假〕：O1 先止住「无身份 0 解除停接 / 构成证明」，O2 作为后续正式卡；但选哪个、何时做由 owner 定。

---

## 6. owner 待定项（不批准实现）

1. 来源优先级：判定入口是否完全排除 unbound 读数（O1），还是允许其作为保守佐证。
2. unknown 行为：卡长期 stale 时 Codex 判定变 unknown，门是否仍 fail-open。
3. 停接比较符与 95 线：维持 `>=` 与项目 Codex 线 95（本文不动）。
4. E-B1 的 Claude 线用 `DEFAULT_CODEX_LINE`(85) 与 E-A1 的 `weeklyLinePct`(70) 不同源：是否统一、统一到哪条。
5. 出借事实 `weekOf` 不含 weekly_scoped：是否纳入。
6. 手动 create（E-M1）与修复策略 Codex create（E-M3）不经额度门：维持既有 owner 约定与 PM 例外，是否给受管卡会话的手动 create 加门，需 owner 决定；本卡**不**擅自给所有 create 加门。
7. 已落盘的 `lend-quota-line-facts.json` 中 unbound 事实的处置（实施时迁移策略）。

无批准时：保持现线（项目 Codex 95、出借线现值）、现门、CAP1 机器 / 项目 / 家族统一池、跨族审查、已开始任务 / 未结结果 / 保全与正式恢复规则全部不变。

---

## 7. 本卡不宣称的事

- 不证明真实额度余额是 0 或 95，不证明提供方错误、账户切换或已重置。
- 不宣称 S2D2 已恢复，不宣称源冲突已实现修复。
- N8A8F 以 0 读数开会话的事实保留，不改写为正式额度批准。
- 私有探针不是正式验收，也不是生产修复；没有写进产品代码或 tests/。

---

## 附录 A · 隔离探针（私有，不入产品）

运行方式：`S` 为任一含 `qsrc1` 的空目录；脚本自检 `STATE_DIR` 必须含 `qsrc1` 才继续，所以不会落到真实状态目录。不读真实 rollout（`readInventoryQuota` 全部依赖注入），不读凭据，不联网。

```
CLAUDESTRA_STATE_DIR=$S/qsrc1-state CLAUDESTRA_RUNTIME_DIR=$S/qsrc1-rt bun qsrc1-probe.ts <repo>
```

```ts
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const repo = process.argv[2]!;
const L = (p: string) => import(join(repo, "src/lib", p));
const { emptyQuotaState } = await L("quota-state.ts");
const { remoteViewOf } = await L("quota-scheduler.ts");
const { selectQuotaLayers } = await L("quota-layers.ts");
const { quotaFor, readInventoryQuota } = await L("ai-quota.ts");
const { quotaPoolTotals } = await L("scheduler-agent-pool-quota.ts");
const { poolQuotaWait } = await L("scheduler-agent-pool-runtime.ts");
const { codexQuotaWait } = await L("scheduler-local-runtime-quota.ts");
const { localCodexQuotaProof } = await L("recovery-local-fallback-plan.ts");
const { factOf, mergeReport } = await L("lend-quota-line-facts.ts");
const { familyLine } = await L("lend-quota-line.ts");
const { reportOf } = await L("quota-week.ts");
const { quotaViewOf } = await L("lend-health.ts");
const { STATE_DIR } = await L("paths.ts");

const H = 3600_000, NOW = Date.UTC(2026, 0, 15, 12, 0); // synthetic clock
const R_STALE = NOW + 30 * H, R_ROLL = NOW + 140 * H;
const dir = STATE_DIR as string;
if (!dir.includes("qsrc1")) throw new Error(`refusing: state dir ${dir} is not the probe dir`);
mkdirSync(dir, { recursive: true });
const ledger = join(dir, "ledger.db");
rmSync(ledger, { force: true });
const db = new Database(ledger);
db.run("CREATE TABLE meta (project TEXT, key TEXT, value TEXT)");
db.run("INSERT INTO meta VALUES ('P','autostart',?)", [JSON.stringify({ weeklyLinePct: 70, codexWeeklyLinePct: 95 })]);
const lines = { status: "ok", file: { v: 1, mode: "on", families: { claude: { warnPct: 70, stopPct: 80 }, codex: { warnPct: 70, stopPct: 80 } } } };

type W = { id: string; usedPct: number; resetsAtMs: number; minutes: number };
function state(obs: number | null, wins: W[]) {
  const st = emptyQuotaState();
  if (obs === null) return st;
  st.current.codex = "acct-fake";
  st.accounts["acct-fake"] = { provider: "codex", identity: "bound", uncertain: false, rateLimitedUntil: null, lastSeenAt: obs, health: {},
    snapshots: { codex_usage: { observedAt: obs, data: { plan: null, limitReached: false, balance: null, resetCredits: null,
      windows: wins.map((w) => ({ id: w.id, kind: w.minutes === 300 ? "session" : "weekly", usedPct: w.usedPct, resetsAtMs: w.resetsAtMs,
        windowMinutes: w.minutes, severity: null, scopeModel: null })) } } } };
  return st;
}
const roll = (obs: number, wins: W[]) => ({ source: "codex-rollout", plan: null, credits: null, limitReached: null, observedAt: obs,
  sessionId: "fake", cwd: null, agent: null,
  windows: wins.map((w) => ({ id: w.id, windowMinutes: w.minutes, pct: w.usedPct, resets: "", resetsAtMs: w.resetsAtMs, resetPassed: w.resetsAtMs <= NOW })) });
const w7 = (usedPct: number, resetsAtMs: number): W => ({ id: "7d", usedPct, resetsAtMs, minutes: 10080 });
const w5 = (usedPct: number, resetsAtMs: number): W => ({ id: "5h", usedPct, resetsAtMs, minutes: 300 });
const brief = (q: any) => q && { status: q.status, source: q.source, observedAt: q.observedAt === null ? null : `T${(q.observedAt - NOW) / H}h`,
  windows: q.windows.map((w: any) => `${w.id}:${w.usedPct}@${w.resetsAtMs === null ? null : `T+${(w.resetsAtMs - NOW) / H}h`}${w.resetPassed ? "(passed)" : ""}`) };

async function run(name: string, st: any, rollout: any, opts: { rolloutThrows?: boolean; prev?: any } = {}) {
  writeFileSync(join(dir, "quota-state.json"), JSON.stringify(st));
  const snapA = selectQuotaLayers({ now: NOW, enabled: true, remote: remoteViewOf(st, NOW, true), local: { claudeCache: null, codexRollout: null } });
  const totals = quotaPoolTotals(db, "P", { claude: 2, codex: 2 }, NOW);
  const inv = await readInventoryQuota({ now: NOW, enabled: () => true, loadState: async () => st, claudeCache: () => null,
    codexRollout: async () => { if (opts.rolloutThrows) throw new Error("fake read failure"); return rollout; } });
  const read = async () => inv.codex;
  const pw = await poolQuotaWait("codex", read, NOW, { project: "P", ledgerPath: ledger });
  const cw = await codexQuotaWait(read, NOW, { project: "P", ledgerPath: ledger });
  const proof = await localCodexQuotaProof(read, NOW, { project: "P", ledgerPath: ledger });
  const facts = mergeReport(opts.prev ?? {}, { codex: inv.codex }, NOW);
  const fl = familyLine("codex", { lines, facts }, NOW);
  console.log(JSON.stringify({ case: name,
    A_pool_view: brief(quotaFor(snapA, "codex")), A_quotaPoolTotals_codex: totals.codex,
    B_inventory: brief(inv.codex), B_poolQuotaWait: pw?.reason ?? null, B_codexQuotaWait: cw?.reason ?? null,
    B_localCodexQuotaProof: proof.ok ? "ok" : proof.why, B_factOf: factOf(inv.codex, NOW) ?? null,
    B_lineFact: { used: fl.weekUsedPct, source: fl.source, state: fl.state, limit: fl.limit },
    B_weekReport: reportOf(inv, NOW).codex ?? null, B_lendHealthView: quotaViewOf(inv.codex) }, null, 1));
}

const stale95 = state(NOW - 3 * H, [w5(40, NOW + 2 * H), w7(95, R_STALE)]);
await run("E1 live_stale 95 vs newer rollout 0, different reset", stale95, roll(NOW - 10 * 60_000, [w5(0, NOW + 5 * H), w7(0, R_ROLL)]));
await run("E2 rollout older than live_stale", stale95, roll(NOW - 5 * H, [w5(0, NOW + 5 * H), w7(0, R_ROLL)]));
await run("E3 rollout read fails", stale95, null, { rolloutThrows: true });
await run("E4 newer rollout has only 5h window (incomplete)", stale95, roll(NOW - 10 * 60_000, [w5(3, NOW + 5 * H)]));
await run("E5 live_stale 7d reset passed, no rollout", state(NOW - 40 * H, [w7(95, NOW - H)]), null);
await run("E6 no account card at all, rollout 0", state(null, []), roll(NOW - 10 * 60_000, [w7(0, R_ROLL)]));
await run("E7 facts re-read: prev local_cache 0 (newer) then only live_stale 95",
  stale95, null, { rolloutThrows: true, prev: { codex: { weekUsedPct: 0, resetAt: R_ROLL, observedAt: NOW - 10 * 60_000, source: "local_cache" } } });
db.close();
```

附录 B · 本人校验记录见交付自查（selfcheck），不在本文重复，以免文档内容随 CI 结果过期。
