# 押后 agent 消息按收件人合批（HMB-1）

## 问题

收件人在跑回合时，别的 agent 发来的消息先押在 `held-messages.json` 里，回合边界（Stop、压缩结束、每分钟扫描判为空闲）再投。
逐条投时第一条一送进去，收件人就开了新一轮；下一条再投时投递层判它忙，又押回去。所以一个边界实际只进一条。
回合很长、来信又多的收件人（2026-10-13 的 dn-review：中位押 78 分钟、队伍最多 19 条），队伍只会越排越长。

## 做法

开关 `CLAUDESTRA_HELD_AGENT_BATCH`，缺省开。只有写成 `off` / `0` / `false` 才关，关掉后押后投递和改动前逐字一致。

- 在回合边界、目标空闲时，`flushHeld` 把这个收件人到期的本机 agent 消息拼成一封载体，一次送出。可以来自多个发送人。
  只取按到达顺序连续的一段：碰到进不了合批的条目（peer、owner、带附件的……）就停，不越过它，顺序和逐条投递一致。
  逻辑在 `src/bridge/held-flush.ts` 的 `agentCarrier`，成员判定在 `src/lib/held-agent-batch.ts`。
- 载体和内部通知批次（`CLAUDESTRA_HELD_IDLE_BATCH`）是同一套，见 `releaseIdleBatch`：
  - 条数和字数上限同 check_inbox。放不下的留到下一个边界，最早的排最前；超长的只给开头，附 `check_inbox({ read })` 分页读入口。
  - 最早一条自己就超长时不走批次，由原路径整条送，免得它饿死在后面短的后头。
  - 投递期间载体排在队首。原条目真送达后才逐条处理：`touch`（回程失效钟）、`noteDelivered`（这一轮由谁开、谁发了请求）、
    网页入站镜像、`notifyHeldSettled`、送达回调（`onHeldDelivered`），然后出队。崩溃最多重投一次，不会丢。
- 批首写明「逐条处理；答复谁就用 send_to_agent 发给谁」。每条正文和逐条投递时渲染得一样，抬头里带原来的 message_id / from / intent / thread / ts。

## 不进合批的（留在原路径）

- owner、卡片答复、peer、guest 的消息：外人一轮只投一个发送人（`mayJoin`），owner 的有自己的插队规则。
- 交给当班 PM 的角色消息（`pm-held-transfer` 的分轮规则）。
- check_inbox 租约内的、额度闸押着的、带附件的（附件在逐条投递的 meta 里，载体带不走）。
- `expectSession` 跟这一段第一个带会话的不一样的调度派单：一封载体只能核一个会话，这一段在它前面截断。
- 内部通知批次开着时，已归进那批的条目。

压缩中不投、租约内不投、闸内只投 `gatesAsHuman` 这三道闸都在合批之前，和原来一样。
载体本身还要再过一遍投递层，核撤下守卫、会话、额度闸。守门（Chat Guard）在每条消息入队前就跑过了，载体不再判一次，和 check_inbox 领取相同。

## 回复归属

载体不承担归属，回程仍按每条原消息各记一槽（`bridge/agent-calls.ts`）。

- 押着时这条请求不算送到，送达后几个 caller 同时在等。
- target 用 send_to_agent 回给 X，只消化 X 那一槽。
- 没指明答给谁的回复（自己频道 reply、Stop 兜底），只在恰好一个 caller 在等时才推。多个在等就谁都不推，提醒 target 分别回。
- 补的一处是 `bridge/stop-settle.ts answerableUnmixed`。target 在自己频道 reply（`bridge.ts answerablePac`）和 Stop 兜底，
  都经它判没指明收件人的答复归谁。这一轮如果是几个 agent 的请求一起开的，这句话不认给任何一位：不管剩下的是本轮的 B，
  还是更早一轮留下的 C，都既不推、也不消化槽。回程留着，等 target 精确答复：send_to_agent，或者 reply 到对方频道。
  精确答复不经这道判定。
  只发 oneShot 通知的发送人不算请求方，不挡唯一请求方。

## 和逐条投递的差别

载体是 bridge 发的一封通知，逐条投递在 `bridge.ts deliverToLocal` 里做的这几件事，载体不替成员做：

- `pendingReplies`：「忘了 reply」的 Stop 拦截。
- `pendingInterAgentMsg` 看门狗。
- `turnCuts` 的逐条入站记录。

check_inbox 领取也不做这几件，回程靠的是回程簿和 Stop 兜底。

测试：`tests/held-agent-batch.test.ts`。逐条路径的机理仍由 `tests/held-flush.test.ts` 守着，那里的 harness 关掉了合批。
