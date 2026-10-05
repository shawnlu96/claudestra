/**
 * MQ1 round-2 regressions (the four P1s of review a1), on the real ledger + real schedulerPass (tests/scheduler-merge-reclaim-world.ts,
 * fake GitHub), manual reviews recorded through the real `ledger review` CLI (manual-merge-queue-world.test.ts manualCard):
 * - an authorization that expires / is cancelled / is answered without approval never lets a queued request merge;
 * - the official manual review path (PM records the actual reviewer) is accepted, other recorders are not;
 * - a request committed after the pass's pre-read but before the new train is saved stops that train (formFence);
 * - a policy that is no longer on stops an unsent claimed run (cancelled, slot freed, no merge), and the claim itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindHash } from "../src/lib/ask-bind.js";
import { answerAsk, closeAsk, openAskFull } from "../src/lib/ledger-asks.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { claimManualMerge, recordRequest } from "../src/lib/manual-merge-queue.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, manualReviewArgs, requestArgs, writePolicy } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm", DISP = "agent-disp";
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

const as = (actor: string, ...args: string[]) => ledgerAs(w, actor, ...args);
const merges = (id: string) => w.hub.calls.filter((c) => c.endsWith(`merge:${id}`)).length;
const claim = () => claimManualMerge(w.db, { actor: "scheduler", now: Date.now() }, { project: "p", mode: "on", train: "none", requiredChecks: ["check"] });
const forms = () => w.events.filter((e) => e.kind === "form").length;

function setup(mode: "on" | "observe" | "off" = "on") {
  w = reclaimWorld({ store: "memory" });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM, DISP] });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "team", value: { dispatcher: DISP, audit: true } });
  writePolicy(mode);
}

/** An owner authorization on the card, bound like every authorize ask (approve = the "go" button). */
function authorize(taskId: string) {
  const binding = { action: "manual_merge", params: { task: taskId }, approve: ["go"] };
  return openAskFull(w.db, { project: "p", taskId, source: "system", kind: "authorize", title: "可以合吗", fromAgent: "scheduler",
    options: [{ type: "buttons", buttons: [{ id: "go", label: "合" }, { id: "no", label: "不合" }] }],
    bind: { ...binding, paramsHash: bindHash(binding, "scheduler") } } as never, Date.now()).ask;
}
const answer = (id: string, button: string) => answerAsk(w.db, id, { choices: [`[button:${button}]`], labels: [button], text: "", principal: "owner:self",
  via: "web_card", at: Date.now(), owner: true });

describe("P1 approval-expiry: closing an authorization is not approving it", () => {
  for (const close of ["expired", "cancelled", "answered-no"] as const) {
    test(`${close}: the waiting request goes void, the real pass sends nothing; a new request after that is the explicit lift`, async () => {
      setup();
      const m = await manualCard(w, "M");
      const ask = authorize("M");
      expect(await as(PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "waiting", why: expect.stringMatching(/审批未答/) });
      expect(claim()).toMatchObject({ claimed: false });
      if (close === "answered-no") answer(ask.id, "no");
      else closeAsk(w.db, ask.id, close, "到期", Date.now());
      for (let i = 0; i < 3; i++) await w.pass();
      expect([w.intentOf("M"), merges("M")]).toEqual([null, 0]);
      const view = JSON.stringify(await as(PM, "merge-queue", "--project", "p"));
      expect(view).toMatch(/M｜已失效.*不是批准/);
      // PM read the outcome and queues again: allowed (the closed ask predates this request), and it merges
      expect(await as(PM, ...requestArgs(m, "--reason", "owner 已当面同意"))).toMatchObject({ ok: true, state: "queued", duplicate: false });
      for (let i = 0; i < 4 && w.phase("M") !== "merged"; i++) await w.pass();
      expect([w.phase("M"), merges("M")]).toEqual(["merged", 1]);
    }, 30_000);
  }

  test("answered with the bound approve button: the same request stays valid and merges once", async () => {
    setup();
    const m = await manualCard(w, "M");
    const ask = authorize("M");
    await as(PM, ...requestArgs(m));
    answer(ask.id, "go");
    for (let i = 0; i < 4 && w.phase("M") !== "merged"; i++) await w.pass();
    expect([w.phase("M"), merges("M")]).toEqual(["merged", 1]);
  }, 30_000);

  test("expiry after the claim, before the merge was sent: the run is cancelled, the slot freed, nothing sent", async () => {
    setup();
    const m = await manualCard(w, "M");
    await as(PM, ...requestArgs(m));
    expect(claim()).toMatchObject({ claimed: true });
    const ask = authorize("M"); // a new owner question while the run waits for CI
    w.hub.pending = true;
    await w.pass();
    closeAsk(w.db, ask.id, "expired", "到期", Date.now());
    w.hub.pending = false;
    for (let i = 0; i < 3; i++) await w.pass();
    expect([w.phase("M"), w.slot(), merges("M")]).toEqual(["resolved", null, 0]);
  }, 30_000);
});

describe("P1 manual-review-cli: the official manual review path", () => {
  test("reviewer alone cannot record on a manual card (unchanged); PM recording the actual reviewer is accepted end to end", async () => {
    setup();
    const c = w.card("R");
    w.db.query("DELETE FROM scheduler_sessions WHERE taskId = 'R'").run();
    w.db.query("DELETE FROM scheduler_intents WHERE taskId = 'R'").run();
    w.db.query("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'R'").run();
    w.db.query("UPDATE tasks SET stage = 'review', rev = rev + 1 WHERE id = 'R'").run();
    const dir = mkdtempSync(join(tmpdir(), "mmq-r2-")), findings = join(dir, "f.json");
    writeFileSync(findings, "[]");
    try {
      expect(await as("agent-review", ...manualReviewArgs("R", c.head, findings))).toMatchObject({ ok: false, code: "forbidden" });
      expect(await as(PM, ...manualReviewArgs("R", c.head, findings))).toMatchObject({ ok: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const review = listEvents(w.db, { project: "p", target: "R" }).findLast((e) => e.kind === "review")!;
    expect(review.actor).toBe(PM);
    expect(await as(PM, ...requestArgs({ ...c, reviewSeq: review.seq }))).toMatchObject({ ok: true, state: "queued" });
    for (let i = 0; i < 4 && w.phase("R") !== "merged"; i++) await w.pass();
    expect([w.phase("R"), merges("R")]).toEqual(["merged", 1]);
    // still no engine review proof for the card
    expect(w.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE taskId = 'R' AND action != 'merge'").get()).toEqual({ n: 0 });
  }, 30_000);

  test("the dispatcher's record (allowed by the CLI) does not count as an independent manual review", async () => {
    setup();
    const m = await manualCard(w, "D", DISP);
    expect(await as(PM, ...requestArgs(m))).toMatchObject({ ok: false, code: "conflict", error: expect.stringMatching(/调度助理除外/) });
  });
});

describe("P1 train-request-race: one ledger decision for formation and request", () => {
  for (const where of ["same connection", "another connection"] as const) {
    test(`${where}: a request committed after the pass's pre-read, before the new train is saved, stops that train`, async () => {
      setup();
      for (const id of ["A1", "A2"]) w.card(id);
      const m = await manualCard(w, "M");
      const path = w.db.filename, other = where === "another connection" ? openLedger(path) : null;
      // formTrain reads nextSeq after its awaits (PR files, main head) and right before saving the train: the request lands there
      const nextSeq = w.store.nextSeq.bind(w.store);
      let inserted = false;
      w.store.nextSeq = (p) => {
        if (!inserted) {
          inserted = true;
          const t = getTask(w.db, "M")!;
          recordRequest(other ?? w.db, { actor: PM, now: Date.now() }, { taskId: "M", head: t.headSHA!, specRev: 1, round: 1, reviewSeq: m.reviewSeq, reason: "竞态" });
        }
        return nextSeq(p);
      };
      try {
        await w.pass();
        expect(inserted).toBe(true);
        expect(forms()).toBe(0); // the fence refused the save: no train formed in that pass
        expect(w.store.load("p")).toBeNull();
        expect(w.intentOf("M")).toMatch(/^mmq:\d+$/); // the same pass's claim took the slot
        for (let i = 0; i < 4 && w.phase("M") !== "merged"; i++) await w.pass();
        expect([w.phase("M"), merges("M")]).toEqual(["merged", 1]);
        for (let i = 0; i < 6 && forms() === 0; i++) await w.pass();
        expect(forms()).toBe(1); // the auto cards go on afterwards
      } finally { if (other) closeLedger(path); }
    }, 60_000);
  }

  test("off: the fence is inert, the train forms as before (old path kept)", async () => {
    setup("off");
    for (const id of ["A1", "A2"]) w.card(id);
    const m = await manualCard(w, "M");
    await as(PM, ...requestArgs(m));
    await w.pass();
    expect(forms()).toBe(1);
    expect(w.intentOf("M")).toBeNull();
  }, 30_000);
});

describe("P1 policy-after-claim: the policy is re-read before every unsent step", () => {
  for (const to of ["off", "observe", "corrupt"] as const) {
    test(`on → ${to} after the claim (ready, nothing sent): the run is cancelled, the slot freed, no merge`, async () => {
      setup();
      const m = await manualCard(w, "M");
      await as(PM, ...requestArgs(m));
      expect(claim()).toMatchObject({ claimed: true });
      const intent = w.intentOf("M")!;
      expect(getMergeRun(w.db, intent)?.phase).toBe("ready");
      if (to === "corrupt") writeFileSync(RECOVERY_POLICY_PATH, "{not json");
      else writePolicy(to);
      for (let i = 0; i < 3; i++) await w.pass();
      expect([getMergeRun(w.db, intent)?.phase, w.slot(), merges("M")]).toEqual(["resolved", null, 0]);
      expect(w.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(intent)).toEqual({ status: "cancelled" });
      expect(w.db.query("SELECT value FROM meta WHERE project = 'p' AND key = 'queueFrozen'").get()).toBeNull(); // not faked as unknown
    }, 30_000);
  }

  test("the claim child re-reads the policy: --mode on from a stale pass reading reserves nothing once the file says off", async () => {
    setup();
    const m = await manualCard(w, "M");
    await as(PM, ...requestArgs(m));
    writePolicy("off");
    expect(claim()).toMatchObject({ claimed: false, why: expect.stringMatching(/off/) });
    expect([w.intentOf("M"), w.slot()]).toEqual([null, null]);
  });
});
