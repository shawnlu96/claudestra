/**
 * team-roster-ROSTER1：名册汇总与位子判定（lib/team-roster.ts）。临时台账；位子与调度器同源（localAgentPool / unifiedPeerCapacity），
 * 额度到线走真的 quotaPoolTotals（只把 quotaFor 换成给定观测，与 tests/quota-codex-line.test.ts 同法）。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as aiQuota from "../src/lib/ai-quota.js";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { notePeerQuota, peerQuota, resetWeekQuotaCacheForTest, type QuotaReport } from "../src/lib/quota-week.js";
import { localAgentPool } from "../src/lib/scheduler-agent-pool-ledger.js";
import { quotaPoolTotals } from "../src/lib/scheduler-agent-pool-quota.js";
import { unifiedPeerCapacity } from "../src/lib/scheduler-placement-reservations.js";
import type { Paused } from "../src/lib/lend-wire-v2.js";
import { teamRoster, weekDays, type Quota, type RosterInput, type RosterMachine, type Slot, type Worker } from "../src/lib/team-roster.js";

const P = "p", PEER = "Sekai", NOW = new Date(2026, 9, 14, 15, 0, 0).getTime(), DAY = 86_400_000;
const AGENTS = { claude: 3, codex: 2 };
let dir: string, path: string, db: Database, seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "roster1-"));
  path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  db.run("PRAGMA foreign_keys=OFF");
  resetWeekQuotaCacheForTest();
});
afterEach(() => {
  closeLedger(path);
  rmSync(dir, { recursive: true, force: true });
});

function card(id: string, stage: string, o: { project?: string; agent?: string | null; family?: string } = {}) {
  db.query(`INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt) VALUES (?, ?, ?, 'code', ?, ?, 0, 0)`)
    .run(id, o.project ?? P, id, stage, o.agent === undefined ? `author-${id}` : o.agent);
  db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES (?, ?, 'code', 3, 'manual', ?, 'manual', 1, 0, 0)`).run(id, o.project ?? P, o.family ?? "claude");
}
function session(taskId: string, role: "author" | "reviewer", agent: string, family: string) {
  db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, 'acp', 'active', ?, 0, 0)`).run(taskId, role, agent, `s-${taskId}-${role}`, family, `i-${taskId}-${role}`);
}
function ensure(id: string, taskId: string, node: string, receipt: string) {
  db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, receipt, reason, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'ensure_session', 0, 1, 1, 3, 'submitted', ?, 't', 0, 0)`).run(id, taskId, P, node, receipt);
}
function step(taskId: string, s: string, round: number, executor: string, kind: string, state: string, at: number) {
  db.query(`INSERT INTO task_steps (taskId, step, round, executor, executorKind, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(taskId, s, round, executor, kind, state, at - 1000, at);
}
function hello(peer: string, o: { claude?: { total: number; busy: number }; paused?: Paused | null; at?: number } = {}) {
  recordHello(db, peer, null, { v: 1, proto: 2, boot: "b", seq: ++seq,
    grant: { until: NOW + DAY, roles: ["write", "review"], repos: ["o/r", "o/s"], ordersPerDay: 10, ordersLeftToday: 7 },
    slots: { claude: o.claude ?? { total: 4, busy: 3 }, codex: { total: 2, busy: 0 } }, paused: o.paused ?? null }, o.at ?? NOW);
}
function order(id: string, taskId: string, o: { project?: string; peer?: string; family?: string; step?: string; status?: string; worker?: string | null; beat?: object | null } = {}) {
  db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
    status, worker, leaseGen, leaseUntil, leaseMs, createdBy, createdAt, updatedAt, beat, beatAt)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0, 'h', 'o/r', '{}', '', '', ?, ?, 1, ?, 10000, 'scheduler', 1, 1, ?, ?)`)
    .run(id, taskId, o.project ?? P, o.peer ?? PEER, o.family ?? "claude", o.step ?? "write", o.status ?? "claimed",
      o.worker === undefined ? `agent-lend-${id.padStart(10, "0").slice(-10)}` : o.worker, NOW + DAY,
      o.beat ? JSON.stringify(o.beat) : null, o.beat ? (o.beat as { at: number }).at : null);
}

const input = (over: Partial<RosterInput> = {}): RosterInput => ({
  db, project: P, now: NOW, selfInstanceId: "iid-self", agents: AGENTS,
  poolTotals: (t) => quotaPoolTotals(db, P, t, NOW), localQuota: null, borrowPeers: [PEER],
  peerInstanceId: (p) => (p === PEER ? "iid-sekai" : null),
  peerPresence: () => ({ online: true, checkedAt: NOW - 5000, latencyMs: 40 }),
  peerQuota: (p) => peerQuota(p, NOW), ...over,
});
const machine = (r: ReturnType<typeof teamRoster>, key: string): RosterMachine => r.machines.find((m) => m.machineKey === key)!;
const known = (claude: number): InventoryQuota => ({ status: "known", source: "live", observedAt: NOW, plan: null, reason: null,
  windows: [{ id: "7d", kind: "weekly", usedPct: claude, resetsAtMs: Date.now() + 3_600_000, resetPassed: false }] } as InventoryQuota);

/** 2 个 Claude 作者在 build、1 个 Codex 审查员在 review、1 个 ensure_session 在途 */
function localScene() {
  card("A1", "build", { agent: "agent-a1" }); session("A1", "author", "agent-a1", "claude");
  card("A2", "build", { agent: "agent-a2" }); session("A2", "author", "agent-a2", "claude");
  card("R1", "review", { agent: "agent-x" }); session("R1", "reviewer", "agent-r1", "codex");
  card("C1", "build", { agent: null, family: "codex" }); ensure("ens-c1", "C1", "write", "ensure author codex");
  step("A1", "write", 0, "agent-a1", "agent", "delivered", NOW - 3 * DAY);
  step("A1", "write", 1, "agent-a1", "agent", "assigned", NOW - 2000);
}

test("[验收线 2] 本机位子：busy 与 localAgentPool.running 相等；seat 回查卡号 / 步骤 / 轮次；creating seat 无名仍计入", () => {
  localScene();
  const quota = spyOn(aiQuota, "quotaFor").mockImplementation(() => known(0));
  try {
    const r = teamRoster(input());
    const local = r.machines[0]!;
    expect(local.machineKey).toBe("local");
    expect(local).toMatchObject({ instanceId: "iid-self", online: true, checkedAt: null, latencyMs: null, proto: "local", why: null, grant: null, paused: null });
    const running = localAgentPool(db, P, AGENTS).running;
    expect(local.slots.claude).toEqual({ total: 3, busy: running.claude, reportedBusy: null, placeable: 1, held: false });
    expect(local.slots.codex).toEqual({ total: 2, busy: running.codex, reportedBusy: null, placeable: 0, held: false });
    expect([running.claude, running.codex]).toEqual([2, 2]);
    const a1 = local.workers.find((w) => w.name === "agent-a1")!;
    expect(a1).toMatchObject({ family: "claude", role: "author", taskId: "A1", step: "write", round: 1, since: NOW - 3000, state: "running", beatAt: null });
    expect(local.workers.find((w) => w.name === "agent-r1")).toMatchObject({ family: "codex", role: "reviewer", taskId: "R1", step: "review", round: null });
    expect(local.workers.find((w) => w.name === null)).toMatchObject({ id: "local:creating:C1:write", family: "codex", taskId: "C1", step: "write" });
    expect(local.workers).toHaveLength(4);
  } finally { quota.mockRestore(); }
});

test("[验收线 2] Claude 周额度到线 → claude held、placeable 0，Codex 不受影响；没有池 → 两家 null", () => {
  localScene();
  const quota = spyOn(aiQuota, "quotaFor").mockImplementation((_s, f) => known(f === "claude" ? 70 : 10));
  try {
    const local = teamRoster(input()).machines[0]!;
    expect(local.slots.claude).toMatchObject({ total: 3, busy: 2, placeable: 0, held: true });
    expect(local.slots.codex).toMatchObject({ total: 2, held: false });
  } finally { quota.mockRestore(); }
  expect(teamRoster(input({ agents: null })).machines[0]!.slots).toEqual({ claude: null, codex: null });
  expect(teamRoster(input({ poolTotals: () => null })).machines[0]!.slots).toEqual({ claude: null, codex: null });
});

test("[验收线 3] peer 位子：busy 跨项目 2、reportedBusy 3、placeable 与 unifiedPeerCapacity 相同；暂停按家族 held", () => {
  hello(PEER);
  card("T1", "build"); card("Q1", "build", { project: "q" });
  order("1", "T1"); order("2", "Q1", { project: "q" });
  const r = teamRoster(input({ poolTotals: (t) => t }));
  const m = machine(r, PEER);
  const want: Slot = { total: 4, busy: 2, reportedBusy: 3, placeable: unifiedPeerCapacity(db, PEER, NOW).slots.claude, held: false };
  expect(m.slots.claude).toEqual(want);
  expect(m).toMatchObject({ machineKey: PEER, instanceId: "iid-sekai", online: true, checkedAt: NOW - 5000, latencyMs: 40, helloAt: NOW, proto: "push", why: null,
    grant: { roles: ["write", "review"], repos: 2, until: NOW + DAY, ordersLeftToday: 7 }, paused: null });
  hello(PEER, { paused: { reason: "codex_quota", until: NOW + DAY } });
  let s = machine(teamRoster(input({ poolTotals: (t) => t })), PEER).slots;
  expect([s.claude!.held, s.codex!.held]).toEqual([false, true]);
  hello(PEER, { paused: { reason: "maintenance", until: NOW + DAY } });
  const paused = machine(teamRoster(input({ poolTotals: (t) => t })), PEER);
  s = paused.slots;
  expect([s.claude!.held, s.codex!.held]).toEqual([true, true]);
  expect(paused.paused).toEqual({ reason: "maintenance", until: NOW + DAY });
});

test("[验收线 3] 没有 lend_peers 行 → slots null、why 照填；本项目不在 agents 池 → slots null", () => {
  card("T1", "build"); order("1", "T1", { peer: "Ghost" });
  const r = teamRoster(input({ borrowPeers: [], poolTotals: (t) => t }));
  expect(r.machines.map((m) => m.machineKey)).toEqual(["local", "Ghost"]); // 借入撤了，本项目还有未结单也要列
  const g = machine(r, "Ghost");
  expect(g.slots).toEqual({ claude: null, codex: null });
  expect(g).toMatchObject({ proto: null, helloAt: null, grant: null, why: expect.stringContaining("没有 hello") });
  hello(PEER);
  expect(machine(teamRoster(input({ agents: null })), PEER).slots).toEqual({ claude: null, codex: null });
});

test("[验收线 4] peer worker：心跳超 60 秒 silent、没有心跳 no_beat；整包 worker id 不重复", () => {
  hello(PEER);
  localScene();
  card("T1", "build"); card("T2", "review");
  order("1", "T1", { beat: { gen: 1, at: NOW - 61_000, phase: "testing", excerpt: "x" } });
  order("2", "T2", { step: "review", family: "codex", beat: null });
  step("T2", "review", 2, "lend-0000000002@Sekai", "peer", "assigned", NOW - 500);
  const spy = spyOn(aiQuota, "quotaFor").mockImplementation(() => known(0));
  try {
    const r = teamRoster(input());
    const ws: Worker[] = machine(r, PEER).workers;
    expect(ws.find((w) => w.taskId === "T1")).toMatchObject({ name: "lend-0000000001", role: "author", family: "claude", state: "silent",
      phase: "testing", excerpt: "x", beatAt: NOW - 61_000, step: "write" });
    expect(ws.find((w) => w.taskId === "T2")).toMatchObject({ role: "reviewer", family: "codex", state: "no_beat", round: 2, since: NOW - 1500 });
    const ids = r.machines.flatMap((m) => m.workers.map((w) => w.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(6);
  } finally { spy.mockRestore(); }
});

test("[验收线 5] 卡归属：本机作者 / peer 作者 / 没有作者步骤分别落进 local、peer、unattributed；derived 不猜", () => {
  hello(PEER);
  card("M1", "merge"); step("M1", "write", 0, "agent-m", "agent", "delivered", NOW - 10);
  card("L1", "live"); step("L1", "write", 0, "agent-l", "agent", "delivered", NOW - 20); step("L1", "fix", 1, "lend-aa@Sekai", "peer", "delivered", NOW - 5);
  card("B1", "blocked", { agent: "agent-b" });
  card("X1", "build"); step("X1", "write", 0, "agent-x", "agent", "delivered", NOW);
  const r = teamRoster(input({ poolTotals: (t) => t }));
  expect(r.machines[0]!.cards).toEqual({ merge: ["M1"], live: [], blocked: [] });
  expect(machine(r, PEER).cards).toEqual({ merge: [], live: ["L1"], blocked: [] });
  expect(r.unattributed).toEqual({ merge: [], live: [], blocked: ["B1"] });
});

test("[验收线 5] 7 天产出：逐日计数，含今天共 7 格，第 8 天以前的不算", () => {
  hello(PEER);
  card("O1", "merge"); card("O2", "merge"); card("O3", "merge"); card("Q1", "merge", { project: "q" });
  step("O1", "write", 0, "agent-o", "agent", "delivered", NOW - 60_000);
  step("O1", "review", 0, "lend-r@Sekai", "peer", "done", NOW - 60_000);
  step("O1", "fix", 1, "agent-o", "agent", "assigned", NOW - 50_000); // 没交付不算
  step("O2", "write", 0, "lend-w@Sekai", "peer", "delivered", NOW - 6 * DAY);
  step("O2", "final_review", 0, "agent-f", "agent", "done", NOW - 6 * DAY);
  step("O3", "write", 0, "agent-o", "agent", "delivered", NOW - 7 * DAY); // 第 8 天
  step("Q1", "write", 0, "agent-q", "agent", "delivered", NOW - 60_000); // 别的项目
  const r = teamRoster(input({ poolTotals: (t) => t }));
  const { days } = weekDays(NOW);
  expect(days).toHaveLength(7);
  expect(days[6]).toBe("2026-10-14");
  expect(days[0]).toBe("2026-10-08");
  const local = r.machines[0]!.output, peer = machine(r, PEER).output;
  expect(local.map((o) => o.day)).toEqual(days);
  expect(local[6]).toEqual({ day: "2026-10-14", delivered: 1, reviewed: 0 });
  expect(local[0]).toEqual({ day: "2026-10-08", delivered: 0, reviewed: 1 });
  expect(peer[6]).toEqual({ day: "2026-10-14", delivered: 0, reviewed: 1 });
  expect(peer[0]).toEqual({ day: "2026-10-08", delivered: 1, reviewed: 0 });
  expect([...local, ...peer].reduce((n, o) => n + o.delivered + o.reviewed, 0)).toBe(4);
});

test("[验收线 6] 额度：peer 没报 / 报了超过 1 小时 → null；本机缺一家 → 该家 null；stopPct 本机线值、peer null", () => {
  hello(PEER, { at: NOW - 30_000 });
  const report: QuotaReport = { claude: { weekUsedPct: 40, resetAt: NOW + DAY }, codex: { weekUsedPct: 12, resetAt: NOW + DAY } };
  let m = machine(teamRoster(input({ poolTotals: (t) => t })), PEER);
  expect(m.quota).toEqual({ claude: null, codex: null });
  notePeerQuota(PEER, report, NOW - 3_700_000);
  expect(machine(teamRoster(input({ poolTotals: (t) => t })), PEER).quota).toEqual({ claude: null, codex: null });
  notePeerQuota(PEER, report, NOW - 60_000);
  m = machine(teamRoster(input({ poolTotals: (t) => t })), PEER);
  expect(m.quota.claude).toEqual({ usedPct: 40, resetAt: NOW + DAY, stopPct: null, observedAt: NOW - 30_000 });
  expect(m.quota.codex).toMatchObject({ usedPct: 12, stopPct: null });
  const local = teamRoster(input({ poolTotals: (t) => t, localQuota: { claude: { weekUsedPct: 55, resetAt: NOW + DAY } } })).machines[0]!;
  const want: Quota = { usedPct: 55, resetAt: NOW + DAY, stopPct: 70, observedAt: NOW };
  expect(local.quota).toEqual({ claude: want, codex: null });
  db.query("INSERT INTO meta (project, key, value) VALUES (?, 'autostart', ?)").run(P, JSON.stringify({ weeklyLinePct: 80, codexWeeklyLinePct: 90 }));
  const lined = teamRoster(input({ poolTotals: (t) => t, localQuota: report })).machines[0]!;
  expect([lined.quota.claude!.stopPct, lined.quota.codex!.stopPct]).toEqual([80, 90]);
  expect(teamRoster(input({ poolTotals: (t) => t, localQuota: null })).machines[0]!.quota).toEqual({ claude: null, codex: null });
});

test("回包外形：self、machines 顺序（本机在前，peer 按名排序）、在线读不到为 null", () => {
  hello("Zed"); hello(PEER);
  const r = teamRoster(input({ borrowPeers: ["Zed", PEER], poolTotals: (t) => t, peerPresence: () => null }));
  expect(r).toMatchObject({ now: NOW, project: P, self: { instanceId: "iid-self" } });
  expect(r.machines.map((m) => m.machineKey)).toEqual(["local", PEER, "Zed"]);
  expect(machine(r, "Zed")).toMatchObject({ online: null, checkedAt: null, latencyMs: null, instanceId: null });
});
