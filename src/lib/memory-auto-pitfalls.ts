/** Review-backed pitfalls: explicit reviewer endorsement, or repeated canonical P1 families within thirty days. */
import type { Database } from "bun:sqlite";
import { getTask } from "./ledger-store.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { markMemory, memoryState, recordMemory, secretHits, type Memory } from "./ledger-memory.js";
import { memoryLint } from "./memory-lint.js";
import { countsAsP1, normalizedFamily, p1FindingStreak, type ReviewFinding } from "./scheduler-review.js";
import { autoClip, autoFiles, autoSource, projectMemories, sourceKey, taskEvents } from "./memory-auto-common.js";
import { mainHasPath } from "./review-converge-followup.js";
import { followUpGlobs, probeLead } from "./review-converge-followup-text.js";

const WINDOW = 30 * 86400_000;
interface Hit { event: LedgerEvent; finding: ReviewFinding; task: LedgerTask }

function findings(e: LedgerEvent): ReviewFinding[] {
  if (!Array.isArray(e.data.findings)) return [];
  return e.data.findings.filter((f): f is ReviewFinding => !!f && typeof f === "object" &&
    typeof f.family === "string" && /^[\w.-]{1,64}$/.test(f.family) && typeof f.probe === "string" &&
    typeof f.findingId === "string" && f.severity === "P1");
}

function hitsFor(db: Database, e: LedgerEvent, all: readonly LedgerEvent[], family: string): Hit[] {
  const hits: Hit[] = [];
  for (const r of all) {
    if (r.kind !== "review" || r.seq > e.seq || r.ts > e.ts || r.ts < e.ts - WINDOW) continue;
    const task = getTask(db, r.target);
    if (!task || task.project !== e.project) continue;
    for (const f of findings(r)) {
      if (normalizedFamily(f.family) !== family) continue;
      if (f.pitfall !== true && !countsAsP1(taskEvents(db, task), Number(r.data.round), f)) continue;
      hits.push({ event: r, finding: f, task });
    }
  }
  return hits;
}

function pitfallFiles(db: Database, hits: Hit[], currentTask: string, files: string[] | null): string[] {
  const sets = hits.map((h) => h.task.id === currentTask && files ? files : autoFiles(h.task, taskEvents(db, h.task)));
  const common = sets[0]?.filter((f) => sets.every((s) => s.includes(f))) ?? [];
  if (common.length) return common.slice(0, 20);
  const dirs = sets.flat().map((f) => f.includes("/") ? `${f.slice(0, f.lastIndexOf("/"))}/**` : f);
  return [...new Set(dirs)].sort().slice(0, 5);
}

function existingPitfall(db: Database, project: string, family: string): Memory | undefined {
  const rows = projectMemories(db, project).filter((m) => m.kind === "pitfall" && m.family && normalizedFamily(m.family) === family);
  return rows.find((m) => ["open", "fixing"].includes(memoryState(db, m.id)!.status))
    ?? rows.find((m) => memoryState(db, m.id)!.status === "candidate");
}

function confirm(db: Database, memory: Memory, e: LedgerEvent): void {
  const source = autoSource(e);
  markMemory(db, { actor: "scheduler", now: e.ts }, { memoryId: memory.id, mark: "confirm", source,
    dedupKey: `auto:confirm:${memory.id}:${e.target}:${sourceKey(source)}` });
}

/** Called under the observer's IMMEDIATE transaction, after the verdict is committed and read back from events. */
export function autoPitfalls(db: Database, e: LedgerEvent, all: readonly LedgerEvent[], hasPath = mainHasPath(), files: string[] | null = null): void {
  const task = getTask(db, e.target);
  if (!task || task.project !== e.project) return;
  for (const f of findings(e)) {
    if (secretHits({ probe: f.probe }).length) { console.warn(`[memory-auto] review ${e.seq} sensitive finding skipped`); continue; }
    const family = normalizedFamily(f.family);
    if (!family) continue;
    const hits = hitsFor(db, e, all, family);
    const cards = new Set(hits.map((h) => h.task.id)).size;
    const explicit = f.pitfall === true;
    const sourceRevision = taskEvents(db, task).findLast((r) => r.seq <= e.seq && r.kind === "stage" && typeof r.data.specRev === "number")?.data.specRev;
    const streak = p1FindingStreak(taskEvents(db, task), f, Number(e.data.round));
    if (!explicit && (cards < 2 && (streak ?? 0) < 2)) continue;
    const prev = existingPitfall(db, e.project, family);
    if (prev) {
      const state = memoryState(db, prev.id)!;
      if (state.status !== "candidate" || explicit || cards >= 3) confirm(db, prev, e);
      continue;
    }
    const input = { project: e.project, kind: "pitfall" as const, family, taskId: task.id,
      title: autoClip(probeLead(f.probe) || family, 80), symptom: autoClip(f.probe, 300),
      rule: autoClip(`避免 ${family}：修复后复跑该审查的复现检查，验证相邻调用与失败路径。`, 300),
      files: explicit ? followUpGlobs([f], files ?? autoFiles(task, taskEvents(db, task)), hasPath).slice(0, 20)
        : pitfallFiles(db, hits, task.id, files), fixable: true,
      sources: [...new Map((explicit ? [e] : hits.map((h) => h.event)).map((r) => [sourceKey(autoSource(r)), autoSource(r)])).values()],
      via: explicit ? "tool" as const : "p1_family" as const, authorRole: explicit ? "reviewer" as const : "system" as const,
      head: typeof e.data.head === "string" ? e.data.head : task.headSHA,
      specRev: typeof sourceRevision === "number" ? sourceRevision : task.specRev, severity: "P1" as const };
    const lint = memoryLint(db, input);
    if (!lint.ok) { console.warn(`[memory-auto] review ${e.seq} finding rejected by lint rule ${lint.rule}`); continue; }
    const saved = recordMemory(db, { actor: explicit ? String(e.data.reviewer ?? e.actor) : "scheduler", now: e.ts }, input);
    if (!explicit && cards >= 3) confirm(db, saved.memory, e);
  }
}
