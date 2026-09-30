/**
 * One service pass over auto cards. The service only reads the ledger; every write goes through the guarded
 * `ledger scheduler-*` CLI under the scheduler identity, which re-checks inside its own transaction. Per card at most
 * one step: drive the card's open intent, else plan the next one and drive it. An unknown result, a lost race or a
 * stale plan ends the card's pass; nothing is resent under a new key unless the ledger itself says the old one is void.
 */
import type { Database } from "bun:sqlite";
import { getIntent, getWorkflow, type AuthorFamily, type IntentStatus, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask, listEvents } from "./ledger-store.js";
import { orderTakenSeq, UNCLAIMED_ALARM_MS, unclaimedKey, unclaimedSentKey } from "./order-mark.js";
import { unpullableReason } from "./order-pullable.js";
import { deadUiAsk, screenshotRefs } from "./scheduler-apply.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { CLAIM_LEASE_MS, driveDispatch, type DriveOutcome, type SchedulerLedgerOps } from "./scheduler-dispatch.js";
import { planScheduler, type PlannerDecision } from "./scheduler-plan.js";
import { getSchedulerSession, type SessionRole } from "./scheduler-sessions.js";
import type { SnapshotOpts } from "./scheduler-snapshot.js";
import { stepOfNode, workOrderFor } from "./scheduler-work-order.js";
import { paceCards, type TickPace } from "./scheduler-yield.js";
import type { BorrowEntry } from "./lend-config.js";
import type { RemotePolicy } from "./scheduler-config.js";
import { isPoolIntent } from "./scheduler-pool-plan.js";
import { drivePool } from "./scheduler-pool-tick.js";
import { deliveryFor, sentAsWake, type EnsureResult, type SessionRef, type WorkerSession } from "./worker-session.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type Planned = Extract<PlannerDecision, { kind: "intent" }>;

export interface AutoTickDeps {
  /** The ledger CLI under the scheduler identity. */
  manager: Manager;
  /** The adapter for this bound session's route, or why it cannot be driven automatically. */
  worker(ref: SessionRef): WorkerSession | { manual: string };
  /** Find or create this card's session for the role. It never binds: binding is a ledger write through the CLI. */
  ensure(task: LedgerTask, role: SessionRole, family: AuthorFamily): Promise<EnsureResult>;
  /** Put the reviewer's own checkout on the head under review; runs before the claim, so a refusal writes nothing. */
  pinReview(task: LedgerTask, ref: SessionRef, head: string | null): Promise<{ dir: string } | { manual: string }>;
  /** Uncommitted tracked edits in the reviewer's checkout (null = clean): the verdict is refused, so PM must take over. */
  reviewDirty(task: LedgerTask, ref: SessionRef): Promise<string | null>;
  notifyPm(task: LedgerTask, text: string): Promise<void>;
  now(): number;
  /** Effective lend.json borrow list (i28-R9); absent = this service never pools. Read once per pass. */
  borrow?(): Promise<BorrowEntry[]>;
}

interface CardOutcome { taskId: string; step: string; detail: string }
export interface AutoTickResult { cards: CardOutcome[]; failed: { taskId: string; error: string }[] }

const UNDELIVERED_BACKOFF_MS = 30_000, UNDELIVERED_BACKOFF_CAP_MS = 600_000;
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 560);
/** A lost notice is logged (the ledger holds the durable record), but a stop / lost lease still ends the pass. */
const noticeLost = (what: string) => (e: unknown): void => {
  if (e instanceof SchedulerStopped) throw e;
  console.error(`⚠️ [scheduler] ${what}：${(e as Error).message}`);
};
/** 未领单报警没送到 PM 时多久重发一次；上次失败时间只放内存（按库分开），重启后立刻再试一次，无妨 */
const UNCLAIMED_RETRY_MS = 60_000;
const alarmFailedAt = new WeakMap<Database, Map<string, number>>();
const roleOfIntent = (i: Pick<SchedulerIntent, "action" | "node">): SessionRole =>
  i.action === "review" || i.node === "adversarial_review" ? "reviewer" : "author";

export function boundRef(db: Database, taskId: string, role: SessionRole): SessionRef | null {
  const s = getSchedulerSession(db, taskId, role);
  return s && s.state === "active" ? { taskId, role, agent: s.agent, sessionId: s.sessionId, family: s.family, transport: s.transport } : null;
}

class Card {
  constructor(readonly db: Database, readonly task: LedgerTask, readonly opts: SnapshotOpts, readonly deps: AutoTickDeps) {}

  out(step: string, detail: string): CardOutcome { return { taskId: this.task.id, step, detail: oneLine(detail) }; }

  async settle(id: string, from: IntentStatus, to: IntentStatus, receipt: string): Promise<boolean> {
    return (await this.deps.manager("ledger", "scheduler-settle", id, "--from", from, "--to", to, "--receipt", oneLine(receipt))).ok === true;
  }

  /** Give the card to PM with the reason on the ledger; the PM notice goes out once, on the first (non-replayed) write. */
  async escalate(reason: string, intentId?: string): Promise<CardOutcome> {
    const r = await this.deps.manager("ledger", "scheduler-fallback-manual", this.task.id, "--reason", oneLine(reason), ...(intentId ? ["--intent", intentId] : []));
    if (r.ok !== true) return this.out("held", `退回人工失败：${String(r.error)}`);
    if (r.duplicate !== true) {
      await this.deps.notifyPm(this.task, `[调度引擎] ${this.task.id} 退回人工，请接手：${oneLine(reason)}`)
        .catch(noticeLost("通知 PM 失败（台账已记退回人工）"));
    }
    return this.out("manual", reason);
  }

  async cancelStale(intent: SchedulerIntent, why: string): Promise<CardOutcome> {
    const ok = await this.settle(intent.id, "pending", "cancelled", `未执行：${why}`);
    return this.out(ok ? "replan" : "lost_race", why);
  }

  async plan(plan: Planned): Promise<SchedulerIntent | string> {
    const workflow = getWorkflow(this.db, this.task.id);
    const seq = (this.db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = ?").get(this.task.project) as { seq: number }).seq;
    const r = await this.deps.manager("ledger", "scheduler-plan", this.task.id, "--id", plan.id, "--rev", String(this.task.rev),
      "--workflow-rev", String(workflow?.rev ?? 0), "--seq", String(seq), "--node", plan.node, "--action", plan.action, "--reason", plan.reason,
      ...(plan.recipient ? ["--recipient", plan.recipient] : []), ...(plan.resources.length ? ["--resources", plan.resources.join(",")] : []));
    return r.ok === true ? r.intent as SchedulerIntent : `计划没写进台账：${String(r.error)}`;
  }

  async ensure(intent: SchedulerIntent, plan: Planned | null): Promise<CardOutcome> {
    const role = roleOfIntent(intent);
    if (intent.status === "submitted") {
      if (getSchedulerSession(this.db, this.task.id, role)?.createIntentId === intent.id) {
        return this.out((await this.settle(intent.id, "submitted", "done", `已绑定 ${role} session`)) ? "session" : "lost_race", `${role} session 已入账`);
      }
      if (this.deps.now() - intent.updatedAt < CLAIM_LEASE_MS) return this.out("held", "建 session 已认领，租约未到期");
      await this.settle(intent.id, "submitted", "unknown", "已认领建 session，但台账没有绑定；不重建，交 PM 核对");
      return this.out("held", "建 session 结果不明，交 PM");
    }
    const family = plan?.sessionFamily;
    if (!family) return this.cancelStale(intent, "计划里没有 session 家族");
    if (!(await this.settle(intent.id, "pending", "submitted", `claimed; ensure ${role} ${family}`))) return this.out("lost_race", "认领失败");
    const got = await this.deps.ensure(this.task, role, family);
    if (got.kind === "unknown") {
      await this.settle(intent.id, "submitted", "unknown", `建 session 结果不明：${got.reason}`);
      return this.out("held", got.reason);
    }
    if (got.kind === "manual") {
      await this.settle(intent.id, "submitted", "cancelled", `未建：${got.reason}`);
      return this.escalate(`${role} session：${got.reason}`, intent.id);
    }
    const ref = got.ref;
    const b = await this.deps.manager("ledger", "scheduler-session-bind", this.task.id, "--role", role, "--intent", intent.id,
      "--agent", ref.agent, "--session", ref.sessionId, "--family", ref.family, "--transport", ref.transport);
    if (b.ok !== true) {
      await this.settle(intent.id, "submitted", "unknown", `${ref.agent} 已${got.created ? "建" : "找到"}，但台账绑不上：${String(b.error)}`);
      return this.out("held", `绑定失败：${String(b.error)}`);
    }
    await this.settle(intent.id, "submitted", "done", `bound ${ref.agent}/${ref.sessionId}`);
    return this.out("session", `${role} = ${ref.agent}`);
  }

  ops(): SchedulerLedgerOps {
    return {
      intent: (id) => getIntent(this.db, id),
      current: (taskId, role) => {
        const t = getTask(this.db, taskId);
        return t ? { specRev: t.specRev, head: t.headSHA, round: t.round, bound: boundRef(this.db, taskId, role) } : null;
      },
      settle: (id, from, to, receipt) => this.settle(id, from, to, receipt),
      taken: (id) => orderTakenSeq(this.db, id),
      now: () => this.deps.now(),
    };
  }

  async work(intent: SchedulerIntent, plan: Planned | null): Promise<CardOutcome> {
    const ref = boundRef(this.db, this.task.id, roleOfIntent(intent));
    if (!ref) return intent.status === "pending" ? this.cancelStale(intent, "台账里没有绑定的 session") : this.out("held", "认领的派单找不到绑定的 session");
    const w = this.deps.worker(ref);
    if ("manual" in w) {
      if (intent.status === "pending") await this.settle(intent.id, "pending", "cancelled", `未投递：${w.manual}`);
      return this.escalate(w.manual, intent.id);
    }
    let checkout: string | undefined;
    if (ref.role === "reviewer" && intent.status === "pending") {
      const pinned = await this.deps.pinReview(this.task, ref, intent.head);
      if ("manual" in pinned) {
        await this.settle(intent.id, "pending", "cancelled", `未投递：${oneLine(pinned.manual)}`);
        return this.escalate(pinned.manual, intent.id);
      }
      checkout = pinned.dir;
    }
    const order = workOrderFor(this.task, intent, plan, ref, checkout);
    if (!order) return this.out("held", `节点 ${intent.node} 没有任务单`);
    let delivery = deliveryFor(w.route, order.step);
    const unpullable = delivery.mode === "wake" ? unpullableReason(this.db, ref, intent) : null;
    if (unpullable) delivery = { mode: "text", reason: `领单工具拿不到这张单（${oneLine(unpullable)}），改发全文` };
    return this.fromDrive(await driveDispatch(this.ops(), w, ref, { ...order, delivery }));
  }

  fromDrive(r: DriveOutcome): CardOutcome {
    if (r.kind === "sent") return this.out("sent", `${r.receipt.route}${r.receipt.fallbackReason ? `（${r.receipt.fallbackReason}）` : ""}`);
    if (r.kind === "settled") return this.out("settled", r.status);
    if (r.kind === "replan") return this.out("replan", r.reason);
    return this.out(r.kind === "lost_race" ? "lost_race" : "held", r.kind === "held" ? r.reason : "");
  }

  async internal(intent: SchedulerIntent, plan: Planned | null): Promise<CardOutcome> {
    if (intent.status !== "pending") return this.out("held", `${intent.action} 意图停在 ${intent.status}`);
    const cmd = intent.action === "stage" ? ["scheduler-stage", intent.id, "--to", plan?.targetStage ?? ""] : ["scheduler-ui-ask", intent.id];
    if (intent.action === "stage" && !plan?.targetStage) return this.cancelStale(intent, "计划里没有目标阶段");
    const shots = intent.action === "ask" ? screenshotRefs(this.task) : null;
    if (shots && "missing" in shots) {
      await this.settle(intent.id, "pending", "cancelled", `未开 ask：${shots.missing}`);
      return this.escalate(shots.missing, intent.id);
    }
    const r = await this.deps.manager("ledger", ...cmd, "--max-workers", String(this.opts.maxWorkers));
    if (r.ok === true && r.duplicate !== true && plan?.pmDiffNotice) await this.diffNotice();
    if (r.ok === true) return this.out(intent.action, intent.action === "stage" ? `${this.task.stage}→${plan?.targetStage}` : `ask ${String(r.askId)}`);
    return r.code === "conflict" ? this.cancelStale(intent, String(r.error)) : this.out("held", String(r.error));
  }

  async drive(intent: SchedulerIntent, plan: Planned | null): Promise<CardOutcome> {
    if (isPoolIntent(intent)) {
      const r = await drivePool({ manager: this.deps.manager, notifyPm: this.deps.notifyPm, lost: noticeLost }, this.task, intent,
        this.opts.maxWorkers, this.opts.pool?.remote);
      return this.out(r.step, r.detail);
    }
    if (intent.action === "ensure_session") return this.ensure(intent, plan);
    if (intent.action === "dispatch" || intent.action === "review") return this.work(intent, plan);
    if (intent.action === "stage" || intent.action === "ask") return this.internal(intent, plan);
    if (intent.action === "merge") return this.out("merge_queue", "合并意图交合并队列");
    return this.out("held", `意图 ${intent.action} 不由本服务执行`);
  }

  /** P2 findings do not block the merge, but PM reads the diff: best-effort, the stage event itself is the durable record. */
  async diffNotice(): Promise<void> {
    const rv = listEvents(this.db, { project: this.task.project, target: this.task.id }).findLast((e) => e.kind === "review");
    const text = `[调度引擎] ${this.task.id} 审查通过但留有 P2，已进合并队列，请看 diff：head ${String(rv?.data.head ?? this.task.headSHA)}` +
      `，报告 ${String(rv?.data.path ?? "（无）")}`;
    await this.deps.notifyPm(this.task, text).catch(noticeLost("P2 看 diff 通知没发出去"));
  }

  /** A screenshot ask that expired or was withdrawn can never be answered; waiting on it would be forever. */
  uiAskDead(): SchedulerIntent | null {
    const sent = this.db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND action = 'ask' AND status = 'done'
      ORDER BY eventSeq DESC LIMIT 1`).get(this.task.id) as SchedulerIntent | null;
    return sent && deadUiAsk(this.db, sent.id, this.deps.now()) ? sent : null;
  }

  /** A sent order is only a receipt: watch its session for a quota / auth failure, which is PM's call, never a resend. */
  async watch(wait: Extract<PlannerDecision, { kind: "wait" }>): Promise<CardOutcome> {
    const deadAsk = wait.code === "owner_screenshot" ? this.uiAskDead() : null;
    if (deadAsk) return this.escalate("截图 ask 已过期或被撤下，没人能再答：PM 决定重开还是接管", deadAsk.id);
    if (wait.code !== "in_flight") return this.out("waiting", wait.reason);
    const sent = (this.db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND action IN ('dispatch','review') AND status = 'done'
      ORDER BY eventSeq DESC LIMIT 1`).get(this.task.id) as SchedulerIntent | null);
    const step = sent && stepOfNode(sent.node);
    const ref = sent && boundRef(this.db, this.task.id, roleOfIntent(sent));
    if (!sent || !step || !ref) return this.out("waiting", wait.reason);
    const dirty = ref.role === "reviewer" ? await this.deps.reviewDirty(this.task, ref) : null;
    if (dirty) return this.escalate(`${ref.agent} 的审查目录有未提交改动（${dirty}）：结论会被拒，审的也不再是 commit ${sent.head ?? ""}`, sent.id);
    const w = this.deps.worker(ref);
    if ("manual" in w) return this.out("held", `${wait.reason}；${w.manual}`);
    const seen = await w.observe(ref, { round: this.task.round, step, head: sent.head, dedupKey: sent.id });
    if (seen.state === "unknown" && seen.failure) {
      return this.escalate(`${ref.agent} 报了归不到派单上的失败（${seen.failure.kind}），本单可能也没跑：${seen.failure.message}`, sent.id);
    }
    if (seen.state === "result" && seen.outcome === "failed") {
      const what = seen.failure.kind === "quota" ? "撞额度" : seen.failure.kind === "auth" ? "登录失效" : "回合失败";
      return this.escalate(`${ref.agent} ${what}：${seen.failure.message}`, sent.id);
    }
    const alarm = await this.unclaimed(sent, ref);
    if (alarm) return alarm;
    if (seen.state === "unknown") return this.out("held", `${wait.reason}；${seen.reason}`);
    return this.out("waiting", wait.reason);
  }

  /**
   * A wake line is only a nudge; the order waits in the ledger. If its recipient has not taken it after UNCLAIMED_ALARM_MS, PM
   * hears once: the alarm row (with its fixed text) is written first, the notice goes out, and only a delivered notice writes
   * unclaimed_sent. Without that row a later tick resends the same text (every UNCLAIMED_RETRY_MS), so a bridge outage or a
   * crash between the two writes delays the warning instead of swallowing it. tests/scheduler-dispatch-wake.test.ts.
   */
  async unclaimed(sent: SchedulerIntent, ref: SessionRef): Promise<CardOutcome | null> {
    if (!sentAsWake(sent.receipt) || orderTakenSeq(this.db, sent.id) !== null) return null;
    const waited = this.deps.now() - sent.updatedAt;
    if (waited < UNCLAIMED_ALARM_MS) return null;
    if (getEventByDedup(this.db, unclaimedSentKey(sent.id))) return this.out("waiting", `${ref.agent} 未领单，已报警过`);
    const failed = alarmFailedAt.get(this.db) ?? new Map<string, number>();
    alarmFailedAt.set(this.db, failed);
    const lastFail = failed.get(sent.id);
    if (lastFail !== undefined && this.deps.now() - lastFail < UNCLAIMED_RETRY_MS) return this.out("waiting", `${ref.agent} 未领单，报警待重发`);
    let text = getEventByDedup(this.db, unclaimedKey(sent.id))?.text;
    if (!text) {
      const draft = `[调度引擎] ${this.task.id} 的单 ${sent.id} 唤醒已发给 ${ref.agent} ${Math.floor(waited / 60_000)} 分钟，还没人领` +
        `（${sent.action === "review" ? "take_review" : "take_order"}）：看看会话在不在、有没有派单工具`;
      const r = await this.deps.manager("ledger", "scheduler-unclaimed", sent.id, "--text", draft);
      if (r.ok !== true) return this.out("held", `未领单报警没记上：${String(r.error)}`);
      text = typeof (r.event as { text?: unknown } | undefined)?.text === "string" ? (r.event as { text: string }).text : draft;
    }
    try {
      await this.deps.notifyPm(this.task, text);
    } catch (e) {
      noticeLost("未领单报警没发出去（台账已记，稍后重发）")(e);
      failed.set(sent.id, this.deps.now());
      return this.out("waiting", `${ref.agent} 未领单，报警没发出去，稍后重发`);
    }
    failed.delete(sent.id);
    const done = await this.deps.manager("ledger", "scheduler-unclaimed-sent", sent.id);
    if (done.ok !== true) console.error(`⚠️ [scheduler] 未领单报警已发出但送达没记上（下个 tick 可能重发一次）：${String(done.error)}`);
    return this.out("waiting", `${ref.agent} 未领单，已报警`);
  }

  /**
   * An order the transport refused (bridge down, session swapped) is safely re-planned, but not every poll: consecutive
   * refusals back off 30s → 10min, or a bridge restart would write a plan + cancel pair per card per second.
   */
  undeliveredBackoff(): string | null {
    const recent = this.db.query(`SELECT status, receipt, updatedAt FROM scheduler_intents WHERE taskId = ? AND action IN ('dispatch','review')
      ORDER BY eventSeq DESC LIMIT 6`).all(this.task.id) as Pick<SchedulerIntent, "status" | "receipt" | "updatedAt">[];
    const n = recent.findIndex((i) => i.status !== "cancelled" || !i.receipt?.startsWith("未投递"));
    const streak = n === -1 ? recent.length : n;
    if (!streak) return null;
    const left = recent[0].updatedAt + Math.min(UNDELIVERED_BACKOFF_MS * 2 ** (streak - 1), UNDELIVERED_BACKOFF_CAP_MS) - this.deps.now();
    return left > 0 ? `连续 ${streak} 次派单未投递（${oneLine(recent[0].receipt ?? "")}），${Math.ceil(left / 1000)}s 后再派` : null;
  }

  async step(): Promise<CardOutcome> {
    const open = this.db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown')
      ORDER BY eventSeq DESC LIMIT 1`).get(this.task.id) as SchedulerIntent | null;
    if (open?.status === "unknown") return this.out("held", `外部结果不明，等 PM 核对：${open.receipt ?? open.reason}`);
    if (open?.action === "merge") return this.out("merge_queue", `合并意图 ${open.status}`);
    if (open && isPoolIntent(open)) return this.drive(open, null);
    if (open?.status === "pending") {
      const again = planScheduler(autoSnapshot(this.db, this.task, this.opts, open.id));
      if (again.kind !== "intent" || again.id !== open.id) return this.cancelStale(open, "按当前台账重算，已不是这个计划");
      return this.drive(open, again);
    }
    if (open) return this.drive(open, null);
    const plan = planScheduler(autoSnapshot(this.db, this.task, this.opts));
    if (plan.kind === "escalate") return this.escalate(`${plan.code}：${plan.reason}`);
    if (plan.kind === "wait") return this.watch(plan);
    if (plan.action === "verify" || plan.action === "retire") return this.out("waiting", `${plan.node} 由合并队列 / PM 收尾`);
    const backoff = plan.action === "dispatch" || plan.action === "review" ? this.undeliveredBackoff() : null;
    if (backoff) return this.out("held", backoff);
    const intent = await this.plan(plan);
    return typeof intent === "string" ? this.out("replan", intent) : this.drive(intent, plan);
  }
}

/** One borrow read per pass, and only when some project may pool; an unreadable lend.json pools nothing (fail-closed). */
function poolReader(deps: AutoTickDeps) {
  let borrow: Promise<BorrowEntry[]> | null = null;
  return async (remote: RemotePolicy | undefined): Promise<SnapshotOpts["pool"]> => {
    if (!remote || !deps.borrow) return undefined;
    if (remote.mode === "off") return { remote, borrow: [] };
    borrow ??= deps.borrow().catch((e: unknown) => { console.error(`⚠️ [scheduler] 读 lend.json 借入名单失败，本轮不挂池：${(e as Error).message}`); return []; });
    return { remote, borrow: await borrow };
  };
}

export async function schedulerAutoTick(db: Database, projects: Record<string, { maxActiveWorkers: number; remote?: RemotePolicy }>, deps: AutoTickDeps,
  pace?: TickPace): Promise<AutoTickResult> {
  const out: AutoTickResult = { cards: [], failed: [] };
  const poolOf = poolReader(deps);
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_workflows'").get()) return out;
  for (const { project, policy, taskId } of paceCards(db, projects, "auto", pace)) {
    if (pace?.yieldNow()) break;
    if (pace) pace.cursor.auto = `${project}/${taskId}`;
    const task = getTask(db, taskId);
    if (!task) continue;
    try {
      const pool = await poolOf(policy.remote);
      out.cards.push(await new Card(db, task, { registry: [], maxWorkers: policy.maxActiveWorkers, now: deps.now(), pool }, deps).step());
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      out.failed.push({ taskId, error: oneLine((e as Error).message) });
    }
  }
  return out;
}
