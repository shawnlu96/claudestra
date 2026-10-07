/**
 * MCRY3 · PR812 (10-07) wired as src/scheduler.ts runs it: read-only LedgerReader, every write the real ledger CLI child (scheduler
 * identity + lease, temp HOME / TMPDIR / state dir), production mergeExternal with only gh faked (calls and merge head recorded).
 * Card A: ready → updating (the scheduler's update-branch) → carried → await_ci → the author pushes a fix → next drive.
 * Before MCRY3 that froze the project queue (unknown); now A goes back to review with the new head and card B behind it merges.
 * Driver / ledger / train cases: tests/scheduler-merge-await-ci-head.test.ts.
 */
import { afterAll, afterEach, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getMeta, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { testChildEnv } from "./test-env.js";

const A = "MCRY3", B = "MCRY3B", M = "b".repeat(40);
const PRS: Record<string, string> = { [A]: "https://github.com/example/repo/pull/42", [B]: "https://github.com/example/repo/pull/43" };
const MANAGER = resolve("src/manager.ts");
const T0 = Date.UTC(2026, 9, 7, 5, 0);
const OWNER = { actor: "owner" };

let root = "", work = "", reviewed = "", merged = "", fix = "", other = "", main = "";
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
/** reviewed = A's reviewed head; merged = the scheduler's update-branch on it; fix = the author's P1 fix on top; other = card B. */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mcry3-"));
  work = join(root, "work");
  await runBounded(["git", "init", "-q", "--bare", "-b", "main", join(root, "origin.git")], { timeoutMs: 30_000 });
  await runBounded(["git", "init", "-q", "-b", "main", work], { timeoutMs: 30_000 });
  await sh("remote", "add", "origin", "https://github.com/example/repo.git");
  await sh("remote", "set-url", "--push", "origin", join(root, "origin.git"));
  const base = await commitFile("README.md", "base\n", "base");
  await sh("push", "-q", "origin", "main");
  await sh("checkout", "-q", "-b", `task/${A}`);
  reviewed = await commitFile("src/x.ts", "export const x = 1;\n", "reviewed change");
  await sh("checkout", "-q", "main");
  main = await commitFile("docs/y.md", "main moved\n", "main moves");
  await sh("push", "-q", "origin", "main");
  await sh("checkout", "-q", `task/${A}`);
  await sh("merge", "-q", "--no-edit", main);
  merged = await sh("rev-parse", "HEAD");
  fix = await commitFile("src/x.ts", "export const x = 2; // P1 fix\n", "author fix");
  await sh("push", "-q", "origin", `${fix}:refs/heads/task/${A}`);
  await sh("checkout", "-q", "-b", `task/${B}`, main);
  other = await commitFile("src/b.ts", "export const b = 1;\n", "card B");
  expect(base).not.toBe(main);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

let cleanup: (() => void)[] = [];
afterEach(() => { setSystemTime(); for (const c of cleanup.splice(0).reverse()) c(); });

const passing = JSON.stringify([{ name: "check", bucket: "pass" }]), pending = JSON.stringify([{ name: "check", bucket: "pending" }]);

async function setup() {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), "mcry3-ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const seq = () => (db.query("SELECT MAX(seq) AS seq FROM events WHERE project='p'").get() as { seq: number }).seq;
  const revs = (id: string) => ({ task: getTask(db, id)!.rev, wf: (db.query("SELECT rev FROM task_workflows WHERE taskId=?").get(id) as { rev: number }).rev });
  /** Card in merge, round 1, its cross-family review passed at `head` (the planner's merge gate re-reads all of it). */
  const card = (id: string, head: string) => {
    const add = (actor: string, kind: string, data: unknown) => db.prepare(
      "INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,?,'p',?,?,'',?)").run(actor, id, kind, JSON.stringify(data));
    createTask(db, OWNER, { project: "p", id, title: "merge", kind: "code", agent: "agent-author" });
    setWorkflow(db, OWNER, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
    db.query("UPDATE tasks SET stage='review', round=1, headSHA=?, pr=?, branch=? WHERE id=?").run(head, PRS[id], `task/${id}`, id);
    add("owner", "stage", { from: "build", to: "review", round: 1 });
    planIntent(db, { actor: "scheduler" }, { id: `rv-${id}`, taskId: id, taskRev: revs(id).task, workflowRev: revs(id).wf, causalSeq: seq(),
      node: "adversarial_review", action: "review", reason: "review", recipient: "agent-review" });
    settleIntent(db, { actor: "scheduler" }, { id: `rv-${id}`, from: "pending", to: "submitted", receipt: "ack" });
    add("agent-review", "review", { round: 1, head, verdict: "pass", reviewer: "agent-review", reviewerSessionId: `rs-${id}`,
      reviewerFamily: "codex", path: `reviews/${id}-r1/report.md`, findings: [], p0: 0, p1: 0, p2: 0 });
    settleIntent(db, { actor: "scheduler" }, { id: `rv-${id}`, from: "submitted", to: "done", receipt: "review event recorded" });
    db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
      VALUES (?,'reviewer','agent-review',?,'codex','acp','active',?,100,100)`).run(id, `rs-${id}`, `rv-${id}`);
    db.query("UPDATE tasks SET stage='merge' WHERE id=?").run(id);
    add("owner", "stage", { from: "review", to: "merge", round: 1, specRev: 1 });
  };
  card(A, reviewed);
  card(B, other);
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
  writeFileSync(clock, "const at = Number(process.env.MCRY3_NOW); Date.now = () => at;\n");
  const env = () => testChildEnv({ MCRY3_NOW: String(at), HOME: home, TMPDIR: tmp, CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: runtime, CLAUDESTRA_TEST: "1",
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
  const plan = async (taskId: string, id: string) => {
    const r = await manager("ledger", "scheduler-plan", taskId, "--id", id, "--rev", String(revs(taskId).task), "--workflow-rev", String(revs(taskId).wf),
      "--seq", String(seq()), "--node", "merge_deploy", "--action", "merge", "--reason", "merge", "--resources", "merge:p");
    expect(r).toMatchObject({ ok: true });
  };

  // Fake gh: GitHub's answers this tick, per PR, every call recorded. Git runs for real (fetch served from the local bare repo).
  const gh = { prs: { 42: { head: reviewed, checks: passing, mergeState: "CLEAN", merged: false }, 43: { head: other, checks: passing, mergeState: "CLEAN", merged: false } } as
    Record<number, { head: string; checks: string; mergeState: string; merged: boolean; view?: Record<string, unknown> }>, calls: [] as string[] };
  const command: typeof runBounded = async (argv, opts) => {
    const ok = (stdout: unknown) => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "", timedOut: false });
    if (argv[0] === "git") return runBounded(argv[1] === "fetch" ? argv.map((a) => (a === "origin" ? join(root, "origin.git") : a)) : argv, opts);
    const a = argv.slice(1).join(" ");
    gh.calls.push(a);
    const n = Number(/\/pull\/(\d+)/.exec(a)?.[1] ?? /pulls\/(\d+)\//.exec(a)?.[1]), p = gh.prs[n];
    if (a.startsWith("repo view")) return ok({ nameWithOwner: "example/repo" });
    if (a.startsWith("pr view") && p) return ok({ state: p.merged ? "MERGED" : "OPEN", headRefOid: p.head, headRefName: `task/${n === 42 ? A : B}`,
      baseRefName: "main", isDraft: false, isCrossRepository: false, mergeStateStatus: p.merged ? "UNKNOWN" : p.mergeState, mergeCommit: p.merged ? { oid: M } : null, ...p.view });
    if (a.startsWith("pr checks") && p) return { code: p.checks === passing ? 0 : 8, stdout: p.checks, stderr: "", timedOut: false };
    if (a.startsWith("api repos/example/repo/compare/")) return ok({ behind: a.includes(reviewed) ? 1 : 0, main });
    if (a === `pr update-branch ${PRS[A]}`) { Object.assign(gh.prs[42]!, { head: merged, checks: pending, mergeState: "UNSTABLE" }); return ok(""); }
    const merge = /^api -X PUT repos\/example\/repo\/pulls\/(\d+)\/merge -f sha=([a-f0-9]{40}) -f merge_method=merge$/.exec(a);
    if (merge && gh.prs[Number(merge[1])]?.head === merge[2]) { gh.prs[Number(merge[1])]!.merged = true; return ok({ merged: true, sha: M }); }
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
  const state = (intentId: string, taskId = A) => ({ phase: getMergeRun(db, intentId)?.phase, frozen: getMeta(db, "p").queueFrozen.frozen,
    stage: getTask(db, taskId)!.stage, head: getTask(db, taskId)!.headSHA });
  const sent = () => gh.calls.filter((c) => c.includes("update-branch") || c.includes("/merge "));
  return { db, gh, plan, tick, state, sent, children };
}

test("MCRY3 旧红新绿：PR812 形态，await_ci 时作者推了新 head → 卡回 review 带新 head，队列没冻；排在后面的卡 B 照常进 ready 并合并", async () => {
  const s = await setup();
  await s.plan(A, "a0");
  await s.tick();
  expect(s.state("a0")).toMatchObject({ phase: "updating", frozen: false });
  await s.tick(); // the scheduler's own update-branch is carried, CI is running on the merged head
  expect(s.state("a0")).toMatchObject({ phase: "await_ci", frozen: false, stage: "merge", head: merged });
  expect(listEvents(s.db, { project: "p", target: A }).filter((e) => e.data.op === "review_carry")).toHaveLength(1);
  // a local review reported P1; the author pushes the fix while the run waits for CI
  Object.assign(s.gh.prs[42]!, { head: fix, checks: pending, mergeState: "UNSTABLE" });
  await s.tick();
  expect(s.state("a0")).toEqual({ phase: "await_review", frozen: false, stage: "review", head: fix });
  expect(getMergeRun(s.db, "a0")?.reason).toBe(`等 CI 时作者推了新 head：原 head ${merged} → 新 head ${fix}，旧审查失效`);
  expect(listEvents(s.db, { project: "p", target: A }).filter((e) => e.data.op === "review_carry")).toHaveLength(1); // not carried again
  // the slot is free and the queue open: card B behind it merges as usual
  await s.plan(B, "b0");
  await s.tick();
  expect(s.state("b0", B)).toMatchObject({ phase: "await_ci", frozen: false });
  await s.tick();
  expect(s.state("b0", B)).toMatchObject({ phase: "merged", frozen: false, stage: "merge" });
  expect(s.state("a0")).toMatchObject({ phase: "await_review", stage: "review", head: fix });
  expect(s.sent()).toEqual([`pr update-branch ${PRS[A]}`, `api -X PUT repos/example/repo/pulls/43/merge -f sha=${other} -f merge_method=merge`]);
  expect(s.children.every((c) => c.startsWith("scheduler-"))).toBe(true);
}, 180_000);

// The other changes at await_ci keep the old answer: unknown, the project queue frozen, nothing sent after the update-branch.
for (const [name, view] of [["PR 已 MERGED（别人合的）", { state: "MERGED", mergeCommit: { oid: M } }], ["PR 被关", { state: "CLOSED" }],
  ["base 改了", { baseRefName: "dev" }], ["分支改了", { headRefName: "task/other" }], ["跨仓库", { isCrossRepository: true }],
  ["变成 draft（UNSTABLE）", { isDraft: true }]] as const) {
  test(`MCRY3 反例：await_ci 时作者推了新 head 且 ${name} → unknown，队列冻结，不合并`, async () => {
    const s = await setup();
    await s.plan(A, "a0");
    await s.tick();
    await s.tick();
    expect(s.state("a0")).toMatchObject({ phase: "await_ci", head: merged });
    Object.assign(s.gh.prs[42]!, { head: fix, checks: pending, mergeState: "UNSTABLE", view });
    await s.tick();
    expect(s.state("a0")).toMatchObject({ phase: "unknown", frozen: true, stage: "merge", head: merged });
    expect(s.sent()).toEqual([`pr update-branch ${PRS[A]}`]);
  }, 180_000);
}
