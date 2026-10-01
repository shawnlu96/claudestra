# i28-W7 实测证据：推送版双实例 + 版本混搭

- 代码：main `82c1a00a`（W1–W5、W1c、W4 都已合入）上的分支 `feat/i28-w7`；执行日期 2026-10-01。
- 两套环境：
  - **进程内双实例**（自动化，`tests/lend-lab*.test.ts` + 夹具 `tests/lend-lab-kit.ts`）：
    - A 用真台账 + 真调度 tick（scheduler.json 带 `remote.reviewFirst`）+ 真推送循环 + 真 `ledger lend-*` CLI；
    - B 用真 lend 循环 + 真收单闸 + 真 `manager create` 闸口（`lendModelArgs` → `lendCreateDenied`）+ 真 MCP 路由（`routeLendTool`）；
    - 回执由 A 的实例钥匙真签、B 真验。
    - 复现：`LEND_LAB_TRACE=1 bun test tests/lend-lab.test.ts tests/lend-lab-faults.test.ts tests/lend-lab-compat.test.ts`，每个场景打印一段「证据摘要」，下文贴的就是它。
  - **真机 lab**（`bun run sandbox --port 26100 up --lab --pair`，两台沙箱实例，B→A 走 lab 中继，两个方向都是端到端加密）：
    - B 的调度服务手动起（沙箱不起 launchd）：`env -i` 之后只加载 `sandbox env --as b`，用 `bun --no-env-file src/scheduler.ts` 起；
    - 代码仓库是 lab 自己的本地 bare 仓库 `<lab>/git/o/r.git`（`lend-git.ts labGitRoot`，只有两个小文件），没有从 GitHub 下载；
    - worker 是 lab 固定的 Codex ACP 桩。
    - 用完已 `bun run sandbox --lab --port 26100 down` + `clean`：目录删掉，7 个端口都释放了。
- 下文的 peer 名：进程内 A 管 B 叫 `mate`、B 管 A 叫 `team-a`。真机 lab 两边按主机名互相命名，下文写作 `<A>` / `<B>`。不贴指纹、token、地址。

## 场景一览

| # | 场景 | 进程内（自动化） | 真机 lab | 结论 |
|---|---|---|---|---|
| 1 | 推送主路径 | `lend-lab.test.ts`「场景 1」 | L1 | 通过 |
| 2 | 上限 | `lend-lab.test.ts`「场景 2」 | L2–L4 | 通过 |
| 3 | 一键收回 | `lend-lab.test.ts`「场景 3」 | L2/L3 收回 + L5 | 通过 |
| 4 | 起 worker 前授权被改（W1c） | `lend-lab-faults.test.ts`「场景 4」 | L5（只验「下一单按新授权起」） | 通过 |
| 5 | B 掉线 | `lend-lab-faults.test.ts`「场景 5a / 5b」 | L6（调度服务停着） | 通过 |
| 6 | B 重启 | `lend-lab-faults.test.ts`「场景 6」 | L7 | 通过 |
| 7 | 回执丢失 | `lend-lab-faults.test.ts`「场景 7」 | 未跑（见该节） | 通过 |
| 8 | 隔离反例（W4 验收线 1） | `lend-lab-faults.test.ts`「场景 8」 | 未跑（见该节） | 通过 |
| — | 版本混搭：旧 A + 新 B / 新 A + 旧 B | `lend-lab-compat.test.ts` | 未跑（不改代码模拟不了旧版） | 通过 |
| — | v1 金样本 | `tests/lend-wire-v1-golden.test.ts` 没改动，照常全绿 | — | 通过 |

## 1. 推送主路径

- **命令**
  - 进程内：
    - B 的授权等价于 `lend grant team-a --codex 2 --roles review --repos o/r --codex-model gpt-6-astra --codex-effort xhigh`；
    - A 的 `scheduler.json` 是 `remote: {mode: balance, roles: [review], reviewFirst: ["mate"]}`；
    - 自动卡 T1 交付后由调度 tick 派审。
  - 真机 lab：
    - B 跑 `lend grant <A> --repos o/r --until 3d --codex 2 --roles review --codex-model gpt-6-astra --codex-effort xhigh`；
    - A 跑 `borrow set <B> --projects sandbox --roles review --max-open 3`，再 `ledger lend-offer L1 --peer <B> --repo o/r --pr 7`（PM 手挂）。
- **预期**：
  - A 推送；B 收单即领；
  - 起 worker 时 create 带上授权里的模型和档位；
  - worker 交结论，A 台账出现 review 事件（家族、会话由 B 侧填）；
  - B 收据一行。
- **实际（进程内）**：
  - A 的计划原文：「挂池：对抗式跨模型审查挂给 mate 的 codex worker（scheduler.json remote.reviewFirst 指定先给 mate）」。
  - B 的 journal 里这单 `preview.source = "push"`；收下的那个 pass 里没有 claim，下一个 pass 才 claim。
  - `manager create` 带的参数是 `["--model","gpt-6-astra","--effort","xhigh"]`。
  - worker 调 `submit_verdict`（W4 路由），返回 `{ok:true, forwarded:true, message:"结论已交给对方并拿到回执"}`。
  - 下一个 pass B 原样重发、验签、acked、停 worker；卡推到 merge。
  ```
  A#21 scheduler T1 scheduler：挂池：对抗式跨模型审查挂给 mate 的 codex worker（scheduler.json remote.reviewFirst 指定先给 mate）
  A#22 note T1 scheduler：出借：审查挂给 mate（codex）
  A#24 step T1 owner：assign review 第 1 轮 → agent-lend-3173fa97ec@mate
  A#25 note T1 owner：出借：mate 领了审查（agent-lend-3173fa97ec）
  A#27 review T1 peer:mate：远端审查（mate，单号 lend:T1:s1:r1:a0）：pass
  A#30 stage T1 scheduler：审查通过，进入合并队列
  A 单 lend:T1:s1:r1:a0 done
  B journal lend:T1:s1:r1:a0 acked
  B 收据 {"orderId":"lend:T1:s1:r1:a0","taskId":"T1","step":"review","head":"11111111","family":"codex","outcome":"acked","reason":null,"acked":true}
  线上：hello:200 → poll:200 → hello:200 → claim:200 → beat:200 → result:200 → beat:200 → result:200 → hello:200
  ```
  review 事件的 data 里有：
  - `reviewerFamily: "codex"`；
  - `reviewerSessionId: "lend:mate:lend:T1:s1:r1:a0"`；
  - `lend.claim: {family: "codex", session: "thr-agent-lend-3173fa97ec"}`（B 填的，标 claim）。
- **实际（真机 lab，UTC）**：
  ```
  A ledger lend-peers → {"peer":"<B>","proto":2,"open":0,"slots":{"codex":2,"claude":0},"why":null,"maxOpen":3}
  A#6  13:24:39 note   出借：审查挂给 <B>（codex）
  A#8  13:24:55 note   出借：<B> 领了审查（agent-lend-f37661fadf）
  A#9  13:27:06 review peer:<B>：远端审查（<B>，单号 lend:L1:s1:r1:a0）：pass
  A ledger lend-orders L1 → status done
  B 收据 {orderId: lend:L1:s1:r1:a0, taskId: L1, step: review, family: codex, outcome: acked, tokens: 未知} ackSig.eventSeq = 9（= A 那条 review 的序号）
  B registry agent-lend-f37661fadf → {runtime: codex, transport: acp, model: gpt-6-astra, effort: xhigh, kind: worker}
  worker 窗口：启动配置 model=gpt-6-astra 没生效：「Model」没有 gpt-6-astra 这个选项（可选：stub-sol, stub-luna）
              启动配置 reasoning_effort=xhigh 没生效：「Reasoning Effort」没有 xhigh 这个选项（可选：low, medium, high）
  ```
  - 模型和档位一路传到了 ACP 宿主；桩没有这两个选项是预期的，真 Codex 会接受。
  - 13:24:55 领单后卡了两分钟才开跑：B 卡在「开跑通知没交出去，暂不起 worker」，补上 `CONTROL_CHANNEL_ID` 后就好了（见「问题 4」）。
  - 真机 lab 里 worker 是走派单尾注里的命令行兜底（`lend submit`）交的结论，没走 MCP（见「问题 5」）。MCP 这条路在进程内用真路由验过。

## 2. 上限

- **命令**：B 授权 `--codex 2`、A 的 `--max-open 3`；同时挂 3 张（进程内 T2、T3、T4；真机 L2、L3、L4，三个 `lend-offer` 并发）。
- **预期**：只领 2 张；第 3 张按 W5 的规则回本机或等，原因能查。
- **实际（进程内）**：
  - 一批推 3 张，B 收 2 张、拒 1 张（`no_slot`），A 当场撤单并通知 PM。
  - B 报满以后，自动卡 T1 进审查：reviewFirst 的 mate 不能接，放本机。
  ```
  A#9  note T4 owner：出借：撤单（原状态 pooled）：推送被 mate 拒收（no_slot）
  A#11 note T2 owner：出借：mate 领了审查（agent-lend-338fcb9b67）
  A#13 note T3 owner：出借：mate 领了审查（agent-lend-8aab8495ed）
  A#32 scheduler T1 scheduler：为 reviewer 建本卡独立 session
  B journal lend:T2:s1:r1:a0 started / lend:T3:s1:r1:a0 started（没有 T4）
  线上：hello:200 → poll:200 → hello:200 → claim:200 ×2 → beat:200 ×2
  ledger lend-orders T1 → placement {"role":"review","where":"local","reason":"reviewFirst 里的 peer 都不能接（mate：对方没有空闲的 codex 槽）；没有可用的 peer，放本机"}
  ledger lend-peers --peer mate → [{"peer":"mate","proto":2,"open":2,"slots":{"codex":0,"claude":0},"why":null,"maxOpen":3}]
  ```
- **实际（真机 lab）**：
  ```
  A#25–27 13:27:57 note 出借：审查挂给 <B>（codex）× 3（L3、L2、L4）
  A#28    13:28:02 note L4 出借：撤单（原状态 pooled）：推送被 <B> 拒收（no_slot）
  A#30/32 13:28:03 note L3 / L2 出借：<B> 领了审查
  A ledger lend-peers → {"open":2,"slots":{"codex":0,"claude":0},"why":null}
  B journal：只有 L2、L3，没有 L4
  ```
- 收据：L4 从没进过 B 的 journal，所以没有收据（符合预期）；L2、L3 的收据见场景 3。

## 3. 一键收回

- **命令**：
  - 进程内：worker 在跑时把 B 的 lend.json 里这条删掉（等价于网页「收回」）。
  - 真机 lab：L3 started、L2 cloned 时，B 跑 `lend revoke --peer <A>`（网页「收回」调的是同一个命令）。
- **预期**：在跑的 worker 停下，单退回 A，A 重新放置；收回后 B 不再领新单。
- **实际（进程内）**：
  - 收回后的第一轮先 kill，kill 完才有出站；
  - 下一次 beat 带 `ended:{reason:"revoked", clean:true}`；
  - A 把这单 released，自动卡改放本机；
  - 之后手挂给 mate 的 T2：A 不推（对方没授权），B 不轮询；2 分钟推送 TTL 到点撤回。
  ```
  A#27 note T1 owner：出借：mate 报 not_started：出借方收回授权，worker 干净停下（没有外部副作用），自动重排
  A#35 scheduler T1 scheduler：派对抗式跨模型审查给 agent-rv-t1
  A#38 note T2 owner：出借：撤单（原状态 pooled）：推送超时撤回：推送 2 分钟没收到 mate 的确认
  B journal lend:T1:s1:r1:a0 stopped（出借授权已收回或失效：没有给 team-a 的授权）
  B 收据 {"orderId":"lend:T1:s1:r1:a0","outcome":"stopped","reason":"出借授权已收回或失效：没有给 team-a 的授权","acked":false}
  线上：hello:200 → poll:200 → hello:200 → claim:200 → beat:200 → hello:200 → beat:200
  ```
- **实际（真机 lab）**：
  ```
  B lend revoke → 已收回对 <A> 的出借授权：还没领的单放弃，在跑的 worker 当场停掉；已当场停掉 agent-lend-19abb24bdd、agent-lend-1a2640d1c9 …
  A#33/34 13:28:27 note L3 / L2 出借：<B> 报 not_started：出借方收回授权，worker 干净停下（没有外部副作用），自动重排
  A ledger lend-peers → {"open":0,"slots":{"codex":0,"claude":0},"why":"对方没有授权（或已收回）"}
  B 收据 lend:L3:s1:r1:a0 stopped / lend:L2:s1:r1:a0 stopped（出借授权已收回或失效）
  L5 在 13:29:05 手挂：收回期间（到 13:30:24 重新授权为止）A 没推、B 的 journal 里没有 L5
  ```

## 4. 起 worker 前授权被改（W1c）

- **命令**：
  - 进程内：父进程按 `lendModelArgs` 组好 `--model gpt-6-astra --effort xhigh` 之后、`lendCreateDenied` 之前，出借方把模型改成 `gpt-5.1-codex`（夹具钩子 `beforeCreateGate`）。
  - 真机 lab：这段窗口只有毫秒级，人手卡不准，只验了后半句「下一次按新授权起」。
- **预期**：闸口拒起，单退回 A，下一次按新授权起。
- **实际（进程内）**：
  ```
  A#27 note T1 owner：出借：mate 报 not_started：起 worker 失败：出借 worker 不起：授权里的模型或推理档在起之前改了，本次不起，下一轮按新授权重建参数
  A#37 scheduler T1 scheduler：派对抗式跨模型审查给 agent-rv-t1        ← 自动卡改放本机
  A 单 lend:T1:s1:r1:a0 released（not_started：…）
  B 收据 {"orderId":"lend:T1:s1:r1:a0","outcome":"released","reason":"起 worker 失败：出借 worker 不起：授权里的模型或推理档在起之前改了，…","acked":false}
  下一张 T2：create 参数 ["--model","gpt-5.1-codex","--effort","xhigh"]，started
  线上：… claim:200 → beat:200 → lease:release:200 → hello:200 ×2 → claim:200 → beat:200
  ```
- **实际（真机 lab）**：B 重新授权时没带模型。之后的 L5 由 `agent-lend-ef8f006ea0` 起，registry 记 `model: None, effort: None`，走 B 本机 Codex 的默认配置。也就是按新授权起的。

## 5. B 掉线

- **5a 推送阶段（进程内）**：B 先报过 hello，然后整条网络断掉 130 秒。
  - 预期：推送 TTL 撤回，A 放回本机；B 回来后不出现重复审查。
  - 实际：B 回来后 hello、poll 都通了，但一次 claim 都没有，A 台账里没有 mate 的 review。
  ```
  A#24 note T1 owner：出借：撤单（原状态 pooled）：推送超时撤回：推送 2 分钟没收到 mate 的确认
  A#30 scheduler T1 scheduler：派对抗式跨模型审查给 agent-rv-t1
  A 单 lend:T1:s1:r1:a0 cancelled（推送超时撤回：推送 2 分钟没收到 mate 的确认）
  线上（B 回来之后）：poll:200 ×3 → hello:200
  ```
- **5b worker 在跑时掉线（进程内）**：
  - 预期：B 到租约截止自停 worker；A 记 unknown 交 PM，不自动转派。
  - 实际：B 回来后没有第二份审查，也没有第二个 worker。
  ```
  A#27 note T1 owner：出借：mate 的租约过期，结果不明，不自动重派
  A 单 lend:T1:s1:r1:a0 unknown（租约过期：对方超过租约没有续租）
  B journal lend:T1:s1:r1:a0 stopped（心跳过期：租约截止前没续上，自停 worker（保留工作副本与 journal））
  B 收据 {"outcome":"stopped","reason":"心跳过期：…","acked":false}
  ```
- **真机 lab（B 的调度服务停着 = 出借服务不在）**：
  - 13:31:20 停掉 B 的调度服务；过了 90 秒，13:32:43 手挂 L6。
  - A 推过去，B 的 bridge 收单入口回 `lender_idle`，A 当场撤单，不用等 TTL。
  - 随后重启 B，L6 一直没进 B 的 journal。
  ```
  A#54 13:32:43 note L6 出借：审查挂给 <B>（codex）
  A#55 13:32:47 note L6 出借：撤单（原状态 pooled）：推送被 <B> 拒收（lender_idle）
  ```

## 6. B 重启

- **进程内**：
  - worker 在跑时重启调度服务（换启动号、重开 journal、tmux 里的 worker 留着）：
    - 不建第二个 worker；
    - A 的租约截止跟着 beat 往后走；
    - hello 带上新的启动号 `boot-lab-0002`。
  - 再造一次：worker 交结论那一下 A 入账了、应答丢了，紧接着又重启：
    - 新进程从 journal 的 `result_pending` 原样重发，拿到原回执，acked；
    - A 只有 1 条 review。
  ```
  A#27 review T1 peer:mate：远端审查（mate，单号 lend:T1:s1:r1:a0）：pass
  A 单 lend:T1:s1:r1:a0 done ／ B journal acked ／ B 收据 {"outcome":"acked","acked":true}
  线上：… beat:200 → hello:200 → beat:200 → poll:200 → beat:200 → result:200 → hello:200 → result:200 → …
  ```
- **真机 lab**：
  - L7 在 13:34:12 刚 claimed 时 kill 掉 B 的调度服务（只 kill 自己记下的 pid），6 秒后重启。
  - 新进程从 journal 接着走：clone → 起 worker → 交结论。
  ```
  A#58 13:34:12 note L7 出借：<B> 领了审查（agent-lend-218720fb12）
  A#59 13:34:39 review peer:<B>：远端审查（<B>，单号 lend:L7:s1:r1:a0）：pass
  A 上 L7 的 review 事件数 = 1；B registry 里 L7 只有一个 worker（agent-lend-218720fb12）；B 收据 acked，eventSeq = 59
  ```

## 7. 回执丢失

- **命令（进程内）**：`result` 的应答连丢两次。worker 同步转发那一次丢了，调度服务的第一次重发也丢了。
- **预期**：结论重发幂等，只入账一次。
- **实际**：
  - A 一共收到 3 次 `result`，正文逐字节相同，3 次应答里的回执 `eventSeq` 也相同；
  - A 只有 1 条 review；
  - 单结了以后 worker 再交，回 `no_order`。
  ```
  A#27 review T1 peer:mate：远端审查（mate，单号 lend:T1:s1:r1:a0）：pass
  B 收据 {"outcome":"acked","acked":true}
  线上：… claim:200 → beat:200 → result:200 → beat:200 → result:200 ×2 → hello:200
  ```
- **真机 lab**：这次没跑。
  - 要造「A 入账了、应答丢了」，得在两台之间插一个会丢应答的代理，lab 没有这个工具。
  - 同一条 `lend/result` 的重发幂等在 R5 lab 里已经用 `lend call … result` 原字节重发实测过：回执一字不差，改一个字回 409，见 `ledger/reviews/R5-lab.md`「回执丢失重发」。v2 没改这条接口。

## 8. 隔离反例（W4 验收线 1）

- **命令（进程内）**：
  - 用一张在跑单的 worker 身份（`verified:true`，会话对得上，等于拿着有效凭据直连 B 的 bridge），直接调 `routeLendTool`，以及原生帧入口 `lendFrameGate`。
- **预期**：白名单以外的工具和帧一律拒。
- **实际**：
  ```
  工具：plan_feature / rewrite_dag / start_node / show_dag / fleet / send_to_agent / reply / dispatch / review / stage / ask_codex → 全部 lend_forbidden
  原生帧：reply / route_to_agent / project_info / send_to_agent / fleet_list / ask_codex / create_channel → 全部 {type:"response", error:"lend_forbidden:<帧>"}
  审查单调 take_order / deliver → wrong_step；参数里的 orderId 不是自己的 → order_mismatch；
  未验证身份 → identity_unverified；别的会话 → session_mismatch；head 不对 → head_mismatch
  本单的 take_review 照常返回订单原文；order_tool 帧放行（之后照样过白名单）
  ```
- 拿真代理 token 绕过 channel-server 直连 bridge 的反例是 W4 自己的测试（`tests/lend-tools.test.ts`，起真的 tool-proxy）。
- 真机 lab 这次没跑：lab 桩只会按首条消息里的 `[stub:call:…]` 调工具，而审查单的首条消息是 B 写的唤醒行，A 的规格进不来（见「问题 5」）。

## 版本混搭（设计稿 §8.5）

「旧版」只用关路由或关 v2 端口来模拟，不拉旧代码、不拷整仓：
- 旧 A = kit 里 A 的 bridge 对 hello / beat / ask 回 404；
- 旧 B = 不给 lend 循环 v2 端口。

两个方向都从挂单一路走到入账，B 发出的每个 v1 正文都过了 A 的 v1 严格解析器。

- **旧 A + 新 B**：
  - hello 拿到 404 → 记成 proto 1，A 没有 `lend_peers` 行，从不推送；
  - B 按 30 秒轮询领单，60 秒逐单 `lease renew`，一个 beat 都没发；
  - hello 每个周期再探一次（回的都是 404），对方升级了能认出来；
  - worker 的 `ask` 回 `peer_no_ask`（「对方版本不支持」）。
  ```
  A#5 step T2 owner：assign review 第 1 轮 → agent-lend-338fcb9b67@mate
  A#7 review T2 peer:mate：远端审查（mate，单号 lend:T2:s1:r1:a0）：pass
  B 收据 {"orderId":"lend:T2:s1:r1:a0","outcome":"acked","acked":true}
  线上：hello:404 → poll:200 ×2 → hello:404 → claim:200 → hello:404 → lease:renew:200 → poll:200 → result:200 ×2 → hello:404 → poll:200
  ```
- **新 A + 旧 B**：
  - B 不发 hello → A 不推送，也不按推送 TTL 撤（挂着超过 4 分钟仍是 pooled）；
  - 自动卡的 reviewFirst 把它认作 proto 1，放本机；
  - 手挂的单 B 靠 poll 领，照常入账。
  ```
  ledger lend-orders T1 → placement {"role":"review","where":"local","reason":"reviewFirst 里的 peer 都不能接（mate：没有 hello（proto 1，只按老规则在本机满时接审查））；没有可用的 peer，放本机"}
  A#28 note T2 owner：出借：mate 领了审查（agent-lend-338fcb9b67）
  A#32 review T2 peer:mate：远端审查（mate，单号 lend:T2:s1:r1:a0）：pass
  线上：poll:200 → claim:200 → poll:200 → lease:renew:200 → poll:200 → result:200 ×2
  ```
- **v1 金样本**：`tests/lend-wire-v1-golden.test.ts` 没改一个字节，和 `tests/lend-compat.test.ts` 一起全绿。

## 发现的问题（交 PM 开节点）

### 问题 1（W5c，影响「审查全交给 B」）：reviewFirst 的 peer 比本机忙时，reviewFirst 失效

- **场景**：A 的 `remote.reviewFirst` 是 `[B]`。B 已经在跑 1 张、还有空位，A 本机空闲。
- **现象**：
  - 调度计划写的是「挂池：…挂给 B（scheduler.json remote.reviewFirst 指定先给 B）」；
  - 但投递那一步把意图记成 `cancelled`，原因是「未投递：按当前台账与借入配置重算，已不该挂池」；
  - 这一轮按「已试过」放回本机。
- **根因**：
  - `ledger scheduler-pool` 投递前在事务里重算放置（`ledger-scheduler-pool.ts offer`），但 remote 是从 `--mode / --roles / --timeout-min` 重新拼出来的（`src/manager/ledger-scheduler-cmds.ts` 的 `scheduler-pool`），丢了 `reviewFirst`；
  - 重算就退化成「在跑最少」，B 比本机多跑一张就选本机，和计划对不上。
  - B 和本机都空闲时不会暴露：平手按「peer 先于本机」，碰巧一致。
- **复现**：`bun test tests/lend-lab.test.ts -t "reviewFirst 在 peer 比本机忙时失效"`。这条用 `test.failing` 钉住；产品修好后它会变红，届时去掉 failing。
- **影响**：owner 定的「审查全交给 B」在 B 有活的时候实际不生效。

### 问题 2（W1c × R7a）：网页「重新授权」会清掉授权里的 Codex 模型 / 推理档

- **现象**：
  - 网页授权表单没有模型 / 档位两项；
  - bridge 拼的 argv（`src/bridge/local-api/lend-grant.ts grantArgv`）也不带 `--codex-model / --codex-effort`；
  - 而 CLI 规定「重授不带就清掉」。
  - 所以出借方先用命令行设了模型，再在网页上点「重新授权」或「授权」，模型就静默清掉了。
- **复现（真机 lab）**：
  1. `lend grant <A> … --codex-model gpt-6-astra --codex-effort xhigh`；
  2. 用网页那条 argv：`lend grant --repos=o/r --until=3d --codex=2 --orders-per-day=200 --roles=review -- <A>`；
  3. `lend status` 显示 `codexModel: None, codexEffort: None`；之后的 L5 worker 果然不带模型起。
- **建议**：表单加两项，且重授时保留原值。

### 问题 3（W1，小）：授权 / 收回的提示把早就停掉的 worker 也算成「已当场停掉」

- **现象**：真机 lab 里每次 `lend grant` / `lend revoke`，都报「已当场停掉 agent-lend-f37661fadf、…」，其中 L1 的 worker 几分钟前就已经 acked、停掉了。
- **原因**：registry 里留着 stopped 的一次性 worker 条目（R5 记过不会自动清），`stopRevokedWorkers` 每次都把它们重新停一遍，再报出来。
- **影响**：误导出借方，以为有活被打断了。

### 问题 4（lab 工具 / 手装机器）：B 的开跑通知依赖 `CONTROL_CHANNEL_ID`

- **现象**：
  - 沙箱把这一项清空了，B 每轮都在日志里记「开跑通知没交出去，暂不起 worker」，单停在 cloned；
  - 填 `local-master-control` 也被 B 的 bridge 拒（沙箱没有大总管频道），要填 lab 桩 agent 的频道才行。
- **说明**：R5 记过同一件事，lab 至今要手动补；手装的真实机器如果这项是空的，也会一直不起 worker（手册已写）。
- **建议**：`sandbox up --lab` 自动给 B 配上；`doctor` 加一行。

### 问题 5（lab 工具）：ACP 桩不会走 W4 的 MCP 交结论

- **现象**：
  - W4 之后审查单的首条消息只有 B 写的唤醒行（订单靠 `take_review` 领），桩只认首条消息里的 `[stub:…]` 指令；
  - 桩看到唤醒行里的命令行兜底，就直接用 `lend submit` 交了；
  - 所以真机 lab 验不到 worker 经 MCP 的 `take_review / submit_verdict`，也没法让 worker 去调白名单外的工具。
- **说明**：
  - 想在 A 的规格里写 `[stub:call:…]`，会被 A 的外发闸当成疑似密钥拒绝外发（这个闸是对的）。
  - 进程内用的是真路由，已经覆盖。
- **建议**：桩认出出借唤醒行时，先走 `take_review → submit_verdict`，命令行只作兜底。

### 顺带（已知，未新开）

- A 台账里「领了审查」和 step assign 的 actor 记成 `owner`，实际是 peer 经 bridge 领的（R5 第 5 条，仍然存在）。
