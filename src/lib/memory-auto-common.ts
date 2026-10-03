/** Event references and bounded templates shared by the local automatic writers. */
import type { Database } from "bun:sqlite";
import { listEvents, toEvent } from "./ledger-store.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { MemorySourceRef } from "./ledger-memory-fold.js";
import { getMemory, type Memory } from "./ledger-memory.js";

export const autoSource = (e: LedgerEvent): MemorySourceRef =>
  e.origin != null && e.originSeq != null ? { origin: e.origin, originSeq: e.originSeq } : { seq: e.seq };
export const sourceKey = (s: MemorySourceRef): string => "seq" in s ? `seq/${s.seq}` : `${s.origin}/${s.originSeq}`;

/** Business answers belong in both the index and the completion facts; permission/AUQ and partial answers do not. */
export function autoDecisionAllowed(db: Database, e: LedgerEvent): boolean {
  if (!e.data.askId) return !["permission", "auq"].includes(String(e.data.via));
  const ask = db.query("SELECT kind, source FROM asks WHERE id = ? AND project = ?").get(String(e.data.askId), e.project) as
    { kind: string; source: string } | null;
  return !!ask && ["decide", "authorize"].includes(ask.kind) && !["permission", "auq"].includes(ask.source) && e.data.partial !== true;
}

/** Template fields are bounded before linting; user-written memories still reject overlong input. */
export function autoClip(text: string, max: number): string {
  let out = "";
  for (const c of text) { if (Buffer.byteLength(out + c) > max) break; out += c; }
  return out;
}

export function projectMemories(db: Database, project: string): Memory[] {
  return (db.query("SELECT id FROM memories WHERE project = ? ORDER BY createdAt, id").all(project) as { id: string }[])
    .map((r) => getMemory(db, r.id)!);
}

/** Indexed receipt lookup bounds every pass and skips IO entirely once the backlog is consumed. */
export function pendingAutoEvents(db: Database, project: string, limit: number): LedgerEvent[] {
  const rows = db.query(`SELECT e.* FROM events e WHERE project = ? AND (kind = 'decision'
    OR kind = 'review' AND json_extract(data, '$.p1') > 0
    OR kind = 'stage' AND (json_extract(data, '$.to') IN ('live','done','verified','cancelled')
      OR json_extract(data, '$.from') = 'live' AND json_extract(data, '$.to') = 'fix'))
    AND NOT EXISTS (SELECT 1 FROM events r WHERE r.dedupKey = 'memory-auto:' || e.project || ':' ||
      CASE WHEN e.origin IS NOT NULL AND e.originSeq IS NOT NULL THEN e.origin || '/' || e.originSeq ELSE 'seq/' || e.seq END)
    ORDER BY seq LIMIT ?`).all(project, Math.min(100, Math.max(1, limit))) as Record<string, unknown>[];
  return rows.map(toEvent);
}

/** PR verification events may carry facts; fall back to the declared scope until PR files can be collected. */
export function autoFiles(task: LedgerTask, events: readonly LedgerEvent[]): string[] {
  for (const e of [...events].reverse()) {
    const facts = e.data.facts as { pr?: { files?: unknown } } | undefined;
    const files = facts?.pr?.files ?? e.data.files;
    if (Array.isArray(files) && files.every((f) => typeof f === "string")) return [...new Set(files as string[])].slice(0, 20);
  }
  return Array.isArray(task.extra.fileGlobs) ? task.extra.fileGlobs.filter((f): f is string => typeof f === "string").slice(0, 20) : [];
}

export const taskEvents = (db: Database, task: LedgerTask): LedgerEvent[] => listEvents(db, { project: task.project, target: task.id });
