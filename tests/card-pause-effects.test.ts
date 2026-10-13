/**
 * UXPAUSE1 · a pause landing inside a card's step, through the real scheduler pass on a temp ledger (ledger CLI in-process, no shared
 * mode file): a pause after the review plan / the claim was written but before the step acts starts no checkout pin, no reviewer
 * ensure and no review send (the claimed intent is settled cancelled, resume redoes it); an ensure already running when the pause lands
 * still binds its session and settles, so resume goes on to the review; under observe each would-be-held action kind is noted apart.
 * Old red (review round 2): pinReview / submit / ensure ran after the pause, and the started ensure's bind / settle were held.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { configureCardPausePolicy } from "../src/lib/card-pause.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { autoSource, pendingAutoEvents, sourceKey } from "../src/lib/memory-auto-common.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerPass, type PassOpts } from "../src/lib/scheduler-pass.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

type Fixture = ReturnType<typeof autoFixture>;
const cleanups: (() => void)[] = [];
afterEach(() => { configureCardPausePolicy(null); while (cleanups.length) cleanups.pop()!(); });

function config(dir: string): SchedulerConfig {
  return { enabled: true, autoDispatch: true, pollMs: 1000, projects: { p: { repoDir: dir, maxActiveWorkers: 2, requiredChecks: ["ci"], mergeTrain: "off" } } };
}
function passOpts(f: Fixture): PassOpts {
  return { assertOwner: () => {}, maintenance: { path: join(f.dir, "maintenance"), marker: join(f.dir, "marker"), request: join(f.dir, "request") },
    trainTick: async () => {}, peerPr: async () => ({ failed: [] }), autostart: () => ({ start: async () => [], resume: async () => [] }),
    lockYield: async () => [], retire: async () => [], lifecycle: async () => [], manager: f.tickDeps.manager, autoDeps: () => f.tickDeps };
}
function consumeMemoryBacklog(db: Database) {
  for (const e of pendingAutoEvents(db, "p", 100)) {
    db.query("INSERT INTO events (ts,actor,project,target,kind,text,data,dedupKey) VALUES (1,'scheduler','p',?,'memory','','{}',?)")
      .run(e.target, `memory-auto:p:${sourceKey(autoSource(e))}`);
  }
}
async function pass(f: Fixture, n = 1) {
  for (let i = 0; i < n; i++) {
    consumeMemoryBacklog(f.db);
    const r = await schedulerPass(f.db, config(f.dir), passOpts(f));
    expect(r.failed).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
/** An auto card the executor just delivered for review: the next passes ensure the reviewer, then plan, pin and send the review. */
async function atReview(mode: RecoveryMode): Promise<Fixture> {
  const f = autoFixture();
  cleanups.push(f.close);
  configureCardPausePolicy((_p, key) => ({ mode: key === "cardPause" ? mode : "off", manualAfterMs: null, source: "config" }));
  const quiet = [spyOn(console, "info").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})];
  cleanups.push(() => quiet.forEach((s) => s.mockRestore()));
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  return f;
}
const pause = (f: Fixture) => f.cli("pm", "card-pause", "T1", "--reason", "PM 核对") as Promise<Record<string, any>>;
const resume = (f: Fixture) => f.cli("pm", "card-resume", "T1");
const intentOf = (f: Fixture, id: string) => f.intents().find((i) => i.id === id)!;
const reviewSent = (f: Fixture) => f.sent.filter((s) => s.agent === "agent-rv-t1").length;
const reviewerEnsures = (f: Fixture) => f.ensured.filter((e) => e.role === "reviewer").length;
const flagOf = (args: readonly string[], name: string) => args[args.indexOf(name) + 1];

/** Pause once, right after the first ledger call matching `when` has been written (the step has not seen the response yet). */
function pauseAfter(f: Fixture, when: (args: string[]) => boolean): { fired: () => { id: string; pins: number; sent: number; ensures: number } | null } {
  const real = f.tickDeps.manager;
  let fired: { id: string; pins: number; sent: number; ensures: number } | null = null;
  f.tickDeps.manager = async (...args) => {
    const r = await real(...args);
    if (!fired && r.ok === true && when(args)) {
      expect((await pause(f)).ok).toBe(true);
      fired = { id: args[1] === "scheduler-plan" ? flagOf(args, "--id") : args[2]!, pins: f.pins.length, sent: f.sent.length, ensures: f.ensured.length };
    }
    return r;
  };
  return { fired: () => fired };
}
const claimOf = (f: Fixture, action: string) => (args: string[]) =>
  args[1] === "scheduler-settle" && flagOf(args, "--to") === "submitted" && f.intents().find((i) => i.id === args[2])?.action === action;

describe("[验收线 1] a pause landing inside a step starts no new external effect", () => {
  test("after the review plan is written, before its response: no checkout pin, no review send; resume sends the review", async () => {
    const f = await atReview("on");
    const hook = pauseAfter(f, (a) => a[1] === "scheduler-plan" && flagOf(a, "--action") === "review");
    await pass(f, 3);
    const at = hook.fired()!;
    expect(at).not.toBeNull();
    expect({ pins: f.pins.length, sent: f.sent.length }).toEqual({ pins: at.pins, sent: at.sent });
    expect(intentOf(f, at.id).status).toBe("cancelled");
    expect((await resume(f)).ok).toBe(true);
    await pass(f, 2);
    expect(reviewSent(f)).toBe(1);
  });

  test("after the review claim (pending → submitted) lands: no send, the claim is settled cancelled; resume sends the review", async () => {
    const f = await atReview("on");
    const hook = pauseAfter(f, claimOf(f, "review"));
    await pass(f, 3);
    const at = hook.fired()!;
    expect(at).not.toBeNull();
    expect(f.sent.length).toBe(at.sent);
    expect(intentOf(f, at.id).status).toBe("cancelled");
    expect((await resume(f)).ok).toBe(true);
    await pass(f, 2);
    expect(reviewSent(f)).toBe(1);
  });

  test("after the reviewer ensure claim lands: no ensure, the claim is settled cancelled; resume ensures and reviews", async () => {
    const f = await atReview("on");
    const hook = pauseAfter(f, claimOf(f, "ensure_session"));
    await pass(f, 3);
    const at = hook.fired()!;
    expect(at).not.toBeNull();
    expect(f.ensured.length).toBe(at.ensures);
    expect(intentOf(f, at.id).status).toBe("cancelled");
    expect(getSchedulerSession(f.db, "T1", "reviewer")).toBeNull();
    expect((await resume(f)).ok).toBe(true);
    await pass(f, 3);
    expect(reviewerEnsures(f)).toBe(1);
    expect(reviewSent(f)).toBe(1);
  });
});

describe("[验收线 3] an ensure already running when the pause lands still lands its result", () => {
  test("its bind and settle are written during the pause; resume goes straight on to the review", async () => {
    const f = await atReview("on");
    const real = f.tickDeps.ensure;
    let paused = false;
    f.tickDeps.ensure = async (task, role, family) => {
      if (role === "reviewer" && !paused) { paused = true; expect((await pause(f)).ok).toBe(true); }
      return real(task, role, family);
    };
    await pass(f, 3);
    expect(paused).toBe(true);
    expect(getSchedulerSession(f.db, "T1", "reviewer")).toMatchObject({ agent: "agent-rv-t1", state: "active" });
    expect(f.intents().find((i) => i.action === "ensure_session" && i.recipient === "agent-rv-t1")?.status ?? "done").toBe("done");
    expect(f.intents().filter((i) => i.action === "ensure_session" && i.status === "unknown")).toEqual([]);
    expect(reviewSent(f)).toBe(0);
    expect((await resume(f)).ok).toBe(true);
    await pass(f, 2);
    expect(reviewerEnsures(f)).toBe(1);
    expect(reviewSent(f)).toBe(1);
  });
});

describe("[验收线 5] observe notes each would-be-held action kind of the auto tick apart", () => {
  test("plan, claim, ensure, pin, snapshot and send each get one note; the review goes out as usual", async () => {
    const f = await atReview("observe");
    const paused = await pause(f);
    expect(paused.ok).toBe(true);
    await pass(f, 3);
    expect(reviewSent(f)).toBe(1);
    const keys = (f.db.query("SELECT data FROM events WHERE target = 'T1' AND kind = 'note'").all() as { data: string }[])
      .map((e) => JSON.parse(e.data)).filter((d) => d.mechanism === "cardPause").map((d) => String(d.actionKey));
    expect(new Set(keys).size).toBe(keys.length);
    const p = `pause.${paused.state.seq}.`;
    expect(keys).toEqual(expect.arrayContaining(["pace", "ledger.scheduler-plan", "ledger.scheduler-settle", "ensure", "pinReview",
      "ledger.scheduler-review-snapshot", "submit"].map((a) => p + a)));
    expect(f.db.query("SELECT 1 FROM events WHERE target = 'T1' AND json_extract(data, '$.op') = 'plan_rejected'").get()).toBeNull();
  });
});
