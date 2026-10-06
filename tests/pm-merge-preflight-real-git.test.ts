/**
 * MAINP2 r3 merge-proof：真实 Git 两跳纯 main + 临时 SQLite 真 PASS。正式 carry 之后，merge API 前的 canonical 证明的 oldHead 只取台账
 * 审查 head（不收 --reviewed-head），对当前 actual main 现跑：main 自己再合原审查 head（merge-base 不唯一）后证明失败 → 零合并调用。
 * gh 全部是结构化 argv 的计数替身，origin 是 GitHub URL 但 origin/main 是本地 ref，不连网。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { statePath } from "../src/lib/paths.js";
import { runManualCarry } from "../src/lib/review-main-carry-manual.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { manualMergeAuth } from "../src/lib/review-main-carry-manual-merge.js";
import { reviewMainCarryProof } from "../src/lib/review-main-carry-proof.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { advanceMergeRun, beginMergeRun, carryReceipt, getMergeRun, type MergePhase } from "../src/lib/scheduler-merge.js";
import { main as cli, type Run } from "../scripts/pm-merge-preflight.js";

const REPO = "example/proof", PR = `https://github.com/${REPO}/pull/1`;
const CHECKS = ["typecheck", "test-1", "test-2", "test-3", "guard", "build", "web"];
let root = "", work = "", ledgerPath = "", db: Database, clock = 1_000_000;
let oldHead = "", main1 = "", main2 = "", one = "", two = "";
const sh = async (...args: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: work, timeoutMs: 30_000 });
  if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = async (p: string, m: string) => { writeFileSync(join(work, p), `${m}\n`); await sh("add", "-A"); await sh("commit", "-qm", m); return sh("rev-parse", "HEAD"); };
const at = (h: string) => sh("checkout", "-q", "--detach", h);
const actualMain = (h: string) => sh("update-ref", "refs/remotes/origin/main", h);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mainp2-pf-git-")); work = join(root, "repo"); mkdirSync(work);
  ledgerPath = join(root, "ledger.sqlite"); db = openLedger(ledgerPath);
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"pm\"]') ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run();
  await sh("init", "-q", "-b", "main");
  await sh("remote", "add", "origin", `https://github.com/${REPO}.git`);
  const base = await commit("shared", "base");
  await sh("checkout", "-qb", "feature"); oldHead = await commit("feature", "reviewed");
  await at(base); main1 = await commit("main1", "main one"); main2 = await commit("main2", "main two");
  await actualMain(main2);
  await at(oldHead); await sh("merge", "-q", "--no-edit", main1); one = await sh("rev-parse", "HEAD");
  await sh("merge", "-q", "--no-edit", main2); two = await sh("rev-parse", "HEAD");
});
afterAll(() => { closeLedger(ledgerPath); if (root) rmSync(root, { recursive: true, force: true }); });

/** A card set up like card() but on auto, its merge run open (intent, slot, reviewer session): the engine owns the carries. */
function engineCard(id: string) {
  mkdirSync(statePath("ledger", "reviews"), { recursive: true });
  writeFileSync(statePath("ledger", "reviews", `${id}.md`), `# 审查 ${id}\n\nhead ${oldHead}\n\nPASS\n`);
  createTask(db, { actor: "owner", now: ++clock }, { project: "p", id, title: id, kind: "code", agent: "agent-author" });
  setWorkflow(db, { actor: "owner", now: ++clock }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto",
    authorFamily: "claude", fallback: "人工" });
  db.query("UPDATE tasks SET stage='merge', round=1, headSHA=?, pr=?, branch=?, updatedAt=? WHERE id=?").run(oldHead, PR, `task/${id}`, ++clock, id);
  const seq = insertEvent(db, { actor: "agent-rv", now: ++clock }, { project: "p", target: id, kind: "review", text: "",
    data: { round: 1, head: oldHead, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: `rs-${id}`, reviewerFamily: "codex",
      path: `reviews/${id}.md`, findings: [], p0: 0, p1: 0, p2: 0 } }, false).seq;
  const rev = getTask(db, id)!.rev;
  for (const [intent, node, action, status] of [[`${id}-rv`, "adversarial_review", "ensure_session", "done"], [`${id}-mq`, "merge_deploy", "merge", "submitted"]]) {
    db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
      VALUES (?,?,'p',?,?,1,?,?,1,?,2,?,'x',?,?)`).run(intent, id, node, action, seq, rev, oldHead, status, clock, clock);
  }
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p',?,?,?)").run(id, `${id}-mq`, clock);
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES (?,'reviewer','agent-rv',?,'codex','acp','active',?,?,?)`).run(id, `rs-${id}`, `${id}-rv`, clock, clock);
  beginMergeRun(db, { actor: "scheduler", now: ++clock }, `${id}-mq`, CHECKS);
  return (from: MergePhase, to: MergePhase, receipt?: string, newHead?: string, actor = "scheduler") =>
    advanceMergeRun(db, { actor, now: ++clock }, { intentId: `${id}-mq`, from, to, rev: getMergeRun(db, `${id}-mq`)!.rev, receipt, newHead });
}

/** Manual code card in merge at the reviewed head, this round's PASS by a codex reviewer (author claude), its report on disk. */
function card(id: string) {
  mkdirSync(statePath("ledger", "reviews"), { recursive: true });
  writeFileSync(statePath("ledger", "reviews", `${id}.md`), `# 审查 ${id}\n\nhead ${oldHead}\n\nPASS\n`);
  createTask(db, { actor: "owner", now: ++clock }, { project: "p", id, title: id, kind: "code", agent: "agent-author" });
  setWorkflow(db, { actor: "owner", now: ++clock }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "manual",
    authorFamily: "claude", fallback: "人工", reason: "pm_takeover: PM 手动推进合并" });
  db.query("UPDATE tasks SET stage='merge', round=1, headSHA=?, pr=?, branch=?, updatedAt=? WHERE id=?").run(oldHead, PR, `task/${id}`, ++clock, id);
  return insertEvent(db, { actor: "agent-rv", now: ++clock }, { project: "p", target: id, kind: "review", text: "",
    data: { round: 1, head: oldHead, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "rs-1", reviewerFamily: "codex",
      path: `reviews/${id}.md`, findings: [], p0: 0, p1: 0, p2: 0 } }, false).seq;
}

function fakeGh(main: () => string) {
  let mergeCalls = 0;
  const run: Run = async (argv, opts) => {
    if (argv[0] === "git") return runBounded(argv[1] === "fetch" ? ["git", "rev-parse", "HEAD"] : argv, opts); // fetch is local: objects already here
    let out: unknown;
    if (argv[1] === "pr") out = { state: "OPEN", headRefOid: two, baseRefName: "main", isDraft: false, isCrossRepository: false };
    else if (argv.includes(`repos/${REPO}/git/ref/heads/main`)) out = { object: { sha: main() } };
    else if (argv.some((x) => x.includes("check-runs"))) out = { total_count: CHECKS.length,
      check_runs: CHECKS.map((name, i) => ({ id: i + 1, name, head_sha: two, status: "completed", conclusion: "success" })) };
    else if (argv.includes(`repos/${REPO}/pulls/1/merge`)) { mergeCalls++; out = { merged: true, sha: main() }; }
    else throw new Error(JSON.stringify(argv));
    return { code: 0, stdout: JSON.stringify(out), stderr: "", timedOut: false };
  };
  return { run, merges: () => mergeCalls };
}

test("r3 merge-proof: the proof's oldHead is the ledger's reviewed head; a carry that no longer proves on the actual main never merges", async () => {
  const reviewSeq = card("T1"), t = getTask(db, "T1")!;
  const carried = await runManualCarry(db, { actor: "pm", now: ++clock }, { taskId: "T1", oldHead, newHead: two, mainHead: main2,
    specRev: t.specRev, round: 1, reviewSeq, rev: t.rev }, { repoDir: work, policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }) });
  expect(carried.status).toBe("carried");
  let proofs: string[] = [];
  const go = (mainSha: string, g: ReturnType<typeof fakeGh>, more: string[] = []) => cli(["--task", "T1", "--pr", PR, "--expected-head", two,
    "--actual-main", mainSha, "--repo-dir", work, "--merge", ...more], { run: g.run, ledger: () => db, actor: () => "pm", checksOf: () => CHECKS,
    sleep: async () => {}, prove: async (i) => { proofs.push(i.oldHead); return reviewMainCarryProof(i); } });

  // positive control: on main2 the real proof holds, it runs twice from the ledger's reviewed head, one pinned merge
  const ok = fakeGh(() => main2);
  expect((await go(main2, ok)).exit).toBe(0);
  expect([proofs, ok.merges()]).toEqual([[oldHead, oldHead], 1]);

  // main itself merges the reviewed feature: two merge bases, the canonical proof fails closed
  await at(main2); await sh("merge", "-q", "--no-edit", oldHead);
  const nextMain = await sh("rev-parse", "HEAD");
  await actualMain(nextMain);
  expect((await reviewMainCarryProof({ repoDir: work, repository: REPO, base: "main", mainHead: nextMain, oldHead, newHead: two })).ok).toBe(false);
  for (const more of [[], ["--reviewed-head", two]]) {
    proofs = [];
    const g = fakeGh(() => nextMain), r = await go(nextMain, g, more);
    expect(r.exit).toBe(2);
    expect(g.merges()).toBe(0);
    if (!more.length) expect([proofs, r.lines.at(-1)]).toEqual([[oldHead], expect.stringContaining("合并未发出：纯 main 合并证明不成立")]);
  }
});

test("r4 merge-proof: after engine carries and a PM takeover the proof still starts at the real PASS head, never the carried head", async () => {
  await actualMain(main2);
  const step = engineCard("T2"), DIFF = "9".repeat(64);
  const hop = (from: string, to: string, parent: string) => carryReceipt({ oldHead: from, newHead: to, mainParent: parent, mainHead: parent, diffHash: DIFF })
    + carryChainSuffix([{ previousHead: from, head: to, mainParent: parent }]);
  // two real single-hop engine carries H → H+main1 → H+main1+main2, each committed with its merge_phase
  step("ready", "updating"); step("updating", "await_ci", hop(oldHead, one, main1), one);
  step("await_ci", "updating", "main 前进，重新更新"); step("updating", "await_ci", hop(one, two, main2), two);
  expect(getTask(db, "T2")!.headSHA).toBe(two);
  // the PM takes the card over (manual) and closes the unsent engine merge: journal resolved, slot released
  const wf = getWorkflow(db, "T2")!;
  setWorkflow(db, { actor: "pm", now: ++clock }, { taskId: "T2", taskRev: getTask(db, "T2")!.rev, workflowRev: wf.rev, template: "code", templateVersion: 2,
    mode: "manual", authorFamily: "claude", fallback: "人工", reason: "pm_takeover: PM 手动推进合并" });
  step("await_ci", "resolved", "PM 接管，引擎合并未发出", undefined, "pm");
  expect(getMergeRun(db, "T2-mq")!.phase).toBe("resolved");
  const auth = manualMergeAuth(db, "pm", { taskId: "T2", pr: PR, head: two }, clock);
  expect(auth).toMatchObject({ ok: true, auth: { base: oldHead, head: two } });

  let proofs: string[] = [];
  const go = (mainSha: string, g: ReturnType<typeof fakeGh>) => cli(["--task", "T2", "--pr", PR, "--expected-head", two, "--actual-main", mainSha,
    "--repo-dir", work, "--merge"], { run: g.run, ledger: () => db, actor: () => "pm", checksOf: () => CHECKS, sleep: async () => {},
    prove: async (i) => { proofs.push(i.oldHead); return reviewMainCarryProof(i); } });
  // positive control: the same actual main the engine proved on, real proof from the PASS head both times, one pinned merge
  const ok = fakeGh(() => main2);
  expect((await go(main2, ok)).exit).toBe(0);
  expect([proofs, ok.merges()]).toEqual([[oldHead, oldHead], 1]);

  // main itself merges the reviewed head: H → N no longer proves on the actual main, so nothing is merged
  await at(main2); await sh("merge", "-q", "--no-edit", oldHead);
  const nextMain = await sh("rev-parse", "HEAD");
  await actualMain(nextMain);
  expect((await reviewMainCarryProof({ repoDir: work, repository: REPO, base: "main", mainHead: nextMain, oldHead, newHead: two })).ok).toBe(false);
  proofs = [];
  const g = fakeGh(() => nextMain), r = await go(nextMain, g);
  expect([r.exit, proofs, g.merges()]).toEqual([2, [oldHead], 0]);
  expect(r.lines.at(-1)).toContain("合并未发出：纯 main 合并证明不成立");
});
