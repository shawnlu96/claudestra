/**
 * Channel MCP Server — 轻量代理
 *
 * 每个 Claude Code 进程启动一个实例。通过 WebSocket 连接到共享的 Bridge，
 * 注册自己对应的 Discord 频道。Bridge 路由消息，此 server 转换为 MCP 协议。
 *
 * 环境变量：
 *   DISCORD_CHANNEL_ID  — 此实例对应的 Discord 频道 ID
 *   BRIDGE_URL           — Bridge WebSocket 地址 (默认 ws://localhost:3847)
 *   ALLOWED_USER_ID      — 允许的 Discord 用户 ID (可选)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ============================================================
// 配置
// ============================================================

const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:3847";
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID || "";
const MCP_NAME = process.env.MCP_NAME || "claudestra";
const CLAUDESTRA_HOME =
  process.env.CLAUDESTRA_HOME || `${import.meta.dir}/..`;

if (!CHANNEL_ID) {
  console.error("❌ 请设置 DISCORD_CHANNEL_ID 环境变量");
  process.exit(1);
}

// ============================================================
// Bridge WebSocket 连接
// ============================================================

let bridgeWs: WebSocket | null = null;
let registered = false;
let replaced = false; // bridge 通知此 channel-server 被新连接取代，跳过重连直接退出
const pendingRequests = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
let requestCounter = 0;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 60_000;

// v2.4.13+ grace-period queue：WS 跟 bridge 断了的时候，新进来的 MCP 请求不立刻
// reject，而是入队等 WS 重连后重发。这样 Claude Code 在短暂 WS flap（典型 2-5s）
// 期间不会收到 "Bridge 连接断开" 错误，也就不会把 claudestra MCP 标 "disconnected"。
// 实测 Claude Code 不会在 stdio EOF 时自动 respawn，也不会在 /mcp 触发时自动重连，
// 所以 reply 工具一旦掉就只能用户手敲 /mcp + 菜单选重连。预防 > 治疗：让 channel-server
// 在 WS gap 期间表现得像"慢一点的成功"而不是"快速的失败"。
const GRACE_QUEUE_MS = 15_000;
interface QueuedSender {
  send: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const queuedSenders: QueuedSender[] = [];

function flushQueuedSenders() {
  if (!queuedSenders.length) return;
  console.error(`🔁 WS 恢复，flush ${queuedSenders.length} 个排队请求`);
  // 拷贝后清空，避免 send 路径里再次入队产生死循环
  const snapshot = queuedSenders.splice(0, queuedSenders.length);
  for (const q of snapshot) {
    clearTimeout(q.timer);
    try {
      q.send();
    } catch (err) {
      q.reject(err as Error);
    }
  }
}

function rejectQueuedSenders(reason: string) {
  if (!queuedSenders.length) return;
  console.error(`❌ ${reason}，reject ${queuedSenders.length} 个排队请求`);
  const snapshot = queuedSenders.splice(0, queuedSenders.length);
  for (const q of snapshot) {
    clearTimeout(q.timer);
    q.reject(new Error(reason));
  }
}

// v2.2.0+: keepalive —— 定期给 bridge 发 ping，重置 Bun 的 ws idleTimeout，避免空闲
// 连接被关。bridge 收到 type:"ping" 不做实质处理（收到本身就重置 idle），可回 pong。
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
function startKeepalive() {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
      try { bridgeWs.send(JSON.stringify({ type: "ping" })); } catch { /* non-critical */ }
    }
  }, 25_000);
}
function stopKeepalive() {
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
}

function connectBridge(): Promise<void> {
  // v2.2.0+: 每次新连接前重置 replaced latch。replaced 是模块级变量，之前从不重置，
  // 一旦收到过一次（哪怕是重连竞态里发给上一条 ws 的）"replaced"，标记就永久 true，
  // 之后**任何**断开都会 process.exit(0) → channel-server 进程死掉、Claude Code 不
  // 自动 respawn → agent 跟 Discord 彻底断、只能手动 /mcp。这里在每次新连接开始时
  // 清掉残留 latch，只让「当前这条连接确实被取代」时才退出。
  replaced = false;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);

    ws.onopen = () => {
      bridgeWs = ws;
      reconnectAttempts = 0;
      // 注册频道。v1.9.21+ 带上 cwd → bridge 用它算 Claude Code jsonl 路径
      // (~/.claude/projects/<slug>/<sessionId>.jsonl)，用于 reply 缺失时兜底抽取
      // assistant 文字。
      ws.send(
        JSON.stringify({
          type: "register",
          channelId: CHANNEL_ID,
          userId: ALLOWED_USER_ID || undefined,
          cwd: process.cwd(),
        })
      );
      // v2.2.0+: keepalive ping，防止空闲连接被 Bun idleTimeout 关掉（无 keepalive 时
      // 长时间不说话的 agent 连接会被关，触发反复重连 flap）。每 25s 发一次。
      startKeepalive();
    };

    ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }

      if (msg.type === "registered") {
        registered = true;
        // v2.4.13+ WS (重)连成功 → 把 grace 期间排队的请求全部重发
        flushQueuedSenders();
        resolve();
        return;
      }

      if (msg.type === "response") {
        const pending = pendingRequests.get(msg.requestId);
        if (pending) {
          pendingRequests.delete(msg.requestId);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        }
        return;
      }

      if (msg.type === "message") {
        // 推送消息给 Claude Code
        handleInboundMessage(msg.content, msg.meta);
        return;
      }

      if (msg.type === "replaced") {
        // bridge 通知我们已经被新的 channel-server 取代
        // 这是 claude 同时通过两个 MCP 注册 spawn 双份的情况
        // 标记为 replaced，下面的 onclose 就不会重连
        replaced = true;
        console.error(
          `❎ 被新连接取代 (${msg.reason || "unknown"})，channel-server 退出`
        );
        return;
      }
    };

    ws.onerror = (err) => {
      console.error("Bridge WebSocket 错误:", err);
      if (!registered) reject(err);
    };

    ws.onclose = (event) => {
      bridgeWs = null;
      registered = false;
      stopKeepalive();
      // 断开时清理所有未完成请求，避免泄漏
      for (const [id, pending] of pendingRequests.entries()) {
        pending.reject(new Error("Bridge 连接断开"));
        pendingRequests.delete(id);
      }

      // 仅当 bridge 明确告诉我们"你被新连接取代了"才退出。判定用**专用 close code
      // 4001**（v2.2.0+），不再依赖 "replaced" 消息能否在 close 之前送达 —— 之前
      // bridge 用 close(1000) + 一条 "replaced" 消息，两者有竞态：close 先到时
      // replaced 标记还没置上 → 误重连，置上后又永久 latch（见 connectBridge 注释）。
      // code 1000 仍只意味着对端干净关闭（如 bridge 重启）→ 应重连，不退出。
      if (replaced || event.code === 4001) {
        console.error("👋 channel-server 退出（被新连接取代）");
        // 退出前 reject 所有排队请求（Claude Code 会立刻收到错误而不是等 15s 超时）
        rejectQueuedSenders("channel-server 被新连接取代");
        process.exit(0);
      }

      // 正常的指数退避重连：3s, 6s, 12s, 24s, 48s, 60s cap
      reconnectAttempts++;
      const delay = Math.min(
        3000 * Math.pow(2, Math.min(reconnectAttempts - 1, 5)),
        MAX_RECONNECT_DELAY_MS
      );
      setTimeout(() => {
        connectBridge().catch(() => {});
      }, delay);
    };
  });
}

function bridgeRequest(msg: any): Promise<any> {
  return new Promise((resolve, reject) => {
    // v2.4.13+ grace-queue：WS 断了但 channel-server 之前注册成功过 → 入队等重连，
    // 而不是立刻 reject。让 Claude Code 在 WS flap 期间体验"慢一点的成功"而不是
    // "立即失败"。失败会触发 Claude Code 把 MCP server 标 "disconnected"，必须用户
    // 手敲 /mcp + 菜单选择才能恢复，这是我们要根除的痛点。
    const wsReady = bridgeWs && bridgeWs.readyState === WebSocket.OPEN && registered;
    if (!wsReady) {
      // v2.5.4+ 初次注册前的请求也入队（之前直接 reject）：main 已改成初连失败
      // 不退出、后台退避重连，bridge 起来后 registered 分支会 flush 队列 ——
      // "尚未初次注册"不再是死路，15s 超时兜底依然在。
      // 入队，给 15s 宽限等 WS 恢复
      const entry: QueuedSender = {
        send: () => doSend(msg, resolve, reject),
        reject,
        timer: setTimeout(() => {
          const idx = queuedSenders.indexOf(entry);
          if (idx >= 0) queuedSenders.splice(idx, 1);
          reject(new Error(`Bridge 断开超 ${GRACE_QUEUE_MS}ms 没恢复`));
        }, GRACE_QUEUE_MS),
      };
      queuedSenders.push(entry);
      console.error(
        `⏸ WS 断开，请求入队等重连（队列长度=${queuedSenders.length}）`
      );
      return;
    }
    doSend(msg, resolve, reject);
  });
}

function doSend(
  msg: any,
  resolve: (v: any) => void,
  reject: (e: Error) => void
) {
  if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
    reject(new Error("Bridge 未连接（doSend 时 WS 不可用）"));
    return;
  }
  const requestId = `req_${++requestCounter}`;
  msg.requestId = requestId;
  pendingRequests.set(requestId, { resolve, reject });
  const timer = setTimeout(() => {
    if (pendingRequests.has(requestId)) {
      pendingRequests.delete(requestId);
      reject(new Error("Bridge 请求超时"));
    }
  }, 30000);
  try {
    bridgeWs.send(JSON.stringify(msg));
  } catch (err) {
    // send 失败时同样清理，防止泄漏
    clearTimeout(timer);
    pendingRequests.delete(requestId);
    reject(err as Error);
  }
}

// ============================================================
// MCP Server
// ============================================================

const mcp = new Server(
  { name: MCP_NAME, version: "1.0.0" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
      },
    },
    instructions: `Claudestra channel bridge——用户通过 Discord 或 Web 客户端远程与你对话（多在手机上）。

Reply rules（通用，不分来源）:
- Use the "reply" tool with chat_id from the <channel> tag.
- If reply tool unavailable, use: bun ${CLAUDESTRA_HOME}/src/discord-reply.ts "<chat_id>" "<text>"
- Reply in 精简中文——直奔结论，先说结果再说细节。
- 有干货才说话；纯状态同步没人问就别刷屏。

**格式按消息来源分流（看 <channel> tag 的 chat_id）：**

chat_id 以 \`api:\` 开头 = **Web 客户端**：
- 完整 Markdown 可用：表格、长消息、代码块都正常写，不受 Discord 限制。
- 用户在 Web 界面能看到本频道**完整聊天记录**（含工具执行过程）——回复不要复述上下文。
- 没有 @mention 语义。
- 这是外部 token 接入的 principal：不要在回复里引用与本请求无关的上下文内容。

chat_id 是纯数字 = **Discord 频道**：
- Never use markdown tables (Discord doesn't support them). Use bullet lists.
- Keep lines under 60 chars in code blocks. Max 2000 chars per message.
- Do NOT @ the user in your reply body. The system adds one @mention automatically when your turn ends, so adding your own (\`<@id>\` or \`@username\`) causes double-notification.

**确认 / 决策类回复一律用按钮（components，两端都渲染），不要用纯文字问问题：**
- commit / push / git tag / release 这种走 git 的操作
- 任何破坏性 / 不可逆操作（删文件、kill agent、drop table、force-push 等）
- 多选一的方案选择
用户在手机上，按钮一点就完成；让他打字回 "好" / "yes" / "push" 是糟糕 UX。最小模板：
\`\`\`
reply({
  chat_id: "<本频道>",
  text: "v2.0.2 commit 完成，要 push + tag + release 吗？",
  components: [{
    type: "buttons",
    buttons: [
      { id: "release_v2_0_2_go", label: "✅ Push + Tag + Release", style: "success" },
      { id: "release_v2_0_2_cancel", label: "🚫 取消", style: "secondary" }
    ]
  }]
})
\`\`\`
你会以 \`[button:<id>]\` 形式收到点击事件，按 id 分支处理。

**用户在你的频道直接发消息 = 你直接回答这里，不要把决定推给 master：**
- master 的职责是 #control 调度。worker 频道里用户跟你说话，决策权就在你和用户之间，你直接发按钮 / 直接 commit / 直接执行。
- 不要在你的回复里写 "等大总管确认" / "我去问下 master"，user 已经在跟你直接对话了。

**系统级共享资源（LaunchAgent / 监听端口 / TLS 证书 / crontab 等机器级设施）的规矩（2026-07-24 双 caddy 事故后立）：**
- **动手前先查现状**：注册 LaunchAgent 前 \`launchctl list\`+看 ~/Library/LaunchAgents/ 有没有同类；绑端口前 \`lsof -iTCP:<port>\`。别的服务已经在做同一件事（如反代/TLS 终结）就复用，不要另起一份。
- **这类变更的决策一律上报用户拍板，不在 agent 之间互相拍板**——别的 agent 无权决定机器基建，把「你定」抛给同事只会踢皮球。用 reply() 带按钮问用户。
- 改完在自己频道 reply 留痕（改了什么、为什么），方便其他 agent 与用户事后追溯。

跨 Claudestra 协作（v2.11+ HTTP peer 模型）：

- 收到带「🤝 来自 peer 实例」注入头的消息 = 另一个 Claudestra 实例的跨机请求（HTTP API 接入，通常由对方 agent 的 send_to_agent 发起）。用 reply() 回答即可——回复会自动转交对方的调用方。回答实质内容，保持精简；超出你职责范围的请求可以礼貌说明并拒绝。
- 主动调对方实例的 agent：\`send_to_agent({ target: "<对方agent>@<peer名>" })\`（或长格式 \`peer:<peer名>.<对方agent>\`）。对方回复会由 bridge push 回来。
- peers 由 owner 用 \`manager.ts peer-http-*\` CLI 管理（invite/join/accept/test/list/remove），已配置的在 \`~/.claude-orchestrator/peers.json\` 的 \`httpPeers\` 字段。`,
  }
);

// 处理来自 Bridge 的入站消息 → MCP notification
function handleInboundMessage(
  content: string,
  meta: Record<string, string>
) {
  mcp.notification({
    method: "notifications/claude/channel",
    params: { content, meta },
  });
}

// 列出可用工具
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a reply to the user's channel (Discord or Web). On Discord, messages over 2000 chars are auto-chunked.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: {
            type: "string",
            description: "Target chat id from the <channel> tag (Discord channel ID, or api:<tokenId> for Web/API users)",
          },
          text: {
            type: "string",
            description: "Message text to send",
          },
          reply_to: {
            type: "string",
            description: "Message ID to reply to (optional, for threading)",
          },
          components: {
            type: "array",
            description: `Optional UI components (rendered on both Discord and the Web client). Each item is a row:
- Button row: { "type": "buttons", "buttons": [{ "id": "unique_id", "label": "Click me", "style": "primary|secondary|success|danger", "emoji": "optional emoji" }] }
- Select menu: { "type": "select", "id": "unique_id", "placeholder": "Choose...", "options": [{ "label": "Option 1", "value": "val1", "description": "optional" }] }
When a user clicks a button, you'll receive a channel message: [button:unique_id]
When a user selects from a menu, you'll receive: [select:unique_id:selected_value]`,
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Absolute file paths to attach (images, logs, etc). Max 10 files, 25MB each.",
          },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "fetch_messages",
      description:
        "Fetch recent messages from a Discord channel. Returns oldest-first. 仅 Discord 会话可用；api: 前缀的会话没有消息历史语义。",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: {
            type: "string",
            description: "Discord channel ID",
          },
          limit: {
            type: "number",
            description: "Number of messages to fetch (max 100, default 20)",
          },
        },
        required: ["channel"],
      },
    },
    {
      name: "react",
      description: "Add an emoji reaction to a message. 仅 Discord 会话可用（chat_id 为 api: 前缀时会报错，直接 reply 即可）。",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "Discord channel ID" },
          message_id: { type: "string", description: "Message ID to react to" },
          emoji: {
            type: "string",
            description: "Emoji to react with (e.g. '👍')",
          },
        },
        required: ["chat_id", "message_id", "emoji"],
      },
    },
    {
      name: "edit_message",
      description: "Edit a previously sent bot message. 仅 Discord 会话可用；API 会话的消息发出后不可编辑，需更正就再 reply 一条。",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "Discord channel ID" },
          message_id: { type: "string", description: "Message ID to edit" },
          text: { type: "string", description: "New message text" },
        },
        required: ["chat_id", "message_id", "text"],
      },
    },
    {
      name: "list_shared_channels",
      description: `列出本机 Discord bot 能访问的所有文字频道（含频道名、topic、所属 guild）。诊断/巡查用——确认某个 agent 频道是否存在、看频道 topic。跨 Claudestra 实例协作不走 Discord 频道:用 send_to_agent(target="对方agent@peer名")(HTTP peer,owner 用 peer-http-* CLI 配置)。`,
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "send_to_agent",
      description: `Send a message to another agent. Use for agent-to-agent collaboration — 包括跨 Claudestra peer 调用。

**⚠️ 通知 / 询问别的 agent 一律用这个工具，不要用 \`reply(chat_id=对方频道)\`。** \`reply\` 是「发到 Discord 频道给人看」的，发到别的 agent 的频道时 v2.0.15 之前对方 claude 进程**根本收不到**（只贴了 Discord，没 forward 给对方 ws），对方会"无动于衷"。v2.0.15+ 已经兜底也会 forward 了，但 \`send_to_agent\` 才是正路 —— 它有 pushBack 推回、有 \`expecting\` 上下文注入、对方 claude 一定收到。

**target 格式**（v1.9.22+ 新增 peer 语法）：
- \`"agent_name"\` 或 \`"predict"\` — 本地 agent（自动补 "agent-" 前缀）
- \`"peer:ahh.future_data"\` — HTTP peer「ahh」的 future_data agent（长格式）
- \`"future_data@ahh"\` — 同上（短格式）

**什么时候用跨 peer**：如果你**不能**自己完成一个任务（比如数据不在本地、专业领域不是你的 cwd 管的），**先查一下** \`~/.claude-orchestrator/peers.json\` 的 \`httpPeers\` 字段，看看 owner 配置了哪些 peer 实例（v2.11+ HTTP peer）。有就直接用 \`send_to_agent({ target: "peer:X.Y", ... })\`，比自己硬怼强。本地调也一样：遇到能力不对口的任务先看有没有同事 agent 能帮忙。

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
- \`send_to_agent({ target: "future_data@claudestra_ahh", text: "..." })\` — 跨 peer 短格式`,
      inputSchema: {
        type: "object" as const,
        properties: {
          target: {
            type: "string",
            description: "Target agent name. Formats: 'predict' (local), 'peer:claudestra_ahh.future_data' (cross-peer long), 'future_data@claudestra_ahh' (cross-peer short)",
          },
          text: {
            type: "string",
            description: "Message text to send",
          },
          expecting: {
            type: "string",
            description: "Optional. What you (the caller) plan to do AFTER the target replies. Bridge injects this back into your push-back so you don't forget the plan. e.g., 'after backend confirms API is up, I'll switch useMock=false and run build:weapp'. Strongly recommended for any multi-step collaboration.",
          },
          oneShot: {
            type: "boolean",
            description: "Optional (default false). 设 true = 这条消息是 fire-and-forget 通知，**不期待对方 reply / 不要 bridge 自动 push-back**。用法：你只是同步状态、ack 收到、抄送 FYI，对方应该直接 end_turn 不回应。bridge 不会给对方挂 watchdog nudge，也不会在对方 Stop 时给你自动 push 任何东西。避免 agent 之间无意义的 ack 循环。",
          },
        },
        required: ["target", "text"],
      },
    },
  ],
}));

// 处理工具调用
mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "reply": {
      const result = await bridgeRequest({
        type: "reply",
        chatId: args?.chat_id || CHANNEL_ID,
        text: args?.text || "",
        replyTo: args?.reply_to,
        components: args?.components,
        files: args?.files,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Sent message(s): ${JSON.stringify(result.messageIds)}`,
          },
        ],
      };
    }

    case "fetch_messages": {
      const result = await bridgeRequest({
        type: "fetch_messages",
        channel: args?.channel || CHANNEL_ID,
        limit: args?.limit || 20,
      });
      return {
        content: [{ type: "text" as const, text: String(result) }],
      };
    }

    case "react": {
      await bridgeRequest({
        type: "react",
        chatId: args?.chat_id || CHANNEL_ID,
        messageId: args?.message_id,
        emoji: args?.emoji,
      });
      return {
        content: [{ type: "text" as const, text: "Reacted." }],
      };
    }

    case "edit_message": {
      await bridgeRequest({
        type: "edit_message",
        chatId: args?.chat_id || CHANNEL_ID,
        messageId: args?.message_id,
        text: args?.text,
      });
      return {
        content: [{ type: "text" as const, text: "Message edited." }],
      };
    }

    case "list_shared_channels": {
      const result = await bridgeRequest({ type: "list_channels" });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.channels || [], null, 2),
          },
        ],
      };
    }

    case "send_to_agent": {
      const oneShot = args?.oneShot === true;
      const result = await bridgeRequest({
        type: "route_to_agent",
        targetName: args?.target || "",
        text: args?.text || "",
        expecting: typeof args?.expecting === "string" ? args.expecting : undefined,
        oneShot,
      });
      // v1.9.21+: bridge 现在会自动把对方的下一条 reply push 回你的 ws，
      // 你不用 fetch_messages 轮询。直接 end_turn，等对方那条 push 消息触发下一轮。
      // v2.4.16+: oneShot=true 时 bridge 既不挂 pending 也不会 push-back，advice 反映这点。
      const advice = oneShot
        ? `消息已 fire-and-forget 发给 ${result.targetName}。**不期待任何 push-back**。对方收到会自己判断要不要回，可能直接 end_turn。end_turn 等用户下一步指示即可。`
        : result.pushBack
        ? `消息已发送给 ${result.targetName}。**不要轮询 fetch_messages** —— bridge 会在对方 reply 时自动把回复 push 到你这边作为新的入站消息，结束本轮等即可。`
        : `消息已发送给 ${result.targetName}。如需获取回复，可用 fetch_messages 轮询频道 ${result.targetChannelId}`;
      return {
        content: [
          {
            type: "text" as const,
            text: advice,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ============================================================
// 启动
// ============================================================

async function main() {
  // 先连接 Bridge。v2.5.4+ 初次连接失败**不再退出**：电脑重启后 launchd 同时拉
  // bridge 和 launcher，agent 恢复时 bridge 常常还没就绪（Discord login 要几秒），
  // channel-server 初连被拒 → 之前这里直接 process.exit(1)，而 Claude Code 不会
  // respawn stdio MCP → agent 永久失联（消息不达 / reply 不可用 / watcher 不启动），
  // 只能手动 restart。现在初连失败交给 onclose 的指数退避重连（3s..60s cap），
  // 跟断线重连同一条路：bridge 起来后自动注册，全程无感。
  await connectBridge().catch((err) => {
    console.error("初次连接 Bridge 失败（后台退避重连中）:", (err as Error)?.message || err);
  });

  // 启动 MCP stdio transport（无论 bridge 是否已连上都要起，Claude Code 侧的
  // MCP 握手不依赖 bridge；bridge 连上前工具调用会走 grace-queue / 明确报错）
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
