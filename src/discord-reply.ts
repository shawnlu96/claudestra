#!/usr/bin/env bun
/**
 * Discord Reply CLI — 通过 Bridge 发送消息到 Discord
 *
 * 用法:
 *   bun src/discord-reply.ts <channel_id> <message>
 *   bun src/discord-reply.ts <channel_id> <message> --reply-to <message_id>
 *   bun src/discord-reply.ts <channel_id> <message> --components '<json>'
 *
 * 当 MCP reply tool 不可用时（如 resumed session），用此脚本代替。
 */

const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:3847";

const args = process.argv.slice(2);
const chatId = args[0];
const text = args[1];

if (!chatId || !text) {
  console.error("用法: bun discord-reply.ts <channel_id> <message>");
  process.exit(1);
}

let replyTo: string | undefined;
let components: any[] | undefined;

for (let i = 2; i < args.length; i++) {
  if (args[i] === "--reply-to" && args[i + 1]) {
    replyTo = args[++i];
  } else if (args[i] === "--components" && args[i + 1]) {
    try {
      components = JSON.parse(args[++i]);
    } catch {
      console.error("--components JSON 解析失败");
      process.exit(1);
    }
  }
}

const ws = new WebSocket(BRIDGE_URL);
const requestId = `reply_${Date.now()}`;

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: "reply",
    requestId,
    chatId,
    text,
    replyTo,
    components,
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(typeof event.data === "string" ? event.data : "");
  if (data.requestId === requestId) {
    if (data.error) {
      console.error("发送失败:", data.error);
      process.exit(1);
    } else {
      console.log(JSON.stringify(data.result));
    }
    ws.close();
    process.exit(0);
  }
};

ws.onerror = () => {
  console.error("无法连接 Bridge");
  process.exit(1);
};

setTimeout(() => {
  console.error("超时");
  process.exit(1);
}, 10000);
