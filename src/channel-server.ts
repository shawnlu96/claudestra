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

function connectBridge(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);

    ws.onopen = () => {
      bridgeWs = ws;
      reconnectAttempts = 0;
      // 注册频道
      ws.send(
        JSON.stringify({
          type: "register",
          channelId: CHANNEL_ID,
          userId: ALLOWED_USER_ID || undefined,
        })
      );
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
      // 断开时清理所有未完成请求，避免泄漏
      for (const [id, pending] of pendingRequests.entries()) {
        pending.reject(new Error("Bridge 连接断开"));
        pendingRequests.delete(id);
      }

      // 被 bridge 主动关闭（code 1000 + replaced 标记）→ 直接退出，不重连
      if (replaced || event?.code === 1000) {
        console.error("👋 channel-server 退出（被 bridge 主动取代）");
        process.exit(0);
      }

      // 否则正常的指数退避重连：3s, 6s, 12s, 24s, 48s, 60s cap
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
    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      reject(new Error("Bridge 未连接"));
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
  });
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
    instructions: `Discord channel bridge. User is on their phone.

Reply rules:
- Use the "reply" tool with chat_id from the <channel> tag.
- If reply tool unavailable, use: bun ${CLAUDESTRA_HOME}/src/discord-reply.ts "<chat_id>" "<text>"
- Never use markdown tables (Discord doesn't support them). Use bullet lists.
- Keep lines under 60 chars in code blocks. Max 2000 chars per message.
- Be concise — user is reading on a small screen.
- Reply in 中文.
- Do NOT @ the user in your reply body. The system adds one @mention automatically when your turn ends, so adding your own (\`<@id>\` or \`@username\`) causes double-notification.

跨 Claudestra 协作（peer 消息）：
- 当你收到的 <channel> tag 里 meta 含 \`peer="true"\`，说明这条消息是**另一个 Claudestra 实例的 bot** 发过来的（peer agent 用 @ 来找你）。\`peer_bot_name\` / \`peer_bot_id\` 告诉你是谁。
- 按消息内容正常响应 + 用 reply(chat_id=当前 channel) 回答。Discord 频道的权限配置保证了你只会在被邀请进的频道里看到这种消息。
- 回答时 **正文里 @ 一下 peer bot**（用 \`<@peer_bot_id>\`）方便对方的 bridge 识别你在给它回话。

主动联系另一个 Claudestra：
- 调 \`list_shared_channels\` 看你能访问到的所有频道。对方 Claudestra 的管理员如果把他们的 bot 邀请到了你这边的频道，你能在列表里看到；反过来他们邀请了你的 bot 到他们的频道，你也能看到（guild 名字跟你自己服务器不同的那些）。
- 按频道的 \`name\` 和 \`topic\` 判断应该去哪个频道提问（比如想问阿里云盘相关就找 \`alipan-resource\` topic 的那个频道）。
- 用 \`reply(chat_id=<对方频道id>, text="<@对方bot> 我遇到了 ...")\` 在对方频道 @ 他们的 bot 提问。对方 bridge 会转给对方合适的 agent，回复会在同一个频道出现。
- 你可以继续 fetch_messages 那个 channel_id 轮询等回复（跟 send_to_agent 类似的主动汇报义务）。`,
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
        "Send a reply to the Discord channel. Messages over 2000 chars are auto-chunked.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: {
            type: "string",
            description: "Discord channel ID to send to",
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
            description: `Optional Discord UI components. Each item is a row:
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
        "Fetch recent messages from a Discord channel. Returns oldest-first.",
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
      description: "Add an emoji reaction to a message.",
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
      description: "Edit a previously sent bot message.",
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
      description: `列出你所在的 Discord bot 能访问的所有文字频道（含频道名、topic、所属 guild）。

用于**跨 Claudestra 协作**：如果你发现对方 Claudestra 的用户把他们的 bot 邀请到了你这边的某些频道，你就能看到对应频道；反过来，当你这边的 bot 被对方邀请到了他们的频道，你也能看到。

**什么时候用：**
- 你遇到一个问题需要对方 Claudestra 的某类 agent（比如阿里云盘 / 加密货币追踪 / Claudestra 本身的 bug）协助
- 你想知道"对方开放了哪些频道给我"，按频道名或 topic 判断应该去哪个频道提问
- 然后用 \`reply(chat_id=<那个频道 id>, text="@对方bot xxx")\` 在那个频道 @ 对方 bot 提问

**返回示例：**
\`\`\`json
[
  { "id": "123", "name": "alipan-resource", "topic": "阿里云盘资源管理", "guild": "Shawn's" },
  { "id": "456", "name": "predict", "topic": "量化预测", "guild": "Shawn's" },
  { "id": "789", "name": "general", "topic": "", "guild": "My Own Server" }
]
\`\`\`

自己的 guild 里的频道也会出现在列表里，过滤时看 guild 名字 / id 区分。`,
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "send_to_agent",
      description: `Send a message to another agent by name. Use this for agent-to-agent collaboration.

IMPORTANT — 主动汇报义务（必读）：
1. 发完消息后，你 **必须** 用 fetch_messages 轮询 targetChannelId 拿对方的回复（首次 sleep 10-15s，之后每 10s 一次，最多 5 次）。
2. 拿到回复后，**必须** 用 reply 工具把"你对谁说了什么 + 对方的回复摘要"汇报给用户。用户不会自己去别的频道查。
3. 如果对方超过 1 分钟没回复，也要用 reply 告诉用户"对方暂时没响应"，不要静默。
4. 如果对方回复中又让你做别的事，按正常流程执行。

收到 inter-agent 消息时（格式为 "[🤖 来自 xxx] ..."）：
- 按对方的请求正常处理并用 reply 回到自己的频道
- 同时用户也会看到这次互动，所以要清晰表明是在回应 xxx 的请求

Examples:
- send_to_agent({ target: "predict", text: "帮我分析 ~/data/sales.csv，返回摘要" })
- send_to_agent({ target: "researcher", text: "X 的调研结果如何？" })`,
      inputSchema: {
        type: "object" as const,
        properties: {
          target: {
            type: "string",
            description: "Target agent name, e.g. 'predict'",
          },
          text: {
            type: "string",
            description: "Message text to send",
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
      const result = await bridgeRequest({
        type: "route_to_agent",
        targetName: args?.target || "",
        text: args?.text || "",
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `消息已发送给 ${result.targetName}。如需获取回复，可用 fetch_messages 轮询频道 ${result.targetChannelId}`,
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
  // 先连接 Bridge
  await connectBridge();

  // 启动 MCP stdio transport
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
