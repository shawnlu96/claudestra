/** Compact, read-only work projection. The caller owns the deferred transaction and supplies machine policy. */
import type { RegistryAgent } from './registry.js';
import { workBoardRegistry, workBoardWorkerAlive } from './ledger-work-board-registry.js';
import type { Database } from 'bun:sqlite';
import { boardContext, featureCard, hasFeatureSchema, type BoardCtx, type BoardNode } from './ledger-dag-board.js';
import type { Feature } from './ledger-feature.js';
import { autoSnapshot } from './scheduler-auto-snapshot.js';
import { cardNames } from './ledger-card-names.js';
import { planScheduler } from './scheduler-plan.js';
import type { SnapshotOpts } from './scheduler-snapshot.js';
import { taskWorkerRefs } from './scheduler-sessions.js';
import { phaseSince } from './lend-pr-takeover.js';
import { listDeps } from './ledger-store.js';
import { stepAtStage } from './ledger-steps.js';
import type { LedgerTask } from './ledger-stages.js';
import { completionHours, estimateMinutes, normalMinutes, remainingMinutes, stepSamples, workStep, type WorkStep } from './ledger-work-board-time.js';

interface WorkRow {
  taskId: string | null; featureId: string | null; nodeKey: string | null; title: string;
  who: string | null; machine: string; step: WorkStep | 'publishing' | null; round: number;
  since: number; normalMinutes: number; remainingMinutes: number; overMinutes: number;
  reason: string | null; code: string | null; estimate: string;
}
export interface WorkBoard {
  now: number; asOfSeq: number; working: WorkRow[]; waiting: WorkRow[]; todo: { ready: WorkRow[]; blocked: WorkRow[] };
  legacyTotal: number;
  legacy: { taskId: string; title: string; stage: string }[];
  machines: Record<string, number>; completionHours: number | null; availableSlots: number;
}
interface Order { orderId: string; taskId: string; peer: string; family: string; step: string; status: string; createdAt: number; updatedAt: number; beat: string | null }
interface Ask { taskId: string; assignee: string | null; kind: string; createdAt: number; title: string }
interface Merge { intentId: string; taskId: string; phase: string; createdAt: number; updatedAt: number; reason: string | null }
interface NodeRef { featureId: string; node: BoardNode }
export interface WorkBoardOptions extends SnapshotOpts { availableSlots?: number; manualRegistry?: readonly RegistryAgent[]; specReady?: (taskId: string) => boolean }
function rows<T>(db: Database, table: string, project: string, where = ''): T[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
  return db.query(`SELECT * FROM ${table} WHERE project=? ${where}`).all(project) as T[];
}
function orderWork(ctx: BoardCtx, order: Order, now: number): { step: WorkRow['step']; since: number } {
  if (order.beat) {
    const beat = JSON.parse(order.beat) as { phase?: string };
    if (beat.phase === 'publishing') return { step: 'publishing', since: phaseSince(order.beat, 'publishing', now) };
  }
  const claimed = ctx.events.get(order.taskId)?.findLast(e => {
    const lend = e.data.lend as { op?: string; orderId?: string } | undefined;
    return e.kind === 'note' && lend?.op === 'claim' && lend.orderId === order.orderId;
  });
  const beat = order.beat ? JSON.parse(order.beat) as { since?: number; at?: number } : null;
  return { step: order.step === 'write' ? 'write' : order.step === 'fix' ? 'fix' : 'review',
    since: claimed?.ts ?? beat?.since ?? beat?.at ?? now };
}
function baseRow(ctx: BoardCtx, task: LedgerTask | null, ref: NodeRef | undefined): WorkRow {
  const node = ref?.node, view = task && ctx.sched.get(task.id);
  const session = task ? taskWorkerRefs(ctx.db, task.id) : null;
  const assigned = task ? stepAtStage(ctx.steps.get(task.id) ?? [], task)?.executor : null;
  const since = task ? ctx.events.get(task.id)?.findLast(e => e.kind === 'stage')?.ts ?? task.createdAt : ctx.now;
  return { taskId: task?.id ?? null, featureId: ref?.featureId ?? null, nodeKey: node?.key ?? null,
    title: (task?.title ?? node?.oneLine ?? '').slice(0, 180),
    who: (task?.stage === 'review' ? session?.reviewer?.agent : session?.author?.agent) ?? assigned ?? view?.handler?.agent ?? task?.agent ?? null,
    machine: 'local',
    step: task ? workStep(task.stage) : null, round: task?.round ?? 0, since, normalMinutes: 0, remainingMinutes: 0,
    overMinutes: 0, reason: null, code: null, estimate: node?.estimate ?? '' };
}
function waiting(ctx: BoardCtx, task: LedgerTask, row: WorkRow, opts: WorkBoardOptions,
  order: Order | undefined, ask: Ask | undefined, merge: Merge | undefined, merges: Merge[]): boolean {
  const view = ctx.sched.get(task.id)!;
  const intent = view.latestIntent;
  const own = ctx.events.get(task.id) ?? [];
  const fallback = own.findLast(e => e.kind === 'scheduler' && e.data.op === 'fallback_manual');
  const manualReason = String(fallback?.data.reason ?? view.waitReason ?? intent?.reason ?? 'PM 人工推进');
  const set = (code: string, reason: string, since = row.since) => {
    row.code = code; row.reason = reason.slice(0, 260); row.since = since; return true;
  };
  if (ask) return set('ask', ask.kind === 'owner_action' || !ask.assignee || ask.assignee === 'owner' ? '等 owner' :
    `等${ask.assignee === task.pm ? ' PM' : '执行者'}答复：${ask.title}`, ask.createdAt);
  if (intent?.status === 'unknown' || order?.status === 'unknown') return set('unknown_effect', '外部结果不明', intent?.updatedAt ?? order!.updatedAt);
  if (order?.status === 'pooled') return set('pooled', order.step === 'review' ? '等审查员领单' : '等执行者领单', order.createdAt);
  if (merge?.phase === 'await_ci') return set('ci', '等 CI', merge.updatedAt);
  if (task.stage === 'merge' && !merge) {
    const ahead = merges.filter(m => !['merged', 'resolved'].includes(m.phase) && m.taskId !== task.id).sort((a, b) => a.createdAt - b.createdAt);
    if (ahead.length) return set('merge_queue', `合并排队：前面是 ${ahead.map(m => m.taskId).join('、')}`);
  }
  if (order?.status === 'claimed') return false;
  if (view.workflow?.mode === 'manual') {
    if (task.stage === 'review') return set('reviewer', '等审查员领单');
    const alive = opts.manualRegistry?.some(a => a.name === task.agent && workBoardWorkerAlive(a));
    const writing = ['restate', 'build', 'fix'].includes(task.stage) || row.step === 'restate';
    if (alive && writing) { row.who = task.agent; return false; }
    if (fallback && !alive) return set(/额度|quota/.test(manualReason) ? 'quota' : 'manual',
      /额度|quota/.test(manualReason) ? `额度到线暂停：${manualReason}` : `退回人工（manual）：${manualReason}`, fallback.ts);
    if (writing) return set('executor_missing', '执行者不在了');
  }
  if (view.workflow?.mode === 'auto') {
    const decision = planScheduler(autoSnapshot(ctx.db, task, opts));
    if (decision.kind === 'escalate') return set(decision.code,
      fallback && !opts.manualRegistry?.some(a => a.name === task.agent && workBoardWorkerAlive(a)) ?
        `退回人工（${decision.code}）：${decision.reason}` : `等 PM：${decision.reason}`);
    if (decision.kind === 'wait' && !['in_flight', 'intent_in_flight', 'terminal'].includes(decision.code)) {
      return set(decision.code, decision.code === 'capacity' ? '本机名额满' : decision.code === 'resource_busy' ? `文件锁：${decision.reason}` : decision.reason);
    }
  }
  if (view.waitReason && intent?.status !== 'submitted') return set('scheduler', view.waitReason, intent?.createdAt);
  if (view.handler?.role === 'owner') return set('owner', '等 owner', view.handler.since);
  if (task.stage === 'blocked') return set('blocked', '等 PM 解除阻塞');
  if (task.stage === 'review' && view.handler?.role !== 'reviewer') return set('reviewer', '等审查员领单', view.handler?.since);
  return false;
}
/** No writes, no dispatch, and no peer credential reads: all scheduler decisions are pure plans. */
export function workBoard(db: Database, project: string, now: number, opts: WorkBoardOptions): WorkBoard {
  opts = { ...opts, manualRegistry: opts.manualRegistry ?? workBoardRegistry() };
  const ctx = boardContext(db, project, now);
  const activeFeatures = hasFeatureSchema(db) ? rows<Feature>(db, 'features', project).filter(f => f.status === 'active') : [];
  const features = activeFeatures.map(f => featureCard(ctx, f));
  const refs: NodeRef[] = features.flatMap(f => f.nodes.map(node => ({ featureId: f.id, node })));
  const byTask = new Map(refs.filter(r => r.node.taskId).map(r => [r.node.taskId!, r]));
  const orders = rows<Order>(db, 'lend_orders', project, "AND status IN ('pooled','claimed','unknown')");
  const asks = rows<Ask>(db, 'asks', project, `AND state='open' AND blocking=1 AND expiresAt>${now}`);
  const merges = rows<Merge>(db, 'scheduler_merges', project);
  const samples = stepSamples(ctx.events, now);
  const board: WorkBoard = { now, asOfSeq: ctx.asOfSeq, working: [], waiting: [], legacy: [], legacyTotal: 0, todo: { ready: [], blocked: [] }, machines: {},
    completionHours: null, availableSlots: opts.availableSlots ?? opts.maxWorkers };
  for (const task of ctx.tasks.values()) {
    if (!ctx.sched.get(task.id)?.workflow && !['verified', 'done', 'cancelled'].includes(task.stage)) {
      board.legacy.push({ taskId: task.id, title: task.title.slice(0, 180), stage: task.stage }); continue;
    }
    const latest = ctx.sched.get(task.id)?.latestIntent;
    const restating = task.stage === 'spec' && latest?.node === 'restate' && ['submitted', 'done'].includes(latest.status);
    if (['verified', 'done', 'cancelled'].includes(task.stage) || (task.stage === 'spec' && !restating)) continue;
    const row = baseRow(ctx, task, byTask.get(task.id));
    if (restating) { row.step = 'restate'; row.since = latest!.createdAt; }
    const order = orders.find(o => o.taskId === task.id && (task.stage !== 'review' || o.step === 'review'));
    const mergeIntent = ctx.db.query("SELECT id FROM scheduler_intents WHERE taskId=? AND action='merge' ORDER BY eventSeq DESC, createdAt DESC, id DESC LIMIT 1")
      .get(task.id) as { id: string } | null;
    const merge = mergeIntent ? merges.find(m => m.intentId === mergeIntent.id) : undefined;
    if (order?.status === 'claimed') {
      row.who = `peer:${order.peer} · ${order.family}`; row.machine = order.peer;
      const work = orderWork(ctx, order, now); row.step = work.step; row.since = work.since;
    }
    if (merge?.phase === 'merged') { row.step = 'deploy'; row.since = merge.updatedAt; }
    const step = row.step === 'publishing' ? 'write' : row.step;
    if (step) {
      const elapsed = Math.max(0, now - row.since) / 60000;
      row.normalMinutes = normalMinutes(step, samples, row.estimate);
      row.remainingMinutes = Math.ceil(remainingMinutes(step, elapsed, samples, row.estimate, task.kind === 'code'));
      row.overMinutes = Math.max(0, Math.floor(elapsed - row.normalMinutes));
    }
    if (waiting(ctx, task, row, opts, order, asks.find(a => a.taskId === task.id), merge, merges)) board.waiting.push(row);
    else { board.working.push(row); board.machines[row.machine] = (board.machines[row.machine] ?? 0) + 1; }
  }
  const started = new Set([...board.working, ...board.waiting, ...board.legacy].map(r => r.taskId));
  for (const ref of refs.filter(r => r.node.phase === 'idle' && !started.has(r.node.taskId))) {
    const task = ref.node.taskId ? ctx.tasks.get(ref.node.taskId) ?? null : null;
    const row = baseRow(ctx, task, ref);
    const blocked = ref.node.deps.filter(key => !features.find(f => f.id === ref.featureId)?.nodes.find(n => n.key === key)?.satisfied);
    const feature = activeFeatures.find(f => f.id === ref.featureId)!;
    const specReady = task ? !!task.spec : opts.specReady?.(cardNames(db, feature, ref.node.key).taskId) ?? false;
    row.reason = [blocked.length ? `被 ${blocked.join('、')} 挡住` : '', !specReady ? '缺规格' : ''].filter(Boolean).join('；') || null;
    row.remainingMinutes = estimateMinutes(row.estimate);
    board.todo[row.reason ? 'blocked' : 'ready'].push(row);
  }
  const allRows = [...board.working, ...board.waiting, ...board.todo.ready, ...board.todo.blocked];
  const durations = new Map(allRows.map(r => [r.taskId ?? `${r.featureId}/${r.nodeKey}`, r.remainingMinutes]));
  const legacyIds = new Set(board.legacy.map(r => r.taskId));
  const graph = refs.filter(r => !r.node.taskId || !legacyIds.has(r.node.taskId)).map(r => ({ id: `${r.featureId}/${r.node.key}`, deps: r.node.deps.map(k => `${r.featureId}/${k}`),
    minutes: durations.get(r.node.taskId ?? `${r.featureId}/${r.node.key}`) ?? 0 }));
  const taskKey = (id: string) => { const ref = byTask.get(id); return ref ? `${ref.featureId}/${ref.node.key}` : id; };
  const deps = listDeps(db, project);
  const offGraph = [...board.working, ...board.waiting].filter(r => !r.featureId).map(r => ({ id: r.taskId!,
    deps: deps.filter(d => d.to === r.taskId).map(d => taskKey(d.from)), minutes: r.remainingMinutes }));
  board.completionHours = completionHours([...graph, ...offGraph], board.availableSlots);
  board.working.sort((a, b) => (now - b.since) / Math.max(1, b.normalMinutes) - (now - a.since) / Math.max(1, a.normalMinutes));
  board.legacyTotal = board.legacy.length;
  board.legacy = board.legacy.sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0).slice(0, 50);
  return board;
}
