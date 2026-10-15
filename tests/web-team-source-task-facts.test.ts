import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { nodeFacts, teamTaskFacts } from "@/features/collab/team-source-task-facts";
import { teamDagBoard } from "@/features/collab/team-source-dag";
import { teamOverview } from "@/features/collab/team-source-adapter";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { SharedLedgerSession, type FeatureList, type Identity, type Transport } from "@/lib/api/shared-ledger";
import type { TaskFact, TaskFacts } from "@/lib/api/shared-ledger-reads";
import { subdagFocus } from "@/features/collab/dag/subdag-focus";
import { feature, node, teamRow, teamWorkBoard } from "./web-collab-dag-fixture";

const fx = generateTeamFixture();
const identity: Identity = { center: "c", team: fx.team, person: "p", project: fx.project, machine: "m" };
const transport: Transport = { list: async () => fx.list, detail: async () => fx.details[0]!,
  command: async () => { throw new Error("unused"); }, receipt: async id => ({ status: "unknown", requestId: id }) };
const fact: TaskFact = { taskId: "center-card", stageSince: 100, doneAt: null, lastEvent: { at: 200, kind: "review" } };
const response = (id: string): TaskFacts => ({ schemaVersion: 1, teamId: fx.team, projectId: fx.project, featureId: id, serverSeq: 1, tasks: [fact] });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => { clock?.mockRestore(); clock = undefined; });
let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;

test("[验收线 1] nodeFacts omits missing values and mismatched phases", () => {
  expect(nodeFacts(fact, "active")).toEqual({ since: 100, lastEvent: { at: 200, actor: "", kind: "review", text: "" } });
  const done = { ...fact, stageSince: null, lastEvent: null, doneAt: 300 };
  expect(nodeFacts(done, "done")).toEqual({ doneAt: 300 });
  for (const phase of ["idle", "active", "done"] as const) {
    expect(nodeFacts(undefined, phase)).toEqual({});
    expect(nodeFacts({ ...fact, stageSince: null, lastEvent: null }, phase)).toEqual({});
  }
  expect(nodeFacts(done, "active")).toEqual({});
  expect(nodeFacts(fact, "done")).toEqual({});
  expect(nodeFacts(fact, "idle")).toEqual({});
  expect(nodeFacts({ ...fact, lastEvent: null }, "active")).toEqual({ since: 100 });
  expect(nodeFacts({ ...fact, stageSince: null }, "active")).toEqual({ lastEvent: { at: 200, actor: "", kind: "review", text: "" } });
});

test("[验收线 3] facts reach team focus-card elapsed time without inventing normal duration", () => {
  const f = feature("F1", [node("A", "active", [], { ...nodeFacts(fact, "active") })]);
  const work = { kind: "team" as const, board: teamWorkBoard({ working: [teamRow("A")] }) };
  const card = subdagFocus(f, work, 300).active[0]!;
  expect(card.since).toBe(100);
  expect(card.lastEvent).toEqual({ at: 200, kind: "review", text: "" });
  expect(card.normalMinutes).toBeNull();
  expect(subdagFocus(feature("F1", [node("A", "active", [], { since: null })]), work, 300).active[0]!.since).toBeNull();
});

test("[验收线 1] board uses central ids including duplicate display ids; no facts preserves JSON", () => {
  const ds = structuredClone(fx.details);
  const active = ds.flatMap(d => d.tasks).filter(t => t.stage === "build").slice(0, 2);
  expect(active.length).toBe(2);
  active.forEach(t => { t.sourceTaskId = "same-card"; });
  const details = new Map(ds.map(d => [d.feature.id, d]));
  const team = teamOverview(fx.list, details, fx.now);
  const plain = teamDagBoard("team", fx.list, details, team);
  expect(createHash("sha256").update(JSON.stringify(plain)).digest("hex")).toBe("ebffc8911d6f36a89fbfda6f11fefdfb0f9a1d9243ab03234ac255814b8ff698");
  const map = new Map(active.map((t, i) => [t.taskId, { ...fact, taskId: t.taskId, stageSince: 100 + i }]));
  const got = teamDagBoard("team", fx.list, details, team, () => map);
  for (const [i, id] of ["same-card", "same-card~2"].entries()) {
    expect(got.features.flatMap(f => f.nodes).find(n => n.taskId === id)?.since).toBe(100 + i);
  }
  const none = teamDagBoard("team", fx.list, details, team, () => null);
  expect(JSON.stringify(none)).toBe(JSON.stringify(plain));
  for (const f of plain.features) for (const n of f.nodes) {
    if (!n.taskId?.startsWith("same-card")) expect(got.features.find(g => g.id === f.id)!.nodes.find(g => g.key === n.key)).toEqual(n);
  }
});

function reader() {
  let now = 0, changes = 0;
  clock = spyOn(Date, "now").mockImplementation(() => now);
  const session = new SharedLedgerSession({ ...identity }, transport);
  const calls: { id: string; resolve: (r: TaskFacts | null) => void }[] = [];
  const source = teamTaskFacts(session, () => { changes++; }, {
    taskFacts: id => new Promise(resolve => { calls.push({ id, resolve }); }),
  });
  const a = fx.list.features[0]!.id, b = fx.list.features[1]!.id;
  const list = (seq: number, projection = true): FeatureList => ({ ...fx.list, features: fx.list.features.map(f => ({ ...f, updatedAt: seq,
    projection: projection ? { sourceInstanceId: "home", sourceSeq: seq, observedAt: now, receivedAt: now } : null })) });
  return { source, session, calls, a, b, list, time: (t: number) => { now = t; }, changes: () => changes };
}

test("[验收线 1] only open feature reads; changed watermark requires 30 seconds; requests coalesce", async () => {
  const w = reader();
  w.source.board(w.list(1)); expect(w.calls).toHaveLength(0);
  w.source.open(w.a); w.source.open(w.a); w.source.board(w.list(2));
  expect(w.calls).toHaveLength(1);
  w.calls[0]!.resolve(response(w.a)); await flush();
  expect(w.changes()).toBe(1);
  w.time(29_999); w.source.board(w.list(2)); expect(w.calls).toHaveLength(1);
  w.time(30_000); w.source.board(w.list(2)); expect(w.calls).toHaveLength(2);
  w.source.board(w.list(3)); expect(w.calls).toHaveLength(2);
  w.source.open(w.b); expect(w.calls).toHaveLength(3);
  w.calls[1]!.resolve(response(w.a)); w.calls[2]!.resolve(response(w.b)); await flush();
  w.time(60_000); w.source.board(w.list(4));
  expect(w.calls.map(c => c.id)).toEqual([w.a, w.a, w.b, w.b]);
  w.source.open(null); w.time(90_000); w.source.board(w.list(4)); expect(w.calls).toHaveLength(4);
});

test("[验收线 1] null retains last success, does not notify or retry unchanged watermark", async () => {
  const w = reader();
  w.source.board(w.list(1)); w.source.open(w.a);
  w.calls[0]!.resolve(response(w.a)); await flush();
  const saved = w.source.board(w.list(1))(w.a);
  w.time(30_000); w.source.board(w.list(2)); w.calls[1]!.resolve(null); await flush();
  expect(w.source.board(w.list(2))(w.a)).toBe(saved); expect(w.changes()).toBe(1);
  w.time(100_000); w.source.open(w.a); w.source.board(w.list(2)); expect(w.calls).toHaveLength(2);
  w.source.board(w.list(3)); expect(w.calls).toHaveLength(3);
});

test("[验收线 1] updatedAt fallback; first null stays null even with open before board", async () => {
  const w = reader();
  w.source.open(w.a); w.calls[0]!.resolve(null); await flush();
  expect(w.source.board(w.list(1, false))(w.a)).toBeNull();
  w.time(40_000); w.source.board(w.list(1, false)); expect(w.calls).toHaveLength(1);
  w.source.board(w.list(2, false)); expect(w.calls).toHaveLength(2);
  expect(w.changes()).toBe(0);
});

test("[验收线 1] identity change hides old cache and late results stay under originating identity", async () => {
  const w = reader();
  w.source.board(w.list(1)); w.source.open(w.a);
  const old = { ...w.session.identity };
  w.session.switchIdentity({ ...old, person: "other" }, transport);
  expect(w.source.board(w.list(1))(w.a)).toBeNull();
  w.source.open(w.a); expect(w.calls).toHaveLength(2);
  w.calls[0]!.resolve(response(w.a)); await flush();
  expect(w.source.board(w.list(1))(w.a)).toBeNull();
  w.calls[1]!.resolve({ ...response(w.a), tasks: [{ ...fact, stageSince: 999 }] }); await flush();
  expect(w.source.board(w.list(1))(w.a)?.get(fact.taskId)?.stageSince).toBe(999);
  w.session.switchIdentity(old, transport);
  expect(w.source.board(w.list(1))(w.a)?.get(fact.taskId)?.stageSince).toBe(100);
});
