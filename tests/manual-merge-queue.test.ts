/**
 * MQ1 negatives and races on the real ledger + real pass (tests/scheduler-merge-reclaim-world.ts, fake GitHub): who may request,
 * what a request binds, what never becomes a candidate, revoke / drift / lease loss / send-then-timeout, two connections and two
 * processes claiming at once, observe dedup, the merge-queue view. tests/manual-merge-queue-train.test.ts has the train scenarios.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openAsk, type NewAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setFrozen, setMeta } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { claimManualMerge, manualTurn } from "../src/lib/manual-merge-queue.js";
import { manualMergeGate } from "../src/lib/manual-merge-queue-pass.js";
import { RECOVERY_POLICY_PATH, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { mergeRunDrift, getMergeRun } from "../src/lib/scheduler-merge.js";
import { mergeQueueCmds } from "../src/manager/ledger-merge-queue-cmds.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { testChildEnv } from "./test-env.js";
import { ledgerAs, manualCard, requestArgs, writePolicy } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm", DISP = "agent-disp";
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

const policy = writePolicy;
const as = (actor: string, ...args: string[]) => ledgerAs(w, actor, ...args);
const sched = { actor: "scheduler" };
const claim = (db = w.db, train: "none" | "holds" | "cleanup" | "corrupt" = "none", mode: "on" | "observe" = "on") =>
  claimManualMerge(db, { ...sched, now: Date.now() }, { project: "p", mode, train, requiredChecks: ["check"] });
const merges = (id: string) => w.hub.calls.filter((c) => c.endsWith(`merge:${id}`)).length;
const reviewOf = (id: string, data: Record<string, unknown>, actor = "agent-review") => insertEvent(w.db, { actor, now: Date.now() },
  { project: "p", target: id, kind: "review", text: "", data: { round: 1, head: getTask(w.db, id)!.headSHA, verdict: "pass", reviewer: "agent-review",
    reviewerSessionId: `rs-${id}`, reviewerFamily: "codex", path: "r.md", findings: [], p0: 0, p1: 0, p2: 0, ...data } }, false).seq;

function setup(mode: "on" | "observe" | "off" = "on") {
  w = reclaimWorld({ store: "memory" });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM, DISP] });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "team", value: { dispatcher: DISP, audit: true } });
  policy(mode);
}

describe("request: who, what it binds, what is refused", () => {
  test("PM (not the dispatcher) / owner only; binding must equal the card; the review's facts are copied, never typed", async () => {
    setup();
    const m = await manualCard(w, "M");
    expect(await as(DISP, ...requestArgs(m))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await as("agent-author", ...requestArgs(m))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await as(PM, ...requestArgs({ ...m, head: "f".repeat(40) }))).toMatchObject({ ok: false, code: "conflict" });
    expect(await as(PM, ...requestArgs({ ...m, reviewSeq: m.reviewSeq - 1 }))).toMatchObject({ ok: false, code: "conflict" });
    expect(await as(PM, ...requestArgs(m, "--ui-digest", "x"))).toMatchObject({ ok: false, code: "invalid" });
    const r = await as(PM, ...requestArgs(m));
    expect(r).toMatchObject({ ok: true, state: "queued", duplicate: false });
    const ev = listEvents(w.db, { project: "p", target: "M" }).find((e) => e.data.op === "manual_merge_request")!;
    expect(ev.actor).toBe(PM);
    // the review was recorded through the real `ledger review` by PM, naming the actual reviewer (no engine ack exists)
    expect(ev.data.review).toEqual({ seq: m.reviewSeq, actor: PM, reviewer: "agent-review", sessionId: "rs-M", family: "codex", reportPath: "r.md", verdict: "pass" });
    // a different binding while one is open is refused; revoke first
    expect(await as(PM, ...requestArgs(m))).toMatchObject({ ok: true, duplicate: true, request: r.request });
  });

  test("same-family, P1, self-written and forged-actor reviews are refused; an auto card is not a manual one", async () => {
    setup();
    const same = await manualCard(w, "S");
    const seq = reviewOf("S", { reviewerFamily: "claude" });
    expect(await as(PM, ...requestArgs({ ...same, reviewSeq: seq }))).toMatchObject({ ok: false, code: "conflict", error: expect.stringMatching(/跨模型/) });
    const p1 = await manualCard(w, "P");
    const p1Seq = reviewOf("P", { verdict: "changes", findings: [{ findingId: "f1", severity: "P1", title: "x", basis: "spec", file: "a.ts", line: 1 }], p1: 1 });
    expect((await as(PM, ...requestArgs({ ...p1, reviewSeq: p1Seq }))).ok).toBe(false);
    const forged = await manualCard(w, "G");
    // not PM / master / owner, not the reviewer: the dispatcher or another agent naming someone else as reviewer is refused
    for (const actor of [DISP, "agent-other", "agent-author"]) {
      const fSeq = reviewOf("G", {}, actor);
      expect(await as(PM, ...requestArgs({ ...forged, reviewSeq: fSeq }))).toMatchObject({ ok: false, error: expect.stringMatching(/reviewer 本人|作者/) });
    }
    // the requester is never the reviewer it binds
    const own = await manualCard(w, "O");
    const oSeq = reviewOf("O", { reviewer: PM }, PM);
    expect(await as(PM, ...requestArgs({ ...own, reviewSeq: oSeq }))).toMatchObject({ ok: false, error: expect.stringMatching(/审查人/) });
    const auto = w.card("A");
    const aSeq = listEvents(w.db, { project: "p", target: "A" }).findLast((e) => e.kind === "review")!.seq;
    expect(await as(PM, ...requestArgs({ ...auto, reviewSeq: aSeq }))).toMatchObject({ ok: false, error: expect.stringMatching(/不是 manual/) });
  });

  test("owner hold, open approval, frozen queue: queued but waiting, never claimed; the wait clears and the turn comes", async () => {
    setup();
    const m = await manualCard(w, "M");
    openAsk(w.db, { project: "p", taskId: "M", source: "human", kind: "decide", title: "能合吗", options: [{ type: "buttons", buttons: [{ id: "go", label: "好" }] }] } as NewAsk);
    expect(await as(PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "waiting", why: expect.stringMatching(/审批未答/) });
    expect(claim()).toMatchObject({ claimed: false, turn: "none" });
    w.db.query("UPDATE asks SET state = 'cancelled' WHERE taskId = 'M'").run();
    setFrozen(w.db, { actor: "owner", now: Date.now() }, { project: "p", frozen: true, reason: "查事故" });
    expect(claim()).toMatchObject({ claimed: false, turn: "none" });
    await w.pass();
    expect(merges("M")).toBe(0);
    setFrozen(w.db, { actor: "owner", now: Date.now() }, { project: "p", frozen: false });
    insertEvent(w.db, { actor: "owner", now: Date.now() }, { project: "p", target: "M", kind: "scheduler", text: "", data: { op: "workflow", mode: "manual", hold: "owner 先别合" } }, false);
    expect(manualTurn(w.db, "p", "none", Date.now()).kind).toBe("none");
  });
});

describe("spec / round / UI drift", () => {
  test("spec or round moving after the request voids it; a ui card needs the accepted digest and a live UI approval", async () => {
    setup();
    const m = await manualCard(w, "M");
    const r = await as(PM, ...requestArgs(m));
    w.db.query("UPDATE tasks SET round = 2, rev = rev + 1 WHERE id = 'M'").run();
    expect(manualTurn(w.db, "p", "none", Date.now()).kind).toBe("none");
    const view = await as(PM, "merge-queue", "--project", "p");
    expect(JSON.stringify(view)).toMatch(new RegExp(`人工#${r.request} M｜已失效`));
    const u = await manualCard(w, "U");
    w.db.query("UPDATE task_workflows SET template = 'ui' WHERE taskId = 'U'").run();
    w.db.query(`UPDATE tasks SET extra = json_set(extra, '$.screenshotsDigest', ?) WHERE id = 'U'`).run("a".repeat(64));
    expect(await as(PM, ...requestArgs(u))).toMatchObject({ ok: false, code: "invalid" });
    expect(await as(PM, ...requestArgs(u, "--ui-digest", "b".repeat(64)))).toMatchObject({ ok: false, error: expect.stringMatching(/UI 截图摘要已变/) });
    expect(await as(PM, ...requestArgs(u, "--ui-digest", "a".repeat(64)))).toMatchObject({ ok: false, error: expect.stringMatching(/UI 验收/) });
  });
});

describe("claim: the one authoritative entry", () => {
  test("waits for a live train, a busy slot, a train file it cannot read; never claims for a non-scheduler", async () => {
    setup();
    const m = await manualCard(w, "M");
    await as(PM, ...requestArgs(m));
    expect(() => claimManualMerge(w.db, { actor: PM }, { project: "p", mode: "on", train: "none", requiredChecks: ["check"] })).toThrow(/调度服务/);
    expect(await as(PM, "manual-merge-claim", "p", "--mode", "on", "--train", "none", "--required-checks", "check")).toMatchObject({ ok: false, code: "forbidden" });
    expect(claim(w.db, "holds")).toMatchObject({ claimed: false, turn: "due", why: expect.stringMatching(/列车/) });
    expect(claim(w.db, "corrupt")).toMatchObject({ claimed: false, why: expect.stringMatching(/读不了/) });
    w.card("A1");
    await w.begin("A1"); // an auto run holds the slot
    expect(claim()).toMatchObject({ claimed: false, why: expect.stringMatching(/合并槽在 A1/) });
    expect(w.intentOf("M")).toBeNull();
  });

  test("two connections and two processes claim at once: exactly one intent, one slot, one run", async () => {
    setup();
    const m = await manualCard(w, "M");
    await as(PM, ...requestArgs(m));
    const path = w.db.filename, other = openLedger(path);
    try {
      const a = claim(w.db), b = claim(other);
      expect([a.claimed, b.claimed]).toEqual([true, false]);
    } finally { closeLedger(path); w.restart(); }
    expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_merges WHERE taskId = 'M'").get()).toEqual({ n: 1 });
    // processes: a second request for another card, claimed from two children started together
    w.db.query("DELETE FROM scheduler_resources WHERE taskId = 'M'").run();
    w.db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE taskId = 'M'").run();
    const n = await manualCard(w, "N");
    await as(PM, ...requestArgs(n));
    const lib = join(import.meta.dir, "../src/lib/manual-merge-queue.ts"), store = join(import.meta.dir, "../src/lib/ledger-store.ts");
    const code = `const { claimManualMerge } = await import(${JSON.stringify(lib)}); const { openLedger } = await import(${JSON.stringify(store)});
      const db = openLedger(${JSON.stringify(path)}); db.exec("PRAGMA busy_timeout = 5000");
      try { console.log(JSON.stringify(claimManualMerge(db, { actor: "scheduler" }, { project: "p", mode: "on", train: "none", requiredChecks: ["check"] }))); }
      catch (e) { console.log(JSON.stringify({ error: String(e.message) })); }`;
    const env = testChildEnv({ CLAUDESTRA_STATE_DIR: process.env.CLAUDESTRA_STATE_DIR, CLAUDESTRA_RUNTIME_DIR: process.env.CLAUDESTRA_RUNTIME_DIR });
    const kids = [0, 1].map(() => Bun.spawn([process.execPath, "--no-env-file", "-e", code], { env, stdout: "pipe", stderr: "pipe" }));
    const outs = await Promise.all(kids.map(async (k) => ({ code: await k.exited, out: (await new Response(k.stdout).text()).trim().split("\n").at(-1)! })));
    expect(outs.map((o) => o.code)).toEqual([0, 0]);
    const parsed = outs.map((o) => JSON.parse(o.out) as { claimed?: boolean });
    expect(parsed.filter((p) => p.claimed === true)).toHaveLength(1);
    expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE taskId = 'N'").get()).toEqual({ n: 1 });
    expect(w.db.query("SELECT taskId FROM scheduler_resources WHERE resource = 'merge:p'").get()).toEqual({ taskId: "N" });
  }, 30_000);

  test("a claimed slot keeps auto merges out: the auto plan for another card is refused while the manual run holds it", async () => {
    setup();
    const m = await manualCard(w, "M");
    await as(PM, ...requestArgs(m));
    expect(claim()).toMatchObject({ claimed: true });
    w.card("A1");
    expect(manualTurn(w.db, "p", "none", Date.now()).kind).toBe("active");
    // the auto tick's own write path for a merge intent, with fresh revs: refused on the slot, not on stale input
    const seq = (w.db.query("SELECT MAX(seq) AS s FROM events WHERE project = 'p'").get() as { s: number }).s;
    const plan = () => planIntent(w.db, { actor: "scheduler", now: Date.now() }, { id: "auto-merge-A1", taskId: "A1", taskRev: getTask(w.db, "A1")!.rev,
      workflowRev: 1, causalSeq: seq, node: "merge_deploy", action: "merge", reason: "合并", resources: ["merge:p"] });
    expect(plan).toThrow(/merge:p.*M 占用/);
    expect(w.slot()).toBe("M");
  });
});

describe("deploy in flight", () => {
  test("an auto card deploying keeps the slot: the manual head waits for the deploy to end, then merges once", async () => {
    w = reclaimWorld({ store: "memory", deploy: true });
    setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM] });
    policy("on");
    w.card("A1"); await w.begin("A1");
    for (let i = 0; i < 4 && !w.hub.calls.includes("deploy:A1"); i++) await w.pass();
    expect(w.hub.calls).toContain("deploy:A1");
    const m = await manualCard(w, "M");
    await as(PM, ...requestArgs(m));
    expect(w.slot()).toBe("A1");
    expect(claim()).toMatchObject({ claimed: false, why: expect.stringMatching(/合并槽在 A1/) });
    for (let i = 0; i < 6 && w.phase("M") !== "merged"; i++) await w.pass();
    const calls = w.hub.calls;
    expect(calls.indexOf("deploy:A1")).toBeLessThan(calls.indexOf("serial-merge:M"));
    expect([w.phase("M"), merges("M")]).toEqual(["merged", 1]);
    expect(calls).not.toContain("deploy:M"); // a manual card is not auto-deployed (deployDrift: not auto), PM deploys it
  });
});

describe("after the claim: drift, revoke, lease loss, a merge sent then lost", () => {
  /** Passes until one ends in SchedulerStopped (the merge call is out when it stops). */
  async function stoppedWithin(n: number): Promise<boolean> {
    for (let i = 0; i < n; i++) {
      try { await w.pass(); } catch (e) { if (e instanceof SchedulerStopped) return true; throw e; }
    }
    return false;
  }

  async function claimed() {
    setup();
    const m = await manualCard(w, "M");
    const r = await as(PM, ...requestArgs(m));
    expect(claim()).toMatchObject({ claimed: true });
    return { m, request: Number(r.request), intent: w.intentOf("M")! };
  }

  test("revoke before any merge: the next pass ends the run cancelled, frees the slot, sends nothing", async () => {
    const { request, intent } = await claimed();
    w.hub.pending = true; // CI pending: the run sits in await_ci
    await w.pass();
    expect(await as(PM, "manual-merge-revoke", "M", "--request", String(request), "--reason", "先不合")).toMatchObject({ ok: true });
    await w.pass();
    expect(getMergeRun(w.db, intent)?.phase).toBe("resolved");
    expect(w.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(intent)).toEqual({ status: "cancelled" });
    expect([w.slot(), merges("M")]).toEqual([null, 0]);
    expect(w.db.query("SELECT value FROM meta WHERE project = 'p' AND key = 'queueFrozen'").get()).toBeNull();
  });

  test("head moves after the claim: the old request goes void, its unsent run is released; a new head needs a new request", async () => {
    const { m } = await claimed();
    w.hub.pending = true;
    await w.pass();
    const head = "e".repeat(40);
    w.db.query("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = 'M'").run(head);
    expect(mergeRunDrift(w.db, getMergeRun(w.db, w.intentOf("M")!)!)).toMatch(/人工合并请求已失效|head/);
    await w.pass();
    expect([w.phase("M"), w.slot(), merges("M")]).toEqual(["resolved", null, 0]);
    expect(await as(PM, ...requestArgs({ ...m, head }))).toMatchObject({ ok: false }); // the bound review was for the old head
  });

  test("lease lost mid-pass, then a restart: the journal carries on, the merge is sent once", async () => {
    await claimed();
    w.hub.stopIn = { name: "M", merged: true }; // GitHub merged it, the service stopped before hearing back
    expect(await stoppedWithin(3)).toBe(true);
    w.restart();
    for (let i = 0; i < 3 && w.phase("M") !== "merged"; i++) await w.pass();
    expect([w.phase("M"), merges("M")]).toEqual(["merged", 1]);
  });

  test("merge sent, effect not observed: unknown + frozen, never re-sent; only PM's resolve settles it", async () => {
    const { intent } = await claimed();
    w.hub.stopIn = { name: "M", merged: false }; // the call died before GitHub merged anything
    expect(await stoppedWithin(3)).toBe(true);
    w.restart();
    await w.pass(); await w.pass();
    expect([w.phase("M"), merges("M")]).toEqual(["unknown", 0]);
    expect(JSON.parse((w.db.query("SELECT value FROM meta WHERE project = 'p' AND key = 'queueFrozen'").get() as { value: string }).value).frozen).toBe(true);
    expect(await as(PM, "manual-merge-revoke", "M", "--request", String(Number(intent.slice(4))), "--reason", "x")).toMatchObject({ ok: false, code: "conflict" });
    expect(await as(PM, "scheduler-merge-resolve", intent, "--outcome", "failed", "--receipt", "GitHub 上 PR 仍 open，未合并")).toMatchObject({ ok: true });
    expect(merges("M")).toBe(0);
  });
});

describe("policy and view", () => {
  test("observe: one deduped would-be note, no intent / slot / block; off and a throwing port: nothing at all", async () => {
    setup("observe");
    const m = await manualCard(w, "M");
    await as(PM, ...requestArgs(m));
    for (let i = 0; i < 3; i++) await w.pass();
    expect(listEvents(w.db, { project: "p", target: "M" }).filter((e) => e.data.op === "recovery_observe")).toHaveLength(1);
    expect([w.intentOf("M"), w.slot()]).toEqual([null, null]);
    const throwing: RecoveryPolicyPort = () => { throw new Error("坏了"); };
    const gate = manualMergeGate(w.db, null, throwing);
    expect(gate.blocks("p")).toBe(false);
    const calls: string[][] = [];
    await gate.claim(async (...a) => { calls.push(a); return { ok: true }; }, { projects: { p: { requiredChecks: ["check"] } } } as never);
    expect(calls).toEqual([]);
    policy("off");
    await w.pass();
    expect(w.intentOf("M")).toBeNull();
  });

  test("merge-queue lists the request with its turn, source and reason, never the reviewer session", async () => {
    setup();
    const m = await manualCard(w, "M");
    w.card("A1"); await w.begin("A1");
    await as(PM, ...requestArgs(m));
    const view = mergeQueueCmds(() => ({ mode: "on", manualAfterMs: null, source: "config" }))["merge-queue"]!;
    const r = await runLedger(["merge-queue", "--project", "p"], { db: w.db, actor: PM, projectIds: ["p"], loadRegistry: async () => ({} as Registry),
      saveRegistry: async () => {}, now: () => Date.now() });
    expect(r.ok).toBe(true);
    const text = JSON.stringify(r);
    expect(text).toMatch(/人工#\d+ M｜排队｜轮转第 1｜agent-pm 请求/);
    expect(text).toMatch(/合并槽在 A1/);
    expect(text).not.toContain("rs-M");
    expect(view.usage).toMatch(/人工合并请求/);
  });
});
