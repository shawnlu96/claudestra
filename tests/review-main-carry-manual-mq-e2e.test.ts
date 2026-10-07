/**
 * MCRY1: the manual merge queue (MQ1) reads MAINP2's formal PM carry, and the formal carry accepts a review a PM put in the lend pool.
 * Production wiring: a real temp state dir and SQLite ledger, the PM's `ledger review` / `main-carry` / `manual-merge-request` run as
 * real `src/manager.ts ledger` child processes (registry channel identity, env -i style env, no bridge / peer / GitHub), a real Git
 * repository for the canonical multi-hop proof, the lend CLI (offer / claim / write) and B's real worker tools in process for the
 * pool review, the scheduler's `manual-merge-claim` / `scheduler-merge-step` on the real CLI, and driveMerge against a fake GitHub
 * that records every call and the expected head of the merge. Two shapes: PR775 (CLI-recorded PASS, carried by PM) and CHKL1
 * (PM `lend-offer` pool PASS). Negatives: 17 hops, non-pure-main, forged-actor carry, lend order head mismatch, deliver after the
 * carry, observe mode writes nothing.
 */
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { saveRawResult } from "../src/lib/pool-review-proof-raw.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { mainCarryKey } from "../src/lib/review-main-carry-manual.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { getMergeRun, mergeRunDrift, type MergePhase, type MergeRun } from "../src/lib/scheduler-merge.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { B_WORKER, lendSide } from "./pool-review-proof-helpers.js";
import { testChildEnv } from "./test-env.js";

const PM = "agent-pm", PM_CHANNEL = "777000111", REPO = "o/r", PR = `https://github.com/${REPO}/pull/7`;
const MANAGER = join(import.meta.dir, "../src/manager.ts");
let root = "", work = "";
let oldHead = "", main1 = "", one = "", many = "", dirty = "", oldMain = "";

const sh = async (...args: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: work, timeoutMs: 30_000 });
  if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = async (f: string, v: string) => { writeFileSync(join(work, f), `${v}\n`); await sh("add", "-A"); await sh("commit", "-qm", v); return sh("rev-parse", "HEAD"); };

/**
 * feature@oldHead (the reviewed head); one = 1 pure main merge (main1); many = 17 pure main merges (the 17th main commit is the
 * actual main for that case); dirty = a main merge plus an extra feature change.
 */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mcry1-e2e-")); work = join(root, "repo"); mkdirSync(work);
  await sh("init", "-q", "-b", "main");
  await commit("shared", "base");
  await sh("checkout", "-qb", "feature"); oldHead = await commit("feature", "reviewed");
  await sh("checkout", "-q", "main"); main1 = await commit("m1", "main one");
  await sh("checkout", "-q", "feature"); await sh("merge", "-q", "--no-edit", main1); one = await sh("rev-parse", "HEAD");
  await commit("feature", "extra change after review"); dirty = await sh("rev-parse", "HEAD");
  await sh("checkout", "-q", "-B", "many", oldHead);
  for (let i = 2; i <= 18; i++) {
    await sh("checkout", "-q", "main"); oldMain = await commit(`m${i}`, `main ${i}`);
    await sh("checkout", "-q", "many"); await sh("merge", "-q", "--no-edit", oldMain);
  }
  many = await sh("rev-parse", "HEAD");
  await sh("remote", "add", "origin", `https://github.com/${REPO}.git`);
  await sh("update-ref", "refs/remotes/origin/main", main1);
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

type Json = Record<string, any>;
let w: ReturnType<typeof world> | null = null;
afterEach(() => { w?.close(); w = null; rmSync(RECOVERY_POLICY_PATH, { force: true }); });

/** One production-shaped state dir: ledger, registry (PM bound to a channel), projects, recovery policy; the card T in review at oldHead. */
function world(o: { mainCarry?: "on" | "observe" } = {}) {
  const state = mkdtempSync(join(root, "state-")), db: Database = openLedger(join(state, "ledger.sqlite"));
  writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "", agents: { [PM]: { channelId: PM_CHANNEL, projectId: "p" } } }));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [], createdAt: "2026-10-07T00:00:00Z" }] }));
  const policy = JSON.stringify({ projects: { p: { keys: { mainCarry: o.mainCarry ?? "on", manualMergeQueue: "on" } } } });
  writeFileSync(join(state, "recovery-policy.json"), policy);
  writeFileSync(RECOVERY_POLICY_PATH, policy); // the in-process scheduler side (claim / drift) reads the test process's own copy
  const reviews = join(state, "ledger", "reviews");
  mkdirSync(reviews, { recursive: true });
  setMeta(db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
  const spec = join(state, "T.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now: 2 }, { project: "p", id: "T", title: "T", kind: "code", agent: "agent-author", spec } as never);
  setWorkflow(db, { actor: "owner", now: 3 }, { taskId: "T", taskRev: getTask(db, "T")!.rev, template: "code", templateVersion: 2,
    mode: "manual", authorFamily: "claude", fallback: "人工", reason: "PM 接管，人工审查后合并" });
  db.query("UPDATE tasks SET stage = 'review', round = 1, headSHA = ?, pr = ?, branch = 'task/T', rev = rev + 1 WHERE id = 'T'").run(oldHead, PR);

  /** The PM's command in a real child process: its own CLI parse, registry identity, the state dir's ledger and policy. */
  const child = async (...args: string[]): Promise<Json> => {
    const env = testChildEnv({ CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run"), DISCORD_CHANNEL_ID: PM_CHANNEL });
    const p = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", MANAGER, "ledger", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    try { return JSON.parse(out.trim().split("\n").at(-1) ?? ""); } catch { throw new Error(`ledger ${args[0]}: ${out}\n${err}`); }
  };
  // The lend side: A's lend CLI with its result deps in this state dir (reports where reports live), B answering with real worker tools.
  const b = lendSide(state);
  const aKey = instanceKeySync(mkdtempSync(join(state, "a-key-")));
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 1 }];
  const lend = { borrow: async () => borrow, notifyPm: async () => {}, result: {
    reportDir: (x: { taskId: string; round: number }) => join(reviews, `${x.taskId}-r${x.round}`),
    writeReport: (p: string, t: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); },
    sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, aKey), saveRaw: (t: string) => saveRawResult(join(state, "lend-raw"), t), pinnedKey: async () => b.pinned,
  } };
  const inProc = (actor: string, ...args: string[]) => runLedger(args, { db, actor, projectIds: ["p"], now: () => Date.now(),
    loadRegistry: async () => ({ socket: "", agents: {} }) as unknown as Registry, saveRegistry: async () => {}, lend } as never) as Promise<Json>;
  const close = () => { db.close(); rmSync(state, { recursive: true, force: true }); };
  return { state, db, reviews, child, inProc, b, close };
}
type World = ReturnType<typeof world>;
const events = (x: World) => listEvents(x.db, { project: "p", target: "T" });
const reviewSeq = (x: World) => events(x).findLast((e) => e.kind === "review")!.seq;
const snapshot = (x: World) => JSON.stringify([getTask(x.db, "T"), events(x).length]);

/** PR775 shape: the cross-family PASS recorded the official manual way, `ledger review` by the PM (child process). */
async function cliReviewed(x: World): Promise<number> {
  const findings = join(x.state, "findings.json"), report = join(x.reviews, "T.md");
  writeFileSync(findings, "[]");
  writeFileSync(report, `# 审查 T\n\nhead ${oldHead}\n\nPASS\n`);
  const r = await x.child("review", "T", "--reviewer", "agent-review", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0", "--head", oldHead,
    "--session", "rs-T", "--family", "codex", "--findings", findings, "--path", report, "--to", "merge");
  expect(r).toMatchObject({ ok: true });
  return reviewSeq(x);
}

/** CHKL1 shape: the PM put the round's review in the lend pool (`lend-offer`), B claimed and answered it through submit_verdict. */
async function lendReviewed(x: World): Promise<number> {
  expect(await x.inProc(PM, "lend-offer", "T", "--peer", "mate", "--repo", REPO)).toMatchObject({ ok: true });
  const [order] = listLendOrders(x.db, "T");
  expect(order).toMatchObject({ createdBy: PM, step: "review" });
  const peer = (ep: string, body: unknown) => x.inProc("owner", `lend-${ep}`, "--", "mate", JSON.stringify(body));
  const claim = await peer("claim", { v: 1, orderId: order!.orderId, worker: B_WORKER });
  expect(claim.ok).toBe(true);
  const a = await x.b.answer(claim as never, { verdict: "pass", findings: [], report: `## 结论\n\nhead ${oldHead} 通过\n` }, (body) => peer("write", body));
  expect(a.r).toMatchObject({ ok: true });
  if (getTask(x.db, "T")!.stage !== "merge") x.db.query("UPDATE tasks SET stage = 'merge', rev = rev + 1 WHERE id = 'T'").run();
  return reviewSeq(x);
}

const carryArgs = (x: World, seq: number, to: string, main = main1) =>
  ["main-carry", "T", "--old", oldHead, "--new", to, "--main", main, "--spec-rev", String(getTask(x.db, "T")!.specRev), "--round", "1",
    "--review-seq", String(seq), "--rev", String(getTask(x.db, "T")!.rev), "--repo-dir", work];
const requestArgs = (x: World, seq: number, head: string) =>
  ["manual-merge-request", "T", "--head", head, "--spec-rev", String(getTask(x.db, "T")!.specRev), "--round", "1", "--review-seq", String(seq),
    "--reason", "PR 合过 main，PM 正式沿用后排队合并"];

/** Fake GitHub at `head` (green, clean, up to date): every call and the merge's expected head are recorded. */
function github(head: string) {
  const calls: string[] = [], merged: { pr: string; expected: string }[] = [];
  const pr = (): PrSnapshot => ({ state: merged.length ? "MERGED" : "OPEN", head, branch: "task/T", base: "main", draft: false, crossRepository: false,
    mergeState: "CLEAN", mergeSha: merged.length ? "f".repeat(40) : null, checks: [{ name: "check", bucket: "pass" }] });
  const external: MergeExternal = {
    inspect: async (p) => { calls.push(`inspect ${p}`); return pr(); },
    freshness: async (p, h) => { calls.push(`freshness ${p} ${h}`); return { behindBy: 0, mainHead: main1 }; },
    carryReview: async () => { throw new Error("不该再沿用"); },
    updateBranch: async (p) => { calls.push(`update-branch ${p}`); },
    merge: async (p, expected) => { calls.push(`merge ${p} ${expected}`); merged.push({ pr: p, expected }); return "f".repeat(40); },
  };
  return { external, calls, merged };
}

/** The scheduler's half on the real CLI: claim the queue head, then drive from ready with the production driver. */
async function claimAndDrive(x: World, head: string) {
  const claim = await x.inProc("scheduler", "manual-merge-claim", "p", "--mode", "on", "--train", "none", "--required-checks", "check");
  expect(claim).toMatchObject({ ok: true, claimed: true });
  const intent = String(claim.intentId), gh = github(head);
  const advance = async (from: MergePhase, to: MergePhase, _rev: number, receipt?: string, mergeSha?: string, newHead?: string) => {
    const args = ["scheduler-merge-step", intent, "--from", from, "--to", to, "--rev", String(getMergeRun(x.db, intent)!.rev)];
    if (receipt) args.push("--receipt", receipt);
    if (mergeSha) args.push("--merge-sha", mergeSha);
    if (newHead) args.push("--new-head", newHead);
    const r = await x.inProc("scheduler", ...args);
    if (r.ok !== true) throw new Error(`scheduler-merge-step: ${String(r.error)}`);
    return r.run as MergeRun;
  };
  const ready = getMergeRun(x.db, intent)!;
  expect(ready).toMatchObject({ phase: "ready", reviewedHead: head });
  const first = await driveMerge(ready, gh.external, advance, () => {}, (r) => mergeRunDrift(x.db, r));
  return { intent, first, gh, again: () => driveMerge(getMergeRun(x.db, intent)!, gh.external, advance, () => {}, (r) => mergeRunDrift(x.db, r)) };
}

describe("MCRY1 production wiring: formal PM carry → manual merge request → merge driver", () => {
  test("PR775 shape: a CLI-recorded PASS carried by `main-carry` (on) is queued by manual-merge-request and merged at the carried head", async () => {
    const x = w = world();
    const seq = await cliReviewed(x);
    const carried = await x.child(...carryArgs(x, seq, one));
    expect(carried).toMatchObject({ ok: true, status: "carried", plan: { from: oldHead, to: one, hops: 1, sourceKind: "cli", sourceReviewSeq: seq } });
    expect(getTask(x.db, "T")!.headSHA).toBe(one);
    const req = await x.child(...requestArgs(x, seq, one));
    expect(req).toMatchObject({ ok: true, state: "queued" });
    const d = await claimAndDrive(x, one);
    expect(d.first.phase).toBe("await_ci"); // ready accepted the carried head: no "审查 head 已变" unknown
    expect(d.gh.calls).toEqual([`inspect ${PR}`, `freshness ${PR} ${one}`]);
    const end = await d.again();
    expect(end.phase).toBe("merged");
    expect(d.gh.merged).toEqual([{ pr: PR, expected: one }]);
  }, 60_000);

  test("CHKL1 shape: a PM `lend-offer` pool PASS is a formal carry source, then queues and merges at the carried head", async () => {
    const x = w = world();
    const seq = await lendReviewed(x);
    const carried = await x.child(...carryArgs(x, seq, one));
    expect(carried).toMatchObject({ ok: true, status: "carried", plan: { from: oldHead, to: one, sourceKind: "lend", sourceReviewSeq: seq } });
    expect(carried.plan.reportSha256).toMatch(/^[a-f0-9]{64}$/);
    const req = await x.child(...requestArgs(x, seq, one));
    expect(req).toMatchObject({ ok: true, state: "queued" });
    const d = await claimAndDrive(x, one);
    expect(d.first.phase).toBe("await_ci");
    expect((await d.again()).phase).toBe("merged");
    expect(d.gh.merged).toEqual([{ pr: PR, expected: one }]);
  }, 60_000);
});

describe("MCRY1 negatives: nothing is widened", () => {
  test("17 pure-main hops: main-carry refuses, nothing written", async () => {
    const x = w = world();
    const seq = await cliReviewed(x);
    await sh("update-ref", "refs/remotes/origin/main", oldMain);
    try {
      const before = snapshot(x);
      const r = await x.child(...carryArgs(x, seq, many, oldMain));
      expect(r.ok).toBe(false);
      expect(String(r.error)).toMatch(/超过有限链长|16/);
      expect(snapshot(x)).toBe(before);
    } finally { await sh("update-ref", "refs/remotes/origin/main", main1); }
  }, 60_000);

  test("non-pure-main (a feature change after the merge): refused, nothing written", async () => {
    const x = w = world();
    const seq = await cliReviewed(x);
    const before = snapshot(x);
    const r = await x.child(...carryArgs(x, seq, dirty));
    expect(r.ok).toBe(false);
    expect(snapshot(x)).toBe(before);
  }, 60_000);

  test("observe mode reports the plan and writes nothing; the request is then refused (no carry, head moved)", async () => {
    const x = w = world({ mainCarry: "observe" });
    const seq = await cliReviewed(x);
    const before = snapshot(x);
    expect(await x.child(...carryArgs(x, seq, one))).toMatchObject({ ok: true, status: "observe", plan: { to: one } });
    expect(snapshot(x)).toBe(before);
    expect(getTask(x.db, "T")!.headSHA).toBe(oldHead);
    expect((await x.child(...requestArgs(x, seq, one))).ok).toBe(false);
  }, 60_000);

  test("a forged review_main_carry (actor not a PM, same shape and key) is not read: the request is refused", async () => {
    const x = w = world();
    const seq = await cliReviewed(x);
    const t = getTask(x.db, "T")!, now = Date.now();
    // Same transaction shape the formal entry writes, by someone who is not a project PM / master / owner.
    x.db.transaction(() => {
      insertEvent(x.db, { actor: "agent-author", now }, { project: "p", target: "T", kind: "task", text: "", data: { patch: { headSHA: one } } }, false);
      x.db.query("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = 'T'").run(one);
      insertEvent(x.db, { actor: "agent-author", now, dedupKey: mainCarryKey("T", oldHead, one) }, { project: "p", target: "T", kind: "decision", text: "",
        data: { op: "review_main_carry", carrySource: "pm", from: oldHead, to: one, mainHead: main1, mainParent: main1, diffHash: "a".repeat(64),
          sourceReviewSeq: seq, round: t.round, specRev: t.specRev } }, true);
    })();
    const r = await x.child(...requestArgs(x, seq, one));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/--review-seq/);
  }, 60_000);

  test("deliver after the formal carry breaks it: the request is refused", async () => {
    const x = w = world();
    const seq = await cliReviewed(x);
    expect(await x.child(...carryArgs(x, seq, one))).toMatchObject({ ok: true, status: "carried" });
    insertEvent(x.db, { actor: "agent-author", now: Date.now() }, { project: "p", target: "T", kind: "deliver", text: "又交了一版", data: { head: one } }, false);
    const r = await x.child(...requestArgs(x, seq, one));
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/--review-seq/);
  }, 60_000);

  test("PM lend orders that do not match: head, a non-PM creator, a scheduler order without its intent — all refused, nothing written", async () => {
    const tamper: [string, string, RegExp][] = [
      ["head not the reviewed one", `UPDATE lend_orders SET head = '${main1}'`, /head \/ 轮次 \/ specRev/],
      ["created by the author, not a PM", "UPDATE lend_orders SET createdBy = 'agent-author'", /不是项目 PM 用 lend-offer 挂的/],
      ["claims the scheduler made it (no scheduler intent)", "UPDATE lend_orders SET createdBy = 'scheduler'", /没有对应的调度器派审意图/],
      ["order id not the ledger's own shape", "UPDATE lend_orders SET orderId = orderId || 'x'", /没有本卡的出借单|不是项目 PM/],
    ];
    for (const [name, sql, why] of tamper) {
      w?.close();
      const x = w = world();
      const seq = await lendReviewed(x);
      x.db.run(sql);
      const before = snapshot(x);
      const r = await x.child(...carryArgs(x, seq, one));
      expect({ name, ok: r.ok }).toEqual({ name, ok: false });
      expect({ name, error: String(r.error) }).toEqual({ name, error: expect.stringMatching(why) });
      expect({ name, same: snapshot(x) === before }).toEqual({ name, same: true });
    }
  }, 120_000);

  test("a carry event read by currentReviewFacts: only a project PM's, complete, keyed, paired, this round / specRev / review", async () => {
    const x = w = world();
    const seq = await cliReviewed(x);
    expect(await x.child(...carryArgs(x, seq, one))).toMatchObject({ ok: true, status: "carried" });
    const task = getTask(x.db, "T")!, all = events(x), may = (a: string) => a === PM;
    expect(currentReviewFacts(task, all, may)).toMatchObject({ kind: "facts", facts: { eventSeq: seq, head: oldHead } });
    expect(currentReviewFacts(task, all).kind).toBe("invalid"); // a caller without the identity check never reads PM carries
    const carry = all.find((e) => e.data.op === "review_main_carry")!;
    const variants: [string, (e: LedgerEvent) => LedgerEvent][] = [
      ["actor not a PM", (e) => ({ ...e, actor: "agent-author" })],
      ["no diffHash", (e) => ({ ...e, data: { ...e.data, diffHash: undefined } })],
      ["no mainHead", (e) => ({ ...e, data: { ...e.data, mainHead: undefined } })],
      ["other review", (e) => ({ ...e, data: { ...e.data, sourceReviewSeq: seq - 1 } })],
      ["other round", (e) => ({ ...e, data: { ...e.data, round: task.round + 1 } })],
      ["other specRev", (e) => ({ ...e, data: { ...e.data, specRev: task.specRev + 1 } })],
      ["other key", (e) => ({ ...e, dedupKey: "main-carry:T:x:y" })],
      ["not from the reviewed head", (e) => ({ ...e, data: { ...e.data, from: main1 } })],
    ];
    for (const [name, change] of variants) {
      const read = currentReviewFacts(task, all.map((e) => e.seq === carry.seq ? change(e) : e), may);
      expect({ name, kind: read.kind }).toEqual({ name, kind: "invalid" });
    }
    const unpaired = all.filter((e) => e.seq !== carry.seq - 1);
    expect(currentReviewFacts(task, unpaired, may).kind).toBe("invalid");
  }, 60_000);
});
