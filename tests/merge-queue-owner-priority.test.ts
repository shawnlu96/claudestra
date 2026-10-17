import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { setFrozen, setMeta } from "../src/lib/ledger-write.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { readPriority, readPriorityModes } from "../src/lib/ledger-priority-read.js";
import { setPriority, setPriorityMode, setPriorityOrder } from "../src/lib/ledger-priority-write.js";
import type { PriorityBand, PriorityMode } from "../src/lib/ledger-priority-types.js";
import { claimManualMerge } from "../src/lib/manual-merge-queue.js";
import { openMergeQueueOwner } from "../src/lib/merge-queue-owner-context.js";
import type { QueueEntry } from "../src/lib/merge-queue-facts.js";
import { pickMergeQueueOwner } from "../src/lib/merge-queue-owner.js";
import { observeMergeQueueOwner } from "../src/lib/merge-queue-owner-pass.js";
import { ownerPriorityPick } from "../src/lib/merge-queue-owner-priority.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH, recoveryPolicy } from "../src/lib/recovery-policy.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import type { TrainStore } from "../src/lib/scheduler-merge-train.js";
import { SLOT_YIELD } from "../src/lib/scheduler-merge-train-hold.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs } from "./manual-merge-queue-world.test.js";

type Mode = "on" | "observe" | "off";
let w: ReclaimWorld;
afterEach(() => {
  w?.close(); setForeignRepoLookupForTest({ project: null, origin: null });
  for (const f of [RECOVERY_POLICY_PATH, SCHEDULER_CONFIG_PATH]) rmSync(f, { force: true });
});

/** Recovery keys for project p; the owner's PRIO2 band switch lives in the ledger (sortMode). */
const keys = (k: Record<string, Mode> = {}) => writeFileSync(RECOVERY_POLICY_PATH,
  JSON.stringify({ projects: { p: { keys: { manualMergeQueue: "on", manualCaseOwnership: "off", mergeDirect: "off", mergeQueueOwner: "on", ...k } } } }));
function world(k: Record<string, Mode> = {}, sort: PriorityMode = "on") {
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
  w = reclaimWorld({ store: "memory", live: true });
  setMeta(w.db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  keys(k); sortMode(sort);
}
const evidence = () => ({ ownerWords: "测试档位", ownerAt: Date.now(), sourceRef: "tests/merge-queue-owner-priority" });
let dedup = 0;
const ctx = () => ({ actor: "owner", project: "p", now: Date.now(), dedupKey: `qp-${++dedup}` });
function sortMode(mode: PriorityMode) {
  setPriorityMode(w.db, ctx(), { mechanism: "prioritySort", mode, rev: readPriorityModes(w.db, "p").prioritySort!.rev, evidence: evidence() });
}
function band(id: string, b: PriorityBand) {
  const target = { kind: "task" as const, id };
  setPriority(w.db, ctx(), { target, band: b, rev: readPriority(w.db, "p", target).rev, evidence: evidence() });
}

/** An auto card entering the queue now (its stage → merge event is its QUEUE1 place). */
function enqueue(id: string, b?: PriorityBand) {
  const card = w.card(id), repo = /github\.com\/([^/]+\/[^/]+)\//.exec(card.prRef)![1]!, remote = w.config.projects.p!.remote!;
  setForeignRepoLookupForTest({ project: () => repo });
  Object.assign(remote, { repo, roles: ["review", "write"] });
  insertEvent(w.db, { actor: "scheduler" }, { project: "p", target: id, kind: "stage", data: { from: "review", to: "merge", head: card.head, round: 1 } }, false);
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify(w.config));
  if (b) band(id, b);
}
/** A manual request entering the queue now. */
async function ask(id: string, b?: PriorityBand) {
  const r = await ledgerAs(w, "agent-pm", ...requestArgs(await manualCard(w, id)));
  expect(r.ok).toBe(true);
  if (b) band(id, b);
}
const pick = () => pickMergeQueueOwner(w.db, "p");
const claim = () => claimManualMerge(w.db, { actor: "scheduler" }, { project: "p", mode: "on", train: "none", requiredChecks: ["check"] });
const maxSeq = () => (w.db.query("SELECT MAX(seq) AS s FROM events WHERE project = 'p'").get() as { s: number }).s;
const plan = (id: string) => planIntent(w.db, { actor: "scheduler" }, { id: `qp-${id}`, taskId: id, taskRev: getTask(w.db, id)!.rev, workflowRev: 1,
  causalSeq: maxSeq(), node: "merge_deploy", action: "merge", reason: "test", resources: ["merge:p"] });
const notes = () => listEvents(w.db, { project: "p" }).filter((e) => e.data.mechanism === "mergeOwnerPriority");

test("[验收线 4] mergeOwnerPriority is registered once and defaults on", () => {
  expect(RECOVERY_KEYS.filter((k: string) => k === "mergeOwnerPriority")).toHaveLength(1);
  expect(recoveryPolicy("unconfigured-queueprio-test", "mergeOwnerPriority" as never).mode).toBe("on");
});

test("[验收线 1] real pass: a newer now manual request takes the slot ahead of an older later auto card", async () => {
  world(); enqueue("A", "later"); await ask("M", "now");
  expect(pick()).toMatchObject({ entry: { taskId: "M" }, reason: expect.stringContaining("owner 档位 now") });
  await w.pass();
  expect(w.slot()).toBe("M");
  expect(w.intentOf("A")).toBeNull();
}, 60_000);

test("[验收线 2][验收线 3] concurrent claims: the auto writer's final fence refuses, the manual claim wins once, one slot", async () => {
  world(); enqueue("A", "later"); await ask("M", "now");
  expect(() => plan("A")).toThrow(/统一合并队列：owner 档位 now.*（M 先）/);
  expect(claim()).toMatchObject({ claimed: true, taskId: "M" });
  expect(claim().claimed).toBe(false);
  expect(() => plan("A")).toThrow(/既有意图持槽/);
  expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_resources WHERE resource = 'merge:p'").get()).toEqual({ n: 1 });
  expect(w.slot()).toBe("M");
});

test("[验收线 2] a newer now auto card goes ahead of an older later manual request", async () => {
  world(); await ask("M", "later"); enqueue("A", "now");
  expect(pick().entry?.taskId).toBe("A");
  expect(claim().claimed).toBe(false);
  expect(plan("A").intent.taskId).toBe("A");
  expect(w.slot()).toBe("A");
});

test("[验收线 2] same band: the owner's explicit order first, then QUEUE1 age", () => {
  world(); enqueue("B1", "now"); enqueue("B2", "now"); enqueue("B3", "now");
  expect(pick().entry?.taskId).toBe("B1");
  setPriorityOrder(w.db, ctx(), { queue: "project", band: "now", targets: [{ kind: "task", id: "B3" }], rev: 0, evidence: evidence() });
  expect(pick()).toMatchObject({ entry: { taskId: "B3" }, reason: expect.stringContaining("now 第 1 位") });
});

test("[验收线 2][验收线 3] the slot holder and a yielded run are never overtaken by a higher band", async () => {
  world(); enqueue("OLD", "later");
  const held = await w.begin("OLD");
  enqueue("NEW", "now");
  expect(pick()).toMatchObject({ intentId: held, reason: "既有意图持槽，先结清" });
  expect(() => plan("NEW")).toThrow(/既有意图持槽/);
  const run = getMergeRun(w.db, held)!;
  expect(await w.manager("ledger", "scheduler-merge-step", held, "--from", run.phase, "--to", run.phase, "--rev", String(run.rev),
    "--receipt", `${SLOT_YIELD}测试让路`)).toMatchObject({ ok: true });
  expect(w.slot()).toBeNull();
  expect(pick()).toMatchObject({ entry: { taskId: "OLD" }, intentId: held });
  expect(() => plan("NEW")).toThrow(/OLD 先/);
}, 60_000);

/** Pure boundary: synthetic queue entries over real ledger bands. */
const entry = (taskId: string): QueueEntry => ({ repository: "o/r", project: "p", taskId, pr: null, source: "auto", head: null, specRev: 1,
  round: 1, reviewSeq: null, ui: { template: false, digest: null }, manualRequestSeq: null, versionSeq: null, state: "ready", reason: null, phase: null });
test("[验收线 2][验收线 3] repairs and admitted in-flight entries are fixed points; an inadmissible one is not", () => {
  world(); for (const [id, b] of [["R", "later"], ["X", "later"], ["Y", "later"], ["Z", "now"]] as const) { w.card(id); band(id, b); }
  const [R, X, Y, Z] = ["R", "X", "Y", "Z"].map(entry) as [QueueEntry, QueueEntry, QueueEntry, QueueEntry];
  const at = (admit: (e: QueueEntry) => boolean, repairs: string[]) =>
    ownerPriorityPick(w.db, "p", [R, X, Y, Z], admit, (e) => e === Y, new Set(repairs), Date.now()).entry?.taskId;
  expect(at(() => true, ["R"])).toBe("R");
  expect(at((e) => e !== R, ["R"])).toBe("X");
  expect(at((e) => e !== R && e !== X, ["R"])).toBe("Y");
  expect(at((e) => e !== Y, [])).toBe("Z");
});

test("[验收线 3] a live train keeps the slot for its rider even against a higher band", () => {
  world(); enqueue("A", "later"); enqueue("B", "now");
  const head = getTask(w.db, "A")!.headSHA!, now = Date.now();
  const train = { phase: "testing", startedAt: now, members: [{ taskId: "A", head }], serial: [], dropped: [], merged: [], cleared: [], bounced: [] };
  openMergeQueueOwner(w.db, w.config, recoveryPolicy, { load: () => train } as unknown as TrainStore);
  expect(pick().entry?.taskId).toBe("A");
  openMergeQueueOwner(w.db, w.config, recoveryPolicy, { load: () => { throw new Error("坏文件"); } } as unknown as TrainStore);
  expect(pick()).toMatchObject({ entry: null, reason: "列车状态不可读，不能认领" });
});

test("[验收线 3] gates still apply: a held or frozen now entry never gets the slot", async () => {
  world(); enqueue("A", "later"); await ask("M", "now");
  insertEvent(w.db, { actor: "owner" }, { project: "p", target: "M", kind: "scheduler", data: { op: "workflow", hold: "暂缓" } }, false);
  expect(pick().entry?.taskId).toBe("A");
  setFrozen(w.db, { actor: "owner" }, { project: "p", frozen: true, reason: "主线暂停" });
  expect(pick()).toMatchObject({ entry: null, reason: "没有可认领版本" });
  expect(claim().claimed).toBe(false);
  expect(w.slot()).toBeNull();
});

for (const key of ["on", "observe", "off"] as const) for (const sort of ["on", "observe", "off"] as const) {
  test(`[验收线 3][验收线 4] mergeOwnerPriority ${key} × prioritySort ${sort}`, async () => {
    world({ mergeOwnerPriority: key }, sort); enqueue("A", "later"); await ask("M", "now");
    const before = w.db.query("SELECT * FROM scheduler_intents").all();
    expect(pick().entry?.taskId).toBe(key === "on" && sort === "on" ? "M" : "A");
    await observeMergeQueueOwner(w.db, w.manager, "p", w.store);
    await observeMergeQueueOwner(w.db, w.manager, "p", w.store);
    const seen = notes();
    expect(seen).toHaveLength(key === "observe" && sort === "on" ? 1 : 0);
    if (seen[0]) expect(seen[0].data).toMatchObject({ chosen: "M", old: "A", source: "manual" });
    expect(JSON.stringify(seen)).not.toContain("测试档位");
    expect(w.db.query("SELECT * FROM scheduler_intents").all()).toEqual(before);
    expect(w.slot()).toBeNull();
  });
}

test("[验收线 4] switching the key while running takes effect on the next pick without a restart", async () => {
  world(); enqueue("A", "later"); await ask("M", "now");
  const seen: string[] = [];
  for (const mode of ["on", "off", "observe", "on"] as const) { keys({ mergeOwnerPriority: mode }); seen.push(pick().entry!.taskId); }
  expect(seen).toEqual(["M", "A", "A", "M"]);
});

test("[验收线 4] upstream switches: under mergeQueueOwner off this key changes nothing; unifiedMergeQueue off claims nothing", async () => {
  const slots: (string | null)[] = [];
  for (const key of ["on", "off"] as const) {
    w?.close(); world({ mergeQueueOwner: "off", mergeOwnerPriority: key }); await ask("M", "later"); enqueue("A", "now");
    await w.pass(); slots.push(w.slot());
  }
  expect(slots[0]).not.toBeNull();
  expect(slots[0]).toBe(slots[1]!);
  keys({ unifiedMergeQueue: "off" });
  expect(pick()).toMatchObject({ entry: null, reason: "unifiedMergeQueue 未就绪" });
}, 60_000);
