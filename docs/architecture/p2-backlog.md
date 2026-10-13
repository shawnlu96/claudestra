# 普通 P2 的持久积压（agents-PMAUTO1）

审查通过但留有 P2 的卡，调度器过去每张都给 PM 发一条「审查通过但留有 P2，已进合并队列，请看 diff」，逐张叫醒 PM。这条通知是 best-effort 的，持久的只有阶段事件。这里把其中的「普通 P2」登进一份持久积压，PM 只收一行摘要，定期统一收。

P2 从不挡合并：这里只决定通知怎么发。P1 判级、审查收敛、合并门都没动。

## 开关

`autostart.p2BacklogMode`，项目级，缺省 `observe`：`ledger autostart-set on|off --p2-backlog on|observe|off --reason …`。

| 档 | 行为 |
| --- | --- |
| off | 原通知逐字原样发；不读、不调、不写 |
| observe | 原通知照发；卡上多一条 note（`op: p2_backlog_observe`）：本会入积压哪几条、本会关联哪几条、哪几条仍交 PM |
| on | 普通 P2 先持久入积压，成功后通知换成一行摘要 |

## 什么算普通 P2

只看当前有效审查（本轮、本 head，`currentReviewFacts`）里的结构化 findings，从不搜正文。

整条审查不归类（原通知原样发）：结论缺结构化字段、finding 缺编号或编号重复、结论是 block、审查里还留着没降级的 P0 / P1。

结论口径和合并闸一致（`scheduler-plan.ts` `mergeReviewGate`）：收敛不改原审查的 verdict，所以 `pass` 和收敛后只剩 P2 的 `changes` 都认。

逐条交 PM 判断（随原通知一起发，注明是哪几条、为什么）：

- `family` 按 `.` `_` `-` 切成词元后整词命中范围 / 权限 / 审批 / 安全类（`scope`、`boundary`、`permission`、`auth`、`authz`、`approval`、`security`、`secret`、`credential` 等，见 `p2-backlog.ts` `PROTECTED_TOKENS`）；
- `family` 是没归类的占位（`unknown`、`other`、`misc` 等）；
- P2 却挂着验收线 / 回归依据（`basis`）；
- `family` 有任何一个词元不在普通分类白名单里（`p2-backlog.ts` `ORDINARY_TOKENS`：命名、文案、注释、文档、格式、整理、测试补充、日志这几类）；
- 本轮从 P1 降下来、但找不到 converge 跟进记录的。

本轮被收敛规则从 P1 降下来的 P2，converge 已经写过草稿和后续 DAG 节点（`review-converge-followup.ts`）。积压里只记一条关联（跟进事件 seq、草稿路径、节点 key），不抄草稿、不二次立项。

只有 `family` 的每个词元都在白名单里的才是普通 P2。认不出不等于普通：并发、持久化、接线这类说行为的分类，以及审查员新起的分类，都交 PM。范围 / 权限那张表只用来给出更准的原因，放行只看白名单；往白名单加词元等于承认这一类 P2 不用 PM 逐条看，要过审。

审查 finding 里目前没有文件路径这类结构化字段，「范围外文件越界」只能靠审查员填的 `family` 认；这是首版的已知局限。

## 积压放在哪

沿用现有的持久惯例，没有新表、没有仓外的 backlog：

- 每条一个台账事件：卡上的 `note`，`op: p2_backlog`，带项目、卡、轮次、`reviewSeq`、head、P2 编号、报告路径、摘要、`status: pending`、清单路径。dedupKey 是 `p2-backlog:[项目, 卡, reviewSeq, findingId]`，重复 tick、重启都不会重复登记。
- 一份清单 `<docsDir>/tasks/drafts/<卡>p2r<轮>s<reviewSeq>.md`（审查员的文字按外来数据引用）。一次审查一份：同一轮来了新的有效审查会另起一份，不沿用旧清单。

清单要核过才算持久：必须是普通文件、来源行是这次审查、每条普通 P2 的条目行都在。没有或是空文件就原子写，写完读回来再核；已有且完整就不动（PM 在别处加的批注留着）；路径是目录、被别的内容占着、缺条目 → 报错，不覆盖、不登事件。

不自动开 DAG 节点、不派单。先核好清单，再在一个事务里记事件；哪一步失败都整笔失败，通知退回原文。

## 通知

| 情况（on） | 发给 PM 的 | PMROUTE1 |
| --- | --- | --- |
| 全是普通 / 已关联的 P2 | `[P2 积压] <卡> 第 N 轮：P2 a、b 已入积压 <清单路径>`（有关联的再接 `；降级 x 关联跟进 #seq`） | digest（规则 `p2.backlog`，整条按完整模板认） |
| 还有要 PM 判断的 | 原通知 + `；需 PM 判断的 P2：x（原因）…；其余已入积压，见 ledger p2-backlog` | judge（原样） |
| 入积压失败 / 结论对不上 / 任何异常 | 原通知原样 | judge（原样） |

摘要只有在积压持久成功之后才发。

摘要里的卡号、P2 编号、清单路径是调度器填的结构化字段，字符集由完整模板限定。PMDIG3 的正文保护只看去掉这些字段后的固定文字（`pm-route-rules.ts` `pmLineFixedText`）：编号叫 `typo-failure`、目录里带 `P0` 不会把摘要打回 judge；模板以外多出的字不匹配规则，照旧整段受保护。

## 命令

- `ledger p2-backlog [--project <id>] [--card <卡>] [--last N]`：只读列表，新的在前。
- `ledger p2-backlog-record <卡> --review-seq <审查事件号> --mode on|observe`：写口，调度服务在发通知前调；PM / master / owner 可手动补登。审查换了一轮或开关刚改，返回 conflict，不按陈旧快照写。

## 接线

`scheduler-auto-tick.ts` 的 `diffNotice` 只接一行：把拼好的原文交给 `p2DiffNotice(this.db, this.task, text, this.deps)`（`p2-backlog-notice.ts`）。调度进程只多依赖 `p2-backlog-notice.ts` 和只读的 `p2-backlog-mode.ts`，积压 writer 留在 `ledger` 子命令里。`scheduler-v2-skip-effects.ts` 登记了 `p2-backlog-notice.ts`（manager，`ledger=1`），`scheduler-v2-skip-paths.ts` 的 `SKIP_LEDGER_COMMANDS` 有 `"p2-backlog-record": "task"`。命令怎么进 `ledger` 入口、调度身份能调哪两条，见 [observation-plan.md](./observation-plan.md)「命令入口」。

## 上线顺序

先留 `observe`，看几张卡上的「本会入积压」和关联是否对，再人工开 `on`。`tests/p2-backlog.test.ts`；真实调度路径在 `tests/p2-backlog-entry.test.ts`。
