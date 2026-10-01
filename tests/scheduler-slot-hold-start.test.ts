import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { claimNode } from "../src/lib/ledger-autostart.js";
import { autostartStep } from "../src/lib/ledger-autostart-step.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import { startPlacement } from "../src/lib/scheduler-placement-start.js";
import { localWriterCount } from "../src/lib/scheduler-pool-facts.js";
import { writeSlotFacts } from "../src/lib/scheduler-slot-hold-facts.js";
import type { SlotPool } from "../src/lib/scheduler-slot-hold-autostart.js";
import { runLedger } from "../src/manager/ledger.js";

const NOW = 10_000_000, ctx = { actor: "owner", now: NOW };
let db: Database, featureId: string, pool: SlotPool, creates: number, gitCalls: number;
const svc = () => ({ autoDispatch: true, projects: ["p"], maxWorkers: () => 2, pool: () => pool, now: () => NOW });
function hello(busy = 0) {
  recordHello(db, "mate", null, { v: 1, proto: 2, boot: "b", seq: busy + 1, paused: null,
    slots: { codex: { total: 2, busy }, claude: { total: 0, busy: 0 } },
    grant: { until: NOW + 3_600_000, roles: ["write"], repos: ["o/r"], ordersPerDay: 20, ordersLeftToday: 20 } }, NOW);
}
const placement = () => ({
  policy: () => ({ remote: pool.remote, maxWorkers: 2 }), borrow: async () => pool.borrow,
  originRepo: async () => "o/r", now: () => NOW,
});
function author(id: string, stage: "spec" | "restate" | "build") {
  createTask(db, ctx, { project: "p", id, title: id, kind: "code", agent: `agent-${id}`, extra: { fileGlobs: [`${id}.ts`] } });
  db.run("UPDATE tasks SET stage = ? WHERE id = ?", [stage, id]);
  if (stage === "build") db.run(`INSERT INTO scheduler_intents
    (id,taskId,project,node,action,causalSeq,taskRev,specRev,templateVersion,status,reason,createdAt,updatedAt)
    VALUES (?,?,'p','build','dispatch',0,1,1,2,'done','test',?,?)`, [`test-${id}`, id, NOW, NOW]);
  if (stage === "build") db.run(`INSERT INTO scheduler_resources (project,resource,taskId,intentId,scope,acquiredAt)
    VALUES ('p', ?, ?, ?, 'card', ?)`, [`slot:p:${id === "a" ? 0 : 1}`, id, `test-${id}`, NOW]);
}
function env(): StartTickEnv {
  return {
    db, svc: svc(), now: () => NOW, memo: new Set(), attempt: () => "attempt",
    ledger: async (...args) => {
      if (args[2] === "claim") {
        const peerAt = args.indexOf("--peer");
        try {
          return { ok: true, ...claimNode(db, { actor: "scheduler", now: NOW }, {
            featureId, key: "next", arm: args[args.indexOf("--arm") + 1], template: "code", svc: svc(),
            peer: peerAt < 0 ? null : JSON.parse(args[peerAt + 1]),
          }) };
        } catch (e) { return { ok: false, code: "conflict", error: String(e) }; }
      }
      return runLedger(args.slice(1), { db, actor: "scheduler", projectIds: ["p"],
        loadRegistry: async () => ({}) as never, saveRegistry: async () => {}, now: () => NOW,
        autoDispatch: () => true, autoProjects: () => ["p"] });
    },
    plain: async () => { creates++; return { ok: true }; },
    startEnv: () => ({ ledgerDir: "/fake/ledger", worktreeRoot: "/fake/wt", projectDirs: async () => ["/fake/repo"],
      agentNames: () => [], exists: (p) => p.endsWith(".git") || p.endsWith("slots-next.md"), branchExists: async () => false,
      autoReady: () => null, template: () => null, placement: (d, q) => startPlacement(d, placement(), q) }),
    stepIO: () => ({ git: async () => { gitCalls++; return { ok: true, out: "" }; }, exists: () => false,
      read: () => null, write: () => {}, remove: () => {}, symlink: () => {}, agentExists: () => false }),
    readSpec: () => ({ text: "# spec\n\n## Goal\n", mtimeMs: NOW - 120_000 }),
    quota: async () => ({ status: "unknown" }) as never, notifyPm: async () => {},
  };
}
beforeEach(() => {
  db = openLedger(":memory:"); creates = gitCalls = 0;
  db.run("INSERT INTO ledger_instance (key,value) VALUES ('origin','ab12')");
  setMeta(db, ctx, { project: "p", key: "pms", value: ["pm"] });
  const f = createFeature(db, ctx, { project: "p", slug: "slots", title: "slots" }).row;
  featureId = f.id;
  initDag(db, ctx, { id: f.id, rev: f.rev, nodes: [{ key: "next", oneLine: "next", fileGlobs: ["next.ts"] }] });
  pool = { remote: { mode: "balance", roles: ["write"], repo: "o/r", poolTimeoutMin: 15 },
    borrow: [{ peer: "mate", projects: ["p"], roles: ["write"], maxOpen: 5 }] };
  hello();
});
afterEach(() => closeLedger(":memory:"));

test("spec and restate authors without persisted slots fill local capacity", async () => {
  author("a", "spec"); author("b", "restate");
  expect(writeSlotFacts(db, "p").workerCount).toBe(2);
  expect(localWriterCount(db, "p", "a")).toBe(1);
  pool.borrow = [];
  expect(await startPlacement(db, placement(), { project: "p", repoDir: "/fake/repo", fileGlobs: ["next.ts"], want: "auto" }))
    .toMatchObject({ where: "refused" });
  expect(await autostartTick(env())).toEqual([]);
  expect(getTask(db, "slots-next")).toBeNull();
  expect(creates).toBe(0);
});
for (const off of [false, true]) {
  test(`autostart uses peer with no local agent/worktree when ${off ? "localPriority=off" : "local slots full"}`, async () => {
    if (off) pool.remote!.localPriority = "off";
    else { author("a", "build"); author("b", "build"); }
    expect(await autostartTick(env())).toEqual([]);
    expect(getTask(db, "slots-next")).toMatchObject({ stage: "restate", agent: null, extra: { placement: "peer:mate", repo: "o/r" } });
    expect(creates).toBe(0); expect(gitCalls).toBe(0);
  });
  test(`autostart waits when peer full and ${off ? "local off" : "local full"}`, async () => {
    if (off) pool.remote!.localPriority = "off";
    else { author("a", "build"); author("b", "build"); }
    hello(2);
    expect(await autostartTick(env())).toEqual([]);
    expect(getTask(db, "slots-next")).toBeNull();
    expect(creates).toBe(0); expect(gitCalls).toBe(0);
  });
}
test("claim reserves local admission before task creation and cannot grant peer privileges to local card", () => {
  pool = { remote: null, borrow: [] };
  const c = claimNode(db, { actor: "scheduler", now: NOW }, { featureId, key: "next", arm: "0123456789abcdef", template: "code", svc: svc() }).claim;
  expect(writeSlotFacts(db, "p").workerCount).toBe(1);
  autostartStep(db, { actor: "scheduler", now: NOW }, { claim: c.seq, sub: "task-new", pos: [c.taskId], flags: {} });
  expect(writeSlotFacts(db, "p").workerCount).toBe(1);
  expect(() => autostartStep(db, { actor: "scheduler", now: NOW }, {
    claim: c.seq, sub: "stage", pos: [c.taskId], flags: { from: "spec", to: "restate" },
  })).toThrow("stage 只能取消");
});

test("claim rejects a local destination with localPriority=off even while a peer is free", () => {
  pool.remote!.localPriority = "off";
  expect(() => claimNode(db, { actor: "scheduler", now: NOW }, {
    featureId, key: "next", arm: "0123456789abcdef", template: "code", svc: svc(),
  })).toThrow("不能在本机开卡");
});
test("peer capacity lost after placement does not authorize a claim or local fallback", async () => {
  pool.remote!.localPriority = "off";
  expect(await startPlacement(db, placement(), { project: "p", repoDir: "/fake/repo", fileGlobs: ["next.ts"], want: "auto" }))
    .toMatchObject({ where: "peer" });
  hello(2);
  expect(() => claimNode(db, { actor: "scheduler", now: NOW }, {
    featureId, key: "next", arm: "0123456789abcdef", template: "code", svc: svc(),
    peer: { name: "mate", repo: "o/r", reason: "selected" },
  })).toThrow("peer 写单名额已满");
  expect(getTask(db, "slots-next")).toBeNull();
});
