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

`observe` 通过全部闸门才记「本会开工」，被挡住记「本会等待」及原因；`on` 记录等待原因。
同 feature 的待记录节点批量提交，资格与模式不变时不再启动写命令；记录失败进入本轮错误，开工继续。
记录按 feature、node、模式版本、门及原因去重，日志不能伪造依赖满足。
`off` 不执行 now 候选与等待记录。

## 停滞时钟

独立 tick 位于 schedulerPass 的正常调度周期内，不占普通候选预算。
监测 now 的非终态卡与未绑卡计划节点；排除被共享台账 skip 的目标。
默认窗口为 30 分钟，时钟取最近实际推进与本次升 now 时间的较晚值。
读侧先筛非终态 now 卡、一次索引事件；未到窗口的对象不启动 CLI。写侧按 key 重核时走同一份
全项目判定再取该目标（前置资格取决于别的 now 对象），同一 claim 事务复用事实。
普通标题、note、心跳、ask、观察、提醒与恢复尝试不改变时钟。

读侧给每个对象带结构化卡点 `block`（ask / frozen / feature / deps / files / no_globs / progress）
和没满足的前置引用 `on`，后续判定只读这个结构，不解析 why 文案。

## 等前置只追前置（STALLVER2）

唯一卡点是依赖没满足（任务看 blockedBy，节点看 waiting=deps）的对象本身不算停滞。沿没满足的边
往上追到第一个不是「只在等依赖」的前置：它拿到监控资格（不改业务优先级，即使它不是 now），
计时用它自己的推进时间，起点取被 now 链引用的时间与最近推进里较晚的。引用时间按路径算：一条路径从下游 now 起点和沿途每条依赖边的生效时间（任务边 `task_deps.createdAt`、节点边为当前版本往回连续带着这条边且前置绑同一张卡的最早 DAG 版本时间，`bindNode` 后绑的卡取 `dag_bindings.boundAt`）里取最晚，多条路径取最早；每一跳还要重放前置卡的阶段事件和边的 `dep-set --state` 事件，取「这一跳当前连续未满足」的起点：done 的边改回 waiting、前置从 live 退回 fix，都算重新入链；只改 when 文案不算。新加依赖、改线或绑卡不会把窗口追溯到引用还不存在的时候，删边后重加重新起窗（换 epoch，旧回执不能落地）。
同一前置被多条下游引用只算一个对象，下游列在 `impact`、提醒正文「影响」行。
前置缺失、已取消、已满足但边未放行或 branch 没选定算图配置问题：等待方自己带 `config`，
只走到记 note，不建 owner 待办，也不尝试自愈。

执行者在做不算停：build / fix 阶段的卡有 claimed 的 write / fix 出借订单、租约未过期且 beatAt
在一窗以内，本轮按心跳计推进（progress 带上心跳，令旧认领失效）；心跳超过一窗或租约过期照旧计停滞。
本机作者（非出借）的存活信号不在此范围。

有效事件明确限定为阶段变化、正式实际领单、执行交付、步骤成果、审查、
合并/部署成果及依赖解除。owner / PM 实际交回自动流程算解决动作；调度服务的 `workflow_resume` 属于恢复尝试，不续命。
卡与计划节点使用 PRIO1 的 work 身份，绑定前后不会因为换地址重复升级。
优先级决策历史识别两次 tick 之间的降档/再升档，普通编辑不能开启新周期。

## 三段升级

1. 达窗口后选择已有且获授权的自愈，最多一次。目前复用原
   `scheduler-auto-resume` 的合并撤销后交回资格；manual 的其他情况、
   冻结、未答 PM ask 或需要核 origin head 的授予分支交由原机制/PM。
2. 成功自愈后最多再等一个窗口；无动作、失败或结果不明立即进入 PM 段。
   PM 段不推送 PM：写命令在同一事务里重核认领、在卡上写一条 note
   （namespace `priority-stall-note`，dedup = 项目 + 对象 key + 周期 + 阶段）再完成认领，
   PM 需要时自己拉。没绑卡的节点 target 留空，data 带 featureId / nodeKey。
   未答执行者 ask 的编号和问题首句在首行，不将 ask 创建视为推进。按 taskId 查项目 PM 名单
   （含交接前 PM）的 open ask，卡或 feature 单独指定的 PM 也保留匹配。note 不算推进。
3. 记 note 后再过一个窗口无推进，创建 owner_action 待办一次，包含阶段、
   原因、停滞时长、影响、自愈及卡上提醒结果。已有同类 open 待办时关联，避免刷卡。

认领、三段结果及 observe 模拟状态保存在台账事件中。每个写命令使用原有
调度身份/服务租约，在 IMMEDIATE 事务中重新取事实，状态版本 CAS 与请求
dedup 共同保护。daemon 的 query_only 连接不做写入。写 note / 建待办前重核认领 token，
推进、执行者心跳、降档、终态、依赖或模式变动使旧 token 失效。

自愈认领超过五分钟仍无结果记 unknown，转 PM 核对，不重新执行。
PM 段明确失败允许最多三次尝试，间隔一分钟（配置窗口更短时取窗口）；成功停止。
PM 段结果不明不重做，按原认领时间等待 owner 窗口；note 与完成同事务，回执丢失也不会重复写。
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
自愈选择、卡上 note、owner 待办及去重。observe 档下追前置、记 note 同样只算不发。合入部署对账继续由既有 DEPRECON1
机制负责，本模块不新增强制恢复权。

测试覆盖共享 claim 门、普通档位、真实临时 Git 仓库的开卡全链与预算，
以及虚拟时钟的三段升级、未答 ask、标题/note 不续命、结果不明、有限重试、
降档再升档、owner 待办关联、CLI CAS/dedup、observe 零外发与 off 零写入；
tests/ledger-priority-stall-chase.test.ts 覆盖追前置、单对象去重、卡上 note、出借心跳与图配置问题。
