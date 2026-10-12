/**
 * 后台任务随会话重启被杀 → 提醒执行者别空等（BGW-1）。纯逻辑：认 CC 写进主会话 jsonl 的那条 task-notification、
 * 判谁算执行者、去重 + 冷却。接线在 bridge/bg-killed-notice.ts。
 *
 * 信号只认 CC 自己落的 orphan 通知：user 记录、origin.kind = task-notification、status = stopped、summary 以 orphan 句式开头。
 * 只匹配那句英文不行——正常 completed / 运行中 / 等输入的通知会把 Bash description 原样塞进 summary（引号里），
 * description 里完全可能有这句话；同一内容的 queue-operation 也不算（否则一次重启认两遍）。tests/bg-killed.test.ts
 */

const KILLED_PHRASE = "didn't finish before the previous session ended";
/** orphan 通知的 summary 开头：单条 shell / 多条 shell / 后台 agent（单复数）。正常通知是 `Background command "<description>" …` */
const ORPHAN_SUMMARY_RE = /^(?:Background (?:shell command|agent)|\d+ background (?:shell command tasks|agents)) didn't finish before the previous session ended\b/;
const STATUS_RE = /<status>([^<]*)<\/status>/;
/** 非贪婪截到 </summary>：description 里可能有裸 <（tests/bg-killed.test.ts「PR1280-r2」） */
const SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/;
const TASK_ID_RE = /<task-id>([^<]+)<\/task-id>/g;
/** 同一 agent 两条提醒之间至少隔这么久；期间新认出的 taskId 攒着，冷却过了合成一条发 */
export const BG_KILLED_COOLDOWN_MS = 10 * 60_000;
/** 只认这么新的通知：bridge 重启后从尾部重读时，旧通知不再提醒（代价：10 分钟内重启 bridge 会补发一次） */
export const BG_KILLED_FRESH_MS = 10 * 60_000;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("\n");
}

/** 一行 jsonl 是不是「上一轮后台任务没跑完」的通知：是 → 返回真实 taskId（去掉 __orphan_summary 扫描标记）与时间戳，否则 null */
export function parseKilledNotice(line: string): { ids: string[]; ts: number } | null {
  if (!line.includes(KILLED_PHRASE)) return null;
  let r: { type?: unknown; origin?: { kind?: unknown }; message?: { content?: unknown }; timestamp?: unknown };
  try {
    r = JSON.parse(line);
  } catch {
    return null; // 读到一半的首行（从尾部起读）：完整记录下一行才会出现，跳过不丢
  }
  if (r.type !== "user" || r.origin?.kind !== "task-notification") return null;
  const text = textOf(r.message?.content);
  if (STATUS_RE.exec(text)?.[1].trim() !== "stopped" || !ORPHAN_SUMMARY_RE.test(SUMMARY_RE.exec(text)?.[1].trim() ?? "")) return null;
  const ids = [...new Set([...text.matchAll(TASK_ID_RE)].map((m) => m[1].trim()))].filter((id) => id && !id.startsWith("__orphan_summary"));
  const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
  return ids.length ? { ids, ts: Number.isFinite(ts) ? ts : 0 } : null;
}

/** 只提醒执行者：master、人类会话、审查员都不在 agent-task-* 名下（与 ctx-boundary-policy 的 executor 口径一致） */
export function isExecutorAgent(name: string): boolean {
  return /^agent-task-/.test(name);
}

export function bgKilledNoticeText(ids: readonly string[]): string {
  return [
    `⚠️ 你上一轮会话放到后台的任务没跑完，已随会话重启被杀（taskId：${ids.join("、")}）。`,
    "它们的完成信号不会再来，别再等：需要结果就重跑（交付前的检查放前台跑），已经够交付就直接交付。",
  ].join("\n");
}

/** 已提醒过的 taskId 记这么久（远长于 BG_KILLED_FRESH_MS：过了新鲜窗口同一条通知不会再被认） */
const SENT_KEEP_MS = 24 * 3600_000;

export interface KilledNoticeState { sent: [string, number][]; last: [string, number][] }

/** 去重 + 冷却：同一 agent 的同一 taskId 只提醒一次；冷却内新认出的攒到 pending，冷却过了一起发。
 *  sent / last 经 snapshot 落盘、构造时还原：bridge 重启不重发、不重置冷却（pending 不落盘，重启后首扫按新鲜窗口重新认出） */
export class KilledNoticeGate {
  private sent: Map<string, number>;
  private last: Map<string, number>;
  private pending = new Map<string, Set<string>>();

  constructor(private readonly cooldownMs = BG_KILLED_COOLDOWN_MS, state?: KilledNoticeState) {
    this.sent = new Map(state?.sent ?? []);
    this.last = new Map(state?.last ?? []);
  }

  offer(agent: string, ids: readonly string[]): void {
    const fresh = ids.filter((id) => !this.sent.has(`${agent}\0${id}`));
    if (!fresh.length) return;
    const p = this.pending.get(agent) ?? new Set<string>();
    for (const id of fresh) p.add(id);
    this.pending.set(agent, p);
  }

  /** 冷却已过、有待发 taskId 的 agent；发成功后调 done，没调就下轮再给 */
  due(now: number): { agent: string; ids: string[] }[] {
    return [...this.pending]
      .filter(([agent, ids]) => ids.size && now - (this.last.get(agent) ?? -Infinity) >= this.cooldownMs)
      .map(([agent, ids]) => ({ agent, ids: [...ids] }));
  }

  done(agent: string, ids: readonly string[], now: number): void {
    const p = this.pending.get(agent);
    for (const id of ids) {
      this.sent.set(`${agent}\0${id}`, now);
      p?.delete(id);
    }
    if (!p?.size) this.pending.delete(agent);
    this.last.set(agent, now);
  }

  snapshot(now: number): KilledNoticeState {
    const keep = ([, t]: [string, number]) => now - t < Math.max(SENT_KEEP_MS, this.cooldownMs);
    return { sent: [...this.sent].filter(keep), last: [...this.last].filter(keep) };
  }
}

export function isKilledNoticeState(d: unknown): d is KilledNoticeState {
  const pairs = (v: unknown) => Array.isArray(v) && v.every((x) => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "number");
  return !!d && typeof d === "object" && pairs((d as KilledNoticeState).sent) && pairs((d as KilledNoticeState).last);
}
