/**
 * i28-CIF3 · FLK2 (10-07) wired as src/scheduler.ts runs it: read-only LedgerReader, every write the real ledger CLI child (scheduler
 * identity + lease, temp HOME / TMPDIR / state dir), production mergeExternal plus the CIF1 / CIF2 gh layers on the same runner, with
 * only gh faked (calls, CI logs and the merge head recorded). Card A: ready → updating (the scheduler's update-branch) → carried →
 * await_ci → GitHub reports UNSTABLE with one shard red on a timeout in a test the PR does not touch, before the required gate ran.
 * Before CIF3 that froze the project queue (unknown); now the run waits for the gate, re-runs once, and merges pinned to the carried head.
 * Driver / ledger cases: tests/scheduler-merge-ci-carried.test.ts.
 */
import { afterAll, afterEach, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { ciBehindGh } from "../src/lib/scheduler-merge-ci-behind.js";
import { ciRerunGh } from "../src/lib/scheduler-merge-ci-rerun.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { testChildEnv } from "./test-env.js";

const A = "FLK2", B = "FLK2B", M = "b".repeat(40);
const PRS: Record<string, string> = { [A]: "https://github.com/example/repo/pull/42", [B]: "https://github.com/example/repo/pull/43" };
const MANAGER = resolve("src/manager.ts");
const T0 = Date.UTC(2026, 9, 7, 7, 0);
const OWNER = { actor: "owner" };
const GATE = "typecheck + test + guard", SHARD = "test shard 1 of 4", RUN = "https://github.com/example/repo/actions/runs/54368";
const SLOW = "tests/scheduler-placement-start-reservations.test.ts";

const at = (line: string) => `${SHARD}\tUnit tests\t2026-10-07T07:20:03.1234567Z ${line}`;
const ciLog = (body: string[]) => [at("##[group]tests/a.test.ts:"), at("(pass) fine [1.00ms]"), at("##[endgroup]"), ...body, at(""),
  at(" 1999 pass"), at(" 1 fail"), at("Ran 2000 tests across 300 files. [90.00s]"), at("##[error]Process completed with exit code 1.")].join("\n");
const TIMEOUT_ONLY = ciLog([at(`##[group]${SLOW}:`), at("(fail) production livePlacementIO observes formal starts [5638.00ms]"),
  at("  ^ this test timed out after 5000ms."), at("##[endgroup]")]);
const ASSERTED = ciLog([at(`##[group]${SLOW}:`), at("error: expect(received).toBe(expected)"),
  at("(fail) production livePlacementIO observes formal starts [0.40ms]"), at("##[endgroup]")]);

let root = "", work = "", reviewed = "", merged = "", other = "", main = "";
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
/** reviewed = A's reviewed head; merged = the scheduler's update-branch on it (only main merged in); other = card B. */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cif3-"));
  work = join(root, "work");
  await runBounded(["git", "init", "-q", "--bare", "-b", "main", join(root, "origin.git")], { timeoutMs: 30_000 });
  await runBounded(["git", "init", "-q", "-b", "main", work], { timeoutMs: 30_000 });
  await sh("remote", "add", "origin", "https://github.com/example/repo.git");
  await sh("remote", "set-url", "--push", "origin", join(root, "origin.git"));
  await commitFile("README.md", "base\n", "base");
  await sh("push", "-q", "origin", "main");
  await sh("checkout", "-q", "-b", `task/${A}`);
  reviewed = await commitFile("src/x.ts", "export const x = 1;\n", "reviewed change");
  await sh("checkout", "-q", "main");
  main = await commitFile("docs/y.md", "main moved\n", "main moves");
  await sh("push", "-q", "origin", "main");
  await sh("checkout", "-q", `task/${A}`);
  await sh("merge", "-q", "--no-edit", main);
  merged = await sh("rev-parse", "HEAD");
  await sh("push", "-q", "origin", `${merged}:refs/heads/task/${A}`);
  await sh("checkout", "-q", "-b", `task/${B}`, main);
  other = await commitFile("src/b.ts", "export const b = 1;\n", "card B");
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

let cleanup: (() => void)[] = [];
afterEach(() => { setSystemTime(); for (const c of cleanup.splice(0).reverse()) c(); });

type Bucket = "pass" | "fail" | "pending";
/** gh pr checks JSON for the sharded workflow; the gate is absent until it runs (needs: tests). */
const checks = (shard: Bucket, gate: Bucket | null) => JSON.stringify([{ name: SHARD, bucket: shard, link: `${RUN}/job/1` },
  ...(gate ? [{ name: GATE, bucket: gate, link: `${RUN}/job/5` }] : [])]);

async function setup(log = TIMEOUT_ONLY) {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), "cif3-ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const seq = () => (db.query("SELECT MAX(seq) AS seq FROM events WHERE project='p'").get() as { seq: number }).seq;
  const revs = (id: string) => ({ task: getTask(db, id)!.rev, wf: (db.query("SELECT rev FROM task_workflows WHERE taskId=?").get(id) as { rev: number }).rev });
  /** Card in merge, round 1, its cross-family pool review passed at `head` (the planner's merge gate re-reads all of it). */
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
  // The child's TMPDIR is `dir` itself: test-guard only keeps a state / runtime dir under the child's own temp roots, and the
  // outer TMPDIR may sit anywhere (a workspace path), so a sibling tmp would get both redirected to an empty ledger.
  const home = join(dir, "home"), runtime = join(dir, "runtime");
  for (const d of [home, runtime]) mkdirSync(d);
  let at = T0;
  const clock = join(dir, "clock.ts");
  writeFileSync(clock, "const at = Number(process.env.CIF3_NOW); Date.now = () => at;\n");
  const env = (over: Record<string, string> = {}) => testChildEnv({ CIF3_NOW: String(at), HOME: home, TMPDIR: dir, CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: runtime, CLAUDESTRA_TEST: "1",
    CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: singletonPath, token: singleton.token },
      maintenance: { path: maintenancePath, token: maintenance.token } }), ...over });
  const children: string[] = [], redirected: string[] = [];
  const cli = async (over: Record<string, string>, args: string[]) => {
    const p = Bun.spawn([process.execPath, "--no-env-file", "--preload", clock, MANAGER, ...args], { env: env(over), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    redirected.push(...err.split("\n").filter((l) => l.startsWith("[test-guard]")));
    try { return JSON.parse(out) as Record<string, unknown>; } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };
  /** The real ledger CLI with the scheduler identity and lease, as schedulerPass's manager runs it. */
  const manager = async (...args: string[]) => {
    children.push(args[1]!);
    return cli({}, args);
  };
  const plan = async (taskId: string, id: string) => {
    const r = await manager("ledger", "scheduler-plan", taskId, "--id", id, "--rev", String(revs(taskId).task), "--workflow-rev", String(revs(taskId).wf),
      "--seq", String(seq()), "--node", "merge_deploy", "--action", "merge", "--reason", "merge", "--resources", "merge:p");
    expect(r).toMatchObject({ ok: true });
    expect(db.query("SELECT id FROM scheduler_intents WHERE id=?").get(id)).toEqual({ id }); // the child wrote this fixture's ledger, not a redirected one
  };

  // Fake gh: GitHub's answers this tick, per PR, every call recorded. Git runs for real (fetch served from the local bare repo).
  const passing = JSON.stringify([{ name: SHARD, bucket: "pass" }, { name: GATE, bucket: "pass" }]);
  const gh = { prs: { 42: { head: reviewed, checks: passing, mergeState: "CLEAN", merged: false }, 43: { head: other, checks: passing, mergeState: "CLEAN", merged: false } } as
    Record<number, { head: string; checks: string; mergeState: string; merged: boolean }>, calls: [] as string[],
    run: { attempt: 1, status: "in_progress", conclusion: "" }, log };
  const command: typeof runBounded = async (argv, opts) => {
    const ok = (stdout: unknown) => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "", timedOut: false });
    if (argv[0] === "git") return runBounded(argv[1] === "fetch" ? argv.map((a) => (a === "origin" ? join(root, "origin.git") : a)) : argv, opts);
    const a = argv.slice(1).join(" ");
    gh.calls.push(a);
    const n = Number(/\/pull\/(\d+)/.exec(a)?.[1] ?? /pulls\/(\d+)\//.exec(a)?.[1]), p = gh.prs[n];
    if (a.startsWith("repo view")) return ok({ nameWithOwner: "example/repo" });
    if (a === `pr view ${PRS[A]} --json files`) return ok({ files: [{ path: "src/x.ts" }] });
    if (a.startsWith("pr view") && p) return ok({ state: p.merged ? "MERGED" : "OPEN", headRefOid: p.head, headRefName: `task/${n === 42 ? A : B}`,
      baseRefName: "main", isDraft: false, isCrossRepository: false, mergeStateStatus: p.merged ? "UNKNOWN" : p.mergeState, mergeCommit: p.merged ? { oid: M } : null });
    if (a.startsWith("pr checks") && p) return { code: p.checks === passing ? 0 : 8, stdout: p.checks, stderr: "", timedOut: false };
    if (a.startsWith("api repos/example/repo/compare/main...")) return ok({ behind: a.includes(reviewed) ? 1 : 0, main });
    if (a.startsWith("api repos/example/repo/compare/")) return ok({ base: main, commits: [] }); // CIF2: the carried head is not behind main
    if (a === "run view 54368 --repo example/repo --json attempt,status,conclusion") return ok(gh.run);
    if (a === "run view 54368 --repo example/repo --log-failed") return ok(gh.log);
    if (a === "run rerun 54368 --failed --repo example/repo") { gh.run = { attempt: 2, status: "queued", conclusion: "" }; return ok(""); }
    if (a === `pr update-branch ${PRS[A]}`) { Object.assign(gh.prs[42]!, { head: merged, checks: checks("pending", null), mergeState: "UNSTABLE" }); return ok(""); }
    const merge = /^api -X PUT repos\/example\/repo\/pulls\/(\d+)\/merge -f sha=([a-f0-9]{40}) -f merge_method=merge$/.exec(a);
    if (merge && gh.prs[Number(merge[1])]?.head === merge[2]) { gh.prs[Number(merge[1])]!.merged = true; return ok({ merged: true, sha: M }); }
    return { code: 1, stdout: "", stderr: `unexpected gh ${a}`, timedOut: false };
  };
  const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: [GATE], repoDir: work } } });
  const tick = async () => {
    at += 60_000;
    setSystemTime(new Date(at));
    const ro = reader.get()!;
    expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
    await mergeTick(ro, config, manager, (p) => Object.assign(mergeExternal(p, command), { ciRerun: ciRerunGh(command), ciBehind: ciBehindGh(command) }), () => {});
  };
  const state = (intentId: string, taskId = A) => ({ phase: getMergeRun(db, intentId)?.phase, frozen: getMeta(db, "p").queueFrozen.frozen,
    stage: getTask(db, taskId)!.stage, head: getTask(db, taskId)!.headSHA });
  const sent = () => gh.calls.filter((c) => c.includes("update-branch") || c.includes("/merge ") || c.startsWith("run rerun"));
  const ops = (op: string) => listEvents(db, { project: "p", target: A }).filter((e) => e.data.op === op);
  /** FLK2: ready → updating (update-branch) → carried → await_ci, then shard 1 red on the timeout while the gate has not run. */
  const toFlk2 = async () => {
    await plan(A, "a0");
    await tick();
    expect(state("a0")).toMatchObject({ phase: "updating", frozen: false });
    await tick();
    expect(state("a0")).toMatchObject({ phase: "await_ci", frozen: false, stage: "merge", head: merged });
    expect(ops("review_carry")).toHaveLength(1);
    Object.assign(gh.prs[42]!, { checks: checks("fail", null), mergeState: "UNSTABLE" });
    await tick();
  };
  /** Run 54368 ended: the gate went red after the shard. */
  const gateRed = () => { gh.run = { attempt: 1, status: "completed", conclusion: "failure" }; gh.prs[42]!.checks = checks("fail", "fail"); };
  return { db, gh, plan, tick, state, sent, ops, toFlk2, gateRed, children, cli, redirected, revs, seq };
}

test("CIF3 旧红新绿：FLK2 形态，调度器 update-branch 沿用后的 head 上分片超时红 → 不判 unknown、记一次重跑继续等，重跑绿后按沿用 head 钉 head 合并，队列始终没冻", async () => {
  const s = await setup();
  await s.toFlk2();
  expect(s.state("a0")).toEqual({ phase: "await_ci", frozen: false, stage: "merge", head: merged }); // before CIF3: unknown, frozen
  s.gateRed();
  await s.tick();
  expect(s.state("a0")).toEqual({ phase: "await_ci", frozen: false, stage: "merge", head: merged });
  expect(s.ops("merge_ci_rerun")).toEqual([expect.objectContaining({ data: expect.objectContaining({ prHead: merged, run: RUN, checks: [GATE],
    cases: [`${SLOW} > production livePlacementIO observes formal starts`] }) })]);
  Object.assign(s.gh.prs[42]!, { checks: checks("pending", "pending") }); // attempt 2 running
  await s.tick();
  expect(s.state("a0")).toMatchObject({ phase: "await_ci", frozen: false });
  s.gh.run = { attempt: 2, status: "completed", conclusion: "success" };
  Object.assign(s.gh.prs[42]!, { checks: JSON.stringify([{ name: SHARD, bucket: "pass" }, { name: GATE, bucket: "pass" }]), mergeState: "CLEAN" });
  await s.tick();
  expect(s.state("a0")).toMatchObject({ phase: "merged", frozen: false, head: merged });
  expect(s.sent()).toEqual([`pr update-branch ${PRS[A]}`, "run rerun 54368 --failed --repo example/repo",
    `api -X PUT repos/example/repo/pulls/42/merge -f sha=${merged} -f merge_method=merge`]);
  expect(s.ops("merge_conflict")).toEqual([]);
  // the queue stayed open: card B behind it merges as usual
  await s.plan(B, "b0");
  await s.tick();
  await s.tick();
  expect(s.state("b0", B)).toMatchObject({ phase: "merged", frozen: false });
  expect(s.children.every((c) => c.startsWith("scheduler-"))).toBe(true);
  expect(s.redirected).toEqual([]); // every child kept this fixture's state / runtime dirs (test-guard redirected none)
}, 180_000);

test("CIF3 反例：同一形态但断言失败 → 退 fix、不重跑、队列不冻", async () => {
  const s = await setup(ASSERTED);
  await s.toFlk2();
  expect(s.state("a0")).toMatchObject({ phase: "await_ci", frozen: false });
  s.gateRed();
  await s.tick();
  expect(s.state("a0")).toEqual({ phase: "resolved", frozen: false, stage: "fix", head: merged });
  expect(s.ops("merge_conflict")).toEqual([expect.objectContaining({ data: expect.objectContaining({ cause: "ci_fail", prHead: merged,
    checks: [{ name: GATE, link: RUN }] }) })]);
  expect(s.sent()).toEqual([`pr update-branch ${PRS[A]}`]);
}, 180_000);

test("CIF3 隔离反例：子进程状态目录不在它认可的临时根下 → test-guard 照旧改道到空台账，写不进本 fixture，也不碰那个目录", async () => {
  const s = await setup();
  const outside = resolve(`.cif3-not-temp-${process.pid}`);
  const r = await s.cli({ CLAUDESTRA_STATE_DIR: outside }, ["ledger", "scheduler-plan", A, "--id", "a0", "--rev", String(s.revs(A).task),
    "--workflow-rev", String(s.revs(A).wf), "--seq", String(s.seq()), "--node", "merge_deploy", "--action", "merge", "--reason", "merge", "--resources", "merge:p"]);
  expect(r).toMatchObject({ ok: false });
  expect(s.redirected).toEqual([expect.stringContaining(`CLAUDESTRA_STATE_DIR 指向 ${outside}`)]);
  expect(existsSync(outside)).toBe(false);
  expect(s.db.query("SELECT id FROM scheduler_intents").all()).toEqual([expect.objectContaining({ id: "rv-FLK2" }), expect.objectContaining({ id: "rv-FLK2B" })]);
}, 60_000);
