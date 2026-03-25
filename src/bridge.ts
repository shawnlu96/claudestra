/**
 * Discord Bridge Service — 主入口
 *
 * 共享的 Discord 网关连接。多个 Claude Code channel-server 实例通过 WebSocket
 * 连接到此 bridge，每个注册一个 Discord 频道 ID。Bridge 负责路由消息。
 */

import {
  Client,
  GatewayIntentBits,
  TextChannel,
  REST,
  Routes,
  SlashCommandBuilder,
  type Message as DiscordMessage,
  type Interaction,
} from "discord.js";
import type { ServerWebSocket } from "bun";

import { DISCORD_TOKEN, BRIDGE_PORT, ALLOWED_USER_IDS, TMUX_SOCK, TMP_DIR } from "./bridge/config.js";
import {
  startTyping,
  stopTyping,
  ensureTyping,
  buildComponents,
} from "./bridge/components.js";
import {
  setBotUserId,
  getBotUserId,
  isBotMessage,
  trackSentMessage,
  discordReply,
  discordFetchMessages,
  discordReact,
  discordEditMessage,
  discordCreateChannel,
  discordDeleteChannel,
} from "./bridge/discord-api.js";
import {
  runManager,
  buildStatusPanel,
  handleMgmtButton,
  handleMgmtSelect,
} from "./bridge/management.js";
import { tmuxScreenshot } from "./bridge/screenshot.js";
import { startWatching, stopWatching } from "./bridge/jsonl-watcher.js";

// ============================================================
// 类型定义
// ============================================================

interface ClientInfo {
  ws: ServerWebSocket<unknown>;
  channelId: string;
  userId?: string;
}

// ============================================================
// 状态
// ============================================================

const clients = new Map<string, ClientInfo>();
const activeStatusMessages = new Map<string, string>();

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

discord.once("ready", async () => {
  setBotUserId(discord.user?.id || "");
  console.log(`✅ Discord 已连接: ${discord.user?.tag}`);
  console.log(`📡 Bridge WebSocket: ws://localhost:${BRIDGE_PORT}`);
  console.log(`🔗 已注册频道: ${clients.size}`);

  // 注册 Slash Commands
  try {
    const rest = new REST().setToken(DISCORD_TOKEN);
    const commands = [
      new SlashCommandBuilder().setName("screenshot").setDescription("截取当前 agent 的终端画面"),
      new SlashCommandBuilder().setName("interrupt").setDescription("打断当前 agent 的操作 (Ctrl+C)"),
      new SlashCommandBuilder().setName("status").setDescription("查看所有 agent 的状态"),
    ].map((c) => c.toJSON());
    await rest.put(Routes.applicationCommands(discord.user!.id), { body: commands });
    console.log("📝 Slash Commands 已注册");
  } catch (err) {
    console.error("Slash Commands 注册失败:", err);
  }
});

// ============================================================
// 入站消息处理
// ============================================================

discord.on("messageCreate", async (msg: DiscordMessage) => {
  if (msg.author.bot) return;
  if (isBotMessage(msg.id)) return;

  if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(msg.author.id)) {
    return;
  }

  const channelId = msg.channelId;
  const client = clients.get(channelId);
  if (!client) return;

  let content = msg.content
    .replace(new RegExp(`<@!?${getBotUserId()}>`, "g"), "")
    .trim();

  // 处理附件
  const attachmentPaths: string[] = [];
  if (msg.attachments.size > 0) {
    const inboxDir = `${TMP_DIR}/inbox`;
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

  if (attachmentPaths.length > 0) {
    const attDesc = attachmentPaths.map((p) => `[attachment: ${p}]`).join("\n");
    content = content ? `${content}\n\n${attDesc}` : attDesc;
  }

  if (!content) return;

  // 显示 typing + 发送打断按钮
  startTyping(channelId, discord);
  const statusMsg = await (msg.channel as TextChannel).send({
    content: "💭 大聪明思考中...",
    components: buildComponents([{
      type: "buttons",
      buttons: [{ id: `interrupt:${channelId}`, label: "打断", emoji: "⚡", style: "danger" }],
    }]),
  });
  trackSentMessage(statusMsg.id);
  activeStatusMessages.set(channelId, statusMsg.id);

  // 转发给 channel-server
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

  try {
    client.ws.send(JSON.stringify({ type: "message", content, meta }));
  } catch (err) {
    console.error(`发送消息到 client (channel ${channelId}) 失败:`, err);
  }
});

// ============================================================
// Interaction 处理（按钮、菜单、Slash Commands）
// ============================================================

discord.on("interactionCreate", async (interaction: Interaction) => {
  try {
    const channelId = interaction.channelId;
    if (!channelId) return;

    if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(interaction.user.id)) {
      return;
    }

    // ── Slash Commands ──
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      if (cmd === "screenshot") {
        await interaction.deferReply();
        const listResult = await runManager("list");
        const worker = (listResult.workers || []).find((w: any) => w.channelId === channelId);
        const windowName = worker ? worker.name : "master";
        const pngPath = await tmuxScreenshot(windowName);
        if (pngPath) {
          await interaction.editReply({ content: "**📸 终端截图**", files: [{ attachment: pngPath }] });
        } else {
          await interaction.editReply("❌ 截图失败");
        }
        return;
      }

      if (cmd === "interrupt") {
        const listResult = await runManager("list");
        const worker = (listResult.workers || []).find((w: any) => w.channelId === channelId);
        if (worker) {
          Bun.spawn(["tmux", "-S", TMUX_SOCK, "send-keys", "-t", `master:${worker.name}`, "C-c"]);
          stopTyping(channelId);
          const statusMsgId = activeStatusMessages.get(channelId);
          if (statusMsgId) {
            try {
              const ch = await discord.channels.fetch(channelId) as TextChannel;
              const sm = await ch.messages.fetch(statusMsgId);
              await sm.edit({ content: "⚡ 已打断", components: [] });
            } catch { /* non-critical */ }
            activeStatusMessages.delete(channelId);
          }
          await interaction.reply("⚡ 已发送 Ctrl+C");
        } else {
          await interaction.reply("⚠️ 当前频道没有关联的 agent");
        }
        return;
      }

      if (cmd === "status") {
        await interaction.deferReply();
        const panel = await buildStatusPanel();
        const components = panel.components ? buildComponents(panel.components) : undefined;
        await interaction.editReply({ content: panel.text, components });
        return;
      }

      return;
    }

    // ── Buttons ──
    if (interaction.isButton()) {
      const id = interaction.customId;
      await interaction.deferUpdate().catch(async () => {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
      });

      // 打断按钮
      if (id.startsWith("interrupt:")) {
        const targetChannelId = id.slice("interrupt:".length);
        const listResult = await runManager("list");
        try {
          const worker = (listResult.workers || []).find((w: any) => w.channelId === targetChannelId);
          if (worker) {
            Bun.spawn(["tmux", "-S", TMUX_SOCK, "send-keys", "-t", `master:${worker.name}`, "C-c"]);
            const statusMsgId = activeStatusMessages.get(targetChannelId);
            if (statusMsgId) {
              try {
                const ch = await discord.channels.fetch(targetChannelId) as TextChannel;
                const sm = await ch.messages.fetch(statusMsgId);
                await sm.edit({ content: "⚡ 已打断", components: [] });
              } catch { /* non-critical */ }
              activeStatusMessages.delete(targetChannelId);
            }
            stopTyping(targetChannelId);
          }
        } catch { /* non-critical */ }
        return;
      }

      // 管理按钮
      const mgmtResult = await handleMgmtButton(id, channelId, interaction.message?.id, discord);
      if (mgmtResult) {
        if (mgmtResult.text !== "__HANDLED__") {
          const components = mgmtResult.components ? buildComponents(mgmtResult.components) : undefined;
          const channel = await discord.channels.fetch(channelId) as TextChannel;
          await channel.send({ content: mgmtResult.text, components });
        }
        return;
      }

      // 未知按钮 → 转发给 LLM
      const client = clients.get(channelId);
      if (!client) return;
      startTyping(channelId, discord);
      client.ws.send(JSON.stringify({
        type: "message",
        content: `[button:${id}]`,
        meta: { chat_id: channelId, message_id: interaction.message?.id || "", user: interaction.user.username, user_id: interaction.user.id, ts: new Date().toISOString() },
      }));
      return;
    }

    // ── Select Menus ──
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      const value = interaction.values[0];
      await interaction.deferUpdate().catch(() => {});

      const mgmtResult = await handleMgmtSelect(id, value, channelId, discord);
      if (mgmtResult) {
        if (mgmtResult.text !== "__HANDLED__") {
          const components = mgmtResult.components ? buildComponents(mgmtResult.components) : undefined;
          const channel = await discord.channels.fetch(channelId) as TextChannel;
          await channel.send({ content: mgmtResult.text, components });
        }
        return;
      }

      // 未知菜单 → 转发给 LLM
      const client = clients.get(channelId);
      if (!client) return;
      startTyping(channelId, discord);
      client.ws.send(JSON.stringify({
        type: "message",
        content: `[select:${id}:${value}]`,
        meta: { chat_id: channelId, message_id: interaction.message?.id || "", user: interaction.user.username, user_id: interaction.user.id, ts: new Date().toISOString() },
      }));
      return;
    }
  } catch (err) {
    console.error("❌ Interaction error:", err);
  }
});

// ============================================================
// WebSocket Server — channel-server 实例连接
// ============================================================

async function handleClientMessage(ws: ServerWebSocket<unknown>, raw: string) {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  switch (msg.type) {
    case "register": {
      const old = clients.get(msg.channelId);
      if (old && old.ws !== ws) {
        console.log(`🔄 频道 ${msg.channelId} 重新注册`);
      }
      clients.set(msg.channelId, { ws, channelId: msg.channelId, userId: msg.userId });
      console.log(`📌 注册频道: ${msg.channelId} (共 ${clients.size} 个)`);
      ws.send(JSON.stringify({ type: "registered", channelId: msg.channelId }));

      // 启动 JSONL watcher（从 registry 查 sessionId 和 cwd）
      try {
        const regResult = await runManager("list");
        const worker = (regResult.workers || []).find((w: any) => w.channelId === msg.channelId);
        if (worker?.sessionId && worker?.project) {
          const cwd = worker.project.replace(/^~/, process.env.HOME || "~");
          startWatching(worker.name, cwd, worker.sessionId, msg.channelId, discord);
        }
      } catch { /* non-critical */ }

      break;
    }

    case "reply": {
      try {
        const isDone = msg.text?.endsWith("[DONE]");
        const text = isDone ? msg.text.replace(/\s*\[DONE\]\s*$/, "") : msg.text;
        if (isDone) {
          stopTyping(msg.chatId);
          const statusMsgId = activeStatusMessages.get(msg.chatId);
          if (statusMsgId) {
            try {
              const ch = await discord.channels.fetch(msg.chatId) as TextChannel;
              const sm = await ch.messages.fetch(statusMsgId);
              await sm.edit({ content: "✅ 完成", components: [] });
            } catch { /* non-critical */ }
            activeStatusMessages.delete(msg.chatId);
          }
        } else {
          ensureTyping(msg.chatId, discord);
        }
        const ids = await discordReply(discord, msg.chatId, text, msg.replyTo, msg.components, msg.files);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { messageIds: ids } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "fetch_messages": {
      try {
        const result = await discordFetchMessages(discord, msg.channel, msg.limit);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "react": {
      try {
        await discordReact(discord, msg.chatId, msg.messageId, msg.emoji);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "edit_message": {
      try {
        await discordEditMessage(discord, msg.chatId, msg.messageId, msg.text);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "create_channel": {
      try {
        const channelId = await discordCreateChannel(discord, msg.name, msg.category);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { channelId } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "delete_channel": {
      try {
        await discordDeleteChannel(discord, msg.channelId);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
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
      for (const [channelId, info] of clients.entries()) {
        if (info.ws === ws) {
          clients.delete(channelId);
          // 查找并停止对应的 JSONL watcher
          runManager("list").then((r) => {
            const worker = (r.workers || []).find((w: any) => w.channelId === channelId);
            if (worker) stopWatching(worker.name);
          }).catch(() => {});
          console.log(`🔌 断开: 频道 ${channelId} (剩余 ${clients.size} 个)`);
        }
      }
    },
  },
});

console.log(`🚀 Bridge WebSocket 启动: ws://localhost:${BRIDGE_PORT}`);

if (!DISCORD_TOKEN) {
  console.error("❌ 请设置 DISCORD_BOT_TOKEN");
  process.exit(1);
}

discord.login(DISCORD_TOKEN);
