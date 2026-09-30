# T84 feature + 子 DAG 版本

状态：阶段 1 L1 已实现（结构、写入口、只读投影）。L2 重写与审批、L3 旧卡迁移、L4 视图读接口各开一张卡，照这份稿实现。

## 两层结构

- **feature**：owner 叫得出名字的一件事（例：「协作底座改版」）。属于一个项目，名字在项目内唯一。
- **子 DAG 版本**：feature 下的一张依赖图，节点对应任务卡（PR 粒度）。图是计划、卡是执行：节点可以还没有卡（计划中），开工时再绑卡。图带版本号，只能整份重写成新版本，不能原地修改。
- 任务卡本身不变：阶段机、CAS、事件都照旧；卡上多一个可空的 `featureId` 指回所属 feature。

## 表结构（迁移第 10 步，`src/lib/ledger-feature-schema.ts`）

`features`

| 列 | 说明 |
|----|------|
| `id` | 全局 id = `<本机前缀>-<slug>`，如 `ab12-i28` |
| `project` / `title` / `ownerWords` | 项目、名字（项目内唯一索引）、owner 原话 |
| `status` | `active` / `paused` / `done` / `dropped` |
| `currentVersion` | 当前版本号，0 = 还没建 DAG |
| `rev` | CAS 版本，每次写 + 1 |
| `createdBy` / `createdAt` / `updatedAt` | |

`dag_versions`（只追加）

| 列 | 说明 |
|----|------|
| `featureId` + `version` | 主键；`version >= 1` |
| `reasonKind` | `initial` 初版 / `new_issue` 发现新问题 / `requirement_change` 需求变了 / `p1_fallback` P1 退路 |
| `reasonText` | 原因原文（owner 原话或审查结论） |
| `proposedBy` / `approvedBy` | 发起人 / 批准人（v1 的批准人为空，审批在 L2） |
| `createdAt` | |
| `nodes` | 节点快照 JSON，见下 |

表上 CHECK：`version = 1` 当且仅当 `reasonKind = 'initial'`。库里 trigger 拦 UPDATE / DELETE，也拦同键 INSERT（挡住 `INSERT OR REPLACE`：它的隐式删除默认不触发 DELETE trigger）。

节点快照（`DagNode`，`src/lib/ledger-feature.ts`）：

```json
{ "key": "T84", "taskId": "T84", "oneLine": "新台账结构", "deps": ["T83"], "status": "build", "estimate": "半天", "inheritedFrom": null }
{ "key": "L2", "taskId": null, "oneLine": "重写命令与审批", "deps": ["T84"], "status": "planned", "estimate": "1 天", "inheritedFrom": null }
```

- `key` 在同一版里唯一（有卡时缺省取 taskId），重写时靠它对齐新旧版的同一节点；`deps` 写节点 key，只能指向同一版里的节点，不许自环、不许成环。
- `taskId` 可空：有值必须是本项目的卡、不属于别的 feature，一张卡只进一个节点；为空 = 计划中，`oneLine` 必填。
- `status` 是建版本那一刻任务卡的 stage（没卡为 `planned`），只作记录；`estimate` 是自由短文本（≤20 字）。
- `inheritedFrom`：从哪一版原样继承来的；新加或改过的节点为 null。v1 全是 null。

其余改动：

- `tasks.featureId`：可空，指向 `features.id`。dag-init 给节点卡写上，每张卡 rev + 1 并附一条 `task` 事件（与 task-set 同形）。
- `events.origin` / `events.originSeq`：写入方的本机前缀与该前缀下的单调序号（`UNIQUE(origin, originSeq)`）。老事件不回填，旧代码写的事件也没有。
- `ledger_instance`：本机前缀固定在这里（key = `origin`）。

## 全局编号

本机前缀取 `STATE_DIR/instance-id` 的前 4 位。选它而不是实例公钥指纹或 registry 名字：instance-id 是专门的本机稳定 id（peer 握手已在用），不用读私钥文件；registry 里没有实例名字段，agent 名也可能跨机重名。第一次用到时写进 `ledger_instance`，之后 instance-id 文件被换也不漂，同步到中心服务时按 `origin` 区分来源。

现有任务 id 不改；只有 feature（以及以后别的新对象）带前缀。命令行里写 slug 或全 id 都认。

序号在同一条 INSERT 里用子查询 `MAX(originSeq) + 1` 算：单条语句原子，写入模块和 bridge 的 ask 事件两个写入点都不用额外加锁。

## 迁移与备份

- 走现有迁移数组，`LEDGER_SCHEMA_VERSION` 仍由数组长度算；每步可重跑（IF NOT EXISTS、加列先查列）。
- `openLedger` 这次要改库就先 `VACUUM INTO` 备份（先写临时文件再 link，并发只留一份；同名已在就跳过），判断与迁移同口径：版本落后 → `backups/ledger.sqlite.pre-v<目标版本>.bak`；版本已到但表 / 列 / 索引缺（并行分支撞了迁移编号，要重跑补齐）→ `….pre-v<目标版本>.repair-<缺项摘要>.bak`。备份失败就不迁移，库保持原样。
- 回滚：停服务，用备份换回 `ledger.sqlite`。旧代码能直接打开 v10 的库（只核自己要的表和列），一般不需要回滚。

## 写入口（CLI，`src/manager/ledger-feature-cmds.ts`）

| 命令 | 说明 |
|------|------|
| `ledger feature-new <slug> --title <名字> [--words <原话>] [--status]` | 建 feature |
| `ledger feature-set <feature> --rev <n> [--title] [--words] [--status]` | 改 feature（CAS） |
| `ledger dag-init <feature> --rev <n> --nodes '<json>' [--reason <原文>]` | 只建 v1：已有任何版本就拒绝 |
| `ledger feature-show <feature>` | 当前版本的节点，状态从任务卡现读 |
| `ledger dag-show <feature> [--version N]` | 某一版的快照，同样附现读状态 |

写命令只许项目 PM 名单里的人、master、owner；都带 `--dedup` 幂等；每次写一条 `feature` 事件（target = feature id）。

投影：`status` = 任务卡当前 stage（没绑卡为 `planned`；绑了卡却找不到为 null、`missing: true`），`statusAtVersion` = 快照原值，`satisfied` 与依赖边同一口径（code 上线即算，ops / investigate 要 done），`ready` = 依赖节点都满足、自己没满足也没终态。

## 「只重写」的四条规矩（L2 照此实现）

1. **版本写入后不可改、不可删。** 库里 trigger 拦 UPDATE / DELETE / 同键 INSERT（含 REPLACE、UPSERT）；要改就写新版本。
2. **改图 = 整份重写成新版本。** 新版本带完整节点快照、原因类型、原因原文、发起人、批准人；除初版外都要有批准人（批准人能否是发起人本人由 L2 卡定）。
3. **版本号连续，只能往前。** 新版本号 = `currentVersion + 1`，与 `features.rev` 的 CAS、`currentVersion` 的推进在同一事务；想退回旧图也是写一个内容同旧版的新版本。
4. **已完成的节点只能原样继承。** 终态节点（done / cancelled）在新版里必须出现、一句话与依赖不变，并标 `inheritedFrom`；节点状态的真相永远在任务卡上，版本只记当时的样子。

## L2 以后

- `dag-rewrite <feature> --rev <n> --reason-kind … --reason … --nodes …` 走审批（ask 卡），批准后写 v(N+1)；被移出新版的卡清掉 `featureId`。
- 开工绑卡（计划节点 → 任务卡）也放在 L2：绑卡不改图，只把卡写进节点；实现时定它是写新版本还是单独的绑定表。
- L3 把现有卡按 owner 叫得出的 feature 归组，每组 dag-init 一次。
- L4 给看板加读接口（按 feature 列节点与现读状态）。
