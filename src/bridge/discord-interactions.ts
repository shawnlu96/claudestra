/**
 * Discord 交互处理：按钮 / 选择菜单 / slash 命令 / TUI modal 适配。
 *
 * 从 bridge.ts 原样搬出（D5-4）。约束：
 * - import 时零副作用——只定义函数；bridge.ts 在 new Client 之后、login 之前调
 *   registerInteractionHandlers(discord, deps)（与原 discord.on("interactionCreate")
 *   同一位置，事件注册顺序不变）；
 * - bridge.ts 本地的状态与函数（ws 会话表、deliver、typing、clear 轮转收尾、Discord
 *   allowlist）经 deps 显式注入，本模块不反向 import bridge.ts。
 */

import { t } from "../lib/i18n.js";
import { TextChannel, type Client, type Interaction } from "discord.js";
import { TMUX_SOCK } from "./config.js";
import { stopTyping, buildComponents } from "./components.js";
import { tmuxScreenshot } from "./screenshot.js";
import { isAutoPermButton, parseAutoPermButton, autoRevertButtonId } from "./auto-allow.js";
import { resetToolTracking, agentNameForChannel } from "./jsonl-watcher.js";
import { emitEvent } from "./event-bus.js";
import { permissionMessages, clearPermissionMessage } from "./permission-watcher.js";
import { clearWedgeState } from "./wedge-watcher.js";
import { forceRefreshStatsDashboard, noteSaveCompactInjected } from "./stats-dashboard.js";
import { parseAuqPane } from "../lib/auq-pane.js";
import { recordMetric } from "../lib/metrics.js";
import { describeKeys, interruptWindow } from "../lib/runtimes/window-ops.js";
import {
  tmuxCapture,
  windowTarget,
  detectRuntimePermissionPrompt,
  detectSessionIdlePrompt,
  tmuxSendLine,
  tmuxRaw,
  tmuxSendEscape,
  parseModalOptions,
  detectArrowNavModal,
  detectPermissionMode,
  btabStepsTo,
  MASTER_SESSION,
  type ArrowNavKind,
} from "../lib/tmux-helper.js";
import { resolveInvocation, isProjectSkillForOtherAgent } from "./slash-registry.js";
import { newThreadId } from "./router.js";
import { clearSafetyTimer, trackStatusMessage, statusMessageIdFor, finishStatusMessage, agentActionButtons } from "./discord-adapter.js";
import type { ServerWebSocket } from "bun";
import type { Envelope, Delivery } from "./router.js";

/** bridge.ts 注入的依赖（都是 bridge 进程内的单例；函数引用，不是快照）。 */
export interface InteractionDeps {
  /** Discord 入站白名单（fail-closed：空 = 谁都不放行） */
  allowedDiscordIds: () => string[];
  /** channelId → channel-server ws 会话 */
  clients: Map<string, { ws: ServerWebSocket<unknown>; channelId: string; cwd?: string }>;
  /** master 的控制频道 id（未配置 = ""） */
  controlChannelId: string;
  deliver: (env: Envelope) => Promise<Delivery>;
  startTypingWithSafety: (channelId: string) => void;
  scheduleClearRotation: (agentName: string, channelId: string, cwd: string, oldSid?: string, runtime?: string) => void;
  /** manager CLI 调用与 LLM-free 管理面板：management.ts 是 hub，bridge/* 不直接 import，由 bridge 注入 */
  runManager: RunManager;
  buildStatusPanel: () => Promise<{ text: string; components: any[] }>;
  handleMgmtButton: (id: string, chatId: string, messageId?: string, discord?: Client) => Promise<MgmtReply | null>;
  handleMgmtSelect: (id: string, value: string, chatId: string, discord: Client) => Promise<MgmtReply | null>;
}

type RunManager = (...args: string[]) => Promise<any>;
type MgmtReply = { text: string; components?: any[] };

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
// Interaction 处理（按钮、菜单、Slash Commands）
// ============================================================

/**
 * v2.4.22+ agent 频道消息底部的通用操作按钮行。挂在「💭 思考中」/「✅ 完成」/
 * button-click 回执这些**永远在频道底部、正文里**的消息上，用户一眼就能点 ——
 * 不用翻 pin（pin 弹窗里按钮 Discord 点不动）、不用打 /focus。
 * withInterrupt=true 时带打断（工作中），完成态不带。
 */

/** v2.4.22+ button 触发截图（复用 /screenshot slash 的逻辑）。返回 png 路径或 null。 */
async function captureChannelScreenshot(channelId: string, runManager: RunManager): Promise<string | null> {
  const listResult = await runManager("list");
  const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
  const windowName = agent ? agent.name : "master";
  console.log(`📸 截图（button）: window=${windowName} channel=${channelId}`);
  return tmuxScreenshot(windowName);
}

/**
 * v2.4.19+ 把 iTerm2 切到某 channel 对应的 tmux tab。button（focus:）和 /focus 共用。
 * 主路径（v2.5.4 定版）：activate 本机 iTerm → tmux select-window → iTerm 自己的
 * CC 跟随切 tab（前台 1s 内稳定；对远端 ssh -CC attach 的 iTerm 同样生效）。
 * 位置序号 AppleScript 只做验证失败后的本机兜底。
 */
async function focusITermTab(targetChannelId: string, controlId: string, runManager: RunManager): Promise<{ ok: boolean; found: boolean; label: string; note: string }> {
  let targetWindow: string;
  let label: string;
  if (targetChannelId === controlId) {
    targetWindow = `${MASTER_SESSION}:0`;
    label = "master";
  } else {
    const listResult = await runManager("list");
    const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
    if (!agent) {
      return { ok: false, found: false, label: "?", note: "❌ 找不到对应 agent（可能已被 kill）" };
    }
    targetWindow = `${MASTER_SESSION}:${agent.name}`;
    label = agent.name;
  }

  // v2.5.4 定版方案：**先 activate 再 select-window，让 iTerm 自己的 CC 跟随干活**。
  //
  // 实验结论（2026-07-08，逐秒观测）：iTerm CC 模式对 tmux 的 window-changed 通知，
  // 前台时 1 秒内稳定跟随；后台时 15s+ 有意忽略（spinner 还在动 = 不是卡死/App Nap，
  // 是防后台抢 tab 焦点的设计）。之前"后台随缘"的根因就是这个 —— 所以把 iTerm 先
  // activate 到前台再 select-window，跟随就从随缘变确定。这同时惠及**所有** -CC
  // client：远端设备 ssh attach 的 iTerm（AppleScript 够不着的那台）也收到同一条
  // select-window 通知，它在用户手上通常本来就是前台 → 一并跟随。
  // 「位置序号选 tab」降级为验证失败后的兜底（它假设单窗口 + tab 顺序==window 顺序，
  // 散窗时会错，不再当主路径）。

  const idxList = (await tmuxRaw(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_index}"]).catch(() => "")).split("\n").filter(Boolean);
  const targetIdx = (await tmuxRaw(["display-message", "-p", "-t", targetWindow, "#{window_index}"]).catch(() => "")).trim();
  const ordinal = idxList.indexOf(targetIdx) + 1; // 1-based 位置（兜底 + 验证用）
  const tmuxCount = idxList.length;

  const clientsOut = await tmuxRaw(["list-clients", "-t", MASTER_SESSION]).catch(() => "");
  const hasCC = /control/.test(clientsOut);

  /** 跑一段 AppleScript，8s 超时 kill（iTerm 无响应时不拖垮 focus）。 */
  const osaRun = async (script: string): Promise<string> => {
    const p = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const out = await Promise.race([
      new Response(p.stdout).text().then((t) => t.trim()),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 8000)),
    ]);
    if (out === "timeout") { try { p.kill(); } catch {} }
    await p.exited.catch(() => {});
    return out;
  };

  // 1) iTerm 提到前台（唤醒 CC 跟随）。远程 attach 时本机没开 iTerm 也无妨，照样走 2)。
  await osaRun('tell application "iTerm2" to activate');

  // 2) 切 tmux window —— 所有 -CC client（本机 + 远端）同时收到通知，前台的会跟。
  //
  // 曾把「给远端弹 macOS 通知」的所有路径都实验过（2026-07-08），全部否决，别再试：
  // - 临时 window 发裸 OSC 9：能弹，但点击必然跳到临时窗口（OSC 9 点击跳发出者 tab）；
  // - run-shell 注入目标 pane：输出不进 pane 的终端流，通知不发；
  // - Claude Code `!` bash mode 从目标 pane 发：输出被 CC 捕获渲染在 TUI 里（⎿ 框），
  //   不写入 pty，OSC 9 到不了 iTerm，还在 agent 会话留痕迹；忙时注入更是排队且不可控。
  await tmuxRaw(["select-window", "-t", targetWindow]).catch(() => {});

  // 2b) 1.8s 后单次补切（owner 批准，非循环）。对抗 iTerm 的防回显竞态：iTerm 因
  // App 焦点事件上报自己 tab 时会预扣 _ignoreWindowChangeNotificationCount 计数器
  // （iTerm2 源码 TmuxController.m），把我们这条切换通知误当回显吃掉，还把旧 tab 回写
  // 覆盖 tmux（把别的 attach 端拉回去）。补发一次：第一发被误吃时计数器已消耗，第二发
  // 必然生效；第一发已生效时第二发是 no-op。
  setTimeout(() => {
    tmuxRaw(["select-window", "-t", targetWindow]).catch(() => {});
  }, 1800);

  // 3) 给 1.5s 跟随，然后验证本机 iTerm 的 current tab 序号是否 == 目标序号。
  let outcome = "noattach";
  if (hasCC && ordinal >= 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const idx = await osaRun('tell application "iTerm2" to return index of current tab of current window');
    if (idx === String(ordinal)) {
      outcome = "ok";
    } else {
      // 4) 没跟上（如本机 iTerm 根本没有 CC 窗口 = 远程 attach）→ 位置序号法兜底强制切。
      const forced = await osaRun([
        'tell application "iTerm2"',
        '  repeat with w in windows',
        `    if (count of tabs of w) is ${tmuxCount} then`,
        `      select tab ${ordinal} of w`,
        '      select w',
        '      return "ok"',
        '    end if',
        '  end repeat',
        '  return "nolocal"',
        'end tell',
      ].join("\n"));
      outcome = forced || "err";
    }
  }

  const found = outcome === "ok";
  console.log(`🖥 focus: ${targetWindow} → tab #${ordinal}/${tmuxCount} outcome=${outcome} (hasCC=${hasCC})`);
  let note: string;
  if (found) {
    note = `🖥 已跳到 **${label}** 的 iTerm tab`;
  } else if (!hasCC) {
    note = `🖥 当前没有 -CC attach，无法切 tab（tmux 内部已切到 **${label}**，attach 后可见）`;
  } else if (outcome === "nolocal") {
    note = `🖥 tmux 已切到 **${label}**。你像是**远程 attach**（本机没有 CC 窗口）—— 远端 iTerm 前台会自动跟着切，没跟就手动点下 tab`;
  } else if (outcome === "timeout") {
    note = `🖥 tmux 已切到 **${label}**，本机 iTerm 的 AppleScript 无响应（超时跳过）。前台 iTerm 会自动跟随`;
  } else {
    note = `🖥 tmux 已切到 **${label}**，但本机 iTerm tab 没跟上（outcome=${outcome}）`;
  }
  return { ok: true, found, label, note };
}

/**
 * v2.5.4+ 触发某个 agent 的「存记忆 + Compact」：往它的 tmux 发 /save-compact
 * （随包 skill：先挑重点存记忆 —— 有 mem0 用 mem0，没有用 CC 自带 memory ——
 * 再自动安排 /compact）。看板 select 和档位提醒按钮共用。agent 正忙也照发，
 * TUI 会排队，轮到时执行（跟 cron --target-agent 一个假设）。
 */
async function triggerSaveCompact(interaction: any, targetChannelId: string, runManager: RunManager): Promise<void> {
  try {
    const listResult = await runManager("list");
    const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
    if (!agent) {
      await interaction.followUp({ content: "❌ 找不到对应 agent（可能已被 kill）", ephemeral: true }).catch(() => {});
      return;
    }
    noteSaveCompactInjected(`master:${agent.name}`);
    await tmuxSendLine(`master:${agent.name}`, "/save-compact");
    console.log(`🧹 save-compact 已发送: ${agent.name} (channel=${targetChannelId})`);
    await interaction
      .followUp({
        content: `🧹 已让 **${String(agent.name).replace(/^agent-/, "")}** 存记忆 + compact（正忙的话会排队，做完它会在自己频道汇报）`,
        ephemeral: true,
      })
      .catch(() => {});
  } catch (e) {
    console.error("🧹 save-compact 触发失败:", e);
    await interaction.followUp({ content: `❌ 触发失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
  }
}

/**
 * 挂上 interactionCreate 监听。只调一次（bridge.ts 在 new Client 之后、login 之前，原位置）。
 * 处理本体单独成函数：包在这里面会让闸门把它算成两个超长函数。
 */
export function registerInteractionHandlers(discord: Client, deps: InteractionDeps): void {
  discord.on("interactionCreate", (interaction: Interaction) => handleInteraction(discord, deps, interaction));
}

async function handleInteraction(discord: Client, deps: InteractionDeps, interaction: Interaction): Promise<void> {
  const { allowedDiscordIds, clients, controlChannelId: CONTROL_CHANNEL_ID, deliver, startTypingWithSafety } = deps;
  const { scheduleClearRotation, runManager, buildStatusPanel, handleMgmtButton, handleMgmtSelect } = deps;
  try {
    const channelId = interaction.channelId;
    console.log(`🎯 Interaction: type=${interaction.type} channel=${channelId} user=${interaction.user?.id}`);
    if (!channelId) return;

    // fail-closed，同 messageCreate：空 allowlist 不再等于放行所有。按钮和 slash
    // 命令能直接触发 kill / restart / 发键，门禁标准不该比消息更松。
    const allowIds = allowedDiscordIds();
    if (allowIds.length === 0) {
      console.warn(
        `🚫 ALLOWED_USER_IDS 为空，已拒绝 ${interaction.user.id} 的交互。请在 .env 里配置后重载 bridge。`
      );
      return;
    }
    if (!allowIds.includes(interaction.user.id)) {
      console.log(`🚫 用户 ${interaction.user.id} 不在允许列表（principals/.env）中`);
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
          const keys = await interruptWindow(`master:${agent.name}`, agent.runtime).catch((e: Error) => e);
          if (keys instanceof Error) return void (await interaction.reply(`❌ 发送打断键失败: ${keys.message}`));
          if (!keys.length) return void (await interaction.reply(`💤 ${agent.name} 当前空闲，无需打断`));
          stopTyping(channelId);
          clearSafetyTimer(channelId);
          // 同打断按钮：被打断的回合没有 Stop hook，主动收尾 done
          emitEvent({ agent: agent.name, chatId: channelId, type: "agent_status", data: { status: "done", trigger: "interrupt" } });
          await finishStatusMessage(discord, channelId, t("⚡ 已打断", "⚡ Interrupted"));
          await interaction.reply(`⚡ 已发送 ${describeKeys(keys)}`);
        } else {
          await interaction.reply("⚠️ 当前频道没有关联的 agent");
        }
        return;
      }

      if (cmd === "focus") {
        // v2.4.20+ 可靠版跳 iTerm tab（不依赖 pin 弹窗里的按钮）。ephemeral 回执。
        try {
          await interaction.deferReply({ ephemeral: true });
        } catch { return; }
        try {
          const r = await focusITermTab(channelId, CONTROL_CHANNEL_ID, runManager);
          await interaction.editReply({ content: r.note }).catch(() => {});
        } catch (e) {
          await interaction.editReply({ content: `❌ 切换失败: ${(e as Error).message}` }).catch(() => {});
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

      // v2.7+ /agents —— Claude 会话总览（前台/后台/分身检测/清理/收编）
      if (cmd === "agents") {
        await interaction.deferReply();
        const panel = await handleMgmtButton("show_sessions_panel", channelId);
        if (panel) {
          const components = panel.components ? buildComponents(panel.components) : undefined;
          await interaction.editReply({ content: panel.text, components });
        } else {
          await interaction.editReply("❌ 无法获取会话清单");
        }
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
        let agentCwd: string | null = null;
        let agentSid: string | undefined;
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === channelId);
          if (agent) {
            agentName = agent.name;
            agentCwd = agent.project ? String(agent.project).replace(/^~/, process.env.HOME || "~") : null;
            agentSid = agent.sessionId || undefined;
          }
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
          // v2.16.2 Discord slash 的 /model 同样登记切换意图 → watcher 代按二次确认
          if (cmd === "model" && agentName) {
            const { noteModelSwitchIntent } = await import("./permission-watcher.js");
            const { resolveModelAlias } = await import("../lib/claude-launch.js");
            const arg = resolved.ccText.replace(/^\/model\s*/, "").trim();
            if (arg) noteModelSwitchIntent(agentName, resolveModelAlias(arg));
          }
          // 直通 /clear 同样轮转 session——与 clear 端点一样挂轮转收尾（Web 直通
          // 同款补丁；master 无 registry/watcher 不需要）。Stop 自愈是最后兜底。
          if (cmd === "clear" && agentName && agentCwd) {
            scheduleClearRotation(agentName, channelId, agentCwd, agentSid);
          }
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

      // 用量看板「🔄 刷新」按钮 — 强制立即刷新（deferUpdate 已 ack，doUpdate 会编辑消息）
      if (id === "stats_refresh") {
        forceRefreshStatsDashboard(discord).catch((e) => console.error("📊 手动刷新失败:", e));
        return;
      }

      // v2.5.4+ 「🧹 存记忆 + Compact」按钮（上下文档位提醒消息上的）
      if (id.startsWith("savecompact:")) {
        const targetChannelId = id.slice("savecompact:".length);
        await triggerSaveCompact(interaction, targetChannelId, runManager);
        return;
      }

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
        const controlChannelId = CONTROL_CHANNEL_ID;
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
          await tmuxSendEscape(`master:${agentName}`);
          clearWedgeState(agentName);
          await interaction.followUp({ content: `✅ 已发 Esc 到 ${agentName}`, ephemeral: true }).catch(() => {});
        } catch (e) {
          await interaction.followUp({ content: `❌ 发 Esc 失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // v2.0.23+: agent 掉线（claude 退到 shell）的重启按钮
      if (id.startsWith("wedge_restart:")) {
        const agentName = id.slice("wedge_restart:".length);
        try {
          await interaction.followUp({ content: `🔄 正在重启 ${agentName}...`, ephemeral: true }).catch(() => {});
          const result = await runManager("restart", agentName);
          clearWedgeState(agentName);
          const ok = result?.ok;
          await interaction.followUp({
            content: ok ? `✅ ${agentName} 已重启` : `❌ 重启失败: ${result?.error || result?.message || "未知错误"}`,
            ephemeral: true,
          }).catch(() => {});
        } catch (e) {
          await interaction.followUp({ content: `❌ 重启失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // v2.2.0+: auto 拦截「临时放行并重试」—— Shift+Tab 运行时切到 bypass + 注入重试
      if (isAutoPermButton(id)) {
        // 切回的目标 = 放行前记下的模式（编在 revert 按钮 id 里），见 bridge/auto-allow.ts
        const { isAllow, channelId: targetChannelId, target } = parseAutoPermButton(id)!;
        try {
          const listResult = await runManager("list");
          const agent = (listResult.agents || []).find((a: any) => a.channelId === targetChannelId);
          if (!agent) {
            await interaction.followUp({ content: "❌ 找不到对应 agent", ephemeral: true }).catch(() => {});
            return;
          }
          const win = `master:${agent.name}`;
          const pane = await tmuxCapture(windowTarget(agent.name), 12);
          const cur = detectPermissionMode(pane);
          if (!cur) {
            await interaction.followUp({ content: "❌ 认不出当前权限模式，请手动 shift+tab 切", ephemeral: true }).catch(() => {});
            return;
          }
          const steps = btabStepsTo(cur, target);
          if (steps < 0) {
            await interaction.followUp({
              content: `❌ 切不到 ${target}（这个 agent 启动没带 allow-flag？需 restart 一次更新）`,
              ephemeral: true,
            }).catch(() => {});
            return;
          }
          // 发 steps 下 Shift+Tab（tmux 里是 BTab）
          for (let i = 0; i < steps; i++) {
            await tmuxRaw(["send-keys", "-t", win, "BTab"]);
            await Bun.sleep(150);
          }
          await Bun.sleep(300);
          const after = detectPermissionMode(await tmuxCapture(windowTarget(agent.name), 12));
          console.log(`⚡ auto_${isAllow ? "allow" : "revert"}: ${agent.name} ${cur}→${after} (${steps} BTab)`);

          if (isAllow) {
            // 切到 bypass 后，注入「重试」让 agent 重做被拦的操作
            const client = clients.get(targetChannelId);
            if (client) {
              startTypingWithSafety(targetChannelId);
              client.ws.send(JSON.stringify({
                type: "message",
                content: `[系统] 刚才被 auto 模式拦下的操作，用户已临时放行（已切到 bypass permissions）。请重试那个操作。完成后简单说一句，方便用户把你切回原来的模式（${cur}）。`,
                meta: { chat_id: targetChannelId, message_id: "", user: interaction.user.username, user_id: interaction.user.id, ts: new Date().toISOString() },
              }));
            }
            const note = after === "bypassPermissions" ? "已临时切到 bypass 并让它重试" : `尝试切 bypass（当前检测=${after || "?"}）并让它重试`;
            await interaction.message?.edit({
              content: `⚡ ${agent.name}：${note}。完事点下面切回 ${cur}。`,
              components: buildComponents([
                { type: "buttons", buttons: [{ id: autoRevertButtonId(targetChannelId, cur), label: `切回 ${cur}`, emoji: "🔒", style: "secondary" }] },
              ]),
            }).catch(() => {});
          } else {
            await interaction.message?.edit({
              content: after === target ? `🔒 ${agent.name} 已切回 ${target}。` : `🔒 ${agent.name} 切回 ${target}（当前检测=${after || "?"}）。`,
              components: [],
            }).catch(() => {});
          }
        } catch (e) {
          await interaction.followUp({ content: `❌ 操作失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // v2.4.19+ 跳到 iTerm tab 按钮（LLM-free）。逻辑抽到 focusITermTab()，
      // /focus slash 命令复用同一份（button 在 pin 弹窗里点不动，slash 更可靠）。
      if (id.startsWith("focus:")) {
        const targetChannelId = id.slice("focus:".length);
        try {
          const r = await focusITermTab(targetChannelId, CONTROL_CHANNEL_ID, runManager);
          await interaction.followUp({ content: r.note, ephemeral: true }).catch(() => {});
        } catch (e) {
          await interaction.followUp({ content: `❌ 切换失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // v2.4.22+ 截图按钮（复用 /screenshot 逻辑）。ephemeral 回执带图，不刷屏。
      if (id.startsWith("screenshot:")) {
        const targetChannelId = id.slice("screenshot:".length);
        try {
          const pngPath = await captureChannelScreenshot(targetChannelId, runManager);
          if (pngPath) {
            await interaction.followUp({ content: "📸 终端截图", files: [{ attachment: pngPath }], ephemeral: true }).catch(() => {});
          } else {
            await interaction.followUp({ content: "❌ 截图失败：PNG 生成失败", ephemeral: true }).catch(() => {});
          }
        } catch (e) {
          await interaction.followUp({ content: `❌ 截图失败: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
        }
        return;
      }

      // 打断按钮
      if (id.startsWith("interrupt:")) {
        const targetChannelId = id.slice("interrupt:".length);
        console.log(`⚡ 打断按钮点击: channel=${targetChannelId}`);
        try {
          // master (CONTROL_CHANNEL_ID) route 到 master:0，
          // 但它不在 registry.json 里 —— 直接认定目标是 master:0，不用查 registry
          const isMasterTarget = targetChannelId === CONTROL_CHANNEL_ID;

          let targetWindow: string;
          let agentLabel: string;
          let targetRuntime: string | undefined;
          if (isMasterTarget) {
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
            targetRuntime = agent.runtime;
          }

          console.log(`⚡ 打断 tmux window: ${targetWindow}`);
          let keys: readonly string[];
          try {
            keys = await interruptWindow(targetWindow, targetRuntime);
          } catch (e) {
            const msg = (e as Error).message;
            console.error(`⚡ tmux send-keys 失败: ${msg}`);
            await interaction.followUp({ content: `❌ tmux 发送打断键失败: ${msg}`, ephemeral: true }).catch(() => {});
            return;
          }
          const idle = { content: `💤 ${agentLabel} 当前空闲，无需打断`, ephemeral: true };
          if (!keys.length) return void (await interaction.followUp(idle).catch(() => {})); // 回执发不出无妨：本就什么键都没按
          console.log(`⚡ ${describeKeys(keys)} 已发送给 ${agentLabel}`);
          recordMetric("agent_interrupt", { channelId: targetChannelId, agent: agentLabel, meta: { trigger: "button" } });

          await finishStatusMessage(discord, targetChannelId, t("⚡ 已打断", "⚡ Interrupted"));
          stopTyping(targetChannelId);
          clearSafetyTimer(targetChannelId);
          // 被打断的回合没有 Stop hook —— 主动把回合状态收尾成 done，
          // 否则 agentStatuses 卡 thinking（web 黄点常驻 / busy 补锁复活）
          emitEvent({ agent: agentLabel, chatId: targetChannelId, type: "agent_status", data: { status: "done", trigger: "interrupt" } });
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
        // 按钮对应的 Claude Code 按键**序列**。
        // v2.0.22+: session-idle modal 不接受 digit 跳转（按 "2" 不会跳到 option 2，
        // Enter 还是确认高亮的 option 1 = 从摘要恢复 = compact）。改用 arrow nav：
        // 光标默认在 option 1，Down 一次到 2，两次到 3。perm 弹窗保留 digit（实测可用）。
        const keySeqMap: Record<string, string[]> = {
          perm_allow: ["1", "Enter"],
          perm_allow_session: ["2", "Enter"],
          perm_deny: ["3", "Enter"],
          session_summary: ["Enter"],              // option 1（高亮默认）
          session_full: ["Down", "Enter"],         // ↓ 到 option 2
          session_noask: ["Down", "Down", "Enter"],// ↓↓ 到 option 3
        };
        const labelMap: Record<string, string> = {
          perm_allow: "✅ 已允许",
          perm_allow_session: "✅ 已允许（本会话不再问）",
          perm_deny: "❌ 已拒绝",
          session_summary: "✨ 从摘要恢复",
          session_full: "📜 恢复完整会话",
          session_noask: "🔕 不再询问",
        };
        const keySeq = keySeqMap[action] || ["Enter"];
        const isPermBtn = action.startsWith("perm_");
        const isIdleBtn = action.startsWith("session_");
        console.log(`🔔 弹窗响应: channel=${targetChannelId} action=${action} keys=${keySeq.join(" ")}`);
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
            ["tmux", "-S", TMUX_SOCK, "send-keys", "-t", `master:${agent.name}`, ...keySeq],
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

      // v2.0.19+: AskUserQuestion 的 Submit / Cancel 按钮
      if (id.startsWith("auq:")) {
        try {
          const { auqStates, buildAuqKeystrokes, clearAuqState, sendAuqKeys } =
            await import("./ask-user-question.js");
          const parts = id.split(":");
          const auqChannel = parts[1];
          const action = parts[2];
          const state = auqStates.get(auqChannel);
          if (!state) {
            await interaction.editReply({ content: `⚠️ AskUserQuestion 状态已过期，请等 agent 重新发起。`, components: [] }).catch(() => {});
            return;
          }
          if (action === "submit") {
            // v2.17.2：发键前重验弹窗还在（API answer 端点同款）。新键位模型含数字键，
            // 弹窗已被 TUI 侧应答时盲发会把数字真打进 composer。抓不到 pane 才盲发。
            let auqPane = "";
            try { auqPane = await tmuxCapture(state.tmuxTarget, 40); } catch { /* 跳过重验 */ }
            const auqParse = auqPane ? parseAuqPane(auqPane) : null;
            if (auqPane && !auqParse) {
              clearAuqState(auqChannel);
              emitEvent({ agent: agentNameForChannel(auqChannel) || "master", chatId: auqChannel, type: "question_cleared", data: { reason: "stale", via: "discord" } });
              await interaction.editReply({ content: `⚠️ 弹窗已在终端侧被应答/关闭，本次提交作废。`, components: [] }).catch(() => {});
              return;
            }
            const keys = buildAuqKeystrokes(state, auqParse);
            // 逐键分发（键间 120ms）：批量 send-keys 会被 AUQ 组件吞导航键，答错选项
            if (keys.length > 0) {
              await sendAuqKeys(state.tmuxTarget, keys);
            }
            const summary = state.selections.map((sel, i) => {
              if (sel.length === 0) return `Q${i + 1}: (none)`;
              const labels = sel.map((oi) => state.questions[i].options[oi]?.label || `?${oi}`).join(", ");
              return `Q${i + 1}: ${labels}`;
            }).join("\n");
            await interaction.editReply({
              content: `✅ 已提交 AskUserQuestion 选择：\n${summary}`,
              components: [],
            }).catch(() => {});
            recordMetric("auq_submit", { channelId: auqChannel, meta: { questions: String(state.questions.length) } });
            clearAuqState(auqChannel);
            // 同步收掉 web 端的交互卡
            emitEvent({ agent: agentNameForChannel(auqChannel) || "master", chatId: auqChannel, type: "question_cleared", data: { reason: "submit", via: "discord" } });
          } else if (action === "cancel") {
            await tmuxSendEscape(state.tmuxTarget);
            await interaction.editReply({
              content: `❌ 已取消 AskUserQuestion（发了 Esc 给 agent）`,
              components: [],
            }).catch(() => {});
            recordMetric("auq_cancel", { channelId: auqChannel });
            clearAuqState(auqChannel);
            // 同步收掉 web 端的交互卡
            emitEvent({ agent: agentNameForChannel(auqChannel) || "master", chatId: auqChannel, type: "question_cleared", data: { reason: "cancel", via: "discord" } });
          }
        } catch (e) {
          console.error("AUQ button 处理异常:", e);
        }
        return;
      }

      // 管理按钮
      const mgmtResult = await handleMgmtButton(id, channelId, interaction.message?.id, discord);
      if (mgmtResult) {
        if (mgmtResult.text !== "__HANDLED__") {
          // 走 deliver(bridge → user)：discordReply 内部 buildComponents。
          await deliver({
            from: { kind: "bridge", label: "mgmt-button" },
            to: { kind: "user", userId: interaction.user.id, channelId },
            intent: "notification",
            content: mgmtResult.text,
            meta: {
              messageId: `mgmt_${Date.now()}`,
              triggerKind: "bridge_synth",
              ts: new Date().toISOString(),
              threadId: newThreadId(),
              components: mgmtResult.components,
            },
          });
        }
        return;
      }

      // 未知按钮 → 走 deliver 转发给 LLM，agent 看到 content="[button:<id>]"
      const client = clients.get(channelId);
      if (!client) return;

      // v2.4.15+ UX：点击后清掉原按钮 + 标注"已点击"，**并在底下保留一个"打断"
      // 按钮**，让用户在 agent 处理过程中能随时中断（之前点完按钮就没打断按钮、
      // 一直要等 agent 自己跑完）。把这条 message 登记为本 channel 的当前 status
      // message —— Stop hook 触发时会自动 edit 成"✅ 完成"+ 去掉按钮，跟 typed
      // message 走 messageCreate 那条路径的语义完全一致。
      const clickedMsgId = interaction.message?.id;
      try {
        const label = (interaction.component as any)?.label || id;
        const origContent = interaction.message?.content || "";
        await interaction.editReply({
          content: `${origContent}\n\n✅ 已点击：**${label}**`,
          components: buildComponents(agentActionButtons(channelId, true)),
        }).catch(() => {});
      } catch { /* non-critical */ }

      // 切换 status 簿记到这条点击的消息，旧的清成"✅ 完成"
      stopTyping(channelId);
      clearSafetyTimer(channelId);
      if (statusMessageIdFor(channelId) !== clickedMsgId) {
        await finishStatusMessage(discord, channelId, t("✅ 完成", "✅ Done"));
      }
      if (clickedMsgId) trackStatusMessage(channelId, clickedMsgId);
      resetToolTracking(channelId);
      startTypingWithSafety(channelId);
      await deliver({
        from: { kind: "user", userId: interaction.user.id, channelId, username: interaction.user.username },
        to: { kind: "local", channelId: client.channelId, ws: client.ws, cwd: client.cwd },
        intent: "request",
        content: `[button:${id}]`,
        meta: {
          messageId: interaction.message?.id || `btn_${Date.now()}`,
          triggerKind: "user_discord",
          ts: new Date().toISOString(),
          threadId: newThreadId(),
        },
      });
      return;
    }

    // ── Select Menus ──
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;
      const value = interaction.values[0];
      await interaction.deferUpdate().catch(() => {});

      // v2.5.4+ 看板「🧹 存记忆 + Compact」select（value = 目标 agent 的 channelId）
      if (id === "stats_savecompact") {
        await triggerSaveCompact(interaction, value, runManager);
        return;
      }

      // v2.0.19+: AskUserQuestion 的 select menu —— 用户选完更新 state，等 Submit 按钮
      // 一并把 selections 翻译成 keystroke 发到 TUI。
      if (id.startsWith("auq:") && /:q\d+$/.test(id)) {
        try {
          const { auqStates } = await import("./ask-user-question.js");
          const parts = id.split(":");
          const auqChannel = parts[1];
          const qIdxStr = parts[2].slice(1); // q0 -> 0
          const qIdx = parseInt(qIdxStr, 10);
          const state = auqStates.get(auqChannel);
          if (state && Number.isInteger(qIdx) && qIdx >= 0 && qIdx < state.questions.length) {
            // interaction.values 是 string[]，每个是 option index 字符串
            state.selections[qIdx] = interaction.values
              .map((v) => parseInt(v, 10))
              .filter((n) => Number.isInteger(n) && n >= 0 && n < state.questions[qIdx].options.length);
            console.log(`🎛 AUQ Q${qIdx + 1} 选了 ${state.selections[qIdx].length} 项 (channel=${auqChannel})`);
          }
        } catch (e) {
          console.error("AUQ select 处理异常:", e);
        }
        return;
      }

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
          await deliver({
            from: { kind: "bridge", label: "mgmt-select" },
            to: { kind: "user", userId: interaction.user.id, channelId },
            intent: "notification",
            content: mgmtResult.text,
            meta: {
              messageId: `mgmt_${Date.now()}`,
              triggerKind: "bridge_synth",
              ts: new Date().toISOString(),
              threadId: newThreadId(),
              components: mgmtResult.components,
            },
          });
        }
        return;
      }

      // 未知菜单 → 转发给 LLM。
      // v2.14+ 多选：Discord 的 max_values>1 会一次交回多个值，全部带上（逗号分隔）。
      // 单选保持原样 `[select:id:value]`，agent 侧的老分支不受影响。
      const client = clients.get(channelId);
      if (!client) return;
      startTypingWithSafety(channelId);
      const picked = interaction.values.length > 1
        ? interaction.values.join(",")
        : value;
      client.ws.send(JSON.stringify({
        type: "message",
        content: `[select:${id}:${picked}]`,
        meta: { chat_id: channelId, message_id: interaction.message?.id || "", user: interaction.user.username, user_id: interaction.user.id, ts: new Date().toISOString() },
      }));
      return;
    }
  } catch (err) {
    console.error("❌ Interaction error:", err);
  }
}
