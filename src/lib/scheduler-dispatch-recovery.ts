/**
 * Local takeover (dispatch-recovery-FB2): runs FB2P's eligible plan (recovery-local-fallback-plan.ts) for an auto build / fix card
 * that the outbound gate refused or no peer may safely take — through the scheduler's own formal steps only, and the card stays auto:
 * - the planner's local decision (the same snapshot without the pool: `ensure_session` for a Codex author, else `dispatch` to the bound one);
 * - one CAS write: `ledger scheduler-plan` with the project seq read before the fresh facts were re-assessed (staleBasis), so any write in
 *   between refuses the plan; one live intent per card and the intent key make a duplicate tick or a restarted service a replay, never a
 *   second author; `scheduler-settle` pending→submitted is the claim;
 * - the existing ensure (ensureLocalAuthor: worktree, `manager create`, `scheduler-autostart step local-author`), `scheduler-session-bind`,
 *   and driveDispatch for the work order. A failed step settles cancelled (nothing went out) or unknown (never retried, PM checks).
 * Never here: ending a peer's write lease (`lend-reclaim` is PM's), changing a pinned placement, replacing a card's author session row,
 * adding a seat, switching model, writing ledger state outside the CLI. Those come back as an exact block (PM told once per process).
 * Policy: the injected CFG port (LocalFallbackPolicyPort); no port = nothing read, nothing written; observe only records the would-be
 * action (CFG's recordObserved, one dedup note per round / trigger / outcome, via the injected observe); off does nothing.
 * Wired after the auto tick (scheduler-autostart-deps.ts). tests/scheduler-dispatch-recovery*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { InventoryQuota } from "./ai-quota.js";
import { getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask } from "./ledger-store.js";
import type { BorrowEntry } from "./lend-config.js";
import { orderTakenSeq } from "./order-mark.js";
import { unpullableReason } from "./order-pullable.js";
import type { ObservedAction } from "./recovery-policy.js";
import { localCodexQuotaProof, localFallbackPolicy, planLocalFallback, readLocalFallbackFacts, staleBasis, type Assessment,
  type EligiblePlan, type LocalFallbackFacts, type LocalFallbackPolicyPort, type Proof } from "./recovery-local-fallback-plan.js";
import { boundRef } from "./scheduler-auto-tick.js";
import type { RemotePolicy } from "./scheduler-config.js";
import { driveDispatch, type SchedulerLedgerOps } from "./scheduler-dispatch.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { isPoolIntent } from "./scheduler-pool-plan.js";
import { planScheduler, type PlannerDecision, type PlannerSnapshot } from "./scheduler-plan.js";
import type { SnapshotOpts } from "./scheduler-snapshot.js";
import { workOrderFor } from "./scheduler-work-order.js";
import { deliveryFor, type EnsureResult, type SessionRef, type WorkerSession } from "./worker-session.js";
import { getSchedulerSession, type SessionRole } from "./scheduler-sessions.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type Planned = Extract<PlannerDecision, { kind: "intent" }>;

export interface TakeoverDeps {
  db: Database;
  /** CFG's recoveryPolicy narrowed to localFallback; absent = the mechanism is not wired: no read, no record, no action. */
  policy?: LocalFallbackPolicyPort;
  /** The guarded ledger CLI under the scheduler identity (the auto tick's manager). */
  manager: Manager;
  /** The auto tick's ensure / worker (scheduler-auto-deps.ts): find or create the session; the adapter for a bound one. */
  ensure(task: LedgerTask, role: SessionRole, family: "codex"): Promise<EnsureResult>;
  worker(ref: SessionRef): WorkerSession | { manual: string };
  /**
   * The family the existing local author creation would pick right now (scheduler-local-author.ts launch: pool → poolAuthorRuntime,
   * else localAuthorRuntime). Asked before a new author is claimed; anything but codex, or absent, blocks: no model switch by takeover.
   */
  authorRuntime?(task: LedgerTask): "claude" | "codex";
  notifyPm(task: LedgerTask, text: string): Promise<void>;
  /** observe mode's one record per would-be action (recovery-policy.ts recordObserved); absent = nothing recorded. */
  observe?(a: ObservedAction): void;
  /** Codex quota snapshot (ai-quota.ts); read at most once per pass and again right before the claim. */
  codexQuota?(): Promise<InventoryQuota>;
  /** Effective borrow list; the gate / peer triggers are pool facts, so without it nothing qualifies. */
  borrow(): Promise<readonly BorrowEntry[]>;
  now(): number;
  /** Tests only: the fact reader (default readLocalFallbackFacts); production never replaces it. */
  readFacts?: typeof readLocalFallbackFacts;
  /** Notices already sent in this process (task + code + reason); a restart re-sends a standing block at most once. */
  told?: Set<string>;
}

export interface TakeoverOutcome { taskId: string; step: string; detail: string }

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 560);
const LIVE = "('pending','submitted','unknown')";
/** Blocks PM can act on (grant, room, quota, model, lease, pin); holds, non-candidates and in-flight evidence stay quiet. */
const TELL: readonly string[] = ["no_grant", "no_slot", "no_quota", "family_switch", "lease_held", "pinned", "assignee_peer"];

/** A free local Codex write seat now: the card's own bound local Codex author keeps its seat; else the pool / legacy slot count. */
export function localCodexSlotProof(s: PlannerSnapshot): Proof {
  if (s.author?.source === "local" && s.author.family === "codex") return { ok: true };
  const p = s.pool as (PlannerSnapshot["pool"] & { localPool?: { running: Record<string, number>; totals: Record<string, number> } }) | null | undefined;
  if (p?.remote.agents) {
    const total = p.localPool?.totals.codex ?? p.remote.agents.codex ?? 0, running = p.localPool?.running.codex ?? p.localWriters ?? s.workerCount;
    return total > running ? { ok: true } : { ok: false, why: `本机 Codex 写位已满（${running}/${total}）` };
  }
  return s.workerCount < s.maxWorkers && s.freeWorkerSlot ? { ok: true } : { ok: false, why: `本机写位已满（${s.workerCount}/${s.maxWorkers}）` };
}

/** What the existing formal steps cannot do for the scheduler: each needs PM, and is reported as such, never worked around. */
function formalGap(task: LedgerTask, facts: LocalFallbackFacts): { code: string; why: string } | null {
  if (facts.lease?.state === "held") {
    return { code: "lease_held", why: `写租约仍在 ${facts.lease.peer}（${facts.lease.branch}），调度器无权收回：PM 核对后 ledger lend-reclaim ${task.id}，本机接管下一轮自动继续` };
  }
  const pin = typeof task.extra.placement === "string" && task.extra.placement.startsWith("peer:") ? task.extra.placement : null;
  if (pin) return { code: "pinned", why: `卡由 PM 固定放在 ${pin}，调度器不改放置：PM 去掉固定放置后本机接管下一轮自动继续` };
  if (task.assigneeKind && task.assigneeKind !== "agent") return { code: "assignee_peer", why: `负责人仍是 ${task.assigneeKind} ${task.assignee ?? ""}，PM 先收回` };
  return null;
}

/** The planner's own local decision: same snapshot, no pool, so it places here; only a Codex author ensure or a local dispatch counts. */
function localDecision(s: PlannerSnapshot): Planned | string {
  const d = planScheduler({ ...s, pool: undefined, strayPoolOrders: undefined });
  if (d.kind !== "intent") return `本机规划不是开工 / 修复派单（${d.kind}：${d.reason}）`;
  if (isPoolIntent({ action: d.action, recipient: d.recipient })) return `本机规划指向 ${d.recipient}，不是本机`;
  if (d.action === "ensure_session" && d.sessionRole === "author" && d.sessionFamily === "codex") return d;
  if (d.action === "dispatch" && (d.node === "write" || d.node === "fix")) return d;
  return `本机规划是 ${d.action} ${d.node}，不是 Codex 作者或开工 / 修复派单`;
}

const triggerText = (p: EligiblePlan): string =>
  p.trigger.kind === "gate_refused" ? `外发闸拒收 #${p.trigger.seq}` : `无可安全投递 peer（${oneLine(p.trigger.reason).slice(0, 120)}）`;

class Takeover {
  constructor(readonly deps: TakeoverDeps, readonly task: LedgerTask, readonly opts: SnapshotOpts) {}

  out(step: string, detail: string): TakeoverOutcome { return { taskId: this.task.id, step, detail: oneLine(detail) }; }

  async settle(id: string, from: string, to: string, receipt: string): Promise<boolean> {
    return (await this.deps.manager("ledger", "scheduler-settle", id, "--from", from, "--to", to, "--receipt", oneLine(receipt))).ok === true;
  }

  async tell(code: string, text: string): Promise<void> {
    const key = `${this.task.id}\n${code}\n${text}`;
    if (this.deps.told?.has(key)) return;
    try { await this.deps.notifyPm(this.task, `[调度引擎] ${this.task.id} 本机接管：${text}`); this.deps.told?.add(key); }
    catch (e) { if (e instanceof SchedulerStopped) throw e; console.error(`⚠️ [scheduler] 本机接管通知没发出去（下轮重发）：${(e as Error).message}`); }
  }

  async facts(task: LedgerTask, quota: Proof): Promise<LocalFallbackFacts> {
    const f = (this.deps.readFacts ?? readLocalFallbackFacts)(this.deps.db, task, this.opts, { slot: { ok: true }, quota });
    return { ...f, slot: localCodexSlotProof(f.snapshot) };
  }

  async quota(): Promise<Proof> {
    return this.deps.codexQuota ? localCodexQuotaProof(this.deps.codexQuota, this.deps.now(), { project: this.task.project, ledgerPath: this.deps.db.filename })
      : { ok: false, why: "没有接 Codex 额度读取，不算额度证明" };
  }

  /** observe: one record per would-be action (what on would do, a formal gap included); the record is all observe ever does. */
  observe(a: Assessment, facts: LocalFallbackFacts): TakeoverOutcome {
    const gap = a.kind === "eligible" ? formalGap(this.task, facts) : null;
    const code = a.kind === "blocked" ? a.code : gap?.code ?? null;
    const what = a.kind === "blocked" ? `阻塞 ${a.code}：${a.reasons.join("；")}` : gap ? `阻塞 ${gap.code}：${gap.why}`
      : `本机 Codex 接管${a.role === "fix" ? "修复" : "开工"}（${triggerText(a)}）`;
    if (this.deps.observe && (code === null || TELL.includes(code))) {
      this.deps.observe({ project: this.task.project, mechanism: "localFallback", target: this.task.id,
        // Not the plan key: it digests the card's last event seq, and this very note is a card event — one note per round / trigger / outcome.
        actionKey: `takeover:${code ?? "act"}:r${a.basis.round}:s${a.basis.specRev}:${a.basis.trigger}`.slice(0, 120), action: oneLine(what).slice(0, 300),
        data: { key: a.key, kind: code ? "blocked" : "eligible", ...(code ? { code } : {}), ...(a.kind === "eligible" ? { role: a.role, trigger: a.trigger.kind } : {}) } });
    }
    return this.out("observe", what);
  }

  async run(depth = 0): Promise<TakeoverOutcome> {
    if (!this.deps.policy) return this.out("off", "没接本机接管策略端口：不读、不记、不做");
    const policy = localFallbackPolicy(this.deps.policy, this.task.project);
    if (policy.mode === "off") return this.out("off", policy.diag ?? "本机接管策略 off");
    const cheap = await this.facts(this.task, { ok: false, why: "未读" });
    const first = planLocalFallback(cheap, this.deps.policy);
    const pre = first.kind === "observe" ? first.would : first;
    // Everything but the quota proof decided without I/O: read quota only for a case that could still be eligible.
    const facts = pre.kind === "blocked" && pre.code !== "no_quota" ? cheap : await this.facts(this.task, await this.quota());
    const plan = planLocalFallback(facts, this.deps.policy);
    if (plan.kind === "observe") return this.observe(plan.would, facts);
    if (plan.kind === "blocked") {
      if (TELL.includes(plan.code)) await this.tell(plan.code, `${plan.code}：${plan.reasons.join("；")}`);
      return this.out("blocked", `${plan.code}：${plan.reasons.join("；")}`);
    }
    const gap = formalGap(this.task, facts);
    if (gap) { await this.tell(gap.code, gap.why); return this.out("blocked", `${gap.code}：${gap.why}`); }
    const local = localDecision(facts.snapshot);
    if (typeof local === "string") return this.out("blocked", local);
    // The ledger keeps one author session row per card and never rebinds it (scheduler-sessions.ts): a retired / other one means no new author.
    const prior = local.action === "ensure_session" ? getSchedulerSession(this.deps.db, this.task.id, "author") : null;
    if (prior) {
      const why = `本卡已有作者 session 记录 ${prior.agent}（${prior.family}/${prior.transport}，${prior.state}），台账不换作者 session：PM 核对后指定执行者`;
      await this.tell("author_bound", why);
      return this.out("blocked", `author_bound：${why}`);
    }
    if (local.action === "ensure_session" && !this.task.agent) {
      let runtime: string;
      try { runtime = this.deps.authorRuntime?.(this.task) ?? "未知"; } catch (e) { runtime = `读不到（${(e as Error).message}）`; }
      if (runtime !== "codex") {
        const why = `现有建作者路径此刻会建 ${runtime} 作者，不是 Codex：接管不换模型`;
        await this.tell("family_switch", why);
        return this.out("blocked", `family_switch：${why}`);
      }
    }
    // Revalidate on fresh facts with the policy asked again; the seq read first is the plan's CAS, so nothing can slip in between.
    const seq = (this.deps.db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = ?").get(this.task.project) as { seq: number }).seq;
    const task = getTask(this.deps.db, this.task.id), workflow = getWorkflow(this.deps.db, this.task.id);
    if (!task || !workflow) return this.out("replan", "卡或流程读不到");
    const fresh = await this.facts(task, await this.quota());
    const stale = staleBasis(plan.basis, fresh, this.deps.policy);
    if (stale.length) return this.out("replan", `接管前重核不过：${stale.join("、")}`);
    const again = localDecision(fresh.snapshot);
    if (typeof again === "string" || again.id !== local.id || again.action !== local.action) return this.out("replan", "本机规划已变");
    const reason = oneLine(`本机接管（${triggerText(plan)}；${plan.key}）：${local.reason}`).slice(0, 600);
    const r = await this.deps.manager("ledger", "scheduler-plan", task.id, "--id", local.id, "--rev", String(task.rev), "--workflow-rev", String(workflow.rev),
      "--seq", String(seq), "--node", local.node, "--action", local.action, "--reason", reason,
      ...(local.recipient ? ["--recipient", local.recipient] : []), ...(local.resources.length ? ["--resources", local.resources.join(",")] : []));
    if (r.ok !== true) return this.out("replan", `接管计划没写进台账：${String(r.error)}`);
    const intent = r.intent as SchedulerIntent;
    if (intent.status !== "pending") return this.out("lost_race", `意图 ${intent.id} 已是 ${intent.status}`);
    const preserve = `branch=${plan.preserve.branch ?? "-"}; head=${plan.preserve.head ?? "-"}; specRev=${plan.preserve.specRev}; round=${plan.preserve.round}`;
    if (local.action === "ensure_session") {
      const done = await this.author(task, intent, plan, preserve);
      // A new author is bound: its work order follows in the same pass, re-planned from scratch on the new facts.
      return done.step === "session" && depth === 0 ? this.run(1) : done;
    }
    return this.dispatch(task, intent, local);
  }

  async author(task: LedgerTask, intent: SchedulerIntent, plan: EligiblePlan, preserve: string): Promise<TakeoverOutcome> {
    if (!(await this.settle(intent.id, "pending", "submitted", `claimed; ensure author codex; local-takeover ${plan.key}; ${triggerText(plan)}; ${preserve}`))) {
      return this.out("lost_race", "认领失败");
    }
    let got: EnsureResult;
    try { got = await this.deps.ensure(task, "author", "codex"); }
    catch (e) {
      if (e instanceof SchedulerStopped) throw e; // the claim stays submitted: the next pass proves it or hands it to PM, never re-creates
      await this.settle(intent.id, "submitted", "unknown", `本机接管建作者出错：${(e as Error).message}`);
      await this.tell("unknown", `建本机 Codex 作者结果不明（${oneLine((e as Error).message)}），不重建，PM 核对`);
      return this.out("held", (e as Error).message);
    }
    if (got.kind === "wait" || got.kind === "manual") {
      await this.settle(intent.id, "submitted", "cancelled", `未建：${got.reason}`);
      if (got.kind === "manual") await this.tell("manual", `建本机 Codex 作者被拒：${got.reason}`);
      return this.out(got.kind === "wait" ? "waiting" : "blocked", got.reason);
    }
    if (got.kind === "unknown") {
      await this.settle(intent.id, "submitted", "unknown", `建 session 结果不明：${got.reason}`);
      await this.tell("unknown", `建本机 Codex 作者结果不明：${got.reason}；不重建，PM 核对`);
      return this.out("held", got.reason);
    }
    const ref = got.ref;
    if (ref.family !== "codex" || ref.transport === "peer") {
      await this.settle(intent.id, "submitted", "unknown", `建出的 ${ref.agent} 是 ${ref.family}/${ref.transport}，不是本机 Codex；不绑定`);
      await this.tell("unknown", `建出的 ${ref.agent} 不是本机 Codex（${ref.family}/${ref.transport}），没绑定，PM 核对`);
      return this.out("held", "建出的作者不是本机 Codex");
    }
    const b = await this.deps.manager("ledger", "scheduler-session-bind", task.id, "--role", "author", "--intent", intent.id,
      "--agent", ref.agent, "--session", ref.sessionId, "--family", ref.family, "--transport", ref.transport);
    if (b.ok !== true) {
      await this.settle(intent.id, "submitted", "unknown", `${ref.agent} 已${got.created ? "建" : "找到"}，但台账绑不上：${String(b.error)}`);
      return this.out("held", `绑定失败：${String(b.error)}`);
    }
    await this.settle(intent.id, "submitted", "done", `bound ${ref.agent}/${ref.sessionId}; local-takeover ${plan.key}`);
    return this.out("session", `author = ${ref.agent}（本机 Codex 接管）`);
  }

  ops(): SchedulerLedgerOps {
    const db = this.deps.db;
    return {
      intent: (id) => db.query("SELECT * FROM scheduler_intents WHERE id = ?").get(id) as SchedulerIntent | null,
      current: (taskId, role) => {
        const t = getTask(db, taskId);
        return t ? { specRev: t.specRev, head: t.headSHA, round: t.round, bound: boundRef(db, taskId, role) } : null;
      },
      settle: (id, from, to, receipt) => this.settle(id, from, to, receipt),
      taken: (id) => orderTakenSeq(db, id),
      now: () => this.deps.now(),
    };
  }

  async dispatch(task: LedgerTask, intent: SchedulerIntent, local: Planned): Promise<TakeoverOutcome> {
    const ref = boundRef(this.deps.db, task.id, "author");
    if (!ref || ref.family !== "codex" || ref.transport === "peer") {
      await this.settle(intent.id, "pending", "cancelled", "未投递：没有绑定的本机 Codex 作者");
      return this.out("replan", "没有绑定的本机 Codex 作者");
    }
    const w = this.deps.worker(ref);
    if ("manual" in w) {
      await this.settle(intent.id, "pending", "cancelled", `未投递：${w.manual}`);
      await this.tell("manual", `本机 Codex 作者 ${ref.agent} 无法自动派单：${w.manual}`);
      return this.out("blocked", w.manual);
    }
    const order = workOrderFor(task, intent, local, ref, undefined, this.deps.db);
    if (!order) {
      await this.settle(intent.id, "pending", "cancelled", `未投递：节点 ${intent.node} 没有任务单`);
      return this.out("blocked", `节点 ${intent.node} 没有任务单`);
    }
    let delivery = deliveryFor(w.route, order.step);
    const unpullable = delivery.mode === "wake" ? unpullableReason(this.deps.db, ref, intent) : null;
    if (unpullable) delivery = { mode: "text", reason: `领单工具拿不到这张单（${oneLine(unpullable)}），改发全文` };
    const r = await driveDispatch(this.ops(), w, ref, { ...order, delivery });
    if (r.kind === "sent") return this.out("sent", `本机 Codex 接管已派 ${order.step}：${r.receipt.route}`);
    if (r.kind === "held") await this.tell("unknown", `本机接管派单未定：${r.reason}`);
    return this.out(r.kind === "settled" ? "settled" : r.kind, "reason" in r ? r.reason : r.kind === "settled" ? r.status : "");
  }
}

/** Auto build / fix cards with no open intent: the only ones the takeover looks at (the auto tick has had its step this pass). */
function candidates(db: Database, project: string): LedgerTask[] {
  const ids = db.query(`SELECT t.id FROM tasks t JOIN task_workflows w ON w.taskId = t.id WHERE t.project = ? AND w.mode = 'auto'
    AND t.stage IN ('build','fix') AND NOT EXISTS (SELECT 1 FROM scheduler_intents i WHERE i.taskId = t.id AND i.status IN ${LIVE}) ORDER BY t.id`)
    .all(project) as { id: string }[];
  return ids.map((r) => getTask(db, r.id)).filter((t): t is LedgerTask => !!t);
}

export async function driveLocalTakeover(deps: TakeoverDeps, task: LedgerTask, opts: SnapshotOpts): Promise<TakeoverOutcome> {
  return new Takeover(deps, task, opts).run();
}

/** One pass over the enabled projects; without a policy port it returns at once, before reading anything. */
export async function localTakeoverTick(deps: TakeoverDeps, projects: Record<string, { maxActiveWorkers: number; remote?: RemotePolicy }>):
  Promise<{ cards: TakeoverOutcome[]; failed: { taskId: string; error: string }[] }> {
  const out = { cards: [] as TakeoverOutcome[], failed: [] as { taskId: string; error: string }[] };
  if (!deps.policy) return out;
  if (!deps.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_workflows'").get()) return out;
  let borrow: Promise<readonly BorrowEntry[]> | null = null;
  for (const [project, policy] of Object.entries(projects)) {
    if (!policy.remote) continue; // no pool, no peer: neither trigger can exist
    for (const task of candidates(deps.db, project)) {
      try {
        borrow ??= deps.borrow().catch((e: unknown) => { console.error(`⚠️ [scheduler] 本机接管读借入名单失败，本轮没有 peer 事实：${(e as Error).message}`); return []; });
        const pool = policy.remote.mode === "off" ? { remote: policy.remote, borrow: [] } : { remote: policy.remote, borrow: await borrow };
        out.cards.push(await driveLocalTakeover(deps, task, { registry: [], maxWorkers: policy.maxActiveWorkers, now: deps.now(), pool }));
      } catch (e) {
        if (e instanceof SchedulerStopped) throw e;
        out.failed.push({ taskId: task.id, error: oneLine((e as Error).message) });
      }
    }
  }
  return out;
}
