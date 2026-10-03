/** Local event consumer. Receipts and writes commit together; replay and concurrent observers cannot duplicate effects. */
import type { Database } from "bun:sqlite";
import { getEventByDedup, getTask, LedgerError, toEvent } from "./ledger-store.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { ORIGIN_VALUES, originArgs } from "./ledger-origin.js";
import { markMemory, memoryState, listMarks, recordMemory, secretHits } from "./ledger-memory.js";
import { memoryLint, lintText } from "./memory-lint.js";
import { resourceKey } from "./ledger-scheduler.js";
import { autoClip, autoDecisionAllowed, autoSource, pendingAutoEvents, projectMemories, sourceKey } from "./memory-auto-common.js";
import { getFeature } from "./ledger-feature.js";
import { autoPitfalls } from "./memory-auto-pitfalls.js";
import { prepareSummary, saveSummary, type SummaryDeps } from "./memory-auto-summary.js";

export interface AutoDeps extends SummaryDeps { assertLease?(): void; limit?: number; hasPath?(path: string): boolean }
export interface AutoResult { recorded: number; rejected: { seq: number; code: string }[] }
const receiptKey = (e: LedgerEvent) => `memory-auto:${e.project}:${sourceKey(autoSource(e))}`;

function indexDecision(db: Database, e: LedgerEvent): void {
  if (!autoDecisionAllowed(db, e)) return;
  if ((e.origin != null || e.originSeq != null) &&
    (!e.origin || !/^[0-9a-z]{4}$/.test(e.origin) || !Number.isInteger(e.originSeq) || (e.originSeq ?? 0) < 1)) {
    throw new LedgerError("invalid", "决定来源身份不完整或序号非法，拒绝索引");
  }
  if (secretHits({ text: e.text }).length) throw new LedgerError("invalid", "决定原文含敏感信息，拒绝索引");
  const task = getTask(db, e.target);
  const feature = !task ? getFeature(db, e.target) : null;
  const input = { project: e.project, kind: "decision" as const, title: autoClip(e.text, 80), body: autoClip(e.text, 600),
    sources: [autoSource(e)], authorRole: "system" as const,
    ...(task?.project === e.project ? { taskId: task.id } : feature?.project === e.project ? { featureId: feature.id } : {}),
    ...(e.origin && e.originSeq ? { via: "decision_index" as const, decisionOf: { origin: e.origin, originSeq: e.originSeq } }
      : { via: "tool" as const, visibility: "home" as const }) };
  const lint = memoryLint(db, input);
  if (!lint.ok) throw new LedgerError("invalid", lint.error);
  recordMemory(db, { actor: "scheduler", now: e.ts }, input);
}

function lifecycle(db: Database, e: LedgerEvent): void {
  const task = getTask(db, e.target);
  if (!task || task.project !== e.project) return;
  const mark = e.data.to === "cancelled" ? "unlink_fix" : e.data.from === "live" && e.data.to === "fix" ? "reopen" :
    e.data.to === "live" || task.kind !== "code" && ["done", "verified"].includes(String(e.data.to)) ? "fixed" : null;
  if (!mark) return;
  for (const m of projectMemories(db, e.project).filter((m) => m.kind === "pitfall" && m.fixable)) {
    const state = memoryState(db, m.id)!;
    const link = listMarks(db, m.id).findLast((r) => r.mark === "link_fix" && r.taskId === task.id);
    if (state.fixTask !== task.id || !link || e.ts < link.ts || ["retracted", "superseded"].includes(state.status)) continue;
    const source = autoSource(e);
    markMemory(db, { actor: "scheduler", now: Math.max(e.ts, link.ts) }, { memoryId: m.id, taskId: task.id, mark, source,
      dedupKey: `auto:${mark}:${m.id}:${task.id}:${sourceKey(source)}` });
  }
}

function receipt(db: Database, e: LedgerEvent, code?: string, files?: string[] | null): void {
  db.prepare(`INSERT INTO events (ts, actor, project, target, kind, text, data, dedupKey, origin, originSeq)
    VALUES (?, 'scheduler', ?, ?, 'memory', '', ?, ?, ${ORIGIN_VALUES})`)
    .run(e.ts, e.project, e.target, JSON.stringify({ op: "auto_observed", source: autoSource(e),
      ...(code ? { rejected: code } : {}), ...(files ? { files } : {}) }), receiptKey(e), ...originArgs(db));
}

/** Cache PR files on the receipt for later cross-card intersections; the source callback never runs inside a write lock. */
async function reviewFiles(db: Database, e: LedgerEvent, deps: AutoDeps): Promise<string[] | null> {
  const task = getTask(db, e.target);
  if (!task || !deps.files || e.kind !== "review") return null;
  const files = (await deps.files(task))?.slice(0, 20) ?? null;
  if (!files) return null;
  const lint = lintText({ project: e.project, kind: "decision", title: "Review file scope", body: "Review provenance",
    files, via: "tool", authorRole: "system" });
  if (!lint.ok || files.some((p) => !resourceKey(p) || /^[~/\\]/.test(p) || /^[A-Za-z]:/.test(p))) {
    console.warn(`[memory-auto] review ${e.seq} file scope rejected; using declared scope`); return null;
  }
  return [...new Set(files)];
}

/** Scheduler identity is required even for direct library calls; model IO never holds a ledger write lock. */
export async function observeMemory(db: Database, actor: string, project: string, deps: AutoDeps = {}): Promise<AutoResult> {
  if (actor !== "scheduler" || !deps.assertLease) throw new LedgerError("forbidden", "自动记忆只由有租约的调度服务写入");
  deps.assertLease();
  const out: AutoResult = { recorded: 0, rejected: [] };
  const pending = pendingAutoEvents(db, project, deps.limit ?? 100);
  for (const e of pending) {
    let summary: Awaited<ReturnType<typeof prepareSummary>> = null;
    const files = await reviewFiles(db, e, deps);
    let rejected: string | undefined;
    try {
      if (e.kind === "stage" && (e.data.to === "verified" || e.data.to === "done" && getTask(db, e.target)?.kind !== "code")) {
        summary = await prepareSummary(db, e, deps);
      }
    } catch (err) {
      if (!(err instanceof LedgerError) || err.code !== "invalid") throw err;
      rejected = err.code;
      console.warn(`[memory-auto] source ${e.seq} summary rejected by lint`);
    }
    deps.assertLease?.();
    db.transaction(() => {
      deps.assertLease?.(); // BEGIN IMMEDIATE may have waited for another writer; recheck after acquiring the lock.
      if (getEventByDedup(db, receiptKey(e))) return;
      const sourceNow = db.query("SELECT * FROM events WHERE seq = ? AND project = ?").get(e.seq, project) as Record<string, unknown> | null;
      if (!sourceNow || JSON.stringify(toEvent(sourceNow)) !== JSON.stringify(e)) throw new LedgerError("conflict", "记忆来源事实已变化，请重试");
      try {
        db.transaction(() => {
          if (e.kind === "review") {
            const rows = db.query("SELECT * FROM events WHERE project = ? AND kind = 'review' AND ts >= ? AND seq <= ? ORDER BY seq")
              .all(project, e.ts - 30 * 86400_000, e.seq) as Record<string, unknown>[];
            autoPitfalls(db, e, rows.map(toEvent), deps.hasPath, files);
          }
          if (e.kind === "decision") indexDecision(db, e);
          if (e.kind === "stage") lifecycle(db, e);
          if (summary) saveSummary(db, e, summary);
        })();
      } catch (err) {
        if (!(err instanceof LedgerError) || err.code !== "invalid") throw err;
        rejected = err.code;
        console.warn(`[memory-auto] source ${e.seq} rejected by lint`);
      }
      receipt(db, e, rejected, files);
      out.recorded++;
      if (rejected) out.rejected.push({ seq: e.seq, code: rejected });
    }).immediate();
  }
  return out;
}
