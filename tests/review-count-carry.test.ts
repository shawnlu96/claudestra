/**
 * CARRYCNT1 through the real merge tick and ledger on a real git repository (this checkout's src/lib as main, H0 = one more effect
 * site in a registered file, H1 = EFFAUTO1's count commit on it): EFFAUTO1 (ports stubbed, trial = H1) claims `updating` and pushes;
 * the next pass meets H1, the pure-main proof refuses (stub), and the count proof (real git, only `gh pr view` faked) carries the
 * review: await_ci, PASS still read, no re-review. Without this card (and under off / observe, or any one-change refusal) the same
 * pass goes back to review with movedHeadReceipt(H0, H1, pure-main refusal), round + 1 — tests/effect-count-refresh.test.ts:118.
 * The merged result passes verifyMergedCarry; tampered count records do not.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useEffCountRefreshPorts, type RefreshNote } from "../src/lib/effect-count-refresh.js";
import { REFRESH_SUBJECT, type RefreshTrial } from "../src/lib/effect-count-refresh-git.js";
import { mustTask } from "../src/lib/ledger-checks.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getMeta, listEvents, openLedger } from "../src/lib/ledger-store.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { createTask } from "../src/lib/ledger-write.js";
import { scopeBytesIn, scopeRunIn, type ScopeRun } from "../src/lib/order-deliver-scope-git.js";
import { RECOVERY_KEYS } from "../src/lib/recovery-keys.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { useCountCarryPorts, type CountCarryNote } from "../src/lib/review-count-carry.js";
import { EFF_COUNT_CARRY_KEY, useCountCarryLedgerMode } from "../src/lib/review-count-carry-ledger.js";
import { badCountValues, countCarryProof, type CountProofIo } from "../src/lib/review-count-carry-proof.js";
import { checkCountCarry } from "../src/lib/review-count-carry-verify.js";
import { verifyMergedCarry } from "../src/lib/review-main-carry-manual-verify.js";
import { sendSourceRefusal } from "../src/lib/review-main-carry-send-source.js";
import { runBounded, type BoundedResult } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { ciRerunGh } from "../src/lib/scheduler-merge-ci-rerun.js";
import type { MergeExternal, PrSnapshot, ReviewCarry } from "../src/lib/scheduler-merge-driver.js";
import { advanceMergeRun, beginMergeRun, getMergeRun, mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { movedHeadReceipt } from "../src/lib/scheduler-review-rebase.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

const ROOT = join(import.meta.dir, ".."), INVENTORY = "src/lib/scheduler-v2-skip-effects.ts", TARGET = "src/lib/scheduler-merge-conflict.ts";
const PR = "https://github.com/example/repo/pull/7", RUN = "https://github.com/example/repo/actions/runs/77";
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];
const EXTRA_SITE = "\nexport const zzCountCarry = (q: { run(): void }) => q.run();\n";
const PURE_MAIN: ReviewCarry = { ok: false, reason: "新 head 不是双亲普通 merge" };
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });
const at = (line: string) => `ci\tRun tests\t2026-10-14T03:02:03.1234567Z ${line}`;
const COUNT_ONLY = [at("##[group]tests/skip-effects.test.ts:"), at("(fail) EFFCNT1 real inventory end to end > the real inventory matches the scan [9.00ms]"),
  at("##[endgroup]"), at(" 1 fail"), at("Ran 2 tests across 1 files. [1.00s]"), at("##[error]Process completed with exit code 1.")].join("\n");
const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const ciGh = async (argv: string[]): Promise<BoundedResult> => {
  const cmd = argv.slice(1).join(" ");
  if (cmd === "run view 77 --repo example/repo --json attempt,status,conclusion") return ok(JSON.stringify({ attempt: 1, status: "completed", conclusion: "failure" }));
  if (cmd === "run view 77 --repo example/repo --log-failed") return ok(COUNT_ONLY);
  if (cmd === `pr view ${PR} --json files`) return ok(JSON.stringify({ files: [{ path: TARGET }] }));
  return { code: 1, stdout: "", stderr: `unexpected gh ${cmd}`, timedOut: false };
};
const red = (head: string, draft = false): PrSnapshot => ({ state: "OPEN", head, branch: "feat/t9", base: "main", draft, crossRepository: false,
  mergeState: "UNSTABLE", mergeSha: null, checks: [{ name: "ci", bucket: "fail", link: `${RUN}/job/9` }] });

let root = "", work = "", base = "", H0 = "", H1 = "";
const sh = async (cwd: string, ...args: string[]) => {
  const r = await runBounded(["git", ...IDENTITY, ...args], { cwd, timeoutMs: 60_000 });
  if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
};
const git = (...args: string[]) => sh(work, ...args);
const edit = (path: string, f: (text: string) => string) => writeFileSync(join(work, path), f(readFileSync(join(work, path), "utf8")));
/** TARGET's entry, one more stmt site (the trusted scan's count for EXTRA_SITE); `tail` is appended to the new value. */
const bumpText = (tail = "") => (t: string) => t.replace(/("scheduler-merge-conflict\.ts": ")([^"]+)(")/,
  (_m, a: string, v: string, b: string) => `${a}${v.replace(/stmt=(\d+)/, (_s, n: string) => `stmt=${Number(n) + 1}`)}${tail}${b}`);
const bump = () => edit(INVENTORY, bumpText());
async function commitOn(parent: string, change: () => void, subject = REFRESH_SUBJECT): Promise<string> {
  await git("checkout", "-q", "--detach", parent);
  change();
  await git("add", "-A"); await git("commit", "-q", "--allow-empty", "-m", subject);
  return git("rev-parse", "HEAD");
}

interface ProofOver { prHead?: string; gitTimeout?: boolean; ghTimeout?: boolean }
let proofCalls = 0;
/** Real git in the fixture repo; `gh pr view` answers base / headRefOid (H1 unless said), or times out. */
function io(newHead: string, over: ProofOver = {}): CountProofIo {
  const wrap = (inner: ScopeRun): ScopeRun => async (cmd, args) => {
    proofCalls++;
    if (cmd === "gh") {
      if (over.ghTimeout) throw new Error("gh pr 超时");
      return JSON.stringify({ baseRefOid: base, headRefOid: over.prHead ?? newHead });
    }
    if (over.gitTimeout) throw new Error(`git ${args[0]} 超时`);
    return inner(cmd, args);
  };
  return { run: wrap(scopeRunIn(work)), scanRun: wrap(scopeRunIn(work)), objectsRun: wrap(scopeRunIn(work, 90_000)), bytes: scopeBytesIn(work, 90_000) };
}

/** The deploy kit's auto card (cross-family PASS at `head`), its merge run at await_ci on `head`. */
function cardAt(head: string) {
  const dir = mkdtempSync(join(tmpdir(), "count-carry-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const pm = { actor: "owner", now: 100 }, sch = { actor: "scheduler", now: 101 };
  createTask(db, pm, { project: "p", id: "T9", title: "count carry", kind: "code", agent: "agent-author" });
  setWorkflow(db, pm, { taskId: "T9", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接手" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch='feat/t9' WHERE id='T9'").run(head, PR);
  const intent = (id: string, node: string, action: string, status: string) => db.query(`INSERT INTO scheduler_intents
    (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
    VALUES (?,'T9','p',?,?,1,?,2,1,?,2,?,'seed',100,100)`).run(id, node, action, id === "m9" ? 4 : 2, head, status);
  intent("rv9", "adversarial_review", "ensure_session", "done");
  intent("m9", "merge_deploy", "merge", "submitted");
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p','T9','m9',100)").run();
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T9','reviewer','agent-rv','rv-session','codex','tmux','active','rv9',100,100)`).run();
  db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-rv','p','T9','review','',?)").run(JSON.stringify({
    round: 1, head, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "rv-session", reviewerFamily: "codex",
    path: "r.md", findings: [], p0: 0, p1: 0, p2: 0 }));
  beginMergeRun(db, sch, "m9", ["ci"]);
  advanceMergeRun(db, sch, { intentId: "m9", from: "ready", to: "await_ci", rev: 1, receipt: "clean" });
  return { db, intent: "m9", close: () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}
type Card = ReturnType<typeof cardAt>;

interface Drive { mode: RecoveryMode; ledgerMode?: RecoveryMode; h0?: string; h1?: string; proof?: ProofOver; realNote?: boolean; restart?: boolean; draft?: boolean }
const OK_TRIAL = (sha: string): RefreshTrial => ({ ok: true, sha, files: [INVENTORY],
  entries: [{ file: "scheduler-merge-conflict.ts", gate: "writer", from: "sql=3 stmt=3", to: "sql=3 stmt=4" }] });

/** CI red only on counts at H0 → EFFAUTO1 (on) claims and pushes H1 → the next pass reads H1; then what the ledger holds. */
async function drive(o: Drive, after?: (c: Card) => Promise<void>) {
  const h0 = o.h0 ?? H0, h1 = o.h1 ?? H1, c = cardAt(h0), notes: CountCarryNote[] = [], refreshNotes: RefreshNote[] = [];
  const effPorts = () => useEffCountRefreshPorts({ mode: () => "on", repoDir: () => "/repo", trial: async () => OK_TRIAL(h1), remoteHead: async () => h0,
    push: async () => ({ ok: true }), note: async (n) => { refreshNotes.push(n); } });
  const carryPorts = () => useCountCarryPorts({ mode: () => o.mode, repoDir: () => work, prove: (i) => countCarryProof(i, io(h1, o.proof)),
    ...(o.realNote ? {} : { note: async (n: CountCarryNote) => { notes.push(n); } }) });
  const tick = (pr: PrSnapshot) => {
    const external = { inspect: async () => pr, freshness: async () => ({ behindBy: 0, mainHead: base }), carryReview: async () => PURE_MAIN,
      updateBranch: async () => {}, merge: async () => { throw new Error("不该合并"); }, ciRerun: ciRerunGh(ciGh as never) } as MergeExternal;
    const manager = async (...args: string[]) => runLedger(args.slice(1), { db: c.db, actor: "scheduler", projectIds: ["p"], now: () => 200,
      loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, autoDispatch: () => true, autoProjects: () => ["p"] });
    return schedulerMergeTick(c.db, config, manager, () => external);
  };
  proofCalls = 0;
  using _ledger = useCountCarryLedgerMode(() => o.ledgerMode ?? o.mode);
  try {
    { using _e = effPorts(); using _c = carryPorts(); await tick(red(h0)); if (!o.restart) await tick(red(h1, o.draft)); }
    if (o.restart) { using _e = effPorts(); using _c = carryPorts(); await tick(red(h1, o.draft)); } // in-process state gone, as after a restart
    if (after) await after(c);
    const task = mustTask(c.db, "T9"), events = listEvents(c.db, { project: "p", target: "T9" }), run = getMergeRun(c.db, c.intent)!;
    const phases = events.filter((e) => e.kind === "scheduler" && e.data.op === "merge_phase");
    return { c, task, events, run, notes, refreshNotes, proofCalls, carries: events.filter((e) => e.data.op === "review_carry"),
      back: phases.find((e) => e.data.to === "await_review")?.data.receipt, claim: phases.find((e) => e.data.to === "updating")?.data.receipt,
      observed: events.filter((e) => e.kind === "note" && e.data.op === "recovery_observe"), frozen: getMeta(c.db, "p").queueFrozen.frozen };
  } finally { c.close(); }
}
const reBack = (h0 = H0, h1 = H1) => movedHeadReceipt(h0, h1, PURE_MAIN);
/** The old road: back to review on H1, round + 1, no count carry. */
const reReviewed = (r: Awaited<ReturnType<typeof drive>>, h0 = H0, h1 = H1) => {
  expect([r.run.phase, r.task.stage, r.task.headSHA, r.task.round, r.back, r.carries.length]).toEqual(["await_review", "review", h1, 2, reBack(h0, h1), 0]);
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "review-count-carry-")); work = join(root, "repo");
  mkdirSync(work);
  await git("init", "-q", "-b", "main");
  await git("remote", "add", "origin", "https://github.com/example/repo.git");
  cpSync(join(ROOT, "src", "lib"), join(work, "src", "lib"), { recursive: true });
  await git("add", "-A"); await git("commit", "-qm", "base");
  base = await git("rev-parse", "HEAD");
  H0 = await commitOn(base, () => edit(TARGET, (t) => t + EXTRA_SITE), "pr");
  H1 = await commitOn(H0, bump);
}, 120_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("CARRYCNT1 count carry (real merge tick, real git)", () => {
  test("[验收线 1] on: EFFAUTO1's count commit keeps the review: await_ci on H1, PASS still read, no re-review; the same after a restart", async () => {
    const off = await drive({ mode: "off" }); // what main does with this very pass
    reReviewed(off);
    for (const restart of [false, true]) {
      let read: ReturnType<typeof currentReviewFacts> | null = null, send: string | null = "unset";
      const on = await drive({ mode: "on", restart }, async (c) => {
        const task = mustTask(c.db, "T9");
        read = currentReviewFacts(task, listEvents(c.db, { project: "p", target: "T9" }));
        send = sendSourceRefusal(c.db, getMergeRun(c.db, c.intent)!, task, getWorkflow(c.db, "T9")!, mergeReviewProof);
      });
      expect([on.run.phase, on.run.reviewedHead, on.task.stage, on.task.headSHA, on.task.round], `restart=${restart}`).toEqual(["await_ci", H1, "merge", H1, 1]);
      expect(on.claim).toStartWith(`效果点计数自动刷新（CI 只红在效果点计数）：CI head ${H0} → 计数提交 ${H1}（`); // EFFAUTO1's real claim, pinned
      const [carry] = on.carries as LedgerEvent[];
      expect(carry!.data).toMatchObject({ carryKind: "count", from: H0, to: H1, round: 1, blobFrom: expect.stringMatching(/^[a-f0-9]{40}$/) });
      expect(on.events.find((e) => e.seq === carry!.seq + 1)?.data).toMatchObject({ op: "merge_phase", to: "await_ci", carrySeq: carry!.seq });
      expect(read!).toMatchObject({ kind: "facts", facts: { head: H0, verdict: "pass", eventSeq: carry!.data.sourceReviewSeq } });
      expect(send).toBeNull();
      expect([on.events.some((e) => e.kind === "stage"), on.notes, on.back]).toEqual([false, [], undefined]);
    }
  }, 180_000);

  test("[验收线 2] one change from the count commit: back to review with the pure-main receipt, no review_carry", async () => {
    const other = (path: string) => edit(path, (t) => `${t}\n// touched\n`);
    const judgeH0 = await commitOn(base, () => { edit(TARGET, (t) => t + EXTRA_SITE); other("src/lib/order-wire-file-scope.ts"); }, "pr judge");
    const cases: [string, () => Promise<{ h0?: string; h1: string; proof?: ProofOver }>][] = [
      ["a non-count line in the inventory", async () => ({ h1: await commitOn(H0, () => { bump(); edit(INVENTORY, (t) => t.replace("S2D2 · every file", "S2D2 · each file")); }) })],
      ["a new entry", async () => ({ h1: await commitOn(H0, () => { bump(); edit(INVENTORY, (t) => t.replace('"lend-git.ts": "vcs=1",', '"lend-git.ts": "vcs=1", "zz-new.ts": "fs=1",')); }) })],
      ["an entry deleted", async () => ({ h1: await commitOn(H0, () => { bump(); edit(INVENTORY, (t) => t.replace('"lend-git.ts": "vcs=1", ', "")); }) })],
      ["a value with a backslash", async () => ({ h1: await commitOn(H0, () => edit(INVENTORY, bumpText("\\\\"))) })],
      ["a value that is no number", async () => ({ h1: await commitOn(H0, () => edit(INVENTORY, (t) => t.replace(/("scheduler-merge-conflict\.ts": ")[^"]+(")/, "$1sql=3 stmt=x$2"))) })],
      ["one more file", async () => ({ h1: await commitOn(H0, () => { bump(); other(TARGET); }) })],
      ["mode 100755", async () => ({ h1: await commitOn(H0, () => { bump(); chmodSync(join(work, INVENTORY), 0o755); }) })],
      ["two commits H0 → H1", async () => ({ h1: await commitOn(await commitOn(H0, () => {}, REFRESH_SUBJECT), bump) })],
      ["H1 a merge commit", async () => {
        await git("checkout", "-q", "--detach", H0); await git("merge", "-q", "--no-ff", "-m", REFRESH_SUBJECT, H1);
        return { h1: await git("rev-parse", "HEAD") };
      }],
      ["another subject", async () => ({ h1: await commitOn(H0, bump, "chore: counts") })],
      ["the PR touched a JUDGE_GLOBS file", async () => ({ h0: judgeH0, h1: await commitOn(judgeH0, bump) })],
      ["PR headRefOid is not H1", async () => ({ h1: H1, proof: { prHead: "f".repeat(40) } })],
      ["git times out", async () => ({ h1: H1, proof: { gitTimeout: true } })],
      ["gh times out", async () => ({ h1: H1, proof: { ghTimeout: true } })],
    ];
    for (const [name, make] of cases) {
      const { h0 = H0, h1, proof } = await make();
      const r = await drive({ mode: "on", h0, h1, proof });
      expect([r.run.phase, r.task.round, r.back, r.carries.length, r.notes], name).toEqual(["await_review", 2, reBack(h0, h1), 0, []]);
    }
    expect(badCountValues([{ file: "a.ts", to: "sql=1\\" }, { file: "b.ts", to: "sql=1 stmt=02" }, { file: "c.ts", to: "fs=1" }])).toEqual(['a.ts="sql=1\\\\"', 'b.ts="sql=1 stmt=02"']);
  }, 600_000);

  test("[验收线 5] off: no git / gh port, no note, today's receipt; observe: one would note, still re-reviewed; wouldnot on c–e only", async () => {
    expect(RECOVERY_KEYS).toContain(EFF_COUNT_CARRY_KEY);
    const off = await drive({ mode: "off" });
    reReviewed(off);
    expect([off.proofCalls, off.notes, off.observed]).toEqual([0, [], []]);
    const observe = await drive({ mode: "observe", realNote: true });
    reReviewed(observe);
    expect(observe.observed).toHaveLength(1);
    expect(observe.observed[0]!.data).toMatchObject({ mechanism: EFF_COUNT_CARRY_KEY, actionKey: `would.${H0.slice(0, 12)}` });
    expect(JSON.stringify(observe.observed[0]!.data)).toContain(H1);
    const would = await drive({ mode: "observe" });
    expect(would.notes.map((n) => n.data)).toEqual([{ mode: "observe", oldHead: H0, newHead: H1, blobFrom: expect.any(String), blobTo: expect.any(String),
      entries: [{ file: "scheduler-merge-conflict.ts", gate: expect.any(String), from: expect.any(String), to: expect.any(String) }] }]);
    const notes = async (h1: string) => (await drive({ mode: "observe", h1 })).notes.map((n) => n.actionKey.split(".")[0]);
    expect(await notes(await commitOn(H0, () => { bump(); edit(TARGET, (t) => `${t}// more\n`); }))).toEqual(["wouldnot"]); // c
    expect(await notes(await commitOn(H0, () => { bump(); edit(INVENTORY, (t) => t.replace('"lend-git.ts": "vcs=1", ', "")); }))).toEqual(["wouldnot"]); // d
    expect(await notes(await commitOn(H0, () => edit(INVENTORY, bumpText("\\\\"))))).toEqual(["wouldnot"]); // e (d refuses it first)
    expect(await notes(await commitOn(H0, bump, "chore: counts"))).toEqual([]); // b
    expect(await notes(await commitOn(await commitOn(H0, () => {}, "wip"), bump))).toEqual([]); // a
  }, 600_000);

  test("[验收线 3] the proof holds but the ledger refuses (on in the driver, off in the transaction): back to review, no unknown, no freeze", async () => {
    const r = await drive({ mode: "on", ledgerMode: "off" });
    expect([r.run.phase, r.task.stage, r.task.round, r.frozen, r.carries.length]).toEqual(["await_review", "review", 2, false, 0]);
    expect(r.back).toContain("计数沿用被台账拒绝：");
    expect(r.notes.map((n) => n.actionKey)).toEqual([`failed.${H0.slice(0, 12)}`]);
    const draft = await drive({ mode: "on", draft: true }); // a draft waits for the next pass on the same evidence
    expect([draft.run.phase, draft.task.headSHA, draft.carries.length]).toEqual(["updating", H0, 0]);
  }, 300_000);

  test("[验收线 4] the merged head passes verifyMergedCarry; tampered count records are problems", async () => {
    let report: Awaited<ReturnType<typeof verifyMergedCarry>> | null = null, carry: LedgerEvent | null = null;
    const ports = { repoDir: work, deployConfigured: false, git: async (args: string[]) => {
      const r = await runBounded(["git", ...args], { cwd: work, timeoutMs: 30_000 });
      return { code: r.code ?? -1, stdout: r.stdout };
    } };
    await drive({ mode: "on" }, async (c) => {
      await git("checkout", "-q", "main"); await git("merge", "-q", "--no-ff", "-m", "merge pr 7", H1);
      const merge = await git("rev-parse", "HEAD");
      carry = listEvents(c.db, { project: "p", target: "T9" }).find((e) => e.data.op === "review_carry")!;
      report = await verifyMergedCarry(c.db, "T9", { pr: { state: "MERGED", baseRefName: "main", headRefOid: H1, mergeSha: merge }, actualMain: merge,
        mainContainsMerge: true }, ports);
    });
    expect(report!).toMatchObject({ ok: true, carries: 1, problems: [] }); // on main: "缺 from / to / mainHead / diffHash，核不了"
    const problems = async (data: Record<string, unknown>) => {
      const out: string[] = [];
      await checkCountCarry({ ...carry!, data: { ...carry!.data, ...data } }, ports, out);
      return out.join("\n");
    };
    expect(await problems({})).toBe("");
    expect(await problems({ blobTo: "0".repeat(40) })).toContain("清单 blob 与记录不一致");
    await git("checkout", "-q", "--detach", H0); await git("merge", "-q", "--no-ff", "-m", REFRESH_SUBJECT, H1);
    expect(await problems({ to: await git("rev-parse", "HEAD") })).toContain("单父");
    const slash = await commitOn(H0, () => edit(INVENTORY, bumpText("\\\\")));
    const [, , b0, b1] = (await git("diff", "--raw", "--no-abbrev", H0, slash)).split(/\s+/);
    expect(await problems({ to: slash, blobFrom: b0, blobTo: b1 })).toContain("计数值不是严格格式");
    expect(await problems({ blobFrom: undefined })).toContain("核不了");
  }, 300_000);
});
