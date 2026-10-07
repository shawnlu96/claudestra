/**
 * MCRY4 · the MRY1 shape end to end, wired as src/scheduler-pass.ts runs it: a real temp ledger, the real lend CLI on A and a real
 * lending side B (pool-review-proof-helpers.ts) for the pooled PASS, then each scheduler pass = mergeTick over a query_only
 * LedgerReader (every write a real `manager.ts ledger` child under the scheduler identity and lease, temp HOME / TMPDIR / state dir)
 * followed by the auto tick. Git runs for real (canonical pure-main proof, fetch served from a local bare origin); only gh is faked
 * (calls, CI per head, and the merge API's pinned sha recorded). pool PASS → update-branch → first carry → main moves → second
 * carry (refused before MCRY4: no pooled reviewer on the carried head) → the new head's own CI → merge pinned to it, while two new
 * cards keep being planned through restate. Negatives: red / pending CI, a revoked or re-pointed source order, an author delivery.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { failureReason } from "../src/lib/lend-health.js";
import { recordAsked } from "../src/lib/lend-journal.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getMeta, getTask, listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { parseSchedulerConfig, type RemotePolicy } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { mergeTick } from "../src/lib/scheduler-service.js";
import { aResultDeps, B_WORKER, lendSide } from "./pool-review-proof-helpers.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";
import { testChildEnv } from "./test-env.js";

const MANAGER = resolve("src/manager.ts"), PR = "https://github.com/o/r/pull/7", M = "e".repeat(40);
const REMOTE: RemotePolicy = { mode: "overflow", roles: ["review"], poolTimeoutMin: 15 };
const HE = "he-codex", PB = "pb-claude"; // MCRY6 MODELX: the provider-refused peer and the same-family peer the engine re-pools to
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
/** origin's main, as GitHub would hold it */
const originMain = (sha: string) => git(bare, "update-ref", "refs/heads/main", sha);

/** reviewed = the pooled PASS's head; merged1 = update-branch's pure merge of main1 into it; merged2 = the next one, of main2. */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mcry4-e2e-"));
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
  await sh("push", "-q", "origin", `${merged2}:refs/heads/task/T1`); // every object on origin; main itself is moved by originMain
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

type CI = "pass" | "fail" | "pending";

/** T1 auto, its round-1 PASS from the pool at `reviewed`, the merge intent planned; T2 / T3 fresh auto cards in spec.
 * `modelx` (MCRY6): HE's codex refuses the order by provider policy, the engine re-pools under the owner's standing refusal-rule
 * approval to PB's claude, and that same-family exempt PASS is the source (ledger-pool-refusal-prod.test.ts shape, in-process). */
async function world(modelx = false) {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const f = autoFixture();
  cleanup.push(() => { f.close(); errors.mockRestore(); });
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ?, pr = ?, branch = 'task/T1' WHERE id = 'T1'", [spec, PR]);
  const to = modelx ? PB : "mate";
  const borrow: BorrowEntry[] = (modelx ? [HE, PB] : [to]).map((peer) => ({ peer, projects: ["p"], roles: ["review"], maxOpen: modelx ? 2 : 1 }));
  const b = lendSide(f.dir), a = aResultDeps(f.dir, b.pinned);
  const lend = { borrow: async () => borrow, notifyPm: async () => {}, result: a.result };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const autoDeps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const autoTick = async (maxActiveWorkers: number) => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers, remote: REMOTE } }, autoDeps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards;
  };
  const peer = (ep: string, body: unknown, name = to) => cli("owner", `lend-${ep}`, "--", name, JSON.stringify(body));
  /** The owner's answer on the refusal rule through the canonical ask transaction: `_go` approves, anything else revokes. */
  const ownerRule = (button: string) => { const at = Date.now(), ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule",
    askKey: "policy-refusal-rule" }, at); answerAsk(f.db, ask.id, { choices: [`[button:${button}]`], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID,
    owner: true, via: "web_card", at: at + 1, final: true }); };
  if (modelx) {
    const policy = JSON.stringify({ projects: { p: { keys: { modelOutcome: "on" } } } }), shared = join(STATE_DIR, "ledger.sqlite");
    for (const at of [join(f.dir, "recovery-policy.json"), RECOVERY_POLICY_PATH]) writeFileSync(at, policy);
    rmSync(shared, { force: true }); symlinkSync(join(f.dir, "ledger.sqlite"), shared); // the pool tick's own reader (scheduler-pool-tick.ts)
    cleanup.push(() => { rmSync(shared, { force: true }); rmSync(RECOVERY_POLICY_PATH, { force: true }); });
    for (const [name, codex, claude] of [[HE, 2, 0], [PB, 0, 2]] as const) recordHello(f.db, name, null, { v: 1, proto: 2, boot: "b", seq: 1, paused: null,
      slots: { codex: { total: codex, busy: 0 }, claude: { total: claude, busy: 0 } },
      grant: { until: Date.now() + 3_600_000, roles: ["review"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, Date.now());
    ownerRule("policy_refusal_rule_go");
  }
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", reviewed);
  expect((await autoTick(0))[0]).toMatchObject({ step: "pool_pooled" });
  if (modelx) {
    const first = listLendOrders(f.db, "T1")[0]!;
    expect(first).toMatchObject({ peer: HE, family: "codex" });
    const held = await peer("claim", { v: 1, orderId: first.orderId, worker: "w1" }, HE) as { lease: { gen: number } };
    expect(await peer("lease", { v: 1, orderId: first.orderId, gen: held.lease.gen, action: "release", reason: "stopped", detail: failureReason({ kind: "error",
      askId: "a", message: "flagged for possible cybersecurity risk" }), failure: { class: "provider_policy", sessionId: "thr-1", failedAt: 5_000 } }, HE)).toMatchObject({ ok: true });
    expect((await autoTick(0))[0]).toMatchObject({ step: "pool_refusal" });
    expect((await autoTick(0))[0]).toMatchObject({ step: "pool_pooled" });
  }
  const order = listLendOrders(f.db, "T1").at(-1);
  const claim = await peer("claim", { v: 1, orderId: order!.orderId, worker: B_WORKER });
  if (modelx) recordAsked(b.db, { orderId: order!.orderId, peer: "home", fp: null, family: "claude", preview: {} }, 1); // B asked as PB's claude
  expect((await b.answer(claim as never, { verdict: "pass", findings: [], report: "## 通过\n" }, (body) => peer("write", body),
    modelx ? { takeFamily: "claude-code", submitFamily: "claude-code" } : {})).r).toMatchObject({ ok: true });
  expect((await autoTick(0))[0]).toMatchObject({ step: "pool_done" });
  expect((await autoTick(0))[0]).toMatchObject({ step: "stage", detail: "review→merge" });
  expect((await autoTick(0))[0]).toMatchObject({ step: "merge_queue" });
  const intent = (f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge'").get() as { id: string }).id;
  const reviewSeq = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "review")!.seq;

  /** Two new auto cards the passes after the second carry must keep planning (MRY1: the refused carry stalled every pass after it). */
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

  // The scheduler service's write path: `manager.ts ledger …` children, scheduler identity, its lease, this state dir.
  const singletonPath = join(f.dir, "scheduler.pid"), maintenancePath = join(f.dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  const home = join(f.dir, "home");
  mkdirSync(home);
  // TMPDIR covers the state / runtime dirs: under a private temp root the children's test-guard would otherwise redirect them (fixture-tmp-1)
  const base = { HOME: home, TMPDIR: f.dir, CLAUDESTRA_STATE_DIR: f.dir, CLAUDESTRA_RUNTIME_DIR: join(f.dir, "run"), DISCORD_CHANNEL_ID: "" };
  const env = testChildEnv({ ...base,
    CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: singletonPath, token: singleton.token },
      maintenance: { path: maintenancePath, token: maintenance.token } }) });
  const children: string[] = [];
  const manager = async (...args: string[]) => {
    children.push(args[1]!);
    const p = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", MANAGER, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    try { return JSON.parse(out.trim().split("\n").at(-1) ?? "") as Record<string, unknown>; } catch { return { ok: false, code: "child", error: `${out}\n${err}`.trim() }; }
  };
  /** MCRY7: an owner terminal `manager.ts ledger` child (no channel, no lease), run to completion inside the driver's synchronous assertActive */
  const ownerSync = (...args: string[]): Record<string, unknown> => JSON.parse(new TextDecoder().decode(Bun.spawnSync([process.execPath, "--no-env-file",
    "--config=/dev/null", MANAGER, "ledger", ...args], { env: testChildEnv(base) }).stdout).trim().split("\n").at(-1) ?? "");
  const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
  cleanup.push(() => { reader.close(); singleton.release(); maintenance.release(); });

  // Fake gh: the PR's head, each head's own CI, the merge API's pinned sha. git is real (fetch maps origin to the bare repo).
  const gh = { head: reviewed, ci: new Map<string, CI>([[reviewed, "pass"]]), merged: false, calls: [] as string[] };
  const next: Record<string, string> = { [reviewed]: merged1, [merged1]: merged2 }; // what update-branch produces against origin's main
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
  /** One scheduler pass in production order: the merge driver, then the auto tick for every other card. `active`: the driver's
   * assertActive, which it calls right after each step it journaled (MCRY6: after the `merging` claim returns, before the API). */
  const pass = async (active: () => void = () => {}) => {
    const ro = reader.get()!;
    expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
    await mergeTick(ro, config, manager, (p) => mergeExternal(p, command), active);
    await autoTick(3);
  };
  const run = () => getMergeRun(f.db, intent)!;
  const carries = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "review_carry");
  const sent = () => gh.calls.filter((c) => c.includes("update-branch") || c.includes("/merge "));
  const restated = () => (f.db.query("SELECT DISTINCT taskId FROM scheduler_intents WHERE taskId IN ('T2','T3') AND node = 'restate' ORDER BY taskId")
    .all() as { taskId: string }[]).map((r) => r.taskId);
  return { f, order: order!, intent, reviewSeq, gh, pass, run, carries, sent, children, restated, newCards, ownerRule, cli, borrow, ownerSync };
}
type World = Awaited<ReturnType<typeof world>>;

/** pass 1 claims + updates against main1, pass 2 carries reviewed → merged1 (first carry), its CI goes green, main moves to main2,
 * pass 3 refreshes (update-branch again) → merged2. */
async function toSecondUpdate(w: World) {
  await originMain(main1);
  await w.pass();
  expect(w.run()).toMatchObject({ phase: "updating", reviewedHead: reviewed });
  expect(w.gh.head).toBe(merged1);
  await w.pass();
  expect(w.run()).toMatchObject({ phase: "await_ci", reviewedHead: merged1 });
  expect(getTask(w.f.db, "T1")!.headSHA).toBe(merged1);
  w.gh.ci.set(merged1, "pass");
  await originMain(main2);
  await w.pass();
  expect(w.run()).toMatchObject({ phase: "updating", reviewedHead: merged1 });
  expect(w.gh.head).toBe(merged2);
}

describe("MCRY4 e2e: a pooled PASS through two engine carries, merged at the new head after its own CI", () => {
  test("旧红新绿：pool PASS → carry → main moves → second carry → new head's CI pending (no merge) → green → merge pinned to it; T2 / T3 keep restating", async () => {
    const w = await world();
    await toSecondUpdate(w);
    await w.newCards();
    expect(w.restated()).toEqual([]);
    await w.pass(); // the second carry: before MCRY4 the in-transaction source gate found no pooled reviewer on merged1 and refused
    expect(w.run()).toMatchObject({ phase: "await_ci", reviewedHead: merged2 });
    expect(getTask(w.f.db, "T1")).toMatchObject({ headSHA: merged2, stage: "merge" });
    expect(w.carries().map((e) => [e.actor, e.data.from, e.data.to, e.data.sourceReviewSeq, e.data.intentId])).toEqual([
      ["scheduler", reviewed, merged1, w.reviewSeq, w.intent], ["scheduler", merged1, merged2, w.reviewSeq, w.intent]]);
    expect(w.order).toMatchObject({ head: reviewed }); // the pool order, ticket and session stay bound to the reviewed head
    expect(listLendOrders(w.f.db, "T1")[0]).toMatchObject({ head: reviewed, status: "done" });
    await w.pass(); // merged2 has no CI result of its own yet: merged1's green does not count
    expect(w.run()).toMatchObject({ phase: "await_ci", reviewedHead: merged2 });
    expect(w.sent()).toEqual([`pr update-branch ${PR}`, `pr update-branch ${PR}`]);
    w.gh.ci.set(merged2, "pass");
    await w.pass();
    expect(w.run()).toMatchObject({ phase: "merged", reviewedHead: merged2, mergeSha: M });
    expect(w.sent()).toEqual([`pr update-branch ${PR}`, `pr update-branch ${PR}`, `api -X PUT repos/o/r/pulls/7/merge -f sha=${merged2} -f merge_method=merge`]);
    expect(w.children.every((c) => c.startsWith("scheduler-"))).toBe(true);
    expect(w.restated()).toEqual(["T2", "T3"]);
  }, 240_000);

  test("the new head's own CI red: no merge is sent and the run leaves the queue; both carries stand, T2 / T3 still restate", async () => {
    const w = await world();
    await toSecondUpdate(w);
    await w.newCards();
    w.gh.ci.set(merged2, "fail");
    await w.pass();
    expect(w.run()).toMatchObject({ phase: "resolved", reviewedHead: merged2 }); // CIF3: the carried head's required red goes straight back to fix
    expect(getTask(w.f.db, "T1")!.stage).toBe("fix");
    expect(getMeta(w.f.db, "p").queueFrozen.frozen).toBe(false);
    expect(listEvents(w.f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "merge_conflict").map((e) => [e.data.cause, e.data.prHead]))
      .toEqual([["ci_fail", merged2]]);
    expect(w.carries()).toHaveLength(2);
    expect(w.sent()).toEqual([`pr update-branch ${PR}`, `pr update-branch ${PR}`]);
    expect(w.restated()).toEqual(["T2", "T3"]);
  }, 240_000);

  const GATE = "advance merge run: 沿用时正式来源审查门不成立（来源 / 家族 / 豁免已变）：";
  const noPass = new RegExp(`^${GATE}当前 head 缺同卡跨模型审查通过结论或仍有 P0/P1$`);
  /** [name, the exact refusal every pass rejects with (null: the zero-exception path), the change] */
  const spoil: [string, RegExp | null, (w: World) => void][] = [
    ["the source order revoked (no longer done)", noPass, (w) => w.f.db.run("UPDATE lend_orders SET status = 'cancelled' WHERE orderId = ?", [w.order.orderId])],
    ["the source order re-pointed at the carried head", noPass, (w) => w.f.db.run("UPDATE lend_orders SET head = ? WHERE orderId = ?", [merged1, w.order.orderId])],
    ["the order's lease gen drifted", new RegExp(`^${GATE}出借池审查回执不成立：结论的提供方 / 会话 / 家族 / 租约代数与出借单 \\S+ 不一致`),
      (w) => w.f.db.run("UPDATE lend_orders SET leaseGen = leaseGen + 3 WHERE orderId = ?", [w.order.orderId])],
    ["the author delivered after the review", null, (w) => insertEvent(w.f.db, { actor: "agent-task-one", now: Date.now() },
      { project: "p", target: "T1", kind: "deliver", text: "", data: { headSHA: merged1 } }, false)],
  ];
  for (const [name, refusal, change] of spoil) {
    test(`second carry refused, zero carry writes, never merged: ${name}`, async () => {
      const w = await world();
      await toSecondUpdate(w);
      change(w);
      w.gh.ci.set(merged2, "pass");
      const before = w.carries().map((e) => e.seq);
      // The refusal is the ledger's in-transaction source gate; today it escapes mergeTick from `updating` (scheduler-merge-driver.ts),
      // except the author delivery, which the driver ends without a throw. Each case pins its path: any other throw is red.
      for (let i = 0; i < 2; i++) if (refusal) await expect(w.pass()).rejects.toThrow(refusal); else await w.pass();
      expect(w.carries().map((e) => e.seq)).toEqual(before); // the first carry's evidence is untouched, no second one was written
      expect(getTask(w.f.db, "T1")!.headSHA).toBe(merged1);
      expect(["updating", "unknown", "await_review"]).toContain(w.run().phase);
      expect(w.sent().some((c) => c.includes("/merge "))).toBe(false);
    }, 240_000);
  }
});

describe("MCRY6 e2e: the auto run re-proves its pinned MODELX source between the merging claim and the merge API", () => {
  test("合法来源：PB 同家族豁免 PASS 两次沿用，发出前重核成立 → 钉在新 head 合并（与正例同路）", async () => {
    const w = await world(true);
    expect(listLendOrders(w.f.db, "T1").map((o) => [o.peer, o.family, o.status])).toEqual([[HE, "codex", "cancelled"], [PB, "claude", "done"]]);
    expect(listEvents(w.f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "review")!.data).toMatchObject({ reviewerFamily: "claude" });
    await toSecondUpdate(w);
    await w.pass();
    expect(w.carries().map((e) => [e.data.to, e.data.sourceReviewSeq])).toEqual([[merged1, w.reviewSeq], [merged2, w.reviewSeq]]);
    w.gh.ci.set(merged2, "pass");
    await w.pass();
    expect(w.run()).toMatchObject({ phase: "merged", reviewedHead: merged2, mergeSha: M });
    expect(w.sent().at(-1)).toBe(`api -X PUT repos/o/r/pulls/7/merge -f sha=${merged2} -f merge_method=merge`);
  }, 240_000);

  test("旧红新绿：merging 认领返回后、merge API 之前 owner 撤回豁免 → 真实零 merge，合并未发出 → unknown 冻结，PM resolve 仍可结清", async () => {
    const w = await world(true);
    await toSecondUpdate(w);
    await w.pass();
    w.gh.ci.set(merged2, "pass");
    let revokedAt = null as string | null;
    await w.pass(() => {
      if (revokedAt || w.run().phase !== "merging") return;
      revokedAt = w.run().phase; // the claim is journaled and returned; nothing was sent yet
      expect(w.sent().some((c) => c.includes("/merge "))).toBe(false);
      w.ownerRule("policy_refusal_rule_stop");
    });
    expect(revokedAt).toBe("merging");
    expect(w.sent().some((c) => c.includes("/merge "))).toBe(false); // before MCRY6: the PUT went out on the revoked exemption
    expect(w.run()).toMatchObject({ phase: "unknown", reviewedHead: merged2, mergeSha: null });
    expect(w.run().reason).toMatch(/^合并未发出：发出前重核正式来源不成立（来源 \/ 家族 \/ 豁免已变）/);
    expect(w.f.db.query("SELECT value FROM meta WHERE project = 'p' AND key = 'queueFrozen'").get()).toMatchObject({ value: expect.stringContaining('"frozen":true') });
    expect(w.carries()).toHaveLength(2); // the carries' evidence stays as written; no fake cancelled / PASS
    expect(listLendOrders(w.f.db, "T1").at(-1)).toMatchObject({ peer: PB, status: "done" });
    expect(await w.cli("owner", "scheduler-merge-resolve", w.intent, "--outcome", "cancelled", "--receipt", "GitHub 核对：PR 未合并"))
      .toMatchObject({ ok: true, run: { phase: "resolved" } });
  }, 240_000);
});

describe("MCRY7 e2e: what does not revoke the source leaves the historical PASS gate and the merge pinned to the current head", () => {
  /** After both carries: merged2 green, one pass (`active` runs after the merging claim) → merged at merged2, the source orders untouched. */
  const mergedAtNewHead = async (w: World, active?: () => void) => {
    expect(w.carries().map((e) => [e.data.from, e.data.to, e.data.sourceReviewSeq])).toEqual([[reviewed, merged1, w.reviewSeq], [merged1, merged2, w.reviewSeq]]);
    const orders = listLendOrders(w.f.db, "T1");
    expect(orders.at(-1)).toMatchObject({ orderId: w.order.orderId, head: reviewed, status: "done" });
    w.gh.ci.set(merged2, "pass");
    await w.pass(active);
    expect(w.run()).toMatchObject({ phase: "merged", reviewedHead: merged2, mergeSha: M });
    expect(w.sent().filter((c) => c.includes("/merge "))).toEqual([`api -X PUT repos/o/r/pulls/7/merge -f sha=${merged2} -f merge_method=merge`]);
    expect(listLendOrders(w.f.db, "T1")).toEqual(orders);
  };

  test("merging 认领返回后、merge API 之前真 CLI lend-cancel：已 done 的来源 not_found、零写入，原历史来源照钉 merged2 合并", async () => {
    const w = await world();
    await toSecondUpdate(w);
    await w.pass();
    const seqs = () => listEvents(w.f.db, { project: "p" }).map((e) => e.seq);
    let cancel = null as Record<string, unknown> | null, before = [] as number[];
    await mergedAtNewHead(w, () => {
      if (cancel || w.run().phase !== "merging") return;
      expect(w.sent().some((c) => c.includes("/merge "))).toBe(false); // the claim is journaled and returned; nothing was sent yet
      before = seqs();
      cancel = w.ownerSync("lend-cancel", "T1", "--reason", "认领后撤单");
      expect(seqs()).toEqual(before);
    });
    expect(cancel).toMatchObject({ ok: false, code: "not_found", error: expect.stringContaining("没有未结的出借单") });
  }, 240_000);

  // Applied before the second carry, so both the in-transaction carry gate and the before-send re-proof read it.
  const keep: [string, (w: World) => Promise<void>][] = [
    ["borrow 授权自然到期（对方 hello 的 grant 过了 until，不是撤销）", async (w) => {
      recordHello(w.f.db, "mate", null, { v: 1, proto: 2, boot: "mcry7", seq: 1, paused: null, slots: { codex: { total: 1, busy: 0 }, claude: { total: 0, busy: 0 } },
        grant: { until: Date.now() + 30, roles: ["review"], repos: ["o/r"], ordersPerDay: 5, ordersLeftToday: 5 } }, Date.now());
      await Bun.sleep(60);
      const grant = (w.f.db.query("SELECT grant FROM lend_peers WHERE peer = 'mate'").get() as { grant: string }).grant;
      expect(JSON.parse(grant).until).toBeLessThan(Date.now());
    }],
    ["删 borrow 配置（借入名单清空）", async (w) => { w.borrow.splice(0); }], // the children read no lend.json either
    ["lend-pin 正式轮换（bridge 改钉对方公钥入账）", async (w) =>
      expect(await w.cli("owner", "lend-pin", "--", "mate", "abcd-0123-4567-89ef", "repin")).toMatchObject({ ok: true, projects: ["p"] })],
  ];
  for (const [name, change] of keep) {
    test(`not a revocation: the second carry and the before-send re-proof keep the historical source → merged at merged2: ${name}`, async () => {
      const w = await world();
      await toSecondUpdate(w);
      await change(w);
      await w.pass();
      await mergedAtNewHead(w);
    }, 240_000);
  }
});
