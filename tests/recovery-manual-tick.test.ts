/**
 * dispatch-recovery-MANUAL tick on a temp ledger, through the real write paths (setWorkflow takeover / hold, fallbackToManual,
 * deliver, setFrozen). Covers off / observe / on, waiting vs stalled classes, one card per state version, retry after a failed
 * send, a send still in flight past the backoff, two connections racing on one version, and a card that moves or is frozen
 * between the read and the claim. The module never hands back itself. notify is a recorder; no bridge.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, deliver, moveStage, setFrozen, setMeta } from "../src/lib/ledger-write.js";
import { manualStallRetryAfter, manualStallTick, type ManualStallDeps } from "../src/lib/recovery-manual.js";
import { MERGE_RETRY_PREFIX } from "../src/lib/scheduler-autostart-resume.js";
import type { ServiceFacts } from "../src/lib/scheduler-autostart.js";
import { fallbackToManual } from "../src/lib/scheduler-fallback.js";

const P = "proj-m", T = "m-1", PM = "agent-pm", EXEC = "agent-exec", MIN = 60_000, N = 30 * MIN;
const OLD = "1".repeat(40), NEW = "2".repeat(40);

let dir: string, path: string, db: Database, now: number, sent: { project: string; audience: string; text: string; key: string }[];
let svc: ServiceFacts;

const at = (actor: string) => ({ actor, now: now++ });
const on = (manualAfterMs: number | null = N): ManualStallDeps["policy"] => () => ({ mode: "on", manualAfterMs });
const record: ManualStallDeps["notify"] = async (project, audience, text, key) => void sent.push({ project, audience, text, key });
const deps = (over: Partial<ManualStallDeps> = {}): ManualStallDeps => ({ db, now: now + 2 * N, svc, policy: on(), notify: record, ...over });
/** The tick's db, with `before` run on a second connection right before the claim's transaction opens (another writer between read and claim). */
function writerBeforeClaim(before: (other: Database) => void): Database {
  let done = false;
  return new Proxy(db, { get(t, k) {
    const v = Reflect.get(t, k, t);
    if (k !== "transaction" || done) return typeof v === "function" ? v.bind(t) : v;
    return (fn: () => unknown) => {
      done = true;
      const other = new Database(path);
      try { before(other); } finally { other.close(); }
      return t.transaction(fn);
    };
  } });
}
const workflowEvents = () => listEvents(db, { target: T }).filter((e) => e.data.op === "workflow_resume");
const eventCount = (store = db) => (store.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
const claims = () => db.query("SELECT dedupKey FROM events WHERE dedupKey LIKE 'recovery:manualStall:%' ORDER BY seq").all() as { dedupKey: string }[];
const only = async (d: ManualStallDeps) => {
  const out = await manualStallTick(d);
  expect(out).toHaveLength(1);
  return out[0] as Extract<Awaited<ReturnType<typeof manualStallTick>>[number], { taskId: string }>;
};

/** auto card started building, then PM took it back to manual (the real takeover path) */
function takeover(reason = "worker 会话丢了，PM 接手"): void {
  createTask(db, at(PM), { project: P, id: T, title: "M", kind: "code", agent: EXEC, pm: PM, branch: "feat/m-1" });
  setWorkflow(db, at(PM), { taskId: T, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接管" });
  db.query("UPDATE tasks SET stage = 'build' WHERE id = ?").run(T);
  const w = getWorkflow(db, T)!;
  setWorkflow(db, at(PM), { taskId: T, taskRev: getTask(db, T)!.rev, workflowRev: w.rev, template: "code", templateVersion: 2, mode: "manual",
    authorFamily: "claude", fallback: w.fallback, reason });
}

/** The planner gave a merging card back to PM over a cancelled merge intent; the executor then delivered a new head from fix. */
function mergeRevoked(delivered = true): void {
  createTask(db, at(PM), { project: P, id: T, title: "M", kind: "code", agent: EXEC, pm: PM, branch: "feat/m-1" });
  setWorkflow(db, at(PM), { taskId: T, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接管" });
  db.query("UPDATE tasks SET stage = 'merge', round = 2, headSHA = ? WHERE id = ?").run(OLD, T);
  db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
    VALUES ('mi-1', ?, ?, 'merge_deploy', 'merge', 1, 1, 2, 1, ?, 2, 'cancelled', 'merge', 1, 1)`).run(T, P, OLD);
  fallbackToManual(db, at("scheduler"), { taskId: T, reason: `${MERGE_RETRY_PREFIX}合并意图 mi-1 已取消` });
  moveStage(db, at(PM), { taskId: T, from: "merge", to: "fix" });
  if (delivered) deliver(db, at(EXEC), { taskId: T, headSHA: NEW, moveFrom: "fix" });
}

beforeEach(() => {
  now = 1_000;
  sent = [];
  svc = { autoDispatch: true, projects: [P], maxWorkers: () => 4 };
  dir = mkdtempSync(join(tmpdir(), "recovery-manual-tick-"));
  path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
});
afterEach(() => {
  closeLedger(path);
  rmSync(dir, { recursive: true, force: true });
});

describe("modes", () => {
  test("off reads no card and writes nothing", async () => {
    takeover();
    const before = eventCount();
    expect(await manualStallTick(deps({ policy: () => ({ mode: "off", manualAfterMs: 0 }) }))).toEqual([{ project: P, mode: "off", diag: null }]);
    expect([eventCount(), sent.length]).toEqual([before, 0]);
  });

  test("missing port: observe with no threshold — classifies, judges nothing stalled, writes nothing", async () => {
    takeover();
    const before = eventCount();
    expect(await only(deps({ policy: undefined }))).toMatchObject({ mode: "observe", cls: "pm_takeover", action: "none", why: expect.stringContaining("未设") });
    expect([eventCount(), sent.length]).toEqual([before, 0]);
  });

  test("on with a null threshold sends nothing either (no private default)", async () => {
    takeover();
    expect(await only(deps({ policy: on(null), now: now + 365 * 24 * 3600_000 }))).toMatchObject({ action: "none" });
    expect(sent).toEqual([]);
  });

  test("observe past the threshold reports the card it would send and does not touch the ledger", async () => {
    takeover();
    const before = eventCount();
    const r = await only(deps({ policy: () => ({ mode: "observe", manualAfterMs: N }) }));
    expect(r).toMatchObject({ action: "would_notify", card: { audience: "pm", cls: "pm_takeover" } });
    expect(r.why).toContain("worker 会话丢了");
    expect([eventCount(), sent.length]).toEqual([before, 0]);
  });
});

describe("waiting is not unattended", () => {
  test("PM / owner hold (manual→manual with a reason) is a hold, never a card", async () => {
    takeover();
    const w = getWorkflow(db, T)!;
    setWorkflow(db, at(PM), { taskId: T, taskRev: getTask(db, T)!.rev, workflowRev: w.rev, template: "code", templateVersion: 2, mode: "manual",
      authorFamily: "claude", fallback: w.fallback, reason: "owner 说先放着，下周再排" });
    expect(await only(deps())).toMatchObject({ cls: "held", action: "none", why: expect.stringContaining("下周再排") });
    expect(sent).toEqual([]);
  });

  test("a frozen queue, an open ask and a submitted order are each waiting", async () => {
    takeover();
    db.query(`INSERT INTO asks (id, project, taskId, fromAgent, fromChannelId, source, kind, title, expiresAt, state, createdAt, updatedAt)
      VALUES ('ask-1', ?, ?, ?, 'c', 'reply', 'authorize', '要不要放行', 9e15, 'open', 1, 1)`).run(P, T, EXEC);
    expect(await only(deps())).toMatchObject({ cls: "approval_wait", action: "none" });
    db.query("UPDATE asks SET state = 'answered'").run();
    db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
      VALUES ('di-1', ?, ?, 'write', 'dispatch', 1, 1, 1, 1, NULL, 2, 'submitted', 'd', 1, 1)`).run(T, P);
    expect(await only(deps())).toMatchObject({ cls: "external_wait", action: "none" });
    setFrozen(db, at(PM), { project: P, frozen: true, reason: "发版冻结" });
    expect(await only(deps())).toMatchObject({ cls: "frozen", action: "none", why: expect.stringContaining("发版冻结") });
    expect(sent).toEqual([]);
  });
  test("an open refusal record does not outrank a normal wait: an ask or an order out is still waiting (wait-race r2)", async () => {
    takeover();
    appendEvent(db, at("scheduler"), { project: P, target: T, kind: "escalate", text: "审查模型拒审", data: { op: "model_safety_hold" } });
    db.query(`INSERT INTO asks (id, project, taskId, fromAgent, fromChannelId, source, kind, title, expiresAt, state, createdAt, updatedAt)
      VALUES ('ask-r', ?, ?, ?, 'c', 'reply', 'authorize', '拒审后要不要换审', 9e15, 'open', 1, 1)`).run(P, T, PM);
    expect(await only(deps())).toMatchObject({ cls: "approval_wait", action: "none" });
    db.query("UPDATE asks SET state = 'answered'").run();
    db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
      VALUES ('ri-1', ?, ?, 'review', 'dispatch', 1, 1, 1, 1, NULL, 2, 'submitted', 'd', 1, 1)`).run(T, P);
    expect(await only(deps())).toMatchObject({ cls: "external_wait", action: "none" });
    expect([sent.length, claims().length]).toEqual([0, 0]);
  });

  test("an approval ask that lands between the read and the claim on a refused card: raced, nothing sent (wait-race r2)", async () => {
    takeover();
    appendEvent(db, at("scheduler"), { project: P, target: T, kind: "escalate", text: "审查模型拒审", data: { op: "model_safety_hold" } });
    const ask = writerBeforeClaim((o) => o.query(`INSERT INTO asks (id, project, taskId, fromAgent, fromChannelId, source, kind, title, expiresAt, state, createdAt, updatedAt)
      VALUES ('ask-r2', ?, ?, ?, 'c', 'reply', 'authorize', '拒审后要不要豁免', 9e15, 'open', 1, 1)`).run(P, T, PM));
    expect(await only(deps({ db: ask }))).toMatchObject({ action: "raced", why: expect.stringContaining("审批等待") });
    expect([sent.length, claims().length]).toEqual([0, 0]);
    expect(await only(deps())).toMatchObject({ cls: "approval_wait", action: "none" });
  });
});

describe("on: one prepared card per state version", () => {
  test("PM takeover stalled past N → one PM card; the next tick dedups; the notice itself does not reset the clock", async () => {
    takeover();
    const r = await only(deps());
    expect(r).toMatchObject({ action: "notified", card: { audience: "pm", command: expect.stringContaining(`workflow-resume ${T} --rev`) } });
    expect(sent).toEqual([{ project: P, audience: "pm", text: expect.stringContaining("下一步："), key: expect.stringMatching(/^recovery:manualStall:/) }]);
    expect(claims().map((c) => c.dedupKey.endsWith(":sent"))).toEqual([false, true]);
    expect(await only(deps())).toMatchObject({ action: "deduped" });
    expect(sent).toHaveLength(1);
    expect(listEvents(db, { target: T }).some((e) => e.data.recovery)).toBe(false);
  });

  test("a new card event is a new state version: fresh until N again, then exactly one more card", async () => {
    takeover();
    await only(deps());
    appendEvent(db, at(EXEC), { project: P, target: T, kind: "note", text: "还在弄，卡在依赖升级" });
    expect(await only(deps({ now }))).toMatchObject({ action: "none", why: expect.stringContaining("未到阈值") });
    expect(await only(deps())).toMatchObject({ action: "notified" });
    expect(await only(deps())).toMatchObject({ action: "deduped" });
    expect(sent).toHaveLength(2);
  });

  test("an open model safety hold goes to the owner, is never handed back and never carries an approval", async () => {
    takeover();
    appendEvent(db, at("scheduler"), { project: P, target: T, kind: "escalate", text: "审查模型拒审", data: { op: "model_safety_hold" } });
    const r = await only(deps());
    expect(r).toMatchObject({ cls: "provider_refusal", action: "notified", card: { audience: "owner", command: null } });
    expect(sent[0].audience).toBe("owner");
    expect(getWorkflow(db, T)!.mode).toBe("manual");
  });

  test("a failed send leaves no sent marker, waits the backoff, then retries once as attempt 2", async () => {
    takeover();
    const t0 = now + 2 * N;
    expect(await only(deps({ now: t0, notify: async () => { throw new Error("bridge 不在"); } }))).toMatchObject({ action: "failed", why: "bridge 不在" });
    expect(await only(deps({ now: t0 + 1 }))).toMatchObject({ action: "retry_wait" });
    expect(await only(deps({ now: t0 + manualStallRetryAfter(1) }))).toMatchObject({ action: "notified" });
    expect(claims().map((c) => c.dedupKey.replace(/^.*:/, ""))).toEqual([expect.any(String), expect.stringMatching(/#2$/), "sent"]);
    expect(sent).toHaveLength(1);
    // attempt 2 hands notify the same key as attempt 1 (the claim row without #n), so the delivery side can drop a repeat
    expect(sent[0].key).toBe(claims()[0].dedupKey);
  });

  test("a send still out past the backoff is not re-sent by the next tick (one card per version)", async () => {
    takeover();
    const t0 = now + 2 * N;
    let release!: () => void;
    const hanging: ManualStallDeps["notify"] = (...a) => new Promise<void>((r) => { release = r; }).then(() => record(...a));
    const first = manualStallTick(deps({ now: t0, notify: hanging }));
    await Promise.resolve();
    expect(claims()).toHaveLength(1);
    expect(await only(deps({ now: t0 + manualStallRetryAfter(1) }))).toMatchObject({ action: "retry_wait", why: expect.stringContaining("还没返回") });
    release();
    expect((await first)[0]).toMatchObject({ action: "notified" });
    expect(await only(deps({ now: t0 + manualStallRetryAfter(2) }))).toMatchObject({ action: "deduped" });
    expect(sent).toHaveLength(1);
    expect(claims().map((c) => c.dedupKey.endsWith(":sent"))).toEqual([false, true]);
  });

  test("frozen, held or asked between the read and the claim: the claim re-decides and sends nothing", async () => {
    takeover();
    const freeze = writerBeforeClaim((o) => setFrozen(o, at(PM), { project: P, frozen: true, reason: "owner pause during dispatch" }));
    expect(await only(deps({ db: freeze }))).toMatchObject({ action: "raced", why: expect.stringContaining("项目队列冻结") });
    expect([sent.length, claims().length]).toEqual([0, 0]);
    expect(await only(deps())).toMatchObject({ cls: "frozen", action: "none" });
    setFrozen(db, at(PM), { project: P, frozen: false });
    const ask = writerBeforeClaim((o) => o.query(`INSERT INTO asks (id, project, taskId, fromAgent, fromChannelId, source, kind, title, expiresAt, state, createdAt, updatedAt)
      VALUES ('ask-2', ?, ?, ?, 'c', 'reply', 'authorize', '要不要放行', 9e15, 'open', 1, 1)`).run(P, T, EXEC));
    expect(await only(deps({ db: ask, now: now + 4 * N }))).toMatchObject({ action: "raced", why: expect.stringContaining("审批等待") });
    expect([sent.length, claims().length]).toEqual([0, 0]);
  });

  test("two connections racing on one version send one card", async () => {
    takeover();
    const other = new Database(path);
    try {
      const rs = await Promise.all([manualStallTick(deps()), manualStallTick(deps({ db: other }))]);
      // The loser sees the winner's claim still unconfirmed (in flight), so it waits the backoff instead of sending.
      expect(rs.flat().map((r) => "action" in r && r.action).sort()).toEqual(["notified", "retry_wait"]);
      expect(claims()).toHaveLength(2);
      expect(sent).toHaveLength(1);
    } finally {
      other.close();
    }
  });
});

describe("never hands back itself", () => {
  test("every proof present, switches open, mode on, still manual past N → a PM card with the formal resume command; mode stays manual", async () => {
    mergeRevoked();
    const t = getTask(db, T)!, w = getWorkflow(db, T)!;
    const r = await only(deps());
    expect(r).toMatchObject({ cls: "merge_revoked", action: "notified", card: { audience: "pm", command: `ledger workflow-resume ${T} --rev ${t.rev} --workflow-rev ${w.rev} --reason <核对结论>` } });
    expect(r.card!.step).toContain("既有自动交回");
    expect([getWorkflow(db, T)!.mode, workflowEvents().length]).toEqual(["manual", 0]);
  });

  test("frozen while the proofs are all present: waiting, no card, no hand-back", async () => {
    mergeRevoked();
    const freeze = writerBeforeClaim((o) => setFrozen(o, at(PM), { project: P, frozen: true, reason: "owner pause during dispatch" }));
    expect(await only(deps({ db: freeze }))).toMatchObject({ action: "raced" });
    expect(await only(deps())).toMatchObject({ cls: "frozen", action: "none" });
    expect([sent.length, getWorkflow(db, T)!.mode, workflowEvents().length]).toEqual([0, "manual", 0]);
  });

  test("observe reports the card it would send; the card stays manual", async () => {
    mergeRevoked();
    expect(await only(deps({ policy: () => ({ mode: "observe", manualAfterMs: N }) }))).toMatchObject({ action: "would_notify" });
    expect([sent.length, getWorkflow(db, T)!.mode]).toEqual([0, "manual"]);
  });

  test("auto-dispatch off → a PM card naming the switch", async () => {
    mergeRevoked();
    svc = { ...svc, autoDispatch: false };
    const r = await only(deps());
    expect(r).toMatchObject({ action: "notified", card: { audience: "pm" } });
    expect(r.card!.step).toContain("开关不允许");
    expect(getWorkflow(db, T)!.mode).toBe("manual");
  });

  test("no new delivery yet → a PM card that names the executor", async () => {
    mergeRevoked(false);
    const r = await only(deps());
    expect(r.card!.step).toContain(`催 ${EXEC}`);
  });

  test("a card that moved between the read and the claim is raced, not sent", async () => {
    takeover();
    const moved = writerBeforeClaim((o) => appendEvent(o, at(PM), { project: P, target: T, kind: "note", text: "PM 在对账" }));
    expect(await only(deps({ db: moved }))).toMatchObject({ action: "raced" });
    expect(sent).toEqual([]);
  });
});
