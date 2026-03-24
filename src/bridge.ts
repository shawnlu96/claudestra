/**
 * Discord Bridge Service
 *
 * 共享的 Discord 网关连接。多个 Claude Code channel-server 实例通过 WebSocket
 * 连接到此 bridge，每个注册一个 Discord 频道 ID。Bridge 负责路由消息。
 *
 * 架构：
 *   Discord (one bot, one gateway)
 *     ↕
 *   Bridge (this process, ws://localhost:BRIDGE_PORT)
 *     ↕ WebSocket
 *     ├── channel-server instance → Claude Code (master, #control)
 *     ├── channel-server instance → Claude Code (worker-alpha, #alpha)
 *     └── channel-server instance → Claude Code (worker-bravo, #bravo)
 */

import {
  Client,
  GatewayIntentBits,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type Message as DiscordMessage,
  type Interaction,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type { ServerWebSocket } from "bun";

// ============================================================
// 配置
// ============================================================

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "3847");
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "").split(",").filter(Boolean);

if (!DISCORD_TOKEN) {
  console.error("❌ 请设置 DISCORD_BOT_TOKEN");
  process.exit(1);
}

// ============================================================
// Typing Indicator 跟踪
// ============================================================

const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

function startTyping(channelId: string) {
  stopTyping(channelId);
  discord.channels.fetch(channelId).then((ch) => {
    if (ch && "sendTyping" in ch) (ch as TextChannel).sendTyping().catch(() => {});
  }).catch(() => {});
  const interval = setInterval(() => {
    discord.channels.fetch(channelId).then((ch) => {
      if (ch && "sendTyping" in ch) (ch as TextChannel).sendTyping().catch(() => {});
    }).catch(() => {});
  }, 8000);
  typingIntervals.set(channelId, interval);
  // 安全兜底：60 秒后停止
  setTimeout(() => stopTyping(channelId), 60000);
}

function stopTyping(channelId: string) {
  const interval = typingIntervals.get(channelId);
  if (interval) {
    clearInterval(interval);
    typingIntervals.delete(channelId);
  }
  const timeout = typingTimeouts.get(channelId);
  if (timeout) {
    clearTimeout(timeout);
    typingTimeouts.delete(channelId);
  }
}

const typingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

/** reply 后重新开始 typing，timeout 毫秒内没有新 reply 则停止 */
function restartTypingWithTimeout(channelId: string, timeout: number) {
  // 清掉旧的超时
  const oldTimeout = typingTimeouts.get(channelId);
  if (oldTimeout) clearTimeout(oldTimeout);

  // 确保 typing 在跑
  if (!typingIntervals.has(channelId)) {
    startTyping(channelId);
  }

  // 设置新超时
  typingTimeouts.set(channelId, setTimeout(() => {
    stopTyping(channelId);
  }, timeout));
}

// ============================================================
// 类型定义
// ============================================================

interface ClientInfo {
  ws: ServerWebSocket<unknown>;
  channelId: string;
  userId?: string;
}

// Client → Bridge
type ClientMessage =
  | { type: "register"; channelId: string; userId?: string }
  | { type: "reply"; requestId: string; chatId: string; text: string; replyTo?: string }
  | { type: "fetch_messages"; requestId: string; channel: string; limit?: number }
  | { type: "react"; requestId: string; chatId: string; messageId: string; emoji: string }
  | { type: "edit_message"; requestId: string; chatId: string; messageId: string; text: string }
  | { type: "create_channel"; requestId: string; name: string; category?: string }
  | { type: "delete_channel"; requestId: string; channelId: string };

// Bridge → Client
type BridgeMessage =
  | {
      type: "message";
      content: string;
      meta: {
        chat_id: string;
        message_id: string;
        user: string;
        user_id: string;
        ts: string;
      };
    }
  | { type: "response"; requestId: string; result?: unknown; error?: string }
  | { type: "registered"; channelId: string };

// ============================================================
// 状态
// ============================================================

// channelId → ClientInfo
const clients = new Map<string, ClientInfo>();
// 跟踪 bot 发送的消息 ID，避免自己触发自己
const recentBotMessageIds = new Set<string>();
let botUserId: string | null = null;

// ============================================================
// Discord Client
// ============================================================

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

discord.once("ready", () => {
  botUserId = discord.user?.id || null;
  console.log(`✅ Discord 已连接: ${discord.user?.tag}`);
  console.log(`📡 Bridge WebSocket: ws://localhost:${BRIDGE_PORT}`);
  console.log(`🔗 已注册频道: ${clients.size}`);
});

discord.on("messageCreate", async (msg: DiscordMessage) => {
  // 忽略 bot 自己的消息
  if (msg.author.bot) return;
  if (recentBotMessageIds.has(msg.id)) return;

  // 用户白名单检查
  if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(msg.author.id)) {
    return;
  }

  const channelId = msg.channelId;
  const client = clients.get(channelId);
  if (!client) return; // 没有注册此频道的 client

  // 清理 @mention 标记（如果有的话）
  let content = msg.content
    .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
    .trim();

  // 处理附件：下载到本地
  const attachmentPaths: string[] = [];
  if (msg.attachments.size > 0) {
    const inboxDir = `/tmp/claude-orchestrator/inbox`;
    await Bun.spawn(["mkdir", "-p", inboxDir]).exited;
    for (const [, att] of msg.attachments) {
      try {
        const resp = await fetch(att.url);
        const buf = await resp.arrayBuffer();
        const filePath = `${inboxDir}/${att.id}_${att.name}`;
        await Bun.write(filePath, buf);
        attachmentPaths.push(filePath);
      } catch (err) {
        console.error(`下载附件失败: ${att.name}`, err);
      }
    }
  }

  // 附件描述追加到内容
  if (attachmentPaths.length > 0) {
    const attDesc = attachmentPaths.map((p) => `[attachment: ${p}]`).join("\n");
    content = content ? `${content}\n\n${attDesc}` : attDesc;
  }

  if (!content) return;

  // 显示 "正在输入..."
  startTyping(channelId);

  // 发送给注册的 channel-server
  const meta: Record<string, string> = {
    chat_id: channelId,
    message_id: msg.id,
    user: msg.author.username,
    user_id: msg.author.id,
    ts: msg.createdAt.toISOString(),
  };
  if (attachmentPaths.length > 0) {
    meta.attachment_count = String(attachmentPaths.length);
    meta.attachments = attachmentPaths.join(";");
  }

  const payload: BridgeMessage = {
    type: "message",
    content,
    meta,
  };

  try {
    client.ws.send(JSON.stringify(payload));
  } catch (err) {
    console.error(`发送消息到 client (channel ${channelId}) 失败:`, err);
  }
});

// ============================================================
// 管理按钮 — 直接执行，不经过 LLM
// ============================================================

const MANAGER_PATH = `${import.meta.dir}/manager.ts`;

async function runManager(...args: string[]): Promise<any> {
  const proc = Bun.spawn(["bun", "run", MANAGER_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(out.trim());
  } catch {
    return { ok: false, error: out.trim() || "manager 执行失败" };
  }
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

async function handleMgmtButton(
  id: string,
  chatId: string
): Promise<{ text: string; components?: any[] } | null> {
  if (id === "list_workers") {
    const result = await runManager("list");
    if (!result.ok) return { text: `❌ ${result.error}` };
    const workers = result.workers || [];
    if (workers.length === 0) return {
      text: "📭 当前没有活跃的 worker。",
      components: [{ type: "buttons", buttons: [
        { id: "browse_sessions", label: "历史会话", emoji: "📋", style: "secondary" },
        { id: "create_worker", label: "新建 Worker", emoji: "➕", style: "success" },
      ]}],
    };
    const lines = workers.map((w: any) => {
      const status = w.status === "active" ? (w.idle ? "🟢 空闲" : "🔵 执行中") : "💀 已断开";
      return `**${w.name}** — ${status}\n📁 \`${w.project}\``;
    });
    const activeWorkers = workers.filter((w: any) => w.status === "active");
    const buttons: any[] = [];
    if (activeWorkers.length > 0) {
      buttons.push(
        { id: "restart_all", label: "全部重启", emoji: "🔄", style: "secondary" },
        { id: "show_kill_menu", label: "销毁 Worker", emoji: "🗑", style: "danger" },
      );
    }
    buttons.push(
      { id: "browse_sessions", label: "历史会话", emoji: "📋", style: "secondary" },
      { id: "create_worker", label: "新建 Worker", emoji: "➕", style: "success" },
    );
    return {
      text: "**📊 Worker 状态**\n\n" + lines.join("\n\n"),
      components: [{ type: "buttons", buttons }],
    };
  }

  if (id === "show_kill_menu") {
    const result = await runManager("list");
    if (!result.ok) return { text: `❌ ${result.error}` };
    const activeWorkers = (result.workers || []).filter((w: any) => w.status === "active");
    if (activeWorkers.length === 0) return { text: "📭 没有可销毁的 worker。" };
    return {
      text: "**🗑 选择要销毁的 Worker：**",
      components: [{
        type: "select",
        id: "kill_worker",
        placeholder: "选择 Worker",
        options: activeWorkers.map((w: any) => ({
          label: w.name,
          value: w.name.replace("worker-", ""),
        })),
      }],
    };
  }

  if (id === "restart_all") {
    const result = await runManager("restart");
    if (!result.ok) return { text: `❌ ${result.error || "重启失败"}` };
    const msg = (result.results || [])
      .map((r: any) => `${r.name}: ${r.ok ? "✅" : `❌ ${r.error}`}`)
      .join("\n");
    return {
      text: `**🔄 重启结果**\n\n${msg}`,
      components: [{ type: "buttons", buttons: [
        { id: "list_workers", label: "Worker 状态", emoji: "📊", style: "primary" },
      ]}],
    };
  }

  if (id === "browse_sessions") {
    const result = await runManager("sessions");
    if (!result.ok) return { text: `❌ ${result.error}` };
    const sessions = (result.sessions || []).slice(0, 15);
    if (sessions.length === 0) return { text: "📭 没有找到历史会话。" };
    const lines = sessions.map((s: any) =>
      `**${s.name}** — ${s.age}\n📁 \`${s.project}\`\n💬 ${s.lastMessage || "(无)"}`
    );
    const options = sessions.map((s: any) => ({
      label: s.name.slice(0, 100),
      value: s.sessionId,
      description: `${s.project} · ${s.age}`.slice(0, 100),
    }));
    return {
      text: "**📋 历史会话**\n\n" + lines.join("\n\n"),
      components: [{
        type: "select",
        id: "resume_session",
        placeholder: "📋 选择要恢复的会话",
        options,
      }],
    };
  }

  return null; // 未知按钮，交给 LLM
}

async function handleMgmtSelect(
  id: string,
  value: string,
  chatId: string
): Promise<{ text: string; components?: any[] } | null> {
  if (id === "kill_worker") {
    const result = await runManager("kill", value);
    if (!result.ok) return { text: `❌ ${result.error}` };
    return {
      text: `🗑️ \`${result.worker}\` 已销毁。`,
      components: [{ type: "buttons", buttons: [
        { id: "list_workers", label: "Worker 状态", emoji: "📊", style: "primary" },
        { id: "browse_sessions", label: "历史会话", emoji: "📋", style: "secondary" },
        { id: "create_worker", label: "新建 Worker", emoji: "➕", style: "success" },
      ]}],
    };
  }

  return null; // resume_session 和 create_worker 需要用户输入，交给 LLM
}

// 处理按钮点击和下拉菜单选择
discord.on("interactionCreate", async (interaction: Interaction) => {
  const channelId = interaction.channelId;
  if (!channelId) return;

  // 用户白名单
  if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(interaction.user.id)) {
    return;
  }

  if (interaction.isButton()) {
    const id = interaction.customId;
    await interaction.deferUpdate().catch(() => {});

    // 尝试直接处理管理按钮
    const mgmtResult = await handleMgmtButton(id, channelId);
    if (mgmtResult) {
      const components = mgmtResult.components ? buildComponents(mgmtResult.components) : undefined;
      const channel = await discord.channels.fetch(channelId) as TextChannel;
      await channel.send({ content: mgmtResult.text, components });
      return;
    }

    // 未知按钮 → 转发给 LLM
    const client = clients.get(channelId);
    if (!client) return;
    startTyping(channelId);
    client.ws.send(JSON.stringify({
      type: "message",
      content: `[button:${id}]`,
      meta: { chat_id: channelId, message_id: interaction.message?.id || "", user: interaction.user.username, user_id: interaction.user.id, ts: new Date().toISOString() },
    }));
    return;
  }

  if (interaction.isStringSelectMenu()) {
    const id = interaction.customId;
    const value = interaction.values[0];
    await interaction.deferUpdate().catch(() => {});

    // 尝试直接处理管理下拉菜单
    const mgmtResult = await handleMgmtSelect(id, value, channelId);
    if (mgmtResult) {
      const components = mgmtResult.components ? buildComponents(mgmtResult.components) : undefined;
      const channel = await discord.channels.fetch(channelId) as TextChannel;
      await channel.send({ content: mgmtResult.text, components });
      return;
    }

    // 未知菜单 → 转发给 LLM
    const client = clients.get(channelId);
    if (!client) return;
    startTyping(channelId);
    client.ws.send(JSON.stringify({
      type: "message",
      content: `[select:${id}:${value}]`,
      meta: { chat_id: channelId, message_id: interaction.message?.id || "", user: interaction.user.username, user_id: interaction.user.id, ts: new Date().toISOString() },
    }));
    return;
  }
});

// ============================================================
// Discord API 操作
// ============================================================

/** 构建 discord.js 组件 */
function buildComponents(
  components: any[]
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];

  for (const comp of components) {
    if (comp.type === "buttons") {
      const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
      for (const btn of comp.buttons || []) {
        const style =
          btn.style === "primary" ? ButtonStyle.Primary :
          btn.style === "danger" ? ButtonStyle.Danger :
          btn.style === "success" ? ButtonStyle.Success :
          ButtonStyle.Secondary;
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(btn.id)
            .setLabel(btn.label)
            .setStyle(style)
            .setEmoji(btn.emoji || null)
        );
      }
      rows.push(row);
    } else if (comp.type === "select") {
      const row = new ActionRowBuilder<MessageActionRowComponentBuilder>();
      const menu = new StringSelectMenuBuilder()
        .setCustomId(comp.id)
        .setPlaceholder(comp.placeholder || "选择...");
      for (const opt of comp.options || []) {
        menu.addOptions({
          label: opt.label,
          value: opt.value,
          description: opt.description,
        });
      }
      row.addComponents(menu);
      rows.push(row);
    }
  }

  return rows;
}

async function discordReply(
  chatId: string,
  text: string,
  replyTo?: string,
  components?: any[]
): Promise<string[]> {
  const channel = await discord.channels.fetch(chatId);
  if (!channel || !("send" in channel)) {
    throw new Error(`频道 ${chatId} 不存在或无法发送消息`);
  }

  const textChannel = channel as TextChannel;
  const messageIds: string[] = [];
  const discordComponents = components ? buildComponents(components) : undefined;

  // Discord 2000 字符限制，分块发送
  const chunks = chunkText(text, 2000);

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const options: any = { content: chunks[i] };
    // 只有第一块回复原消息
    if (i === 0 && replyTo) {
      options.reply = { messageId: replyTo };
    }
    // 只有最后一块带组件
    if (isLast && discordComponents?.length) {
      options.components = discordComponents;
    }
    const sent = await textChannel.send(options);
    messageIds.push(sent.id);
    recentBotMessageIds.add(sent.id);
    if (recentBotMessageIds.size > 200) {
      const first = recentBotMessageIds.values().next().value;
      if (first) recentBotMessageIds.delete(first);
    }
  }

  return messageIds;
}

async function discordFetchMessages(
  channelId: string,
  limit: number = 20
): Promise<string> {
  const channel = await discord.channels.fetch(channelId);
  if (!channel || !("messages" in channel)) {
    throw new Error(`频道 ${channelId} 不存在`);
  }

  const textChannel = channel as TextChannel;
  const messages = await textChannel.messages.fetch({ limit: Math.min(limit, 100) });

  // 按时间正序
  const sorted = [...messages.values()].reverse();
  const lines = sorted.map((m) => {
    const tag = m.author.bot ? "[bot]" : "";
    return `[${m.id}] ${m.author.username}${tag}: ${m.content}`;
  });

  return lines.join("\n");
}

async function discordReact(
  chatId: string,
  messageId: string,
  emoji: string
): Promise<void> {
  const channel = await discord.channels.fetch(chatId);
  if (!channel || !("messages" in channel)) throw new Error("频道不存在");
  const msg = await (channel as TextChannel).messages.fetch(messageId);
  await msg.react(emoji);
}

async function discordEditMessage(
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

async function discordCreateChannel(
  name: string,
  categoryName?: string
): Promise<string> {
  const guild = discord.guilds.cache.first();
  if (!guild) throw new Error("Bot 未加入任何 server");

  let parentId: string | undefined;
  if (categoryName) {
    const cat = guild.channels.cache.find(
      (c) => c.name === categoryName && c.type === 4
    );
    parentId = cat?.id;
  }

  const ch = await guild.channels.create({
    name,
    parent: parentId,
    topic: `Claude Code worker channel`,
  });
  return ch.id;
}

async function discordDeleteChannel(channelId: string): Promise<void> {
  const channel = await discord.channels.fetch(channelId);
  if (channel && "delete" in channel) {
    await (channel as TextChannel).delete();
  }
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

// ============================================================
// WebSocket Server — channel-server 实例连接到这里
// ============================================================

async function handleClientMessage(
  ws: ServerWebSocket<unknown>,
  raw: string
) {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  switch (msg.type) {
    case "register": {
      // 注册 channel → client 映射
      const old = clients.get(msg.channelId);
      if (old && old.ws !== ws) {
        // 旧连接被新连接替换
        console.log(`🔄 频道 ${msg.channelId} 重新注册`);
      }
      clients.set(msg.channelId, {
        ws,
        channelId: msg.channelId,
        userId: msg.userId,
      });
      console.log(`📌 注册频道: ${msg.channelId} (共 ${clients.size} 个)`);
      ws.send(JSON.stringify({ type: "registered", channelId: msg.channelId }));
      break;
    }

    case "reply": {
      try {
        // 检测 [DONE] 标记：任务完成，立即停止 typing
        const isDone = msg.text?.endsWith("[DONE]");
        const text = isDone ? msg.text.replace(/\s*\[DONE\]\s*$/, "") : msg.text;
        if (isDone) {
          stopTyping(msg.chatId);
        } else {
          restartTypingWithTimeout(msg.chatId, 180_000);
        }
        const ids = await discordReply(msg.chatId, text, msg.replyTo, msg.components);
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            result: { messageIds: ids },
          })
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            error: (err as Error).message,
          })
        );
      }
      break;
    }

    case "fetch_messages": {
      try {
        const result = await discordFetchMessages(msg.channel, msg.limit);
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            result,
          })
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            error: (err as Error).message,
          })
        );
      }
      break;
    }

    case "react": {
      try {
        await discordReact(msg.chatId, msg.messageId, msg.emoji);
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            result: { ok: true },
          })
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            error: (err as Error).message,
          })
        );
      }
      break;
    }

    case "edit_message": {
      try {
        await discordEditMessage(msg.chatId, msg.messageId, msg.text);
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            result: { ok: true },
          })
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            error: (err as Error).message,
          })
        );
      }
      break;
    }

    case "create_channel": {
      try {
        const channelId = await discordCreateChannel(
          msg.name,
          msg.category
        );
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            result: { channelId },
          })
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            error: (err as Error).message,
          })
        );
      }
      break;
    }

    case "delete_channel": {
      try {
        await discordDeleteChannel(msg.channelId);
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            result: { ok: true },
          })
        );
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            error: (err as Error).message,
          })
        );
      }
      break;
    }
  }
}

// ============================================================
// 启动
// ============================================================

const server = Bun.serve({
  port: BRIDGE_PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("Claude Orchestrator Bridge", { status: 200 });
  },
  websocket: {
    open(ws) {
      console.log("🔌 新的 channel-server 连接");
    },
    message(ws, message) {
      handleClientMessage(ws, typeof message === "string" ? message : new TextDecoder().decode(message));
    },
    close(ws) {
      // 清理断开连接的 client
      for (const [channelId, info] of clients.entries()) {
        if (info.ws === ws) {
          clients.delete(channelId);
          console.log(`🔌 断开: 频道 ${channelId} (剩余 ${clients.size} 个)`);
        }
      }
    },
  },
});

console.log(`🚀 Bridge WebSocket 启动: ws://localhost:${BRIDGE_PORT}`);

// 连接 Discord
discord.login(DISCORD_TOKEN);
