// SCHEDMEM1 验收线 2：待办过滤搬进 SQL 后，unsentRemoteNotices / lateRemoteMatches 与改前逐项相同；全部办完时 SQL 一行不读。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeLedger, getEventByDedup, getTask, openLedger } from "../src/lib/ledger-store.js";
import { TERMINAL_STAGES } from "../src/lib/ledger-stages.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { APPLIED_OP, appliedKey, lateRemoteMatches, NOTIFIED_OP, notifiedKey, REMOTE_REVIEW_OP, remoteHeadMatch, unsentRemoteNotices }
  from "../src/lib/remote-review-read.js";

const HEAD = "abcdef0123456789abcdef0123456789abcdef01", HEAD2 = "1234567890abcdef1234567890abcdef12345678";
const H12 = HEAD.slice(0, 12), H12B = HEAD2.slice(0, 12);

/** The functions as they were before SCHEDMEM1 (every row read, filtered in JS): the oracle. */
const oldRows = (db: Database, project: string) => db.query(`SELECT seq, target, data FROM events WHERE dedupKey >= ? AND dedupKey < ? AND project = ?
  AND kind = 'scheduler' AND actor = 'scheduler' ORDER BY seq`).all(`scheduler:${REMOTE_REVIEW_OP}`, "scheduler:remote_reviex", project) as { seq: number; target: string; data: string }[];
const oldUnsent = (db: Database, project: string) => oldRows(db, project).map((x) => ({ ...x, notice: (JSON.parse(x.data) as { notice?: unknown }).notice }))
  .filter((x) => typeof x.notice === "string" && !getEventByDedup(db, notifiedKey(x.seq)))
  .map((x) => ({ taskId: x.target, seq: x.seq, text: x.notice as string }));
const oldLate = (db: Database, project: string) => oldRows(db, project).filter((x) => {
  const d = JSON.parse(x.data) as { op?: string; matched?: boolean; head12?: unknown };
  if (d.op !== REMOTE_REVIEW_OP || d.matched !== false || typeof d.head12 !== "string" || getEventByDedup(db, appliedKey(x.seq))) return false;
  const task = getTask(db, x.target);
  return !!task && !TERMINAL_STAGES.includes(task.stage) && !!remoteHeadMatch(db, task, d.head12);
}).map((x) => ({ taskId: x.target, seq: x.seq }));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "schedmem1-rr-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  dirs.push(dir);
  let now = 1_000, n = 0;
  for (const [project, id] of [["p", "T1"], ["p", "T2"], ["p", "T3"], ["q", "Q1"]] as const)
    createTask(db, { actor: "owner", now: (now += 10) }, { project, id, title: id, kind: "code", agent: "agent-a" });
  db.query("UPDATE tasks SET headSHA = ?, stage = 'review' WHERE id IN ('T1', 'Q1')").run(HEAD);
  db.query("UPDATE tasks SET headSHA = ?, stage = 'done' WHERE id = 'T2'").run(HEAD);
  db.query("UPDATE tasks SET headSHA = ?, stage = 'build' WHERE id = 'T3'").run(HEAD2);
  const ev = (target: string, data: Record<string, unknown>, key: string, o: { project?: string; actor?: string } = {}) =>
    insertEvent(db, { actor: o.actor ?? "scheduler", now: (now += 10), dedupKey: key }, { project: o.project ?? "p", target, kind: "scheduler", text: "", data }, true);
  const book = (target: string, data: Record<string, unknown>, o: { project?: string; actor?: string } = {}) =>
    ev(target, { op: REMOTE_REVIEW_OP, ...data }, `scheduler:${REMOTE_REVIEW_OP}:${target}:r${++n}:${data.head12 ?? "x"}`, o).seq;
  const notified = (target: string, seq: number) => ev(target, { op: NOTIFIED_OP, remoteSeq: seq }, notifiedKey(seq));
  const applied = (target: string, seq: number, data: Record<string, unknown> = {}) => ev(target, { op: APPLIED_OP, remoteSeq: seq, ...data }, appliedKey(seq)).seq;
  return { db, path, book, notified, applied };
}

/** Counts the rows the remote_review* range queries hand back (the dedupKey range is how both old and new read). */
function countRows(db: Database): { rows: number } {
  const c = { rows: 0 }, query = db.query.bind(db);
  db.query = ((sql: string) => {
    const st = query(sql);
    if (!/dedupKey >= \?1? AND dedupKey < \?/.test(sql)) return st;
    return new Proxy(st, { get: (t, k) => k === "all" ? (...a: never[]) => { const r = t.all(...a); c.rows += r.length; return r; }
      : typeof Reflect.get(t, k) === "function" ? (Reflect.get(t, k) as (...a: unknown[]) => unknown).bind(t) : Reflect.get(t, k) });
  }) as typeof db.query;
  return c;
}

describe("SCHEDMEM1 remote review reads", () => {
  test("[验收线 2] notified / unnotified / applied / unmatched / finished card / other head: new output equals the old, item by item", () => {
    const f = fixture();
    const a = f.book("T1", { matched: true, head12: H12, notice: "a: notified" }); f.notified("T1", a);
    f.book("T1", { matched: true, head12: H12, notice: "b: owed" });
    f.book("T1", { matched: false, head12: H12 }); // late match
    const d = f.book("T1", { matched: false, head12: H12, notice: "d: owed too" }); // late match with an owed notice
    const e = f.book("T1", { matched: false, head12: H12 }); const ea = f.applied("T1", e, { notice: "e applied: owed" });
    const g = f.book("T1", { matched: false, head12: H12 }); const ga = f.applied("T1", g, { notice: "g applied: sent" }); f.notified("T1", ga);
    f.book("T2", { matched: false, head12: H12, notice: "card done" }); // finished card: no late match, the notice is still owed
    f.book("T3", { matched: false, head12: H12 }); // the card is at another head
    f.book("T3", { matched: false, head12: H12B }); // ... and this one is at its head
    f.book("T1", { matched: 0, head12: H12 }); // not the literal false
    f.book("T1", { matched: false, head12: 12 }); // head12 not a string
    f.book("T1", { matched: false }); // no head12
    f.book("T1", { matched: true, head12: H12, notice: 7 }); // notice not a string
    f.book("T1", { matched: false, head12: H12, notice: "other actor" }, { actor: "agent-x" });
    f.book("Q1", { matched: false, head12: H12, notice: "other project" }, { project: "q" });
    f.book("GONE", { matched: false, head12: H12, notice: "no such card" });
    for (const p of ["p", "q"]) {
      expect(unsentRemoteNotices(f.db, p)).toEqual(oldUnsent(f.db, p));
      expect(lateRemoteMatches(f.db, p)).toEqual(oldLate(f.db, p));
    }
    expect(unsentRemoteNotices(f.db, "p").map((x) => x.text)).toEqual(["b: owed", "d: owed too", "e applied: owed", "card done", "no such card"]);
    expect(lateRemoteMatches(f.db, "p").map((x) => x.taskId)).toEqual(["T1", "T1", "T3"]);
    expect(lateRemoteMatches(f.db, "p").map((x) => x.seq)).toContain(d);
    expect(ea).toBeGreaterThan(0);
    // an old booking whose card reaches its head later still matches: the semantics did not move
    f.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T3'").run(HEAD);
    expect(lateRemoteMatches(f.db, "p")).toEqual(oldLate(f.db, "p"));
    expect(lateRemoteMatches(f.db, "p").filter((x) => x.taskId === "T3").length).toBe(1);
    closeLedger(f.path);
  });

  test("[验收线 2] 10k bookings all notified and applied: both reads return no rows from SQL (the old read 60k)", () => {
    const f = fixture();
    f.db.transaction(() => {
      for (let i = 0; i < 10_000; i++) {
        const s = f.book("T1", { matched: false, head12: H12, notice: `n${i}` });
        f.notified("T1", s);
        f.applied("T1", s);
      }
    })();
    const c = countRows(f.db);
    expect(unsentRemoteNotices(f.db, "p")).toEqual([]);
    expect(lateRemoteMatches(f.db, "p")).toEqual([]);
    expect(c.rows).toBe(0);
    expect(oldUnsent(f.db, "p")).toEqual([]);
    expect(oldLate(f.db, "p")).toEqual([]);
    expect(c.rows).toBe(60_000); // the oracle: every booking, notice and application, read twice
    closeLedger(f.path);
  }, 60_000);
});
