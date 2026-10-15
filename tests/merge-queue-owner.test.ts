import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";
import { adoptSchedulerLease, assertSchedulerLease, resetSchedulerLeaseForTest } from "../src/lib/scheduler-lease-env.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { claimManualMerge } from "../src/lib/manual-merge-queue.js";
import { openMergeQueueOwner } from "../src/lib/merge-queue-owner-context.js";
import { pickMergeQueueOwner } from "../src/lib/merge-queue-owner.js";
import { observeMergeQueueOwner } from "../src/lib/merge-queue-owner-pass.js";
import { setPrivateMergePortsForTest } from "../src/lib/private-merge-gate.js";
import { reclaimLentSlots } from "../src/lib/scheduler-merge-reclaim.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { SLOT_RECLAIM, SLOT_YIELD } from "../src/lib/scheduler-merge-train-hold.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { testChildEnv } from "./test-env.js";
import { setFrozen, setMeta } from "../src/lib/ledger-write.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH, recoveryPolicy } from "../src/lib/recovery-policy.js";
import { projectRepo, setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs } from "./manual-merge-queue-world.test.js";

let w: ReclaimWorld;
afterEach(() => {
  resetSchedulerLeaseForTest(); w?.close();
  rmSync(RECOVERY_POLICY_PATH, { force: true }); rmSync(SCHEDULER_CONFIG_PATH, { force: true });
  setForeignRepoLookupForTest({ project: null, origin: null });
  setPrivateMergePortsForTest(null);
});
function setup(mode?: "off" | "observe" | "on") {
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
  w = reclaimWorld({ store: "memory", live: true });
  setMeta(w.db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: {
    manualMergeQueue: "on", manualCaseOwnership: "off", mergeDirect: "off", ...(mode ? { mergeQueueOwner: mode } : {}),
  } } } }));
}
function auto(id: string) {
  const c = w.card(id);
  const repo = /github\.com\/([^/]+\/[^/]+)\//.exec(c.prRef)![1]!;
  setForeignRepoLookupForTest({ project: () => repo });
  w.config.projects.p!.remote!.repo = repo;
  w.config.projects.p!.remote!.roles = ["review", "write"];
  insertEvent(w.db, { actor: "scheduler" }, { project: "p", target: id, kind: "stage", data: { from: "review", to: "merge", head: c.head, round: 1 } }, false);
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify(w.config));
  return c;
}
async function request(id: string) {
  const c = await manualCard(w, id);
  const r = await ledgerAs(w, "agent-pm", ...requestArgs(c));
  expect(r.ok).toBe(true);
  return Number(r.request);
}

test("[验收线 5] the new key occurs exactly once and defaults on", () => {
  expect(RECOVERY_KEYS.filter((k: string) => k === "mergeQueueOwner")).toHaveLength(1);
  expect(recoveryPolicy("unconfigured-owner-test", "mergeQueueOwner" as never).mode).toBe("on");
});
test("[验收线 1] default on: a real pass gives the earlier auto version the slot before a fresh manual request", async () => {
  setup(); auto("A"); await request("M");
  await w.pass();
  expect(w.slot()).toBe("A");
  expect(w.intentOf("M")).toBeNull();
}, 60_000);
test("[验收线 4] off keeps the manual-first legacy path", async () => {
  setup("off"); auto("A"); await request("M");
  await w.pass();
  expect(w.slot()).toBe("M");
}, 60_000);

test("[验收线 4] default on without repository falls back to legacy and completes both merges", async () => {
  setup(); w.card("A"); await request("M");
  setForeignRepoLookupForTest({ project: null });
  await w.pass();
  expect(w.slot()).toBe("M");
  for (let n = 0; n < 14 && (w.phase("M") !== "merged" || w.phase("A") !== "merged"); n++) await w.pass();
  expect(w.phase("M")).toBe("merged"); expect(w.phase("A")).toBe("merged");
  expect(w.hub.calls.filter((x) => x === "serial-merge:M")).toHaveLength(1);
  const notes = listEvents(w.db, { project: "p" }).filter((e) => e.data.mechanism === "mergeQueueOwner");
  expect(notes.some((e) => e.data.reason === "缺 repository")).toBe(true);
  expect(new Set(notes.map((e) => e.data.actionKey)).size).toBe(notes.length);
});

const claim = () => claimManualMerge(w.db, { actor: "scheduler" }, { project: "p", mode: "on", train: "none", requiredChecks: ["check"] });
function plan(id: string, node = "merge_deploy") {
  return planIntent(w.db, { actor: "scheduler" }, { id: `owner-${id}`, taskId: id, taskRev: getTask(w.db, id)!.rev, workflowRev: 1,
    causalSeq: (w.db.query("SELECT MAX(seq) AS s FROM events WHERE project = 'p'").get() as { s: number }).s,
    node, action: "merge", reason: "test", resources: ["merge:p"] });
}
test("[验收线 3] a review-only UI refresh retains the idle slot path but cannot overtake a merge owner", async () => {
  setup("on"); auto("U");
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { mergeQueueOwner: "on", uiOwnerAskFresh: "on" } } } }));
  w.db.query("UPDATE task_workflows SET template='ui' WHERE taskId='U'").run();
  w.db.query("UPDATE tasks SET stage='review', extra=? WHERE id='U'").run(JSON.stringify({ ownerVisual: true }));
  insertEvent(w.db, { actor: "owner" }, { project: "p", target: "U", kind: "task", data: { op: "set", patch: { extra: { ownerVisual: true } } } }, false);
  auto("A");
  expect(() => plan("U", "ui_owner_fresh")).toThrow(/统一合并队列/);
  w.db.query("UPDATE tasks SET stage='done' WHERE id='A'").run();
  expect(plan("U", "ui_owner_fresh").intent.taskId).toBe("U");
  expect(w.slot()).toBe("U");
  expect(await w.manager("ledger", "scheduler-settle", "owner-U", "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
  expect(await w.manager("ledger", "scheduler-merge-begin", "owner-U", "--required-checks", "check")).toMatchObject({ ok: true });
  let run = getMergeRun(w.db, "owner-U")!;
  expect(await w.manager("ledger", "scheduler-merge-step", run.intentId, "--from", "ready", "--to", "ready", "--rev", String(run.rev),
    "--receipt", `${SLOT_YIELD}列车先走`)).toMatchObject({ ok: true });
  run = getMergeRun(w.db, "owner-U")!;
  expect(await w.manager("ledger", "scheduler-merge-step", run.intentId, "--from", "ready", "--to", "ready", "--rev", String(run.rev),
    "--receipt", SLOT_RECLAIM)).toMatchObject({ ok: true });
  expect(w.slot()).toBe("U");
});

async function yieldRun(id: string) {
  const intent = await w.begin(id), run = getMergeRun(w.db, intent)!;
  expect(await w.manager("ledger", "scheduler-merge-step", intent, "--from", run.phase, "--to", run.phase, "--rev", String(run.rev),
    "--receipt", `${SLOT_YIELD}测试列车让路`)).toMatchObject({ ok: true });
  return intent;
}

test("[验收线 1] an older manual request beats the auto writer even when it attempts the transaction first", async () => {
  setup("on"); await request("M"); auto("A");
  expect(() => plan("A")).toThrow(/统一合并队列/);
  expect(claim()).toMatchObject({ claimed: true, taskId: "M" });
  expect(w.slot()).toBe("M");
});

test("[验收线 1] fresh arrivals cannot starve a valid yielded version; restart preserves the same intent", async () => {
  setup("on"); auto("OLD"); const id = await yieldRun("OLD");
  auto("NEW"); await request("M");
  w.restart();
  await w.pass();
  expect(w.slot()).toBe("OLD");
  expect(w.intentOf("OLD")).toBe(id);
  expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE taskId='OLD' AND action='merge'").get()).toEqual({ n: 1 });
  expect(w.turns("OLD")).toEqual(["yield", "reclaim"]);
});

for (const change of ["revoke", "head", "spec", "hold", "freeze"] as const) test(`[验收线 2] final manual claim rechecks ${change} after the pick`, async () => {
  setup("on"); const seq = await request("M"); auto("A");
  expect(pickMergeQueueOwner(w.db, "p").entry?.taskId).toBe("M");
  if (change === "revoke") await ledgerAs(w, "agent-pm", "manual-merge-revoke", "M", "--request", String(seq), "--reason", "撤回");
  if (change === "head") w.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'M'").run("d".repeat(40));
  if (change === "spec") w.db.query("UPDATE tasks SET specRev = specRev + 1 WHERE id = 'M'").run();
  if (change === "hold") insertEvent(w.db, { actor: "owner" }, { project: "p", target: "M", kind: "scheduler", data: { op: "workflow", hold: "暂缓" } }, false);
  if (change === "freeze") setFrozen(w.db, { actor: "owner" }, { project: "p", frozen: true, reason: "暂停" });
  expect(claim().claimed).toBe(false);
  expect(w.intentOf("M")).toBeNull();
  expect(w.slot()).toBeNull();
});

test("[验收线 2] a newly held auto head is rejected even with refreshed causal/revision inputs", () => {
  setup("on"); auto("A");
  expect(pickMergeQueueOwner(w.db, "p").entry?.taskId).toBe("A");
  insertEvent(w.db, { actor: "owner" }, { project: "p", target: "A", kind: "scheduler", data: { op: "workflow", hold: "hold" } }, false);
  expect(() => plan("A")).toThrow(/统一合并队列/);
  expect(w.slot()).toBeNull();
});

for (const phase of ["merging", "unknown"] as const) test(`[验收线 2] ${phase} is verified before any fresh owner, even if its slot is absent`, async () => {
  setup("on"); auto("OLD"); const id = await w.begin("OLD"); auto("NEW"); await request("M");
  w.db.query("UPDATE scheduler_merges SET phase = ? WHERE intentId = ?").run(phase, id);
  w.db.query("DELETE FROM scheduler_resources WHERE intentId = ?").run(id);
  expect(pickMergeQueueOwner(w.db, "p")).toMatchObject({ intentId: id, reason: "先核实在途运行" });
  expect(() => plan("NEW")).toThrow(/先核实在途运行/);
  expect(claim().claimed).toBe(false);
  expect(w.slot()).toBeNull();
});

test("[验收线 4] normalized same-repository project conflicts refuse both new exits", async () => {
  setup("on"); auto("A"); await request("M");
  w.config.projects.q = { ...w.config.projects.p!, remote: { ...w.config.projects.p!.remote!, repo: w.config.projects.p!.remote!.repo!.toUpperCase() } };
  openMergeQueueOwner(w.db, w.config);
  expect(pickMergeQueueOwner(w.db, "p").reason).toMatch(/多项目出口冲突/);
  expect(() => plan("A")).toThrow(/多项目出口冲突/);
  expect(claim().claimed).toBe(false);
  expect(w.slot()).toBeNull();
});

test("[验收线 4] observe records the changed choice once with no claim/reclaim/resource change", async () => {
  setup("observe"); auto("A"); await request("M");
  const resources = w.db.query("SELECT * FROM scheduler_resources").all(), intents = w.db.query("SELECT * FROM scheduler_intents").all();
  await observeMergeQueueOwner(w.db, w.manager, "p", w.store);
  await observeMergeQueueOwner(w.db, w.manager, "p", w.store);
  const notes = listEvents(w.db, { project: "p" }).filter((e) => e.data.mechanism === "mergeQueueOwner");
  expect(notes).toHaveLength(1);
  expect(notes[0]!.data).toMatchObject({ chosen: "A", old: "M" });
  expect(w.db.query("SELECT * FROM scheduler_resources").all()).toEqual(resources);
  expect(w.db.query("SELECT * FROM scheduler_intents").all()).toEqual(intents);
  await w.pass();
  expect(w.slot()).toBe("M");
});

test("[验收线 5] observation compares against the enabled legacy exit, not an inactive manual queue", async () => {
  setup("observe"); auto("A"); await request("M");
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: {
    mergeQueueOwner: "observe", manualMergeQueue: "observe", manualCaseOwnership: "off",
  } } } }));
  await observeMergeQueueOwner(w.db, w.manager, "p", w.store);
  expect(listEvents(w.db, { project: "p" }).filter((e) => e.data.mechanism === "mergeQueueOwner")).toEqual([]);
  expect(w.slot()).toBeNull();
});

for (const mode of ["off", "observe"] as const) test(`[验收线 4] on to ${mode}: the submitted owner settles under its original intent`, async () => {
  setup("on"); auto("A"); await request("M");
  await w.pass(); const id = w.intentOf("A");
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { mergeQueueOwner: mode, manualMergeQueue: "on", manualCaseOwnership: "off" } } } }));
  for (let n = 0; n < 6 && w.phase("A") !== "merged"; n++) await w.pass();
  expect(w.phase("A")).toBe("merged"); expect(w.intentOf("A")).toBe(id);
  expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE taskId='A' AND action='merge'").get()).toEqual({ n: 1 });
  expect(w.hub.calls.filter((x) => x === "serial-merge:A")).toHaveLength(1);
});

for (const first of ["auto", "manual"] as const) test(`[验收线 1] a real pass and SQLite child processes race auto/manual: only the ${first} version wins`, async () => {
  setup("on");
  if (first === "auto") { auto("A"); await request("M"); } else { await request("M"); auto("A"); }
  const seq = (w.db.query("SELECT MAX(seq) AS s FROM events WHERE project='p'").get() as { s: number }).s;
  const code = `const { openLedger } = await import('./src/lib/ledger-store.ts');
    const { planIntent } = await import('./src/lib/ledger-scheduler-write.ts');
    const { claimManualMerge } = await import('./src/lib/manual-merge-queue.ts');
    const db = openLedger(${JSON.stringify(w.db.filename)}); db.exec('PRAGMA busy_timeout=5000');
    try { const r = process.argv.at(-1) === 'auto'
      ? planIntent(db, { actor:'scheduler' }, { id:'race-A',taskId:'A',taskRev:${getTask(w.db, "A")!.rev},workflowRev:1,causalSeq:${seq},
        node:'merge_deploy',action:'merge',reason:'race',resources:['merge:p'] })
      : claimManualMerge(db,{actor:'scheduler'},{project:'p',mode:'on',train:'none',requiredChecks:['check']});
      console.log(JSON.stringify(r)); } catch(e) { console.log(JSON.stringify({error:e.message})); }`;
  const env = testChildEnv({ CLAUDESTRA_STATE_DIR: process.env.CLAUDESTRA_STATE_DIR, CLAUDESTRA_RUNTIME_DIR: process.env.CLAUDESTRA_RUNTIME_DIR });
  const kids = ["auto", "manual"].map((kind) => Bun.spawn([process.execPath, "--no-env-file", "-e", code, kind], { env, stdout: "pipe", stderr: "pipe" }));
  const [, results] = await Promise.all([w.pass(), Promise.all(kids.map(async (child) => ({
    code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text(),
  })))]);
  expect(results.map((r) => [r.code, r.err])).toEqual([[0, ""], [0, ""]]);
  expect(w.slot()).toBe(first === "auto" ? "A" : "M");
  expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE action='merge' AND status IN ('pending','submitted')").get()).toEqual({ n: 1 });
}, 30_000);


for (const mode of ["on", "observe"] as const) test(`[验收线 2] shared-ledger skip precedes ${mode} arbitration and observations`, async () => {
  setup(mode); auto("A"); await request("M");
  w.db.query("INSERT INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('f','p','f','active','owner',1,1)").run();
  w.db.query("UPDATE tasks SET featureId = 'f'").run();
  writeFileSync(join(dirname(w.db.filename), "shared-ledger-modes.json"), JSON.stringify({ features: { f: { authorityMode: "execution", sharedPlanning: true } } }));
  const before = listEvents(w.db, { project: "p" }).length;
  await observeMergeQueueOwner(w.db, w.manager, "p", w.store);
  if (mode === "on") { expect(claim().claimed).toBe(false); expect(() => plan("A")).toThrow(/skip/); }
  expect(listEvents(w.db, { project: "p" })).toHaveLength(before);
  expect(w.slot()).toBeNull();
});

test("[验收线 2] the ledger CLI's real lease gate refuses a queued claim before any transaction", async () => {
  setup("on"); await request("M"); auto("A");
  adoptSchedulerLease({ CLAUDESTRA_SCHEDULER_SERVICE: "1" });
  const result = await runLedger(["manual-merge-claim", "p", "--mode", "on", "--train", "none", "--required-checks", "check"], {
    db: w.db, actor: "scheduler", projectIds: ["p"], autoProjects: () => ["p"], autoDispatch: () => true, assertLease: assertSchedulerLease,
    loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: Date.now,
  });
  expect(result).toMatchObject({ ok: false, code: "lease-lost" });
  expect(w.slot()).toBeNull(); expect(w.intentOf("M")).toBeNull();
});

test("[验收线 3] planner, real inspect, candidates and deploy retain their gates on the unified train", async () => {
  setup("on"); w.close(); w = reclaimWorld({ store: "memory", deploy: true });
  setMeta(w.db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  auto("A"); auto("B"); await request("M");
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: {
    mergeQueueOwner: "on", mergeUnifiedCandidates: "on", manualMergeQueue: "on", manualCaseOwnership: "off",
  } } } }));
  for (let n = 0; n < 18 && (w.phase("M") !== "merged" || w.hub.calls.filter((c) => c.startsWith("deploy:")).length < 2); n++) await w.pass();
  expect(w.hub.calls.filter((c) => c.startsWith("failed:"))).toEqual([]);
  for (const id of ["A", "B", "M"]) {
    expect(w.hub.calls.filter((c) => c === `match-head:${id}`)).toHaveLength(1);
    expect(w.hub.calls.filter((c) => c === `deploy:${id}`)).toHaveLength(id === "M" ? 0 : 1);
  }
  expect(w.db.query("SELECT mode FROM task_workflows WHERE taskId = 'M'").get()).toEqual({ mode: "manual" });
});


/** Keep the PR in the fixture repository while the project's public checkout belongs elsewhere. */
function privateProject(id: string) {
  const repo = /github\.com\/([^/]+\/[^/]+)\//.exec(getTask(w.db, id)!.pr!)![1]!;
  w.config.projects.p!.remote = { ...w.config.projects.p!.remote!, repo: "example/public", roles: ["review", "write"] };
  setForeignRepoLookupForTest({ project: () => "example/public" });
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify(w.config));
  w.db.query("UPDATE tasks SET extra = json_set(extra, '$.fileGlobs', json(?)) WHERE id = ?")
    .run(JSON.stringify([`repo:${repo}/src/**`]), id);
  setPrivateMergePortsForTest({ policy: recoveryPolicy, ledger: () => w.db, handoff: () => false,
    repoDirs: { dirs: () => [dirname(w.db.filename)], exists: () => true, origin: () => repo } });
  openMergeQueueOwner(w.db, w.config);
}
function fallbackPolicy(keys: Record<string, string> = {}) {
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: {
    manualMergeQueue: "on", manualCaseOwnership: "off", mergeDirect: "off", privateRepoMerge: "on", ...keys,
  } } } }));
}
const ownerNotes = () => listEvents(w.db, { project: "p" }).filter((e) => e.data.mechanism === "mergeQueueOwner");

test("[验收线 3] default on admits a private auto card through the real pass and planIntent", async () => {
  setup(); auto("P"); privateProject("P"); fallbackPolicy();
  await w.pass();
  expect(w.slot()).toBe("P");
  expect(w.intentOf("P")).not.toBeNull();
  expect(w.hub.calls.filter((x) => x.startsWith("failed:"))).toEqual([]);
  expect(ownerNotes().some((e) => /foreign repository/.test(String(e.data.reason)))).toBe(true);
});

test("[验收线 3] default on preserves the private manual request's legacy claim and sample dedup", async () => {
  setup(); await request("P"); privateProject("P"); fallbackPolicy();
  await observeMergeQueueOwner(w.db, w.manager, "p", w.store);
  await observeMergeQueueOwner(w.db, w.manager, "p", w.store);
  expect(ownerNotes()).toHaveLength(1);
  await w.pass();
  expect(w.slot()).toBe("P");
  expect(w.phase("P")).toBe("ready");
  expect(claim().claimed).toBe(false);
  expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE action='merge'").get()).toEqual({ n: 1 });
});

test("[验收线 3] a private yielded intent reclaims through MTR1 and resumes through mergeSlotTurn", async () => {
  setup(); auto("P"); const id = await yieldRun("P"); privateProject("P"); fallbackPolicy();
  expect(await reclaimLentSlots(w.db, ["p"], w.manager, w.store)).toEqual({ reclaimed: ["P"], failed: [] });
  expect(w.slot()).toBe("P");
  const run = getMergeRun(w.db, id)!;
  expect(await w.manager("ledger", "scheduler-merge-step", id, "--from", run.phase, "--to", run.phase, "--rev", String(run.rev),
    "--receipt", `${SLOT_YIELD}retest slot turn`)).toMatchObject({ ok: true });
  // The fixture driver handles the PR; the real slot-turn path still has to reclaim before it can drive it.
  setPrivateMergePortsForTest(null);
  await w.pass();
  expect(w.slot()).toBe("P");
  expect(w.turns("P")).toEqual(["yield", "reclaim", "yield", "reclaim"]);
  expect(w.intentOf("P")).toBe(id);
});

test("[验收线 4] disabling QUEUE1 alone restores manual-first legacy passes with one fallback sample per version", async () => {
  setup(); auto("A"); await request("M"); fallbackPolicy({ unifiedMergeQueue: "off" });
  await observeMergeQueueOwner(w.db, w.manager, "p", w.store);
  await observeMergeQueueOwner(w.db, w.manager, "p", w.store);
  expect(ownerNotes()).toHaveLength(1);
  expect(ownerNotes()[0]!.data.reason).toMatch(/unifiedMergeQueue/);
  await w.pass();
  expect(w.slot()).toBe("M");
  for (let n = 0; n < 14 && (w.phase("M") !== "merged" || w.phase("A") !== "merged"); n++) await w.pass();
  expect(w.phase("M")).toBe("merged"); expect(w.phase("A")).toBe("merged");
});

for (const kind of ["manual", "auto"] as const) test(`[验收线 4] unreadable QUEUE1 policy restores the ${kind} write path`, async () => {
  setup(); auto("A"); await request("M");
  openMergeQueueOwner(w.db, w.config, (project, key) => {
    if (key === "unifiedMergeQueue") throw new Error("dependency unreadable");
    return recoveryPolicy(project, key);
  });
  if (kind === "manual") expect(claim()).toMatchObject({ claimed: true, taskId: "M" });
  else expect(plan("A").intent.taskId).toBe("A");
});

test("[验收线 5] final owner writes reuse the origin cache instead of spawning git under the write lock", () => {
  setup(); const c = auto("A");
  const repo = /github\.com\/([^/]+\/[^/]+)\//.exec(c.prRef)![1]!;
  let reads = 0;
  setForeignRepoLookupForTest({ project: null, origin: () => { reads++; return repo; } });
  w.config.projects.p!.repoDir = dirname(w.db.filename);
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify(w.config));
  openMergeQueueOwner(w.db, w.config);
  projectRepo(w.config.projects.p); // scheduler snapshot warms the ordinary repository cache
  const before = reads;
  expect(plan("A").intent.taskId).toBe("A");
  expect(reads).toBe(before);
});
