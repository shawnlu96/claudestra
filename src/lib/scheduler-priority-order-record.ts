/**
 * PRIO2 samples: one project-level `note` (data.op=priority-sort-sample) per (entry, candidates with their band / source / version /
 * owner place, old order, new order, claim result). The dedup key is that content's hash, so a repeated tick over the same facts
 * never writes again while any change of candidates, band version or outcome writes one new sample. An entry's first sample is
 * always kept (PM checks every entry is covered); after that only a differing order or outcome is. Under observe this is the only
 * effect of the mechanism.
 *
 * Sorting never writes: the scheduler pass reads the ledger through a read-only handle and manualTurn / the autostart pick are pure
 * reads. A sample is queued here and written after the auto tick by flushPrioritySamples through the pass's scheduler-identity
 * ledger CLI (`scheduler-priority-sample`, scheduler-priority-order-cmd.ts); a write that fails is logged and dropped, so a sample never changes what the caller runs.
 */
import { createHash } from "node:crypto";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { Blocked, PrioritySortEntry, Ranked, SortOptions } from "./scheduler-priority-order.js";

export const PRIORITY_SORT_OP = "priority-sort-sample";
export const PRIORITY_SAMPLE_CMD = "scheduler-priority-sample";

export interface SampleInput<T> {
  ranked: Ranked<T>[];
  /** The full new order (observe and on projects sorted). */
  would: Ranked<T>[];
  opts: Pick<SortOptions<T>, "queue">;
  now?: number;
  claim?: { legacy: T | null; would: T | null; blocked: Blocked[] };
  /** A list shared by several entries: each candidate's own entry; the sample is labelled with the entries present. */
  entryOf?: (r: Ranked<T>) => PrioritySortEntry;
  contest?: string;
  /** The ledger file the candidates were read from; a pass flushes only its own ledger's samples. */
  ledger?: string;
}

const idOf = <T>(r: Ranked<T>): string =>
  r.key.taskId ?? (r.key.featureId ? `${r.key.featureId}${r.key.nodeKey ? `/${r.key.nodeKey}` : ""}` : `#${r.index}`);

/** What the sample says for one project: its candidates in old and new order, and why each sits where it does. */
function sampleData<T>(entry: PrioritySortEntry, project: string, input: SampleInput<T>) {
  const mine = (r: Ranked<T>) => r.key.project === project;
  const own = input.ranked.filter(mine), of = input.entryOf, pick = (x: T | null | undefined) => {
    const r = x == null ? undefined : input.ranked.find((y) => y.item === x);
    return r && mine(r) ? idOf(r) : null;
  };
  const legacy = own.map(idOf), would = input.would.filter(mine).map(idOf);
  return {
    op: PRIORITY_SORT_OP, mechanism: "prioritySort", entry: of ? [...new Set(own.map(of))].sort().join("+") : entry, mode: own[0]?.mode ?? "off", queue: input.opts.queue ?? "project",
    candidates: own.map((r) => ({ id: idOf(r), band: r.rank?.band ?? null, source: r.rank?.source ?? null, rev: r.rank?.rev ?? 0,
      order: r.rank?.order ?? null, pinned: r.pinned, ...(of ? { entry: of(r) } : {}) })),
    legacy, would, changed: would.some((id, i) => id !== legacy[i]),
    ...(input.claim ? { claim: { legacy: pick(input.claim.legacy), would: pick(input.claim.would),
      blocked: input.claim.blocked.filter((b) => b.project === project).map((b) => ({ id: b.taskId, band: b.band, why: b.why })) } } : {}),
    ...(input.contest ? { contest: input.contest } : {}),
  };
}

export function sampleText(d: SampleData): string {
  const head = `优先级排序${d.mode === "on" ? "" : "观察"}（${d.entry}）`;
  const order = d.changed ? `旧 ${d.legacy.slice(0, 5).join("→")}，新 ${d.would.slice(0, 5).join("→")}` : `新旧同序 ${d.legacy.slice(0, 5).join("→")}`;
  const claim = d.claim ? `；认领 旧 ${d.claim.legacy ?? "无"} / 新 ${d.claim.would ?? "无"}${d.claim.blocked.length
    ? `，卡点 ${d.claim.blocked.slice(0, 3).map((b) => `${b.id}(${b.band})：${b.why}`).join("；")}` : ""}` : "";
  const text = `${head}：${order}${claim}${d.contest ? `；合并竞争本会 ${d.contest}` : ""}`;
  return text.length > 600 ? `${text.slice(0, 599)}…` : text;
}

/** One queued sample: a project-level note under its content hash. */
export interface PrioritySample { project: string; dedupKey: string; data: SampleData; now: number; ledger: string }
export type SampleData = ReturnType<typeof sampleData>;

/** Queued samples by dedup key, the keys already handed to the writer, the (project, entry) pairs sampled at least once. */
const pending = new Map<string, PrioritySample>(), handed = new Set<string>(), covered = new Set<string>();
const LIMIT = 2000;
/** At most this many samples per flush; older ones beyond it are dropped with one log line. */
const FLUSH_MAX = 20;
const SHOWN = 20;

/**
 * Worth a sample: the new order or outcome differs from the old one, or the first real competition (two candidates or more) this
 * entry saw (coverage for PM). A lone candidate competes with nobody: nothing to sample.
 */
const telling = (d: SampleData, first: boolean): boolean =>
  (first && d.candidates.length > 1) || d.changed || (!!d.claim && (d.claim.legacy !== d.claim.would || d.claim.blocked.length > 0)) || (!!d.contest && d.contest !== "tie");

/**
 * Queues at most one sample per non-off project in the list. The same facts queue once per process; the ledger write is
 * deduplicated again by the same key, so a restart costs nothing either. Returns how many were queued.
 */
export function recordPrioritySort<T>(entry: PrioritySortEntry, input: SampleInput<T>): number {
  const projects = [...new Set(input.ranked.filter((r) => r.mode !== "off").map((r) => r.key.project))];
  let queued = 0;
  for (const project of projects) {
    const full = sampleData(entry, project, input), cover = JSON.stringify([project, full.entry]);
    if (!telling(full, !covered.has(cover))) continue;
    const dedupKey = `priority-sort:${createHash("sha256").update(JSON.stringify([project, full])).digest("hex").slice(0, 40)}`;
    if (handed.has(dedupKey) || pending.has(dedupKey)) continue;
    if (covered.size >= LIMIT) covered.clear();
    covered.add(cover);
    if (pending.size >= LIMIT) pending.delete(pending.keys().next().value!);
    const data = { ...full, legacy: full.legacy.slice(0, SHOWN), would: full.would.slice(0, SHOWN), candidates: full.candidates.slice(0, SHOWN) };
    pending.set(dedupKey, { project, dedupKey, data, now: input.now ?? Date.now(), ledger: input.ledger ?? "" });
    queued++;
  }
  return queued;
}

/** The scheduler-identity ledger CLI (the pass's manager): the only writer of samples. */
export type SampleManager = (...args: string[]) => Promise<Record<string, unknown>>;

/**
 * Writes the queued samples read from `db`'s ledger (all of them without one) through `ledger scheduler-priority-sample`, at most
 * FLUSH_MAX per call (the newest; older ones are dropped with one log line). A refused write is logged and not retried; it never fails the pass.
 */
export async function flushPrioritySamples(manager: SampleManager, db?: { filename: string } | null): Promise<number> {
  const all = [...pending.values()].filter((s) => !db || s.ledger === db.filename);
  for (const s of all) pending.delete(s.dedupKey);
  const batch = all.slice(-FLUSH_MAX);
  if (all.length > batch.length) console.warn(`[priority-sort] 本轮样本 ${all.length} 条超过上限 ${FLUSH_MAX}，丢掉最旧的 ${all.length - batch.length} 条`);
  let written = 0;
  for (const s of batch) {
    if (handed.size >= LIMIT) handed.clear();
    handed.add(s.dedupKey);
    try {
      const r = await manager("ledger", "scheduler-priority-sample", "--project", s.project, "--dedup", s.dedupKey, "--data", JSON.stringify(s.data));
      if (r.ok !== true) console.warn(`[priority-sort] ${s.project} ${s.data.entry} 样本没记上：${String(r.error ?? "manager failed")}`);
      else if (r.duplicate !== true) written++;
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e; // a lost lease ends the pass, it is not a lost sample
      console.warn(`[priority-sort] ${s.project} ${s.data.entry} 样本没记上：${(e as Error).message}`);
    }
  }
  return written;
}

/** Tests only: the queue as it stands, and a clean process. */
export const pendingPrioritySamples = (): PrioritySample[] => [...pending.values()];
export const resetPrioritySamples = (): void => { pending.clear(); handed.clear(); covered.clear(); };
