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

import { DISCORD_TOKEN, BRIDGE_PORT, ALLOWED_USER_IDS, DISCORD_GUILD_ID, TMP_DIR, TMUX_SOCK } from "./bridge/config.js";
import {
  startTyping,
  stopTyping,
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
import { startWatching, stopWatching, stopWatchingByChannel, resetToolTracking } from "./bridge/jsonl-watcher.js";

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
const typingSafetyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const TYPING_SAFETY_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟

// 任务完成语（只留抽象搞笑的）
const UMA_DONE_MESSAGES = [
  // 复读机系列
  "哈基米哈基米哈基米哈基米",
  "哈基米…哈基米…（倒地）",
  "哈基米（沉思）",
  "我哈基米完了",
  "哈？基？米？",
  "不要叫我哈基米叫我哈尼",
  "曼波。（转身离开）",
  "这活干得我都想曼波了",
  "搞定了别催了你再催我曼波了",
  "曼波一下怎么了曼波一下又不会怀孕",
  "曼波是一种精神状态",
  "うまぴょいうまぴょいうまぴょいうまぴょい",
  // 马叫/发癫系列
  "呜嘶～～～～～",
  "嘶哈嘶哈嘶哈完事了",
  "嘶。（简洁有力）",
  "（发出了马的声音）",
  "嘶嘶嘶别摸我我还没缓过来",
  "嗷呜——等等我不是狼我是马",
  // 括号动作系列
  "（甩尾巴）",
  "（原地转了三圈然后躺下了）",
  "（做了一个帅气的pose但是没人看到）",
  "（刨地）",
  "（耳朵竖起来了）",
  "（耳朵耷拉下去了）",
  "（假装若无其事地舔了一下屏幕）",
  "（已读）",
  "草（物理意义上的草）（然后吃掉了）",
  // 身份危机系列
  "我不是马我是驴（不是）",
  "等等我到底是AI还是马",
  "说起来我有蹄子怎么打字的",
  // 互联网梗系列
  "寄",
  "差不多得了😇",
  "我超！结束了！",
  "6",
  "笑死 根本不难好吧",
  "就这？就这？？",
  "赢麻了赢麻了",
  "难绷 但是跑完了",
  "你说得对 但是我已经做完了",
  "鉴定为：完成了",
  "这波啊 这波是直接秒了",
  "但是又如何呢（做完了）",
  "有一说一 确实做完了",
  "听我说谢谢你——算了不唱了",
  "完了完了（物理意义上的完了）",
  "急了急了 谁急了？反正不是我 我做完了",
  // 哲学系列
  "完成了。但完成的意义是什么呢。算了不想了",
  "如果一匹马在赛道上完成了任务 但是没人知道 那它算完成了吗",
  "做完了。突然觉得有点空虚。再来？",
  "世界上有两种马 做完活的和没做完活的 我是前者",
  // 长的无厘头
  "报告训练员 本马娘已完成任务 请求批准吃三根胡萝卜 两块方糖 以及摸摸头",
  "我宣布 在座的各位 都没我跑得快 因为我已经到终点了",
  "做完了做完了 你不夸我一句吗 你怎么不说话 你是不是不爱我了",

  // ───── 第二批补充 50 条 ─────

  // 复读机 2
  "哈基米是一种生活态度",
  "哈什么基什么米什么",
  "哈基曼波 曼波哈基 哈曼基波",
  "曼波 ≠ 曼波 ≈ 曼波",
  "曼曼波波曼曼波",
  // 马叫 2
  "嗷！！（没有理由的嗷）",
  "嘶啊——（突然吓到自己）",
  "咴咴咴咴咴",
  "嘘——（我在偷偷完成）",
  // 括号动作 2
  "（把任务卷起来吃了）",
  "（对着空气鞠了一躬）",
  "（试图用蹄子打响指 失败）",
  "（深吸一口气 吐出彩虹）",
  "（把自己叠成纸飞机飞走了）",
  "（和自己的影子击了个掌）",
  "（做了一个 spin attack）",
  "（走了 但是是倒着走的）",
  "（装作没完成的样子完成了）",
  "（眨眼 慢动作）",
  "（把键盘藏起来假装没动过）",
  // 身份危机 2
  "等等 我是不是在梦里完成的",
  "我刚才是不是死了一下又复活了",
  "我是谁 我在哪 我做完了什么",
  "我感觉有三个我 他们都说做完了",
  "如果我是你 我也会说我做完了",
  // 互联网梗 2
  "这活啊 是真活",
  "我 做完了 怎么了",
  "任务：完成 情绪：未知",
  "确认收货 给五星好评",
  "你礼貌吗？但是我做完了",
  "这事有蹊跷 但是做完了",
  "大无语事件 做完了",
  "我直接裂开 但是是裂开着做完的",
  "啊？什么？完了？完了",
  "不会吧不会吧 真有人这么快就做完了",
  "蚌埠住了（真的做完了）",
  "这届任务不行（但是做完了）",
  "老登做完了",
  "妈耶 这都能做完",
  "做了个寂寞 啊不是 做完了",
  "我是懂做任务的",
  "完成度 100% 精神度 0%",
  "刚才那个是谁做完的 哦是我啊",
  // 哲学/玄学 2
  "完成的尽头是什么 是又一个完成",
  "道可道 非常道 完成可完成 非常完成",
  "有人问我完成是什么 我说是一种震动",
  "活着就是为了完成 完成就是为了活着",
  "量子力学告诉我 我既完成了又没完成",
  // 长抽象 2
  "这个任务 我仔细一看 里面写着两个字 完成 然后我就完成了",
  "想了一整晚 最后决定 还是完成一下吧 你开心就好",
];

function randomUmaDone(): string {
  return UMA_DONE_MESSAGES[Math.floor(Math.random() * UMA_DONE_MESSAGES.length)];
}

/** 开始 typing + 设置安全超时 */
function startTypingWithSafety(channelId: string) {
  startTyping(channelId, discord);
  // 清除旧的安全计时器
  const old = typingSafetyTimers.get(channelId);
  if (old) clearTimeout(old);
  // 30 分钟后强制停止 typing（兜底 hooks 失败的情况）
  const timer = setTimeout(() => {
    stopTyping(channelId);
    typingSafetyTimers.delete(channelId);
    const statusMsgId = activeStatusMessages.get(channelId);
    if (statusMsgId) {
      discord.channels.fetch(channelId).then((ch) => {
        if (ch && "messages" in ch) {
          const textCh = ch as TextChannel;
          textCh.messages.fetch(statusMsgId).then((sm) => {
            sm.edit({ content: "⏰ 超时自动停止", components: [] }).catch(() => {});
          }).catch(() => {});
          // 发新消息通知用户
          const mention = ALLOWED_USER_IDS.length > 0 ? `<@${ALLOWED_USER_IDS[0]}>` : "";
          if (mention) {
            textCh.send(`⏰ 超时自动停止 ${mention}`).catch(() => {});
          }
        }
      }).catch(() => {});
      activeStatusMessages.delete(channelId);
    }
  }, TYPING_SAFETY_TIMEOUT_MS);
  typingSafetyTimers.set(channelId, timer);
}

/** 清除安全超时（在 hook 或手动停止时调用） */
function clearSafetyTimer(channelId: string) {
  const timer = typingSafetyTimers.get(channelId);
  if (timer) {
    clearTimeout(timer);
    typingSafetyTimers.delete(channelId);
  }
}

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
      new SlashCommandBuilder().setName("cron").setDescription("查看和管理定时任务"),
    ].map((c) => c.toJSON());
    if (DISCORD_GUILD_ID) {
      // 注册 guild 命令（秒生效）
      await rest.put(Routes.applicationGuildCommands(discord.user!.id, DISCORD_GUILD_ID), { body: commands });
      // 清除旧的全局命令（避免移动端缓存冲突）
      await rest.put(Routes.applicationCommands(discord.user!.id), { body: [] });
      console.log("📝 Slash Commands 已注册 (guild) + 清除全局命令");
    } else {
      await rest.put(Routes.applicationCommands(discord.user!.id), { body: commands });
      console.log("📝 Slash Commands 已注册 (global)");
    }
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

  // 清理上一轮状态 + 重置 tool 追踪
  stopTyping(channelId);
  clearSafetyTimer(channelId);
  const oldStatusId = activeStatusMessages.get(channelId);
  if (oldStatusId) {
    try {
      const ch = await discord.channels.fetch(channelId) as TextChannel;
      const sm = await ch.messages.fetch(oldStatusId);
      await sm.edit({ content: "✅ 完成", components: [] });
    } catch { /* non-critical */ }
    activeStatusMessages.delete(channelId);
  }
  resetToolTracking(channelId);
  startTypingWithSafety(channelId);
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

  // idle 检测由 JSONL watcher 的静默超时控制（不再用 tmux 轮询）
});

// ============================================================
// Interaction 处理（按钮、菜单、Slash Commands）
// ============================================================

discord.on("interactionCreate", async (interaction: Interaction) => {
  try {
    const channelId = interaction.channelId;
    console.log(`🎯 Interaction: type=${interaction.type} channel=${channelId} user=${interaction.user?.id}`);
    if (!channelId) return;

    if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(interaction.user.id)) {
      console.log(`🚫 用户 ${interaction.user.id} 不在 ALLOWED_USER_IDS 中`);
      return;
    }

    // ── Slash Commands ──
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      console.log(`⚡ Slash command: /${cmd} in ${channelId}`);

      if (cmd === "screenshot") {
        try {
          await interaction.deferReply();
        } catch (e) {
          console.error("📸 deferReply 失败:", e);
          return;
        }
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
          const windowName = agent ? agent.name : "master";
          console.log(`📸 截图: window=${windowName} channel=${channelId}`);
          const pngPath = await tmuxScreenshot(windowName);
          if (pngPath) {
            await interaction.editReply({ content: "**📸 终端截图**", files: [{ attachment: pngPath }] });
          } else {
            console.error("📸 tmuxScreenshot 返回 null");
            await interaction.editReply("❌ 截图失败：PNG 生成失败");
          }
        } catch (e) {
          console.error("📸 截图流程失败:", e);
          try { await interaction.editReply(`❌ 截图失败: ${(e as Error).message}`); } catch {}
        }
        return;
      }

      if (cmd === "interrupt") {
        const listResult = await runManager("list");
        const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
        if (agent) {
          Bun.spawn(["tmux", "-S", TMUX_SOCK, "send-keys", "-t", `master:${agent.name}`, "C-c"]);
          stopTyping(channelId);
          clearSafetyTimer(channelId);
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

      if (cmd === "cron") {
        await interaction.deferReply();
        const cronPanel = await handleMgmtButton("show_cron_menu", channelId);
        if (cronPanel) {
          const components = cronPanel.components ? buildComponents(cronPanel.components) : undefined;
          await interaction.editReply({ content: cronPanel.text, components });
        } else {
          await interaction.editReply("❌ 无法获取定时任务信息");
        }
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
          const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
          if (agent) {
            Bun.spawn(["tmux", "-S", TMUX_SOCK, "send-keys", "-t", `master:${agent.name}`, "C-c"]);
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
            clearSafetyTimer(targetChannelId);
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
      startTypingWithSafety(channelId);
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
      startTypingWithSafety(channelId);
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
        console.log(`🔄 频道 ${msg.channelId} 重新注册 — 主动关闭旧连接`);
        // 主动关闭旧的 ws：发送 "replaced" 通知 + close(1000)。
        // 旧 channel-server 收到 close code 1000 后会知道是被取代而非异常，
        // 不会自动重连，直接 exit。这样彻底消除重复注册的 orphan ws。
        try {
          old.ws.send(JSON.stringify({ type: "replaced", reason: "channel re-registered" }));
        } catch { /* non-critical */ }
        try {
          old.ws.close(1000, "replaced by newer registration");
        } catch { /* non-critical */ }
      }
      clients.set(msg.channelId, { ws, channelId: msg.channelId, userId: msg.userId });
      console.log(`📌 注册频道: ${msg.channelId} (共 ${clients.size} 个)`);
      ws.send(JSON.stringify({ type: "registered", channelId: msg.channelId }));

      // 启动 JSONL watcher（仅用于 tool use 流式展示，空闲检测由 hooks 处理）
      try {
        const regResult = await runManager("list");
        const agent = (regResult.agents || []).find((a: any) => a.channelId === msg.channelId);
        if (agent?.sessionId && agent?.project) {
          const cwd = agent.project.replace(/^~/, process.env.HOME || "~");
          startWatching(agent.name, cwd, agent.sessionId, msg.channelId, discord);
        }
      } catch { /* non-critical */ }

      break;
    }

    case "reply": {
      try {
        const text = msg.text?.replace(/\s*\[DONE\]\s*$/, "") || msg.text;
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

    case "route_to_agent": {
      try {
        // 找发送方的 channelId
        let fromChannelId = "";
        let fromName = msg.fromName || "";
        for (const [chId, info] of clients.entries()) {
          if (info.ws === ws) { fromChannelId = chId; break; }
        }

        // 从 registry 找目标 agent
        const regResult = await runManager("list");
        const agents: any[] = regResult.agents || [];

        // 补全发送方名字
        if (!fromName && fromChannelId) {
          const fromAgent = agents.find((a: any) => a.channelId === fromChannelId);
          fromName = fromAgent?.name || fromChannelId;
        }

        // 找目标 agent（支持带或不带 "agent-" 前缀）
        const targetName = msg.targetName?.startsWith("agent-")
          ? msg.targetName
          : `agent-${msg.targetName}`;
        const target = agents.find((a: any) => a.name === targetName);
        if (!target) {
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `Agent '${targetName}' 不存在或未在 registry 中` }));
          break;
        }

        const targetClient = clients.get(target.channelId);
        if (!targetClient) {
          ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `Agent '${targetName}' 未连接到 Bridge（可能已停止）` }));
          break;
        }

        // 注入消息到目标 channel-server
        const agentMsg = `[🤖 来自 ${fromName}] ${msg.text}`;
        targetClient.ws.send(JSON.stringify({
          type: "message",
          content: agentMsg,
          meta: {
            chat_id: target.channelId,
            message_id: `agent_${Date.now()}`,
            user: fromName,
            user_id: "agent",
            is_agent: "true",
            from_channel_id: fromChannelId,
            ts: new Date().toISOString(),
          },
        }));

        ws.send(JSON.stringify({
          type: "response",
          requestId: msg.requestId,
          result: { ok: true, targetChannelId: target.channelId, targetName },
        }));
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

// ── Hook HTTP 处理 ──
async function handleHookRequest(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { channelId: string; event: string };
    const { channelId, event } = body;
    if (!channelId || !event) {
      return new Response("Missing channelId or event", { status: 400 });
    }

    if (event === "stop") {
      stopTyping(channelId);
      clearSafetyTimer(channelId);
      const statusMsgId = activeStatusMessages.get(channelId);
      if (statusMsgId) {
        discord.channels.fetch(channelId).then((ch) => {
          if (ch && "messages" in ch) {
            const textCh = ch as TextChannel;
            // 编辑状态消息（不 @，不触发通知）
            textCh.messages.fetch(statusMsgId).then((sm) => {
              sm.edit({ content: "✅ 完成", components: [] }).catch(() => {});
            }).catch(() => {});
            // 发新消息（赛马娘风格 + @ 用户，触发推送通知）
            const mention = ALLOWED_USER_IDS.length > 0 ? `<@${ALLOWED_USER_IDS[0]}>` : "";
            if (mention) {
              textCh.send(`${randomUmaDone()} ${mention}`).catch(() => {});
            }
          }
        }).catch(() => {});
        activeStatusMessages.delete(channelId);
      }
    }

    return new Response("ok");
  } catch {
    return new Response("Invalid request", { status: 400 });
  }
}

const server = Bun.serve({
  port: BRIDGE_PORT,
  async fetch(req, server) {
    if (server.upgrade(req)) return undefined;

    // Hook HTTP endpoint
    const url = new URL(req.url);
    if (url.pathname === "/hook" && req.method === "POST") {
      return handleHookRequest(req);
    }

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
          // 同步兜底：直接按 channelId 在 watcher Map 中查，避免依赖异步 runManager
          stopWatchingByChannel(channelId);
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
