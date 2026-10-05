/**
 * Card worker lifecycle (LIFE1): which worker agents to collect this pass, decided from facts only (no I/O, tests/agent-lifecycle.test.ts).
 * An agent is a card worker only through a ledger record, read through the one index (agent-lifecycle-store.ts cardWorkerIndex:
 * registration, scheduler_sessions row or a card's tasks.agent). Names never decide anything; an agent no record links to a card is
 * the user's and is never touched.
 * - card finished (verified / done / cancelled): every agent registered to it is retired (archive → remove → own checkout + temp dirs);
 *   scheduler-bound sessions of finished cards are left to scheduler-retire.ts, which already collects them.
 * - reviewer: verdict recorded and the card left review long enough ago, or idle long enough → collected.
 * - author: card in merge / live / blocked and idle long enough → parked (archive → kill; registry, checkout kept for resume).
 * - stock: unregistered agents a record links to a finished card, idle long enough.
 * - memory: swap above the threshold → idle-longest-first among agents not on in-progress cards, until it drops back (executor re-reads).
 * Never: master, PM, kind=main, lend workers (lend_orders; the lend service collects them), frozen cards (only reported), a live
 * turn, a turn within recentTurnMin, an agent another unfinished card still uses.
 */
import type { LifecyclePolicy } from "./agent-lifecycle-config.js";
import type { CardWorker, WorkerRole } from "./agent-lifecycle-store.js";

const MIN = 60_000;
const FINISHED_STAGES: readonly string[] = ["verified", "done", "cancelled"];
/** Author stages where the code is written and only merge / acceptance / an unblock is awaited. */
const AUTHOR_WAIT_STAGES: readonly string[] = ["merge", "live", "blocked"];
/** Stages whose agents are mid-work: the memory backstop never touches them. */
const IN_PROGRESS_STAGES: readonly string[] = ["restate", "build", "review", "fix"];


export interface AgentFacts {
  name: string;
  kind?: "worker" | "main";
  role?: string;
  status?: string;
  cwd?: string;
  sessionId?: string;
  /** a tmux window or ACP host is running it */
  running: boolean;
  /** ms since the last turn activity; null = unknown */
  idleMs: number | null;
  /** a turn is running now */
  turnActive: boolean;
}

export interface CardFacts {
  id: string;
  project: string;
  stage: string;
  frozen: boolean;
  /** last stage change */
  stageAt: number | null;
  /** latest review verdict on the card */
  reviewAt: number | null;
  /** the agent the card names as executor */
  agent: string | null;
}

export interface PlanInput {
  now: number;
  policy: LifecyclePolicy;
  agents: AgentFacts[];
  /** cardWorkerIndex(db): agent → its card links; absent = the user's own agent */
  index: ReadonlyMap<string, CardWorker>;
  cards: CardFacts[];
  pms: ReadonlySet<string>;
  /** agents another service owns by record (lend_orders.agent): never collected here */
  foreign: ReadonlySet<string>;
  /** master's registry key(s) */
  master: ReadonlySet<string>;
  /** system swap use in percent; null = unreadable (memory rule skipped) */
  swapPct: number | null;
}

type Rule = "card_finished" | "reviewer_done" | "author_parked" | "stock" | "memory";
export interface Action {
  agent: string; taskId: string | null; role: WorkerRole | "stock"; rule: Rule; mode: "retire" | "park"; idleMs: number | null; reason: string;
  cwd?: string;
}
export interface Plan {
  actions: Action[];
  /** memory candidates, idle-longest first; the executor takes them one by one while swap stays above the threshold */
  memory: Action[];
  frozen: { agent: string; taskId: string }[];
  /** kept because another record links it to an unfinished or unknown card (sources disagree): reported, not collected */
  kept: { agent: string; reason: string }[];
  /** running worker agents */
  live: number;
  swapPct: number | null;
}

interface Worker { facts: AgentFacts; taskId: string | null; role: WorkerRole | "stock"; bound: boolean; links: CardWorker["links"] }

const hours = (ms: number | null): string => (ms === null ? "?" : `${(ms / 3_600_000).toFixed(1)}h`);

function workers(input: PlanInput): Worker[] {
  const out: Worker[] = [];
  for (const a of input.agents) {
    if (a.kind === "main" || a.role === "pm" || a.role === "dispatcher" || input.pms.has(a.name) || input.master.has(a.name) || input.foreign.has(a.name)) continue;
    const w = input.index.get(a.name);
    if (!w) continue;
    const bound = w.links.some((l) => l.source === "scheduler_sessions");
    // only a card naming it as executor (no registration, no binding) = stock; an unfinished such card comes first and keeps it
    out.push({ facts: a, taskId: w.taskId, role: w.source === "tasks.agent" ? "stock" : w.role, bound, links: w.links });
  }
  return out;
}

/**
 * Another card still links this agent (registration, binding or executor) and is unfinished, or unknown to the ledger: the sources
 * disagree, so the agent is kept (collecting it could stop that card's work).
 */
function usedElsewhere(w: Worker, cards: Map<string, CardFacts>): string | null {
  const hit = w.links.find((l) => {
    if (!l.taskId || l.taskId === w.taskId) return false;
    const other = cards.get(l.taskId);
    return !other || !FINISHED_STAGES.includes(other.stage);
  });
  if (!hit) return null;
  const other = cards.get(hit.taskId!);
  return `${hit.source} 还关联卡 ${hit.taskId}（${other ? other.stage : "台账里找不到"}），记录不一致，保守保留`;
}

function decide(input: PlanInput, w: Worker, card: CardFacts | undefined): Action | null {
  const p = input.policy, idle = w.facts.idleMs, a = w.facts;
  const base = { agent: a.name, taskId: w.taskId, role: w.role, idleMs: idle, ...(a.cwd ? { cwd: a.cwd } : {}) };
  const idleFor = (min: number) => idle !== null && idle >= min * MIN;
  if (w.role === "stock") {
    if (!card || !FINISHED_STAGES.includes(card.stage)) return null;
    if (!idleFor(p.stockIdleMin) && a.running) return null;
    return { ...base, rule: "stock", mode: "retire", reason: `未登记的存量 worker，卡 ${card.id} 已 ${card.stage}，闲置 ${hours(idle)}` };
  }
  if (!card) return w.bound || !idleFor(p.stockIdleMin) ? null : { ...base, rule: "card_finished", mode: "retire", reason: `登记的卡 ${w.taskId} 台账里找不到，闲置 ${hours(idle)}` };
  if (FINISHED_STAGES.includes(card.stage)) {
    if (w.bound) return null; // scheduler-retire.ts collects the sessions it bound
    return { ...base, rule: "card_finished", mode: "retire", reason: `卡 ${card.id} 已 ${card.stage}` };
  }
  if (!a.running) return null; // already stopped: nothing to free until the card finishes
  if (w.role === "reviewer") {
    const left = card.stage !== "review" && card.stageAt !== null && input.now - card.stageAt >= p.reviewerAfterReviewMin * MIN
      && card.reviewAt !== null && card.reviewAt <= (card.stageAt ?? 0);
    if (!left && !idleFor(p.reviewerIdleMin)) return null;
    // a scheduler-bound reviewer is parked: the scheduler still holds its binding and resumes it for a re-review
    return { ...base, rule: "reviewer_done", mode: w.bound ? "park" : "retire",
      reason: left ? `结论已记录，卡离开 review ${hours(input.now - card.stageAt!)}` : `审查员闲置 ${hours(idle)}` };
  }
  if (w.role === "author" && AUTHOR_WAIT_STAGES.includes(card.stage) && idleFor(p.authorIdleMin)) {
    return { ...base, rule: "author_parked", mode: "park", reason: `卡在 ${card.stage}，作者闲置 ${hours(idle)}` };
  }
  return null;
}

export function planLifecycle(input: PlanInput): Plan {
  const cards = new Map(input.cards.map((c) => [c.id, c]));
  const all = workers(input);
  const plan: Plan = { actions: [], memory: [], frozen: [], kept: [], live: all.filter((w) => w.facts.running).length, swapPct: input.swapPct };
  const recent = (w: Worker) => w.facts.turnActive || (w.facts.running && (w.facts.idleMs === null || w.facts.idleMs < input.policy.recentTurnMin * MIN));
  const spare: Worker[] = [];
  for (const w of all) {
    const card = w.taskId ? cards.get(w.taskId) : undefined;
    if (card?.frozen) { plan.frozen.push({ agent: w.facts.name, taskId: card.id }); continue; }
    if (recent(w)) continue;
    const conflict = usedElsewhere(w, cards);
    if (conflict) { plan.kept.push({ agent: w.facts.name, reason: conflict }); continue; }
    const act = decide(input, w, card);
    if (act) plan.actions.push(act);
    else if (w.facts.running && !(card && IN_PROGRESS_STAGES.includes(card.stage))) spare.push(w);
  }
  if (input.swapPct !== null && input.swapPct > input.policy.swapPct) {
    plan.memory = spare.sort((x, y) => (y.facts.idleMs ?? 0) - (x.facts.idleMs ?? 0)).map((w) => {
      const card = w.taskId ? cards.get(w.taskId) : undefined;
      const finished = !card || FINISHED_STAGES.includes(card.stage);
      return { agent: w.facts.name, taskId: w.taskId, role: w.role, rule: "memory" as const, mode: finished && !w.bound ? "retire" as const : "park" as const,
        idleMs: w.facts.idleMs, reason: `swap ${input.swapPct!.toFixed(0)}% 超过 ${input.policy.swapPct}%，闲置 ${hours(w.facts.idleMs)}`,
        ...(w.facts.cwd ? { cwd: w.facts.cwd } : {}) };
    });
  }
  return plan;
}

/** The one-line health summary doctor / ledger audit show. */
export function lifecycleLine(plan: Pick<Plan, "live" | "actions" | "swapPct">, mode: string): string {
  return `worker agent：活 ${plan.live} / 应收 ${plan.actions.length} / swap ${plan.swapPct === null ? "?" : `${plan.swapPct.toFixed(0)}%`}（lifecycle ${mode}）`;
}
