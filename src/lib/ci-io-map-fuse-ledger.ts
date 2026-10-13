/**
 * Ledger side of the read map's fuse (merge-arch-SELECT4; rules: ci-io-map-fuse.ts, driver: ci-io-map-fuse-run.ts). Only existing
 * note events, no table. Every record is bound to its evidence through the dedup key, and none of them is a claim taken before
 * the send that could suppress a retry:
 * - done:<evidence key> is written only after CI_IO_MAP was read back as observe (or found already safe). It ends that evidence.
 * - try:<case>:<evidence key> is written right before the write. A pass that died after the write and before `done` leaves it
 *   unsettled: the next pass that reads observe settles it as lowered instead of writing again.
 * - pending:<case> keeps a failed attempt of a car's run open for a later pass (run not finished, a read or the write failed);
 *   closed:<case> ends it. failed:<evidence key> records a write that could not be confirmed.
 * - ref:<run>#<time> keeps a red run whose attempt could not even be read at the verdict; refdone:<the same> ends it once its failed
 *   attempts were read back and opened as pending cases.
 * - a done / failed record carrying `notice` is owed to PM until sent:<its key> exists, so a notice that failed is sent again.
 * observe's own record (recovery-policy recordObserved) lives under another key and never stands in for any of these.
 */
import type { Database } from "bun:sqlite";
import { getEventByDedup } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { recordObserved } from "./recovery-policy.js";
import { caseId, wouldText, type FuseCase, type FuseEvidence, type FuseRef } from "./ci-io-map-fuse.js";

const OP = "ci_io_map_fuse", P = "ci-io-map-fuse";
type Step = "pending" | "closed" | "try" | "done" | "failed" | "skip" | "sent" | "ref" | "refdone";
type DoneResult = "lowered" | "settled" | "already_safe";
interface OwedNotice { key: string; text: string; members: string[] }
interface FuseWrite { before: string | null; after: string | null; at: number; notice?: string }

export interface FuseLedger {
  observe(e: FuseEvidence, key: string): void;
  isDone(key: string): boolean;
  pend(c: FuseCase): void;
  /** Cases still open, written at or after `since`. */
  openCases(project: string, since: number): FuseCase[];
  close(c: FuseCase, why: string): void;
  /** Keeps a red run for a later pass; a run that already has an open one gets no second. */
  ref(r: FuseRef): void;
  openRefs(project: string, since: number): { id: string; ref: FuseRef }[];
  closeRef(project: string, id: string, why: string): void;
  tryWrite(c: FuseCase, key: string, e: FuseEvidence): void;
  /** The write this case sent that no `done` settled yet, with the evidence it was sent for. */
  unsettled(c: FuseCase): { key: string; evidence: FuseEvidence } | null;
  /** The record's own key when this call wrote it; null for a second process or a repeated pass, which sends no second notice. */
  done(c: FuseCase, key: string, e: FuseEvidence, result: DoneResult, w: FuseWrite): string | null;
  failed(c: FuseCase, key: string, e: FuseEvidence, why: string, w: FuseWrite): string | null;
  skip(c: FuseCase, why: string): void;
  /** Notices of done / failed records written in [since, before] that were never sent. */
  owed(project: string, since: number, before: number): OwedNotice[];
  sent(project: string, key: string): void;
}

const range = (step: Step): [string, string] => [`${P}:${step}:`, `${P}:${step};`];
const doneKey = (key: string) => `${P}:done:${key}`;

export function fuseLedger(db: Database, now: () => number): FuseLedger {
  const note = (project: string, step: Step, id: string, text: string, data: Record<string, unknown>): boolean =>
    !appendEvent(db, { actor: "scheduler", now: now(), dedupKey: `${P}:${step}:${id}` },
      { project, target: "", kind: "note", text: text.slice(0, 600), data: { ...data, op: OP, step } }).duplicate;
  const rows = (project: string, step: Step, since: number, before = Number.MAX_SAFE_INTEGER) =>
    (db.query("SELECT dedupKey, data FROM events WHERE dedupKey > ? AND dedupKey < ? AND project = ? AND ts >= ? AND ts <= ? ORDER BY seq")
      .all(...range(step), project, since, before) as { dedupKey: string; data: string }[]).map((r) => ({ key: r.dedupKey, data: JSON.parse(r.data) as Record<string, unknown> }));
  const label = (c: FuseCase) => `列车 ${c.train} 车厢 ${c.car} 的 run ${c.runId}（第 ${c.attempt} 次）`;
  const bound = (c: FuseCase, key: string, e: FuseEvidence) => ({ case: caseId(c), key, evidence: e });
  const openRefs = (project: string, since: number) => rows(project, "ref", since).map((r) => ({ id: r.key.slice(`${P}:ref:`.length), ref: r.data.ref as FuseRef }))
    .filter((r) => !!r.ref && Array.isArray(r.ref.members) && !getEventByDedup(db, `${P}:refdone:${r.id}`));
  return {
    observe(e, key) {
      recordObserved(db, { project: e.project, mechanism: "ciIoMapFuse", target: "", actionKey: `fuse:${key}`, action: wouldText(e).slice(0, 560),
        data: { evidence: e } }, now());
    },
    isDone: (key) => !!getEventByDedup(db, doneKey(key)),
    pend(c) { note(c.project, "pending", caseId(c), `CI_IO_MAP 熔断：${label(c)}还没核完，留给后面的轮次`, { case: c }); },
    openCases: (project, since) => rows(project, "pending", since).map((r) => r.data.case as FuseCase)
      .filter((c) => !!c && Array.isArray(c.members) && !getEventByDedup(db, `${P}:closed:${caseId(c)}`)),
    close(c, why) { if (getEventByDedup(db, `${P}:pending:${caseId(c)}`)) note(c.project, "closed", caseId(c), `CI_IO_MAP 熔断：${label(c)}核完：${why}`, { case: caseId(c) }); },
    ref(r) {
      const run = `${r.repo.toLowerCase()}#${r.runId}`;
      if (openRefs(r.project, 0).some((o) => o.id.startsWith(`${run}#`))) return;
      note(r.project, "ref", `${run}#${now()}`, `CI_IO_MAP 熔断：列车 ${r.train} 车厢 ${r.car} 的 run ${r.runId} 红了但还没读到，留给后面的轮次`, { ref: r });
    },
    openRefs,
    closeRef(project, id, why) { note(project, "refdone", id, `CI_IO_MAP 熔断：run ${id.split("#")[1]} 读回了：${why}`, { ref: id }); },
    tryWrite(c, key, e) { note(c.project, "try", `${caseId(c)}:${key}`, `CI_IO_MAP 熔断：即将把 ${c.repo} 的 CI_IO_MAP 从 on 写成 observe（${label(c)}）`, bound(c, key, e)); },
    unsettled(c) {
      const id = caseId(c), hit = rows(c.project, "try", 0).find((r) => r.data.case === id && typeof r.data.key === "string" && !getEventByDedup(db, doneKey(r.data.key)));
      return hit ? { key: hit.data.key as string, evidence: hit.data.evidence as FuseEvidence } : null;
    },
    done(c, key, e, result, w) {
      const text = result === "already_safe" ? `CI_IO_MAP 熔断：${c.repo} 的 CI_IO_MAP 已在安全档（${w.before ?? "未设置"}），没有改（${label(c)}）`
        : `CI_IO_MAP 熔断：${c.repo} 的 CI_IO_MAP 已从 on 退回 observe，读回确认（${label(c)}）`;
      return note(c.project, "done", key, text, { ...bound(c, key, e), result, ...w }) ? doneKey(key) : null;
    },
    failed: (c, key, e, why, w) => (note(c.project, "failed", key, `CI_IO_MAP 熔断未确认：${why}（${label(c)}）`, { ...bound(c, key, e), why, ...w })
      ? `${P}:failed:${key}` : null),
    skip(c, why) { note(c.project, "skip", caseId(c), `CI_IO_MAP 熔断：${label(c)}不能当证据，没有写变量：${why}`, { case: caseId(c), why }); },
    owed: (project, since, before) => (["done", "failed"] as const).flatMap((step) => rows(project, step, since, before))
      .filter((r) => typeof r.data.notice === "string" && !getEventByDedup(db, `${P}:sent:${r.key}`))
      .map((r) => ({ key: r.key, text: r.data.notice as string, members: (r.data.evidence as FuseEvidence).members })),
    sent(project, key) { note(project, "sent", key, "CI_IO_MAP 熔断：PM 通知已发出", { notice: key }); },
  };
}
