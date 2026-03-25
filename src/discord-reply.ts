#!/usr/bin/env bun
/**
 * Discord Reply CLI — 通过 Bridge 发送消息到 Discord
 *
 * 用法:
 *   bun src/discord-reply.ts <channel_id> <message>
 *   bun src/discord-reply.ts <channel_id> <message> --reply-to <message_id>
 *   bun src/discord-reply.ts <channel_id> <message> --components '<json>'
 */

import { bridgeRequest } from "./lib/bridge-client.js";

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

try {
  const result = await bridgeRequest({
    type: "reply",
    chatId,
    text,
    replyTo,
    components,
  });
  console.log(JSON.stringify(result));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
