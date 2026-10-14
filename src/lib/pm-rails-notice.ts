/**
 * PMR-2 给 owner 的三类推送（只在 pmRails=on 的项目上发，发送 / 落盘在 manager/pm-rails-cmds.ts 的 `ledger pm-rails-tick`）：
 * - 干预：同一张卡从第一条干预起 10 分钟内的合成一条，窗口满了才发（不打扰：走本机 owner 通知，不开「待你处理」）；
 * - 停住：自动卡的调度意图停在 unknown（引擎静默 held）满 30 分钟推一次，同一意图同一状态版本（updatedAt）不再推；
 * - 每日汇总：本机时间 10:00 之后发一条，汇总前一天 10:00 到当天 10:00 的干预；没有就不发。
 * 只推 on 期间打的标（intervention.mode = "on"）：observe 期的干预切 on 后不补推，切 on 之后、第一轮 tick 之前的也不丢。
 * 纯查询 + 拼文案，状态（各卡推到哪条、推过的停住、汇总日期）由调用方存。tests/pm-rails.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { toEvent } from "./ledger-store.js";

const PM_RAILS_MERGE_MS = 10 * 60_000;
const PM_RAILS_STALL_MS = 30 * 60_000;
const PM_RAILS_DIGEST_HOUR = 10;
/** 一条推送里最多列这么多个事件号，多的折成「等 N 条」 */
const SEQ_MAX = 8;
/** 项目级干预（冻结 / 解冻）在分组里用的卡名 */
export const PROJECT_TARGET = "(项目)";

/** 单次推送往回看多久：bridge 停了这么久之后不再逐条补推（每日汇总照样带上） */
export const PM_RAILS_LOOKBACK_MS = 48 * 3600_000;

export interface PmRailsProjectState { cards: Record<string, number>; stalls: string[] }
export interface PmRailsState { projects: Record<string, PmRailsProjectState>; digestDay?: string }

type Intervention = { cmd?: unknown; by?: unknown };
const iv = (e: LedgerEvent): Intervention => (e.data.intervention ?? {}) as Intervention;
const cardOf = (e: LedgerEvent): string => e.target || PROJECT_TARGET;

/** on 期间打标的干预事件 */
export function interventionEvents(db: Database, q: { project: string; fromTs: number; toTs?: number }): LedgerEvent[] {
  const rows = db.query(`SELECT * FROM events WHERE project = ? AND ts >= ? AND ts < ? AND json_extract(data, '$.intervention.mode') = 'on' ORDER BY seq`)
    .all(q.project, q.fromTs, q.toTs ?? Number.MAX_SAFE_INTEGER) as Record<string, unknown>[];
  return rows.map(toEvent);
}

/** 「谁 · 命令×次数」一行一个人，带事件号 */
function tally(events: readonly LedgerEvent[]): string[] {
  const by = new Map<string, Map<string, number>>();
  for (const e of events) {
    const who = String(iv(e).by ?? e.actor), cmd = String(iv(e).cmd ?? e.kind);
    const m = by.get(who) ?? new Map<string, number>();
    m.set(cmd, (m.get(cmd) ?? 0) + 1);
    by.set(who, m);
  }
  return [...by].map(([who, m]) => `${who}：${[...m].map(([cmd, n]) => `${cmd}×${n}`).join("、")}`);
}

function seqList(events: readonly LedgerEvent[]): string {
  const shown = events.slice(0, SEQ_MAX).map((e) => `#${e.seq}`).join(" ");
  return events.length > SEQ_MAX ? `${shown} 等 ${events.length} 条` : shown;
}

export interface CardPush { card: string; lastSeq: number; text: string }

/** 各卡还没推的干预里，第一条已满 10 分钟的那一组（从它起 10 分钟内的）合成一条；一张卡可能一次出几组 */
export function cardPushes(project: string, events: readonly LedgerEvent[], st: PmRailsProjectState, now: number): CardPush[] {
  const groups = new Map<string, LedgerEvent[]>();
  for (const e of events) {
    if (e.seq <= (st.cards[cardOf(e)] ?? 0)) continue;
    groups.set(cardOf(e), [...(groups.get(cardOf(e)) ?? []), e]);
  }
  const out: CardPush[] = [];
  for (const [card, list] of groups) {
    let rest = list;
    while (rest.length && rest[0].ts <= now - PM_RAILS_MERGE_MS) {
      const end = rest[0].ts + PM_RAILS_MERGE_MS;
      const group = rest.filter((e) => e.ts < end);
      rest = rest.slice(group.length);
      out.push({ card, lastSeq: group.at(-1)!.seq, text: [`[人工干预] ${project} · ${card}（自动卡）`, ...tally(group), `台账事件 ${seqList(group)}`].join("\n") });
    }
  }
  return out;
}

export interface Stall { key: string; text: string }

/** 自动卡上停在 unknown 满 30 分钟的意图；key = 意图 + 状态版本，推过的调用方记下 */
export function stalledIntents(db: Database, project: string, now: number): Stall[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_intents'").get()) return [];
  const rows = db.query("SELECT id, taskId, node, action, updatedAt FROM scheduler_intents WHERE project = ? AND status = 'unknown' AND updatedAt <= ? ORDER BY updatedAt")
    .all(project, now - PM_RAILS_STALL_MS) as { id: string; taskId: string; node: string; action: string; updatedAt: number }[];
  return rows.filter((r) => getWorkflow(db, r.taskId)?.mode === "auto").map((r) => ({
    key: `${r.id}@${r.updatedAt}`,
    text: `[调度停住] ${project} · ${r.taskId}：意图 ${r.id}（${r.node} / ${r.action}）停在 unknown 已 ${Math.floor((now - r.updatedAt) / 60_000)} 分钟，引擎不会自己往下走`,
  }));
}

const dayStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** 本机时间今天 10:00 已过且今天还没汇总：返回汇总窗口 [昨天 10:00, 今天 10:00) */
export function digestWindow(now: number, lastDay: string | undefined): { day: string; fromTs: number; toTs: number } | null {
  const d = new Date(now);
  if (d.getHours() < PM_RAILS_DIGEST_HOUR || dayStr(d) === lastDay) return null;
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), PM_RAILS_DIGEST_HOUR).getTime();
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, PM_RAILS_DIGEST_HOUR).getTime();
  return { day: dayStr(d), fromTs: from, toTs: to };
}

/** 每日汇总正文：按项目、卡分段；没有干预返回 null（不发） */
export function digestText(day: string, events: readonly LedgerEvent[]): string | null {
  if (!events.length) return null;
  const lines = [`[人工干预 · 每日汇总] 截至 ${day} ${PM_RAILS_DIGEST_HOUR}:00 的 24 小时，自动卡上共 ${events.length} 次`];
  const cards = new Map<string, LedgerEvent[]>();
  for (const e of events) cards.set(`${e.project} · ${cardOf(e)}`, [...(cards.get(`${e.project} · ${cardOf(e)}`) ?? []), e]);
  for (const [card, list] of cards) lines.push(`• ${card}（${list.length} 次）`, ...tally(list).map((l) => `  ${l}`), `  台账事件 ${seqList(list)}`);
  return lines.join("\n");
}
