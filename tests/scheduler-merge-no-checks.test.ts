/**
 * MCHK1 · 刚 update-branch 后 GitHub 还没给新 head 登记 CI：`gh pr checks` stdout 空、stderr「no checks reported」、mergeState=BLOCKED。
 * 按 src/scheduler.ts 的接法测：只读 LedgerReader 读账，写入走真实台账 CLI 子进程（scheduler 身份 + 租约，临时 HOME / TMPDIR / 状态目录），
 * 外部是生产 mergeExternal，只把 gh 换成伪造的；head 已变的 carry 走真实本地 git（origin 指向本地裸仓）。
 * 旧代码：inspect 抛「gh pr checks 无结果」→ 合并意图 unknown、项目冻结。新代码：按 UNKNOWN 等待（持久化、10 分钟上限），检查登记后正常合并一次。
 */
import { afterAll, afterEach, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getMeta, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { beginMergeRun, getMergeRun } from "../src/lib/scheduler-merge.js";
import { MERGE_STATE_UNKNOWN_LIMIT_MS, NO_CHECKS_LIMIT_REASON } from "../src/lib/scheduler-merge-driver.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { testChildEnv } from "./test-env.js";

const ID = "MCHK", INTENT = `merge-${ID}`, PR = "https://github.com/example/repo/pull/42", M = "b".repeat(40);
const MANAGER = resolve("src/manager.ts");
const T0 = Date.UTC(2026, 9, 7, 1, 30);
const NO_CHECKS = "no checks reported on the 'task/MCHK' branch\n";

let root = "", work = "", reviewed = "", merged = "", main = "";
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
/** reviewed = the PR head the review passed; merged = what update-branch made (reviewed + main merged in, nothing else). */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mchk1-"));
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
  await sh("push", "-q", "origin", `HEAD:refs/heads/task/${ID}`);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

let cleanup: (() => void)[] = [];
afterEach(() => { setSystemTime(); for (const c of cleanup.splice(0).reverse()) c(); });

type Checks = { stdout: string; stderr: string; code: number | null; timedOut?: boolean };
const checks = (list: { name: string; bucket: string }[], code = 0): Checks => ({ stdout: JSON.stringify(list), stderr: "", code });
const noChecks: Checks = { stdout: "", stderr: NO_CHECKS, code: 1 };
const pending = checks([{ name: "check", bucket: "pending" }], 8), passing = checks([{ name: "check", bucket: "pass" }]);

async function setup() {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), "mchk1-ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const ctx = { actor: "owner", now: 100 };
  createTask(db, ctx, { project: "p", id: ID, title: "merge", kind: "code", agent: "agent-author" });
  setWorkflow(db, ctx, { taskId: ID, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch=? WHERE id=?").run(reviewed, PR, `task/${ID}`, ID);
  db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-review','p',?,'review','',?)").run(ID, JSON.stringify({
    round: 1, head: reviewed, verdict: "pass", reviewer: "agent-review", reviewerSessionId: "rs", reviewerFamily: "codex",
    path: `reviews/${ID}-r1/report.md`, findings: [], p0: 0, p1: 0, p2: 0 }));
  const intent = (iid: string, node: string, action: string, status: string) => db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,
    causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt) VALUES (?,?,'p',?,?,3,4,2,1,?,2,?,'r',100,100)`)
    .run(iid, ID, node, action, reviewed, status);
  intent(INTENT, "merge_deploy", "merge", "submitted");
  intent("rc", "adversarial_review", "ensure_session", "done");
  for (const resource of [`task:${ID}`, "merge:p"]) {
    db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p',?,?,?,100)").run(resource, ID, INTENT);
  }
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES (?,'reviewer','agent-review','rs','codex','acp','active','rc',100,100)`).run(ID);
  beginMergeRun(db, { actor: "scheduler", now: 101 }, INTENT, ["check"]);
  db.query("UPDATE scheduler_merges SET phase='updating' WHERE intentId=?").run(INTENT); // update-branch was just sent
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
  writeFileSync(clock, "const at = Number(process.env.MCHK1_NOW); Date.now = () => at;\n");
  const env = () => testChildEnv({ MCHK1_NOW: String(at), HOME: home, TMPDIR: tmp, CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: runtime, CLAUDESTRA_TEST: "1",
    CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: singletonPath, token: singleton.token },
      maintenance: { path: maintenancePath, token: maintenance.token } }) });
  const children: string[] = [];
  /** The real ledger CLI, as schedulerPass's manager runs it: a child process with the scheduler identity and lease. */
  const manager = async (...args: string[]) => {
    children.push(args[1]!);
    // the child journals at the test's wall clock (unknownSince)
    const p = Bun.spawn([process.execPath, "--no-env-file", "--preload", clock, MANAGER, ...args],
      { env: env(), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    try { return JSON.parse(out) as Record<string, unknown>; } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };

  // Fake gh: what GitHub says about the PR this tick. Git runs for real (fetch served from the local bare repo).
  const gh = { head: merged, mergeState: "BLOCKED", checks: noChecks, merged: false, calls: [] as string[] };
  const command: typeof runBounded = async (argv, opts) => {
    const ok = (stdout: unknown) => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "", timedOut: false });
    if (argv[0] === "git") return runBounded(argv[1] === "fetch" ? argv.map((a) => (a === "origin" ? join(root, "origin.git") : a)) : argv, opts);
    const a = argv.slice(1).join(" ");
    gh.calls.push(a);
    if (a.startsWith("repo view")) return ok({ nameWithOwner: "example/repo" });
    if (a.startsWith("pr view")) return ok({ state: gh.merged ? "MERGED" : "OPEN", headRefOid: gh.head, headRefName: `task/${ID}`, baseRefName: "main",
      isDraft: false, isCrossRepository: false, mergeStateStatus: gh.merged ? "UNKNOWN" : gh.mergeState, mergeCommit: gh.merged ? { oid: M } : null });
    if (a.startsWith("pr checks")) return { timedOut: false, ...gh.checks };
    if (a.startsWith("api repos/example/repo/compare/")) return ok({ behind: 0, main });
    if (a === `api -X PUT repos/example/repo/pulls/42/merge -f sha=${gh.head} -f merge_method=merge`) { gh.merged = true; return ok({ merged: true, sha: M }); }
    return { code: 1, stdout: "", stderr: `unexpected gh ${a}`, timedOut: false };
  };
  const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: work } } });
  /** One scheduler merge tick at wall clock `when`: reads through the read-only handle only. */
  const tick = async (when: number, say: Partial<Pick<typeof gh, "mergeState" | "checks">> = {}) => {
    Object.assign(gh, say);
    at = when;
    setSystemTime(new Date(when));
    const ro = reader.get()!;
    expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
    await mergeTick(ro, config, manager, (p) => mergeExternal(p, command), () => {});
  };
  const state = () => {
    const run = getMergeRun(db, INTENT)!;
    return { phase: run.phase, frozen: getMeta(db, "p").queueFrozen.frozen, reason: run.reason, unknownSince: run.unknownSince };
  };
  const sent = () => gh.calls.filter((c) => c.includes("update-branch") || c.includes("/merge "));
  return { db, tick, state, gh, sent, children };
}

test("MCHK1 旧红新绿：update-branch 后 head 已变、BLOCKED、gh 说 no checks reported → 等待不冻结，pending → 全绿后合并一次", async () => {
  const s = await setup();
  await s.tick(T0);
  // 旧代码：phase=unknown、reason 含「gh pr checks 无结果」、项目冻结
  expect(s.state()).toMatchObject({ phase: "updating", frozen: false, unknownSince: T0 });
  await s.tick(T0 + 60_000); // 还没登记：同一个时钟接着等
  expect(s.state()).toMatchObject({ phase: "updating", frozen: false, unknownSince: T0 });
  await s.tick(T0 + 120_000, { mergeState: "UNSTABLE", checks: pending });
  expect(s.state()).toMatchObject({ phase: "await_ci", frozen: false, unknownSince: null });
  expect(getMergeRun(s.db, INTENT)?.reviewedHead).toBe(merged); // carry 照旧走真实 git 证明
  await s.tick(T0 + 180_000, { mergeState: "CLEAN", checks: passing });
  expect(s.state()).toMatchObject({ phase: "merged", frozen: false });
  expect(s.sent()).toEqual([`api -X PUT repos/example/repo/pulls/42/merge -f sha=${merged} -f merge_method=merge`]);
  expect(s.children.every((c) => c.startsWith("scheduler-"))).toBe(true);
}, 120_000);

test("MCHK1 反例：一直没有检查，到 10 分钟上限 → unknown，原因写明 CI 没登记；期间不 update-branch、不合并", async () => {
  const s = await setup();
  await s.tick(T0);
  await s.tick(T0 + MERGE_STATE_UNKNOWN_LIMIT_MS - 1);
  expect(s.state()).toMatchObject({ phase: "updating", frozen: false, unknownSince: T0 });
  await s.tick(T0 + MERGE_STATE_UNKNOWN_LIMIT_MS);
  expect(s.state()).toMatchObject({ phase: "unknown", frozen: true, reason: NO_CHECKS_LIMIT_REASON });
  expect(NO_CHECKS_LIMIT_REASON).toBe("CI 在 10 分钟内没有登记");
  expect(s.sent()).toEqual([]);
}, 120_000);

for (const c of [
  { name: "stderr 是别的错", checks: { stdout: "", stderr: "HTTP 502: Bad Gateway\n", code: 1 }, why: /gh pr checks 无结果：HTTP 502/ },
  { name: "gh 超时", checks: { stdout: "", stderr: NO_CHECKS, code: null, timedOut: true }, why: /gh pr checks 无结果/ },
  { name: "退出码异常（4 = 未认证）", checks: { stdout: "", stderr: NO_CHECKS, code: 4 }, why: /gh pr checks 无结果/ },
  { name: "JSON 坏掉", checks: { stdout: "[{", stderr: "", code: 0 }, why: /外部步骤失败/ },
]) {
  test(`MCHK1 反例：${c.name} → 照旧 unknown、冻结`, async () => {
    const s = await setup();
    await s.tick(T0, { checks: c.checks });
    expect(s.state()).toMatchObject({ phase: "unknown", frozen: true });
    expect(s.state().reason).toMatch(c.why);
    expect(s.sent()).toEqual([]);
  }, 120_000);
}

test("MCHK1 反例：空检查列表 + CLEAN（head 未变、已在等 CI）→ 不合并，只等待", async () => {
  const s = await setup();
  s.db.query("UPDATE scheduler_merges SET phase='await_ci' WHERE intentId=?").run(INTENT);
  s.gh.head = reviewed;
  await s.tick(T0, { mergeState: "CLEAN" });
  expect(s.state()).toMatchObject({ phase: "await_ci", frozen: false, unknownSince: T0 });
  await s.tick(T0 + 60_000);
  expect(s.state()).toMatchObject({ phase: "await_ci", frozen: false });
  expect(s.sent()).toEqual([]);
}, 120_000);
