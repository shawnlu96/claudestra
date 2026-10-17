/**
 * MAINREDLOG1 · mainRedGreenRetire end to end: a red main writes a fix node through the real tick and `ledger scheduler-main-red-fix`,
 * then a green run on a newer main SHA retires it while nobody started it. Fixture as tests/main-red-fix-tick.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { effectiveNodes, getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { MainRedRun } from "../src/lib/main-red-fix.js";
import { setMainRedFixCliForTest } from "../src/lib/main-red-fix-cmds.js";
import type { MainRedGh } from "../src/lib/main-red-fix-gh.js";
import { mainRedFixTick, setMainRedFixTickForTest } from "../src/lib/main-red-fix-tick.js";
import type { RecoveryKey, RecoveryMode } from "../src/lib/recovery-policy.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import type { SpecWaitEnv } from "../src/lib/scheduler-spec-wait.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";

const P = "p", REPO = "o/r", CHECK = "typecheck + test + guard", MIN = 60_000;
const owner = { actor: "owner", now: 100 };
const sha = (c: string) => c.repeat(40);
let db: Database, dir: string, now: number, agentsF: string, mergeF: string, modes: Partial<Record<RecoveryKey, RecoveryMode>>;
let notices: { text: string; level: string }[], runs: Record<string, MainRedRun[]>, log: string;

const run = (id: number, conclusion: string | null, attempt = 1, head = sha("b")): MainRedRun =>
  ({ id, attempt, status: "completed", conclusion, headSha: head, url: `https://github.com/${REPO}/actions/runs/${id}`, createdAt: id * 1000 });
const redLog = (file: string) => [`##[group]${file}:`, "error: expect(received).toBe(expected)", "(fail) race > case [0.40ms]", "##[endgroup]",
  " 1999 pass", " 1 fail", "##[error]Process completed with exit code 1."].map((l) => `test shard 2 of 4\tUnit tests\t2026-10-12T09:00:00.1Z ${l}`).join("\n");
const gh: MainRedGh = { runs: async (_r, file) => runs[file] ?? [], failedJobs: async () => [CHECK], failedLog: async () => log,
  jobLogs: async () => { throw new Error("not read"); }, commitPulls: async (_r, s) => s === sha("b") ? [12] : [], rerunFailed: async () => {} };

function deps(actor: string): LedgerDeps {
  return { db, actor, now: () => now, projectIds: [P], assertLease: () => {}, autoDispatch: () => true, autoProjects: () => [P],
    loadRegistry: async () => ({ socket: "s", agents: {} }), saveRegistry: async () => {} };
}
const env = (): SpecWaitEnv => ({ db, now: () => now, readSpec: () => null, svc: { autoDispatch: true, projects: [P], maxWorkers: () => 1 },
  ledger: (...args: string[]) => runLedger(args.slice(1), deps("scheduler")) as Promise<Record<string, unknown>>,
  notifyPm: async (_p, text, level) => { notices.push({ text, level }); } });
const tick = async () => { now += 11 * MIN; return mainRedFixTick(env()); };
const ops = (op: string) => listEvents(db, { project: P }).filter((e) => e.data.op === op);
const keysOf = (f: string) => { const x = getFeature(db, f)!; return effectiveNodes(db, getDagVersion(db, x.id, x.currentVersion)!).map((n) => n.key); };
const cardFor = (f: string, key: string, stage: string) => {
  createTask(db, owner, { project: P, id: `${f}-${key}`, title: "fix", kind: "code" });
  bindNode(db, owner, { id: f, rev: getFeature(db, f)!.rev, key, taskId: `${f}-${key}` });
  db.query("UPDATE tasks SET stage = ? WHERE id = ?").run(stage, `${f}-${key}`);
};
/** Every row the green tick could touch, to compare off with what the code did before this card. */
const snapshot = () => ({ events: listEvents(db, { project: P }).map((e) => [e.seq, e.kind, e.text]),
  versions: [agentsF, mergeF].map((f) => getFeature(db, f)!.currentVersion), notices: [...notices] });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "main-red-retire-")); db = openLedger(join(dir, "ledger.sqlite")); now = 1_000_000;
  modes = { mainRedFix: "on", mainRedRepairBind: "off", mainRedGreenRetire: "on" }; notices = []; runs = {}; log = redLog("tests/a.test.ts");
  setMeta(db, owner, { project: P, key: "pms", value: ["agent-pm"] });
  agentsF = createFeature(db, owner, { project: P, slug: "agents", title: "agents" }).row.id;
  initDag(db, owner, { id: agentsF, rev: 1, nodes: [{ key: "OBSAUTO1", oneLine: "obs", fileGlobs: ["src/lib/obs.ts", "tests/a*.test.ts"] }, { key: "OTHER1", oneLine: "o" }] });
  createTask(db, owner, { project: P, id: "agents-OBSAUTO1", title: "obs", kind: "code", pr: `https://github.com/${REPO}/pull/12` });
  bindNode(db, owner, { id: agentsF, rev: getFeature(db, agentsF)!.rev, key: "OBSAUTO1", taskId: "agents-OBSAUTO1" });
  db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'agents-OBSAUTO1'").run();
  mergeF = createFeature(db, owner, { project: P, slug: "merge-arch", title: "merge" }).row.id;
  initDag(db, owner, { id: mergeF, rev: 1, nodes: [{ key: "BASE1", oneLine: "base" }, { key: "CIRED9", oneLine: "PM 自己写的" }] });
  const policy = (_p: string, key: RecoveryKey) => ({ mode: modes[key] ?? "observe", manualAfterMs: null, source: "config" as const });
  setMainRedFixCliForTest({ ledgerDir: join(dir, "ledger"), repo: () => REPO, policy,
    scrub: async () => ({ identity: { username: "mrf-tester-user", hostname: "mrf-tester-host" } }) });
  setMainRedFixTickForTest({ gh: () => gh, policy, ledgerDir: join(dir, "ledger"), health: async () => null,
    config: () => ({ projects: { [P]: { remote: { repo: REPO }, requiredChecks: [CHECK] } } }) as unknown as SchedulerConfig });
  // red on b: OBSAUTO1R1 (push) and NIGHTLY1 (Nightly), both planned
  runs["ci.yml"] = [run(77, "failure")];
  runs["nightly.yml"] = [run(76, "failure")];
  expect(await tick()).toEqual([]);
  expect(keysOf(agentsF)).toContain("OBSAUTO1R1");
  expect(keysOf(mergeF)).toContain("NIGHTLY1");
});
afterEach(() => { setMainRedFixCliForTest(null); setMainRedFixTickForTest(null); closeLedger(join(dir, "ledger.sqlite")); rmSync(dir, { recursive: true, force: true }); });

describe("[验收线 3] main green on a newer SHA retires this mechanism's planned fix node", () => {
  test("the planned node leaves the sub-DAG with the reason; one info notice; nothing else moves; once only", async () => {
    runs["ci.yml"] = [run(78, "success", 1, sha("c")), run(77, "failure")];
    expect(await tick()).toEqual([]);
    expect(keysOf(agentsF)).toEqual(["OBSAUTO1", "OTHER1"]);
    expect(keysOf(mergeF)).toEqual(["BASE1", "CIRED9", "NIGHTLY1"]); // the PM's node and the other workflow's node stay
    const f = getFeature(db, agentsF)!, v = getDagVersion(db, f.id, f.currentVersion)!;
    expect(v.reasonText).toContain(`main 已在 ${sha("c")} 转绿`);
    expect(ops("main_red_fix_retired")).toEqual([expect.objectContaining({ data: expect.objectContaining({ featureId: agentsF, key: "OBSAUTO1R1",
      greenSha: sha("c"), reason: expect.stringContaining(`main 已在 ${sha("c")} 转绿`) }) })]);
    expect(notices).toEqual([{ text: expect.stringContaining(`main 已在 ${sha("c")} 转绿`), level: "info" }]);
    const before = snapshot();
    await tick(); await tick();
    expect(snapshot()).toEqual(before);
  });
  test("a node already bound to a card is not removed: one PM todo, once", async () => {
    cardFor(agentsF, "OBSAUTO1R1", "build");
    runs["ci.yml"] = [run(78, "success", 1, sha("c")), run(77, "failure")];
    await tick(); await tick();
    expect(keysOf(agentsF)).toContain("OBSAUTO1R1");
    expect(ops("main_red_fix_retired")).toEqual([]);
    expect(ops("pm_todo").filter((e) => String(e.data.dedupKey).includes("retire-bound")).map((e) => e.text))
      .toEqual([expect.stringContaining(`已开卡 ${agentsF}-OBSAUTO1R1`)]);
    expect(notices).toEqual([]);
  });
  test("green on the SHA the node was written for (not newer), or a Nightly green for a push node: nothing", async () => {
    runs["ci.yml"] = [run(78, "success", 1, sha("b")), run(77, "failure")];
    runs["nightly.yml"] = [run(79, "failure", 1, sha("c")), run(76, "failure")]; // the Nightly node waits for a Nightly green
    await tick();
    expect(keysOf(agentsF)).toContain("OBSAUTO1R1");
    expect(ops("main_red_fix_retired")).toEqual([]);
    runs["nightly.yml"] = [run(80, "success", 1, sha("d"))];
    await tick();
    expect(keysOf(mergeF)).toEqual(["BASE1", "CIRED9"]);
    expect(keysOf(agentsF)).toContain("OBSAUTO1R1");
  });
  test("the write door refuses a node this mechanism did not write", async () => {
    const r = await runLedger(["scheduler-main-red-fix", P, "--op", "retire", "--facts", JSON.stringify({ workflow: "push", featureId: mergeF, key: "CIRED9",
      greenSha: sha("c"), greenRunId: 99, url: `https://github.com/${REPO}/actions/runs/99` })], deps("scheduler"));
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    expect(keysOf(mergeF)).toContain("CIRED9");
  });
  test("observe: one note per node, the node stays; switched to on, the note does not hold it back", async () => {
    modes.mainRedGreenRetire = "observe";
    runs["ci.yml"] = [run(78, "success", 1, sha("c")), run(77, "failure")];
    await tick(); await tick();
    expect(keysOf(agentsF)).toContain("OBSAUTO1R1");
    expect(ops("recovery_observe").filter((e) => e.data.mechanism === "mainRedGreenRetire").map((e) => e.text))
      .toEqual([expect.stringContaining(`从子 DAG 移出修复节点 ${agentsF}/OBSAUTO1R1`)]);
    modes.mainRedGreenRetire = "on";
    await tick();
    expect(keysOf(agentsF)).not.toContain("OBSAUTO1R1");
  });
});

test("[验收线 4] mainRedGreenRetire off: the green tick writes, removes and sends nothing, as before", async () => {
  modes.mainRedGreenRetire = "off";
  const before = snapshot();
  runs["ci.yml"] = [run(78, "success", 1, sha("c")), run(77, "failure")];
  runs["nightly.yml"] = [run(80, "success", 1, sha("d"))];
  expect(await tick()).toEqual([]);
  await tick();
  expect(snapshot()).toEqual(before);
  expect(keysOf(agentsF)).toContain("OBSAUTO1R1");
  expect(keysOf(mergeF)).toContain("NIGHTLY1");
});
