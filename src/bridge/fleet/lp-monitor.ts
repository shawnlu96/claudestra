/**
 * 各 Claude Code 窗口的 low-priority 状态缓存：每 30 秒抓一次画面（capture-pane 只读，不打断会话），
 * 变了就发 SSE `low_priority`。agent 列表、统计面板、批量面板都读这份缓存，别各自抓屏。
 * 批量动作跑完会对涉及的 agent 立刻 refreshLp，不用等下一轮。
 */
import { readLpPane, type LpMode } from "../../lib/lp-state.js";
import { readRegistryAgents } from "../../lib/registry.js";
import { tmuxRawStrict, windowTarget } from "../../lib/tmux-helper.js";
import { emitEvent } from "../event-bus.js";
import { MASTER_WINDOW } from "../turn-probe.js";

export interface LpSnapshot {
  lowPriority: LpMode;
  walled: boolean;
  /** 现在能开（撞墙后 CC 提供了 low-priority） */
  offer: boolean;
  resetsAt?: string;
  allowancePct?: number;
  reason?: string;
  at: number;
}

const INTERVAL_MS = 30_000;
const cache = new Map<string, LpSnapshot>();
const bare = (n: string) => String(n).replace(/^agent-/, "");

/** 大总管固定是 master:0，其余按窗口名精确匹配 */
export function lpWindowOf(name: string): string {
  return bare(name) === "master" ? MASTER_WINDOW : windowTarget(name);
}

async function probeLp(name: string): Promise<LpSnapshot> {
  try {
    const r = readLpPane(await tmuxRawStrict(["capture-pane", "-t", lpWindowOf(name), "-p", "-e"]));
    const { lowPriority, walled, offer, resetsAt, allowancePct, reason } = r;
    return { lowPriority, walled, offer, at: Date.now(), ...(resetsAt ? { resetsAt } : {}), ...(allowancePct !== undefined ? { allowancePct } : {}), ...(reason ? { reason } : {}) };
  } catch (e) {
    return { lowPriority: "unknown", walled: false, offer: false, reason: `抓屏失败：${(e as Error).message.slice(0, 120)}`, at: Date.now() };
  }
}

const sig = (s: LpSnapshot | undefined) => (s ? `${s.lowPriority}|${s.walled}|${s.offer}|${s.resetsAt ?? ""}|${s.allowancePct ?? ""}` : "");

/** 抓这几个 agent 的最新状态，写缓存；有变化的发 SSE。agents: [名字, channelId] */
export async function refreshLp(agents: { name: string; channelId?: string }[]): Promise<Map<string, LpSnapshot>> {
  const out = new Map<string, LpSnapshot>();
  await Promise.all(
    agents.map(async (a) => {
      const snap = await probeLp(a.name);
      const key = bare(a.name);
      const changed = sig(cache.get(key)) !== sig(snap);
      cache.set(key, snap);
      out.set(key, snap);
      if (changed) emitEvent({ agent: a.name, chatId: a.channelId ?? "", type: "low_priority", data: { ...snap } }, { transient: true });
    }),
  );
  return out;
}

/** agent 列表的附加字段（agent-info-routes.ts 并进每一行）；缓存里没有就不给 */
export function lpField(name: string): { lowPriority?: LpSnapshot } {
  const s = cache.get(bare(name));
  return s ? { lowPriority: s } : {};
}

/** Discord 统计面板的纯文字标签（嵌入消息画不了线条图标，也不用 emoji）；没状态、关着又没撞墙 = 空串 */
export function lpTag(name: string): string {
  const s = cache.get(bare(name));
  if (s?.lowPriority === "on") return ` · LP→${s.resetsAt ?? "?"}`;
  if (s?.lowPriority === "exhausted") return " · LP 本周额度已用完";
  return s?.walled ? " · 撞墙中" : "";
}

let timer: ReturnType<typeof setInterval> | null = null;

/** 只看 Claude Code 窗口（Pi / Codex 没有这个开关）；master 由调用方按 controlChannelId 带上 */
export function startLpMonitor(controlChannelId?: string): void {
  if (timer) return;
  const tick = async () => {
    const regs = await readRegistryAgents().catch((e) => (console.warn(`⚠️ [fleet] LP 轮询读 registry 失败: ${(e as Error).message}`), []));
    const cc = regs.filter((r) => (r.runtime ?? "claude-code") === "claude-code" && r.status !== "stopped");
    await refreshLp([...cc.map((r) => ({ name: r.name, channelId: r.channelId })), ...(controlChannelId ? [{ name: "master", channelId: controlChannelId }] : [])]);
  };
  void tick();
  timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref?.(); // 不单独撑住进程
}
