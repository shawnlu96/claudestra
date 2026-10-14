/**
 * merge-arch-CAND1 unit side: the pick and its dependency tiers, the member protocol saved at boarding (memberCheck, ridingRequests,
 * the forming save), the dry-run batch, and the thin wiring of the fence / blocks / claim, on the MTR1 world's ledger without a pass.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { getTask } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { claimManualMerge, manualTurn } from "../src/lib/manual-merge-queue.js";
import { manualMergeGate } from "../src/lib/manual-merge-queue-pass.js";
import { headMayRide, unifiedCandidatesMode, unifiedPick, UNIFIED_CANDIDATES_KEY, type UnifiedCaps } from "../src/lib/merge-queue-candidates.js";
import { bindingOf, formingCarries, formingSave, memberCheck, predictBatch, ridingRequests, unifiedTrainCandidates, type UnifiedCandidate }
  from "../src/lib/merge-queue-candidates-member.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import type { TrainCandidate, TrainState } from "../src/lib/scheduler-merge-train.js";
import { memberStatusOf, mergeCandidates } from "../src/lib/scheduler-merge-train-tick.js";
import { memoryTrainStore, reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs, uiAutoCard } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm", ALL: UnifiedCaps = { queue: () => true, ui: () => true, manual: () => true };
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

function setup() {
  w = reclaimWorld({ store: "memory" });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
}
const request = async (id: string) => {
  const m = await manualCard(w, id), r = await ledgerAs(w, PM, ...requestArgs(m));
  expect(r).toMatchObject({ ok: true, state: "queued" });
  return { ...m, seq: Number(r.request) };
};
/** Every key at `mode` except the ones named. */
const port = (mode: RecoveryMode, keys: Record<string, RecoveryMode> = {}): RecoveryPolicyPort =>
  (_p, k) => ({ mode: keys[k] ?? mode, manualAfterMs: null, source: "config" });
const pick = (caps: Partial<UnifiedCaps> = {}, ports = {}) => unifiedPick(w.db, "p", Date.now(), mergeCandidates(w.db, "p", null), { ...ALL, ...caps }, ports);
const ids = (cs: readonly TrainCandidate[]) => cs.map((c) => c.taskId).sort();
const train = (members: (TrainCandidate & { files?: string[] })[], over: Partial<TrainState> = {}): TrainState => ({ v: 1, id: "t1", seq: 1, project: "p",
  repo: "example/x", base: "0".repeat(40), phase: "settling", outcome: null, reason: null, members: members.map((m) => ({ files: [], ...m })), cars: [],
  cleared: members.map((m) => m.taskId), merged: [], bounced: [], serial: [], dropped: [], ciRuns: 1, startedAt: Date.now(), updatedAt: Date.now(), skip: [], ...over });
const manualMember = (m: { taskId: string; prRef: string; head: string; seq: number }): UnifiedCandidate =>
  ({ taskId: m.taskId, prRef: m.prRef, head: m.head, unified: { v: 1, source: "manual", ui: false, requestSeq: m.seq } });

describe("[验收线 5] the switch", () => {
  test("off / observe / on through the policy port; a read that throws is off", () => {
    for (const m of ["off", "observe", "on"] as const) expect(unifiedCandidatesMode("p", port(m))).toBe(m);
    expect(unifiedCandidatesMode("p", () => { throw new Error("坏文件"); })).toBe("off");
    expect(unifiedCandidatesMode("p", port("on", { [UNIFIED_CANDIDATES_KEY]: "observe" }))).toBe("observe");
  });
});

describe("[验收线 2] the pick", () => {
  test("auto + accepted ui + valid request are candidates, each bound to what it boarded as; the rest is rejected with QUEUE1's reason", async () => {
    setup();
    w.card("A");
    await uiAutoCard(w, "U");
    const m = await request("M");
    await manualCard(w, "N");
    const r = pick();
    expect(ids(r.candidates)).toEqual(["A", "M", "U"]);
    const by = Object.fromEntries(r.candidates.map((c) => [c.taskId, bindingOf(c)]));
    expect(by).toEqual({ A: null, U: { v: 1, source: "auto", ui: true, requestSeq: null }, M: { v: 1, source: "manual", ui: false, requestSeq: m.seq } });
    expect(r.candidates.find((c) => c.taskId === "M")).toMatchObject({ head: m.head, prRef: m.prRef });
    expect(r.rejected).toMatchObject([{ taskId: "N", code: "manual_no_request" }]);
  });

  test("shared-ledger skip and another repository exclude ui and manual cards", async () => {
    setup();
    w.card("A");
    await uiAutoCard(w, "U");
    await request("M");
    const skip = pick({}, { skip: (_db: unknown, id: string) => id !== "A" });
    expect(ids(skip.candidates)).toEqual(["A"]);
    expect(skip.rejected.map((x) => [x.taskId, x.code]).sort()).toEqual([["M", "shared_ledger_skip"], ["U", "shared_ledger_skip"]]);
    const foreign = pick({}, { repo: () => "other/repo" });
    expect(ids(foreign.candidates)).toEqual(["A"]); // the old filter's own list is passed through, never re-judged here
    expect(foreign.rejected.map((x) => [x.taskId, x.code]).sort()).toEqual([["M", "foreign_repo"], ["U", "foreign_repo"]]);
  });

  test("dependency tiers: a class below its tier keeps the old path (not a candidate, not a rejection)", async () => {
    setup();
    w.card("A");
    await uiAutoCard(w, "U");
    await request("M");
    expect(pick({ ui: () => false })).toMatchObject({ candidates: [{ taskId: "M" }, { taskId: "A" }], rejected: [] });
    expect(ids(pick({ manual: () => false }).candidates)).toEqual(["A", "U"]);
    expect(pick({ queue: () => false })).toEqual({ candidates: mergeCandidates(w.db, "p", null), rejected: [] });
  });

  test("outside a pass that opened the ports the tick gets the old candidates untouched", () => {
    setup();
    const old = [w.card("A")];
    expect(unifiedTrainCandidates(w.db, "p", old, Date.now())).toEqual(old);
  });
});

describe("[验收线 1] the member protocol saved at boarding", () => {
  test("a manual member is judged by its request, not by mode = auto; an unbound manual card is gone as before", async () => {
    setup(); writePolicyOn();
    const m = await request("M"), s = train([manualMember(m)]), now = Date.now();
    expect(memberStatusOf(w.db, "M", m.head)).toEqual({ kind: "gone", why: "流程改为 manual" }); // the old rule alone
    expect(memberStatusOf(w.db, "M", m.head, memberCheck(w.db, s, "M", m.head, now))).toEqual({ kind: "waiting" });
    expect(memberCheck(w.db, null, "M", m.head, now)).toBeNull();
    expect(memberCheck(w.db, train([{ taskId: "M", prRef: m.prRef, head: m.head }]), "M", m.head, now)).toBeNull(); // no binding: old rule
    rmSync(RECOVERY_POLICY_PATH, { force: true }); // manualMergeQueue back to its default observe: nobody would claim the member
    expect(memberStatusOf(w.db, "M", m.head, memberCheck(w.db, s, "M", m.head, now))).toEqual({ kind: "gone", why: `人工合并排队策略已是 observe，请求 #${m.seq} 不会被认领` });
    writePolicyOn();
    expect(await ledgerAs(w, PM, "manual-merge-revoke", "M", "--request", String(m.seq), "--reason", "撤回")).toMatchObject({ ok: true });
    expect(memberStatusOf(w.db, "M", m.head, memberCheck(w.db, s, "M", m.head, now))).toEqual({ kind: "gone", why: `人工合并请求 #${m.seq} 已失效：请求已撤销` });
  });

  test("a ui member keeps mode = auto and re-reads the screenshot gate", async () => {
    setup();
    const u = await uiAutoCard(w, "U"), now = Date.now();
    const s = train([{ ...u, unified: { v: 1, source: "auto", ui: true, requestSeq: null } } as UnifiedCandidate]);
    const check = () => memberStatusOf(w.db, "U", u.head, memberCheck(w.db, s, "U", u.head, now));
    expect(check()).toEqual({ kind: "waiting" });
    w.db.query("UPDATE tasks SET extra = json_set(extra, '$.screenshotsDigest', ?) WHERE id = 'U'").run("cd".repeat(32)); // new screenshots, not approved
    expect(check()).toMatchObject({ kind: "gone", why: expect.stringMatching(/^UI 验收：/) });
    w.db.query("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'U'").run();
    expect(check()).toEqual({ kind: "gone", why: "流程改为 manual" });
  });

  test("the forming save carries its train; a wrapper that passes the closure on keeps it", async () => {
    setup();
    const m = await request("M"), s = train([manualMember(m)]);
    let saved = 0;
    const save = formingSave(s, () => { saved++; }), wrapped = ((f: () => void) => f)(save);
    expect([formingCarries(wrapped, m.seq), formingCarries(wrapped, m.seq + 1), formingCarries(() => {}, m.seq)]).toEqual([true, false, false]);
    save();
    expect(saved).toBe(1);
  });

  test("ridingRequests: only a settling train's cleared (or pinned) bound members; an unreadable train file rides no one", async () => {
    setup();
    const m = await request("M"), mem = memoryTrainStore();
    const riding = () => [...ridingRequests(w.db, "p", () => mem.store)];
    expect(riding()).toEqual([]);
    mem.store.save(train([manualMember(m)], { phase: "testing", cleared: [] }));
    expect(riding()).toEqual([]);
    mem.store.save(train([manualMember(m)]));
    expect(riding()).toEqual([m.seq]);
    mem.store.save(train([manualMember(m)], { cleared: [] }));
    expect(riding()).toEqual([]);
    mem.store.save(train([manualMember(m)], { cleared: [], bounced: [{ taskId: "M", head: m.head, receipt: "r" }] }));
    expect(riding()).toEqual([m.seq]);
    mem.store.save(train([manualMember(m)], { merged: [{ taskId: "M", sha: "1".repeat(40) }] }));
    expect(riding()).toEqual([]);
    expect([...ridingRequests(w.db, "p", () => ({ ...mem.store, load: () => { throw new Error("坏文件"); } }))]).toEqual([]);
  });
});

describe("[验收线 4] the dry-run batch is formTrain's own", () => {
  const cand = (n: number): TrainCandidate => ({ taskId: `C${n}`, prRef: `https://github.com/example/dry/pull/${n}`, head: n.toString(16).padStart(40, "0") });
  test("same upper and lower limits, same file-conflict pick, bindings kept, nothing saved anywhere", async () => {
    const files = async (c: TrainCandidate) => [c.taskId === "C3" ? "src/C1.ts" : `src/${c.taskId}.ts`];
    const eight = [1, 2, 3, 4, 5, 6, 7, 8].map(cand);
    expect((await predictBatch("p", eight, files, [], Date.now)).map((m) => m.taskId)).toEqual(["C1", "C2", "C4", "C5", "C6", "C7"]); // max 6, C3 overlaps C1
    expect(await predictBatch("p", [cand(1)], files, [], Date.now)).toEqual([]); // fewer than two: no train
    expect(await predictBatch("p", [cand(1), cand(3)], files, [], Date.now)).toEqual([]);
    const bound = { ...cand(2), unified: { v: 1, source: "manual", ui: false, requestSeq: 9 } } as UnifiedCandidate;
    expect((await predictBatch("p", [cand(1), bound], files, [], Date.now)).map(bindingOf)).toEqual([null, bound.unified!]);
    expect((await predictBatch("p", eight, files, [`C2:${cand(2).head}`], Date.now)).map((m) => m.taskId)).not.toContain("C2"); // the last train's skip list
  });
});

describe("[验收线 3] fence, blocks and claim", () => {
  const ON = port("on");
  test("blocks: a due head that is a candidate lets the tick try under on; observe / off keep the old answer", async () => {
    setup();
    await request("M");
    const mem = memoryTrainStore();
    expect(manualMergeGate(w.db, mem.store, ON).blocks("p")).toBe(false);
    expect(manualMergeGate(w.db, mem.store, port("on", { [UNIFIED_CANDIDATES_KEY]: "observe" })).blocks("p")).toBe(true);
    expect(manualMergeGate(w.db, mem.store, port("on", { [UNIFIED_CANDIDATES_KEY]: "off" })).blocks("p")).toBe(true);
    const turn = manualTurn(w.db, "p", "none", Date.now());
    expect(headMayRide(w.db, "p", turn, Date.now(), ON)).toBe(true);
    expect(headMayRide(w.db, "p", { kind: "none" }, Date.now(), ON)).toBe(false);
  });

  test("formFence: the due head riding the forming train does not stop it; a train without it is still fenced", async () => {
    setup();
    const m = await request("M"), gate = manualMergeGate(w.db, memoryTrainStore().store, ON);
    let saved = 0;
    gate.formFence("p", formingSave(train([manualMember(m)], { phase: "testing" }), () => { saved++; }));
    expect(saved).toBe(1);
    expect(() => gate.formFence("p", formingSave(train([], { phase: "testing" }), () => { saved++; }))).toThrow(/人工合并队首已到期/);
    expect(() => gate.formFence("p", () => { saved++; })).toThrow(/人工合并队首已到期/); // the old call shape: fenced as before
    expect(saved).toBe(1);
  });

  test("claim: a riding member takes its turn under a holding train and past an owed auto turn, once; a non-member still waits", async () => {
    setup();
    const m1 = await request("M1"), m2 = await request("M2"), mem = memoryTrainStore(), now = Date.now();
    manualMergeGate(w.db, mem.store, ON); // the pass opens the store for this ledger: the claim's own connection finds it by file
    mem.store.save(train([manualMember(m2)]));
    expect(manualTurn(w.db, "p", "holds", now)).toMatchObject({ kind: "due", req: { seq: m2.seq }, wait: null }); // M2 rides; M1, ahead of it, is no member
    const ctx = { actor: "scheduler", now };
    const claim = () => claimManualMerge(w.db, ctx, { project: "p", mode: "on", train: "holds", requiredChecks: ["check"] });
    writePolicyOn();
    expect(claim()).toMatchObject({ claimed: true, taskId: "M2", intentId: `mmq:${m2.seq}` });
    expect(claim()).toMatchObject({ claimed: false, turn: "active" }); // never a second claim while it runs
    expect(getTask(w.db, "M1")!.stage).toBe("merge");
    expect(w.intentOf("M1")).toBeNull();
    mem.store.save(train([manualMember(m2)], { merged: [{ taskId: "M2", sha: "1".repeat(40) }] }));
    w.db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?").run(`mmq:${m2.seq}`);
    w.db.query("DELETE FROM scheduler_resources").run();
    expect(manualTurn(w.db, "p", "holds", now)).toMatchObject({ kind: "due", req: { seq: m1.seq }, wait: expect.stringMatching(/不打断活车/) });
  });
});

/** The claim re-reads manualMergeQueue from the policy file inside its transaction. */
function writePolicyOn() {
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { manualMergeQueue: "on", manualCaseOwnership: "off" } } } }));
}
