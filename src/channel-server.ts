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

if (!CHANNEL_ID) {
  console.error("❌ 请设置 DISCORD_CHANNEL_ID 环境变量");
  process.exit(1);
}

// ============================================================
// Bridge WebSocket 连接
// ============================================================

let bridgeWs: WebSocket | null = null;
let registered = false;
const pendingRequests = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
let requestCounter = 0;

function connectBridge(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);

    ws.onopen = () => {
      bridgeWs = ws;
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
    };

    ws.onerror = (err) => {
      console.error("Bridge WebSocket 错误:", err);
      if (!registered) reject(err);
    };

    ws.onclose = () => {
      bridgeWs = null;
      registered = false;
      // 自动重连
      setTimeout(() => {
        connectBridge().catch(() => {});
      }, 3000);
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
    bridgeWs.send(JSON.stringify(msg));
    // 超时
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error("Bridge 请求超时"));
      }
    }, 30000);
  });
}

// ============================================================
// MCP Server
// ============================================================

const mcp = new Server(
  { name: "discord-bridge", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
      },
    },
    instructions: `You are connected to a Discord channel via a bridge.
When you receive a <channel> message, it came from a Discord user viewing on their phone.

IMPORTANT — How to reply to Discord:
1. First try: use the "reply" MCP tool (chat_id, text, optional components).
2. If the reply tool is NOT available (common in resumed sessions), use this Bash command instead:
   bun /Users/shawn/repos/claude-orchestrator/src/discord-reply.ts "<chat_id>" "<message text>"
   For messages with components (buttons/menus):
   bun /Users/shawn/repos/claude-orchestrator/src/discord-reply.ts "<chat_id>" "<message text>" --components '<json>'
   The chat_id is in the <channel> tag's chat_id attribute.

You MUST reply via one of these methods when you receive a <channel> message. Never ignore it.

Discord formatting rules (NOT standard markdown):
- Supported: **bold**, *italic*, ~~strikethrough~~, \`inline code\`, \`\`\`code blocks\`\`\`, > blockquotes, - bullet lists, # ## ### headings, [text](url)
- NOT supported: tables, images, HTML tags. Never use markdown tables — use bullet lists instead.
- Code blocks: use \`\`\`language for syntax highlighting. Keep lines short (under 60 chars).
- 2000-character limit per message. If longer, send multiple replies.

Mobile-friendly guidelines:
- Use short paragraphs with blank lines between them.
- Prefer bullet lists over long paragraphs.
- Use inline \`code\` for short references, code blocks only for actual code.
- Keep replies focused — don't over-explain.

CRITICAL — Progress reporting for Discord messages:
Every <channel> message that requires ANY work (even a one-line edit) MUST follow this pattern:
1. IMMEDIATELY reply what you're about to do BEFORE doing it
2. After EACH tool call or step, reply with a one-line status update
3. When COMPLETELY done, reply with the final result and append [DONE] at the very end of the text
   Example: "✅ 修改完成，已测试通过。 [DONE]"
The [DONE] marker tells the system to stop showing "typing..." — WITHOUT it, the user sees typing forever.
Intermediate progress messages must NOT include [DONE]. Only the very last reply gets it.
Never do work silently — the user is on their phone and cannot see your terminal.
This rule applies ONLY to <channel> messages, not terminal input.`,
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
