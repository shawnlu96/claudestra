import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env.js";

const cases = ["ledger-dag-write", "feature-migrate", "feature-write", "feature-split", "autostart", "feature-dep", "dag-tools-steps"];

async function windowWriter(dir: string, entry: string) {
  const { openLedger, closeLedger } = await import("../src/lib/ledger-store.js");
  const { createFeature, initDag, setFeature } = await import("../src/lib/ledger-feature-write.js");
  const { createTask, setMeta } = await import("../src/lib/ledger-write.js");
  const { getFeature } = await import("../src/lib/ledger-feature.js");
  const { bindNode } = await import("../src/lib/ledger-dag-write.js");
  const { applyMigration } = await import("../src/lib/ledger-feature-migrate.js");
  const { applyFeatureSplit } = await import("../src/lib/ledger-feature-split.js");
  const { claimNode } = await import("../src/lib/ledger-autostart.js");
  const { changeFeatureDep } = await import("../src/lib/ledger-feature-deps-write.js");
  const { readSharedLedgerMode } = await import("../src/lib/shared-ledger-mode.js");
  const path = join(dir, "ledger.sqlite"), db = openLedger(path), ctx = { actor: "owner" };
  const id = "c600-plan", project = "project-a";
  db.run("INSERT INTO ledger_instance VALUES ('origin', 'c600')");
  setMeta(db, ctx, { project, key: "pms", value: ["pm-a"] });
  createFeature(db, ctx, { project, slug: "plan", title: "Plan" });
  initDag(db, ctx, { id, rev: 1, nodes: [{ key: "next", oneLine: "Next", fileGlobs: ["src/sample.ts"] }] });
  createTask(db, ctx, { project, id: "card-a", title: "Card", kind: "code" });
  createFeature(db, ctx, { project, slug: "other", title: "Other" });
  const rev = getFeature(db, id)!.rev;
  let switcher: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  const original = db.prepare.bind(db);
  // Pause at the first actual write after transaction entry and gate validation, the C5 r2 counterexample window.
  db.prepare = ((sql: string, ...args: unknown[]) => {
    if (!switcher && db.inTransaction && /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
      switcher = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "switch", dir],
        { env: testChildEnv({ CLAUDESTRA_STATE_DIR: dir }), stdout: "pipe", stderr: "pipe" });
      const deadline = Date.now() + 3000;
      while (!existsSync(join(dir, "shared-ledger-modes.json.lock")) && Date.now() < deadline) Bun.sleepSync(10);
      if (!existsSync(join(dir, "shared-ledger-modes.json.lock"))) throw new Error("switch never attempted");
      Bun.sleepSync(200);
      if (readSharedLedgerMode(id).sharedPlanning) throw new Error("mode interleaved with admitted write");
      writeFileSync(join(dir, "held"), entry);
    }
    return original(sql, ...args as []);
  }) as typeof db.prepare;
  try {
    if (entry === "ledger-dag-write") bindNode(db, ctx, { id, rev, key: "next", taskId: "card-a" });
    if (entry === "feature-write") setFeature(db, ctx, { id, rev, patch: { title: "Edited" } });
    if (entry === "feature-migrate") applyMigration(db, ctx, { project, features: [{ slug: "plan", title: "Plan", cards: ["card-a"] }] });
    if (entry === "feature-split") applyFeatureSplit(db, ctx, id, { targets: [{ slug: "split", title: "Split", nodes: ["next"] }], deps: [] });
    if (entry === "autostart") claimNode(db, { actor: "scheduler" }, { featureId: id, key: "next", arm: "0123456789abcdef", template: null,
      svc: { autoDispatch: true, projects: [project], maxWorkers: () => 3 } });
    if (entry === "feature-dep") changeFeatureDep(db, ctx, id, "c600-other");
    if (entry === "dag-tools-steps") createTask(db, ctx, { project, id: "card-new", title: "New", kind: "code", extra: { sharedFeatureId: id } });
    if (!switcher || !existsSync(join(dir, "held"))) throw new Error("write window not exercised");
    if (await switcher.exited !== 0) throw new Error(await new Response(switcher.stderr).text());
    if (!readSharedLedgerMode(id).sharedPlanning) throw new Error("mode did not switch after commit");
    expect(() => changeFeatureDep(db, ctx, "c600-other", id)).toThrow("共享规划");
    expect(() => createTask(db, ctx, { project, id: "blocked", title: "Blocked", kind: "code", extra: { sharedFeatureId: id } })).toThrow("共享规划");
  } finally { closeLedger(path); }
}

if (import.meta.main && ["switch", "writer"].includes(Bun.argv[2] ?? "")) {
  const [role, dir, entry] = Bun.argv.slice(2);
  if (role === "switch") {
    const { writeSharedLedgerMode } = await import("../src/lib/shared-ledger-mode.js");
    await writeSharedLedgerMode("c600-plan", { authorityMode: "planning", sharedPlanning: true }, dir);
  } else await windowWriter(dir!, entry!);
} else for (const entry of cases) {
  test(`${entry}: mode switch waits for the admitted write transaction`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "c6-window-"));
    try {
      const child = Bun.spawn([process.execPath, "--no-env-file", import.meta.path, "writer", dir, entry],
        { env: testChildEnv({ CLAUDESTRA_STATE_DIR: dir }), stdout: "pipe", stderr: "pipe" });
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(error).toBe("");
      expect(code).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 15000);
}
