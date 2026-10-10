# security 卡审查进统一池（i28-SECPOOL1）

security 模板的卡原先审查写死在本机。这个开关决定它的审查能不能和 code 卡一样进统一池（借入的 peer）。

## 开关

- 存在 `statePath("security-pool.json")`，形如 `{ "projects": { "<项目>": "on" | "observe" | "off" } }`，每个项目一个值。
  读写都在 `src/lib/security-pool.ts`，写走 `writeJsonAtomicSync`（tmp + rename）。
  各项目共用这一份文件：写者在跨进程锁 `security-pool.json.lock`（`lib/file-lock.ts`）里重读、合并、写回，两个 PM 同时切不同项目不会丢更新；20s 拿不到锁直接报错不写。
- 不在 `scheduler.json` 里。
- 命令：`ledger security-pool [on|observe|off] [--project <id>]`。不带取值只打印当前值；切换只有项目 PM、master、owner 能做。
  命令收到非法取值直接报错。
- 文件里写了非法取值，或文件损坏：按 off 处理，非法取值打一次带项目名的警告。

| 取值 | 派单 | 说明 |
| --- | --- | --- |
| off（缺省，含没写这个键） | 和开关出现前一样：security 卡只在本机审 | — |
| observe | 同 off | `ledger lend-orders` 的放置说明多一句「按统一池会放到 <peer>（<family>）」，或者池也放不下时说明原因；已经派出、还在等结果的审查也带这一句（本机那单按已绑定审查 session 的复审沿用规则算，已在池里的那单就是它） |
| on | security 卡审查和 code 卡一样进统一池 | 仍必须跨模型（审查家族 ≠ 作者家族），复审沿用原审查 session 的规则不变 |

## 规划器怎么拿到开关

规划函数是纯函数，不读文件。`autoSnapshot`（`src/lib/scheduler-auto-snapshot.ts`）只给 security 卡读开关，
填进快照的 `securityPool` 字段；没有这个字段就按 off。

带台账库的两处直接读文件：`scheduler-sessions.ts` 绑定审查 session，`lend-cli-author-family.ts` 手动挂出借单。
池单拒审（`scheduler-refusal-pool.ts`）由 `poolLedgerFacts` 读。

所有判断都调用 `securityReviewLocalOnly(workflow, mode)`：只有 security 卡、而且开关不是 on 时，才返回 true（只在本机审）。

## on 时变化的地方

- 放置：`reviewPlacement`、`agentPoolReview`、`poolTarget`（proto-1 的 R9 规则仍然只借 codex），以及池单拒审 epoch 的去处核对。
- 审查者独立性：peer 交回的审查（session source 不是 local）不再触发 `reviewer_independence`；审查家族等于作者家族时照旧触发。
- session 绑定：允许 `transport=peer` 的审查 session。
- 手动 `lend offer`：允许借出审查，跨模型检查照旧。
- 池单拒审：换审查人时可以换到别的 peer，不再只限本机。
- i28-SR1：本机对面家族名额是 0 时，统一池能放到 peer 就不报警；池里也放不下才照旧报警并发 PM 卡。报警文字不变，因为告警命令要按同一段文字去重。

## 不变的规则

- security 卡不让锁。
- peer PR 收卡。
- 外发闸、额度闸、跨模型规则。
- 审查要求不变，关键面要实测。派给 peer 的审查单走现有的出借单材料（卡规格里的审查要求原样带过去），本卡没有另写一份审查正文。

测试：`tests/security-pool.test.ts`。
