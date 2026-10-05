/**
 * MQ1 round-3 regressions (the three findings of review r2), on the real ledger + real schedulerPass (tests/scheduler-merge-reclaim-world.ts,
 * fake GitHub), manual reviews and PM actions through the real ledger CLI (manual-merge-queue-world.test.ts):
 * - approval-expiry: an authorization closed without approval is not lifted by queuing again; an approval whose window ended (checkAsk's
 *   rule) is no approval, whether the request is still queued or its run already holds the slot;
 * - policy-after-claim: the policy is read once more on the last check before the merge call, after the `merging` claim committed
 *   (nothing sent: the run ends cancelled, the slot is freed, the queue is not frozen); a merge already sent is only verified, never redone;
 * - ui-auto-starvation: a legal auto ui card gets the turn between two manual merges like any other waiting auto card;
 * - approval-expiry (r3): a decision is its asker + ask key + binding hash; an approval of another decision (other key / params /
 *   asker) lifts nothing, only the owner approving the same decision re-asked does, and the ledger's own supersede (same asker +
 *   key, old one still open) hands an undecided version to its recorded replacement.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { answerAsk, closeAsk, getAsk, openAskFull } from "../src/lib/ledger-asks.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { claimManualMerge } from "../src/lib/manual-merge-queue.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { answer as answerIn, authorize as authorizeIn, ledgerAs, manualCard, requestArgs, uiAutoCard, writePolicy } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm", DISP = "agent-disp";
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

const as = (actor: string, ...args: string[]) => ledgerAs(w, actor, ...args);
const merges = (id: string) => w.hub.calls.filter((c) => c.endsWith(`merge:${id}`)).length;
const claim = () => claimManualMerge(w.db, { actor: "scheduler", now: Date.now() }, { project: "p", mode: "on", train: "none", requiredChecks: ["check"] });
const authorize = (taskId: string, o?: { askKey?: string; params?: unknown; fromAgent?: string }) => authorizeIn(w, taskId, "manual_merge", o);
const answer = (id: string, button: string) => answerIn(w, id, button);
/** The approval window of an answered ask ends (checkAsk: the window runs from the ask, an answer does not extend it). */
const windowEnds = (id: string) => w.db.query("UPDATE asks SET expiresAt = ? WHERE id = ?").run(Date.now() - 1, id);
const frozen = () => w.db.query("SELECT value FROM meta WHERE project = 'p' AND key = 'queueFrozen'").get();
const view = async () => JSON.stringify(await as(PM, "merge-queue", "--project", "p"));

function setup(mode: "on" | "observe" | "off" = "on") {
  w = reclaimWorld({ store: "memory" });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM, DISP] });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "team", value: { dispatcher: DISP, audit: true } });
  writePolicy(mode);
}

describe("P1 approval-expiry: the lift is the owner's approval, never a newer request", () => {
  test("an authorization that expired before any request was made keeps the request waiting until the owner approves a re-ask", async () => {
    setup();
    const m = await manualCard(w, "M");
    const ask = authorize("M");
    closeAsk(w.db, ask.id, "expired", "到期", Date.now()); // closed before PM ever queued
    expect(await as(PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "waiting", why: expect.stringMatching(/不是批准/) });
    expect(claim()).toMatchObject({ claimed: false });
    for (let i = 0; i < 2; i++) await w.pass();
    expect([w.intentOf("M"), merges("M")]).toEqual([null, 0]);
    answer(authorize("M").id, "go");
    for (let i = 0; i < 4 && w.phase("M") !== "merged"; i++) await w.pass();
    expect([w.phase("M"), merges("M")]).toEqual(["merged", 1]);
  }, 30_000);

  test("approved, then the approval window ends while the request waits: nothing sent; requesting again changes nothing; a fresh approval lifts it", async () => {
    setup();
    const m = await manualCard(w, "M");
    const ask = authorize("M");
    answer(ask.id, "go");
    expect(await as(PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
    windowEnds(ask.id);
    for (let i = 0; i < 3; i++) await w.pass();
    expect([w.intentOf("M"), merges("M")]).toEqual([null, 0]);
    expect(await view()).toMatch(/M｜等前置.*有效期/);
    expect(await as(PM, ...requestArgs(m, "--reason", "再排"))).toMatchObject({ ok: true, duplicate: true, state: "waiting", why: expect.stringMatching(/有效期/) });
    for (let i = 0; i < 2; i++) await w.pass();
    expect([w.intentOf("M"), merges("M")]).toEqual([null, 0]);
    answer(authorize("M").id, "go");
    for (let i = 0; i < 4 && w.phase("M") !== "merged"; i++) await w.pass();
    expect([w.phase("M"), merges("M")]).toEqual(["merged", 1]);
  }, 30_000);

  test("the approval window ends after the claim, before the merge was sent: the run is cancelled, the slot freed, nothing sent", async () => {
    setup();
    const m = await manualCard(w, "M");
    const ask = authorize("M");
    answer(ask.id, "go");
    await as(PM, ...requestArgs(m));
    expect(claim()).toMatchObject({ claimed: true });
    w.hub.pending = true;
    await w.pass();
    windowEnds(ask.id);
    w.hub.pending = false;
    for (let i = 0; i < 3; i++) await w.pass();
    expect([w.phase("M"), w.slot(), merges("M"), frozen()]).toEqual(["resolved", null, 0, null]);
  }, 30_000);

  test("owner_action: the owner's answer is the act; expired / cancelled, or an answer not from the owner, is not", async () => {
    setup();
    const m = await manualCard(w, "M");
    const open = () => openAskFull(w.db, { project: "p", taskId: "M", source: "system", kind: "owner_action", title: "登录", fromAgent: "scheduler",
      options: [] } as never, Date.now()).ask;
    const reply = (id: string, owner: boolean) => answerAsk(w.db, id, { choices: [], labels: ["做完了"], text: "做完了", principal: owner ? "owner:self" : "peer:x",
      via: "web_card", at: Date.now(), ...(owner ? { owner: true as const } : { external: true as const }) });
    closeAsk(w.db, open().id, "expired", "到期", Date.now());
    expect(await as(PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "waiting", why: expect.stringMatching(/不是批准/) });
    reply(open().id, false); // someone else answered the re-ask: still waiting
    for (let i = 0; i < 2; i++) await w.pass();
    expect([w.intentOf("M"), merges("M")]).toEqual([null, 0]);
    expect(await view()).toMatch(/M｜等前置.*不是批准/);
    reply(open().id, true);
    for (let i = 0; i < 4 && w.phase("M") !== "merged"; i++) await w.pass();
    expect([w.phase("M"), merges("M")]).toEqual(["merged", 1]);
  }, 30_000);
});

describe("P1 policy-after-claim: the last check before the merge call reads the policy", () => {
  /** Flip the policy right after the `merging` claim committed and before its receipt reaches the driver. */
  const flipAfterMergingClaim = (to: "off" | "observe" | "corrupt") => (args: string[], r: Record<string, unknown>) => {
    if (args[1] === "scheduler-merge-step" && args[args.indexOf("--to") + 1] === "merging" && r.ok === true) {
      if (to === "corrupt") writeFileSync(RECOVERY_POLICY_PATH, "{not json");
      else writePolicy(to);
    }
  };
  for (const to of ["off", "observe", "corrupt"] as const) {
    test(`on → ${to} between the merging claim and the send: no merge, the run ends cancelled, the slot is freed, no freeze`, async () => {
      setup();
      const m = await manualCard(w, "M");
      await as(PM, ...requestArgs(m));
      let flipped = false;
      for (let i = 0; i < 4 && !flipped; i++) await w.pass({ afterManager: (a, r) => { flipAfterMergingClaim(to)(a, r); flipped ||= a.includes("merging") && r.ok === true; } });
      expect(flipped).toBe(true);
      const intent = w.intentOf("M")!;
      expect([getMergeRun(w.db, intent)?.phase, w.slot(), merges("M"), frozen()]).toEqual(["resolved", null, 0, null]);
      expect(w.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(intent)).toEqual({ status: "cancelled" });
      // the request itself is still valid: once the policy is on again PM can queue it anew, and it merges once
      writePolicy("on");
      expect(await as(PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
      for (let i = 0; i < 4 && w.phase("M") !== "merged"; i++) await w.pass();
      expect([w.phase("M"), merges("M")]).toEqual(["merged", 1]);
    }, 30_000);
  }

  test("a merge already sent is only verified after a restart, whatever the policy says now; never sent again", async () => {
    setup();
    const m = await manualCard(w, "M");
    await as(PM, ...requestArgs(m));
    w.hub.stopIn = { name: "M", merged: true }; // GitHub merged it, the service died before the receipt
    let stopped = false;
    for (let i = 0; i < 4 && !stopped; i++) {
      try { await w.pass(); } catch (e) { if (!(e instanceof SchedulerStopped)) throw e; stopped = true; }
    }
    expect(stopped).toBe(true);
    expect(getMergeRun(w.db, w.intentOf("M")!)?.phase).toBe("merging");
    w.restart();
    writePolicy("off");
    for (let i = 0; i < 3 && w.phase("M") !== "merged"; i++) await w.pass();
    expect([w.phase("M"), merges("M"), frozen()]).toEqual(["merged", 1, null]);
  }, 30_000);
});

describe("P1 ui-auto-starvation: a legal auto ui card is owed its turn like any auto card", () => {
  test("ui auto card waiting, three manual requests: the ui card merges between the first and second manual merge", async () => {
    setup();
    const u = await uiAutoCard(w, "U");
    const ms = [await manualCard(w, "M1"), await manualCard(w, "M2"), await manualCard(w, "M3")];
    for (const m of ms) expect(await as(PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "queued" });
    for (let i = 0; i < 24 && ["U", "M1", "M2", "M3"].some((id) => w.phase(id) !== "merged"); i++) await w.pass();
    const order = w.hub.calls.filter((c) => c.includes("merge:")).map((c) => c.split(":").pop());
    expect(order).toEqual(["M1", "U", "M2", "M3"]);
    expect(merges(u.taskId)).toBe(1);
  }, 90_000);

  test("a ui auto card without its screenshot acceptance is not a candidate: the manual queue does not wait for it", async () => {
    setup();
    const c = w.card("U");
    w.db.query("UPDATE task_workflows SET template = 'ui' WHERE taskId = ?").run("U");
    w.db.query("UPDATE tasks SET extra = json_set(extra, '$.screenshotsDigest', ?), rev = rev + 1 WHERE id = ?").run("ab".repeat(32), "U");
    const ms = [await manualCard(w, "M1"), await manualCard(w, "M2")];
    for (const m of ms) await as(PM, ...requestArgs(m));
    for (let i = 0; i < 12 && ["M1", "M2"].some((id) => w.phase(id) !== "merged"); i++) await w.pass();
    expect([w.phase("M1"), w.phase("M2"), merges(c.taskId)]).toEqual(["merged", "merged", 0]);
  }, 60_000);
});

describe("P1 approval-expiry (r3): a decision is its asker + key + binding; only its own re-ask lifts the wait", () => {
  const current = (head: string) => ({ askKey: "merge-current", params: { task: "M", head } });

  test("reviewer's probe: the current-head authorization expired; approving another key / head, another asker, or the same key with other params lifts nothing", async () => {
    setup();
    const m = await manualCard(w, "M");
    const d1 = authorize("M", current(m.head));
    expect(await as(PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "waiting" }); // the ask is open
    closeAsk(w.db, d1.id, "expired", "到期", Date.now());
    expect(await as(PM, ...requestArgs(m, "--reason", "再排"))).toMatchObject({ ok: true, duplicate: true, state: "waiting", why: expect.stringMatching(/不是批准/) });
    answer(authorize("M", { askKey: "merge-other-head", params: { task: "M", head: "other" } }).id, "go"); // another key, another head
    answer(authorize("M", { ...current(m.head), fromAgent: "agent-other" }).id, "go"); // another asker, same key and params
    answer(authorize("M", current("other")).id, "go"); // same asker and key, other params
    expect(await as(PM, ...requestArgs(m, "--reason", "又排"))).toMatchObject({ ok: true, duplicate: true, state: "waiting", why: expect.stringMatching(/不是批准/) });
    for (let i = 0; i < 3; i++) await w.pass();
    expect([w.intentOf("M"), merges("M"), frozen()]).toEqual([null, 0, null]);
    expect(await view()).toMatch(/M｜等前置.*不是批准/);
    answer(authorize("M", current(m.head)).id, "go"); // the same decision, re-asked and approved
    for (let i = 0; i < 4 && w.phase("M") !== "merged"; i++) await w.pass();
    expect([w.phase("M"), merges("M")]).toEqual(["merged", 1]);
  }, 30_000);

  test("an open authorization re-asked under the same key with changed params is superseded by the ledger: its recorded replacement decides", async () => {
    setup();
    const m = await manualCard(w, "M");
    const d1 = authorize("M", current("stale"));
    expect(await as(PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "waiting" });
    const d2 = authorize("M", current(m.head));
    expect([getAsk(w.db, d1.id)?.state, d2.supersedes]).toEqual(["superseded", d1.id]);
    for (let i = 0; i < 2; i++) await w.pass();
    expect([w.intentOf("M"), merges("M")]).toEqual([null, 0]);
    answer(d2.id, "go");
    for (let i = 0; i < 4 && w.phase("M") !== "merged"; i++) await w.pass();
    expect([w.phase("M"), merges("M")]).toEqual(["merged", 1]);
  }, 30_000);
});
