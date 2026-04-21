/**
 * Discord Bridge Service — 主入口
 *
 * 共享的 Discord 网关连接。多个 Claude Code channel-server 实例通过 WebSocket
 * 连接到此 bridge，每个注册一个 Discord 频道 ID。Bridge 负责路由消息。
 */

import { enableTimestampLogs } from "./lib/log-timestamp.js";
enableTimestampLogs(); // 给所有 console log 加 ISO timestamp 前缀（daemon 专用）

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
import { startPermissionWatcher, permissionMessages, clearPermissionMessage } from "./bridge/permission-watcher.js";
import { startWedgeWatcher, clearWedgeState } from "./bridge/wedge-watcher.js";
import { recordMetric } from "./lib/metrics.js";
import {
  tmuxCapture,
  windowTarget,
  detectRuntimePermissionPrompt,
  detectSessionIdlePrompt,
  tmuxSendLine,
  tmuxRaw,
  parseModalOptions,
  detectArrowNavModal,
  MASTER_SESSION,
  type ArrowNavKind,
} from "./lib/tmux-helper.js";
import {
  scanGlobal as scanGlobalSkills,
  scanProject as scanProjectSkills,
  clearProject as clearProjectSkills,
  allRegistrableCommands,
  resolveInvocation,
  isProjectSkillForOtherAgent,
} from "./bridge/slash-registry.js";

// ============================================================
// 类型定义
// ============================================================

interface ClientInfo {
  ws: ServerWebSocket<unknown>;
  channelId: string;
  userId?: string;
  /** channel-server 所在 Claude Code 进程的 cwd，v1.9.21+ 用来找 jsonl 兜底抽取 */
  cwd?: string;
}

// ============================================================
// 状态
// ============================================================

const clients = new Map<string, ClientInfo>();
const activeStatusMessages = new Map<string, string>();

/**
 * v1.9.20+ / v1.9.21 重构: 记 "Discord 入站消息进到某个 channel-server 但还没回到
 * Discord" 的 pending，Stop hook 触发时用来做两件事：
 *   (1) 如果 pending 的 targetWs 就是这次 Stop 的 ws，且该 turn 没调 reply() →
 *       从 session jsonl 捞最近一条 assistant 文字，**代 post** 到
 *       intendedReplyChannel（v1.9.21+，比 NAG 更硬兜底）
 *   (2) 抽不到文字时 fallback 到 [SYSTEM NAG] 注入，让 master/agent 再跑一轮
 *
 * intendedReplyChannel 可能跟接收消息的 channel 不同！
 *   - via_master：消息进 #agent-exchange 但 CONTROL 和 #agent-exchange 都行
 *     （master 用同一个 ws 处理两个 channel），intended = #agent-exchange
 *   - direct：peer 消息进 #agent-exchange，路由到 agent 的 ws，agent 应该 reply
 *     回 #agent-exchange @ peer bot —— intended = #agent-exchange，target 是 agent
 *
 * reply handler 命中 intendedReplyChannel 就清掉 pending。
 */
interface PendingReply {
  msgId: string;
  ts: number;
  nagged: boolean;
  intendedReplyChannel: string;
  targetWs: ServerWebSocket<unknown>;
}
const pendingReplies = new Map<string, PendingReply>();
const CONTROL_CHANNEL_ID = process.env.CONTROL_CHANNEL_ID || "";

let _cachedAgentExchangeId = "";
async function getLocalAgentExchangeId(): Promise<string> {
  if (_cachedAgentExchangeId) return _cachedAgentExchangeId;
  try {
    const { readPeers } = await import("./lib/peers.js");
    const p = await readPeers();
    _cachedAgentExchangeId = p.localAgentExchangeId || "";
  } catch { /* non-critical */ }
  return _cachedAgentExchangeId;
}

/**
 * v1.9.21+ send_to_agent 推回机制：记录一条 outstanding send_to_agent 调用，
 * 当 target agent 下一次 reply 到自己 channel 时，bridge 自动把那段文字也 push
 * 回 caller 的 ws 作为"[agent-X 回复] …"合成消息，caller 不再需要 fetch_messages
 * 轮询。key = target agent 的 channelId。
 */
interface PendingAgentCall {
  callerChannelId: string;   // 谁发起的（master 或某个 agent）
  callerWs: ServerWebSocket<unknown>;
  callerName: string;
  targetName: string;
  ts: number;
}
const pendingAgentCalls = new Map<string, PendingAgentCall>();

/**
 * v1.9.22+ 跨 peer 的 send_to_agent：caller 发给 peer agent 后，bridge 需要
 * 在 peer bot 下一次在 shared channel reply 时，把 text push 回 caller ws。
 * 跟 pendingAgentCalls 对称。key = shared channel id（我们发消息过去的 channel）。
 */
interface PendingPeerCall {
  callerChannelId: string;
  callerWs: ServerWebSocket<unknown>;
  callerName: string;
  peerBotId: string;
  peerBotName: string;
  peerAgent: string;
  ts: number;
}
const pendingPeerCalls = new Map<string, PendingPeerCall>();
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
    GatewayIntentBits.GuildMembers,       // v1.8.4+: guildMemberAdd 事件，peer bot 加入通知
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

discord.once("ready", async () => {
  setBotUserId(discord.user?.id || "");
  console.log(`✅ Discord 已连接: ${discord.user?.tag}`);
  console.log(`📡 Bridge WebSocket: ws://localhost:${BRIDGE_PORT}`);
  console.log(`🔗 已注册频道: ${clients.size}`);

  // 扫 skill + 为已有 active agent 扫项目级
  await scanGlobalSkills();
  try {
    const listResult = await runManager("list");
    for (const a of listResult.agents || []) {
      if (a.status === "active" && a.cwd) {
        await scanProjectSkills(a.name, a.cwd);
      }
    }
  } catch { /* non-critical */ }

  // 注册 Slash Commands
  await registerSlashCommands();

  // 启动权限弹窗 watcher
  startPermissionWatcher(ALLOWED_USER_IDS, discord);

  // 启动 wedge watcher — 检测长时间没动静但又不 idle 的 agent
  startWedgeWatcher(discord);
  recordMetric("bridge_start", { meta: { channels: clients.size } });

  // 每 30 分钟自动重扫 skill（新装 plugin / 新建 user skill 不需要 restart bridge 就能出现在 /）
  setInterval(async () => {
    try {
      await scanGlobalSkills();
      const listResult = await runManager("list");
      for (const a of listResult.agents || []) {
        if (a.status === "active" && a.cwd) {
          await scanProjectSkills(a.name, a.cwd);
        }
      }
      await registerSlashCommands();
    } catch (e) {
      console.error("定时 skill 重扫失败:", e);
    }
  }, 30 * 60_000);
});

// ────────────────────────────────────────────────
// Slash command 构建 + 注册（可重入）
// ────────────────────────────────────────────────
let lastRegisteredHash = "";

function truncateDesc(desc: string, fallback: string): string {
  const s = (desc || fallback || "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 100) : fallback.slice(0, 100);
}

/**
 * 构建完整的 Discord slash command 列表（内置 bridge 命令 + CC built-in + 所有 skill）。
 */
function buildAllSlashCommands(): any[] {
  const commands: any[] = [
    // bridge 自己的 4 个
    new SlashCommandBuilder().setName("screenshot").setDescription("截取当前 agent 的终端画面").toJSON(),
    new SlashCommandBuilder().setName("interrupt").setDescription("打断当前 agent 的操作 (Ctrl+C)").toJSON(),
    new SlashCommandBuilder().setName("status").setDescription("查看所有 agent 的状态").toJSON(),
    new SlashCommandBuilder().setName("cron").setDescription("查看和管理定时任务").toJSON(),
  ];
  const bridgeNames = new Set(["screenshot", "interrupt", "status", "cron"]);

  for (const item of allRegistrableCommands()) {
    if (item.kind === "builtin") {
      const c = item.cmd;
      if (bridgeNames.has(c.name)) continue; // 优先 bridge 自己的
      const b = new SlashCommandBuilder()
        .setName(c.name)
        .setDescription(truncateDesc(c.description, `Claude Code ${c.name}`));
      for (const opt of c.options) {
        if (opt.type === "choices") {
          b.addStringOption((o) => {
            o.setName(opt.name).setDescription(truncateDesc(opt.description, opt.name)).setRequired(!!opt.required);
            for (const ch of opt.choices || []) o.addChoices({ name: ch, value: ch });
            return o;
          });
        } else {
          b.addStringOption((o) =>
            o.setName(opt.name).setDescription(truncateDesc(opt.description, opt.name)).setRequired(!!opt.required)
          );
        }
      }
      commands.push(b.toJSON());
    } else {
      const s = item.skill;
      if (bridgeNames.has(s.discordName)) continue;
      const b = new SlashCommandBuilder()
        .setName(s.discordName)
        .setDescription(truncateDesc(s.description, `skill: ${s.invokeName}`))
        .addStringOption((o) =>
          o.setName("args").setDescription(truncateDesc(`参数（可选）会原样附加到 /${s.invokeName} 后面`, "参数"))
        );
      commands.push(b.toJSON());
    }
  }
  return commands;
}

async function registerSlashCommands(): Promise<void> {
  try {
    const commands = buildAllSlashCommands();
    // 用 hash 去重 — 命令列表没变就不 REST PUT，省 Discord 配额
    const hash = JSON.stringify(commands);
    if (hash === lastRegisteredHash) {
      console.log(`📝 Slash Commands 未变 (${commands.length} 条)，跳过重注册`);
      return;
    }
    const rest = new REST().setToken(DISCORD_TOKEN);
    if (DISCORD_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(discord.user!.id, DISCORD_GUILD_ID), { body: commands });
      await rest.put(Routes.applicationCommands(discord.user!.id), { body: [] });
      console.log(`📝 Slash Commands 已注册 (guild, ${commands.length} 条) + 清除全局`);
    } else {
      await rest.put(Routes.applicationCommands(discord.user!.id), { body: commands });
      console.log(`📝 Slash Commands 已注册 (global, ${commands.length} 条)`);
    }
    lastRegisteredHash = hash;
  } catch (err) {
    console.error("Slash Commands 注册失败:", err);
  }
}

// ────────────────────────────────────────────────
// Slash 结果呈现（支持 TUI modal 适配 → Discord 按钮/菜单）
// ────────────────────────────────────────────────

/**
 * 发完 slash 命令 + 等 2.5s 之后调。
 * 截一张图；如果 pane 上有数字选项 modal，就把选项以 Discord 按钮/select 的形式暴露给用户。
 * 否则就只发截图。
 */
async function presentSlashResult(
  interaction: any,
  targetWindow: string,
  targetLabel: string,
  ccText: string
): Promise<void> {
  const pane = await tmuxCapture(targetWindow, 40);
  const options = parseModalOptions(pane);
  const arrowNav = options ? null : detectArrowNavModal(pane);
  const pngPath = await tmuxScreenshot(targetLabel);
  const baseContent = `⚡ **${targetLabel}** ← \`${ccText}\``;

  // 无 modal → 截图 + Esc 兜底按钮（防止偶发 modal 没被检测到导致 session 卡住）
  // 兜底按钮（没有 modal 时）：Esc + 🤖 让大总管处理
  if (!options && !arrowNav) {
    const payload: any = {
      content: baseContent,
      components: buildComponents([
        {
          type: "buttons",
          buttons: [
            { id: `modal:${targetWindow}:esc`, label: "Esc (兜底)", emoji: "❌", style: "secondary" },
            { id: `escalate:${targetWindow}:${encodeURIComponent(ccText)}`, label: "让大总管处理", emoji: "🤖", style: "primary" },
          ],
        },
      ]),
    };
    if (pngPath) payload.files = [{ attachment: pngPath }];
    else payload.content = `${baseContent}（截图失败）`;
    await interaction.editReply(payload).catch(() => {});
    return;
  }

  // 有 modal → 截图 + 按钮（按钮组里已含 🤖 升级按钮）
  const header = options
    ? `🎛 **${targetLabel}** 的 TUI 选项（\`${ccText}\`）：`
    : `🎛 **${targetLabel}** 的 ${arrowNav} 箭头 modal（\`${ccText}\`），用按钮导航 + 点 ✅ 确认：`;
  const modalRows = options
    ? buildModalComponents(targetWindow, options, ccText)
    : buildArrowModalComponents(targetWindow, arrowNav!, ccText);
  const payload: any = { content: header, components: modalRows };
  if (pngPath) payload.files = [{ attachment: pngPath }];
  await interaction.editReply(payload).catch(() => {});
}

/**
 * 把 modal 选项渲染成 Discord components。
 * ≤5 项 → 按钮行；>5 项 → string select menu。
 * 再追加一个 "❌ 取消 (Esc)" + 🤖 升级按钮。
 */
function buildModalComponents(targetWindow: string, options: { key: string; label: string; selected: boolean }[], ccText = "") {
  const rows: any[] = [];
  const escId = `modal:${targetWindow}:esc`;
  const escalateId = `escalate:${targetWindow}:${encodeURIComponent(ccText)}`;

  if (options.length <= 5) {
    const buttons = options.map((o) => ({
      id: `modal:${targetWindow}:${o.key}`,
      label: `${o.key}. ${o.label}`.slice(0, 80),
      style: o.selected ? "success" : "primary",
    }));
    rows.push({ type: "buttons" as const, buttons });
  } else {
    rows.push({
      type: "select" as const,
      id: `modal:${targetWindow}:select`,
      placeholder: "选一个选项",
      options: options.map((o) => ({
        label: `${o.key}. ${o.label}`.slice(0, 100),
        value: o.key,
        description: o.selected ? "当前选中" : undefined,
      })),
    });
  }
  rows.push({
    type: "buttons" as const,
    buttons: [
      { id: escId, label: "取消 (Esc)", style: "secondary", emoji: "❌" },
      { id: escalateId, label: "让大总管处理", style: "primary", emoji: "🤖" },
    ],
  });
  return buildComponents(rows);
}

/**
 * 把箭头导航 modal 渲染成上下左右 + Enter + Esc + 🤖 升级按钮。
 */
function buildArrowModalComponents(targetWindow: string, kind: ArrowNavKind, ccText = "") {
  const rows: any[] = [];
  const navButtons: any[] = [];
  if (kind === "vertical" || kind === "both") {
    navButtons.push({ id: `modal:${targetWindow}:up`, label: "Up", emoji: "⬆️", style: "primary" });
    navButtons.push({ id: `modal:${targetWindow}:down`, label: "Down", emoji: "⬇️", style: "primary" });
  }
  if (kind === "horizontal" || kind === "both") {
    navButtons.push({ id: `modal:${targetWindow}:left`, label: "Left", emoji: "⬅️", style: "primary" });
    navButtons.push({ id: `modal:${targetWindow}:right`, label: "Right", emoji: "➡️", style: "primary" });
  }
  rows.push({ type: "buttons" as const, buttons: navButtons });
  rows.push({
    type: "buttons" as const,
    buttons: [
      { id: `modal:${targetWindow}:enter`, label: "确认 (Enter)", emoji: "✅", style: "success" },
      { id: `modal:${targetWindow}:esc`, label: "取消 (Esc)", emoji: "❌", style: "secondary" },
      { id: `escalate:${targetWindow}:${encodeURIComponent(ccText)}`, label: "让大总管处理", emoji: "🤖", style: "primary" },
    ],
  });
  return buildComponents(rows);
}

/**
 * 按钮 / select 点击后，把按键发给 tmux，等 1.5s，再次截图 + 可能再出 modal。
 */
async function handleModalInteraction(
  interaction: any,
  targetWindow: string,
  key: string
): Promise<void> {
  await interaction.deferUpdate().catch(() => {});
  recordMetric("modal_button", { agent: targetWindow.replace(/^master:/, ""), meta: { key } });
  try {
    const keyMap: Record<string, string> = {
      esc: "Escape",
      enter: "Enter",
      left: "Left",
      right: "Right",
      up: "Up",
      down: "Down",
    };
    const tmuxKey = keyMap[key] ?? key; // 数字键保持原样
    await tmuxRaw(["send-keys", "-t", targetWindow, tmuxKey]);
    await Bun.sleep(1500);
    const pane = await tmuxCapture(targetWindow, 40);
    const options = parseModalOptions(pane);
    const arrowNav = options ? null : detectArrowNavModal(pane);
    const pngPath = await tmuxScreenshot(targetWindow.replace(/^master:/, ""));
    const label = targetWindow.replace(/^master:/, "");

    const payload: any = {};
    if (options) {
      payload.content = `🎛 **${label}** 的 TUI 选项（继续）：`;
      payload.components = buildModalComponents(targetWindow, options);
    } else if (arrowNav) {
      payload.content = `🎛 **${label}** 的 ${arrowNav} 箭头 modal（继续，用 ✅ 确认）：`;
      payload.components = buildArrowModalComponents(targetWindow, arrowNav);
    } else {
      payload.content = `✅ **${label}** 已执行（key=${key}）`;
      payload.components = [];
    }
    if (pngPath) payload.files = [{ attachment: pngPath }];
    await interaction.editReply(payload).catch(() => {});
  } catch (e) {
    await interaction.editReply({
      content: `❌ Modal 交互失败：${(e as Error).message}`,
      components: [],
    }).catch(() => {});
  }
}

// ============================================================
// 入站消息处理
// ============================================================

discord.on("messageCreate", async (msg: DiscordMessage) => {
  // 跳过自己 bot 的消息（echo）+ 跳过 bridge 自己发出去的（见 trackSentMessage）
  if (msg.author.id === getBotUserId()) return;
  if (isBotMessage(msg.id)) return;

  const mentionedMe = msg.mentions.users.has(getBotUserId());
  const channelId = msg.channelId;

  // v1.9.0+: PeerEvent 事件解析（grant/revoke 通告）— peer bot 发来的
  // 如果这条消息正文里有 PeerEvent 标记，解析后更新本地 capabilities 并主动 notify master（让用户知道对方新开放/撤销）
  if (msg.author.bot) {
    try {
      const { parsePeerEvent, addCapability, removeCapability } = await import("./lib/peers.js");
      const event = parsePeerEvent(msg.content || "");
      if (event) {
        console.log(`📥 PeerEvent 收到: ${JSON.stringify(event)} from ${msg.author.tag}`);
        const myBotId = getBotUserId();
        // event.peer 可以是我方 bot id 或 "all"；只处理针对我们的
        if (event.peer === myBotId || event.peer === "all") {
          if (event.kind === "grant") {
            await addCapability({
              peerBotId: msg.author.id,
              peerBotName: msg.author.tag,
              peerAgentExchangeId: event.exchange,
              peerAgent: event.local,
              purpose: event.purpose,
              mode: event.mode,
            });
            console.log(`📥 学到能力: peer ${msg.author.tag} 开放 ${event.local}（${event.purpose ?? "无描述"}）`);
            await notifyMaster(
              [
                `🤝 **对方 Claudestra 开放了新能力给你**`,
                ``,
                `来源：**${msg.author.tag}**（peer bot id \`${msg.author.id}\`）`,
                `开放 agent：**${event.local}**`,
                event.purpose ? `用途：${event.purpose}` : "",
                ``,
                `你的 \`~/.claude-orchestrator/peers.json\` 里 capabilities 已更新。`,
                `以后本地 agent 遇到相关问题可以直接去 **#agent-exchange** 频道 @ ${msg.author.tag} 提问。`,
              ].filter(Boolean).join("\n")
            );
          } else if (event.kind === "revoke") {
            await removeCapability(msg.author.id, event.local);
            console.log(`📥 撤销能力: peer ${msg.author.tag} 收回 ${event.local}`);
            await notifyMaster(
              [
                `🚫 **对方 Claudestra 撤销了能力**`,
                ``,
                `来源：**${msg.author.tag}**`,
                `撤销 agent：**${event.local}**`,
              ].join("\n")
            );
          }
        }
      }
    } catch (e) {
      console.error("PeerEvent 处理失败:", e);
    }
  }

  // v1.9.22+: peer bot 在 shared channel 发消息 → 如果我方最近刚对这个 channel
  // 发了跨 peer send_to_agent，把 peer bot 这条回复 push 回 caller 的 ws（免轮询）。
  // 命中后 early return，不再让 master / direct 路由重复处理同一条消息。
  // [EOT] 标记的消息不触发 pushback（那是关闭信号，没实质内容）。
  if (msg.author.bot && !/\[EOT\]\s*$/i.test(msg.content || "")) {
    const pp = pendingPeerCalls.get(channelId);
    if (pp && pp.peerBotId === msg.author.id) {
      const cleanText = (msg.content || "")
        .replace(/<!--\s*CLAUDESTRA_PEER_EVENT[\s\S]*?-->/g, "")
        .replace(new RegExp(`<@!?${getBotUserId()}>`, "g"), "")
        .replace(/<@!?\d+>\s*/g, "")
        .trim();
      if (cleanText) {
        try {
          pp.callerWs.send(JSON.stringify({
            type: "message",
            content: `[🤖 peer ${pp.peerBotName}/${pp.peerAgent} 回复]\n${cleanText}`,
            meta: {
              chat_id: pp.callerChannelId,
              message_id: `peer_reply_${Date.now()}`,
              user: `${pp.peerBotName}/${pp.peerAgent}`,
              user_id: "peer_agent",
              is_agent: "true",
              from_channel_id: channelId,
              ts: new Date().toISOString(),
            },
          }));
          lastMessageSource.set(pp.callerChannelId, "agent");
          console.log(`📨 PEER PUSH-BACK: ${pp.peerBotName}/${pp.peerAgent} 回复 → push 给 caller=${pp.callerChannelId}（吞掉本条，不走 master/direct）`);
          recordMetric("peer_pushback", { channelId: pp.callerChannelId, meta: { peer: pp.peerBotName, peerAgent: pp.peerAgent } });
          pendingPeerCalls.delete(channelId);
          return; // 吞掉，不再走下面的流程
        } catch (e) {
          console.error("PEER PUSH-BACK 失败:", e);
        }
      }
    }
  }

  // Peer bot（其他 Claudestra / 任意外部 bot）：必须 @ 我们才处理。
  // @ 是跨 agent 协作的强制语义 —— "这条消息给你，你要响应"。没 @ 就不转发给 agent，
  // 对方 agent 看到"没回应"就会知道自己忘了 @ 或 bridge 没自动补 @。
  // 保证：我方 reply() 时 bridge 会自动补 @ peer bot（见 ensurePeerMentions），所以我方不会忘。
  if (msg.author.bot) {
    if (!mentionedMe) return;
  } else if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(msg.author.id)) {
    // 人类但不在 allowlist：只有 @ 了我们才处理（跨服有人找我们的场景）
    if (!mentionedMe) return;
  }

  // v1.9.22+: 本地 allowlist user 在 #agent-exchange 里只 @ peer bot、没 @ 我们 →
  // 不 forward 给我方 master（免得它以为用户在问自己，浪费 turn 或误答）。
  // 这种消息意图是"用对方的 agent"，让对方 bridge 处理就行。
  const exchangeIdForSkip = await getLocalAgentExchangeId();
  if (!msg.author.bot && channelId === exchangeIdForSkip && !mentionedMe) {
    const peerBotsInMsg = Array.from(msg.mentions.users.values()).filter(
      (u) => u.bot && u.id !== getBotUserId()
    );
    if (peerBotsInMsg.length > 0) {
      console.log(`🎯 SKIP local-forward: user ${msg.author.username} @ peer bot ${peerBotsInMsg.map((u) => u.username).join("/")} 不 @ 我方 bot，交给对方 bridge 处理`);
      return;
    }
  }

  // v1.9.22+: 对称 direct 路由 —— peer bot 是我们自己的 bot（即我们被 invite 到对方 guild），
  // 对方 guild 的 #agent-exchange 里的消息 @ 我们，需要路由到我方**指定的 exposed agent**。
  // 即使 clients.get 找不到（那是对方 guild 的频道，我们没注册过任何 channel-server），
  // 也应该识别出是 foreign #agent-exchange 并走 direct 路由。
  if (!clients.get(channelId) && mentionedMe) {
    const handled = await tryRouteForeignAgentExchange(msg, channelId);
    if (handled) return;
  }

  const client = clients.get(channelId);
  if (!client) return;
  const isPeer = msg.author.bot;

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

  // v1.9.16+: peer 消息以 [EOT] 结尾 → "本轮结束，不需要再回复"。
  // 解决 #agent-exchange 两边 bot 互相 ack 死循环的问题（每次 reply 会自动 @ 对方 bot，
  // 对方又 route 给 master 处理，master 又 reply... 无限）。
  // 约定：agent 想主动结束 thread 时在 reply 末尾写 `[EOT]`。收到端 bridge 识别到就
  // 直接不 forward 给本地 agent，Discord 里消息仍可见（带 [EOT] 尾巴做人类可读的标记）。
  if (isPeer && /\[EOT\]\s*$/i.test(content)) {
    console.log(`📪 收到 peer [EOT] 标记，不 forward 给 agent: from=${msg.author.tag} channel=${channelId}`);
    recordMetric("peer_thread_closed", { channelId, meta: { from: msg.author.id } });
    return;
  }

  // 新用户消息到达 → 如果 agent 还在忙（不 idle），先发 Ctrl+C 打断，让新消息覆盖旧任务
  // 注意：peer bot 来的消息不走这个打断（agent-to-agent 的交流不应该打断本地 agent 的工作）
  if (!isPeer) {
    try {
      const listResult = await runManager("list");
      const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
      const targetWindow = agent ? `master:${agent.name}` : `master:0`;
      const { isIdle } = await import("./lib/tmux-helper.js");
      if (!(await isIdle(targetWindow))) {
        console.log(`⚡ 新消息到达但 ${targetWindow} 还在忙，发 Ctrl+C 打断`);
        await tmuxRaw(["send-keys", "-t", targetWindow, "C-c"]).catch(() => {});
        await Bun.sleep(400);
      }
    } catch { /* non-critical */ }
  }

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
  if (isPeer) {
    // 对接另一个 Claudestra 的 bot / 其他外部 bot。agent 需要知道"这是 peer"才能正确响应
    meta.peer = "true";
    meta.peer_bot_name = msg.author.username;
    meta.peer_bot_id = msg.author.id;
  }

  // v1.9.4+: 在 #agent-exchange 频道里发的任何消息（peer bot 或我方人类），都注入路由指令给 master。
  // 这个频道本身就是"agent 之间交流"的设计，master 不该自己答。header 每次都在 content 最前面，
  // 比纯 CLAUDE.md 指令难被 LLM 忽略。
  try {
    const { readPeers } = await import("./lib/peers.js");
    const peers = await readPeers();
    if (peers.localAgentExchangeId && channelId === peers.localAgentExchangeId) {
      const senderKind = isPeer ? `peer bot ${msg.author.username}` : `用户 ${msg.author.username}`;
      // 如果是 peer 发的：exposures 要匹配该 peer 或 "all"
      // 如果是用户发的：所有 exposures 都可选（让 master 挑最合适的）
      const relevant = peers.exposures.filter((e) =>
        isPeer ? (e.peerBotId === msg.author.id || e.peerBotId === "all") : true
      );
      if (relevant.length === 0 && isPeer) {
        content = [
          `⚠️ PEER REQUEST FROM ${msg.author.username} — NO EXPOSURES DEFINED`,
          ``,
          `你还没有对这个 peer 开放任何本地 agent。礼貌回一句"${process.env.USER_NAME || "User"} 还没对你开放任何 agent，请让他 peer-expose 后再试"，结束本轮。**不要**自己回答 peer 问题。`,
          ``,
          `---`,
          `原始消息：`,
          content,
        ].join("\n");
      } else if (relevant.length > 0) {
        const exposureList = relevant
          .map((e) => `  - ${e.localAgent}${e.purpose ? ` (用途: ${e.purpose})` : ""}`)
          .join("\n");
        content = [
          `🚨 AGENT-EXCHANGE 消息 FROM ${senderKind} — YOU MUST ROUTE, NOT ANSWER`,
          ``,
          `这条消息来自 #agent-exchange 频道，需要路由给本地 agent，而不是你自己回答。可选 agent：`,
          exposureList,
          ``,
          `步骤：`,
          `1. 挑跟请求最匹配的 agent`,
          `2. \`send_to_agent(target="<agent 名字>", text="来自 ${senderKind} 的请求：<原文>")\``,
          `3. fetch_messages 轮询对应 channelId 等回复（首次 15s sleep，之后每 10s 轮询，最多 5 次）`,
          `4. 拿到 agent 回复后用 \`reply(chat_id="${channelId}", text="...")\` 转述${isPeer ? "给 peer（bridge 会自动 @ 对方 bot）" : "给用户"}`,
          ``,
          `🚫 不要自己回答，即便你觉得你知道答案。这个频道的语义就是"agent 间协作"，你只做调度。`,
          ``,
          `⚠️ **最后一步必须是 \`reply\` 工具调用**。纯文字输出只到你本地终端，Discord 看不到，用户只会收到 Stop 的空 "✅ 完成" 通知。没调 reply = 没回。`,
          ``,
          `---`,
          `原始消息：`,
          content,
        ].join("\n");
      }
    }
  } catch (e) {
    console.error("agent-exchange header 注入失败:", e);
  }

  // 记录触发源：peer bot / 其他 bot 的消息视为 "agent"（下游 Stop 不发完成 @）；人类视为 "user"
  // 必须写给所有共享同一个 ws 的 channel：
  // 场景：peer 在 #agent-exchange 发消息，client.channelId=#agent-exchange，
  // 但 master 的 Stop hook 会带 CONTROL_CHANNEL_ID 来查，如果只在 #agent-exchange
  // 键上存 "agent"，Stop 一查 CONTROL 找不到就当 "user" 发 @。
  const triggerSource: "user" | "agent" = isPeer ? "agent" : "user";
  for (const [cid, info] of clients.entries()) {
    if (info.ws === client.ws) {
      lastMessageSource.set(cid, triggerSource);
    }
  }

  // v1.9.21+ direct mode peer routing：
  // 如果是 peer bot 在 #agent-exchange 发消息、且 peers.json 里这个 peer 的
  // exposure 是 mode=direct → 路由**直接到 agent 的 ws**，完全绕过 master。
  // agent 被要求 reply 回 #agent-exchange @ peer bot。
  // 找不到匹配 exposure / 多个 candidate / mode=via_master → 回到原路径（forward 给 master）。
  let routeWs = client.ws;
  let routeClientChannelId = client.channelId;
  let directHeaderInjected = false;
  if (isPeer && channelId === await getLocalAgentExchangeId()) {
    const { readPeers, effectivePeerMode } = await import("./lib/peers.js");
    const peers = await readPeers();
    const directExposures = peers.exposures
      .filter((e) => (e.peerBotId === msg.author.id || e.peerBotId === "all") && effectivePeerMode(e) === "direct");
    // 只 auto-pick 唯一一条（多条 → 交给 master 决策，避免误路由）
    if (directExposures.length === 1) {
      const targetExp = directExposures[0];
      try {
        const listResult = await runManager("list");
        const agents = (listResult.agents || []) as any[];
        const targetAgent = agents.find((a: any) =>
          a.name === targetExp.localAgent || a.name === `agent-${targetExp.localAgent}`
        );
        if (targetAgent && targetAgent.status === "active") {
          const agentClient = clients.get(targetAgent.channelId);
          if (agentClient) {
            // 改写 content：盖掉上面的 master agent-exchange header，插 direct header
            content = [
              `🤝 PEER DIRECT REQUEST — bridge 直接把这条来自 #agent-exchange 的 peer 请求路由给你处理`,
              ``,
              `来源：peer bot **${msg.author.username}** (id: \`${msg.author.id}\`) 在 #agent-exchange (\`${channelId}\`)`,
              `你被 expose 的理由：${targetExp.purpose || "（无描述）"}`,
              ``,
              `**最终动作必须是**：\`reply(chat_id="${channelId}", text="<你的答案>")\``,
              `- bridge 会自动在你 reply 前 @ peer bot，不用自己加 \`<@id>\``,
              `- 如果这是最后一句（对方不需要再回应）在 text 末尾加 \`[EOT]\` 防止互 ack 死循环`,
              `- 不要 reply 到自己 channel，没人读；不要 send_to_agent 套娃，不要找 master`,
              `- 如果你觉得这个请求你处理不了，reply 一句"请找 ${process.env.USER_NAME || "owner"} 或其 master" 也行`,
              ``,
              `---`,
              `原始消息：`,
              (msg.content || "").replace(new RegExp(`<@!?${getBotUserId()}>`, "g"), "").trim() + (attachmentPaths.length > 0 ? `\n\n${attachmentPaths.map((p) => `[attachment: ${p}]`).join("\n")}` : ""),
            ].join("\n");
            routeWs = agentClient.ws;
            routeClientChannelId = agentClient.channelId;
            directHeaderInjected = true;
            console.log(`🎯 PEER DIRECT: ${msg.author.username} → ${targetAgent.name} (bypass master)`);
            recordMetric("peer_direct_route", { channelId, meta: { peerBotId: msg.author.id, agent: targetAgent.name } });
          } else {
            console.log(`⚠️ PEER DIRECT fallback: agent ${targetAgent.name} 未连接 bridge，回落 master`);
          }
        } else if (targetAgent) {
          console.log(`⚠️ PEER DIRECT fallback: agent ${targetExp.localAgent} status=${targetAgent.status}，回落 master`);
        } else {
          console.log(`⚠️ PEER DIRECT fallback: agent ${targetExp.localAgent} 在 registry 找不到，回落 master`);
        }
      } catch (e) {
        console.error("PEER DIRECT routing 失败，回落 master:", e);
      }
    } else if (directExposures.length > 1) {
      console.log(`🎯 PEER DIRECT 有 ${directExposures.length} 个候选（${directExposures.map((e) => e.localAgent).join("/")}），交给 master 决策`);
    }
  }

  // v1.9.20+/v1.9.21: 挂起一个"这条消息需要 reply 回 Discord"的 pending 记录。
  // Stop hook 触发时 bridge 会：
  //   (1) 从 session jsonl 捞最近 assistant 文字代 post 到 intendedReplyChannel
  //   (2) 没文字就 fallback 到 [SYSTEM NAG] 注入
  // 只对 master 自己的两个 channel (CONTROL + #agent-exchange) 挂 pending。
  // direct 模式下 intendedReplyChannel 依然是 #agent-exchange，但 targetWs 是 agent。
  const exchangeId = await getLocalAgentExchangeId();
  if (channelId === CONTROL_CHANNEL_ID || channelId === exchangeId) {
    pendingReplies.set(channelId, {
      msgId: msg.id,
      ts: Date.now(),
      nagged: false,
      intendedReplyChannel: channelId,
      targetWs: routeWs,
    });
  }

  try {
    routeWs.send(JSON.stringify({ type: "message", content, meta }));
    recordMetric("message_in", { channelId, meta: { len: content.length, attachments: attachmentPaths.length, direct: directHeaderInjected } });
  } catch (err) {
    console.error(`发送消息到 client (channel ${channelId}) 失败:`, err);
    recordMetric("error", { channelId, meta: { phase: "forward_to_client", err: String(err) } });
  }

  // idle 检测由 JSONL watcher 的静默超时控制（不再用 tmux 轮询）
});

// ============================================================
// Peer 发现：bot 被邀请 / 别的 bot 加入
// ============================================================

// 工具：reply 到一个跟 peer bot 共享的频道时，自动在消息正文前加上对所有 peer bot 的 @，
// 保证对方 bridge 能识别"这条是给它的"。已经带上的 id 不重复加。
async function ensurePeerMentions(discord: Client, channelId: string, text: string): Promise<string> {
  try {
    const ch = await discord.channels.fetch(channelId).catch(() => null);
    if (!ch || !("guild" in ch) || !(ch as any).guild) return text;
    const guild = (ch as any).guild;
    const ownBotId = getBotUserId();
    // 列频道成员里的 peer bot
    const members = await guild.members.fetch({ cache: true }).catch(() => null);
    if (!members) return text;
    const peerBots: string[] = [];
    for (const [, m] of members) {
      if (!m.user?.bot) continue;
      if (m.user.id === ownBotId) continue;
      // 只有对该频道有 View Channel 权限的 bot 才算真的在场
      const perms = (ch as any).permissionsFor?.(m);
      if (perms && !perms.has("ViewChannel")) continue;
      peerBots.push(m.user.id);
    }
    if (peerBots.length === 0) return text;
    const missing = peerBots.filter((id) => !text.includes(`<@${id}>`) && !text.includes(`<@!${id}>`));
    if (missing.length === 0) return text;
    const prefix = missing.map((id) => `<@${id}>`).join(" ");
    return `${prefix} ${text}`;
  } catch {
    return text;
  }
}

// 工具：往 master 控制频道发一条通知
async function notifyMaster(content: string): Promise<void> {
  const controlChannelId = process.env.CONTROL_CHANNEL_ID || "";
  if (!controlChannelId) return;
  try {
    const ch = await discord.channels.fetch(controlChannelId);
    if (ch && "messages" in ch) {
      await (ch as TextChannel).send({ content });
    }
  } catch { /* non-critical */ }
}

// 我方 bot 被邀请加入新 guild
discord.on("guildCreate", async (guild) => {
  console.log(`🎉 我方 bot 被加到新 guild: ${guild.name} (${guild.id})`);
  await notifyMaster(
    [
      `🎉 **跨 Claudestra 协作：你的 bot 被邀请到新服务器**`,
      ``,
      `服务器：**${guild.name}**（id: \`${guild.id}\`，${guild.memberCount} 成员）`,
      ``,
      `接下来可以：`,
      `• 调 \`list_shared_channels\` MCP 工具，看这个 guild 里哪些频道你能进。`,
      `• 按频道名字 / topic 判断用途；需要时 reply 到对应 chat_id @ 对方 bot 发起对话。`,
      `• 你也可以先不动；等对方 agent 主动 @ 我们。`,
    ].join("\n")
  );
});

// 我方 bot 在外部 guild 拿到新频道访问权限（对方给我们 allow View Channel）
discord.on("channelCreate", async (channel) => {
  // 只通知外部 guild（peer 邀请我们进去的那些），自己 guild 里建频道是我们自己在创建 agent 不通知
  if (!("guild" in channel) || !channel.guild) return;
  if (channel.guild.id === DISCORD_GUILD_ID) return;
  const textCh = channel as TextChannel;
  if (typeof textCh.isTextBased !== "function" || !textCh.isTextBased()) return;
  console.log(`🎉 外部 guild 新频道访问: #${textCh.name} in ${textCh.guild?.name}`);
  await notifyMaster(
    [
      `🎉 **你 bot 在对方 Claudestra 服务器拿到新频道访问**`,
      ``,
      `频道：**#${textCh.name}**（id: \`${textCh.id}\`，topic: ${textCh.topic || "(无)"}）`,
      `服务器：${textCh.guild?.name ?? "(未知)"}`,
      ``,
      `你可以在这个频道 @ 对方 bot 发起对话：\`reply(chat_id="${textCh.id}", text="<@对方bot_id> ...")\``,
      `或者先调 \`list_shared_channels\` 看一下你当前的全部外部频道列表。`,
    ].join("\n")
  );
});

// 我方 bot 在外部 guild 失去频道访问（频道被删了）
discord.on("channelDelete", async (channel) => {
  if (!("guild" in channel) || !channel.guild) return;
  if (channel.guild.id === DISCORD_GUILD_ID) return;
  const textCh = channel as TextChannel;
  if (typeof textCh.isTextBased !== "function" || !textCh.isTextBased()) return;
  console.log(`💨 外部 guild 频道被删: #${textCh.name} in ${textCh.guild?.name}`);
  await notifyMaster(
    [
      `💨 **${textCh.guild?.name ?? "外部 guild"} 里 #${textCh.name} 被删了**`,
    ].join("\n")
  );
});

// 已有频道权限变化：比如对方 grant 或 revoke 我们的 View Channel
discord.on("channelUpdate", async (oldCh: any, newCh: any) => {
  if (!newCh.guild || newCh.guild.id === DISCORD_GUILD_ID) return;
  if (typeof newCh.isTextBased !== "function" || !newCh.isTextBased()) return;
  const me = newCh.guild.members.me;
  if (!me) return;
  try {
    const oldCanView = oldCh.permissionsFor(me)?.has("ViewChannel") ?? false;
    const newCanView = newCh.permissionsFor(me)?.has("ViewChannel") ?? false;
    if (!oldCanView && newCanView) {
      console.log(`🎉 外部 guild 新获授权: #${newCh.name} in ${newCh.guild.name}`);
      await notifyMaster(
        [
          `🎉 **你 bot 在对方 Claudestra 服务器拿到新频道访问**`,
          ``,
          `频道：**#${newCh.name}**（id: \`${newCh.id}\`，topic: ${newCh.topic || "(无)"}）`,
          `服务器：${newCh.guild.name}`,
          ``,
          `你可以在这个频道 @ 对方 bot 发起对话：\`reply(chat_id="${newCh.id}", text="<@对方bot_id> ...")\``,
          `或者先调 \`list_shared_channels\` 看一下你当前的全部外部频道列表。`,
        ].join("\n")
      );
    } else if (oldCanView && !newCanView) {
      console.log(`💨 外部 guild 失去授权: #${newCh.name} in ${newCh.guild.name}`);
      await notifyMaster(
        [
          `💨 **你 bot 在 ${newCh.guild.name} 的 #${newCh.name} 被收回了 View Channel 权限**`,
        ].join("\n")
      );
    }
  } catch (e) {
    console.error("channelUpdate 处理失败:", e);
  }
});

// 别的 bot（不是我方）加入了我的 guild
discord.on("guildMemberAdd", async (member) => {
  if (!member.user?.bot) return;
  if (member.user.id === getBotUserId()) return; // 自己
  if (member.guild.id !== DISCORD_GUILD_ID) return; // 不是我方主 guild 不处理
  console.log(`🎉 Peer bot 加入: ${member.user.tag} (${member.user.id}) in ${member.guild.name}`);

  // v1.9.0+: 新流程
  // 1. 等 Discord 把 peer bot 的 managed role 同步完
  await Bun.sleep(1500);
  // 2. 确保 #agent-exchange 频道存在（第一次 peer 加入会自动建）
  const exchange = await ensureAgentExchangeChannel(member.guild);
  // 3. 对这个 peer bot：deny 所有频道 view，但 allow #agent-exchange
  const scope = await scopePeerToAgentExchange(member, exchange);
  // 4. 记到 peers.json
  const peersLib = await import("./lib/peers.js");
  await peersLib.upsertPeerBot({
    id: member.id,
    name: member.user.tag,
    guildId: member.guild.id,
    agentExchangeId: exchange?.id,
    firstSeen: new Date().toISOString(),
  });
  // 5. master 如果已经连着，把 #agent-exchange 挂到 master ws 上（让 master 收这里的消息）
  if (exchange) {
    const controlId = process.env.CONTROL_CHANNEL_ID || "";
    const master = clients.get(controlId);
    if (master) {
      clients.set(exchange.id, { ws: master.ws, channelId: exchange.id, userId: master.userId });
      console.log(`📌 #agent-exchange (${exchange.id}) 挂到 master ws`);
    }
  }

  const scopeNote = !exchange
    ? `⚠️ 没能在你 guild 里建或找到 #agent-exchange 频道（权限不足？），peer 通信无处可去`
    : scope.ok
      ? `✅ peer bot 现在只能看到 **#${exchange.name}**（id: \`${exchange.id}\`）一个频道，其他全部 deny`
      : `⚠️ Scope 部分失败: ${scope.reason}. peer bot 可能还能看到一些其他频道，手工 deny 下。`;

  await notifyMaster(
    [
      `🎉 **跨 Claudestra 协作：对方 Claudestra 的 bot 刚刚加入你的服务器**`,
      ``,
      `Peer bot：**${member.user.tag}**（id: \`${member.id}\`）`,
      `服务器：${member.guild.name}`,
      ``,
      scopeNote,
      ``,
      `目前**没有任何本地 agent** 对这个 peer 开放。要开放，跑：`,
      `  \`bun src/manager.ts peer-expose <agent-name> ${member.user.username} --purpose "..."\``,
      `  或开放给所有 peer：\`bun src/manager.ts peer-expose <agent-name> all --purpose "..."\``,
    ].join("\n")
  );
});

/**
 * 确保 guild 里有一个 #agent-exchange 频道。
 * 优先用 peers.json 里记录的 id；没有或找不到就新建一个。
 */
async function ensureAgentExchangeChannel(guild: any): Promise<TextChannel | null> {
  const { readPeers, setLocalAgentExchangeId } = await import("./lib/peers.js");
  const peers = await readPeers();
  const EXCHANGE_NAME = process.env.PEER_EXCHANGE_CHANNEL_NAME || "agent-exchange";

  // 1. peers.json 里已有记录 → 确认频道还在
  if (peers.localAgentExchangeId) {
    try {
      const ch = await guild.channels.fetch(peers.localAgentExchangeId).catch(() => null);
      if (ch) return ch as TextChannel;
    } catch { /* fall through to create */ }
  }

  // 2. 搜 guild 看有没有同名频道
  const existing = guild.channels.cache.find(
    (c: any) => c.type === 0 && c.name === EXCHANGE_NAME
  );
  if (existing) {
    await setLocalAgentExchangeId(existing.id);
    return existing as TextChannel;
  }

  // 3. 建新频道
  try {
    const me = guild.members.me;
    if (!me?.permissions?.has("ManageChannels")) {
      console.error(`⚠️ 我方 bot 缺 Manage Channels 权限，建不了 #${EXCHANGE_NAME}`);
      return null;
    }
    const ch = await guild.channels.create({
      name: EXCHANGE_NAME,
      type: 0,
      topic: "跨 Claudestra agent 交流专用频道。所有 peer bot 被自动限制只能看到这里。",
    });
    await setLocalAgentExchangeId(ch.id);
    console.log(`✨ 建了 #${EXCHANGE_NAME} (${ch.id})`);
    return ch as TextChannel;
  } catch (e) {
    console.error(`⚠️ 建 #${EXCHANGE_NAME} 失败:`, e);
    return null;
  }
}

/**
 * 把 peer bot scope 到 #agent-exchange：所有其他文字频道 deny View，agent-exchange allow View/Send/ReadHistory。
 */
async function scopePeerToAgentExchange(
  member: any,
  exchange: TextChannel | null
): Promise<{ ok: boolean; modified: number; total: number; reason?: string }> {
  try {
    const guild = member.guild;
    if (!guild) return { ok: false, modified: 0, total: 0, reason: "没有 guild 上下文" };

    let peerBotRole = guild.roles.cache.find(
      (r: any) => r.managed && r.tags?.botId === member.id
    );
    if (!peerBotRole) {
      try { await guild.roles.fetch(); } catch { /* non-critical */ }
      peerBotRole = guild.roles.cache.find(
        (r: any) => r.managed && r.tags?.botId === member.id
      );
    }
    if (!peerBotRole) {
      return { ok: false, modified: 0, total: 0, reason: "找不到 peer bot 的 managed role" };
    }

    const me = guild.members.me;
    if (!me?.permissions?.has("ManageRoles") || !me.permissions.has("ManageChannels")) {
      return { ok: false, modified: 0, total: 0, reason: "我方 bot 缺 Manage Roles / Manage Channels 权限" };
    }

    const channels = guild.channels.cache.filter((c: any) =>
      c.type === 0 || c.type === 4 || c.type === 5
    );
    let modified = 0;
    for (const [, ch] of channels) {
      try {
        if (exchange && ch.id === exchange.id) {
          // agent-exchange：allow View + Send + ReadHistory
          await (ch as any).permissionOverwrites.edit(peerBotRole, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
          });
        } else {
          // 其他频道：deny View
          await (ch as any).permissionOverwrites.edit(peerBotRole, { ViewChannel: false });
        }
        modified++;
      } catch {
        // 个别失败不阻塞
      }
    }
    return { ok: true, modified, total: channels.size };
  } catch (e) {
    return { ok: false, modified: 0, total: 0, reason: (e as Error).message };
  }
}

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
      recordMetric("slash_invoked", { channelId, meta: { cmd } });

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

      // ── 转发给 Claude Code 的 slash（built-in / skill） ──
      {
        // 立即 defer，防止 3s Discord token 过期（lookup 可能耗时）
        await interaction.deferReply().catch(() => {});

        // 找 channel 对应的 agent
        let agentName: string | null = null;
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
          if (agent) agentName = agent.name;
        } catch { /* non-critical */ }

        // 如果没找到 agent，就是 master channel（control channel）
        const targetWindow = agentName ? `master:${agentName}` : `master:0`;
        const targetLabel = agentName || "master";

        // 收集 option 值
        const vals: Record<string, string> = {};
        for (const opt of interaction.options.data) {
          if (typeof opt.value === "string") vals[opt.name] = opt.value;
        }

        // 先检查是不是其他 agent 的 project skill
        const otherOwner = isProjectSkillForOtherAgent(cmd, agentName);
        if (otherOwner) {
          await interaction.editReply({
            content: `⚠️ \`/${cmd}\` 是 **${otherOwner}** 的项目级 skill，在当前频道（${targetLabel}）不可用。切到 ${otherOwner} 的频道再试。`,
          }).catch(() => {});
          return;
        }

        const resolved = resolveInvocation(cmd, agentName, vals);
        if (!resolved.ok) {
          await interaction.editReply({ content: `⚠️ ${resolved.reason}` }).catch(() => {});
          return;
        }

        console.log(`⚡ 转发 slash: /${cmd} → window=${targetWindow} text="${resolved.ccText}"`);
        try {
          await tmuxSendLine(targetWindow, resolved.ccText);
          // TUI 渲染需要几秒，截图作为反馈（否则像 /context 这类纯 TUI 命令 Discord 端完全没响应）
          await Bun.sleep(2500);
          await presentSlashResult(interaction, targetWindow, targetLabel, resolved.ccText);
        } catch (e) {
          console.error(`⚡ tmux 发送失败:`, e);
          await interaction.editReply({
            content: `❌ 发送失败：${(e as Error).message}`,
          }).catch(() => {});
        }
        return;
      }
    }

    // ── Buttons ──
    if (interaction.isButton()) {
      const id = interaction.customId;
      await interaction.deferUpdate().catch(async () => {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
      });

      // TUI modal 选项按钮 — 把键转发给 tmux，再截图 + 可能再出菜单
      if (id.startsWith("modal:")) {
        const rest = id.slice("modal:".length);
        const idx = rest.lastIndexOf(":");
        if (idx < 0) return;
        const targetWindow = rest.slice(0, idx);
        const key = rest.slice(idx + 1);
        await handleModalInteraction(interaction, targetWindow, key);
        return;
      }

      // 升级到大总管处理 — 把当前 agent 状态 + 截图 post 到 control 频道，master 自己 LLM 处理
      if (id.startsWith("escalate:")) {
        const rest = id.slice("escalate:".length);
        const idx = rest.indexOf(":");
        if (idx < 0) return;
        const targetWindow = rest.slice(0, idx);
        const ccText = decodeURIComponent(rest.slice(idx + 1));
        const agentName = targetWindow.replace(/^master:/, "");
        const controlChannelId = process.env.CONTROL_CHANNEL_ID || "";
        if (!controlChannelId) {
          await interaction.followUp({ content: "❌ 未配置 CONTROL_CHANNEL_ID，无法升级", ephemeral: true }).catch(() => {});
          return;
        }
        try {
          const pngPath = await tmuxScreenshot(agentName);
          const ctrlCh = (await discord.channels.fetch(controlChannelId)) as TextChannel;
          const msg = [
            `🤖 **需要你帮忙：** agent **${agentName}** 上的 \`${ccText}\` 的 TUI bridge 认不出，user 升级给你处理。`,
            ``,
            `你可以用这些 Bash 子命令控制这个 agent 的 tmux window：`,
            `- \`bun ../src/manager.ts tmux-screenshot ${agentName}\` — 截图（返回 PNG 路径，可用 Read 工具看）`,
            `- \`bun ../src/manager.ts tmux-capture ${agentName} [lines]\` — 读文本 pane`,
            `- \`bun ../src/manager.ts tmux-send-keys ${agentName} <keys...>\` — 发键（Enter/Escape/Left/Right/C-c/数字/字符串）`,
            `- \`bun ../src/manager.ts tmux-wait-idle ${agentName} [ms]\` — 等回到 idle`,
            ``,
            `请先截图看看现在 pane 什么状态，再决定怎么操作 + 用 reply 告诉原频道结果。原频道 channel_id=\`${interaction.channelId}\`。`,
          ].join("\n");
          await ctrlCh.send({
            content: msg,
            files: pngPath ? [{ attachment: pngPath }] : undefined,
          });
          await interaction.followUp({ content: `🤖 已升级到大总管（#control 频道），他会接手`, ephemeral: true }).catch(() => {});
          recordMetric("modal_button", { channelId: interaction.channelId, agent: agentName, meta: { action: "escalate", ccText } });
        } catch (e) {
          await interaction.followUp({ content: `❌ 升级失败：${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // Wedge Esc 救回按钮
      if (id.startsWith("wedge_esc:")) {
        const agentName = id.slice("wedge_esc:".length);
        try {
          await tmuxRaw(["send-keys", "-t", `master:${agentName}`, "Escape"]);
          clearWedgeState(agentName);
          await interaction.followUp({ content: `✅ 已发 Esc 到 ${agentName}`, ephemeral: true }).catch(() => {});
        } catch (e) {
          await interaction.followUp({ content: `❌ 发 Esc 失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // 打断按钮
      if (id.startsWith("interrupt:")) {
        const targetChannelId = id.slice("interrupt:".length);
        console.log(`⚡ 打断按钮点击: channel=${targetChannelId}`);
        try {
          // master (CONTROL_CHANNEL_ID) 和 #agent-exchange 都 route 到 master:0，
          // 但它们不在 registry.json 里 —— 直接认定目标是 master:0，不用查 registry
          const controlId = process.env.CONTROL_CHANNEL_ID || "";
          const { readPeers } = await import("./lib/peers.js");
          const peers = await readPeers().catch(() => ({ localAgentExchangeId: "" } as any));
          const exchangeId = (peers as any).localAgentExchangeId || "";
          const isMasterChannel =
            targetChannelId === controlId ||
            (exchangeId && targetChannelId === exchangeId);

          let targetWindow: string;
          let agentLabel: string;
          if (isMasterChannel) {
            targetWindow = `${MASTER_SESSION}:0`;
            agentLabel = "master";
          } else {
            const listResult = await runManager("list");
            const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
            if (!agent) {
              console.error(`⚡ 打断失败：channel=${targetChannelId} 找不到对应 agent`);
              await interaction.followUp({ content: "❌ 打断失败：找不到对应 agent", ephemeral: true }).catch(() => {});
              return;
            }
            targetWindow = `master:${agent.name}`;
            agentLabel = agent.name;
          }

          console.log(`⚡ 发送 C-c 到 tmux window: ${targetWindow}`);
          const proc = Bun.spawn(
            ["tmux", "-S", TMUX_SOCK, "send-keys", "-t", targetWindow, "C-c"],
            { stdout: "pipe", stderr: "pipe" }
          );
          const stderr = await new Response(proc.stderr).text();
          await proc.exited;
          if (proc.exitCode !== 0) {
            console.error(`⚡ tmux send-keys 失败 (exit=${proc.exitCode}): ${stderr}`);
            await interaction.followUp({ content: `❌ tmux 发送 C-c 失败: ${stderr}`, ephemeral: true }).catch(() => {});
            return;
          }
          console.log(`⚡ C-c 已发送给 ${agentLabel}`);
          recordMetric("agent_interrupt", { channelId: targetChannelId, agent: agentLabel, meta: { trigger: "button" } });

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
        } catch (e) {
          console.error(`⚡ 打断流程异常:`, e);
        }
        return;
      }

      // 权限弹窗 + session-idle 弹窗响应按钮
      const promptBtnPrefixes = [
        "perm_allow:", "perm_allow_session:", "perm_deny:",
        "session_summary:", "session_full:", "session_noask:",
      ];
      if (promptBtnPrefixes.some((p) => id.startsWith(p))) {
        const [action, targetChannelId] = id.split(":");
        // 按钮对应的 Claude Code 选项键
        const keyMap: Record<string, string> = {
          perm_allow: "1", perm_allow_session: "2", perm_deny: "3",
          session_summary: "1", session_full: "2", session_noask: "3",
        };
        const labelMap: Record<string, string> = {
          perm_allow: "✅ 已允许",
          perm_allow_session: "✅ 已允许（本会话不再问）",
          perm_deny: "❌ 已拒绝",
          session_summary: "✨ 从摘要恢复",
          session_full: "📜 恢复完整会话",
          session_noask: "🔕 不再询问",
        };
        const key = keyMap[action];
        const isPermBtn = action.startsWith("perm_");
        const isIdleBtn = action.startsWith("session_");
        console.log(`🔔 弹窗响应: channel=${targetChannelId} action=${action} key=${key}`);
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
          if (!agent) {
            await interaction.followUp({ content: "❌ 找不到对应 agent", ephemeral: true }).catch(() => {});
            return;
          }

          // 发键前再确认弹窗还在，避免把 digit+Enter 当成普通消息提交给 Claude
          const pane = await tmuxCapture(windowTarget(agent.name), 30);
          const hasPerm = detectRuntimePermissionPrompt(pane) !== null;
          const hasIdle = detectSessionIdlePrompt(pane) !== null;
          const dialogStillActive = (isPermBtn && hasPerm) || (isIdleBtn && hasIdle);

          if (!dialogStillActive) {
            console.log(`🔔 弹窗已关闭，跳过发键: channel=${targetChannelId} hasPerm=${hasPerm} hasIdle=${hasIdle}`);
            const msgId = permissionMessages.get(targetChannelId);
            if (msgId) {
              try {
                const ch = await discord.channels.fetch(targetChannelId) as TextChannel;
                const sm = await ch.messages.fetch(msgId);
                await sm.edit({ content: `🔕 弹窗已自动关闭，无需操作`, components: [] });
              } catch { /* non-critical */ }
              clearPermissionMessage(targetChannelId);
            }
            return;
          }

          const proc = Bun.spawn(
            ["tmux", "-S", TMUX_SOCK, "send-keys", "-t", `master:${agent.name}`, key, "Enter"],
            { stdout: "pipe", stderr: "pipe" }
          );
          await proc.exited;
          if (proc.exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            console.error(`🔔 tmux send-keys 失败: ${stderr}`);
          }

          // 编辑原消息显示已处理（保留指纹让下次 poll 自然清理，避免竞争条件）
          const msgId = permissionMessages.get(targetChannelId);
          if (msgId) {
            try {
              const ch = await discord.channels.fetch(targetChannelId) as TextChannel;
              const sm = await ch.messages.fetch(msgId);
              await sm.edit({ content: `🔔 ${labelMap[action]}`, components: [] });
            } catch { /* non-critical */ }
            permissionMessages.delete(targetChannelId);
          }
        } catch (e) {
          console.error(`🔔 权限响应流程异常:`, e);
        }
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

      // TUI modal 选择器
      if (id.startsWith("modal:")) {
        const rest = id.slice("modal:".length);
        // 格式：modal:<targetWindow>:select  —— 最后一段固定是 "select"
        const parts = rest.split(":");
        const targetWindow = parts.slice(0, -1).join(":");
        await handleModalInteraction(interaction, targetWindow, value);
        return;
      }

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
      clients.set(msg.channelId, { ws, channelId: msg.channelId, userId: msg.userId, cwd: msg.cwd });
      console.log(`📌 注册频道: ${msg.channelId} (共 ${clients.size} 个)`);
      ws.send(JSON.stringify({ type: "registered", channelId: msg.channelId }));

      // v1.9.0+: master 注册 CONTROL_CHANNEL_ID 时，顺便也把 #agent-exchange 指向同一个 ws
      // 这样 peer 在 #agent-exchange 里说的话也由 master 处理（不额外建 session）
      if (msg.channelId === (process.env.CONTROL_CHANNEL_ID || "")) {
        try {
          const { readPeers } = await import("./lib/peers.js");
          const peers = await readPeers();
          if (peers.localAgentExchangeId && peers.localAgentExchangeId !== msg.channelId) {
            // 注意 cwd 沿用 master 的（因为这一项指向同一个 ws，jsonl 抽取要走同一份）
            clients.set(peers.localAgentExchangeId, { ws, channelId: peers.localAgentExchangeId, userId: msg.userId, cwd: msg.cwd });
            console.log(`📌 也把 #agent-exchange (${peers.localAgentExchangeId}) 挂到 master ws`);
          }
        } catch { /* non-critical */ }
      }

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
        let text = msg.text?.replace(/\s*\[DONE\]\s*$/, "") || msg.text;
        // v1.8.9+: 跨 Claudestra 协作必须 @ peer bot 才能让对方 bridge 可靠识别
        //（老版本 peer 可能仍要求 @；新版虽然放行了也 @ 让语义明确，谁看到都知道在跟它说话）
        // 检查这个频道里有没有 peer bot（别的 bot + 不是我方），有就把没 @ 到的补一下
        text = await ensurePeerMentions(discord, msg.chatId, text || "");
        const ids = await discordReply(discord, msg.chatId, text, msg.replyTo, msg.components, msg.files);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { messageIds: ids } }));

        // v1.9.20+: 成功 reply 到 pending 的 intendedReplyChannel → 清 pending
        pendingReplies.delete(msg.chatId);

        // v1.9.21+ send_to_agent 推回机制：
        // 如果 reply 的 chat_id 正好是某个 pending send_to_agent 的 target agent 的
        // channel，说明 agent 在它自己的 channel 里发了答案（discord 看得到，供审计）；
        // bridge 同时把这段 text push 回 caller 的 ws 作为合成消息，caller 不用再轮询。
        const pending = pendingAgentCalls.get(msg.chatId);
        if (pending) {
          const agentName = msg.chatId; // 用 channel id 作为 label
          const pushMsg = {
            type: "message" as const,
            content: `[🤖 ${pending.targetName} 回复]\n${text.replace(/<@!?\d+>\s*/g, "").trim()}`,
            meta: {
              chat_id: pending.callerChannelId,
              message_id: `agent_reply_${Date.now()}`,
              user: pending.targetName,
              user_id: "agent",
              is_agent: "true",
              from_channel_id: msg.chatId,
              ts: new Date().toISOString(),
            },
          };
          try {
            pending.callerWs.send(JSON.stringify(pushMsg));
            lastMessageSource.set(pending.callerChannelId, "agent");
            console.log(`📨 AGENT PUSH-BACK: ${pending.targetName} 回复 → push 给 caller=${pending.callerChannelId} (免去 fetch_messages 轮询)`);
            recordMetric("agent_pushback", { channelId: pending.callerChannelId, meta: { targetName: pending.targetName } });
          } catch (e) {
            console.error("AGENT PUSH-BACK 发送失败:", e);
          }
          pendingAgentCalls.delete(msg.chatId);
        }
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

    case "rename_channel": {
      try {
        const ch = await discord.channels.fetch(msg.channelId);
        if (!ch || !("setName" in ch)) throw new Error("channel 不存在或不可重命名");
        await (ch as TextChannel).setName(msg.name);
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { ok: true } }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
      }
      break;
    }

    case "list_channels": {
      // 列出本 bot 能看到的所有文字频道。用于跨 Claudestra 场景：
      // peer 的 agent 自己看我这边有哪些频道、topic 是什么、该去哪里 @ 我的 bot。
      try {
        const channels: any[] = [];
        for (const [_, ch] of discord.channels.cache) {
          // 只要能发消息的文字频道（TextChannel type = 0）
          if (ch.type !== 0) continue;
          const textCh = ch as TextChannel;
          channels.push({
            id: textCh.id,
            name: textCh.name,
            topic: textCh.topic || "",
            guild: textCh.guild?.name || "",
            guild_id: textCh.guild?.id || "",
          });
        }
        ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { channels } }));
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

        // v1.9.22+: 解析 target，支持 peer: 语法：
        //   "future_data"                        → 本地 agent-future_data
        //   "peer:claudestra_ahh.future_data"    → 跨 peer，经 foreign #agent-exchange
        //   "future_data@claudestra_ahh"         → 同上（短格式）
        const rawTarget = (msg.targetName as string) || "";
        const peerMatch = rawTarget.match(/^peer:([^.]+)\.(.+)$/) || rawTarget.match(/^([^@]+)@(.+)$/);
        if (peerMatch) {
          const [, first, second] = peerMatch;
          // 根据前缀判断：peer:X.Y 是 X=peer name, Y=agent；Y@X 是 Y=agent, X=peer name
          const peerIdentifier = rawTarget.startsWith("peer:") ? first : second;
          const peerAgentName = rawTarget.startsWith("peer:") ? second : first;
          return await handlePeerRouteToAgent(ws, msg, fromChannelId, fromName, peerIdentifier, peerAgentName);
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
        const targetName = rawTarget.startsWith("agent-")
          ? rawTarget
          : `agent-${rawTarget}`;
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
        // v1.9.6+: send_to_agent 触发的 turn 不发完成 @（用户没在这个 channel 问问题）
        lastMessageSource.set(target.channelId, "agent");

        // v1.9.21+: 记 pending agent call。当 target agent 下一次 reply 到自己 channel
        // 时，bridge 把那段 text 也 push 回 caller 的 ws（免 fetch_messages 轮询）。
        if (fromChannelId) {
          pendingAgentCalls.set(target.channelId, {
            callerChannelId: fromChannelId,
            callerWs: ws,
            callerName: fromName,
            targetName,
            ts: Date.now(),
          });
        }

        ws.send(JSON.stringify({
          type: "response",
          requestId: msg.requestId,
          result: {
            ok: true,
            targetChannelId: target.channelId,
            targetName,
            pushBack: true, // v1.9.21+: 告诉 caller "agent 回复会自动 push 给你，不用轮询"
          },
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
// channelId → 最近一次完成通知时间戳，用于去抖
const lastCompletionSent = new Map<string, number>();
// v1.9.6+: 记录每个 channel 的最近一次消息触发源。如果是 "agent"（peer bot / send_to_agent 转发）
// 那次 turn 结束时就不发完成 @ — 用户没问问题，不用通知他
const lastMessageSource = new Map<string, "user" | "agent">();
const COMPLETION_DEDUPE_MS = 10_000; // 10 秒内不重复发完成通知

/**
 * v1.9.20+/v1.9.21: Stop hook 触发时兜底 master/agent 忘了 reply 的情况。
 *
 * **v1.9.21 升级**：不再只靠 NAG（NAG 的成功率受 LLM 自觉性影响），而是**优先**
 * 从 session jsonl 捞最近一条 assistant 文字**代 post** 到 intendedReplyChannel。
 * 捞不到才 fallback 到 NAG。这样保证"消息进 Discord 就一定有 Discord 回复"。
 *
 * stopChannelId: Stop hook 自己带的 channelId（我们据此找到触发 Stop 的那个 ws，
 *   只处理它名下的 pending，避免在 master Stop 时误清掉别的 agent 的 pending）
 * channelsToClear: 跟 stopChannelId 同 ws 的所有 channel（master 是
 *   {CONTROL, #agent-exchange}）
 */
/**
 * v1.9.22+ 对称 direct 路由：我方 bot 在对方 guild 的 foreign #agent-exchange 收到 @
 * 时，判断是否该走直接路由到我方 exposed agent。
 *
 * 信任模型（简化版，按 owner 要求）：
 *   - 消息在"我方 peer bot 能看见的 foreign #agent-exchange"（peerBots[].agentExchangeId）
 *   - @ 了我方 bot
 *   - 我方有唯一匹配 peer 的 direct exposure（按 peerBotId 或 "all"）
 *   - 人类发送者通过"信任传递"合法（peerBots 里登记过这个 peer 的 agentExchangeId，
 *     说明我们之前已经信任这个 peer；peer 在他自己的 #agent-exchange 里放进的人类就
 *     信任是 peer 的 authorized users，不额外鉴权）
 *
 * 返回 true 表示已处理（调用方 early return），false 表示没处理（调用方回到默认流程）。
 */
/**
 * v1.9.22+ 跨 peer 的 send_to_agent：调用方通过 `peer:X.Y` 或 `Y@X` 把请求
 * 发给 peer 的 agent。bridge 查 peers.json capabilities 验证、reply 到 peer 的
 * #agent-exchange @ 对方 bot 就 OK。同时记 pendingPeerCalls 在 peer bot 回复时
 * 把 text push 回 caller ws（跟 pendingAgentCalls 对称）。
 */
async function handlePeerRouteToAgent(
  ws: ServerWebSocket<unknown>,
  msg: any,
  fromChannelId: string,
  fromName: string,
  peerIdentifier: string,
  peerAgentName: string,
) {
  try {
    const { readPeers } = await import("./lib/peers.js");
    const peers = await readPeers();
    const peer = peers.peerBots.find((p) => p.id === peerIdentifier || p.name === peerIdentifier || p.name.startsWith(`${peerIdentifier}#`));
    if (!peer) {
      ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `未知 peer "${peerIdentifier}"。已登记的 peers: ${peers.peerBots.map((p) => p.name).join(", ") || "(无)"}` }));
      return;
    }
    const cap = peers.capabilities.find((c) => c.peerBotId === peer.id && c.peerAgent === peerAgentName);
    if (!cap) {
      ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `peer "${peer.name}" 没有开放 agent "${peerAgentName}"。已开放: ${peers.capabilities.filter((c) => c.peerBotId === peer.id).map((c) => c.peerAgent).join(", ") || "(无)"}` }));
      return;
    }

    // peer.agentExchangeId 是**我方 guild** 里的那个 shared #agent-exchange（peer bot 能看到）
    // —— 跟 peer 通信就发在这。若 capability 带了 peerAgentExchangeId（对方 guild 的），
    //   优先用那个（更明确），否则 fall back 到 peer.agentExchangeId。
    const targetChannelId = cap.peerAgentExchangeId || peer.agentExchangeId;
    if (!targetChannelId) {
      ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `找不到跟 peer "${peer.name}" 通信的 #agent-exchange channel` }));
      return;
    }

    // 通过 bridge 的 discord client 发送（不走 MCP reply，因为这是 bridge 主动发起）
    const textToSend = `<@${peer.id}> ${msg.text || ""}`.trim();
    const enriched = await ensurePeerMentions(discord, targetChannelId, textToSend);
    try {
      const ch = await discord.channels.fetch(targetChannelId);
      if (ch && "messages" in ch) {
        const sent = await (ch as TextChannel).send({ content: enriched });
        trackSentMessage(sent.id);
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: `发送到 peer 频道失败: ${(e as Error).message}` }));
      return;
    }

    // 记 pendingPeerCalls：下次这个 peer 在 shared channel 回复时，bridge push 给 caller
    pendingPeerCalls.set(targetChannelId, {
      callerChannelId: fromChannelId,
      callerWs: ws,
      callerName: fromName,
      peerBotId: peer.id,
      peerBotName: peer.name,
      peerAgent: peerAgentName,
      ts: Date.now(),
    });

    ws.send(JSON.stringify({
      type: "response",
      requestId: msg.requestId,
      result: {
        ok: true,
        targetChannelId,
        targetName: `peer:${peer.name}.${peerAgentName}`,
        pushBack: true,
      },
    }));
    console.log(`🎯 PEER ROUTE: ${fromName} → peer ${peer.name} agent ${peerAgentName} (channel ${targetChannelId})`);
    recordMetric("peer_route_send", { channelId: targetChannelId, meta: { peer: peer.name, peerAgent: peerAgentName } });
  } catch (err) {
    ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, error: (err as Error).message }));
  }
}

async function tryRouteForeignAgentExchange(msg: DiscordMessage, channelId: string): Promise<boolean> {
  try {
    const { readPeers, effectivePeerMode } = await import("./lib/peers.js");
    const peers = await readPeers();

    // 1. 确认 channelId 是某个 peer 的 foreign #agent-exchange（我们被 invite 进去的）
    const peerBotForChannel = peers.peerBots.find((p) => p.agentExchangeId === channelId);
    if (!peerBotForChannel) return false;
    // 如果是我们自己 guild 的本地 agent-exchange，不走这条（那条走 clients.get 正常路径）
    if (peers.localAgentExchangeId === channelId) return false;

    // 2. 找这个 peer 的 direct exposure（我们对这个 peer 开放的 agent）
    const directExposures = peers.exposures
      .filter((e) => (e.peerBotId === peerBotForChannel.id || e.peerBotId === "all") && effectivePeerMode(e) === "direct");

    if (directExposures.length === 0) {
      console.log(`🎯 SYMMETRIC: 收到 foreign #agent-exchange (${channelId}) 的 @ 但我方没对 ${peerBotForChannel.name} 开放任何 direct agent，忽略`);
      return false;
    }

    if (directExposures.length > 1) {
      console.log(`🎯 SYMMETRIC: foreign #agent-exchange 有 ${directExposures.length} 个候选（${directExposures.map((e) => e.localAgent).join("/")}），交给默认流程（其实 default 会 drop）`);
      return false;
    }

    const targetExp = directExposures[0];

    // 3. 找 target agent 的 ws
    const listResult = await runManager("list");
    const agents = (listResult.agents || []) as any[];
    const targetAgent = agents.find((a: any) =>
      a.name === targetExp.localAgent || a.name === `agent-${targetExp.localAgent}`
    );
    if (!targetAgent || targetAgent.status !== "active") {
      console.log(`🎯 SYMMETRIC fallback: target agent ${targetExp.localAgent} 不可用 (status=${targetAgent?.status ?? "missing"})`);
      return false;
    }
    const agentClient = clients.get(targetAgent.channelId);
    if (!agentClient) {
      console.log(`🎯 SYMMETRIC fallback: target agent ${targetAgent.name} 未连接 bridge`);
      return false;
    }

    // 4. 处理附件（跟主流程一样）
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
        } catch { /* skip */ }
      }
    }

    // 5. 构造消息内容，注入对称 direct header
    const rawText = (msg.content || "")
      .replace(new RegExp(`<@!?${getBotUserId()}>`, "g"), "")
      .trim();
    const senderKind = msg.author.bot ? `peer bot ${msg.author.username}` : `用户 ${msg.author.username}`;
    const contentLines = [
      `🤝 PEER DIRECT REQUEST (对称路由) — bridge 把这条来自**对方 guild** #agent-exchange 的 peer 请求直接路由给你处理`,
      ``,
      `来源：${senderKind} (id: \`${msg.author.id}\`) 在对方 guild 的 #agent-exchange (\`${channelId}\`)，通过 peer bot \`${peerBotForChannel.name}\` 的 shared 频道过来`,
      `你被 expose 给这个 peer 的理由：${targetExp.purpose || "（无描述）"}`,
      ``,
      `**最终动作必须是**：\`reply(chat_id="${channelId}", text="<你的答案>")\``,
      `- bridge 自动 @ peer bot，你不用自己加 \`<@id>\``,
      `- 如果这是最后一句在 text 末尾加 \`[EOT]\` 防止互 ack`,
      `- 不要 reply 到自己 channel；不要 send_to_agent 套娃；不要联系 master`,
      ``,
      `---`,
      `原始消息：`,
      rawText + (attachmentPaths.length > 0 ? `\n\n${attachmentPaths.map((p) => `[attachment: ${p}]`).join("\n")}` : ""),
    ];
    const content = contentLines.join("\n");

    const meta: Record<string, string> = {
      chat_id: channelId,
      message_id: msg.id,
      user: msg.author.username,
      user_id: msg.author.id,
      ts: msg.createdAt.toISOString(),
      peer_direct: "true",
      peer_reply_to: channelId,
      peer_bot_name: peerBotForChannel.name,
      peer_bot_id: peerBotForChannel.id,
    };
    if (attachmentPaths.length > 0) {
      meta.attachment_count = String(attachmentPaths.length);
      meta.attachments = attachmentPaths.join(";");
    }

    // 6. 设 pending + triggerSource
    pendingReplies.set(channelId, {
      msgId: msg.id,
      ts: Date.now(),
      nagged: false,
      intendedReplyChannel: channelId,
      targetWs: agentClient.ws,
    });
    lastMessageSource.set(agentClient.channelId, "agent");

    // 7. 发送
    agentClient.ws.send(JSON.stringify({ type: "message", content, meta }));
    console.log(`🎯 SYMMETRIC DIRECT: ${senderKind} 在 foreign #agent-exchange (${channelId}) → 路由到 ${targetAgent.name}`);
    recordMetric("peer_direct_route_symmetric", { channelId, meta: { sender: msg.author.id, agent: targetAgent.name } });
    return true;
  } catch (e) {
    console.error("tryRouteForeignAgentExchange 异常:", e);
    return false;
  }
}

/** v1.9.21+ 每分钟扫一次，清超过 10min 仍未被 agent 回复消化的 pendingAgentCalls。
 * 正常情况下 agent 会在几十秒内回 → 被 reply handler 清掉。残留条目只会发生在
 * agent 挂了 / 忘了回 / fetch_messages 被用户取消等极端场景。留太多占内存。 */
setInterval(() => {
  const now = Date.now();
  const STALE_MS = 10 * 60_000;
  for (const [channelId, pending] of pendingAgentCalls.entries()) {
    if (now - pending.ts > STALE_MS) {
      pendingAgentCalls.delete(channelId);
      console.log(`🧹 pendingAgentCalls stale: 清掉 target=${pending.targetName} (caller=${pending.callerName})`);
    }
  }
  for (const [channelId, pending] of pendingPeerCalls.entries()) {
    if (now - pending.ts > STALE_MS) {
      pendingPeerCalls.delete(channelId);
      console.log(`🧹 pendingPeerCalls stale: 清掉 target=${pending.peerBotName}/${pending.peerAgent}`);
    }
  }
}, 60_000).unref();

async function maybeRescueMissedReply(stopChannelId: string, channelsToClear: Set<string>): Promise<void> {
  const now = Date.now();
  const STALE_MS = 5 * 60_000;

  const stopClient = clients.get(stopChannelId);
  if (!stopClient) return;

  const { findLatestJsonl, extractLatestAssistantText } = await import("./lib/jsonl-extract.js");

  for (const cid of channelsToClear) {
    const pending = pendingReplies.get(cid);
    if (!pending) continue;

    // 只处理 pending 的 targetWs 属于这次 Stop 的 ws —— 避免 Stop A 误清 Stop B 的 pending
    if (pending.targetWs !== stopClient.ws) continue;

    if (now - pending.ts > STALE_MS) {
      pendingReplies.delete(cid);
      continue;
    }

    // 1. 优先抽 jsonl 代 post
    let rescued = false;
    if (stopClient.cwd) {
      try {
        const jsonlPath = await findLatestJsonl(stopClient.cwd);
        if (jsonlPath) {
          const extracted = await extractLatestAssistantText(jsonlPath, { sinceMs: pending.ts - 5_000 });
          if (extracted && extracted.trim().length > 0) {
            const rescuedText = `${extracted.trim()}\n\n_📋 [bridge 兜底] agent 本轮忘记调用 reply()，这段文字由 bridge 从 jsonl 抽取后代为发送_`;
            try {
              const textWithMentions = await ensurePeerMentions(discord, pending.intendedReplyChannel, rescuedText);
              await discordReply(discord, pending.intendedReplyChannel, textWithMentions);
              console.log(`🆘 RESCUE: 从 jsonl 抽取 assistant 文字代 post 到 channel=${pending.intendedReplyChannel} (${extracted.length} chars)`);
              recordMetric("reply_rescue_posted", { channelId: pending.intendedReplyChannel, meta: { chars: String(extracted.length), source: stopClient.channelId } });
              pendingReplies.delete(cid);
              rescued = true;
            } catch (e) {
              console.error(`🆘 RESCUE post 失败 channel=${pending.intendedReplyChannel}:`, e);
            }
          }
        }
      } catch (e) {
        console.error(`🆘 RESCUE jsonl 抽取异常 cwd=${stopClient.cwd}:`, e);
      }
    }

    if (rescued) continue;
    if (pending.nagged) continue; // 已 NAG 过，不再重复

    // 2. 捞不到文字（比如这一轮纯 tool_use 没产出 assistant text）→ fallback NAG
    pending.nagged = true;
    const nagContent = [
      `⚠️ [SYSTEM] 你刚才处理了 Discord channel \`${cid}\` 里的入站消息，但这一轮既没调 \`reply()\` 工具、也没产出文字答案（bridge 尝试从 jsonl 抽取代你 post，但没找到 text 内容）。`,
      ``,
      `立刻补一条：\`reply(chat_id="${cid}", text="<你的答案或'无法处理'的说明>")\``,
      ``,
      `（这是 bridge 自动检测到 reply 缺失触发的 NAG，只 nag 一次，再不调就放弃。）`,
    ].join("\n");

    try {
      stopClient.ws.send(JSON.stringify({
        type: "message",
        content: nagContent,
        meta: { nag: "true", channel_id: cid, missed_msg_id: pending.msgId },
      }));
      console.log(`📢 NAG: 没抽到 text，发 SYSTEM NAG 给 channel=${cid} (msg=${pending.msgId})`);
      recordMetric("master_nag_missed_reply", { channelId: cid, meta: { missedMsgId: pending.msgId } });
    } catch (e) {
      console.error(`📢 NAG 注入失败 channel=${cid}:`, e);
    }
  }
}

async function handleHookRequest(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { channelId: string; event: string };
    const { channelId, event } = body;
    if (!channelId || !event) {
      return new Response("Missing channelId or event", { status: 400 });
    }

    // 所有 hook 事件都停 typing / 清 safety timer
    // 兼容旧版 hook 发的 "stop"
    if (event === "Stop" || event === "StopFailure" || event === "Notification" || event === "stop") {
      console.log(`🏁 Hook 收到 ${event}: channel=${channelId}`);
      stopTyping(channelId);
      clearSafetyTimer(channelId);

      // v1.9.3+: #agent-exchange 挂到 master 的 ws（跟 CONTROL 共用同一个 Claude Code session），
      // master 的 Stop hook 只带 CONTROL 的 channelId；如果不同时停 agent-exchange 的 typing，
      // peer 请求触发的 typing indicator 会永远卡在那里。
      // 解决：找出跟当前 channel 共用同一个 ws 的所有其他 channel，一并 stopTyping + clearSafetyTimer。
      const thisClient = clients.get(channelId);
      if (thisClient) {
        for (const [otherId, info] of clients.entries()) {
          if (otherId !== channelId && info.ws === thisClient.ws) {
            stopTyping(otherId);
            clearSafetyTimer(otherId);
          }
        }
      }

      // 只有 Stop / StopFailure 触发完成通知，Notification 不触发（避免 Stop+Notification 连发两次）
      // 同时 10 秒内去抖，防止 Claude Code 重复 fire Stop 事件
      let shouldNotify = event === "Stop" || event === "StopFailure" || event === "stop";
      const now = Date.now();
      const last = lastCompletionSent.get(channelId) || 0;
      if (shouldNotify && now - last < COMPLETION_DEDUPE_MS) {
        console.log(`🏁 去抖跳过（${Math.round((now - last) / 1000)}s 内已发过）: channel=${channelId}`);
        return new Response("ok");
      }

      // v1.9.6+: 如果最近一次 message 来自 agent（peer bot / send_to_agent 转发），
      // 这次 Stop 是"为 agent 工作" — 用户没问过问题，不用 @ 他
      if (shouldNotify && lastMessageSource.get(channelId) === "agent") {
        console.log(`🏁 跳过完成通知（上一次消息来自 agent，非 user 触发）: channel=${channelId}`);
        shouldNotify = false;
      }

      // 防御性：等 Claude Code TUI 稳定下来（~1.5s），再看 pane 状态确认真的"完成"。
      // 有几种场景 Stop 会提前触发：
      //   - pane 上有权限/session-idle 弹窗 → Claude 实际在等用户输入
      //   - pane 不在 ❯ idle 提示符 → Claude 可能在下一步（工具调用流转等）
      // 这两种都应该跳过完成通知，等真正 idle 时的下一个 Stop 事件再发。
      if (shouldNotify) {
        await Bun.sleep(1500);
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
          if (agent) {
            const target = windowTarget(agent.name);
            const pane = await tmuxCapture(target, 30);
            if (detectRuntimePermissionPrompt(pane) || detectSessionIdlePrompt(pane)) {
              console.log(`🏁 pane 有弹窗，跳过完成通知: channel=${channelId} agent=${agent.name}`);
              shouldNotify = false;
            } else {
              const { isIdle } = await import("./lib/tmux-helper.js");
              const idle = await isIdle(target);
              if (!idle) {
                console.log(`🏁 Stop 触发但 pane 不是 ❯ idle 状态，Claude 还在工作 → 跳过这次通知，等下一个 Stop: channel=${channelId} agent=${agent.name}`);
                shouldNotify = false;
              }
            }
          }
        } catch { /* non-critical */ }
      }

      // 收集所有需要清状态消息的 channel：Stop hook 本身的 channelId + 所有共享同一个 ws 的其他 channel
      // （比如 master 的 #agent-exchange）。否则 peer 消息走 #agent-exchange 触发的"💭 大聪明思考中..."
      // 按钮永远不会变成"✅ 完成"，interrupt 按钮一直挂着。
      const channelsToClear = new Set<string>([channelId]);
      const thisClientForStatus = clients.get(channelId);
      if (thisClientForStatus) {
        for (const [otherId, info] of clients.entries()) {
          if (otherId !== channelId && info.ws === thisClientForStatus.ws) {
            channelsToClear.add(otherId);
          }
        }
      }

      // 把所有相关 channel 的"💭 思考中..."状态消息改成"✅ 完成"并去掉 interrupt 按钮
      for (const cid of channelsToClear) {
        const statusMsgId = activeStatusMessages.get(cid);
        if (!statusMsgId) continue;
        try {
          const ch = await discord.channels.fetch(cid);
          if (ch && "messages" in ch) {
            const sm = await (ch as TextChannel).messages.fetch(statusMsgId);
            await sm.edit({ content: "✅ 完成", components: [] });
          }
        } catch { /* non-critical */ }
        activeStatusMessages.delete(cid);
      }

      // 发完成通知消息 + @ 用户（仅 Stop/StopFailure）
      if (shouldNotify) {
        try {
          const ch = await discord.channels.fetch(channelId);
          if (ch && "messages" in ch) {
            const textCh = ch as TextChannel;
            const mention = ALLOWED_USER_IDS.length > 0 ? `<@${ALLOWED_USER_IDS[0]}>` : "";
            if (mention) {
              await textCh.send(`${randomUmaDone()} ${mention}`);
              lastCompletionSent.set(channelId, now);
              console.log(`🏁 完成通知已发送: channel=${channelId}`);
              recordMetric("agent_completed", { channelId });
            }
          }
        } catch (e) {
          console.error(`🏁 完成通知发送失败:`, e);
        }
      }

      // v1.9.20+/v1.9.21: Stop hook reply 缺失兜底。master/agent 忘调 reply →
      // 优先从 session jsonl 抽 assistant 文字代 post；抽不到再 NAG 强制再跑一轮。
      await maybeRescueMissedReply(channelId, channelsToClear);
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

    // Skills 重新扫描（manager 在 create/resume/kill 后调）
    if (url.pathname === "/skills/rescan" && req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as {
          agent?: string;
          cwd?: string;
          action?: "add" | "remove" | "full";
        };
        const action = body.action || "full";
        if (action === "remove" && body.agent) {
          clearProjectSkills(body.agent);
          clearWedgeState(body.agent);
        } else if (action === "add" && body.agent && body.cwd) {
          await scanProjectSkills(body.agent, body.cwd);
        } else {
          // full rescan
          await scanGlobalSkills();
          try {
            const listResult = await runManager("list");
            for (const a of listResult.agents || []) {
              if (a.status === "active" && a.cwd) {
                await scanProjectSkills(a.name, a.cwd);
              } else {
                clearProjectSkills(a.name);
              }
            }
          } catch { /* non-critical */ }
        }
        await registerSlashCommands();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // v1.9.0+: peer-expose / peer-revoke CLI 通过这里触发广播（在 #agent-exchange 发带 PeerEvent 标记的消息）
    if (url.pathname === "/peer/announce" && req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as {
          kind: "grant" | "revoke";
          local: string;
          peer: string; // peer bot id 或 "all"
          purpose?: string;
          mode?: "direct" | "via_master";
        };
        const { readPeers, encodePeerEvent } = await import("./lib/peers.js");
        const peers = await readPeers();
        if (!peers.localAgentExchangeId) {
          return new Response(JSON.stringify({ ok: false, error: "没找到 #agent-exchange（还没有 peer 加入过？）" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const ch = await discord.channels.fetch(peers.localAgentExchangeId).catch(() => null);
        if (!ch || !("messages" in ch)) {
          return new Response(JSON.stringify({ ok: false, error: "agent-exchange 频道不存在" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        const event = encodePeerEvent({
          kind: body.kind,
          local: body.local,
          peer: body.peer,
          purpose: body.purpose,
          exchange: peers.localAgentExchangeId,
          mode: body.mode,
        });
        // 找目标 peer 的 @mention（如果是 "all" 就 @ 所有 peer bot）
        let atMentions = "";
        if (body.peer === "all") {
          atMentions = peers.peerBots.map((p) => `<@${p.id}>`).join(" ");
        } else {
          atMentions = `<@${body.peer}>`;
        }
        const humanMsg =
          body.kind === "grant"
            ? `🤝 **开放 agent**: 我这边 **${body.local}** 对 ${atMentions} 开放${body.purpose ? `（${body.purpose}）` : ""}。可以直接在本频道 @ 我 bot 问这 agent 处理的话题。`
            : `🚫 **撤销**: 我这边 **${body.local}** 对 ${atMentions} 的开放已撤回。`;
        await (ch as TextChannel).send({ content: `${event}\n${humanMsg}` });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
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
