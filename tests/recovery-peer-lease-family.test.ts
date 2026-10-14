/**
 * dispatch-recovery-PEERLEASE1 · the fix author's family after a peer author handover (recovery-peer-lease-family.ts), on an in-memory
 * events table: the frozen runtime until a local binding confirms it, nothing for another round / head / spec, a newer delivery, a
 * contradicting binding or the retired peer row itself; and the handed-over peer row is history for the binder. [验收线 5] [验收线 6]
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { handoverAuthorFamily, PEER_HANDOVER_OP, unlessHandedOver } from "../src/lib/recovery-peer-lease-family.js";
import type { WorkerRef } from "../src/lib/scheduler-plan.js";

const H = "2".repeat(40);
const TASK = { id: "T1", specRev: 1, round: 1, headSHA: H, stage: "fix" };

function ledger(handover: Record<string, unknown> | null, deliverAfter = false): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE events (seq INTEGER PRIMARY KEY, ts INTEGER, target TEXT, kind TEXT, data TEXT)");
  db.run("INSERT INTO events (ts, target, kind, data) VALUES (1, 'T1', 'deliver', '{}')");
  if (handover) db.run("INSERT INTO events (ts, target, kind, data) VALUES (2, 'T1', 'scheduler', ?)",
    [JSON.stringify({ op: PEER_HANDOVER_OP, specRev: 1, round: 1, head: H, sessionId: "sess-mate", runtime: "codex", ...handover })]);
  if (deliverAfter) db.run("INSERT INTO events (ts, target, kind, data) VALUES (3, 'T1', 'deliver', '{}')");
  return db;
}
const local = (family: "claude" | "codex", sessionId = "s-local"): WorkerRef => ({ agent: "a", sessionId, taskId: "T1", family, source: "local" });

describe("handoverAuthorFamily", () => {
  test("[验收线 5] the frozen runtime before any binding, then only a confirming local binding", () => {
    const db = ledger({});
    expect(handoverAuthorFamily(db, TASK, null)).toBe("codex");
    expect(handoverAuthorFamily(db, TASK, local("codex"))).toBe("codex");
    expect(handoverAuthorFamily(db, TASK, local("claude"))).toBeNull(); // created in another family: no override, the gate refuses
    expect(handoverAuthorFamily(db, TASK, { ...local("codex"), source: "peer_claim" })).toBeNull();
    expect(handoverAuthorFamily(db, TASK, local("codex", "sess-mate"))).toBeNull();
  });

  test("[验收线 6] no handover, another round / head / spec, a newer delivery or a stage past fix: the head source decides as before", () => {
    expect(handoverAuthorFamily(ledger(null), TASK, null)).toBeNull();
    expect(handoverAuthorFamily(ledger({ round: 0 }), TASK, null)).toBeNull();
    expect(handoverAuthorFamily(ledger({ head: "3".repeat(40) }), TASK, null)).toBeNull();
    expect(handoverAuthorFamily(ledger({ specRev: 2 }), TASK, null)).toBeNull();
    expect(handoverAuthorFamily(ledger({ runtime: "gpt" }), TASK, null)).toBeNull();
    expect(handoverAuthorFamily(ledger({}, true), TASK, null)).toBeNull();
    expect(handoverAuthorFamily(ledger({}), { ...TASK, stage: "review" }, null)).toBeNull();
  });
});

describe("unlessHandedOver", () => {
  const row = { taskId: "T1", sessionId: "sess-mate", state: "retired", transport: "peer" };
  test("[验收线 4] only the peer row this card's handover retired is dropped", () => {
    const db = ledger({});
    expect(unlessHandedOver(db, row)).toBeNull();
    expect(unlessHandedOver(db, { ...row, state: "active" })).toEqual({ ...row, state: "active" });
    expect(unlessHandedOver(db, { ...row, transport: "acp" })).toEqual({ ...row, transport: "acp" });
    expect(unlessHandedOver(db, { ...row, sessionId: "other" })).toEqual({ ...row, sessionId: "other" });
    expect(unlessHandedOver(ledger(null), row)).toEqual(row);
    expect(unlessHandedOver(db, null)).toBeNull();
  });
});
