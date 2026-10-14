import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoFixture, H1 } from "./scheduler-auto-helpers.js";
import { createTask } from "../src/lib/ledger-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { holdWriteLease } from "../src/lib/ledger-lend-lease.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { lendAuthorBasis, lendAuthorFence } from "../src/lib/lend-author-retire-proof.js";
import { LEND_AUTHOR_CLI_PORTS } from "../src/lib/lend-author-retire-cmds.js";
import { retireAfterLeaseEnd, retireLendAuthor } from "../src/lib/lend-author-retire-write.js";
import { lendAuthorBudget, prepareLendAuthor } from "../src/lib/lend-author-retire-tick.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { schedulerPass } from "../src/lib/scheduler-pass.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import type { LocalAuthorEnv } from "../src/lib/scheduler-local-author.js";
import type { ReadLendHead } from "../src/lib/lend-author-retire-read.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function fixture(mode: RecoveryMode = "on") {
  const f = autoFixture(); cleanup.push(f.close);
  const previous = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : undefined;
  cleanup.push(() => previous ? writeFileSync(RECOVERY_POLICY_PATH, previous) : unlinkSync(RECOVERY_POLICY_PATH));
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { lendAuthorRebuild: mode } } } }));
  f.db.run("INSERT INTO meta(project,key,value) VALUES ('p','team',?)", [JSON.stringify({ dispatcher: "dispatch", sinceSeq: 1 })]);
  f.db.run("UPDATE meta SET value='[\"pm\",\"dispatch\"]' WHERE project='p' AND key='pms'");
  const add = (id: string) => {
    if (id !== "T1") {
      createTask(f.db, { actor: "owner" }, { project: "p", id, title: id, kind: "code" });
      setWorkflow(f.db, { actor: "owner" }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2,
        mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
    }
    f.db.run("UPDATE tasks SET stage='fix', headSHA=?, branch=?, agent='remote@mate' WHERE id=?", [H1, `lend/${id}-abcd`, id]);
    f.db.run(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
      VALUES (?,?,'p','fix','ensure_session',1,1,1,1,?,2,'done','seed',1,1)`, [`old-${id}`, id, H1]);
    f.db.run(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
      VALUES (?,'author','remote@mate',?,'claude','peer','active',?,1,1)`, [id, `peer-${id}`, `old-${id}`]);
    f.db.run(`INSERT INTO lend_orders(orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,worker,
      leaseGen,leaseMs,createdBy,createdAt,updatedAt,branch) VALUES (?,?,'p','mate','claude','fix',1,0,?,'example/repo','{}','','',
      'cancelled','remote',1,1000,'pm',1,1,?)`, [`O-${id}`, id, H1, `lend/${id}-abcd`]);
    holdWriteLease(f.db, getTask(f.db, id)!, { peer: "mate", fp: "abcd-ef01-2345-6789", repo: "example/repo", branch: `lend/${id}-abcd` }, 1);
    f.db.run("UPDATE lend_write_leases SET state='ended' WHERE taskId=?", [id]);
  };
  add("T1");
  const sample = (id = "T1") => ({ ...lendAuthorFence(getTask(f.db, id)!, getSchedulerSession(f.db, id, "author")!),
    basis: lendAuthorBasis(f.db, id), heads: [{ repo: "example/repo", branch: `lend/${id}-abcd`, head: H1 }] });
  const blocked = () => listEvents(f.db, { target: "T1" }).filter(e => e.data.op === "lend_author_blocked");
  const env: LocalAuthorEnv = { db: f.reader.get()!, registryRow: () => undefined, worktreeRoot: f.dir,
    active: () => {}, git: async () => ({ code: 0, out: "" }), create: async () => ({ ok: false }),
    ledger: (...args) => f.cli("scheduler", ...args.slice(1)) };
  return { ...f, add, sample, blocked, env };
}

test.each(["off", "observe", "on"] as const)("%s: dispatcher reclaim commits; forbidden retirement is deduplicated", async mode => {
  const f = fixture(mode);
  for (let n = 0; n < 2; n++) {
    f.db.run("UPDATE lend_write_leases SET state='held'"); f.db.run("UPDATE lend_orders SET status='claimed'");
    expect(await f.cliWith({ lend: lendDeps(async () => ({ ok: true, head: H1 })) }, "dispatch",
      "lend-reclaim", "T1", "--reason", "test")).toMatchObject({ ok: true });
    expect(f.db.query("SELECT state FROM lend_write_leases").get()).toEqual({ state: "ended" });
    expect(f.db.query("SELECT status FROM lend_orders").get()).toEqual({ status: "cancelled" });
  }
  expect(getSchedulerSession(f.db, "T1", "author")?.state).toBe("active");
  expect(f.blocked()).toHaveLength(mode === "off" ? 0 : 1);
  if (mode !== "off") expect(f.blocked()[0]?.text).toContain("身份不符");
  expect(listEvents(f.db, { target: "T1" }).filter(e => e.data.op === "lend_author_retire")).toHaveLength(0);
  expect(listEvents(f.db, { target: "T1" }).filter(e => (e.data.lend as { op?: string })?.op === "reclaim")).toHaveLength(2);
  expect(() => retireLendAuthor(f.db, { actor: "dispatch" }, f.sample(), LEND_AUTHOR_CLI_PORTS)).toThrow("PM");
});

test("lease-end off bypasses identity; on refuses without throwing even without a sample", () => {
  const f = fixture(), before = f.task();
  const ports = { ...LEND_AUTHOR_CLI_PORTS, policy: () => ({ mode: "off" as const, manualAfterMs: null, source: "default" as const }),
    manager: () => { throw new Error("identity must not be checked"); } };
  expect(() => retireAfterLeaseEnd(f.db, { actor: "intruder" }, before, false, lendAuthorBasis(f.db, "T1"), ports)).not.toThrow();
  expect(retireAfterLeaseEnd(f.db, { actor: "dispatch" }, before, false, lendAuthorBasis(f.db, "T1"), LEND_AUTHOR_CLI_PORTS))
    .toMatchObject({ ok: false, reason: "forbidden" });
  expect(f.blocked()).toHaveLength(1);
});

test.each([false, true])("authorized reclaim still retires atomically, including database failure=%s", async fail => {
  const f = fixture();
  f.db.run("UPDATE lend_write_leases SET state='held'"); f.db.run("UPDATE lend_orders SET status='claimed'");
  if (fail) f.db.run("CREATE TRIGGER fail_retire BEFORE UPDATE ON scheduler_sessions WHEN NEW.state='retired' BEGIN SELECT RAISE(ABORT,'retire failure'); END");
  const result = await f.cliWith({ lend: lendDeps(async () => ({ ok: true, head: H1 })) }, "owner", "lend-reclaim", "T1", "--reason", "test");
  expect(result.ok).toBe(!fail);
  expect(f.db.query("SELECT state FROM lend_write_leases").get()).toEqual({ state: fail ? "held" : "ended" });
  expect(f.db.query("SELECT status FROM lend_orders").get()).toEqual({ status: fail ? "claimed" : "cancelled" });
  expect(getSchedulerSession(f.db, "T1", "author")?.state).toBe(fail ? "active" : "retired");
});

test("observe: writer and readonly tick use identical blocked notes and dedup keys", async () => {
  const f = fixture("observe"); f.db.run("UPDATE lend_orders SET status='unknown'");
  retireLendAuthor(f.db, { actor: "scheduler" }, f.sample(), LEND_AUTHOR_CLI_PORTS);
  const writer = f.blocked()[0]!;
  const tick = fixture("observe"); tick.db.run("UPDATE lend_orders SET status='unknown'");
  await prepareLendAuthor(tick.env, tick.task()); await prepareLendAuthor(tick.env, tick.task());
  expect(tick.blocked()).toHaveLength(1);
  expect(tick.blocked()[0]).toMatchObject({ data: writer.data, text: writer.text, dedupKey: writer.dedupKey });
});

function lendDeps(remoteHead: ReadLendHead) {
  return { borrow: async () => [], notifyPm: async () => {},
    result: { remoteHead, reportDir: () => "unused", writeReport: () => {}, sign: () => ({ key: "unused", sig: "unused" }) } };
}

function stale(f: ReturnType<typeof fixture>) {
  f.db.run(`INSERT INTO lend_orders(orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,
    leaseGen,leaseMs,createdBy,createdAt,updatedAt,branch) VALUES ('STALE','T1','p','mate','claude','fix',1,0,?,'example/repo',
    '{}','','','pooled',0,1000,'pm',1,1,'lend/T1-abcd')`, [H1]);
  f.db.run("UPDATE lend_write_leases SET state='held'");
  f.advance(60 * 60_000);
}

test.each(["poll", "sweep"])("bridge %s never calls stalled remote reader; only reclaims and leaves no blocked note", async route => {
  const f = fixture(); stale(f); let reads = 0;
  const lend = lendDeps(() => { reads++; return new Promise(() => {}); });
  const args = route === "sweep" ? ["lend-sweep"] : ["lend-poll", "--", "mate", JSON.stringify({ v: 1,
    capacity: { families: { claude: 1 }, busy: {}, roles: ["write"], repos: ["example/repo"], ordersLeftToday: 3 } })];
  const began = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([f.cliWith({ lend }, "owner", ...args), new Promise(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), 900);
  })]);
  clearTimeout(timer);
  expect(reads).toBe(0); expect(result).toMatchObject({ ok: true });
  expect(performance.now() - began).toBeLessThan(1000);
  expect(f.db.query("SELECT state FROM lend_write_leases").get()).toEqual({ state: "ended" });
  expect(getSchedulerSession(f.db, "T1", "author")?.state).toBe("active"); expect(f.blocked()).toHaveLength(0);
});

test("real auto tick reads only two candidates and leaves the third auto for the next tick", async () => {
  const f = fixture(); f.add("T2"); f.add("T3");
  const reads: string[] = [];
  const prod = autoTickDeps(f.reader.get()!, { registryPath: f.registryPath,
    lendAuthor: { readHead: async (_repo, branch) => { reads.push(branch); return { ok: true, head: H1 }; } } });
  // The production preflight runs; the unleased writer child refuses here, so no local process can be started by this unit fixture.
  const deps = { ...f.tickDeps, prepareAuthor: prod.prepareAuthor };
  const result = await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, deps);
  expect(reads).toHaveLength(2);
  expect(result.cards).toContainEqual({ taskId: "T3", step: "held", detail: expect.stringContaining("下一轮") });
  expect(getWorkflow(f.db, "T3")?.mode).toBe("auto");
  expect(getSchedulerSession(f.db, "T3", "author")?.state).toBe("active");
  expect(listEvents(f.db, { target: "T3" }).some(e => e.data.op === "lend_author_blocked")).toBe(false);
  await schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, deps);
  expect(reads).toHaveLength(3);
  expect(reads.at(-1)).toBe("lend/T3-abcd");
});

test("scheduler pass preserves the lend author preflight on its readonly connection", async () => {
  const f = fixture("observe"); f.db.run("UPDATE lend_orders SET status='unknown'");
  const result = await schedulerPass(f.env.db, parseSchedulerConfig({ enabled: true, autoDispatch: true,
    projects: { p: { maxActiveWorkers: 2, repoDir: f.dir, requiredChecks: ["ci"], mergeHandoff: true } } }), {
    assertOwner: () => {}, manager: f.tickDeps.manager,
    autoDeps: () => ({ ...f.tickDeps, prepareAuthor: task => prepareLendAuthor(f.env, task) }),
    maintenance: { path: join(f.dir, "lock"), marker: join(f.dir, "marker"), request: join(f.dir, "request") },
    peerPr: async () => ({ failed: [] }), autostart: () => ({ resume: async () => [], start: async () => [] }),
    retire: async () => [], lifecycle: async () => [], lockYield: async () => [],
    recoveryPolicy: () => ({ mode: "off", manualAfterMs: null, source: "default" }), log: () => {},
  });
  expect(result).toMatchObject({ ran: true, failed: [] });
  expect(f.blocked()).toHaveLength(1);
});

test("a stalled second read uses the remaining aggregate deadline; deferred cards get no proof note", async () => {
  const f = fixture(); f.add("T2"); f.add("T3");
  const budget = lendAuthorBudget(); expect(budget.remainingMs).toBe(20_000);
  budget.remainingMs = 80; // Exercise the production deadline with a short remaining allowance.
  let reads = 0;
  const deps = { readHead: async () => {
    if (++reads === 1) { await Bun.sleep(45); return { ok: true as const, head: H1 }; }
    return new Promise<never>(() => {});
  } };
  const began = performance.now();
  await prepareLendAuthor(f.env, f.task(), deps, budget);
  await prepareLendAuthor(f.env, getTask(f.db, "T2")!, deps, budget);
  expect(await prepareLendAuthor(f.env, getTask(f.db, "T3")!, deps, budget)).toMatchObject({ deferred: true });
  expect(performance.now() - began).toBeLessThan(500);
  expect(reads).toBe(2);
  expect(listEvents(f.db, { target: "T3" }).some(e => e.data.op === "lend_author_blocked")).toBe(false);
});
