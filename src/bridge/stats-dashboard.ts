/**
 * 只读用量看板（v2.4.25+）
 *
 * 一个只读频道（📊-claudestra-stats）里常驻一条 embed 消息，每次「对话完成」hook 就
 * 编辑它 —— 走消息编辑限流（~5/5s per channel），几乎不受限，避开了改 topic 那条严格的
 * 2 次/10min。数据两块：
 *   - per-agent（上下文 / 模型 / 今日·本周 token）：本地 JSONL 即时算（agent-stats.ts）
 *   - 账号级 5h/周 limit 占比：只读 statusline 缓存 / 上次网页手动刷新的读数（lib/account-usage-view.ts），后台从不抓 TUI
 *
 * 同一份快照另开 `GET /stats` JSON 接口，给以后的 Web 端。
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type Client,
  type TextChannel,
} from "discord.js";
import { readConfig, setStatsDashboard, isConfigCorrupt } from "../lib/config-store.js";
import { readRegistryAgents, readRegistryAgentsSync } from "../lib/registry.js";
import { readAccountUsageView } from "../lib/account-usage-view.js";
import type { AccountUsage } from "../lib/account-usage-panel.js";
import { manualRefresh, type RefreshOutcome } from "../lib/account-usage-refresh.js";
import { ctxBoundaryViewFor, ctxBoundaryWarnings } from "./ctx-boundary.js";
import { boundaryLabel, type CtxBoundaryView } from "../lib/ctx-boundary-decision.js";
import { discordCreateChannel } from "./discord-api.js";
import { computeAgentStats, formatTokens, type AgentStat } from "../lib/agent-stats.js";
import { currentUsageWindow, noteWeekResetText, type UsageWindowBounds } from "../lib/usage-window.js";
import { fmtAge, machineFooter, machineUsage, type MachineSlot } from "./machine-usage.js";
import { withCodexQuota, type CodexQuotaObservation } from "../lib/codex-usage.js";
import { lpTag } from "./fleet/lp-monitor.js";

import {
  fmtResets, sessionResetSuspect, bar, ctxDot, boundaryNote as formatBoundaryNote,
  limitDot, limitColor, BOUNDARY_DOT,
} from "../lib/stats-dashboard-format.js";

export { sessionResetSuspect } from "../lib/stats-dashboard-format.js";
export { panelResidue, typedRecheckOk, type AccountUsage } from "../lib/account-usage-panel.js";
const boundaryNote = (v: CtxBoundaryView | null): string => formatBoundaryNote(v, formatTokens);

const DASHBOARD_CHANNEL_NAME = "📊-claudestra-stats";
const DEBOUNCE_MS = 3000; // 合并瞬时连发的多个 hook
const TICK_MS = 10 * 60 * 1000; // 低频兜底：挂机没 hook 时也刷一次，反映 5h/周 limit 重置

export interface StatsSnapshot {
  /** 永远有值：没有读数时 source "none"、pct null（未知，不是 0） */
  global: AccountUsage | null;
  /** 只有手动刷新的响应带：本次结果与下一次可刷新时刻 */
  refresh?: Omit<RefreshOutcome, "usage">;
  agents: AgentStat[];
  updatedAt: number;
  /** Claude 之外的额度卡（目前只有「最近一次 Codex 会话看到的额度」）；没有就是空数组 */
  quotas?: CodexQuotaObservation[];
  /** 今日 / 本周的边界（本周 = 周额度周期，拿不到退回滚动 7 天）与全机合计（所有会话、按响应去重；首次扫描前为 null） */
  window?: UsageWindowBounds;
  machine?: MachineSlot;
}

// ── 账号级用量：后台只读缓存（lib/account-usage-view.ts），TUI 探测只走网页手动刷新（handleStatsRefreshRequest）──

/** 后台读数：statusline 缓存 / 上次手动读数，都没有 = 未知（pct null）。绝不起 TUI 抓取 */
function getAccountUsage(): AccountUsage {
  return readAccountUsageView();
}

// ── 快照组装 ───────────────────────────────────────────────────────────

export async function buildSnapshot(global: AccountUsage = getAccountUsage()): Promise<StatsSnapshot> {
  const window = currentUsageWindow();
  const [agents, machine] = await Promise.all([
    readRegistryAgents().then((list) => computeAgentStats(list, window)), // RegistryAgent 是 AgentLike 超集
    machineUsage(window),
  ]);
  agents.sort((a, b) => b.contextTokens - a.contextTokens);
  return withCodexQuota({ global, agents, updatedAt: Date.now(), window, machine });
}

// ── Discord 渲染 ───────────────────────────────────────────────────────

/**
 * 用 Discord 原生 embed 字段渲染，而不是等宽代码块表格 ——
 * 代码块在窄手机屏（~33 字符）会硬折行、把列冲乱。原生字段全宽堆叠、按文字自然换行，
 * 还能用 emoji。每个 agent 一个非 inline 字段：名字前用颜色点表示上下文占用预警
 * （🟢正常 / 🟡偏高 / 🔴该 compact），value 行放模型 + 今日/本周。账号级 limit 两条
 * 进度条放在 description，也各带颜色点，边框色跟最严重的 limit 走。
 */
function renderEmbed(snap: StatsSnapshot): EmbedBuilder {
  const g = snap.global;
  const desc: string[] = ["**🌐 账号 limit（所有 agent 共享）**"];
  let worstLimit: number | null = null;
  if (g && (g.sessionPct != null || g.weekPct != null)) {
    worstLimit = Math.max(g.sessionPct ?? 0, g.weekPct ?? 0);
    desc.push(`⏱ 5h　${limitDot(g.sessionPct)} ${bar(g.sessionPct, 8)}${g.sessionResets ? "　⟳ " + fmtResets(g.sessionResets) + (sessionResetSuspect(g.sessionResets, g.scrapedAt) ? "⚠️" : "") : ""}`);
    desc.push(`📆 周　${limitDot(g.weekPct)} ${bar(g.weekPct, 8)}${g.weekResets ? "　⟳ " + fmtResets(g.weekResets) : ""}`);
    // gauge 数据年龄：embed 的 timestamp 是重渲染时间，账号 % 可能是旧缓存 ——
    // 不标年龄用户会以为一切都是最新的（owner 2026-07-10 报告"刷新不及时"的根源）
    const stale = g.stale ?? Date.now() - g.scrapedAt > 15 * 60_000;
    desc.push(`_${stale ? "⚠️ 陈旧 · " : ""}账号 gauge 读于 ${fmtAge(g.scrapedAt)}（${g.source === "manual" ? "网页手动刷新" : "statusline"}）_`);
  } else {
    // 后台从不抓 TUI：没有读数就写未知（不画成 0）；要真实读数 = 配 statusline 或在网页点刷新
    desc.push(`_账号用量未知（${g?.reason === "corrupt" ? "用量缓存损坏" : "没有 statusline 用量缓存"}）——网页用量看板可手动刷新_`);
  }
  desc.push("_🟢 正常 · 🟡 过了压缩线 · 🔴 过了硬上限（点=上下文边界 / 前缀=limit）_");
  for (const w of ctxBoundaryWarnings().slice(0, 3)) desc.push(`⚠️ 上下文边界配置${w.policy ? `（${boundaryLabel(w.policy)}）` : ""}：${w.text}`);

  const emb = new EmbedBuilder()
    .setTitle("📊 Claudestra 用量看板")
    .setColor(limitColor(worstLimit))
    .setDescription(desc.join("\n"))
    .setFooter({ text: machineFooter(snap.machine, snap.window) })
    .setTimestamp(new Date(snap.updatedAt));

  for (const a of snap.agents.slice(0, 24)) {
    const name = a.name.replace(/^agent-/, "");
    // compact 后无新对话 → 上下文是估算值，加 ~ 和标注（真实值下轮对话自动校准）
    const ctx = a.contextEstimated ? `📖 ~${formatTokens(a.contextTokens)} ${a.contextPct}%（刚 compact）` : `📖 ${formatTokens(a.contextTokens)} ${a.contextPct}%`;
    const bv = ctxBoundaryViewFor({ ...a, sessionId: a.jsonl?.split("/").pop()?.replace(/\.jsonl$/, "") }, a.contextTokens);
    emb.addFields({
      name: `${bv ? BOUNDARY_DOT[bv.level] : ctxDot(a.contextPct)} ${name} · ${ctx}${lpTag(a.name)}`, // lpTag：low-priority 纯文字标签（bridge/fleet/lp-monitor.ts）
      value: `${a.model.replace(/^claude-/, "")} · 当前会话 今 ${formatTokens(a.today.tokens)} · 周 ${formatTokens(a.week.tokens)}${boundaryNote(bv)}`,
      inline: false,
    });
  }
  return emb;
}

// ── 频道 / 消息 保障 ───────────────────────────────────────────────────

// 本进程建了、却没能落盘的频道 / 消息 id（setStatsDashboard 失败时）。不记下来，
// 下一轮 doUpdate（每个 Stop hook + 10 分钟 tick）就会再建一个频道、再发一条消息。
const unpersisted: { channelId?: string; messageId?: string } = {};
let corruptNoted = false;

/** 导出给测试（create 可替换）；运行时只由 doUpdate 调。 */
export async function ensureChannel(
  discord: Pick<Client, "channels">,
  create: (d: Client, name: string) => Promise<string> = discordCreateChannel,
): Promise<string | null> {
  const cfg = await readConfig();
  for (const id of new Set([cfg.statsDashboard?.channelId, unpersisted.channelId])) {
    if (!id) continue;
    const ch = await discord.channels.fetch(id).catch(() => null);
    if (ch) return id;
  }
  // config.json 坏了：建了频道也存不下，每轮都会再建一个。暂停看板，坏文件由 doctor 报
  if (isConfigCorrupt()) {
    if (!corruptNoted) console.error("📊 config.json 已损坏，用量看板暂停（修好或删掉该文件后自动恢复）");
    corruptNoted = true;
    return null;
  }
  corruptNoted = false;
  // 复用 discordCreateChannel，再把 @everyone 设成不可发言（只读）
  try {
    const chId = await create(discord as Client, DASHBOARD_CHANNEL_NAME);
    unpersisted.channelId = chId;
    const ch = (await discord.channels.fetch(chId).catch(() => null)) as TextChannel | null;
    if (ch && ch.guild) {
      await ch.permissionOverwrites
        .edit(ch.guild.roles.everyone, { SendMessages: false, AddReactions: false })
        .catch(() => {});
      await ch.setTopic("Claudestra 实时用量看板（只读，自动更新）").catch(() => {});
    }
    await setStatsDashboard(chId, "");
    console.log(`📊 已创建用量看板频道: ${chId}`);
    return chId;
  } catch (e) {
    console.error("📊 创建看板频道失败:", (e as Error).message);
    return null;
  }
}

/** 看板消息底部的「🔄 刷新」按钮（点了按缓存立即重渲染）。 */
function refreshRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("stats_refresh").setLabel("🔄 刷新").setStyle(ButtonStyle.Secondary),
  );
}

/**
 * v2.5.4+ 「存记忆 + Compact」select menu：选一个 agent → bridge 往它的 tmux 发
 * /save-compact（skill：先挑重点存记忆，再自动 /compact）。Discord 没法把按钮放到
 * embed field "旁边"，一条消息也放不下每 agent 一个按钮，select 是最干净的形态。
 */
function saveCompactRow(agents: AgentStat[]) {
  const opts = agents
    .filter((a) => a.channelId)
    .slice(0, 25)
    .map((a) => ({
      label: a.name.replace(/^agent-/, "").slice(0, 100),
      value: a.channelId,
      description: `📖 ${formatTokens(a.contextTokens)} (${a.contextPct}%) · 今 ${formatTokens(a.today.tokens)}`.slice(0, 100),
      emoji: ctxDot(a.contextPct),
    }));
  if (!opts.length) return null;
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("stats_savecompact")
      .setPlaceholder("🧹 存记忆 + Compact…（选一个 agent）")
      .addOptions(opts),
  );
}

// ── 上下文阈值提醒 ─────────────────────────────────────────────────────
// 跨过一档提醒一次（250K/300K/400K/500K/750K），compact 掉下去自动复位、再涨再提醒。
// bridge 刚启动的第一轮只记 baseline 不提醒，避免每次重启把已超标的 agent 全轰一遍。

const CTX_TIERS = [250_000, 300_000, 400_000, 500_000, 750_000];
const notifiedTier = new Map<string, number>(); // channelId → 已提醒过的档位（1-based，0=没过档）
let tierBaselined = false;

function tierOf(tokens: number): number {
  let t = 0;
  for (let i = 0; i < CTX_TIERS.length; i++) if (tokens >= CTX_TIERS[i]) t = i + 1;
  return t;
}

async function checkContextTiers(discord: Client, agents: AgentStat[]): Promise<void> {
  const first = !tierBaselined;
  tierBaselined = true;
  for (const a of agents) {
    if (!a.channelId) continue;
    const tier = tierOf(a.contextTokens);
    const prev = notifiedTier.get(a.channelId) ?? 0;
    // 涨了记新档；掉了（compact 过）复位。自动压缩不在这里，在 bridge/ctx-boundary.ts（每分钟一轮，web-only 也跑）
    if (tier !== prev) notifiedTier.set(a.channelId, tier);
    if (tier === 0 || first) continue;

    // 档位提醒只在**向上跨档**时发一次。18dec8f 把原 `tier === prev → continue`
    // 拆掉后,稳态每轮都会走到这里重发提醒(刷屏回归)——这行守卫补回原语义
    if (tier <= prev) continue;

    try {
      const ch = (await discord.channels.fetch(a.channelId).catch(() => null)) as TextChannel | null;
      if (!ch || !("send" in ch)) continue;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`savecompact:${a.channelId}`)
          .setLabel("🧹 存记忆 + Compact")
          .setStyle(ButtonStyle.Primary),
      );
      await ch.send({
        content: `⚠️ **${a.name.replace(/^agent-/, "")}** 上下文已到 **${formatTokens(a.contextTokens)}（${a.contextPct}%）**，超过 ${formatTokens(CTX_TIERS[tier - 1])} 档。建议先把关键信息存进记忆再 compact，一键搞定👇`,
        components: [row as any],
      });
      console.log(`📊 上下文档位提醒: ${a.name} → ${formatTokens(a.contextTokens)} (档${tier})`);
    } catch (e) {
      console.error(`📊 档位提醒失败 (${a.name}):`, (e as Error).message);
    }
  }
}

async function ensureMessage(
  discord: Client,
  channelId: string,
  embed: EmbedBuilder,
  extraRows: any[] = [],
): Promise<string | null> {
  const ch = (await discord.channels.fetch(channelId).catch(() => null)) as TextChannel | null;
  if (!ch || !("send" in ch)) return null;
  const payload = { embeds: [embed], components: [refreshRow(), ...extraRows] };
  const cfg = await readConfig();
  for (const existingId of new Set([cfg.statsDashboard?.messageId, unpersisted.messageId])) {
    if (!existingId) continue;
    const msg = await ch.messages.fetch(existingId).catch(() => null);
    if (msg) {
      await msg.edit(payload);
      return existingId;
    }
  }
  const msg = await ch.send(payload);
  unpersisted.messageId = msg.id;
  await setStatsDashboard(channelId, msg.id);
  return msg.id;
}

// ── 对外：更新 / 初始化 / HTTP ─────────────────────────────────────────

let debTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let pending = false;

async function doUpdate(discord: Client): Promise<void> {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  try {
    const snap = await buildSnapshot();
    const channelId = await ensureChannel(discord);
    if (!channelId) return;
    const menu = saveCompactRow(snap.agents);
    await ensureMessage(discord, channelId, renderEmbed(snap), menu ? [menu] : []);
    // 上下文跨档提醒（发到各 agent 自己的频道，带一键按钮）
    await checkContextTiers(discord, snap.agents);
  } catch (e) {
    console.error("📊 看板更新失败:", (e as Error).message);
  } finally {
    running = false;
    if (pending) {
      pending = false;
      void doUpdate(discord);
    }
  }
}

/** 看板「🔄 刷新」按钮：只用缓存重渲染——Discord 刷新不是 TUI 探测入口（只有网页手动刷新是）。 */
export async function forceRefreshStatsDashboard(discord: Client): Promise<void> {
  await doUpdate(discord);
}

/** 每次「对话完成」hook 调这个（防抖合并瞬时连发）。 */
export function updateStatsDashboard(discord: Client): void {
  if (debTimer) return;
  debTimer = setTimeout(() => {
    debTimer = null;
    void doUpdate(discord);
  }, DEBOUNCE_MS);
}

let tickTimer: ReturnType<typeof setInterval> | null = null;

/** 启动时确保频道 + 消息存在，刷一次，并起一个低频兜底 tick。（statusLine 包装批准卡不归这里：平台无关，见 bridge/account-usage-startup.ts） */
export async function initStatsDashboard(discord: Client): Promise<void> {
  try {
    await doUpdate(discord);
  } catch (e) {
    console.error("📊 看板初始化失败:", (e as Error).message);
  }
  // 低频兜底：主更新仍是「对话完成」hook，但挂机、没任何 hook 时账号 5h/周 limit 的
  // 重置就反映不出来。这个 tick 每 10min 按缓存重渲染一次（doUpdate 内部有 running 锁，只读缓存）。
  if (!tickTimer) tickTimer = setInterval(() => void doUpdate(discord), TICK_MS);
}

/** 网页用户点刷新：唯一允许起 TUI 探测的入口，过 lib/account-usage-refresh.ts 的闸（失败退避 30 分钟、并发只一次、跨重启有效）。
 *  探测用独立临时会话（bridge/account-usage-probe.ts），不碰任何用户 / agent 窗口；返回快照 + 本次结果与下一可刷新时刻。 */
export async function handleStatsRefreshRequest(): Promise<Response> {
  const { usageProbeRunner } = await import("./account-usage-probe.js"); // 只有手动刷新才加载探测（看板与 GET 用不到它）
  return respond(async () => {
    const { usage, ...refresh } = await manualRefresh({ probe: usageProbeRunner() });
    if (refresh.outcome === "refreshed" && usage) noteWeekResetText(usage.weekResets); // 没配 statusline 时周期起点的次来源
    const global = refresh.outcome === "refreshed" && usage ? usage : getAccountUsage();
    return { ...(await buildSnapshot(global)), refresh };
  });
}

/** GET /stats —— 开放 JSON 接口，给 Web 端：只读缓存，任何参数都不起 TUI 探测。 */
export async function handleStatsRequest(): Promise<Response> {
  return respond(() => buildSnapshot());
}

async function respond(build: () => Promise<StatsSnapshot>): Promise<Response> {
  try {
    const snap = await build();
    return new Response(JSON.stringify(snap, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
