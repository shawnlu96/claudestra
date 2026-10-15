# 项目记忆调优：出借单 / 全文直发注入与样本口（PMEMTUNE1）

10-16 基线（近 7 天）：写单覆盖 185 / 1392 = 13.3%，检索成本 / 延迟 0 样本。主因是出借单（76.7% 的写单阶段涉及出借）和
全文直发不经领单入口，所以从不带记忆；成本 / 延迟是没写字段，不是测得 0。本卡补这两个口和样本；相关性归 PMEMTUNE2。

## 三个渠道，同一套检索

| 渠道 | 入口 | 何时记推出 | 开关 |
| --- | --- | --- | --- |
| `local_take` | `take_order` / `take_review`（memory-retrieve-take.ts → withMemory） | 真实领取拼单时（原样） | 无（原有） |
| `lend` | 挂出借单（ledger-lend.ts renderLendOffer → memory-retrieve-lend.ts） | 出借单行写进 `lend_orders` 之后，同一事务 | `memoryLendInjection`（safety，缺省 observe） |
| `direct` | 调度器全文直发（scheduler-auto-tick.ts、scheduler-dispatch-recovery.ts → memory-inject-dispatch.ts） | 发送结果是 `sent` 之后 | `memoryDirectInjection`（缺省 on） |

三个渠道都用 memory-retrieve-order.ts 的 `fitMemory`（同一套三路排名、选择、渲染、预算）；没有第二份排序。

- **出借只放 team**：候选按 `visibility = team` 过滤后再排名（排名缓存另记一份，键尾 `:team`），画行时再核一次可见性；
  home 记忆在任何路径都不进出借 wire。记忆节先单独过一遍 peer 外发闸（`redactOrderForPeer`），拒了就整节不放，单子照发。
  中心化出借（`notes: false`）不注入、不写事件。
- **预算**：write / fix 4 条 / 1600 字节，review 只放坑 3 条 / 1000 字节（`MEMORY_CAPS`），整单仍受 `WIRE_MAX_BYTES` 约束。
- **全文直发发送前不写台账**：接管路径认领后若项目有新事件会作废重规划，所以排名在内存里现算，发出去后才登记排名、推出、尝试和
  缺省档记录。wake 投递由收件人自己领单（`local_take`），这里不碰；`workOrderFor` 本身不改（它也给审查材料冻结和复述单用）。
- **故障不挡派单**：检索抛错 / 准备超时 → 按无记忆照发，尝试记 `error` 与原因。出借的异步准备 `prepareLendMemory`
  （补嵌入、语义路，带总时限）在事务外调；没调时出借按图 + 文件两路在事务内现算。

## 样本口（只追加记录）

- `memory_rank` 事件带 `elapsedMs`（检索开始到选完）。
- 自动总结写入事件带 `costUsd`：有模型调用按响应 `usage` 计价（数值）；没调模型写 `null` + `costReason: no_model_call`
  （`costDetail` 说为什么：simple_card / no_lesson_port / prompt_secret / endpoint_unconfigured）；调了算不出写 `null` + `cost_unknown`。
- 每次检索尝试一条 note，`op = memory_inject_attempt`：`taskId`、`orderId`、`channel`、`order`、`result`
  （injected / empty / budget_drop / filtered_visibility / error）、`count`、`elapsedMs`。同一单号同一渠道只一条。
  出借 observe 档不写尝试，只写 `memoryLendInjection` 的恢复观察样本（按单号去重：条数、各条 visibility、字节数、本会的结果）。
- `ledger memory-metrics` 新增 `channelCoverage`（各渠道有尝试的写单数 / 推出的写单数、未覆盖原因分布，
  `no_attempt` = 没有任何尝试、`observe` = 出借只记了样本）与 `summaryCost`（priced / noModelCall / costUnknown / unmarked）。
  原有字段（含 `coverage`、`costLatency`）含义不变。

## 回退

`ledger scheduler-recovery <project> off --key memoryLendInjection`（或 `memoryDirectInjection`）：off 档单子与事件逐字回到改动前。
发现 home 记忆出现在出借 wire 里，立即把 `memoryLendInjection` 切 off。

测试：tests/memory-lend-inject.test.ts、tests/memory-inject-dispatch.test.ts、tests/memory-inject-attempt.test.ts、
tests/memory-metrics-channels.test.ts、tests/memory-auto-summary-cost.test.ts。
