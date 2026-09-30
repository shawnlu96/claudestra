# 借别人的算力：远端 worker 池（阶段 4）

状态：设计稿 v1（T86，specRev 1），只出文档。依据：任务卡 T86、协作底座改版方案页第 4、6 节、`docs/design/scheduler-engine.md`、
`docs/team/peer-delegation.md`、`docs/relay/protocol.md`、`src/lib/worker-session.ts`。

## 一句话

别人的机器（**出借方**，下称 B）在本机写一份「给谁、出几个位、接什么活」的声明；B 的调度服务**主动**经中继去我们（**发起方**，下称 A）
那里拉单、领单，在 B 本机起一次性 worker 干活，结果写回 A 的台账。卡只在 A 一处；B 不开端口、不经 B 的 PM、B 本地不开卡，只留收据。

和今天的 T46 委托相比：委托是「一件活 → 对方 agent → 对方 owner 逐件拍板 → 对方 agent 自己写卡」，靠约定；
本稿是「一个位 → 对方调度器 → 按声明自动（或逐单确认）领单 → 固定格式回写」，靠代码。委托照旧保留，给边界不清的大活用。

## 0. 通道：全部是 B → A 的出站调用

```
 B（出借方）                                 中继（现有 relay://，不改协议）        A（发起方）
 lend 循环 ──poll(声明快照)──────────────────────────────────────────────────▶ /api/v1/lend/poll   → 匹配的待领单
          ──claim(orderId, worker 标签)──────────────────────────────────────▶ /api/v1/lend/claim  → 完整订单 + 租约
 一次性 worker（B 本机）── take_review / take_order（B 本机 MCP，M2/M3）
          ──result(deliver / submit_verdict)────────────────────────────────▶ /api/v1/lend/result → ledger peer-write
          ──heartbeat / release──────────────────────────────────────────────▶ /api/v1/lend/lease
```

- **凭据**：B 用 A 已经签给它的 peer token，外加 B 的实例钥匙签名（`instance-key.pem`，A 的 bridge 按 `docs/relay/protocol.md` §4.1 强制验签、
  钉钥、防重放）。经中继时走 T21a 的 peer 端到端加密，中继看不到订单正文。
  **不产生新凭据**：这枚 token 是 A 在握手时签给 B、只能访问 A 的一枚，本来就在 B 手里；lend 不要求 A 交出任何密钥或 GitHub 凭据。
- **方向**：A 不需要持有 B 的 token，也不需要 B 把任何 agent 开放给 A。A 对 B 暴露的只有 `lend/*` 四个接口。
- **端口**：两边都只有出站到中继的一条 WebSocket（直连 peer 也可以，但不是前提）。
- **中继不改**：`presence` 帧是中继自己生成的，不带自定义数据，所以容量不走 presence，而是随每次 `poll` 上报。在线状态照旧用 `peer-presence`。
- **messages-only token**：`lend/*` 四条路径加进 `messagesOnlyAllows`（`src/lib/peer-scope-gate.ts`），对方开了「只能投递消息」也能用；
  反过来，**A 这边的 lend 能力不给 scope 里任何 agent 的驱动权**：拉单不经 agent、不注入任何会话。

## 1. 容量声明

### 1.1 出借方 B：`statePath("lend.json")` 的 `lend` 段

```json
{ "enabled": true,                                  // 本文件自己的总开关，缺省 false；与 scheduler.json 的 autoDispatch 无关
  "lend": [ {
    "peer": "team-a",                                 // B 给 A 起的 peer 名（peers.json 里已握手的那条）
    "families": { "codex": 3, "claude": 2 },          // 同时在跑的上限，按模型家族
    "roles": ["review"],                              // review | write（write 要仓库写权限，见 §4）
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
- A 收到的声明快照存在内存 + `statePath("lend-seen.json")`（peer、fp、快照、收到时间），给调度器选人和网页显示用。
  超过 5 分钟没 poll 的 peer 视为不可用。

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

与本机的差别只有两处，都由 A 在出单时替换，schema 不变：
- `inputs` 里的本机路径（规格卡路径、审查报告路径）换成**内联正文**（规格与验收原文，走 §5 的脱敏与限长）；
- `writeBack` 不再是 A 本机的 `ledger …` 命令，而是「调用 `submit_verdict` / `deliver`」这句固定话；worker 在 B 本机调的是 B 的 MCP 工具。

结果同理：`deliver`（单号、head、证据、一句话、自查）与 `submit_verdict`（单号、head、verdict、P0/P1/P2、逐条 findingId/family/probe、报告正文）
的 payload 与 M2 / M3 一字不差；B 的 bridge 只是把本机 MCP 收到的 payload 原样转给 A 的 `lend/result`，再补上 B 已知的会话 id 与家族（标 claim）。

### 2.2 A 侧：挂进池子

- **v1（手动）**：`ledger lend-offer <task> --step review [--family codex]`。PM 或调度器写一条 intent，状态 `pooled`，
  **不派给具体谁**。复用 `scheduler_intents` 表，transport 记 `peer`，收件人留空。
- **v2（调度器）**：`selectWorkerRoute` 的 peer 分支（今天 `→ manual`）改成：本机同家族没有空位，且 `borrow` 允许这个项目，就出 `pooled` intent。
  本机优先；「本地 Codex 满了才去借」由这一步实现。
- A 不推单：谁先 `claim` 成功谁拿（同一 `BEGIN IMMEDIATE` 事务里做 CAS：intent 仍是 `pooled`、peer 在 `borrow` 里、家族/角色匹配、
  这个 peer 未超过 `maxOpen`）。claim 成功时同事务写 `task_steps`：这一步执行者 = `<worker 标签>@<peer>`、kind `peer`，
  之后 `peer-ledger` 的「按步骤判权限」原样生效。

### 2.3 B 侧：lend 循环

放在 B 的第四服务 `scheduler` 里（`docs/design/scheduler-engine.md`「运行形态」），不放 bridge：bridge 部署重启不该打断在跑的出借。
它是服务 pass 里 merge / observe / auto 之后的一步，**同一个 pass、同一把维护租约**（`scheduler-pass.ts`）；租约、停止信号与单实例锁
的核对和 E2a 一样紧贴每个效果（每次 poll / claim / 起 worker / 转发结果之前与之后），失租或停止后本轮不再领新单。开关只看 `lend.json`
的 `enabled`，**不依赖 `autoDispatch`**：B 可以不开自动派单，只出借。

1. 每 30 秒对每个 `lend` 条目 `poll`（带声明快照 + 当前占用）。返回的单子先本地过滤：仓库在白名单、角色/家族在声明里、今日额度未满、占用未满。
2. `confirm=per-order`：在 B 的 owner 频道开 authorize ask（`bind: {action: "lend_claim", params: {peer, orderId}}`），
   只认 ask-check 通过的 owner 回答；过期 = 放弃，不 claim。`auto`：直接下一步。
3. `claim` → 拿到完整订单与租约。
4. 起一次性 worker：`manager create agent-lend-<orderId 短码> <工作副本> --runtime codex --transport acp`（Claude 走缺省 runtime），标 `kind: worker`（T69），
   进程环境按 §5 用 `env -i` + 白名单（R4 在 `src/lib/runtimes/` 的启动参数里加 `cleanEnv` 选项，不另写启动器），
   目录是 `statePath("lend","<orderId>")` 下从 GitHub 浅 clone 并 detached 到 `repo.head` 的工作副本。
5. worker 用 B 本机 MCP `take_review` / `take_order` 领到这张单（M2/M3；M1 的连接身份保证只有这个 worker 能领）。
6. worker `submit_verdict` / `deliver` → B 的 bridge 原样转发到 A 的 `lend/result`；收到 A 的签名回执后，B 写收据、归档并结束 worker。
7. 在跑期间每 60 秒续租（`lend/lease`）。

## 3. 结果回写与身份

- **回写到哪**：A 的台账。`lend/result` 在 A 的 bridge 里只做校验，写入仍经 `runManager` → `ledger peer-write`（bridge 不直接写库，沿用 T46）。
  review 结果写成 `review` 事件（带 head / findings / 报告正文），deliver 写成 `deliver` 事件；之后由 A 的调度器按同一套模板推阶段。
- **身份**：请求级身份 = A 的 bridge 已验过的实例签名（指纹钉在 peers.json）+ token 对应的 peer 名；两者不符直接 401（现有逻辑）。
  事件里额外记：`peer`、`fp`、签名头的 sha256 摘要、orderId。能证明「这条结论出自 B 这台机器」，**证明不了 B 上具体是哪个 agent、哪个模型**。
- **模型家族只算自称**：B 报的 `family` / 会话 id 进 `task_steps.claims`，不进 `verified`。A 的跨模型规则（作者 Claude → 审查 Codex）
  对远端结论标「家族未核实」；安全类卡的终审**不接受**远端结论，必须本机跨家族复核（与 scheduler-engine 的「未知家族不猜」一致）。
- **结论绑定**：`lend/result` 必须带 orderId，且 head = 订单 head、intent 仍由这个 peer 持有、租约未被 A 收回；否则 409，不入账。
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

写权限（`roles: ["write"]`）更敏感：B 要能推分支、开 PR。v1 不做；做时推荐 B 用**自己的账号 fork**，PR 从 fork 发到 A 的仓库，
A 零授权、原有合并门槛不变（T46 规矩 4）。私有仓库的授权方式列为 owner 待确认项。

## 5. 安全边界

**订单是外来数据（对 B）**，结论是外来数据（对 A）：
- B 侧：worker 看到的订单一律经 `renderWorkOrder`（固定标题由代码写，台账里的文字只在 `quoteExternal` 引号里出现、逐字段限长）；
  单子整体限 32 KiB，超了 B 拒领。A 出单时先按 `send_to_agent` 的脱敏规则去掉 token、内网地址、个人信息、本机路径；
  脱敏会破坏验收信息时不外发（同 scheduler-engine「若脱敏破坏验收信息则停止派发」）。
- A 侧：远端结论里的 finding 正文、报告正文按外来文本入库，再派给本机修复者时照样 `quoteExternal`，不当指令。

**B 机器上的隔离**：
- **独立 worktree**：每单一个新工作副本 `statePath("lend","<orderId>")`，从 GitHub 公开地址浅 clone、detached 在订单 head；
  不是 B 自己任何仓库的 worktree，不共享 B 的 `.git`、stash 或分支。干完（或被撤、失租）即删。
- **一次性会话**：每单一个新 worker，不复用 B 自己的 agent，也不进 B 的会话列表（`kind: worker`）。
- **干净环境**：worker 进程用 `env -i` 加白名单启动，只放 `PATH HOME USER LANG TERM TMPDIR` 和 Codex 自己的 `CODEX_HOME`（用的是 B 的 Codex 额度，
  B 的 owner 同意出借即同意这一项）。**不带** B 的 `.env`（Discord / 控制 token 等）、`BRIDGE_CONTROL_TOKEN`、`CLAUDESTRA_*`、`GH_TOKEN` / `GITHUB_TOKEN`；
  peer token 与实例私钥本来只在 B 的 bridge 进程里，worker 碰不到。回写只能经 B 本机 MCP 工具（M3 前是 `lend submit` CLI，经 bridge 的回环
  接口），由 B 的 bridge 代签代发，worker 自己发不出带签名的 peer 请求。
- **只读**：review 单不提交、不推送；工作副本没有写凭据，推也推不上去。
- **这不是硬边界**：worker 和 B 是同一个 OS 用户，bypass 模式下等于任意 shell，照样能去读 `HOME` 下的文件（peers.json、实例私钥）。
  所以 B 的真实闸门是 `repos` 白名单与逐单确认（同 CLAUDE.md「Security posture」）；独立 OS 用户 / 容器的硬隔离列为后续节点 R9。

**撤销与紧急停止**：
- A：`ledger lend-cancel <orderId>` 撤单（下次续租 B 得到 `cancelled`，B 停 worker、写收据）；`lend.json` 去掉 `borrow` = 停止外借；
  `peer-http-remove` / 吊销 token = 立即切断。
- B：`manager lend off [--peer x]` 停止领新单，在跑的单按 `--now` 选择立即 kill（向 A 报 `released`）或跑完；owner 删 peer 同效。
- 两边的 `doctor` 各显示一行：出借中/借入中的单数与最近一次 poll。

## 6. 失败处理

| 情况 | A 怎么办 | B 怎么办 |
|---|---|---|
| B 离线 / 续租超时 | 租约到期只把 intent 标 `unknown`，停给 PM；**不自动转给别人**（B 可能还在写，结论可能晚到） | 恢复后先续租；被 A 收回就停 worker |
| B 额度用完 | 收到 `release(quota)` → intent 回到 `pooled`（B 明确没干，可安全重派） | 当日不再 poll 该类单 |
| B 的 worker 撞额度 / 登录失败 | 同上，`release(quota|auth)` | 收据记失败原因 |
| 结果不明（result 请求超时、回执丢失） | 以台账为准：同 orderId 已有事件就算完成；没有就等 B 重发（同 orderId 幂等） | 用同一 orderId 重发，最多到租约结束 |
| 结论不明（B 报 unknown / 中途被 kill） | **不换 key 重做**，沿用调度引擎「结果不明停给 PM」；PM 核对后显式 `lend-reoffer`（新 orderId，旧的记 cancelled） | — |
| A 撤单后 B 仍交结果 | 409，不入账 | 写收据「被撤」 |

## 7. 最小可试用版（第一次内部试用）

**切片**：只 review、只 Codex、只公开仓库（claudestra 本身）、B 侧逐单确认、额度只按「单/日」、A 侧手动挂单。

| 做 | 先不做 |
|---|---|
| `lend.json`（lend / borrow）+ CLI | 网页设置页、token 额度执行 |
| A：`lend/poll · claim · lease · result` 四接口 + `ledger lend-offer / lend-cancel` | 调度器自动挂池子（v2，等阶段 2 打开 autoDispatch） |
| B：scheduler 服务里的 lend 循环（同 pass、同租约）+ authorize ask + 一次性 Codex worker（独立 worktree、`env -i` 白名单，§5） | write 角色、fork PR、私有仓库授权 |
| 结果写 A 台账 review 事件（家族标 claim） | 远端 Claude worker、多单并发调优 |
| B 收据 jsonl | 中心服务撮合、中继直连（只留接口，见下） |

**M2 / M3 没合时怎么办**：B 的 worker 用 CLI `manager lend submit <orderId> --verdict … --findings <json>` 回写，参数就是 `submit_verdict` 的字段、
走同一个 `order-wire` 校验；M3 合入后 worker 改调 MCP 工具，CLI 保留给 PM 手动补救。这样明天不被 M1–M3 卡住，也不分叉格式。

**接口预留**：`lend/*` 的四个请求体不含传输细节；以后中心服务撮合时，同样的 poll/claim 由中心转发或直接替代 A 的接口；
中继直连（阶段 6）对这层透明。

**试用步骤**：两位试用同事升级到含本功能的版本 → 各自 `manager lend set team-a --codex 2 --roles review --repos shawnlu96/claudestra` →
A `lend.json` 加 `borrow` → PM 对一张已交付的卡 `ledger lend-offer <T> --step review` → B 的 owner 点确认 → 看 A 台账出现 review 事件、B 收据一行。

### 子 DAG v1 草案（阶段 4，PR 粒度）

| 节点 | 一句话 | 依赖 | 粗估 |
|---|---|---|---|
| R1 | `order-wire.ts`：OrderWire / deliver / verdict 的共享 schema、校验、脱敏；`renderWorkOrder` 接入 | M2/M3 的字段定稿（可先行，M2/M3 反过来引用它） | 3h |
| R2 | `lend.json` 读写 + `manager lend set/off/status` + doctor 行 | — | 3h |
| R3 | A 侧 `lend/*` 四接口 + `pooled` intent + claim CAS + `ledger lend-offer/cancel/reoffer` + peer-write 入账 | R1、R2、T68 PR A 表 | 6h |
| R4 | B 侧 lend 循环：同 pass 同租约、poll 过滤、authorize ask、一次性 worker（独立 worktree + `env -i` 白名单）创建/清理、续租、`lend submit` 转发、收据 | R1、R2、R3 | 7h |
| R5 | 双实例沙箱实测（T81 `--lab --pair`）：A 挂两张、B 上限一、逐单确认、撤单、离线租约 | R3、R4 | 3h |
| R6 | 调度器 peer 分支：本机满才挂池子（v2） | R5、阶段 2 autoDispatch | 4h |
| R7 | M3 合入后 worker 改走 `take_review` / `submit_verdict` MCP，家族/会话由 B 的 M1 填 | R4、M3 | 2h |
| R8 | 私有仓库授权 + write 角色（fork PR） | owner 定 §4 | 6h |
| R9 | 出借 worker 硬隔离（独立 OS 用户或容器） | R5 | 6h |

明天的最小切片 = R1–R5（约 22h agent 工作量，R2 与 R1 可并行；R3、R4 可在 R1 定稿后并行）。

## 8. 给 owner 的待确认（≤ 5 条）

1. **私有仓库怎么给远端读**：建议只用「对方账号只读协作者」，且按项目逐个加；不发 deploy key、不发 token。v1 只做公开仓库。
2. **远端审查结论算不算数**：建议普通卡算一轮正式审查（家族标「自称」）；安全类卡远端结论只作参考，终审必须本机跨家族。
3. **远端离线、租约到期**：建议停给 PM，不自动转给别人（可能重复干活、结论晚到对不上）；代价是偶尔要 PM 点一下重派。
4. **外借范围**：建议缺省什么都不外借，按项目在 `borrow` 里显式列出；个人项目永不外借。
5. **出借方的额度计量**：v1 只按「单/日」限；按 token 限要等 T83 的 usage 账接上，是否需要在明天之前就有？
