/** team-project-N8A r1 P1: a `shared-auto off|observe|exclude` that completed while the pass awaited governs the batch. */
import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { readSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { autoShareFixture, cleanupAutoShareState, PROJECT } from "./shared-ledger-auto-share-fixture.test.js";
import { SCRUB } from "./shared-ledger-mirror-fixture.test.js";

afterEach(() => cleanupAutoShareState());
const T0 = Date.UTC(2026, 9, 8, 12, 0), BATCH = `auto-${PROJECT}-202610081200`;
const OPEN = { authorityMode: "source" as const, sharedPlanning: false };
const journals = () => { const d = join(STATE_DIR, "shared-ledger-migrations"); return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith(".json")) : []; };

type Change = "off" | "observe" | "exclude";
const command = (f: Awaited<ReturnType<typeof autoShareFixture>>, change: Change) =>
  f.ledger(change === "exclude" ? ["shared-auto", "exclude", PROJECT, f.features[1]!] : ["shared-auto", change, PROJECT]);
const expectControl = (f: Awaited<ReturnType<typeof autoShareFixture>>, change: Change) => {
  if (change === "exclude") expect(f.state()).toMatchObject({ mode: "on", exclude: [f.features[1]] });
  else expect(f.state().mode).toBe(change);
};

for (const change of ["off", "observe", "exclude"] as const) {
  for (const at of ["auto-precheck", "batch"] as const) {
    test(`N8A-r1 ${change} completes while the ${at} scrub awaits → no journal, no gate, 0 center requests`, async () => {
      const f = await autoShareFixture(["alpha", "beta", "gamma"]);
      try {
        await f.ledger(["shared-auto", "on", PROJECT]);
        let fired = false;
        f.setScrub(async (_db, plan) => {
          if (!fired && (plan.batchId === "auto-precheck") === (at === "auto-precheck")) {
            fired = true;
            expect(await command(f, change)).toMatchObject({ ok: true });
          }
          return SCRUB;
        });
        expect(await f.pass(T0)).toEqual({ [PROJECT]: { action: "idle" } });
        expect(fired).toBe(true);
        expect(f.center.calls).toEqual([]);
        expect(journals()).toEqual([]);
        for (const id of f.features) expect(readSharedLedgerMode(id)).toEqual(OPEN);
        expectControl(f, change);
        expect(f.state().pending ?? null).toBeNull();
        if (change === "exclude") expect(f.state().features![f.features[1]!]).toMatchObject({ status: "excluded" });
        // The next pass follows the new controls: off / observe open nothing; exclude shares the other two only.
        await f.pass(T0 + 300_000);
        if (change === "exclude") {
          expect(f.center.batches.map((b) => b.manifest.features.map((x) => x.sourceFeatureId))).toEqual([[f.features[0], f.features[2]].sort()]);
          expect(readSharedLedgerMode(f.features[1]!)).toEqual(OPEN);
        } else expect(f.center.calls).toEqual([]);
      } finally { await f.close(); }
    });
  }
}

for (const change of ["off", "observe", "exclude"] as const) {
  test(`N8A-r1 ${change} completes after the gate, before the dry-run → fenced, revoked, payload never sent`, async () => {
    const f = await autoShareFixture(["alpha", "beta", "gamma"]);
    try {
      await f.ledger(["shared-auto", "on", PROJECT]);
      f.center.onceAt("receipt", async () => { expect(await command(f, change)).toMatchObject({ ok: true }); });
      await f.pass(T0);
      expect(f.center.calls).toEqual([`receipt ${BATCH}`]);
      expect(f.center.batches).toEqual([]);
      expect(f.journal(BATCH).phase).toBe("aborted");
      for (const id of f.features) {
        expect(readSharedLedgerMode(id)).toEqual(OPEN);
        expect(f.state().features![id]).toMatchObject({ status: "deferred", reason: "自动共享开关已改，本批未上传" });
      }
      expectControl(f, change);
      expect(f.state()).toMatchObject({ pending: null, batches: [{ batchId: BATCH, outcome: "fenced" }] });
    } finally { await f.close(); }
  });

  test(`N8A-r1 ${change} completes during the dry-run → commit never sent, batch aborted, modes reopen`, async () => {
    const f = await autoShareFixture(["alpha", "beta", "gamma"]);
    try {
      await f.ledger(["shared-auto", "on", PROJECT]);
      f.center.onceAt("dry-run", async () => { expect(await command(f, change)).toMatchObject({ ok: true }); });
      await f.pass(T0);
      expect(f.center.calls).toEqual([`receipt ${BATCH}`, `dry-run ${BATCH}`, `receipt ${BATCH}`]);
      expect(f.center.batches).toEqual([]);
      expect(f.journal(BATCH).phase).toBe("aborted");
      for (const id of f.features) expect(readSharedLedgerMode(id)).toEqual(OPEN);
      expectControl(f, change);
      expect(f.state()).toMatchObject({ pending: null, batches: [{ batchId: BATCH, outcome: "fenced" }] });
    } finally { await f.close(); }
  });
}
