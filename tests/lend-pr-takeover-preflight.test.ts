import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { uiDeliverPort } from "../src/lib/ledger-deliver-ui-port.js";
import type { UiDeliverPort } from "../src/lib/ledger-deliver-ui.js";
import { getLendOrder } from "../src/lib/ledger-lend.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { acquireLock, type LockHandle } from "../src/lib/file-lock.js";
import { encodeLease, SchedulerLeaseLost } from "../src/lib/scheduler-lease-env.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { beatLend } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { lendTakeoverStep, type TakeoverGh } from "../src/lib/lend-pr-takeover.js";
import { uiTakeoverRefusal } from "../src/lib/lend-pr-takeover-refusal.js";
import { runLedger } from "../src/manager/ledger.js";
import { takeoverDeps } from "../src/manager/ledger-lend-takeover-cmds.js";
import { testChildEnv } from "./test-env.js";

const project = "uitake", taskId = "UT", branch = "lend/UT", base = "a".repeat(40), head = "b".repeat(40);
let db: Database, now: number, seen: Map<string, string>, id: string;
let dir: string, policyPath: string, creates: number, calls: number;
let gh: TakeoverGh;
const atHead = async () => ({ ok: true as const, head });
const port = (peer: { peer: string; worker: string; orderId: string }) => uiDeliverPort({ peer, policyPath, root: join(dir, "artifacts"), now });
const policy = (value: string) => { writeFileSync(policyPath, JSON.stringify({ projects: { [project]: { keys: { uiDelivery: value } } } })); };
const run = (args: string[], actor = "agent-lead") => runLedger(args, {
  db, actor, projectIds: [project], autoProjects: () => [project], assertLease: () => {}, now: () => now,
  loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {},
  lend: { borrow: async () => [{ peer: "testpeer", projects: [project], roles: ["write" as const], maxOpen: 1 }], notifyPm: async () => {},
    result: { peerFp: async () => "abcd-ef01-2345-6789", remoteHead: async (_repo: string, br: string) => ({ ok: true as const, head: br === "main" ? base : head }) } } as never,
}) as Promise<Record<string, any>>;
const step = (uiPort = port) => lendTakeoverStep(db, { gh, seen, now: () => now, uiPort,
  manager: (...args) => {
    if (args[1] === "lend-takeover") calls++;
    takeoverDeps.make = () => ({ remoteHead: (repo, br) => gh.head(repo, br), uiPort });
    return run(args.slice(1), "scheduler");
  } });
const snapshot = () => JSON.stringify((db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
  .map(({ name }) => [name, db.query(`SELECT * FROM "${name}"`).all()]));
const notes = () => listEvents(db, { target: taskId }).filter(e => e.data.preflight === true);
const savedMake = takeoverDeps.make;

beforeEach(async () => {
  now = 10_000; seen = new Map(); creates = 0; calls = 0;
  dir = mkdtempSync(join(tmpdir(), "uitake-preflight-")); db = openLedger(join(dir, "source.sqlite")); policyPath = join(dir, "policy.json"); policy("on");
  const spec = join(dir, "spec.md"); writeFileSync(spec, "Isolated UI takeover fixture.");
  setMeta(db, { actor: "owner", now }, { project, key: "pms", value: ["agent-lead"] });
  createTask(db, { actor: "owner", now }, { project, id: taskId, title: "UI takeover", kind: "code", spec, agent: "agent-writer" });
  db.run("UPDATE tasks SET stage='build' WHERE id=?", [taskId]);
  db.run(`INSERT INTO task_workflows (taskId,project,template,templateVersion,mode,authorFamily,fallback,specRev,createdAt,updatedAt)
    VALUES (?,?,'ui',3,'manual','codex','',1,1,1)`, [taskId, project]);
  const offered = await run(["lend-offer", taskId, "--peer", "testpeer", "--repo", "example/test"]);
  expect(offered).toMatchObject({ ok: true }); id = offered.orderId;
  expect(await run(["lend-claim", "--", "testpeer", JSON.stringify({ v: 1, orderId: id, worker: "agent-testworker" })], "owner")).toMatchObject({ ok: true });
  db.run("UPDATE lend_orders SET branch=? WHERE orderId=?", [branch, id]);
  const beat = () => beatLend(db, { actor: "owner", now }, "testpeer", { v: 1, orders: [{ orderId: id, gen: 1,
    phase: "publishing", lastActivityAt: 0, excerpt: "fixture", ended: null }] } as never, new Map());
  beat(); now += 180_000; beat(); now += 180_000; beat();
  takeoverDeps.make = () => ({ remoteHead: atHead, uiPort: port });
  gh = { head: atHead, compare: async () => ({ ok: true, value: "ahead" }), openPr: async () => ({ ok: true, value: null }),
    createPr: async () => { creates++; return { ok: true, value: 42 }; } };
});
afterEach(() => { takeoverDeps.make = savedMake; closeLedger(db.filename); });

test("old create-before-CLI refuses after an external PR; new preflight is 0 create / 0 takeover with one persistent diagnostic", async () => {
  await gh.createPr({ repo: "example/test", branch, base: "main", title: "fixture", body: "fixture" });
  const before = snapshot();
  expect(await run(["lend-takeover", id, "--head", head, "--pr", "42"], "scheduler")).toMatchObject({ ok: false, code: "invalid" });
  expect(snapshot()).toBe(before); expect(creates).toBe(1); creates = 0;
  await step(); expect((await step()).failed).toHaveLength(1);
  for (let n = 0; n < 8; n++) expect((await step()).failed).toEqual([]);
  seen = new Map(); await step(); await step(); // Restart: persistent dedup, not in-memory suppression.
  expect(creates).toBe(0); expect(calls).toBe(0); expect(notes()).toHaveLength(1);
  expect(notes()[0].data).toMatchObject({ orderId: id, head, code: "missing", pr: null, preflight: true });
  expect(getWriteLease(db, taskId)?.state).toBe("held");
  expect(getLendOrder(db, id)?.status).toBe("claimed");
  expect(getTask(db, taskId)?.stage).toBe("build");
  const afterDiagnostic = snapshot();
  await run(["lend-takeover", id, "--head", head, "--pr", "42"], "scheduler");
  expect(snapshot()).toBe(afterDiagnostic);
});

for (const value of ["observe", "off", "code"]) test(`${value} preserves original PR / takeover route`, async () => {
  if (value === "code") db.run("UPDATE task_workflows SET template='code' WHERE taskId=?", [taskId]);
  else policy(value);
  await step(); await step();
  expect(creates).toBe(1); expect(calls).toBe(1); expect(getTask(db, taskId)?.stage).toBe("review");
  expect(notes()).toEqual([]);
});

test("existing PR is recorded as existing; unknown lookup never claims not sent or attempts takeover", async () => {
  await step(); gh.openPr = async () => ({ ok: false, error: "unknown external result" });
  expect((await step()).failed[0]?.error).toContain("unknown external result");
  expect(notes()).toEqual([]); expect(creates + calls).toBe(0);
  gh.openPr = async () => ({ ok: true, value: 77 }); await step();
  expect(notes()[0].data.pr).toBe(77); expect(notes()[0].data.effect).toContain("已查到 PR #77");
  expect(notes()[0].data.effect).not.toContain("代开 PR / 接管未发出");
  expect(creates + calls).toBe(0);
});

test("policy changes resume; spec / head changes have distinct diagnostics and no stale retries", async () => {
  await step(); await step();
  const next = "c".repeat(40); gh.head = async () => ({ ok: true, head: next });
  await step(); await step();
  expect(notes()).toHaveLength(2); expect(notes().at(-1)?.data.head).toBe(next);
  db.run("UPDATE tasks SET specRev=2 WHERE id=?", [taskId]); await step();
  expect(notes()).toHaveLength(2); // Changed specification invalidates the old order.
  db.run("UPDATE tasks SET specRev=1 WHERE id=?", [taskId]);
  gh.head = atHead; await step(); policy("off"); await step();
  expect(creates).toBe(1); expect(calls).toBe(1); expect(notes()).toHaveLength(2);
});

test("unreadable policy and thrown pre-read conservatively block", async () => {
  await step(); writeFileSync(policyPath, "{"); await step();
  expect(notes()[0].data.code).toBe("policy_unreadable"); expect(creates + calls).toBe(0);
  const throwing = () => { throw new Error("read unavailable"); };
  expect((await step(throwing)).failed[0]?.error).toContain("接管预读失败"); expect(creates + calls).toBe(0);
});

test("diagnostic storage retries bounded; changed material is re-read before retry", async () => {
  let attempts = 0;
  const failing = (peer: Parameters<typeof port>[0]): UiDeliverPort => ({ ...port(peer), observe: () => { attempts++; throw new Error("store unavailable"); } });
  await step(failing);
  for (let n = 0; n < 8; n++) await step(failing);
  expect(attempts).toBe(3); expect(creates + calls).toBe(0);
  policy("off"); await step(failing);
  expect(attempts).toBe(3); expect(getTask(db, taskId)?.stage).toBe("review");
});

test("pre-read is no authorization: policy drifts after it and final CLI rejects with zero writes", async () => {
  policy("observe"); expect(uiTakeoverRefusal(db, id, head, port)).toBeNull();
  policy("on"); const before = snapshot();
  expect(await run(["lend-takeover", id, "--head", head, "--pr", "42"], "scheduler")).toMatchObject({ ok: false, code: "invalid" });
  expect(snapshot()).toBe(before);
});

test("ownership and ancestry still prevent creation; no author identity bypass", async () => {
  await step(); gh.compare = async () => ({ ok: true, value: "diverged" }); await step();
  expect(notes()).toEqual([]); expect(creates + calls).toBe(0);
  gh.compare = async () => ({ ok: true, value: "ahead" });
  gh.openPr = async () => { db.run("UPDATE lend_orders SET status='cancelled' WHERE orderId=?", [id]); return { ok: true, value: null }; };
  await step(); expect(notes()).toEqual([]); expect(creates + calls).toBe(0);
  expect(await run(["lend-takeover", id, "--head", head, "--pr", "42"], "agent-writer")).toMatchObject({ ok: false, code: "forbidden" });
});


function allTables(database: Database): string {
  const tables = database.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return JSON.stringify(tables.map(({ name }) => [name, database.query(`SELECT * FROM "${name}"`).all()]));
}

async function realCliFixture() {
  const state = join(dir, "cli-state"), bin = join(dir, "bin");
  mkdirSync(state); mkdirSync(bin);
  const locks: LockHandle[] = [];
  for (const name of ["singleton", "maintenance"]) locks.push((await acquireLock(join(state, name), 0))!);
  const singleton = { path: join(state, "singleton"), token: locks[0].token };
  const maintenance = { path: join(state, "maintenance"), token: locks[1].token };
  const scheduler = (projects = [project]) => writeFileSync(join(state, "scheduler.json"), JSON.stringify({ enabled: true,
    projects: Object.fromEntries(projects.map(p => [p, { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: dir }])) }));
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, `#!${process.execPath}
import { Database } from "bun:sqlite";
import { writeFileSync, readFileSync } from "node:fs";
if (process.argv[2] !== "ls-remote") process.exit(91);
const effect = process.env.UITAKE_EFFECT, state = process.env.CLAUDESTRA_STATE_DIR;
if (effect === "lease") writeFileSync(state + "/singleton/owner", "lost");
if (effect === "project") {
  const cfg = JSON.parse(readFileSync(state + "/scheduler.json", "utf8")); cfg.projects = { other_project: Object.values(cfg.projects)[0] };
  writeFileSync(state + "/scheduler.json", JSON.stringify(cfg));
}
if (["terminal", "rev", "spec", "round", "worker", "order_head", "repo"].includes(effect)) {
  const db = new Database(state + "/ledger.sqlite");
  const sql = { terminal: "UPDATE lend_orders SET status='cancelled'", rev: "UPDATE tasks SET rev=rev+1",
    spec: "UPDATE tasks SET specRev=specRev+1", round: "UPDATE tasks SET round=round+1",
    repo: "UPDATE lend_orders SET repo='other/repo'", worker: "UPDATE lend_orders SET worker='agent-other'", order_head: "UPDATE lend_orders SET head='${"e".repeat(40)}'" };
  db.run(sql[effect]); db.close();
}
if (effect === "mode") {
  writeFileSync(state + "/recovery-policy.json", JSON.stringify({ projects: { ${project}: { keys: { uiDelivery: "off" } } } }));
}
console.log("${head}\trefs/heads/${branch}");
`);
  chmodSync(fakeGit, 0o700);
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: {
    "agent-lead": { projectId: project }, "agent-writer": { projectId: project } } }));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: project, name: "Test", dirs: [dir] }] }));
  writeFileSync(join(state, "recovery-policy.json"), readFileSync(policyPath)); scheduler();
  db.run("UPDATE lend_orders SET leaseUntil=? WHERE orderId=?", [Date.now() + 300_000, id]);
  const path = join(state, "ledger.sqlite"); db.query("VACUUM INTO ?").run(path);
  const copy = openLedger(path), reader = new LedgerReader(path);
  const cli = async (args: string[], options: { actor?: string; effect?: string; noLease?: boolean } = {}) => {
    const actor = options.actor ?? "scheduler";
    const env = testChildEnv({ PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, CLAUDESTRA_STATE_DIR: state,
      UITAKE_EFFECT: options.effect, CLAUDESTRA_SCHEDULER_SERVICE: actor === "scheduler" ? "1" : undefined,
      CLAUDESTRA_SCHEDULER_LEASE: actor === "scheduler" && !options.noLease ? encodeLease({ singleton, maintenance }) : undefined,
      CLAUDESTRA_AGENT: actor.startsWith("agent-") ? actor : undefined,
      DISCORD_CHANNEL_ID: actor === "master" ? "test-master" : undefined, CONTROL_CHANNEL_ID: actor === "master" ? "test-master" : undefined });
    const child = Bun.spawn([process.execPath, resolve("src/manager.ts"), "ledger", ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    expect(err).not.toContain("Unhandled"); return JSON.parse(out) as Record<string, any>;
  };
  const close = () => {
    reader.close(); closeLedger(path);
    for (let i = 0; i < locks.length; i++) {
      // A synthetic stolen token has no real successor; restore it solely to release this fixture's lock cleanly.
      writeFileSync(join(state, ["singleton", "maintenance"][i], "owner"), locks[i].token); locks[i].release();
    }
  };
  return { state, copy, reader, cli, scheduler, snapshot: () => allTables(copy), close };
}

const diagnosticArgs = () => ["lend-takeover-refusal", id, "--head", head, "--pr", "42"];

test("real LedgerReader plus leased manager CLI: blocked UI records once and final takeover refusal is all-table zero-write", async () => {
  const f = await realCliFixture();
  try {
    const before = f.snapshot();
    expect(await f.cli(["lend-takeover", id, "--head", head, "--pr", "42"], { actor: "owner" })).toMatchObject({ ok: false, code: "invalid" });
    expect(f.snapshot()).toBe(before); // Original takeover's PM/owner authority remains intact.
    const drive = () => lendTakeoverStep(f.reader.get()!, { gh, seen, now: Date.now, uiPort: port,
      manager: (...args: string[]) => { if (args[1] === "lend-takeover") calls++; return f.cli(args.slice(1)); } });
    await drive(); expect((await drive()).failed).toHaveLength(1);
    const diagnosed = f.snapshot();
    seen.clear(); f.reader.close(); await drive(); await drive();
    expect(f.snapshot()).toBe(diagnosed); expect(creates + calls).toBe(0);
    expect(listEvents(f.copy, { target: taskId }).filter(e => e.data.preflight === true)).toHaveLength(1);
    expect(f.reader.get()!.query("PRAGMA query_only").get()).toEqual({ query_only: 1 });
  } finally { f.close(); }
}, 15000);



test("diagnostic lock recheck drops a stale policy refusal without creating or delivering", async () => {
  let reads = 0;
  const changing = (peer: Parameters<typeof port>[0]): UiDeliverPort => {
    const p = port(peer);
    return { ...p, mode: () => ({ mode: ++reads === 1 ? "on" : "off" }) };
  };
  await step(changing); expect((await step(changing)).failed).toEqual([]);
  expect(reads).toBe(2); expect(notes()).toEqual([]); expect(creates + calls).toBe(0);
});


test("production query_only scheduler connection records through CLI, never writes its read connection", async () => {
  const reader = new Database(db.filename);
  reader.exec("PRAGMA query_only=ON");
  const deps = { gh, seen, now: () => now, uiPort: port, manager: (...args: string[]) => {
    if (args[1] === "lend-takeover") calls++;
    return run(args.slice(1), "scheduler");
  } };
  try {
    await lendTakeoverStep(reader, deps);
    expect((await lendTakeoverStep(reader, deps)).failed).toHaveLength(1);
    seen.clear(); await lendTakeoverStep(reader, deps); await lendTakeoverStep(reader, deps);
    expect(notes()).toHaveLength(1); expect(creates + calls).toBe(0);
    expect(reader.query("PRAGMA query_only").get()).toEqual({ query_only: 1 });
    expect(await run(["lend-takeover-refusal", id, "--head", head], "agent-writer")).toMatchObject({ ok: false, code: "forbidden" });
  } finally { reader.close(); }
});


test("diagnostic CLI independently refuses obsolete remote head without a stale note", async () => {
  const newHead = "d".repeat(40);
  let reads = 0;
  gh.head = async () => ({ ok: true, head: ++reads <= 2 ? head : newHead });
  await step(); await step();
  expect(notes()).toEqual([]); expect(creates + calls).toBe(0);
});

for (const actor of ["agent-lead", "master", "owner", "agent-writer"]) test(`ui-takeover-diag-pm-identity: ${actor} forbidden with all-table zero writes`, async () => {
  const before = snapshot();
  expect(await run(["lend-takeover-refusal", id, "--head", head], actor)).toMatchObject({ ok: false, code: "forbidden" });
  expect(snapshot()).toBe(before);
});

test("ui-takeover-diag-retry-drop-reason: exhausted budget keeps original refusal and stops CLI retries", async () => {
  let tries = 0;
  const failing = (peer: Parameters<typeof port>[0]): UiDeliverPort => ({ ...port(peer), observe: () => { tries++; throw new Error("write unavailable"); } });
  await step(failing);
  for (let n = 0; n < 3; n++) await step(failing);
  const exhausted = await step(failing);
  expect(tries).toBe(3);
  expect(exhausted.failed[0]?.error).toContain("ui 卡交付的截图证据不合格（missing）");
  expect(exhausted.failed[0]?.error).toContain("停止重试");
  expect(creates + calls).toBe(0);
});

for (const actor of ["agent-lead", "master", "owner", "agent-writer"]) test(`real CLI identity: ${actor} forbidden and every table unchanged`, async () => {
  const f = await realCliFixture();
  try {
    const before = f.snapshot();
    expect(await f.cli(diagnosticArgs(), { actor })).toMatchObject({ ok: false, code: "forbidden" });
    expect(f.snapshot()).toBe(before);
  } finally { f.close(); }
}, 15000);

for (const scenario of ["cross-project", "missing-lease", "lost-lease", "terminal", "bad-head", "base-head"]) {
  test(`real CLI direct refusal: ${scenario} has all-table zero writes`, async () => {
    const f = await realCliFixture();
    try {
      if (scenario === "cross-project") f.scheduler(["other-project"]);
      if (scenario === "lost-lease") writeFileSync(join(f.state, "singleton", "owner"), "lost");
      if (scenario === "terminal") f.copy.run("UPDATE lend_orders SET status='done' WHERE orderId=?", [id]);
      const args = diagnosticArgs();
      if (scenario === "bad-head") args[3] = "not-a-sha";
      if (scenario === "base-head") args[3] = base;
      const before = f.snapshot();
      const r = await f.cli(args, { noLease: scenario === "missing-lease" });
      expect(r.ok).toBe(false);
      expect(r.code).toBe(scenario === "cross-project" ? "forbidden" : scenario.includes("lease") ? "lease-lost"
        : scenario === "terminal" ? "conflict" : "invalid");
      expect(f.snapshot()).toBe(before);
    } finally { f.close(); }
  }, 15000);
}

for (const flag of ["text", "action", "dedup", "project", "pm"]) test(`real CLI rejects ${flag} injection with all-table zero writes`, async () => {
  const f = await realCliFixture();
  try {
    const before = f.snapshot();
    expect(await f.cli([...diagnosticArgs(), `--${flag}`, "malicious"])).toMatchObject({ ok: false, code: "invalid" });
    expect(f.snapshot()).toBe(before);
  } finally { f.close(); }
}, 15000);

for (const effect of ["lease", "project", "terminal", "rev", "spec", "round", "worker", "order_head", "repo", "mode"]) {
  test(`real CLI rereads ${effect} after remote await and writes no stale diagnostic`, async () => {
    const f = await realCliFixture();
    try {
      // Account for only the external fixture mutation; the CLI must add no writes of its own.
      if (effect === "terminal") f.copy.run("UPDATE lend_orders SET status='cancelled'");
      if (effect === "rev") f.copy.run("UPDATE tasks SET rev=rev+1");
      if (effect === "spec") f.copy.run("UPDATE tasks SET specRev=specRev+1");
      if (effect === "round") f.copy.run("UPDATE tasks SET round=round+1");
      if (effect === "worker") f.copy.run("UPDATE lend_orders SET worker='agent-other'");
      if (effect === "order_head") f.copy.run("UPDATE lend_orders SET head=?", ["e".repeat(40)]);
      if (effect === "repo") f.copy.run("UPDATE lend_orders SET repo='other/repo'");
      const expected = f.snapshot();
      if (effect === "terminal") f.copy.run("UPDATE lend_orders SET status='claimed'");
      if (effect === "rev") f.copy.run("UPDATE tasks SET rev=rev-1");
      if (effect === "spec") f.copy.run("UPDATE tasks SET specRev=specRev-1");
      if (effect === "round") f.copy.run("UPDATE tasks SET round=round-1");
      if (effect === "worker") f.copy.run("UPDATE lend_orders SET worker='agent-testworker'");
      if (effect === "order_head") f.copy.run("UPDATE lend_orders SET head=?", [base]);
      if (effect === "repo") f.copy.run("UPDATE lend_orders SET repo='example/test'");
      const r = await f.cli(diagnosticArgs(), { effect });
      expect(r.ok).toBe(false);
      expect(r.code).toBe(effect === "lease" ? "lease-lost" : effect === "project" ? "forbidden" : "conflict");
      expect(f.snapshot()).toBe(expected);
    } finally { f.close(); }
  }, 15000);
}

test("transaction's final prewrite lease check refuses with every table unchanged", async () => {
  let checks = 0;
  const before = snapshot();
  const r = await runLedger(diagnosticArgs(), { db, actor: "scheduler", projectIds: [project], autoProjects: () => [project], now: () => now,
    loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {},
    assertLease: () => { if (++checks === 4) throw new SchedulerLeaseLost("lost at final prewrite"); } });
  expect(checks).toBe(4); expect(r).toMatchObject({ ok: false, code: "lease-lost" }); expect(snapshot()).toBe(before);
});

for (const throws of [false, true]) test(`actual stop is propagated (${throws ? "thrown stop" : "lease-lost response"}) with no diagnostic or PR`, async () => {
  const before = snapshot();
  const deps = { gh, seen, now: () => now, uiPort: port, manager: async () => {
    if (throws) throw new SchedulerStopped("stopped");
    return { ok: false, code: "lease-lost", error: "lost" };
  } };
  await lendTakeoverStep(db, deps);
  await expect(lendTakeoverStep(db, deps)).rejects.toBeInstanceOf(throws ? SchedulerStopped : SchedulerLeaseLost);
  expect(snapshot()).toBe(before); expect(creates + calls).toBe(0);
});


test("real CLI rejects positional body injection without touching any table", async () => {
  const f = await realCliFixture();
  try {
    const before = f.snapshot();
    expect(await f.cli([...diagnosticArgs(), "injected body"])).toMatchObject({ ok: false, code: "invalid" });
    expect(f.snapshot()).toBe(before);
  } finally { f.close(); }
}, 15000);

for (const existing of [false, true]) test(`retry cap preserves known PR facts (${existing ? "existing" : "not excluded"}) and makes no fourth diagnostic call`, async () => {
  let diagnosticCalls = 0;
  if (existing) gh.openPr = async () => ({ ok: true, value: 77 });
  const deps = { gh, seen, now: () => now, uiPort: port, manager: async () => {
    diagnosticCalls++; return { ok: false, code: "busy", error: "storage busy" };
  } };
  await lendTakeoverStep(db, deps);
  for (let n = 0; n < 3; n++) await lendTakeoverStep(db, deps);
  const before = snapshot(), exhausted = await lendTakeoverStep(db, deps);
  expect(exhausted.failed[0].error).toContain("停止重试");
  expect(exhausted.failed[0].error).toContain(existing ? "已查到 PR #77" : "既有外部效果未排除");
  expect(diagnosticCalls).toBe(3); expect(creates + calls).toBe(0); expect(snapshot()).toBe(before);
});

test("writer transaction rechecks a changed actor before even replaying a diagnostic", async () => {
  const deps = { db, actor: "scheduler", projectIds: [project], autoProjects: () => [project], assertLease: () => {}, now: () => now,
    loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} };
  takeoverDeps.make = () => ({ uiPort: port, remoteHead: async () => { deps.actor = "owner"; return atHead(); } });
  const before = snapshot();
  expect(await runLedger(diagnosticArgs(), deps)).toMatchObject({ ok: false, code: "forbidden" });
  expect(snapshot()).toBe(before);
});
