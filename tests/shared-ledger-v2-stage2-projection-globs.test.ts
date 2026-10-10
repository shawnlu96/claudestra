/** team-project-S2F3: center-only cards take extra.fileGlobs from the node they are bound to in the center DAG. */
import { describe, expect, test } from "bun:test";
import { getTask } from "../src/lib/ledger-store.js";
import { observeSnapshot } from "../src/lib/scheduler-snapshot.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { writeExecutionProjection } from "../src/lib/shared-ledger-v2-projection.js";
import { projectionGlobs } from "../src/lib/shared-ledger-v2-projection-globs.js";
import { centerTaskFields } from "../src/lib/shared-ledger-v2-projection-rows.js";
import { executionMode, intent, ledger, ref, resource, tables, task, view, type Ledger } from "./shared-ledger-v2-stage2-projection-fixture.test.js";

type Obj = Record<string, any>;
const node = (key: string, fileGlobs: string[]): Obj => ({ key, oneLine: `node ${key}`, deps: [], fileGlobs, estimate: "1h" });
/** A feature view at DAG version 1 with the given nodes and bindings ([nodeKey, taskId]). */
function dagView(seq: number, rows: Parameters<typeof view>[1], nodes: Obj[], bindings: [string, string][]): Obj {
  return { ...view(seq, rows, { currentVersion: 1 }), dag: { version: 1, nodes, bindings: bindings.map(([nodeKey, taskId]) => ({ nodeKey, taskId })) } };
}
const extraOf = (l: Ledger, id: string): Obj => JSON.parse(l.rows("SELECT extra FROM tasks WHERE id = ?", id)[0]!.extra as string);
function run(fn: (l: Ledger) => void | Promise<void>) {
  return async () => { const l = ledger(); try { l.setMode(executionMode); await fn(l); } finally { l.close(); } };
}
/** Seeds a local card the way an earlier projection (without a DAG) would, then patches its extra. */
function seed(l: Ledger, id: string, extra: Obj, seq = 1): void {
  writeExecutionProjection(l.db, view(seq, { tasks: [task(id)] }), ref);
  const merged = { ...extraOf(l, id), ...extra };
  l.db.prepare("UPDATE tasks SET extra = ? WHERE id = ?").run(JSON.stringify(merged), id);
}

const author: WorkerRef = { agent: "worker", sessionId: "session-author", taskId: "T1", family: "claude", source: "local" };
/** The real snapshot's fileGlobs fed to the real planner on an otherwise ready build card. */
function planOf(l: Ledger, id: string) {
  const real = observeSnapshot(l.db, getTask(l.db, id)!, { registry: [], maxWorkers: 2 });
  const s: PlannerSnapshot = { ...real, author, workflow: { taskId: id, project: "p", template: "code", templateVersion: 2, mode: "auto",
    authorFamily: "claude", fallback: "x", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 },
    events: [...real.events, { seq: 998, kind: "task", data: { op: "new" }, ts: 998, actor: "worker", project: "p", target: id, text: "", dedupKey: null },
      { seq: 999, kind: "stage", data: { from: "build", to: "build", round: 1, specRev: 1 }, ts: 999, actor: "worker",
      project: "p", target: id, text: "复述", dedupKey: null }],
    intents: [], blockedBy: [], queueFrozen: false, heldResources: [], workerCount: 0, freeWorkerSlot: "slot:p:0", reviewer: null };
  return { fileGlobs: real.fileGlobs, decision: planScheduler(s) };
}
const code = (d: Obj) => d.code ?? d.kind;

describe("S2F3 projection fileGlobs from the center DAG binding", () => {
  test("[验收线 1] a center-only card bound to a node lands its fileGlobs; snapshot and planner see them", run(l => {
    const v = dagView(10, { tasks: [task("T1")] }, [node("n1", ["src/demo/*.ts"])], [["n1", "T1"]]);
    expect(writeExecutionProjection(l.db, v, ref).kind).toBe("written");
    expect(extraOf(l, "T1").fileGlobs).toEqual(["src/demo/*.ts"]);
    const { fileGlobs, decision } = planOf(l, "T1");
    expect(fileGlobs).toEqual(["src/demo/*.ts"]);
    expect(code(decision)).not.toBe("file_scope");
    expect(decision).toMatchObject({ kind: "intent", action: "dispatch" });
  }));

  test("[验收线 2] an existing card keeps every other extra key verbatim; only fileGlobs follows the node", run(l => {
    seed(l, "T1", { ownerVisual: { state: "ok", seq: 3 }, screenshotsDigest: "sha256:abc", fileGlobs: ["old/*.ts"] });
    const before = extraOf(l, "T1");
    const v = dagView(10, { tasks: [task("T1")] }, [node("n1", ["src/demo/*.ts"])], [["n1", "T1"]]);
    writeExecutionProjection(l.db, v, ref);
    expect(extraOf(l, "T1")).toEqual({ ...before, centerTask: centerTaskFields(v.tasks[0]), fileGlobs: ["src/demo/*.ts"] });
  }));

  test("[验收线 3] unbound cards and a null DAG keep the local value verbatim; absent stays absent", run(l => {
    seed(l, "T1", { fileGlobs: ["keep/**/*.ts", "b.ts"] });
    writeExecutionProjection(l.db, view(2, { tasks: [task("T1"), task("T2")] }), ref);
    expect(extraOf(l, "T1").fileGlobs).toEqual(["keep/**/*.ts", "b.ts"]);
    expect("fileGlobs" in extraOf(l, "T2")).toBe(false);
    const v = dagView(3, { tasks: [task("T1"), task("T2"), task("T3")] }, [node("n1", ["x/*.ts"]), node("n2", ["y/*.ts"])], [["n1", "T3"]]);
    writeExecutionProjection(l.db, v, ref);
    expect(extraOf(l, "T1").fileGlobs).toEqual(["keep/**/*.ts", "b.ts"]);
    expect("fileGlobs" in extraOf(l, "T2")).toBe(false);
    expect(extraOf(l, "T3").fileGlobs).toEqual(["x/*.ts"]);
  }));

  test("[验收线 4] a local repo: scope is kept even when the card is bound", run(l => {
    seed(l, "T1", { fileGlobs: ["repo:org/private/src/*.ts", "src/a.ts"] });
    writeExecutionProjection(l.db, dagView(2, { tasks: [task("T1")] }, [node("n1", ["src/a.ts"])], [["n1", "T1"]]), ref);
    expect(extraOf(l, "T1").fileGlobs).toEqual(["repo:org/private/src/*.ts", "src/a.ts"]);
  }));

  for (const status of ["pending", "submitted", "unknown"]) {
    test(`[验收线 5] a ${status} center intent defers the change once; the next view after it ends applies it`, run(l => {
      seed(l, "T1", { fileGlobs: ["old/*.ts"] });
      const seen: [string, string][] = [], r = { ...ref, observe: (id: string, c: string) => { seen.push([id, c]); } };
      const live = intent("d1", "T1", { status }), nodes = [node("n1", ["new/*.ts"])];
      const v2 = dagView(2, { tasks: [task("T1")], intents: [live] }, nodes, [["n1", "T1"]]);
      if (status === "unknown") v2.resources = resource(live).map(r => ({ ...r, state: "unknown" }));
      writeExecutionProjection(l.db, v2, r);
      expect(extraOf(l, "T1").fileGlobs).toEqual(["old/*.ts"]);
      expect(seen).toEqual([["T1", "projection_globs_deferred:T1"]]);
      const snap = JSON.stringify(tables(l));
      expect(writeExecutionProjection(l.db, v2, r).kind).toBe("stale");
      expect(JSON.stringify(tables(l))).toBe(snap);
      expect(seen).toHaveLength(1);
      writeExecutionProjection(l.db, dagView(3, { tasks: [task("T1")], intents: [{ ...live, status: "done" }] }, nodes, [["n1", "T1"]]), r);
      expect(extraOf(l, "T1").fileGlobs).toEqual(["new/*.ts"]);
      expect(seen).toHaveLength(1);
    }));
  }

  test("[验收线 5] without observe the deferral goes to console.warn", run(l => {
    seed(l, "T1", { fileGlobs: ["old/*.ts"] });
    const warn = console.warn, lines: unknown[][] = [];
    console.warn = (...a: unknown[]) => { lines.push(a); };
    try {
      writeExecutionProjection(l.db, dagView(2, { tasks: [task("T1")], intents: [intent("d1", "T1")] }, [node("n1", ["new/*.ts"])], [["n1", "T1"]]), ref);
    } finally { console.warn = warn; }
    expect(lines.map(a => String(a[0]))).toEqual(["[shared-ledger-v2-projection projection_globs_deferred] T1"]);
    expect(extraOf(l, "T1").fileGlobs).toEqual(["old/*.ts"]);
  }));

  test("[验收线 6] node scope changes and rebinds follow; an empty node writes [] and the planner reports file_scope", run(l => {
    const nodes = (a: string[], b: string[]) => [node("n1", a), node("n2", b)];
    writeExecutionProjection(l.db, dagView(2, { tasks: [task("T1")] }, nodes(["a/*.ts"], ["b/*.ts"]), [["n1", "T1"]]), ref);
    expect(extraOf(l, "T1").fileGlobs).toEqual(["a/*.ts"]);
    writeExecutionProjection(l.db, dagView(3, { tasks: [task("T1")] }, nodes(["a2/*.ts"], ["b/*.ts"]), [["n1", "T1"]]), ref);
    expect(extraOf(l, "T1").fileGlobs).toEqual(["a2/*.ts"]);
    writeExecutionProjection(l.db, dagView(4, { tasks: [task("T1")] }, nodes(["a2/*.ts"], ["b/*.ts"]), [["n2", "T1"]]), ref);
    expect(extraOf(l, "T1").fileGlobs).toEqual(["b/*.ts"]);
    writeExecutionProjection(l.db, dagView(5, { tasks: [task("T1")] }, nodes(["a2/*.ts"], []), [["n2", "T1"]]), ref);
    expect(extraOf(l, "T1").fileGlobs).toEqual([]);
    expect(code(planOf(l, "T1").decision)).toBe("file_scope");
  }));

  test("[验收线 7] duplicate task bindings or a binding to a missing node are refused with zero writes", run(l => {
    const before = JSON.stringify(tables(l));
    const dup = dagView(2, { tasks: [task("T1")] }, [node("n1", ["a.ts"]), node("n2", ["b.ts"])], [["n1", "T1"], ["n2", "T1"]]);
    const missing = dagView(2, { tasks: [task("T1")] }, [node("n1", ["a.ts"])], [["n9", "T1"]]);
    for (const v of [dup, missing]) {
      expect(() => writeExecutionProjection(l.db, v, ref)).toThrow("projection_view");
      expect(JSON.stringify(tables(l))).toBe(before);
    }
  }));

  test("[验收线 5] the pure mapping is order-stable and leaves out kept cards", () => {
    const live = intent("d1", "T2"), v = dagView(2, { tasks: [task("T1"), task("T2"), task("T3")], intents: [live] },
      [node("n1", ["a.ts", "b.ts"]), node("n2", ["c.ts"]), node("n3", ["d.ts"])], [["n1", "T1"], ["n2", "T2"], ["n3", "T3"]]);
    const local = new Map<string, Obj>([["T2", { fileGlobs: ["old.ts"] }], ["T3", { fileGlobs: ["repo:o/r/x.ts"] }]]);
    const once = projectionGlobs(v as never, local), twice = projectionGlobs(v as never, local);
    expect([...once.write]).toEqual([["T1", ["a.ts", "b.ts"]]]);
    expect(once.deferred).toEqual(["T2"]);
    expect(JSON.stringify([...twice.write, twice.deferred])).toBe(JSON.stringify([...once.write, once.deferred]));
  });

  test("[验收线 8] everything but tasks.extra.fileGlobs matches the same view projected without bindings", async () => {
    const project = (bindings: [string, string][]) => {
      const l = ledger();
      try {
        l.setMode(executionMode);
        seed(l, "T1", { ownerVisual: { state: "ok" } });
        const d = intent("d1", "T2", { status: "done" }), p = intent("p3", "T3");
        writeExecutionProjection(l.db, dagView(5, { tasks: [task("T1"), task("T2"), task("T3")], intents: [d, p] },
          [node("n1", ["a/*.ts"]), node("n2", ["b/*.ts"]), node("n3", ["c/*.ts"])], bindings), ref);
        const t = tables(l);
        return { ...t, tasks: (t.tasks as Obj[]).map(r => { const e = JSON.parse(r.extra); delete e.fileGlobs; return { ...r, extra: e }; }),
          globs: (t.tasks as Obj[]).map(r => [r.id, JSON.parse(r.extra).fileGlobs ?? null]) };
      } finally { l.close(); }
    };
    const bound = project([["n1", "T1"], ["n2", "T2"], ["n3", "T3"]]), unbound = project([]);
    expect(bound.globs).toEqual([["T1", ["a/*.ts"]], ["T2", ["b/*.ts"]], ["T3", null]]);
    expect({ ...bound, globs: null }).toEqual({ ...unbound, globs: null });
  });
});
