/**
 * dispatch-recovery-CIF8: the known flaky test list (ledger decision events, judged on read) and its `ledger ci-known-flaky`
 * command. The merge gate side is tests/ci-known-flaky-rerun.test.ts.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { activeKnownFlaky, knownFlakyMode } from "../src/lib/ci-known-flaky.js";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_KEYS } from "../src/lib/recovery-policy.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "p", FILE = "tests/scheduler-update-fail-remote-cancel.test.ts";
const owner = { actor: "owner", now: 100 };
let db: Database, featureId: string, now: number;

const run = (actor: string, ...args: string[]) => runLedger(["ci-known-flaky", ...args, "--project", P],
  { db, actor, projectIds: [P, "q"], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now }) as Promise<Record<string, any>>;
const add = (actor = "agent-pm", file = FILE, node = "UPDFLAKY1") => run(actor, "add", file, "--feature", "rel", "--node", node, "--reason", "时序竞态");
const decisions = () => (db.query("SELECT text FROM events WHERE project=? AND kind='decision' ORDER BY seq").all(P) as { text: string }[]).map((e) => e.text);
/** The fixing node opens its card, which then reaches `stage`. */
function fixer(stage: string): void {
  createTask(db, owner, { project: P, id: "rel-UPDFLAKY1", title: "fix", kind: "code" });
  bindNode(db, owner, { id: featureId, rev: getFeature(db, featureId)!.rev, key: "UPDFLAKY1", taskId: "rel-UPDFLAKY1" });
  db.query("UPDATE tasks SET stage=? WHERE id='rel-UPDFLAKY1'").run(stage);
}

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1000;
  setMeta(db, owner, { project: P, key: "pms", value: ["agent-pm"] });
  featureId = createFeature(db, owner, { project: P, slug: "rel", title: "rel" }).row.id;
  initDag(db, owner, { id: featureId, rev: 1, nodes: [{ key: "UPDFLAKY1", oneLine: "修时序竞态" }, { key: "OTHER1", oneLine: "别的" }] });
});
afterEach(() => closeLedger(":memory:"));

test("the switch is the recovery key ciKnownFlaky, observe by default", () => {
  expect(RECOVERY_KEYS.filter((k) => k === "ciKnownFlaky")).toHaveLength(1);
  expect(knownFlakyMode(P)).toBe("observe"); // test-guard state dir: no recovery-policy.json
});

test("add registers file, fixing node and reason through a ledger decision; list shows it valid", async () => {
  expect(await run("agent-pm")).toMatchObject({ ok: true, project: P, mode: "observe", entries: [] });
  const r = await add();
  expect(r).toMatchObject({ ok: true, duplicate: false, entry: { file: FILE, featureId, node: "UPDFLAKY1", reason: "时序竞态", by: "agent-pm", active: true } });
  expect(decisions()).toEqual([`已知偶发测试登记：${FILE}（修复节点 ${featureId}/UPDFLAKY1）：时序竞态`]);
  expect((await run("agent-worker", "list")).entries).toEqual([expect.objectContaining({ file: FILE, active: true, state: "修复节点计划中（未开工）", seq: r.entry.seq })]);
  expect([...activeKnownFlaky(db, P).keys()]).toEqual([FILE]);
  expect(activeKnownFlaky(db, "q").size).toBe(0);
});

test("only the project's PM / master / owner may write; bad input is refused and nothing is written", async () => {
  expect((await add("agent-worker")).code).toBe("forbidden");
  expect((await run("agent-worker", "revoke", FILE, "--reason", "x")).code).toBe("forbidden");
  expect((await add("agent-pm", "../tests/x.test.ts")).code).toBe("invalid");
  expect((await add("agent-pm", "src/lib/x.ts")).code).toBe("invalid");
  expect((await add("agent-pm", FILE, "NOPE")).code).toBe("invalid");
  expect((await run("agent-pm", "add", FILE, "--feature", "nope", "--node", "UPDFLAKY1", "--reason", "x")).code).toBe("not_found");
  expect((await run("agent-pm", "add", FILE, "--feature", "rel", "--node", "UPDFLAKY1")).code).toBe("invalid");
  expect((await run("agent-pm", "revoke", FILE, "--reason", "x")).code).toBe("not_found");
  expect((await run("agent-pm", "drop", FILE)).code).toBe("invalid");
  expect(decisions()).toEqual([]);
  expect((await add("owner")).ok).toBe(true);
});

test("the entry stops counting once its fixing node is verified / done / cancelled, judged on read with nothing written", async () => {
  await add();
  fixer("review");
  expect((await run("agent-pm", "list")).entries[0]).toMatchObject({ active: true, state: "修复节点 rel-UPDFLAKY1 在 review" });
  for (const stage of ["verified", "done", "cancelled"]) {
    db.query("UPDATE tasks SET stage=? WHERE id='rel-UPDFLAKY1'").run(stage);
    expect((await run("agent-pm", "list")).entries[0]).toMatchObject({ file: FILE, active: false });
    expect(activeKnownFlaky(db, P).size).toBe(0);
  }
  expect(decisions()).toHaveLength(1);
  // A node that is no longer fixing anything cannot be registered against.
  expect((await add("agent-pm", "tests/other.test.ts")).code).toBe("invalid");
  db.query("UPDATE tasks SET stage='fix' WHERE id='rel-UPDFLAKY1'").run();
  expect(activeKnownFlaky(db, P).size).toBe(1);
});

test("revoke removes the entry; registering again replaces it; --dedup makes a retry a no-op", async () => {
  await add();
  expect(await run("agent-pm", "revoke", FILE, "--reason", "误登记", "--dedup", "rv1")).toMatchObject({ ok: true, duplicate: false, revoked: { file: FILE } });
  expect(await run("agent-pm", "revoke", FILE, "--reason", "误登记", "--dedup", "rv1")).toMatchObject({ ok: true, duplicate: true });
  expect([(await run("agent-pm", "list")).entries, activeKnownFlaky(db, P).size]).toEqual([[], 0]);
  expect(decisions().at(-1)).toBe(`已知偶发测试撤销：${FILE}（修复节点 ${featureId}/UPDFLAKY1）：误登记`);
  await add();
  const again = await add("agent-pm", FILE, "OTHER1");
  expect((await run("agent-pm", "list")).entries).toEqual([expect.objectContaining({ file: FILE, node: "OTHER1", seq: again.entry.seq })]);
});
