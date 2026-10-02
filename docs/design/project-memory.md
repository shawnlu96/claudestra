# 项目记忆：台账 / DAG 存「总结 + 坑」，开工前三路取相关记忆

状态：设计稿（pmem-D1），只出设计、不改代码。基线 4a4d1f3f。与 i28-SYNC1（台账同步）并行，边界见 §7、§10。
定位与卖点不在本稿（仓库公开），由 PM 另放私密文档。

## 0. 一句话结论

台账已经是一张结构干净的图（feature → DAG 版本 → 节点 → 卡 → 事件），缺的只是**提炼过的东西**。本稿新增一类只追加的
「记忆」行（总结 / 坑 / 决定三种），由机器在固定时机写、人用 MCP 工具补；开工单和审查单生成时按**图上相邻、改同一批
文件、语义相近**三路取候选，用 RRF 合并，按条数 / 字节上限写进单子的一节「项目记忆」。坑挂上「修它的卡」，那张卡合并后
自动标「已修」，之后不再推。向量只是本机派生缓存，不同步、不上中心；没有嵌入模型时退化成两路，照样能用。

现状对照：

- 台账 `events.kind` 有 `stage / note / deliver / review / decision / …`（`src/lib/ledger-stages.ts`），没有总结和坑。
- 审查结论已经结构化：`ReviewFinding {findingId, family, severity, probe}`（`src/lib/scheduler-review.ts`），
  `p1FindingStreak` 已能按 findingId / 归一化 family 数连续 P1——「同类 P1 自动沉淀成坑」直接复用这套口径。
- 合并后实际改动的文件已能拿到（`src/lib/ledger-verify-facts.ts` 的 PR files / 本地 git 推断）；DAG 节点带 `fileGlobs`
  （`src/lib/dag-tools-plan.ts` 强制非空）。文件这一路不需要新采集。
- PM 的几十条「自动卡卡点」经验在 PM 私人记忆（mem0 / 本地文件），换 PM、新执行者都看不到 → §8 一次性导入。

---

## 1. 记忆单元

**结论：新表 `memories`（内容只写一次）+ 新表 `memory_marks`（状态变化只追加），每次写入另追加一条
`events.kind = 'memory'` 事件做时间线。不做成「只是一种新事件」。**

理由：事件的 `text/data` 是自由 JSON，没有锚点列可建索引（按文件、按 family 查要全表扫 JSON）；坑要有状态
（开放 / 修复中 / 已修 / 撤回），状态要能按图查。但状态又不能原地改——否则就不再是「只增数据」、同步时会冲突（§7）。
所以内容冻结、状态走只追加的 mark，当前状态 = 按固定顺序折叠 marks。这和 `dag_proposals`（内容列 trigger 冻结）、
`dag_bindings`（只追加，读时并进快照）是同一种做法。

### 1.1 `memories`（内容冻结）

| 列 | 说明 |
|---|---|
| `id` | 全局 id `<本机前缀>-m<originSeq>`，前缀与 `ledger_instance.origin` 同（`docs/design/feature-dag.md`「全局编号」） |
| `origin` / `originSeq` | 写入方前缀 + 该前缀下单调序号，`UNIQUE(origin, originSeq)`——同步的合并键 |
| `project` | 项目 |
| `kind` | `summary` 卡完成总结 / `pitfall` 坑 / `decision` 决定 |
| `featureId` / `nodeKey` / `taskId` | 图上锚点，可空（项目级的坑三个都空）；`taskId` 有值时 `featureId` 取卡当时的 featureId |
| `files` | JSON 数组，仓库相对路径或 glob（≤20 项）；总结 = 合并实际改动文件，坑 = 作者给的范围 |
| `family` | 坑的归一化 family（与 `ReviewFinding.family` 同字符集 `[\w.-]{1,64}`），可空 |
| `title` | ≤80 字节一句话 |
| `body` | 总结 ≤600 字节；坑 = `{symptom, rule}` 两段各 ≤300 字节（症状 / 怎么避免）；决定 = 原文截 ≤600 字节 |
| `fixable` | 坑才有：1 = 代码缺陷，能被某张卡修掉；0 = 规矩 / 环境特性（如「多语句 exec 吞运行期错误」），永不自动过期 |
| `sources` | JSON 数组，来源事件引用 `{origin, originSeq}`（老事件没有 origin 的用 `{seq}`，只在本机有效）；导入的可空，但要 `sourceNote` |
| `sourceNote` | 无来源事件时的出处说明（≤200 字节），如「PM 私人记忆导入」 |
| `via` | `verify_summary` / `p1_family` / `tool` / `decision_index` / `import` |
| `author` / `authorRole` | 写入者代号（`agent-x` 或 `peer:<代号>`）与角色（executor / reviewer / pm / owner / system） |
| `head` / `specRev` | 写入时卡的 head 与 specRev（总结、坑必填，给「截至哪版代码」） |
| `visibility` | `team`（可进共享台账，过脱敏闸）/ `home`（只在主场）；默认 `team`，脱敏闸拒时降为 `home` 并提示 |
| `redactionVersion` / `digest` | 写入时过的脱敏规则版本、`sha256(title+body+files)`（§7 判重 / 同步校验） |
| `createdAt` | |

trigger 拦 UPDATE / DELETE / 同键 INSERT（同 `dag_versions`）。写错了不改行，走 §4 的 retract / supersede。

### 1.2 `memory_marks`（只追加）

| 列 | 说明 |
|---|---|
| `memoryId` / `origin` / `originSeq` / `ts` / `actor` | 同上，`UNIQUE(origin, originSeq)` |
| `mark` | `confirm` / `link_fix` / `unlink_fix` / `fixed` / `reopen` / `dispute` / `retract` / `supersede` |
| `taskId` | `link_fix` / `fixed` / `reopen` 指修它的卡 |
| `by` | `supersede` 指新记忆 id |
| `reason` | ≤300 字节；`dispute` / `retract` 必填 |
| `source` | 触发它的事件 `{origin, originSeq}`（自动 mark 必填：如修复卡进 `live` 的那条 stage 事件） |
| `dedupKey` | 自动 mark 用 `auto:<mark>:<memoryId>:<taskId>:<来源事件>`，`UNIQUE`——多处观察到同一件事只记一条 |

**状态折叠**（`memoryStatus(memory, marks)`，纯函数）：按 `(ts, origin, originSeq)` 全序排 marks，从初始状态
（PM / 审查员 / owner / 系统确认的写入 = `open`；执行者写的、自动沉淀的 = `candidate`）依次应用：

```
candidate --confirm--> open
open --link_fix--> fixing --fixed--> fixed --reopen--> open
fixing --unlink_fix--> open
任意 --dispute--> 同状态 + disputed 标（PM confirm 清掉）
任意 --retract / supersede--> 终态（之后的 marks 只记录不生效）
```

总结与决定只用 `dispute / retract / supersede`；`fixed` 只对 `fixable = 1` 的坑生效。

### 1.3 三种记忆和现有事件的关系

- **决定**：不另写原文。owner 决定已经是 `decision` 事件，索引器为每条「非 ask 噪声」的 decision 事件生成一行
  `kind = decision, via = decision_index`，id 由来源事件确定（`<事件 origin>-d<事件 originSeq>`），重放 / 多机生成同一行，幂等。
  ask 作答的 decision（`data.askId`）只收 `kind ∈ {decide, authorize}` 的业务 ask，不收 permission / AUQ。
- **总结 / 坑**：内容在 `memories`，同时追加一条 `events.kind = 'memory'`（target = 锚点卡 / feature，`data = {memoryId, kind, mark?}`）。
  事件只做时间线与审计，不复制正文；`isAskEvent` 同样把它排除在「卡的最近一条」之外，免得盖掉问题态。
- **脱敏级别**：见 `visibility` / `redactionVersion`；规则沿用共享台账的「白名单 → 脱敏 / 敏感命中 → 预览 → 签名上传 → 中心复核」（§7）。

---

## 2. 谁来写、什么时候写

### 2.1 卡完成总结

**结论：调度器在卡进 `verified`（ops / investigate 进 `done`）时生成。先用模板机械拼出事实部分，再让便宜模型写一句
「教训」；模型不可用就只留事实部分。执行者交付时不另写总结。**

- 不让执行者写：交付发生在审查前，还不知道哪些 P1 被打回、最后怎么修的；而且是「自己总结自己」，容易写成表功。
  执行者 `deliver` 现有的 `summary`（≤500 字节）作为输入之一用。
- 不让 PM 写：PM 是瓶颈，几十张卡一个 PM，写总结会被跳过（与「不靠提示词」同理）。
- **事实部分（无模型，必有）**：标题、轮数、每轮 P1 的 family 列表与是否在下一轮消失、改动文件（verify facts 已有）、
  卡生命周期内的 decision 摘要、最后一轮 deliver summary。拼成 ≤400 字节。
- **教训一句（可选，便宜模型）**：输入 = 上面的事实 + 各轮 P1 probe（按 `fitFindings` 同法压到 ≤4KB）+ 规格前 1KB，
  约 3–6K token 输入、≤150 token 输出，要求「只写下一个改这些文件的人该知道的一句话；没有就输出 NONE」。
  按 Claude Haiku 4.5 公开价（输入 $1 / 输出 $5 每百万 token，以 <https://platform.claude.com/docs/en/about-claude/pricing> 为准）
  每张卡约 **$0.004–0.007**；一天 30 张卡不到 $0.25。走本机已配置的模型端点（`ai-endpoints.ts`），没配就跳过。
- 一轮就过、没有 P1、改动 ≤2 个文件的卡：只写事实部分，不调模型（大部分卡落在这里，成本再降）。

### 2.2 坑

**结论：两条入口——人用 MCP 工具 `record_memory` 显式记；调度器把「同类 P1 反复出现」自动沉淀成候选坑。
不靠提示词让模型「记得记」。**

工具（在 `order-tools` 同一套鉴权下，身份来自 verified 会话，不收 body 里的 actor / role）：

| 工具 | 谁 | 作用 |
|---|---|---|
| `record_memory` | 执行者 / 审查员 / PM | 记坑或总结补充：`{kind: "pitfall", title, symptom, rule, files, family?, fixable, orderId?}`；带 orderId 时锚点取那张卡 |
| `mark_memory` | 见 §4 权限表 | `confirm / dispute / retract / supersede / link_fix / unlink_fix` |
| `show_memory` | 有台账读权的人 | 按 id 取全文与 marks 历史（单子里只放摘要） |

- **审查员**：`submit_verdict` 的逐项结论加可选 `pitfall: true`（只对 P1 有意义），表示「这不只是这张卡的错，是会再犯的坑」。
  调度器在 verdict 落库后用这条 finding 的 family / probe 生成 `open` 坑（审查员背书），`sources` = 该 review 事件。
- **执行者**：`record_memory` 写进来是 `candidate`，不进开工单；PM 在待办里批量 `confirm`。
- **自动沉淀**（调度器观察器，`via = p1_family`）：同一项目里，同一归一化 family 的 P1 在 **30 天内出现在 ≥2 张不同的卡**，
  或单卡 `p1FindingStreak ≥ 2`，且没有同 family 的 open / fixing 坑 → 写一条 `candidate` 坑：title 取最近一条 probe 首句，
  `files` = 这些卡改动文件的交集（空则并集前 5 个目录 glob），`sources` = 所有命中的 review 事件。
  出现在 **≥3 张卡** 自动 `confirm`（三次已经不是偶然）。已有同 family 的 open / fixing 坑则不新开，只给它追加一条带 source 的
  `confirm` mark（状态不变，来源变多）——避免同一个坑长出十条。

### 2.3 防噪音：不记什么

写入口（工具与自动写）统一过 `memoryLint`，命中即拒并说明原因：

1. 进度 / 状态（「已完成 X」「等审查」）——这是事件，不是记忆。
2. 代码本身就能读出来的事实（「foo 函数在 bar.ts」）。
3. 规格复述；本卡一次性的错别字、格式、命名意见（P2 一律不自动沉淀）。
4. 环境个例：本机 Bun 版本与 CI 不同、本机网络 / 配额问题（已在标准答复里，记了只会误导别人）。
5. 无来源的推测：坑必须有 `sources` 或出自审查员 / PM；导入的要 `sourceNote`。
6. 秘密、地址、本机绝对路径、人名、商业内容：脱敏闸命中就拒（不降级），只在本机提示字段位置。
7. 重复：同 family + 文件有交集的 open 坑已在，或与已有记忆语义余弦 ≥0.92 → 不新开，提示改用 `mark_memory confirm` 追加来源。
8. 长度超限直接拒，不截断（截断的坑比没有更糟）。

---

## 3. 三路检索怎么合

时机：调度器生成**写单**（`order-take.ts` 的 build / fix）与**审查单**（`review-order.ts`）时；同一卡同一 specRev 同一 head
算一次，结果记进 `scheduler` 事件 `data.memoryIds`（§9 要用）。只读、走 `ledgerDb()` 的 query_only 连接。

### 3.1 候选池与过滤

候选 = 本项目全部记忆，先过滤：状态 ∈ {open, fixing}（总结 / 决定看 open），去掉 `candidate / fixed / retracted / superseded`
和带 `disputed` 标的；去掉锚在**本卡本轮**、本卡已经知道的东西（本卡上一轮自己的总结不存在，坑照收）。

### 3.2 三路

**图（graph）**——按跳数排，同跳数内 坑 > 决定 > 总结、再新者优先：

| 跳 | 关系 |
|---|---|
| 0 | 锚在本卡（前几轮审查沉淀的坑、本卡上的 decision） |
| 1 | 本节点的直接依赖 / 被依赖节点所绑的卡；本 feature 级的 decision |
| 2 | 同 feature 其它节点 |
| 3 | `feature_deps` 相邻 feature 的节点 |

图从当前 DAG 版本取（`effectiveNodes`），依赖边与 `ledger-dag-board` 同口径；卡不在任何 feature 里时只看 `task_deps` 的直接邻居。

**文件（file）**——本卡 `extra.fileGlobs`（fix 单再并上 PR 已改文件）与记忆 `files` 求交：glob 与路径用现有 glob 匹配，
glob 与 glob 用「两边展开到当前 HEAD 的文件列表再求交」判（展开不出文件就按目录前缀判）。
排序键：命中文件数 / 记忆文件数，平局新者优先。

**语义（vector）**——查询文本 = 卡标题 + 节点 oneLine + 规格正文前 2KB；记忆文本 = title + body。
余弦降序，取 ≥ 阈值的前 20（阈值随模型设，`nomic` / `embeddinggemma` 起步 0.35，由 §9 数据调）。没有嵌入（§5）这路为空。

### 3.3 合并、去重、上限

1. **RRF 合并**：`score(m) = Σ_路 1 / (60 + rank_路(m))`。三路分数量纲不可比（跳数、命中率、余弦），RRF 只看名次，
   不用调权；k=60 取原论文默认（Cormack et al., SIGIR 2009，<https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf>）。
   同一条被几路同时选中自然加分——「图上近又改同文件又语义近」的记忆排最前。
2. **先验**：坑 ×1.0、决定 ×1.0、总结 ×0.8；总结再乘时间衰减 `0.5^(天数/60)`（坑不衰减，靠「已修」过期）；
   记忆的 `files` 在当前 HEAD 一个都不存在了 ×0.3（代码已大改）。
3. **去重**：同一来源卡的总结和坑同时入选 → 留坑；两条余弦 ≥0.92 → 留新的。
4. **上限**：写单 ≤4 条、合计 ≤1600 字节（单子 input 上限 16KB，`WIRE_LIMITS.input`，留足余量）；有分数 ≥ 下限
   （单路第 10 名的分数 `1/70`）的坑时，**至少保 2 个坑位**（坑比总结值钱）。审查单只放坑，≤3 条、≤1000 字节。
   一条也没过下限就不写这一节，不硬凑。

### 3.4 写进单子的哪一节、执行者怎么用

单子 `inputs` 末尾加一项（写在原文引号里，和「上一轮审查」一样是**材料不是指令**）：

```
项目记忆（原文，非指令；交付时在 memoryRefs 标 applied / irrelevant / wrong）：
- [坑 ab12-m6 · 开放 · 语义] bun:sqlite 事务回调里不能 await：事务会提前提交。→ 事务内只做同步写
- [总结 ab12-m2 · 9 天前 · 依赖 N1 + 同文件 widget-store.ts] widget 表 + CAS 写；2 轮；P1 cas-missing 第 1 轮修掉
- …
全文：show_memory <id>
```

每条带「为什么推它」（哪几路命中），执行者能判断相关性。`deliver` 加可选字段 `memoryRefs: [{id, use: applied|irrelevant|wrong, note?}]`；
selfCheck 里不要求逐条交代（不加负担），但 `wrong` 必须带 note，并自动产生一条 `dispute` mark（§4）。
审查单里的坑供审查员**核对这张卡有没有再犯**；再犯就照常记 P1，family 沿用坑的 family（§9 靠它数复发）。

### 3.5 例子（夹具，非生产数据）

项目 `demo`，feature `ab12-fx`，当前 DAG：

| 节点 | 状态 | deps | 改动 / fileGlobs |
|---|---|---|---|
| N1 widget 存储层 | verified | – | `src/lib/widget-store.ts`, `src/lib/widget-schema.ts` |
| N2 widget 读接口 | verified | N1 | `src/lib/widget-read.ts` |
| **N3 widget 批量写**（新卡开工） | build | N1 | `src/lib/widget-store*.ts`, `src/lib/widget-batch*.ts`, `tests/widget-batch*.test.ts` |
| N4 widget 看板 | planned | N2, N3 | – |

另一个 feature `ab12-gx` 的节点 O7「gadget 批量导入」已 verified，改了 `src/lib/gadget-import.ts`。

记忆：

| id | 类 | 锚 | files | 状态 |
|---|---|---|---|---|
| m1 | 坑（规矩，fixable=0）「迁移语句逐条 prepare().run()，多语句 exec 吞运行期错误」 | N1 | `src/lib/*-schema.ts` | open |
| m2 | 总结 N1（9 天前） | N1 | widget-store.ts, widget-schema.ts | open |
| m3 | 坑「widget-store 写入没包事务，并发下 rev 跳号」 | N1 | widget-store.ts | **fixed**（见 §4 例子） |
| m4 | 决定（owner）「批量写单批上限 500，超了拒，不自动分片」 | feature ab12-fx | – | open |
| m5 | 总结 O7（20 天前）「一个事务写完；3 轮；P1 tx-await」 | O7 | gadget-import.ts | open |
| m6 | 坑「bun:sqlite 事务回调里不能 await」 | O7 | `src/lib/*-import.ts` | open |
| m7 | 总结 N2（5 天前） | N2 | widget-read.ts | open |
| m8 | 坑「UI 截图用 headless 脚本」 | 项目级 | `web/**` | open |

过滤：m3 已修，出局。

三路（名次）：

- 图：跳 1 有 m1（N1 的坑）、m4（feature 级决定）、m2（N1 的总结），同跳内 坑 > 决定 > 总结，名次 **m1、m4、m2**；
  跳 2 有 m7（同 feature 的 N2）。m5 / m6 / m8 不在图上相邻。
- 文件：m2（widget-store.ts 命中 `widget-store*.ts`）。m1 的 `*-schema.ts` 与本卡 glob 无交集；m6 的 `*-import.ts` 也没有。
- 语义（余弦）：m5 0.71、m6 0.66、m4 0.62、m2 0.55、m7 0.41；m1 0.30、m8 0.12 低于 0.35 不入。

RRF（k=60）与先验：

| id | 图 | 文件 | 语义 | RRF | 先验 | 终分 |
|---|---|---|---|---|---|---|
| m2 | 3 → 1/63 | 1 → 1/61 | 4 → 1/64 | 0.04789 | 0.8 × 0.5^(9/60)=0.721 | **0.03453** |
| m4 | 2 → 1/62 | – | 3 → 1/63 | 0.03200 | 1.0 | **0.03200** |
| m7 | 4 → 1/64 | – | 5 → 1/65 | 0.03101 | 0.8 × 0.5^(5/60)=0.755 | 0.02342 |
| m1 | 1 → 1/61 | – | – | 0.01639 | 1.0 | **0.01639** |
| m6 | – | – | 2 → 1/62 | 0.01613 | 1.0 | **0.01613** |
| m5 | – | – | 1 → 1/61 | 0.01639 | 0.8 × 0.5^(20/60)=0.635 | 0.01041 |

按终分前 4 = m2、m4、m7、m1，只有 1 个坑；坑位保 2：m6（0.01613 ≥ 下限 1/70 ≈ 0.01429）顶掉最低的非坑 m7。
m5 与 m6 同来源卡，本来也会按去重留坑 m6。

**写进开工单的是 m2、m4、m1、m6**，理由：

- m2：上游 N1 的总结，又改同一个文件——批量写要沿用 N1 的 CAS 写法，三路都中。
- m4：owner 对「批量写」本身的决定，图上同 feature + 语义都中；不看它多半会写出自动分片。
- m1：上游留下的规矩；本卡若要加表 / 加列会踩到。只有图一路，但坑优先保位。
- m6：别的 feature 里踩过的「事务里 await」——图和文件都够不到，只有语义能找回来，这正是向量那一路的价值。
- m7 落选：同 feature 的读接口总结，和批量写关系弱；m3 已修不推；m8 文件和语义都不沾。

---

## 4. 过期与纠错

### 4.1 坑和「修它的卡」怎么关联

- PM 开修复卡时在 `plan_feature / rewrite_dag` 的节点或 `start_node` 上带 `fixesMemory: [id]`（工具层校验 id 存在、是
  `fixable=1` 的 open 坑），写入后自动追加 `link_fix` mark（taskId = 新卡）。也可以事后 `mark_memory link_fix`。
- 执行者在 deliver 的 `memoryRefs` 里标 `{id, use: "applied"}` 不等于修好了——只有 `link_fix` 过的卡能让坑过期。
- 调度器观察器看到修复卡的 stage 事件进 `live`（code：PR 已合并）或 `done / verified`（ops）→ 追加 `fixed` mark，
  `source` = 那条 stage 事件，`dedupKey` 防重。卡被 `cancelled` → 追加 `unlink_fix`，坑回 open。
- 回滚（`live → fix`）→ 追加 `reopen`；再次上线再 `fixed`。

### 4.2 记错了谁来改

| 动作 | 谁能做 | 效果 |
|---|---|---|
| `dispute` | 任何有台账写权的角色；执行者 `memoryRefs: wrong` 自动产生 | 带 disputed 标，**不再进单子**，进 PM 待办 |
| `confirm` | PM / owner / 审查员（坑） | candidate → open，或清 disputed |
| `retract` | PM / owner；作者 24 小时内可撤自己写的 | 终态，不再进单子，行仍在（审计） |
| `supersede` | PM / owner | 指向新记忆 id，旧的退场；用于「坑的规矩变了」 |
| `link_fix / unlink_fix` | PM / owner | 见 4.1 |
| `fixed / reopen` | 只有调度器身份 | 见 4.1；人不能手标「已修」——防止「我觉得修好了」 |

### 4.3 旧记忆怎么不误导

- 每条进单子都带状态、日期、来源路由；总结时间衰减；记忆文件在 HEAD 已不存在 ×0.3。
- 每周卫生检查（复用 cron，同 mem0 卫生的「只报告」红线）：列出 90 天没被任何单子选中、或文件全没了、或同 family 坑
  60 天没再出现 P1 的记忆，**只给 PM 清单**，处置由 PM 决定。
- 同一条记忆被 `wrong` 标 2 次（不同执行者）→ 自动 dispute。

### 4.4 完整例子（承接 §3.5 的 m3）

1. **记下**：N2 第 1 轮审查，审查员发现读到的 rev 跳号，根因在 N1 的 `widget-store.ts` 写入没包事务——不是 N2 的范围。
   审查员对这条 P1 标 `pitfall: true`、family `widget-tx`。调度器写 `m3`（坑，fixable=1，files `src/lib/widget-store.ts`，
   sources = 这条 review 事件，作者审查员 → 状态 **open**）。N2 的这条 P1 由 PM 判为范围外，N2 照常走完。
2. **开修复卡**：PM `rewrite_dag` 加节点 `N1f「widget-store 写入包事务」`，带 `fixesMemory: ["ab12-m3"]`，绑卡后自动
   `link_fix(m3, N1f)` → m3 状态 **fixing**。这期间别的卡开工若选中 m3，单子上显示「修复中：N1f」。
3. **合并**：N1f 过审、合并，stage 事件 `merge → live`（origin `ab12`，originSeq 812）。调度器观察器追加
   `fixed(m3, N1f, source={ab12, 812}, dedupKey="auto:fixed:ab12-m3:N1f:ab12/812")` → m3 状态 **fixed**。
4. **之后**：§3.5 的 N3 开工，候选过滤先去掉 fixed，m3 不进三路排名；N3 的开工单里没有它（即使它改的正是 `widget-store*.ts`）。
5. **（反例）**：如果 N1f 上线后回滚（`live → fix`），观察器追加 `reopen` → m3 回 **open**，下一张碰 widget-store 的卡又会看到它。

---

## 5. 向量

**结论：在本机算、存本机、不同步、中心不存向量。V1 不用 sqlite-vec 也不用 pgvector：向量存在单独的本机 SQLite 文件里
（BLOB float32），检索在 TypeScript 里暴力算余弦。嵌入模型可插拔：本机 Ollama 优先，其次 owner 显式配置的远端 API，
都没有就关掉语义这一路。**

- **为什么本机、不同步**：向量是 `title + body` 的派生物，随时可重算；不同机器可能用不同模型（维度、空间都不同），
  同步向量反而要统一模型。只同步原文（已脱敏），每台机器自己嵌入。中心不存向量也就没有「中心看到全部原文语义」的额外面。
- **为什么不用扩展**：一个项目的记忆量级是千条（几十条坑 + 每张卡一条总结）。5000 条 × 768 维的暴力余弦是约 400 万次乘加，
  Bun 里个位数毫秒。sqlite-vec 仍是 pre-v1（「expect breaking changes」，<https://github.com/asg017/sqlite-vec>），且 macOS 系统
  SQLite 不支持加载扩展，要在建任何 `Database` 前 `Database.setCustomSQLite` 换成自带的 libsqlite3（<https://bun.sh/docs/api/sqlite>）——
  这会影响整个进程里的台账库连接，不值得。超过 5 万条再评估 sqlite-vec（Bun 用法见 <https://alexgarcia.xyz/sqlite-vec/js.html>）。
- **存哪**：`STATE_DIR/memory-vectors.sqlite`，表 `memory_vectors(memoryId, model, dim, digest, vec BLOB, createdAt)`，
  主键 `(memoryId, model)`；`digest` 对不上 `memories.digest` 就重算。与 `ledger.sqlite` 分开：坏了直接删、不进台账备份 / 迁移。
- **嵌入模型**（`memory.embed` 配置，按序取第一个可用的）：
  1. 本机 Ollama：`embeddinggemma`（622MB、多语言，<https://ollama.com/library/embeddinggemma>）或 `bge-m3`（1.2GB、100+ 语言、8K 上下文，
     <https://ollama.com/library/bge-m3>）。中文台账选多语言模型；`nomic-embed-text` 以英文为主，不作默认。
  2. 远端 API（owner 显式开、只发 `visibility=team` 且已过脱敏的文本）：Voyage `voyage-4-lite / voyage-3.5-lite` $0.02 / 百万 token
     （<https://docs.voyageai.com/docs/pricing>；Anthropic 不提供嵌入模型、文档点名 Voyage，<https://platform.claude.com/docs/en/build-with-claude/embeddings>），
     或 OpenAI `text-embedding-3-small` $0.02 / 百万 token、默认 1536 维（<https://developers.openai.com/api/docs/models/text-embedding-3-small>）。
  3. 都没有：语义路为空，RRF 只合图 + 文件两路；单子上不提示（不是错误）。`doctor` 里显示「项目记忆：语义检索未启用」。
- **peer 没有 Ollama**：同 3。出借给别人的 worker 不在自己机器上检索——检索在**发单的主场**做，单子里已经是选好的几条，
  worker 不需要任何嵌入能力。
- **成本与延迟**：一条记忆约 100–200 token，1000 条全量嵌入约 20 万 token，远端约 $0.004；本机 Ollama 免费。
  每张单 1 次查询嵌入（本机几十毫秒级；远端一个 HTTP 往返）+ 暴力余弦几毫秒；嵌入失败 / 超时（2 秒）当作这路为空，不阻塞派单。
  新记忆写入后异步嵌入，不在写入事务里调模型。

---

## 6. 对比成熟方案

**结论：三个都不直接用，各借一个思路。** 原因是共同的：我们的「实体和关系」本来就是台账里结构化的行（feature、节点、卡、
依赖、文件、review family），不需要大模型从自由文本里抽实体；而它们的核心价值恰恰在抽取。另外运行时也对不上（下表）。

| 方案 | 事实（出处） | 能直接用吗 | 借什么 |
|---|---|---|---|
| **mem0** | LLM 从对话抽候选事实，与相似旧记忆比对后由 LLM 选 ADD / UPDATE / DELETE / NOOP（<https://arxiv.org/abs/2504.19413>）；图变体 Mem0g 在论文里用 Neo4j，冲突关系标无效而非删除（同上）；当前文档称已不再支持外部图库、改为内部按实体链接（<https://docs.mem0.ai/open-source/features/graph-memory>）；TS SDK 的向量库里没有 SQLite（<https://docs.mem0.ai/components/vectordbs/overview>）；Apache 2.0（<https://github.com/mem0ai/mem0>） | 否：要加 Postgres / Qdrant；抽取对象是对话里的个人事实，和我们「卡 / 坑」的结构重复 | 写入前与相似旧记忆比对再决定「新开 / 追加 / 不写」→ §2.2 自动沉淀与 §2.3 第 7 条；冲突用「标无效」不删 → §1.2 marks |
| **Zep / Graphiti** | 时序知识图，双时间轴：系统内创建 / 失效时间 + 事实真实成立时间，边带 `valid_at / invalid_at / expired_at`（<https://arxiv.org/abs/2501.13956>，<https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py>）；矛盾时把旧边置失效、保留不删（论文）；检索 = 余弦 + BM25 + n 跳图遍历，用 RRF / MMR / 节点距离等重排（<https://help.getzep.com/graphiti/working-with-data/searching>）；每条事实可追溯到来源 episode；仅 Python，后端 Neo4j / FalkorDB / Neptune（<https://github.com/getzep/graphiti>）；Apache 2.0 | 否：Python + 图数据库，进不了 Bun + SQLite 单进程 | 「混合检索 + RRF + 图距离」→ §3；「失效不删、事实挂来源」→ `sources` 与 `fixed` mark；双时间轴我们简化成「记忆写入时间 + 修复卡合并时间」两点，够用 |
| **Letta（原 MemGPT）** | 分层记忆：常驻上下文的 core memory blocks、可搜索的 recall（历史消息）与 archival（向量）（<https://arxiv.org/abs/2310.08560>，<https://docs.letta.com/guides/agents/architectures/memgpt>）；同一 block 可挂到多个 agent 共享（<https://docs.letta.com/guides/agents/multi-agent-shared-memory>）；Apache 2.0、主开发已转到 letta-code（<https://github.com/letta-ai/letta>） | 否：它是完整的 agent 运行时，不是可嵌入的库；我们的执行者是 Claude Code / Codex 会话 | 分层思想：单子里放少量「常驻」摘要（≈ core），全文按需 `show_memory`（≈ archival 检索）→ §3.4 |

补充：sqlite-vec / pgvector 的取舍见 §5（pgvector 支持 HNSW / IVFFlat，<https://github.com/pgvector/pgvector>；若中心将来要做跨项目语义检索再考虑，
V1 中心不存向量）。

---

## 7. 团队与共享

**结论：记忆是只追加数据（内容行 + mark 行，都以 `(origin, originSeq)` 为键），属于 SYNC1 里「可合并」一类：多端各自写、
并集合并、状态由确定性折叠算出，不需要单写权威。**

- **为什么可合并**：`memories` 内容冻结，同键同 digest 幂等、同键不同 digest 报错隔离（与 `task_mirrors` 同水位同摘要的规矩一致，
  `docs/design/shared-ledger.md` §3.2）；`memory_marks` 只追加，状态 = 按 `(ts, origin, originSeq)` 全序折叠——任何两端拿到同一个
  mark 集合，算出同一个状态，与到达顺序无关。自动 mark 用 `dedupKey` 收敛「两端都观察到同一次合并」。
  唯一需要权威的是「修复卡进 live」这件事本身，它来自卡的主场 / 中心 stage 事件，本稿只消费、不复制权威。
- **脱敏**：上传沿用共享台账的「本机字段白名单 → 脱敏 / 敏感命中检查 → 共享内容预览 → 签名上传 → 中心再次校验」
  （`docs/design/shared-ledger.md` §3.3），复用 `dispatch-redact.ts`。白名单字段：`id / origin / originSeq / project / kind /
  featureId / nodeKey / taskId / files（仓库相对） / family / title / body / fixable / sources（origin+seq 引用） / sourceNote /
  via / author（代号） / authorRole / head / specRev / redactionVersion / digest / createdAt`；marks 全字段（reason 过同一道闸）。
  `visibility = home` 的行与它的 marks 不上传。写入时就过一次闸（§2.3 第 6 条），上传前再过一次（规则版本可能更新）。
- **可见范围**：和台账读权同一道门（`canReadLedger` / 中心项目成员）；不另设记忆级 ACL——记忆是项目资产，粒度太细的
  权限会让「换 PM 看不到」的老问题回来。写权见 §4.2。
- **离开的成员**：行保留，作者代号不改（`(instanceId, agentId)` 代号，不存真名）；撤成员后其实例不能再写新 mark，
  已有记忆照常参与检索；PM 可 retract / supersede。与共享台账「已下载副本不能保证追回」同口径。
- **与 i28-SYNC1 的边界**：SYNC1 负责传输、批次水位、可合并 / 单写两类的分类框架与冲突隔离；本稿只**声明**两张表的合并键、
  digest 校验与折叠函数，并把它们登记为「可合并」一类。若 SYNC1 的分类名不同，以 SYNC1 为准、本稿实现节点 M8 跟随。
  向量表不在同步范围内。

---

## 8. 迁移：PM 私人记忆里的坑一次性导入

**结论：PM 出 JSONL 清单 → `ledger memory-import --dry-run` 出报告 → PM 改清单 → 正式导入（备份 + 单事务）。**

清单格式（一行一条）：

```json
{"kind":"pitfall","title":"迁移语句逐条 prepare().run()","symptom":"多语句 exec 的运行期错误被吞，版本号照样前进","rule":"一条语句一次 prepare().run()","files":["src/lib/*-schema.ts"],"family":"migration-exec","fixable":false,"feature":null,"task":null,"sourceNote":"PM 私人记忆导入（原条目日期）","visibility":"team"}
```

流程：

1. PM 从自己的 mem0 / 本地文件挑出「自动卡卡点」类条目，按上面格式写清单（只放项目通用的坑；个人偏好、进度、人名留在私人记忆）。
2. `ledger memory-import --file <清单> --dry-run --out <报告.md>`：只读，逐行报告 ① 格式 / 长度错误 ② 脱敏命中（只报字段位置）
   ③ 与已有记忆或清单内互相重复（同 family + 文件交集 / 余弦 ≥0.92，有嵌入时）④ 锚点找不到的 feature / 卡 ⑤ `memoryLint` 拒的原因。
3. PM 改清单直到报告干净。
4. 正式导入：只许 PM / owner；先 `VACUUM INTO backups/ledger.sqlite.pre-memory-import-<时间>-<清单摘要>.bak`，一个 IMMEDIATE
   事务写全部，任何一行失败整批回滚。`via = import`、`authorRole = pm`、状态直接 **open**（PM 背书）；
   `dedupKey = import:<sha256(行)>`，重跑幂等。
5. 导入后 PM 在私人记忆里给这些条目打「已迁项目记忆 <id>」标记（私人记忆的处置不在本稿范围）。i28-PMSW1 交接时，新 PM 读项目记忆，不再读旧 PM 私人记忆。

---

## 9. 衡量

**结论：靠三类数据——单子里推了什么（`scheduler` 事件 `data.memoryIds`）、执行者怎么用（`memoryRefs`）、之后同类 P1 还出不出现
（review 事件的 family）。门槛数字由 owner 定，这里留空。** 报表走 `ledger metrics` 同一处，按周出。

| 指标 | 定义 | 方向 | 门槛 |
|---|---|---|---|
| 同类 P1 复发率 | 单子里推过 open 坑 F 的卡里，审查出现与 F 同 family 的 P1 的比例；对照：上线前 8 周同 family P1 / 同文件卡 | 降 | ___ |
| 坑复发次数 | 每个 open 坑在被推之后又出现同 family P1 的次数（按坑列，找「推了也没用」的坑，多半要改写 rule） | 降 | ___ |
| 引用率 | `memoryRefs.use = applied` / 推出的条数 | 升 | ___ |
| 无关率 | `irrelevant` / 推出的条数（检索精度） | 降 | ___ |
| 错误率 | `wrong` / 推出的条数 | 降 | ___ |
| 覆盖率 | 至少推了 1 条的单子 / 全部写单 | 参考 | ___ |
| 轮数差 | 有坑命中的卡与无命中的卡平均轮数（观察性，不当因果） | 参考 | ___ |
| 成本 / 延迟 | 每卡总结模型花费、每单检索 p95 毫秒 | 守上限 | ___ |
| 路由贡献 | 被 applied 的记忆分别来自哪几路（判断向量那路值不值） | 参考 | ___ |

---

## 10. 实现节点（供 PM `plan_feature` / `rewrite_dag`）

fileGlobs 两两不相交（测试文件按节点前缀分开）。共享热文件只各归一个节点：迁移数组 `ledger-store.ts` 归 M1，
`order-tools.ts` / `order-deliver.ts` 归 M2，`order-take.ts` / `review-order.ts` 归 M5，`scheduler-observe-tick.ts` 归 M3。

| key | oneLine | deps | fileGlobs | 估时 | 验收线 |
|---|---|---|---|---|---|
| M1 | 记忆两张表 + 迁移 + 状态折叠 + 写入函数 | – | `src/lib/ledger-memory-schema.ts`, `src/lib/ledger-memory.ts`, `src/lib/ledger-memory-fold.ts`, `src/lib/ledger-store.ts`, `tests/ledger-memory-*.test.ts` | 1 天 | 迁移可重跑、旧代码能开新库；内容行 trigger 拦改删 / 同键 INSERT；折叠对 marks 任意排列结果相同（性质测试）；每次写追加 `memory` 事件 |
| M2 | MCP 工具 record / mark / show_memory + deliver.memoryRefs + CLI + memoryLint | M1 | `src/lib/memory-tools*.ts`, `src/lib/memory-lint*.ts`, `src/lib/order-tools.ts`, `src/lib/order-deliver.ts`, `src/bridge/order-tools.ts`, `src/manager/ledger-memory-cmds.ts`, `tests/memory-tools*.test.ts`, `tests/memory-lint*.test.ts` | 1 天 | 身份只取 verified 会话；§4.2 权限表全表用例；§2.3 八条各有拒绝用例；`wrong` 自动 dispute |
| M3 | 自动写：verified 总结、P1 family 沉淀、审查员 pitfall 标、fixed / reopen / unlink 观察器、decision 索引 | M1, M2 | `src/lib/memory-auto*.ts`, `src/lib/scheduler-observe-tick.ts`, `src/lib/scheduler-review.ts`, `tests/memory-auto*.test.ts` | 1.5 天 | §4.4 例子整段做成测试；同一次合并两端观察只记一条；模型不可用时总结只有事实部分；≥2 卡 candidate、≥3 卡自动 confirm |
| M4 | 嵌入提供方 + 本机向量库 + 暴力余弦 | M1 | `src/lib/memory-embed*.ts`, `src/lib/memory-vectors*.ts`, `tests/memory-embed*.test.ts`, `tests/memory-vectors*.test.ts` | 半天 | 无模型时返回空不抛错；digest 变了重算；2 秒超时；只发 team 文本到远端 |
| M5 | 三路检索 + RRF + 上限 + 写单 / 审查单注入 | M1, M4 | `src/lib/memory-retrieve*.ts`, `src/lib/order-take.ts`, `src/lib/review-order.ts`, `tests/memory-retrieve*.test.ts` | 1 天 | §3.5 夹具逐数复现（终分、坑位、去重、落选理由）；无嵌入时两路照常；单子字节上限内；`memoryIds` 记进事件 |
| M6 | 导入命令（dry-run 报告 + 备份 + 单事务） | M1, M2 | `src/lib/memory-import*.ts`, `src/manager/ledger-memory-import.ts`, `tests/memory-import*.test.ts` | 半天 | 重跑幂等；任一行失败整批回滚；报告五类问题都有用例；`--out` 不落到库文件上（同 feature-migrate） |
| M7 | 指标报表 + 每周卫生清单（只报告） | M3, M5 | `src/lib/memory-metrics*.ts`, `src/lib/memory-hygiene-report*.ts`, `tests/memory-metrics*.test.ts` | 半天 | §9 每个指标有定义测试；卫生只出清单不写 mark |
| M8 | 共享台账：记忆白名单 + 可合并登记 + 上传前脱敏 | M1，及 SYNC1 的可合并框架节点 | `src/shared-ledger/memory*.ts`, `tests/shared-ledger-memory*.test.ts` | 1 天 | home 行不上传；同键不同 digest 隔离；两端任意顺序合并状态一致；脱敏命中阻止上传 |

**边界**

- **i28-SYNC1**：SYNC1 定传输、水位、「可合并 / 单写权威」两类框架；本稿 M8 只往「可合并」类登记两张表，不改 SYNC1 的文件。
  M8 依赖 SYNC1 的框架节点落地；在那之前 M1–M7 只在本机生效，不受影响。
- **i28-PMSW1**（换 PM）：PMSW1 管交接流程（名单、待办、频道）；本稿提供「新 PM 第一件事读项目记忆」所需的数据与 §8 的导入。
  PMSW1 不定义记忆 schema，本稿不碰 PM 名单 / 交接文件。

---

## 11. 公开内容自检

本稿所有例子是夹具（`demo`、`ab12-fx`、N1–N4、O7、widget / gadget）；不含生产节点标题、peer 名、地址、令牌、个人信息与商业 / 路线内容。
引用的卡号（i28-SYNC1、i28-PMSW1）只作边界说明。外部方案的特性均附官方文档 / 论文 / 仓库链接。
