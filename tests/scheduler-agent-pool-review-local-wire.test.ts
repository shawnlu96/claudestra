/**
 * dispatch-recovery-REVLOCAL1 wiring: the planner's review placement reads reviewLocalFirst from the recovery policy file and names the
 * card; the pass's start hook writes the queued records through the scheduler identity's CLI; reserveFinishing seats a queued review
 * where the switch would really send it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { reserveFinishing } from "../src/lib/scheduler-agent-pool-reserve.js";
import { resetReviewLocalObserved, reviewLocalPending } from "../src/lib/scheduler-agent-pool-review-local.js";
import { resetWriteLocalObserved } from "../src/lib/scheduler-agent-pool-write-local.js";
import { autostartHooks } from "../src/lib/scheduler-autostart-deps.js";
import type { RemotePolicy, SchedulerConfig } from "../src/lib/scheduler-config.js";
import type { PlacementFacts } from "../src/lib/scheduler-placement.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import type { PoolFacts } from "../src/lib/scheduler-pool-plan.js";
import { autoFixture, H1 } from "./scheduler-auto-helpers.js";

const HEAD = "a".repeat(40);
const REMOTE: RemotePolicy = { mode: "balance", roles: [], poolTimeoutMin: 15, repo: "o/r", agents: { claude: 4, codex: 8 } };
const author: WorkerRef = { agent: "agent-author", sessionId: "s-a", taskId: "T1", family: "claude", source: "local" };
const ev = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "x", project: "p", target: "T1", text: "复述", dedupKey: null });
/** Local Codex 2 / 8 running, the peer's Codex idle; the card was written by Claude. */
const pool = (codexRunning = 2) => ({ remote: REMOTE, localReviewers: 0, repo: "o/r", lastPeer: null,
  localPool: { totals: { claude: 4, codex: 8 }, running: { claude: 0, codex: codexRunning } },
  peers: [{ peer: "mate", open: 0, maxOpen: 2, roles: ["review" as const],
    v2: { why: null, slots: { codex: 4, claude: 4 }, roles: ["review" as const], repos: ["o/r"], familyTotals: { claude: 5, codex: 5 }, familyBusy: { claude: 0, codex: 0 } } }] }) as PoolFacts;
const snap = (over: Partial<PlannerSnapshot> = {}): PlannerSnapshot => ({
  task: { id: "T1", project: "p", itemId: null, title: "t", kind: "code", stage: "review", stageBefore: null, round: 3, agent: author.agent, assigneeKind: "agent",
    assignee: author.agent, pm: "pm", branch: "b", pr: "https://github.com/o/r/pull/7", headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1,
    extra: {}, createdAt: 1, updatedAt: 1 } as LedgerTask,
  workflow: { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x", specRev: 1,
    rev: 1, createdAt: 1, updatedAt: 1 },
  events: [ev(1, "task", { op: "new" }), ev(11, "stage", { from: "build", to: "review", round: 3, specRev: 1 })], intents: [], blockedBy: [], queueFrozen: false,
  fileGlobs: ["src/lib/x.ts"], heldResources: [], workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer: null,
  reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null, pool: pool(), ...over,
});
const setMode = (mode: string | null) => mode === null ? rmSync(RECOVERY_POLICY_PATH, { force: true })
  : writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { reviewLocalFirst: mode } } } }));
const TO_PEER = { kind: "intent", action: "review", recipient: "peer:mate", reason: expect.stringContaining("codex 在跑 0，最少优先，平手 peer 先") };

beforeEach(() => { resetReviewLocalObserved(); resetWriteLocalObserved(); setMode(null); });
afterEach(() => { resetReviewLocalObserved(); resetWriteLocalObserved(); setMode(null); });

test("planner, no policy entry (observe): the review still goes to the peer and one record names the card and its round", () => {
  expect(planScheduler(snap())).toMatchObject(TO_PEER);
  expect(planScheduler(snap())).toMatchObject(TO_PEER);
  expect(reviewLocalPending()).toEqual([{ project: "p", mechanism: "reviewLocalFirst", target: "T1", actionKey: "review-local:r3",
    action: "派本机：codex 本机在跑 2 / 名额 8", data: { family: "codex", running: 2, total: 8, peer: "mate", round: 3 } }]);
});

test("planner, on: the review is placed here (a local Codex reviewer is ensured), nothing recorded", () => {
  setMode("on");
  expect(planScheduler(snap())).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "reviewer", sessionFamily: "codex" });
  expect(planScheduler(snap({ pool: pool(8) }))).toMatchObject(TO_PEER); // no free local seat: the peer as before
  expect(reviewLocalPending()).toEqual([]);
});

test("planner, off or an unreadable policy file: the peer, nothing recorded", () => {
  for (const mode of ["off", "bogus"]) {
    setMode(mode);
    expect(planScheduler(snap())).toMatchObject(TO_PEER);
  }
  expect(reviewLocalPending()).toEqual([]);
});

test("planner: a card bound to its reviewer goes back to that reviewer in every mode", () => {
  const reviewer: WorkerRef = { agent: "rv", sessionId: "s-rv", taskId: "T1", family: "codex", source: "local" };
  for (const mode of ["on", "observe", "off"]) {
    setMode(mode);
    expect(planScheduler(snap({ reviewer }))).toMatchObject({ kind: "intent", action: "review", recipient: "rv" });
  }
  expect(reviewLocalPending()).toEqual([]);
});

test("planner, on: writing and fixing are planned exactly as under off", () => {
  for (const stage of ["build", "fix"] as const) {
    const s = () => { const x = snap(); x.task = { ...x.task, stage }; x.events = [ev(1, "task", { op: "new" }), ev(11, "stage", { from: "spec", to: stage, round: 3, specRev: 1 })]; return x; };
    setMode("off"); const before = planScheduler(s());
    setMode("on"); expect(planScheduler(s())).toEqual(before);
  }
  expect(reviewLocalPending()).toEqual([]);
});

test("start hook: queued records are written as the scheduler through scheduler-recovery-observe; a refused write is retried next pass", async () => {
  const f = autoFixture();
  try {
    planScheduler(snap());
    const calls: string[][] = [];
    let ok = false;
    const ledger = async (...args: string[]) => { calls.push(args); return ok ? { ok: true } : { ok: false, error: "busy" }; };
    const hooks = autostartHooks({ db: f.db, ledger, active: () => {}, lease: undefined });
    const config = { enabled: false, autoDispatch: false, projects: {} } as unknown as SchedulerConfig;
    const pace = { yieldNow: () => false, cursor: {} };
    await hooks.start(config, pace);
    expect(reviewLocalPending()).toHaveLength(1);
    ok = true;
    await hooks.start(config, pace);
    await hooks.start(config, pace);
    const want = ["ledger", "scheduler-recovery-observe", "T1", "--mechanism", "reviewLocalFirst", "--action-key", "review-local:r3", "--action",
      "派本机：codex 本机在跑 2 / 名额 8", "--data", JSON.stringify({ family: "codex", running: 2, total: 8, peer: "mate", round: 3 })];
    expect(calls).toEqual([want, want]);
    expect(reviewLocalPending()).toEqual([]);
  } finally { f.close(); }
});

test("reserveFinishing: a queued review's seat is reserved where it will really go — here under on, on the peer under observe / off", () => {
  const f = autoFixture();
  try {
    f.db.query("UPDATE tasks SET stage='review', headSHA=?, pr='https://github.com/o/r/pull/7' WHERE id='T1'").run(H1);
    const facts = (): PlacementFacts => ({ remote: REMOTE, repo: "o/r", pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true,
      local: { running: 2, room: true, pool: { totals: { claude: 4, codex: 8 }, running: { claude: 0, codex: 2 } } },
      peers: [{ peer: "mate", roles: [], priority: "off", open: 0,
        v2: { why: null, roles: [], repos: ["o/r"], slots: { claude: 4, codex: 4 }, familyTotals: { claude: 5, codex: 5 }, familyBusy: { claude: 0, codex: 0 } } }] });
    const seats = (mode: string | null) => {
      setMode(mode);
      const r = reserveFinishing(f.db, "p", facts());
      return { local: r.local.pool!.running.codex, peer: r.peers[0]!.v2!.slots.codex };
    };
    expect(seats("on")).toEqual({ local: 3, peer: 4 });
    for (const mode of ["observe", "off", null]) expect(seats(mode)).toEqual({ local: 2, peer: 3 });
    // A pinned card's review is not moved by the switch, so its seat stays on the peer.
    f.db.query("UPDATE tasks SET extra=json_set(extra, '$.placement', 'peer:mate') WHERE id='T1'").run();
    expect(seats("on")).toEqual({ local: 2, peer: 3 });
    expect(reviewLocalPending()).toEqual([]);
  } finally { f.close(); }
});
