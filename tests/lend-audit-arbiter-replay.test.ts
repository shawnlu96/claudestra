import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { arbitrationFixture, verdictRequest } from "./fix-strategy-remote-helpers.js";
import { arbiterStep } from "../src/lib/review-arbiter-runtime.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { claimLend, getLendOrder } from "../src/lib/ledger-lend.js";
import { RECEIPT_PURPOSE, writeLendResult } from "../src/lib/ledger-lend-result.js";
import { instanceKeySync, signPurpose, verifyPurpose } from "../src/lib/instance-key.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { parseLendRequest, type ResultRequest } from "../src/lib/lend-wire.js";
import { getEventByDedup } from "../src/lib/ledger-store.js";

const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const parse = (raw: string): ResultRequest => {
  const parsed = parseLendRequest("result", JSON.parse(raw));
  if (!parsed.ok || "deliver" in parsed.value) throw new Error("invalid test request");
  return parsed.value;
};

function snapshot(db: Database) {
  return JSON.stringify(["tasks", "scheduler_intents", "lend_orders", "events", "scheduler_resources"]
    .map((table) => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}

/** Real arbitration admission and a temporary signing key; report and lifecycle ports never contact services. */
async function claimedArbitration() {
  const fixture = await arbitrationFixture(), { f, p, intent } = fixture;
  expect(await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps)).toMatchObject({ step: "pooled" });
  const offered = remoteOrder(f.db, intent.id)!;
  claimLend(f.db, f.at("peer:Peer"), "Peer", { v: 1, orderId: offered.orderId, worker: "new-arbiter" }, () => p.context.borrow[0]);
  const o = remoteOrder(f.db, intent.id)!, raw = JSON.stringify(verdictRequest(o)), sha = digest(raw);
  const key = instanceKeySync(f.dir)!;
  const calls = { sign: 0, report: 0, directory: 0 }, reports: string[] = [];
  let signingEnabled = true;
  const deps = {
    reportDir: () => { calls.directory++; return f.dir; },
    writeReport: (_path: string, body: string) => { calls.report++; reports.push(body); },
    sign: (fields: string[]) => { calls.sign++; return signingEnabled ? signPurpose(RECEIPT_PURPOSE, fields, key) : null; },
  };
  const submit = (body = raw, peer = "Peer", bodySha = digest(body)) =>
    writeLendResult(f.db, f.at(`peer:${peer}`), peer, parse(body), bodySha, deps);
  return { ...fixture, o, raw, sha, calls, reports, submit, disableSigning: () => { signingEnabled = false; } };
}

for (const later of ["lease", "stage", "head", "specRev", "round", "rev", "intent", "cancelled", "unknown"] as const) {
  test(`[验收线 1] committed arbitration replays its original signed receipt after ${later} changes`, async () => {
    const h = await claimedArbitration(), { f, p, intent, o } = h;
    try {
      const first = h.submit(); // The HTTP response can be lost after this transaction commits.
      expect(verifyPurpose(first.key, RECEIPT_PURPOSE, [o.orderId, h.sha, String(first.eventSeq), o.taskId], first.sig)).toBe(true);
      expect(getLendOrder(f.db, o.orderId)?.receipt).toEqual(first);
      expect(h.calls).toEqual({ sign: 1, report: 1, directory: 1 });
      expect(await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps)).toMatchObject({ step: "arbitrated" });
      expect(getIntent(f.db, intent.id)?.status).toBe("done");
      if (later === "lease") f.advance(o.leaseUntil! - f.tickDeps.now() + 1);
      if (later === "stage") {
        const next = p.plan();
        expect(await f.cli("scheduler", "scheduler-stage", next.id, "--to", "merge", "--max-workers", "2")).toMatchObject({ ok: true });
        expect(f.task().stage).toBe("merge");
      }
      if (later === "head") f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["4".repeat(40)]);
      if (["specRev", "round", "rev"].includes(later)) f.db.run(`UPDATE tasks SET ${later} = ${later} + 1 WHERE id = 'T1'`);
      if (later === "intent") f.db.run("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?", [intent.id]);
      if (later === "cancelled" || later === "unknown") f.db.run("UPDATE lend_orders SET status = ? WHERE orderId = ?", [later, o.orderId]);
      const before = snapshot(f.db), effects = [...p.effects];
      h.disableSigning(); // Replay must succeed even if the current signing key is unavailable.
      expect(h.submit(h.raw, "Peer", h.sha)).toEqual(first);
      expect(h.submit(h.raw, "Peer", h.sha)).toEqual(first);
      expect(snapshot(f.db)).toBe(before);
      expect(p.effects).toEqual(effects);
      expect(h.calls).toEqual({ sign: 1, report: 1, directory: 1 });
    } finally { f.close(); }
  });
}

for (const invalid of ["body", "peer", "gen", "ordinary", "cancelAck", "binding", "missing-receipt"] as const) {
  test(`[验收线 2] committed receipt refuses ${invalid} without changing the ledger`, async () => {
    const h = await claimedArbitration(), { f, o } = h;
    try {
      h.submit();
      f.advance(o.leaseUntil! - f.tickDeps.now() + 1);
      const req = parse(h.raw);
      if (invalid === "body") { req.arbitration!.verdict = "upheld"; req.verdict.verdict = "changes"; }
      if (invalid === "gen") req.gen++;
      if (invalid === "ordinary") delete req.arbitration;
      if (invalid === "cancelAck") { delete req.arbitration; req.cancelAck = { clean: true }; }
      if (invalid === "binding") f.db.run("UPDATE lend_orders SET wire = ? WHERE orderId = ?", [JSON.stringify({ ...o.wire, convergence: undefined }), o.orderId]);
      if (invalid === "missing-receipt") f.db.run("UPDATE lend_orders SET receipt = NULL WHERE orderId = ?", [o.orderId]);
      const raw = JSON.stringify(req), before = snapshot(f.db), calls = { ...h.calls };
      // Even with a supplied matching digest, identity and purpose are checked before returning a receipt.
      const sha = invalid === "body" ? digest(raw) : h.sha;
      const code = invalid === "peer" || invalid === "gen" ? "not_found"
        : invalid === "ordinary" || invalid === "binding" ? "invalid"
        : invalid === "cancelAck" ? "cancelled" : "conflict";
      expect(() => h.submit(raw, invalid === "peer" ? "Other" : "Peer", sha))
        .toThrow(expect.objectContaining({ current: { lend: code } }));
      expect(snapshot(f.db)).toBe(before);
      expect(h.calls).toEqual(calls);
    } finally { f.close(); }
  });
}

for (const invalid of ["expired", "intent-status", "intent-action", "intent-head", "intent-specRev", "intent-taskRev",
  "stage", "head", "specRev", "round", "family", "session", "author-family", "dispute", "unclaimed"] as const) {
  test(`[验收线 2] first arbitration still refuses ${invalid} without events or reports`, async () => {
    const h = await claimedArbitration(), { f, intent, o } = h;
    try {
      const req = parse(h.raw);
      if (invalid === "expired") f.advance(o.leaseUntil! - f.tickDeps.now() + 1);
      if (invalid === "intent-status") f.db.run("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?", [intent.id]);
      if (invalid === "intent-action") f.db.run("UPDATE scheduler_intents SET action = 'dispatch' WHERE id = ?", [intent.id]);
      if (invalid === "intent-head") f.db.run("UPDATE scheduler_intents SET head = ? WHERE id = ?", ["4".repeat(40), intent.id]);
      if (invalid === "intent-specRev") f.db.run("UPDATE scheduler_intents SET specRev = specRev + 1 WHERE id = ?", [intent.id]);
      if (invalid === "intent-taskRev") f.db.run("UPDATE scheduler_intents SET taskRev = taskRev + 1 WHERE id = ?", [intent.id]);
      if (invalid === "stage") f.db.run("UPDATE tasks SET stage = 'merge' WHERE id = 'T1'");
      if (invalid === "head") f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["4".repeat(40)]);
      if (invalid === "specRev" || invalid === "round") f.db.run(`UPDATE tasks SET ${invalid} = ${invalid} + 1 WHERE id = 'T1'`);
      if (invalid === "family") req.session.family = "claude";
      if (invalid === "session") req.session.id = "s-one";
      if (invalid === "author-family") f.db.run("UPDATE task_workflows SET authorFamily = 'codex' WHERE taskId = 'T1'");
      if (invalid === "dispute") {
        const wire = structuredClone(o.wire);
        if (wire.convergence?.kind !== "arbitration") throw new Error("missing test binding");
        wire.convergence.findingId = "another-finding";
        f.db.run("UPDATE lend_orders SET wire = ? WHERE orderId = ?", [JSON.stringify(wire), o.orderId]);
      }
      if (invalid === "unclaimed") f.db.run("UPDATE lend_orders SET status = 'done' WHERE orderId = ?", [o.orderId]);
      const before = snapshot(f.db);
      expect(() => h.submit(JSON.stringify(req))).toThrow();
      expect(snapshot(f.db)).toBe(before);
      expect(getEventByDedup(f.db, `scheduler:${intent.id}:verdict`)).toBeNull();
      expect(h.calls).toEqual({ sign: 0, report: 0, directory: 0 });
    } finally { f.close(); }
  });
}
