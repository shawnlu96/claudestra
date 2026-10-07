/**
 * dispatch-recovery-RVCAP1 · 已离开审查阶段的旧绑定不再占用本机审查计数：localReviewerCount 改读共享 AgentPool 的工作阶段口径
 * （scheduler-agent-pool-ledger.ts workingSeats）。N3 形态：8 张 active 非 peer 审查绑定，7 张卡已 blocked/fix/merge/live、1 张在 review。
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { getTask } from "../src/lib/ledger-store.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { localAgentPool, workingSeats } from "../src/lib/scheduler-agent-pool-ledger.js";
import { localReviewerCount } from "../src/lib/scheduler-pool-facts.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { finishSwap, scenario } from "./scheduler-review-swap.test.js";

const OLD_STAGES = ["blocked", "fix", "merge", "live", "blocked", "fix", "merge"];

/** 改前的 localReviewerCount 原查询（旧红对照）：所有 active 非 peer 审查绑定，不看卡阶段。 */
const legacyCount = (db: Database, project: string, except: string | null): number =>
  (db.query(`SELECT COUNT(*) AS n FROM scheduler_sessions AS s JOIN tasks AS t ON t.id = s.taskId WHERE t.project = ? AND s.taskId != ?
    AND s.role = 'reviewer' AND s.state = 'active' AND s.transport != 'peer'`).get(project, except ?? "") as { n: number }).n;

function card(db: Database, id: string, stage: string, project = "p") {
  db.query(`INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt) VALUES (?, ?, ?, 'code', ?, ?, 0, 0)`)
    .run(id, project, id, stage, `author-${id}`);
  db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES (?, ?, 'code', 3, 'manual', 'claude', 'manual', 1, 0, 0)`).run(id, project);
}
function reviewer(db: Database, id: string, stage: string, o: { agent?: string; project?: string; transport?: string; state?: string; intent?: string } = {}) {
  card(db, id, stage, o.project);
  db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES (?, 'reviewer', ?, ?, 'codex', ?, ?, ?, 0, 0)`).run(id, o.agent ?? `rv-${id}`, `s-${id}`, o.transport ?? "acp", o.state ?? "active", o.intent ?? `i-${id}`);
}
function intent(db: Database, id: string, taskId: string, action: string, node: string, status: string, receipt: string | null = null) {
  db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, receipt, reason, createdAt, updatedAt)
    VALUES (?, ?, 'p', ?, ?, 0, 1, 1, 3, ?, ?, 't', 0, 0)`).run(id, taskId, node, action, status, receipt);
}
function ledger<T>(fn: (db: Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "rvcap1-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  db.run("PRAGMA foreign_keys=OFF");
  try { return fn(db); } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
}
const poolReviewers = (db: Database, except: string | null = null) => [...workingSeats(db, "p", except)!.values()].filter((s) => s.reviewer).length;

test("RVCAP1 旧红新绿（N3）：8 张 active 旧绑定、7 张已离开 review → 计数 1，与共享 AgentPool 工作阶段口径一致", () => ledger((db) => {
  OLD_STAGES.forEach((stage, i) => reviewer(db, `old${i}`, stage));
  reviewer(db, "reviewing", "review");
  expect(legacyCount(db, "p", "me")).toBe(8); // 改前：8/8，>= maxWorkers 8 一直等
  expect(localReviewerCount(db, "p", "me")).toBe(1);
  expect(localReviewerCount(db, "p", "me")).toBe(poolReviewers(db, "me"));
  expect(localAgentPool(db, "p", { claude: 8, codex: 8 }, "me").running).toEqual({ claude: 0, codex: 1 });
  // review 阶段的旧轮绑定仍算（LS2）；registry 状态 / 名字不参与
  db.run("UPDATE tasks SET round = 3 WHERE id = 'reviewing'");
  expect(localReviewerCount(db, "p", "me")).toBe(1);
}));

test("RVCAP1 真在 review 的满 8 仍等；跨项目 / peer / retired / 本卡 except 不算；同 agent 重复绑定只算一次", () => ledger((db) => {
  for (let i = 0; i < 8; i++) reviewer(db, `r${i}`, "review");
  expect(localReviewerCount(db, "p", null)).toBe(8);
  expect(localReviewerCount(db, "p", "r0")).toBe(7);
  reviewer(db, "other", "review", { project: "q" });
  reviewer(db, "peer", "review", { transport: "peer" });
  reviewer(db, "retired", "review", { state: "retired" });
  reviewer(db, "dup", "review", { agent: "rv-r1" });
  expect(localReviewerCount(db, "p", null)).toBe(8);
  // retiring（尚未退役完成）仍占位，fail closed
  reviewer(db, "retiring", "review", { state: "retiring" });
  expect(localReviewerCount(db, "p", null)).toBe(9);
  expect(localReviewerCount(db, "p", null)).toBe(poolReviewers(db));
}));

test("RVCAP1 读坏 / 缺权威数据 fail closed，不当成零占用", () => ledger((db) => {
  reviewer(db, "r", "review");
  db.run("ALTER TABLE scheduler_sessions RENAME TO scheduler_sessions_gone");
  expect(() => localReviewerCount(db, "p", null)).toThrow(/缺会话绑定表/);
  db.run("ALTER TABLE scheduler_sessions_gone RENAME TO scheduler_sessions");
  db.run("ALTER TABLE tasks RENAME TO tasks_gone");
  expect(() => localReviewerCount(db, "p", null)).toThrow();
}));

test("RVCAP1 未结效果不因卡阶段变化而不计：submitted/unknown 审查建会话预留、未结派审；pending 不算，已绑定不重复算", () => ledger((db) => {
  card(db, "creating", "merge"); intent(db, "ens-s", "creating", "ensure_session", "adversarial_review", "submitted", "claimed; ensure replacement reviewer");
  card(db, "unknown", "blocked"); intent(db, "ens-u", "unknown", "ensure_session", "adversarial_review", "unknown");
  card(db, "pending", "review"); intent(db, "ens-p", "pending", "ensure_session", "adversarial_review", "pending");
  card(db, "cancelled", "review"); intent(db, "ens-c", "cancelled", "ensure_session", "adversarial_review", "cancelled");
  expect(localReviewerCount(db, "p", null)).toBe(2);
  // 绑定已产生：按绑定算一次，不再按预留叠加
  reviewer(db, "bound", "review", { intent: "ens-b" }); intent(db, "ens-b", "bound", "ensure_session", "adversarial_review", "submitted");
  expect(localReviewerCount(db, "p", null)).toBe(3);
  // 卡已离开 review 但派审效果未结（submitted / unknown）：旧绑定仍在干活；结掉后不再算
  reviewer(db, "inflight", "fix"); intent(db, "rv-1", "inflight", "review", "adversarial_review", "unknown");
  expect(localReviewerCount(db, "p", null)).toBe(4);
  db.run("UPDATE scheduler_intents SET status = 'done' WHERE id = 'rv-1'");
  expect(localReviewerCount(db, "p", null)).toBe(3);
  // 作者建会话预留不算审查名额，仍算 pool
  card(db, "author", "build"); intent(db, "ens-a", "author", "ensure_session", "write", "submitted");
  expect(localReviewerCount(db, "p", null)).toBe(3);
  expect(localAgentPool(db, "p", { claude: 8, codex: 8 }).running).toEqual({ claude: 3, codex: 1 });
  expect(localReviewerCount(db, "p", null)).toBe(poolReviewers(db));
}));

/** 本卡（T1）换审查员后挂着 pending 的 ensure_session；同项目再放 8 张别的卡的 active 审查绑定。 */
async function swapped(stages: string[]) {
  const p = await scenario();
  p.hello("Sekai", 0); p.hello("HedeMacBook-Pro", 0); // 无出借空位：只剩本机跨家族建会话一条路
  await finishSwap(p);
  p.f.db.run("PRAGMA foreign_keys=OFF");
  stages.forEach((stage, i) => reviewer(p.f.db, `X${i}`, stage));
  return { p, creates: () => p.effects.filter((e) => e.startsWith("ensure:")) };
}

/** 照调度器的正式写口记下本卡的 ensure_session 意图（不放宽名额：只为让真实 CLI 有一张 pending 意图可推）。 */
function planEnsure(db: Database) {
  const task = getTask(db, "T1")!, workflow = getWorkflow(db, task.id)!;
  const plan = planScheduler(autoSnapshot(db, task, { registry: [], maxWorkers: 32 }));
  if (plan.kind !== "intent" || plan.action !== "ensure_session") throw new Error(JSON.stringify(plan));
  const seq = (db.query("SELECT MAX(seq) AS n FROM events").get() as { n: number }).n;
  return planIntent(db, { actor: "scheduler", now: Date.now() }, { id: plan.id, taskId: task.id, taskRev: task.rev, workflowRev: workflow.rev,
    causalSeq: seq, action: plan.action, node: plan.node, reason: plan.reason, resources: plan.resources }).intent;
}

test("RVCAP1 review-swap：真实台账 CLI 在真满额时仍等待、零创建；N3 旧绑定形态下按现存正式门建一次新审查会话", async () => {
  const full = await swapped(Array(8).fill("review"));
  try {
    full.p.policy.maxActiveWorkers = 8;
    expect(await full.p.tick()).toMatchObject({ step: "waiting" }); // 规划层同一口径：本机审查名额满
    const ensure = planEnsure(full.p.f.db);
    expect(await full.p.cli("scheduler", "scheduler-review-swap", ensure.id, "--max-workers", "8"))
      .toMatchObject({ ok: true, step: "waiting", detail: expect.stringContaining("名额已满") });
    expect(getIntent(full.p.f.db, ensure.id)?.status).toBe("pending");
    expect(await full.p.tick()).not.toMatchObject({ step: "session" }); // 规划层仍判满，不推这张意图
    expect(full.creates()).toEqual([]);
  } finally { full.p.f.close(); }

  const n3 = await swapped([...OLD_STAGES, "review"]);
  try {
    n3.p.policy.maxActiveWorkers = 8;
    expect(legacyCount(n3.p.f.db, "p", "T1")).toBe(8); // 改前这里同样返回「名额已满」
    expect(await n3.p.tick()).toMatchObject({ step: "session" });
    const ensure = n3.p.f.intents().findLast((i) => i.action === "ensure_session")!;
    expect(n3.creates()).toEqual(["ensure:codex"]);
    expect(getIntent(n3.p.f.db, ensure.id)?.status).toBe("done");
    expect(getSchedulerSession(n3.p.f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv-new", createIntentId: ensure.id });
    // 已绑定：再走一次真实 CLI 不重复创建
    expect(await n3.p.cli("scheduler", "scheduler-review-swap", ensure.id, "--max-workers", "8")).toMatchObject({ ok: true, step: "session" });
    expect(n3.creates()).toEqual(["ensure:codex"]);
  } finally { n3.p.f.close(); }
}, 120_000);

test("RVCAP1 review-swap：创建已认领 / 结果未知 / 错 head 都零重复新效果", async () => {
  const s = await swapped([...OLD_STAGES, "review"]);
  try {
    s.p.policy.maxActiveWorkers = 8;
    const ensure = planEnsure(s.p.f.db);
    s.p.f.db.run("UPDATE scheduler_intents SET status = 'submitted', updatedAt = ? WHERE id = ?", [Date.now() + 3_600_000, ensure.id]);
    expect(await s.p.cli("scheduler", "scheduler-review-swap", ensure.id, "--max-workers", "8"))
      .toMatchObject({ ok: true, step: "waiting", detail: expect.stringContaining("等待绑定回执") });
    s.p.f.db.run("UPDATE scheduler_intents SET status = 'unknown' WHERE id = ?", [ensure.id]);
    expect(await s.p.cli("scheduler", "scheduler-review-swap", ensure.id, "--max-workers", "8")).toMatchObject({ ok: true, step: "held" });
    // 别的卡上未知结果的审查建会话仍占位：本卡另一次创建意图看到的计数含它
    expect(localReviewerCount(s.p.f.db, "p", "X0")).toBe(2);
    s.p.f.db.run("UPDATE scheduler_intents SET status = 'pending' WHERE id = ?", [ensure.id]);
    s.p.f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["f".repeat(40)]);
    expect(await s.p.cli("scheduler", "scheduler-review-swap", ensure.id, "--max-workers", "8")).toMatchObject({ ok: false });
    expect(s.creates()).toEqual([]);
  } finally { s.p.f.close(); }
}, 120_000);
