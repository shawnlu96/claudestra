/**
 * merge-arch-UI1 · PM's screenshot approval carried by full rendered content (merge-content-ui.ts) where the older layers (UICAR2 /
 * UIR1 / UICAR3, scheduler-ui-carry-read.ts) leave a gap. Real git fixture, temp ledger, the file-backed policy under the preload's temp
 * state dir, the real advanceMergeRun carry transaction and the merge gate readers (uiMergeRefusal, mergeRunDrift). No network.
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
import { projectPmUiGate, UI_APPROVED, UI_REJECTED } from "../src/lib/ledger-ui-approve-verdict.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { renderIdOf } from "../src/lib/merge-content-proof.js";
import { contentUiVerdict, mergeContentUiMode, setContentUiPort } from "../src/lib/merge-content-ui.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { advanceMergeRun, beginMergeRun, carryReceipt, getMergeRun, mergeRunDrift, type CarryEvidence, type MergeRun } from "../src/lib/scheduler-merge.js";
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
  mkdirSync(join(work, file, ".."), { recursive: true }); writeFileSync(join(work, file), body);
  await sh("add", "-A"); await sh("commit", "-qm", file); return sh("rev-parse", "HEAD");
};
const mergeMain = async (kind: string, from: string, main: string) => {
  await sh("checkout", "-q", "-B", `h-${kind}`, from); await sh("merge", "-q", "--no-edit", main);
  heads[kind] = { main, merged: await sh("rev-parse", "HEAD") };
};

/** base → feature `reviewed` (the UI change); per kind one main commit on base merged into it; lib2 = a second pure-main hop on lib. */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mcui-")); work = join(root, "repo"); mkdirSync(work);
  await sh("init", "-q", "-b", "main");
  for (const f of ["README.md", "web/app.tsx", "src/bridge/data.json", "src/lib/other.ts", "src/lib/owned.ts", "styles/app.css", "assets/logo.svg",
    "bun.lock", "package.json"]) await commit(f, "base\n");
  const base = await sh("rev-parse", "HEAD");
  await sh("checkout", "-qb", "feature"); reviewed = await commit("web/app.tsx", "ui change\n");
  for (const [kind, file] of [["lib", "src/lib/other.ts"], ["css", "styles/app.css"], ["bridge", "src/bridge/data.json"], ["asset", "assets/logo.svg"],
    ["lock", "bun.lock"], ["web", "web/features/x.tsx"]] as const) {
    await sh("checkout", "-q", "-B", `main-${kind}`, base);
    await mergeMain(kind, reviewed, await commit(file, `main ${kind}\n`));
  }
  await sh("checkout", "-q", "main-lib"); await mergeMain("lib2", heads.lib!.merged, await commit("src/lib/other2.ts", "main 2\n"));
  await sh("checkout", "-q", "main-lib"); await mergeMain("lib3", heads.lib2!.merged, await commit("src/lib/other3.ts", "main 3\n"));
}, 120_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); setContentUiPort(null); });

type Mode = "on" | "observe" | "off";
interface Opts { mode?: Mode | null; uiReviewCarry?: Mode; uiCarryOwnGlobs?: Mode; ownerVisual?: boolean }
/** The older layers off unless given; mode null = no mergeContentUi entry (its default, observe). */
const policy = (o: Opts) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { uiCarry: "off",
  uiReviewCarry: o.uiReviewCarry ?? "off", uiCarryOwnGlobs: o.uiCarryOwnGlobs ?? "off", ...(o.mode === null ? {} : { mergeContentUi: o.mode ?? "on" }) } } } }));
/** UI card T1 (auto) in merge at `reviewed`: cross-family PASS, PM's bound approval, merge run a1 begun (ready). */
function world(o: Opts = {}) {
  policy(o);
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: work } } }));
  const dir = mkdtempSync(join(root, "ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); rmSync(RECOVERY_POLICY_PATH, { force: true }); rmSync(SCHEDULER_CONFIG_PATH, { force: true }); });
  const add = (actor: string, kind: string, data: unknown) => db.prepare(
    "INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (10,?,'p','T1',?,'',?)").run(actor, kind, JSON.stringify(data));
  const seq = () => (db.query("SELECT MAX(seq) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
  setMeta(db, OWNER, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, OWNER, { project: "p", id: "T1", title: "ui", kind: "code", agent: "agent-author" });
  setWorkflow(db, OWNER, { taskId: "T1", taskRev: 1, template: "ui", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "manual" });
  const extra = { screenshotsDigest: DIGEST, fileGlobs: ["src/lib/owned.ts"], ...(o.ownerVisual ? { ownerVisual: true } : {}) };
  db.query("UPDATE tasks SET stage='review', round=1, headSHA=?, pr=?, branch='task/T1', extra=? WHERE id='T1'").run(reviewed, PR, JSON.stringify(extra));
  if (o.ownerVisual) add("owner", "task", { op: "set", patch: { extra } });
  add("owner", "stage", { from: "build", to: "review", round: 1, specRev: 1 });
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
  const approvalSeq = seq();
  if (o.ownerVisual) { // the owner path runs this card; its merge run is not begun here
    db.query("UPDATE tasks SET stage='merge' WHERE id='T1'").run();
    return { db, add, seq, approvalSeq };
  }
  db.query("UPDATE tasks SET stage='merge' WHERE id='T1'").run();
  add("owner", "stage", { from: "review", to: "merge", round: 1, specRev: 1 });
  planIntent(db, SCHED, { id: "a1", taskId: "T1", taskRev: rev(), workflowRev: wf(), causalSeq: seq(), node: "merge_deploy",
    action: "merge", reason: "merge", resources: ["merge:p"] });
  settleIntent(db, SCHED, { id: "a1", from: "pending", to: "submitted", receipt: "claimed" });
  expect(beginMergeRun(db, SCHED, "a1", ["check"]).run.phase).toBe("ready");
  return { db, add, seq, approvalSeq };
}
type W = ReturnType<typeof world>;
const run = (w: W) => getMergeRun(w.db, "a1")!;
const step = (w: W, to: MergeRun["phase"], extra: { receipt?: string; newHead?: string } = {}) =>
  advanceMergeRun(w.db, SCHED, { intentId: "a1", from: run(w).phase, to, rev: run(w).rev, ...extra });
const netHash = (main: string, head: string) => createHash("sha256").update(execFileSync("git", ["-c", "core.quotePath=true", "diff",
  "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--full-index", "--no-renames", "--ignore-submodules=none", "--no-relative",
  "--submodule=short", `${main}...${head}`], { cwd: work })).digest("hex");
const evidence = (kind: string, from: string): CarryEvidence => {
  const { main, merged } = heads[kind]!;
  return { oldHead: from, newHead: merged, mainParent: main, mainHead: main, diffHash: netHash(main, merged) };
};
/** update-branch merged `kind`'s main into the current head through the real carry transaction. */
const carry = (w: W, kind: string, from = reviewed) => {
  const ev = evidence(kind, from);
  step(w, "updating");
  return step(w, "await_ci", { newHead: ev.newHead, receipt: carryReceipt(ev) + carryChainSuffix([{ previousHead: ev.oldHead, head: ev.newHead, mainParent: ev.mainParent }]) });
};
const evs = (w: W) => listEvents(w.db, { project: "p", target: "T1" });
const notes = (w: W) => evs(w).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "mergeContentUi");
const task = (w: W) => getTask(w.db, "T1")!;
const gate = (w: W) => uiMergeRefusal(w.db, task(w), Date.now());
const verdict = (w: W) => { const t = task(w), e = evs(w); return contentUiVerdict(w.db, t, e, projectPmUiGate(w.db, t, e)); };
const refused = (w: W) => { const v = verdict(w); if (v.carry) throw new Error("carried"); return v.reason; };
const snapshot = (w: W) => JSON.stringify(evs(w).filter((e) => e.seq <= w.approvalSeq));

describe("[验收线 1] pure main updates with unchanged render inputs", () => {
  test("on: two pure-main hops carry PM's approval by content; it names the approval seq and digests and rewrites nothing", () => {
    const w = world();
    const before = snapshot(w);
    carry(w, "lib"); carry(w, "lib2", heads.lib!.merged);
    expect(task(w).headSHA).toBe(heads.lib2!.merged);
    expect(gate(w)).toBeNull();
    const v = verdict(w);
    if (!v.carry) throw new Error(v.reason);
    expect(v.source).toBe("git");
    expect(v.evidence.approvalSeq).toBe(w.approvalSeq);
    expect(v.evidence.screenshotsDigest).toBe(DIGEST);
    expect(v.evidence.strength).toBe("full");
    expect(v.evidence.review.approvedHead).toBe(reviewed);
    expect(v.evidence.review.chain.map((h) => h.head)).toEqual([heads.lib!.merged, heads.lib2!.merged]);
    expect(v.evidence.renderId).toBe(renderIdOf(v.evidence.review.contentId, v.evidence.renderInputs!, DIGEST));
    expect(snapshot(w)).toBe(before); // the approval and everything before it untouched
    const ops = evs(w).filter((e) => e.seq > w.approvalSeq).map((e) => String(e.data.op));
    expect(ops.filter((op) => [UI_APPROVED, "ui_carry", "ui_review_carry"].includes(op))).toEqual([]); // no approval written
    expect(task(w).extra.screenshotsDigest).toBe(DIGEST);
  });

  test("observe (also unset): only a note with would-carry and digests, written only in the run's own transaction", () => {
    for (const mode of ["observe", null] as const) {
      const w = world({ mode, uiReviewCarry: "observe" }); // UIR1 observe: its unsent check reads the gate in the run's → unknown step
      expect(mergeContentUiMode("p")).toBe("observe");
      carry(w, "lib"); // a second hop is refused by the driver itself once the gate is shut
      const shut = gate(w);
      expect(shut).toContain("PM 截图验收");
      expect(notes(w)).toEqual([]); // a pure read (planner, ticks, audits) writes nothing
      expect(() => step(w, "await_ci", { receipt: "GitHub 合并状态：UNKNOWN，等待计算" })).toThrow(shut!); // a refused step rolls back, note too
      expect(notes(w)).toEqual([]);
      step(w, "unknown", { receipt: `合并运行已失效：UI 截图验收已失效：${shut}` }); // the driver gives up: this transaction commits
      expect(gate(w)).toBe(shut);
      const n = notes(w);
      expect(n).toHaveLength(1);
      expect(n[0]!.data).toMatchObject({ carried: true, approvalSeq: w.approvalSeq, approvedHead: reviewed, head: heads.lib!.merged, digest: DIGEST, hops: 1 });
      expect(n[0]!.data.renderInputs).toMatch(/^[a-f0-9]{64}$/);
      cleanup.splice(0).reverse().forEach((c) => c());
    }
  });

  test("off: the old chain only, nothing read, nothing recorded", () => {
    const w = world({ mode: "off" });
    setContentUiPort({ git: () => { throw new Error("git must not run under off"); } });
    carry(w, "lib");
    expect(gate(w)).toContain("PM 截图验收");
    expect(notes(w)).toEqual([]);
  });

  test("an existing UIR1 record bound to this approval supplies the digest: no git read", () => {
    const w = world({ uiReviewCarry: "observe" }); // UIR1 observe: its would-carry note holds the render digest, the gate stays shut
    carry(w, "lib");
    setContentUiPort({ git: () => { throw new Error("no git expected"); } });
    const v = verdict(w);
    if (!v.carry) throw new Error(v.reason);
    expect(v.source).toBe("ui_review_carry");
    expect(gate(w)).toBeNull();
  });
});

describe("[验收线 2] anything that changes what is rendered, or the approval's binding, refuses", () => {
  test.each(["css", "bridge", "asset", "lock", "web"])("main changed %s: refused, gate stays shut", (kind) => {
    const w = world();
    carry(w, kind);
    expect(refused(w)).toContain("渲染输入变了");
    expect(gate(w)).toContain("PM 截图验收");
  });

  test("PM's approval revoked (rejected after it): refused", () => {
    const w = world();
    carry(w, "lib");
    expect(gate(w)).toBeNull();
    w.add("agent-pm", "decision", { op: UI_REJECTED, head: heads.lib!.merged, specRev: 1, round: 1, screenshotsDigest: DIGEST, note: "no" });
    expect(refused(w)).toContain("不是 approved");
    expect(gate(w)).not.toBeNull();
  });

  test("round or spec revision changed: refused", () => {
    for (const col of ["round", "specRev"]) {
      const w = world();
      carry(w, "lib");
      w.db.query(`UPDATE tasks SET ${col}=2 WHERE id='T1'`).run();
      expect(refused(w)).toContain("本轮 / 本规格");
      expect(gate(w)).not.toBeNull();
      cleanup.splice(0).reverse().forEach((c) => c());
    }
  });

  test("a delivery after the approval breaks the chain", () => {
    const w = world();
    carry(w, "lib");
    w.add("agent-author", "deliver", { head: heads.lib!.merged });
    expect(refused(w)).toContain("交付");
  });

  test("ownerVisual: the owner's own head and expiry only — a content match opens nothing", () => {
    const w = world({ ownerVisual: true });
    // a hand-written scheduler carry from PM's head (render inputs unchanged): the owner path still rules
    w.add("scheduler", "scheduler", { op: "review_carry", intentId: "x", from: reviewed, to: heads.lib!.merged, round: 1, specRev: 1,
      mainParent: heads.lib!.main, mainHead: heads.lib!.main, diffHash: netHash(heads.lib!.main, heads.lib!.merged) });
    w.add("scheduler", "scheduler", { op: "merge_phase", intentId: "x", from: "updating", to: "await_ci", carrySeq: w.seq() - 1 });
    w.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(heads.lib!.merged);
    expect(gate(w)).toContain("owner");
  });
});

describe("[验收线 3] UICAR3 scope carries stay scope carries", () => {
  test("main touched web/ outside the card's files: UICAR3 carries, the content verdict refuses, no switch revokes UICAR3", () => {
    const w = world({ uiCarryOwnGlobs: "on", mode: "on" });
    carry(w, "web");
    expect(evs(w).some((e) => e.data.op === "ui_carry" && e.data.mechanism === "uiCarryOwnGlobs")).toBe(true);
    expect(refused(w)).toContain("渲染输入变了"); // never claims renderInputs equal for a scope carry
    for (const mode of ["on", "observe", "off"] as const) {
      policy({ uiCarryOwnGlobs: "on", mode });
      expect(gate(w)).toBeNull();
    }
    expect(notes(w)).toEqual([]); // the older layer carried: nothing to map, nothing observed
  });

  test("switching modes never revokes a content carry already followed by UIR1 on the next hop", () => {
    const w = world({ mode: "on" });
    carry(w, "lib");
    policy({ mode: "on", uiReviewCarry: "on" });
    carry(w, "lib2", heads.lib!.merged); // UIR1 judges this hop with heldFrom read through the content mapping
    expect(evs(w).filter((e) => e.data.op === "ui_review_carry").map((e) => e.data.from)).toEqual([heads.lib!.merged]);
    expect(gate(w)).toBeNull();
  });
});

describe("[验收线 4] every gate reader sees the same approval facts", () => {
  test("uiMergeRefusal, the driver's drift recheck and its pre-send recheck agree, under on and observe", () => {
    const w = world();
    carry(w, "lib");
    const uiLine = (d: string | null) => (d ?? "").includes("截图验收");
    expect(gate(w)).toBeNull();
    expect(uiLine(mergeRunDrift(w.db, run(w), Date.now()))).toBe(false);
    expect(uiLine(mergeRunDrift(w.db, { ...run(w), beforeSend: true }, Date.now()))).toBe(false);
    policy({ mode: "observe" });
    expect(gate(w)).not.toBeNull();
    expect(uiLine(mergeRunDrift(w.db, run(w), Date.now()))).toBe(true);
    expect(uiLine(mergeRunDrift(w.db, { ...run(w), beforeSend: true }, Date.now()))).toBe(true);
  });

  test("PM re-approval on the new head and a later revoke are read as they are, not overwritten by the content mapping", () => {
    const w = world();
    carry(w, "lib"); carry(w, "lib2", heads.lib!.merged);
    w.add("agent-pm", "decision", { op: UI_APPROVED, head: heads.lib2!.merged, specRev: 1, round: 1, screenshotsDigest: DIGEST });
    expect(gate(w)).toBeNull();
    expect(refused(w)).toContain("就是批准 head"); // the head's own approval: nothing for the mapping to add
    w.add("agent-pm", "decision", { op: UI_REJECTED, head: heads.lib2!.merged, specRev: 1, round: 1, screenshotsDigest: DIGEST });
    expect(gate(w)).not.toBeNull();
    expect(() => carry(w, "lib3", heads.lib2!.merged)).toThrow("截图验收"); // nor does a further carry resurrect it
  });

  test("a hand-written review_carry without the scheduler's paired merge_phase is not a trusted hop", () => {
    const w = world();
    w.add("scheduler", "scheduler", { op: "review_carry", intentId: "a1", from: reviewed, to: heads.lib!.merged, round: 1, specRev: 1,
      mainParent: heads.lib!.main, mainHead: heads.lib!.main, diffHash: netHash(heads.lib!.main, heads.lib!.merged) });
    w.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(heads.lib!.merged);
    expect(refused(w)).toContain("merge_phase");
  });
});

describe("switch", () => {
  test("RECOVERY_KEYS has mergeContentUi exactly once", () => {
    expect(RECOVERY_KEYS.filter((k) => k === "mergeContentUi")).toHaveLength(1);
  });
  test("explicit key only: unset observe, project mode does not act for it, unreadable file off", () => {
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { mode: "on" } } }));
    cleanup.push(() => rmSync(RECOVERY_POLICY_PATH, { force: true }));
    expect(mergeContentUiMode("p")).toBe("observe");
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { mergeContentUi: "on" } } } }));
    expect(mergeContentUiMode("p")).toBe("on");
    writeFileSync(RECOVERY_POLICY_PATH, "{bad");
    expect(mergeContentUiMode("p")).toBe("off");
  });
});
