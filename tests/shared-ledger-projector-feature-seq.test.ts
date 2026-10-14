import { expect, test } from "bun:test";
import { moveStage, setMeta } from "../src/lib/ledger-write.js";
import { pushSharedLedgerMirror, type MirrorClient } from "../src/lib/shared-ledger-projector.js";
import type { SharedLedgerProjection } from "../src/lib/shared-ledger-contract.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { globalSeq, mirrorEntry, SCRUB } from "./shared-ledger-mirror-fixture.test.js";

for (const budgetMode of ["on", "off", "observe"] as const) test(`[验收线 1] [验收线 5] feature watermark and heartbeat (${budgetMode})`, async () => {
  const f = integrationFixture();
  try {
    const sent: SharedLedgerProjection[] = [];
    const client: MirrorClient = { projection: async p => {
      sent.push(p);
      return { schemaVersion: 1, sourceInstanceId: p.sourceInstanceId, sourceSeq: p.sourceSeq, serverSeq: sent.length, digest: "a".repeat(64) };
    } };
    let now = 1000;
    const deps = () => ({ client, scrub: SCRUB, now, budgetMode });
    let entry = (await pushSharedLedgerMirror(f.db, f.id, mirrorEntry(f, 0), deps())).entry;
    sent.length = 0;
    for (let i = 0; i < 10; i++) setMeta(f.db, { actor: "owner" }, { project: f.project, key: "docsDir", value: `unrelated-${i}` });
    now += 10_000;
    const idle = await pushSharedLedgerMirror(f.db, f.id, entry, deps());
    expect(idle.outcome.kind).toBe(budgetMode === "on" ? "idle" : "pushed");
    expect(sent).toHaveLength(budgetMode === "on" ? 0 : 1);
    entry = idle.entry;
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    const expectedSeq = globalSeq(f);
    setMeta(f.db, { actor: "owner" }, { project: f.project, key: "docsDir", value: "after-own-event" });
    const active = await pushSharedLedgerMirror(f.db, f.id, entry, deps());
    expect(active.outcome).toMatchObject({ kind: "pushed", seq: budgetMode === "on" ? expectedSeq : globalSeq(f) });
    entry = active.entry;
    sent.length = 0;
    setMeta(f.db, { actor: "owner" }, { project: f.project, key: "docsDir", value: "heartbeat-unrelated" });
    now += 299_999;
    expect((await pushSharedLedgerMirror(f.db, f.id, entry, deps())).outcome.kind).toBe(budgetMode === "on" ? "idle" : "pushed");
    now++;
    const heartbeat = await pushSharedLedgerMirror(f.db, f.id, entry, deps());
    expect(heartbeat.outcome.kind).toBe("pushed");
    expect(sent).toHaveLength(budgetMode === "on" ? 1 : 2);
    expect(sent.at(-1)?.sourceSeq).toBe(globalSeq(f));
    if (budgetMode === "on") expect((await pushSharedLedgerMirror(f.db, f.id, heartbeat.entry, deps())).outcome.kind).toBe("idle");
  } finally { await f.close(); }
});

import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { updateSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { runSharedLedgerMirrorPass } from "../src/lib/shared-ledger-mirror-loop.js";
import { serviceCredential } from "./shared-ledger-mirror-fixture.test.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

test("[验收线 1] idle features rotate so the thirteenth feature's change is not starved", async () => {
  const f = integrationFixture(), dir = f.startEnv.ledgerDir;
  try {
    await serviceCredential(dir);
    writeFileSync(join(dir, "recovery-policy.json"), JSON.stringify({ projects: { [f.project]: { keys: { centerRequestBudget: "on" } } } }));
    const ids = [f.id];
    for (let i = 0; i < 12; i++) {
      const feature = createFeature(f.db, { actor: f.actor }, { project: f.project, slug: `idle-${i}`, title: `Idle ${i}` }).row;
      initDag(f.db, { actor: f.actor }, { id: feature.id, rev: 1, nodes: [{ key: "work", oneLine: "Work", fileGlobs: ["src/work.ts"] }] });
      ids.push(feature.id);
    }
    for (const id of ids) await writeSharedLedgerMode(id, { authorityMode: "source", sharedPlanning: true, mirror: true }, dir, f.db.filename);
    await updateSharedLedgerMirrors(dir, entries => {
      for (const id of ids) entries[id] = mirrorEntry(f, globalSeq(f), { lastPushAt: id === f.id ? 2000 : 1000 });
    });
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    let calls = 0, now = 10_000;
    const deps = { stateDir: dir, ledgerPath: f.db.filename, now: () => now, requestGapMs: 0, scrub: async () => SCRUB,
      client: (): MirrorClient => ({ projection: async p => {
        calls++;
        return { schemaVersion: 1, sourceInstanceId: p.sourceInstanceId, sourceSeq: p.sourceSeq, serverSeq: calls, digest: "a".repeat(64) };
      } }),
    };
    expect(Object.keys(await runSharedLedgerMirrorPass(deps))).toHaveLength(12);
    expect(calls).toBe(0);
    now += 10_000;
    expect((await runSharedLedgerMirrorPass(deps))[f.id]?.kind).toBe("pushed");
    expect(calls).toBe(1);
  } finally { await f.close(); }
});

test("[验收线 1] legacy global watermark stays monotonic; no global advancement means no heartbeat", async () => {
  const f = integrationFixture();
  try {
    for (let i = 0; i < 10; i++) setMeta(f.db, { actor: "owner" }, { project: f.project, key: "docsDir", value: `old-${i}` });
    let calls = 0;
    const deps = { now: 400_000, budgetMode: "on" as const, scrub: SCRUB,
      client: { projection: async (p: SharedLedgerProjection) => {
        calls++;
        return { schemaVersion: 1 as const, sourceInstanceId: p.sourceInstanceId, sourceSeq: p.sourceSeq, serverSeq: calls, digest: "a".repeat(64) };
      } },
    };
    const entry = mirrorEntry(f, globalSeq(f), { lastPushAt: 1000 });
    const idle = await pushSharedLedgerMirror(f.db, f.id, entry, deps);
    expect(idle.outcome.kind).toBe("idle");
    expect(calls).toBe(0);
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    const active = await pushSharedLedgerMirror(f.db, f.id, idle.entry, deps);
    expect(active.outcome).toMatchObject({ kind: "pushed", seq: globalSeq(f) });
    expect(active.entry.watermark).toBeGreaterThan(entry.watermark);
    expect(active.entry.featureWatermark).toBe(globalSeq(f));
  } finally { await f.close(); }
});
