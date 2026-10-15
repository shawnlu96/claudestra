# 观察期登记与按样本自动转正

观察期计划保存在状态目录 `observation-plans.json`，用 file-lock 和原子写串行登记、撤销、标误判、到期核对。
恢复策略文件及 autostart meta 仍是开关真源；不改 recovery-policy.json 格式，不新增恢复键。

## 自动登记与授权

在规格 `## 上线后 PM` 一节第一行写 `观察期：N 小时`（整数 ≥1，超过 168 按 168 算），另起整行写：

```
自动转正:askReminder、auditIdleFacts
```

兼容该节完整的 `scheduler-recovery <本项目> on --key <键>` 命令行，允许 `ledger` 前缀、列表标记、反引号或尾部 `--reason` 参数。
只解析结构化行，不从其它中文正文推测授权，也不执行规格里的命令。

`pmWakeTicks` 中自动登记先于 observationTick。调度连接只读，自动登记经带租约的
`ledger scheduler-observation-register <卡>` 重新读取正式规格、检查本项目自动调度仍启用后写入。
只扫描 verified 且未有 `post-verify-done:<卡>` 的卡；时长复用 observationHours，起点是最近 verified。
同项目同目标只保留一条 active 计划，已有手动计划优先；同一卡同次 verified 的终结计划不自动重登，撤销后不与 PM 抢控制。
tick 用只读计划快照与本次 verified 后的 skip note 预筛；已有登记或已跳过的目标不重复调用登记命令，新增目标与新的 verified 仍会核对。

计划的证据来源保持 `source=ledger-events`；自动计划的 `authorization.source=spec`，另记录正式规格路径、完整内容 SHA-256 摘要及该卡 PM；
卡没指定 PM 时取项目当班 PM。每次到期及进入目标 writer 的锁后，均重核该 PM 仍有配置权、规格摘要未变、
specRev / 最近 verified / 目标 observe 世代 / 配置版本未变。卡已离开 verified 或卡 PM 被改也不转正。
调度身份不能使用手动 observation-register；新登记口和 pm_todo 写口均拒绝 PM、执行者以及无有效租约的调度调用。

目标不是 observe、诊断错误、键不认识、第一行时长没认出或 PM 无配置权：不登记，在卡上写
`op=observation_register_skip` note，按卡 + 键去重，不通知。
整机键、manualStall、autostart 字段保持原有登记约束；自动登记只做项目恢复键。

## 手动入口

```
ledger observation-register <卡> --target recovery:<键>|autostart:<字段> --project <项目> \
  --rule v1 --source ledger-events [--hours N] [--start 毫秒或ISO] --reason 原因
```

手动入口仍只允许项目配置人（PM，调度助理除外 / master / owner）；其计划继续推送转正摘要或交 PM 判断通知。
可登记 autostart 的 mergePmWait / postVerifyDefer / reviewPmWait / specWait / wipGate，不能给 autoMode、p2BacklogMode 自己转正。
起点不能早于最近 verified 或本次 observe 世代。没有 configRev 的旧计划不转正。

- `observation-cancel <登记号> --reason …`：撤销，自动计划的顺延待办同时关闭。
- `observation-mark / observation-unmark <登记号> --misjudged <事件号> --reason …`：标记、清除人工误判。
- `observation-recheck <登记号> --reason …`：把 judged 计划放回，原绑定与窗口不变，换一个转正幂等键。
- `observation-plans [--project 项目] [--all]`：列计划，自动计划显示来源 spec、授权绑定、顺延次数。
- `observation-due <卡> <登记号> [--sent]`：核对；--sent 记已送。调度自动计划直接记账，不调用 sendToPm。

## 证据与顺延

按项目和窗口 `[startAt, dueAt]` 只读台账结构化事件。专用适配器优先：dagWriteScrub 仍使用
DAG 事件的 data.dagWriteScrub 观察记录及 op=converge_dag_scrub 错误，口径不变。
其它 RECOVERY_KEYS 中的键使用通用适配器，键先校验白名单，再通过 SQL 参数绑定：

- 观察记录：kind=note、op=recovery_observe、mechanism=目标键。
- 错误记录：op=recovery_error、mechanism=目标键。
- 错误写口：`recordRecoveryError(db, {project, mechanism, actionKey, error})`，按 project + mechanism + actionKey 去重。

**这是对 PMAUTO1 的有意放宽：错误来源从必须存在改为有则核。没有 recovery_error 事件也允许按样本转正，
不代表日志没有错误或所有机制都已接入错误写口。** 仍须证据可读、窗口走完、结构化错误为零、未清误判为零。

自动计划零样本且其它口径通过时，dueAt 加一个原始时长，最多两次；第三次到期仍零样本 → judged/no_samples。
高风险键额外要求累计窗口 ≥24 小时、样本 ≥3 条；不足也按相同两次上限顺延，耗尽后交 PM。
有错误、未清误判、证据不可读或授权陈旧时立即 judged，不借顺延绕过这些条件。
手动计划的零样本保持原有立即交 PM 行为。

## 开关和结果拉取

沿用项目 `autostart.autoMode`（旧配置缺省 observe）：

| 档 | 自动登记 | 到期 |
| --- | --- | --- |
| off | 不登记 | 不核、不发 |
| observe | 正常登记 | 仅一次 dry-run note：本会转正 / 本会顺延 / 本会交 PM，不切、不实际顺延 |
| on | 正常登记 | 按证据转正、顺延或判定 |

一键回退：`ledger autostart-set off --auto-mode off --reason …`；单条可 observation-cancel。

自动计划的转正、判定和顺延均不推送 PM；tick 直接 --sent 记账。PM 用 `ledger pm-todo` 拉：
判定条目包含原因和证据行；顺延条目 due=false，仅 `--all` 显示。只有观察期和自动转正行的卡，
全部目标转正后补 `post-verify-done:<卡>` 幂等 note 并消失；含其它检查项的卡保留，摘要注明「开关已自动转正」。
登记中只在卡片摘要注明「开关已交系统观察」，卡片待办仍保留；部分目标跳过登记或 PM 关闭判定条目，都不等于完成上线后工作。

通用写口 `recordPmTodo(db, ctx, {project,target,kind,text,dedupKey})` 写 op=pm_todo 的 note，按 dedupKey 去重。
去重键拒绝 `post-verify-done:` 与 `pm-todo-done:` 完成命名空间，不能借新增待办伪造完成或关闭其它条目。
`ledger scheduler-pm-todo <卡> --kind K --text T --dedup K` 仅调度身份使用，只接受这些字段，不接受任意 op / data。
普通待办缺省列出，不受卡阶段或观察期限制；PM 用 `ledger note <卡> --text 已处理 --dedup pm-todo-done:<dedupKey>` 关闭。
观察期旧顺延条目会在下一次顺延、判定、转正、取消或 recheck 后自动关闭，避免过期结论继续列出。
PVDEFER1 提醒算法未改。

## 事件与崩溃恢复

- `observation_plan` decision：登记 / 撤销 / 标误判 / recheck；自动登记包含证据来源 source=ledger-events 与授权来源 authorization.source=spec。
- `observation_plan` note/action=judged：自动判定。
- `observation_extend` note：登记号 + 顺延次数幂等。
- `observation_dry_run` note：observe 档预演。
- `observation_promote` note：成功模式、窗口、样本引用、原 writer 审计号。
- `pm_todo` note：observation_judged / observation_extended 或其它调用方类型。
- `post_verify_done` note：纯自动工作全部转正后完成卡待办。

转正继续用原 writer（恢复键 setRecovery、autostart setAutostartSwitch），以绑定 PM 身份执行，
先存 prepared，再发布开关，再存 published 并补成功 note/noted。原 writer 锁内重核 autoMode=on 和计划锁仍有效。
发布后崩溃仅补 note；发布前失败交 PM；审计 published / void 或恢复文件 rev 核定是否实际生效。
不改 stage、workflow-resume 或 manual-merge-request。

## 高风险分类核对

`recovery-key-class.ts` 仅分类，不设缺省档。逐个核过当前 RECOVERY_KEYS：下列键涉及安全证明、权限或资源清理，
按高风险处理；未列出的键为普通调度、排队、记录、部署时序或重试策略，没有新增 schema 迁移恢复键，schema 类目前为空。
manualStall 仍禁止自动登记，分类不授予额外权限。按字母序，每行一个键与理由：
- `authorRebuild`（permission）：依据退役证明重建作者并重新指派。
- `cardProcReap`（delete-data）：回收卡片进程及其运行资源。
- `ciCoverageGate`（safety）：决定合并所需 CI 证据是否齐全。
- `ciIoMapFuse`（safety）：熔断 CI 输入输出映射的不可信证据。
- `ciManualResume`（permission）：按 CI 证明把人工卡交回自动调度。
- `ciProofReuse`（safety）：复用已有 CI 通过证明。
- `ciSelectedGate`（safety）：决定所选 CI 检查是否覆盖所需验证。
- `ciWebBuild`（safety）：决定生产构建是否构成 CI 放行证据。
- `convIgnoredBuildArtifacts`（delete-data）：隔离和清理被忽略的构建产物。
- `dagWriteScrub`（safety）：拦截不能下发的 DAG 写入。
- `effCountCarry`（safety）：为纯副作用计数修复继承正式审查证明。
- `iaWatchdogScope`（permission）：限定 agent 间看门狗的消息来源。
- `lendAuthorRebuild`（permission）：退役已结束租约的 peer 作者绑定并接管修复。
- `lendUiShots`（safety）：登记出借交付的截图验收证据。
- `lendUiUpload`（safety）：把本机截图材料上传给 peer。
- `lendUsageReport`（safety）：向 peer 发送本机单会话用量数据。
- `localReviewAdopt`（permission）：接管本机人工审查的授权来源。
- `mainCarry`（safety）：将旧 head 的审查证据沿用到新 head。
- `mainCarryMerge`（safety）：以纯 main 合并证明沿用审查结论。
- `manualCaseOwnership`（permission）：决定人工事项的处理责任人。
- `manualMergeQueue`（permission）：凭 PM 人工请求授权进入合并队列。
- `manualRecovery`（permission）：按证据把人工工作流交回自动调度。
- `manualStall`（permission）：强制恢复人工卡，仍保留原有禁止登记规则。
- `mergeContentReview`（safety）：以内容证明认定审查证据有效。
- `mergeContentUi`（safety）：以内容证明认定 UI 验收证据有效。
- `mergeDirect`（safety）：直接合并已核准的 PR。
- `mergePipe`（safety）：流水合并的证据与合并条件。
- `mergeUnion`（safety）：自动处理白名单文件的 union 合并。
- `mirrorSkipBlockedId`（safety）：排除被脱敏拒绝的卡后继续镜像上传。
- `modelOutcome`（permission）：按已批准的豁免跨模型家族接续拒审。
- `nearMarker`（safety）：按验收线附近标记调整正式审查级别。
- `peerLeaseRecovery`（permission）：恢复跨机派单租约的控制权。
- `pmRails`（permission）：监督 PM 越权写入并通知 owner。
- `privateMergeNarrow`（permission）：限制私仓合并目标与执行范围。
- `privateStartPlacement`（permission）：私仓任务跨机放置范围。
- `reclaimLocalFix`（permission）：租约回收后重新指派本机修复执行者。
- `skipEffectsAutoScope`（permission）：自动批准副作用清单的范围例外。
- `staleReplacement`（delete-data）：退役过时执行者并创建替代者。
- `teamBody`（safety）：允许卡片正文上传到共享中心。
- `uiCarry`（safety）：继承 UI 验收证明。
- `uiCarryOwnGlobs`（permission）：限定可继承 UI 验收的文件范围。
- `uiDelivery`（safety）：把截图材料纳入正式 UI 交付检查。
- `uiManualResume`（permission）：按截图批准证明把人工 UI 卡交回自动调度。
- `uiOwnerAskFresh`（permission）：核定 owner 验收请求的新鲜度。
- `uiOwnerCarry`（permission）：继承 owner 的视觉批准。
- `uiOwnerReask`（permission）：重发 owner 视觉验收请求。
- `uiReviewCarry`（safety）：继承 UI 审查证明。

相关测试：tests/observation-auto-register.test.ts、tests/observation-plan.test.ts、tests/pm-todo-note.test.ts、tests/pm-todo.test.ts。
