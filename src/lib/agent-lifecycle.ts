/**
 * Card worker lifecycle (LIFE1): which worker agents to collect this pass, decided from facts only (no I/O, tests/agent-lifecycle.test.ts).
 * An agent is a card worker only through a ledger record, read through the one index (agent-lifecycle-store.ts cardWorkerIndex:
 * registration, scheduler_sessions row or a card's tasks.agent). Names never decide anything; an agent no record links to a card is
 * the user's and is never touched. A registration names a session: an agent now running another session (the name was reused after
 * a manual remove) or whose session is unknown is kept and reported, never collected.
 * Every collection is a retire (archive → remove → own checkout + temp dirs; a resume or a new session later starts fresh):
 * - card finished (verified / done / cancelled): every agent registered to it.
 * - reviewer: verdict recorded and the card left review long enough ago, or idle long enough.
 * - author: card in merge / live / blocked and idle long enough.
 * - stock: unregistered agents a record links to a finished card, idle long enough.
 * - memory: swap above the threshold → idle-longest-first among agents not on in-progress cards, until it drops back (executor re-reads).
 * Sessions the scheduler bound (scheduler_sessions) stay the scheduler's: it collects them when the card finishes
 * (scheduler-retire.ts) and resumes them for the next round. Retiring a binding on an unfinished card needs an entry point the
 * scheduler does not have yet (LIFE3), so one that is due (idle rule or memory backstop) goes into `kept` marked `bound` with
 * BOUND_WAIT, and the summary line counts it into 应收 and separately as 调度绑定待收 K: visible, not silently exempt.
 * Disk a retire could not clean is retried every pass (pendingCleanups), one pending row at a time (its key: agent + regAt), with
 * the same frozen / protected / recent-activity guards as a retire, and kept while any agent now works in one of its checkouts.
 * Never: master, PM, kind=main, lend workers (lend_orders; the lend service collects them), frozen cards (only reported), a card whose
 * extra cannot be read (reported), a live turn, a turn within recentTurnMin (running or not), an agent another unfinished card still uses.
 */
import type { LifecyclePolicy } from "./agent-lifecycle-config.js";
import type { CardWorker, CleanupEntry, PendingCleanup, WorkerRole } from "./agent-lifecycle-store.js";

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
  /** tasks.extra could not be parsed: whether the card is frozen is unknown */
  extraError?: string;
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
  /** pendingCleanups(db): disk earlier retires left behind */
  pending?: readonly (PendingCleanup & { error?: string })[];
}

type Rule = "card_finished" | "reviewer_done" | "author_idle" | "stock" | "memory" | "cleanup_retry";
export interface Action {
  agent: string; taskId: string | null; role: WorkerRole | "stock"; rule: Rule; idleMs: number | null; reason: string;
  /** the session this decision is about: the executor refuses when the agent runs another one by then */
  sessionId?: string;
  cwd?: string;
  /** cleanup_retry only: what is still on disk */
  entries?: CleanupEntry[];
  /** cleanup_retry only: the pending row's createdAt, its key with the agent name */
  regAt?: number;
}
export interface Plan {
  actions: Action[];
  /** memory candidates, idle-longest first; the executor takes them one by one while swap stays above the threshold */
  memory: Action[];
  /** disk earlier retires could not clean, retried each pass */
  cleanups: Action[];
  frozen: { agent: string; taskId: string }[];
  /** kept although a rule would apply (sources disagree, session changed, scheduler-bound, unreadable card): reported, not collected */
  kept: { agent: string; reason: string; bound?: true }[];
  /** running worker agents */
  live: number;
  swapPct: number | null;
}

interface Worker { facts: AgentFacts; taskId: string | null; role: WorkerRole | "stock"; bound: boolean; links: CardWorker["links"] }

/** The reason a due scheduler-bound session is kept: retiring the binding belongs to LIFE3. */
export const BOUND_WAIT = "调度绑定，待 LIFE3";

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

/** A registration made for another session than the one the agent runs now (or runs an unknown one): not this card's worker any more. */
function sessionMismatch(w: Worker): string | null {
  const regs = w.links.filter((l) => l.source === "worker_agents");
  if (!regs.length) return null;
  const now = w.facts.sessionId;
  const other = regs.find((l) => !l.sessionId || l.sessionId !== now);
  if (!other) return null;
  return now ? `登记的会话 ${other.sessionId || "?"} 不是它现在的会话 ${now}（名字被复用？），保守保留` : "读不出它现在的会话 id，核不了是不是登记的那个，保守保留";
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
  const base = { agent: a.name, taskId: w.taskId, role: w.role, idleMs: idle, ...(a.sessionId ? { sessionId: a.sessionId } : {}), ...(a.cwd ? { cwd: a.cwd } : {}) };
  const idleFor = (min: number) => idle !== null && idle >= min * MIN;
  if (w.role === "stock") {
    if (!card || !FINISHED_STAGES.includes(card.stage)) return null;
    if (!idleFor(p.stockIdleMin) && a.running) return null;
    return { ...base, rule: "stock", reason: `未登记的存量 worker，卡 ${card.id} 已 ${card.stage}，闲置 ${hours(idle)}` };
  }
  if (!card) return idleFor(p.stockIdleMin) ? { ...base, rule: "card_finished", reason: `登记的卡 ${w.taskId} 台账里找不到，闲置 ${hours(idle)}` } : null;
  if (FINISHED_STAGES.includes(card.stage)) return { ...base, rule: "card_finished", reason: `卡 ${card.id} 已 ${card.stage}` };
  if (w.role === "reviewer") {
    const left = card.stage !== "review" && card.stageAt !== null && input.now - card.stageAt >= p.reviewerAfterReviewMin * MIN
      && card.reviewAt !== null && card.reviewAt <= (card.stageAt ?? 0);
    if (!left && !idleFor(p.reviewerIdleMin)) return null;
    return { ...base, rule: "reviewer_done", reason: left ? `结论已记录，卡离开 review ${hours(input.now - card.stageAt!)}` : `审查员闲置 ${hours(idle)}` };
  }
  if (w.role === "author" && AUTHOR_WAIT_STAGES.includes(card.stage) && idleFor(p.authorIdleMin)) {
    return { ...base, rule: "author_idle", reason: `卡在 ${card.stage}，作者闲置 ${hours(idle)}` };
  }
  return null;
}

export function planLifecycle(input: PlanInput): Plan {
  const cards = new Map(input.cards.map((c) => [c.id, c]));
  const all = workers(input);
  const plan: Plan = { actions: [], memory: [], cleanups: [], frozen: [], kept: [], live: all.filter((w) => w.facts.running).length, swapPct: input.swapPct };
  const recentMs = input.policy.recentTurnMin * MIN;
  // a stopped agent whose activity is unknown (no session file left) cannot have had a turn; a running one might
  const recent = (f: AgentFacts) => f.turnActive || (f.idleMs !== null ? f.idleMs < recentMs : f.running);
  const spare: Worker[] = [], spareBound: Worker[] = [];
  const keep = (w: Worker, reason: string) => plan.kept.push({ agent: w.facts.name, reason });
  const keepBound = (w: Worker, why: string) => plan.kept.push({ agent: w.facts.name, reason: `${BOUND_WAIT}（${why}）`, bound: true });
  for (const w of all) {
    const card = w.taskId ? cards.get(w.taskId) : undefined;
    if (card?.frozen) { plan.frozen.push({ agent: w.facts.name, taskId: card.id }); continue; }
    if (card?.extraError) { keep(w, `卡 ${card.id} 的 extra 读不出（${card.extraError}），冻结与否不明，跳过`); continue; }
    if (recent(w.facts)) continue;
    const conflict = usedElsewhere(w, cards) ?? sessionMismatch(w);
    if (conflict) { keep(w, conflict); continue; }
    const act = decide(input, w, card);
    if (act && w.bound) {
      // finished cards: scheduler-retire.ts is collecting it already, nothing to report
      if (!card || !FINISHED_STAGES.includes(card.stage)) keepBound(w, act.reason);
      continue;
    }
    if (act) plan.actions.push(act);
    else if (w.facts.running && !(card && IN_PROGRESS_STAGES.includes(card.stage))) (w.bound ? spareBound : spare).push(w);
  }
  if (input.swapPct !== null && input.swapPct > input.policy.swapPct) {
    for (const w of spareBound) keepBound(w, `内存兜底：swap ${input.swapPct.toFixed(0)}% 超过 ${input.policy.swapPct}%，闲置 ${hours(w.facts.idleMs)}`);
    plan.memory = spare.sort((x, y) => (y.facts.idleMs ?? 0) - (x.facts.idleMs ?? 0)).map((w) => ({
      agent: w.facts.name, taskId: w.taskId, role: w.role, rule: "memory" as const, idleMs: w.facts.idleMs,
      reason: `swap ${input.swapPct!.toFixed(0)}% 超过 ${input.policy.swapPct}%，闲置 ${hours(w.facts.idleMs)}`,
      ...(w.facts.sessionId ? { sessionId: w.facts.sessionId } : {}), ...(w.facts.cwd ? { cwd: w.facts.cwd } : {}),
    }));
  }
  for (const p of input.pending ?? []) {
    const why = p.error ?? retryBlocked(input, p, cards.get(p.taskId ?? ""), recent);
    if (why === "frozen") { plan.frozen.push({ agent: p.agent, taskId: p.taskId! }); continue; }
    if (why) { plan.kept.push({ agent: p.agent, reason: `待补清先不动：${why}` }); continue; }
    plan.cleanups.push({ agent: p.agent, taskId: p.taskId, role: p.role, rule: "cleanup_retry", idleMs: null, sessionId: p.sessionId,
      regAt: p.createdAt, reason: `上次收回没清完的 ${p.entries.length} 处`, entries: p.entries });
  }
  return plan;
}

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/**
 * Why a pending cleanup may not be retried this pass ("frozen" = its card is frozen), null = it may. The retry acts on disk only,
 * but under the same guards as a retire: frozen / unreadable card, the name now held by a protected or recently active agent, and
 * any agent (whatever its name or session) working in one of the checkouts. The executor re-checks holders against live agents.
 */
function retryBlocked(input: PlanInput, p: PendingCleanup, card: CardFacts | undefined, recent: (f: AgentFacts) => boolean): string | null {
  if (card?.frozen) return "frozen";
  if (card?.extraError) return `卡 ${card.id} 的 extra 读不出（${card.extraError}），冻结与否不明`;
  const same = input.agents.find((a) => a.name === p.agent);
  if (same && (same.kind === "main" || same.role === "pm" || same.role === "dispatcher" || input.pms.has(same.name) || input.master.has(same.name)
    || input.foreign.has(same.name))) return `${p.agent} 现在是受保护的 agent`;
  if (same && recent(same)) return `同名 agent ${p.agent} 最近有活动`;
  const holder = input.agents.find((a) => a.status !== "stopped" && a.cwd && p.entries.some((e) => inside(a.cwd!, e.checkout)));
  return holder ? `${holder.name}（会话 ${holder.sessionId ?? "?"}）正在 ${holder.cwd} 工作` : null;
}

/** Distinct scheduler-bound sessions that are due but wait for LIFE3 (an agent due by idle and memory counts once). */
const boundDue = (plan: Pick<Plan, "kept">): number => new Set(plan.kept.filter((k) => k.bound).map((k) => k.agent)).size;

/** The one-line health summary doctor / ledger audit show: 应收 includes the bound ones, also shown on their own as K. */
export function lifecycleLine(plan: Pick<Plan, "live" | "actions" | "swapPct" | "cleanups" | "kept">, mode: string): string {
  const k = boundDue(plan);
  return `worker agent：活 ${plan.live} / 应收 ${plan.actions.length + k}${k ? `（调度绑定待收 ${k}）` : ""} / swap ${plan.swapPct === null ? "?" : `${plan.swapPct.toFixed(0)}%`}` +
    `${plan.cleanups.length ? ` / 待补清 ${plan.cleanups.length}` : ""}（lifecycle ${mode}）`;
}
