/**
 * i28-SR1: a security card's review whose family has local cap 0 is reported (one alarm event + one PM ask per card and reason),
 * a merely busy family keeps queueing, and non-security cards still pool as before.
 */
import { describe, expect, test } from "bun:test";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { reviewPlacement } from "../src/lib/scheduler-placement-plan.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import type { PoolFacts } from "../src/lib/scheduler-pool-plan.js";
import { raiseSecReviewNoRoom, SEC_REVIEW_NO_ROOM, secReviewNoRoom } from "../src/lib/scheduler-sec-review.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const HEAD = "a".repeat(40);
const REMOTE: RemotePolicy = { mode: "balance", roles: ["review"], poolTimeoutMin: 15 };
const author: WorkerRef = { agent: "agent-author", sessionId: "s-a", taskId: "T1", family: "codex", source: "local" };
const ev = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "x", project: "p", target: "T1", text: "x", dedupKey: null });
const pool = (over: Partial<PoolFacts> = {}): PoolFacts => ({ remote: REMOTE, localReviewers: 0, repo: "o/r", lastPeer: null,
  peers: [{ peer: "mate", open: 0, maxOpen: 2, roles: ["review"], v2: { why: null, slots: { codex: 1, claude: 1 }, roles: ["review"], repos: ["o/r"] } }], ...over });
const snap = (template: "code" | "security", over: Partial<PlannerSnapshot> = {}, stage: Stage = "review"): PlannerSnapshot => ({
  task: { id: "T1", project: "p", itemId: null, title: "t", kind: "code", stage, stageBefore: null, round: 1, agent: author.agent, assigneeKind: "agent",
    assignee: author.agent, pm: "pm", branch: "b", pr: "https://github.com/o/r/pull/7", headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1,
    extra: {}, createdAt: 1, updatedAt: 1 } as LedgerTask,
  workflow: { taskId: "T1", project: "p", template, templateVersion: 2, mode: "auto", authorFamily: "codex", fallback: "x", specRev: 1,
    rev: 1, createdAt: 1, updatedAt: 1 },
  events: [ev(1, "task", { op: "new" }), ev(11, "stage", { from: "build", to: stage, round: 1, specRev: 1 })], intents: [], blockedBy: [], queueFrozen: false,
  fileGlobs: ["src/lib/x.ts"], heldResources: [], workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer: null,
  reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null, pool: pool(), ...over,
});
const agents = (claude: number, codex = 2): RemotePolicy => ({ ...REMOTE, agents: { claude, codex } });

describe("planner: security review with local cap 0", () => {
  test("codex author, local claude cap 0 → the fixed reason, not a silent queue (agents and localFamilies alike)", () => {
    for (const remote of [agents(0), { ...REMOTE, localFamilies: ["codex"] } as RemotePolicy, { ...REMOTE, mode: "off", localFamilies: ["codex"] } as RemotePolicy]) {
      const s = snap("security", { pool: pool({ remote }) });
      expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "placement", reason: expect.stringContaining(SEC_REVIEW_NO_ROOM) });
      expect(reviewPlacement(s, 0)).toMatchObject({ wait: expect.stringContaining("本机 claude 名额上限是 0") });
    }
  });

  test("cap above 0 but busy → the old queue reason, no alarm reason", () => {
    const s = snap("security", { pool: { ...pool({ remote: agents(1) }), localPool: { running: { claude: 1, codex: 0 }, totals: { claude: 1, codex: 2 } } } as PoolFacts });
    expect(secReviewNoRoom(s)).toBeNull();
    const placed = reviewPlacement(s, 0);
    expect(placed).toMatchObject({ wait: "等 claude 空位" });
    expect(JSON.stringify(placed)).not.toContain(SEC_REVIEW_NO_ROOM);
  });

  test("non-security cards are untouched: with local claude cap 0 they still pool to a peer", () => {
    const s = snap("code", { pool: pool({ remote: agents(0) }) });
    expect(secReviewNoRoom(s)).toBeNull();
    expect(reviewPlacement(s, 0)).toMatchObject({ peer: "mate" });
    expect(planScheduler(snap("code"))).toMatchObject({ kind: "intent", action: "review", recipient: "peer:mate" });
  });

  test("a bound reviewer session or no cap configured → unchanged", () => {
    expect(secReviewNoRoom(snap("security", { reviewer: { ...author, family: "claude" }, pool: pool({ remote: agents(0) }) }))).toBeNull();
    expect(secReviewNoRoom(snap("security"))).toBeNull();
    expect(planScheduler(snap("security"))).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "reviewer" });
  });
});

describe("tick: alarm event + PM ask, once per card and reason", () => {
  async function atSecurityReview() {
    const f = autoFixture();
    await toBuild(f);
    await f.tick();
    await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
    expect(f.task().stage).toBe("review");
    f.db.run("UPDATE task_workflows SET template = 'security', authorFamily = 'codex' WHERE taskId = 'T1'");
    return f;
  }
  const tickWith = async (f: Awaited<ReturnType<typeof atSecurityReview>>, remote: RemotePolicy) => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2, remote } }, { ...f.tickDeps, borrow: async () => [] });
    expect(r.failed).toEqual([]);
    return r.cards[0];
  };
  const alarms = (f: Awaited<ReturnType<typeof atSecurityReview>>) =>
    listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "sec_review_no_room");
  const asks = (f: Awaited<ReturnType<typeof atSecurityReview>>) =>
    f.db.query("SELECT title, body, options, state FROM asks WHERE taskId = 'T1' AND dedupKey LIKE 'sec-review-no-room:%'").all() as
      { title: string; body: string; options: string; state: string }[];

  test("security card, codex author, local claude cap 0 → one alarm + one ask; the second tick repeats neither", async () => {
    const f = await atSecurityReview();
    try {
      const notices = f.notices.length;
      expect(await tickWith(f, agents(0))).toMatchObject({ step: "waiting", detail: expect.stringContaining(SEC_REVIEW_NO_ROOM) });
      expect(alarms(f)).toHaveLength(1);
      expect(alarms(f)[0]).toMatchObject({ kind: "note", actor: "scheduler", data: { kind: "alarm", family: "claude" } });
      const [ask] = asks(f);
      expect(asks(f)).toHaveLength(1);
      expect(ask.state).toBe("open");
      expect(ask.body).toContain("a. 本机临时给这张卡开 1 个 claude 名额（default；PM 确认后才执行）");
      expect(ask.body).toContain("owner 批");
      expect(ask.body).toContain("c. 退回作者重写");
      expect(JSON.parse(ask.options)[0].buttons).toHaveLength(3);
      expect(f.notices.slice(notices)).toEqual([expect.stringContaining("default a 要 PM 确认才执行")]);

      expect(await tickWith(f, agents(0))).toMatchObject({ step: "waiting" });
      expect(alarms(f)).toHaveLength(1);
      expect(asks(f)).toHaveLength(1);
      expect(f.notices.length).toBe(notices + 1);
      expect(f.ensured.filter((s) => s.role === "reviewer")).toEqual([]);
    } finally { f.close(); }
  });

  test("the alarm CLI is scheduler-only and refuses a card that is not a security review", async () => {
    const f = await atSecurityReview();
    try {
      expect(await f.cli("pm", "scheduler-sec-review-alarm", "T1", "--rev", String(f.task().rev))).toMatchObject({ ok: false, code: "forbidden" });
      f.db.run("UPDATE task_workflows SET template = 'code' WHERE taskId = 'T1'");
      expect(await f.cli("scheduler", "scheduler-sec-review-alarm", "T1", "--rev", String(f.task().rev))).toMatchObject({ ok: false, code: "conflict" });
      await raiseSecReviewNoRoom(f.db, f.task(), { kind: "wait", code: "placement", reason: "等 claude 空位" }, f.tickDeps);
      expect(alarms(f)).toEqual([]);
    } finally { f.close(); }
  });
});
