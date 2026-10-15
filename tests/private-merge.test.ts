/**
 * merge-arch-MERGEAUTO1 end to end on a synthetic ledger: a private-repo card (floka-ai/cloud) at merge, a fake gh answering like
 * GitHub for that PR, a temporary checkout directory, and the planner's call at foreignRepoEscalation. P1 lines are 「[验收线 N]」.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { beginMergeRun, getMergeRun, type MergeRun } from "../src/lib/scheduler-merge.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import type { RecoveryKey, RecoveryMode } from "../src/lib/recovery-policy.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { ForeignRepoError, setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import type { MergeExternal } from "../src/lib/scheduler-merge-driver.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { setPrivateMergePortsForTest } from "../src/lib/private-merge-gate.js";
import { privateGh } from "../src/lib/private-merge-gh.js";
import { privateMergeDrive, resetPrivateMergeForTest } from "../src/lib/private-merge.js";
import { privateBounceChecks } from "../src/lib/private-merge-ledger.js";
import { ledgerAs } from "./deploy-test-kit.js";

const HEAD = "c".repeat(40), NEW_HEAD = "e".repeat(40), MERGE_SHA = "f".repeat(40), MAIN = "9".repeat(40);
const REPO = "floka-ai/cloud", PRIVATE = `https://github.com/${REPO}/pull/12`;
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });

interface FakeGh {
  pr: { state: string; headRefOid: string; baseRefName: string; isDraft: boolean; mergeable: string; mergeCommit: { oid: string } | null };
  /** names = main's required checks; 404 / 403 = none readable */
  protection: string[] | 404 | 403;
  checks: { name: string; bucket: string }[];
  /** set: every gh call fails with this exit code and a stderr full of things that must never be echoed */
  fail?: number;
  calls: string[][];
}
const SECRET_STDERR = "fatal: unable to access 'https://x-token:ghp_SECRET@github.com/floka-ai/cloud.git/' in /Users/someone/private/cloud";

function fakeGh(over: Partial<FakeGh> = {}): FakeGh {
  return { pr: { state: "OPEN", headRefOid: HEAD, baseRefName: "main", isDraft: false, mergeable: "MERGEABLE", mergeCommit: null },
    protection: ["ci"], checks: [{ name: "ci", bucket: "pass" }], calls: [], ...over };
}
const ok = (stdout: string, code = 0): BoundedResult => ({ code, stdout, stderr: "", timedOut: false });
const err = (code: number, stderr: string): BoundedResult => ({ code, stdout: "", stderr, timedOut: false });

function ghCommand(gh: FakeGh) {
  return async (argv: string[]): Promise<BoundedResult> => {
    gh.calls.push(argv);
    if (argv[0] !== "gh") return err(2, "not gh");
    if (gh.fail !== undefined) return err(gh.fail, SECRET_STDERR);
    const [, a, b] = argv;
    if (a === "pr" && b === "view") return ok(JSON.stringify(gh.pr));
    if (a === "api" && argv[2]!.endsWith("/protection/required_status_checks")) {
      return typeof gh.protection === "number" ? err(1, `gh: Not Found (HTTP ${gh.protection})\n${SECRET_STDERR}`)
        : ok(JSON.stringify({ contexts: gh.protection, checks: gh.protection.map((context) => ({ context, app_id: 1 })) }));
    }
    if (a === "api" && argv[2] === `repos/${REPO}/commits/main`) return ok(`${MAIN}\n`);
    if (a === "pr" && b === "checks") {
      if (!gh.checks.length) return err(1, "no checks reported on the 'x' branch");
      // real gh: exit 1 when a check failed, 8 when one is pending, JSON on stdout either way
      const code = gh.checks.some((c) => c.bucket === "fail" || c.bucket === "cancel") ? 1 : gh.checks.some((c) => c.bucket === "pending") ? 8 : 0;
      return ok(JSON.stringify(gh.checks), code);
    }
    if (a === "pr" && b === "merge") {
      gh.pr = { ...gh.pr, state: "MERGED", mergeCommit: { oid: MERGE_SHA } };
      return ok("");
    }
    return err(2, "unexpected gh call");
  };
}

interface Kit { db: Database; dir: string; close(): void; clock: { now: number } }

const intentRow = (db: Database, id: string, task: string, node: string, action: string, status: string, seq: number, head: string) => db.query(`INSERT INTO scheduler_intents
  (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
  VALUES (?,?,'p',?,?,1,?,2,1,?,2,?,'seed',100,100)`).run(id, task, node, action, seq, head, status);

/** An auto card at merge on the private repository with its merge intent submitted, the merge slot held and the run `ready`. */
function seedCard(db: Database, id: string, pr = PRIVATE, head = HEAD, slot = true): string {
  const pm = { actor: "owner", now: 100 }, intent = `m-${id}`;
  createTask(db, pm, { project: "p", id, title: "private", kind: "code", agent: "agent-author" });
  setWorkflow(db, pm, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接手" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch=?, extra=? WHERE id=?")
    .run(head, pr, `feat/${id}`, JSON.stringify({ fileGlobs: [`repo:${REPO}/src/**`] }), id);
  intentRow(db, `rv-${id}`, id, "adversarial_review", "ensure_session", "done", 2, head);
  intentRow(db, intent, id, "merge_deploy", "merge", "submitted", 4, head);
  if (slot) db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p',?,?,100)").run(id, intent);
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES (?,'reviewer','agent-rv',?,'codex','tmux','active',?,100,100)`).run(id, `rv-session-${id}`, `rv-${id}`);
  db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-rv','p',?,'review','',?)").run(id, JSON.stringify({
    round: 1, head, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: `rv-session-${id}`, reviewerFamily: "codex",
    path: "r.md", findings: [], p0: 0, p1: 0, p2: 0 }));
  return intent;
}

/** The ledger, the card T1 (`m-T1` ready), the ports (privateRepoMerge = mode, privateMergeNarrow off) and the project repository. */
function kit(mode: RecoveryMode, gh: FakeGh, opts: { checkout?: boolean; narrow?: RecoveryMode; begin?: boolean } = {}): Kit {
  const dir = mkdtempSync(join(tmpdir(), "private-merge-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const clock = { now: 1_000_000 };
  seedCard(db, "T1");
  if (opts.begin !== false) beginMergeRun(db, { actor: "scheduler", now: 101 }, "m-T1", ["ci"]);
  const checkout = join(dir, "cloud");
  setForeignRepoLookupForTest({ project: () => "shawnlu96/claudestra" });
  setPrivateMergePortsForTest({
    policy: (_p: string, key: RecoveryKey) => ({ mode: key === "privateRepoMerge" ? mode : key === "privateMergeNarrow" ? opts.narrow ?? "off" : "observe",
      manualAfterMs: null, source: "config" }),
    repoDirs: { dirs: () => [checkout], origin: () => (opts.checkout === false ? "someone/else" : REPO), exists: () => true },
    command: ghCommand(gh), ledger: () => db, handoff: () => false, now: () => clock.now,
  });
  resetPrivateMergeForTest();
  return { db, dir, clock, close: () => {
    setPrivateMergePortsForTest(null);
    setForeignRepoLookupForTest({ project: null, origin: null });
    closeLedger(path);
    rmSync(dir, { recursive: true, force: true });
  } };
}

/** The project's own gh (repoDir = shawnlu96/claudestra): a private PR is refused as before; it must never merge anything. */
const projectExternal = (): MergeExternal => ({
  inspect: async () => { throw new ForeignRepoError(REPO, "shawnlu96/claudestra"); },
  freshness: async () => { throw new Error("不该读 freshness"); },
  carryReview: async () => ({ ok: false, reason: "不沿用" }),
  updateBranch: async () => { throw new Error("不该更新"); },
  merge: async () => { throw new Error("项目 gh 不该合并私仓"); },
});

function managerOf(db: Database) {
  const fallbacks: string[][] = [], ledger = ledgerAs(db, "scheduler");
  const manager = async (...args: string[]) => {
    if (args[1] === "scheduler-fallback-manual") fallbacks.push(args.slice(2));
    return ledger(...args);
  };
  return { manager, fallbacks };
}

async function tick(k: Kit, m = managerOf(k.db)) {
  await schedulerMergeTick(k.db, config, m.manager, projectExternal);
  return m;
}

const run = (db: Database, intent = "m-T1"): MergeRun => getMergeRun(db, intent)!;
const stage = (db: Database, id = "T1") => (db.query("SELECT stage, headSHA FROM tasks WHERE id=?").get(id) as { stage: string; headSHA: string });
const mode = (db: Database, id = "T1") => (db.query("SELECT mode FROM task_workflows WHERE taskId=?").get(id) as { mode: string }).mode;
const frozen = (db: Database) => (db.query("SELECT value FROM meta WHERE project='p' AND key='queueFrozen'").get() as { value: string } | null)?.value ?? "";
/** The privateRepoMerge records (every mode), oldest first. */
const notes = (db: Database, id = "T1") => (db.query(`SELECT text, data FROM events WHERE target=? AND kind='note'
  AND json_extract(data,'$.mechanism')='privateRepoMerge' ORDER BY seq`).all(id) as { text: string; data: string }[])
  .map((n) => ({ text: n.text, data: JSON.parse(n.data) as Record<string, unknown> }));
const merges = (gh: FakeGh) => gh.calls.filter((c) => c[1] === "pr" && c[2] === "merge");

// ---- the planner's snapshot of T1 (the shape tests/scheduler-foreign-repo.test.ts uses), with the card's private fileGlobs ----
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { foreignRepoReason } from "../src/lib/scheduler-foreign-repo.js";
import type { MergePhase } from "../src/lib/scheduler-merge.js";

const author: WorkerRef = { agent: "agent-author", sessionId: "session-author", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "session-review", taskId: "T1", family: "codex", source: "local" };
const event = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "agent-author", project: "p", target: "T1", text: "", dedupKey: null });
const planTask = (): LedgerTask => ({
  id: "T1", project: "p", itemId: null, title: "T", kind: "code", stage: "merge", stageBefore: null, round: 1,
  agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "agent-pm", branch: "task/T1", pr: PRIVATE,
  headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1, extra: { fileGlobs: [`repo:${REPO}/src/**`] }, createdAt: 1, updatedAt: 1,
});
const workflow: TaskWorkflow = { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude",
  fallback: "PM 接手", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 };
const sentReview: SchedulerIntent = { id: "review-r1", taskId: "T1", project: "p", node: "adversarial_review", action: "review",
  recipient: reviewer.agent, causalSeq: 14, eventSeq: 15, taskRev: 1, specRev: 1, head: HEAD, templateVersion: 2, status: "done",
  attempts: 0, receipt: null, reason: "x", createdAt: 14, updatedAt: 14 };
const snap = (): PlannerSnapshot => ({
  task: planTask(), workflow: { ...workflow }, intents: [sentReview], blockedBy: [], queueFrozen: false, fileGlobs: [`repo:${REPO}/src/**`],
  events: [event(1, "task", { op: "new" }), event(11, "stage", { from: "build", to: "review", round: 1 }), event(19, "deliver", { round: 1, headSHA: HEAD }),
    event(20, "review", { round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, reviewerFamily: reviewer.family,
      path: "reviews/T1-r1/report.md", verdict: "pass", findings: [], p0: 0, p1: 0, p2: 0 }),
    event(31, "stage", { from: "review", to: "merge", round: 1 })],
  heldResources: [], workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer,
  reviewDispatches: [{ intentId: "review-r1", round: 1, head: HEAD, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq: 16 }],
  uiGate: { state: "none" }, screenshotsDigest: null, projectRepo: "shawnlu96/claudestra",
});
const foreignEscalation = { kind: "escalate" as const, code: "foreign_repo", reason: foreignRepoReason(REPO).replace(/^foreign_repo：/, "") };
const leaks = (s: string, urls = true) => /\/Users\/|\/tmp\/|private-merge-|ghp_|token|fatal|\.git\b/.test(s) || (urls && /https?:\/\//.test(s));

let current: Kit | null = null;
const open = (m: RecoveryMode, gh: FakeGh, opts?: Parameters<typeof kit>[2]) => (current = kit(m, gh, opts));
afterEach(() => { current?.close(); current = null; });

describe("[验收线 1] privateRepoMerge off / observe / on", () => {
  test("on: the planner plans the merge, the driver merges with --match-head-commit <reviewed head>, the run is merged", async () => {
    const gh = fakeGh(), k = open("on", gh, { begin: false });
    expect(planScheduler(snap())).toMatchObject({ kind: "intent", action: "merge" });
    beginMergeRun(k.db, { actor: "scheduler", now: 101 }, "m-T1", ["ci"]);
    const m = await tick(k);
    expect(merges(gh)).toEqual([["gh", "pr", "merge", "12", "--repo", REPO, "--merge", "--match-head-commit", HEAD]]);
    expect(run(k.db)).toMatchObject({ phase: "merged", mergeSha: MERGE_SHA });
    expect(m.fallbacks).toEqual([]);
    expect(frozen(k.db)).not.toContain("true");
    expect(notes(k.db).map((n) => n.data.outcome)).toEqual(["merged"]);
    expect(notes(k.db)[0]!.data).toMatchObject({ head: HEAD, mergeSha: MERGE_SHA, repo: REPO });
  });

  test("off: both foreign_repo paths exactly as before: the planner escalates, the driver hands the run to PM; nothing recorded", async () => {
    const gh = fakeGh(), k = open("off", gh);
    expect(planScheduler(snap())).toEqual(foreignEscalation);
    const m = await tick(k);
    expect(m.fallbacks).toEqual([["T1", "--reason", foreignRepoReason(REPO), "--intent", "m-T1"]]);
    expect(run(k.db).phase).toBe("resolved");
    expect(gh.calls).toEqual([]);
    expect(notes(k.db)).toEqual([]);
  });

  test("observe: the planner escalates as before and records 「本会自动合并」 once per card + head", () => {
    const k = open("observe", fakeGh(), { begin: false });
    expect(planScheduler(snap())).toEqual(foreignEscalation);
    expect(planScheduler(snap())).toEqual(foreignEscalation);
    expect(notes(k.db)).toHaveLength(1);
    expect(notes(k.db)[0]!.text).toBe("恢复观察（privateRepoMerge）：本会 自动合并");
    expect(notes(k.db)[0]!.data).toMatchObject({ actionKey: `h-${HEAD}`, head: HEAD, mode: "observe" });
  });

  test("a manual merge request (mmq:) or a run without the hand-over hook never takes this path", async () => {
    const gh = fakeGh(), k = open("on", gh);
    const step = async (): Promise<MergeRun> => { throw new Error("不该推进"); };
    expect(await privateMergeDrive({ ...run(k.db), intentId: "mmq:3" }, step, () => {}, () => null, async () => {})).toBeNull();
    expect(await privateMergeDrive(run(k.db), step, () => {}, () => null)).toBeNull();
    expect(gh.calls).toEqual([]);
  });
});

describe("[验收线 2] no checkout here", () => {
  test("planner and driver go to PM as before; the record names the repository, never a local path", async () => {
    const gh = fakeGh(), k = open("on", gh, { checkout: false });
    expect(planScheduler(snap())).toEqual(foreignEscalation);
    const m = await tick(k); // a run planned before the checkout went away
    expect(m.fallbacks).toEqual([["T1", "--reason", foreignRepoReason(REPO), "--intent", "m-T1"]]);
    expect(gh.calls).toEqual([]);
    expect(notes(k.db).map((n) => n.text)).toEqual([`恢复观察（privateRepoMerge）：本会 交 PM：本机没有 ${REPO} 的检出`]);
    expect(leaks(JSON.stringify(notes(k.db)))).toBe(false);
  });

  test("observe without a checkout records 「不能自动合并：本机没有 … 的检出」", () => {
    const k = open("observe", fakeGh(), { checkout: false, begin: false });
    expect(planScheduler(snap())).toEqual(foreignEscalation);
    expect(notes(k.db)[0]!.text).toBe(`恢复观察（privateRepoMerge）：本会 不能自动合并：本机没有 ${REPO} 的检出`);
  });
});

describe("[验收线 3] head / base / state", () => {
  test("a PR head unlike the reviewed head goes back to review (the drift rule), nothing merged", async () => {
    const gh = fakeGh(), k = open("on", gh);
    gh.pr.headRefOid = NEW_HEAD;
    const m = await tick(k);
    expect(run(k.db).phase).toBe("await_review");
    expect(stage(k.db)).toEqual({ stage: "review", headSHA: NEW_HEAD });
    expect(merges(gh)).toEqual([]);
    expect(m.fallbacks).toEqual([]);
  });

  for (const [what, change, why] of [
    ["base not main", (g: FakeGh) => { g.pr.baseRefName = "dev"; }, "PR 的 base 不是 main"],
    ["a closed PR", (g: FakeGh) => { g.pr.state = "CLOSED"; }, "PR 已关闭"],
  ] as const) {
    test(`${what}: not merged, PM (foreign_repo), the run cancelled without a freeze`, async () => {
      const gh = fakeGh(), k = open("on", gh);
      change(gh);
      const m = await tick(k);
      expect(merges(gh)).toEqual([]);
      expect(m.fallbacks).toHaveLength(1);
      expect(m.fallbacks[0]![2]).toStartWith(`foreign_repo：卡在 ${REPO}，私仓自动合并停下：${why}`);
      expect(run(k.db).phase).toBe("resolved");
      expect(mode(k.db)).toBe("manual");
      expect(frozen(k.db)).not.toContain("true");
    });
  }
});

describe("[验收线 4] no branch protection", () => {
  test("every check green and at least one: merged", async () => {
    const gh = fakeGh({ protection: 404, checks: [{ name: "build", bucket: "pass" }, { name: "lint", bucket: "skipping" }] });
    const k = open("on", gh);
    await tick(k);
    expect(run(k.db).phase).toBe("merged");
    expect(merges(gh)).toHaveLength(1);
  });

  test("no check at all: PM 「私仓没有可核的 CI」, nothing merged", async () => {
    const gh = fakeGh({ protection: 403, checks: [] }), k = open("on", gh);
    const m = await tick(k);
    expect(merges(gh)).toEqual([]);
    expect(m.fallbacks[0]![2]).toContain("私仓没有可核的 CI");
  });

  test("checks running: wait (the run stays), and 2 hours on the same head goes to PM once", async () => {
    const gh = fakeGh({ protection: 404, checks: [{ name: "build", bucket: "pending" }] }), k = open("on", gh);
    const m = managerOf(k.db);
    await tick(k, m);
    k.clock.now += 3_600_000;
    await tick(k, m);
    expect(run(k.db).phase).toBe("ready");
    expect(m.fallbacks).toEqual([]);
    k.clock.now += 3_600_000;
    await tick(k, m);
    await tick(k, m);
    expect(m.fallbacks).toHaveLength(1);
    expect(m.fallbacks[0]![2]).toContain("等了 2 小时仍未就绪：checks 还在跑");
    expect(merges(gh)).toEqual([]);
    expect(run(k.db).phase).toBe("resolved");
  });

  test("a protection that names checks: a required one still missing waits, an unrequired red one does not block", async () => {
    const gh = fakeGh({ protection: ["ci", "e2e"], checks: [{ name: "ci", bucket: "pass" }, { name: "docs", bucket: "fail" }] }), k = open("on", gh);
    await tick(k);
    expect(merges(gh)).toEqual([]);
    gh.checks.push({ name: "e2e", bucket: "pass" });
    await tick(k);
    expect(run(k.db).phase).toBe("merged");
  });
});

describe("[验收线 5] red CI, conflict, one merge per private repository", () => {
  test("a required check red: bounced to fix through the ledger's merge bounce", async () => {
    const gh = fakeGh({ checks: [{ name: "ci", bucket: "fail" }] }), k = open("on", gh);
    const m = await tick(k);
    expect(run(k.db).phase).toBe("resolved");
    expect(run(k.db).reason).toStartWith(`ci_fail: 退回 fix（ci_fail）：PR head ${HEAD}`);
    expect(stage(k.db).stage).toBe("fix");
    expect(m.fallbacks).toEqual([]);
    expect(merges(gh)).toEqual([]);
  });

  test("the private repository's own required check name (not the project's) red: bounced to fix, not PM", async () => {
    const gh = fakeGh({ protection: ["build"], checks: [{ name: "build", bucket: "fail" }] }), k = open("on", gh);
    const m = await tick(k);
    expect(run(k.db).phase).toBe("resolved");
    expect(run(k.db).requiredChecks).toBe("build");
    expect(run(k.db).reason).toStartWith(`ci_fail: 退回 fix（ci_fail）：PR head ${HEAD}，失败检查 [{"name":"build","link":""}]`);
    expect(stage(k.db).stage).toBe("fix");
    expect(m.fallbacks).toEqual([]);
    expect(frozen(k.db)).not.toContain("true");
    expect(merges(gh)).toEqual([]);
  });

  test("no protection: a red check of the private repository's own bounces to fix with every check seen as the run's list", async () => {
    const gh = fakeGh({ protection: 404, checks: [{ name: "lint", bucket: "pass" }, { name: "test", bucket: "fail" }] }), k = open("on", gh);
    const m = await tick(k);
    expect(run(k.db).requiredChecks).toBe("lint,test");
    expect(run(k.db).reason).toContain(`失败检查 [{"name":"test","link":""}]`);
    expect(stage(k.db).stage).toBe("fix");
    expect(m.fallbacks).toEqual([]);
  });

  test("a conflict bounces as a conflict with main's head", async () => {
    const gh = fakeGh(), k = open("on", gh);
    gh.pr.mergeable = "CONFLICTING";
    await tick(k);
    expect(run(k.db).reason).toBe(`conflict: 退回 fix（conflict）：PR head ${HEAD}，main head ${MAIN}`);
    expect(stage(k.db).stage).toBe("fix");
  });

  test("two cards of the same private repository: the older open run goes first, the other waits; the ledger decides", async () => {
    // T2's run (older, await_ci) is driven first: its PR reads at another head, so it goes back to review and T2's turn ends
    const gh = fakeGh(), k = open("on", gh);
    const other = seedCard(k.db, "T2", "https://github.com/floka-ai/cloud/pull/13", "b".repeat(40), false);
    k.db.query(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
      VALUES (?, 'T2', 'p', 'https://github.com/floka-ai/cloud/pull/13', 'feat/T2', ?, 'ci', 'await_ci', 50, 50)`).run(other, "b".repeat(40));
    k.db.query("UPDATE scheduler_merges SET createdAt=200 WHERE intentId='m-T1'").run();
    gh.calls.length = 0;
    await tick(k);
    expect(gh.calls.length).toBeGreaterThan(0);
    expect(gh.calls.every((c) => c.includes("13"))).toBe(true); // T1's PR 12 was not even read
    expect(run(k.db).phase).toBe("ready");
    expect(notes(k.db).map((n) => n.data.outcome)).toEqual(["wait-serial"]);
    expect(run(k.db, other).phase).toBe("await_review");
    await tick(k);
    expect(run(k.db).phase).toBe("merged");
  });
});

describe("[验收线 5] gh pr checks exit codes", () => {
  const checksOf = (r: BoundedResult) => privateGh(async () => r, "/tmp/x", REPO, 12).checks();
  test("exit 1 with failed checks on stdout is a red result, not a gh failure", async () => {
    expect(await checksOf(ok(JSON.stringify([{ name: "ci", bucket: "fail" }]), 1))).toEqual([{ name: "ci", bucket: "fail" }]);
  });
  test("exit 1 without a JSON list stays a gh failure (class and exit code only)", async () => {
    expect(await checksOf({ code: 1, stdout: "", stderr: SECRET_STDERR, timedOut: false })).toEqual({ fail: "gh pr checks 失败（exit 1）" });
  });
  test("exit 8 with pending checks is still read", async () => {
    expect(await checksOf(ok(JSON.stringify([{ name: "ci", bucket: "pending" }]), 8))).toEqual([{ name: "ci", bucket: "pending" }]);
  });
});

describe("[验收线 6] PM merged by hand", () => {
  test("the next pass records merged from the PR's merge commit, no gh pr merge", async () => {
    const gh = fakeGh(), k = open("on", gh);
    gh.pr = { ...gh.pr, state: "MERGED", mergeCommit: { oid: MERGE_SHA } };
    const m = await tick(k);
    expect(run(k.db)).toMatchObject({ phase: "merged", mergeSha: MERGE_SHA });
    expect(merges(gh)).toEqual([]);
    expect(m.fallbacks).toEqual([]);
    expect(notes(k.db).map((n) => n.data.outcome)).toEqual(["merged-by-pm"]);
  });

  test("a restart in `merging`: a merged PR is recorded, never merged twice", async () => {
    const gh = fakeGh(), k = open("on", gh);
    const sch = { actor: "scheduler", now: 102 };
    const { advanceMergeRun } = await import("../src/lib/scheduler-merge.js");
    advanceMergeRun(k.db, sch, { intentId: "m-T1", from: "ready", to: "await_ci", rev: 1, receipt: "x" });
    advanceMergeRun(k.db, sch, { intentId: "m-T1", from: "await_ci", to: "merging" as MergePhase, rev: 2, receipt: "y" });
    gh.pr = { ...gh.pr, state: "MERGED", mergeCommit: { oid: MERGE_SHA } };
    await tick(k);
    expect(run(k.db)).toMatchObject({ phase: "merged", mergeSha: MERGE_SHA });
    expect(merges(gh)).toEqual([]);
  });
});

describe("[验收线 7] failures say class and exit code only", () => {
  test("gh failing: retried next pass, the 3rd in a row on one head goes to PM; no stderr, URL or path anywhere", async () => {
    const gh = fakeGh({ fail: 4 }), k = open("on", gh);
    const m = managerOf(k.db);
    await tick(k, m);
    await tick(k, m);
    expect(m.fallbacks).toEqual([]);
    expect(run(k.db).phase).toBe("ready");
    await tick(k, m);
    expect(m.fallbacks).toHaveLength(1);
    expect(m.fallbacks[0]![2]).toContain("gh 连续 3 次出错：gh pr view 失败（exit 4）");
    for (const t of [...notes(k.db).map((n) => `${n.text} ${JSON.stringify(n.data)}`), m.fallbacks[0]![2]!]) expect(leaks(t)).toBe(false);
    // every ledger row of the card (its PR link is the card's own, so only URLs are allowed there)
    for (const e of k.db.query("SELECT text, data FROM events WHERE target='T1'").all() as { text: string; data: string }[]) expect(leaks(e.text + e.data, false)).toBe(false);
    expect(leaks(run(k.db).reason ?? "")).toBe(false);
    expect(merges(gh)).toEqual([]);
  });

  test("a protection read refused with 404 / 403 falls back; any other failure is a gh failure, never a fallback", async () => {
    const gh = fakeGh(), k = open("on", gh);
    const command = ghCommand(gh);
    setPrivateMergePortsForTest({ ...currentPorts(k), command: async (argv: string[]) =>
      argv[2]?.endsWith("/protection/required_status_checks") ? { code: 1, stdout: "", stderr: `HTTP 502 ${SECRET_STDERR}`, timedOut: false } : command(argv) });
    await tick(k);
    expect(merges(gh)).toEqual([]);
    expect(notes(k.db).map((n) => n.text)).toEqual(["恢复观察（privateRepoMerge）：本会 gh 出错（gh api 分支保护 失败（exit 1）），第 1 次，下轮重试"]);
  });
});

/** kit's ports again (for a test that swaps one of them). */
function currentPorts(k: Kit) {
  return {
    policy: (_p: string, key: RecoveryKey) => ({ mode: (key === "privateRepoMerge" ? "on" : key === "privateMergeNarrow" ? "off" : "observe") as RecoveryMode,
      manualAfterMs: null, source: "config" as const }),
    repoDirs: { dirs: () => [join(k.dir, "cloud")], origin: () => REPO, exists: () => true },
    ledger: () => k.db, handoff: () => false, now: () => k.clock.now,
  };
}

describe("privateMergeNarrow kept under on", () => {
  const locks = (db: Database) => (db.query("SELECT resource FROM scheduler_resources WHERE taskId='T1' AND scope='card' ORDER BY resource").all() as
    { resource: string }[]).map((r) => r.resource);
  const narrowEvents = (db: Database) => db.query("SELECT text, data FROM events WHERE target='T1' AND json_extract(data,'$.op')='merge_private_narrow'").all() as
    { text: string; data: string }[];
  function withGit(k: Kit, gh: FakeGh, diff: () => { code: number; stdout: string }, merge: () => RecoveryMode = () => "on") {
    const command = ghCommand(gh);
    setPrivateMergePortsForTest({ ...currentPorts(k), policy: (_p: string, key: RecoveryKey) =>
      ({ mode: key === "privateRepoMerge" ? merge() : "on" as RecoveryMode, manualAfterMs: null, source: "config" as const }),
      command: async (argv: string[]) => {
        if (argv[0] !== "git") return command(argv);
        if (argv[1] === "config") return { code: 0, stdout: `https://github.com/${REPO}.git\n`, stderr: "", timedOut: false };
        if (argv[1] === "fetch") return { code: 0, stdout: "", stderr: "", timedOut: false };
        const d = diff();
        return { ...d, stderr: d.code ? SECRET_STDERR : "", timedOut: false };
      } });
    for (const f of ["src/a.ts", "src/b.ts"]) {
      k.db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, 'T1', 'm-T1', 1, 'card')").run(`repo:${REPO}/${f}`);
    }
  }

  test("the card's file locks narrow once to the PR's own files (narrowTarget), then the merge goes on", async () => {
    const gh = fakeGh(), k = open("on", gh);
    let diffs = 0;
    withGit(k, gh, () => { diffs++; return { code: 0, stdout: "src/a.ts\0" }; });
    gh.checks = [{ name: "ci", bucket: "pending" }]; // first pass waits after narrowing
    await tick(k);
    expect(locks(k.db)).toEqual([`repo:${REPO}/src/a.ts`]);
    await tick(k);
    expect(diffs).toBe(1);
    expect(narrowEvents(k.db)).toHaveLength(1);
    gh.checks = [{ name: "ci", bucket: "pass" }];
    await tick(k);
    expect(run(k.db).phase).toBe("merged");
  });

  test("a failed git step keeps the locks whole and records the step and exit code only", async () => {
    const gh = fakeGh(), k = open("on", gh);
    withGit(k, gh, () => ({ code: 128, stdout: "" }));
    await tick(k);
    expect(locks(k.db)).toHaveLength(2);
    const [ev] = narrowEvents(k.db);
    expect(JSON.parse(ev!.data).skipped).toBe("git diff 失败（exit 128）");
    expect(leaks(ev!.text + ev!.data, false)).toBe(false);
    expect(run(k.db).phase).toBe("merged");
  });

  test("privateRepoMerge turned off while the PR's files are read: the write transaction rechecks it and writes nothing", async () => {
    const gh = fakeGh(), k = open("on", gh);
    let merge: RecoveryMode = "on";
    withGit(k, gh, () => { merge = "off"; return { code: 0, stdout: "src/a.ts\0" }; }, () => merge);
    await tick(k);
    expect(locks(k.db)).toHaveLength(2);
    expect(narrowEvents(k.db)).toEqual([]);
  });
});

describe("privateBounceChecks rechecks in its own transaction (lease, switch, card)", () => {
  const live = () => {};
  test("on, card still at this merge and head: the run's list becomes the names read from GitHub; the undo puts it back", () => {
    const k = open("on", fakeGh());
    const undo = privateBounceChecks(k.db, run(k.db), ["build"], { head: HEAD, assertActive: live });
    expect(run(k.db).requiredChecks).toBe("build");
    undo!();
    expect(run(k.db).requiredChecks).toBe("ci");
  });
  test("switch off, card off this head or PR, or the lease lost: nothing written", () => {
    const k = open("off", fakeGh());
    expect(privateBounceChecks(k.db, run(k.db), ["build"], { head: HEAD, assertActive: live })).toBeNull();
    current!.close();
    const k2 = open("on", fakeGh());
    expect(privateBounceChecks(k2.db, run(k2.db), ["build"], { head: NEW_HEAD, assertActive: live })).toBeNull();
    expect(privateBounceChecks(k2.db, { ...run(k2.db), prRef: `https://github.com/${REPO}/pull/13` }, ["build"], { head: HEAD, assertActive: live })).toBeNull();
    expect(() => privateBounceChecks(k2.db, run(k2.db), ["build"], { head: HEAD, assertActive: () => { throw new Error("lease lost"); } })).toThrow("lease lost");
    expect(run(k2.db).requiredChecks).toBe("ci");
  });
});
