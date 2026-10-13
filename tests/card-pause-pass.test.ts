/**
 * UXPAUSE1 · a paused card through the real scheduler pass (schedulerPass on a temp ledger, the ledger CLI in-process, no shared
 * mode file): under `on` a review-stage auto card gets no reviewer session, review order, pool order, PM notice or ledger write for
 * as many passes as it stays paused, and lifecycle sees it frozen; resume continues exactly as a never-paused card; the executor's
 * delivery during a pause still moves the stage; observe schedules as usual and records each would-be hold once.
 * Old red: the same card without the pause (the control fixture) gets its reviewer and review order.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ledgerFacts } from "../src/lib/agent-lifecycle-deps.js";
import { configureCardPausePolicy } from "../src/lib/card-pause.js";
import { schedulerV2SkipManager } from "../src/lib/scheduler-v2-skip.js";
import { autoSource, pendingAutoEvents, sourceKey } from "../src/lib/memory-auto-common.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { schedulerPass, type PassOpts } from "../src/lib/scheduler-pass.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

type Fixture = ReturnType<typeof autoFixture>;
const cleanups: (() => void)[] = [];
afterEach(() => { configureCardPausePolicy(null); while (cleanups.length) cleanups.pop()!(); });
const policy = (mode: RecoveryMode) => configureCardPausePolicy((_p, key) => ({ mode: key === "cardPause" ? mode : "observe", manualAfterMs: null, source: "config" }));

function config(dir: string): SchedulerConfig {
  return { enabled: true, autoDispatch: true, pollMs: 1000, projects: { p: { repoDir: dir, maxActiveWorkers: 2, requiredChecks: ["ci"], mergeTrain: "off" } } };
}
function passOpts(f: Fixture): PassOpts {
  return { assertOwner: () => {}, maintenance: { path: join(f.dir, "maintenance"), marker: join(f.dir, "marker"), request: join(f.dir, "request") },
    trainTick: async () => {}, peerPr: async () => ({ failed: [] }), autostart: () => ({ start: async () => [], resume: async () => [] }),
    lockYield: async () => [], retire: async () => [], lifecycle: async () => [], manager: f.tickDeps.manager, autoDeps: () => f.tickDeps };
}
/** Already-consumed project decisions, so the unrelated memory sweep has no work in these passes. */
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
    await new Promise((resolve) => setTimeout(resolve, 20)); // observe notes are written beside the pass
  }
}

/** An auto card the executor just delivered for review (H1): the next passes ensure the reviewer and send the review order. */
async function atReview(): Promise<Fixture> {
  const f = autoFixture();
  cleanups.push(f.close);
  await toBuild(f);
  await f.tick(); // write order
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  expect(existsSync(join(f.dir, "shared-ledger-modes.json"))).toBe(false);
  return f;
}
const t1Events = (db: Database, after = 0) => (db.query("SELECT seq, actor, kind, text, data FROM events WHERE target = 'T1' AND seq > ? ORDER BY seq").all(after) as
  { seq: number; actor: string; kind: string; text: string; data: string }[]).filter((e) => e.kind !== "memory");
const topSeq = (db: Database) => (db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s;
/** What the scheduler did for the card, without ids / clocks: intents in order, sessions ensured, orders sent, PM notices. */
const actions = (f: Fixture) => ({
  intents: f.intents().map((i) => `${i.node}/${i.action}/${i.status}/${i.recipient ?? "-"}`),
  ensured: f.ensured.map((e) => `${e.role}:${e.family}`), sent: f.sent.map((s) => `${s.agent}:${s.route}`), notices: f.notices.length,
});
const pause = (f: Fixture) => f.cli("pm", "card-pause", "T1", "--reason", "PM 核对审查范围") as Promise<Record<string, any>>;
const resume = (f: Fixture) => f.cli("pm", "card-resume", "T1");

describe("[验收线 1] a paused card gets no new action from the pass", () => {
  test("control (old red): the same review card without a pause gets its reviewer session and review order", async () => {
    const f = await atReview();
    await pass(f, 2);
    expect(actions(f).ensured).toContain("reviewer:codex");
    expect(actions(f).sent).toContain("agent-rv-t1:acp");
    expect(f.intents().at(-1)).toMatchObject({ action: "review" });
  });

  test("on: several passes send no review, no reviewer session, no pool order, no PM notice and write nothing for the card", async () => {
    policy("on");
    const f = await atReview();
    expect((await pause(f)).ok).toBe(true);
    const before = actions(f), seq = topSeq(f.db), info = spyOn(console, "info").mockImplementation(() => {});
    try { await pass(f, 4); } finally { info.mockRestore(); }
    expect(actions(f)).toEqual(before);
    expect(f.pins).toEqual([]);
    expect(t1Events(f.db, seq)).toEqual([]);
    expect(f.db.query("SELECT COUNT(*) AS n FROM lend_orders").get()).toEqual({ n: 0 });
    expect(ledgerFacts(f.db).cards.find((t) => t.id === "T1")).toMatchObject({ frozen: true }); // lifecycle never reclaims its sessions
    expect(f.task().stage).toBe("review");
  });
});

describe("[验收线 3] resume picks up exactly where the card was", () => {
  test("after resume the passes do what a never-paused card does (same fixture compared)", async () => {
    policy("on");
    const control = await atReview();
    await pass(control, 2);
    const paused = await atReview();
    expect((await pause(paused)).ok).toBe(true);
    await pass(paused, 3);
    expect(actions(paused).sent).not.toContain("agent-rv-t1:acp");
    expect((await resume(paused)).ok).toBe(true);
    await pass(paused, 2);
    expect(actions(paused)).toEqual(actions(control));
    expect(paused.task()).toMatchObject({ stage: control.task().stage, round: control.task().round, headSHA: control.task().headSHA });
    expect(ledgerFacts(paused.db).cards.find((t) => t.id === "T1")).toMatchObject({ frozen: false });
  });

  test("the executor's delivery during a pause still moves the stage; the review waits for resume", async () => {
    policy("on");
    const f = autoFixture();
    cleanups.push(f.close);
    await toBuild(f);
    await f.tick(); // write order out: the executor is working
    expect((await pause(f)).ok).toBe(true);
    expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
    expect(f.task().stage).toBe("review");
    await pass(f, 3);
    expect(actions(f).sent).not.toContain("agent-rv-t1:acp");
    expect(actions(f).ensured).not.toContain("reviewer:codex");
    expect((await resume(f)).ok).toBe(true);
    await pass(f, 2);
    expect(actions(f).sent).toContain("agent-rv-t1:acp");
    expect(f.intents().at(-1)).toMatchObject({ action: "review" });
  });
});

describe("[验收线 5] observe: schedules as usual, records each would-be hold once", () => {
  test("the review goes out as if unpaused; one cardPause note per action kind for this pause, none on later passes", async () => {
    policy("on");
    const control = await atReview();
    await pass(control, 2);
    policy("observe");
    const f = await atReview();
    const paused = await pause(f);
    expect(paused).toMatchObject({ ok: true, state: { paused: true } });
    await pass(f, 2);
    expect(actions(f)).toEqual(actions(control));
    const notes = () => t1Events(f.db).filter((e) => e.kind === "note" && JSON.parse(e.data).mechanism === "cardPause").map((e) => JSON.parse(e.data));
    const keys = notes().map((d) => d.actionKey as string);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain(`pause.${paused.state.seq}.pace`);
    for (const d of notes()) expect(d).toMatchObject({ op: "recovery_observe", pauseSeq: paused.state.seq });
    await pass(f, 2);
    expect(notes().map((d) => d.actionKey).sort()).toEqual([...keys].sort());
  });
});

describe("[验收线 1] the manager layer holds the card's ledger calls (no shared mode file)", () => {
  test("on: a `ledger <sub> T1` call through the pass manager is held unwritten; other calls and resumed cards pass", async () => {
    policy("on");
    const f = await atReview();
    const calls: string[][] = [];
    const gate = schedulerV2SkipManager(f.db, async (...args) => { calls.push(args); return { ok: true }; });
    expect((await pause(f)).ok).toBe(true);
    const info = spyOn(console, "info").mockImplementation(() => {});
    cleanups.push(() => info.mockRestore());
    expect(await gate("ledger", "scheduler-review-pm", "T1")).toMatchObject({ ok: false, code: "v2_held", held: true, error: expect.stringContaining("card paused: T1") });
    expect(await gate("ledger", "scheduler-autostart", "review-pm", "T1")).toMatchObject({ held: true });
    expect(await gate("ledger", "show", "-")).toEqual({ ok: true });
    expect(calls).toEqual([["ledger", "show", "-"]]);
    expect((await resume(f)).ok).toBe(true);
    expect(await gate("ledger", "scheduler-review-pm", "T1")).toEqual({ ok: true });
  });

  test("observe: the call goes through and one cardPause note is written per sub-command for this pause", async () => {
    policy("observe");
    const f = await atReview();
    const paused = await pause(f);
    const sent: string[][] = [];
    const gate = schedulerV2SkipManager(f.db, async (...args) => { sent.push(args); return f.tickDeps.manager(...args); });
    for (let i = 0; i < 3; i++) expect(await gate("ledger", "scheduler-review-pm", "T1")).toMatchObject({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const observes = sent.filter((a) => a[1] === "scheduler-recovery-observe");
    expect(observes).toHaveLength(1);
    expect(observes[0]).toEqual(expect.arrayContaining(["--mechanism", "cardPause", "--action-key", `pause.${paused.state.seq}.ledger.scheduler-review-pm`]));
    expect(sent.filter((a) => a[1] === "scheduler-review-pm")).toHaveLength(3);
    const notes = t1Events(f.db).filter((e) => e.kind === "note" && JSON.parse(e.data).mechanism === "cardPause");
    expect(notes).toHaveLength(1);
  });
});
