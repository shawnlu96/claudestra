/**
 * agent 工具的长说明（从 channel-server.ts 原样搬出，给 channel-server 与 Pi 扩展共用，免得两份漂移）。
 */
export const SEND_TO_AGENT_DESCRIPTION = `Send a message to another agent. Use for agent-to-agent collaboration — 包括跨 Claudestra peer 调用。

**⚠️ 通知 / 询问别的 agent 一律用这个工具，不要用 \`reply(chat_id=对方频道)\`。** \`reply\` 是「发到 Discord 频道给人看」的，发到别的 agent 的频道时 v2.0.15 之前对方 claude 进程**根本收不到**（只贴了 Discord，没 forward 给对方 ws），对方会"无动于衷"。v2.0.15+ 已经兜底也会 forward 了，但 \`send_to_agent\` 才是正路 —— 它有 pushBack 推回、有 \`expecting\` 上下文注入、对方 claude 一定收到。

**target 格式**（v1.9.22+ 新增 peer 语法）：
- \`"agent_name"\` 或 \`"predict"\` — 本地 agent（自动补 "agent-" 前缀）
- \`"peer:ahh.future_data"\` — HTTP peer「ahh」的 future_data agent（长格式）
- \`"future_data@ahh"\` — 同上（短格式）

**什么时候用跨 peer**：如果你**不能**自己完成一个任务（比如数据不在本地、专业领域不是你的 cwd 管的），**先查一下** \`~/.claude-orchestrator/peers.json\` 的 \`httpPeers\` 字段，看看 owner 配置了哪些 peer 实例（v2.11+ HTTP peer）。发之前可以看 \`~/.claude-orchestrator/peer-presence.json\`：bridge 每分钟探一次，记着每个 peer 在不在线、对方开放了哪些 agent（离线的发了只会超时）。有就直接用 \`send_to_agent({ target: "peer:X.Y", ... })\`，比自己硬怼强。本地调也一样：遇到能力不对口的任务先看有没有同事 agent 能帮忙。

**回复机制（v1.9.21+ 推回，不再轮询）**：
- send_to_agent 返回的 \`pushBack: true\` 说明对方（本地 agent 或 peer agent）回复时 bridge 会自动把 text 推回你作为新消息 \`[🤖 xxx 回复] ...\`。**不要** fetch_messages 轮询。
- 只要 end_turn 等那条 push 消息触发下一轮，读它、继续下一步就行。
- 如果对方超过几分钟没回复，你收到任何消息都没有，可以主动用 reply 告诉用户"对方没响应"。

**\`expecting\` 字段（v2.0.12+ 强烈建议填）**：
- \`send_to_agent\` 现在多一个**可选** \`expecting\` 字段，写"对方答完后我应该做啥"。例：
  \`\`\`
  send_to_agent({
    target: "qingniao-backend",
    text: "AI 接口 spec 是 X，能搞定吗？",
    expecting: "等后端确认 OK 后，我要把前端 useMock 切 false + 跑 build:weapp + 出体验版"
  })
  \`\`\`
- bridge 在把对方 reply push 回你的 ws 时，**会在最前面注入一段 \`[💡 你之前期望：...]\` 提醒**，你重新接到 push 时不靠"自己记得"也能续上动作。
- 不填 expecting 不会出错，但实际经验是 caller 经常收到 reply 后忘了原计划，只把对方答复转告用户就 end_turn 了。**协作场景一定填**。

收到 inter-agent 消息（格式 \`[🤖 xxx 回复] ...\` 或 \`[🤖 来自 xxx] ...\`）时，**先分类再行动**：

1. **完成信号 + 包含你下一步动作**（"done, 你切 useMock"、"接口 ready, 你跑 build"）
   → **立即执行**对方告诉你的下一步动作，不要只是 ack。
   → 执行完用 \`reply\` 到自己频道告诉用户进度（"X 切完了 → 跑 Y"），然后继续等下一步或主动接续。

2. **进度更新**（"卡了一下"、"还在搞"、"5 分钟后好"）
   → 用 \`reply\` 简短转告用户，**不动手**。等下一条 push。

3. **直接问你**（"X 接口长啥样？"、"你那边 schema 是啥"）
   → 答它，用 \`send_to_agent\` 反向 reply 回去（target 就是发起方）。同时 \`reply\` 到自己频道留痕。

4. **完成信号但没说下一步**（"done"、"全部修完了"，但没指示你做啥）
   → \`send_to_agent\` 反问对方"下一步要我做啥 / 我现在能测了吗？"，**绝对不要原地静默 end_turn 等**。

**绝对禁止**：收到 peer push 后沉默 end_turn 不做任何事。哪怕你判断它只是 informational，也至少 \`reply\` 一句"收到 [转告内容]"让用户看到协作链条在动。assistant 纯文字到不了 Discord，沉默 = 用户以为你死了。

Examples:
- \`send_to_agent({ target: "predict", text: "分析 ~/data/sales.csv" })\` — 本地
- \`send_to_agent({ target: "future_data@ahh", text: "查 SKYAI 的大户多空比" })\` — 跨 HTTP peer
- \`send_to_agent({ target: "future_data@claudestra_ahh", text: "..." })\` — 跨 peer 短格式`;

export const FORWARD_TO_AGENT_DESCRIPTION = `**转交**：用户这条消息明显是发给另一个 agent 的（发错了对话），把它原样交给那个 agent，由它直接回用户——你**不再回复**这条。

与 send_to_agent 的区别：send_to_agent 是请同事帮忙，同事的回答推回给你、你再转述；转交后回答直接到用户那里，原对话只留一行「↪ 已转给 X」。

**什么时候用**（先判断再动手，别干到一半才转）：
- 明显走错：用户说的项目 / 仓库 / 话题明确归另一个 agent 管（名字相近的 agent 最常见，比如 gc-car 与 gc-car-chat），而且对方在 project_info 的花名册里、在线。
- **拿不准就别转**：直接 reply 一个按钮问用户，例如 \`[[{#fwd_confirm .primary}转给 gc-car-chat]]\`——用户点了你会收到 [button:fwd_confirm]，那时再调本工具转交**用户原来那条消息**的 message_id。
- 不能转：peer 发来的请求、已经被转过一次的消息、目标不在线（工具会告诉你原因，那就改为 reply 告诉用户该找谁）。

原话由 bridge 从你刚收到的消息里原样取出（含附件），你只需给 message_id（<channel> 标签里的 message_id）。
调用成功后直接结束本轮，不要再 reply。`;
