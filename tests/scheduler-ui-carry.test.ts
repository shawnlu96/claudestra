/**
 * UICAR2 · ledger side: the scheduler's own update-branch carry (`advanceMergeRun` updating → await_ci with a new head) on a UI card
 * writes a paired `ui_carry` only when main's part (git diff --name-only merge-base(from, mainParent)..mainParent, computed by the
 * writer in a temp repo) touches no web/**, src/bridge/** or card fileGlobs file, PM's last verdict is approved on `from` with the
 * card's digest, the card is not ownerVisual and uiCarry is on. The merge run's drift (uiMergeRefusal) reads it back. Real git fixture,
 * temp ledger in process. Production wiring (CLI child, fake gh, merge driver): tests/scheduler-ui-carry-e2e.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { UI_APPROVED, UI_REJECTED } from "../src/lib/ledger-ui-approve-verdict.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { advanceMergeRun, beginMergeRun, carryReceipt, getMergeRun, mergeRunDrift, type CarryEvidence } from "../src/lib/scheduler-merge.js";
import { mainTouched, uiCarryMode, uiCarryPlan } from "../src/lib/scheduler-ui-carry.js";
import { uiCarriedFrom } from "../src/lib/scheduler-ui-carry-read.js";
import { projectPmUiGate } from "../src/lib/ledger-ui-approve-verdict.js";
import { uiMergeRefusal } from "../src/lib/scheduler-ui-merge-refusal.js";

const DIGEST = "d".repeat(64), PR = "https://github.com/example/repo/pull/5", SCHED = { actor: "scheduler" }, OWNER = { actor: "owner" };
let root = "", work = "", reviewed = "";
const heads: Record<string, { main: string; merged: string }> = {};
const sh = async (...argv: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...argv],
    { cwd: work, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = async (file: string, body: string) => {
  mkdirSync(join(work, file, ".."), { recursive: true });
  writeFileSync(join(work, file), body);
  await sh("add", "-A"); await sh("commit", "-qm", file);
  return sh("rev-parse", "HEAD");
};

/** base → feature `reviewed` (the UI change); main siblings each touching one kind of path; `merged` = reviewed + that main. */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "uicar2-")); work = join(root, "repo"); mkdirSync(work);
  await sh("init", "-q", "-b", "main");
  for (const f of ["README.md", "web/app.tsx", "src/bridge/b.ts", "src/lib/other.ts", "src/lib/owned.ts"]) await commit(f, "base\n");
  const base = await sh("rev-parse", "HEAD");
  await sh("checkout", "-qb", "feature"); reviewed = await commit("web/app.tsx", "ui change\n");
  for (const [kind, file] of [["lib", "src/lib/other.ts"], ["web", "web/features/lend/x.tsx"], ["bridge", "src/bridge/b.ts"],
    ["glob", "src/lib/owned.ts"], ["rename", "web/app.tsx"]] as const) {
    await sh("checkout", "-q", "-B", `main-${kind}`, base);
    const main = kind === "rename" ? (await sh("mv", "README.md", "web/README.md"), await sh("commit", "-qm", "mv"), await sh("rev-parse", "HEAD"))
      : await commit(file, `main ${kind}\n`);
    await sh("checkout", "-q", "-B", `h-${kind}`, reviewed); await sh("merge", "-q", "--no-edit", main);
    heads[kind] = { main, merged: await sh("rev-parse", "HEAD") };
  }
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

type Mode = "on" | "observe" | "off";
/** UI card T1 (auto) in merge at `reviewed`: cross-family PASS, PM's bound approval, merge run a1 claimed and at updating. */
function world(o: { mode?: Mode; ownerVisual?: boolean; verdict?: string; pmPatch?: Record<string, unknown> } = {}) {
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { uiCarry: o.mode ?? "on" } } } }));
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: work } } }));
  const dir = mkdtempSync(join(root, "ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); rmSync(RECOVERY_POLICY_PATH, { force: true }); rmSync(SCHEDULER_CONFIG_PATH, { force: true }); });
  const add = (actor: string, kind: string, data: unknown) => db.prepare(
    "INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (10,?,'p','T1',?,'',?)").run(actor, kind, JSON.stringify(data));
  const seq = () => (db.query("SELECT MAX(seq) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
  setMeta(db, OWNER, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, OWNER, { project: "p", id: "T1", title: "ui", kind: "code", agent: "agent-author" });
  setWorkflow(db, OWNER, { taskId: "T1", taskRev: 1, template: "ui", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "manual" });
  const extra = { screenshotsDigest: DIGEST, fileGlobs: ["src/lib/owned.ts", "web/**"], ...(o.ownerVisual ? { ownerVisual: true } : {}) };
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
  add("agent-pm", "decision", { op: UI_APPROVED, head: reviewed, specRev: 1, round: 1, screenshotsDigest: DIGEST, ...o.pmPatch });
  db.query("UPDATE tasks SET stage='merge' WHERE id='T1'").run();
  add("owner", "stage", { from: "review", to: "merge", round: 1, specRev: 1 });
  if (o.verdict === "rejected") add("agent-pm", "decision", { op: UI_REJECTED, head: reviewed, specRev: 1, round: 1, screenshotsDigest: DIGEST, note: "不对" });
  // the merge run itself starts under the approval as written (beginMergeRun re-reads the UI gate); a twist after that is the case
  planIntent(db, SCHED, { id: "a1", taskId: "T1", taskRev: rev(), workflowRev: wf(), causalSeq: seq(), node: "merge_deploy",
    action: "merge", reason: "merge", resources: ["merge:p"] });
  settleIntent(db, SCHED, { id: "a1", from: "pending", to: "submitted", receipt: "claimed" });
  return { db, add, seq };
}
type W = ReturnType<typeof world>;
const begin = (w: W) => beginMergeRun(w.db, SCHED, "a1", ["check"]).run;
const step = (w: W, to: "updating" | "await_ci", extra: { receipt?: string; newHead?: string } = {}) => {
  const r = getMergeRun(w.db, "a1")!;
  return advanceMergeRun(w.db, SCHED, { intentId: "a1", from: r.phase, to, rev: r.rev, ...extra });
};
/** The canonical proof's net diff hash (review-main-carry-proof.ts netDiff's arguments), as the driver's receipt carries it. */
const netHash = (main: string, head: string) => createHash("sha256").update(execFileSync("git", ["-c", "core.quotePath=true", "diff",
  "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--full-index", "--no-renames", "--ignore-submodules=none", "--no-relative",
  "--submodule=short", `${main}...${head}`], { cwd: work })).digest("hex");
const evidence = (kind: string, patch: Partial<CarryEvidence> = {}): CarryEvidence => {
  const { main, merged } = heads[kind]!;
  return { oldHead: reviewed, newHead: merged, mainParent: main, mainHead: main, diffHash: netHash(main, merged), ...patch };
};
/** update-branch merged `kind`'s main into the reviewed head: the driver's receipt with its canonical one-hop chain. */
const carry = (w: W, kind: string, patch: Partial<CarryEvidence> = {}) => {
  const ev = evidence(kind, patch);
  step(w, "updating");
  return step(w, "await_ci", { newHead: ev.newHead, receipt: carryReceipt(ev) +
    carryChainSuffix([{ previousHead: reviewed, head: ev.newHead, mainParent: ev.mainParent }]) });
};
const evs = (w: W) => listEvents(w.db, { project: "p", target: "T1" });
const uiCarries = (w: W) => evs(w).filter((e) => e.data.op === "ui_carry");
const phaseNote = (w: W) => evs(w).findLast((e) => e.data.op === "merge_phase" && e.data.to === "await_ci")?.data.note;
const drift = (w: W) => mergeRunDrift(w.db, getMergeRun(w.db, "a1")!, Date.now());

describe("mainTouched: the writer's own git, canonical proof and touched list in one temp repo", () => {
  test("lists main's files since the merge base, both sides of a rename", () => {
    expect(mainTouched(work, evidence("lib")).files).toEqual(["src/lib/other.ts"]);
    expect(mainTouched(work, evidence("rename")).files.sort()).toEqual(["README.md", "web/README.md"]);
    expect(() => mainTouched(work, evidence("lib", { mainParent: "0".repeat(40) }))).toThrow();
  });
  test("the receipt does not re-prove there: another diffHash, a mainParent that is not the new head's parent, from not under to", () => {
    expect(() => mainTouched(work, evidence("lib", { diffHash: "f".repeat(64) }))).toThrow(/canonical/);
    const base = execFileSync("git", ["rev-parse", `${reviewed}^`], { cwd: work }).toString().trim(); // on main, not a parent of `to`
    expect(() => mainTouched(work, evidence("lib", { mainParent: base }))).toThrow(/父提交/);
    expect(() => mainTouched(work, evidence("lib", { newHead: heads.web!.merged }))).toThrow();
  });
});

describe("UICAR2 write: on", () => {
  test("main only changed src/lib (unrelated): ui_carry right after the carry's merge_phase, drift passes at the new head", () => {
    const w = world();
    begin(w);
    expect(drift(w)).toBeNull();
    carry(w, "lib");
    const [u] = uiCarries(w), c = evs(w).find((e) => e.data.op === "review_carry")!;
    expect(u).toMatchObject({ actor: "scheduler", kind: "scheduler", seq: c.seq + 2, data: { intentId: "a1", from: reviewed, to: heads.lib!.merged,
      round: 1, specRev: 1, digest: DIGEST, mainParent: heads.lib!.main, touched: [], changed: ["src/lib/other.ts"], carrySeq: c.seq } });
    expect(u!.data.approvalSeq).toBe(projectPmUiGate(w.db, getTask(w.db, "T1")!, evs(w)).seq!);
    expect(u!.data.mainBase).toMatch(/^[a-f0-9]{40}$/);
    expect(phaseNote(w)).toBeUndefined();
    expect(getTask(w.db, "T1")!.headSHA).toBe(heads.lib!.merged);
    expect(drift(w)).toBeNull();
  });

  for (const [kind, why] of [["web", /main 改了 web\/features\/lend\/x\.tsx/], ["bridge", /main 改了 src\/bridge\/b\.ts/],
    ["glob", /main 改了 src\/lib\/owned\.ts/], ["rename", /main 改了 .*web\/README\.md/]] as const) {
    test(`main touched ${kind}: no ui_carry, the reason in merge_phase's note, drift refuses (UICAR1 path)`, () => {
      const w = world();
      begin(w);
      carry(w, kind);
      expect(uiCarries(w)).toEqual([]);
      expect(String(phaseNote(w))).toMatch(why);
      expect(String(phaseNote(w))).toMatch(/截图验收要 PM 在新 head 上补/);
      expect(drift(w)).toMatch(/UI 截图验收已失效/);
    });
  }

  const twists: [string, (w: W) => void, RegExp][] = [
    ["PM's last verdict is rejected", (w) => w.add("agent-pm", "decision", { op: UI_REJECTED, head: reviewed, specRev: 1, round: 1,
      screenshotsDigest: DIGEST, note: "改" }), /不是 approved/],
    ["approval for another round", (w) => w.add("agent-pm", "decision", { op: UI_APPROVED, head: reviewed, specRev: 1, round: 2, screenshotsDigest: DIGEST }), /没绑在/],
    ["digest changed", (w) => w.db.query("UPDATE tasks SET extra = json_set(extra, '$.screenshotsDigest', ?) WHERE id = 'T1'").run("e".repeat(64)), /没绑在/],
    ["approval bound to another head", (w) => w.add("agent-pm", "decision", { op: UI_APPROVED, head: heads.web!.merged, specRev: 1, round: 1,
      screenshotsDigest: DIGEST }), /没绑在/],
    ["ownerVisual raised", (w) => w.add("agent-author", "task", { op: "set", patch: { extra: { ownerVisual: true } } }), /ownerVisual/],
  ];
  // The merge run's own drift already refuses these before the carry (unless the owner answered): the writer re-judges on its own.
  for (const [name, twist, why] of twists) {
    test(`${name}: the writer plans no ui_carry and says why`, () => {
      const w = world();
      begin(w);
      twist(w);
      const plan = uiCarryPlan(w.db, getTask(w.db, "T1")!, "a1", evidence("lib"), Date.now());
      expect(String(plan.note)).toMatch(why);
      plan.commit(1);
      expect(uiCarries(w)).toEqual([]);
    });
  }

  test("the receipt's diffHash does not re-prove in the writer's temp repo: nothing carried, note says so", () => {
    const w = world();
    begin(w);
    carry(w, "lib", { diffHash: "f".repeat(64) });
    expect(uiCarries(w)).toEqual([]);
    expect(String(phaseNote(w))).toMatch(/canonical 净 diff 在本库对不上/);
    expect(drift(w)).toMatch(/UI 截图验收已失效/);
  });

  test("no repoDir for the project: nothing carried (fail closed), note says so", () => {
    const w = world();
    begin(w);
    writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, projects: { q: { maxActiveWorkers: 1, requiredChecks: ["c"], repoDir: work } } }));
    carry(w, "lib");
    expect(uiCarries(w)).toEqual([]);
    expect(String(phaseNote(w))).toMatch(/repoDir/);
  });
});

describe("UICAR2 switch", () => {
  test("observe: one observation note (would carry + the touched list), no ui_carry, drift refuses as before", () => {
    const w = world({ mode: "observe" });
    begin(w);
    carry(w, "lib");
    expect(uiCarries(w)).toEqual([]);
    const obs = evs(w).filter((e) => e.data.op === "recovery_observe");
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ actor: "scheduler", kind: "note", data: { mechanism: "uiCarry", changed: ["src/lib/other.ts"], touched: [] } });
    expect(obs[0]!.text).toMatch(/沿用截图验收/);
    expect(drift(w)).toMatch(/UI 截图验收已失效/);
  });

  test("off: nothing recorded, no note; default (no entry) is observe; an unknown file reads off", () => {
    const w = world({ mode: "off" });
    begin(w);
    carry(w, "web");
    expect(evs(w).filter((e) => e.data.op === "recovery_observe" || e.data.op === "ui_carry")).toEqual([]);
    expect(phaseNote(w)).toBeUndefined();
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: {} }));
    expect(uiCarryMode("p")).toBe("observe");
    writeFileSync(RECOVERY_POLICY_PATH, "{");
    expect(uiCarryMode("p")).toBe("off");
  });
});

describe("UICAR2 read: only the scheduler's paired ui_carry counts", () => {
  /** A carried run; the ledger is append-only, so the reader is handed the events with the ui_carry rewritten (or gone). */
  const readWith = (change: (u: LedgerEvent) => LedgerEvent | null) => {
    const w = world();
    begin(w);
    carry(w, "lib");
    const task = getTask(w.db, "T1")!, all = evs(w), pm = projectPmUiGate(w.db, task, all);
    expect(uiCarriedFrom(w.db, task, all, pm)).toBe(true);
    const twisted = all.flatMap((e) => (e.data.op === "ui_carry" ? [change(e)].filter((x): x is LedgerEvent => !!x) : [e]));
    return uiCarriedFrom(w.db, task, twisted, pm);
  };
  const data = (u: LedgerEvent, patch: Record<string, unknown>): LedgerEvent => ({ ...u, data: { ...u.data, ...patch } });
  const cases: [string, (u: LedgerEvent) => LedgerEvent | null][] = [
    ["written by a non-scheduler actor", (u) => ({ ...u, actor: "agent-author" })],
    ["forged approvalSeq", (u) => data(u, { approvalSeq: (u.data.approvalSeq as number) - 1 })],
    ["other digest", (u) => data(u, { digest: "e".repeat(64) })],
    ["other round", (u) => data(u, { round: 2 })],
    ["other specRev", (u) => data(u, { specRev: 2 })],
    ["other from", (u) => data(u, { from: heads.web!.main })],
    ["other intent", (u) => data(u, { intentId: "a0" })],
    ["other carrySeq", (u) => data(u, { carrySeq: (u.data.carrySeq as number) - 1 })],
    ["non-empty touched", (u) => data(u, { touched: ["web/x.tsx"] })],
    ["another key", (u) => ({ ...u, dedupKey: "scheduler:a1:ui-carry:0" })],
    ["not right after the carry's merge_phase", (u) => ({ ...u, seq: u.seq + 1 })],
    ["missing", () => null],
  ];
  for (const [name, change] of cases) test(name, () => expect(readWith(change)).toBe(false));

  test("a forged ui_carry for a scheduler carry that had none (main touched web) is not read", () => {
    const w = world();
    begin(w);
    carry(w, "web");
    const c = evs(w).find((e) => e.data.op === "review_carry")!, pm = projectPmUiGate(w.db, getTask(w.db, "T1")!, evs(w));
    w.db.transaction(() => insertEvent(w.db, { actor: "agent-author", now: Date.now() }, { project: "p", target: "T1", kind: "scheduler", text: "",
      data: { op: "ui_carry", intentId: "a1", from: reviewed, to: c.data.to, round: 1, specRev: 1, digest: DIGEST, approvalSeq: pm.seq,
        mainBase: reviewed, mainParent: c.data.mainParent, touched: [], carrySeq: c.seq } }, false))();
    expect(drift(w)).toMatch(/UI 截图验收已失效/);
    expect(uiCarriedFrom(w.db, getTask(w.db, "T1")!, evs(w), pm)).toBe(false);
  });

  test("a later PM approval at the new head still releases it directly (UICAR1 path unchanged)", () => {
    const w = world();
    begin(w);
    carry(w, "web");
    expect(drift(w)).toMatch(/UI 截图验收已失效/);
    w.add("agent-pm", "decision", { op: UI_APPROVED, head: heads.web!.merged, specRev: 1, round: 1, screenshotsDigest: DIGEST });
    expect(drift(w)).toBeNull();
  });
});
