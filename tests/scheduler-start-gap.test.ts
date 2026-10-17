/** RESTATEGO1 · a card in build with no start order: the next pass dispatches the write order, or a note names what it waits for. */
import { describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler, type PlannerDecision, type PlannerSnapshot } from "../src/lib/scheduler-plan.js";
import { START_GAP_ESCALATE_MS, START_GAP_MS, startGap, trackStartGap } from "../src/lib/scheduler-start-gap.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { configureSchedulerV2Intents, schedulerV2EnsureClaimFence, withSchedulerV2Intents } from "../src/lib/scheduler-v2-intent.js";
import { withSchedulerV2LedgerCmds } from "../src/lib/scheduler-v2-ledger-cmds.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import type { PmNoticeLevel } from "../src/lib/pm-notice-level.js";
import { ledgercmdFixture } from "./shared-ledger-v2-stage2-ledgercmd-fixture.test.js";
import { intentCenter } from "./shared-ledger-v2-stage2-intent-fixture.test.js";

type F = ReturnType<typeof autoFixture>;
const policy = (mode: RecoveryMode): RecoveryPolicyPort => () => ({ mode, manualAfterMs: null, source: "config" });
const gapNotes = (f: F) => listEvents(f.db, { project: "p", target: "T1" })
  .filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "startDeliveryConfirm" && String(e.data.actionKey).startsWith("start-gap:"));
const todos = (f: F) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "pm_todo" && e.data.kind === "start_gap");

/** A start_node card on a center replica: named local author, the replica's feature id on the card, v3 auto workflow. */
function centerCard(mode: RecoveryMode = "on") {
  const f = autoFixture();
  f.db.query("UPDATE tasks SET extra = json_set(extra, '$.sharedFeatureId', 'n7-feature-a') WHERE id = 'T1'").run();
  f.db.query("UPDATE task_workflows SET templateVersion = 3 WHERE taskId = 'T1'").run();
  f.tickDeps.recoveryPolicy = policy(mode);
  // the scheduler identity's CLI runs leased in the service; pm-todo needs that lease
  f.tickDeps.manager = (...args) => f.cliWith({ assertLease: () => {} }, "scheduler", ...args.slice(1));
  return f;
}

describe("[验收线 1] start_node center-replica card after approve_restate", () => {
  test("the next pass plans and sends the write order (v3: the executor's own restate record releases build)", async () => {
    const f = centerCard();
    try {
      expect(getWorkflow(f.db, "T1")?.templateVersion).toBe(3);
      await f.tick(); // author session
      await f.tick(); // restate order
      await f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述");
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "restate→build" }); // approve_restate
      expect(await f.tick()).toMatchObject({ step: "sent", detail: "channel" });
      expect(f.intents().at(-1)).toMatchObject({ node: "write", action: "dispatch", status: "done", recipient: "agent-task-one" });
      expect(gapNotes(f)).toEqual([]); // an ordinary first dispatch leaves no gap note
    } finally { f.close(); }
  });

  test("a gate holds the write order: past the threshold one note names the wait code, reason and time in build; cleared → re-planned", async () => {
    const f = centerCard();
    try {
      await f.tick();
      await f.tick();
      await f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述");
      await f.tick(); // restate → build
      await f.cli("pm", "freeze", "--reason", "测试：冻结队列", "--project", "p");
      expect(await f.tick()).toMatchObject({ step: "waiting" });
      expect(gapNotes(f)).toEqual([]); // inside the threshold
      f.advance(START_GAP_MS);
      await f.tick();
      await f.tick();
      const notes = gapNotes(f);
      expect(notes.map((e) => e.data.actionKey)).toEqual(["start-gap:s1:wait", "start-gap:s1:wait:queue_frozen"]);
      expect(notes[0].text).toMatch(/在 build 已 1\d 分钟没有开工单，等 queue_frozen：项目队列已冻结/);
      expect(notes[0].data).toMatchObject({ code: "queue_frozen", waitedMs: expect.any(Number), since: expect.any(Number) });
      expect(todos(f)).toEqual([]);
      f.advance(START_GAP_ESCALATE_MS);
      await f.tick();
      await f.tick();
      expect(todos(f)).toHaveLength(1); // still blocked after an hour: one PM todo, never repeated
      await f.cli("pm", "unfreeze", "--project", "p");
      expect(await f.tick()).toMatchObject({ step: "sent" });
      expect(gapNotes(f).map((e) => e.data.actionKey)).toContain("start-gap:s1:replanned");
      expect(f.intents().at(-1)).toMatchObject({ node: "write", status: "done" });
    } finally { f.close(); }
  });

  test("[验收线 4] key off: no note, no todo — the pass decides exactly as before", async () => {
    const f = centerCard("off");
    try {
      await toBuild(f);
      await f.cli("pm", "freeze", "--reason", "测试：冻结队列", "--project", "p");
      f.advance(START_GAP_ESCALATE_MS * 2);
      expect(await f.tick()).toMatchObject({ step: "waiting", detail: "项目队列已冻结，不派新活" });
      expect(gapNotes(f)).toEqual([]);
      expect(todos(f)).toEqual([]);
    } finally { f.close(); }
  });
});

describe("startGap (pure)", () => {
  test("only an auto card in build without a sent write order, past the threshold; a done stage intent is no delivery", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      const snap = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: 0 });
      const since = snap.events.findLast((e) => e.kind === "stage" && e.data.to === "build")!.ts;
      expect(snap.intents.some((i) => i.node === "approve_restate" && i.status === "done")).toBe(true);
      const placement: PlannerDecision = { kind: "wait", code: "placement", reason: "等 claude / codex 空位" };
      expect(startGap(snap, placement, since + START_GAP_MS - 1)).toEqual({ kind: "none" });
      expect(startGap(snap, placement, since + START_GAP_MS)).toEqual({ kind: "gap", since, waitedMs: START_GAP_MS, code: "placement", reason: "等 claude / codex 空位" });
      const plan = planScheduler(snap);
      expect(plan).toMatchObject({ kind: "intent", node: "write" });
      expect(startGap(snap, plan, since + START_GAP_MS)).toEqual({ kind: "replanned", since, waitedMs: START_GAP_MS });
      await f.tick(); // write sent
      const after = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: 0 });
      expect(startGap(after, placement, since + 10 * START_GAP_MS)).toEqual({ kind: "none" });
    } finally { f.close(); }
  });
});

/**
 * The same card under the real center wiring: S2I (withSchedulerV2Intents, X8 journal) and S2Q (withSchedulerV2LedgerCmds) over
 * the fixture's recording center. S2Q holds this mechanism's ledger writes for a central card (v2_unmapped), so the wait
 * reason and the escalation must reach PM another way.
 */
function centralGapCard(mode: RecoveryMode = "on") {
  const s = ledgercmdFixture(), center = intentCenter(s.port.clientFor("p")!), f = s.f;
  configureSchedulerV2Intents({
    route: (id) => s.port.route(id), wrapManager: (mgr) => withSchedulerV2LedgerCmds(mgr, s.port),
    fence: () => s.port.fence("feature-one"), claimFence: (taskId, role) => schedulerV2EnsureClaimFence(f.db, taskId, role),
    central: (taskId, intentId) => center.bound(taskId, intentId, f.task().headSHA, "dispatch"),
    settled: async (_taskId, intentId, to) => { await s.port.sync("p", "feature-one"); const intent = getIntent(f.db, intentId); return { ok: intent?.status === to, intent }; },
  });
  const levels: { text: string; level: PmNoticeLevel }[] = [];
  f.tickDeps.recoveryPolicy = policy(mode);
  f.tickDeps.manager = (...args) => f.cliWith({ assertLease: () => {} }, "scheduler", ...args.slice(1));
  f.tickDeps.notifyPm = async (_task, text, level) => { levels.push({ text, level }); };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, withSchedulerV2Intents(f.tickDeps));
    expect(r.failed).toEqual([]);
    return r.cards[0];
  };
  return { s, f, tick, levels, gap: () => levels.filter((n) => n.text.includes("开工单") && n.text.includes(f.task().id)) };
}

async function centralToBuild(c: ReturnType<typeof centralGapCard>) {
  for (let i = 0; i < 4 && c.f.sent.length === 0; i++) await c.tick(); // session, then the restate order
  await c.f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述");
  await c.f.cli("pm", "restate-approve", "T1");
  for (let i = 0; i < 4 && c.f.task().stage !== "build"; i++) await c.tick(); // approve_restate: the center's task.stage
  expect(c.f.task().stage).toBe("build");
}

describe("[验收线 1] center replica under S2Q: the wait reason and the escalation reach PM though the ledger writes are held", () => {
  test("复现测试 central start gap: queue frozen past the threshold → one info notice with code / reason / time in build; an hour → one action notice; cleared → sent", async () => {
    const c = centralGapCard();
    try {
      await centralToBuild(c);
      await c.f.cli("pm", "freeze", "--reason", "测试：冻结队列", "--project", "p");
      let last: unknown;
      for (let i = 0; i < 3 && (last as { step?: string } | undefined)?.step !== "waiting"; i++) last = await c.tick(); // a planned write is cancelled first
      expect(last).toMatchObject({ step: "waiting", detail: "项目队列已冻结，不派新活" });
      expect(c.f.sent.some((x) => x.text.includes("write"))).toBe(false);
      expect(c.gap()).toEqual([]); // inside the threshold
      c.f.advance(START_GAP_MS);
      await c.tick();
      await c.tick();
      expect(c.s.observations).toContain("v2_unmapped"); // S2Q held the ledger note, as for every central card
      const waits = c.gap().filter((n) => n.level === "info");
      expect(waits).toHaveLength(1); // one per code, not every pass
      expect(waits[0]!.text).toMatch(/^\[调度引擎\] T1 记录：开工单等待原因 queue_frozen（在 build 1\d 分钟）：项目队列已冻结/);
      expect(c.gap().filter((n) => n.level === "action")).toEqual([]);
      c.f.advance(START_GAP_ESCALATE_MS);
      await c.tick();
      await c.tick();
      const escalated = c.gap().filter((n) => n.level === "action");
      expect(escalated).toHaveLength(1);
      expect(escalated[0]!.text).toContain("还没有开工单：等 queue_frozen");
      await c.f.cli("pm", "unfreeze", "--project", "p");
      for (let i = 0; i < 3 && !c.f.intents().some((x) => x.node === "write" && x.status === "done"); i++) await c.tick();
      expect(c.f.intents().find((x) => x.node === "write")).toMatchObject({ status: "done" });
      expect(c.gap().filter((n) => n.text.includes("重新规划开工单"))).toHaveLength(1);
      expect(c.gap().filter((n) => n.level === "action")).toHaveLength(1);
    } finally { configureSchedulerV2Intents(null); }
  });

  test("[验收线 4] key off on a central card: no notice at all", async () => {
    const c = centralGapCard("off");
    try {
      await centralToBuild(c);
      await c.f.cli("pm", "freeze", "--reason", "测试：冻结队列", "--project", "p");
      c.f.advance(START_GAP_ESCALATE_MS * 2);
      await c.tick();
      await c.tick();
      expect(c.gap()).toEqual([]);
    } finally { configureSchedulerV2Intents(null); }
  });
});

/** Two center-replica cards on one ledger: the in-process dedup of the PM notices is per card, not per action key. */
describe("[验收线 1] center replica, two cards on one ledger: each card's wait notice and escalation reach PM", () => {
  test("T1's notices never stand in for T2's; another wait code still escalates once per card", async () => {
    const f = autoFixture();
    try {
      let now = 1_000_000;
      const told: { id: string; text: string; level: PmNoticeLevel }[] = [];
      const deps = {
        now: () => now, recoveryPolicy: policy("on"),
        manager: async () => ({ ok: false, code: "v2_unmapped" }), // S2Q holds every ledger write of a central card
        notifyPm: async (task: LedgerTask, text: string, level: PmNoticeLevel) => { told.push({ id: task.id, text, level }); },
      };
      const card = (id: string) => ({ ...f.task(), id, stage: "build", specRev: 1 }) as LedgerTask;
      const snap = (task: LedgerTask) => ({ task, workflow: { mode: "auto" }, events: [], intents: [] }) as unknown as PlannerSnapshot;
      const pass = async (code: string) => {
        for (const id of ["T1", "T2"]) {
          const task = card(id);
          await trackStartGap({ db: f.db, task, deps }, snap(task), { kind: "wait", code, reason: `等 ${code}` });
        }
      };
      const of = (id: string, level: PmNoticeLevel) => told.filter((n) => n.id === id && n.level === level);
      await pass("queue_frozen"); // first seen in build
      now += START_GAP_MS;
      await pass("queue_frozen");
      await pass("queue_frozen");
      for (const id of ["T1", "T2"]) {
        expect(of(id, "info")).toHaveLength(1);
        expect(of(id, "info")[0]!.text).toContain(`${id} 记录：开工单等待原因 queue_frozen`);
        expect(of(id, "action")).toEqual([]);
      }
      now += START_GAP_ESCALATE_MS;
      await pass("placement"); // a changed reason: a new note per card; the escalation is once per card, whatever the code
      await pass("placement");
      for (const id of ["T1", "T2"]) {
        expect(of(id, "info").map((n) => n.text.includes("placement"))).toEqual([false, true]);
        expect(of(id, "action")).toHaveLength(1);
        expect(of(id, "action")[0]!.text).toContain(`${id} 在 build 已 70 分钟，还没有开工单：等 placement`);
      }
    } finally { f.close(); }
  });
});
