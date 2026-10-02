import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { convergenceOrderLines } from "../src/lib/fix-strategy-order.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { convergenceProbe, repeatedFix, fourRoundFix } from "./fix-strategy-helpers.js";
import { orderFamily } from "../src/lib/scheduler-placement-plan.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { remoteHeadFamily } from "../src/lib/scheduler-head-family.js";
import { insertEvent } from "../src/lib/ledger-tx.js";

test("two-round repair archives before stopping, binds a fresh author, preserves history and requires a named reproduction test", async () => {
  const f = await repeatedFix();
  try {
    const p = convergenceProbe(f), intent = p.plan();
    expect(intent.action).toBe("fix_swap");
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
    expect(p.effects).toEqual(["archive:agent-task-one"]);
    expect(getSchedulerSession(f.db, "T1", "author")?.sessionId).toBe("s-one");
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
    expect(p.effects[1]).toBe("kill:agent-task-one");
    const author = getSchedulerSession(f.db, "T1", "author")!;
    expect(author.sessionId).not.toBe("s-one");
    expect(author.family).toBe("claude");
    expect(getIntent(f.db, intent.id)?.status).toBe("done");
    const retired = f.db.query("SELECT state, archiveReceipt, killReceipt FROM scheduler_sessions WHERE sessionId = 's-one'").get();
    expect(retired).toMatchObject({ state: "retired", killReceipt: "旧作者归档后已确认停止" });
    const material = convergenceOrderLines(f.db, f.task()).at(-1)!.split("：").at(-1)!;
    const body = readFileSync(material, "utf8");
    expect(body).toContain("original report reviews/T1-r1/report.md");
    expect(body).toContain("repair diff");
    expect(body).toContain("two ticks claim");
    expect(planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }))).toMatchObject({ action: "dispatch", recipient: author.agent });
    expect(await f.cli(author.agent, "deliver", "T1", "--from", "fix", "--head", "3".repeat(40))).toMatchObject({ ok: false });
    expect(await f.cli(author.agent, "deliver", "T1", "--from", "fix", "--head", "3".repeat(40), "--text", "复现测试：claim-race，先红后绿")).toMatchObject({ ok: true });
    expect(getWorkflow(f.db, "T1")?.authorFamily).toBe("claude");
  } finally { f.close(); }
});

test("archive failure or changed live session cannot stop a different worker", async () => {
  const f = await repeatedFix();
  try {
    const p = convergenceProbe(f), intent = p.plan();
    p.deps.manager = async () => ({ ok: false, error: "disk full" });
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting", detail: "旧作者归档未完成：disk full" });
    p.edit((r) => { r.agents["agent-task-one"].sessionId = "unrelated-session"; });
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
    expect(getSchedulerSession(f.db, "T1", "author")?.sessionId).toBe("s-one");
  } finally { f.close(); }
});

test("four-round repair changes the author family and forces a new cross-family ordinary reviewer", async () => {
  const f = await fourRoundFix();
  try {
    const p = convergenceProbe(f), intent = p.plan();
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    const author = getSchedulerSession(f.db, "T1", "author")!;
    expect(author.family).toBe("codex");
    expect(getWorkflow(f.db, "T1")?.authorFamily).toBe("codex");
    await f.cli(author.agent, "deliver", "T1", "--from", "fix", "--head", "5".repeat(40), "--text", "复现测试：race，先红后绿");
    expect(planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }))).toMatchObject({ action: "review_swap" });
  } finally { f.close(); }
});

test("LP1 local family restriction prevents repair creation even with available machine slots", async () => {
  const f = await fourRoundFix();
  try {
    const p = convergenceProbe(f), intent = p.plan();
    p.deps.localFamilyWait = (_task, family) => family === "codex" ? "本机不接 codex" : null;
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting", detail: expect.stringContaining("本机不接 codex") });
    expect(p.effects.some((e) => e.startsWith("create:"))).toBe(false);
  } finally { f.close(); }
});

test("family-full waits for CONV3 without faking a write lease; a peer-written old head cannot override the new local family", async () => {
  const f = await fourRoundFix();
  try {
    const p = convergenceProbe(f);
    p.edit((r) => { for (let n = 0; n < 6; n++) r.agents[`agent-full-${n}`] = { runtime: "codex", status: "active", sessionId: `busy-${n}` }; });
    f.db.run("UPDATE tasks SET branch = 'feat/T1', pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'");
    for (let n = 0; n < 6; n++) f.db.query(`INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt)
      VALUES (?, 'p', 'busy', 'code', 'build', ?, 0, 0)`).run(`busy-${n}`, `agent-full-${n}`);
    recordHello(f.db, "Peer", null, { v: 1, proto: 2, boot: "peer", seq: 1, slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } },
      paused: null, grant: { until: f.tickDeps.now() + 3600000, roles: ["write"], repos: ["o/r"], ordersPerDay: 10, ordersLeftToday: 10 } }, f.tickDeps.now());
    const opts = { registry: [], maxWorkers: 2, now: f.tickDeps.now(), pool: {
      remote: { mode: "balance" as const, roles: ["write" as const], poolTimeoutMin: 15, repo: "o/r" },
      borrow: [{ peer: "Peer", projects: ["p"], roles: ["write" as const], maxOpen: 2 }] } };
    const intent = p.plan();
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting", detail: expect.stringContaining("Codex 全机会话已达 6") });
    expect(p.effects.some((e) => e.startsWith("create:"))).toBe(false);
    p.edit((r) => { for (let n = 0; n < 6; n++) delete r.agents[`agent-full-${n}`]; });
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
    const latest = insertEvent(f.db, f.at("agent-old-peer"), { project: "p", target: "T1", kind: "deliver", data: { headSHA: f.task().headSHA } }, true);
    f.db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
      status, leaseMs, createdBy, createdAt, updatedAt, eventSeq) VALUES ('old', 'T1', 'p', 'Other', 'claude', 'write', 1, 4, ?, 'o/r', '{}', '', '',
      'done', 1000, 'owner', 1, 1, ?)`).run(f.task().headSHA, latest.seq);
    expect(remoteHeadFamily(f.db, f.task())).toBe("claude");
    const snapshot = autoSnapshot(f.db, f.task(), opts);
    expect(snapshot.workflow?.authorFamily).toBe("codex");
    expect(orderFamily(snapshot, "Peer", "fix")).toBe("codex");
    expect(planScheduler(snapshot)).toMatchObject({ action: "dispatch", recipient: getSchedulerSession(f.db, "T1", "author")!.agent });
  } finally { f.close(); }
});
