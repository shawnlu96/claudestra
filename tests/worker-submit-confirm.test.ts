/** RESTATEGO1 · start-order delivery confirmation: resend once past the timeout, stop once confirmed, cap then PM todo; off = untouched. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerAuditTicker } from "../src/bridge/ledger-audit-service.js";
import type { Envelope } from "../src/bridge/router.js";
import { auditLedger } from "../src/lib/ledger-audit.js";
import type { StoredFinding } from "../src/lib/ledger-audit-store.js";
import { collectAuditSnapshots, executorIdleNote, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { sessionTailInfo } from "../src/lib/session-tail.js";
import { baselineAudit, tempLedgerPath } from "./ledger-test-helpers.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { attemptId, CONFIRM_TIMEOUT_MS, confirmDecision, MAX_RESENDS, startDeliveryState, turnStartedFor } from "../src/lib/worker-submit-confirm.js";
import { configureSchedulerV2Intents, schedulerV2EnsureClaimFence, withSchedulerV2Intents, type SchedulerV2IntentPort } from "../src/lib/scheduler-v2-intent.js";
import { withSchedulerV2LedgerCmds } from "../src/lib/scheduler-v2-ledger-cmds.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";
import { ledgercmdFixture } from "./shared-ledger-v2-stage2-ledgercmd-fixture.test.js";
import { intentCenter } from "./shared-ledger-v2-stage2-intent-fixture.test.js";

type F = ReturnType<typeof autoFixture>;
const policy = (mode: RecoveryMode): RecoveryPolicyPort => () => ({ mode, manualAfterMs: null, source: "config" });
const line = (rec: object) => JSON.stringify(rec);
const userLine = (text: string) => line({ type: "user", timestamp: "2026-10-17T00:00:00Z", message: { role: "user", content: text } });
const asstLine = (text: string) => line({ type: "assistant", timestamp: "2026-10-17T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text }] } });
const firstOf = (db: F["db"], node: string) =>
  db.query("SELECT * FROM scheduler_intents WHERE node = ? AND action = 'dispatch' AND id NOT LIKE '%.r%' ORDER BY eventSeq LIMIT 1").get(node) as SchedulerIntent;

/**
 * The confirmation over the real schedulerAutoTick: the fixture's tick deps with the policy, the leased scheduler CLI the
 * service runs (pm-todo needs that lease) and the session text under the test's control. `deps` lets the central case wrap them.
 */
function harness(f: F, mode: { current: RecoveryMode }, wrap: (d: AutoTickDeps) => AutoTickDeps = (d) => d) {
  let session = "";
  f.tickDeps.recoveryPolicy = (...a) => policy(mode.current)(...a);
  f.tickDeps.manager = (...args) => f.cliWith({ assertLease: () => {} }, "scheduler", ...args.slice(1));
  f.tickDeps.sessionText = async () => session;
  const deps = () => wrap(f.tickDeps);
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, deps());
    expect(r.failed).toEqual([]);
    return r.cards[0];
  };
  const events = () => listEvents(f.db, { project: "p", target: "T1" });
  const notes = (prefix: string) => events().filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "startDeliveryConfirm"
    && String(e.data.actionKey).startsWith(prefix));
  const todos = () => events().filter((e) => e.data.op === "pm_todo" && e.data.kind === "start_delivery_unconfirmed");
  return { tick, notes, todos, setSession: (s: string) => { session = s; } };
}

/** A local card past approve_restate with its write wake line sent. */
async function sentWrite(mode: RecoveryMode = "on") {
  const f = autoFixture(), m = { current: mode };
  await toBuild(f);
  const h = harness(f, m);
  expect(await h.tick()).toMatchObject({ step: "sent" });
  return { f, h, m, key: firstOf(f.db, "write").id };
}

describe("confirmDecision (pure)", () => {
  test("confirmed always wins; wait inside the timeout; resend up to the cap; then one escalation", () => {
    const base = { sentAt: 0, resends: [] as number[], confirmed: false, escalated: false };
    expect(confirmDecision({ ...base, confirmed: true }, 10 * CONFIRM_TIMEOUT_MS)).toEqual({ kind: "confirmed" });
    expect(confirmDecision(base, CONFIRM_TIMEOUT_MS - 1).kind).toBe("wait");
    expect(confirmDecision(base, CONFIRM_TIMEOUT_MS)).toEqual({ kind: "resend", attempt: 1 });
    expect(confirmDecision({ ...base, resends: [CONFIRM_TIMEOUT_MS] }, CONFIRM_TIMEOUT_MS + 1).kind).toBe("wait"); // timer restarts from the resend
    const capped = { ...base, resends: Array.from({ length: MAX_RESENDS }, (_, i) => (i + 1) * CONFIRM_TIMEOUT_MS) };
    expect(confirmDecision(capped, (MAX_RESENDS + 1) * CONFIRM_TIMEOUT_MS)).toEqual({ kind: "escalate" });
    expect(confirmDecision({ ...capped, escalated: true }, 99 * CONFIRM_TIMEOUT_MS)).toEqual({ kind: "escalated" });
  });

  test("turnStartedFor: the key in a user record, then a real assistant record; the restart filler and a bare key do not count", () => {
    expect(turnStartedFor([userLine("<channel>有新单 K1</channel>"), asstLine("好的，先领单")].join("\n"), "K1")).toBe(true);
    expect(turnStartedFor(userLine("<channel>有新单 K1</channel>"), "K1")).toBe(false);
    expect(turnStartedFor([userLine("有新单 K1"), asstLine("No response requested.")].join("\n"), "K1")).toBe(false);
    expect(turnStartedFor([asstLine("提到 K1"), asstLine("again")].join("\n"), "K1")).toBe(false);
    expect(turnStartedFor([userLine("别的单 K2"), asstLine("ok")].join("\n"), "K1")).toBe(false);
  });
});

describe("[验收线 2] local card: resend once past the timeout, stop on confirmation, cap → PM todo", () => {
  test("unconfirmed past the timeout: one more attempt as its own intent, over the channel, carrying the key; inside the next timeout nothing", async () => {
    const t = await sentWrite();
    try {
      const before = t.f.sent.length;
      expect(await t.h.tick()).toMatchObject({ step: "waiting" }); // inside the timeout
      t.f.advance(CONFIRM_TIMEOUT_MS);
      expect(await t.h.tick()).toMatchObject({ step: "resent", detail: expect.stringContaining("第 1 次重投") });
      expect(t.f.sent.length).toBe(before + 1);
      expect(t.f.sent.at(-1)).toMatchObject({ route: "channel", key: attemptId(t.key, 1), text: expect.stringContaining(t.key) });
      expect(getIntent(t.f.db, attemptId(t.key, 1))).toMatchObject({ node: "write", action: "dispatch", status: "done", recipient: "agent-task-one" });
      expect(t.h.notes("resend:")).toHaveLength(1);
      expect(await t.h.tick()).toMatchObject({ step: "waiting" }); // the timer restarted from the resend
      expect(t.f.sent.length).toBe(before + 1);
    } finally { t.f.close(); }
  });

  test("once the session shows the turn started (any attempt carries the key), no more resends", async () => {
    const t = await sentWrite();
    try {
      t.f.advance(CONFIRM_TIMEOUT_MS);
      await t.h.tick();
      const n = t.f.sent.length;
      t.h.setSession([userLine(`【调度派单】有新单 ${attemptId(t.key, 1)}`), asstLine("领单")].join("\n"));
      for (let i = 0; i < 3; i++) { t.f.advance(CONFIRM_TIMEOUT_MS); expect(await t.h.tick()).not.toMatchObject({ step: "resent" }); }
      expect(t.f.sent.length).toBe(n);
      expect(t.h.notes("resend:")).toHaveLength(1);
    } finally { t.f.close(); }
  });

  test("capped: after MAX_RESENDS one PM todo, then the tick goes on as before (no loop)", async () => {
    const t = await sentWrite();
    try {
      for (let i = 1; i <= MAX_RESENDS; i++) {
        t.f.advance(CONFIRM_TIMEOUT_MS);
        expect(await t.h.tick()).toMatchObject({ step: "resent" });
      }
      const n = t.f.sent.length;
      t.f.advance(CONFIRM_TIMEOUT_MS);
      expect(await t.h.tick()).toMatchObject({ step: "held", detail: expect.stringContaining("已升级 PM 待办") });
      expect(t.h.todos()).toHaveLength(1);
      expect(t.h.todos()[0]!.text).toContain("重投 2 次（r1 done、r2 done）");
      for (let i = 0; i < 3; i++) { t.f.advance(CONFIRM_TIMEOUT_MS); expect(await t.h.tick()).not.toMatchObject({ step: "resent" }); }
      expect(t.f.sent.length).toBe(n);
      expect(t.h.todos()).toHaveLength(1);
      expect(t.h.notes("resend:")).toHaveLength(MAX_RESENDS);
      expect(startDeliveryState(t.f.db, getTask(t.f.db, "T1")!, 0)).toContain(`已重投 ${MAX_RESENDS}/${MAX_RESENDS} 次（r1 done、r2 done），已升级 PM 待办`);
    } finally { t.f.close(); }
  });

  test("an unreadable session is no evidence: nothing is resent on guesswork", async () => {
    const t = await sentWrite();
    try {
      t.f.tickDeps.sessionText = async () => null;
      const n = t.f.sent.length;
      t.f.advance(10 * CONFIRM_TIMEOUT_MS);
      expect(await t.h.tick()).not.toMatchObject({ step: "resent" });
      expect(t.f.sent.length).toBe(n);
      expect(t.h.notes("")).toHaveLength(0);
    } finally { t.f.close(); }
  });
});

/**
 * Center replica: real schedulerAutoTick, S2I (withSchedulerV2Intents → centralSubmit with X8's persistent journal) and S2Q
 * (withSchedulerV2LedgerCmds) over the fixture's recording center; the channel send is the fixture's. The first order is the
 * restate (a central card's stage moves are the center's), the same delivery path as the write order.
 */
function centralCard() {
  const s = ledgercmdFixture(), center = intentCenter(s.port.clientFor("p")!), m = { current: "on" as RecoveryMode };
  const port: SchedulerV2IntentPort = {
    route: (id) => s.port.route(id), wrapManager: (mgr) => withSchedulerV2LedgerCmds(mgr, s.port),
    fence: () => s.port.fence("feature-one"), claimFence: (taskId, role) => schedulerV2EnsureClaimFence(s.f.db, taskId, role),
    central: (taskId, intentId) => center.bound(taskId, intentId, s.f.task().headSHA, "dispatch"),
    settled: async (_taskId, intentId, to) => { await s.port.sync("p", "feature-one"); const intent = getIntent(s.f.db, intentId); return { ok: intent?.status === to, intent }; },
  };
  configureSchedulerV2Intents(port);
  const h = harness(s.f, m, withSchedulerV2Intents);
  return { ...s, center, h, m, results: () => s.requests.filter((c) => c.type === "operation.result") };
}

describe("[验收线 2] center replica: every resend is a real send under its own center intent", () => {
  test("first send, no turn; each timeout = intent.create + checks + one result + one channel send; capped → PM told once", async () => {
    const c = centralCard();
    try {
      expect(await c.h.tick()).toMatchObject({ step: "session" });
      let last: unknown;
      for (let i = 0; i < 3 && c.f.sent.length === 0; i++) last = await c.h.tick();
      expect(last).toMatchObject({ step: "sent" });
      const key = firstOf(c.f.db, "restate").id;
      expect(c.f.sent).toHaveLength(1);
      for (let n = 1; n <= MAX_RESENDS; n++) {
        c.f.advance(CONFIRM_TIMEOUT_MS);
        const creates = c.requests.filter((r) => r.type === "intent.create").length;
        expect(await c.h.tick()).toMatchObject({ step: "resent", detail: expect.stringContaining("已送出") });
        expect(c.f.sent).toHaveLength(1 + n); // the transport really sent it (round 1 replayed the done intent: 0 sends)
        expect(c.f.sent.at(-1)).toMatchObject({ key: attemptId(key, n), text: expect.stringContaining(key) });
        const created = c.requests.filter((r) => r.type === "intent.create");
        expect(created).toHaveLength(creates + 1);
        expect(created.at(-1)!.type === "intent.create" && created.at(-1)!.payload.operationId).toBe(attemptId(key, n));
        expect(getIntent(c.f.db, attemptId(key, n))?.status).toBe("done"); // projected back from X8's own report
      }
      expect(c.results()).toHaveLength(1 + MAX_RESENDS); // one result per operation, none replayed
      expect(c.center.journal.read(c.center.bound("T1", attemptId(key, 1), c.f.task().headSHA, "dispatch").context)?.state).toBe("confirmed");
      c.f.advance(CONFIRM_TIMEOUT_MS);
      expect(await c.h.tick()).toMatchObject({ step: "held", detail: expect.stringContaining("已升级 PM 待办") });
      for (let i = 0; i < 2; i++) { c.f.advance(CONFIRM_TIMEOUT_MS); await c.h.tick(); }
      expect(c.f.sent).toHaveLength(1 + MAX_RESENDS);
      // S2Q holds a central card's pm-todo (v2_unmapped): the same text reaches PM once as a notice instead
      expect(c.h.todos()).toHaveLength(0);
      expect(c.f.notices.filter((t) => t.includes(`开工单 ${key}`) && t.includes("重投 2 次（r1 done、r2 done）"))).toHaveLength(1);
    } finally { configureSchedulerV2Intents(null); }
  });
});

describe("[验收线 2 / 回归] observe then on (with a restart): observe's would-notes use none of on's budget", () => {
  test("observe: three timeouts, notes only; on after a restart: two real resends, then the PM todo", async () => {
    const t = await sentWrite("observe");
    try {
      const n = t.f.sent.length;
      for (let i = 0; i < 3; i++) { t.f.advance(CONFIRM_TIMEOUT_MS); await t.h.tick(); }
      expect(t.f.sent.length).toBe(n);
      expect(t.h.notes("would-").map((e) => e.data.actionKey)).toEqual([`would-resend:${t.key}:1`, `would-resend:${t.key}:2`, `would-escalate:${t.key}`]);
      expect(t.h.todos()).toHaveLength(0);
      t.f.reader.close(); // a restart: everything below is read back from the ledger
      t.m.current = "on";
      for (let i = 1; i <= MAX_RESENDS; i++) { t.f.advance(CONFIRM_TIMEOUT_MS); expect(await t.h.tick()).toMatchObject({ step: "resent" }); }
      expect(t.f.sent.length).toBe(n + MAX_RESENDS);
      t.f.advance(CONFIRM_TIMEOUT_MS);
      expect(await t.h.tick()).toMatchObject({ step: "held", detail: expect.stringContaining("已升级 PM 待办") });
      expect(t.h.todos()).toHaveLength(1);
    } finally { t.f.close(); }
  });
});

describe("[验收线 4] recovery key off / observe", () => {
  test("off: no read, no note, no resend, no new intent; observe: notes only, nothing sent or planned", async () => {
    for (const mode of ["off", "observe"] as const) {
      const t = await sentWrite(mode);
      try {
        let reads = 0;
        t.f.tickDeps.sessionText = async () => { reads++; return ""; };
        const n = t.f.sent.length, intents = t.f.intents().length;
        for (let i = 0; i <= MAX_RESENDS + 1; i++) { t.f.advance(CONFIRM_TIMEOUT_MS); expect(await t.h.tick()).not.toMatchObject({ step: "resent" }); }
        expect(t.f.sent.length).toBe(n);
        expect(t.f.intents().length).toBe(intents);
        expect(reads).toBe(mode === "off" ? 0 : MAX_RESENDS + 1);
        expect(t.h.notes("")).toHaveLength(mode === "off" ? 0 : MAX_RESENDS + 1);
        expect(t.h.todos()).toHaveLength(0);
      } finally { t.f.close(); }
    }
  });
});

describe("[验收线 3] executor_idle counts from the last real conversation; a touched session file does not reset it", () => {
  const MIN = 60_000, NOW = Date.parse("2026-10-17T00:47:00Z"), EXE = "agent-task-x";
  /** Card X entered build 8 h ago; the executor's last real turn (its restate) was 9 h ago; CC touched the file 25 min ago. */
  async function idle(mode: RecoveryMode) {
    const path = tempLedgerPath("restatego1-idle-"), dir = mkdtempSync(join(tmpdir(), "restatego1-idle-")), jsonl = join(dir, "s.jsonl");
    const db = openLedger(path);
    try {
      setMeta(db, { actor: "owner", now: 0 }, { project: "p", key: "pms", value: ["agent-pm"] });
      baselineAudit(db, "p");
      createTask(db, { actor: "owner", now: NOW - 480 * MIN }, { project: "p", id: "X", title: "X", kind: "code", agent: EXE, pm: "agent-pm", stage: "build" });
      const at = (ms: number) => new Date(ms).toISOString();
      writeFileSync(jsonl, [line({ type: "user", timestamp: at(NOW - 541 * MIN), message: { role: "user", content: "复述单" } }),
        line({ type: "assistant", timestamp: at(NOW - 540 * MIN), message: { role: "assistant", content: [{ type: "text", text: "复述已交" }] } }),
        line({ type: "file-history-snapshot", timestamp: at(NOW - 25 * MIN) })].join("\n"));
      utimesSync(jsonl, new Date(NOW - 25 * MIN), new Date(NOW - 25 * MIN)); // the hourly touch: mtime moves, no new conversation
      const src: SnapshotSources = {
        registry: async () => [EXE, "agent-pm"].map((name): RegistryAgent => ({ name, projectId: "p", cwd: dir, sessionId: "s" })),
        windows: async () => ["master", EXE, "agent-pm"], turn: async () => "idle", reviewers: () => [], heldPath: join(dir, "held.json"),
        fileTimes: async () => ({ lastWriteAt: NOW - 25 * MIN, startedAt: NOW - 600 * MIN }),
        convTs: async () => (await sessionTailInfo(jsonl))?.convTs ?? null, policy: policy(mode),
      };
      const snap = (await collectAuditSnapshots(db, ["p"], NOW, src))[0]!;
      const found = auditLedger(snap, NOW, policy("on")).findings.filter((f) => f.rule === "executor_idle");
      const notes = await Promise.all(found.map((f) => executorIdleNote(db, f, NOW, src)));
      return { found, notes };
    } finally { closeLedger(path); }
  }

  test("on: idle 480 min (since build, the last conversation being older); the note carries both durations and the start-order state", async () => {
    const { found, notes } = await idle("on");
    expect(found.map((f) => f.detail)).toEqual([`X 在 build，执行者 ${EXE} 已空闲 480 分钟，还没交付`]);
    expect(notes).toEqual(["距进入 build 480 分钟；距最后一次真实对话 540 分钟；本 specRev 还没有 write 开工单的派单记录"]);
  });

  test("[验收线 4] off: exactly as before — the file's mtime resets the clock (25 min), no note", async () => {
    const { found, notes } = await idle("off");
    expect(found.map((f) => f.detail)).toEqual([`X 在 build，执行者 ${EXE} 已空闲 25 分钟，还没交付`]);
    expect(notes).toEqual([null]);
  });
});

test("audit service: executor_idle goes out with the note appended; other rules and a missing note keep the original text", async () => {
  const f = (key: string, rule: string): StoredFinding => ({ key, project: "p", taskId: "X", rule: rule as StoredFinding["rule"], firstSeen: 1, lastSeen: 1,
    resolvedAt: null, since: 1, detail: `${rule} 原文`, suggestion: "看看", notify: "pm", notifiedAt: null, queuedAs: null, changedAt: 1 });
  const sent: Envelope[] = [];
  const tick = ledgerAuditTicker({
    clients: new Map([["pm-ch", { ws: {} as never, channelId: "pm-ch" }]]), deliver: async (env) => { sent.push(env); return { outcome: { kind: "sent" } }; },
    hold: () => {}, lastMessageSource: { set: () => {} }, channelOf: () => "pm-ch", busy: async () => false, failureTargets: () => [],
    runManager: async (...args) => args.includes("--json") ? { ok: true, projects: [{ project: "p" }], pending: [f("a", "executor_idle"), f("b", "pm_held")] } : { ok: true },
    pmTodo: { mode: () => "off", record: () => {}, observe: () => {} },
    idleNote: async (x) => x.key === "a" ? "距进入 build 480 分钟；距最后一次真实对话 540 分钟" : null,
  });
  await tick();
  const text = String(sent[0]!.content);
  expect(text).toContain("executor_idle 原文（距进入 build 480 分钟；距最后一次真实对话 540 分钟）");
  expect(text).toContain("pm_held 原文");
  expect(text).not.toContain("pm_held 原文（");
});
