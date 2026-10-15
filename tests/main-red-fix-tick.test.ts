/**
 * agents-MAINRED1 end to end: the tick with a fake gh, a synthetic ledger, a temp docs dir and a fake clock; every write goes through
 * `ledger scheduler-main-red-fix` exactly as the scheduler's env.ledger sends it. Pure parts: tests/main-red-fix.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addKnownFlaky } from "../src/lib/ci-known-flaky.js";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { effectiveNodes, getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { MainRedRun } from "../src/lib/main-red-fix.js";
import { MAIN_RED_FIX_SERVICE, setMainRedFixCliForTest } from "../src/lib/main-red-fix-cmds.js";
import type { MainRedGh } from "../src/lib/main-red-fix-gh.js";
import { mainRedFixTick, setMainRedFixTickForTest } from "../src/lib/main-red-fix-tick.js";
import type { RecoveryKey, RecoveryMode } from "../src/lib/recovery-policy.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { SchedulerLeaseLost } from "../src/lib/scheduler-lease-env.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import type { MainCiHealth } from "../src/lib/scheduler-main-ci.js";
import { mainCiApprovals } from "../src/lib/scheduler-main-ci-wiring-store.js";
import { specPathIn } from "../src/lib/scheduler-autostart-deps.js";
import { lintObservation } from "../src/lib/spec-lint-observation.js";
import type { SpecWaitEnv } from "../src/lib/scheduler-spec-wait.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";

const P = "p", REPO = "o/r", CHECK = "typecheck + test + guard", MIN = 60_000;
const owner = { actor: "owner", now: 100 };
const sha = (c: string) => c.repeat(40);
let db: Database, dir: string, now: number, agentsF: string, mergeF: string, modes: Partial<Record<RecoveryKey, RecoveryMode>>;
let notices: string[], gh: Fake, health: MainCiHealth | null;

interface Fake extends MainRedGh { state: { runs: Record<string, MainRedRun[]>; log: string; pulls: Record<string, number[]>; reruns: number[]; calls: number } }
function fakeGh(): Fake {
  const state = { runs: {} as Record<string, MainRedRun[]>, log: "", pulls: {} as Record<string, number[]>, reruns: [] as number[], calls: 0 };
  const hit = <T>(v: T) => { state.calls++; return Promise.resolve(v); };
  return { state, runs: (_r, file) => hit(state.runs[file] ?? []), failedJobs: () => hit([CHECK]), failedLog: () => hit(state.log),
    commitPulls: (_r, s) => hit(state.pulls[s] ?? []), rerunFailed: async (_r, id) => { state.calls++; state.reruns.push(id); } };
}
const run = (id: number, conclusion: string | null, attempt = 1, head = sha("b"), status = "completed"): MainRedRun =>
  ({ id, attempt, status, conclusion, headSha: head, url: `https://github.com/${REPO}/actions/runs/${id}`, createdAt: id * 1000 });
const step = (lines: string[]) => lines.map((l) => `test shard 2 of 4\tUnit tests\t2026-10-12T09:00:00.1234567Z ${l}`);
const redLog = (...files: string[]) => step([...files.flatMap((f) => [`##[group]${f}:`, "error: expect(received).toBe(expected)", "(fail) race > case [0.40ms]",
  "##[endgroup]"]), " 1999 pass", ` ${files.length} fail`, "##[error]Process completed with exit code 1."]).join("\n");
const redHealth = (s = sha("b")): MainCiHealth => ({ target: { project: P, repo: REPO, requiredChecks: [CHECK] }, mainSha: s, observedAt: now, state: "red",
  reasons: [{ code: "unsuccessful_check", check: CHECK, conclusion: "failure" }], checks: [] });

function deps(actor: string, assertLease?: () => void): LedgerDeps {
  return { db, actor, now: () => now, projectIds: [P], assertLease, autoDispatch: () => true, autoProjects: () => [P],
    loadRegistry: async () => ({ socket: "s", agents: {} }), saveRegistry: async () => {} };
}
const env = (): SpecWaitEnv => ({ db, now: () => now, readSpec: () => null, svc: { autoDispatch: true, projects: [P], maxWorkers: () => 1 },
  ledger: (...args: string[]) => runLedger(args.slice(1), deps("scheduler", () => {})) as Promise<Record<string, unknown>>,
  notifyPm: async (_p, text) => { notices.push(text); } });
const tick = async () => { now += 11 * MIN; return mainRedFixTick(env()); };
const ops = (op: string) => listEvents(db, { project: P }).filter((e) => e.data.op === op);
const nodesOf = (f: string) => { const x = getFeature(db, f)!; return effectiveNodes(db, getDagVersion(db, x.id, x.currentVersion)!); };
const specPath = (taskId: string) => join(dir, "ledger", "docs", "tasks", `${taskId}.md`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "main-red-fix-")); db = openLedger(join(dir, "ledger.sqlite")); now = 1_000_000;
  modes = { mainRedFix: "on", mainRedRepairBind: "observe" }; notices = []; gh = fakeGh(); health = redHealth();
  setMeta(db, owner, { project: P, key: "pms", value: ["agent-pm"] });
  agentsF = createFeature(db, owner, { project: P, slug: "agents", title: "agents" }).row.id;
  initDag(db, owner, { id: agentsF, rev: 1, nodes: [{ key: "OBSAUTO1", oneLine: "obs", fileGlobs: ["src/lib/obs.ts", "tests/a*.test.ts"] }, { key: "OTHER1", oneLine: "o" }] });
  createTask(db, owner, { project: P, id: "agents-OBSAUTO1", title: "obs", kind: "code", pr: `https://github.com/${REPO}/pull/12` });
  bindNode(db, owner, { id: agentsF, rev: getFeature(db, agentsF)!.rev, key: "OBSAUTO1", taskId: "agents-OBSAUTO1" });
  db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'agents-OBSAUTO1'").run();
  mergeF = createFeature(db, owner, { project: P, slug: "merge-arch", title: "merge" }).row.id;
  initDag(db, owner, { id: mergeF, rev: 1, nodes: [{ key: "BASE1", oneLine: "base" }] });
  const policy = (_p: string, key: RecoveryKey) => ({ mode: modes[key] ?? "observe", manualAfterMs: null, source: "config" as const });
  setMainRedFixCliForTest({ ledgerDir: join(dir, "ledger"), repo: () => REPO, policy,
    scrub: async () => ({ identity: { username: "mrf-tester-user", hostname: "mrf-tester-host" } }) });
  setMainRedFixTickForTest({ gh: () => gh, policy, ledgerDir: join(dir, "ledger"), health: async () => health,
    config: () => ({ projects: { [P]: { remote: { repo: REPO }, requiredChecks: [CHECK] } } }) as unknown as SchedulerConfig });
  gh.state.log = redLog("tests/a.test.ts");
  gh.state.pulls[sha("b")] = [12];
});
afterEach(() => { setMainRedFixCliForTest(null); setMainRedFixTickForTest(null); closeLedger(join(dir, "ledger.sqlite")); rmSync(dir, { recursive: true, force: true }); });

describe("[验收线 1] a red main push run with no merge intent", () => {
  test("on: one tick writes one fix node and one formal spec; the same run never writes again", async () => {
    gh.state.runs["ci.yml"] = [run(77, "failure")];
    expect(await tick()).toEqual([]);
    expect(nodesOf(agentsF).find((n) => n.key === "OBSAUTO1R1")).toMatchObject({ taskId: null, deps: [], fileGlobs: ["src/lib/obs.ts", "tests/a*.test.ts", "tests/a.test.ts"] });
    const spec = readFileSync(specPath("agents-OBSAUTO1R1"), "utf8");
    expect(lintObservation(spec)).toBeNull();
    expect(spec).toContain("观察期：6 小时");
    expect(spec).toContain("责任卡：agents-OBSAUTO1");
    expect(existsSync(specPathIn(join(dir, "ledger"), "agents-OBSAUTO1R1"))).toBe(true); // the path the autostart tick reads
    expect(ops("main_red_fix_node")).toHaveLength(1);
    expect(ops("pm_todo").map((e) => e.data.kind)).toEqual(["main_red_fix"]);
    const version = getFeature(db, agentsF)!.currentVersion, events = listEvents(db, { project: P }).length;
    expect(await tick()).toEqual([]);
    expect(getFeature(db, agentsF)!.currentVersion).toBe(version);
    expect(listEvents(db, { project: P })).toHaveLength(events);
    expect(notices).toEqual([]);
  });
  test("cancelled, still running or covered by a later green run: nothing", async () => {
    gh.state.runs["ci.yml"] = [run(80, "success"), run(79, "failure")];
    gh.state.runs["nightly.yml"] = [run(81, null, 1, sha("b"), "in_progress"), run(78, "cancelled")];
    expect(await tick()).toEqual([]);
    expect(listEvents(db, { project: P }).filter((e) => String(e.data.op).startsWith("main_red"))).toEqual([]);
  });
});

describe("[验收线 2] known flaky failures re-run once first", () => {
  beforeEach(() => {
    addKnownFlaky(db, { actor: "agent-pm" }, { project: P, file: "tests/flaky.test.ts", featureId: mergeF, node: "BASE1", reason: "竞态" });
    gh.state.log = redLog("tests/flaky.test.ts");
    gh.state.runs["ci.yml"] = [run(90, "failure")];
  });
  test("rerun green: one rerun, no node, one PM todo", async () => {
    await tick();
    expect(gh.state.reruns).toEqual([90]);
    expect(ops("main_red_fix_node")).toHaveLength(0);
    gh.state.runs["ci.yml"] = [run(90, null, 2, sha("b"), "in_progress")];
    await tick();
    gh.state.runs["ci.yml"] = [run(90, "success", 2)];
    await tick(); await tick();
    expect(gh.state.reruns).toEqual([90]);
    expect(ops("main_red_fix_node")).toHaveLength(0);
    expect(ops("pm_todo").map((e) => e.text)).toEqual([expect.stringContaining("重跑转绿")]);
  });
  test("still red after the rerun: the node is written, no second rerun", async () => {
    await tick();
    gh.state.runs["ci.yml"] = [run(90, "failure", 2)];
    await tick(); await tick();
    expect(gh.state.reruns).toEqual([90]);
    expect(ops("main_red_fix_node")).toHaveLength(1);
    expect(readFileSync(specPath("agents-OBSAUTO1R1"), "utf8")).toContain("已知偶发重跑一次仍红");
  });
});

describe("[验收线 3] which feature takes the node", () => {
  test("Nightly red → the fallback feature, NIGHTLY<n>", async () => {
    gh.state.runs["nightly.yml"] = [run(95, "failure")];
    await tick();
    expect(nodesOf(mergeF).map((n) => n.key)).toContain("NIGHTLY1");
    expect(nodesOf(agentsF).map((n) => n.key)).not.toContain("OBSAUTO1R1");
    expect(existsSync(specPath("merge-arch-NIGHTLY1"))).toBe(true);
  });
  test("push red whose responsible feature is done → the fallback feature; no feature at all → one action notice", async () => {
    db.query("UPDATE features SET status = 'done' WHERE id = ?").run(agentsF);
    gh.state.runs["ci.yml"] = [run(96, "failure")];
    await tick();
    expect(nodesOf(mergeF).map((n) => n.key)).toContain("CIRED1");
    db.query("UPDATE features SET status = 'paused' WHERE id = ?").run(mergeF);
    gh.state.runs["nightly.yml"] = [run(97, "failure", 1, sha("c"))];
    await tick();
    expect(notices).toEqual([expect.stringContaining("兜底 feature 也写不进")]);
    expect(ops("main_red_fix_handled").at(-1)?.data.outcome).toBe("unplaced");
  });
});

test("[验收线 4] same workflow, an unverified node of this mechanism, same failed checks: no new node, one note", async () => {
  gh.state.runs["ci.yml"] = [run(77, "failure")];
  await tick();
  const version = getFeature(db, agentsF)!.currentVersion;
  gh.state.runs["ci.yml"] = [run(78, "failure", 1, sha("c")), run(77, "failure")];
  await tick();
  expect(getFeature(db, agentsF)!.currentVersion).toBe(version);
  expect(ops("main_red_fix_node")).toHaveLength(1);
  expect(ops("main_red_fix_same")).toHaveLength(1);
});

test("the same fault's fix cards failed twice: the third node pushes one action notice; earlier ones stay pull-only", async () => {
  const cancel = (key: string) => {
    createTask(db, owner, { project: P, id: `agents-${key}`, title: "fix", kind: "code" });
    bindNode(db, owner, { id: agentsF, rev: getFeature(db, agentsF)!.rev, key, taskId: `agents-${key}` });
    db.query("UPDATE tasks SET stage = 'cancelled' WHERE id = ?").run(`agents-${key}`);
  };
  for (const [id, key] of [[77, "OBSAUTO1R1"], [78, "OBSAUTO1R2"]] as const) {
    gh.state.runs["ci.yml"] = [run(id, "failure", 1, sha("b"))];
    await tick();
    cancel(key);
  }
  expect(notices).toEqual([]);
  gh.state.runs["ci.yml"] = [run(79, "failure")];
  await tick();
  expect(nodesOf(agentsF).map((n) => n.key)).toContain("OBSAUTO1R3");
  expect(notices).toEqual([expect.stringContaining("同一故障修复卡已失败 2 次")]);
});

describe("[验收线 5] mainRedRepairBind", () => {
  async function atMerge(): Promise<string> {
    gh.state.runs["ci.yml"] = [run(77, "failure")];
    await tick();
    createTask(db, owner, { project: P, id: "agents-OBSAUTO1R1", title: "fix", kind: "code" });
    bindNode(db, owner, { id: agentsF, rev: getFeature(db, agentsF)!.rev, key: "OBSAUTO1R1", taskId: "agents-OBSAUTO1R1" });
    db.query("UPDATE tasks SET stage = 'merge', headSHA = ? WHERE id = 'agents-OBSAUTO1R1'").run(sha("d"));
    return "agents-OBSAUTO1R1";
  }
  test("observe: no binding, one would-bind note", async () => {
    await atMerge();
    await tick(); await tick();
    expect(mainCiApprovals(db, P, REPO)).toEqual([]);
    expect(ops("recovery_observe").filter((e) => e.data.mechanism === "mainRedRepairBind")).toHaveLength(1);
  });
  test("on: only this mechanism's card, same faultKey; the PM revoke undoes it and it is not bound again", async () => {
    modes.mainRedRepairBind = "on";
    const id = await atMerge();
    health = redHealth(sha("e")); // main moved: another fault key
    await tick();
    expect(mainCiApprovals(db, P, REPO)).toEqual([]);
    health = redHealth();
    await tick();
    expect(mainCiApprovals(db, P, REPO)).toEqual([expect.objectContaining({ actor: "agent-pm", binding: expect.objectContaining({ taskId: id, head: sha("d") }) })]);
    expect(listEvents(db, { project: P, target: id }).find((e) => e.data.op === "main_ci_repair")?.data).toMatchObject({ source: "mainRedFix", by: "scheduler" });
    createTask(db, owner, { project: P, id: "agents-OTHER1", title: "o", kind: "code" });
    db.query("UPDATE tasks SET stage = 'merge', headSHA = ? WHERE id = 'agents-OTHER1'").run(sha("f"));
    const other = await runLedger(["scheduler-main-red-fix", P, "--op", "bind", "--facts", JSON.stringify({ taskId: "agents-OTHER1", head: sha("f"), mainSha: sha("b"),
      faultKey: "x" })], deps("scheduler", () => {}));
    expect(other).toMatchObject({ ok: false, code: "forbidden" });
    expect(await runLedger(["main-ci-repair", id, "--revoke", "--reason", "PM 撤销"], deps("agent-pm"))).toMatchObject({ ok: true });
    await tick();
    expect(mainCiApprovals(db, P, REPO)).toEqual([]);
  });
});

describe("[验收线 6] off and observe", () => {
  test("off: no gh read, nothing written", async () => {
    modes.mainRedFix = "off";
    gh.state.runs["ci.yml"] = [run(77, "failure")];
    const before = listEvents(db, { project: P }).length;
    await tick();
    expect(gh.state.calls).toBe(0);
    expect(listEvents(db, { project: P })).toHaveLength(before);
  });
  test("observe: no rerun, no node, only would-be notes per main SHA + workflow", async () => {
    modes.mainRedFix = "observe";
    addKnownFlaky(db, { actor: "agent-pm" }, { project: P, file: "tests/flaky.test.ts", featureId: mergeF, node: "BASE1", reason: "竞态" });
    gh.state.log = redLog("tests/flaky.test.ts");
    gh.state.runs["ci.yml"] = [run(90, "failure")];
    gh.state.runs["nightly.yml"] = [run(91, "failure", 1, sha("c"))];
    await tick(); await tick();
    expect(gh.state.reruns).toEqual([]);
    expect(ops("main_red_fix_node")).toHaveLength(0);
    const notes = ops("recovery_observe").filter((e) => e.data.mechanism === "mainRedFix").map((e) => e.text);
    expect(notes).toEqual([expect.stringContaining("本会 重跑"), expect.stringContaining("本会 重跑")]);
    gh.state.log = redLog("tests/a.test.ts");
    gh.state.runs["ci.yml"] = [run(92, "failure", 1, sha("d"))];
    await tick(); await tick();
    const after = ops("recovery_observe").filter((e) => e.data.mechanism === "mainRedFix").map((e) => e.text);
    expect(after.slice(2)).toEqual([expect.stringContaining(`本会 写修复节点 ${mergeF}/CIRED1`)]);
    expect(ops("main_red_fix_node")).toHaveLength(0);
    expect(existsSync(join(dir, "ledger", "docs", "tasks"))).toBe(false);
  });
});

describe("the write door: scheduler identity with a lease only", () => {
  const args = ["scheduler-main-red-fix", P, "--op", "rerun-result", "--facts", JSON.stringify({ workflow: "push", runId: 1, url: `https://github.com/${REPO}/actions/runs/1`, green: true })];
  test("PM, executor, owner and a lease-less scheduler are refused; a lost lease stops; nothing is written", async () => {
    expect(MAIN_RED_FIX_SERVICE.has("scheduler-main-red-fix")).toBe(true);
    for (const actor of ["agent-pm", "agent-w", "owner"]) expect(await runLedger(args, deps(actor, () => {}))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await runLedger(args, deps("scheduler"))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await runLedger(args, deps("scheduler", () => { throw new SchedulerLeaseLost("lease lost"); }))).toMatchObject({ ok: false, code: "lease-lost" });
    expect(ops("pm_todo")).toHaveLength(0);
    expect(await runLedger(args, deps("scheduler", () => {}))).toMatchObject({ ok: true });
  });
  test("a lost lease inside the tick stops it", async () => {
    gh.state.runs["ci.yml"] = [run(77, "failure")];
    const e = { ...env(), ledger: async () => ({ ok: false, code: "lease-lost", error: "gone" }) };
    now += 11 * MIN;
    expect(mainRedFixTick(e)).rejects.toBeInstanceOf(SchedulerStopped);
  });
});
