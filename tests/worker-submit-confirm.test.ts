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
import { boundRef } from "../src/lib/scheduler-auto-tick.js";
import { CONFIRM_TIMEOUT_MS, confirmDecision, confirmStart, MAX_RESENDS, startDeliveryState, turnStartedFor, type SessionText } from "../src/lib/worker-submit-confirm.js";
import type { WorkerObservation } from "../src/lib/worker-session.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const policy = (mode: RecoveryMode): RecoveryPolicyPort => () => ({ mode, manualAfterMs: null, source: "config" });
const lastWrite = (f: F) => f.db.query("SELECT * FROM scheduler_intents WHERE node = 'write' ORDER BY eventSeq DESC LIMIT 1").get() as SchedulerIntent;
const running: WorkerObservation = { state: "running", busy: false };
const line = (rec: object) => JSON.stringify(rec);
const userLine = (text: string) => line({ type: "user", timestamp: "2026-10-17T00:00:00Z", message: { role: "user", content: text } });
const asstLine = (text: string) => line({ type: "assistant", timestamp: "2026-10-17T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text }] } });

/** A card past approve_restate with its write wake line sent; session text and policy are the test's. */
async function sentWrite(mode: RecoveryMode = "on") {
  const f = autoFixture();
  await toBuild(f);
  expect(await f.tick()).toMatchObject({ step: "sent" });
  const sent = lastWrite(f), ref = boundRef(f.db, "T1", "author")!;
  let session = "";
  const read: SessionText = async () => session;
  // the service's ledger CLI runs under a leased scheduler identity; the fixture's manager has no lease, which the pm-todo writer needs
  const manager = (...args: string[]) => f.cliWith({ assertLease: () => {} }, "scheduler", ...args.slice(1));
  const card = () => ({ db: f.db, task: getTask(f.db, "T1")!, deps: { ...f.tickDeps, manager, recoveryPolicy: policy(mode) } });
  const step = () => confirmStart(card(), sent, ref, f.tickDeps.worker(ref) as never, running, read);
  const notes = (prefix: string) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "recovery_observe" && String(e.data.actionKey).startsWith(prefix));
  return { f, sent, ref, step, notes, setSession: (s: string) => { session = s; } };
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

describe("[验收线 2] resend once past the timeout, stop on confirmation, cap → PM todo", () => {
  test("unconfirmed past the timeout: one resend over the channel under the same key; inside the next timeout nothing more", async () => {
    const t = await sentWrite();
    try {
      const before = t.f.sent.length;
      expect(await t.step()).toBeNull(); // inside the timeout
      t.f.advance(CONFIRM_TIMEOUT_MS);
      expect(await t.step()).toEqual(["resent", expect.stringContaining("第 1 次重投：已送出")]);
      expect(t.f.sent.length).toBe(before + 1);
      expect(t.f.sent.at(-1)).toMatchObject({ route: "channel", key: t.sent.id, text: expect.stringContaining(t.sent.id) });
      expect(t.notes("resend:")).toHaveLength(1);
      expect(await t.step()).toBeNull(); // the timer restarted from the resend
      expect(t.f.sent.length).toBe(before + 1);
    } finally { t.f.close(); }
  });

  test("once the session shows the turn started, no more resends", async () => {
    const t = await sentWrite();
    try {
      t.f.advance(CONFIRM_TIMEOUT_MS);
      await t.step();
      const n = t.f.sent.length;
      t.setSession([userLine(`【调度派单】有新单 ${t.sent.id}`), asstLine("领单")].join("\n"));
      t.f.advance(10 * CONFIRM_TIMEOUT_MS);
      expect(await t.step()).toBeNull();
      expect(t.f.sent.length).toBe(n);
      expect(t.notes("resend:")).toHaveLength(1);
    } finally { t.f.close(); }
  });

  test("capped: after MAX_RESENDS one PM todo, then the tick goes on as before (no loop)", async () => {
    const t = await sentWrite();
    try {
      for (let i = 1; i <= MAX_RESENDS; i++) {
        t.f.advance(CONFIRM_TIMEOUT_MS);
        expect((await t.step())?.[0]).toBe("resent");
      }
      const n = t.f.sent.length;
      t.f.advance(CONFIRM_TIMEOUT_MS);
      expect(await t.step()).toEqual(["held", expect.stringContaining("已升级 PM 待办")]);
      const todos = listEvents(t.f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "pm_todo");
      expect(todos).toHaveLength(1);
      expect(todos[0].data.kind).toBe("start_delivery_unconfirmed");
      for (let i = 0; i < 3; i++) { t.f.advance(CONFIRM_TIMEOUT_MS); expect(await t.step()).toBeNull(); }
      expect(t.f.sent.length).toBe(n);
      expect(t.notes("resend:")).toHaveLength(MAX_RESENDS);
      expect(startDeliveryState(t.f.db, getTask(t.f.db, "T1")!, 0)).toContain(`已重投 ${MAX_RESENDS}/${MAX_RESENDS} 次，已升级 PM 待办`);
    } finally { t.f.close(); }
  });

  test("an unreadable session is no evidence: nothing is resent on guesswork", async () => {
    const t = await sentWrite();
    try {
      t.f.advance(10 * CONFIRM_TIMEOUT_MS);
      const n = t.f.sent.length;
      const ref = t.ref, card = { db: t.f.db, task: getTask(t.f.db, "T1")!, deps: { ...t.f.tickDeps, recoveryPolicy: policy("on") } };
      expect(await confirmStart(card, t.sent, ref, t.f.tickDeps.worker(ref) as never, running, async () => null)).toBeNull();
      expect(t.f.sent.length).toBe(n);
    } finally { t.f.close(); }
  });
});

describe("[验收线 4] recovery key off / observe", () => {
  test("off: no read, no note, no resend; observe: notes only, nothing sent", async () => {
    for (const mode of ["off", "observe"] as const) {
      const t = await sentWrite(mode);
      try {
        const n = t.f.sent.length;
        for (let i = 0; i <= MAX_RESENDS + 1; i++) { t.f.advance(CONFIRM_TIMEOUT_MS); expect(await t.step()).toBeNull(); }
        expect(t.f.sent.length).toBe(n);
        expect(t.notes("")).toHaveLength(mode === "off" ? 0 : MAX_RESENDS + 1);
        expect(listEvents(t.f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "pm_todo")).toHaveLength(0);
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
