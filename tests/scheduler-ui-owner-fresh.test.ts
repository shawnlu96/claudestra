/**
 * UIOWNCARRY2 · before the owner screenshot ask of an ownerVisual card the scheduler brings the PR up to main ("only chase main"):
 * a `merge` intent at node ui_owner_fresh, begun in review by beginMergeRun, driven by the merge driver's own update-branch + review_carry,
 * ended before any merge claim; then UIOWNCARRY1's render inputs decide ask on the new head vs PM re-shoot. Switch `uiOwnerAskFresh`.
 * Real git fixture, temp ledger, the file-backed policy reader, the real planner / plan write / merge journal / merge driver.
 * No network, no production state.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getMeta, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { openSchedulerUiAsk } from "../src/lib/scheduler-apply.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { advanceMergeRun, beginMergeRun, carryReceipt, getMergeRun, mergeRunDrift, type CarryEvidence, type MergeRun } from "../src/lib/scheduler-merge.js";
import { planScheduler, type PlannerDecision } from "../src/lib/scheduler-plan.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { cachedMainContains, type MainContains } from "../src/lib/scheduler-ui-owner-fresh.js";
import { kickRemoteMain, readRemoteMain, refreshRemoteMain, REMOTE_REFRESH_MS } from "../src/lib/scheduler-ui-owner-fresh-remote.js";
import { OWNER_FRESH_DONE, OWNER_FRESH_NODE, ownerFreshStep, uiOwnerAskFreshMode } from "../src/lib/scheduler-ui-owner-fresh.js";

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

/** base → feature `reviewed` (the UI change); per kind a main commit on base merged into it (lib: no render input, web: web/). */
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "uiownfresh-")); work = join(root, "repo"); mkdirSync(work);
  await sh("init", "-q", "-b", "main");
  for (const f of ["README.md", "web/app.tsx", "src/lib/other.ts", "package.json"]) await commit(f, "base\n");
  base = await sh("rev-parse", "HEAD");
  await sh("checkout", "-qb", "feature"); reviewed = await commit("web/app.tsx", "ui change\n");
  for (const [kind, file] of [["lib", "src/lib/other.ts"], ["web", "web/features/x.tsx"]] as const) {
    await sh("checkout", "-q", "-B", `main-${kind}`, base);
    const main = await commit(file, `main ${kind}\n`);
    await sh("checkout", "-q", "-B", `h-${kind}`, reviewed); await sh("merge", "-q", "--no-edit", main);
    heads[kind] = { main, merged: await sh("rev-parse", "HEAD") };
  }
}, 120_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
const cleanup: (() => void)[] = [];
afterEach(() => { for (const c of cleanup.splice(0).reverse()) c(); });

type Mode = "on" | "observe" | "off";
const policy = (mode: Mode | null) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { ...(mode ? { uiOwnerAskFresh: mode } : {}) } } } }));

/** ownerVisual UI card T1 (auto) in review at `reviewed` (screenshots registered there), cross-family PASS, no owner ask yet. */
function world(o: { mode?: Mode | null; ownerVisual?: boolean; verdict?: "pass" | "changes" } = {}) {
  const ownerVisual = o.ownerVisual ?? true;
  policy(o.mode === undefined ? "on" : o.mode);
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: work } } }));
  const dir = mkdtempSync(join(root, "ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); rmSync(RECOVERY_POLICY_PATH, { force: true }); rmSync(SCHEDULER_CONFIG_PATH, { force: true }); });
  const add = (actor: string, kind: string, data: unknown) => db.prepare(
    "INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (10,?,'p','T1',?,'',?)").run(actor, kind, JSON.stringify(data));
  setMeta(db, OWNER, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, OWNER, { project: "p", id: "T1", title: "ui", kind: "code", agent: "agent-author" });
  setWorkflow(db, OWNER, { taskId: "T1", taskRev: 1, template: "ui", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "manual" });
  const shots = [join(dir, "before.png"), join(dir, "after.png")];
  for (const s of shots) writeFileSync(s, "png");
  const extra = { screenshotsDigest: DIGEST, screenshots: shots, fileGlobs: [], ...(ownerVisual ? { ownerVisual: true } : {}) };
  db.query("UPDATE tasks SET stage='review', round=1, headSHA=?, pr=?, branch='task/T1', extra=? WHERE id='T1'").run(reviewed, PR, JSON.stringify(extra));
  if (ownerVisual) add("owner", "task", { op: "set", patch: { extra } });
  add("agent-author", "deliver", { head: reviewed, uiEvidence: { digest: DIGEST, head: reviewed } });
  add("owner", "stage", { from: "build", to: "review", round: 1 });
  planIntent(db, SCHED, { id: "rv", taskId: "T1", taskRev: rev(db), workflowRev: wf(db), causalSeq: seq(db), node: "adversarial_review",
    action: "review", reason: "review", recipient: "agent-review" });
  settleIntent(db, SCHED, { id: "rv", from: "pending", to: "submitted", receipt: "ack" });
  const p1 = o.verdict === "changes";
  add("agent-review", "review", { round: 1, head: reviewed, verdict: o.verdict ?? "pass", reviewer: "agent-review", reviewerSessionId: "rs",
    reviewerFamily: "codex", path: "report.md", findings: p1 ? [{ findingId: "F1", family: "x", severity: "P1", probe: "p" }] : [], p0: 0, p1: p1 ? 1 : 0, p2: 0 });
  settleIntent(db, SCHED, { id: "rv", from: "submitted", to: "done", receipt: "review event recorded" });
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T1','reviewer','agent-review','rs','codex','acp','active','rv',10,10)`).run();
  return { db, add };
}
type W = ReturnType<typeof world>;
type DB = W["db"];
const wf = (db: DB) => (db.query("SELECT rev FROM task_workflows WHERE taskId='T1'").get() as { rev: number }).rev;
const rev = (db: DB) => getTask(db, "T1")!.rev;
const seq = (db: DB) => (db.query("SELECT MAX(seq) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
const task = (w: W) => getTask(w.db, "T1")!;
const evs = (w: W) => listEvents(w.db, { project: "p", target: "T1" });
const behind: MainContains = () => ({ contains: false, mainHead: heads.lib!.main });
const fresh: MainContains = () => ({ contains: true, mainHead: heads.lib!.main });
const opts = (contains: MainContains) => ({ registry: [], maxWorkers: 2, mainContains: contains });
const plan = (w: W, contains: MainContains = behind): PlannerDecision => planScheduler(autoSnapshot(w.db, task(w), opts(contains)));
type Planned = Extract<PlannerDecision, { kind: "intent" }>;
/** Write the planned intent through the real plan write (the scheduler's `ledger scheduler-plan`). */
const write = (w: W, p: Planned) => planIntent(w.db, SCHED, { id: p.id, taskId: "T1", taskRev: rev(w.db), workflowRev: wf(w.db), causalSeq: seq(w.db),
  node: p.node, action: p.action, reason: p.reason, resources: p.resources });
/** A planned fresh intent, written, claimed by the merge tick and begun (the merge tick's scheduler-merge-begin). */
function begin(w: W): MergeRun {
  const p = plan(w) as Planned;
  expect([p.kind, p.action, p.node]).toEqual(["intent", "merge", OWNER_FRESH_NODE]);
  write(w, p);
  settleIntent(w.db, SCHED, { id: p.id, from: "pending", to: "submitted", receipt: "merge controller claimed" });
  return beginMergeRun(w.db, SCHED, p.id, ["check"]).run;
}
const run = (w: W, id: string) => getMergeRun(w.db, id)!;
const step = (w: W, id: string, to: MergeRun["phase"], extra: { receipt?: string; newHead?: string } = {}) =>
  advanceMergeRun(w.db, SCHED, { intentId: id, from: run(w, id).phase, to, rev: run(w, id).rev, ...extra });
const netHash = (main: string, head: string) => createHash("sha256").update(execFileSync("git", ["-c", "core.quotePath=true", "diff",
  "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--full-index", "--no-renames", "--ignore-submodules=none", "--no-relative",
  "--submodule=short", `${main}...${head}`], { cwd: work })).digest("hex");
const evidence = (kind: string): CarryEvidence => {
  const { main, merged } = heads[kind]!;
  return { oldHead: reviewed, newHead: merged, mainParent: main, mainHead: main, diffHash: netHash(main, merged) };
};
/** The driver's update-branch: → updating → await_ci with the carry receipt (the merge path's own review_carry + merge_phase). */
const chase = (w: W, id: string, kind: string) => {
  const ev = evidence(kind);
  step(w, id, "updating");
  return step(w, id, "await_ci", { newHead: ev.newHead, receipt: carryReceipt(ev) + carryChainSuffix([{ previousHead: ev.oldHead, head: ev.newHead, mainParent: ev.mainParent }]) });
};
const pr = (head: string, o: Partial<PrSnapshot> = {}): PrSnapshot => ({ state: "OPEN", head, branch: "task/T1", crossRepository: false, base: "main",
  draft: false, mergeState: "CLEAN", mergeSha: null, checks: [{ name: "check", bucket: "pass" }], ...o });
/** A fake GitHub that records every merge call; up to date with main. */
const github = (head: () => string) => {
  const merges: string[] = [];
  const external: MergeExternal = {
    inspect: async () => pr(head()), freshness: async () => ({ behindBy: 0, mainHead: heads.lib!.main }),
    carryReview: async () => ({ ok: false, reason: "unused" }), updateBranch: async () => {},
    merge: async (p, h) => { merges.push(`${p}@${h}`); return "f".repeat(40); },
  };
  return { external, merges };
};
const advance = (w: W, id: string) => async (from: MergeRun["phase"], to: MergeRun["phase"], r: number, receipt?: string, mergeSha?: string, newHead?: string) =>
  advanceMergeRun(w.db, SCHED, { intentId: id, from, to, rev: r, receipt, mergeSha, newHead });
const record = (w: W) => evs(w).findLast((e) => e.data.op === "ui_owner_fresh");
const observed = (w: W) => evs(w).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "uiOwnerAskFresh");
const frozen = (w: W) => getMeta(w.db, "p").queueFrozen.frozen;

describe("[验收线 1] owner ask on a head behind main, render inputs unchanged", () => {
  test("on: chase main first (merge driver's update-branch + review_carry), then the ask binds the new head with the card's digest", async () => {
    const w = world();
    const r = begin(w);
    expect([r.phase, task(w).stage]).toEqual(["ready", "review"]);
    chase(w, r.intentId, "lib");
    expect(task(w).headSHA).toBe(heads.lib!.merged);
    const { external, merges } = github(() => heads.lib!.merged);
    const end = await driveMerge(run(w, r.intentId), external, advance(w, r.intentId), () => {}, (m) => mergeRunDrift(w.db, m));
    expect([end.phase, merges, task(w).stage, frozen(w)]).toEqual(["resolved", [], "review", false]);
    expect(record(w)).toMatchObject({ actor: "scheduler", data: { from: reviewed, to: heads.lib!.merged, shot: reviewed, renderSame: true } });
    const ask = plan(w, fresh) as Planned;
    expect([ask.action, ask.askBind]).toEqual(["ask", { task: "T1", specRev: 1, head: heads.lib!.merged, screenshotsDigest: DIGEST }]);
  });

  for (const mode of ["observe", "off", null] as const) {
    test(`${mode ?? "no entry (= observe)"}: as before — the ask goes out on the old head${mode !== "off" ? ", plus one observation" : ""}`, () => {
      const w = world({ mode });
      const p = plan(w) as Planned;
      expect([p.action, p.askBind?.head]).toEqual(["ask", reviewed]);
      write(w, p);
      const { ask } = openSchedulerUiAsk(w.db, SCHED, { intentId: p.id }, opts(behind));
      expect(ask.state).toBe("open");
      expect(observed(w).map((e) => e.data)).toEqual(mode === "off" ? [] : [expect.objectContaining({ task: "T1", head: reviewed,
        mainHead: heads.lib!.main, plan: "先追 main" })]);
    });
  }
  test("observe on a head that already contains main records nothing", () => {
    const w = world({ mode: "observe" });
    const p = plan(w, fresh) as Planned;
    write(w, p);
    openSchedulerUiAsk(w.db, SCHED, { intentId: p.id }, opts(fresh));
    expect(observed(w)).toEqual([]);
  });
  test("no entry reads as observe; an unreadable policy as off", () => {
    policy(null);
    expect(uiOwnerAskFreshMode("p")).toBe("observe");
    writeFileSync(RECOVERY_POLICY_PATH, "{");
    expect(uiOwnerAskFreshMode("p")).toBe("off");
    rmSync(RECOVERY_POLICY_PATH, { force: true });
  });
});

describe("[验收线 1] round 1: mergeDirect never skips the chase; the default fact reads the remote's current main", () => {
  test("mergeDirect on, PR BEHIND with green CI: the chase still sends update-branch", async () => {
    const w = world();
    const r = begin(w);
    const updates: string[] = [];
    const { external, merges } = github(() => reviewed);
    const direct: MergeExternal = { ...external, direct: () => true, inspect: async () => pr(reviewed, { mergeState: "BEHIND" }),
      freshness: async () => ({ behindBy: 1, mainHead: heads.lib!.main }), updateBranch: async (p) => { updates.push(p); } };
    const end = await driveMerge(run(w, r.intentId), direct, advance(w, r.intentId));
    expect([updates, merges, end.phase, task(w).stage]).toEqual([[PR], [], "updating", "review"]);
  });
  test("production default: origin/main fetched before main moved still reads behind (remote read), never the stale local ref", async () => {
    const w = world();
    const bare = join(root, `origin-${Date.now()}.git`), clone = join(root, `clone-${Date.now()}`);
    await sh("init", "-q", "--bare", bare);
    await sh("push", "-q", bare, `${base}:refs/heads/main`, `${reviewed}:refs/heads/feature`);
    await sh("clone", "-q", bare, clone);
    await sh("push", "-q", bare, `${heads.lib!.main}:refs/heads/main`); // main moves after the clone fetched: origin/main is stale
    expect(execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: clone, encoding: "utf8" }).trim()).toBe(base);
    writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: clone } } }));
    const kicks: string[] = [];
    const contains = cachedMainContains({ spawner: (repo) => { kicks.push(repo); } });
    const snap = () => planScheduler(autoSnapshot(w.db, task(w), opts(contains)));
    expect([snap(), kicks]).toMatchObject([{ kind: "intent", action: "ask" }, [clone]]); // never read: unknown, one background kick
    refreshRemoteMain(clone); // what the kicked child runs: ls-remote + fetch the missing main
    const d = snap();
    expect(d).toMatchObject({ kind: "intent", action: "merge", node: OWNER_FRESH_NODE });
    expect((d as Planned).reason).toContain(heads.lib!.main.slice(0, 12));
    expect(readRemoteMain(clone)?.head).toBe(heads.lib!.main);
  });
});

describe("[回归] round 2: no network under the ledger write lock", () => {
  /** A clone whose origin answers ls-remote only after 6 s and then fails (slow network / rate limit). */
  const slowRepo = async () => {
    const bare = join(root, `slow-${Date.now()}.git`), clone = join(root, `slowclone-${Date.now()}`);
    await sh("init", "-q", "--bare", bare);
    await sh("push", "-q", bare, `${base}:refs/heads/main`);
    await sh("clone", "-q", bare, clone);
    execFileSync("git", ["config", "remote.origin.uploadpack", "sleep 6; false"], { cwd: clone });
    writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: clone } } }));
    return clone;
  };
  test("default fact, cold cache: openSchedulerUiAsk opens the ask at once and another process writes the ledger meanwhile", async () => {
    const w = world();
    const clone = await slowRepo();
    const p = planScheduler(autoSnapshot(w.db, task(w), { registry: [], maxWorkers: 2 })) as Planned;
    expect(p).toMatchObject({ kind: "intent", action: "ask", askBind: { head: reviewed } }); // unknown: as before
    write(w, p);
    const t0 = Date.now();
    const { ask } = openSchedulerUiAsk(w.db, SCHED, { intentId: p.id }, { registry: [], maxWorkers: 2 });
    expect(Date.now() - t0).toBeLessThan(3_000); // the ls-remote alone would hold the write lock 6 s
    expect(ask.bind?.params).toMatchObject({ head: reviewed });
    expect(readRemoteMain(clone)).toBeNull(); // the detached child is still waiting on the remote; nobody waited for it
  }, 20_000);
  test("a write from another process during the snapshot is never locked out", async () => {
    const w = world();
    await slowRepo();
    const path = (w.db as unknown as { filename: string }).filename;
    w.db.exec("BEGIN IMMEDIATE");
    const child = Bun.spawn([process.execPath, "-e", `const { Database } = require("bun:sqlite"); const d = new Database(${JSON.stringify(path)});
      d.exec("PRAGMA busy_timeout = 5000"); try { d.exec("INSERT INTO meta (project,key,value) VALUES ('q','x','1')"); console.log("written"); }
      catch (e) { console.log(String(e).includes("locked") ? "locked" : String(e)); }`], { stdout: "pipe" });
    autoSnapshot(w.db, task(w), { registry: [], maxWorkers: 2 }); // inside the write lock, as replanned() is
    w.db.exec("COMMIT");
    expect((await new Response(child.stdout).text()).trim()).toBe("written");
  }, 20_000);
  test("the background refresh records a failed remote read as unknown, and kicks at most once per refresh window", () => {
    const repo = join(root, "nowhere"), kicks: number[] = [];
    for (const at of [1_000, 2_000, 1_000 + REMOTE_REFRESH_MS]) kickRemoteMain(repo, [], at, () => { kicks.push(at); });
    expect(kicks).toEqual([1_000, 1_000 + REMOTE_REFRESH_MS]);
    mkdirSync(repo, { recursive: true });
    refreshRemoteMain(repo, [], () => 5);
    expect(readRemoteMain(repo)).toEqual({ at: 5, head: null });
  });
});

describe("[验收线 2] main's part changed web/: no ask, back to PM to re-shoot", () => {
  test("on: the record says render inputs changed; the plan escalates with the re-shoot reason", () => {
    const w = world();
    const r = begin(w);
    chase(w, r.intentId, "web");
    step(w, r.intentId, "resolved", { receipt: OWNER_FRESH_DONE });
    expect(record(w)?.data).toMatchObject({ to: heads.web!.merged, renderSame: false });
    const d = plan(w, fresh);
    expect(d).toMatchObject({ kind: "escalate", code: "ui_owner_reshoot" });
    expect((d as { reason: string }).reason).toMatch(/要在新 head 重拍/);
  });
  test("render inputs that cannot be read are a re-shoot too, never an ask", () => {
    const w = world();
    const r = begin(w);
    chase(w, r.intentId, "lib");
    writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: join(root, "gone") } } }));
    step(w, r.intentId, "resolved", { receipt: OWNER_FRESH_DONE });
    expect(record(w)?.data.renderSame).toBe(false);
    expect(plan(w, fresh)).toMatchObject({ kind: "escalate", code: "ui_owner_reshoot" });
  });
});

describe("[回归] a re-shoot on the new head voids the earlier re-shoot record", () => {
  const reshot = (w: W, digest: string) => {
    const r = begin(w);
    chase(w, r.intentId, "web");
    step(w, r.intentId, "resolved", { receipt: OWNER_FRESH_DONE });
    expect(plan(w, fresh)).toMatchObject({ kind: "escalate", code: "ui_owner_reshoot" });
    const extra = { ...task(w).extra, screenshotsDigest: digest };
    w.db.query("UPDATE tasks SET extra=? WHERE id='T1'").run(JSON.stringify(extra));
    w.add("agent-author", "deliver", { head: heads.web!.merged, uiEvidence: { digest, head: heads.web!.merged } });
  };
  const make = () => ({ kind: "wait", code: "in_flight", reason: "x" }) as PlannerDecision;
  for (const [name, digest] of [["new digest", "e".repeat(64)], ["same digest re-delivered", DIGEST]] as const) {
    test(`${name}: the gate lets the ask through`, () => {
      const w = world();
      reshot(w, digest);
      expect(ownerFreshStep(autoSnapshot(w.db, task(w), opts(fresh)), make)).toBeNull();
    });
  }
  test("a digest changed without a delivery no longer matches the record either", () => {
    const w = world();
    const r = begin(w);
    chase(w, r.intentId, "web");
    step(w, r.intentId, "resolved", { receipt: OWNER_FRESH_DONE });
    w.db.query("UPDATE tasks SET extra=? WHERE id='T1'").run(JSON.stringify({ ...task(w).extra, screenshotsDigest: "e".repeat(64) }));
    expect(ownerFreshStep(autoSnapshot(w.db, task(w), opts(fresh)), make)).toBeNull();
  });
});

describe("[验收线 3] scheduler-review.ts trusts the chase's carry through the one review_carry rule", () => {
  test("the chase's review_carry carries the PASS to the new head", () => {
    const w = world();
    const r = begin(w);
    chase(w, r.intentId, "lib");
    const c = evs(w).find((e) => e.data.op === "review_carry")!;
    expect(evs(w).find((e) => e.seq === c.seq + 1)?.data).toMatchObject({ op: "merge_phase", to: "await_ci", carrySeq: c.seq, intentId: r.intentId });
    expect(currentReviewFacts(task(w), evs(w)).kind).toBe("facts");
  });
  const forged: [string, (w: W, id: string) => void][] = [
    ["no merge_phase right after it", (w, id) => w.add("scheduler", "scheduler", { op: "review_carry", intentId: id, from: reviewed,
      to: heads.lib!.merged, round: 1, specRev: 1 })],
    ["fields missing (no round / specRev)", (w, id) => {
      w.add("scheduler", "scheduler", { op: "review_carry", intentId: id, from: reviewed, to: heads.lib!.merged });
      w.add("scheduler", "scheduler", { op: "merge_phase", intentId: id, to: "await_ci", carrySeq: seq(w.db) });
    }],
  ];
  for (const [name, forge] of forged) {
    test(`a forged carry — ${name} — is not trusted`, () => {
      const w = world();
      const r = begin(w);
      forge(w, r.intentId);
      w.db.query("UPDATE tasks SET headSHA=? WHERE id='T1'").run(heads.lib!.merged);
      expect(currentReviewFacts(task(w), evs(w))).toEqual({ kind: "invalid", reason: "审查结论的完整 head 与任务不一致" });
    });
  }
});

describe("[验收线 4] the chase never merges, holds no merge slot and leaves the card in review", () => {
  test("no merge slot, a slot turn is ignored, the run ends in review with the intent done", async () => {
    const w = world();
    const r = begin(w);
    expect(w.db.query("SELECT resource FROM scheduler_resources WHERE resource LIKE 'merge:%'").all()).toEqual([]);
    chase(w, r.intentId, "lib");
    const { external, merges } = github(() => heads.lib!.merged);
    await driveMerge(run(w, r.intentId), external, advance(w, r.intentId));
    expect([merges, task(w).stage, run(w, r.intentId).phase, frozen(w)]).toEqual([[], "review", "resolved", false]);
    expect(w.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(r.intentId)).toEqual({ status: "done" });
    expect(w.db.query("SELECT 1 FROM scheduler_resources WHERE intentId = ?").all(r.intentId)).toEqual([]);
  });
  test("a conflict sends the card review → fix with the bounce, never merged", () => {
    const w = world();
    const r = begin(w);
    step(w, r.intentId, "resolved", { receipt: `退回 fix（conflict）：PR head ${reviewed}，main head ${heads.lib!.main}` });
    expect([task(w).stage, run(w, r.intentId).phase]).toEqual(["fix", "resolved"]);
    expect(evs(w).findLast((e) => e.kind === "stage")?.data).toMatchObject({ from: "review", to: "fix", mergeBounce: { cause: "conflict" } });
  });
});

describe("[验收线 5] main freshness unknown, or the queue frozen: the ask goes out as before, nothing blocks", () => {
  const unknowns: [string, MainContains][] = [["unknown", () => ({ contains: null, mainHead: null })], ["throws", () => { throw new Error("rate limited"); }]];
  for (const [name, contains] of unknowns) {
    test(`on · ${name}`, () => {
      const w = world();
      expect(plan(w, contains)).toMatchObject({ kind: "intent", action: "ask", askBind: { head: reviewed } });
    });
  }
  test("on · local git in the configured repo without an origin/main is unknown", () => {
    const w = world();
    expect(planScheduler(autoSnapshot(w.db, task(w), { registry: [], maxWorkers: 2 }))).toMatchObject({ action: "ask" });
  });
  test("on · frozen queue", () => {
    const w = world();
    w.db.query("INSERT INTO meta (project,key,value) VALUES ('p','queueFrozen',?)").run(JSON.stringify({ frozen: true, reason: "x", since: 1 }));
    expect(plan(w)).toMatchObject({ kind: "intent", action: "ask" });
  });
});

describe("[验收线 6] non-ownerVisual cards (PM screenshot acceptance) never chase", () => {
  test("on, behind main: the PM notice as before, no fact on the snapshot", () => {
    const w = world({ ownerVisual: false });
    const s = autoSnapshot(w.db, task(w), opts(behind)) as { ownerFresh?: unknown };
    expect(s.ownerFresh).toBeUndefined();
    expect(planScheduler(s as never)).toMatchObject({ kind: "intent", action: "ask", pmNotice: { head: reviewed } });
  });
});

describe("[验收线 7] the plan write and the merge claim each refuse on their own", () => {
  const p = (node: string): Planned => ({ kind: "intent", id: `t68:s1:r1:${node}:a0`, node, action: "merge", reason: "x", resources: [],
    recipient: null, observedOnly: false });
  test("a review-stage merge intent at another node is refused", () => {
    const w = world();
    expect(() => write(w, p("merge_deploy"))).toThrow(/merge 意图只许在 merge_deploy 节点/);
  });
  const missing: [string, (o: Parameters<typeof world>[0]) => W, RegExp][] = [
    ["not in review", (o) => { const w = world(o); w.db.query("UPDATE tasks SET stage='fix' WHERE id='T1'").run(); return w; }, /只在 review 阶段/],
    ["not ownerVisual", (o) => world({ ...o, ownerVisual: false }), /ownerVisual/],
    ["switch observe", (o) => world({ ...o, mode: "observe" }), /不是 on/],
    ["switch off", (o) => world({ ...o, mode: "off" }), /不是 on/],
    ["no passing review on the head", (o) => world({ ...o, verdict: "changes" }), /合并前缺本轮同 head 的通过审查/],
  ];
  for (const [name, make, why] of missing) {
    test(`ui_owner_fresh · ${name}: refused`, () => {
      const w = make({});
      expect(() => write(w, p(OWNER_FRESH_NODE))).toThrow(why);
    });
  }
  test("the merge claim refuses a ui_owner_fresh run even when the driver's stop is bypassed: no merge sent, no freeze", async () => {
    const w = world();
    const r = begin(w);
    expect(() => step(w, r.intentId, "await_ci", { receipt: "head 未变，等待 CI" })).not.toThrow();
    expect(() => step(w, r.intentId, "merging", { receipt: "CI 全绿：check" })).toThrow(/只有 merge 阶段 merge_deploy 节点的运行能合并/);
    const { external, merges } = github(() => reviewed);
    // the driver sees another intent id, so its own stop (ownerFreshEnd) does not fire; the journal writes go to the real run
    const end = await driveMerge({ ...run(w, r.intentId), intentId: "bypass" }, external, advance(w, r.intentId));
    expect([merges, end.phase, task(w).stage, frozen(w)]).toEqual([[], "resolved", "review", false]);
    expect(evs(w).findLast((e) => e.data.op === "merge_phase")?.data).toMatchObject({ outcome: "fresh_failed" });
  });
});
