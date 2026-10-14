/**
 * PM 暂存（docs/architecture/pm-digest.md「暂存」）：开着时，除 owner / 人类对话和卡片答复外，推给当班 PM 的消息全文落盘、不叫醒 PM。
 * hold = 一直攒到切 off 才整包送一次；batch = 队里最早一条等满 everyMin 分钟整包送一次。PM 每被叫醒一次都要重读整段上下文，
 * 额度的大头是叫醒次数而不是单次大小，所以这里砍的是次数。开关只有 manager 的 `ledger pm-hold` 写，队列只有 bridge 写。
 */
import { statePath } from "./paths.js";
import { readJsonStateSync, reportCorrupt, writeJsonAtomicSync } from "./state-file.js";
import type { DigestInput } from "./pm-digest.js";

type PmHoldMode = "off" | "hold" | "batch";
export interface PmHoldSetting { mode: PmHoldMode; everyMin: number; since: number }
export interface PmHoldEntry { id: string; project: string; at: number; source: string; body: string }

export const PM_HOLD_DEFAULT_MIN = 60;
/** 整包送出的信封 from.label：它自己不能再被暂存，否则永远送不出去 */
export const PM_HOLD_LABEL = "pm-hold";
/** 单条正文进包的上限；整包上限超了就留到下一包（下一轮 tick 立即补送） */
const BODY_MAX = 3000;
const BUNDLE_MAX = 40_000;

const isSetting = (v: unknown): v is PmHoldSetting => {
  const s = v as PmHoldSetting;
  return !!s && (s.mode === "off" || s.mode === "hold" || s.mode === "batch") && Number.isFinite(s.everyMin) && s.everyMin > 0;
};
const isEntry = (v: unknown): v is PmHoldEntry => {
  const e = v as PmHoldEntry;
  return !!e && typeof e.id === "string" && typeof e.project === "string" && typeof e.body === "string" && Number.isFinite(e.at);
};

/** owner / 人类对话、peer 回程（from 是 local，靠 peer_http 认）、卡片答复照常立即送；整包信封自己也不暂存 */
export function pmHoldExempt(m: Pick<DigestInput, "fromKind" | "triggerKind">, sender?: string): boolean {
  if (m.fromKind === "bridge" && sender === PM_HOLD_LABEL) return true;
  return m.fromKind === "user" || m.fromKind === "api" || m.triggerKind === "user_discord" || m.triggerKind === "peer_http" || m.triggerKind === "ask_answer";
}

export class PmHoldStore {
  constructor(readonly modePath = statePath("pm-hold-mode.json"), readonly path = statePath("pm-hold.json")) {}

  setting(project: string): PmHoldSetting {
    const r = readJsonStateSync(this.modePath);
    if (r.status === "corrupt") reportCorrupt(this.modePath, r.error, "pm-hold");
    const v = r.status === "ok" ? (r.data as { projects?: Record<string, unknown> }).projects?.[project] : undefined;
    return isSetting(v) ? v : { mode: "off", everyMin: PM_HOLD_DEFAULT_MIN, since: 0 };
  }

  setSetting(project: string, s: PmHoldSetting): void {
    const r = readJsonStateSync(this.modePath);
    if (r.status === "corrupt") throw new Error(`pm-hold 开关文件损坏：${r.error}`); // 不覆盖损坏文件，留给人看
    const prev = r.status === "ok" ? (r.data as { projects?: Record<string, PmHoldSetting> }).projects : undefined;
    writeJsonAtomicSync(this.modePath, { projects: { ...prev, [project]: s } });
  }

  queue(): PmHoldEntry[] {
    const r = readJsonStateSync(this.path);
    if (r.status === "corrupt") throw new Error(`pm-hold 队列文件损坏：${r.error}`); // 调用方按写失败处理：照常立即送
    const q = r.status === "ok" ? (r.data as { queue?: unknown[] }).queue : undefined;
    return Array.isArray(q) ? q.filter(isEntry) : [];
  }

  push(e: PmHoldEntry): void {
    const q = this.queue();
    if (!q.some((x) => x.id === e.id)) writeJsonAtomicSync(this.path, { queue: [...q, e] });
  }

  remove(ids: ReadonlySet<string>): void {
    writeJsonAtomicSync(this.path, { queue: this.queue().filter((e) => !ids.has(e.id)) });
  }
}

/** 开着且不豁免就全文入队，返回 true（调用方不投、不叫醒 PM）；关着或豁免返回 false。写失败抛错，调用方照常立即送 */
export function pmHoldTake(store: PmHoldStore, e: Omit<PmHoldEntry, "source"> & { source?: string },
  m: Pick<DigestInput, "fromKind" | "triggerKind">): boolean {
  if (store.setting(e.project).mode === "off" || pmHoldExempt(m, e.source)) return false;
  store.push({ ...e, source: e.source ?? m.fromKind });
  return true;
}

/** 该送了吗：off（刚关、队里还有剩的）立刻送；batch 最早一条等满 everyMin；hold 一直攒 */
export function pmHoldDue(s: PmHoldSetting, entries: readonly PmHoldEntry[], now: number): boolean {
  if (!entries.length) return false;
  if (s.mode === "off") return true;
  if (s.mode === "hold") return false;
  return now - Math.min(...entries.map((e) => e.at)) >= s.everyMin * 60_000;
}

const hhmm = (at: number): string => new Date(at).toTimeString().slice(0, 5);
const clip = (s: string): string => (s.length > BODY_MAX ? `${s.slice(0, BODY_MAX)}…（截断，原文 ${s.length} 字）` : s);

/** 拼整包：同来源同正文的合成一条带次数；超过整包上限的留在队里，返回本包实际带走的 ids */
export function pmHoldBundle(entries: readonly PmHoldEntry[]): { text: string; ids: Set<string> } {
  const groups: { first: PmHoldEntry; last: number; ids: string[] }[] = [];
  for (const e of [...entries].sort((a, b) => a.at - b.at)) {
    const g = groups.find((x) => x.first.source === e.source && x.first.body === e.body);
    if (g) { g.ids.push(e.id); g.last = e.at; } else groups.push({ first: e, last: e.at, ids: [e.id] });
  }
  const ids = new Set<string>(), parts: string[] = [];
  let size = 0;
  for (const [i, g] of groups.entries()) {
    const times = g.ids.length > 1 ? `${hhmm(g.first.at)}–${hhmm(g.last)}，重复 ${g.ids.length} 次` : hhmm(g.first.at);
    const part = `—— ${i + 1}. ${g.first.source} · ${times}\n${clip(g.first.body.trim())}`;
    if (parts.length && size + part.length > BUNDLE_MAX) break;
    parts.push(part);
    size += part.length;
    for (const id of g.ids) ids.add(id);
  }
  const left = entries.length - ids.size;
  const head = `[📦 PM 暂存] 攒了 ${ids.size} 条推送，一次处理（不用逐条回复，要动手的照常做）${left ? `；还有 ${left} 条下一包送` : ""}：`;
  return { text: [head, ...parts].join("\n\n"), ids };
}
