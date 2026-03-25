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
  // 不设超时 — 只靠 [DONE] 或 stopTyping() 来停止
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

/** reply 后确保 typing 继续（等待 [DONE] 才停止） */
function ensureTyping(channelId: string) {
  if (!typingIntervals.has(channelId)) {
    startTyping(channelId);
  }
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
// channelId → 当前状态消息 ID（带打断按钮的那条）
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

  // 显示 "正在输入..." + 发送打断按钮状态消息
  startTyping(channelId);
  const statusMsg = await (msg.channel as TextChannel).send({
    content: "💭 大聪明思考中...",
    components: buildComponents([{
      type: "buttons",
      buttons: [{ id: `interrupt:${channelId}`, label: "打断", emoji: "⚡", style: "danger" }],
    }]),
  });
  recentBotMessageIds.add(statusMsg.id);
  // 跟踪此频道的状态消息 ID
  activeStatusMessages.set(channelId, statusMsg.id);

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
const TMUX_SOCK = "/tmp/claude-orchestrator/master.sock";

async function tmuxCapture(windowName: string, lines = 50): Promise<string> {
  const target = windowName === "master" ? "master:0" : `master:${windowName}`;
  const proc = Bun.spawn(["tmux", "-S", TMUX_SOCK, "capture-pane", "-t", target, "-p", "-J", "-S", `-${lines}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

const SCREENSHOT_APP = `${import.meta.dir}/../Screenshot.app/Contents/MacOS/screenshot`;
const IT2API = "/Applications/iTerm.app/Contents/Resources/utilities/it2api";

async function isScreenLocked(): Promise<boolean> {
  const proc = Bun.spawn(["ioreg", "-n", "Root", "-d1"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.includes('"CGSSessionScreenIsLocked"=Yes');
}

async function tmuxScreenshot(windowName: string): Promise<string | null> {
  const pngPath = `/tmp/claude-orchestrator/peek_${windowName}_${Date.now()}.png`;
  const target = windowName === "master" ? "master:0" : `master:${windowName}`;

  // 未锁屏：用 ScreenCaptureKit 真实截图
  if (!(await isScreenLocked())) try {
    // 1. 切到目标 tmux window
    await Bun.spawn(["tmux", "-S", TMUX_SOCK, "select-window", "-t", target]).exited;
    await Bun.sleep(300);

    // 2. 用 it2api 切到对应的 iTerm2 tab
    const searchName = windowName === "master" ? "Claude Code" : windowName.replace("worker-", "");
    const listProc = Bun.spawn([IT2API, "list-sessions"], { stdout: "pipe", stderr: "pipe" });
    const listOut = await new Response(listProc.stdout).text();
    await listProc.exited;
    for (const line of listOut.split("\n")) {
      if (line.toLowerCase().includes(searchName.toLowerCase()) && line.includes("id=")) {
        const idMatch = line.match(/id=([A-F0-9-]+)/);
        if (idMatch) {
          await Bun.spawn([IT2API, "activate", "session", idMatch[1]]).exited;
          break;
        }
      }
    }
    await Bun.sleep(500);

    // 3. 用 ScreenCaptureKit 截图
    const proc = Bun.spawn([SCREENSHOT_APP, pngPath], {
      stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    if (out.includes("OK")) {
      const { existsSync } = await import("fs");
      if (existsSync(pngPath)) return pngPath;
    }
  } catch {}

  // 锁屏或截图失败：用 tmux capture-pane → HTML → qlmanage PNG
  try {
    const proc = Bun.spawn(["tmux", "-S", TMUX_SOCK, "capture-pane", "-t", target, "-p", "-S", "-50"], {
      stdout: "pipe", stderr: "pipe",
    });
    const content = await new Response(proc.stdout).text();
    await proc.exited;
    if (!content.trim()) return null;

    // 转义 HTML 特殊字符，保留空格和换行
    const escaped = content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/ /g, "&nbsp;")
      .split("\n")
      .join("<br>\n");

    const htmlContent = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body {
  background: #1e1e2e;
  color: #cdd6f4;
  font-family: 'Menlo', 'Monaco', monospace;
  font-size: 12px;
  line-height: 1.3;
  padding: 10px;
  margin: 0;
  white-space: pre;
}
</style></head><body>${escaped}</body></html>`;

    const htmlPath = `/tmp/claude-orchestrator/peek_${Date.now()}.html`;
    await Bun.write(htmlPath, htmlContent);

    await Bun.spawn(["qlmanage", "-t", "-s", "1512", "-o", "/tmp/claude-orchestrator/", htmlPath], {
      stdout: "pipe", stderr: "pipe",
    }).exited;

    const qlPngPath = htmlPath + ".png";
    const { existsSync, renameSync } = await import("fs");
    if (existsSync(qlPngPath)) {
      renameSync(qlPngPath, pngPath);
      try { await Bun.spawn(["rm", htmlPath]).exited; } catch {}
      return pngPath;
    }
  } catch {}

  return null;
}

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

/** 构建 Agent 状态面板内容 */
async function buildStatusPanel(): Promise<{ text: string; components: any[] }> {
  const result = await runManager("list");
  if (!result.ok) return { text: `❌ ${result.error}`, components: [] };
  const workers = result.workers || [];
  if (workers.length === 0) return {
    text: "📭 当前没有活跃的 Agent。",
    components: [{ type: "buttons", buttons: [
      { id: "browse_sessions", label: "历史会话", emoji: "📋", style: "secondary" },
      { id: "create_worker", label: "新建 Agent", emoji: "➕", style: "success" },
    ]}],
  };
  const lines = workers.map((w: any) => {
    let status: string;
    if (w.status !== "active") {
      status = "💀 已断开";
    } else if (w.channelId && typingIntervals.has(w.channelId)) {
      status = "🔵 工作中";
    } else if (w.idle) {
      status = "🟢 空闲";
    } else {
      status = "🔵 执行中";
    }
    return `**${w.name}** — ${status}\n📁 \`${w.project}\``;
  });
  const activeWorkers = workers.filter((w: any) => w.status === "active");
  const row1: any[] = [
    { id: "refresh_status", label: "刷新", emoji: "🔄", style: "primary" },
  ];
  if (activeWorkers.length > 0) {
    row1.push(
      { id: "show_peek_menu", label: "监工", emoji: "👁", style: "secondary" },
      { id: "restart_all", label: "全部重启", emoji: "🔄", style: "secondary" },
      { id: "show_kill_menu", label: "销毁", emoji: "🗑", style: "danger" },
    );
  }
  const row2: any[] = [
    { id: "browse_sessions", label: "历史会话", emoji: "📋", style: "secondary" },
    { id: "create_worker", label: "新建 Agent", emoji: "➕", style: "success" },
  ];
  return {
    text: "**📊 Agent 状态**\n\n" + lines.join("\n\n"),
    components: [
      { type: "buttons", buttons: row1 },
      { type: "buttons", buttons: row2 },
    ],
  };
}

async function handleMgmtButton(
  id: string,
  chatId: string,
  messageId?: string
): Promise<{ text: string; components?: any[] } | null> {
  if (id === "list_workers") {
    return await buildStatusPanel();
  }

  if (id === "refresh_status") {
    // 用 edit_message 更新原消息而不是发新消息
    if (messageId) {
      const panel = await buildStatusPanel();
      try {
        const ch = await discord.channels.fetch(chatId) as TextChannel;
        const msg = await ch.messages.fetch(messageId);
        await msg.edit({
          content: panel.text,
          components: panel.components ? buildComponents(panel.components) : [],
        });
      } catch {}
      return { text: "__HANDLED__" };
    }
    return await buildStatusPanel();
  }

  if (id === "show_kill_menu") {
    const result = await runManager("list");
    if (!result.ok) return { text: `❌ ${result.error}` };
    const activeWorkers = (result.workers || []).filter((w: any) => w.status === "active");
    if (activeWorkers.length === 0) return { text: "📭 没有可销毁的 Agent。" };
    return {
      text: "**🗑 选择要销毁的 Agent：**",
      components: [{
        type: "select",
        id: "kill_worker",
        placeholder: "选择 Agent",
        options: activeWorkers.map((w: any) => ({
          label: w.name,
          value: w.name.replace("worker-", ""),
        })),
      }],
    };
  }

  if (id === "show_peek_menu") {
    const result = await runManager("list");
    if (!result.ok) return { text: `❌ ${result.error}` };
    const activeWorkers = (result.workers || []).filter((w: any) => w.status === "active");
    // 加上大总管自己
    const options = [
      { label: "🎛 大总管 (master)", value: "master" },
      ...activeWorkers.map((w: any) => ({
        label: w.name,
        value: w.name,
      })),
    ];
    return {
      text: "**👁 选择要查看的 Agent：**",
      components: [{
        type: "select",
        id: "peek_worker",
        placeholder: "选择 Agent",
        options,
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
        { id: "list_workers", label: "Agent 状态", emoji: "📊", style: "primary" },
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
        { id: "list_workers", label: "Agent 状态", emoji: "📊", style: "primary" },
        { id: "browse_sessions", label: "历史会话", emoji: "📋", style: "secondary" },
        { id: "create_worker", label: "新建 Agent", emoji: "➕", style: "success" },
      ]}],
    };
  }

  if (id === "peek_worker") {
    const windowName = value;
    const pngPath = await tmuxScreenshot(windowName);
    if (!pngPath) {
      return { text: `❌ 无法截取 \`${windowName}\` — 可能电脑锁屏了` };
    }
    // 发送截图
    const channel = await discord.channels.fetch(chatId) as TextChannel;
    await channel.send({
      content: `**👁 ${windowName} 终端截图**`,
      files: [{ attachment: pngPath }],
      components: buildComponents([{ type: "buttons", buttons: [
        { id: "show_peek_menu", label: "再看一个", emoji: "👁", style: "primary" },
        { id: "list_workers", label: "Agent 状态", emoji: "📊", style: "secondary" },
      ]}]),
    });
    return { text: "__HANDLED__" }; // 已直接发送
  }

  return null; // resume_session 和 create_worker 需要用户输入，交给 LLM
}

// 处理按钮点击和下拉菜单选择
discord.on("interactionCreate", async (interaction: Interaction) => {
  try {
  const channelId = interaction.channelId;
  if (!channelId) return;
  console.log(`🔘 Interaction: ${interaction.isButton() ? 'button' : 'select'} ${interaction.isButton() ? (interaction as any).customId : (interaction as any).customId} in ${channelId}`);

  // 用户白名单
  if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(interaction.user.id)) {
    return;
  }

  if (interaction.isButton()) {
    const id = interaction.customId;
    await interaction.deferUpdate().catch(async () => {
      // deferUpdate 可能失败（非 bot 消息上的按钮），回退到 deferReply
      await interaction.deferReply({ ephemeral: true }).catch(() => {});
    });

    // 打断按钮：interrupt:<channelId>
    if (id.startsWith("interrupt:")) {
      const targetChannelId = id.slice("interrupt:".length);
      // 找到对应的 tmux window 并发 Ctrl+C
      // 从 registry 或 clients 反查 window name
      const proc = Bun.spawn(["bun", "run", MANAGER_PATH, "list"], {
        stdout: "pipe", stderr: "pipe",
        env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
      });
      const listOut = await new Response(proc.stdout).text();
      await proc.exited;
      try {
        const listResult = JSON.parse(listOut.trim());
        const worker = (listResult.workers || []).find((w: any) => w.channelId === targetChannelId);
        if (worker) {
          const target = `master:${worker.name}`;
          Bun.spawn(["tmux", "-S", TMUX_SOCK, "send-keys", "-t", target, "C-c"]);
          // 更新状态消息
          const statusMsgId = activeStatusMessages.get(targetChannelId);
          if (statusMsgId) {
            try {
              const ch = await discord.channels.fetch(targetChannelId) as TextChannel;
              const statusMsg = await ch.messages.fetch(statusMsgId);
              await statusMsg.edit({ content: "⚡ 已打断", components: [] });
            } catch {}
            activeStatusMessages.delete(targetChannelId);
          }
          stopTyping(targetChannelId);
        }
      } catch {}
      return;
    }

    // 尝试直接处理管理按钮
    const mgmtResult = await handleMgmtButton(id, channelId, interaction.message?.id);
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
    startTyping(channelId);
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
  components?: any[],
  files?: string[]
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
    // 只有最后一块带组件和文件
    if (isLast && discordComponents?.length) {
      options.components = discordComponents;
    }
    if (isLast && files?.length) {
      options.files = files.map((f) => ({ attachment: f }));
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
          // 更新状态消息为"已完成"
          const statusMsgId = activeStatusMessages.get(msg.chatId);
          if (statusMsgId) {
            try {
              const ch = await discord.channels.fetch(msg.chatId) as TextChannel;
              const statusMsg = await ch.messages.fetch(statusMsgId);
              await statusMsg.edit({ content: "✅ 完成", components: [] });
            } catch {}
            activeStatusMessages.delete(msg.chatId);
          }
        } else {
          ensureTyping(msg.chatId);
          // 状态消息保持不变（不更新内容，避免刷屏）
        }
        const ids = await discordReply(msg.chatId, text, msg.replyTo, msg.components, msg.files);
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
