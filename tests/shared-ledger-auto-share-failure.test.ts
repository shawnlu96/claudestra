/** team-project-N8A acceptance 5: no failure leaves a local planning gate behind; unknown outcomes retry then halt. */
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { readSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { autoShareFixture, cleanupAutoShareState, PROJECT } from "./shared-ledger-auto-share-fixture.test.js";

afterEach(() => cleanupAutoShareState());
const T0 = Date.UTC(2026, 9, 8, 12, 0), STEP = 300_000, OPEN = { authorityMode: "source" as const, sharedPlanning: false };
const BATCH = `auto-${PROJECT}-202610081200`;

test("N8A-5a prepare fails after the gate is installed → revoked at once, modes reopen, the next pass pre-checks again", async () => {
  const f = await autoShareFixture(["alpha", "beta"]);
  try {
    // The batch's scrub refuses the feature titles ("Feature …"): pre-check passes, prepare's export fails behind the gate.
    f.setScrub(async (_db, plan) => ({ identity: plan.batchId === "auto-precheck" ? { username: "n8a-user", hostname: "n8a-host" } : { username: "Feature", hostname: "n8a-host" } }));
    await f.ledger(["shared-auto", "on", PROJECT]);
    expect(await f.pass(T0)).toEqual({ [PROJECT]: { action: "batch", batchId: BATCH } });
    expect(f.journal(BATCH).phase).toBe("aborted");
    for (const id of f.features) expect(readSharedLedgerMode(id)).toEqual(OPEN);
    expect(f.center.calls).toEqual([]);
    expect(f.state()).toMatchObject({ pending: null, batches: [{ batchId: BATCH, outcome: "prepare-failed" }] });
    for (const id of f.features) expect(f.state().features![id]).toMatchObject({ status: "deferred" });
    f.setScrub(async () => ({ identity: { username: "n8a-user", hostname: "n8a-host" } }));
    await f.pass(T0 + STEP);
    expect(f.center.batches.map((b) => b.batchId)).toEqual([`auto-${PROJECT}-202610081205`]);
    for (const id of f.features) expect(readSharedLedgerMode(id).mirror).toBe(true);
  } finally { await f.close(); }
});

for (const fault of ["dry-run-4xx", "commit-4xx"] as const) {
  test(`N8A-5b center 4xx (${fault}) → revoke, modes reopen, features refused by the center, no retry without a change`, async () => {
    const f = await autoShareFixture(["alpha", "beta"]);
    try {
      f.center.fault(fault);
      await f.ledger(["shared-auto", "on", PROJECT]);
      await f.pass(T0);
      expect(f.journal(BATCH).phase).toBe("aborted");
      for (const id of f.features) {
        expect(readSharedLedgerMode(id)).toEqual(OPEN);
        expect(f.state().features![id]).toMatchObject({ status: "refused", reason: "中心拒收" });
      }
      expect(f.state()).toMatchObject({ pending: null, batches: [{ batchId: BATCH, outcome: "rejected" }] });
      const calls = f.center.calls.length;
      f.center.fault("none");
      await f.pass(T0 + STEP);
      expect(f.center.calls.length).toBe(calls);
    } finally { await f.close(); }
  });
}

test("N8A-5c commit transport error → same batch retried next pass; 3rd unknown halts; halted opens 0 new batches until the PM clears it", async () => {
  const f = await autoShareFixture(["alpha", "beta"]);
  try {
    f.center.fault("lost");
    await f.ledger(["shared-auto", "on", PROJECT]);
    await f.pass(T0);
    expect(f.state()).toMatchObject({ pending: { batchId: BATCH, unknown: 1 } });
    for (const id of f.features) expect(readSharedLedgerMode(id).sharedPlanning).toBe(true);
    await f.pass(T0 + STEP);
    expect(f.state()).toMatchObject({ pending: { batchId: BATCH, unknown: 2 } });
    expect(f.state().halted ?? null).toBeNull();
    await f.pass(T0 + 2 * STEP);
    expect(f.state()).toMatchObject({ pending: { batchId: BATCH, unknown: 3 }, halted: { batchId: BATCH }, batches: [{ batchId: BATCH, outcome: "halted" }] });
    expect(f.state().lastError).toContain(BATCH);
    expect(f.center.calls.filter((c) => c.startsWith("commit")).map((c) => c.split(" ")[1])).toEqual([BATCH, BATCH, BATCH]);
    // New candidates do not get a batch while halted.
    f.feature("later");
    f.center.fault("none");
    const before = f.center.calls.length;
    expect(await f.pass(T0 + 3 * STEP)).toEqual({ [PROJECT]: { action: "halted", batchId: BATCH } });
    expect(f.center.calls.length).toBe(before);
    // The PM may clear it only after the batch's journal settled.
    expect(await f.ledger(["shared-auto", "on", PROJECT])).toMatchObject({ ok: false, code: "conflict" });
    const path = join(STATE_DIR, "shared-ledger-migrations", `${BATCH}.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), phase: "aborted" }));
    expect(await f.ledger(["shared-auto", "on", PROJECT])).toMatchObject({ ok: true, halted: null, pending: null });
  } finally { await f.close(); }
});

test("shared-auto changes need the project's PM / owner; status is readable; bad usage is refused", async () => {
  const f = await autoShareFixture(["alpha"]);
  try {
    expect(await f.ledger(["shared-auto", "on", PROJECT], "someone-else")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.ledger(["shared-auto", "exclude", PROJECT, f.features[0]!], "someone-else")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.ledger(["shared-auto", "status", PROJECT], "someone-else")).toMatchObject({ ok: true, mode: "off", bound: true });
    expect(await f.ledger(["shared-auto", "exclude", PROJECT])).toMatchObject({ ok: false, code: "invalid" });
    expect(await f.ledger(["shared-auto", "maybe", PROJECT])).toMatchObject({ ok: false, code: "invalid" });
    await f.ledger(["shared-auto", "exclude", PROJECT, f.features[0]!]);
    expect(await f.ledger(["shared-auto", "include", PROJECT, f.features[0]!])).toMatchObject({ ok: true, exclude: [] });
  } finally { await f.close(); }
});
