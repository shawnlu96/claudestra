/**
 * UIASK1: planning and the merge write accept the same owner screenshot ask (only the scheduler's), and an ownerVisual card whose
 * owner-approved scheduler ask went stale gets a new ask from the scheduler under uiOwnerReask (off / observe / on).
 * Real ledger CLI in-process; the policy file lives in the test state dir (tests/preload.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { bindHash } from "../src/lib/ask-bind.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { autostartHooks } from "../src/lib/scheduler-autostart-deps.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { uiMergeRefusal } from "../src/lib/scheduler-ui-gate.js";
import { drainUiOwnerReaskObserved, resetUiOwnerReaskObserved, uiOwnerReaskMode, uiOwnerReaskPending } from "../src/lib/scheduler-ui-reask.js";
import { autoFixture, DIGEST, H2, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const OLD = "4".repeat(40);

/** A UI card whose review on H2 just passed. */
async function passed(ownerVisual: boolean): Promise<F> {
  const f = autoFixture({ template: "ui", ownerVisual });
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2);
  await f.tick();
  await f.tick();
  await f.review("pass", H2, []);
  return f;
}

/** A screenshot ask from `from`, bound to `head`, answered by `answer` (owner approve by default). One bound to OLD is opened
 * before the fixture's clock reaches the review, so it is never newer than an ask the tick opens. */
function ownerAsk(f: F, o: { from?: string; head?: string; answer?: "approve" | "reject" | "guest" | null; expiresAt?: number } = {}) {
  const from = o.from ?? "scheduler", at = o.head === OLD ? 500 : 9_000;
  const binding = { action: "scheduler_ui_screenshot", params: { task: "T1", specRev: 1, head: o.head ?? H2, screenshotsDigest: DIGEST }, approve: ["scheduler_ui_approve"] };
  const ask = openAsk(f.db, { project: "p", taskId: "T1", fromAgent: from, source: from === "scheduler" ? "system" : "reply", kind: "authorize",
    title: "看前后截图", askKey: `scheduler_ui_screenshot:T1`, expiresAt: o.expiresAt ?? 1e12, bind: { ...binding, paramsHash: bindHash(binding, from) } }, at);
  const answer = o.answer === undefined ? "approve" : o.answer;
  if (answer) {
    const button = answer === "reject" ? "scheduler_ui_reject" : "scheduler_ui_approve";
    answerAsk(f.db, ask.id, { choices: [`[button:${button}]`], labels: ["x"], principal: answer === "guest" ? "guest" : "owner",
      owner: answer !== "guest", via: "web_card", at: at + 100 } as never);
  }
  return ask;
}

const asks = (f: F) => (f.db.query("SELECT COUNT(*) AS n FROM asks WHERE kind = 'authorize'").get() as { n: number }).n;
const plan = (f: F) => planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: 10_000 }));
const policy = (mode: RecoveryMode) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { uiOwnerReask: mode } } } }));

afterEach(() => { rmSync(RECOVERY_POLICY_PATH, { force: true }); resetUiOwnerReaskObserved(); });

describe("[验收线 1] planning accepts only the scheduler's owner ask, like the merge write", () => {
  test("a manager-opened, owner-answered ask bound to the current values no longer plans merge; the merge write refuses it too", async () => {
    const f = await passed(true);
    try {
      ownerAsk(f, { from: "pm" });
      expect(uiMergeRefusal(f.db, f.task(), 10_000)).toContain("owner");
      expect(plan(f)).not.toMatchObject({ kind: "intent", targetStage: "merge" });
      expect(plan(f)).toMatchObject({ kind: "intent", action: "ask", askBind: { task: "T1", head: H2, specRev: 1, screenshotsDigest: DIGEST } });
    } finally { f.close(); }
  });

  test("the same ask opened by the scheduler still plans merge, and the merge write accepts it", async () => {
    const f = await passed(true);
    try {
      ownerAsk(f);
      expect(plan(f)).toMatchObject({ kind: "intent", targetStage: "merge" });
      expect(uiMergeRefusal(f.db, f.task(), 10_000)).toBeNull();
    } finally { f.close(); }
  });
});

describe("[验收线 2] the owner approved on an older head: uiOwnerReask", () => {
  test("on: the planner asks again, bound to the card's current values; the tick opens one new scheduler ask and then waits", async () => {
    policy("on");
    const f = await passed(true);
    try {
      ownerAsk(f, { head: OLD });
      expect(plan(f)).toMatchObject({ kind: "intent", action: "ask", askBind: { task: "T1", specRev: 1, head: H2, screenshotsDigest: DIGEST } });
      expect(await f.tick()).toMatchObject({ step: "ask", detail: expect.stringMatching(/^ask /) });
      expect(asks(f)).toBe(2);
      const opened = f.db.query("SELECT fromAgent, askKey, state, bind FROM asks WHERE state = 'open'").get() as Record<string, string>;
      expect(opened).toMatchObject({ fromAgent: "scheduler", askKey: "scheduler_ui_screenshot:T1", state: "open" });
      expect(JSON.parse(opened.bind!).params).toEqual({ task: "T1", specRev: 1, head: H2, screenshotsDigest: DIGEST });
      // [验收线 3] the current values now have a scheduler ask: the existing branch waits, no second ask.
      for (let i = 0; i < 2; i++) expect(await f.tick()).toMatchObject({ step: "waiting", detail: "等待 owner 看前后截图" });
      expect(asks(f)).toBe(2);
      expect(uiOwnerReaskPending()).toEqual([]);
    } finally { f.close(); }
  });

  test("observe: escalates ui_stale as before and queues one would-reopen record with the old and new binding", async () => {
    policy("observe");
    const f = await passed(true);
    try {
      ownerAsk(f, { head: OLD });
      expect(plan(f)).toMatchObject({ kind: "escalate", code: "ui_stale" });
      plan(f);
      const pending = uiOwnerReaskPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ project: "p", mechanism: "uiOwnerReask", target: "T1",
        data: { from: { head: OLD, specRev: 1, screenshotsDigest: DIGEST }, to: { head: H2, specRev: 1, screenshotsDigest: DIGEST } } });
      expect(pending[0]!.actionKey).toMatch(/^[\w.:@/-]{1,120}$/);
      const written: unknown[] = [];
      expect(await drainUiOwnerReaskObserved((a) => { written.push(a); })).toBe(1);
      expect(written).toHaveLength(1);
      expect(uiOwnerReaskPending()).toEqual([]);
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("ui_stale") });
      expect(asks(f)).toBe(1);
    } finally { f.close(); }
  });

  test("the start hook writes the queued record as the scheduler (scheduler-recovery-observe), exactly once", async () => {
    policy("observe");
    const f = await passed(true);
    try {
      ownerAsk(f, { head: OLD });
      const calls: string[][] = [];
      const ledger = async (...args: string[]) => { calls.push(args); return f.cli("scheduler", ...args.slice(1)); };
      const hooks = autostartHooks({ db: f.db, ledger, active: () => {}, lease: undefined });
      const config = { enabled: false, autoDispatch: false, projects: {} } as unknown as SchedulerConfig;
      const pace = { yieldNow: () => false, cursor: {} };
      plan(f);
      await hooks.start(config, pace);
      plan(f); // a replanned pass queues the same record again; the ledger's dedup key keeps one
      await hooks.start(config, pace);
      await hooks.start(config, pace);
      expect(calls.filter((c) => c[1] === "scheduler-recovery-observe" && c.includes("uiOwnerReask"))).toHaveLength(2);
      const notes = f.db.query("SELECT data FROM events WHERE target = 'T1' AND kind = 'note'").all()
        .map((r) => JSON.parse((r as { data: string }).data)).filter((d) => d.op === "recovery_observe" && d.mechanism === "uiOwnerReask");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ from: { head: OLD }, to: { head: H2, specRev: 1, screenshotsDigest: DIGEST } });
      expect(uiOwnerReaskPending()).toEqual([]);
    } finally { f.close(); }
  });

  test("a failed write goes back in the queue for the next drain", async () => {
    policy("observe");
    const f = await passed(true);
    try {
      ownerAsk(f, { head: OLD });
      plan(f);
      expect(await drainUiOwnerReaskObserved(() => { throw new Error("ledger down"); })).toBe(0);
      expect(uiOwnerReaskPending()).toHaveLength(1);
    } finally { f.close(); }
  });

  test("off: escalates ui_stale exactly as before, nothing queued, nothing opened", async () => {
    policy("off");
    const f = await passed(true);
    try {
      ownerAsk(f, { head: OLD });
      expect(plan(f)).toMatchObject({ kind: "escalate", code: "ui_stale", reason: "截图许可绑定的 head/specRev 已过期" });
      expect(uiOwnerReaskPending()).toEqual([]);
      expect(await f.tick()).toMatchObject({ step: "manual" });
      expect(asks(f)).toBe(1);
    } finally { f.close(); }
  });

  test("default is observe; an unreadable policy file is off", () => {
    expect(uiOwnerReaskMode("p")).toBe("observe");
    writeFileSync(RECOVERY_POLICY_PATH, "{");
    expect(uiOwnerReaskMode("p")).toBe("off");
  });
});

describe("[验收线 3] never reopened after a rejection or an unverified answer, nor twice for the same values", () => {
  for (const answer of ["reject", "guest"] as const) {
    test(`${answer} on an older head escalates ui_stale even with uiOwnerReask=on`, async () => {
      policy("on");
      const f = await passed(true);
      try {
        ownerAsk(f, { head: OLD, answer });
        expect(plan(f)).toMatchObject({ kind: "escalate", code: "ui_stale" });
        expect(await f.tick()).toMatchObject({ step: "manual" });
        expect(asks(f)).toBe(1);
      } finally { f.close(); }
    });
  }

  test("an open or expired scheduler ask for the current values takes the existing branch, after an older approval", async () => {
    policy("on");
    const f = await passed(true);
    try {
      ownerAsk(f, { head: OLD });
      ownerAsk(f, { answer: null });
      expect(plan(f)).toMatchObject({ kind: "wait", code: "owner_screenshot" });
    } finally { f.close(); }
    const g = await passed(true);
    try {
      ownerAsk(g, { head: OLD });
      ownerAsk(g, { answer: null, expiresAt: 9_500 });
      expect(plan(g)).not.toMatchObject({ kind: "escalate" });
      expect(uiOwnerReaskPending()).toEqual([]);
    } finally { g.close(); }
  });

  test("a manager-opened ask on top of a stale scheduler approval does not count: the scheduler reopens instead", async () => {
    policy("on");
    const f = await passed(true);
    try {
      ownerAsk(f, { head: OLD });
      ownerAsk(f, { from: "pm" });
      expect(plan(f)).toMatchObject({ kind: "intent", action: "ask", askBind: { head: H2 } });
      expect(uiMergeRefusal(f.db, f.task(), 10_000)).toContain("owner");
    } finally { f.close(); }
  });
});

describe("[验收线 4] a default (PM-accepted) card is untouched", () => {
  test("a stale owner approval on a default card neither reopens nor queues; the PM notice goes out as before", async () => {
    policy("on");
    const f = await passed(false);
    try {
      ownerAsk(f, { head: OLD });
      expect(await f.tick()).toMatchObject({ step: "ask", detail: expect.stringContaining("pm_notice") });
      expect(asks(f)).toBe(1);
      expect(uiOwnerReaskPending()).toEqual([]);
    } finally { f.close(); }
  });
});
