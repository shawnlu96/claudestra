/**
 * team-project-S2F3: a card created only on the center has no local start_node to copy its DAG node's fileGlobs into extra, so
 * the planner refuses it (file_scope). The projection lands the scope from the center view instead: the node the card is bound
 * to in view.dag.bindings gives extra.fileGlobs. Pure mapping plus a thin reader; writeTasks passes the result to taskExtra.
 */
import type { Database } from "bun:sqlite";
import { isPrivateRepoGlob } from "./shared-ledger-source-dag-push-version.js";
import { TERMINAL_INTENT, type V2FeatureView } from "./shared-ledger-v2-projection-rows.js";

interface ProjectionGlobs {
  /** taskId → fileGlobs to write; a card left out keeps its local extra.fileGlobs verbatim. */
  write: Map<string, string[]>;
  /** Cards whose bound node scope differs from the local one but a live center intent holds it back (re-judged next view). */
  deferred: string[];
}
export interface ProjectionGlobsRef { observe?(taskId: string, code: string): void }

const sameGlobs = (local: unknown, want: readonly string[]): boolean =>
  Array.isArray(local) && local.length === want.length && local.every((g, i) => g === want[i]);

/**
 * Pure: `local` is each existing local card's extra (absent for a new card). Rules (PM 定 2-4): no binding / no DAG → keep;
 * a local repo: scope → keep (uploads drop private globs, the center node is not that card's real scope); a live center
 * intent (status not done / cancelled) → keep and defer; otherwise a copy of the bound node's fileGlobs (an empty node writes []).
 */
export function projectionGlobs(view: V2FeatureView, local: ReadonlyMap<string, Record<string, unknown>>): ProjectionGlobs {
  const write = new Map<string, string[]>(), deferred: string[] = [];
  if (!view.dag) return { write, deferred };
  const nodes = new Map(view.dag.nodes.map(n => [n.key, n.fileGlobs]));
  const live = new Set(view.intents.filter(i => !TERMINAL_INTENT.includes(i.status)).map(i => i.taskId));
  for (const b of view.dag.bindings) {
    const want = nodes.get(b.nodeKey), have = local.get(b.taskId)?.fileGlobs;
    if (!want) continue; // the contract guarantees the node exists (parseDag); nothing to fall back to
    if (Array.isArray(have) && have.some(g => typeof g === "string" && isPrivateRepoGlob(g))) continue;
    if (live.has(b.taskId)) { if (!sameGlobs(have, want)) deferred.push(b.taskId); continue; }
    write.set(b.taskId, [...want]);
  }
  return { write, deferred };
}

function localExtra(db: Database, id: string): Record<string, unknown> | null {
  const row = db.query("SELECT extra FROM tasks WHERE id = ?").get(id) as { extra: string } | null;
  if (!row) return null;
  try { const v = JSON.parse(row.extra) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}; }
  catch { return {}; } // writeTasks refuses unreadable extra itself (projection_extra); here it only means "no local scope"
}

/** Reads the view's existing local cards, maps them, and reports each deferred card once (observe, else console.warn). */
export function projectedGlobs(db: Database, view: V2FeatureView, ref: ProjectionGlobsRef): Map<string, string[]> {
  const local = new Map<string, Record<string, unknown>>();
  for (const t of view.tasks) { const extra = localExtra(db, t.id); if (extra) local.set(t.id, extra); }
  const { write, deferred } = projectionGlobs(view, local);
  for (const id of deferred) {
    if (ref.observe) ref.observe(id, `projection_globs_deferred:${id}`);
    else console.warn(`[shared-ledger-v2-projection projection_globs_deferred] ${id}`);
  }
  return write;
}
