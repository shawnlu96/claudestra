/**
 * UIOWNCARRY1 · on an ownerVisual card the owner's screenshot approval survives the scheduler's own update-branch carry when the render
 * inputs of the approved head and the new head are identical (UIR1's renderInputs), under `uiOwnerCarry` (off / observe / on). The
 * planner (projectUiGate → uiMergeBlock) and the merge write (uiMergeRefusal / mergeRunDrift) accept it through one pairing function.
 * Real git fixture, temp ledger, the file-backed policy reader, the real advanceMergeRun transaction. No network, no production state.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindHash } from "../src/lib/ask-bind.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { UI_APPROVED } from "../src/lib/ledger-ui-approve-verdict.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { advanceMergeRun, beginMergeRun, carryReceipt, getMergeRun, mergeRunDrift, type CarryEvidence, type MergeRun } from "../src/lib/scheduler-merge.js";
import type { PlannerSnapshot } from "../src/lib/scheduler-plan.js";
import { uiCarryPlan } from "../src/lib/scheduler-ui-carry.js";
import { projectUiGate, uiMergeBlock, uiMergeRefusal } from "../src/lib/scheduler-ui-gate.js";
import { ownerCarriedAsk, uiOwnerCarryMode } from "../src/lib/scheduler-ui-owner-carry.js";
import { uiReviewCarryKey } from "../src/lib/scheduler-ui-review-carry.js";

const DIGEST = "d".repeat(64), PR = "https://github.com/example/repo/pull/5", SCHED = { actor: "scheduler" }, OWNER = { actor: "owner" };
let root = "", work = "", reviewed = "", base = "";
const heads: Record<string, { main: string; merged: string }> = {};
const sh = async (...argv: string[]) => {
  const r = await runBounded(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...argv],
    { cwd: work, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = async (file: string, body: string) => {
  mkdirSync(join(work, file, ".."), { recursive: true }); writeFileSync(join(work, file), body);
  await sh("add", "-A"); await sh("commit", "-qm", file); return sh("rev-parse", "HEAD");
};
const mergeMain = async (kind: string, from: string, main: string) => {
  await sh("checkout", "-q", "-B", `h-${kind}`, from); await sh("merge", "-q", "--no-edit", main);
  heads[kind] = { main, merged: await sh("rev-parse", "HEAD") };
};

/** base → feature `reviewed` (the UI change); per kind a main commit on base merged into it; lib2 = a second main hop after lib. */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "uiowncarry-")); work = join(root, "repo"); mkdirSync(work);
  await sh("init", "-q", "-b", "main");
  for (const f of ["README.md", "web/app.tsx", "src/lib/other.ts", "package.json"]) await commit(f, "base\n");
  base = await sh("rev-parse", "HEAD");
  await sh("checkout", "-qb", "feature"); reviewed = await commit("web/app.tsx", "ui change\n");
  for (const [kind, file] of [["lib", "src/lib/other.ts"], ["web", "web/features/x.tsx"], ["dep", "package.json"]] as const) {
    await sh("checkout", "-q", "-B", `main-${kind}`, base);
    await mergeMain(kind, reviewed, await commit(file, `main ${kind}\n`));
  }
  await sh("checkout", "-q", "main-lib"); await mergeMain("lib2", heads.lib!.merged, await commit("src/lib/other2.ts", "main 2\n"));
}, 120_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

type Mode = "on" | "observe" | "off";
/** The other carry layers keep their own default (observe); null = no uiOwnerCarry entry. */
const policy = (mode: Mode | null) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { ...(mode ? { uiOwnerCarry: mode } : {}) } } } }));
let askN = 0;
/** A scheduler screenshot ask bound to `head`, answered by the authenticated owner (approve) unless told otherwise. */
function ownerAsk(db: ReturnType<typeof openLedger>, o: { head?: string; answer?: "approve" | "reject" | "guest"; from?: string } = {}) {
  const from = o.from ?? "scheduler", at = Date.now() - 60_000 + askN;
  const binding = { action: "scheduler_ui_screenshot", params: { task: "T1", specRev: 1, head: o.head ?? reviewed, screenshotsDigest: DIGEST }, approve: ["scheduler_ui_approve"] };
  const ask = openAsk(db, { project: "p", taskId: "T1", fromAgent: from, source: from === "scheduler" ? "system" : "reply", kind: "authorize",
    title: "看前后截图", askKey: `scheduler_ui_screenshot:T1:${askN++}`, expiresAt: 1e15, bind: { ...binding, paramsHash: bindHash(binding, from) } }, at);
  const answer = o.answer ?? "approve";
  answerAsk(db, ask.id, { choices: [`[button:${answer === "reject" ? "scheduler_ui_reject" : "scheduler_ui_approve"}]`], labels: ["x"],
    principal: answer === "guest" ? "guest" : "owner", owner: answer !== "guest", via: "web_card", at: at + 1 } as never);
  return ask;
}

/** ownerVisual UI card T1 (auto) in merge at `reviewed`: cross-family PASS, the owner's approval bound there, merge run a1 begun (ready). */
function world(o: { mode?: Mode | null; ownerVisual?: boolean } = {}) {
  const ownerVisual = o.ownerVisual ?? true;
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
  const extra = { screenshotsDigest: DIGEST, fileGlobs: [], ...(ownerVisual ? { ownerVisual: true } : {}) };
  db.query("UPDATE tasks SET stage='review', round=1, headSHA=?, pr=?, branch='task/T1', extra=? WHERE id='T1'").run(reviewed, PR, JSON.stringify(extra));
  if (ownerVisual) add("owner", "task", { op: "set", patch: { extra } });
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
  const ask = ownerVisual ? ownerAsk(db) : null;
  if (!ownerVisual) add("agent-pm", "decision", { op: UI_APPROVED, head: reviewed, specRev: 1, round: 1, screenshotsDigest: DIGEST });
  db.query("UPDATE tasks SET stage='merge' WHERE id='T1'").run();
  add("owner", "stage", { from: "review", to: "merge", round: 1, specRev: 1 });
  planIntent(db, SCHED, { id: "a1", taskId: "T1", taskRev: rev(), workflowRev: wf(), causalSeq: seq(), node: "merge_deploy",
    action: "merge", reason: "merge", resources: ["merge:p"] });
  settleIntent(db, SCHED, { id: "a1", from: "pending", to: "submitted", receipt: "claimed" });
  expect(beginMergeRun(db, SCHED, "a1", ["check"]).run.phase).toBe("ready"); // the owner's approval on `reviewed` opens the run, as before
  return { db, add, ask };
}
type W = ReturnType<typeof world>;
const run = (w: W) => getMergeRun(w.db, "a1")!;
const step = (w: W, to: MergeRun["phase"], extra: { receipt?: string; newHead?: string; mergeSha?: string } = {}) =>
  advanceMergeRun(w.db, SCHED, { intentId: "a1", from: run(w).phase, to, rev: run(w).rev, ...extra });
const netHash = (main: string, head: string) => createHash("sha256").update(execFileSync("git", ["-c", "core.quotePath=true", "diff",
  "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--full-index", "--no-renames", "--ignore-submodules=none", "--no-relative",
  "--submodule=short", `${main}...${head}`], { cwd: work })).digest("hex");
const evidence = (kind: string, from = reviewed): CarryEvidence => {
  const { main, merged } = heads[kind]!;
  return { oldHead: from, newHead: merged, mainParent: main, mainHead: main, diffHash: netHash(main, merged) };
};
/** The merge driver's own update-branch: → updating → await_ci with the carry receipt (review_carry + merge_phase in one transaction). */
const carry = (w: W, kind: string, from = reviewed) => {
  const ev = evidence(kind, from);
  step(w, "updating");
  return step(w, "await_ci", { newHead: ev.newHead, receipt: carryReceipt(ev) + carryChainSuffix([{ previousHead: ev.oldHead, head: ev.newHead, mainParent: ev.mainParent }]) });
};
const evs = (w: W) => listEvents(w.db, { project: "p", target: "T1" });
const records = (w: W) => evs(w).filter((e) => e.data.op === "ui_review_carry");
const observed = (w: W) => evs(w).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "uiOwnerCarry");
const phaseNote = (w: W) => evs(w).findLast((e) => e.data.op === "merge_phase" && e.data.to === "await_ci")?.data.note;
const task = (w: W) => getTask(w.db, "T1")!;
const write = (w: W) => uiMergeRefusal(w.db, task(w), Date.now());
const drift = (w: W) => mergeRunDrift(w.db, run(w), Date.now());
/** The planner side, as scheduler-snapshot.ts builds it for uiMergeBlock. */
const planner = (w: W) => uiMergeBlock({ task: task(w), events: evs(w), screenshotsDigest: DIGEST, ownerVisual: true,
  uiGate: projectUiGate(w.db, task(w), Date.now()) } as unknown as PlannerSnapshot);

describe("[验收线 1] the owner approved H0; the merge driver's update-branch moves to H1 and main touched no render input", () => {
  test("on: ui_review_carry with the ask id at carrySeq + 2; planner and merge write both open; the card merges", () => {
    const w = world();
    carry(w, "lib");
    const c = evs(w).find((e) => e.data.op === "review_carry")!, [u] = records(w);
    expect(u).toMatchObject({ actor: "scheduler", kind: "scheduler", seq: c.seq + 2, dedupKey: uiReviewCarryKey("a1", c.seq), data: {
      mechanism: "uiOwnerCarry", ask: w.ask!.id, approvedHead: reviewed, approvalSeq: null, carrySeq: c.seq, intentId: "a1",
      from: reviewed, to: heads.lib!.merged, specRev: 1, digest: DIGEST, mainParent: heads.lib!.main, diffHash: c.data.diffHash } });
    expect(u!.data.renderInputs).toMatch(/^[a-f0-9]{64}$/);
    expect(phaseNote(w)).toBeUndefined();
    expect([planner(w), write(w), drift(w)]).toEqual([null, null, null]);
    expect(projectUiGate(w.db, task(w), Date.now())).toMatchObject({ state: "approved", ownerVerified: true, head: heads.lib!.merged });
    step(w, "merging");
    expect(step(w, "merged", { receipt: "merged", mergeSha: "f".repeat(40) }).phase).toBe("merged");
  });

  test("on: two main updates in a row chain on the one approval", () => {
    const w = world();
    carry(w, "lib");
    carry(w, "lib2", heads.lib!.merged);
    expect(records(w).map((u) => [u.data.from, u.data.to, u.data.approvedHead])).toEqual([[reviewed, heads.lib!.merged, reviewed],
      [heads.lib!.merged, heads.lib2!.merged, reviewed]]);
    expect([planner(w), write(w), drift(w)]).toEqual([null, null, null]);
  });

  for (const mode of ["observe", "off", null] as const) {
    test(`${mode ?? "no entry (= observe)"}: as before the change — merge_ui_unapproved, the write refuses${mode !== "off" ? ", plus one would-carry observation" : ""}`, () => {
      const w = world({ mode });
      carry(w, "lib");
      expect(records(w)).toEqual([]);
      expect(planner(w)).toBe("本卡要 owner 看截图：缺与当前 head/specRev/摘要相符的 owner 认证答复");
      expect(write(w)).toBe("缺同 head/specRev/摘要的 owner 截图授权（本卡要 owner 看截图）");
      expect(drift(w)).toMatch(/UI 截图验收已失效/);
      if (mode === "off") expect(observed(w)).toEqual([]);
      else expect(observed(w).map((e) => e.data)).toEqual([expect.objectContaining({ carried: true, renderSame: true, ask: w.ask!.id,
        from: reviewed, to: heads.lib!.merged, approvedHead: reviewed })]);
    });
  }
  test("no entry reads as observe; an unreadable policy as off", () => {
    policy(null);
    expect(uiOwnerCarryMode("p")).toBe("observe");
    writeFileSync(RECOVERY_POLICY_PATH, "{");
    expect(uiOwnerCarryMode("p")).toBe("off");
    rmSync(RECOVERY_POLICY_PATH, { force: true });
  });
});

describe("[验收线 2] main's part changed a render input: never carried", () => {
  for (const kind of ["web", "dep"]) {
    for (const mode of ["on", "observe", "off"] as const) {
      test(`${kind} · ${mode}`, () => {
        const w = world({ mode });
        carry(w, kind);
        expect(records(w)).toEqual([]);
        expect(write(w)).not.toBeNull();
        expect(drift(w)).toMatch(/UI 截图验收已失效/);
        if (mode === "on") {
          expect(String(phaseNote(w))).toMatch(/owner 截图批准不沿用：main 改了界面输入.*要 PM 在新 head 重拍/);
          expect(planner(w)).toMatch(/owner 截图批准不沿用：main 改了界面输入.*要 PM 在新 head 重拍/);
        } else {
          expect(planner(w)).toBe("本卡要 owner 看截图：缺与当前 head/specRev/摘要相符的 owner 认证答复");
          expect(observed(w).map((e) => e.data.carried)).toEqual(mode === "observe" ? [false] : []);
        }
      });
    }
  }
});

describe("[验收线 3] expired, rejected, not the authenticated owner, or a head PM moved by hand: never carried", () => {
  const twists: [string, (w: W) => void, RegExp][] = [
    ["the ask expired", (w) => w.db.query("UPDATE asks SET expiresAt = 1 WHERE id = ?").run(w.ask!.id), /不算批准/],
    ["a newer ask the owner rejected", (w) => ownerAsk(w.db, { answer: "reject" }), /不算批准/],
    ["a newer ask answered by a guest", (w) => ownerAsk(w.db, { answer: "guest" }), /不是已认证的 owner/],
  ];
  for (const [name, twist, why] of twists) {
    for (const mode of ["on", "observe", "off"] as const) {
      test(`${name} · ${mode}`, () => {
        const w = world({ mode });
        twist(w);
        const plan = uiCarryPlan(w.db, task(w), "a1", evidence("lib"), Date.now());
        if (mode === "on") expect(String(plan.note)).toMatch(why);
        plan.commit(1);
        expect(records(w)).toEqual([]);
        if (mode === "observe") expect(observed(w).map((e) => e.data.carried)).toEqual([false]);
      });
    }
  }
  test("a manager-opened ask never counts, even owner-answered", () => {
    const w = world();
    ownerAsk(w.db, { from: "agent-pm" }); // not the scheduler's: the newest scheduler ask still decides
    carry(w, "lib");
    expect(records(w)).toHaveLength(1);
    expect(ownerCarriedAsk(w.db, task(w), evs(w), Date.now())?.id).toBe(w.ask!.id);
  });
  for (const mode of ["on", "observe", "off"] as const) {
    test(`PM's manual update-branch to H1, then the scheduler's carry H1 → H2 · ${mode}: no trusted chain, nothing carried`, () => {
      const w = world({ mode });
      w.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(heads.lib!.merged); // the head moved outside the driver: no review_carry
      w.db.query("UPDATE scheduler_merges SET reviewedHead=? WHERE intentId='a1'").run(heads.lib!.merged);
      expect([write(w), ownerCarriedAsk(w.db, task(w), evs(w), Date.now())]).toEqual([expect.any(String), null]);
      const plan = uiCarryPlan(w.db, task(w), "a1", evidence("lib2", heads.lib!.merged), Date.now());
      if (mode === "on") expect(String(plan.note)).toMatch(/不是调度器的可信沿用链/);
      plan.commit(1);
      expect(records(w)).toEqual([]);
    });
  }
});

describe("[验收线 5] planner and merge write share one pairing function: a forged record opens neither", () => {
  const forge = (w: W, key: (carrySeq: number) => string, drop?: string) => {
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { uiOwnerCarry: "on", uiCarry: "off", uiReviewCarry: "off", uiCarryOwnGlobs: "off" } } } }));
    carry(w, "web"); // refused under on, the other layers off: nothing at carrySeq + 2
    const c = evs(w).find((e) => e.data.op === "review_carry")!;
    const data: Record<string, unknown> = { op: "ui_review_carry", mechanism: "uiOwnerCarry", ask: w.ask!.id, approvedHead: reviewed, approvalSeq: null,
      carrySeq: c.seq, intentId: "a1", from: c.data.from, to: c.data.to, specRev: 1, round: 1, digest: DIGEST, renderInputs: "a".repeat(64),
      mainParent: c.data.mainParent, mainHead: c.data.mainHead, diffHash: c.data.diffHash };
    if (drop) delete data[drop];
    const seq = insertEvent(w.db, { actor: "scheduler", now: Date.now(), dedupKey: key(c.seq) }, { project: "p", target: "T1", kind: "scheduler",
      text: "伪", data }, true).seq;
    expect(seq).toBe(c.seq + 2);
  };
  const cases: [string, (w: W) => void][] = [
    ["wrong key", (w) => forge(w, (s) => `scheduler:a1:ui-owner-carry:${s}`)],
    ["missing renderInputs", (w) => forge(w, (s) => uiReviewCarryKey("a1", s), "renderInputs")],
    ["missing ask", (w) => forge(w, (s) => uiReviewCarryKey("a1", s), "ask")],
    ["missing mechanism", (w) => forge(w, (s) => uiReviewCarryKey("a1", s), "mechanism")],
  ];
  for (const [name, f] of cases) {
    test(name, () => {
      const w = world();
      f(w);
      expect(planner(w)).not.toBeNull();
      expect(write(w)).not.toBeNull();
      expect(projectUiGate(w.db, task(w), Date.now()).head).toBe(reviewed);
    });
  }
  test("the complete record (control): both open", () => {
    const w = world();
    forge(w, (s) => uiReviewCarryKey("a1", s));
    expect([planner(w), write(w)]).toEqual([null, null]);
  });
});

describe("[验收线 6] not ownerVisual: PM's acceptance carry exactly as before", () => {
  test("uiOwnerCarry on changes nothing: the carry records PM's UIR1 / UICAR2 layers only, no owner record", () => {
    const w = world({ ownerVisual: false });
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { uiOwnerCarry: "on", uiReviewCarry: "on" } } } }));
    carry(w, "lib");
    expect(records(w).map((u) => [u.data.ask, u.data.mechanism, u.data.approvedHead])).toEqual([[null, undefined, reviewed]]);
    expect(write(w)).toBeNull();
    expect(observed(w)).toEqual([]);
  });
});
