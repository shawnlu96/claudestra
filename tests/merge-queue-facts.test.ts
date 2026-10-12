/**
 * merge-arch-QUEUE1: the unified read-only merge queue (src/lib/merge-queue-facts.ts) on the real ledger of the MTR1 world
 * (tests/scheduler-merge-reclaim-world.ts) with manual cards and requests made through the real ledger CLI
 * (tests/manual-merge-queue-world.test.ts). Ports for handoff / shared-ledger skip / project repository are injected.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { setFrozen, setMeta, setTask } from "../src/lib/ledger-write.js";
import { mergeQueue, mergeQueueCards, unifiedMergeQueue } from "../src/lib/ledger-merge-queue-view.js";
import { claimManualMerge, manualQueueView } from "../src/lib/manual-merge-queue.js";
import {
  mergeQueueFacts, queueEventFields, queueEventKey, QUEUE_EVENT_KINDS, unifiedQueueMode, versionSeqOf, type QueueEntry, type QueueFactsPorts,
} from "../src/lib/merge-queue-facts.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { advanceMergeRun, getMergeRun } from "../src/lib/scheduler-merge.js";
import { mergeCandidates } from "../src/lib/scheduler-merge-train-tick.js";
import { wipGateDepth } from "../src/lib/scheduler-wip-gate-config.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs, uiAutoCard, writePolicy } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm", DISP = "agent-disp";
const PORTS: QueueFactsPorts = { handoff: () => false, skip: () => false, repo: () => null };
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

function setup() {
  w = reclaimWorld({ store: "memory" });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM, DISP] });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "team", value: { dispatcher: DISP, audit: true } });
  writePolicy("on");
}

const facts = (ports: QueueFactsPorts = PORTS) => mergeQueueFacts(w.db, "p", Date.now(), ports);
const of = (id: string, list = facts()) => list.find((e) => e.taskId === id)!;
const order = (list = facts()) => list.map((e) => `${e.source}:${e.taskId}`);
const sha = (c: string) => c.repeat(40);
/** The `review → merge` stage event the review CLI / auto gate write; world.card puts the row in merge without one. */
const enter = (id: string) => insertEvent(w.db, { actor: "scheduler", now: Date.now() }, { project: "p", target: id, kind: "stage", text: "",
  data: { from: "review", to: "merge", round: 1, specRev: 1 } }, false).seq;
/** An auto card in merge with its entry event: the world's reviewed card + `stage → merge`. */
const auto = (id: string) => { const c = w.card(id); return { ...c, entry: enter(id) }; };
const request = async (c: { taskId: string; head: string; reviewSeq: number }) => {
  const r = await ledgerAs(w, PM, ...requestArgs(c));
  if (r.ok !== true) throw new Error(String(r.error));
  return Number(r.request);
};
/** The scheduler's update-branch carry (scheduler-merge.ts carryReview): event + head move; `digest` null = an old record without one. */
function carry(id: string, to: string, digest: string | null = "d".repeat(64), o: { actor?: string; round?: number } = {}) {
  const from = getTask(w.db, id)!.headSHA!;
  const seq = insertEvent(w.db, { actor: o.actor ?? "scheduler", now: Date.now() }, { project: "p", target: id, kind: "scheduler", text: "carry",
    data: { op: "review_carry", intentId: `merge-${id}`, from, to, round: o.round ?? 1, specRev: 1, ...(digest ? { diffHash: digest } : {}) } }, false).seq;
  w.db.query("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = ?").run(to, id);
  return seq;
}
/** A hand / author `set` of the card's head: real content changed. */
function setHead(id: string, to: string) {
  const seq = insertEvent(w.db, { actor: PM, now: Date.now() }, { project: "p", target: id, kind: "task", text: "", data: { op: "set", patch: { headSHA: to } } }, false).seq;
  w.db.query("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = ?").run(to, id);
  return seq;
}
/** Every table a read must not touch, as one comparable snapshot. */
const ledgerState = () => ["events", "scheduler_intents", "scheduler_resources", "scheduler_merges", "tasks", "asks"].map((t) =>
  JSON.stringify(w.db.query(`SELECT * FROM ${t} ORDER BY rowid`).all()));
const notReady = (e: QueueEntry) => expect(e.state === "ready" || e.state === "running").toBe(false);

describe("[验收线 1] one stable order over auto / manual / ui by the version's queue seq", () => {
  test("mixed sources sort by versionSeq; updatedAt and read order do not move a place", async () => {
    setup();
    const a = auto("A");
    const m = await manualCard(w, "M");
    const mReq = await request(m);
    await uiAutoCard(w, "U");
    const u = enter("U");
    const b = auto("B");
    const list = facts();
    expect(order(list)).toEqual(["auto:A", "manual:M", "auto:U", "auto:B"]);
    expect(list.map((e) => e.versionSeq)).toEqual([a.entry, mReq, u, b.entry]);
    expect(of("M", list)).toMatchObject({ source: "manual", state: "ready", manualRequestSeq: mReq, reviewSeq: m.reviewSeq, head: m.head });
    expect(of("U", list)).toMatchObject({ source: "auto", ui: { template: true, digest: "ab".repeat(32) } });
    expect(of("A", list)).toMatchObject({ source: "auto", state: "ready", head: a.head, reviewSeq: expect.any(Number) });
    // the train / auto filter orders by updatedAt; turning it around changes that order, never this one
    w.db.query("UPDATE tasks SET updatedAt = 10 WHERE id = 'B'").run();
    w.db.query("UPDATE tasks SET updatedAt = 99999999999999 WHERE id = 'A'").run();
    expect(mergeCandidates(w.db, "p", null).map((c) => c.taskId)[0]).toBe("B");
    expect(facts()).toEqual(list);
    expect(facts()).toEqual(list); // a second read (a new pass, any cursor) answers the same
  });

  test("a trusted scheduler carry keeps the place; a carry without digest, another round or a hand head move re-queues", () => {
    setup();
    const a = auto("A"), b = auto("B"), c = auto("C"), d = auto("D");
    carry("A", sha("1"));
    carry("A", sha("2")); // a chain of trusted carries still leads back to the entry
    expect(of("A").versionSeq).toBe(a.entry);
    const old = carry("B", sha("3"), null);
    const forged = carry("C", sha("4"), "e".repeat(64), { actor: "agent-author" });
    const moved = setHead("D", sha("5"));
    const list = facts();
    expect(list.map((e) => [e.taskId, e.versionSeq])).toEqual([["A", a.entry], ["B", old], ["C", forged], ["D", moved]]);
    expect([b.entry, c.entry, d.entry].every((s) => s < old)).toBe(true);
    // after a trusted carry, a real change re-queues; a trusted carry on top of it keeps the new place
    const real = setHead("A", sha("6"));
    carry("A", sha("7"));
    expect(of("A").versionSeq).toBe(real);
    expect(order().at(-1)).toBe("auto:A");
    // a carry recorded for another round is not this round's: conservative
    const other = carry("B", sha("8"), "f".repeat(64), { round: 2 });
    expect(of("B").versionSeq).toBe(other);
  });

  test("versionSeqOf: no entry event = no place; a carry before the entry does not count", () => {
    setup();
    w.card("N");
    expect(of("N").versionSeq).toBeNull();
    carry("N", sha("1"), null);
    const entry = enter("N");
    expect(versionSeqOf(getTask(w.db, "N")!, listEvents(w.db, { project: "p", target: "N" }), entry)).toBe(entry);
    auto("Z");
    w.card("Y"); // unplaced entries go after every placed one
    expect(order().slice(-1)).toEqual(["auto:Y"]);
  });

  test("a real setTask repeating the current head keeps the place; a real setTask to a new head re-queues (round 1 review)", () => {
    setup();
    const a = auto("A"), b = auto("B");
    const cur = getTask(w.db, "A")!;
    setTask(w.db, { actor: PM, now: Date.now() }, { id: "A", rev: cur.rev, patch: { headSHA: cur.headSHA!, title: "metadata only" } });
    expect(facts().map((e) => [e.taskId, e.versionSeq])).toEqual([["A", a.entry], ["B", b.entry]]);
    const moved = setTask(w.db, { actor: PM, now: Date.now() }, { id: "A", rev: getTask(w.db, "A")!.rev, patch: { headSHA: sha("9") } }).event.seq;
    expect(facts().map((e) => [e.taskId, e.versionSeq])).toEqual([["B", b.entry], ["A", moved]]);
  });
});

describe("[验收线 2] manual and blocked reasons, never an action", () => {
  test("no request, revoke, hold, stale review, duplicate request: each its reason, none ready", async () => {
    setup();
    await manualCard(w, "N");
    expect(of("N")).toMatchObject({ source: "manual", state: "blocked", versionSeq: null, manualRequestSeq: null, reason: { code: "manual_no_request" } });
    const r = await manualCard(w, "R");
    const rSeq = await request(r);
    expect((await ledgerAs(w, PM, "manual-merge-revoke", "R", "--request", String(rSeq), "--reason", "先不合")).ok).toBe(true);
    expect(of("R")).toMatchObject({ state: "excluded", manualRequestSeq: rSeq, reason: { code: "withdrawn", why: "先不合" } });
    const h = await manualCard(w, "H");
    const hSeq = await request(h);
    insertEvent(w.db, { actor: "owner", now: Date.now() }, { project: "p", target: "H", kind: "scheduler", text: "", data: { op: "workflow", mode: "manual", hold: "owner 先别合" } }, false);
    expect(of("H")).toMatchObject({ state: "blocked", manualRequestSeq: hSeq, versionSeq: hSeq, reason: { code: "owner_hold" } });
    const s = await manualCard(w, "S");
    const sSeq = await request(s);
    insertEvent(w.db, { actor: "agent-review", now: Date.now() }, { project: "p", target: "S", kind: "review", text: "", data: { round: 1, head: s.head,
      verdict: "pass", reviewer: "agent-review", reviewerSessionId: "rs-S2", reviewerFamily: "codex", path: "r2.md", findings: [], p0: 0, p1: 0, p2: 0 } }, false);
    expect(of("S")).toMatchObject({ state: "excluded", manualRequestSeq: sSeq, reviewSeq: s.reviewSeq, reason: { code: "manual_void", why: expect.stringMatching(/审查结论已换成/) } });
    const d = await manualCard(w, "D");
    const first = await request(d);
    // the CLI answers a second identical request with the first one; a raw duplicate row (hand-written / replayed) gets no place
    expect(await ledgerAs(w, PM, ...requestArgs(d))).toMatchObject({ ok: true, duplicate: true });
    const ev = listEvents(w.db, { project: "p", target: "D" }).find((e) => e.seq === first)!;
    const dup = insertEvent(w.db, { actor: PM, now: Date.now() }, { project: "p", target: "D", kind: "decision", text: ev.text, data: ev.data }, false).seq;
    const ds = facts().filter((e) => e.taskId === "D");
    expect(ds.map((e) => [e.manualRequestSeq, e.state, e.reason?.code ?? null])).toEqual([[first, "ready", null], [dup, "excluded", "duplicate_request"]]);
    for (const e of facts().filter((x) => x.taskId !== "D")) notReady(e);
  });

  test("freeze, unknown merge run, missing evidence, handoff, foreign repo, shared-ledger skip, landed", async () => {
    setup();
    const m = await manualCard(w, "M");
    await request(m);
    auto("A"); auto("K"); auto("E"); auto("L");
    setFrozen(w.db, { actor: "owner", now: Date.now() }, { project: "p", frozen: true, reason: "查事故" });
    for (const id of ["M", "A"]) expect(of(id)).toMatchObject({ state: "blocked", reason: { code: "frozen", why: expect.stringMatching(/查事故/) } });
    setFrozen(w.db, { actor: "owner", now: Date.now() }, { project: "p", frozen: false });
    const intent = await w.begin("K");
    expect(of("K")).toMatchObject({ state: "running", phase: expect.any(String) });
    w.db.query("UPDATE scheduler_intents SET status = 'unknown' WHERE id = ?").run(intent);
    w.db.query("DELETE FROM scheduler_resources WHERE intentId = ?").run(intent); // free the slot for the next run of this fixture
    expect(of("K")).toMatchObject({ state: "blocked", reason: { code: "unknown_run" } });
    w.db.query("UPDATE tasks SET pr = NULL WHERE id = 'E'").run();
    expect(of("E")).toMatchObject({ state: "blocked", reason: { code: "missing_evidence" } });
    const l = await w.begin("L");
    w.db.query("UPDATE scheduler_merges SET phase = 'merged' WHERE intentId = ?").run(l);
    w.db.query("UPDATE scheduler_intents SET status = 'done' WHERE id = ?").run(l);
    expect(of("L")).toMatchObject({ state: "excluded", reason: { code: "landed" } });
    expect(facts({ ...PORTS, handoff: () => true }).filter((e) => e.taskId === "A" || e.taskId === "M").map((e) => e.reason?.code)).toEqual(["merge_handoff", "merge_handoff"]);
    expect(of("A", facts({ ...PORTS, repo: () => "other/repo" }))).toMatchObject({ state: "excluded", reason: { code: "foreign_repo" } });
    expect(of("A", facts({ ...PORTS, repo: () => null }))).toMatchObject({ state: "ready", repository: expect.stringMatching(/^example\/mtr1-\d+$/) });
    expect(of("M", facts({ ...PORTS, skip: (_db, id) => id === "M" }))).toMatchObject({ state: "excluded", reason: { code: "shared_ledger_skip" } });
  });

  test("an auto card the auto gate does not list is blocked, not ready (P1 review)", () => {
    setup();
    auto("P");
    insertEvent(w.db, { actor: "agent-review", now: Date.now() }, { project: "p", target: "P", kind: "review", text: "", data: { round: 1, head: getTask(w.db, "P")!.headSHA,
      verdict: "changes", reviewer: "agent-review", reviewerSessionId: "rs-P", reviewerFamily: "codex", path: "r.md", p0: 0, p1: 1, p2: 0,
      findings: [{ findingId: "f1", severity: "P1", title: "x", basis: "spec", file: "a.ts", line: 1 }] } }, false);
    expect(of("P")).toMatchObject({ state: "blocked", reason: { code: "not_candidate" } });
  });
});

describe("[验收线 3] coexists: pure read, old paths unchanged", () => {
  test("reading writes nothing; the old merge-queue rows, manual view and candidates read the same before and after", async () => {
    setup();
    auto("A");
    const m = await manualCard(w, "M");
    await request(m);
    await manualCard(w, "N");
    const now = Date.now();
    const before = ledgerState();
    const old = [JSON.stringify(mergeQueue(w.db, "p", now)), JSON.stringify(manualQueueView(w.db, "p", "none", now)), JSON.stringify(mergeCandidates(w.db, "p", { now }))];
    const u = unifiedMergeQueue(w.db, "p", now);
    expect(u.map((e) => e.taskId)).toEqual(["A", "M", "N"]);
    facts();
    expect(ledgerState()).toEqual(before);
    expect([JSON.stringify(mergeQueue(w.db, "p", now)), JSON.stringify(manualQueueView(w.db, "p", "none", now)), JSON.stringify(mergeCandidates(w.db, "p", { now }))]).toEqual(old);
    expect(mergeQueue(w.db, "p", now).map((r) => Object.keys(r).sort())).toEqual([["blocked", "enteredAt", "phase", "task", "waitedMin"]]);
  });
});

describe("[验收线 4] WIP depth keeps its measure; merged-awaiting-deploy is not waiting", () => {
  test("wipGateDepth is still mergeQueueCards (blocked auto cards counted, manual requests not), not the ready count", async () => {
    setup();
    auto("A"); auto("B"); auto("L");
    const m = await manualCard(w, "M");
    await request(m);
    w.db.query("UPDATE tasks SET pr = NULL WHERE id = 'B'").run();
    const l = await w.begin("L");
    w.db.query("UPDATE scheduler_merges SET phase = 'merged' WHERE intentId = ?").run(l);
    w.db.query("UPDATE scheduler_intents SET status = 'done' WHERE id = ?").run(l);
    const depth = wipGateDepth(w.db, "p");
    expect(depth).toBe(mergeQueueCards(w.db, "p").length);
    const list = facts();
    const ready = list.filter((e) => e.state === "ready").map((e) => e.taskId);
    expect(ready).toEqual(["A", "M"]);
    expect(depth).not.toBe(ready.length);
    expect(of("L", list)).toMatchObject({ state: "excluded", reason: { code: "landed" } });
  });

  test("a claimed manual request whose run reached merged is excluded as landed, not running (round 1 review)", async () => {
    setup();
    const m = await manualCard(w, "M");
    const req = await request(m);
    const sched = { actor: "scheduler", now: Date.now() };
    const c = claimManualMerge(w.db, sched, { project: "p", mode: "on", train: "none", requiredChecks: ["check"] });
    if (!c.claimed) throw new Error(`claim refused: ${String(c.why)}`);
    const id = c.intentId, step = (from: "ready" | "await_ci" | "merging", to: "await_ci" | "merging" | "merged", extra = {}) =>
      advanceMergeRun(w.db, sched, { intentId: id, from, to, rev: getMergeRun(w.db, id)!.rev, receipt: to, ...extra });
    expect(of("M")).toMatchObject({ state: "running", manualRequestSeq: req, reason: null });
    step("ready", "await_ci");
    step("await_ci", "merging");
    expect(of("M")).toMatchObject({ state: "running", phase: "merging" });
    const others: QueueFactsPorts[] = [{ ...PORTS, skip: () => true }, { ...PORTS, handoff: () => true }, { ...PORTS, repo: () => "other/repo" }];
    for (const ports of others) expect(of("M", facts(ports))).toMatchObject({ state: "running", phase: "merging", reason: null });
    step("merging", "merged", { mergeSha: sha("c") });
    expect(of("M")).toMatchObject({ state: "excluded", manualRequestSeq: req, phase: "merged", reason: { code: "landed" } });
    // round 2 review: another card-level exclusion must not hide the landed fact and let the running exception revive the card
    for (const ports of others) expect(of("M", facts(ports))).toMatchObject({ state: "excluded", phase: "merged", reason: { code: "landed" } });
  });
});

describe("event fields and switch for the later action cards", () => {
  test("observe is marked predicted and keyed apart; the same fact gives the same key; the switch key is registered once", async () => {
    setup();
    auto("A");
    const e = of("A");
    expect(QUEUE_EVENT_KINDS).toEqual(["queue_enter", "claim", "landed", "blocked", "withdrawn"]);
    const real = queueEventFields(e, "queue_enter", "on"), seen = queueEventFields(e, "queue_enter", "observe");
    expect(real).toMatchObject({ op: "merge_queue", event: "queue_enter", predicted: false, taskId: "A", source: "auto", versionSeq: e.versionSeq, head: e.head });
    expect(seen.predicted).toBe(true);
    expect(queueEventKey(seen)).toMatch(/^mq-observe:/);
    expect(queueEventKey(real)).toMatch(/^mq:queue_enter:/);
    expect(queueEventKey(real)).not.toBe(queueEventKey(seen));
    expect(queueEventKey(queueEventFields(of("A"), "queue_enter", "on"))).toBe(queueEventKey(real));
    expect(queueEventKey(queueEventFields(e, "blocked", "on"))).not.toBe(queueEventKey(real));
    expect(RECOVERY_KEYS.filter((k) => k === "unifiedMergeQueue")).toHaveLength(1);
    const policy = (mode: "on" | "observe" | "off"): RecoveryPolicyPort => () => ({ mode, manualAfterMs: null, source: "config" });
    expect(unifiedQueueMode("p", policy("on"))).toBe("on");
    expect(unifiedQueueMode("p", () => { throw new Error("坏文件"); })).toBe("off");
  });
});
