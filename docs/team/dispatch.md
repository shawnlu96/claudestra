# 统一派单（T48）

协作模型第一期第 2 项（[collab-model.md](./collab-model.md) §4「派单」）：PM 不再手写任务单，某一步选定执行者后由系统生成、投递、记账。

## 命令

```bash
# 登记对方实例在这个项目上的 PM（目录），并发 = 对方入口同时能接几步；agent 留空 = 删除
bun src/manager.ts ledger team-set --peer-pm Shawn=agent-claudestra-dev --concurrency 2
# 派一步：派人（task_steps）→ 生成步骤单 → 记 dispatch 事件与投递行 → 当场投一次
bun src/manager.ts ledger dispatch T48 --step write --to agent-exec
bun src/manager.ts ledger dispatch T48 --step review --to agent-codex@Shawn --kind peer
# 这张卡的派单、送达、回执
bun src/manager.ts ledger dispatch-log T48
```

`dispatch` 不带 `--step` 仍是原来的派审查员（review-pack）。能派的步骤：restate / write / review / fix / final_review / ui_check；合并部署、核对只由仓库所在实例的 PM 做，不出任务单。

## 规则

- **通道**：本机 agent 经 bridge 的本机专用入口 `dispatch_to_agent`（`bridge/dispatch-route.ts`：只收本机 agent 名，不像 `route_to_agent` 那样把 `x@peer` / `peer:` 转成远程投递；`--kind agent` 的执行者带 `@` 或 `peer:` 当场拒）；`<x>@<peer>` 只发给目录里登记的对方项目 PM，不直接找对方执行者，没登记就拒派。目录记在台账 meta（`peerPms`），不放 peers.json（凭据文件）。
- **首行**：卡上还没有这个 peer 的 accept 事件 → 新委托 `[协作 Txx]`（接方先问 owner，或凭常设授权直接接）；已接受或本机执行者 → 步骤单 `[协作 Txx/<步骤>]`。生成器（`lib/dispatch-order.ts`）与接方的解析（`lib/collab-note.ts`）同一口径，单测互相校验。
- **内容**：只写输入 / 产出 / 验收与回报命令；规格卡、审查报告当数据，每行加 `│ ` 前缀。修 / 审的单子附本轮审查报告全文（review 事件正文、结论 md、同一审查方这一轮写的 note，本机或 peer 写的都收）。
- **脱敏**：发往 peer 的单子先按敏感字段名遮整段值（`lib/redact-fields.ts`：字段名以 token / password / secret / api_key / authorization / credential / private_key 结尾；JSON、YAML、`key: value`、`key=value`、`--token`；引号跨行、块标量、折行都算），再过 `lib/dispatch-redact.ts`（带前缀的密钥、长随机串、内网地址、邮箱 / 电话 / 家目录名），末尾写「本单脱敏 N 处」。纯函数，同样输入逐字同样输出。
- **去重与幂等**：`--step` 派单默认按「卡 / 步骤 / 执行者 / 轮次」去重（`--dedup` 可覆盖），判在派人之前，重复时步骤结果不动、不再发；改派别人再改回来算新的一次。每张单子带稳定发送标识 `dispatch:D<派单编号>:r<轮次>`，重发不变；接收端按「发送方 + 标识」只投一次、回第一次的 thread（`lib/delivery-dedup.ts`：本机入口按目标 agent，messages API 按 Bearer 哈希，落盘 7 天）。
- **记账与回执**：`dispatch_log` 表一张单子一行（主键 = dispatch 事件 seq），正文存生成时那份，重发不重新生成。回执 = 执行者在卡上写了任何事件（本机按 agent 名，peer 按 `peer:<实例>`）。
- **重试与提醒**：bridge 每分钟看一眼有没有未回执的派单，有才跑 `ledger dispatch-sweep`：送不出去按 1、2、4、8… 分钟退避重发（封顶 1 小时），连着失败 4 次提醒 PM 一次；送达后 15 分钟没回执提醒 PM 一次（从送达算）。提醒记成卡上 `bridge-rule` 的 note，并直接投给卡的 PM。同一步后来又派了别人、或卡已结束，旧单停止。
- **常设授权**：接方 `peer-ledger <peer> accept <T> --ask <askId>` 也认 `bind.action = peer_accept_standing`、params `{peer, project}` 的卡（project = 对方卡上的项目）；收回 = owner 取消或重开那张 ask。ask 的有效期上限是 7 天，到期要重签。
- **回报不是新委托**：peer 发回 `[协作 Txx/<步骤>]` 时，若本方台账里这张卡有一步派给了这个 peer，注入头说明这是回报、不要求先问 owner（`lib/peer-delegated.ts`）。

代码：`src/lib/dispatch-order.ts`、`src/lib/dispatch-redact.ts`、`src/lib/redact-fields.ts`、`src/lib/delivery-dedup.ts`、`src/bridge/dispatch-route.ts`、`src/bridge/api-dedup.ts`、`src/lib/ledger-dispatch-log.ts`、`src/lib/ledger-peer-pms.ts`、`src/manager/ledger-step-dispatch.ts`、`src/bridge/dispatch-sweeper.ts`；测试 `tests/dispatch-order.test.ts`、`tests/ledger-step-dispatch.test.ts`。
