# now 自动开工与停滞升级

`priorityNowStart` 与 `priorityStall` 使用 PRIO1 保存的项目独立开关，缺省
`observe`，支持 `off / observe / on`。读有效档位沿用 `readPriority`，没有
登记的目标仍为 `next`。旧文本 priority 不参与判定。

## 自动开工

`priorityNowSwitch` 是候选和 claim 事务共用的节点资格规则。
只有有效 `now` 且 `priorityNowStart=on` 才豁免 feature 级 autostart 关闭。
项目开关、中心副本/共享规划、服务停用、feature 暂停、待批 DAG、冻结、
PM、容量、文件锁/车道、规格、权限与额度仍走原有门。claim 在事务里现读，
候选快照不构成开工授权。

正常 autostart tick 在普通候选预算检查前处理 now：每次开完重新取事实，
继续处理仍就绪的 now 节点，直到没有候选或真实容量挡住。每节点每轮只尝试
一次，开卡仍复用原 claim / preflight / runStart / settle 和进程内 inFlight。
结果不明的 claim 不重开。next/later 保留原候选遍历顺序。

`observe` 只经调度写口记「本会开工」及当前资格；`on` 记录等待原因。
记录按 feature、node、模式版本、门及原因去重，日志不能伪造依赖满足。
`off` 不执行 now 候选与等待记录。

## 停滞时钟

独立 tick 位于 schedulerPass 的正常调度周期内，不占普通候选预算。
监测 now 的非终态卡与未绑卡计划节点；排除被共享台账 skip 的目标。
默认窗口为 30 分钟，时钟取最近实际推进与本次升 now 时间的较晚值。
普通标题、note、心跳、ask、观察、提醒与恢复尝试不改变时钟。

有效事件明确限定为阶段变化、正式实际领单、执行交付、步骤成果、审查、
合并/部署成果及依赖解除。实际交回自动流程算解决动作；仅尝试不算。
卡与计划节点使用 PRIO1 的 work 身份，绑定前后不会因为换地址重复升级。
优先级决策历史识别两次 tick 之间的降档/再升档，普通编辑不能开启新周期。

## 三段升级

1. 达窗口后选择已有且获授权的自愈，最多一次。目前复用原
   `scheduler-auto-resume` 的合并撤销后交回资格；manual 的其他情况、
   冻结、未答 PM ask 或需要核 origin head 的授予分支交由原机制/PM。
2. 成功自愈后最多再等一个窗口；无动作、失败或结果不明立即进入 PM 段。
   PM 通知按卡/feature 的负责 PM 路由，未答执行者 ask 的编号和问题首句
   在首行，不将 ask 创建视为推进。
3. PM 通知后再过一个窗口无推进，创建 owner_action 待办一次，包含阶段、
   原因、停滞时长、自愈及通知结果。已有同类 open 待办时关联，避免刷卡。

认领、三段结果及 observe 模拟状态保存在台账事件中。每个写命令使用原有
调度身份/服务租约，在 IMMEDIATE 事务中重新取事实，状态版本 CAS 与请求
dedup 共同保护。daemon 的 query_only 连接不做写入。外发前重核认领 token，
推进、降档、终态、模式变动使旧 token 失效。

自愈认领超过五分钟仍无结果记 unknown，转 PM 核对，不重新执行。
PM 失败允许最多三次尝试，间隔一分钟（配置窗口更短时取窗口）；成功停止。
owner 待办创建和完成认领同一事务，认领中断可安全重试。
模式切换使用独立版本和模拟/实际流，observe 切 on 从实际事实开始，
不会补发模拟中的整串历史通知。off 保持原机制行为。

## 门槛配置

```sh
claudestra ledger priority-stall-threshold --project example
claudestra ledger priority-stall-threshold 1800000 \
  --project example --reason 'owner 确认 30 分钟升级窗口' \
  --dedup owner-stall-window-001
```

门槛仅 owner 可改；PM/master 只能查询。范围 1000..2592000000 毫秒，
变更保存 before/after、actor、时间与 reason。重复同一请求无副作用；
不同请求不能复用 dedup。调整门槛不重置有效推进时钟。

## 验证与启用

先跑 now 模式与停滞模式的 observe，核对记录中的依赖门和 feature 开关门，
再分别以新的 owner 原话授权切 on。上线后首个实际周期须逐段复核：
自愈选择、PM 通知、owner 待办及去重。合入部署对账继续由既有 DEPRECON1
机制负责，本模块不新增强制恢复权。

测试覆盖共享 claim 门、普通档位、真实临时 Git 仓库的开卡全链与预算，
以及虚拟时钟的三段升级、未答 ask、标题/note 不续命、结果不明、有限重试、
降档再升档、owner 待办关联、CLI CAS/dedup、observe 零外发与 off 零写入。
