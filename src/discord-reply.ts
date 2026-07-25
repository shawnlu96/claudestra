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
  console.error("usage: bun discord-reply.ts <channel_id> <message>");
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

// 本进程不是注册过的 channel-server，bridge 无法从 ws 反查「这条回复是谁发的」。
// 没有这个身份，回复会被投到一个匿名来源上：等待中的 HTTP 请求匹配不到、SSE 事件
// 里的 agent 变成字面的 "?"，于是 web 端既不显示也不结束等待 —— 而调用方还收到
// 一个成功的空结果。2026-07-25 就是这样丢了一整条带按钮的消息。
// DISCORD_CHANNEL_ID 由 Claude Code 注入 agent 进程并被子进程继承，正好是身份来源。
const fromChannelId = process.env.DISCORD_CHANNEL_ID || "";

try {
  const result = await bridgeRequest({
    type: "reply",
    chatId,
    text,
    replyTo,
    components,
    fromChannelId,
  });
  console.log(JSON.stringify(result));
} catch (err) {
  console.error(`发送失败: ${(err as Error).message}`);
  if (!fromChannelId) {
    console.error(
      "提示: 没有 DISCORD_CHANNEL_ID 环境变量，bridge 认不出这条回复来自哪个 agent。\n" +
        "      在 agent 自己的会话里跑本命令，或显式 DISCORD_CHANNEL_ID=<频道id> 再跑。",
    );
  }
  process.exit(1);
}
