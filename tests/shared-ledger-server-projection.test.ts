import { test, expect } from "bun:test";
import { fixture } from "./shared-ledger-server-fixture.test.js";

test("projection home/service gate, watermark gaps, individual revisions and no inferred deletion", () => {
  const f = fixture();
  try {
    const { id, manifest } = f.imported();
    const p = f.projection(id, manifest);
    expect(f.call("alice", p, "projections").status).toBe(403);
    expect(f.call("home", { ...p, sourceSeq: 9, previousSourceSeq: 8, tasks: [] }, "projections").status).toBe(409);
    expect(f.call("home", { ...p, previousSourceSeq: 9 }, "projections").status).toBe(409);
    const tasks = structuredClone(p.tasks);
    tasks[0]!.steps[0]!.sourceRev = 0;
    expect(f.call("home", { ...p, tasks }, "projections").status).toBe(409);
    expect(f.store.get<{ sourceSeq: number }>("SELECT sourceSeq FROM projection_watermarks WHERE featureId=?", id)!.sourceSeq).toBe(10);
    tasks[0]!.steps[0]!.sourceRev = 2;
    tasks[0]!.steps[0]!.sourceSeq = 11;
    const good = { ...p, tasks };
    const r = f.call("home", good, "projections");
    expect(r.status).toBe(200);
    expect(f.call("home", { ...good, observedAt: f.now + 100 }, "projections").body).toEqual(r.body);
    const altered = structuredClone(good); altered.tasks[0]!.stage = "done";
    expect(f.call("home", altered, "projections").status).toBe(409);
    const lower = structuredClone(good); lower.previousSourceSeq = 11; lower.sourceSeq = 12; lower.tasks[0]!.sourceRev = 0;
    expect(f.call("home", lower, "projections").status).toBe(409);
    const empty = { ...good, mode: "snapshot", previousSourceSeq: 11, sourceSeq: 12, tasks: [], events: [] };
    expect(f.call("home", empty, "projections").status).toBe(200);
    const d = f.call("bob", null, `features/${id}`, "GET").body;
    expect(d.tasks).toHaveLength(1);
    expect(d.tasks[0].steps[0].sourceRev).toBe(2);
    expect(d.feature.counts.completed).toBe(0);
    expect(d.feature.projection.sourceSeq).toBe(12);
  } finally { f.cleanup(); }
});

test("failed later task keeps first task, steps and watermark unchanged", () => {
  const f = fixture();
  try {
    const { id, manifest } = f.imported();
    const p = f.projection(id, manifest);
    p.tasks[0]!.stage = "done";
    const extra = structuredClone(p.tasks[0]!);
    extra.sourceTaskId = "extra"; extra.deps = ["nonexistent"];
    p.tasks.push(extra);
    expect(f.call("home", p, "projections").status).toBe(400);
    const d = f.call("alice", null, `features/${id}`, "GET").body;
    expect(d.tasks).toHaveLength(1);
    expect(d.tasks[0].stage).toBe("build");
    expect(d.feature.projection.sourceSeq).toBe(10);
    expect(f.store.get("SELECT id FROM id_map WHERE sourceId='extra'")).toBeNull();
  } finally { f.cleanup(); }
});
