import { afterEach, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH, recoveryPolicy } from "../src/lib/recovery-policy.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { createTask } from "../src/lib/ledger-write.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { beginStaleReviewerSwap, staleReplacementFact } from "../src/lib/scheduler-review-stale.js";
import { exemptSession, mayRebindReviewer, refusalEpoch } from "../src/lib/scheduler-review-swap.js";
import { bindSchedulerSession, getSchedulerSession, recordSessionRetirement } from "../src/lib/scheduler-sessions.js";
import { staleFixture } from "./scheduler-review-stale-fixture.test.js";
import { H2 } from "./scheduler-auto-helpers.js";

let close: (() => void)[] = [];
afterEach(() => { for (const c of close.splice(0).reverse()) c(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });
const policy = (mode: string) => writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { staleReplacement: mode } } } }));
function setup(opts: Parameters<typeof staleFixture>[0] = {}) { const s = staleFixture(opts); close.push(s.f.close); policy("on"); return s; }
function planned(s: ReturnType<typeof setup>) {
  const p = planScheduler(s.snapshot());
  expect(p.kind).toBe("intent");
  if (p.kind !== "intent") throw new Error(p.reason);
  return planIntent(s.f.db, s.f.at("scheduler"), { ...p, taskId: "T1", taskRev: s.f.task().rev, workflowRev: s.snapshot().workflow!.rev,
    recipient: p.recipient ?? undefined, causalSeq: s.snapshot().events.at(-1)!.seq }).intent;
}

test("[验收线 1] N3 来源轮次前移，规划退休意图", () => {
  const s = setup();
  const p = planScheduler(s.snapshot());
  expect(p).toMatchObject({ kind: "intent", id: s.id, action: "review_swap", node: "adversarial_review", recipient: null, resources: [s.resource] });
  expect(planScheduler(s.snapshot())).toEqual(p);
});

test("[验收线 8] 新键恰好一次；缺省与项目继承沿用原语义", () => {
  expect(RECOVERY_KEYS.filter((k) => k === "staleReplacement")).toHaveLength(1);
  rmSync(RECOVERY_POLICY_PATH, { force: true });
  expect(recoveryPolicy("p", "staleReplacement").mode).toBe("observe");
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { mode: "on" } } }));
  expect(recoveryPolicy("p", "staleReplacement").mode).toBe("on");
  writeFileSync(RECOVERY_POLICY_PATH, "broken");
  expect(recoveryPolicy("p", "staleReplacement").mode).toBe("off");
});

test("[验收线 5] 非命中快照不加字段；普通替换、当前窗口、同轮只换 head、peer、manual、安全拒绝、共用均排除", () => {
  const cases = [
    (s: ReturnType<typeof setup>) => s.f.db.run("UPDATE tasks SET round = 3, headSHA = ? WHERE id = 'T1'", [s.swap.data.head as string]),
    (s: ReturnType<typeof setup>) => s.f.db.run("UPDATE tasks SET round = 3 WHERE id = 'T1'"),
    (s: ReturnType<typeof setup>) => s.f.db.run("UPDATE scheduler_sessions SET transport = 'peer'"),
    (s: ReturnType<typeof setup>) => s.f.db.run("UPDATE task_workflows SET mode = 'manual'"),
    (s: ReturnType<typeof setup>) => s.event("scheduler", { op: "model_safety_hold" }),
    (s: ReturnType<typeof setup>) => s.f.db.run("UPDATE tasks SET agent = ? WHERE id = 'T1'", [s.agent]),
    (s: ReturnType<typeof setup>) => s.f.db.run("UPDATE task_workflows SET specRev = 2"),
    (s: ReturnType<typeof setup>) => s.f.db.run("UPDATE scheduler_intents SET node = 'build' WHERE id = 'ensure-r3'"),
    (s: ReturnType<typeof setup>) => s.event("review", { round: 4, specRev: 1, head: H2 }),
  ];
  for (const opts of [{ swap: { legacy: false } }, { ordinary: true }, { swap: { refusal: {} } }]) {
    const s = setup(opts);
    expect(staleReplacementFact(s.f.db, s.f.task())).toBeNull();
    expect(Object.hasOwn(s.snapshot(), "staleReplacement")).toBe(false);
  }
  for (const change of cases) {
    const s = setup(); change(s);
    expect(staleReplacementFact(s.f.db, s.f.task())).toBeNull();
    const snapshot = s.snapshot();
    expect(Object.hasOwn(snapshot, "staleReplacement")).toBe(false);
    expect(planScheduler(snapshot)).not.toMatchObject({ action: "review_swap", id: s.id });
  }
});

test("[验收线 5] 本轮审查在途或完成则 wait；取消过的退休 id 不重开", () => {
  for (const status of ["submitted", "done"]) {
    const s = setup(); s.intent(`review-${status}`, "review", status, s.snapshot().events.at(-1)!.seq);
    expect(planScheduler(s.snapshot())).toMatchObject({ kind: "wait" });
  }
  const s = setup(); s.intent(s.id, "review_swap", "cancelled");
  expect(planScheduler(s.snapshot())).toMatchObject({ kind: "intent", action: "review", recipient: s.agent });
});

test("[验收线 5] 活出借单、其他卡的活绑定、当前作者绑定均不退休", () => {
  for (const status of ["pooled", "claimed", "unknown"]) {
    const s = setup();
    s.f.db.run(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
      status, leaseMs, createdBy, createdAt, updatedAt) VALUES ('live', 'T1', 'p', 'peer', 'codex', 'review', 1, 4, ?, 'x/y', '{}', '', '', ?, 1000, 'scheduler', 1, 1)`,
      [H2, status]);
    expect(staleReplacementFact(s.f.db, s.f.task())).toBeNull();
    expect(planScheduler(s.snapshot())).not.toMatchObject({ id: s.id, action: "review_swap" });
  }
  for (const other of [true, false]) {
    const s = setup(), taskId = other ? "T2" : "T1";
    if (other) createTask(s.f.db, s.f.at("owner"), { project: "p", id: taskId, title: "other", kind: "code" });
    s.f.db.run(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES (?, 'author', ?, 's-shared', 'codex', 'acp', 'active', 'ensure-r3', 1, 1)`, [taskId, s.agent]);
    expect(staleReplacementFact(s.f.db, s.f.task())).toBeNull();
  }
});

test("[验收线 6] 写口身份、策略、窗口、绑定、未结意图及 id 漂移全部拒绝且零写", () => {
  const cases = [
    (s: ReturnType<typeof setup>) => policy("observe"),
    (s: ReturnType<typeof setup>) => policy("off"),
    (s: ReturnType<typeof setup>) => s.f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["3".repeat(40)]),
    (s: ReturnType<typeof setup>) => s.f.db.run("UPDATE tasks SET round = 5 WHERE id = 'T1'"),
    (s: ReturnType<typeof setup>) => s.f.db.run("UPDATE tasks SET specRev = 2 WHERE id = 'T1'"),
    (s: ReturnType<typeof setup>) => s.f.db.run("UPDATE scheduler_sessions SET sessionId = 'another'"),
    (s: ReturnType<typeof setup>) => s.intent("other", "ask", "pending"),
  ];
  for (const change of cases) {
    const s = setup(); planned(s); change(s);
    const before = listEvents(s.f.db);
    expect(() => beginStaleReviewerSwap(s.f.db, s.f.at("scheduler"), s.id)).toThrow();
    expect(listEvents(s.f.db)).toEqual(before);
    expect(getSchedulerSession(s.f.db, "T1", "reviewer")?.state).toBe("active");
  }
  const s = setup(); planned(s);
  const before = listEvents(s.f.db);
  expect(() => beginStaleReviewerSwap(s.f.db, s.f.at("owner"), s.id)).toThrow(/只由调度服务/);
  expect(() => beginStaleReviewerSwap(s.f.db, s.f.at("scheduler"), "wrong")).toThrow();
  expect(listEvents(s.f.db)).toEqual(before);
});

test("[验收线 6] 事务退休一次；策略改 off 后重复调用仍返回旧行；审查历史不改", () => {
  const s = setup(); planned(s);
  const before = listEvents(s.f.db), ensure = getIntent(s.f.db, "ensure-r3");
  const retired = beginStaleReviewerSwap(s.f.db, s.f.at("scheduler"), s.id);
  expect(retired).toMatchObject({ state: "retired", retireIntentId: s.id });
  const events = listEvents(s.f.db), swap = events.at(-1)!;
  expect(swap.data).toMatchObject({ op: "reviewer_swap", fromFamily: "codex", toFamily: "claude", head: H2, round: 4,
    stale: { seq: s.swap.seq, tag: "-re", round: 3, head: s.swap.data.head, specRev: 1 } });
  expect(swap.data).not.toHaveProperty("legacy"); expect(swap.data).not.toHaveProperty("refusal");
  expect(events.slice(0, before.length)).toEqual(before);
  expect(getIntent(s.f.db, "ensure-r3")).toEqual(ensure);
  policy("off");
  expect(beginStaleReviewerSwap(s.f.db, s.f.at("scheduler"), s.id)).toEqual(retired);
  expect(listEvents(s.f.db)).toEqual(events);
});

test("[验收线 7] 不放宽 kill、跨家族和普通退休门；旧豁免不延续", () => {
  const s = setup(); planned(s);
  const retired = beginStaleReviewerSwap(s.f.db, s.f.at("scheduler"), s.id);
  expect(refusalEpoch(listEvents(s.f.db), s.f.task())).toBeNull();
  expect(exemptSession(listEvents(s.f.db), s.f.task(), s.sessionId, "codex")).toBe(false);
  s.intent("new-ensure", "ensure_session", "submitted", s.event("scheduler", { op: "new_ensure" }).seq);
  expect(mayRebindReviewer(s.f.db, retired, "new-ensure")).toBe(false);
  expect(() => recordSessionRetirement(s.f.db, s.f.at("scheduler"), { taskId: "T1", role: "reviewer", intentId: s.id,
    effect: "archive", receipt: "x" })).toThrow(/未验证/);
  s.f.db.run("UPDATE scheduler_intents SET status = 'done' WHERE id = ?", [s.id]);
  s.f.db.run("UPDATE scheduler_sessions SET archiveReceipt = 'x', killReceipt = 'x'");
  const registry = `${s.f.dir}/bad-registry.json`;
  writeFileSync(registry, JSON.stringify({ agents: { "agent-new": { runtime: "claude-code", sessionId: "s-new" } } }));
  expect(() => bindSchedulerSession(s.f.db, s.f.at("scheduler"), { taskId: "T1", role: "reviewer", intentId: "new-ensure",
    agent: "agent-new", sessionId: "s-new", family: "claude", transport: "tmux", registryPath: registry })).toThrow(/跨模型审查规则不符/);
});
