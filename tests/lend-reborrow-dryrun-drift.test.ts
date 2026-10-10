/**
 * CVDRY1: a reborrow dry-run answers the PM with the facts as they are when it returns. Task, CONV material, order or lease drifting
 * while the command prepares outside the lock is a conflict with zero ledger writes, never an ok built on the earlier snapshot.
 * Drift is injected from inside the real CLI's first source read (the gh probe), i.e. after the facts were captured.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeLedger, listEvents } from "../src/lib/ledger-store.js";
import { getLendOrder } from "../src/lib/ledger-lend.js";
import { resources, lab, db, dbPath, endSeq, intentId, oldId, reviewed, base, cli, conv, snapshot, target, convEnd, setup } from "./lend-reborrow-conv-fixture.js";

afterEach(async () => { closeLedger(dbPath); await resources.dispose(); });
const sqlFlag = () => join(lab.root, "sql-drift-flag");
const materialPath = () => String(listEvents(db, { target: "T1" }).find((e) => e.dedupKey === `scheduler:${intentId}:materials`)!.data.material);

/** A gh in front of the fixture's: its first call runs the flagged SQL against the ledger, then hands over to the fixture's gh. */
function sqlDriftGh() {
  const bin = join(lab.root, "bin-drift"), inner = join(lab.root, "bin", "gh"); mkdirSync(bin);
  const file = join(bin, "gh");
  writeFileSync(file, `#!${process.execPath}\nconst fs=require('node:fs');const flag=${JSON.stringify(sqlFlag())};\n` +
    `if(fs.existsSync(flag)){const sql=fs.readFileSync(flag,'utf8');fs.rmSync(flag);const {Database}=require('bun:sqlite');` +
    `const d=new Database(${JSON.stringify(dbPath)});d.run(sql);d.close();}\n` +
    `const r=Bun.spawnSync([${JSON.stringify(inner)},...process.argv.slice(2)],{stdout:'inherit',stderr:'inherit'});process.exit(r.exitCode??1);\n`);
  chmodSync(file, 0o755); lab.env.PATH = `${bin}:${lab.env.PATH}`;
}
/** The command wrote nothing: undoing the injected drift restores the exact pre-command ledger. */
function drifted(run: () => Record<string, any>, drift: string, undo: string) {
  const before = snapshot(), reason = getLendOrder(db, oldId)!.reason;
  writeFileSync(sqlFlag(), drift);
  const r = run();
  expect(existsSync(sqlFlag())).toBe(false);
  expect(snapshot()).not.toBe(before);
  db.run(undo, undo.includes("?") ? [reason] : []);
  expect(snapshot()).toBe(before);
  expect(r).toMatchObject({ ok: false, code: "conflict" });
  expect(String(r.error)).toContain("dry-run 期间事实漂移");
}
const ORDER = ["UPDATE lend_orders SET reason = 'drifted' WHERE orderId = '%'", "UPDATE lend_orders SET reason = ? WHERE orderId = '%'"];
const STATUS = ["UPDATE lend_orders SET status = 'released' WHERE orderId = '%'", "UPDATE lend_orders SET status = 'cancelled' WHERE orderId = '%'"];
const LEASE = ["UPDATE lend_write_leases SET prevAssignee = 'someone-else' WHERE taskId = 'T1'", "UPDATE lend_write_leases SET prevAssignee = NULL WHERE taskId = 'T1'"];
const forOld = (pair: string[]) => pair.map((s) => s.replace("%", oldId)) as [string, string];

describe("--conv-end dry-run", () => {
  beforeEach(async () => { await setup("codex"); await convEnd(); sqlDriftGh(); }, 60_000);

  test("no drift: the dry-run output is exactly the prepared facts and nothing is written", () => {
    const before = snapshot(), bytes = readFileSync(materialPath());
    const m = listEvents(db, { target: "T1" }).find((e) => e.dedupKey === `scheduler:${intentId}:materials`)!;
    expect(conv()).toEqual({ ok: true, dryRun: true, previousOrderId: oldId, gen: 1, reclaimSeq: endSeq, source: "conv", intentId,
      originalFamily: "codex", convFamily: target(), material: { sha256: String(m.data.sha256).slice(0, 12), bytes: bytes.length },
      reviewedHead: reviewed, remoteHead: reviewed, providerVerification: "required_at_claim" });
    expect(snapshot()).toBe(before);
  }, 60_000);

  // Review probe: append to the frozen material while the command reads the remote source.
  test("frozen material appended during preparation is a conflict, not ok with the stale byte count", () => {
    const path = materialPath(), frozen = readFileSync(path), before = snapshot();
    writeFileSync(join(lab.root, "material-flag"), path);
    const r = conv();
    expect(readFileSync(path).length).toBe(frozen.length + "\nedited".length);
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(String(r.error)).toContain("dry-run 期间事实漂移");
    expect(r.material).toBeUndefined();
    expect(snapshot()).toBe(before);
  }, 60_000);

  test("order status changed during preparation is a conflict with zero writes", () => {
    expect(readFileSync(materialPath()).length).toBeGreaterThan(0);
    drifted(() => conv(), ...forOld(STATUS));
  }, 60_000);

  test("order row changed during preparation is a conflict with zero writes", () => drifted(() => conv(), ...forOld(ORDER)), 60_000);

  test("lease changed during preparation is a conflict with zero writes", () => drifted(() => conv(), LEASE[0]!, LEASE[1]!), 60_000);

  test("task changed during preparation (a new ledger event) is a conflict that appends nothing itself", () => {
    const seqs = () => listEvents(db, { target: "T1" }).map((e) => e.seq);
    const before = seqs();
    writeFileSync(join(lab.root, "drift-flag"), "");
    const r = conv();
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(String(r.error)).toContain("dry-run 期间事实漂移");
    const after = listEvents(db, { target: "T1" });
    expect(after.map((e) => e.seq).slice(0, -1)).toEqual(before);
    expect(after.at(-1)).toMatchObject({ kind: "note", actor: "owner", text: "drift" });
  }, 60_000);

  test("after a refused dry-run, apply still signs exactly one successor from fresh facts", () => {
    drifted(() => conv(), LEASE[0]!, LEASE[1]!);
    expect(conv("--apply")).toMatchObject({ ok: true, supersedes: oldId });
  }, 60_000);
});

describe("--reclaim dry-run", () => {
  let reclaimSeq = 0;
  const recovery = () => cli(...base(), "--reclaim", String(reclaimSeq));
  beforeEach(async () => {
    await setup("codex");
    expect(cli("lend-reclaim", "T1", "--reason", "PM recovery").ok).toBe(true);
    reclaimSeq = listEvents(db, { target: "T1" }).findLast((e) => (e.data.lend as { op?: string } | undefined)?.op === "reclaim")!.seq;
    sqlDriftGh();
  }, 60_000);

  test("no drift: the dry-run output is exactly the prepared facts and nothing is written", () => {
    const before = snapshot();
    expect(recovery()).toEqual({ ok: true, dryRun: true, previousOrderId: oldId, gen: 1, reclaimSeq, reviewedHead: reviewed, remoteHead: reviewed,
      providerVerification: "required_at_claim" });
    expect(snapshot()).toBe(before);
  }, 60_000);

  test.each([["order status", STATUS], ["order row", ORDER]])("%s changed during preparation is a conflict with zero writes", (_name, pair) => {
    drifted(recovery, ...forOld(pair));
  }, 60_000);

  test("lease changed during preparation is a conflict with zero writes", () => drifted(recovery, LEASE[0]!, LEASE[1]!), 60_000);
});
