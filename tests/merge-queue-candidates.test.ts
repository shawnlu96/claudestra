/**
 * merge-arch-CAND1 integration: the real schedulerPass (train tick → mergeTick → deployTick → reclaim → manual claim → auto tick) on
 * the MTR1 world (tests/scheduler-merge-reclaim-world.ts: temporary ledger, fake GitHub) with MQ1's manual cards and PM requests
 * through the real ledger CLI. The switches are read from the test state dir's recovery-policy.json, as the pass reads them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { listEvents } from "../src/lib/ledger-store.js";
import { setFrozen, setMeta } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { bindingOf } from "../src/lib/merge-queue-candidates-member.js";
import { UNIFIED_CANDIDATES_KEY } from "../src/lib/merge-queue-candidates.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH, recoveryPolicy } from "../src/lib/recovery-policy.js";
import { setForeignRepoLookupForTest } from "../src/lib/scheduler-foreign-repo.js";
import { mergeCandidates } from "../src/lib/scheduler-merge-train-tick.js";
import { reclaimWorld, type ReclaimWorld, type WorldOpts } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs, uiAutoCard } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm";
type Mode = "on" | "observe" | "off";
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); setForeignRepoLookupForTest({ project: null }); });

const as = (actor: string, ...args: string[]) => ledgerAs(w, actor, ...args);
/** The dependency tiers on (MQ1's queue, UI1's content carry) unless a test lowers one; OWN1 off as in MQ1's own train tests. */
const policy = (mode: Mode, keys: Record<string, Mode> = {}) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys:
  { mergeQueueOwner: "off", manualMergeQueue: "on", mergeContentUi: "on", manualCaseOwnership: "off", [UNIFIED_CANDIDATES_KEY]: mode, ...keys } } } }));
function setup(mode: Mode, opts: Partial<WorldOpts> = {}, keys: Record<string, Mode> = {}) {
  w = reclaimWorld({ store: "memory", ...opts });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
  policy(mode, keys);
}
const request = async (id: string) => {
  const m = await manualCard(w, id), r = await as(PM, ...requestArgs(m));
  expect(r).toMatchObject({ ok: true, state: "queued" });
  return { ...m, seq: Number(r.request) };
};
const passes = async (n: number, until: () => boolean = () => false) => { for (let i = 0; i < n && !until(); i++) await w.pass(); };
const forms = () => w.events.filter((e) => e.kind === "form").map((e) => (e.data!.members as { taskId: string }[]).map((m) => m.taskId).sort());
const callsOf = (id: string) => w.hub.calls.filter((c) => c.endsWith(`:${id}`));
const notes = () => listEvents(w.db, { project: "p" }).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === UNIFIED_CANDIDATES_KEY);
const modeOf = (id: string) => (w.db.query("SELECT mode FROM task_workflows WHERE taskId = ?").get(id) as { mode: string }).mode;

describe("[验收线 1] on: an auto card, a ui card and a valid manual request ride one train", () => {
  test("the manual member is not voided for its mode and merges match-head through its own manual intent after the green", async () => {
    setup("on");
    w.card("A1");
    await uiAutoCard(w, "U1");
    const m = await request("M");
    w.hub.pending = true;
    await passes(2); // forms, then tests: the member checks run while CI is pending
    const s = w.store.load("p")!;
    expect(s.phase).toBe("testing");
    expect(s.members.map((x) => x.taskId).sort()).toEqual(["A1", "M", "U1"]);
    expect(s.members.map((x) => [x.taskId, bindingOf(x)]).sort()).toEqual([["A1", null], ["M", { v: 1, source: "manual", ui: false, requestSeq: m.seq }],
      ["U1", { v: 1, source: "auto", ui: true, requestSeq: null }]]);
    expect(w.intentOf("M")).toBeNull(); // nothing claimed while the train tests
    w.hub.pending = false;
    await passes(12, () => w.store.load("p")!.phase === "done");
    expect(w.store.load("p")).toMatchObject({ phase: "done", outcome: "merged" });
    expect(w.events.filter((e) => e.kind === "void")).toEqual([]);
    for (const id of ["A1", "U1", "M"]) expect(callsOf(id)).toEqual([`match-head:${id}`]); // one external merge each, no update-branch
    // the manual card merged by the manual request's own intent; no auto workflow, review dispatch or session was made up for it
    expect(w.intentOf("M")).toBe(`mmq:${m.seq}`);
    expect(w.db.query("SELECT status, node FROM scheduler_intents WHERE id = ?").get(`mmq:${m.seq}`)).toEqual({ status: "done", node: "manual_merge" });
    expect(modeOf("M")).toBe("manual");
    expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE taskId = 'M' AND action != 'merge'").get()).toEqual({ n: 0 });
    expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_sessions WHERE taskId = 'M'").get()).toEqual({ n: 0 });
    expect(w.slot()).toBeNull();
    expect(notes()).toEqual([]); // on acts, it does not record predictions
  }, 60_000);
});

describe("[验收线 2] what never boards", () => {
  /** Two auto cards always form; `bad` must stay off every train and get nothing sent. */
  async function refused(bad: string, arrange: () => Promise<void> | void) {
    setup("on");
    for (const id of ["A1", "A2"]) w.card(id);
    await arrange();
    await passes(10, () => w.store.load("p")?.phase === "done");
    expect(forms()).toEqual([["A1", "A2"]]);
    expect(callsOf(bad)).toEqual([]);
  }
  test("a manual card without a request", () => refused("M", async () => { await manualCard(w, "M"); }), 60_000);
  test("a revoked request", () => refused("M", async () => {
    const m = await request("M");
    expect(await as(PM, "manual-merge-revoke", "M", "--request", String(m.seq), "--reason", "先不合")).toMatchObject({ ok: true });
  }), 60_000);
  test("a request on a card explicitly held in manual", () => refused("M", async () => {
    await request("M");
    insertEvent(w.db, { actor: "owner", now: Date.now() }, { project: "p", target: "M", kind: "scheduler", text: "", data: { op: "workflow", mode: "manual", hold: "owner 先别合" } }, false);
  }), 60_000);
  test("a ui card without its screenshot approval", () => refused("U", () => {
    w.card("U");
    w.db.query("UPDATE task_workflows SET template = 'ui' WHERE taskId = 'U'").run();
    w.db.query("UPDATE tasks SET extra = json_set(extra, '$.screenshotsDigest', ?) WHERE id = 'U'").run("ab".repeat(32));
  }), 60_000);
  test("a requested card and a ui card in another repository", () => refused("M", async () => {
    const repo = /github\.com\/([\w.-]+\/[\w.-]+)\/pull/.exec(w.card("A3").prRef)![1]!;
    setForeignRepoLookupForTest({ project: () => repo });
    await request("M");
    w.db.query("UPDATE tasks SET pr = 'https://github.com/other/repo/pull/7' WHERE id = 'M'").run();
    await uiAutoCard(w, "U");
    w.db.query("UPDATE tasks SET pr = 'https://github.com/other/repo/pull/8' WHERE id = 'U'").run();
    w.db.query("UPDATE tasks SET stage = 'done' WHERE id = 'A3'").run();
  }), 60_000);

  test("a frozen queue boards no one, manual and ui included", async () => {
    setup("on");
    w.card("A1");
    await uiAutoCard(w, "U1");
    await request("M");
    setFrozen(w.db, { actor: "owner", now: Date.now() }, { project: "p", frozen: true, reason: "查事故" });
    await passes(4);
    expect(forms()).toEqual([]);
    expect(w.hub.calls).toEqual([]);
  }, 60_000);

  /** The change lands while formTrain awaits its first PR file read: the pick is already made, the save has not happened yet. */
  async function raced(change: () => void) {
    let fired = false;
    setup("on", { files: (n) => { if (!fired) { fired = true; change(); } return `src/${n}.ts`; } });
    w.card("A");
    await request("M");
    await passes(6, () => w.store.load("p")?.phase === "done");
    expect(fired).toBe(true);
    expect(forms().filter((f) => f.includes("M"))).toEqual([]);
  }
  test("the queue frozen during formation: the train binding M is not saved, nothing is sent", async () => {
    await raced(() => setFrozen(w.db, { actor: "owner", now: Date.now() }, { project: "p", frozen: true, reason: "查事故" }));
    expect(w.hub.calls).toEqual([]);
  }, 60_000);
  test("the switch set off during formation: no unified member is saved, M takes the old manual path", async () => {
    await raced(() => policy("off"));
    expect(callsOf("M").filter((c) => !c.startsWith("serial-merge:"))).toEqual([]);
  }, 60_000);

  test("a member whose request is revoked after boarding is never sent", async () => {
    setup("on");
    w.card("A1");
    const m = await request("M");
    w.hub.pending = true;
    await passes(1);
    expect(forms()).toEqual([["A1", "M"]]);
    expect(await as(PM, "manual-merge-revoke", "M", "--request", String(m.seq), "--reason", "撤回")).toMatchObject({ ok: true });
    w.hub.pending = false;
    await passes(10, () => w.phase("A1") === "merged");
    expect(w.events.find((e) => e.kind === "void")!.text).toMatch(/M 已离开合并队列：人工合并请求 #\d+ 已失效：请求已撤销/);
    expect(callsOf("M")).toEqual([]);
    expect(w.intentOf("M")).toBeNull();
    expect(w.phase("A1")).toBe("merged"); // the auto member went on serially
  }, 60_000);

  test("revoked after the green, its run already claimed: the run ends cancelled, the train drops it, nothing is sent", async () => {
    setup("on");
    for (const id of ["A1", "A2"]) w.card(id);
    const m = await request("M");
    w.hub.pending = true;
    await passes(1);
    w.hub.pending = false;
    await passes(8, () => w.intentOf("M") !== null); // the settling train is its turn: claimed, not yet driven
    expect(w.store.load("p")).toMatchObject({ phase: "settling" });
    expect(w.phase("M")).toBe("ready");
    expect(await as(PM, "manual-merge-revoke", "M", "--request", String(m.seq), "--reason", "撤回")).toMatchObject({ ok: true });
    await passes(12, () => w.store.load("p")!.phase === "done");
    expect(w.store.load("p")).toMatchObject({ phase: "done", outcome: "merged", dropped: ["M"] });
    expect(callsOf("M")).toEqual([]);
    expect(w.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(`mmq:${m.seq}`)).toEqual({ status: "cancelled" });
    expect(w.slot()).not.toBe("M");
  }, 60_000);
});

describe("[验收线 3] next to the existing paths", () => {
  test("planner, driver, mergeCandidates and the deploy tick: each member takes its own existing path", async () => {
    setup("on", { deploy: true });
    w.card("A1");
    await uiAutoCard(w, "U1");
    const m = await request("M");
    // mergeCandidates itself is unchanged: the train's old filter still lists the auto code card only, the auto gate's adds the ui card
    expect(mergeCandidates(w.db, "p", null).map((c) => c.taskId)).toEqual(["A1"]);
    expect(mergeCandidates(w.db, "p", { now: Date.now() }).map((c) => c.taskId).sort()).toEqual(["A1", "U1"]);
    await passes(30, () => w.phase("M") === "merged" && ["A1", "U1"].every((id) => w.hub.calls.includes(`deploy:${id}`)));
    // planner: the auto members' merge intents are the auto tick's own plans; the manual member's is the claim
    const node = (id: string) => (w.db.query("SELECT node FROM scheduler_intents WHERE id = ?").get(w.intentOf(id)!) as { node: string }).node;
    expect([node("A1"), node("U1"), node("M")]).toEqual(["merge_deploy", "merge_deploy", "manual_merge"]);
    expect(w.intentOf("M")).toBe(`mmq:${m.seq}`);
    // driver: every member went ready → merging → merged in its own run, its inspect read the PR, the train gate cleared it
    for (const id of ["A1", "U1", "M"]) {
      const phases = listEvents(w.db, { project: "p", target: id }).filter((e) => e.data.op === "merge_phase").map((e) => e.data.to);
      expect(phases.filter((p) => p === "merging" || p === "merged")).toEqual(["merging", "merged"]);
      // deploy tick: one deploy after an auto member's merge; the manual card's deploy stays PM's, as on the old manual path
      expect(callsOf(id)).toEqual(id === "M" ? ["match-head:M"] : [`match-head:${id}`, `deploy:${id}`]);
    }
    expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE action = 'merge' AND taskId IN ('A1','U1','M')").get()).toEqual({ n: 3 }); // no double claim
  }, 60_000);

  test("an all-auto train is the old train: no binding in its state, the same merges", async () => {
    setup("on");
    for (const id of ["A1", "A2"]) w.card(id);
    await passes(10, () => w.store.load("p")?.phase === "done");
    expect(forms()).toEqual([["A1", "A2"]]);
    expect(w.store.load("p")!.members.map((x) => Object.keys(x).sort())).toEqual([["files", "head", "prRef", "taskId"], ["files", "head", "prRef", "taskId"]]);
    expect(w.hub.calls).toEqual(["match-head:A1", "match-head:A2"]);
  }, 60_000);

  test("serial: a lone manual head forms no train and is claimed and merged the old way", async () => {
    setup("on");
    await request("M");
    await passes(6, () => w.phase("M") === "merged");
    expect(forms()).toEqual([]);
    expect(callsOf("M")).toEqual(["serial-merge:M"]);
  }, 60_000);

  test("a due head left out of the batch keeps the old fairness: no train forms over it, it is served first", async () => {
    setup("on", { files: (n) => (n === 3 ? [] : `src/${n}.ts`) }); // M's PR lists no files: formTrain never batches it
    for (const id of ["A1", "A2"]) w.card(id);
    await request("M");
    await passes(1);
    expect(forms()).toEqual([]); // the fence stopped A1 + A2: the due head does not ride
    expect(w.slot()).toBe("M");
    await passes(14, () => w.store.load("p")?.phase === "done");
    const at = (c: string) => w.hub.calls.indexOf(c);
    expect(callsOf("M")).toEqual(["serial-merge:M"]);
    expect(forms()).toEqual([["A1", "A2"]]); // and the auto cards are not starved after it
    expect(at("serial-merge:M")).toBeLessThan(at("match-head:A1"));
  }, 60_000);

  test("PM adds a request during a live train and revokes another: the newcomer waits for the train, nothing collides, no one starves", async () => {
    setup("on");
    w.card("A1");
    const m1 = await request("M1");
    w.hub.pending = true;
    await passes(1);
    expect(forms()).toEqual([["A1", "M1"]]);
    const m2 = await request("M2"), m3 = await request("M3"); // arrive while the train tests: neither is a member
    await passes(2);
    expect([w.intentOf("M2"), w.intentOf("M3")]).toEqual([null, null]); // the live train is not interrupted
    expect(await as(PM, "manual-merge-revoke", "M3", "--request", String(m3.seq), "--reason", "撤回")).toMatchObject({ ok: true });
    w.hub.pending = false;
    for (const id of ["A2", "A3"]) w.card(id);
    await passes(30, () => ["M2", "A2", "A3"].every((id) => w.phase(id) === "merged"));
    expect(["A1", "M1", "M2", "A2", "A3"].map((id) => w.phase(id))).toEqual(["merged", "merged", "merged", "merged", "merged"]);
    for (const id of ["A1", "M1", "M2", "A2", "A3"]) expect(callsOf(id).filter((c) => c.includes("merge") || c.includes("match-head"))).toHaveLength(1);
    expect(callsOf("M3")).toEqual([]);
    expect(callsOf("M1")).toEqual(["match-head:M1"]);
    expect(w.intentOf("M2")).toBe(`mmq:${m2.seq}`);
    expect(w.intentOf("M1")).toBe(`mmq:${m1.seq}`);
    expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE node = 'manual_merge'").get()).toEqual({ n: 2 }); // one claim per request
    expect(w.hub.calls.filter((c) => c.startsWith("failed:"))).toEqual([]);
  }, 60_000);

  test("two manual members of one train merge one after the other while an outsider waits (no owed-turn deadlock)", async () => {
    setup("on", { files: (n) => (n === 4 ? "src/1.ts" : `src/${n}.ts`) }); // X overlaps A1: an outsider of the train
    w.card("A1");
    await request("M1"); await request("M2");
    w.card("X");
    await passes(24, () => w.phase("X") === "merged");
    expect(forms()[0]).toEqual(["A1", "M1", "M2"]);
    expect([callsOf("M1"), callsOf("M2")]).toEqual([["match-head:M1"], ["match-head:M2"]]);
    expect(w.phase("X")).toBe("merged");
  }, 60_000);
});

describe("[验收线 4] observe and off leave the old trail; observe records the prediction", () => {
  /** The scenario of 验收线 1 plus a second auto card and a manual card without a request, fresh cards arriving later. */
  async function trail(mode: Mode) {
    setup(mode);
    for (const id of ["A1", "A2"]) w.card(id);
    await uiAutoCard(w, "U1");
    await request("M");
    await manualCard(w, "N");
    await passes(8);
    for (const id of ["A3", "A4"]) w.card(id);
    await passes(10);
    const intents = w.db.query("SELECT taskId, node, status FROM scheduler_intents WHERE action = 'merge' ORDER BY taskId").all();
    const out = { calls: [...w.hub.calls], forms: forms(), intents, events: w.events.filter((e) => e.kind !== "hold").map((e) => e.kind), notes: notes() };
    w.close(); rmSync(RECOVERY_POLICY_PATH, { force: true });
    return out;
  }

  test("same GitHub calls, trains, intents; observe alone has the candidate, rejection and right-of-way notes", async () => {
    const off = await trail("off"), observe = await trail("observe"), on = await trail("on");
    expect(observe.calls).toEqual(off.calls);
    expect(observe.forms).toEqual(off.forms);
    expect(observe.intents).toEqual(off.intents);
    expect(observe.events).toEqual(off.events);
    expect(off.forms.flat()).not.toContain("M"); // the old path: no train carries the manual or the ui card
    expect(off.forms.flat()).not.toContain("U1");
    expect(off.calls).toContain("serial-merge:M");
    expect(off.notes).toEqual([]);
    const cls = (c: string) => observe.notes.filter((e) => e.data.class === c);
    expect(cls("ui").map((e) => e.target)).toEqual(["U1"]);
    expect(cls("manual")).toMatchObject([{ target: "M", data: { requestSeq: expect.any(Number) } }]);
    expect(cls("rejected")).toMatchObject([{ target: "N", data: { code: "manual_no_request" } }]);
    // the batch on would form, and that the due manual head rides it instead of fencing it
    expect(cls("batch").length).toBeGreaterThanOrEqual(1);
    const batch = cls("batch")[0]!.data as { members: { taskId: string }[]; headRides: boolean; wouldForm: boolean };
    expect(batch.members.map((m) => m.taskId).sort()).toEqual(["A1", "A2", "M", "U1"]);
    expect(batch).toMatchObject({ headRides: true, wouldForm: true });
    expect(new Set(observe.notes.map((e) => e.dedupKey)).size).toBe(observe.notes.length); // one note per fact, however many passes
    // and on really does what observe predicted
    expect(on.forms[0]).toEqual(["A1", "A2", "M", "U1"]);
    expect(on.notes).toEqual([]);
  }, 120_000);

  test("unset = observe; a tier below on sends that class down the old path without a note", async () => {
    expect(recoveryPolicy("p", UNIFIED_CANDIDATES_KEY).mode).toBe("observe");
    setup("observe", {}, { manualMergeQueue: "observe", mergeContentUi: "observe" });
    w.card("A1");
    await uiAutoCard(w, "U1");
    await manualCard(w, "M");
    await passes(3);
    expect(notes()).toEqual([]);
  }, 60_000);

  for (const next of ["observe", "off"] as const) {
    test(`on → ${next} with a live train: its manual and ui members keep the protocol they boarded under, no new unified candidate boards`, async () => {
      setup("on");
      w.card("A1");
      await uiAutoCard(w, "U1");
      const m = await request("M");
      w.hub.pending = true;
      await passes(1);
      expect(forms()).toEqual([["A1", "M", "U1"]]);
      policy(next);
      await passes(2); // the old rule would void here: "流程改为 manual"
      expect(w.events.filter((e) => e.kind === "void")).toEqual([]);
      w.hub.pending = false;
      w.card("A2"); await request("M2"); await uiAutoCard(w, "U2");
      await passes(24, () => w.phase("M2") === "merged" && w.phase("U2") === "merged");
      expect(w.events.filter((e) => e.kind === "void")).toEqual([]);
      expect(callsOf("M")).toEqual(["match-head:M"]);
      expect(callsOf("U1")).toEqual(["match-head:U1"]);
      expect(w.intentOf("M")).toBe(`mmq:${m.seq}`);
      expect(forms().slice(1).flat().filter((id) => id === "M2" || id === "U2")).toEqual([]); // back on the old candidates
      expect([w.phase("M2"), w.phase("U2")]).toEqual(["merged", "merged"]); // and still served, the old way
    }, 60_000);
  }
});

describe("[验收线 5] the switch", () => {
  test("its key is registered exactly once", () => {
    expect(RECOVERY_KEYS.filter((k) => k === UNIFIED_CANDIDATES_KEY)).toHaveLength(1);
  });
});
