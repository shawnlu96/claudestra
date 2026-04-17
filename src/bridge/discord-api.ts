/**
 * Discord API 操作：发消息、获取历史、反应、编辑、创建/删除频道
 */

import { TextChannel, type Client } from "discord.js";
import { buildComponents } from "./components.js";

let botUserId: string | null = null;
const recentBotMessageIds = new Set<string>();

export function setBotUserId(id: string) {
  botUserId = id;
}

export function getBotUserId() {
  return botUserId;
}

export function trackSentMessage(id: string) {
  recentBotMessageIds.add(id);
  if (recentBotMessageIds.size > 200) {
    const first = recentBotMessageIds.values().next().value;
    if (first) recentBotMessageIds.delete(first);
  }
}

export function isBotMessage(id: string) {
  return recentBotMessageIds.has(id);
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";
  for (const line of lines) {
    if ((current + "\n" + line).length > limit) {
      if (current) chunks.push(current);
      current = line.length > limit ? line.slice(0, limit) : line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function discordReply(
  discord: Client,
  chatId: string,
  text: string,
  replyTo?: string,
  components?: any[],
  files?: string[]
): Promise<string[]> {
  const channel = await discord.channels.fetch(chatId);
  if (!channel || !("send" in channel)) {
    throw new Error(`频道 ${chatId} 不存在或无法发送消息`);
  }

  const textChannel = channel as TextChannel;
  const messageIds: string[] = [];
  const discordComponents = components
    ? buildComponents(components)
    : undefined;

  const chunks = chunkText(text, 2000);

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const options: any = { content: chunks[i] };
    if (i === 0 && replyTo) {
      options.reply = { messageId: replyTo };
    }
    if (isLast && discordComponents?.length) {
      options.components = discordComponents;
    }
    if (isLast && files?.length) {
      options.files = files.map((f) => ({ attachment: f }));
    }
    const sent = await textChannel.send(options);
    messageIds.push(sent.id);
    trackSentMessage(sent.id);
  }

  return messageIds;
}

export async function discordFetchMessages(
  discord: Client,
  channelId: string,
  limit: number = 20
): Promise<string> {
  const channel = await discord.channels.fetch(channelId);
  if (!channel || !("messages" in channel)) {
    throw new Error(`频道 ${channelId} 不存在`);
  }

  const textChannel = channel as TextChannel;
  const messages = await textChannel.messages.fetch({
    limit: Math.min(limit, 100),
  });

  const sorted = [...messages.values()].reverse();
  const lines = sorted.map((m) => {
    const tag = m.author.bot ? "[bot]" : "";
    return `[${m.id}] ${m.author.username}${tag}: ${m.content}`;
  });

  return lines.join("\n");
}

export async function discordReact(
  discord: Client,
  chatId: string,
  messageId: string,
  emoji: string
): Promise<void> {
  const channel = await discord.channels.fetch(chatId);
  if (!channel || !("messages" in channel)) throw new Error("频道不存在");
  const msg = await (channel as TextChannel).messages.fetch(messageId);
  await msg.react(emoji);
}

export async function discordEditMessage(
  discord: Client,
  chatId: string,
  messageId: string,
  text: string
): Promise<void> {
  const channel = await discord.channels.fetch(chatId);
  if (!channel || !("messages" in channel)) throw new Error("频道不存在");
  const msg = await (channel as TextChannel).messages.fetch(messageId);
  if (msg.author.id !== botUserId) throw new Error("只能编辑 bot 自己的消息");
  await msg.edit(text);
}

export async function discordCreateChannel(
  discord: Client,
  name: string,
  categoryName?: string
): Promise<string> {
  const guild = discord.guilds.cache.first();
  if (!guild) throw new Error("Bot 未加入任何 server");

  let parentId: string | undefined;
  if (categoryName) {
    let cat = guild.channels.cache.find(
      (c) => c.name === categoryName && c.type === 4
    );
    if (!cat) {
      // category 不存在，自动创建
      cat = await guild.channels.create({
        name: categoryName,
        type: 4, // GuildCategory
      });
    }
    parentId = cat?.id;
  }

  const ch = await guild.channels.create({
    name,
    parent: parentId,
    topic: `Claude Code agent channel`,
  });
  return ch.id;
}

export async function discordDeleteChannel(
  discord: Client,
  channelId: string
): Promise<void> {
  const channel = await discord.channels.fetch(channelId);
  if (channel && "delete" in channel) {
    await (channel as TextChannel).delete();
  }
}
