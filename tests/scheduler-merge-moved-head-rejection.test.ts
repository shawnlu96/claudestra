/**
 * MCRY5 · `updating` meets a moved head and the ledger's canonical source gate refuses the carry (scheduler-merge-driver.ts
 * driveMerge). Before MCRY5 the branch returned movedHead's promise un-awaited, so the advance rejection skipped the driver's own
 * catch, escaped mergeTick and aborted the whole scheduler pass: no unknown receipt, no auto tick for any other card.
 * Wired as src/scheduler-pass.ts runs it (the MCRY4 shape, tests/review-main-carry-auto-source-e2e.test.ts): a real temp ledger, a
 * pooled PASS through the real lend CLI on A and lending side B, mergeTick over a query_only LedgerReader whose every write is a real
 * `manager.ts ledger` child under the scheduler identity and lease, then the auto tick. Git is real; only gh is faked.
 * Now: the refusal lands in the original catch → formal unknown with the real reason kept, the pass completes and its auto tick
 * still judges T2 / T3 (waiting on the frozen queue, not forced; restate planned once the PM resolves and unfreezes);
 * a trusted carry still reaches await_ci; SchedulerStopped still propagates with zero later effects.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getMeta, getTask, listEvents } from "../src/lib/ledger-store.js";
import { createTask, setFrozen } from "../src/lib/ledger-write.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { parseSchedulerConfig, type RemotePolicy } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { getMergeRun, type MergeRun } from "../src/lib/scheduler-merge.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { aResultDeps, B_WORKER, lendSide } from "./pool-review-proof-helpers.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";
import { testChildEnv } from "./test-env.js";

const MANAGER = resolve("src/manager.ts"), PR = "https://github.com/o/r/pull/7", M = "e".repeat(40);
const REMOTE: RemotePolicy = { mode: "overflow", roles: ["review"], poolTimeoutMin: 15 };
let root = "", work = "", bare = "", reviewed = "", merged1 = "", merged2 = "", main1 = "", main2 = "";

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
const originMain = (sha: string) => git(bare, "update-ref", "refs/heads/main", sha);

/** reviewed = the pooled PASS's head; merged1 / merged2 = update-branch's pure merges of main1 / main2 into it. */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mcry5-e2e-"));
  work = join(root, "work"); bare = join(root, "origin.git");
  await runBounded(["git", "init", "-q", "--bare", "-b", "main", bare], { timeoutMs: 30_000 });
  await runBounded(["git", "init", "-q", "-b", "main", work], { timeoutMs: 30_000 });
  await sh("remote", "add", "origin", "https://github.com/o/r.git");
  await sh("remote", "set-url", "--push", "origin", bare);
  await commit("README.md", "base\n");
  await sh("push", "-q", "origin", "main");
  await sh("checkout", "-qb", "task/T1");
  reviewed = await commit("src/lib/x.ts", "export const x = 1;\n");
  await sh("checkout", "-q", "main"); main1 = await commit("docs/one.md", "main one\n");
  await sh("checkout", "-q", "task/T1"); await sh("merge", "-q", "--no-edit", main1); merged1 = await sh("rev-parse", "HEAD");
  await sh("checkout", "-q", "main"); main2 = await commit("docs/two.md", "main two\n");
  await sh("checkout", "-q", "task/T1"); await sh("merge", "-q", "--no-edit", main2); merged2 = await sh("rev-parse", "HEAD");
  await sh("push", "-q", "origin", `${merged2}:refs/heads/task/T1`);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

type CI = "pass" | "fail" | "pending";

/** T1 auto, its round-1 PASS from the pool at `reviewed`, the merge intent planned. */
async function world() {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const f = autoFixture();
  cleanup.push(() => { f.close(); errors.mockRestore(); });
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ?, pr = ?, branch = 'task/T1' WHERE id = 'T1'", [spec, PR]);
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 1 }];
  const b = lendSide(f.dir), a = aResultDeps(f.dir, b.pinned);
  const lend = { borrow: async () => borrow, notifyPm: async () => {}, result: a.result };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const autoDeps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const autoTick = async (maxActiveWorkers: number) => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers, remote: REMOTE } }, autoDeps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards;
  };
  const peer = (ep: string, body: unknown) => cli("owner", `lend-${ep}`, "--", "mate", JSON.stringify(body));
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", reviewed);
  expect((await autoTick(0))[0]).toMatchObject({ step: "pool_pooled" });
  const order = listLendOrders(f.db, "T1").at(-1)!;
  const claim = await peer("claim", { v: 1, orderId: order.orderId, worker: B_WORKER });
  expect((await b.answer(claim as never, { verdict: "pass", findings: [], report: "## 通过\n" }, (body) => peer("write", body))).r).toMatchObject({ ok: true });
  expect((await autoTick(0))[0]).toMatchObject({ step: "pool_done" });
  expect((await autoTick(0))[0]).toMatchObject({ step: "stage", detail: "review→merge" });
  expect((await autoTick(0))[0]).toMatchObject({ step: "merge_queue" });
  const intent = (f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge'").get() as { id: string }).id;

  /** Two new auto cards the pass that meets the refusal must still judge (restate once the queue is open). */
  const newCards = async () => {
    const registry = JSON.parse(await Bun.file(f.registryPath).text());
    for (const id of ["T2", "T3"]) {
      const agent = `agent-${id.toLowerCase()}`;
      registry.agents[agent] = { runtime: "claude-code", sessionId: `s-${id}`, cwd: f.dir, channelId: `ch-${id}` };
      createTask(f.db, { actor: "owner", now: Date.now() }, { project: "p", id, title: id, kind: "code", agent, extra: { fileGlobs: [`src/${id}.ts`] } });
      setWorkflow(f.db, { actor: "owner", now: Date.now() }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "只报错不修" });
    }
    writeFileSync(f.registryPath, JSON.stringify(registry));
  };

  const singletonPath = join(f.dir, "scheduler.pid"), maintenancePath = join(f.dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  const home = join(f.dir, "home");
  mkdirSync(home);
  const env = testChildEnv({ HOME: home, TMPDIR: f.dir, CLAUDESTRA_STATE_DIR: f.dir, CLAUDESTRA_RUNTIME_DIR: join(f.dir, "run"), DISCORD_CHANNEL_ID: "",
    CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: singletonPath, token: singleton.token },
      maintenance: { path: maintenancePath, token: maintenance.token } }) });
  const children: string[] = [];
  const manager = async (...args: string[]) => {
    children.push(args[1]!);
    const p = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", MANAGER, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    try { return JSON.parse(out.trim().split("\n").at(-1) ?? "") as Record<string, unknown>; } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  cleanup.push(() => { reader.close(); singleton.release(); maintenance.release(); });

  const gh = { head: reviewed, ci: new Map<string, CI>([[reviewed, "pass"]]), merged: false, calls: [] as string[] };
  const next: Record<string, string> = { [reviewed]: merged1, [merged1]: merged2 };
  const command: typeof runBounded = async (argv, opts) => {
    const ok = (stdout: unknown) => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "", timedOut: false });
    if (argv[0] === "git") return runBounded(argv[1] === "fetch" ? argv.map((x) => (x === "origin" ? bare : x)) : argv, opts);
    const cmd = argv.slice(1).join(" ");
    gh.calls.push(cmd);
    if (cmd.startsWith("repo view")) return ok({ nameWithOwner: "o/r" });
    if (cmd.startsWith("pr view")) return ok({ state: gh.merged ? "MERGED" : "OPEN", headRefOid: gh.head, headRefName: "task/T1", baseRefName: "main",
      isDraft: false, isCrossRepository: false, mergeStateStatus: gh.merged ? "UNKNOWN" : "CLEAN", mergeCommit: gh.merged ? { oid: M } : null });
    if (cmd.startsWith("pr checks")) {
      const ci = gh.ci.get(gh.head) ?? "pending";
      return { code: ci === "pass" ? 0 : ci === "fail" ? 1 : 8, stdout: JSON.stringify([{ name: "check", bucket: ci }]), stderr: "", timedOut: false };
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
  const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 3, requiredChecks: ["check"], repoDir: work, remote: REMOTE } } });
  /** One scheduler pass in production order: the merge driver, then the auto tick for every other card. */
  const pass = async (active: () => void = () => {}) => {
    const ro = reader.get()!;
    expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
    await mergeTick(ro, config, manager, (p) => mergeExternal(p, command), active);
    return autoTick(3);
  };
  const run = () => getMergeRun(f.db, intent)!;
  const carries = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "review_carry");
  const sent = () => gh.calls.filter((c) => c.includes("update-branch") || c.includes("/merge "));
  const restated = () => (f.db.query("SELECT DISTINCT taskId FROM scheduler_intents WHERE taskId IN ('T2','T3') AND node = 'restate' ORDER BY taskId")
    .all() as { taskId: string }[]).map((r) => r.taskId);
  return { f, order, intent, gh, pass, run, carries, sent, children, restated, newCards, cli };
}
type World = Awaited<ReturnType<typeof world>>;

/** pass 1 updates against main1, pass 2 carries reviewed → merged1 from `updating` (the trusted carry), its CI goes green, main
 * moves to main2, pass 3 refreshes → `updating` with the PR at merged2: the next pass is `updating` meeting a moved head. */
async function toSecondUpdate(w: World) {
  await originMain(main1);
  await w.pass();
  expect(w.run()).toMatchObject({ phase: "updating", reviewedHead: reviewed });
  await w.pass();
  expect(w.run()).toMatchObject({ phase: "await_ci", reviewedHead: merged1 });
  expect(w.carries().map((e) => [e.data.from, e.data.to])).toEqual([[reviewed, merged1]]);
  w.gh.ci.set(merged1, "pass");
  await originMain(main2);
  await w.pass();
  expect(w.run()).toMatchObject({ phase: "updating", reviewedHead: merged1 });
  expect(w.gh.head).toBe(merged2);
}

const GATE = "沿用时正式来源审查门不成立（来源 / 家族 / 豁免已变）：";
const spoil: [string, string, (w: World) => void][] = [
  ["the source order revoked", "当前 head 缺同卡跨模型审查通过结论或仍有 P0/P1",
    (w) => w.f.db.run("UPDATE lend_orders SET status = 'cancelled' WHERE orderId = ?", [w.order.orderId])],
  ["the order's lease gen drifted", "出借池审查回执不成立：结论的提供方 / 会话 / 家族 / 租约代数与出借单",
    (w) => w.f.db.run("UPDATE lend_orders SET leaseGen = leaseGen + 3 WHERE orderId = ?", [w.order.orderId])],
];

describe("MCRY5 e2e: updating meets a moved head and the canonical source gate refuses the carry", () => {
  for (const [name, why, change] of spoil) {
    test(`旧红新绿：${name} → this run's catch writes a formal unknown, the pass completes, T2 / T3 still planned`, async () => {
      const w = await world();
      await toSecondUpdate(w);
      await w.newCards();
      change(w);
      w.gh.ci.set(merged2, "pass");
      const carriesBefore = w.carries().map((e) => e.seq), sentBefore = w.sent();
      const cards = await w.pass(); // before MCRY5 this rejected with the gate's refusal and the auto tick never ran
      const r = w.run();
      expect(r).toMatchObject({ phase: "unknown", reviewedHead: merged1, mergeSha: null });
      expect(r.reason).toStartWith(`外部步骤失败：advance merge run: ${GATE}`);
      expect(r.reason).toContain(why); // the real refusal is kept, not rewritten
      // the auto tick ran in this same pass: T2 / T3 are judged, and wait on the frozen queue instead of being forced through
      expect(cards.filter((c) => c.taskId !== "T1").map((c) => [c.taskId, c.step, c.detail])).toEqual([
        ["T2", "waiting", "项目队列已冻结，不派新活"], ["T3", "waiting", "项目队列已冻结，不派新活"]]);
      // no carry, no fake source, no PASS, no merge: only the unknown receipt was written for this run
      expect(w.carries().map((e) => e.seq)).toEqual(carriesBefore);
      expect(getTask(w.f.db, "T1")).toMatchObject({ headSHA: merged1, stage: "merge" });
      expect(listEvents(w.f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "review")).toHaveLength(1);
      expect(w.sent()).toEqual(sentBefore);
      expect(getIntent(w.f.db, w.intent)!.status).toBe("submitted"); // not settled as done: the PM resolves the unknown
      expect(getMeta(w.f.db, "p").queueFrozen.frozen).toBe(true); // the merge queue is not pushed past the unknown
      expect(w.children.every((c) => c.startsWith("scheduler-"))).toBe(true);
      // the next pass neither retries the carry nor re-sends anything; it completes as well
      await w.pass();
      expect(w.run()).toMatchObject({ phase: "unknown", rev: r.rev });
      expect(w.sent()).toEqual(sentBefore);
      // the PM's formal path still works: resolve the unknown, unfreeze → T2 / T3 get restate planned on the next pass
      expect(await w.cli("owner", "scheduler-merge-resolve", w.intent, "--outcome", "cancelled", "--receipt", "GitHub 核对：PR 未合并"))
        .toMatchObject({ ok: true, run: { phase: "resolved" } });
      setFrozen(w.f.db, { actor: "owner" }, { project: "p", frozen: false, reason: "核对无其他 unknown" });
      expect(w.restated()).toEqual([]);
      await w.pass();
      expect(w.restated()).toEqual(["T2", "T3"]);
      expect(w.sent()).toEqual(sentBefore);
    }, 240_000);
  }

  test("a trusted second carry from updating still reaches await_ci (and merges after its own CI)", async () => {
    const w = await world();
    await toSecondUpdate(w);
    await w.pass();
    expect(w.run()).toMatchObject({ phase: "await_ci", reviewedHead: merged2 });
    expect(w.carries().map((e) => [e.data.from, e.data.to])).toEqual([[reviewed, merged1], [merged1, merged2]]);
    w.gh.ci.set(merged2, "pass");
    await w.pass();
    expect(w.run()).toMatchObject({ phase: "merged", reviewedHead: merged2, mergeSha: M });
  }, 240_000);

  test("lease lost at the carry: SchedulerStopped still escapes the pass, zero later effects", async () => {
    const w = await world();
    await toSecondUpdate(w);
    await w.newCards();
    const before = { run: w.run(), carries: w.carries().length, children: w.children.length, sent: w.sent() };
    await expect(w.pass(() => { throw new SchedulerStopped("lease lost"); })).rejects.toBeInstanceOf(SchedulerStopped);
    expect(w.run()).toEqual(before.run);
    expect(w.carries()).toHaveLength(before.carries);
    expect(w.children).toHaveLength(before.children); // no ledger child at all after the stop
    expect(w.sent()).toEqual(before.sent);
    expect(w.restated()).toEqual([]); // the auto tick did not run in the stopped pass
  }, 240_000);
});

// Driver unit, the ledger stubbed: what `updating` does with a moved head and each kind of failure.
const OLD = "a".repeat(40), NEW = "c".repeat(40);
const snap: PrSnapshot = { state: "OPEN", head: NEW, branch: "task/T1", base: "main", draft: false, crossRepository: false,
  mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }] };
const run0: MergeRun = { intentId: "a1", taskId: "T1", project: "p", prRef: PR, expectedBranch: "task/T1", reviewedHead: OLD, requiredChecks: "check",
  phase: "updating", rev: 3, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 };
async function drive(refuse: (to: MergeRun["phase"]) => Error | null, active: () => void = () => {}, start = run0) {
  let row = start;
  const journal: string[] = [], effects: string[] = [];
  const external: MergeExternal = {
    inspect: async () => { effects.push("inspect"); return snap; }, freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }),
    carryReview: async () => ({ ok: true, reason: "纯 main", mainParent: "d".repeat(40), mainHead: "e".repeat(40), diffHash: "f".repeat(64) }),
    updateBranch: async () => { effects.push("update"); }, merge: async () => { effects.push("merge"); return M; },
  };
  const advance = async (from: MergeRun["phase"], to: MergeRun["phase"], rev: number, receipt?: string, _sha?: string, newHead?: string) => {
    journal.push(`${from}→${to}`);
    const e = refuse(to);
    if (e) throw e;
    row = { ...row, phase: to, rev: rev + 1, reason: receipt ?? null, reviewedHead: to === "await_ci" && newHead ? newHead : row.reviewedHead };
    return row;
  };
  const out = await driveMerge(start, external, advance, active);
  return { out, journal, effects };
}

test("MCRY5 driver at updating: a refused carry resolves to unknown with the ledger's reason; a granted one is await_ci", async () => {
  const gate = new Error(`advance merge run: ${GATE}当前 head 缺同卡跨模型审查通过结论或仍有 P0/P1`);
  const refused = await drive((to) => (to === "await_ci" ? gate : null));
  expect(refused.journal).toEqual(["updating→await_ci", "updating→unknown"]);
  expect(refused.out).toMatchObject({ phase: "unknown", reviewedHead: OLD });
  expect(refused.out.reason).toBe(`外部步骤失败：${gate.message}`);
  expect((await drive(() => null)).out).toMatchObject({ phase: "await_ci", reviewedHead: NEW });
});

test("MCRY5 driver at updating: SchedulerStopped from the advance or assertActive propagates with no further step", async () => {
  const fromAdvance = drive((to) => (to === "await_ci" ? new SchedulerStopped("lease lost") : null));
  await expect(fromAdvance).rejects.toBeInstanceOf(SchedulerStopped);
  const journal: string[] = [];
  await expect(drive((to) => { journal.push(to); return null; }, () => { throw new SchedulerStopped("stopped"); })).rejects.toBeInstanceOf(SchedulerStopped);
  expect(journal).toEqual([]); // assertActive runs before any advance
});

test("MCRY5 driver: an unknown-error at the unknown write itself is not swallowed as success; merging is never re-sent", async () => {
  const both = new Error("ledger busy");
  await expect(drive(() => both)).rejects.toThrow("ledger busy"); // carry and its unknown both refused: no fake result
  const merging = await drive(() => null, () => {}, { ...run0, phase: "merging", reviewedHead: NEW });
  expect(merging.out).toMatchObject({ phase: "unknown", reason: "合并曾发出但未能核实结果，不重复 gh pr merge" });
  expect(merging.effects).toEqual(["inspect"]);
});
