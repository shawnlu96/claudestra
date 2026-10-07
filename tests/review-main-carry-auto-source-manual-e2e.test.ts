/**
 * MCRY4 · a manual_merge run keeps proving the PM request's own source through repeated engine carries (the head projection only
 * reads the review facts at the PASS head; the request gate re-reads the card itself). PR775 shape wired as production runs it: the
 * PM's `ledger review` / `main-carry` / `manual-merge-request` as real `manager.ts ledger` children (registry channel identity),
 * the production manualMergeGate claim and mergeTick over a query_only LedgerReader, every scheduler write a ledger CLI child under
 * the scheduler identity and lease. Real Git (canonical proof, fetch from a local bare origin), only gh faked.
 * CLI PASS at H0 → formal PM carry H0→one → request at one → update-branch → engine carry one→two → main moves → engine carry
 * two→three → three's own CI → merge pinned to three. A revoked request: no second carry, never merged.
 */
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { manualMergeGate } from "../src/lib/manual-merge-queue-pass.js";
import { RECOVERY_POLICY_PATH, recoveryPolicy } from "../src/lib/recovery-policy.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { testChildEnv } from "./test-env.js";

const PM = "agent-pm", PM_CHANNEL = "777000111", PR = "https://github.com/o/r/pull/7", M = "e".repeat(40);
const MANAGER = resolve("src/manager.ts");
let root = "", work = "", bare = "", h0 = "", one = "", two = "", three = "", main1 = "", main2 = "", main3 = "";

const git = async (cwd: string, ...argv: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...argv], { cwd, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const sh = (...argv: string[]) => git(work, ...argv);
const commit = async (file: string, body: string) => {
  mkdirSync(join(work, file, ".."), { recursive: true });
  writeFileSync(join(work, file), body);
  await sh("add", "-A");
  await sh("commit", "-qm", file);
  return sh("rev-parse", "HEAD");
};
/** origin's main as GitHub holds it, and the local tracking ref the PM's `main-carry --repo-dir` reads */
const originMain = async (sha: string) => { await git(bare, "update-ref", "refs/heads/main", sha); await sh("update-ref", "refs/remotes/origin/main", sha); };

/** h0 = the reviewed head; one / two / three = successive pure merges of main1 / main2 / main3 into it. */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mcry4-mq-")); work = join(root, "work"); bare = join(root, "origin.git");
  await runBounded(["git", "init", "-q", "--bare", "-b", "main", bare], { timeoutMs: 30_000 });
  await runBounded(["git", "init", "-q", "-b", "main", work], { timeoutMs: 30_000 });
  await sh("remote", "add", "origin", "https://github.com/o/r.git");
  await sh("remote", "set-url", "--push", "origin", bare);
  await commit("README.md", "base\n");
  await sh("push", "-q", "origin", "main");
  await sh("checkout", "-qb", "task/T"); h0 = await commit("src/lib/x.ts", "export const x = 1;\n");
  const step = async (n: number) => {
    await sh("checkout", "-q", "main"); const m = await commit(`docs/m${n}.md`, `main ${n}\n`);
    await sh("checkout", "-q", "task/T"); await sh("merge", "-q", "--no-edit", m);
    return [m, await sh("rev-parse", "HEAD")] as const;
  };
  [main1, one] = await step(1); [main2, two] = await step(2); [main3, three] = await step(3);
  await sh("push", "-q", "origin", `${three}:refs/heads/task/T`);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

type Json = Record<string, any>;
async function world() {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const state = mkdtempSync(join(root, "state-")), db: Database = openLedger(join(state, "ledger.sqlite"));
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: { [PM]: { channelId: PM_CHANNEL, projectId: "p" } } }));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [], createdAt: "2026-10-07T00:00:00Z" }] }));
  const policyPath = join(state, "recovery-policy.json"), policy = JSON.stringify({ projects: { p: { keys: { mainCarry: "on", manualMergeQueue: "on" } } } });
  writeFileSync(policyPath, policy);
  writeFileSync(RECOVERY_POLICY_PATH, policy); // the in-process pass (claim gate / drift) reads the test process's own copy
  mkdirSync(join(state, "ledger", "reviews"), { recursive: true });
  setMeta(db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
  const spec = join(state, "T.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now: 2 }, { project: "p", id: "T", title: "T", kind: "code", agent: "agent-author", spec } as never);
  setWorkflow(db, { actor: "owner", now: 3 }, { taskId: "T", taskRev: getTask(db, "T")!.rev, template: "code", templateVersion: 2,
    mode: "manual", authorFamily: "claude", fallback: "人工", reason: "PM 接管，人工审查后合并" });
  db.query("UPDATE tasks SET stage = 'review', round = 1, headSHA = ?, pr = ?, branch = 'task/T', rev = rev + 1 WHERE id = 'T'").run(h0, PR);

  const spawn = async (env: Record<string, string>, args: string[]): Promise<Json> => {
    const p = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", MANAGER, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    try { return JSON.parse(out.trim().split("\n").at(-1) ?? ""); } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };
  const home = join(state, "home"), tmp = join(state, "tmp");
  for (const d of [home, tmp]) mkdirSync(d);
  const base = { HOME: home, TMPDIR: tmp, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run") };
  const pm = (...args: string[]) => spawn(testChildEnv({ ...base, DISCORD_CHANNEL_ID: PM_CHANNEL }), ["ledger", ...args]);
  const singletonPath = join(state, "scheduler.pid"), maintenancePath = join(state, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  const schedulerEnv = testChildEnv({ ...base, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "1",
    CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: singletonPath, token: singleton.token }, maintenance: { path: maintenancePath, token: maintenance.token } }) });
  const children: string[] = [];
  const scheduler = (...args: string[]) => (children.push(args[1]!), spawn(schedulerEnv, args));
  const reader = new LedgerReader(join(state, "ledger.sqlite"));
  cleanup.push(() => { reader.close(); singleton.release(); maintenance.release(); db.close(); rmSync(state, { recursive: true, force: true }); errors.mockRestore(); });

  const gh = { head: one, ci: new Map<string, string>(), merged: false, calls: [] as string[] };
  const next: Record<string, string> = { [one]: two, [two]: three };
  const command: typeof runBounded = async (argv, opts) => {
    const ok = (stdout: unknown) => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "", timedOut: false });
    if (argv[0] === "git") return runBounded(argv[1] === "fetch" ? argv.map((x) => (x === "origin" ? bare : x)) : argv, opts);
    const cmd = argv.slice(1).join(" ");
    gh.calls.push(cmd);
    if (cmd.startsWith("repo view")) return ok({ nameWithOwner: "o/r" });
    if (cmd.startsWith("pr view")) return ok({ state: gh.merged ? "MERGED" : "OPEN", headRefOid: gh.head, headRefName: "task/T", baseRefName: "main",
      isDraft: false, isCrossRepository: false, mergeStateStatus: gh.merged ? "UNKNOWN" : "CLEAN", mergeCommit: gh.merged ? { oid: M } : null });
    if (cmd.startsWith("pr checks")) {
      const ci = gh.ci.get(gh.head) ?? "pending";
      return { code: ci === "pass" ? 0 : 8, stdout: JSON.stringify([{ name: "check", bucket: ci }]), stderr: "", timedOut: false };
    }
    if (cmd.startsWith("api repos/o/r/compare/main...")) {
      const main = await git(bare, "rev-parse", "main");
      const r = await runBounded(["git", "merge-base", "--is-ancestor", main, gh.head], { cwd: bare, timeoutMs: 30_000 });
      return ok({ behind: r.code === 0 ? 0 : 1, main });
    }
    if (cmd === `pr update-branch ${PR}`) { gh.head = next[gh.head]!; return ok(""); }
    if (cmd.startsWith("api -X PUT repos/o/r/pulls/7/merge")) { gh.merged = true; return ok({ merged: true, sha: M }); }
    return { code: 1, stdout: "", stderr: `unexpected gh ${cmd}`, timedOut: false };
  };
  const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["check"], repoDir: work } } });
  const pass = async () => {
    const ro = reader.get()!;
    expect(() => ro.run("UPDATE tasks SET rev = rev WHERE id = 'T'")).toThrow(/readonly/);
    await mergeTick(ro, config, scheduler, (p) => mergeExternal(p, command), () => {});
  };
  return { state, db, pm, scheduler, reader, policyPath, gh, config, pass, children };
}

const events = (db: Database) => listEvents(db, { project: "p", target: "T" });

/** PR775 shape up to the second update-branch: PASS at h0 by the PM, formal carry h0→one, request at one, claimed; the run updates
 * to two, the engine carries one→two, two's CI goes green, main moves, update-branch again → three. */
async function toSecondUpdate(w: Awaited<ReturnType<typeof world>>) {
  await originMain(main1);
  const findings = join(w.state, "findings.json"), report = join(w.state, "ledger", "reviews", "T.md");
  writeFileSync(findings, "[]");
  writeFileSync(report, `# 审查 T\n\nhead ${h0}\n\nPASS\n`);
  expect(await w.pm("review", "T", "--reviewer", "agent-review", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0", "--head", h0,
    "--session", "rs-T", "--family", "codex", "--findings", findings, "--path", report, "--to", "merge")).toMatchObject({ ok: true });
  const seq = events(w.db).findLast((e) => e.kind === "review")!.seq;
  const t = () => getTask(w.db, "T")!;
  expect(await w.pm("main-carry", "T", "--old", h0, "--new", one, "--main", main1, "--spec-rev", String(t().specRev), "--round", "1",
    "--review-seq", String(seq), "--rev", String(t().rev), "--repo-dir", work)).toMatchObject({ ok: true, status: "carried", plan: { sourceKind: "cli" } });
  const req = await w.pm("manual-merge-request", "T", "--head", one, "--spec-rev", String(t().specRev), "--round", "1", "--review-seq", String(seq),
    "--reason", "PM 正式沿用后排队合并");
  expect(req).toMatchObject({ ok: true, state: "queued" });
  const ro = w.reader.get()!;
  const gate = manualMergeGate(ro, null, (p, k) => recoveryPolicy(p, k, w.policyPath));
  expect(await gate.claim(w.scheduler, w.config)).toEqual({ claimed: ["T"], failed: [] });
  const intent = (ro.query("SELECT id, node FROM scheduler_intents WHERE action = 'merge' AND status IN ('pending','submitted')").get() as { id: string; node: string });
  expect(intent.node).toBe("manual_merge");
  const run = () => getMergeRun(w.db, intent.id)!;
  const carries = () => events(w.db).filter((e) => e.data.op === "review_carry");
  await originMain(main2);
  await w.pass(); // begin at `one`, behind main2 → update-branch → two
  expect(run()).toMatchObject({ phase: "updating", reviewedHead: one });
  await w.pass(); // engine carry one → two under the manual intent
  expect(run()).toMatchObject({ phase: "await_ci", reviewedHead: two });
  w.gh.ci.set(two, "pass");
  await originMain(main3);
  await w.pass(); // two's CI green but main moved: update-branch again → three
  expect(run()).toMatchObject({ phase: "updating", reviewedHead: two });
  return { seq, request: Number(req.request), intent: intent.id, run, carries };
}

test("MCRY4 manual run: the PM request's own source carries one→two→three by the engine, merged at three after its own CI", async () => {
  const w = await world();
  const { seq, intent, run, carries } = await toSecondUpdate(w);
  await w.pass(); // the repeated engine carry two → three, still read through the PM request
  expect(run()).toMatchObject({ phase: "await_ci", reviewedHead: three });
  expect(carries().map((e) => [e.data.from, e.data.to, e.data.sourceReviewSeq, e.data.intentId])).toEqual([[one, two, seq, intent], [two, three, seq, intent]]);
  await w.pass(); // three has no CI of its own yet
  expect(run().phase).toBe("await_ci");
  expect(w.gh.calls.some((c) => c.includes("/merge "))).toBe(false);
  w.gh.ci.set(three, "pass");
  await w.pass();
  expect(run()).toMatchObject({ phase: "merged", reviewedHead: three });
  expect(w.gh.calls.filter((c) => c.includes("/merge "))).toEqual([`api -X PUT repos/o/r/pulls/7/merge -f sha=${three} -f merge_method=merge`]);
  expect(w.children.every((c) => c.startsWith("scheduler-") || c.startsWith("manual-merge-"))).toBe(true);
}, 240_000);

test("MCRY4 manual run: the PM revokes the request before the second carry → no second carry, never merged", async () => {
  const w = await world();
  const { request, run, carries } = await toSecondUpdate(w);
  expect(Number.isSafeInteger(request)).toBe(true);
  expect(await w.pm("manual-merge-revoke", "T", "--request", String(request), "--reason", "撤回")).toMatchObject({ ok: true });
  w.gh.ci.set(three, "pass");
  for (let i = 0; i < 2; i++) await w.pass().catch(() => {}); // how the driver ends a refused run is scheduler-merge-driver.ts's
  expect(carries()).toHaveLength(1);
  expect(getTask(w.db, "T")!.headSHA).toBe(two);
  expect(run().phase).not.toBe("merged");
  expect(w.gh.calls.some((c) => c.includes("/merge "))).toBe(false);
}, 240_000);
