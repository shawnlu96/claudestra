/** STALLVER2: waiting only on a dependency chases the upstream; the PM step is a note on the card; a live lend executor is progress. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { setPriority, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import { listAsks } from "../src/lib/ledger-asks.js";
import { priorityStallBases } from "../src/lib/ledger-priority-stall-read.js";
import { claimPriorityStalls, finishPriorityStall, priorityStallDue } from "../src/lib/ledger-priority-stall-store.js";
import { priorityStallCommand } from "../src/lib/ledger-priority-stall-command.js";
import { priorityStallTick } from "../src/lib/ledger-priority-stall-tick.js";
import { PRIORITY_STALL_MS as W } from "../src/lib/ledger-priority-stall.js";
import { runLedger } from "../src/manager/ledger.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";

let db: Database, now: number, notices: number, calls: number;
const project = "chase", pm = "agent-pm", t0 = 1000, fid = "ab12-chase";
const evidence = { ownerWords: "now", ownerAt: t0, sourceRef: "test:owner" };
const config = { enabled: true, autoDispatch: true, projects: { [project]: { maxActiveWorkers: 3 } } } as unknown as SchedulerConfig;
const svc = { autoDispatch: true, projects: [project], maxWorkers: () => 3 };
const ctx = () => ({ actor: "scheduler", now });
const manager = async (...args: string[]) => {
  calls++;
  return runLedger(args.slice(1), { db, actor: "scheduler", projectIds: [project], now: () => now, autoDispatch: () => true,
    autoProjects: () => [project], loadRegistry: async () => ({ agents: {}, socket: "" }), saveRegistry: async () => {} });
};
// The injected notice stub the old PM step called; STALLVER2 must leave it at zero.
const ports = () => ({ manager, active: () => {}, now: () => now, notify: async () => { notices++; } });
const tick = () => priorityStallTick(db, config, ports());
const notes = () => listEvents(db).filter((e) => e.data.namespace === "priority-stall-note");
const nowNode = (key: string) => setPriority(db, { actor: pm, project, now: t0, dedupKey: `now-${key}` },
  { target: { kind: "node", id: fid, nodeKey: key }, band: "now", rev: 0, evidence });
const nowTask = (id: string) => setPriority(db, { actor: pm, project, now: t0, dedupKey: `now-${id}` },
  { target: { kind: "task", id }, band: "now", rev: 0, evidence });
function build(id: string, at = t0) {
  createTask(db, { actor: pm, now: t0 }, { project, id, kind: "code", title: id, pm });
  moveStage(db, { actor: pm, now: at }, { taskId: id, from: "spec", to: "restate" });
  moveStage(db, { actor: pm, now: at }, { taskId: id, from: "restate", to: "build" });
}
function graph(nodes: unknown[]) {
  createFeature(db, { actor: pm, now: t0 }, { project, slug: "chase", title: "chase" });
  initDag(db, { actor: pm, now: t0 }, { id: fid, rev: 1, nodes });
}
function order(taskId: string, o: { leaseUntil: number; beatAt: number | null; step?: string; status?: string }) {
  db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status,
    leaseMs, leaseUntil, beatAt, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, 'peer:x', 'claude', ?, 1, 0, 'h', 'o/r', 'v1', 't', 's', ?, 600000, ?, ?, 'pm', ?, ?)`)
    .run(`lend:${taskId}`, taskId, project, o.step ?? "fix", o.status ?? "claimed", o.leaseUntil, o.beatAt, t0, t0);
}

beforeEach(() => {
  db = openLedger(":memory:"); now = t0; notices = 0; calls = 0;
  db.query("INSERT INTO ledger_instance(key,value) VALUES ('origin','ab12')").run();
  setMeta(db, { actor: "owner" }, { project, key: "pms", value: [pm] });
  setPriorityMode(db, { actor: pm, project, now: t0, dedupKey: "mode" }, { mechanism: "priorityStall", mode: "on", rev: 0, evidence });
});
afterEach(() => closeLedger(":memory:"));

function waitOnCard() {
  build("B");
  graph([{ key: "b", taskId: "B" }, { key: "a1", oneLine: "a1", deps: ["b"], fileGlobs: ["src/a1.ts"] },
    { key: "a2", oneLine: "a2", deps: ["b"], fileGlobs: ["src/a2.ts"] }]);
  nowNode("a1");
}

test("[验收线 1] a now node waiting only on card B is not reported; B (not now) is, once, with every waiting node as impact", async () => {
  waitOnCard();
  now = t0 + W;
  let bases = priorityStallBases(db, project, undefined, now);
  expect(bases.find((b) => b.nodeKey === "a1")).toMatchObject({ eligible: false, block: { kind: "deps", on: ["b"] } });
  expect(bases.filter((b) => b.taskId === "B")).toEqual([expect.objectContaining({ eligible: true, impact: [`${fid}/a1`], stage: "build" })]);
  nowNode("a2");
  bases = priorityStallBases(db, project, undefined, now);
  const due = bases.filter((b) => priorityStallDue(db, b, now));
  expect(due.map((b) => b.label)).toEqual(["B"]);
  expect(due[0].impact).toEqual([`${fid}/a1`, `${fid}/a2`]);
  // The keyed writer recheck reaches the same answer for a target that is not itself now.
  expect(priorityStallBases(db, project, due[0].key, now)).toEqual([due[0]]);
  expect(await tick()).toEqual([]);
  expect(notes()).toHaveLength(1);
  expect(notes()[0]).toMatchObject({ target: "B", data: { impact: [`${fid}/a1`, `${fid}/a2`] } });
  expect(notes()[0].text).toContain(`影响：${fid}/a1, ${fid}/a2`);
});

test("[验收线 2] upstream progress within a window keeps both the waiting node and the upstream quiet", async () => {
  waitOnCard(); nowNode("a2");
  moveStage(db, { actor: pm, now: t0 + W - 10 }, { taskId: "B", from: "build", to: "review" });
  now = t0 + W;
  expect(priorityStallBases(db, project, undefined, now).filter((b) => priorityStallDue(db, b, now))).toEqual([]);
  expect(await tick()).toEqual([]);
  expect(calls).toBe(0); expect(claimPriorityStalls(db, ctx(), project)).toEqual([]);
});

test("[验收线 3] on reaches the PM step without any push: one deduped note, not repeated in the cycle or after a restart", async () => {
  build("T"); nowTask("T");
  const memory = db, root = mkdtempSync(join(tmpdir(), "stall-note-")), path = join(root, "ledger.sqlite");
  writeFileSync(path, db.serialize()); db = openLedger(path);
  try {
    now = t0 + W;
    expect(await tick()).toEqual([]);
    expect(notices).toBe(0);
    expect(notes()).toHaveLength(1);
    const note = notes()[0], key = priorityStallBases(db, project)[0].key;
    expect(note.dedupKey).toBe(`priority-stall-note:${project}:${key}:${note.data.cycle}:pm`);
    expect(note).toMatchObject({ target: "T", data: { key, step: "pm", featureId: null, nodeKey: null } });
    for (let i = 0; i < 3; i++) { now += 60_000; await tick(); }
    closeLedger(path); db = openLedger(path);
    now += 5 * 60_000; await tick();
    expect(notes()).toHaveLength(1); expect(notices).toBe(0);
    // A note is not progress: the clock keeps running to the owner step.
    now = t0 + 2 * W; await tick();
    expect(listAsks(db, { project, states: ["open"] })).toHaveLength(1);
    expect(notes()).toHaveLength(1);
  } finally { closeLedger(path); db = memory; rmSync(root, { recursive: true, force: true }); }
});

test("[验收线 3] the note op fences a stale token and replays its own dedup", () => {
  build("T"); nowTask("T"); now = t0 + W;
  const heal = claimPriorityStalls(db, ctx(), project)[0];
  finishPriorityStall(db, ctx(), project, heal.basis.key, heal.token, "unavailable", "none");
  const p = claimPriorityStalls(db, ctx(), project)[0];
  expect(p.action).toBe("pm");
  const input = { op: "note" as const, key: p.basis.key, token: p.token };
  const first = priorityStallCommand(db, { ...ctx(), dedupKey: "n1" }, project, "T", input, svc);
  expect(first.noteSeq).toBeNumber();
  expect(priorityStallCommand(db, { ...ctx(), dedupKey: "n1" }, project, "T", input, svc)).toEqual(first);
  expect(priorityStallCommand(db, { ...ctx(), dedupKey: "n2" }, project, "T", input, svc)).toEqual({ ok: true, stale: true });
  expect(notes()).toHaveLength(1);
});

test("[验收线 4] an unbound upstream node gets its note with an empty target and featureId/nodeKey in data", async () => {
  graph([{ key: "up", oneLine: "no globs yet" }, { key: "a", oneLine: "a", deps: ["up"], fileGlobs: ["src/a.ts"] }]);
  nowNode("a");
  now = t0 + W;
  const up = priorityStallBases(db, project, undefined, now).find((b) => b.nodeKey === "up")!;
  expect(up).toMatchObject({ eligible: true, block: { kind: "no_globs" }, impact: [`${fid}/a`] });
  expect(await tick()).toEqual([]);
  expect(notes()).toHaveLength(1);
  expect(notes()[0]).toMatchObject({ target: "", data: { featureId: fid, nodeKey: "up", key: up.key } });
});

function fixCard() {
  build("T"); nowTask("T");
  moveStage(db, { actor: pm, now: t0 }, { taskId: "T", from: "build", to: "review" });
  moveStage(db, { actor: pm, now: t0 }, { taskId: "T", from: "review", to: "fix" });
  now = t0 + 3 * W;
}

test("[验收线 5] a fix card with a claimed lend order beating within a window is not stalled", async () => {
  fixCard();
  order("T", { leaseUntil: now + 60_000, beatAt: now - 60_000 });
  expect(priorityStallBases(db, project, undefined, now).filter((b) => priorityStallDue(db, b, now))).toEqual([]);
  expect(await tick()).toEqual([]);
  expect(calls).toBe(0); expect(claimPriorityStalls(db, ctx(), project)).toEqual([]);
});

test("[验收线 5] a beat older than one window still counts as stalled", () => {
  fixCard();
  order("T", { leaseUntil: now + 60_000, beatAt: now - W });
  expect(claimPriorityStalls(db, ctx(), project)[0]?.action).toBe("heal");
});

test("[验收线 5] an expired lease still counts as stalled; a beat landing after the claim fences its receipt", () => {
  fixCard();
  order("T", { leaseUntil: now, beatAt: now - 60_000 });
  const heal = claimPriorityStalls(db, ctx(), project)[0];
  expect(heal.action).toBe("heal");
  db.query("UPDATE lend_orders SET leaseUntil=?, beatAt=?").run(now + 10 * 60_000, now);
  expect(finishPriorityStall(db, ctx(), project, heal.basis.key, heal.token, "success", "late")).toBe(false);
});

test.each([["review", "claimed"], ["fix", "pooled"]])("[验收线 5] stage %s with a %s order is not a live executor", (stage, status) => {
  fixCard();
  if (stage === "review") db.query("UPDATE tasks SET stage='review' WHERE id='T'").run();
  order("T", { leaseUntil: now + 60_000, beatAt: now - 60_000, status });
  expect(claimPriorityStalls(db, ctx(), project)[0]?.action).toBe("heal");
});

test("[验收线 6] a cancelled upstream is graph configuration: one note on the waiting card, never an owner ask", async () => {
  createTask(db, { actor: pm, now: t0 }, { project, id: "U", kind: "code", title: "U", pm });
  createTask(db, { actor: pm, now: t0 }, { project, id: "A", kind: "code", title: "A", pm });
  addDep(db, { actor: pm, now: t0 }, { from: "U", to: "A", when: "U live" });
  db.query("UPDATE tasks SET stage='cancelled' WHERE id='U'").run();
  nowTask("A");
  const a = priorityStallBases(db, project).find((b) => b.taskId === "A")!;
  expect(a).toMatchObject({ eligible: true, config: "前置卡 U 已取消", block: { kind: "deps", on: ["U"] } });
  for (let i = 1; i <= 5; i++) { now = t0 + i * W; expect(await tick()).toEqual([]); }
  expect(notes()).toHaveLength(1);
  expect(notes()[0].text.split("\n")[0]).toBe("now 链图配置问题：前置卡 U 已取消");
  expect(listAsks(db, { project })).toHaveLength(0); expect(notices).toBe(0);
});

test("[验收线 6] a planned node whose upstream node's card is cancelled is configuration too", () => {
  createTask(db, { actor: pm, now: t0 }, { project, id: "U", kind: "code", title: "U", pm });
  graph([{ key: "up", taskId: "U" }, { key: "a", oneLine: "a", deps: ["up"], fileGlobs: ["src/a.ts"] }]);
  db.query("UPDATE tasks SET stage='cancelled' WHERE id='U'").run();
  nowNode("a");
  expect(priorityStallBases(db, project).find((b) => b.nodeKey === "a")).toMatchObject({ eligible: true, config: "前置卡 U 已取消" });
});

test("[验收线 7] a genuinely stalled build card with no live order still escalates to the owner ask on the existing windows", async () => {
  build("T"); nowTask("T");
  order("T", { leaseUntil: t0 + 60_000, beatAt: t0 });
  now = t0 + W; await tick();
  expect(listAsks(db, { project })).toHaveLength(0); expect(notes()).toHaveLength(1);
  now = t0 + 2 * W - 1; await tick();
  expect(listAsks(db, { project })).toHaveLength(0);
  now = t0 + 2 * W; await tick();
  expect(listAsks(db, { project, states: ["open"] })).toEqual([expect.objectContaining({ kind: "owner_action", title: "now 停滞：T" })]);
  expect(notices).toBe(0);
});
