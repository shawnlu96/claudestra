import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask } from "../src/lib/ledger-write.js";
import { ledgerOrigin } from "../src/lib/ledger-origin.js";
import { priorityAudit } from "../src/lib/ledger-priority-write.js";
import { observeMemory } from "../src/lib/memory-auto.js";
import { projectMemories } from "../src/lib/memory-auto-common.js";
import { prepareSummary } from "../src/lib/memory-auto-summary.js";

let db: Database;
const project = "compat", ctx = { actor: "owner", now: 1000 };
const decision = (text: string, data: Record<string, unknown> = {}) =>
  appendEvent(db, ctx, { project, target: "A", kind: "decision", text, data }).event;
const run = () => observeMemory(db, "scheduler", project, { assertLease: () => {} });
beforeEach(() => {
  db = openLedger(":memory:"); ledgerOrigin(db, () => "ab12");
  createTask(db, ctx, { project, id: "A", title: "Atomic transaction writes", kind: "code" });
});
afterEach(() => closeLedger(":memory:"));

test("priority audit decisions retain their kind but never index, reject or replay; normal decisions still index", async () => {
  const ordinary = decision("Keep revision writes atomic");
  const audits = ["set", "bind", "move", "retire"].map((op) =>
    priorityAudit(db, ctx, project, { recordId: "A", op, ...(op === "set" ? { ownerWords: "Priority audit noise" } : {}) }));
  expect(audits.every((e) => e.kind === "decision" && e.data.namespace === "priority")).toBe(true);
  const out = await run();
  expect(out.rejected).toEqual([]);
  expect(projectMemories(db, project)).toHaveLength(1);
  expect(projectMemories(db, project)[0]).toMatchObject({ kind: "decision", body: ordinary.text });
  for (const e of audits) {
    const receipt = listEvents(db).find((r) => r.dedupKey === `memory-auto:${project}:ab12/${e.originSeq}`);
    expect(receipt?.data).toMatchObject({ op: "auto_observed" });
    expect(receipt!.data).not.toHaveProperty("rejected");
  }
  const before = listEvents(db);
  expect((await run()).recorded).toBe(0);
  expect(listEvents(db)).toEqual(before);
});

test("priority audit text is absent from completion facts and model prompt; ordinary decisions remain", async () => {
  decision("Priority audit noise", { namespace: "priority" });
  decision("Keep writes atomic");
  const completed = appendEvent(db, ctx, { project, target: "A", kind: "note", text: "Completion fixture" }).event;
  let prompt = "";
  const summary = await prepareSummary(db, completed, { files: async () => ["src/a.ts", "src/b.ts", "src/c.ts"],
    lesson: async (input) => { prompt = input; return "NONE"; } });
  expect(summary!.body).toContain("决定 Keep writes atomic");
  expect(summary!.body).not.toContain("Priority audit noise");
  expect(prompt).toContain("Keep writes atomic");
  expect(prompt).not.toContain("Priority audit noise");
});

test("empty priority lifecycle audits leave a decision-free summary unchanged; other namespaces are still business decisions", async () => {
  const completed = appendEvent(db, ctx, { project, target: "A", kind: "note", text: "Completion fixture" }).event;
  const before = await prepareSummary(db, completed, {});
  priorityAudit(db, ctx, project, { recordId: "A", op: "bind" });
  const after = appendEvent(db, ctx, { project, target: "A", kind: "note", text: "Completion fixture" }).event;
  expect((await prepareSummary(db, after, {}))!.body).toBe(before!.body);
  decision("Keep business decisions", { namespace: "Priority" });
  await run();
  expect(projectMemories(db, project).map((m) => m.body)).toEqual(["Keep business decisions"]);
});
