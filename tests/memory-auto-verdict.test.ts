/** The real local/peer verdict intake persists pitfall before the automatic observer reads it. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { getTask } from "../src/lib/ledger-store.js";
import { verifyPurpose } from "../src/lib/instance-signature.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import type { LendReceipt } from "../src/lib/lend-wire.js";
import { P, verdictFixture, type VerdictFixture } from "./memory-auto-verdict-fixture.ts";

// Every test owns its ledger file, temp dir and generated instance key (see the fixture); nothing rides on ":memory:" or STATE_DIR.
let fx: VerdictFixture | undefined, db: Database;
let run: VerdictFixture["run"], pitfalls: VerdictFixture["pitfalls"], local: VerdictFixture["local"], peerOrder: VerdictFixture["peerOrder"];
beforeEach(() => { fx = verdictFixture(); ({ db, run, pitfalls, local, peerOrder } = fx); });
afterEach(() => { const own = fx; fx = undefined; own?.dispose(); });

test("submit_verdict pitfall survives persisted findings/read path; replay never creates another pitfall", async () => {
  expect(local(true)).toMatchObject({ ok: true, duplicate: false });
  const events = listEvents(db, { project: P, target: "A" });
  expect(events.find((e) => e.kind === "review")!.data.findings).toMatchObject([{ pitfall: true }]);
  expect(currentReviewFacts(getTask(db, "A")!, events)).toMatchObject({ kind: "facts", facts: { findings: [{ pitfall: true }] } });
  await run(); expect(pitfalls()).toHaveLength(1); expect(pitfalls()[0]!.authorRole).toBe("reviewer");
  expect(local(true)).toMatchObject({ ok: true, duplicate: true });
  await run(); expect(pitfalls()).toHaveLength(1);
});

test("local legacy client without pitfall still works; invalid fields stay rejected", async () => {
  expect(local("true")).toMatchObject({ ok: false, error: "invalid_wire" });
  expect(local(1)).toMatchObject({ ok: false, error: "invalid_wire" });
  expect(local()).toMatchObject({ ok: true }); await run(); expect(pitfalls()).toEqual([]);
});

test("peer result through lend wire/lease/signature intake retains pitfall in stored events; resend is idempotent", async () => {
  const { call, result } = await peerOrder();
  const body = result(true); const first = await call("write", body); expect(first.ok).toBe(true);
  const e = listEvents(db, { project: P, target: "A" }).find((e) => e.kind === "review")!;
  expect(e.data.findings).toMatchObject([{ pitfall: true }]);
  await run(); expect(pitfalls()).toHaveLength(1);
  expect(pitfalls()[0]).toMatchObject({ author: "peer:mate", sources: [{ origin: "ab12", originSeq: e.originSeq }] });
  expect(await call("write", body)).toEqual(first); await run(); expect(pitfalls()).toHaveLength(1);
});

test("peer old client works without optional pitfall; illegal pitfall is rejected before any review event", async () => {
  const { call, result } = await peerOrder();
  expect((await call("write", result("true"))).ok).toBe(false);
  expect(listEvents(db, { project: P }).filter((e) => e.kind === "review")).toEqual([]);
  expect((await call("write", result())).ok).toBe(true); await run(); expect(pitfalls()).toEqual([]);
});

test("legacy persisted pitfall:false reads as an ordinary finding and does not invalidate review facts", () => {
  expect(local(false)).toMatchObject({ ok: true });
  const events = listEvents(db, { project: P, target: "A" }).map((e) => e.kind === "review" ? { ...e, data: { ...e.data,
    findings: (e.data.findings as object[]).map((f) => ({ ...f, pitfall: false })) } } : e);
  expect(currentReviewFacts(getTask(db, "A")!, events)).toMatchObject({ kind: "facts", facts: { findings: [{ family: "widget-tx" }] } });
});

/** Full peer chain on one fixture; the receipt must be signed by that fixture's own generated key. */
async function peerChain(x: VerdictFixture) {
  const { call, result } = await x.peerOrder();
  const first = await call("write", result(true)); expect(first.ok).toBe(true);
  const r = first.receipt as LendReceipt;
  expect(r.key).toBe(x.key.publicKey);
  expect(verifyPurpose(x.key.publicKey, RECEIPT_PURPOSE, [r.orderId, r.sha256, String(r.eventSeq), r.taskId], r.sig)).toBe(true);
  await x.run(); expect(x.pitfalls()).toHaveLength(1);
  return r;
}

test("isolation probe: a polluted shared :memory: ledger and a broken neighbour key do not leak into this fixture", async () => {
  // A neighbour may already have leaked task A into ":memory:"; then the pollution is real and the handle is not ours to close.
  const shared = openLedger(":memory:"), ours = !getTask(shared, "A");
  try {
    if (ours) createTask(shared, { actor: "owner" }, { project: P, id: "A", title: "left open by a neighbour", kind: "code" });
    // The legacy setup reopened ":memory:" and got this very handle back, so its createTask("A") went red.
    expect(openLedger(":memory:")).toBe(shared);
    expect(() => createTask(openLedger(":memory:"), { actor: "owner" }, { project: P, id: "A", title: "legacy setup", kind: "code" })).toThrow();
    const neighbour = verdictFixture();
    const neighbourKey = neighbour.key.publicKey;
    writeFileSync(join(neighbour.root, "identity", "instance-key.pem"), "not a pem");
    neighbour.dispose();
    expect(fx!.key.publicKey).not.toBe(neighbourKey);
    expect(getTask(db, "A")!.title).toBe("Atomic revision writes");
    await peerChain(fx!);
    expect(getTask(shared, "A")).not.toBeNull();
  } finally {
    if (ours) closeLedger(":memory:");
  }
});

test("isolation probe: two fixtures run the peer chain in parallel; disposing one leaves the other intact", async () => {
  const other = verdictFixture();
  try {
    const [mine, theirs] = await Promise.all([peerChain(fx!), peerChain(other)]);
    expect(mine.key).not.toBe(theirs.key);
    expect(other.ledgerPath).not.toBe(fx!.ledgerPath);
    other.dispose();
    expect(existsSync(other.root)).toBe(false);
    expect(() => other.db.query("SELECT 1").get()).toThrow();
    await run(); expect(pitfalls()).toHaveLength(1);
    expect(listEvents(db, { project: P, target: "A" }).filter((e) => e.kind === "review")).toHaveLength(1);
  } finally {
    other.dispose();
  }
});

test("isolation probe: a setup failure after resources exist closes the ledger, removes the temp root and rethrows", () => {
  let root = "", seeded: Database | undefined;
  expect(() => verdictFixture({ seed: (d, r) => { seeded = d; root = r; throw new Error("seed boom"); } })).toThrow("seed boom");
  expect(root).not.toBe("");
  expect(existsSync(root)).toBe(false);
  expect(() => seeded!.query("SELECT 1").get()).toThrow();
  expect(db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
});
