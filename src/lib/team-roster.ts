/**
 * 团队名册（team-roster-ROSTER1）：这台 bridge 自己视角下，本项目用到的每台机器——在线、位子、额度、授权、worker、卡与 7 天产出。
 * 只读；位子与调度器同源（workingSeats / quotaPoolTotals / unifiedPeerCapacity），不另算。now、配置、peer 事实全由参数注入，
 * 台账只做查询。读不到的一律 null（未知），不写 0。不返回「人」这一层（ROSTER3 由网页拼）。tests/team-roster.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";
import { stepPeer, type ExecutorKind } from "./ledger-steps.js";
import { LEND_LIVE } from "./ledger-lend-schema.js";
import { localDay } from "./lend-journal.js";
import { lendWorkerRows } from "./lend-workers-view.js";
import { codexWeeklyLine } from "./quota-codex-line.js";
import type { QuotaReport } from "./quota-week.js";
import type { AgentLimits } from "./scheduler-agent-pool-config.js";
import { workingSeats } from "./scheduler-agent-pool-ledger.js";
import { readSwitch, weeklyLine } from "./scheduler-autostart.js";
import { stepOfNode } from "./scheduler-work-order.js";
import { getLendPeer, hasPeersTable, pausedFamily, unifiedPeerCapacity, type LendPeer } from "./scheduler-placement-reservations.js";

const FAMILIES = ["claude", "codex"] as const;
type Family = (typeof FAMILIES)[number];

export interface Slot { total: number; busy: number; reportedBusy: number | null; placeable: number; held: boolean }
export interface Quota { usedPct: number; resetAt: number; stopPct: number | null; observedAt: number | null }
export interface Worker {
  id: string; name: string | null; family: "claude" | "codex"; role: "author" | "reviewer";
  taskId: string | null; step: string | null; round: number | null; since: number | null;
  phase: string | null; excerpt: string | null; beatAt: number | null;
  state: "running" | "silent" | "no_beat" | "unknown";
}
interface Cards { merge: string[]; live: string[]; blocked: string[] }
export interface RosterMachine {
  machineKey: string;
  instanceId: string | null;
  online: boolean | null; checkedAt: number | null; latencyMs: number | null;
  helloAt: number | null;
  proto: "local" | "push" | "poll" | null;
  why: string | null;
  slots: { claude: Slot | null; codex: Slot | null };
  quota: { claude: Quota | null; codex: Quota | null };
  grant: { roles: string[]; repos: number; until: number; ordersLeftToday: number } | null;
  paused: { reason: string; until: number } | null;
  workers: Worker[];
  cards: Cards;
  output: { day: string; delivered: number; reviewed: number }[];
}
export interface Roster {
  now: number; project: string;
  self: { instanceId: string | null };
  machines: RosterMachine[];
  unattributed: Cards;
}

/** peer 的在线读数（bridge peerPresence 换算后）；读不到 = null */
export interface PeerPresenceFacts { online: boolean | null; checkedAt: number | null; latencyMs: number | null }

export interface RosterInput {
  db: Database;
  project: string;
  now: number;
  selfInstanceId: string | null;
  /** scheduler.json projects[p].agents；没有池 / scheduler.json 读不了 = null（两边位子都给 null） */
  agents: AgentLimits | null;
  /** 调度器的额度调整（quotaPoolTotals）；读不了 = null（两家位子未知）；单测可换 */
  poolTotals(totals: AgentLimits): AgentLimits | null;
  /** 本机周额度（readWeekQuota）；读不了 = null */
  localQuota: QuotaReport | null;
  /** 有效借入条目里含本项目的 peer 名 */
  borrowPeers: readonly string[];
  peerInstanceId(peer: string): string | null;
  peerPresence(peer: string): PeerPresenceFacts | null;
  peerQuota(peer: string): QuotaReport | null;
}

const hasTable = (db: Database, name: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** 本机在归属 / 产出里的内部键：peer 名是配置数据、可以就叫 "local"，内部不能拿 "local" 当本机（char(0) 不会出现在 peer 名里） */
const SELF = "\u0000self";

const emptyCards = (): Cards => ({ merge: [], live: [], blocked: [] });

/** 含今天共 7 个本地日期（旧 → 新）与第一天 0 点 */
export function weekDays(now: number): { days: string[]; start: number } {
  const d = new Date(now);
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) days.push(localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i, 12).getTime()));
  return { days, start: new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime() };
}

/** 该卡该步骤最大 round 那一行的 round 与 createdAt；查不到 = null */
function stepRound(db: Database, taskId: string | null, step: string | null): { round: number | null; since: number | null } {
  if (!taskId || !step || !hasTable(db, "task_steps")) return { round: null, since: null };
  const r = db.query("SELECT round, createdAt FROM task_steps WHERE taskId = ? AND step = ? ORDER BY round DESC LIMIT 1")
    .get(taskId, step) as { round: number; createdAt: number } | null;
  return r ? { round: r.round, since: r.createdAt } : { round: null, since: null };
}

const STAGE_STEP: Record<string, string> = { restate: "restate", build: "write", fix: "fix", review: "review" };

type Seats = NonNullable<ReturnType<typeof workingSeats>>;

/** workingSeats 里绑定按阶段占位的条件（作者在 spec/restate/build/fix、审查员在 review）；其余审查员占位靠未结 review effect，由 holdsSeat 判 */
const WORKING_STAGE: Record<string, readonly string[]> = { author: ["spec", "restate", "build", "fix"], reviewer: ["review"] };

/** 这张卡是否让 agent 占着这个 seat：阶段就在占位口径里，或去掉该卡后 workingSeats（调度器同一口径，含未结 review effect）里这个 seat 消失 / 不再是审查员 */
function holdsSeat(db: Database, project: string, agent: string, reviewer: boolean, b: { taskId: string; role: string; stage: string }): boolean {
  if (WORKING_STAGE[b.role]?.includes(b.stage)) return true;
  const rest = workingSeats(db, project, b.taskId)?.get(agent);
  return !rest || (reviewer && !rest.reviewer);
}

/**
 * agent 名的 seat 回查 scheduler_sessions（未退役、非 peer）：只认真正让它占位的绑定（holdsSeat），空闲绑定（如 merge / live）不抢；
 * 同一 agent 同时在几张卡上干活时只看与 seat 同角色的绑定，按 updatedAt 取第一条占位的（都判不出时取该角色最新一条）。步骤优先取它在 task_steps 里最近的一行，否则按卡的阶段
 */
function sessionOf(db: Database, project: string, agent: string, reviewer: boolean): { taskId: string; step: string | null } | null {
  const rows = db.query(`SELECT s.taskId, s.role, t.stage FROM scheduler_sessions s JOIN tasks t ON t.id = s.taskId
    WHERE t.project = ? AND s.agent = ? AND s.transport != 'peer' AND s.state != 'retired'
    ORDER BY s.updatedAt DESC`).all(project, agent) as
    { taskId: string; role: string; stage: string }[];
  // 只在与 seat 同角色的绑定里挑：审查员 seat 的未结审查互相保留占位时，作者阶段的捷径不能把它改认到作者卡上
  const role = reviewer ? "reviewer" : "author", same = rows.filter((x) => x.role === role), pool = same.length ? same : rows;
  const r = pool.find((x) => holdsSeat(db, project, agent, reviewer, x)) ?? pool[0];
  if (!r) return null;
  const own = hasTable(db, "task_steps")
    ? db.query("SELECT step FROM task_steps WHERE taskId = ? AND executor = ? ORDER BY updatedAt DESC, round DESC LIMIT 1").get(r.taskId, agent) as { step: string } | null
    : null;
  return { taskId: r.taskId, step: own?.step ?? (r.role === "reviewer" ? "review" : STAGE_STEP[r.stage] ?? null) };
}

/** 本机 worker：workingSeats 的每个键一行，回查不到的卡号 / 步骤 / 轮次为 null，但仍是一个 seat；creating 的流程节点换成真实步骤（stepOfNode） */
function localWorkers(db: Database, project: string, seats: Seats | null): Worker[] {
  const out: Worker[] = [];
  for (const [key, seat] of seats ?? []) {
    const creating = key.match(/^creating:(.+):([^:]+)$/);
    const found = creating ? { taskId: creating[1]!, step: stepOfNode(creating[2]!) ?? creating[2]! } : sessionOf(db, project, key, seat.reviewer);
    const at = stepRound(db, found?.taskId ?? null, found?.step ?? null);
    out.push({
      id: `local:${key.replace(/^agent-/, "")}`, name: creating ? null : key, family: seat.family, role: seat.reviewer ? "reviewer" : "author",
      taskId: found?.taskId ?? null, step: found?.step ?? null, ...at, phase: null, excerpt: null, beatAt: null, state: "running",
    });
  }
  return out;
}

/** 远端 worker：lendWorkerRows 原样照搬状态，按 peer 分组；同一 id 只留第一行 */
function peerWorkers(db: Database, project: string, now: number, seen: Set<string>): Map<string, Worker[]> {
  const out = new Map<string, Worker[]>();
  for (const r of lendWorkerRows(db, now, project)) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const w: Worker = {
      id: r.id, name: r.worker, family: r.family === "codex" ? "codex" : "claude", role: r.role === "审查员" ? "reviewer" : "author",
      taskId: r.taskId, step: r.step, ...stepRound(db, r.taskId, r.step), phase: r.phase, excerpt: r.excerpt, beatAt: r.beatAt, state: r.state,
    };
    out.set(r.peer, [...(out.get(r.peer) ?? []), w]);
  }
  return out;
}

/** 本机位子：total = 配置；busy = workingSeats 该家族条数；placeable 用额度调整后的 total；没有池 / 没有会话表 = 两家 null */
function localSlots(agents: AgentLimits | null, adjusted: AgentLimits | null, seats: Map<string, { family: AuthorFamily }> | null):
  { claude: Slot | null; codex: Slot | null } {
  if (!agents || !adjusted || !seats) return { claude: null, codex: null };
  const busy = { claude: 0, codex: 0 };
  for (const s of seats.values()) busy[s.family]++;
  const slot = (f: Family): Slot => ({ total: agents[f], busy: busy[f], reportedBusy: null, placeable: Math.max(0, adjusted[f] - busy[f]),
    held: agents[f] > 0 && adjusted[f] === 0 });
  return { claude: slot("claude"), codex: slot("codex") };
}

/** 本机在这台 peer 上该家族的在途单（跨项目） */
const liveAt = (db: Database, peer: string, f: Family): number =>
  (db.query(`SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND family = ? AND status IN (${LEND_LIVE.map(() => "?").join(",")})`)
    .get(peer, f, ...LEND_LIVE) as { n: number }).n;

/** peer 位子：按整台机器跨项目（与 unifiedPeerCapacity 同源）；没有 lend_peers 行或本项目不在 agents 池 = null，why 照填 */
function peerSlotsOf(db: Database, peer: string, row: LendPeer | null, unified: boolean, now: number):
  { slots: { claude: Slot | null; codex: Slot | null }; why: string | null } {
  if (!hasTable(db, "lend_orders") || !hasPeersTable(db)) return { slots: { claude: null, codex: null }, why: null };
  const cap = unifiedPeerCapacity(db, peer, now);
  if (!row || !unified) return { slots: { claude: null, codex: null }, why: cap.why };
  const slot = (f: Family): Slot => ({ total: row.slots[f].total, busy: liveAt(db, peer, f), reportedBusy: row.slots[f].busy,
    placeable: cap.slots[f], held: pausedFamily(row.paused, f, now) });
  return { slots: { claude: slot("claude"), codex: slot("codex") }, why: cap.why };
}

const quotaOf = (r: QuotaReport | null, f: Family, stopPct: number | null, observedAt: number | null): Quota | null => {
  const w = r?.[f];
  return w ? { usedPct: w.weekUsedPct, resetAt: w.resetAt, stopPct, observedAt } : null;
};

/** 本项目 merge / live / blocked 的卡按最近一次 write / fix 步骤（updatedAt）的执行者归到机器：peer 名 / SELF / null（不归） */
function cardOwners(db: Database, project: string): { id: string; stage: keyof Cards; machine: string | null }[] {
  const steps = hasTable(db, "task_steps");
  const rows = db.query(`SELECT t.id, t.stage, ${steps ? `(SELECT s.executor || char(1) || s.executorKind FROM task_steps s
      WHERE s.taskId = t.id AND s.step IN ('write','fix') ORDER BY s.updatedAt DESC, s.round DESC LIMIT 1)` : "NULL"} AS doer
    FROM tasks t WHERE t.project = ? AND t.stage IN ('merge','live','blocked') ORDER BY t.id`).all(project) as { id: string; stage: keyof Cards; doer: string | null }[];
  return rows.map((r) => {
    if (!r.doer) return { id: r.id, stage: r.stage, machine: null };
    const [executor, kind] = r.doer.split("\u0001") as [string, ExecutorKind];
    return { id: r.id, stage: r.stage, machine: kind === "peer" ? stepPeer({ executor, executorKind: kind }) : SELF };
  });
}

/** 7 天产出：task_steps join tasks；交付 = write / fix delivered，审完 = review / final_review done；机器 = stepPeer ?? SELF */
function outputs(db: Database, project: string, now: number): Map<string, Map<string, { delivered: number; reviewed: number }>> {
  const out = new Map<string, Map<string, { delivered: number; reviewed: number }>>();
  if (!hasTable(db, "task_steps")) return out;
  const { start } = weekDays(now);
  const rows = db.query(`SELECT s.step, s.executor, s.executorKind, s.updatedAt FROM task_steps s JOIN tasks t ON t.id = s.taskId
    WHERE t.project = ? AND s.updatedAt >= ? AND s.updatedAt <= ?
    AND ((s.step IN ('write','fix') AND s.state = 'delivered') OR (s.step IN ('review','final_review') AND s.state = 'done'))`)
    .all(project, start, now) as { step: string; executor: string; executorKind: ExecutorKind; updatedAt: number }[];
  for (const r of rows) {
    const machine = stepPeer(r) ?? SELF, day = localDay(r.updatedAt);
    const byDay = out.get(machine) ?? out.set(machine, new Map()).get(machine)!;
    const cell = byDay.get(day) ?? byDay.set(day, { delivered: 0, reviewed: 0 }).get(day)!;
    if (r.step === "write" || r.step === "fix") cell.delivered++;
    else cell.reviewed++;
  }
  return out;
}

/** 本项目还有未结单的 peer（借入撤了也要列，否则 worker 会丢） */
function livePeers(db: Database, project: string): string[] {
  if (!hasTable(db, "lend_orders")) return [];
  return (db.query(`SELECT DISTINCT peer FROM lend_orders WHERE project = ? AND status IN (${LEND_LIVE.map(() => "?").join(",")})`)
    .all(project, ...LEND_LIVE) as { peer: string }[]).map((r) => r.peer);
}

const proto = (row: LendPeer | null): RosterMachine["proto"] => (row ? (row.proto >= 2 ? "push" : "poll") : null);

function peerMachine(inp: RosterInput, peer: string, workers: Worker[]): Omit<RosterMachine, "cards" | "output"> {
  const { db, now } = inp;
  const row = hasPeersTable(db) ? getLendPeer(db, peer) : null;
  const { slots, why } = peerSlotsOf(db, peer, row, inp.agents !== null, now);
  const pres = inp.peerPresence(peer), q = inp.peerQuota(peer), helloAt = row?.helloAt ?? null;
  const g = row?.grant;
  return {
    machineKey: peer, instanceId: inp.peerInstanceId(peer),
    online: pres?.online ?? null, checkedAt: pres?.checkedAt ?? null, latencyMs: pres?.latencyMs ?? null,
    helloAt, proto: proto(row), why, slots,
    quota: { claude: quotaOf(q, "claude", null, helloAt), codex: quotaOf(q, "codex", null, helloAt) },
    grant: g ? { roles: [...g.roles], repos: g.repos.length, until: g.until, ordersLeftToday: g.ordersLeftToday } : null,
    paused: row?.paused ? { reason: row.paused.reason, until: row.paused.until } : null, workers,
  };
}

/** Claude 停派线 = quotaPoolTotals 用的同一个值；meta 坏了按默认线，并留一句 */
function claudeLine(db: Database, project: string): number {
  try { return weeklyLine(readSwitch(db, project)); }
  catch (e) {
    console.warn(`[team-roster] ${project} 的 autostart meta 读不了，Claude 线按默认：${(e as Error).message}`);
    return weeklyLine({});
  }
}

function localMachine(inp: RosterInput, seats: ReturnType<typeof workingSeats>): Omit<RosterMachine, "cards" | "output"> {
  const { db, project, now, agents } = inp;
  return {
    machineKey: "local", instanceId: inp.selfInstanceId, online: true, checkedAt: null, latencyMs: null, helloAt: null, proto: "local", why: null,
    slots: localSlots(agents, agents ? inp.poolTotals(agents) : null, seats),
    quota: { claude: quotaOf(inp.localQuota, "claude", claudeLine(db, project), now), codex: quotaOf(inp.localQuota, "codex", codexWeeklyLine(db, project), now) },
    grant: null, paused: null, workers: localWorkers(db, project, seats),
  };
}

/** 名册：machines[0] 本机，其后本项目的 peer（借入含本项目 ∪ 本项目有未结单），按名排序 */
export function teamRoster(inp: RosterInput): Roster {
  const { db, project, now } = inp;
  const seats = workingSeats(db, project);
  const local = localMachine(inp, seats);
  const seen = new Set(local.workers.map((w) => w.id));
  const remote = peerWorkers(db, project, now, seen);
  const names = [...new Set([...inp.borrowPeers, ...livePeers(db, project), ...remote.keys()])].sort();
  // 叫 "local" 的 peer 照列（machineKey 与本机同名，网页靠 machines[0] / proto 区分），归属与产出走内部键，不与本机混记
  if (names.includes("local")) console.warn(`[team-roster] ${project} 有 peer 名叫 "local"，machineKey 与本机同名；本机是 machines[0]（proto local）`);
  const machines = [local, ...names.map((p) => peerMachine(inp, p, remote.get(p) ?? []))]
    .map((m) => ({ ...m, cards: emptyCards(), output: [] as RosterMachine["output"] }));
  const byKey = new Map(machines.map((m, i) => [i === 0 ? SELF : m.machineKey, m]));
  const unattributed = emptyCards();
  // 归属到名册外的 peer（借入已撤、也没有未结单）的卡不丢：进 unattributed
  for (const c of cardOwners(db, project)) ((c.machine && byKey.get(c.machine)?.cards) || unattributed)[c.stage].push(c.id);
  const out = outputs(db, project, now), { days } = weekDays(now);
  for (const [key, m] of byKey) m.output = days.map((day) => ({ day, ...(out.get(key)?.get(day) ?? { delivered: 0, reviewed: 0 }) }));
  return { now, project, self: { instanceId: inp.selfInstanceId }, machines, unattributed };
}
