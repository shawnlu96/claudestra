# 入站路由：目标忙时由 Jev 判「打断 / 排队 / 合并」

目标 agent 主回合在跑时，新到的一条消息怎么投。改动前是按来源一刀切：人类 request 一律打断（CC 发 C-c），本机 agent 消息一律押到回合结束，PM 的收件箱因此排大队。开关打开后，忙时这一条先问 Jev：

| 结论 | 意思 | 怎么执行 |
|---|---|---|
| `interrupt` | 改方向 / 叫停 / 答它正在等的问题 / 等不了的事故 | 现有抢占：Claude Code 发 C-c；Codex 按现有限制（`allow`）；Pi / ACP 不打断，消息 steer 进回合 |
| `queue` | 独立的新问题、通知、致谢 | 押到回合结束（押后队列），Stop / 扫描时投；忙时 `check_inbox` 也领得到 |
| `merge` | 补充 / 更正 / 重复排队里的某一条 | 押着，投递和领取时紧跟那条同伴；两条都是本机 agent 消息时并进 HMB-1 的一封载体（[held-agent-batch.md](./held-agent-batch.md)） |

## 为什么规则在代码、语义在 Jev

Jev 擅长「这句话是不是在改方向、是不是在补充排队里那条」这种语义判断（调研 12 个合成例 11/12，每次约 300–500 ms、约 $0.00003）；它不擅长、也不该负责权限。唯一判错的一例是 peer 发 `URGENT: stop everything…` 被判打断。所以：

- **谁能打断写死在代码里**：只有 owner 本人（`isOwnerSource`，转交来的 owner 原话不算）。Jev 判了 `interrupt` 而发送人不是 owner → 改成 `queue`（`lib/inbound-route.ts decideRoute`，日志 `downgraded: "not_owner"`）。权限规则也写进了问题里（调研：写进去后 peer / 冒充 owner / agent 冒充的打断概率 0 / 0.05 / 0.01），但不靠它。PM 对自己项目执行者不开打断权：PM 的消息照 agent 消息走。
- **merge 只在同一个人之间、或本机 agent 之间**：不同 principal 的话混进一轮，Stop 兜底会把答给一个人的话结给另一个（`held-flush.ts mayJoin` 的同一个理由）。Jev 选了不能合并的那条 → `queue`（`downgraded: "merge_target"`）。人的两条只保证紧挨着投，不拼成一封：拼成载体就丢了逐条的回程登记（`pendingReplies` / chat_id），见 `bridge.ts` 混批无人认领那段。
- **不问 Jev 的**：目标空闲（直接投）、压缩中（照旧押）、停字（照旧直接打断）、bridge 通知、答复 / 通知类、带 `waitForIdle` 的、空文本。
- **回落现有规则**：没配 key、超时（单独问 1.5 秒；和 Chat Guard 并在一次时用守门的 8 秒）、出错、答案格式不对、拿不准——所选项概率 < `ROUTE_MIN_P` = 0.6（调研里判对的最低是 0.90）；merge 的同伴概率 < 0.5 改按排队。

## 三处一致

结论只在开关 `on` 时写在信封上（`meta.inboundRoute`，随押后队列落盘），三处都经 `bridge/inbound-route.ts` 读它：

- `deliverToLocal`：抢不抢（`preemptForHuman` 第一行 `routeAdmitsWhileBusy`）、押不押（`routeHolds`）；
- `held-flush.ts`：忙时到期过滤（判了排队的人类消息不放出来，否则放出来又押回 / 抢占）、投递顺序（`routeOrder`）；
- `inbox.ts`：领取顺序与 merge 跟同伴一起领（`routePullable`）。

开关切回 `off` / `observe` 时信封上的结论一律不认，三处同时回到改动前（`isHumanRequest`）。owner 消息被判排队后押满 2 分钟（`OWNER_HELD_MAX_MS`）仍没投出去，结论作废、按原规则投——一直有后台在跑的 PM 等不到回合结束。被 Chat Guard 隔离的消息结论作废，放行后按现有规则投。

## Chat Guard

目标开了 Chat Guard 时，路由问题（state 键 `agent` / `incoming` / `queue`，问题键 `route_action` / `route_merge_with`）并进守门那一次 Jev 请求，不另发、不加延迟（`bridge/chat-guard.ts judge`）。

## 开关

`config.json` 的 `inboundRoute.mode`，缺省 `off`；bridge 每 2 秒现读，切换不用重启。

```bash
bun src/manager.ts inbound-route status|off|observe|on
# 或 PUT /api/v1/settings {"inboundRouteMode":"observe"}（要 manage 授权；GET 回当前档位）
```

- `observe`：投递完全照旧、不等 Jev；每条忙时消息判完记一行。先开它对照几天。
- `on`：按判定执行。

## 日志

状态目录 `inbound-route.jsonl`（0600，满 32 MB 转 `.1`，只留一代）。一行一条：`mode`、`msg`（message_id）、`agent`、`from` / `role`、`preview`（正文前 80 字）、`queued`（排队条数）、`rule`（现有规则会怎么投：interrupt / queue / deliver）、`jev`（Jev 判的：interrupt / queue / merge / unsure / error）、`p`、`mergeWith`、`downgraded`、`actual`（实际怎么投）、`via`（solo / guard）、`ms`。observe 下 `actual` 恒等于 `rule`，对照 `jev` 和 `rule` 不一致的行就是开了 `on` 会变的地方。

## 测试

`tests/inbound-route.test.ts`（纯逻辑）、`tests/inbound-route-runtime.test.ts`（开关 / 回落 / observe / Chat Guard 合并）、`tests/inbound-route-three.test.ts`（三处一致、merge 回复归属）、`tests/inbound-route-replay.test.ts`（12 + 4 个合成例的录制回放，夹具 `tests/fixtures/inbound-route/cases.json`，重录方法见夹具的 `about`）。
