import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { createTask } from "../src/lib/ledger-write.js";
import { setFeature } from "../src/lib/ledger-feature-write.js";
import { preflightStart } from "../src/lib/dag-tools-start.js";
import { featureGate } from "../src/lib/scheduler-autostart.js";
import { readSharedLedgerMode, writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { readSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { CENTER, cleanupMirrorState, commitJournal, serviceCredential } from "./shared-ledger-mirror-fixture.test.js";

afterEach(() => cleanupMirrorState());
const svc = (project: string) => ({ autoDispatch: true, projects: [project], maxWorkers: () => 3 });
const spec = "# PJ1 spec\n模板：code\n";

test("shared-mirror on: committed, not activated feature gets local planning back; before on it stays blocked", async () => {
  const f = integrationFixture();
  try {
    const payload = await commitJournal(f, "batch-pj1-on");
    await serviceCredential();
    const ctx = { actor: f.actor };
    // Before on: sharedPlanning=true closes every local planning path.
    expect(() => setFeature(f.db, ctx, { id: f.id, rev: f.feature().rev, patch: { title: "Edited before" } })).toThrow("共享规划");
    expect(() => createTask(f.db, ctx, { project: f.project, id: "pj1-blocked", title: "Blocked", kind: "code", extra: { sharedFeatureId: f.id } })).toThrow("共享规划");
    expect(await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec })).toMatchObject({ ok: false, code: "forbidden" });
    expect(featureGate(f.db, f.feature(), svc(f.project))).toMatchObject({ gate: "feature" });

    const on = await f.ledger(["shared-mirror", "on", f.id]);
    expect(on).toMatchObject({ ok: true, mirroring: true, centerFeatureId: "center-feature-1", watermark: payload.manifest.sourceSeq });
    expect(readSharedLedgerMode(f.id)).toEqual({ authorityMode: "source", sharedPlanning: true, mirror: true });
    // Persisted in the mode file, so a restart (fresh read) keeps it.
    expect(JSON.parse(readFileSync(join(STATE_DIR, "shared-ledger-modes.json"), "utf8")).features[f.id].mirror).toBe(true);

    // After on: 改图, start_node (task-new with sharedFeatureId), auto start gate and preflight all pass.
    expect(setFeature(f.db, ctx, { id: f.id, rev: f.feature().rev, patch: { title: "Edited while mirrored" } }).row.title).toBe("Edited while mirrored");
    expect(createTask(f.db, ctx, { project: f.project, id: "pj1-started", title: "Started", kind: "code", extra: { sharedFeatureId: f.id } }).row.id).toBe("pj1-started");
    expect((await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec })).ok).toBe(true);
    expect(featureGate(f.db, f.feature(), svc(f.project))?.gate).not.toBe("feature");

    const status = await f.ledger(["shared-mirror", "status", f.id]);
    expect(status).toMatchObject({ ok: true, mirroring: true, lastPushSeq: null, lastError: null });

    // off stops pushing first, then closes the local gate again.
    const off = await f.ledger(["shared-mirror", "off", f.id]);
    expect(off).toMatchObject({ ok: true, mirroring: false });
    expect(readSharedLedgerMirrors()[f.id]?.enabled).toBe(false);
    expect(readSharedLedgerMode(f.id)).toEqual({ authorityMode: "source", sharedPlanning: true });
    expect(() => setFeature(f.db, ctx, { id: f.id, rev: f.feature().rev, patch: { title: "Edited after off" } })).toThrow("共享规划");
  } finally { await f.close(); }
});

test("shared-mirror on refuses features never committed, already activated, or without a service project credential", async () => {
  const f = integrationFixture();
  try {
    await serviceCredential();
    // Never committed: local gate open, no journal.
    expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: false, code: "forbidden" });
    // Gate closed by a prepare, but no committed batch in the journal.
    await writeSharedLedgerMode(f.id, { authorityMode: "source", sharedPlanning: true }, STATE_DIR, f.db.filename);
    expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: false, error: expect.stringContaining("还没有 commit") });
    // Activated: journal says active and the mode moved to planning.
    await commitJournal(f, "batch-pj1-active", "active");
    await writeSharedLedgerMode(f.id, { authorityMode: "planning", sharedPlanning: true }, STATE_DIR, f.db.filename);
    expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: false, error: expect.stringContaining("activate") });
    // An activated journal also wins over a stale source mode.
    await writeSharedLedgerMode(f.id, { authorityMode: "source", sharedPlanning: true }, STATE_DIR, f.db.filename);
    expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: false, error: expect.stringContaining("activate") });
    expect(readSharedLedgerMode(f.id).mirror).toBeUndefined();
  } finally { await f.close(); }
});

test("shared-mirror on requires a kind=service credential with the project action", async () => {
  const f = integrationFixture();
  try {
    await commitJournal(f, "batch-pj1-cred");
    expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: false, error: expect.stringContaining("service 凭据") });
    await serviceCredential(STATE_DIR, ["import"]);
    expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: false, error: expect.stringContaining("service 凭据") });
    await serviceCredential(STATE_DIR, ["import", "project"]);
    expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: true, mirroring: true });
    expect(readSharedLedgerMirrors()[f.id]).toMatchObject({ enabled: true, centerId: CENTER.centerId, sourceInstanceId: CENTER.instanceId });
  } finally { await f.close(); }
});

test("only PM / owner can switch mirroring; off on a feature that is not mirrored is refused", async () => {
  const f = integrationFixture();
  try {
    await commitJournal(f, "batch-pj1-role");
    await serviceCredential();
    expect(await f.ledger(["shared-mirror", "on", f.id], "agent-stranger")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.ledger(["shared-mirror", "off", f.id])).toMatchObject({ ok: false, code: "invalid" });
    expect(await f.ledger(["shared-mirror", "bogus", f.id])).toMatchObject({ ok: false, code: "invalid" });
  } finally { await f.close(); }
});
