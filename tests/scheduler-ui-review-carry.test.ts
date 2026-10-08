/**
 * UIR1 · the scheduler's update-branch carry keeps PM's screenshot acceptance only when the approved head's render inputs (web/**,
 * src/bridge/**, assets / styles / i18n, root package / lock / config, the card's fileGlobs) are byte-identical trees at the new head,
 * read with real git in the writer's temp repo; the trusted record is the scheduler's ui_review_carry right after the carry's
 * merge_phase. A run that sent nothing and is held only by the screenshot gate ends cancelled instead of freezing the queue (on only).
 * Real git fixture, temp ledger, the default file-backed policy reader (RECOVERY_POLICY_PATH under the preload's temp state dir), the
 * real advanceMergeRun transaction and the real driveMerge with only GitHub faked. No network, no production state.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { closeLedger, getMeta, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { projectPmUiGate, UI_APPROVED, UI_REJECTED } from "../src/lib/ledger-ui-approve-verdict.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { advanceMergeRun, beginMergeRun, carryReceipt, getMergeRun, mergeRunDrift, type CarryEvidence, type MergeRun } from "../src/lib/scheduler-merge.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { uiCarryPlan } from "../src/lib/scheduler-ui-carry.js";
import { uiCarriedFrom } from "../src/lib/scheduler-ui-carry-read.js";
import { gitIn } from "../src/lib/scheduler-ui-carry-proof.js";
import { uiMergeRefusal } from "../src/lib/scheduler-ui-merge-refusal.js";
import { renderInputs, uiReviewCarryCalls, uiReviewCarryMode } from "../src/lib/scheduler-ui-review-carry.js";

const DIGEST = "d".repeat(64), PR = "https://github.com/example/repo/pull/5", SCHED = { actor: "scheduler" }, OWNER = { actor: "owner" };
let root = "", work = "", reviewed = "", base = "";
const heads: Record<string, { main: string; merged: string }> = {};
const sh = async (...argv: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...argv],
    { cwd: work, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (file: string, body: string) => { mkdirSync(join(work, file, ".."), { recursive: true }); writeFileSync(join(work, file), body); };
const commit = async (file: string, body: string) => { write(file, body); await sh("add", "-A"); await sh("commit", "-qm", file); return sh("rev-parse", "HEAD"); };
const mergeMain = async (kind: string, from: string, main: string) => {
  await sh("checkout", "-q", "-B", `h-${kind}`, from); await sh("merge", "-q", "--no-edit", main);
  heads[kind] = { main, merged: await sh("rev-parse", "HEAD") };
};

/** base → feature `reviewed` (the UI change); per kind a main commit on base, `merged` = reviewed + that main; lib2 = a second main hop. */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "uir1-")); work = join(root, "repo"); mkdirSync(work);
  await sh("init", "-q", "-b", "main");
  for (const f of ["README.md", "web/app.tsx", "src/bridge/b.ts", "src/lib/other.ts", "src/lib/owned.ts", "package.json", "web/package.json"]) await commit(f, "base\n");
  base = await sh("rev-parse", "HEAD");
  await sh("checkout", "-qb", "feature"); reviewed = await commit("web/app.tsx", "ui change\n");
  for (const [kind, file] of [["lib", "src/lib/other.ts"], ["web", "web/features/x.tsx"], ["dep", "package.json"], ["webdep", "web/package.json"],
    ["bridge", "src/bridge/b.ts"], ["glob", "src/lib/owned.ts"], ["i18n", "i18n/zh.json"], ["config", "vite.config.ts"]] as const) {
    await sh("checkout", "-q", "-B", `main-${kind}`, base);
    await mergeMain(kind, reviewed, await commit(file, `main ${kind}\n`));
  }
  await sh("checkout", "-q", "main-lib"); const main2 = await commit("src/lib/other2.ts", "main 2\n");
  await mergeMain("lib2", heads.lib!.merged, main2);
  await sh("checkout", "-q", "-B", "main-link", base); symlinkSync("../README.md", join(work, "web", "link.md"));
  await sh("add", "-A"); await sh("commit", "-qm", "link"); await mergeMain("link", reviewed, await sh("rev-parse", "HEAD"));
}, 120_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

type Mode = "on" | "observe" | "off";
const policy = (mode: Mode | null) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { uiCarry: "off", ...(mode ? { uiReviewCarry: mode } : {}) } } } }));
/** UI card T1 (auto) in merge at `reviewed`: cross-family PASS, PM's bound approval, merge run a1 begun (ready). uiCarry (UICAR2) off. */
function world(o: { mode?: Mode | null; ownerVisual?: boolean; globs?: string[] } = {}) {
  policy(o.mode === undefined ? "on" : o.mode);
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: work } } }));
  const dir = mkdtempSync(join(root, "ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); rmSync(RECOVERY_POLICY_PATH, { force: true }); rmSync(SCHEDULER_CONFIG_PATH, { force: true }); });
  const add = (actor: string, kind: string, data: unknown) => db.prepare(
    "INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (10,?,'p','T1',?,'',?)").run(actor, kind, JSON.stringify(data));
  const seq = () => (db.query("SELECT MAX(seq) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
  setMeta(db, OWNER, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, OWNER, { project: "p", id: "T1", title: "ui", kind: "code", agent: "agent-author" });
  setWorkflow(db, OWNER, { taskId: "T1", taskRev: 1, template: "ui", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "manual" });
  const extra = { screenshotsDigest: DIGEST, fileGlobs: o.globs ?? ["src/lib/owned.ts"], ...(o.ownerVisual ? { ownerVisual: true } : {}) };
  db.query("UPDATE tasks SET stage='review', round=1, headSHA=?, pr=?, branch='task/T1', extra=? WHERE id='T1'").run(reviewed, PR, JSON.stringify(extra));
  if (o.ownerVisual) add("owner", "task", { op: "set", patch: { extra } });
  add("owner", "stage", { from: "build", to: "review", round: 1 });
  const wf = () => (db.query("SELECT rev FROM task_workflows WHERE taskId='T1'").get() as { rev: number }).rev;
  const rev = () => getTask(db, "T1")!.rev;
  planIntent(db, SCHED, { id: "rv", taskId: "T1", taskRev: rev(), workflowRev: wf(), causalSeq: seq(), node: "adversarial_review",
    action: "review", reason: "review", recipient: "agent-review" });
  settleIntent(db, SCHED, { id: "rv", from: "pending", to: "submitted", receipt: "ack" });
  add("agent-review", "review", { round: 1, head: reviewed, verdict: "pass", reviewer: "agent-review", reviewerSessionId: "rs",
    reviewerFamily: "codex", path: "report.md", findings: [], p0: 0, p1: 0, p2: 0 });
  settleIntent(db, SCHED, { id: "rv", from: "submitted", to: "done", receipt: "review event recorded" });
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T1','reviewer','agent-review','rs','codex','acp','active','rv',10,10)`).run();
  add("agent-pm", "decision", { op: UI_APPROVED, head: reviewed, specRev: 1, round: 1, screenshotsDigest: DIGEST });
  db.query("UPDATE tasks SET stage='merge' WHERE id='T1'").run();
  add("owner", "stage", { from: "review", to: "merge", round: 1, specRev: 1 });
  planIntent(db, SCHED, { id: "a1", taskId: "T1", taskRev: rev(), workflowRev: wf(), causalSeq: seq(), node: "merge_deploy",
    action: "merge", reason: "merge", resources: ["merge:p"] });
  settleIntent(db, SCHED, { id: "a1", from: "pending", to: "submitted", receipt: "claimed" });
  // the existing behaviour kept: an approved UI card's merge run begins (beginMergeRun re-reads the UI gate)
  expect(beginMergeRun(db, SCHED, "a1", ["check"]).run.phase).toBe("ready");
  return { db, add, seq };
}
type W = ReturnType<typeof world>;
const run = (w: W) => getMergeRun(w.db, "a1")!;
const step = (w: W, to: MergeRun["phase"], extra: { receipt?: string; newHead?: string; mergeSha?: string } = {}, actor = SCHED) =>
  advanceMergeRun(w.db, actor, { intentId: "a1", from: run(w).phase, to, rev: run(w).rev, ...extra });
const netHash = (main: string, head: string) => createHash("sha256").update(execFileSync("git", ["-c", "core.quotePath=true", "diff",
  "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--full-index", "--no-renames", "--ignore-submodules=none", "--no-relative",
  "--submodule=short", `${main}...${head}`], { cwd: work })).digest("hex");
const evidence = (kind: string, from = reviewed): CarryEvidence => {
  const { main, merged } = heads[kind]!;
  return { oldHead: from, newHead: merged, mainParent: main, mainHead: main, diffHash: netHash(main, merged) };
};
const receiptOf = (ev: CarryEvidence) => carryReceipt(ev) + carryChainSuffix([{ previousHead: ev.oldHead, head: ev.newHead, mainParent: ev.mainParent }]);
/** update-branch merged `kind`'s main into the current head: ready/await_ci → updating → await_ci with the driver's receipt. */
const carry = (w: W, kind: string, from = reviewed) => {
  const ev = evidence(kind, from);
  step(w, "updating");
  return step(w, "await_ci", { newHead: ev.newHead, receipt: receiptOf(ev) });
};
const evs = (w: W) => listEvents(w.db, { project: "p", target: "T1" });
const carries = (w: W) => evs(w).filter((e) => e.data.op === "ui_review_carry");
const observed = (w: W) => evs(w).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "uiReviewCarry");
const phaseNote = (w: W) => evs(w).findLast((e) => e.data.op === "merge_phase" && e.data.to === "await_ci")?.data.note;
const drift = (w: W) => mergeRunDrift(w.db, run(w), Date.now());
const frozen = (w: W) => getMeta(w.db, "p").queueFrozen.frozen;

describe("renderInputs: the render-input tree of one commit, by real git", () => {
  const read = () => gitIn(work);
  test("equal across a main that only touched src/lib; differs for web/, root package.json, web/package.json, i18n/, *.config.*, fileGlobs", () => {
    const at = (h: string, globs: string[] = []) => renderInputs(read(), h, globs).digest;
    expect(at(heads.lib!.merged)).toBe(at(reviewed));
    expect(at(heads.lib2!.merged)).toBe(at(reviewed));
    for (const k of ["web", "dep", "webdep", "bridge", "i18n", "config"]) expect(at(heads[k]!.merged)).not.toBe(at(reviewed));
    expect(at(heads.glob!.merged)).toBe(at(reviewed)); // src/lib/owned.ts is not a render input by itself …
    expect(at(heads.glob!.merged, ["src/lib/owned.ts"])).not.toBe(at(reviewed, ["src/lib/owned.ts"])); // … but the card's fileGlobs are
  });
  test("a symlink among the inputs, or no web/ at all, is not provable", () => {
    expect(() => renderInputs(read(), heads.link!.merged, [])).toThrow(/符号链接/);
    const first = execFileSync("git", ["rev-list", "--max-parents=0", base], { cwd: work }).toString().trim(); // README.md only
    expect(() => renderInputs(read(), first, [])).toThrow(/缺 web/);
  });
});

describe("write: on", () => {
  test("main only changed src/lib: ui_review_carry right after the carry's merge_phase with the full evidence; the gate opens; probe counts", () => {
    const w = world(), before = { ...uiReviewCarryCalls };
    carry(w, "lib");
    const [u] = carries(w), c = evs(w).find((e) => e.data.op === "review_carry")!, pm = projectPmUiGate(w.db, getTask(w.db, "T1")!, evs(w));
    expect(u).toMatchObject({ actor: "scheduler", kind: "scheduler", seq: c.seq + 2, dedupKey: `scheduler:a1:ui-review-carry:${c.seq}`, data: {
      intentId: "a1", carrySeq: c.seq, from: reviewed, to: heads.lib!.merged, approvedHead: reviewed, approvalSeq: pm.seq, approvalActor: "agent-pm",
      approvalOp: UI_APPROVED, ask: null, round: 1, specRev: 1, digest: DIGEST, mainParent: heads.lib!.main, mainHead: heads.lib!.main,
      diffHash: c.data.diffHash } });
    expect(u!.data.renderInputs).toMatch(/^[a-f0-9]{64}$/);
    expect(evs(w).find((e) => e.seq === c.seq + 1)?.data).toMatchObject({ op: "merge_phase", carrySeq: c.seq }); // order contract kept
    expect(phaseNote(w)).toBeUndefined();
    expect([drift(w), uiMergeRefusal(w.db, getTask(w.db, "T1")!, Date.now())]).toEqual([null, null]);
    expect(uiReviewCarryCalls.plan).toBeGreaterThan(before.plan);
    expect(uiReviewCarryCalls.read).toBeGreaterThan(before.read);
  });

  test("two main updates in a row: the second carry chains on the first, both bound to the one original approval", () => {
    const w = world();
    carry(w, "lib");
    carry(w, "lib2", heads.lib!.merged);
    const list = carries(w);
    expect(list.map((u) => [u.data.from, u.data.to, u.data.approvedHead])).toEqual([[reviewed, heads.lib!.merged, reviewed],
      [heads.lib!.merged, heads.lib2!.merged, reviewed]]);
    expect(drift(w)).toBeNull();
  });

  test("a first hop carried only under observe does not let the second hop chain once on", () => {
    const w = world({ mode: "observe" });
    carry(w, "lib");
    policy("on");
    const plan = uiCarryPlan(w.db, getTask(w.db, "T1")!, "a1", evidence("lib2", heads.lib!.merged), Date.now());
    expect(String(plan.note)).toMatch(/不是调度器的可信沿用链/);
    plan.commit(1);
    expect(carries(w)).toEqual([]);
  });

  for (const [kind, globs] of [["web", undefined], ["dep", undefined], ["webdep", undefined], ["bridge", undefined], ["i18n", undefined],
    ["config", undefined], ["glob", ["src/lib/owned.ts"]], ["link", undefined]] as const) {
    test(`main changed render input (${kind}): nothing carried, merge_phase says why, the gate stays shut`, () => {
      const w = world({ globs: globs ? [...globs] : undefined });
      carry(w, kind);
      expect(carries(w)).toEqual([]);
      expect(String(phaseNote(w))).toMatch(/截图验收不继承：.*(渲染输入).*要 PM 在新 head/);
      expect(drift(w)).toMatch(/UI 截图验收已失效/);
    });
  }

  const twists: [string, (w: W) => void, RegExp][] = [
    ["PM's last verdict is rejected", (w) => w.add("agent-pm", "decision", { op: UI_REJECTED, head: reviewed, specRev: 1, round: 1, screenshotsDigest: DIGEST, note: "改" }), /不是 approved/],
    ["approval for another round", (w) => w.add("agent-pm", "decision", { op: UI_APPROVED, head: reviewed, specRev: 1, round: 2, screenshotsDigest: DIGEST }), /没绑在/],
    ["approval for another specRev", (w) => w.add("agent-pm", "decision", { op: UI_APPROVED, head: reviewed, specRev: 2, round: 1, screenshotsDigest: DIGEST }), /没绑在/],
    ["digest replaced", (w) => w.db.query("UPDATE tasks SET extra = json_set(extra, '$.screenshotsDigest', ?) WHERE id = 'T1'").run("e".repeat(64)), /没绑在/],
    ["approval on an unrelated head", (w) => w.add("agent-pm", "decision", { op: UI_APPROVED, head: heads.web!.merged, specRev: 1, round: 1, screenshotsDigest: DIGEST }), /可信沿用链/],
    ["approval by someone who is no longer PM", (w) => setMeta(w.db, OWNER, { project: "p", key: "pms", value: [] }), /不是 approved/],
    ["approval written by the executor", (w) => { setMeta(w.db, OWNER, { project: "p", key: "pms", value: [] });
      w.add("agent-author", "decision", { op: UI_APPROVED, head: reviewed, specRev: 1, round: 1, screenshotsDigest: DIGEST }); }, /不是 approved/],
    ["ownerVisual raised", (w) => w.add("agent-author", "task", { op: "set", patch: { extra: { ownerVisual: true } } }), /ownerVisual/],
  ];
  for (const [name, twist, why] of twists) {
    test(`${name}: the writer plans no ui_review_carry and says why`, () => {
      const w = world();
      twist(w);
      const plan = uiCarryPlan(w.db, getTask(w.db, "T1")!, "a1", evidence("lib"), Date.now());
      expect(String(plan.note)).toMatch(why);
      plan.commit(1);
      expect(carries(w)).toEqual([]);
    });
  }

  test("after the carry: PM rejects, re-approves (a new event), loses PM rights, or the digest changes → the carried approval no longer counts", () => {
    for (const twist of [(w: W) => w.add("agent-pm", "decision", { op: UI_REJECTED, head: reviewed, specRev: 1, round: 1, screenshotsDigest: DIGEST, note: "撤" }),
      (w: W) => w.add("agent-pm", "decision", { op: UI_APPROVED, head: reviewed, specRev: 1, round: 1, screenshotsDigest: DIGEST }),
      (w: W) => setMeta(w.db, OWNER, { project: "p", key: "pms", value: [] }),
      (w: W) => w.db.query("UPDATE tasks SET extra = json_set(extra, '$.screenshotsDigest', ?) WHERE id = 'T1'").run("e".repeat(64))]) {
      const w = world();
      carry(w, "lib");
      expect(drift(w)).toBeNull();
      twist(w);
      expect(drift(w)).toMatch(/UI 截图验收已失效/);
      for (const c of cleanup.splice(0).reverse()) c();
    }
  });
});

describe("switch: observe / off / switched after the carry", () => {
  test("observe: one prediction note, no ui_review_carry, the gate stays shut; a refusal is also only predicted", () => {
    const w = world({ mode: "observe" });
    carry(w, "lib");
    expect(carries(w)).toEqual([]);
    expect(observed(w)).toHaveLength(1);
    expect(observed(w)[0]).toMatchObject({ actor: "scheduler", kind: "note", data: { carried: true, approvedHead: reviewed } });
    expect(phaseNote(w)).toBeUndefined();
    expect(drift(w)).toMatch(/UI 截图验收已失效/);
    const v = world({ mode: "observe" });
    carry(v, "web");
    expect(observed(v)[0]).toMatchObject({ data: { carried: false } });
    expect(observed(v)[0]!.text).toMatch(/渲染输入/);
  });
  test("off: nothing recorded; no entry = observe; an unreadable file = off", () => {
    const w = world({ mode: "off" });
    carry(w, "lib");
    expect([carries(w), observed(w), phaseNote(w)]).toEqual([[], [], undefined]);
    policy(null);
    expect(uiReviewCarryMode("p")).toBe("observe");
    writeFileSync(RECOVERY_POLICY_PATH, "{");
    expect(uiReviewCarryMode("p")).toBe("off");
  });
  test("carried under on, then switched to observe / off: the record no longer opens the gate", () => {
    const w = world();
    carry(w, "lib");
    for (const m of ["observe", "off"] as const) { policy(m); expect(drift(w)).toMatch(/UI 截图验收已失效/); }
    policy("on");
    expect(drift(w)).toBeNull();
  });
});

describe("read: only the scheduler's own paired record counts", () => {
  const readWith = (change: (u: LedgerEvent) => LedgerEvent | null) => {
    const w = world();
    carry(w, "lib");
    const task = getTask(w.db, "T1")!, all = evs(w), pm = projectPmUiGate(w.db, task, all);
    expect(uiCarriedFrom(w.db, task, all, pm)).toBe(true);
    return uiCarriedFrom(w.db, task, all.flatMap((e) => (e.data.op === "ui_review_carry" ? [change(e)].filter((x): x is LedgerEvent => !!x) : [e])), pm);
  };
  const data = (u: LedgerEvent, patch: Record<string, unknown>): LedgerEvent => ({ ...u, data: { ...u.data, ...patch } });
  const cases: [string, (u: LedgerEvent) => LedgerEvent | null][] = [
    ["written by a non-scheduler actor", (u) => ({ ...u, actor: "agent-author" })], ["a note, not a scheduler event", (u) => ({ ...u, kind: "note" })],
    ["forged approvalSeq", (u) => data(u, { approvalSeq: (u.data.approvalSeq as number) - 1 })], ["other approvedHead", (u) => data(u, { approvedHead: heads.web!.merged })],
    ["other approval actor", (u) => data(u, { approvalActor: "agent-author" })], ["other digest", (u) => data(u, { digest: "e".repeat(64) })],
    ["other round", (u) => data(u, { round: 2 })], ["other specRev", (u) => data(u, { specRev: 2 })], ["other to", (u) => data(u, { to: heads.web!.merged })],
    ["other diffHash", (u) => data(u, { diffHash: "f".repeat(64) })], ["other intent", (u) => data(u, { intentId: "a0" })],
    ["no render digest", (u) => data(u, { renderInputs: "" })], ["another key", (u) => ({ ...u, dedupKey: "scheduler:a1:ui-review-carry:0" })],
    ["not right after the carry's merge_phase", (u) => ({ ...u, seq: u.seq + 5 })], ["missing", () => null],
  ];
  for (const [name, change] of cases) test(name, () => expect(readWith(change)).toBe(false));

  test("a ui_review_carry the executor appended (or a PM note / extra) for a carry that had none does not open the gate", () => {
    const w = world();
    carry(w, "web");
    const c = evs(w).find((e) => e.data.op === "review_carry")!, pm = projectPmUiGate(w.db, getTask(w.db, "T1")!, evs(w));
    w.db.transaction(() => insertEvent(w.db, { actor: "agent-author", now: Date.now() }, { project: "p", target: "T1", kind: "scheduler", text: "",
      data: { op: "ui_review_carry", intentId: "a1", carrySeq: c.seq, from: reviewed, to: c.data.to, approvedHead: reviewed, approvalSeq: pm.seq,
        approvalActor: "agent-pm", round: 1, specRev: 1, digest: DIGEST, renderInputs: "a".repeat(64), mainParent: c.data.mainParent,
        mainHead: c.data.mainHead, diffHash: c.data.diffHash } }, false))();
    w.add("agent-pm", "note", { op: "ui_review_carry", carrySeq: c.seq });
    w.db.query("UPDATE tasks SET extra = json_set(extra, '$.uiReviewCarry', 'on') WHERE id = 'T1'").run();
    expect(drift(w)).toMatch(/UI 截图验收已失效/);
  });
});

describe("transaction: one write, CAS, idempotent", () => {
  test("the record's insert fails → the whole carry rolls back (head, run, review_carry); a stale rev is refused; a replay writes no second record", () => {
    const w = world(), ev = evidence("lib");
    step(w, "updating");
    const next = w.seq() + 2; // the planted row takes +1, review_carry +2
    w.db.transaction(() => insertEvent(w.db, { actor: "scheduler", now: 1, dedupKey: `scheduler:a1:ui-review-carry:${next}` },
      { project: "p", target: "T1", kind: "scheduler", text: "", data: { op: "x" } }, true))();
    expect(() => step(w, "await_ci", { newHead: ev.newHead, receipt: receiptOf(ev) })).toThrow();
    expect([getTask(w.db, "T1")!.headSHA, run(w).phase, evs(w).some((e) => e.data.op === "review_carry")]).toEqual([reviewed, "updating", false]);
    const v = world();
    step(v, "updating");
    const stale = run(v).rev - 1;
    expect(() => advanceMergeRun(v.db, SCHED, { intentId: "a1", from: "updating", to: "await_ci", rev: stale, newHead: ev.newHead, receipt: receiptOf(ev) })).toThrow(/不能从/);
    const at = run(v);
    step(v, "await_ci", { newHead: ev.newHead, receipt: receiptOf(ev) });
    expect(() => advanceMergeRun(v.db, SCHED, { intentId: "a1", from: at.phase, to: "await_ci", rev: at.rev, newHead: ev.newHead, receipt: receiptOf(ev) })).toThrow(/不能从/);
    expect(carries(v)).toHaveLength(1);
  });
});

/** GitHub as the driver sees it: the PR at `head`, green, mergeable; merge records whether it was ever called. */
function github(head: () => string, o: { carried?: CarryEvidence; mergedOk?: boolean } = {}) {
  const sent: string[] = [];
  let merged: string | null = null;
  const pr = (): PrSnapshot => ({ state: merged ? "MERGED" : "OPEN", head: head(), branch: "task/T1", crossRepository: false, base: "main", draft: false,
    mergeState: "CLEAN", mergeSha: merged, checks: [{ name: "check", bucket: "pass" }] });
  const ext: MergeExternal = {
    inspect: async () => pr(), freshness: async () => ({ behindBy: 0, mainHead: o.carried?.mainHead ?? "c".repeat(40) }),
    carryReview: async () => { const c = o.carried!; return { ok: true, reason: "pure main", mainParent: c.mainParent, mainHead: c.mainHead, diffHash: c.diffHash,
      chain: [{ previousHead: c.oldHead, head: c.newHead, mainParent: c.mainParent }] }; },
    updateBranch: async () => {},
    merge: async (_pr, h) => { sent.push(h); if (o.mergedOk !== false) merged = "9".repeat(40); return "9".repeat(40); },
  };
  return { ext, sent };
}
const advance = (w: W, actor = SCHED) => (from: MergeRun["phase"], to: MergeRun["phase"], rev: number, receipt?: string, mergeSha?: string, newHead?: string) =>
  Promise.resolve(advanceMergeRun(w.db, actor, { intentId: "a1", from, to, rev, receipt, mergeSha, newHead }));
/** The service's drive: the run as journaled, the ledger re-read before the merge call (scheduler-service.ts recheck). */
const drive = (w: W, ext: MergeExternal, active: () => void = () => {}) => driveMerge(run(w), ext, advance(w), active, (r) => mergeRunDrift(w.db, r, Date.now()));
/** The driver itself carries: updating sees the moved head, the ledger carries, the next call merges or ends. */
async function driven(w: W, kind: string) {
  const ev = evidence(kind);
  step(w, "updating");
  let head = reviewed;
  const gh = github(() => head, { carried: ev });
  head = ev.newHead;
  expect((await drive(w, gh.ext)).phase).toBe("await_ci");
  return { gh, final: await drive(w, gh.ext) };
}

describe("driver × ledger: pure main with unchanged render inputs merges; anything short of proof waits for PM without freezing", () => {
  test("on, main only touched src/lib: carry → await_ci → merging → merged at the new head", async () => {
    const w = world(), { gh, final } = await driven(w, "lib");
    expect([final.phase, gh.sent, frozen(w)]).toEqual(["merged", [heads.lib!.merged], false]);
  });

  test("on, render inputs changed: no merge sent, the run ends cancelled with its slot freed, queue not frozen, PM still has to approve", async () => {
    const w = world(), before = uiReviewCarryCalls.unsent, { gh, final } = await driven(w, "web");
    expect([final.phase, gh.sent, frozen(w), getIntent(w.db, "a1")!.status]).toEqual(["resolved", [], false, "cancelled"]);
    expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_resources WHERE intentId='a1'").get()).toEqual({ n: 0 });
    expect(evs(w).findLast((e) => e.data.op === "merge_phase")!.data).toMatchObject({ to: "resolved", outcome: "cancelled", uiUnsent: true });
    expect(uiMergeRefusal(w.db, getTask(w.db, "T1")!, Date.now())).toMatch(/PM 截图验收/); // no approval invented
    expect(uiReviewCarryCalls.unsent).toBeGreaterThan(before);
  });

  for (const mode of ["observe", "off"] as const) {
    test(`${mode}: the old unknown + freeze stays (observe only records the prediction)`, async () => {
      const w = world({ mode }), { gh, final } = await driven(w, "web");
      expect([final.phase, gh.sent, frozen(w)]).toEqual(["unknown", [], true]);
      expect(observed(w).some((e) => String(e.data.actionKey).startsWith("ui-unsent:"))).toBe(mode === "observe");
    });
  }

  const others: [string, (w: W) => void][] = [
    ["the reviewer session changed", (w) => w.db.query("UPDATE scheduler_sessions SET sessionId='other' WHERE taskId='T1'").run()],
    ["the branch changed", (w) => w.db.query("UPDATE tasks SET branch='task/other' WHERE id='T1'").run()],
    ["the spec revision moved", (w) => w.db.query("UPDATE tasks SET specRev=2 WHERE id='T1'").run()],
    ["the merge slot is gone", (w) => w.db.query("DELETE FROM scheduler_resources WHERE intentId='a1'").run()],
  ];
  for (const [name, twist] of others) {
    test(`on, UI gate shut but also ${name}: not hidden behind the UI end, unknown + freeze`, async () => {
      const w = world(), ev = evidence("web");
      carry(w, "web");
      twist(w);
      const gh = github(() => ev.newHead);
      const r = await drive(w, gh.ext);
      expect([r.phase, gh.sent, frozen(w)]).toEqual(["unknown", [], true]);
    });
  }

  test("on: a merging row (the claim may have been sent), even with a 合并未发出 receipt, and a PM's unknown both stay unknown + frozen", () => {
    const w = world();
    carry(w, "lib");
    step(w, "merging", { receipt: "CI 全绿：check" });
    w.add("agent-pm", "decision", { op: UI_REJECTED, head: reviewed, specRev: 1, round: 1, screenshotsDigest: DIGEST, note: "撤" });
    expect(step(w, "unknown", { receipt: "合并未发出：UI 截图验收已失效" }).phase).toBe("unknown");
    expect(frozen(w)).toBe(true);
    const v = world();
    carry(v, "web");
    expect(step(v, "unknown", { receipt: "PM 手动停" }, { actor: "agent-pm" }).phase).toBe("unknown");
    expect(frozen(v)).toBe(true);
  });

  test("on: sent but the result unverifiable stays unknown + frozen; a lost lease stops before any write", async () => {
    const w = world(), ev = evidence("lib");
    carry(w, "lib");
    const gh = github(() => ev.newHead, { mergedOk: false });
    expect((await drive(w, gh.ext)).phase).toBe("unknown");
    expect([gh.sent, frozen(w)]).toEqual([[heads.lib!.merged], true]);
    const v = world();
    carry(v, "web");
    const at = run(v), stop = () => { throw new SchedulerStopped("lease lost"); };
    await expect(drive(v, github(() => evidence("web").newHead).ext, stop)).rejects.toThrow(SchedulerStopped);
    expect([run(v).phase, run(v).rev, frozen(v)]).toEqual([at.phase, at.rev, false]);
  });
});
