import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoFixture, toBuild, P1 } from "./scheduler-auto-helpers.js";
import { testChildEnv } from "./test-env.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { holdWriteLease } from "../src/lib/ledger-lend-lease.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { readSchedulerConfig } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { lendAuthorBranchGate } from "../src/lib/lend-author-retire-checkout.js";
import { RECOVERY_KEYS } from "../src/lib/recovery-keys.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { currentOrders } from "../src/lib/order-take.js";

const cleanup: (() => void)[] = [];
const savedState = process.env.CLAUDESTRA_STATE_DIR, savedRuntime = process.env.CLAUDESTRA_RUNTIME_DIR;
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c();
  process.env.CLAUDESTRA_STATE_DIR = savedState; process.env.CLAUDESTRA_RUNTIME_DIR = savedRuntime;
});

async function repository(root: string) {
  const repo = join(root, "repo"), bare = join(root, "origin.git"); mkdirSync(repo); mkdirSync(bare);
  const run = async (dir: string, ...args: string[]) => {
    const r = await git(["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args]);
    if (r.code !== 0) throw new Error(r.out); return r.out.trim();
  };
  await run(bare, "init", "-q", "--bare", "-b", "main"); await run(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "x.ts"), "one\n"); await run(repo, "add", "."); await run(repo, "commit", "-qm", "seed");
  await run(repo, "remote", "add", "origin", bare); await run(repo, "branch", "lend/T1-abcd");
  await run(repo, "push", "-q", "origin", "main", "lend/T1-abcd");
  return { repo, bare, run, head: await run(repo, "rev-parse", "HEAD") };
}

async function fixture(mode: "on" | "observe" | "off" = "on") {
  const f = autoFixture(); cleanup.push(f.close);
  const r = await repository(f.dir), configPath = join(f.dir, "scheduler.json"), projectsPath = join(f.dir, "projects.json");
  const runtime = join(f.dir, "run"); mkdirSync(runtime);
  process.env.CLAUDESTRA_STATE_DIR = f.dir; process.env.CLAUDESTRA_RUNTIME_DIR = runtime;
  writeFileSync(configPath, JSON.stringify({ enabled: true, autoDispatch: true, projects: { p: {
    maxActiveWorkers: 2, repoDir: r.repo, localAuthorRuntime: "claude", requiredChecks: ["ci"] } } }));
  writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "p", dirs: [r.repo] }] }));
  const modeFile = () => writeFileSync(join(f.dir, "recovery-policy.json"), JSON.stringify({ projects: { p: { keys: { lendAuthorRebuild: mode } } } }));
  modeFile();
  const spec = join(f.dir, "T1.md"); writeFileSync(spec, "# T1\n模板：code\n验收：x\n");
  f.db.run("UPDATE tasks SET spec=?, branch='lend/T1-abcd' WHERE id='T1'", [spec]);
  await toBuild(f); await f.tick();
  expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", r.head)).toMatchObject({ ok: true });
  await f.tick(); await f.tick();
  expect(await f.review("changes", r.head, [P1])).toMatchObject({ ok: true });
  await f.tick();
  f.db.run("UPDATE scheduler_sessions SET agent='remote@mate', sessionId='peer-s', transport='peer' WHERE taskId='T1' AND role='author'");
  f.db.run("UPDATE tasks SET agent='remote@mate', assigneeKind='agent', assignee='remote@mate' WHERE id='T1'");
  f.db.run(`INSERT INTO lend_orders (orderId,taskId,project,peer,family,step,specRev,round,head,repo,wire,text,sha256,status,worker,
    leaseGen,leaseMs,createdBy,createdAt,updatedAt,branch) VALUES ('O','T1','p','mate','claude','fix',1,1,?,'example/repo','{}','','',
    'cancelled','remote',1,1000,'pm',1,1,'lend/T1-abcd')`, [r.head]);
  holdWriteLease(f.db, f.task(), { peer: "mate", fp: "abcd-ef01-2345-6789", repo: "example/repo", branch: "lend/T1-abcd" }, 1);
  f.db.run("UPDATE lend_write_leases SET state='ended' WHERE taskId='T1'");
  const single = await acquireLock(join(f.dir, "single.lock")), maintain = await acquireLock(join(f.dir, "maintain.lock"));
  if (!single || !maintain) throw new Error("locks unavailable"); cleanup.push(() => { single.release(); maintain.release(); });
  const lease = { singleton: { path: join(f.dir, "single.lock"), token: single.token },
    maintenance: { path: join(f.dir, "maintain.lock"), token: maintain.token } };
  const env = testChildEnv({ HOME: f.dir, CLAUDESTRA_STATE_DIR: f.dir, CLAUDESTRA_RUNTIME_DIR: runtime });
  const cliEnv: Record<string, string> = {};
  const cli = async (scheduler: boolean, ...args: string[]) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/manager.ts"), "ledger", ...args],
      { stdout: "pipe", stderr: "pipe", env: { ...env, ...cliEnv, ...(scheduler ? {
        CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease(lease) } : {}) } });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    const last = out.trim().split("\n").at(-1); if (!last) throw new Error(err); return JSON.parse(last) as Record<string, unknown>;
  };
  const creates: string[][] = [], sent: string[] = []; let reads = 0, clock = Date.now();
  let readHead: () => Promise<RemoteHead> = async () => ({ ok: true, head: r.head });
  const opts = { registryPath: f.registryPath, configPath, projectsPath, lockPath: join(f.dir, "slots.lock") };
  const prod = autoTickDeps(f.reader.get()!, { registryPath: f.registryPath, worktreeRoot: join(f.dir, "wt"), lease,
    lendAuthor: { start: opts, timeoutMs: 20, now: () => clock, policy: () => ({ mode, manualAfterMs: null, source: "default" }),
      readHead: async () => { reads++; return readHead(); } },
    create: async (...args) => {
      creates.push(args); const name = `agent-${args[1]}`, reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
      reg.agents[name] = { cwd: args[2], projectId: "p", sessionId: "local-s", runtime: "claude-code", kind: "worker", status: "active" };
      writeFileSync(f.registryPath, JSON.stringify(reg)); return { ok: true };
    }, notifyPm: async () => {} });
  const deps = { ...prod, borrow: async () => [], manager: (...args: string[]) => cli(true, ...args.slice(1)),
    worker: (ref: Parameters<typeof prod.worker>[0]) => ref.transport === "peer" ? { manual: `${ref.agent} 不在本机 registry` } : ({ ...f.tickDeps.worker(ref), submit: async () => {
      if (ref.transport === "peer") return { status: "rejected" as const, route: "channel" as const, reason: "missing registry" };
      sent.push(ref.agent); return { status: "sent" as const, route: "channel" as const, messageKey: "test", evidence: "test" }; } }) };
  const tick = () => schedulerAutoTick(f.reader.get()!, { p: { maxActiveWorkers: 2 } }, deps);
  return { f, ...r, cli, cliEnv, tick, creates, sent, prod, opts, reads: () => reads,
    setRead: (fn: typeof readHead) => { readHead = fn; }, advance: (ms: number) => { clock += ms; }, setMode: (m: typeof mode) => { mode = m; modeFile(); } };
}

test("SLA1 shape: readonly scheduler retires peer, creates local author, sends original fix and preserves reviewer", async () => {
  const p = await fixture(), reviewer = getSchedulerSession(p.f.db, "T1", "reviewer");
  expect(await p.tick()).toMatchObject({ failed: [], cards: [{ step: "session" }] });
  expect(getSchedulerSession(p.f.db, "T1", "author")).toMatchObject({ agent: "agent-task-t1", transport: "tmux" });
  expect(getSchedulerSession(p.f.db, "T1", "reviewer")).toEqual(reviewer);
  expect(await p.tick()).toMatchObject({ failed: [], cards: [{ step: "sent" }] });
  expect(p.creates).toHaveLength(1); expect(p.sent).toEqual(["agent-task-t1"]); expect(p.reads()).toBe(1);
  expect(getWorkflow(p.f.db, "T1")?.mode).toBe("auto");
  expect(p.f.task()).toMatchObject({ stage: "fix", headSHA: p.head, branch: "lend/T1-abcd" });
  expect(currentOrders(p.f.db, { agent: "agent-task-t1", sessionId: "local-s", family: "claude-code", channelId: "test" })).toMatchObject([{ step: "fix" }]);
}, 30_000);

function lab(p: Awaited<ReturnType<typeof fixture>>) {
  mkdirSync(join(p.f.dir, "git/example"), { recursive: true }); symlinkSync(p.bare, join(p.f.dir, "git/example/repo.git"));
  const home = `${p.f.dir}-home`; mkdirSync(home); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const runtime = `${p.f.dir}-runtime`; mkdirSync(runtime); cleanup.push(() => rmSync(runtime, { recursive: true, force: true }));
  Object.assign(p.cliEnv, { HOME: home, CLAUDESTRA_RUNTIME_DIR: runtime, CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_SANDBOX_ROOT: p.f.dir, CLAUDESTRA_LAB_ROOT: p.f.dir,
    BRIDGE_PORT: "45678", BRIDGE_URL: "ws://127.0.0.1:45678", BRIDGE_BIND: "127.0.0.1" });
}

test.each(["reclaim", "sweep"] as const)("%s ends lease and retires binding in one transaction via CLI (local bare remote)", async route => {
  const p = await fixture(); lab(p);
  p.f.db.run("UPDATE lend_write_leases SET state='held' WHERE taskId='T1'");
  if (route === "sweep") {
    p.f.db.run("INSERT INTO lend_orders SELECT 'OLD',taskId,project,peer,family,step,specRev,round,head,repo,pr,wire,text,sha256,status,worker,leaseGen,"
      + "leaseMs,leaseUntil,resultSha,receipt,eventSeq,reason,supersedes,createdBy,createdAt,updatedAt,branch,base,seenAt,beatAt,beat FROM lend_orders WHERE orderId='O'");
  }
  p.f.db.run("UPDATE lend_orders SET status=?, leaseGen=? WHERE orderId='O'", [route === "reclaim" ? "claimed" : "pooled", route === "reclaim" ? 1 : 0]);
  expect(await p.cli(false, ...(route === "reclaim" ? ["lend-reclaim", "T1", "--reason", "test"] : ["lend-sweep"]))).toMatchObject({ ok: true });
  expect(p.f.db.query("SELECT state FROM lend_write_leases WHERE taskId='T1'").get()).toEqual({ state: "ended" });
  if (route === "reclaim") expect(getSchedulerSession(p.f.db, "T1", "author")?.state).toBe("retired");
  else {
    expect(getSchedulerSession(p.f.db, "T1", "author")?.state).toBe("active");
    expect(listEvents(p.f.db, { target: "T1" }).some(e => e.data.op === "lend_author_blocked")).toBe(false);
    expect(p.reads()).toBe(0);
    expect(await p.tick()).toMatchObject({ failed: [], cards: [{ step: "session" }] });
    expect(getSchedulerSession(p.f.db, "T1", "author")).toMatchObject({ agent: "agent-task-t1", transport: "tmux" });
    expect(await p.tick()).toMatchObject({ failed: [], cards: [{ step: "sent" }] });
    expect(p.reads()).toBe(1); expect(p.creates).toHaveLength(1); expect(p.sent).toEqual(["agent-task-t1"]);
  }
}, 30_000);

test("retirement failure rolls back the cancelled order, ended lease, assignment and binding", async () => {
  const p = await fixture(); lab(p);
  p.f.db.run("UPDATE lend_write_leases SET state='held' WHERE taskId='T1'");
  p.f.db.run("UPDATE lend_orders SET status='claimed' WHERE orderId='O'");
  p.f.db.run("CREATE TRIGGER fail_retire BEFORE UPDATE ON scheduler_sessions WHEN NEW.state='retired' BEGIN SELECT RAISE(ABORT,'retire failure'); END");
  const before = p.f.task();
  expect(await p.cli(false, "lend-reclaim", "T1", "--reason", "test")).toMatchObject({ ok: false });
  expect(p.f.task()).toEqual(before);
  expect(p.f.db.query("SELECT state FROM lend_write_leases WHERE taskId='T1'").get()).toEqual({ state: "held" });
  expect(p.f.db.query("SELECT status FROM lend_orders WHERE orderId='O'").get()).toEqual({ status: "claimed" });
  expect(getSchedulerSession(p.f.db, "T1", "author")?.state).toBe("active");
}, 30_000);

test.each(["observe", "off"] as const)("%s preserves old manual behavior, zero remote reads", async mode => {
  const p = await fixture(mode);
  expect(await p.tick()).toMatchObject({ failed: [], cards: [{ step: "manual" }] });
  p.f.db.run("UPDATE task_workflows SET mode='auto' WHERE taskId='T1'");
  expect(await p.tick()).toMatchObject({ failed: [], cards: [{ step: "held", detail: expect.stringContaining("不在本机 registry") }] });
  const notes = listEvents(p.f.db, { target: "T1" }).filter(e => e.data.mechanism === "lendAuthorRebuild");
  expect(notes).toHaveLength(mode === "observe" ? 1 : 0); expect(p.reads()).toBe(0); expect(p.creates).toHaveLength(0);
  expect(getSchedulerSession(p.f.db, "T1", "author")?.state).toBe("active");
}, 30_000);

test("existing branch checked out elsewhere or at a different head is preserved and stops for PM", async () => {
  const p = await fixture(), occupied = join(p.f.dir, "occupied");
  await p.run(p.repo, "worktree", "add", occupied, "lend/T1-abcd");
  expect(await p.tick()).toMatchObject({ failed: [], cards: [{ step: "manual", detail: expect.stringContaining("占用") }] });
  expect(p.creates).toHaveLength(0); expect(await p.run(occupied, "rev-parse", "HEAD")).toBe(p.head);
  await p.run(p.repo, "worktree", "remove", occupied);
  const check = (args: string[]) => git(["-C", p.repo, ...args]);
  expect(await lendAuthorBranchGate(check, { branch: "lend/T1-abcd", base: "0".repeat(40), worktree: occupied })).toContain("不一致");
}, 30_000);

test("unknown order cannot retire through the real CLI; recovery key occurs once", async () => {
  const p = await fixture(); p.f.db.run("UPDATE lend_orders SET status='unknown' WHERE orderId='O'");
  expect(await p.tick()).toMatchObject({ failed: [] });
  expect(getSchedulerSession(p.f.db, "T1", "author")?.state).toBe("active"); expect(p.creates).toHaveLength(0);
  expect(listEvents(p.f.db, { target: "T1" }).findLast(e => e.data.op === "lend_author_blocked")?.text).toContain("unknown");
  expect(RECOVERY_KEYS.filter(k => k === "lendAuthorRebuild")).toHaveLength(1);
}, 30_000);


test("unreadable/mismatched/timed-out head blocks; same rev + binding reads at most once in ten minutes", async () => {
  const p = await fixture();
  p.setRead(async () => ({ ok: true, head: "0".repeat(40) }));
  await p.prod.prepareAuthor!(p.f.task()); await p.prod.prepareAuthor!(p.f.task());
  expect(p.reads()).toBe(1); expect(getSchedulerSession(p.f.db, "T1", "author")?.state).toBe("active");
  expect(listEvents(p.f.db, { target: "T1" }).at(-1)?.text).toContain("不一致");
  p.advance(600_001); p.setRead(async () => ({ ok: false, error: "missing remote" }));
  await p.prod.prepareAuthor!(p.f.task()); expect(p.reads()).toBe(2);
  p.advance(600_001); p.setRead(() => new Promise(() => {}));
  const start = Date.now(); await p.prod.prepareAuthor!(p.f.task());
  expect(Date.now() - start).toBeLessThan(5000); expect(p.reads()).toBe(3);
  expect(getSchedulerSession(p.f.db, "T1", "author")?.state).toBe("active");
}, 30_000);
