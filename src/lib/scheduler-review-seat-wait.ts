/** Review placement diagnostics use the existing leased observe writer even when reviewSeatIdle is off. */
import type { Database } from "bun:sqlite";
import type { AgentPoolLoad } from "./scheduler-agent-pool.js";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import { workingSeats, type WorkingSeat } from "./scheduler-agent-pool-ledger.js";
import { planScheduler, type PlannerDecision, type PlannerSnapshot } from "./scheduler-plan.js";
import { observeDedupKey, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { peerFacts } from "./scheduler-agent-pool-peer.js";
import { peerRefusal } from "./scheduler-placement.js";
import { placementHistory } from "./scheduler-placement-tried.js";
import { privateRepoOf } from "./scheduler-foreign-repo.js";
import { securityReviewLocalOnly } from "./security-pool.js";
import { keepsReviewer } from "./scheduler-review-swap.js";

const MECHANISM = "reviewSeatIdle", WAIT_MS = 20 * 60_000;
interface Ports { manager(...args: string[]): Promise<Record<string, unknown>>; now(): number; recoveryPolicy?: RecoveryPolicyPort }
interface WaitClock { window: string; since: number }
const clocks = new WeakMap<Database, Map<string, WaitClock>>();
const key = (task: LedgerTask, actionKey: string) => observeDedupKey({ project: task.project, mechanism: MECHANISM, target: task.id, actionKey });

async function record(ports: Ports, task: LedgerTask, actionKey: string, action: string, data: Record<string, unknown>): Promise<boolean> {
  const r = await ports.manager("ledger", "scheduler-recovery-observe", task.id, "--mechanism", MECHANISM,
    "--action-key", actionKey, "--action", action, "--data", JSON.stringify(data));
  if (r.ok !== true) console.error(`[scheduler-review-seat] ${task.id} 等槽记录失败，下轮重试：${String(r.error)}`);
  return r.ok === true;
}

const poolOf = (s: PlannerSnapshot) => s.pool as (NonNullable<PlannerSnapshot["pool"]> & { localPool?: AgentPoolLoad }) | null;

function creatingKeys(db: Database, project: string): Set<string> {
  const rows = db.query(`SELECT i.taskId,i.node,t.agent FROM scheduler_intents i JOIN tasks t ON t.id=i.taskId
    WHERE t.project=? AND i.action='ensure_session' AND i.status IN ('submitted','unknown') AND NOT EXISTS
    (SELECT 1 FROM scheduler_sessions s WHERE s.createIntentId=i.id AND s.state!='retired')`).all(project) as
    { taskId: string; node: string; agent: string | null }[];
  return new Set(rows.filter((r) => !r.agent || !db.query(`SELECT 1 FROM scheduler_sessions s JOIN tasks t ON t.id=s.taskId
    WHERE t.project=? AND s.agent=? AND s.state!='retired' AND s.transport!='peer' AND s.role='author' AND t.stage IN ('spec','restate','build','fix')`).get(project, r.agent))
    .map((r) => ["restate", "write", "fix"].includes(r.node) && r.agent ? r.agent : `creating:${r.taskId}:${r.node}`));
}

function counts(seats: Map<string, WorkingSeat>, family: AuthorFamily, creating = new Set<string>()) {
  const out = { authors: 0, reviewers: 0, creating: 0, running: 0 };
  for (const [id, s] of seats) if (s.family === family) {
    out.running++;
    if (id.startsWith("creating:") || (!s.reviewer && creating.has(id))) out.creating++;
    else if (s.reviewer) out.reviewers++;
    else out.authors++;
  }
  return out;
}

/** Codes alone leave raw hello diagnostics, repository coordinates and machine identifiers out of the durable note. */
function peerCodes(s: PlannerSnapshot, family: AuthorFamily): string[] {
  const p = s.pool;
  if (privateRepoOf(s) && securityReviewLocalOnly(s.workflow, s.securityPool)) return ["private_local_review_conflict"];
  if (!p?.peers.length) return ["no_peers"];
  const since = s.events.findLast((e) => e.kind === "stage" && e.data.to === "review")?.seq ?? 0;
  const history = placementHistory(s, since);
  const facts = { remote: p.remote, repo: p.repo, peers: p.peers.map(peerFacts), local: { running: 0, room: false },
    pin: null, lastPeer: p.lastPeer, writeLeasePeer: null, locksFree: true, tried: history.tried };
  const localOnly = securityReviewLocalOnly(s.workflow, s.securityPool) || (keepsReviewer(s) && s.reviewer?.source === "local");
  return [...new Set(facts.peers.map((peer) => {
    if (localOnly && !privateRepoOf(s)) return "local_review_required";
    if (p.remote.mode === "off") return "remote_off";
    if (history.tried.includes(peer.peer)) return "round_attempt_spent";
    if (history.retries.some((r) => r.peer === peer.peer && r.gate)) return "temporary_refusal_wait";
    if (!peer.v2) return "no_hello";
    if (peer.v2.why) return "hello_unusable";
    if (!p.repo || !peer.v2.repos.some((r) => r.toLowerCase() === p.repo!.toLowerCase())) return "repo_unauthorized";
    if (peer.v2.slots[family] <= 0) return "family_no_slot";
    return peerRefusal(facts, peer, "review", family) ? "placement_policy_refused" : "peer_available";
  }))];
}

function counterfactual(s: PlannerSnapshot, seats: Map<string, WorkingSeat>): PlannerDecision {
  const running = { claude: counts(seats, "claude").running, codex: counts(seats, "codex").running };
  const pool = { ...s.pool!, localReviewers: [...seats.values()].filter((v) => v.reviewer).length,
    localPool: { ...poolOf(s)!.localPool!, running } };
  return planScheduler({ ...s, workerCount: running.claude + running.codex, pool });
}

async function observeRoom(db: Database, task: LedgerTask, s: PlannerSnapshot, seats: Map<string, WorkingSeat>, family: AuthorFamily, ports: Ports) {
  if ((ports.recoveryPolicy ?? recoveryPolicy)(task.project, MECHANISM).mode !== "observe" || !poolOf(s)?.localPool) return;
  const actionKey = `release:r${task.round}`;
  if (getEventByDedup(db, key(task, actionKey))) return;
  const active = workingSeats(db, task.project, task.id, "on");
  if (!active) return;
  const idle = [...seats].filter(([id, v]) => v.family === family && v.reviewer && !active.has(id)).length;
  if (!idle || counts(active, family).running >= poolOf(s)!.localPool!.totals[family]) return;
  const planned = counterfactual(s, active);
  const local = planned.kind === "intent" && ((planned.action === "ensure_session" && planned.sessionRole === "reviewer") ||
    (planned.action === "review" && planned.recipient === s.reviewer?.agent && s.reviewer?.source === "local"));
  if (local) await record(ports, task, actionKey, `放行：不计空闲审查员 ${idle} 个`, { round: task.round, family, idle });
}

/** Prefer existing ledger timestamps; absent evidence uses an in-process clock and accepts a restart's conservative delay. */
function waitSince(db: Database, task: LedgerTask, s: PlannerSnapshot, family: AuthorFamily, now: number): { since: number; clock: "ledger" | "process" } {
  const times = s.events.filter((e) => e.kind === "review" ||
    (e.kind === "stage" && e.data.to === "review" && e.data.round === task.round)).map((e) => e.ts);
  const ended = db.query(`SELECT MAX(updatedAt) AS at FROM scheduler_intents WHERE taskId=? AND action='review'
    AND status IN ('done','cancelled')`).get(task.id) as { at: number | null };
  if (ended.at !== null) times.push(ended.at);
  const valid = times.filter((t) => Number.isFinite(t) && t >= 0);
  if (valid.length) return { since: Math.max(...valid), clock: "ledger" };
  let taskClocks = clocks.get(db);
  if (!taskClocks) { taskClocks = new Map(); clocks.set(db, taskClocks); }
  const window = JSON.stringify([task.round, task.specRev, task.headSHA, family]);
  const prior = taskClocks.get(task.id);
  if (prior?.window === window) return { since: prior.since, clock: "process" };
  taskClocks.set(task.id, { window, since: now });
  return { since: now, clock: "process" };
}

/** Only the threshold diagnostic is durable; below twenty minutes no wait note, creation or dispatch is written. */
export async function trackReviewSeatWait(db: Database, task: LedgerTask, s: PlannerSnapshot, plan: PlannerDecision, ports: Ports): Promise<void> {
  const family = s.workflow?.authorFamily === "claude" ? "codex" : "claude";
  const inFlight = db.query(`SELECT 1 FROM scheduler_intents WHERE taskId=? AND action='review'
    AND status IN ('pending','submitted','unknown')`).get(task.id);
  if (task.stage !== "review" || plan.kind !== "wait" || plan.code !== "placement" || inFlight) {
    clocks.get(db)?.delete(task.id);
    return;
  }
  const seats = workingSeats(db, task.project, task.id);
  if (!seats) return; // Missing authoritative bindings cannot be treated as idle reviewers or used for a capacity diagnosis.
  await observeRoom(db, task, s, seats, family, ports);
  const { since, clock } = waitSince(db, task, s, family, ports.now()), actionKey = `wait-note:r${task.round}`;
  if (ports.now() - since <= WAIT_MS || getEventByDedup(db, key(task, actionKey))) return;
  const c = counts(seats, family, creatingKeys(db, task.project)), cap = poolOf(s)?.localPool?.totals[family] ?? s.pool?.remote.agents?.[family] ?? s.maxWorkers;
  const codes = [...(privateRepoOf(s) ? ["private_repo_peer_only"] : []), ...peerCodes(s, family)];
  await record(ports, task, actionKey, `记录：审查等槽超过 20 分钟；家族 ${family}；本机上限 ${cap}，在跑 ${c.running}` +
    `（作者 ${c.authors} / 审查员 ${c.reviewers} / 创建预留 ${c.creating}）；peer 原因码 ${codes.join(",")}`,
    { round: task.round, family, cap, ...c, peerCodes: codes, since, clock });
}
