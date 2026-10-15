# Floka 改名：滚动观察与收兼容退出证据（rename-floka-OBSERVE1）

本页只讲**怎么证明可以收兼容**。工具只读显式给的脱敏样本，不接生产统计、日志或台账，不切任何协议档位；
收兼容本身（删旧族接收、旧安装别名）另开卡，由 PM 核全部条件后再讨论，**不自动切 on**。

## 1. 工具

```bash
bun scripts/rename-floka/observe.ts --sample <样本.json> [--config <config.json>] [--out <临时目录>]
```

| `rename.observation` | 行为 |
|---|---|
| `off` | 什么都不做，返回 0 |
| `observe`（缺省；写错也按它） | 报告打到 stdout，**零写入**；给 `--out` 直接报错 |
| `on` | 同 observe，另把报告新建写入 `--out`：目录必须已存在、真实路径严格在系统临时根下、同名文件不覆盖 |

退出码：`0` 退出条件全满足；`1` 报告已出但不许退出（看 `exit.reasons`）；`2` 用法 / 样本错误。

## 2. 样本格式（只许计数、时间戳、枚举）

样本只认下面这些字段，多一个键整份拒；原文里出现 `tok_` / `dev_` 前缀、`cstra_*=` / `floka_*=` cookie 赋值、
PEM、40 位以上 base64 或 32 位以上 hex 也整份拒，报错不回显内容。节点 id 只许 `[a-z0-9-]`（写不进域名、IP、URL）。
**缺的格子补成 `"unknown"`，判定里与有旧流量同等拒绝——没观测到不是零。**

| 字段 | 含义 |
|---|---|
| `fleet.machines` | 应有几台主机（目前 3） |
| `nodes[]` | `{id, kind: machine/relay/ledger, version, receiveFloka, sendFamily: legacy/floka}`；三类都要有 |
| `allNewSendAt` | 最后一个节点切到新族发送的时刻；`null` = 还没全部切 |
| `window` | 零旧流量窗口 `{start, end}`，start 不得早于 `allNewSendAt` |
| `rollbackPeriodMs` | 回滚期；`allNewSendAt + rollbackPeriodMs` 之前拒绝退出 |
| `traffic[]` | `{direction: receive/send, area: signature/relay/ledger/e2e/browser, source: machine/center, legacy, floka}`；relay、ledger 两区另要中心（center）视角 |
| `sessions.legacyMcp` | 还挂着旧 MCP 名的会话数 |
| `clients[]` | `{kind: browser/sw/native, legacy, offline}`：旧格式客户端与离线未回来的客户端 |
| `pending` | `{legacyCalls, maxExpiresAt}`：旧族待处理调用 |
| `payloads[]` | `{kind, legacyLive, maxExpiresAt}`：存量旧族载荷，见 §3 |
| `infra` | `domain / vapid / systemd / nginx / installCopies` 各 `done / pending / unknown`，单独报告，未 done 也拒绝退出 |

## 3. 有效期与观察窗口

| 载荷 | 最长有效期 | 出处 |
|---|---|---|
| 一键邀请（invite-pop） | 24 小时 | `src/lib/peers.ts` `INVITE_TTL_MS` |
| 签名能力证明 | 7 天 | `floka-compat/signature/capability.ts` |
| E2E 能力证明 | 7 天 | `floka-compat/e2e/capability.ts` |
| 中心能力 | 24 小时 | `floka-center/capability.ts` |
| 设备凭据（cookie 名带旧品牌） | 90 天 | `src/lib/devices.ts` `CREDENTIAL_TTL_MS` |
| 审查票据 / 结果回执 | **无过期字段** | `pool-review-proof-ticket.ts`：只能实测 `legacyLive = 0` |
| 待处理调用、离线客户端 | 代码里无统一上限 | 只能实测 |

要求窗口 = max(14 天, 已知最长有效期) = **90 天**（被设备凭据撑长）；回滚期另算，两者都满才放行。
任何 `unknown` 都延长窗口，不缩短。若浏览器族要早于其他区收兼容，需另开卡把窗口按区拆开，本工具不做。

## 4. 现有观察出口核对（开工时 origin/main 426379058）

| 来源 | 现在能给什么 | 缺口 |
|---|---|---|
| SIGN1 / peer（`floka-peer/signature.ts`、`capability.ts`） | `observePeer(area, verdict)` 打一行 `[floka-peer] observe …` 到日志 | 逐条判断，无聚合计数、无族×方向分格 |
| LEDGER1（`floka-ledger/config.ts`） | `LedgerObservation {use, family, wouldAccept}` 经 report 打日志 | 同上；中心侧不在本仓 |
| RELAY1（`floka-compat/relay/gear.ts`） | 每条消息挂 `observed {candidate, wouldReject}` | 调用方不落计数 |
| 中心（私仓 floka-ai/cloud，worktree head ae10e56） | **无任何 rename 观察** | **阻塞**：`center_observation_missing` |
| 浏览器 / SW / native、旧 MCP 会话、待处理调用 | 无出口 | 全部 `unknown` |

结论：现阶段只能由人按上表从日志和清单手工汇总成样本；在补齐聚合出口和中心观察之前，
真实样本必然含 `unknown`，退出判定必然拒绝——这是预期结果，不是工具问题。

## 5. 滚动顺序与每步证据

1. **中心先双认**：relay / 台账中心接收开 on，样本里 `nodes[kind=relay|ledger].receiveFloka = true`。
2. **一台试点**：试点机接收 on → 发送 on；跑一次本工具，确认试点机格子的新族计数在涨、其余机器不受影响；做一次回滚演练（发送退回 observe）并记录时间。
3. **其余两台**：同上；最后一台切发送的时刻写进 `allNewSendAt`。
4. **观察期**：从 `allNewSendAt` 起至少 90 天且回滚期满，期间每次跑出的 `exit.reasons` 原样留档。
5. **退出**：本工具返回 0 且 `blockers` 为空后，交 PM 核全部条件，再讨论另开收兼容卡。不删身份、历史与旧读兼容以外的任何东西。
