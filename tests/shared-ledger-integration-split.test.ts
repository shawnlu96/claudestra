import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { createFeature } from "../src/lib/ledger-feature-write.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { getTask } from "../src/lib/ledger-store.js";
import { applyFeatureSplit } from "../src/lib/ledger-feature-split.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { STATE_DIR } from "../src/lib/paths.js";

const closed = { authorityMode: "planning" as const, sharedPlanning: true };
const opened = { authorityMode: "source" as const, sharedPlanning: false };
const add = (f: ReturnType<typeof integrationFixture>, slug: string) =>
  createFeature(f.db, { actor: f.actor }, { project: f.project, slug, title: `Split ${slug}` }).row.id;

test("CLI split rejects a shared existing target without moving its bound card or appending either DAG", async () => {
  const f = integrationFixture(), target = add(f, "target");
  try {
    await writeSharedLedgerMode(target, closed);
    const file = join(f.startEnv.ledgerDir, "split.json");
    writeFileSync(file, JSON.stringify({ targets: [{ id: target, title: "Split target", nodes: ["existing"] }], deps: [] }));
    expect(await f.ledger(["feature-split", f.id, "--plan", file])).toMatchObject({ ok: false, code: "forbidden" });
    expect(getFeature(f.db, target)?.currentVersion).toBe(0);
    expect(f.feature().currentVersion).toBe(1);
    expect(getTask(f.db, "c5-existing")?.featureId).toBe(f.id);
  } finally { await writeSharedLedgerMode(target, opened); await f.close(); }
});

test("split rechecks a source gate closed by the backup callback before any transaction writes", async () => {
  const f = integrationFixture();
  try {
    expect(() => applyFeatureSplit(f.db, { actor: f.actor }, f.id,
      { targets: [{ slug: "late", title: "Late target", nodes: ["next"] }], deps: [] }, () => {
        writeFileSync(join(STATE_DIR, "shared-ledger-modes.json"), JSON.stringify({ features: { [f.id]: closed } }), { mode: 0o600 });
        return null;
      })).toThrow("共享规划");
    expect(f.feature().currentVersion).toBe(1);
    expect(getFeature(f.db, "c5a0-late")).toBeNull();
  } finally { await f.close(); }
});

test("split rejects dependency changes involving a third shared feature and rolls back every target", async () => {
  const f = integrationFixture(), third = add(f, "third");
  try {
    await writeSharedLedgerMode(third, closed);
    expect(() => applyFeatureSplit(f.db, { actor: f.actor }, f.id, {
      targets: [{ slug: "new-target", title: "New target", nodes: ["next"] }],
      deps: [{ from: "new-target", to: third }],
    }, () => null)).toThrow("共享规划");
    expect(getFeature(f.db, "c5a0-new-target")).toBeNull();
    expect(f.feature().currentVersion).toBe(1);
    expect(f.db.query("SELECT count(*) AS n FROM feature_deps").get()).toEqual({ n: 0 });
  } finally { await writeSharedLedgerMode(third, opened); await f.close(); }
});

test("a newly planned target with an installed shared gate is refused before its creation", async () => {
  const f = integrationFixture(), target = "c5a0-new-shared";
  try {
    await writeSharedLedgerMode(target, closed);
    expect(() => applyFeatureSplit(f.db, { actor: f.actor }, f.id,
      { targets: [{ slug: "new-shared", title: "New shared target", nodes: ["existing"] }], deps: [] }, () => null)).toThrow("共享规划");
    expect(getFeature(f.db, target)).toBeNull();
    expect(getTask(f.db, "c5-existing")?.featureId).toBe(f.id);
    expect(f.feature().currentVersion).toBe(1);
  } finally { await writeSharedLedgerMode(target, opened); await f.close(); }
});
