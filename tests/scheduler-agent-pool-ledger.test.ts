import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localAgentPool } from "../src/lib/scheduler-agent-pool-ledger.js";
import { poolAuthorRuntime } from "../src/lib/scheduler-agent-pool-runtime.js";
import { withCodexSlot } from "../src/lib/scheduler-local-runtime-slots.js";
import { unknownQuota } from "../src/lib/ai-quota.js";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import { autoFixture, H1 } from "./scheduler-auto-helpers.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { poolFacts } from "../src/lib/scheduler-pool-facts.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";

const limits = { claude: 0, codex: 5 };
const remote: RemotePolicy = { agents: limits, mode: "balance", roles: [], poolTimeoutMin: 15 };

function bound(db: ReturnType<typeof openLedger>, id: string, stage: string, family = "codex", role = "author") {
  db.query(`INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt) VALUES (?, 'p', ?, 'code', ?, ?, 0, 0)`)
    .run(id, id, stage, id);
  db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, 'acp', 'active', 'i', 0, 0)`).run(id, role, id, `s-${id}`, family);
}

test("sessions alone count: manual authors, idle authors, retired bindings and peer transports do not take local seats", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cap1-count-")), ledgerPath = join(dir, "ledger.sqlite"), db = openLedger(ledgerPath);
  db.run("PRAGMA foreign_keys=OFF");
  const registryPath = join(dir, "registry.json"), configPath = join(dir, "scheduler.json"), lockPath = join(dir, "lock");
  const agents: Record<string, object> = {};
  try {
    for (let i = 0; i < 3; i++) {
      db.query(`INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt) VALUES (?, 'p', 'manual', 'code', 'build', ?, 0, 0)`)
        .run(`manual${i}`, `manual${i}`);
      agents[`manual${i}`] = { runtime: "codex", status: "active" };
    }
    bound(db, "waiting", "review"); bound(db, "idle", "merge"); bound(db, "peer", "build");
    db.query("UPDATE scheduler_sessions SET transport='peer' WHERE agent='peer'").run();
    bound(db, "retired", "build"); db.query("UPDATE scheduler_sessions SET state='retired' WHERE agent='retired'").run();
    writeFileSync(registryPath, JSON.stringify({ agents }));
    writeFileSync(configPath, JSON.stringify({ enabled: true, projects: { p: { agents: limits, requiredChecks: ["ci"], repoDir: dir } } }));
    expect(localAgentPool(db, "p", limits).running).toEqual({ claude: 0, codex: 0 });
    const opts = { project: "p", family: "codex" as const, ledgerPath, registryPath, configPath, lockPath, codexQuota: async () => unknownQuota("test") };
    for (let i = 0; i < 5; i++) {
      expect(await withCodexSlot(async () => { bound(db, `worker${i}`, "build"); return "created"; }, opts)).toBe("created");
    }
    expect(localAgentPool(db, "p", limits).running.codex).toBe(5);
    expect(await withCodexSlot(async () => "overflow", opts)).toMatchObject({ kind: "wait", reason: "等 codex 空位" });
    db.query("UPDATE tasks SET stage='review' WHERE id='worker4'").run();
    bound(db, "reviewer", "review", "codex", "reviewer");
    expect(await withCodexSlot(async () => "overflow", opts)).toMatchObject({ kind: "wait" });
    expect(poolAuthorRuntime("p", limits, ledgerPath)).toBe("codex");
  } finally { closeLedger(ledgerPath); rmSync(dir, { recursive: true, force: true }); }
});

test("planner with local Claude zero dispatches across model to peer without roles, or waits; security stays local", () => {
  const f = autoFixture();
  try {
    f.db.query("UPDATE tasks SET stage='review', headSHA=?, pr='https://github.com/o/r/pull/7' WHERE id='T1'").run(H1);
    f.db.query("UPDATE task_workflows SET authorFamily='codex' WHERE taskId='T1'").run();
    const options = { registry: [], maxWorkers: 1, pool: { remote, borrow: [] } };
    const s = autoSnapshot(f.db, f.task(), options);
    expect(planScheduler(s)).toMatchObject({ kind: "wait", reason: "等 claude 空位" });
    s.pool!.peers = [{ peer: "mate", roles: [], priority: "off", open: 99, maxOpen: 1,
      v2: { why: null, roles: [], repos: ["o/r"], slots: { claude: 1, codex: 0 }, familyTotals: { claude: 1, codex: 0 } } }];
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "review", recipient: "peer:mate" });
    s.workflow!.template = "security";
    expect(planScheduler(s)).toMatchObject({ kind: "wait", reason: "等 claude 空位" });
  } finally { f.close(); }
});

test("same tick gives last Codex seat to review before a lexically earlier new build", async () => {
  const f = autoFixture();
  try {
    await f.tick(); // bind Claude author while still using legacy policy
    f.db.run("PRAGMA foreign_keys=OFF");
    for (let i = 0; i < 4; i++) bound(f.db, `busy${i}`, "build");
    f.db.query("UPDATE tasks SET stage='review', headSHA=? WHERE id='T1'").run(H1);
    f.db.query(`INSERT INTO tasks (id, project, title, kind, stage, agent, extra, createdAt, updatedAt)
      VALUES ('A-new', 'p', 'new', 'code', 'build', 'new', '{"fileGlobs":["src/lib/new.ts"]}', 0, 0)`).run();
    f.db.query(`INSERT INTO task_workflows SELECT 'A-new', project, template, templateVersion, mode, 'codex', fallback, specRev, rev, createdAt, updatedAt
      FROM task_workflows WHERE taskId='T1'`).run();
    f.db.query(`INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (0,'owner','p','A-new','task','','{"op":"new"}')`).run();
    const deps = { ...f.tickDeps, borrow: async () => [] };
    const result = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 5, remote } }, deps);
    expect(result.failed).toEqual([]);
    expect(result.cards[0]).toMatchObject({ taskId: "T1", step: "session" });
    expect(result.cards.find((r) => r.taskId === "A-new")).toMatchObject({ step: "waiting", detail: expect.stringContaining("codex 空位") });
    expect(localAgentPool(f.db, "p", limits).running.codex).toBe(5);
  } finally { f.close(); }
});

test("hello totals and live family orders replace maxOpen, and cooldown/expiry still zero capacity", () => {
  const f = autoFixture();
  try {
    const now = f.tickDeps.now();
    recordHello(f.db, "mate", null, { v: 1, proto: 2, boot: "b", seq: 1, paused: null,
      slots: { claude: { total: 5, busy: 1 }, codex: { total: 5, busy: 0 } },
      grant: { until: now + 10000, repos: ["o/r"], roles: [], ordersPerDay: 50, ordersLeftToday: 50 } }, now);
    const borrow = [{ peer: "mate", projects: ["p"], maxOpen: 0, roles: [], priority: "off" as const }];
    expect(poolFacts(f.db, f.task(), { remote, borrow, now }).peers[0]!.v2!.slots.claude).toBe(4);
    f.db.query("INSERT INTO lend_peer_cooldowns (peer, family, until, reason, startedAt) VALUES ('mate','claude',?,'quota',?)").run(now + 5000, now);
    expect(poolFacts(f.db, f.task(), { remote, borrow, now }).peers[0]!.v2!.slots.claude).toBe(0);
    expect(poolFacts(f.db, f.task(), { remote, borrow, now: now + 20000 }).peers[0]!.v2!.why).toContain("到期");
  } finally { f.close(); }
});

test("real pool CLI offers and claims a Claude review despite legacy borrow role/maxOpen limits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cap1-cli-"));
  const script = `
    import { autoFixture, H1 } from './tests/scheduler-auto-helpers.ts';
    import { recordHello } from './src/lib/ledger-lend-peers.ts';
    import { listLendOrders } from './src/lib/ledger-lend.ts';
    import { schedulerAutoTick } from './src/lib/scheduler-auto-tick.ts';
    import { writeFileSync } from 'node:fs';
    import { statePath } from './src/lib/paths.ts';
    const f = autoFixture();
    try {
      const remote = { mode:'balance', roles:[], poolTimeoutMin:15, agents:{claude:0,codex:5} };
      writeFileSync(statePath('scheduler.json'), JSON.stringify({enabled:true, projects:{p:{agents:remote.agents,requiredChecks:['ci'],repoDir:f.dir}}}));
      const spec = f.dir + '/spec.md'; writeFileSync(spec, 'Review src/lib/x.ts');
      f.db.query("UPDATE tasks SET stage='review', headSHA=?, pr='https://github.com/o/r/pull/7', spec=? WHERE id='T1'").run(H1,spec);
      f.db.query("UPDATE task_workflows SET authorFamily='codex' WHERE taskId='T1'").run();
      const borrow = [{peer:'mate', projects:['p'], roles:['write'], priority:'off', maxOpen:0}];
      recordHello(f.db, 'mate', null, {v:1,proto:2,boot:'b',seq:1,paused:null,
        slots:{claude:{total:5,busy:0},codex:{total:5,busy:0}},
        grant:{until:Date.now()+100000,roles:['write'],repos:['o/r'],ordersPerDay:50,ordersLeftToday:50}}, f.tickDeps.now());
      const lend = {borrow:async()=>borrow, notifyPm:async()=>{}, schedulerPolicy:()=>({remote,maxActiveWorkers:5})};
      const cli = (actor,...args)=>f.cliWith({lend},actor,...args);
      const deps = {...f.tickDeps, borrow:async()=>borrow, manager:(...args)=>cli('scheduler',...args.slice(1))};
      const tick = await schedulerAutoTick(f.db,{p:{remote,maxActiveWorkers:5}},deps);
      const order = listLendOrders(f.db,'T1')[0];
      const claim = order && await cli('owner','lend-claim','--','mate',JSON.stringify({v:1,orderId:order.orderId,worker:'worker'}));
      console.log(JSON.stringify({tick, order:order && {family:order.family,status:order.status}, claim}));
    } finally {f.close();}
  `;
  try {
    const child = Bun.spawn([process.execPath, "--eval", script], { cwd: process.cwd(),
      env: { ...process.env, CLAUDESTRA_STATE_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status, err).toBe(0);
    const result = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(result.tick.failed).toEqual([]);
    expect(result.tick.cards[0]).toMatchObject({ step: "pool_pooled" });
    expect(result.order).toEqual({ family: "claude", status: "pooled" });
    expect(result.claim).toMatchObject({ ok: true, lease: { gen: 1 }, order: { step: "review" } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);
