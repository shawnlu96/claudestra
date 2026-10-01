# 借别人的算力：远端 worker 池（阶段 4）

状态：协议 v2（i28-W2 起，A 侧已实现；B 侧在 W1 / W3 / W4）。v1 设计稿（T86）里「B 每 30 秒轮询拉单 + 每单 owner 点确认」已退役，
见 §9；v1 的四个接口本身逐字节冻结，旧版 B 照旧能用。依据：任务卡 T86、i28 远端池 v2 方案、`docs/design/scheduler-engine.md`、
`docs/team/peer-delegation.md`、`docs/relay/protocol.md`、`src/lib/worker-session.ts`。

## 一句话

别人的机器（**出借方**，下称 B）的 owner 一次授权（仓库、角色、各家族名额、每日单数、到期时间）；B 开着机，它的空位就像我们
（**发起方**，下称 A）本机的 worker 一样进 A 的槽池：B 定时向 A 报容量（hello）和心跳（beat），A 的调度器把单子挂给它，A 的 bridge
**直接推过去**（offer），B 在授权内自动领单（仍是 v1 的 claim CAS）、在 B 本机起一次性 worker 干活，结果经同一套 MCP 写回 A 的台账。
卡只在 A 一处；B 不开端口、不经 B 的 PM、B 本地不开卡，只留收据。

和今天的 T46 委托相比：委托是「一件活 → 对方 agent → 对方 owner 逐件拍板 → 对方 agent 自己写卡」，靠约定；
本稿是「一个位 → 对方调度器 → 授权内自动领单 → 固定格式回写」，靠代码。委托照旧保留，给边界不清的大活用。

## 0. 通道：都是普通的 peer API 调用，中继一行不改

```
 B（出借方）                                 中继（现有 relay://，不改协议）        A（发起方）
 调度服务 ──hello(授权 + 名额，60 秒保活)───────────────────────────────────▶ /api/v1/lend/hello  → lend_peers
          ◀──offer(挂给 B 的单的摘要)─────────────────────────────────────── A 的 bridge 推送循环（§8.2）
          ──claim(orderId, worker 标签)──────────────────────────────────────▶ /api/v1/lend/claim  → 完整订单 + 租约（权威 CAS）
 一次性 worker（B 本机）── take_review / take_order / ask（同一套 MCP，W4）
          ──beat(批量心跳兼续租，15 秒)──────────────────────────────────────▶ /api/v1/lend/beat   → 逐单 verdict
          ──ask(远端 worker 的提问)──────────────────────────────────────────▶ /api/v1/lend/ask    → 卡的 PM
          ──result(deliver / submit_verdict)────────────────────────────────▶ /api/v1/lend/result → ledger lend-write
 （兜底，proto 2 时每 5 分钟）──poll──────────────────────────────────────────▶ /api/v1/lend/poll
 （对方是旧版 A 时）──poll 30 秒 / lease 续租──────────────────────────────────▶ /api/v1/lend/poll、lease
```

- **凭据**：B 用 A 已经签给它的 peer token，外加 B 的实例钥匙签名（`instance-key.pem`，A 的 bridge 按 `docs/relay/protocol.md` §4.1 强制验签、
  钉钥、防重放）。经中继时走 T21a 的 peer 端到端加密，中继看不到订单正文。
  **不产生新凭据**：这枚 token 是 A 在握手时签给 B、只能访问 A 的一枚，本来就在 B 手里；lend 不要求 A 交出任何密钥或 GitHub 凭据。
- **方向**：B → A 用 A 签给 B 的 token；A → B 的推送用 B 签给 A 的 token（只单向配对时 A 推不了：B 10 分钟内没收到过这个 A 的推送就按 30 秒轮询，赶在 A 的 2 分钟推送 TTL 之前领到）。
  A 对 B 暴露的只有 `lend/*`：v1 的 poll / claim / lease / result 加 v2 的 hello / beat / ask；B 对 A 暴露的只有 `lend/offer`。
- **端口**：两边都只有出站到中继的一条 WebSocket（直连 peer 也可以，但不是前提）。
- **中继不改**：`presence` 帧是中继自己生成的，不带自定义数据，所以容量不走 presence，而是走 hello（§8.1）。在线状态照旧用 `peer-presence`。
- **messages-only token**：`lend/*` 的这八条路径（含 offer）加进 `messagesOnlyAllows`（`src/lib/peer-scope-gate.ts`），对方开了「只能投递消息」
  也能用，lend 以外一条不多放；反过来，**lend 能力不给 scope 里任何 agent 的驱动权**：收单、心跳不经 agent、不注入任何会话，ask 只开一条问 PM 的 ask。
- **鉴权**：每个 `lend/*` 请求都要 peer token + E2E 解开的内层请求 + 钉住的公钥 + 实例签名（`local-api/lend.ts` 的 `lendCallerRefusal`，
  B 收 offer 的入口复用同一道），老 peer 一律 401，不退回明文。

## 1. 容量声明

### 1.1 出借方 B：`statePath("lend.json")` 的 `lend` 段

> v2（W1）：`lend[]` 改成一次授权（grant）：`peer`（钉 fp）、`repos`、`roles`（缺省只有 review，write 单独显式打开）、`families`（各家族名额）、
> `ordersPerDay`、`until`（必填，上限 90 天）、`grantedAt`。`confirm` 字段去掉——逐单确认已退役（§9），v1 文件里 `per-order` 或已过期的条目
> 迁成「暂停，待重新授权」，绝不迁成免确认。下面是 v1 的样子，留作对照。

```json
{ "enabled": true,                                  // 本文件自己的总开关，缺省 false；与 scheduler.json 的 autoDispatch 无关
  "lend": [ {
    "peer": "team-a",                                 // B 给 A 起的 peer 名（peers.json 里已握手的那条）
    "families": { "codex": 3, "claude": 2 },          // 同时在跑的上限，按模型家族
    "roles": ["review"],                              // review | write（write = 接开工 / 修复单，用出借人的 GitHub 登录推 lend/ 分支，见 §4）
    "repos": ["shawnlu96/claudestra"],                // GitHub owner/repo 白名单，只从这里 clone
    "quota": { "ordersPerDay": 10, "tokensPerDay": null },   // tokensPerDay 预留，v1 不执行
    "confirm": "per-order",                           // per-order（缺省）| auto
    "until": "2026-10-07T00:00:00Z"                   // 可选：到期自动停出借
} ] }
```

- 只有 B 的 owner 能改（`manager lend set/off`，写 CLI；网页设置页后做）。文件不存在 = 不出借，lend 循环空转。
- `confirm` 缺省 `per-order`（owner 已定）：每一单在 B 的「待你处理」里开一张 authorize ask，B 的 owner 点了才领；
  `auto` 只对熟人，由 B 的 owner 显式改。
- 声明是 B 的**自我约束**：数量、额度、家族都由 B 本地执行，A 只当参考。A 拿到的快照标 `claim`。

### 1.2 发起方 A：同一文件的 `borrow` 段

```json
{ "borrow": [ { "peer": "mate-b", "projects": ["claude-orchestrator"], "roles": ["review"], "maxOpen": 3 } ] }
```

- A 只会把**列在这里的项目**的单子给**列在这里的 peer**：私有项目、个人项目缺省不外发。没有 `borrow` = 什么都不外借。
- A 收到的容量与授权记在台账 `lend_peers` 表（每个 peer 一行：协议版本、启动号 + 序号、授权、各家族名额、暂停、helloAt），给调度器
  选人（`ledger lend-peers`）和网页显示用。超过 180 秒没有新 hello 的 peer 按 0 槽计（§8.1）。

## 2. 领活

### 2.1 订单格式：就是 M2 / M3 的派单格式

订单 = `WorkOrder`（`src/lib/worker-session.ts`，本机调度器今天就在用）+ 仓库定位，抽成一个共享的 wire 模块 `src/lib/order-wire.ts`，
M2 的 `take_order` / M3 的 `take_review` 本机 MCP 工具和 `lend/claim` 返回同一个对象，**不另起一套**：

```ts
interface OrderWire extends WorkOrder {              // taskId / specRev / head / round / node / step / dedupKey / inputs / outputs / acceptance / findings
  orderId: string;                                   // = 调度 intent id（dedupKey），全程唯一
  repo: { github: string; pr: number | null; head: string };   // 只给 GitHub 坐标，不给 A 本机路径
  family: "codex" | "claude";                        // A 要求的家族（跨模型审查配对由 A 算好）
  leaseMs: number;
}
```

与本机的差别都由 A 在出单时替换，schema 不变：
- `inputs` 里的本机路径换成**内联正文**。现有 `renderWorkOrder` 对每行 `quoteExternal` 缺省只留 300 字并压成单行，远端又读不到原文，
  所以 R1 给 renderer 加**逐字段限额**（规格原文 ≤ 16 KiB、每条 finding ≤ 2 KiB，保留换行），并随单带全文 sha256；
  任何字段超限或脱敏后变了验收句，**A 拒绝外发**，不截断。B 渲染后核 sha256，对不上拒领。
- `outputs` 里 A 本机的报告路径改成逻辑产出「报告正文放进 submit_verdict」；`writeBack` 改成「调用 `submit_verdict` / `deliver`」这句固定话。

结果同理：`deliver`（单号、head、证据、一句话、自查）与 `submit_verdict`（单号、head、verdict、P0/P1/P2、逐条 findingId/family/probe、报告正文）
的 payload 与 M2 / M3 一字不差；B 的 bridge 只是把本机 MCP 收到的 payload 原样转给 A 的 `lend/result`，再补上 B 已知的会话 id 与家族（标 claim）。

### 2.2 A 侧：挂进池子

- **手动**：`ledger lend-offer <task> --peer <名> --repo <owner/name>`。PM 或调度器写一条 intent，状态 `pooled`，
  **不派给具体谁**。复用 `scheduler_intents` 表，transport 记 `peer`，收件人留空。
- **v2（调度器）**：`selectWorkerRoute` 的 peer 分支（今天 `→ manual`）改成：本机同家族没有空位，且 `borrow` 允许这个项目，就出 `pooled` intent。
  本机优先；「本地 Codex 满了才去借」由这一步实现。
- 挂出去的单只给选定的那个 peer；对 proto 2 的 peer，A 的 bridge 主动推送（§8.2），但推送只是通知，权威仍是 B 发起的 `claim`：谁先 `claim` 成功谁拿（同一 `BEGIN IMMEDIATE` 事务里做 CAS：intent 仍是 `pooled`、peer 在 `borrow` 里、家族/角色匹配、
  这个 peer 未超过 `maxOpen`）。claim 成功时同事务写 `task_steps`：这一步执行者 = `<worker 标签>@<peer>`、kind `peer`，
  之后 `peer-ledger` 的「按步骤判权限」原样生效。

### 2.3 B 侧：lend 循环

放在 B 的第四服务 `scheduler` 里（`docs/design/scheduler-engine.md`「运行形态」），不放 bridge：bridge 部署重启不该打断在跑的出借。
它是服务 pass 里 merge / observe / auto 之后的一步，**同一个 pass、同一把维护租约**（`scheduler-pass.ts`）；租约、停止信号与单实例锁
的核对和 E2a 一样紧贴每个效果（每次 poll / claim / 起 worker / 转发结果之前与之后），失租或停止后本轮不再领新单。开关只看 `lend.json`
的 `enabled`，**不依赖 `autoDispatch`**：B 可以不开自动派单，只出借。今天 `src/scheduler.ts` 只在 `scheduler.json` 启用时进 pass，
`scheduler-pass.ts` 在 `autoDispatch=false` 时提前返回，R4 要把入口改成「两个开关任一开着就跑 pass，各步各看各的开关」，不能为出借被迫开合并或自动派单。
**前提**（不满足就不 poll，`doctor` 报原因）：第四服务已装且在跑；对 A 的 peer 记录钉了完整公钥并有 E2E 会话（`peer-e2e-outbound` 对无 E2E 记录的老 peer
返回 null，此时拒绝借单，不退回明文）。每一步先写 B 的本地 journal（§6）再做外部效果。

1. 单子从哪来：proto 2 的 A 推送（§8.2，B 的收单入口同步核授权、名额、日额度、仓库白名单、写角色后记 journal `asked`）；
   兜底轮询：proto 2、hello 新鲜、且 10 分钟内收到过这个 A 的推送时每 5 分钟 `poll` 一次，否则每 30 秒（推不过来的 A 也赶得上它 2 分钟的推送 TTL）；
   B 重启、hello 失败、刚从 proto 2 掉回 1 时立刻一次。对方是旧版 A（hello 回 404）时退回 v1：每 30 秒 `poll`。
2. ~~逐单确认~~（已退役，§9）：授权内直接下一步；claim 前、clone 后起 worker 前、首条派单前各同步重读一次授权，收回即停。
3. `claim` → 拿到完整订单与租约。
4. 起一次性 worker：`manager create agent-lend-<orderId 短码> <工作副本> --runtime codex --transport acp`（Claude 走缺省 runtime），标 `kind: worker`（T69），
   进程环境按 §5 用 `env -i` + 白名单（R4 在 `src/lib/runtimes/` 的启动参数里加 `cleanEnv` 选项，不另写启动器），
   目录是 `statePath("lend","<orderId>")` 下的新 clone：`git fetch origin <完整 SHA>`（fork PR 的提交经 `refs/pull/<N>/head` 可达），
   checkout 后核 `HEAD == repo.head == order.head`；clone / fetch / 核对失败 → 没起过 worker，按 `not_started` 释放（§6）。
5. 交单：M3 合入前，B 把渲染好的订单经 `WorkerSession.submit`（ACP）作为这个新会话的第一条消息发给 worker，journal 记 session id ↔ orderId；
   M3 合入后改由 worker 调 `take_review` / `take_order` 领（M1 的连接身份保证只有这个会话能领）。
6. worker `submit_verdict` / `deliver`（M3 前是 `lend submit` CLI，只收 journal 里「调用会话 = 该单 session、cwd = 该单工作副本」的单；
   同用户下这是防误投、不防伪造，同 T85 威胁模型）→ payload 先落 journal，再由 B 的 scheduler 带 sha256 转发 `lend/result`；拿到 A 的签名回执才写收据、结束 worker。
7. 在跑期间续租：proto 2 时每 15 秒一次批量 `beat`（§8.3）同时就是续租；对旧版 A 照旧每 60 秒 `lend/lease`（租约缺省 10 分钟）。

## 3. 结果回写与身份

- **回写到哪**：A 的台账，经 `runManager` → 新 CLI `ledger lend-write <peer> <json>`（bridge 不直接写库，沿用 T46）。不复用 `peer-write`：它的 review
  只收 verdict / P 计数 / 正文，会丢 head、findings、session。`lend-write` 把 M3 payload 全量交给现有 `recordReview` / `deliver` 写入器：
  review 事件带完整 head、`findings[]`、`reviewerSessionId = lend:<peer>:<orderId>`、`reviewerFamily`（claim）、orderId；报告正文由 A 写到
  `statePath("ledger","reviews","<T>-r<N>")/report.md` 再记路径。`scheduler-review` / `ledgerResult` 因此按原字段消费，不另起结果格式。
- **一个事务里核完再写**：`lend-write` 在同一 `BEGIN IMMEDIATE` 里核 orderId、持有 peer、租约代数未过期未撤、task/specRev/round/head 与订单一致、
  步骤绑定仍是这张单，然后写结果事件并结清 intent；bridge 上的预检只为早拒，不算数。撤单 / 重派在同一事务里清掉步骤绑定。
- **旧入口不能绕过**：`task_steps` 上由 lend 绑定的步骤带 `lendOrder`，`/api/v1/peer-ledger` 对这类步骤的 review / stage / pr 写入一律拒（403
  `lend_managed`），只能走 `lend/result`；T46 委托的步骤不带这个标记，权限照旧。
- **身份**：请求级身份 = A 的 bridge 已验过的实例签名（指纹钉在 peers.json）+ token 对应的 peer 名；两者不符直接 401（现有逻辑）。
  事件里额外记：`peer`、`fp`、签名头的 sha256 摘要、orderId。能证明「这条结论出自 B 这台机器」，**证明不了 B 上具体是哪个 agent、哪个模型**。
- **模型家族只算自称**：B 报的 `family` / 会话 id 进 `task_steps.claims`，不进 `verified`。A 的跨模型规则（作者 Claude → 审查 Codex）
  对远端结论标「家族未核实」。普通卡的跨模型配对按 claim 家族算（owner 待确认第 2 条）；security 模板要求 verified 家族，claim 结论
  只记参考、不推阶段，终审必须本机跨家族复核（与 scheduler-engine 的「未知家族不猜」一致）。
- **B 只留收据**：`statePath("lend","receipts.jsonl")`：orderId、peer、A 的 taskId、step、head、家族、起止时间、token 用量（从 worker 会话记录取，
  接 T83 的 usage 模块）、A 回执的签名。不存规格正文、不存结论正文；工作副本在 worker 结束时删除。

## 4. 代码访问

远端只从 GitHub 拿代码，不碰 A 本机任何文件；订单里只有 `owner/repo`、PR 号、head。

| 仓库 | 授权方式 | 风险 |
|---|---|---|
| 公开 | 无 | 无额外风险。**v1 只做这一类** |
| 私有 | A 把 B 的 GitHub 账号加为**只读协作者** | 该账号能读整个仓库全部历史，B 机器上任何进程（包括被注入的 worker）都能读；撤销靠 A 手动移除 |
| 私有 | **deploy key**（只读，按仓库） | 私钥要放到 B 机器上，泄露面等同上；只限单仓库，但不能按分支/PR 收窄，也不过期 |
| 私有 | A 签**细粒度 token**（单仓库、contents:read、带过期） | 最小但要 A 发凭据给 B：token 离开 A 就等于交出，违反「不把我方凭据交给对方」，**不推荐** |

写权限（`roles: ["write"]`，i28-R6 起做了，取代原来的「v1 不做」）：出借方的 worker 接**开工单**（卡在 build）和**修复单**（卡在 fix）。

- **两边都要开 write**：A 的 `borrow --roles review,write`、B 的 `lend set --roles review,write`；缺省仍只开 review。poll / claim 两侧都按单子种类核角色。
- **分支固定**：`lend/<任务 id>-<出借方指纹前 4 位>`。A 按钉住的 B 公钥算，B 按自己的公钥再算一遍，对不上不领。开工单从 `--base`（缺省 main）
  在远端的 head 切出，修复单从卡上的 head 接着改。
- **推送用出借人自己的 GitHub 登录**，直接推到 A 的仓库（出借人是协作者时）；没有推送权限的，B 在起 worker 之前 dry-run 试推就发现，
  按 not_started 退回并写明「推到自己 fork 的路径 v1 不支持，只检测」——fork PR 留给后续。
- **worker 推不出去**：写单的 clone 上锁（`protocol.allow=never`，生效配置里每一条逐协议许可 `protocol.<协议>.allow` 也在副本里盖成 never——全局配置放行的不算数；清空凭据助手、askPass / ssh 指向 false）；推送只由出借服务在另一个目录做，
  只推订单分支这一条显式 refspec、不 force，非快进就拒。锁是配置不是边界（§5 同一系统用户）。
- **A 收货**：自己 ls-remote 订单分支，head 逐字相等、卡仍在 build / fix 且轮次没变、查远端期间卡没被改，才在一个事务里记 deliver
  （actor `<出借方指纹>/<worker>`，负责人记成 peer_agent）、推到 review、签回执；同一单同一 head 重交幂等。
- **写租约**：一张卡的写代码在合并或 PM `lend-reclaim` 之前留在同一出借方，修复单缺省派回它；派不回去（授权过期、挂 30 分钟没人领、
  对方没起得来）就撤单、结束租约、通知 PM，卡退回本机。

私有仓库的授权方式仍是 owner 待确认项。

## 5. 安全边界

**订单是外来数据（对 B）**，结论是外来数据（对 A）：
- B 侧：worker 看到的订单一律经 `renderWorkOrder`（固定标题由代码写，台账里的文字只在 `quoteExternal` 引号里出现、逐字段限长）；
  单子整体限 32 KiB，超了 B 拒领。A 出单时先按 `send_to_agent` 的脱敏规则去掉 token、内网地址、个人信息、本机路径；
  脱敏会破坏验收信息时不外发（同 scheduler-engine「若脱敏破坏验收信息则停止派发」）。
- A 侧：远端结论里的 finding 正文、报告正文按外来文本入库，再派给本机修复者时照样 `quoteExternal`，不当指令。

**B 机器上的隔离**（能防什么、不能防什么）：
- **能做到**：每单一个新会话（`kind: worker`，不复用 B 的 agent）和一个新 clone（不是 B 任何仓库的 worktree，不共享 `.git`、stash、分支）；
  worker 用 `env -i` + 白名单启动，只放 `PATH HOME USER LANG TERM TMPDIR CODEX_HOME`，**不主动注入** B 的 `.env`、`BRIDGE_CONTROL_TOKEN`、
  `CLAUDESTRA_*`、`GH_TOKEN` / `GITHUB_TOKEN`。防的是「worker 顺手用到了继承来的凭据」和「工作现场串进 B 自己的仓库」。
- **做不到**：worker 与 B 同一个 OS 用户、bypass 下是任意 shell。它仍能读 `HOME` 下的 peers.json、实例私钥、`~/.codex`，能用 git credential
  helper、SSH agent、Keychain，能连 B 的回环服务，也就能自己签 peer 请求或往 GitHub 推。`env -i` 只清继承的环境变量，不是凭据隔离；
  公开仓库的 PR 正文同样可能带提示注入。
- 所以 B 的 owner 授权的是「让一个外来任务在我这个用户下跑一个 shell」，不只是「借出 Codex 额度」。授权表单（CLI 与网页）写明这一句；
  真正的闸门是授权本身（`repos` 白名单、角色、名额、到期）和一键收回即停。要承诺「worker 拿不到宿主凭据 / 没有写权限」，前提是 R9（独立 OS 用户或容器 + 只经 bridge 代发）。

**撤销与紧急停止**：
- A：`ledger lend-cancel <orderId>` 撤单（下次续租 B 得到 `cancelled`，B 停 worker、写收据）；`lend.json` 去掉 `borrow` = 停止外借；
  `peer-http-remove` / 吊销 token 只切断通讯，停不了 B 上已起的进程；B 在租约截止时自停（§6）。
- B：`manager lend off [--peer x]` 停止领新单，在跑的单跑完，或 `--now` 立即停（向 A 报 `stopped`，按 §6 处理）。
- 两边的 `doctor` 各显示一行：出借中/借入中的单数与最近一次 poll。

## 6. 失败处理：状态与恢复

B 的 journal（`statePath("lend","journal.sqlite")`，一单一行）先写后做：`asked → claimed(lease 代数) → cloned → started(session) → result_pending(payload
sha256) → acked | stopped | cancelled`。B 重启按 journal 续：未 claim 的重新 poll；已 claim 的先用同 orderId 重发 claim（A 对同一持有者幂等返回
原订单与当前租约），不新建第二个 worker；`started` 的先续租、再按 session 接上观察；`result_pending` 的用原 payload 重发。

| 情况 | B 报 / 做 | A 的 intent |
|---|---|---|
| clone / fetch / 核 head 失败、worker 从没起 | `release(not_started)`，journal 证明无 session | 回 `pooled`，可安全重派 |
| proto 2 的推送丢了（请求或应答在任一步丢） | — | 推送 TTL：2 分钟没确认、或确认后 3 分钟没领 → `withdrawPooledLend` 撤回，auto 卡由池同步重排（§8.2） |
| B 收回授权、worker 干净停下（proto 2） | beat 里报 `ended:{revoked, clean:true}` | 审查单走 not_started；写单要 A 自己核对分支没推送，否则 `unknown` 交 PM（§8.3） |
| worker 已起后撞额度 / 登录失败 / 被 `--now` 停 | `stopped(原因)`，只在 worker 已确认退出且无待发结果时报 | `unknown`，保留绑定与槽位，停给 PM |
| B 离线、续租 / beat 连续失败 | 到租约截止仍没续上就自停 worker，保留工作副本和 journal | 租约到期 → `unknown`，不自动转派 |
| result 已入账、回执丢了 | 同 orderId、同 sha256 重发 | 返回原回执（即使 intent 已结、租约已过）；同 orderId 换了正文 → 409 |
| A 撤单 / 重派后 B 才交结果、且从未成功入账 | 写收据「被撤」 | 409，不入账 |
| 结论不明（B 报 unknown） | — | **不换 key 重做**；PM 核对后 `lend-reoffer`（新 orderId，旧单记 cancelled） |

- **回执**：A 用自己的实例钥匙签 `{orderId, sha256, eventSeq, taskId}`，经 E2E 响应返回；B 验签后才写收据。重复请求拿到的是同一张。
- **现场**：工作副本只在「worker 已确认退出」且「结果已拿到回执或单已确认撤销」后删；停不下来或撤销没确认时保留现场、`doctor` 告警。
- **额度**：B 的日额度按 `claimed` 计，`not_started` 退回；今日只受 B 本机时区日界线约束。

## 7. 最小可试用版（第一次内部试用）

**切片**：只 review、只 Codex、只公开仓库（claudestra 本身）、B 侧逐单确认、额度只按「单/日」、A 侧手动挂单。

| 做 | 先不做 |
|---|---|
| `lend.json`（lend / borrow）+ CLI | 网页设置页、token 额度执行 |
| A：`lend/poll · claim · lease · result` 四接口 + `ledger lend-offer / lend-cancel` | 调度器自动挂池子（v2，等阶段 2 打开 autoDispatch） |
| B：scheduler 服务里的 lend 循环（同 pass、同租约）+ authorize ask + 一次性 Codex worker（独立 worktree、`env -i` 白名单，§5） | fork PR（写单 i28-R6 已做，fork 只检测）、私有仓库授权 |
| 结果写 A 台账 review 事件（家族标 claim） | 远端 Claude worker、多单并发调优 |
| B 收据 jsonl | 中心服务撮合、中继直连（只留接口，见下） |

**M1–M3 没合时怎么办**：领单靠 §2.3 第 5 步的 `WorkerSession.submit` 首条消息，回写靠 `manager lend submit <orderId> --verdict … --findings <json>`，
参数就是 `submit_verdict` 的字段、走同一个 `order-wire` 校验；M3 合入后改走 MCP（R7）。两头都不依赖 M1–M3，也不分叉格式。

**接口预留**：`lend/*` 的四个请求体不含传输细节；以后中心服务撮合时，同样的 poll/claim 由中心转发或直接替代 A 的接口；
中继直连（阶段 6）对这层透明。

**试用步骤**：两位试用同事升级、确认第四服务在跑、中继在线且与 A 已有带钥 E2E 的 peer 记录 → 各自 `manager lend set team-a --codex 2 --roles review --repos shawnlu96/claudestra` →
A `lend.json` 加 `borrow` → PM 对一张已交付的卡 `ledger lend-offer <T> --step review` → B 的 owner 点确认 → 看 A 台账出现 review 事件、B 收据一行。

### 子 DAG v1 草案（阶段 4，PR 粒度）

| 节点 | 一句话 | 依赖 | 粗估 |
|---|---|---|---|
| R1 | `order-wire.ts`：OrderWire / deliver / verdict 的共享 schema、校验、脱敏；`renderWorkOrder` 接入 | M2/M3 的字段定稿（可先行，M2/M3 反过来引用它） | 3h |
| R2 | `lend.json` 读写 + `manager lend set/off/status` + doctor 行 | — | 3h |
| R3 | A 侧 `lend/*` 四接口 + `pooled` intent + 幂等 claim CAS + `ledger lend-write`（单事务核验、结构化入账、签名回执）+ peer-ledger 拒 `lendOrder` 步骤 + `lend-offer/cancel/reoffer` | R1、R2、T68 PR A 表 | 8h |
| R4 | B 侧：服务入口两开关、journal 与重启恢复、poll 过滤、authorize ask、clone+核 head、一次性 worker（`env -i`）、首条消息交单、`lend submit`、续租/自停、收据 | R1、R2、R3 | 9h |
| R5 | 双实例沙箱实测（T81 `--lab --pair`）：上限、逐单确认、撤单、离线租约、回执丢失重发、B 重启；scheduler.json 缺失、autoDispatch=false、无 M3、老 peer 非 E2E、fork PR head | R3、R4 | 4h |
| R6 | 调度器 peer 分支：本机满才挂池子（v2） | R5、阶段 2 autoDispatch | 4h |
| R7 | M3 合入后 worker 改走 `take_review` / `submit_verdict` MCP，家族/会话由 B 的 M1 填 | R4、M3 | 2h |
| R8 | 私有仓库授权 + fork PR（write 角色本身已由 i28-R6 做了） | owner 定 §4 | 6h |
| R9 | 出借 worker 硬隔离（独立 OS 用户或容器） | R5 | 6h |

最小切片 = R1–R5（约 27h agent 工作量；R1、R2 可并行，R3 依赖 R1 定稿，R4 与 R3 要联调，R5 在最后）。

## 8. 协议 v2（i28-W2：A 侧）

线格式在 `src/lib/lend-wire-v2.ts`，协议版本常量 `LEND_PROTO`（= 2）只在那里定义一次，两边都从那里引用。两个方向都严格解析：
多字段、少字段、类型不对、超长一律拒，不截断。v2 只**加接口**，从不往 v1 正文里加字段。

### 8.1 hello 与可用槽

```
POST /api/v1/lend/hello   (B→A；B 的调度服务启动时、授权哈希 / 名额 / 暂停变了时、再加每 60 秒保活)
{ v:1, proto:2, boot:"<B 本次启动随机 id>", seq:<单调递增>,
  grant:{ until, roles:["review"|"write"], repos:["o/r"], ordersPerDay, ordersLeftToday } | null,   // null = 已收回
  slots:{ codex:{total,busy}, claude:{total,busy} }, paused:null|{reason:"codex_quota", until} }
→ { ok:true, v:1, proto:2, helloMs:60000, beatMs:15000 }
```

- A 记进 `lend_peers`。同一启动号里序号没涨的 hello 照常回应答但不入账：迟到的旧 hello 不会把已收回的授权翻回来；换启动号重新计。
- **可用槽**（`ledger lend-peers`，调度器 W5 用）= min(上报的 total − busy, borrow.maxOpen − A 在它那里的未结单数)，按家族算。
  没有 hello（proto 1）、hello 超过 180 秒、授权为 null / 到期 / 今日用完 → 0；`<家族>_quota` 暂停只停那个家族，别的暂停原因停整个 peer。
- 没有 `lend_peers` 行的 peer 一律当 proto 1：A 从不推送，只靠它轮询。

### 8.2 推送与推送 TTL

1. 挂单不变（`offerLendCore`，单子状态 `pooled`，peer 已选定）。
2. A 的 bridge 推送循环（`bridge/lend-dispatch.ts`，逻辑在 `lib/lend-dispatch.ts`）每 5 秒一轮：找出 hello 新鲜、授权还在的 v2 peer 名下的池单，
   按 peer 一批（≤20）`peerFetch(<peer>/api/v1/lend/offer)`。正文是 v1 poll 列给 B 的同一份摘要：
   ```
   { v:1, proto:2, orders:[{ orderId, taskId, step, family, repo, pr, head, round, specRev, offeredAt }] }
   → { ok:true, v:1, accepted:[orderId…], refused:[{ orderId, code }] }
   ```
   - 只推 E2E：先过 `peerLendProblem`（握手完整、钉了公钥、有 E2E 记录、没有代理变量），应答也必须是 E2E 回来的；不满足就不发，绝不退回明文。
   - 应答经 `ledger lend-pushed` 入账：接收的记一次确认（`lend_orders.seenAt`，只记第一次，重复确认不续命），拒收的立刻撤回。
   - 发送状态和退避只在内存里：失败后 5 秒、15 秒、30 秒，之后每 60 秒；bridge 重启就把全部池单重推一遍，B 按 orderId 去重，所以无害。
3. **推送 TTL**（`lib/ledger-lend-peers-ttl.ts`，接在 `sweepLend` 里）：发往 proto 2 peer 的池单，挂出后 2 分钟没确认、或确认后 3 分钟没被领，
   就走 `withdrawPooledLend`（CAS）撤回。auto 卡不通知 PM（调度器的池同步看到 cancelled 会重排），手挂的卡告诉 PM。撤回和 B 的 claim
   都是 BEGIN IMMEDIATE，只有一个能赢；撤回后 B 再来领拿到 `cancelled`。所以请求或应答在任意一步丢掉，单子都不会悬着。

### 8.3 beat 与收回

```
POST /api/v1/lend/beat    (B→A，每 15 秒，按 peer 批量，≤50 单)
{ v:1, orders:[{ orderId, gen, phase:"cloning|starting|working|publishing|result_pending",
                 lastActivityAt, excerpt:"≤1 KiB，已脱敏", ended?:{ reason:"revoked", clean:bool } }] }
→ { ok:true, v:1, orders:[{ orderId, verdict:"ok|cancelled|lease_expired|stale_gen|not_found|done", lease:{gen,expiresAt,ms}|null }] }
```

- beat 就是 proto 2 的续租：只续这个 peer 持有、租约没过期、代数对得上的单，其余逐单回原因（别家的 / 没领的 = not_found）。
  phase 与摘要记进 `lend_orders.beat`（摘要 A 再脱敏一次），时间记 `beatAt`。先扫一遍过期租约，所以过期的单回 `lease_expired`。
- **收回授权时自动重排**（owner 10-01 定，偏离 T93「停了交 PM」，只对 proto 2）：beat 里某单带 `ended:{revoked, clean:true}` →
  按 not_started 的路子：`released`、解绑步骤，auto 卡由池同步重排；写单走现有 sendBack，写租约结束、卡退回本机。
  - 审查单信 `clean:true`（审查本来没有外部副作用）。
  - 写单：A 自己 `git ls-remote` 订单分支，分支不存在（开工单）或还停在起点 head 才算干净；核对不了或已有推送 → 照旧 `unknown` 交 PM。
  - `clean:false`、proto 1 的 `stopped`、单子不归这个 peer 或代数不对 → 行为不变。proto 在 beat 的事务里按 `lend_peers` 核：
    没有 hello 记录的 peer 一律当 proto 1，带 `clean:true` 也按 `stopped` 交 PM。
  - 收到收回的 beat，A 把这个 peer 的授权当作没了（可用槽立刻 0），直到它下一次带授权的 hello：撤回的单不会重排回同一个 peer。

### 8.4 远端 worker 提问

```
POST /api/v1/lend/ask     (B→A，worker 经 B 的 bridge 转来)
{ v:1, orderId, gen, question, options:[…] }   → { ok:true, v:1, askId }
```

- A 侧的调用方身份是 RemoteCaller `{peer, fp, orderId, gen, worker}`：peer 来自已验过的 E2E principal，其余全部取自 `lend_orders` 那一行，
  不信请求里的任何字段；只认这个 peer 持有、租约没过期、代数对得上的单（否则 409 `not_held`）。
- askee 是这张卡的 PM（卡上没有就取项目 PM 名单第一位），开 ask 并通知 PM 走和本机 ask 工具同一个函数（`lib/order-ask.ts` openOrderAsk）；
  通知里只有本卡号、单号、提问人（`worker@peer`）和引用形式的问题，回包只有 `askId`。A 侧的远端调用入口只有 hello / beat / ask / result
  四种（加 v1 的 poll / claim / lease），没有任何 PM 工具或 DAG 工具，也没有读别的卡的接口。

### 8.5 版本混搭与 v1 冻结

| | 旧 B（只轮询） | 新 B |
|---|---|---|
| **旧 A** | 现状 | B 发 hello 拿到 404 → 记成 proto 1，走 v1 轮询；ask 明确回「对方版本不支持」 |
| **新 A** | B 从不发 hello → A 从不推送，靠 poll | 推送 + beat + ask |

- v2 的拒绝码里没有 404（`LEND_V2_STATUS`），所以 v2 接口回 404 只可能是对方没有这个路由；B 侧客户端（`lib/lend-remote.ts`）把它识别成 `old_peer`。
- v1 四个接口的请求体和应答体用金样本锁死（`tests/lend-wire-v1-golden.test.ts`），流程中夹着 hello / beat 也必须一字不差。
- 上线顺序：先升 A（向后兼容），再升 B。

## 9. 已退役

- **轮询为主的拉单**：v1 里 B 每 30 秒 poll 是唯一的单子来源；v2 起主路径是推送（§8.2），poll 只剩两种用途：推送正常到达时 5 分钟一次的兜底
  （10 分钟没收到这个 A 的推送就回到 30 秒），以及对方是旧版 A 时的回退。
- **逐单确认**（`confirm: per-order` 的 authorize ask、`ledger lend-ask`）：改为一次授权（§1.1）。`ledger lend-ask` 先改成回「已退役」的空壳（W1）。
- **`lend-seen.json` 的容量快照**：换成台账 `lend_peers`（§1.2、§8.1）。
- v1 设计稿末尾的「给 owner 的待确认」已由 i28 远端池 v2 方案逐条定掉，不再列在这里。

## 10. 写代码派远端与机器档位（i28-W9）

到 W9 为止调度器只把**审查**挂给出借方。W9 打通开工单和修复单（build / fix）：调度器像派审查一样把它们挂进池子，出借方的
worker 按 R6 的写单路子做（从基线切 `lend/<卡>-<指纹前 4 位>` 分支、推到本仓库、开 PR、`deliver` 交付）。交付后卡进 review，
审查跨家族派出。分到哪台机器不做按额度全自动，每台机器给一个档位，调起来方便（owner 10-01 22:22）。

### 10.1 开关与配置项

| 在哪 | 字段 | 取值 | 缺省 | 作用 |
|---|---|---|---|---|
| scheduler.json `projects.<id>.remote` | `roles` | `review` / `write`（write = build + fix） | `["review"]` | 写单要显式写 `write` 才派远端；不写行为与 W9 之前完全一样 |
| 同上 | `repo` | GitHub `owner/name` | — | 有 `write` 时必填、没有时不许写：开工单还没有 PR，出借方按它 clone / 推分支 |
| 同上 | `localPriority` | `first` / `balance` / `low` / `off` | `balance` | 本机的档位 |
| 同上 | `reviewFirst` | peer 名列表 | — | 照旧（W5c）：审查先给列表里第一个能接的；对写单不起作用 |
| lend.json `borrow[]` | `priority` | 同上四档 | `balance` | 这个 peer 的档位；`manager borrow set <peer> … --priority <档>` 写（重设不带就回到 balance） |
| lend.json `borrow[]` | `roles` | 加上 `write` | — | 借入方允许把写单给这个 peer |
| 出借方 lend.json `lend[]` | `roles` | 加上 `write` | review | 出借方授权里也要有 write（`lend grant … --roles review,write`），hello 里报给借入方 |

三处（scheduler.json、借入条目、出借方授权）都含 write，写单才会派过去；少一处就留在本机，原因写在计划事件里（`ledger lend-orders` 也看得到）。

### 10.2 放置顺序（`lib/scheduler-placement.ts`）

1. **硬约束先过滤**：remote.mode、三处 roles、对方 hello 新鲜且授权在、仓库在授权里、对方有空闲槽、文件锁没被别的卡占、`off` 的 peer 一律出局。
2. **修复单只派回写租约方**（R6）：这张卡的分支就是那台出借方推的 `lend/` 分支，换人等于重写。它接不了就等，原因写明；要换人先 `ledger lend-reclaim`。
   没有写租约（本机写的卡）的修复单不派远端。
3. **审查的 reviewFirst**：照旧，先给列表里第一个能接的 peer，不看负载。
4. **逐档**：能接的机器里，先在 `first` 档挑，档内按在跑数最少（平手规则照 W5：写租约方 > 复审回上次的 peer > peer 先于本机 > 借入顺序）；
   `first` 档没有能接的，再看 `balance`（本机和 peer 一起平分，就是 W5 的规则）；最后才看 `low`。`off` 永远不派。
5. 一台 peer 都接不了：本机照常排队（本机 `off` 时改成等，不在本机跑）。

所有机器都是 balance（或者都没写档位）时，放置结果和理由文字与 W5 逐字相同。挂池复核（`ledger scheduler-pool` 出单前在事务里重算）
用的是同一份策略：调度服务把 roles / reviewFirst / localPriority / repo 原样传过去，由 `parseRemotePolicy` 解析（和读 scheduler.json 同一个函数），
peer 的档位随借入名单一起读，所以复核不会丢档位。

### 10.3 写单派出去之后

- **出单**：开工单的起点是 `main` 在远端的 head，修复单带上一轮审查报告原文（出借方读不到本机文件）；材料在事务外备好
  （`lib/lend-write-materials.ts`，PM 手挂的 `ledger lend-offer` 用同一份）。查不到就这一轮不挂，换下一台或回本机。
- **家族**：写单用出借方有空槽的家族，先 Codex 再 Claude（owner：先用孟总的 Codex）。
- **交付**：出借方 `deliver` 时 A 核远端分支 head，卡记 head / 分支 / PR 并推到 review（R6 `writeLendDeliver`），下一轮调度把挂池意图记 done。
- **审查跨家族**：卡的作者家族开卡时写在 `task_workflows.authorFamily`（自动开卡写 claude）。当前 head 是某张远端写单交付的，作者家族就按那张单的家族算
  （`lib/scheduler-head-family.ts` 的 `remoteHeadFamily`），不改 workflow 那一行。审查放置、建 reviewer session、绑定校验、结论记账、
  两道合并闸读的都是这一个函数：Codex 写的卡交 Claude 审（本机，或有 Claude 槽的 peer），Codex 的结论记不进去。
  本机 Claude 写的卡照旧交 Codex 审（优先 reviewFirst）。
- **已知边界**：远端写过、之后某一轮又回本机写的卡，复审要换家族时原来的 reviewer session 对不上，交 PM（不自动换人）。
  一张卡复述时占的本机 worker 槽，写单派远端期间仍算在这张卡上。`start_node` 的 `auto` 放置也走这套档位：有 write 时新卡可能直接固定给 peer（W5 的设计，跳过复述）。

### 10.4 上线清单（PM 照着带人做）

1. **出借方（孟总机器）升级**：升到包含 i28-R7e 的版本（R7e 打开出借方的 write 角色；在那之前出借方一律拒 write，授权里写了也不生效）。
2. **出借方重新授权**，带上 write（网页出借页重新授权，或命令行）：
   `manager lend grant <借入方 peer 名> --repos shawnlu96/claudestra --until 7d --roles review,write --codex <N> [--codex-model gpt-6-astra --codex-effort xhigh]`
   N 是同时在跑的 Codex 数（审查和写代码共用）。授权最长 7 天，到期前续。
3. **借入方升级**到含 i28-W9 的版本，重启四个服务（bridge / cron / launcher / scheduler）。
4. **借入方 lend.json**：`manager borrow set <出借方 peer 名> --projects claude-orchestrator --roles review,write --priority first`
   （要先用对方的 Codex 就设 first；只想留着兜底设 low）。`manager borrow status` 核对档位和 roles。
5. **借入方 scheduler.json**，项目 `claude-orchestrator` 的 `remote` 改成：
   `{ "mode": "balance", "roles": ["review", "write"], "repo": "shawnlu96/claudestra", "reviewFirst": ["<出借方 peer 名>"] }`
   （本机想少用就加 `"localPriority": "low"`）。调度服务每轮重读，下一轮生效；改坏了整个调度停，`bun src/manager.ts doctor` 会报。
6. **核对**：下一张进 build 的自动卡，`ledger lend-orders <卡>` 应显示挂给出借方的开工单；出借方领单、交付后卡进 review，审查员应是本机 Claude session。
