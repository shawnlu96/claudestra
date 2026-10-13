/**
 * dispatch-recovery-WRITELOCAL1 wiring: agentPoolWork reads writeLocalEqual from the recovery policy file and names the card and its
 * stage window; reserveFinishing carries the switch into a new card's start placement (the card id = spec placement records); the
 * pass's start hook writes the queued records through the scheduler identity's CLI.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { agentPoolWork } from "../src/lib/scheduler-agent-pool-plan.js";
import { reservedStartPlacement, reserveFinishing } from "../src/lib/scheduler-agent-pool-reserve.js";
import { resetReviewLocalObserved } from "../src/lib/scheduler-agent-pool-review-local.js";
import { resetWriteLocalObserved, writeLocalPending } from "../src/lib/scheduler-agent-pool-write-local.js";
import { autostartHooks } from "../src/lib/scheduler-autostart-deps.js";
import type { RemotePolicy, SchedulerConfig } from "../src/lib/scheduler-config.js";
import type { PlacementFacts } from "../src/lib/scheduler-placement.js";
import type { PlannerSnapshot } from "../src/lib/scheduler-plan.js";
import type { PoolFacts } from "../src/lib/scheduler-pool-plan.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const REMOTE: RemotePolicy = { mode: "balance", roles: [], poolTimeoutMin: 15, repo: "o/r", agents: { claude: 0, codex: 8 } };
const SEKAI_V2 = { why: null, slots: { claude: 1, codex: 0 }, roles: ["write" as const], repos: ["o/r", "o/private"], familyTotals: { claude: 2, codex: 0 }, familyBusy: { claude: 1, codex: 0 } };
const ev = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "x", project: "p", target: "T1", text: "x", dedupKey: null });
/** Local Codex 1 / 8 running, no local Claude; peer Sekai has one Claude seat with one Claude running. */
const pool = (codexRunning = 1) => ({ remote: REMOTE, localReviewers: 0, repo: "o/r", lastPeer: null,
  localPool: { totals: { claude: 0, codex: 8 }, running: { claude: 0, codex: codexRunning } },
  peers: [{ peer: "Sekai", open: 0, maxOpen: 2, roles: ["write" as const], v2: SEKAI_V2 }] }) as PoolFacts;
const snap = (extra: Record<string, unknown> = {}, stage = "build", over: Partial<PlannerSnapshot> = {}): PlannerSnapshot => ({
  task: { id: "T1", project: "p", itemId: null, title: "t", kind: "code", stage, stageBefore: null, round: 0, agent: null, assigneeKind: null,
    assignee: null, pm: "pm", branch: "b", pr: null, headSHA: null, spec: null, specRev: 1, model: null, rev: 1, extra, createdAt: 1, updatedAt: 1 } as LedgerTask,
  workflow: { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x", specRev: 1,
    rev: 1, createdAt: 1, updatedAt: 1 },
  events: [ev(1, "task", { op: "new" }), ev(11, "stage", { from: "restate", to: stage, round: 0, specRev: 1 })], intents: [], blockedBy: [], queueFrozen: false,
  fileGlobs: ["src/lib/x.ts"], heldResources: [], workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author: null, reviewer: null,
  reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null, pool: pool(), projectRepo: "o/r", ...over,
});
const setMode = (mode: string | null) => mode === null ? rmSync(RECOVERY_POLICY_PATH, { force: true })
  : writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { writeLocalEqual: mode } } } }));
const TO_PEER = { peer: "Sekai", reason: expect.stringContaining("claude 在跑 1，最少优先，平手 peer 先") };

beforeEach(() => { resetWriteLocalObserved(); resetReviewLocalObserved(); setMode(null); });
afterEach(() => { resetWriteLocalObserved(); resetReviewLocalObserved(); setMode(null); });

test("agentPoolWork, no policy entry (observe): still the peer; one record names the card and its stage window", () => {
  expect(agentPoolWork(snap(), 0, "write", true)).toMatchObject(TO_PEER);
  expect(agentPoolWork(snap(), 0, "write", true)).toMatchObject(TO_PEER);
  expect(writeLocalPending()).toMatchObject([{ project: "p", mechanism: "writeLocalEqual", target: "T1", actionKey: "write-local:build:r0",
    action: "本会派本机：codex 本机在跑 1 / 名额 8，peer 最少 claude 负载 1" }]);
});

test("agentPoolWork, on: written here (null = local); full local Codex, pinned and private cards and fixes as under off", () => {
  setMode("on");
  expect(agentPoolWork(snap(), 0, "write", true)).toBeNull();
  expect(agentPoolWork(snap({}, "build", { pool: pool(8) }), 0, "write", true)).toMatchObject(TO_PEER);
  const cases: [Record<string, unknown>, string, "write" | "fix"][] = [[{ placement: "peer:Sekai" }, "build", "write"],
    [{ placement: "local" }, "build", "write"], [{ repo: "o/private" }, "build", "write"], [{}, "fix", "fix"]];
  for (const [extra, stage, role] of cases) {
    setMode("off"); const before = agentPoolWork(snap(extra, stage), 0, role, true);
    setMode("on"); expect(agentPoolWork(snap(extra, stage), 0, role, true)).toEqual(before);
  }
  expect(writeLocalPending()).toEqual([]);
});

test("agentPoolWork, on: a private card with both peer families free (Claude 5, Codex 0) keeps the off placement (r2 review)", () => {
  const both = { ...SEKAI_V2, slots: { claude: 1, codex: 1 }, familyTotals: { claude: 6, codex: 1 }, familyBusy: { claude: 5, codex: 0 } };
  const p = { ...pool(2), peers: [{ ...pool(2).peers[0]!, v2: both }] } as PoolFacts;
  setMode("off"); const before = agentPoolWork(snap({ repo: "o/private" }, "build", { pool: p }), 0, "write", true);
  expect(before).toMatchObject({ peer: "Sekai", reason: expect.stringContaining("claude 在跑 5") });
  setMode("on"); expect(agentPoolWork(snap({ repo: "o/private" }, "build", { pool: p }), 0, "write", true)).toEqual(before);
  expect(agentPoolWork(snap({}, "build", { pool: p }), 0, "write", true)).toMatchObject({ peer: "Sekai", reason: expect.stringContaining("codex 在跑 0") });
  expect(writeLocalPending()).toEqual([]);
});

test("start placement: reserveFinishing carries the switch — on starts here, observe / off on the peer; only a card id records", () => {
  const f = autoFixture();
  try {
    const facts = (): PlacementFacts => ({ remote: REMOTE, repo: "o/r", pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true,
      local: { running: 1, room: true, pool: { totals: { claude: 0, codex: 8 }, running: { claude: 0, codex: 1 } } },
      peers: [{ peer: "Sekai", roles: [], priority: "off", open: 0, v2: SEKAI_V2 }] });
    const start = (mode: string | null, taskId?: string) => {
      setMode(mode);
      return reservedStartPlacement(facts(), reserveFinishing(f.db, "p", facts(), taskId)).kind;
    };
    expect(start("on")).toBe("local");
    for (const mode of ["observe", "off", null]) expect(start(mode)).toBe("peer");
    expect(writeLocalPending()).toEqual([]);
    expect(start(null, "T9")).toBe("peer");
    expect(writeLocalPending()).toMatchObject([{ target: "T9", actionKey: "write-local:start" }]);
  } finally { f.close(); }
});

test("start hook: queued records are written as the scheduler through scheduler-recovery-observe; a refused write is retried next pass", async () => {
  const f = autoFixture();
  try {
    agentPoolWork(snap(), 0, "write", true);
    const calls: string[][] = [];
    let ok = false;
    const ledger = async (...args: string[]) => { calls.push(args); return ok ? { ok: true } : { ok: false, error: "busy" }; };
    const hooks = autostartHooks({ db: f.db, ledger, active: () => {}, lease: undefined });
    const config = { enabled: false, autoDispatch: false, projects: {} } as unknown as SchedulerConfig;
    const pace = { yieldNow: () => false, cursor: {} };
    await hooks.start(config, pace);
    expect(writeLocalPending()).toHaveLength(1);
    ok = true;
    await hooks.start(config, pace);
    await hooks.start(config, pace);
    const want = ["ledger", "scheduler-recovery-observe", "T1", "--mechanism", "writeLocalEqual", "--action-key", "write-local:build:r0", "--action",
      "本会派本机：codex 本机在跑 1 / 名额 8，peer 最少 claude 负载 1", "--data",
      JSON.stringify({ family: "codex", running: 1, total: 8, peerFamily: "claude", peerLoad: 1, window: "build:r0" })];
    expect(calls).toEqual([want, want]);
    expect(writeLocalPending()).toEqual([]);
  } finally { f.close(); }
});
