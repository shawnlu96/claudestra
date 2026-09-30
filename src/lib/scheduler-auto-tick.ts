/**
 * One service pass over auto cards. The service only reads the ledger; every write goes through the guarded
 * `ledger scheduler-*` CLI under the scheduler identity, which re-checks inside its own transaction. Per card at most
 * one step: drive the card's open intent, else plan the next one and drive it. An unknown result, a lost race or a
 * stale plan ends the card's pass; nothing is resent under a new key unless the ledger itself says the old one is void.
 */
import type { Database } from "bun:sqlite";
import { getIntent, getWorkflow, type AuthorFamily, type IntentStatus, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask } from "./ledger-store.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import { CLAIM_LEASE_MS, driveDispatch, type DriveOutcome, type SchedulerLedgerOps } from "./scheduler-dispatch.js";
import { planScheduler, type PlannerDecision } from "./scheduler-plan.js";
import { getSchedulerSession, type SessionRole } from "./scheduler-sessions.js";
import type { SnapshotOpts } from "./scheduler-snapshot.js";
import { stepOfNode, workOrderFor } from "./scheduler-work-order.js";
import type { EnsureResult, SessionRef, WorkerSession } from "./worker-session.js";

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
  notifyPm(task: LedgerTask, text: string): Promise<void>;
  now(): number;
}

interface CardOutcome { taskId: string; step: string; detail: string }
export interface AutoTickResult { cards: CardOutcome[]; failed: { taskId: string; error: string }[] }

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 560);
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
        .catch((e) => console.error(`⚠️ [scheduler] 通知 PM 失败（台账已记退回人工）：${(e as Error).message}`));
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
    return this.fromDrive(await driveDispatch(this.ops(), w, ref, order));
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
    const r = await this.deps.manager("ledger", ...cmd, "--max-workers", String(this.opts.maxWorkers));
    if (r.ok === true) return this.out(intent.action, intent.action === "stage" ? `${this.task.stage}→${plan?.targetStage}` : `ask ${String(r.askId)}`);
    return r.code === "conflict" ? this.cancelStale(intent, String(r.error)) : this.out("held", String(r.error));
  }

  async drive(intent: SchedulerIntent, plan: Planned | null): Promise<CardOutcome> {
    if (intent.action === "ensure_session") return this.ensure(intent, plan);
    if (intent.action === "dispatch" || intent.action === "review") return this.work(intent, plan);
    if (intent.action === "stage" || intent.action === "ask") return this.internal(intent, plan);
    if (intent.action === "merge") return this.out("merge_queue", "合并意图交合并队列");
    return this.out("held", `意图 ${intent.action} 不由本服务执行`);
  }

  /** A sent order is only a receipt: watch its session for a quota / auth failure, which is PM's call, never a resend. */
  async watch(wait: Extract<PlannerDecision, { kind: "wait" }>): Promise<CardOutcome> {
    if (wait.code !== "in_flight") return this.out("waiting", wait.reason);
    const sent = (this.db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND action IN ('dispatch','review') AND status = 'done'
      ORDER BY eventSeq DESC LIMIT 1`).get(this.task.id) as SchedulerIntent | null);
    const step = sent && stepOfNode(sent.node);
    const ref = sent && boundRef(this.db, this.task.id, roleOfIntent(sent));
    if (!sent || !step || !ref) return this.out("waiting", wait.reason);
    const w = this.deps.worker(ref);
    if ("manual" in w) return this.out("waiting", wait.reason);
    const seen = await w.observe(ref, { round: this.task.round, step, head: sent.head, dedupKey: sent.id });
    if (seen.state === "result" && seen.outcome === "failed") {
      const what = seen.failure.kind === "quota" ? "撞额度" : seen.failure.kind === "auth" ? "登录失效" : "回合失败";
      return this.escalate(`${ref.agent} ${what}：${seen.failure.message}`, sent.id);
    }
    if (seen.state === "unknown") return this.out("held", `${wait.reason}；${seen.reason}`);
    return this.out("waiting", wait.reason);
  }

  async step(): Promise<CardOutcome> {
    const open = this.db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown')
      ORDER BY eventSeq DESC LIMIT 1`).get(this.task.id) as SchedulerIntent | null;
    if (open?.status === "unknown") return this.out("held", `外部结果不明，等 PM 核对：${open.receipt ?? open.reason}`);
    if (open?.action === "merge") return this.out("merge_queue", `合并意图 ${open.status}`);
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
    const intent = await this.plan(plan);
    return typeof intent === "string" ? this.out("replan", intent) : this.drive(intent, plan);
  }
}

export async function schedulerAutoTick(db: Database, projects: Record<string, { maxActiveWorkers: number }>, deps: AutoTickDeps): Promise<AutoTickResult> {
  const out: AutoTickResult = { cards: [], failed: [] };
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_workflows'").get()) return out;
  for (const [project, policy] of Object.entries(projects)) {
    const ids = db.query(`SELECT w.taskId FROM task_workflows AS w JOIN tasks AS t ON t.id = w.taskId
      WHERE w.project = ? AND w.mode = 'auto' AND t.stage NOT IN ('done','cancelled') ORDER BY w.taskId`).all(project) as { taskId: string }[];
    for (const { taskId } of ids) {
      const task = getTask(db, taskId);
      if (!task) continue;
      try {
        out.cards.push(await new Card(db, task, { registry: [], maxWorkers: policy.maxActiveWorkers, now: deps.now() }, deps).step());
      } catch (e) {
        out.failed.push({ taskId, error: oneLine((e as Error).message) });
      }
    }
  }
  return out;
}
