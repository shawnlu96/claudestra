/**
 * MAINP2 r6 manual-carry-1：MQ1 人工合并请求的 run 在 update-branch 后沿用审查。真实 Git 单跳纯 main 合并经 mergeExternal.carryReview
 * （canonical reviewMainCarryProof）证明，台账全走真实 runLedger 分派：PM `ledger review` → `manual-merge-request` → `manual-merge-claim`
 * → driveMerge 的 `scheduler-merge-step`。写 carry 的事务按本 run 真实 intent（manual_merge）读人工请求绑定的审查来源，不读自动池 /
 * scheduler_sessions；撤销 / 错角色 / 来源漂移 / 错 head / 未知链 / 自动路径多跳未开均零写。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { carryReceipt, getMergeRun, mergeRunDrift, type MergePhase, type MergeRun } from "../src/lib/scheduler-merge.js";
import { ledgerAs, manualReviewArgs, requestArgs } from "./manual-merge-queue-world.test.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";

const PM = "agent-pm";
let root = "", work = "", oldHead = "", main1 = "", one = "";
let w: ReclaimWorld;
let open = false;
const closeWorld = () => { if (open) w.close(); open = false; };
const sh = async (...args: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: work, timeoutMs: 30_000 });
  if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = async (f: string, v: string) => { writeFileSync(join(work, f), `${v}\n`); await sh("add", "-A"); await sh("commit", "-qm", v); return sh("rev-parse", "HEAD"); };
/** Objects are all local; only the network fetch is stubbed (origin is the GitHub URL the proof binds to). */
const gitCommand: typeof runBounded = async (argv, opts) => argv[0] === "git" && argv.includes("fetch")
  ? { code: 0, stdout: "", stderr: "", timedOut: false } : runBounded(argv, opts);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mainp2-mq1-")); work = join(root, "repo"); mkdirSync(work);
  await sh("init", "-q", "-b", "main");
  const base = await commit("shared", "base");
  await sh("checkout", "-qb", "feature"); oldHead = await commit("feature", "reviewed");
  await sh("checkout", "-q", "main"); main1 = await commit("m1", "main one");
  await sh("update-ref", "refs/remotes/origin/main", main1);
  await sh("checkout", "-q", "feature"); await sh("merge", "-q", "--no-edit", main1); one = await sh("rev-parse", "HEAD");
  void base;
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
afterEach(() => { closeWorld(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

/** A PM-taken-over card at the real reviewed head, its cross-family PASS recorded by `ledger review`, requested and claimed. */
async function claimedManual(): Promise<{ intent: string; reviewSeq: number; request: number; prRef: string; external: MergeExternal }> {
  closeWorld();
  w = reclaimWorld({ store: "memory" }); open = true;
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { manualMergeQueue: "on" } } } }));
  const c = w.card("M"), db = w.db;
  const repo = /github\.com\/([\w.-]+\/[\w.-]+)\/pull/.exec(c.prRef)![1]!;
  await sh("remote", "remove", "origin").catch(() => {});
  await sh("remote", "add", "origin", `https://github.com/${repo}.git`);
  db.query("DELETE FROM scheduler_sessions WHERE taskId = 'M'").run(); // PM took over: no engine reviewer session survives
  db.query("DELETE FROM scheduler_intents WHERE taskId = 'M'").run();
  setWorkflow(db, { actor: "owner", now: Date.now() }, { taskId: "M", taskRev: getTask(db, "M")!.rev, workflowRev: 1, template: "code", templateVersion: 2,
    mode: "manual", authorFamily: "claude", fallback: "缩小范围", reason: "PM 接管，人工审查后合并" });
  db.query("UPDATE tasks SET stage = 'review', headSHA = ?, rev = rev + 1 WHERE id = 'M'").run(oldHead);
  const dir = mkdtempSync(join(root, "findings-")), findings = join(dir, "findings.json");
  writeFileSync(findings, "[]");
  expect(await ledgerAs(w, PM, ...manualReviewArgs("M", oldHead, findings))).toMatchObject({ ok: true });
  const reviewSeq = listEvents(db, { project: "p", target: "M" }).findLast((e) => e.kind === "review")!.seq;
  const req = await ledgerAs(w, PM, ...requestArgs({ taskId: "M", head: oldHead, reviewSeq }));
  expect(req).toMatchObject({ ok: true, state: "queued" });
  const claim = await ledgerAs(w, "scheduler", "manual-merge-claim", "p", "--mode", "on", "--train", "none", "--required-checks", "check");
  expect(claim).toMatchObject({ ok: true, claimed: true });
  const intent = String(claim.intentId);
  const r = await step(intent, "ready", "updating");
  expect(r).toMatchObject({ ok: true });
  const project = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["check"], repoDir: work } } }).projects.p!;
  const real = mergeExternal(project, gitCommand, () => 1);
  const pr: PrSnapshot = { state: "OPEN", head: one, branch: "task/M", base: "main", draft: false, crossRepository: false,
    mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pending" }] };
  const external: MergeExternal = { inspect: async () => pr, freshness: async () => ({ behindBy: 0, mainHead: main1 }), carryReview: real.carryReview,
    updateBranch: async () => { throw new Error("不该再更新"); }, merge: async () => { throw new Error("不该合并"); } };
  return { intent, reviewSeq, request: Number(req.request), prRef: c.prRef, external };
}

const step = (intent: string, from: MergePhase, to: MergePhase, o: { receipt?: string; newHead?: string; actor?: string } = {}) => {
  const args = ["scheduler-merge-step", intent, "--from", from, "--to", to, "--rev", String(getMergeRun(w.db, intent)!.rev)];
  if (o.receipt) args.push("--receipt", o.receipt);
  if (o.newHead) args.push("--new-head", o.newHead);
  return ledgerAs(w, o.actor ?? "scheduler", ...args);
};
/** The driver's advance port on the real ledger CLI (scheduler identity). */
const advance = (intent: string) => async (from: MergePhase, to: MergePhase, _rev: number, receipt?: string, _sha?: string, newHead?: string) => {
  const r = await step(intent, from, to, { receipt, newHead });
  if (r.ok !== true) throw new Error(`scheduler-merge-step: ${String(r.error)}`);
  return r.run as MergeRun;
};
const snapshot = () => JSON.stringify([w.db.query("SELECT * FROM tasks ORDER BY id").all(), w.db.query("SELECT * FROM scheduler_merges").all(),
  w.db.query("SELECT seq FROM events ORDER BY seq DESC LIMIT 1").get()]);
const carries = () => listEvents(w.db, { project: "p", target: "M" }).filter((e) => e.data.op === "review_carry");
const receiptFor = (proofDiff: string, chain = carryChainSuffix([{ previousHead: oldHead, head: one, mainParent: main1 }]), to = one) =>
  carryReceipt({ oldHead, newHead: to, mainParent: main1, mainHead: main1, diffHash: proofDiff }) + chain;

test("manual-carry-1: a manual run's pure-main update carries on the request's bound PASS (real Git proof + real ledger CLI)", async () => {
  const m = await claimedManual();
  const proof = await m.external.carryReview(m.prRef, oldHead, one);
  expect(proof).toMatchObject({ ok: true, mainParent: main1, chain: [{ previousHead: oldHead, head: one, mainParent: main1 }] });
  const run = await driveMerge(getMergeRun(w.db, m.intent)!, m.external, advance(m.intent), () => {}, (r) => mergeRunDrift(w.db, r));
  expect(run.phase).toBe("await_ci");
  expect(getTask(w.db, "M")!.headSHA).toBe(one);
  expect(carries()).toHaveLength(1);
  expect(carries()[0]!.data).toMatchObject({ intentId: m.intent, from: oldHead, to: one, sourceReviewSeq: m.reviewSeq, hops: 1, mainCarry: "single",
    chain: [{ previousHead: oldHead, head: one, mainParent: main1 }] });
  // the carried head stays the request's own: the run is still live, no auto session was invented
  expect(mergeRunDrift(w.db, getMergeRun(w.db, m.intent)!)).toBeNull();
  expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_sessions WHERE taskId = 'M'").get()).toEqual({ n: 0 });
}, 30_000);

test("manual-carry-1 negatives: revoke / wrong role / source drift / wrong head / policy off / unknown chain / multi-hop off all write nothing", async () => {
  type M = Awaited<ReturnType<typeof claimedManual>>;
  const carry = (m: M) => step(m.intent, "updating", "await_ci", { receipt: receiptFor("a".repeat(64)), newHead: one });
  const prep: Record<string, (m: M) => Promise<void>> = {
    revoked: async (m) => {
      expect(await ledgerAs(w, PM, "manual-merge-revoke", "M", "--request", String(m.request), "--reason", "撤回")).toMatchObject({ ok: true });
    },
    "manual queue policy off": async () => {
      writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { manualMergeQueue: "off" } } } }));
    },
    "source drift": async () => {
      insertEvent(w.db, { actor: "agent-x", now: Date.now() }, { project: "p", target: "M", kind: "review", text: "", data: { round: 1, head: oldHead,
        verdict: "pass", reviewer: "agent-x", reviewerSessionId: "rs-other", reviewerFamily: "codex", path: "r2.md", findings: [], p0: 0, p1: 0, p2: 0 } }, false);
    },
  };
  const cases: [string, (m: M) => Promise<Record<string, unknown>>, RegExp][] = [
    ["revoked", carry, /人工合并请求已失效：请求已撤销/],
    ["wrong role", (m) => step(m.intent, "updating", "await_ci", { receipt: receiptFor("a".repeat(64)), newHead: one, actor: PM }), /沿用审查只许调度服务身份写/],
    ["source drift", carry, /本轮审查结论已换成/],
    ["manual queue policy off", carry, /人工合并排队策略已是 off/],
    ["wrong head", (m) => step(m.intent, "updating", "await_ci", { receipt: receiptFor("a".repeat(64)), newHead: main1 }), /head 对不上/],
    ["unknown chain", (m) => step(m.intent, "updating", "await_ci", { receipt: receiptFor("a".repeat(64), "｜链 not-json"), newHead: one }), /链不成立：不是 JSON/],
    ["no chain", (m) => step(m.intent, "updating", "await_ci", { receipt: receiptFor("a".repeat(64), ""), newHead: one }), /链不成立：缺完整链/],
    ["two hops while mainCarry not on", (m) => step(m.intent, "updating", "await_ci", { receipt: receiptFor("a".repeat(64),
      carryChainSuffix([{ previousHead: oldHead, head: main1, mainParent: main1 }, { previousHead: main1, head: one, mainParent: main1 }])), newHead: one }), /mainCarry/],
  ];
  for (const [name, act, why] of cases) {
    const m = await claimedManual();
    await prep[name]?.(m);
    const before = snapshot();
    const r = await act(m);
    expect({ name, ok: r.ok }).toEqual({ name, ok: false });
    expect({ name, error: String(r.error) }).toEqual({ name, error: expect.stringMatching(why) });
    expect({ name, same: snapshot() === before, carries: carries().length }).toEqual({ name, same: true, carries: 0 });
  }
}, 60_000);
