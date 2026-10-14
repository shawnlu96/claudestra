# Owner 优先级登记

优先级只有三档：`now`（现在做）、`next`（接着做）、`later`（可以拖）。
旧事项 `items.priority` 是展示文本，仍可写；系统不解析、不迁移它。

## 数据与继承

`priority_records` 保存受控显式档位和独立版本号。feature 一份记录；
任务卡与计划节点共用 work 记录。未绑卡节点按 feature + nodeKey 定位，
绑卡增加 taskId 别名；通过卡和节点写入会修改同一行。

未显式定档的卡/节点每次现读 feature。feature 未登记时有效档位为 `next`，
`source=system`，提示「系统缺省、owner 未登记」。`priority-clear` 清显式档位，
保留记录、版本和历史，立即恢复继承。任务卡不属于 feature 时也使用系统缺省。

feature 的 rev 与优先级 rev 独立：修改普通标题不会造成优先级 CAS 冲突。
未登记的优先级 rev 为 0。每次专用写入都在 IMMEDIATE 事务中核版本和权限，
更新数据并追加台账事件；失败整体回滚。相同操作者、同一去重键和完整请求
只返回首次保存的结果，内容变更或跨项目重用去重键会拒绝。

## 权限与原话

owner 可登记。PM 必须同时是项目 pms 成员、当班 PM，且不是调度助理。
当班身份使用 `activeProjectPm`，无 activePm 指针时使用现有名单的首个非助理。
master、scheduler、import 身份及普通 agent 都没有优先级写权限。
CLI 还核验 PM 的 registry 项目，目标必须属于本次指定项目。

每次修改均须保存非空 `ownerWords`、`sourceRef` 和正整数毫秒 `ownerAt`。
事件另记登记者与登记时间。PM 没有可靠原话时先使用现有 ask 向 owner 核实，
专用入口不会替 PM 推断原话或档位。来源引用是审计线索，不能单独充当权限。
身份沿用现有 CLI 推导机制，不能把自报 actor 的库函数当作远程认证接口。

## 命令

以下命令均在 `claudestra ledger` 下。目标格式为 `feature <id>`、`task <id>`
或 `node <featureId> <nodeKey>`；feature 支持完整 id 或本机 slug。
`--project` 缺省取调用者所属项目，owner 终端需要明确指定。

```sh
claudestra ledger priority-show task agents-PMJOB1 \
  --project claude-orchestrator
claudestra ledger priority-set feature b5cf-team-project \
  --project claude-orchestrator --band now --rev 0 \
  --dedup owner-priority-001 --owner-words '团队主线也放 now' \
  --owner-at 1791846900000 --source 'discord:channel/message'
claudestra ledger priority-clear node b5cf-team-project N1 \
  --project claude-orchestrator --rev 1 --dedup owner-priority-002 \
  --owner-words 'N1 跟随团队主线' --owner-at 1791846900000 \
  --source 'discord:channel/message'
claudestra ledger priority-history task agents-PMJOB1 \
  --project claude-orchestrator
claudestra ledger priority-history --project claude-orchestrator
```

`priority-show` 返回有效档位、显式值、继承来源、owner 是否登记、优先级 rev、
队列内同档位置和旧事项文本。`priority-history` 查询只追加的 `decision` 事件，
`data.namespace=priority`，包含旧新值、原话/原话时间、来源引用、登记者与时间。
项目历史还包括顺序与开关。卡/节点历史包括其关联记录的合并和搬迁沿革，
取消节点的旧历史仍可按原 feature + nodeKey 查，新的同名节点使用新身份。

`priority-show`、`priority-history` 使用只读连接，旧库缺新表时返回缺省，
不会建库或迁移。`priority-order`、`priority-mode` 是查询/修改混合命令，
外层按写命令处理；缺少修改参数时仅查询。

## 同档顺序

默认保留现有顺序。owner 可明确给一组同档目标登记顺序，PM 按其原话转录。
`priority_orders` 以项目 + queue + band 为作用域，queue 缺省为 `project`；
没有跨实例全局名次。members 使用稳定记录 id，绑卡别名归并时只翻译身份，
不改变相对次序。未列出的目标保持调用方原顺序；空列表清除覆盖。
不同档位、跨项目目标、重复记录（包括同时列出已绑节点及其卡）都会拒绝。

```sh
claudestra ledger priority-order next --project claude-orchestrator
claudestra ledger priority-order next --project claude-orchestrator \
  --queue build --rev 0 --dedup owner-order-001 \
  --targets '[{"kind":"task","id":"A"},{"kind":"task","id":"B"}]' \
  --owner-words '同档先 A 后 B' --owner-at 1791846900000 \
  --source 'discord:channel/message'
```

## 四个机制开关

`prioritySort`、`priorityNowStart`、`priorityStall`、`priorityPanel` 独立登记，
均可为 `off / observe / on`，缺省 `observe`，各自带 CAS 版本和历史。
开关不限制登记写入。此模块保存后续机制所需的配置，不执行派单、开工、
恢复、通知或待办；消费者须在 observe 只记反事实结果，在 on 才执行对应动作。

```sh
claudestra ledger priority-mode --project claude-orchestrator
claudestra ledger priority-mode prioritySort --project claude-orchestrator \
  --mode on --rev 0 --dedup owner-mode-001 \
  --owner-words '排序机制转正' --owner-at 1791846900000 \
  --source 'discord:channel/message'
```

切 on 是独立审计动作，不能用初始定档原话替代新的切换授权。

## DAG 与入口保护

DAG 初建、重写、绑卡、拆分的现有事务各调用一个新模块函数。
同一逻辑节点编辑保留身份；删除或换卡会退役旧节点定位；
未绑卡的旧记录归档，移出的原卡保留其独立显式档位，
同名新节点使用新 id，旧显式档位不转移。拆分移动节点沿用 id，
显式档位不变，继承档位跟随目标 feature。搬迁事件同时保存新旧位置。

独立卡与计划节点均已登记显式档位时，绑定拒绝，不猜哪份 owner 授权较新。
PM 先按 owner 原话 clear 一处，再重试。只有一处显式档位时合并为一份活跃真值，
归档另一身份并通过 mergedInto 串起历史和顺序引用。

通用 new/set/import、feature patch、DAG 节点输入会递归拒绝受控优先级键，
包括嵌套 extra。网页经既有 CLI 写入口也受同样约束。旧事项顶层 priority
是唯一保留的文本例外。新表在台账末尾迁移中幂等建表，不改既有表列；
旧库仅回填当前 DAG 的无授权身份，不生成初始档位或历史决策。

## 上线登记

PM 核对真实 owner 原话/时间/来源后逐个登记：agents-PMJOB1、agents-PMAUTO1、
merge-arch-DEPRECON1、merge-arch-SELECT1、feature b5cf-team-project 为 now，
本 prio feature 为 next。其他项不批量推断升档。实现及迁移不会自动录入这些档位。
