import { expect, test } from "bun:test";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { featureGate } from "../src/lib/scheduler-autostart.js";
import { createTask } from "../src/lib/ledger-write.js";
import { applyMigration } from "../src/lib/ledger-feature-migrate.js";
import { getTask } from "../src/lib/ledger-store.js";

test("planning authority rejects actual CLI, MCP and autostart while an existing card advances", async () => {
  const f = integrationFixture();
  try {
    expect(await f.ledger(["stage", "c5-existing", "--from", "spec", "--to", "restate", "--text", "Already started"]))
      .toMatchObject({ ok: true });
    await f.mode(true);
    const cli = await f.ledger(["dag-bind", f.id, "next", "c5-existing", "--rev", String(f.feature().rev)]);
    expect(cli).toMatchObject({ ok: false, code: "forbidden" });
    expect(cli.error).toContain("共享规划");
    expect(await f.ledger(["dag-rewrite", f.id, "--rev", String(f.feature().rev), "--nodes", "[]", "--reason-kind", "new_issue", "--reason", "CLI rewrite"]))
      .toMatchObject({ ok: false, code: "forbidden" });
    const claim = await f.ledger(["scheduler-autostart", "claim", f.id, "next", "--arm", "0123456789abcdef", "--template", "code", "--max-workers", "3"], "scheduler");
    expect(claim).toMatchObject({ ok: false });
    expect(claim.error).toContain("共享规划");
    expect(await f.tools.plan_feature(f.call, { featureId: f.id, reasonKind: "new_issue", reason: "Shared planning request", nodes: [
      { key: "existing", oneLine: "Existing card", fileGlobs: ["src/lib/existing.ts"] },
      { key: "next", oneLine: "New work", fileGlobs: ["src/lib/c5.ts"] },
      { key: "plan", oneLine: "New plan", fileGlobs: ["src/lib/plan.ts"] },
    ] })).toMatchObject({ ok: false, code: "forbidden" });
    const rewrite = await f.tools.rewrite_dag(f.call, { featureId: f.id, reasonKind: "new_issue", reason: "test rewrite",
      add: [{ key: "new", oneLine: "More work", fileGlobs: ["src/lib/new.ts"] }] });
    expect(rewrite).toMatchObject({ ok: false, code: "forbidden" });
    const start = await f.tools.start_node(f.call, { featureId: f.id, key: "next" });
    expect(start).toMatchObject({ ok: false, code: "forbidden" });
    expect(featureGate(f.db, f.feature(), { autoDispatch: true, projects: [f.project], maxWorkers: () => 3 })?.why).toContain("共享规划");
    expect(f.calls.some(c => c[0] === "create")).toBe(false);
    expect(await f.ledger(["stage", "c5-existing", "--from", "restate", "--to", "build", "--text", "Existing authorization"])).toMatchObject({ ok: true });
    expect(getTask(f.db, "c5-existing")?.stage).toBe("build");
    await f.mode(false);
    expect(featureGate(f.db, f.feature(), { autoDispatch: true, projects: [f.project], maxWorkers: () => 3 })).toBeNull();
  } finally { await f.close(); }
});


test("bulk migration cannot assign another card into a feature whose planning gate closed", async () => {
  const f = integrationFixture();
  try {
    createTask(f.db, { actor: f.actor }, { project: f.project, id: "c5-extra", title: "Unassigned card", kind: "code" });
    await f.mode(true);
    expect(() => applyMigration(f.db, { actor: f.actor }, { project: f.project,
      features: [{ slug: "gate", title: "Gate integration", cards: ["c5-extra"] }] })).toThrow("共享规划");
    expect(getTask(f.db, "c5-extra")?.featureId).toBeNull();
  } finally { await f.close(); }
});
