import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { workingSeats, type WorkingSeat } from "../src/lib/scheduler-agent-pool-ledger.js";
import { autoFixture, H1, H2 } from "./scheduler-auto-helpers.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";

// The optional mode exercises both counterfactual reads without touching the machine's policy file.
const seats = workingSeats;
import { addSeat, reviewEffect, reviewEvent } from "./scheduler-review-seat-fixture.test.js";
const count = (db: Database, mode: RecoveryMode, except: string | null = null) => seats(db, "p", except, mode)!.size;

test("[验收线 2] in-flight, unknown and delivered effects reserve until same-head session proof", () => {
  const f = autoFixture();
  try {
    for (const [id, status] of [["sent", "submitted"], ["uncertain", "unknown"], ["delivered", "done"]]) {
      addSeat(f.db, id); reviewEffect(f.db, id, status);
    }
    expect(count(f.db, "on")).toBe(3);
    reviewEvent(f.db, "delivered", H1); reviewEvent(f.db, "delivered", H2, 2, "wrong-session");
    expect(count(f.db, "on")).toBe(3);
    reviewEvent(f.db, "delivered");
    expect(count(f.db, "on")).toBe(2);
    f.db.query("UPDATE tasks SET stage='blocked'").run();
    expect(count(f.db, "on")).toBe(2);
  } finally { f.close(); }
});

test("[验收线 2] manual dispatch counts only current-round review bindings until a subsequent current-round verdict", () => {
  const f = autoFixture();
  try {
    addSeat(f.db, "manual");
    const dispatch = (round: number) => f.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data)
      VALUES (0,'pm','p','manual','dispatch','',?)`).run(JSON.stringify({ round, head: H2, reviewer: "adversarial" }));
    dispatch(1); expect(count(f.db, "on")).toBe(0);
    reviewEvent(f.db, "manual"); dispatch(2); expect(count(f.db, "on")).toBe(1);
    reviewEvent(f.db, "manual", H1, 1); expect(count(f.db, "on")).toBe(1);
    reviewEvent(f.db, "manual"); expect(count(f.db, "on")).toBe(0);
    dispatch(2); f.db.query("UPDATE tasks SET stage='merge' WHERE id='manual'").run();
    expect(count(f.db, "on")).toBe(0);
  } finally { f.close(); }
});

test("[验收线 3] off and observe preserve the legacy seats and their insertion order", () => {
  const f = autoFixture();
  try {
    addSeat(f.db, "idle"); addSeat(f.db, "author", "author", "build"); addSeat(f.db, "gone"); addSeat(f.db, "peer");
    f.db.query("UPDATE scheduler_sessions SET state='retired' WHERE agent='gone'").run();
    f.db.query("UPDATE scheduler_sessions SET transport='peer' WHERE agent='peer'").run();
    const old: [string, WorkingSeat][] = [["idle", { family: "codex", reviewer: true }], ["author", { family: "codex", reviewer: false }]];
    expect([...seats(f.db, "p", null, "off")!]).toEqual(old);
    expect([...seats(f.db, "p", null, "observe")!]).toEqual(old);
    expect([...seats(f.db, "p", null, "on")!.keys()]).toEqual(["author"]);
  } finally { f.close(); }
});
