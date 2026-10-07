/**
 * MCRY2 · PMDIR1 (10-07) wired as src/scheduler.ts runs it: mergeTick reads a read-only LedgerReader, every scheduler write is the
 * real ledger CLI in a child process (scheduler identity + lease, temp HOME / TMPDIR / state dir), the external is the production
 * mergeExternal with only gh faked (it records every call and the expected head of the merge); git runs for real on a local fixture.
 * a0: ready → updating (update-branch: the PR head becomes reviewed + a pure main merge) → inspect throws → unknown → PM resolves
 * cancelled → unfreeze → workflow-resume → a1.
 * Old code: a1 at ready reads the moved head → unknown, queue frozen again. New code: a1 writes review_carry (priorIntent a0) and
 * goes to await_ci; CI green → merged pinned to the new head; the queue is never frozen. Ledger-level rules:
 * tests/scheduler-merge-ready-carry-ledger.test.ts.
 */
import { afterAll, afterEach, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { resumeAutoWorkflow } from "../src/lib/ledger-scheduler-resume.js";
import { closeLedger, getMeta, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setFrozen } from "../src/lib/ledger-write.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { getMergeRun, resolveMergeRun } from "../src/lib/scheduler-merge.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { testChildEnv } from "./test-env.js";

const ID = "MCRY", PR = "https://github.com/example/repo/pull/42", M = "b".repeat(40);
const MANAGER = resolve("src/manager.ts");
const T0 = Date.UTC(2026, 9, 7, 2, 0);
const OWNER = { actor: "owner" };

let root = "", work = "", reviewed = "", merged = "", foreign = "", main = "";
const sh = async (...argv: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...argv],
    { cwd: work, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commitFile = async (file: string, body: string, msg: string) => {
  mkdirSync(join(work, file, ".."), { recursive: true });
  writeFileSync(join(work, file), body);
  await sh("add", file);
  await sh("commit", "-q", "-m", msg);
  return sh("rev-parse", "HEAD");
};
/** reviewed = the head the review passed; merged = update-branch's pure main merge on it; foreign = merged + a non-main change. */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mcry2-"));
  work = join(root, "work");
  await runBounded(["git", "init", "-q", "--bare", "-b", "main", join(root, "origin.git")], { timeoutMs: 30_000 });
  await runBounded(["git", "init", "-q", "-b", "main", work], { timeoutMs: 30_000 });
  await sh("remote", "add", "origin", "https://github.com/example/repo.git");
  await sh("remote", "set-url", "--push", "origin", join(root, "origin.git"));
  await commitFile("README.md", "base\n", "base");
  await sh("push", "-q", "origin", "main");
  await sh("checkout", "-q", "-b", `task/${ID}`);
  reviewed = await commitFile("src/x.ts", "export const x = 1;\n", "reviewed change");
  await sh("checkout", "-q", "main");
  main = await commitFile("docs/y.md", "main moved\n", "main moves");
  await sh("push", "-q", "origin", "main");
  await sh("checkout", "-q", `task/${ID}`);
  await sh("merge", "-q", "--no-edit", main);
  merged = await sh("rev-parse", "HEAD");
  foreign = await commitFile("src/z.ts", "export const z = 2;\n", "unreviewed change");
  await sh("push", "-q", "origin", `${foreign}:refs/heads/task/${ID}`);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

let cleanup: (() => void)[] = [];
afterEach(() => { setSystemTime(); for (const c of cleanup.splice(0).reverse()) c(); });

const passing = { stdout: JSON.stringify([{ name: "check", bucket: "pass" }]), stderr: "", code: 0 };
const broken = { stdout: "", stderr: "HTTP 502: Bad Gateway\n", code: 1 }; // the read right after update-branch fails

async function setup(updateTo: () => string) {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), "mcry2-ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  // Card in merge, round 1, its cross-family review passed at `reviewed` (the planner's merge gate re-reads all of it).
  const add = (actor: string, kind: string, data: unknown) => db.prepare(
    "INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,?,'p',?,?,'',?)").run(actor, ID, kind, JSON.stringify(data));
  createTask(db, OWNER, { project: "p", id: ID, title: "merge", kind: "code", agent: "agent-author" });
  setWorkflow(db, OWNER, { taskId: ID, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
  db.query("UPDATE tasks SET stage='review', round=1, headSHA=?, pr=?, branch=? WHERE id=?").run(reviewed, PR, `task/${ID}`, ID);
  add("owner", "stage", { from: "build", to: "review", round: 1 });
  const seq = () => (db.query("SELECT MAX(seq) AS seq FROM events WHERE project='p'").get() as { seq: number }).seq;
  const revs = () => ({ task: getTask(db, ID)!.rev, wf: (db.query("SELECT rev FROM task_workflows WHERE taskId=?").get(ID) as { rev: number }).rev });
  planIntent(db, { actor: "scheduler" }, { id: "rv", taskId: ID, taskRev: revs().task, workflowRev: revs().wf, causalSeq: seq(),
    node: "adversarial_review", action: "review", reason: "review", recipient: "agent-review" });
  settleIntent(db, { actor: "scheduler" }, { id: "rv", from: "pending", to: "submitted", receipt: "ack" });
  add("agent-review", "review", { round: 1, head: reviewed, verdict: "pass", reviewer: "agent-review", reviewerSessionId: "rs",
    reviewerFamily: "codex", path: `reviews/${ID}-r1/report.md`, findings: [], p0: 0, p1: 0, p2: 0 });
  settleIntent(db, { actor: "scheduler" }, { id: "rv", from: "submitted", to: "done", receipt: "review event recorded" });
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES (?,'reviewer','agent-review','rs','codex','acp','active','rv',100,100)`).run(ID);
  db.query("UPDATE tasks SET stage='merge' WHERE id=?").run(ID);
  add("owner", "stage", { from: "review", to: "merge", round: 1, specRev: 1 });
  writeFileSync(join(dir, "registry.json"), JSON.stringify({ agents: {} }));
  const reader = new LedgerReader(path);
  cleanup.push(() => { reader.close(); closeLedger(path); rmSync(dir, { recursive: true, force: true }); errors.mockRestore(); });

  const singletonPath = join(dir, "singleton.lock"), maintenancePath = join(dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  cleanup.push(() => { singleton.release(); maintenance.release(); });
  const home = join(dir, "home"), tmp = join(dir, "tmp"), runtime = join(dir, "runtime");
  for (const d of [home, tmp, runtime]) mkdirSync(d);
  let at = T0;
  const clock = join(dir, "clock.ts");
  writeFileSync(clock, "const at = Number(process.env.MCRY2_NOW); Date.now = () => at;\n");
  const env = () => testChildEnv({ MCRY2_NOW: String(at), HOME: home, TMPDIR: tmp, CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: runtime, CLAUDESTRA_TEST: "1",
    CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: singletonPath, token: singleton.token },
      maintenance: { path: maintenancePath, token: maintenance.token } }) });
  const children: string[] = [];
  /** The real ledger CLI with the scheduler identity and lease, as schedulerPass's manager runs it. */
  const manager = async (...args: string[]) => {
    children.push(args[1]!);
    const p = Bun.spawn([process.execPath, "--no-env-file", "--preload", clock, MANAGER, ...args], { env: env(), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    try { return JSON.parse(out) as Record<string, unknown>; } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };
  /** The planner's merge intent, through the same CLI subcommand the scheduler pass uses. */
  const plan = async (id: string) => {
    const r = await manager("ledger", "scheduler-plan", ID, "--id", id, "--rev", String(revs().task), "--workflow-rev", String(revs().wf),
      "--seq", String(seq()), "--node", "merge_deploy", "--action", "merge", "--reason", "merge", "--resources", "merge:p");
    expect(r).toMatchObject({ ok: true });
  };

  // Fake gh: GitHub's answers this tick, every call recorded. Git runs for real (fetch served from the local bare repo).
  const gh = { head: reviewed, behind: 1, checks: passing, merged: false, calls: [] as string[] };
  const command: typeof runBounded = async (argv, opts) => {
    const ok = (stdout: unknown) => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "", timedOut: false });
    if (argv[0] === "git") return runBounded(argv[1] === "fetch" ? argv.map((a) => (a === "origin" ? join(root, "origin.git") : a)) : argv, opts);
    const a = argv.slice(1).join(" ");
    gh.calls.push(a);
    if (a.startsWith("repo view")) return ok({ nameWithOwner: "example/repo" });
    if (a.startsWith("pr view")) return ok({ state: gh.merged ? "MERGED" : "OPEN", headRefOid: gh.head, headRefName: `task/${ID}`, baseRefName: "main",
      isDraft: false, isCrossRepository: false, mergeStateStatus: gh.merged ? "UNKNOWN" : "CLEAN", mergeCommit: gh.merged ? { oid: M } : null });
    if (a.startsWith("pr checks")) return { timedOut: false, ...gh.checks };
    if (a.startsWith("api repos/example/repo/compare/")) return ok({ behind: gh.head === reviewed ? gh.behind : 0, main });
    if (a === `pr update-branch ${PR}`) { gh.head = updateTo(); gh.checks = broken; return ok(""); }
    if (a === `api -X PUT repos/example/repo/pulls/42/merge -f sha=${gh.head} -f merge_method=merge`) { gh.merged = true; return ok({ merged: true, sha: M }); }
    return { code: 1, stdout: "", stderr: `unexpected gh ${a}`, timedOut: false };
  };
  const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: work } } });
  const tick = async () => {
    at += 60_000;
    setSystemTime(new Date(at));
    const ro = reader.get()!;
    expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
    await mergeTick(ro, config, manager, (p) => mergeExternal(p, command), () => {});
  };
  /** The PM's recovery (PMDIR1): resolve the unknown run as cancelled, unfreeze, hand the card back to auto. */
  const recover = (intentId: string) => {
    resolveMergeRun(db, { ...OWNER, now: at }, { intentId, outcome: "cancelled", receipt: "PR 仍 OPEN、未合并" });
    setFrozen(db, { ...OWNER, now: at }, { project: "p", frozen: false, reason: "核对无其他 unknown" });
    resumeAutoWorkflow(db, { ...OWNER, now: at }, { taskId: ID, taskRev: revs().task, workflowRev: revs().wf, reason: "交回 auto", maxWorkers: 2 });
  };
  const state = (intentId: string) => ({ phase: getMergeRun(db, intentId)?.phase, frozen: getMeta(db, "p").queueFrozen.frozen,
    stage: getTask(db, ID)!.stage, head: getTask(db, ID)!.headSHA });
  const sent = () => gh.calls.filter((c) => c.includes("update-branch") || c.includes("/merge "));
  return { db, gh, plan, tick, recover, state, sent, children };
}

/** a0 claims updating, update-branch moves the head, the next inspect fails → unknown; the PM recovers; a1 is planned. */
async function pmdir1(s: Awaited<ReturnType<typeof setup>>) {
  await s.plan("a0");
  await s.tick();
  expect(s.state("a0")).toMatchObject({ phase: "updating", frozen: false });
  await s.tick();
  expect(s.state("a0")).toMatchObject({ phase: "unknown", frozen: true });
  expect(getMergeRun(s.db, "a0")?.reason).toMatch(/外部步骤失败/);
  s.recover("a0");
  await s.plan("a1");
}

test("MCRY2 旧红新绿：PMDIR1 形态，a1 在 ready 沿用上一次尝试的 update-branch（review_carry 带 priorIntent）→ await_ci → 按新 head 合并，队列始终没冻", async () => {
  const s = await setup(() => merged);
  await pmdir1(s);
  s.gh.checks = passing;
  await s.tick();
  // 旧代码：a1 phase=unknown（「PR 状态、base 或审查 head 已变」），meta.queueFrozen 为真
  expect(s.state("a1")).toMatchObject({ phase: "await_ci", frozen: false, stage: "merge", head: merged });
  expect(getMergeRun(s.db, "a1")?.reviewedHead).toBe(merged);
  const carry = listEvents(s.db, { project: "p", target: ID }).findLast((e) => e.data.op === "review_carry")!;
  expect(carry).toMatchObject({ actor: "scheduler", data: { intentId: "a1", priorIntent: "a0", from: reviewed, to: merged, round: 1, specRev: 1 } });
  await s.tick();
  expect(s.state("a1")).toMatchObject({ phase: "merged", frozen: false });
  expect(s.sent()).toEqual([`pr update-branch ${PR}`, `api -X PUT repos/example/repo/pulls/42/merge -f sha=${merged} -f merge_method=merge`]);
  expect(s.children.every((c) => c.startsWith("scheduler-"))).toBe(true);
}, 180_000);

test("MCRY2 反例：新 head 带非 main 改动 → a1 回 review 重审（带新 head），不冻结、不合并", async () => {
  const s = await setup(() => foreign);
  await pmdir1(s);
  s.gh.checks = passing;
  await s.tick();
  expect(s.state("a1")).toMatchObject({ phase: "await_review", frozen: false, stage: "review", head: foreign });
  expect(listEvents(s.db, { project: "p", target: ID }).some((e) => e.data.op === "review_carry")).toBe(false);
  expect(s.sent()).toEqual([`pr update-branch ${PR}`]);
}, 180_000);

test("MCRY2 反例：上一次尝试没走到 updating（PR 上的纯 main 合并是别人推的）→ 台账拒沿用，a1 回 review，不冻结、不合并", async () => {
  const s = await setup(() => merged);
  await s.plan("a0");
  s.gh.checks = broken; // a0 fails its very first read at ready: no update-branch was ever sent
  await s.tick();
  expect(s.state("a0")).toMatchObject({ phase: "unknown", frozen: true });
  s.recover("a0");
  await s.plan("a1");
  Object.assign(s.gh, { head: merged, checks: passing }); // someone else merged main into the PR meanwhile
  await s.tick();
  expect(s.state("a1")).toMatchObject({ phase: "await_review", frozen: false, stage: "review", head: merged });
  expect(getMergeRun(s.db, "a1")?.reason).toMatch(/跨尝试沿用被台账拒绝.*没有由调度器从 ready 发出 update-branch/);
  expect(s.sent()).toEqual([]);
}, 180_000);
