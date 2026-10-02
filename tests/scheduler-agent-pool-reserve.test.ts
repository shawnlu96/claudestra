import { expect, test } from "bun:test";
import { autoFixture, H1 } from "./scheduler-auto-helpers.js";
import { poolStartGate } from "../src/lib/scheduler-agent-pool-start.js";
import { FINISH_FIRST_WAIT, reserveFinishing, reservedStartPlacement } from "../src/lib/scheduler-agent-pool-reserve.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import type { PlacementFacts } from "../src/lib/scheduler-placement.js";
import { poolAuthorRuntime } from "../src/lib/scheduler-agent-pool-runtime.js";
import { startPlacement } from "../src/lib/scheduler-placement-start.js";

const remote: RemotePolicy = { mode: "balance", roles: [], poolTimeoutMin: 15, repo: "o/r", agents: { claude: 0, codex: 5 } };
type Fixture = ReturnType<typeof autoFixture>;

function finishing(f: Fixture, family: "claude" | "codex", stage = "review") {
  f.db.query("UPDATE tasks SET stage=?, headSHA=?, pr='https://github.com/o/r/pull/7' WHERE id='T1'").run(stage, H1);
  f.db.query("UPDATE task_workflows SET authorFamily=? WHERE taskId='T1'").run(family);
}

function busy(f: Fixture, n: number, offset = 0) {
  f.db.run("PRAGMA foreign_keys=OFF");
  for (let i = 0; i < n; i++) {
    const id = `busy-${i + offset}`;
    f.db.query("INSERT INTO tasks (id,project,title,kind,stage,createdAt,updatedAt) VALUES (?,'p',?,'code','build',0,0)").run(id, id);
    f.db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
      VALUES (?,'author',?,?,'codex','acp','active','i',0,0)`).run(id, id, id);
  }
}

test("acceptance 1: review waiting for unavailable Claude permits local Codex autostart", () => {
  const f = autoFixture();
  try {
    finishing(f, "codex");
    expect(poolStartGate(f.db, "p", remote, [], 1000)).toBeNull();
    expect(poolStartGate(f.db, "p", remote, [], 1000, null)).toBeNull();
  } finally { f.close(); }
});

test("acceptance 2: a Claude author's review reserves the last local Codex seat", () => {
  const f = autoFixture();
  try {
    finishing(f, "claude"); busy(f, 4);
    expect(poolStartGate(f.db, "p", remote, [], 1000)).toBe(FINISH_FIRST_WAIT);
    expect(poolStartGate(f.db, "p", remote, [], 1000, null)).toBe(FINISH_FIRST_WAIT);
  } finally { f.close(); }
});

test("a fix reserves its author's family, leaving excess seats usable", () => {
  const f = autoFixture();
  try {
    finishing(f, "codex", "fix"); busy(f, 3);
    expect(poolStartGate(f.db, "p", remote, [], 1000)).toBeNull();
    busy(f, 1, 3);
    expect(poolStartGate(f.db, "p", remote, [], 1000)).toBe(FINISH_FIRST_WAIT);
  } finally { f.close(); }
});

test("peer seats are reserved before pinned admission, without blocking other families", () => {
  const f = autoFixture();
  try {
    finishing(f, "codex");
    recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "b", seq: 1, paused: null,
      slots: { claude: { total: 1, busy: 0 }, codex: { total: 0, busy: 0 } },
      grant: { until: 10000, repos: ["o/r"], roles: [], ordersPerDay: 50, ordersLeftToday: 50 } }, 1000);
    const borrow = [{ peer: "mate", projects: ["p"], maxOpen: 0, roles: [] }];
    expect(poolStartGate(f.db, "p", remote, borrow, 1000)).toBeNull();
    expect(poolStartGate(f.db, "p", remote, borrow, 1000, null)).toBeNull();
    expect(poolStartGate(f.db, "p", remote, borrow, 1000, { name: "mate", repo: "o/r" })).toBe(FINISH_FIRST_WAIT);
  } finally { f.close(); }
});

test("reservation chooses remaining Codex after consuming the preferred Claude seat, without mutating inputs", () => {
  const f = autoFixture();
  try {
    finishing(f, "codex");
    const facts: PlacementFacts = { remote, peers: [], repo: "o/r", pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true,
      local: { running: 0, room: true, pool: { totals: { claude: 1, codex: 1 }, running: { claude: 0, codex: 0 } } } };
    const reserved = reserveFinishing(f.db, "p", facts);
    expect(reservedStartPlacement(facts, reserved)).toMatchObject({ kind: "local", family: "codex" });
    expect(facts.local.pool!.running).toEqual({ claude: 0, codex: 0 });
  } finally { f.close(); }
});

test("submitted finishing orders do not reserve an additional seat", async () => {
  const f = autoFixture();
  try {
    await f.tick(); await f.tick(); // obtain a real intent, then make it the submitted review of this head
    finishing(f, "claude"); busy(f, 4);
    f.db.query("UPDATE scheduler_intents SET action='review', head=?, status='submitted' WHERE taskId='T1'").run(H1);
    expect(poolStartGate(f.db, "p", remote, [], 1000)).toBeNull();
  } finally { f.close(); }
});

test("runtime and start preflight use remaining families after reservation", async () => {
  const f = autoFixture();
  try {
    finishing(f, "codex");
    const policy = { ...remote, agents: { claude: 1, codex: 1 } };
    expect(poolAuthorRuntime("p", policy.agents, f.db.filename)).toBe("codex");
    const io = { policy: () => ({ remote: policy, maxWorkers: 2 }), borrow: async () => [], originRepo: async () => "o/r", now: () => 1000 };
    expect(await startPlacement(f.db, io, { project: "p", repoDir: f.dir, fileGlobs: ["src/lib/new.ts"], want: "auto" }))
      .toMatchObject({ where: "local", reason: expect.stringContaining("codex") });
  } finally { f.close(); }
});

test("multiple queued reviews each reserve one seat; manual reviews do not reserve", () => {
  const f = autoFixture();
  try {
    finishing(f, "claude"); busy(f, 3);
    f.db.query("INSERT INTO tasks (id,project,title,kind,stage,headSHA,createdAt,updatedAt) VALUES ('T2','p','second','code','review',?,0,0)").run(H1);
    f.db.query("INSERT INTO task_workflows SELECT 'T2',project,template,templateVersion,mode,authorFamily,fallback,specRev,rev,createdAt,updatedAt FROM task_workflows").run();
    expect(poolStartGate(f.db, "p", remote, [], 1000)).toBe(FINISH_FIRST_WAIT);
    f.db.query("UPDATE task_workflows SET mode='manual' WHERE taskId='T2'").run();
    expect(poolStartGate(f.db, "p", remote, [], 1000)).toBeNull();
  } finally { f.close(); }
});

test("existing local reviewer binding is counted once rather than reserving twice", async () => {
  const f = autoFixture();
  try {
    await f.tick(); finishing(f, "claude"); busy(f, 3);
    f.db.query("UPDATE scheduler_sessions SET role='reviewer', family='codex' WHERE taskId='T1'").run();
    expect(poolStartGate(f.db, "p", remote, [], 1000)).toBeNull();
  } finally { f.close(); }
});
