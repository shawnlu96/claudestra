import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { latestReviewerSwap, reviewsAfterSwap } from "../src/lib/scheduler-review-swap.js";
import { reviewSwapStep, type ReviewSwapDeps } from "../src/lib/scheduler-review-swap-runtime.js";
import { beginReviewerSwap, bindSchedulerSession, getSchedulerSession, recordReviewerSwapEffect, taskWorkerRefs } from "../src/lib/scheduler-sessions.js";
import { autoFixture, H1, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

const REMOTE: RemotePolicy = { mode: "balance", roles: ["review"], poolTimeoutMin: 15, reviewFirst: ["Sekai", "HedeMacBook-Pro"] };
const borrow: BorrowEntry[] = ["HedeMacBook-Pro", "Sekai"].map((peer) => ({ peer, projects: ["p"], roles: ["review"], maxOpen: 4 }));

async function scenario(security = false) {
  const f = autoFixture({ reviewerRuntime: "claude-code" });
  const registry = () => JSON.parse(readFileSync(f.registryPath, "utf8"));
  const editRegistry = (fn: (r: ReturnType<typeof registry>) => void) => { const r = registry(); fn(r); writeFileSync(f.registryPath, JSON.stringify(r)); };
  editRegistry((r) => {
    Object.assign(r.agents["agent-task-one"], { runtime: "codex", transport: "acp" });
    Object.assign(r.agents["agent-rv-t1"], { transport: "tmux", status: "active" });
  });
  f.db.run("UPDATE task_workflows SET authorFamily = 'codex', template = ?", [security ? "security" : "code"]);
  const spec = join(f.dir, "spec.md"), report = join(f.dir, "findings.json");
  writeFileSync(spec, "只改 src/lib/x.ts，修好后复验");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);
  const verdict = async (family: "claude" | "codex", session: string, findings: object[]) => {
    writeFileSync(report, JSON.stringify(findings));
    return f.cliWith({ callerSession: session }, "agent-rv-t1", "review", "T1", "--reviewer", "agent-rv-t1", "--verdict", findings.length ? "changes" : "pass",
      "--p0", "0", "--p1", String(findings.length), "--p2", "0", "--head", f.task().headSHA!, "--session", session,
      "--family", family, "--findings", report, "--path", `reviews/T1-r${f.task().round}/report.md`);
  };
  await toBuild(f);
  await f.tick();
  expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).toMatchObject({ ok: true });
  expect(await f.tick()).toMatchObject({ step: "session" });
  expect(await f.tick()).toMatchObject({ step: "sent" });
  expect(await verdict("claude", "s-rv", [P1])).toMatchObject({ ok: true });
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
  // Model the takeover's new local author, then deliver the fixed head through the real ledger writer.
  f.db.run("UPDATE task_workflows SET authorFamily = 'claude' WHERE taskId = 'T1'");
  f.db.run("UPDATE scheduler_sessions SET family = 'claude', transport = 'tmux' WHERE taskId = 'T1' AND role = 'author'");
  editRegistry((r) => { Object.assign(r.agents["agent-task-one"], { runtime: "claude-code", transport: "tmux" }); });
  await f.tick();
  expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H2)).toMatchObject({ ok: true });
  expect(f.task().round).toBe(2);

  const effects: string[] = [], state = { archiveOk: true, killOk: true, lostLease: false };
  const effectsDeps: ReviewSwapDeps = {
    registryPath: f.registryPath,
    active: () => { if (state.lostLease) throw new Error("lease lost"); },
    agents: async () => Object.entries(registry().agents).map(([name, value]) => {
      const row = value as { sessionId: string; status: string };
      return { name, ...row, window: row.status !== "stopped", pending: false };
    }),
    agent: async (cmd, agent) => {
      effects.push(`${cmd}:${agent}`);
      if (cmd === "archive") return { ok: state.archiveOk, archived: ["old.jsonl"], error: "archive failed" };
      if (state.killOk) editRegistry((r) => { r.agents[agent].status = "stopped"; });
      return { ok: true };
    },
    ensure: async (task, family) => {
      effects.push(`ensure:${family}`);
      editRegistry((r) => Object.assign(r.agents["agent-rv-t1"], { runtime: family === "codex" ? "codex" : "claude-code",
        transport: family === "codex" ? "acp" : "tmux", sessionId: "s-rv-new", status: "active" }));
      return { kind: "ready", created: true, ref: { taskId: task.id, role: "reviewer", agent: "agent-rv-t1", sessionId: "s-rv-new", family, transport: "acp" } };
    },
  };
  const reports = join(f.dir, "reports"); mkdirSync(reports);
  const key = instanceKeySync(f.dir);
  const lend = { borrow: async () => borrow, notifyPm: async () => {},
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key) } };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args);
  const policy = { maxActiveWorkers: 2, remote: REMOTE };
  const tick = async () => {
    const deps = { ...f.tickDeps, borrow: async () => borrow, manager: (...a: string[]) => a[1] === "scheduler-review-swap"
      ? reviewSwapStep(f.db, f.at("scheduler"), a[2], Number(a[4]), effectsDeps) : cli("scheduler", ...a.slice(1)) };
    const result = await schedulerAutoTick(f.db, { p: policy }, deps);
    if (result.failed.length) throw new Error(JSON.stringify(result.failed));
    return result.cards[0];
  };
  const hello = (peer: string, slots = 2) => recordHello(f.db, peer, null, { v: 1, proto: 2, boot: peer, seq: 1,
    slots: { codex: { total: slots, busy: 0 }, claude: { total: 0, busy: 0 } }, paused: null,
    grant: { until: f.tickDeps.now() + 3600000, roles: ["review"], repos: ["o/r"], ordersPerDay: 50, ordersLeftToday: 50 } }, f.tickDeps.now());
  const snapshot = () => autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: policy.maxActiveWorkers, now: f.tickDeps.now(), pool: { remote: policy.remote, borrow } });
  const swaps = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "reviewer_swap");
  const peer = (op: string, orderId: string, more: object = {}) => cli("owner", `lend-${op}`, "--", "Sekai", JSON.stringify({ v: 1, orderId, ...more }));
  return { f, verdict, effects, effectsDeps, state, cli, tick, hello, snapshot, swaps, peer, policy, editRegistry };
}

async function finishSwap(p: Awaited<ReturnType<typeof scenario>>) {
  expect(await p.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("已归档") });
  expect(taskWorkerRefs(p.f.db, "T1").reviewer).toBeNull();
  expect(await p.tick()).toMatchObject({ step: "session", detail: "旧审查已更换" });
}

function persistPlan(db: Database) {
  const task = getTask(db, "T1")!, workflow = getWorkflow(db, task.id)!;
  const plan = planScheduler(autoSnapshot(db, task, { registry: [], maxWorkers: 2 }));
  if (plan.kind !== "intent") throw new Error(JSON.stringify(plan));
  const seq = (db.query("SELECT MAX(seq) AS n FROM events").get() as { n: number }).n;
  return planIntent(db, { actor: "scheduler", now: 20000 }, { id: plan.id, taskId: task.id, taskRev: task.rev, workflowRev: workflow.rev,
    causalSeq: seq, action: plan.action, node: plan.node, reason: plan.reason, resources: plan.resources }).intent;
}

describe("i28-RI1 automatic reviewer replacement", () => {
  test("codex → Claude takeover: atomic swap in memory retains the old binding and rejects duplicate swaps", async () => {
    const p = await scenario();
    p.f.db.run("PRAGMA journal_mode = DELETE");
    const db = Database.deserialize(p.f.db.serialize());
    try {
      const intent = persistPlan(db);
      expect(intent.action).toBe("review_swap");
      const ctx = { actor: "scheduler", now: 20001 };
      const old = beginReviewerSwap(db, ctx, intent.id);
      expect(old).toMatchObject({ state: "retired", agent: "agent-rv-t1", sessionId: "s-rv", retireIntentId: intent.id });
      expect(beginReviewerSwap(db, ctx, intent.id)).toEqual(old);
      expect(taskWorkerRefs(db, "T1").reviewer).toBeNull();
      expect(latestReviewerSwap(listEvents(db, { project: "p", target: "T1" }))?.data).toMatchObject({
        fromFamily: "codex", toFamily: "claude", round: 2, head: H2, sessionId: "s-rv", agent: "agent-rv-t1" });
      expect(() => recordReviewerSwapEffect(db, ctx, intent.id, "kill", "stopped")).toThrow(/先归档/);
      expect(() => beginReviewerSwap(db, { actor: "owner" }, intent.id)).toThrow(/调度服务/);
      expect(db.query("SELECT COUNT(*) AS n FROM scheduler_sessions WHERE role = 'reviewer'").get()).toEqual({ n: 1 });
    } finally { db.close(); p.f.close(); }
  });

  test("swap → Sekai Codex review → real pool receipt → merge queue, without manual approval", async () => {
    const p = await scenario();
    try {
      p.hello("HedeMacBook-Pro"); p.hello("Sekai");
      expect(planScheduler(p.snapshot())).toMatchObject({ kind: "intent", action: "review_swap" });
      await finishSwap(p);
      expect(p.effects).toEqual(["archive:agent-rv-t1", "kill:agent-rv-t1"]);
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      const [order] = listLendOrders(p.f.db, "T1");
      expect(order).toMatchObject({ peer: "Sekai", family: "codex", status: "pooled", round: 2, head: H2, createdBy: "scheduler" });
      expect(await p.peer("claim", order.orderId, { worker: "w2" })).toMatchObject({ ok: true });
      expect(await p.peer("write", order.orderId, { gen: 1, report: "复验通过", session: { id: "peer-r2", family: "codex" },
        verdict: { v: 1, orderId: order.orderId, head: H2, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "r.md" } })).toMatchObject({ ok: true });
      expect(await p.tick()).toMatchObject({ step: "pool_done" });
      expect(await p.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
      expect(await p.tick()).toMatchObject({ step: "merge_queue" });
      expect(p.f.intents().at(-1)).toMatchObject({ action: "merge", status: "pending" });
      expect(p.f.notices).toEqual([]);
      expect(p.swaps()).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test("same-agent takeover completes within two ticks without stopping the author; other cards still block", async () => {
    const p = await scenario();
    try {
      p.hello("Sekai");
      p.f.db.run("UPDATE tasks SET agent = 'agent-rv-t1' WHERE id = 'T1'");
      p.f.db.run("UPDATE scheduler_sessions SET agent = 'agent-rv-t1' WHERE role = 'author'");
      expect(await p.tick()).toMatchObject({ step: "session", detail: "旧审查已更换" });
      const id = String(p.swaps()[0].data.intentId);
      expect(getIntent(p.f.db, id)).toMatchObject({ status: "done", receipt: "旧审查会话由本卡作者沿用，未停用" });
      expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
      expect(listLendOrders(p.f.db, "T1")[0]).toMatchObject({ peer: "Sekai", family: "codex", round: 2 });
      expect(p.effects).toEqual([]);
      expect(getSchedulerSession(p.f.db, "T1", "author")).toMatchObject({ sessionId: "s-one", state: "active" });
      expect(taskWorkerRefs(p.f.db, "T1").reviewer).toBeNull();
    } finally { p.f.close(); }
    const blocked = await scenario();
    try {
      blocked.f.db.run("UPDATE tasks SET agent = 'agent-rv-t1' WHERE id = 'T1'");
      createTask(blocked.f.db, blocked.f.at("owner"), { project: "p", id: "OTHER", title: "other", kind: "code", agent: "agent-rv-t1" });
      blocked.f.db.run("UPDATE scheduler_sessions SET taskId = 'OTHER', agent = 'agent-rv-t1' WHERE role = 'author'");
      for (let n = 0; n < 2; n++) {
        expect(await blocked.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("另一张卡") });
      }
      expect(getIntent(blocked.f.db, String(blocked.swaps()[0].data.intentId))?.status).toBe("submitted");
      expect(blocked.effects).toEqual([]);
      expect(listLendOrders(blocked.f.db, "T1")).toEqual([]);
    } finally { blocked.f.close(); }
  });

  test("security stays local: new Codex session binds, reviews twice in the same epoch, then passes merge proof", async () => {
    const p = await scenario(true);
    try {
      p.hello("Sekai");
      await finishSwap(p);
      expect(await p.tick()).toMatchObject({ step: "session", detail: "跨家族审查新会话已绑定" });
      expect(p.effects.at(-1)).toBe("ensure:codex");
      expect(listLendOrders(p.f.db, "T1")).toEqual([]);
      expect(getSchedulerSession(p.f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv-new", family: "codex", state: "active" });
      expect(p.f.db.query("SELECT sessionId, state FROM scheduler_sessions WHERE role = 'reviewer' ORDER BY createdAt").all())
        .toEqual([{ sessionId: "s-rv", state: "retired" }, { sessionId: "s-rv-new", state: "active" }]);
      expect(await p.tick()).toMatchObject({ step: "sent" });
      expect(await p.verdict("codex", "s-rv-new", [{ ...P1, findingId: "second" }])).toMatchObject({ ok: true });
      expect(await p.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
      await p.tick();
      await p.f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", "3".repeat(40));
      expect(await p.tick()).toMatchObject({ step: "sent" });
      expect(await p.verdict("codex", "s-rv-new", [])).toMatchObject({ ok: true });
      expect(await p.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
      expect(await p.tick()).toMatchObject({ step: "merge_queue" });
      expect(p.swaps()).toHaveLength(1);
      expect(reviewsAfterSwap(p.snapshot().events)).toHaveLength(2);
    } finally { p.f.close(); }
  });

  test("no peer can take the review → local opposite-family ensure; no slots anywhere → wait then resume", async () => {
    const p = await scenario();
    try {
      p.hello("Sekai", 0); p.hello("HedeMacBook-Pro", 0);
      await finishSwap(p);
      p.policy.maxActiveWorkers = 0;
      expect(planScheduler(p.snapshot())).toMatchObject({ kind: "wait", code: "reviewer_capacity", reason: expect.stringContaining("本机审查名额也已满") });
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      expect(p.f.notices).toEqual([]);
      p.policy.maxActiveWorkers = 2;
      expect(await p.tick()).toMatchObject({ step: "session" });
      expect(p.effects.at(-1)).toBe("ensure:codex");
      expect(await p.tick()).toMatchObject({ step: "sent" });
    } finally { p.f.close(); }
  });

  test("same-round second independence failure escalates once; original no-swap replacement guard remains", async () => {
    const p = await scenario(true);
    try {
      const before = p.snapshot();
      expect(planScheduler({ ...before, reviewer: { ...before.reviewer!, sessionId: "unapproved" } }))
        .toMatchObject({ kind: "escalate", code: "reviewer_replaced" });
      await finishSwap(p); await p.tick();
      p.f.db.run("UPDATE scheduler_sessions SET family = 'claude' WHERE sessionId = 's-rv-new'");
      expect(planScheduler(p.snapshot())).toMatchObject({ kind: "escalate", code: "reviewer_independence" });
      expect(await p.tick()).toMatchObject({ step: "manual" });
      expect(p.swaps()).toHaveLength(1);
    } finally { p.f.close(); }
  });

  test("archive failure retries; kill with a remaining window retries; completed effects are not repeated", async () => {
    const p = await scenario();
    try {
      p.state.archiveOk = false;
      expect(await p.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("归档未完成") });
      expect(p.effects).toEqual(["archive:agent-rv-t1"]);
      p.state.archiveOk = true;
      await p.tick();
      p.state.killOk = false;
      expect(await p.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("窗口") });
      p.state.killOk = true;
      await p.tick();
      const swap = p.swaps()[0];
      const before = [...p.effects];
      expect(await reviewSwapStep(p.f.db, p.f.at("scheduler"), String(swap.data.intentId), 2, p.effectsDeps)).toMatchObject({ ok: true });
      expect(await p.cli("scheduler", "scheduler-review-swap", String(swap.data.intentId), "--max-workers", "2")).toMatchObject({ ok: true });
      expect(await p.cli("owner", "scheduler-review-swap", String(swap.data.intentId), "--max-workers", "2")).toMatchObject({ ok: false, code: "forbidden" });
      expect(p.effects).toEqual(before);
      expect(getIntent(p.f.db, String(swap.data.intentId))?.status).toBe("done");
    } finally { p.f.close(); }
  });

  test("stale head rolls back without a swap event; old session can never be rebound as the replacement", async () => {
    const p = await scenario(true);
    try {
      const intent = persistPlan(p.f.db);
      p.f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", [H1]);
      expect(() => beginReviewerSwap(p.f.db, p.f.at("scheduler"), intent.id)).toThrow(/过期/);
      expect(p.swaps()).toEqual([]);
      expect(getSchedulerSession(p.f.db, "T1", "reviewer")?.state).toBe("active");
      p.f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", [H2]);
      await finishSwap(p);
      const ensure = persistPlan(p.f.db);
      p.f.db.run("UPDATE scheduler_intents SET status = 'submitted' WHERE id = ?", [ensure.id]);
      p.editRegistry((r) => { r.agents["agent-rv-t1"].runtime = "codex"; });
      expect(() => bindSchedulerSession(p.f.db, p.f.at("scheduler"), { taskId: "T1", role: "reviewer", intentId: ensure.id,
        agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", transport: "acp", registryPath: p.f.registryPath })).toThrow();
    } finally { p.f.close(); }
  });
});

test("current head's remote family overrides workflow; a cancelled write order restores the workflow family", async () => {
  const p = await scenario();
  try {
    const delivered = p.snapshot().events.findLast((e) => e.kind === "deliver")!;
    p.f.db.run(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
      status, leaseMs, eventSeq, createdBy, createdAt, updatedAt) VALUES ('remote-write', 'T1', 'p', 'Sekai', 'codex', 'fix', 1, 2, ?,
      'o/r', '{}', 'remote delivery', '', 'done', 600000, ?, 'scheduler', 1, 1)`, [H2, delivered.seq]);
    expect(p.snapshot().workflow?.authorFamily).toBe("codex");
    expect(planScheduler(p.snapshot())).toMatchObject({ kind: "intent", action: "review", recipient: "agent-rv-t1" });
    p.f.db.run("UPDATE lend_orders SET status = 'cancelled' WHERE orderId = 'remote-write'");
    expect(p.snapshot().workflow?.authorFamily).toBe("claude");
    expect(planScheduler(p.snapshot())).toMatchObject({ kind: "intent", action: "review_swap" });
    await finishSwap(p);
    expect(p.swaps()[0].data).toMatchObject({ fromFamily: "codex", toFamily: "claude" });
  } finally { p.f.close(); }
});

test("Sekai unavailable falls through to Hede; an already bound independent reviewer remains on its own epoch", async () => {
  const p = await scenario();
  try {
    p.hello("Sekai", 0); p.hello("HedeMacBook-Pro");
    await finishSwap(p);
    expect(planScheduler(p.snapshot())).toMatchObject({ kind: "intent", action: "review", recipient: "peer:HedeMacBook-Pro" });
    p.policy.remote = { ...REMOTE, mode: "off" };
    await p.tick();
    const s = p.snapshot();
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "review", recipient: "agent-rv-t1" });
    // A new local reviewer may not be replaced again without a new swap event.
    s.events = [...s.events, { ...s.events[0], kind: "review", seq: s.events.at(-1)!.seq + 1,
      data: { reviewer: "agent-rv-t1", reviewerSessionId: "s-rv-new", round: 1 } }];
    expect(planScheduler({ ...s, reviewer: { ...s.reviewer!, sessionId: "unapproved" } })).toMatchObject({ kind: "escalate", code: "reviewer_replaced" });
  } finally { p.f.close(); }
});

test("old results are refused as soon as swapped; a lost lease executes no lifecycle effect", async () => {
  const p = await scenario(true);
  try {
    const intent = persistPlan(p.f.db);
    p.state.lostLease = true;
    await expect(reviewSwapStep(p.f.db, p.f.at("scheduler"), intent.id, 2, p.effectsDeps)).rejects.toThrow("lease lost");
    expect(p.effects).toEqual([]);
    expect(p.swaps()).toEqual([]);
    p.state.lostLease = false;
    await p.tick();
    expect(await p.verdict("claude", "s-rv", [])).toMatchObject({ ok: false });
    await p.tick(); await p.tick();
    expect(await p.verdict("claude", "s-rv", [])).toMatchObject({ ok: false });
  } finally { p.f.close(); }
});
