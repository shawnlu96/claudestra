# 人工卡交付提醒（RVF-2）

人工流程卡（workflow 不是 `auto`：`manual`、`observe` 或没有 workflow）没有调度器接手，执行者 `ledger deliver` 之后要 PM 手动派审。
以前交付通知只投给调度助理，PM 收不到，曾空等近 2 小时。现在交付后一定有人接，逐级往上推：

| 时刻 | 动作 | 收件人 |
|------|------|--------|
| 交付（bridge 下一轮扫描，≤ 1 分钟） | 「交付即通知」，带 `ledger dispatch <卡>` 命令 | 卡的 PM（action 级：PM 正忙就押到回合结束送达） |
| 交付后满 N 分钟（≥ N，缺省 10）仍没有 dispatch / review 事件 | 【升级】；没送到每轮重试 | 卡的 PM |
| 升级送到（或第一次没送到）后满 M 分钟（缺省 30）仍没有 | owner「待你处理」（kind `owner_action`），写明卡号、项目、交付时刻、该谁派审、派审命令，以及升级有没有送到 PM | owner |

- **撤销**：之后出现 dispatch 或 review 事件（或卡离开 build / review / fix、转成 auto、又交付了一次），这次交付的提醒停止；开过的 owner 卡自动关掉（cancelled），关不掉下一轮再关。
- **回到等审**：同一次交付撤销后又回来（review → blocked → review、交回 auto 又退回人工，中间没有新交付），记录接着用：已升级过的不再升级；
  已关掉的 owner 卡作废，到点再开一张新的（dedupKey 带开卡时刻，不会撞上已结案的旧卡），之后派审照样自动关。
- **PM 不在**：升级投不出去（不在 registry / 不是 active）或项目没有 PM，不会卡在 PM 这一级：从第一次没送到算满 M 分钟照样进 owner，卡上写明没送到的原因。
- **不触发**：自动卡；不在 build / review / fix 的卡。
- **不重复通知**：班子路由（`lib/team-route.ts`）已把交付直推给 PM 的项目——开了班子且没配调度助理，或调度助理就是 PM——不再发「交付即通知」；PM 自己交付的也不发。升级与 owner 卡照常。调度助理那条交付通知不变。
- **PM 是谁**：任务上记的 `pm` 优先，其次 PM 名单里第一个不是调度助理的（与巡检 `auditRecipient` 同一口径：配了班子只认 `team.dispatcher`，没配按名字里的 `dispatch` 认）；名单里只有调度助理（PM 兼调度助理）时就是它。

## 阈值

`~/.claude-orchestrator/manual-deliver-notice.json`（随 `CLAUDESTRA_STATE_DIR`）：

```json
{ "pmAfterMin": 10, "ownerAfterMin": 30 }
```

两项都是 1..1440 的整数，可只写一项；文件不在 = 缺省；写错 / 读不了 = 缺省并在 bridge 日志里说一次。每轮现读，改了不用重启。

## 与巡检 `manual_deliver_no_review` 的关系

巡检（`lib/ledger-audit.ts`，每 15 分钟）用同一份阈值：交付后满 N 分钟（≥ N，与提醒同一比较）、还没有审查结论才报，收件人是同一位卡的 PM。
去重共用一份状态：bridge 已给 PM 发过升级的交付，巡检只 keep 不推；巡检先推了或押着（`audit_findings.notifiedAt` / `queuedAs`）的，bridge 不再发升级，
owner 那一级从巡检推送的时刻起算。两边在 bridge 里经 `serialMdn` 串行（巡检整轮、提醒整轮互不交错），bridge 重启后提醒首轮（60 秒）早于巡检首轮（90 秒），
同一次交付只推 PM 一次。巡检依旧在「有审查员在跑」时压住不推，这一点与提醒不同（提醒只看 dispatch / review 事件）。

## 实现

- 判定与文案：`src/lib/manual-deliver-notice.ts`（纯函数 + 状态 / 配置读写）。
- 定时器：`src/bridge/manual-deliver-notice.ts`，在 `startLedgerAudit` 里启动；启动 60 秒后首轮，之后每 60 秒。对台账只读（`LedgerReader`），
  通知走 `sendLedgerNotice`（与班子路由同一条押后投递），owner 卡经 `bridge/asks.ts` 的 `createAsk`（dedupKey `manual-deliver:<项目>|<卡>|<交付 seq>#<开卡时刻>`），撤销按 dedupKey 找卡关。
- 状态：`~/.claude-orchestrator/manual-deliver-notice-state.json`，每次交付一条（`notified` / `pm` / `pmFail` / `owner` / `ownerKey` / `askId` / `resolvedAt`）。
  每一步先记再投：投递没成功改回去、下一轮重投；状态写不下就什么都不发（不会每分钟重推）；owner 卡先记 `ownerKey` 再开，开卡后崩溃也不重开。
  一张卡出错只跳过这张卡，别的卡照常。撤销的记录保留 7 天再删；还在等审的记录不带撤销时刻，不会被删。
- 首次运行（状态文件不在）与平时一样：已在等的交付按真实交付时刻走升级链（超过 N 的不补发交付通知，直接升级），上线时在等审的卡至少收到一条提醒。
- bridge 停过、超过 N 分钟才第一次看到的交付：不补发「交付即通知」，直接升级。
- 测试：`tests/manual-deliver-notice.test.ts`。

## 已知限制

- 台账从备份恢复后事件 seq 可能回卷：同一张卡之后的交付拿到旧 seq 时，会被当成已处理的那次交付（不再通知 / 升级，巡检也被压住）。
  恢复台账后删掉 `manual-deliver-notice-state.json` 即可（下一轮按当前台账重新判，在等的交付走正常升级链）。
