/**
 * UICAR3 (uiCarryOwnGlobs) · the scheduler's own update-branch carry on a UI card whose main part touches web/ but none of the card's
 * own files (extra.fileGlobs, net diff paths). Judged after UICAR2 / UIR1 in the same uiCarryPlan call: on writes a ui_carry with
 * mechanism=uiCarryOwnGlobs that the UI gate reads back, observe records one recovery_observe and leaves the manual path as it was,
 * off does nothing. Real git fixture, temp ledger in process (tests/scheduler-ui-carry.test.ts is UICAR2's).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { UI_APPROVED, UI_REJECTED } from "../src/lib/ledger-ui-approve-verdict.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { advanceMergeRun, beginMergeRun, carryReceipt, getMergeRun, mergeRunDrift, type CarryEvidence } from "../src/lib/scheduler-merge.js";
import { uiCarryPlan } from "../src/lib/scheduler-ui-carry.js";
import { ownGlobsHits } from "../src/lib/scheduler-ui-carry-own-globs.js";
import { uiCarryOwnGlobsMode } from "../src/lib/scheduler-ui-carry-read.js";

const DIGEST = "d".repeat(64), PR = "https://github.com/example/repo/pull/7", SCHED = { actor: "scheduler" }, OWNER = { actor: "owner" };
const GLOBS = ["web/card/**"];
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

/** base → feature `reviewed` (changes web/card/a.tsx); main siblings: another web file, a new file under the card's glob, src/lib only. */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "uicar3-")); work = join(root, "repo"); mkdirSync(work);
  await sh("init", "-q", "-b", "main");
  for (const f of ["README.md", "web/app.tsx", "web/card/a.tsx", "src/lib/other.ts"]) await commit(f, "base\n");
  const base = await sh("rev-parse", "HEAD");
  await sh("checkout", "-qb", "feature"); reviewed = await commit("web/card/a.tsx", "ui change\n");
  for (const [kind, file] of [["web", "web/app.tsx"], ["glob", "web/card/b.tsx"], ["lib", "src/lib/other.ts"]] as const) {
    await sh("checkout", "-q", "-B", `main-${kind}`, base);
    const main = await commit(file, `main ${kind}\n`);
    await sh("checkout", "-q", "-B", `h-${kind}`, reviewed); await sh("merge", "-q", "--no-edit", main);
    heads[kind] = { main, merged: await sh("rev-parse", "HEAD") };
  }
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

let cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

type Mode = "on" | "observe" | "off";
/** UI card T1 (auto) in merge at `reviewed`: cross-family PASS, PM's bound approval, merge run a1 claimed. */
function world(o: { own?: Mode; uiCarry?: Mode; review?: Mode } = {}) {
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { uiCarry: o.uiCarry ?? "on", uiReviewCarry: o.review ?? "off",
    ...(o.own ? { uiCarryOwnGlobs: o.own } : {}) } } } }));
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: work } } }));
  const dir = mkdtempSync(join(root, "ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); rmSync(RECOVERY_POLICY_PATH, { force: true }); rmSync(SCHEDULER_CONFIG_PATH, { force: true }); });
  const add = (actor: string, kind: string, data: unknown) => db.prepare(
    "INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (10,?,'p','T1',?,'',?)").run(actor, kind, JSON.stringify(data));
  const seq = () => (db.query("SELECT MAX(seq) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
  setMeta(db, OWNER, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, OWNER, { project: "p", id: "T1", title: "ui", kind: "code", agent: "agent-author" });
  setWorkflow(db, OWNER, { taskId: "T1", taskRev: 1, template: "ui", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "manual" });
  const extra = { screenshotsDigest: DIGEST, fileGlobs: GLOBS };
  db.query("UPDATE tasks SET stage='review', round=1, headSHA=?, pr=?, branch='task/T1', extra=? WHERE id='T1'").run(reviewed, PR, JSON.stringify(extra));
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
  return { db, add };
}
type W = ReturnType<typeof world>;
const begin = (w: W) => beginMergeRun(w.db, SCHED, "a1", ["check"]).run;
const step = (w: W, to: "updating" | "await_ci", extra: { receipt?: string; newHead?: string } = {}) => {
  const r = getMergeRun(w.db, "a1")!;
  return advanceMergeRun(w.db, SCHED, { intentId: "a1", from: r.phase, to, rev: r.rev, ...extra });
};
const netHash = (main: string, head: string) => createHash("sha256").update(execFileSync("git", ["-c", "core.quotePath=true", "diff",
  "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--full-index", "--no-renames", "--ignore-submodules=none", "--no-relative",
  "--submodule=short", `${main}...${head}`], { cwd: work })).digest("hex");
const evidence = (kind: string, patch: Partial<CarryEvidence> = {}): CarryEvidence => {
  const { main, merged } = heads[kind]!;
  return { oldHead: reviewed, newHead: merged, mainParent: main, mainHead: main, diffHash: netHash(main, merged), ...patch };
};
const carry = (w: W, kind: string, patch: Partial<CarryEvidence> = {}) => {
  const ev = evidence(kind, patch);
  step(w, "updating");
  return step(w, "await_ci", { newHead: ev.newHead, receipt: carryReceipt(ev) +
    carryChainSuffix([{ previousHead: reviewed, head: ev.newHead, mainParent: ev.mainParent }]) });
};
const evs = (w: W) => listEvents(w.db, { project: "p", target: "T1" });
const uiCarries = (w: W) => evs(w).filter((e) => e.data.op === "ui_carry");
const observed = (w: W, mechanism = "uiCarryOwnGlobs") => evs(w).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === mechanism);
const phaseNote = (w: W) => evs(w).findLast((e) => e.data.op === "merge_phase" && e.data.to === "await_ci")?.data.note;
const drift = (w: W) => mergeRunDrift(w.db, getMergeRun(w.db, "a1")!, Date.now());

describe("uiCarryOwnGlobs switch", () => {
  test("registered in sorted position; default (no entry) observe; an unreadable policy reads off", () => {
    expect(RECOVERY_KEYS).toContain("uiCarryOwnGlobs");
    expect(RECOVERY_KEYS.indexOf("uiCarryOwnGlobs")).toBe(RECOVERY_KEYS.indexOf("uiCarry") + 1);
    const w = world();
    expect(uiCarryOwnGlobsMode("p")).toBe("observe");
    writeFileSync(RECOVERY_POLICY_PATH, "{ not json");
    expect(uiCarryOwnGlobsMode("p")).toBe("off");
    expect(uiCarryOwnGlobsMode("p", () => { throw new Error("x"); })).toBe("off");
    void w;
  });
});

describe("[验收线 1] main touched another web/ file, none of the card's own files", () => {
  test("on: ui_carry (mechanism uiCarryOwnGlobs) at carrySeq + 2, no note, the UI gate opens at the new head", () => {
    const w = world({ own: "on" });
    begin(w);
    carry(w, "web");
    const c = evs(w).find((e) => e.data.op === "review_carry")!, [u, ...rest] = uiCarries(w);
    expect(rest).toEqual([]);
    expect(u).toMatchObject({ actor: "scheduler", kind: "scheduler", seq: c.seq + 2, dedupKey: `scheduler:a1:ui-carry:${c.seq}`,
      data: { mechanism: "uiCarryOwnGlobs", intentId: "a1", from: reviewed, to: heads.web!.merged, round: 1, specRev: 1, digest: DIGEST,
        mainParent: heads.web!.main, touched: ["web/app.tsx"], uiTouched: 1, ownFiles: 1, carrySeq: c.seq } });
    expect(phaseNote(w)).toBeUndefined();
    expect(observed(w)).toEqual([]);
    expect(getTask(w.db, "T1")!.headSHA).toBe(heads.web!.merged);
    expect(drift(w)).toBeNull();
    // switched back to observe: the record no longer opens the gate
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { uiCarry: "on", uiReviewCarry: "off", uiCarryOwnGlobs: "observe" } } } }));
    expect(drift(w)).toMatch(/UI 截图验收已失效/);
  });

  test("on with UIR1 on (which refuses: render inputs changed): UICAR3 carries and the UIR1 gate reads it", () => {
    const w = world({ own: "on", review: "on" });
    begin(w);
    carry(w, "web");
    const c = evs(w).find((e) => e.data.op === "review_carry")!;
    expect(uiCarries(w).map((e) => [e.seq, e.data.mechanism])).toEqual([[c.seq + 2, "uiCarryOwnGlobs"]]);
    expect(evs(w).filter((e) => e.data.op === "ui_review_carry")).toEqual([]);
    expect(phaseNote(w)).toBeUndefined();
    expect(drift(w)).toBeNull();
  });

  test("observe: no ui_carry, one observation (UI files touched + card files), note and refusal as before", () => {
    const w = world({ own: "observe" });
    begin(w);
    carry(w, "web");
    expect(uiCarries(w)).toEqual([]);
    const obs = observed(w);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ actor: "scheduler", kind: "note", data: { uiTouched: 1, ownFiles: 1, from: reviewed, to: heads.web!.merged } });
    expect(obs[0]!.text).toMatch(/沿用截图验收/);
    expect(String(phaseNote(w))).toMatch(/main 改了 web\/app\.tsx.*截图验收要 PM 在新 head 上补/);
    expect(drift(w)).toMatch(/UI 截图验收已失效/);
  });

  test("off: nothing recorded, refusal as before", () => {
    const w = world({ own: "off" });
    begin(w);
    carry(w, "web");
    expect(uiCarries(w)).toEqual([]);
    expect(observed(w)).toEqual([]);
    expect(String(phaseNote(w))).toMatch(/main 改了 web\/app\.tsx/);
    expect(drift(w)).toMatch(/UI 截图验收已失效/);
  });
});

describe("[验收线 2] main touched the card's own files", () => {
  for (const own of ["on", "observe"] as const) {
    test(`${own}: a file under the card's fileGlobs: nothing carried, nothing recorded`, () => {
      const w = world({ own });
      begin(w);
      carry(w, "glob");
      expect(uiCarries(w)).toEqual([]);
      expect(observed(w)).toEqual([]);
      expect(String(phaseNote(w))).toMatch(/main 改了 web\/card\/b\.tsx/);
      expect(drift(w)).toMatch(/UI 截图验收已失效/);
    });
  }
  test("a path of the card's net diff (outside its globs, any case) counts as the card's own", () => {
    expect(ownGlobsHits(["web/app.tsx", "docs/X.md"], GLOBS, ["web/card/a.tsx", "docs/x.md"])).toEqual(["docs/X.md"]);
    expect(ownGlobsHits(["web/card/new.tsx"], GLOBS, [])).toEqual(["web/card/new.tsx"]);
    expect(ownGlobsHits(["web/app.tsx", "src/bridge/b.ts"], GLOBS, ["web/card/a.tsx"])).toEqual([]);
  });
});

describe("[验收线 3] the other conditions", () => {
  const twists: [string, (w: W) => void][] = [
    ["PM's last verdict is rejected", (w) => w.add("agent-pm", "decision", { op: UI_REJECTED, head: reviewed, specRev: 1, round: 1,
      screenshotsDigest: DIGEST, note: "改" })],
    ["digest changed", (w) => w.db.query("UPDATE tasks SET extra = json_set(extra, '$.screenshotsDigest', ?) WHERE id = 'T1'").run("e".repeat(64))],
    ["approval bound to another head", (w) => w.add("agent-pm", "decision", { op: UI_APPROVED, head: heads.lib!.merged, specRev: 1, round: 1,
      screenshotsDigest: DIGEST })],
    ["ownerVisual raised", (w) => w.add("agent-author", "task", { op: "set", patch: { extra: { ownerVisual: true } } })],
  ];
  for (const [name, twist] of twists) {
    for (const own of ["on", "observe"] as const) {
      test(`${name} (${own}): nothing carried, nothing recorded`, () => {
        const w = world({ own });
        begin(w);
        twist(w);
        const plan = uiCarryPlan(w.db, getTask(w.db, "T1")!, "a1", evidence("web"), Date.now());
        expect(plan.note).not.toBeNull();
        plan.commit(1);
        expect(uiCarries(w)).toEqual([]);
        expect(observed(w)).toEqual([]);
      });
    }
  }
  test("net diff not equal (receipt does not re-prove): nothing carried, nothing recorded", () => {
    const w = world({ own: "on" });
    begin(w);
    carry(w, "web", { diffHash: "f".repeat(64) });
    expect(uiCarries(w)).toEqual([]);
    expect(observed(w)).toEqual([]);
    expect(String(phaseNote(w))).toMatch(/canonical 净 diff 在本库对不上/);
    expect(drift(w)).toMatch(/UI 截图验收已失效/);
  });
});

describe("[验收线 4] UICAR2 / UIR1 already carried", () => {
  test("UICAR2 on carries (main only src/lib): one UICAR2 ui_carry, no UICAR3 event", () => {
    const w = world({ own: "on" });
    begin(w);
    carry(w, "lib");
    const u = uiCarries(w);
    expect(u).toHaveLength(1);
    expect(u[0]!.data.mechanism).toBeUndefined();
    expect(u[0]!.data.touched).toEqual([]);
    expect(observed(w)).toEqual([]);
    expect(drift(w)).toBeNull();
  });
  test("UICAR2 observe would carry: only its own observation, UICAR3 not judged", () => {
    const w = world({ own: "observe", uiCarry: "observe" });
    begin(w);
    carry(w, "lib");
    expect(observed(w, "uiCarry")).toHaveLength(1);
    expect(observed(w)).toEqual([]);
  });
  test("UIR1 on carries (main only src/lib, render inputs equal): its ui_review_carry only, no UICAR3 event", () => {
    const w = world({ own: "on", review: "on" });
    begin(w);
    carry(w, "lib");
    expect(evs(w).filter((e) => e.data.op === "ui_review_carry")).toHaveLength(1);
    expect(uiCarries(w)).toEqual([]);
    expect(observed(w)).toEqual([]);
    expect(drift(w)).toBeNull();
  });
});
