/**
 * PRIO2 samples: one project-level `note` per (entry, candidates with their band / source / version / owner place, old order, new
 * order, claim result). The dedup key is that content's hash, so a repeated tick over the same facts never writes again while any
 * change of candidates, band version or outcome writes one new sample. Under observe this is the only effect of the mechanism.
 * A write that fails (read-only handle, busy ledger) is swallowed: a sample never changes what the caller runs.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendEvent } from "./ledger-write.js";
import type { Blocked, PrioritySortEntry, Ranked, SortOptions } from "./scheduler-priority-order.js";

export const PRIORITY_SORT_OP = "priority-sort-sample";

export interface SampleInput<T> {
  ranked: Ranked<T>[];
  /** The full new order (observe and on projects sorted). */
  would: Ranked<T>[];
  opts: Pick<SortOptions<T>, "queue">;
  now?: number;
  claim?: { legacy: T | null; would: T | null; blocked: Blocked[] };
  contest?: string;
}

const idOf = <T>(r: Ranked<T>): string => r.key.taskId ?? `#${r.index}`;

/** What the sample says for one project: its candidates in old and new order, and why each sits where it does. */
function sampleData<T>(entry: PrioritySortEntry, project: string, input: SampleInput<T>) {
  const mine = (r: Ranked<T>) => r.key.project === project;
  const own = input.ranked.filter(mine), pick = (x: T | null | undefined) => {
    const r = x == null ? undefined : input.ranked.find((y) => y.item === x);
    return r && mine(r) ? idOf(r) : null;
  };
  const legacy = own.map(idOf), would = input.would.filter(mine).map(idOf);
  return {
    op: PRIORITY_SORT_OP, mechanism: "prioritySort", entry, mode: own[0]?.mode ?? "off", queue: input.opts.queue ?? "project",
    candidates: own.map((r) => ({ id: idOf(r), band: r.rank?.band ?? null, source: r.rank?.source ?? null, rev: r.rank?.rev ?? 0,
      order: r.rank?.order ?? null, pinned: r.pinned })),
    legacy, would, changed: would.some((id, i) => id !== legacy[i]),
    ...(input.claim ? { claim: { legacy: pick(input.claim.legacy), would: pick(input.claim.would),
      blocked: input.claim.blocked.filter((b) => b.project === project).map((b) => ({ id: b.taskId, band: b.band, why: b.why })) } } : {}),
    ...(input.contest ? { contest: input.contest } : {}),
  };
}

function sampleText(d: ReturnType<typeof sampleData>): string {
  const head = `优先级排序${d.mode === "on" ? "" : "观察"}（${d.entry}）`;
  const order = d.changed ? `旧 ${d.legacy.slice(0, 5).join("→")}，新 ${d.would.slice(0, 5).join("→")}` : `新旧同序 ${d.legacy.slice(0, 5).join("→")}`;
  const claim = d.claim ? `；认领 旧 ${d.claim.legacy ?? "无"} / 新 ${d.claim.would ?? "无"}${d.claim.blocked.length
    ? `，卡点 ${d.claim.blocked.slice(0, 3).map((b) => `${b.id}(${b.band})：${b.why}`).join("；")}` : ""}` : "";
  const text = `${head}：${order}${claim}${d.contest ? `；合并竞争本会 ${d.contest}` : ""}`;
  return text.length > 600 ? `${text.slice(0, 599)}…` : text;
}

/** Writes at most one sample per non-off project in the list. Returns how many were new (duplicates do not count). */
export function recordPrioritySort<T>(db: Database, entry: PrioritySortEntry, input: SampleInput<T>): number {
  const projects = [...new Set(input.ranked.filter((r) => r.mode !== "off").map((r) => r.key.project))];
  let written = 0;
  for (const project of projects) {
    const data = sampleData(entry, project, input);
    const dedupKey = `priority-sort:${createHash("sha256").update(JSON.stringify([project, data])).digest("hex").slice(0, 40)}`;
    try {
      const r = appendEvent(db, { actor: "scheduler", now: input.now ?? Date.now(), dedupKey },
        { project, target: "", kind: "note", text: sampleText(data), data });
      if (!r.duplicate) written++;
    } catch (e) {
      console.warn(`[priority-sort] ${project} ${entry} 样本没记上：${(e as Error).message}`);
    }
  }
  return written;
}
