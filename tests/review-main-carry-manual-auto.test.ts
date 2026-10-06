/**
 * MAINP2 验收线 4 + 9：auto 路径的多跳沿用，按 src/scheduler.ts 的接法跑一遍——调度侧只拿 query_only 的 LedgerReader，
 * 每次写都经真实 `ledger scheduler-merge-step` 子进程（调度服务身份 + 租约，临时台账）。证明是真实 git 的两跳纯 main 合并
 * （mergeExternal.carryReview → canonical reviewMainCarryProof），沿用写进台账；改坏一跳则退回审查，什么沿用都不写。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLock, type LockHandle } from "../src/lib/file-lock.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent, type EventDraft } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import { getMergeRun, mergeRunDrift, type MergePhase, type MergeRun } from "../src/lib/scheduler-merge.js";
import { testChildEnv } from "./test-env.js";

const REPO = "example/auto", PR = `https://github.com/${REPO}/pull/1`;
let root = "", work = "", state = "", ledgerPath = "", env: Record<string, string> = {};
let oldHead = "", main1 = "", main2 = "", one = "", two = "", evil = "";
const locks: LockHandle[] = [];
const sh = async (...args: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: work, timeoutMs: 30_000 });
  if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = async (f: string, v: string, m: string) => { writeFileSync(join(work, f), v); await sh("add", "-A"); await sh("commit", "-qm", m); return sh("rev-parse", "HEAD"); };
/** Objects are all local; only the network fetch is stubbed (origin is a GitHub URL the proof binds to). */
const gitCommand: typeof runBounded = async (argv, opts) => argv[0] === "git" && argv.includes("fetch")
  ? { code: 0, stdout: "", stderr: "", timedOut: false } : runBounded(argv, opts);

/** The scheduler's ledger child: the real manager CLI in its own process, as scheduler-service.ts's `manager` runs it. */
async function manager(...args: string[]): Promise<Record<string, unknown>> {
  const p = Bun.spawn([process.execPath, "--no-env-file", resolve("src/manager.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  try { return JSON.parse(out); } catch { throw new Error(`manager 输出不是 JSON：${out} ${err}`); }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mainp2-auto-")); work = join(root, "repo"); state = join(root, "state"); mkdirSync(work); mkdirSync(state);
  mkdirSync(join(root, "home")); mkdirSync(join(root, "runtime"));
  await sh("init", "-q", "-b", "main"); await sh("remote", "add", "origin", `https://github.com/${REPO}.git`);
  const base = await commit("shared", "s\n", "base");
  await sh("checkout", "-qb", "feature"); oldHead = await commit("feature", "reviewed\n", "reviewed");
  await sh("checkout", "-q", "main"); main1 = await commit("m1", "1\n", "main one"); main2 = await commit("m2", "2\n", "main two");
  void base;
  await sh("update-ref", "refs/remotes/origin/main", main2);
  await sh("checkout", "-q", "feature"); await sh("merge", "-q", "--no-edit", main1); one = await sh("rev-parse", "HEAD");
  await sh("merge", "-q", "--no-edit", main2); two = await sh("rev-parse", "HEAD");
  await sh("merge", "-q", "--no-commit", "--no-ff", oldHead).catch(() => {});
  writeFileSync(join(work, "feature"), "reviewed\nsmuggled\n"); await sh("add", "-A");
  evil = await sh("commit-tree", await sh("write-tree"), "-p", one, "-p", main2, "-m", "evil hop");
  await sh("reset", "-q", "--hard", two);
  const singleton = (await acquireLock(join(root, "singleton.lock"), 0))!, maintenance = (await acquireLock(join(root, "maintenance.lock"), 0))!;
  locks.push(singleton, maintenance);
  env = testChildEnv({ HOME: join(root, "home"), CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(root, "runtime"), CLAUDESTRA_TEST: "1",
    CLAUDESTRA_SCHEDULER_SERVICE: "1", CLAUDESTRA_SCHEDULER_LEASE: encodeLease({ singleton: { path: join(root, "singleton.lock"), token: singleton.token },
      maintenance: { path: join(root, "maintenance.lock"), token: maintenance.token } }) });
  ledgerPath = join(state, "ledger.sqlite");
  // the CLI child re-reads both inside its write transaction (review-main-carry-manual-auto.ts autoCarryEvidence)
  writeFileSync(join(state, "scheduler.json"), JSON.stringify({ enabled: false, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: work } } }));
  policy("on");
});
const policy = (mode: "on" | "observe" | "off") =>
  writeFileSync(join(state, "recovery-policy.json"), JSON.stringify({ projects: { p: { keys: { mainCarry: mode } } } }));
afterAll(() => { for (const l of locks) l.release(); closeLedger(ledgerPath); if (root) rmSync(root, { recursive: true, force: true }); });

let cards = 0;
/** An auto card in merge at the reviewed head with its proven cross-family review, holding the merge slot with a submitted intent. */
function card(): { id: string; intent: string } {
  const db = openLedger(ledgerPath), id = `A${++cards}`, at = Date.now(), intent = `merge-${id}`;
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"pm\"]') ON CONFLICT (project, key) DO NOTHING").run();
  createTask(db, { actor: "owner", now: at }, { project: "p", id, title: id, kind: "code", agent: "agent-author" });
  setWorkflow(db, { actor: "owner", now: at }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch=?, updatedAt=? WHERE id=?").run(oldHead, PR, `task/${id}`, at, id);
  const ev = (actor: string, kind: EventDraft["kind"], data: Record<string, unknown>, dedupKey?: string) =>
    insertEvent(db, { actor, now: at, dedupKey }, { project: "p", target: id, kind, text: "", data }, !!dedupKey).seq;
  ev("scheduler", "stage", { from: "build", to: "review", round: 1 });
  const intentRow = (iid: string, node: string, action: string, recipient: string | null, status: string) => db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,
    action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,recipient,createdAt,updatedAt) VALUES (?,?,'p',?,?,1,?,2,1,?,2,?,'r',?,?,?)`)
    .run(iid, id, node, action, ev("scheduler", "scheduler", { op: "plan", intentId: iid }), oldHead, status, recipient, at, at);
  intentRow(`rc-${id}`, "adversarial_review", "ensure_session", null, "done");
  intentRow(`rv-${id}`, "adversarial_review", "review", "agent-review", "done");
  ev("scheduler", "scheduler", { op: "intent_submitted", intentId: `rv-${id}` }, `scheduler:rv-${id}:submitted`);
  ev("agent-review", "review", { round: 1, head: oldHead, verdict: "pass", reviewer: "agent-review", reviewerSessionId: `rs-${id}`, reviewerFamily: "codex",
    path: "r.md", findings: [], p0: 0, p1: 0, p2: 0 });
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES (?,'reviewer','agent-review',?,'codex','acp','active',?,?,?)`).run(id, `rs-${id}`, `rc-${id}`, at, at);
  intentRow(intent, "merge_deploy", "merge", null, "pending");
  db.query("DELETE FROM scheduler_resources WHERE resource='merge:p'").run(); // the previous case's slot: each case is its own card
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p',?,?,?)").run(id, intent, at);
  closeLedger(ledgerPath);
  return { id, intent };
}

/** One merge step the way scheduler-service.ts drives it: run read from the read-only reader, every write through the CLI child. */
async function drive(intent: string, prHead: string, hops = 16) {
  const reader = new LedgerReader(ledgerPath), ro = reader.get()!;
  try {
    expect(() => ro.run("UPDATE meta SET value = value")).toThrow(/readonly/);
    const advance = async (from: MergePhase, to: MergePhase, rev: number, receipt?: string, mergeSha?: string, newHead?: string) => {
      const args = ["ledger", "scheduler-merge-step", intent, "--from", from, "--to", to, "--rev", String(rev)];
      if (receipt) args.push("--receipt", receipt);
      if (mergeSha) args.push("--merge-sha", mergeSha);
      if (newHead) args.push("--new-head", newHead);
      const r = await manager(...args);
      if (r.ok !== true) throw new Error(`scheduler-merge-step: ${String(r.error)}`);
      return r.run as MergeRun;
    };
    const project = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: work } } }).projects.p!;
    const real = mergeExternal(project, gitCommand, () => hops); // hops: what the mainCarry policy allows (16 = on)
    const pr: PrSnapshot = { state: "OPEN", head: prHead, branch: `task/${intent.slice(6)}`, base: "main", draft: false, crossRepository: false,
      mergeState: "CLEAN", mergeSha: null, checks: [{ name: "ci", bucket: "pending" }] };
    const external: MergeExternal = { inspect: async () => pr, freshness: async () => ({ behindBy: 0, mainHead: main2 }), carryReview: real.carryReview,
      updateBranch: async () => { throw new Error("不该再更新"); }, merge: async () => { throw new Error("不该合并"); } };
    const run = getMergeRun(ro, intent)!;
    expect(run.phase).toBe("updating");
    return await driveMerge(run, external, advance, () => {}, (m) => mergeRunDrift(ro, m));
  } finally { reader.close(); }
}

async function begin(intent: string) {
  expect(await manager("ledger", "scheduler-settle", intent, "--from", "pending", "--to", "submitted", "--receipt", "merge controller claimed")).toMatchObject({ ok: true });
  const r = await manager("ledger", "scheduler-merge-begin", intent, "--required-checks", "ci");
  expect(r).toMatchObject({ ok: true });
  const run = r.run as MergeRun;
  expect(await manager("ledger", "scheduler-merge-step", intent, "--from", "ready", "--to", "updating", "--rev", String(run.rev))).toMatchObject({ ok: true });
}

describe("MAINP2 auto carry through the production write port", () => {
  test("two pure-main hops: the read-only scheduler side carries the review via the real ledger CLI child", async () => {
    const c = card();
    await begin(c.intent);
    const after = await drive(c.intent, two);
    expect(after).toMatchObject({ phase: "await_ci", reviewedHead: two });
    const db = openLedger(ledgerPath);
    try {
      expect(getTask(db, c.id)!.headSHA).toBe(two);
      const carry = listEvents(db, { project: "p", target: c.id }).filter((e) => e.data.op === "review_carry");
      expect(carry).toEqual([expect.objectContaining({ actor: "scheduler", data: expect.objectContaining({ from: oldHead, to: two, mainParent: main2, mainHead: main2 }) })]);
      // review r1 missing-chain: the full canonical chain and the PASS it carries are on the event written by the CLI child
      const review = listEvents(db, { project: "p", target: c.id }).findLast((e) => e.kind === "review")!;
      expect(carry[0]!.data).toMatchObject({ hops: 2, mainCarry: "on", sourceReviewSeq: review.seq,
        chain: [{ previousHead: oldHead, head: one, mainParent: main1 }, { previousHead: one, head: two, mainParent: main2 }] });
      expect(listEvents(db, { project: "p", target: c.id }).filter((e) => e.kind === "decision")).toEqual([]); // not a PM carry
    } finally { closeLedger(ledgerPath); }
  }, 60_000);
  test("mainCarry not on (observe default): the same two clean hops are not carried — no wider authority than single hop", async () => {
    const c = card();
    await begin(c.intent);
    expect(await drive(c.intent, two, 1)).toMatchObject({ phase: "await_review", reason: expect.stringContaining("只认单跳") });
    const db = openLedger(ledgerPath);
    try { expect(listEvents(db, { project: "p", target: c.id }).filter((e) => e.data.op === "review_carry")).toEqual([]); }
    finally { closeLedger(ledgerPath); }
  }, 60_000);
  test("review r1 policy-drift: on when the proof ran, off before the CLI write → the write transaction refuses, zero writes", async () => {
    const c = card();
    await begin(c.intent);
    const snap = () => {
      const db = openLedger(ledgerPath);
      try { return { task: getTask(db, c.id), n: listEvents(db, { project: "p", target: c.id }).length }; } finally { closeLedger(ledgerPath); }
    };
    const before = snap();
    policy("off");
    try {
      await expect(drive(c.intent, two)).rejects.toThrow(/mainCarry 策略不是 on/); // the external still says 16: only the CLI re-read catches it
    } finally { policy("on"); }
    expect(snap()).toEqual(before);
  }, 60_000);
  test("an evil hop in the chain: back to review, nothing carried", async () => {
    const c = card();
    await begin(c.intent);
    const after = await drive(c.intent, evil);
    expect(after.phase).toBe("await_review");
    const db = openLedger(ledgerPath);
    try {
      expect(listEvents(db, { project: "p", target: c.id }).filter((e) => e.data.op === "review_carry")).toEqual([]);
    } finally { closeLedger(ledgerPath); }
  }, 60_000);
});
