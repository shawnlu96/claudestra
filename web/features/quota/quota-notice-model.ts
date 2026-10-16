/**
 * 顶部额度卡与额度摘要的纯模型（QUOTA1）：两个读数（/quota/wall 的闸、/lend/quota-lines 的两条线）→ 每族最多一行，取最严重的一条：
 * 用完（闸）> 不再接新活 > 到提醒线；闸恢复中那一行顶替 Claude 的线提醒。两族都有就两行，同一张卡。
 * 关掉按「实例 + 族 + 严重度 + 重置时刻」记（本设备 localStorage）：同一窗口里同级或更低的不再出，升级或进了新的重置窗口再出；
 * 恢复中单算一级（关过「用完」后开始恢复照样出一次）。旧的两个关闭键（额度闸横幅、额度提醒条）读一次迁过来，之后不再写。
 * tests/web-quota-notice-model.test.ts。文案是中文原文（词在 lib/owner-words QUOTA_WORDS），渲染点 t() 翻译。
 */
import { QUOTA_WORDS as Q } from "@/lib/owner-words";
import type { QuotaFamily, QuotaLinesView } from "../lend/lend-quota-model";
import { DISMISS_KEY as OLD_WARNING_KEY, FAMILY_LABEL, parseDismissed, RESET_JITTER_MS, warnStatus, warningItems } from "../lend/quota-warning-model";
import { localWhen, wallLine, type Phrase, type WallResponse } from "../quota-wall/wall-banner-model";

export type NoticeLevel = "warn" | "stop" | "out" | "recovering";

export interface NoticeRow {
  family: QuotaFamily;
  level: NoticeLevel;
  /** 关掉记录认的窗口：闸 = wall:enteredAt；线 = lines */
  id: string;
  reset: number | null;
  title: Phrase;
  detail: Phrase[];
  /** 「已恢复」两步确认（只有闸开着的那一行） */
  canClear: boolean;
}

const RANK: Record<NoticeLevel, number> = { warn: 1, stop: 2, out: 3, recovering: 0 };
const ORDER: QuotaFamily[] = ["claude", "codex"];

/** 两个读数 → 要出的行（Claude 在前）；读数 undefined / null = 那一份没有 */
export function noticeRows(lines: QuotaLinesView | null | undefined, wall: WallResponse | null | undefined, now: number): NoticeRow[] {
  const rows = new Map<QuotaFamily, NoticeRow>();
  for (const it of warningItems(lines, now)) {
    const detail: Phrase[] = [{ text: warnStatus(it), vars: {} },
      it.resetAt === null ? { text: "重置时间未知", vars: {} } : { text: "{when} 重置", vars: { when: localWhen(it.resetAt) } }];
    if (it.lastKnown) detail.push({ text: "上次读数", vars: {} });
    rows.set(it.family, { family: it.family, level: it.level, id: "lines", reset: it.resetAt, canClear: false, detail,
      title: { text: it.level === "stop" ? Q.stop : Q.warn, vars: { family: FAMILY_LABEL[it.family], pct: it.usedPct } } });
  }
  const w = wallLine(wall, now);
  if (w) rows.set("claude", { family: "claude", level: w.level, id: w.id, reset: w.resetsAt, title: w.title, detail: w.detail, canClear: w.canClear });
  return ORDER.flatMap((f) => rows.get(f) ?? []);
}

/** 摘要的一段：「Claude 本周已用 62%」+ 到线 / 用完时的状态字 */
export interface SummaryPart { family: string; pct: number; tag: Phrase | null; tone: "warning" | "error" | null }

/** 额度行 / 用量看板顶部摘要：每族本周已用 + 状态字；一族都读不到 = null（整行不出） */
export function summaryParts(lines: QuotaLinesView | null | undefined, wall: WallResponse | null | undefined, now: number): SummaryPart[] | null {
  const rows = new Map(noticeRows(lines, wall, now).map((r) => [r.family, r]));
  const out: SummaryPart[] = [];
  for (const f of ORDER) {
    const line = lines?.families.find((x) => x.family === f);
    if (!line || line.weekUsedPct === null) continue;
    const r = rows.get(f);
    const tag: Phrase | null = !r || r.level === "recovering" ? null
      : r.level === "warn" ? { text: Q.tagWarn, vars: {} }
      : r.level === "stop" ? { text: Q.tagStop, vars: {} }
      : r.reset === null ? { text: Q.tagOutNoTime, vars: {} } : { text: Q.tagOut, vars: { when: localWhen(r.reset) } };
    out.push({ family: FAMILY_LABEL[f], pct: Math.round(line.weekUsedPct), tag, tone: !tag ? null : r!.level === "warn" ? "warning" : "error" });
  }
  return out.length ? out : null;
}

export const usedPhrase = (p: SummaryPart): Phrase => ({ text: Q.used, vars: { family: p.family, pct: p.pct } });

// ── 关掉记录 ──

export const NOTICE_DISMISS_KEY = "cstra_quota_notice_dismissed";
export const OLD_WALL_KEY = "cstra_quota_wall_dismissed";
const MAX_SCOPES = 32;
const MAX_RECS = 4;

/** 关掉的一行：哪一级、哪个窗口 */
export interface DismissRec { level: NoticeLevel; id: string; reset: number | null }
/** 键 = 实例 fp|族 */
export type NoticeDismiss = Record<string, DismissRec[]>;

const scopeOf = (fp: string, family: QuotaFamily) => `${fp}|${family}`;

/** 同一个重置窗口：两边都有重置时刻就只比时刻（闸保留 enteredAt 也会改 resetsAt，如先碰 5 小时、后碰更晚的周额度 = 新窗口）；
 *  有一边缺时刻（旧闸横幅迁来的记录、恢复中的闸）才退回按同一道闸 enteredAt 认 */
function sameWindow(a: Pick<DismissRec, "id" | "reset">, b: Pick<DismissRec, "id" | "reset">): boolean {
  if (a.reset !== null && b.reset !== null) return Math.abs(a.reset - b.reset) <= RESET_JITTER_MS;
  if (a.id === b.id && a.id.startsWith("wall:")) return true;
  return a.reset === null && b.reset === null && a.id === b.id;
}

const covers = (r: DismissRec, row: NoticeRow) =>
  sameWindow(r, row) && (row.level === "recovering" ? r.level === "recovering" : r.level !== "recovering" && RANK[r.level] >= RANK[row.level]);

export function isRowDismissed(m: NoticeDismiss, fp: string, row: NoticeRow): boolean {
  return (m[scopeOf(fp, row.family)] ?? []).some((r) => covers(r, row));
}

const LEVELS = new Set<string>(["warn", "stop", "out", "recovering"]);
const isRec = (v: unknown): v is DismissRec => !!v && typeof v === "object" && LEVELS.has((v as DismissRec).level)
  && typeof (v as DismissRec).id === "string" && ((v as DismissRec).reset === null || Number.isFinite((v as DismissRec).reset));

/** 新键的内容；损坏 = 当没关过（最多多出一次，不会吞掉该出的） */
export function parseNoticeDismiss(raw: string | null): NoticeDismiss {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: NoticeDismiss = {};
    for (const [scope, list] of Object.entries(v)) {
      const recs = Array.isArray(list) ? list.filter(isRec).slice(-MAX_RECS) : [];
      if (recs.length) out[scope] = recs;
    }
    return out;
  } catch {
    return {};
  }
}

function add(m: NoticeDismiss, scope: string, recs: DismissRec[]): NoticeDismiss {
  const keep = (m[scope] ?? []).filter((r) => !recs.some((x) => x.level === r.level && x.id === r.id && x.reset === r.reset));
  const rest = Object.entries(m).filter(([k]) => k !== scope);
  return Object.fromEntries([...rest, [scope, [...keep, ...recs].slice(-MAX_RECS)]].slice(-MAX_SCOPES));
}

/** 关掉卡片：卡上每一行都记下 */
export function dismissRows(m: NoticeDismiss, fp: string, rows: NoticeRow[]): NoticeDismiss {
  return rows.reduce((acc, r) => add(acc, scopeOf(fp, r.family), [{ level: r.level, id: r.id, reset: r.reset }]), m);
}

/** 两份记录合并（别的 tab 落盘的 + 本页存不下的） */
export function mergeNoticeDismiss(a: NoticeDismiss, b: NoticeDismiss): NoticeDismiss {
  return Object.entries(b).reduce((acc, [scope, recs]) => add(acc, scope, recs), a);
}

/** 旧额度提醒条的记录 → 新记录：每个实例 / 家族取关掉过的最高一级，窗口是它记下的 resetAt */
function fromOldWarning(raw: string | null): NoticeDismiss {
  let out: NoticeDismiss = {};
  for (const [scope, rec] of Object.entries(parseDismissed(raw))) {
    const levels = rec.states.map((s) => s.split(":")[0]).filter((s) => s === "warn" || s === "stop");
    if (!levels.length) continue;
    const reset = Number(rec.gen.split("|")[0]);
    out = add(out, scope, [{ level: levels.includes("stop") ? "stop" : "warn", id: "lines", reset: Number.isFinite(reset) ? reset : null }]);
  }
  return out;
}

/** 旧额度闸横幅的记录（"enteredAt:active" / "enteredAt:recovering"，不分机器）→ 记到当前机器的 Claude 上 */
function fromOldWall(raw: string | null, fp: string): NoticeDismiss {
  const m = raw?.match(/^(.*):(active|recovering)$/);
  if (!m) return {};
  return { [scopeOf(fp, "claude")]: [{ level: m[2] === "active" ? "out" : "recovering", id: `wall:${m[1]}`, reset: null }] };
}

/** 读关掉记录：新键在就只用新键；还没有新键就把旧的两个键读一次迁过来（migrated = 调用方把结果写进新键，旧键不再写） */
export function loadNoticeDismiss(get: (k: string) => string | null, fp: string): { map: NoticeDismiss; migrated: boolean } {
  const raw = get(NOTICE_DISMISS_KEY);
  if (raw !== null) return { map: parseNoticeDismiss(raw), migrated: false };
  return { map: mergeNoticeDismiss(fromOldWarning(get(OLD_WARNING_KEY)), fromOldWall(get(OLD_WALL_KEY), fp)), migrated: true };
}
