/**
 * actionState 的事实收集（agents-ACTIONSTATE1）：每个项目快照把 ask / 出借订单 / 写租约 / 调度意图 / 合并运行 / 会话各批量查一次，
 * 建成按卡号索引的 ActionCtx，再按卡调纯函数 actionState（action-state.ts）。总览、详情、完成分页、工作行都走这里同一入口，
 * 同一张卡在同一时刻得到同一个结果。只读：只有 SELECT，不写库、不发事件；表不存在（老库）当没有这类事实。
 * - 心跳只认既有判定：claimed 单租约过期（leaseUntil < now，ledger-lend.ts 收租约同一口径）= stale；单子是 unknown（租约过期 / 对方报停交 PM）
 *   = disconnected；没有在途单 = 没有心跳记录（null），不凭缺字段判断联。
 * - CI 反复失败只认当前 head（最近一次合并运行审过的 head）上最近连续的 ci_fail 退回；旧 head、取消、别的结论都打断连续。
 * - placement / instance：出借单的 peer + worker、写租约、调度会话、跨实例委托、本机 agent，按这个先后取；peer 昵称不当实例号。
 * tests/ledger-action-state*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { actionState, type ActionAsk, type ActionCi, type ActionInput, type ActionPlacement, type ActionState } from "./action-state.js";
import { isAskForAudience } from "./ask-audience.js";
import { CARD_PAUSE_OP, CARD_RESUME_OP, cardPauseMode } from "./card-pause.js";
import { attentionCtx, withAttentionFacts, type AttentionCtx } from "./ledger-attention-facts.js";
import { depViews } from "./ledger-deps.js";
import { taskView, type TaskView } from "./ledger-read-cards.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { listDeps } from "./ledger-store.js";
import { parseBounceReceipt } from "./scheduler-merge-conflict.js";

interface OrderFact { peer: string; family: string; status: string; worker: string | null; leaseUntil: number | null; beatAt: number | null; updatedAt: number }
interface MergeFact { intentId: string; phase: string; reviewedHead: string; reason: string | null; updatedAt: number }
interface SessionFact { role: string; sessionId: string; family: string | null; transport: string }
interface IntentFact { id: string; taskId: string; node: string | null; action: string | null; status: string }

export interface ActionCtx {
  now: number;
  asks: ReadonlyMap<string, ActionAsk[]>;
  orders: ReadonlyMap<string, OrderFact>;
  leases: ReadonlyMap<string, string>;
  /** 每张卡最近一条调度意图 / 最近一条 merge 意图 id */
  latestIntent: ReadonlyMap<string, IntentFact>;
  latestMerge: ReadonlyMap<string, string>;
  merges: ReadonlyMap<string, MergeFact[]>;
  sessions: ReadonlyMap<string, SessionFact[]>;
  canPause: boolean;
}

const hasTable = (db: Database, name: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const cols = (db: Database, table: string): Set<string> => new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
const select = <T>(db: Database, table: string, sql: string, ...args: (string | number)[]): T[] =>
  hasTable(db, table) ? (db.query(sql).all(...args) as T[]) : [];

function group<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(key(r));
    if (list) list.push(r);
    else out.set(key(r), [r]);
  }
  return out;
}

function parseExtra(raw: unknown): { mechanism?: unknown; pm?: unknown } | null {
  try { return typeof raw === "string" ? JSON.parse(raw) as { mechanism?: unknown; pm?: unknown } : null; }
  catch { return null; } // 坏 extra 只影响 priorityStall 收件人判定：按没写处理（归 owner，与 ask-audience 一致）
}

function askFacts(db: Database, project: string): Map<string, ActionAsk[]> {
  if (!hasTable(db, "asks")) return new Map();
  const assignee = cols(db, "asks").has("assignee") ? "assignee" : "NULL AS assignee";
  const rows = db.query(`SELECT id, taskId, kind, source, state, expiresAt, createdAt, ${assignee}, extra FROM asks
    WHERE project = ? AND taskId IS NOT NULL AND state = 'open' ORDER BY createdAt, id`).all(project) as
    { id: string; taskId: string; kind: string; source: string; state: string; expiresAt: number; createdAt: number; assignee: string | null; extra: string }[];
  const facts = rows.map((r) => ({ taskId: r.taskId, ask: { id: r.id, kind: r.kind, source: r.source, state: r.state, expiresAt: r.expiresAt, createdAt: r.createdAt,
    forOwner: r.assignee === "owner" || isAskForAudience({ assignee: r.assignee, extra: parseExtra(r.extra) }) } }));
  return new Map([...group(facts, (f) => f.taskId)].map(([k, v]) => [k, v.map((f) => f.ask)]));
}

function orderFacts(db: Database, project: string): Map<string, OrderFact> {
  if (!hasTable(db, "lend_orders")) return new Map();
  const beat = cols(db, "lend_orders").has("beatAt") ? "beatAt" : "NULL AS beatAt";
  const rows = db.query(`SELECT taskId, peer, family, status, worker, leaseUntil, ${beat}, updatedAt FROM lend_orders
    WHERE project = ? AND status IN ('pooled','claimed','unknown') ORDER BY updatedAt, orderId`).all(project) as (OrderFact & { taskId: string })[];
  return new Map(rows.map(({ taskId, ...o }) => [taskId, o]));
}

function intentFacts(db: Database, project: string): Pick<ActionCtx, "latestIntent" | "latestMerge"> {
  const rows = select<IntentFact>(db, "scheduler_intents", `SELECT id, taskId, node, action, status FROM scheduler_intents
    WHERE project = ? ORDER BY eventSeq, createdAt, id`, project);
  const latestIntent = new Map<string, IntentFact>(), latestMerge = new Map<string, string>();
  for (const r of rows) {
    latestIntent.set(r.taskId, r);
    if (r.action === "merge") latestMerge.set(r.taskId, r.id);
  }
  return { latestIntent, latestMerge };
}

/** 一个项目快照建一次；canPause 缺省读现有暂停开关（只读策略文件），测试可注入 */
export function actionCtx(db: Database, project: string, now: number, canPause?: boolean): ActionCtx {
  const merges = select<MergeFact & { taskId: string }>(db, "scheduler_merges", `SELECT intentId, taskId, phase, reviewedHead, reason, updatedAt
    FROM scheduler_merges WHERE project = ? ORDER BY createdAt, intentId`, project);
  const sessions = select<SessionFact & { taskId: string }>(db, "scheduler_sessions", `SELECT taskId, role, sessionId, family, transport FROM scheduler_sessions
    WHERE state != 'retired' AND taskId IN (SELECT id FROM tasks WHERE project = ?) ORDER BY taskId, role`, project);
  const leases = select<{ taskId: string; peer: string }>(db, "lend_write_leases", "SELECT taskId, peer FROM lend_write_leases WHERE project = ? AND state = 'held'", project);
  return {
    now, asks: askFacts(db, project), orders: orderFacts(db, project), leases: new Map(leases.map((l) => [l.taskId, l.peer])), ...intentFacts(db, project),
    merges: group(merges, (m) => m.taskId), sessions: group(sessions, (s) => s.taskId), canPause: canPause ?? safeMode(project),
  };
}

function safeMode(project: string): boolean {
  try { return cardPauseMode(project) === "on"; }
  catch { return false; } // 策略读不了：不合成暂停动作（没有可用通道就不给）
}

const sameSha = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const OPEN_PHASES = new Set(["ready", "updating", "await_review", "await_ci", "merging", "unknown"]);

/** 当前合并运行的 CI 事实：head = 最近一次运行审过的 head；从最近往前数这个 head 上连续的 ci_fail 退回，进行中的那次跳过 */
function ciOf(runs: readonly MergeFact[] | undefined, latestId: string | undefined): ActionCi | null {
  if (!runs?.length) return null;
  const latest = runs.find((r) => r.intentId === latestId) ?? runs.at(-1)!;
  let streak = 0;
  let open = true;
  for (const r of [...runs].reverse()) {
    if (open && OPEN_PHASES.has(r.phase)) continue;
    open = false;
    const b = r.phase === "resolved" && r.reason ? parseBounceReceipt(r.reason) : null;
    if (b?.cause !== "ci_fail" || !sameSha(b.prHead, latest.reviewedHead)) break;
    streak++;
  }
  return { phase: latest.phase, head: latest.reviewedHead, failStreak: streak, since: latest.updatedAt };
}

function heartbeatOf(o: OrderFact | undefined, now: number): ActionInput["heartbeat"] {
  if (o?.status === "unknown") return { state: "disconnected", at: o.updatedAt };
  if (o?.status !== "claimed" || o.leaseUntil === null) return null;
  return { state: o.leaseUntil < now ? "stale" : "live", at: o.beatAt ?? o.updatedAt };
}

function placementOf(v: TaskView, ctx: ActionCtx, session: SessionFact | undefined): { placement: ActionPlacement | null; instance: string | null } {
  const o = ctx.orders.get(v.id), lease = ctx.leases.get(v.id), delegate = typeof v.extra?.delegate === "string" ? v.extra.delegate : "";
  if (o?.status === "claimed") return { placement: { where: "peer", peer: o.peer, family: o.family }, instance: o.worker };
  if (lease) return { placement: { where: "peer", peer: lease, family: null }, instance: null };
  if (session) return { placement: { where: session.transport === "peer" ? "peer" : "local", peer: null, family: session.family }, instance: session.sessionId };
  if (!v.agent && delegate) return { placement: { where: "peer", peer: delegate.split("@")[1] || null, family: null }, instance: null };
  return { placement: v.agent ? { where: "local", peer: null, family: null } : null, instance: null };
}

const pausedOf = (own: readonly LedgerEvent[]): boolean =>
  own.findLast((e) => e.kind === "decision" && (e.data.op === CARD_PAUSE_OP || e.data.op === CARD_RESUME_OP))?.data.op === CARD_PAUSE_OP;

/** 一张卡的输入：v 是带 attentionFacts 的任务视图，own 是这张卡自己的事件 */
function taskActionInput(v: TaskView, own: readonly LedgerEvent[], ctx: ActionCtx): ActionInput {
  const intent = ctx.latestIntent.get(v.id);
  const session = ctx.sessions.get(v.id)?.find((s) => s.role === (v.stage === "review" ? "reviewer" : "author"));
  const ci = ciOf(ctx.merges.get(v.id), ctx.latestMerge.get(v.id));
  const latestMerge = ctx.merges.get(v.id)?.find((m) => m.intentId === ctx.latestMerge.get(v.id));
  const e = v.lastEvent;
  return {
    now: ctx.now, taskId: v.id, stage: v.stage, stageSince: v.stageSince, stageSinceApprox: v.stageSinceApprox,
    restating: v.stage === "spec" && intent?.node === "restate" && ["submitted", "done"].includes(intent.status),
    asks: ctx.asks.get(v.id) ?? [], mergePhase: latestMerge?.phase ?? null, ci, heartbeat: heartbeatOf(ctx.orders.get(v.id), ctx.now),
    ...placementOf(v, ctx, session), frozen: v.attentionFacts?.frozen === true, observationUntil: v.attentionFacts?.observationUntil ?? null,
    blockedBy: v.blockedBy, specReady: !!v.spec, paused: pausedOf(own), delegated: !v.agent && typeof v.extra?.delegate === "string" && !!v.extra.delegate,
    lastEvent: e ? { kind: e.kind, ts: e.ts, result: e.data.result } : null, canPause: ctx.canPause,
  };
}

const taskActionState = (v: TaskView, own: readonly LedgerEvent[], ctx: ActionCtx): ActionState => actionState(taskActionInput(v, own, ctx));

/** 总览 / 详情 / 完成分页的统一挂法：在 withAttentionFacts 之后调 */
export function withActionState<T extends TaskView>(v: T, own: readonly LedgerEvent[], ctx: ActionCtx): T & { actionState: ActionState } {
  return { ...v, actionState: taskActionState(v, own, ctx) };
}

/** 没建卡的 DAG 待做行：只有节点依赖和规格就绪两条事实，不伪造卡号 */
export function untaskedActionState(blocked: readonly string[], specReady: boolean, now: number): ActionState {
  return actionState({
    now, taskId: null, stage: null, restating: false, stageSince: null, stageSinceApprox: false, asks: [], mergePhase: null, ci: null, heartbeat: null,
    placement: null, instance: null, frozen: false, observationUntil: null, blockedBy: blocked, specReady, paused: false, delegated: false,
    lastEvent: null, canPause: false,
  });
}

interface BoardRows {
  working: { taskId: string | null; actionState?: ActionState }[];
  waiting: { taskId: string | null; actionState?: ActionState }[];
  todo: { ready: { taskId: string | null; actionState?: ActionState }[]; blocked: { taskId: string | null; actionState?: ActionState }[] };
  legacy: { taskId: string; actionState?: ActionState }[];
}

/**
 * 工作看板的有卡行（working / waiting / todo / legacy）挂 actionState：与总览同一条路——taskView + withAttentionFacts + 同一个 ActionCtx。
 * 只给已有行加字段，不增删行、不改次序；依赖边只查一次。
 */
export function attachBoardActionStates(board: BoardRows, db: Database, project: string, tasks: ReadonlyMap<string, LedgerTask>,
  events: ReadonlyMap<string, LedgerEvent[]>, now: number, facts?: AttentionCtx, canPause?: boolean): void {
  const ctx = actionCtx(db, project, now, canPause);
  const attention = facts ?? attentionCtx(project);
  const deps = depViews(listDeps(db, project), [...tasks.values()]);
  for (const row of [...board.working, ...board.waiting, ...board.todo.ready, ...board.todo.blocked, ...board.legacy]) {
    const task = row.taskId ? tasks.get(row.taskId) : undefined;
    if (!task) continue;
    const own = events.get(task.id) ?? [];
    row.actionState = taskActionState(withAttentionFacts(taskView(task, own, now, deps), own, attention), own, ctx);
  }
}
