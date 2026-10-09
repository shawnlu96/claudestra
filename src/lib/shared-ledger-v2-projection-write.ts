/**
 * S2P dedicated projection writer: the only module that writes as PROJECTION_ACTOR. It lands a center feature view on the home
 * ledger verbatim (stage / round / head straight from the center, no stage machine: the center already checked roles), the same
 * way the replica writer does (own tx + direct SQL + insertEvent). It never calls ledger-write and never imports applyMove.
 * Retention (§2.2「投影写入」): no intent row is ever deleted (sessions / merges / resources reference them), home actions
 * (ensure_session / retire) and their locks are never touched, absent live center intents are reported as projection_orphan.
 * Tracked tables are written with INSERT … ON CONFLICT DO UPDATE / UPDATE only (never REPLACE, see S2G2's static guard).
 */
import type { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { STATE_DIR } from "./paths.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { readSharedLedgerMode, type SharedLedgerMode } from "./shared-ledger-mode.js";
import { parseFeatureView } from "./shared-ledger-contract-v2-routes.js";
import { PROJECTION_ACTOR, withProjectionScope } from "./shared-ledger-v2-write-gate.js";
import { guardProjectionTasks, withProjectionWriter } from "./scheduler-v2-retire-guard.js";
import {
  cardEventData, depRow, intentRow, LOCAL_ACTIONS, PROJECTED_ACTIONS, resourceRow, stepRow, taskExtra, taskRow, TERMINAL_INTENT, workflowRow,
  type LocalTaskRow, type ProjectionIdentity, type V2FeatureView,
} from "./shared-ledger-v2-projection-rows.js";

export interface ProjectionCenterRef { teamId: string; projectId: string; centerFeatureId: string }
export interface ExecutionProjectionRef {
  /** Local project and local feature id the view is projected onto (trusted context, never taken from the view). */
  project: string; featureId: string;
  /** X13 / X13B pass their batch id while the feature carries `migrating`. */
  batchId?: string;
  /** Center binding for a migrating feature whose mode file has no centerExecution / centerPlanned yet (X13 manifest scope). */
  center?: ProjectionCenterRef;
  /** Trusted instance → local agent / peer mapping; a non-human executor without it is refused (v2_unmapped), never guessed. */
  identity?: ProjectionIdentity;
  now?: number;
  observe?(taskId: string, code: string): void;
}
export type ExecutionProjectionOutcome =
  | { kind: "written"; centerSeq: number; tasks: string[]; orphans: string[] }
  | { kind: "stale"; centerSeq: number; landed: number };

type Row = Record<string, string | number | null>;
const scopeError = (text: string, prefix = "projection_scope"): never => { throw new LedgerError("conflict", `${prefix}: ${text}`); };
const modeDir = (db: Database): string => db.filename === ":memory:" || !db.filename ? STATE_DIR : dirname(db.filename);

/** Highest centerSeq already landed for the feature (the same evidence S2G's withProjectionScope checks). */
export function landedCenterSeq(db: Database, featureId: string): number {
  return (db.query(`SELECT COALESCE(MAX(CAST(json_extract(data, '$.centerSeq') AS INTEGER)), 0) AS seq FROM events
    WHERE actor = ? AND json_extract(data, '$.featureId') = ?`).get(PROJECTION_ACTOR, featureId) as { seq: number }).seq;
}

function parseView(raw: unknown): V2FeatureView {
  try { return parseFeatureView(raw); }
  catch { throw new LedgerError("invalid", "projection_view: 中心快照视图不合法"); }
}

/** The view must belong to the center feature this local feature is bound to; nothing in the view itself is trusted for that. */
function checkScope(m: SharedLedgerMode, view: V2FeatureView, ref: ExecutionProjectionRef): void {
  const bound = m.centerExecution ?? m.centerPlanned;
  if (bound && ref.center && (bound.teamId !== ref.center.teamId || bound.projectId !== ref.center.projectId
    || bound.centerFeatureId !== ref.center.centerFeatureId)) scopeError("调用方中心绑定与模式文件不符");
  const center = bound ?? ref.center ?? scopeError("本机 feature 没有中心绑定");
  if (view.teamId !== center.teamId || view.projectId !== center.projectId) scopeError("快照跨项目");
  if (view.feature.id !== center.centerFeatureId) scopeError("快照跨 feature");
  if (m.centerExecution && view.feature.epoch < m.centerExecution.epoch) scopeError("快照 epoch 旧于本机执行 epoch");
}

function localTask(db: Database, id: string) {
  return db.query("SELECT id, project, spec, specRev, pr, featureId, extra FROM tasks WHERE id = ?").get(id) as
    (LocalTaskRow & { featureId: string | null }) | null;
}
function readExtra(extra: string | undefined): Record<string, unknown> | null {
  try { const v = JSON.parse(extra ?? "{}") as unknown; return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; }
  catch { return null; }
}
/** A card the projection rewrites must carry readable extra: rebuilding it from {} would silently drop home metadata. */
function parseExtra(id: string, extra: string): Record<string, unknown> {
  return readExtra(extra) ?? scopeError(`卡 ${id} 的 extra 不是合法 JSON 对象`, "projection_extra");
}
function belongs(row: { featureId: string | null; extra: string }, featureId: string): boolean {
  // Membership only: unreadable extra carries no sharedFeatureId evidence, so the featureId column alone decides; a card that
  // does belong and is rewritten is refused by parseExtra, never rebuilt from {}.
  const shared = readExtra(row.extra)?.sharedFeatureId;
  const ids = [row.featureId, shared].filter(id => typeof id === "string" && id);
  return ids.length > 0 && ids.every(id => id === featureId);
}

function upsert(db: Database, table: string, keys: readonly string[], row: Row, keep: readonly string[] = []): void {
  const cols = Object.keys(row), set = cols.filter(c => !keys.includes(c) && !keep.includes(c));
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
    ON CONFLICT (${keys.join(", ")}) DO UPDATE SET ${set.map(c => `${c} = excluded.${c}`).join(", ")}`).run(...cols.map(c => row[c]!));
}

function writeTasks(db: Database, view: V2FeatureView, ref: ExecutionProjectionRef): void {
  const feature = db.query("SELECT project FROM features WHERE id = ?").get(ref.featureId) as { project: string } | null;
  if (feature && feature.project !== ref.project) scopeError(`本机 feature ${ref.featureId} 属于别的本机项目`);
  const linked = !!feature;
  for (const t of view.tasks) {
    const local = localTask(db, t.id), row = taskRow(t, local, ref.identity);
    if (local) {
      if (local.project !== ref.project) scopeError(`卡 ${t.id} 属于别的本机项目`);
      if (!belongs(local, ref.featureId)) scopeError(`卡 ${t.id} 属于别的 feature`);
      row.extra = taskExtra(t, parseExtra(t.id, local.extra), ref.identity);
      const cols = Object.keys(row).filter(c => c !== "createdAt");
      db.prepare(`UPDATE tasks SET ${cols.map(c => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map(c => row[c]!), t.id);
      continue;
    }
    const item = t.itemId && db.query("SELECT 1 FROM items WHERE project = ? AND id = ?").get(ref.project, t.itemId) ? t.itemId : null;
    // No local feature row (feature known only by mode / sharedFeatureId): bind through extra, as stage-one shared cards do.
    upsert(db, "tasks", ["id"], { id: t.id, project: ref.project, itemId: item, ...row,
      featureId: linked ? ref.featureId : null, extra: taskExtra(t, linked ? {} : { sharedFeatureId: ref.featureId }, ref.identity) });
  }
}

function writeDeps(db: Database, view: V2FeatureView, ref: ExecutionProjectionRef, ids: Set<string>): void {
  const want = new Set(view.dependencies.map(d => `${d.fromTask}\0${d.toTask}`));
  for (const d of db.query("SELECT fromTask, toTask FROM task_deps WHERE project = ?").all(ref.project) as { fromTask: string; toTask: string }[]) {
    if (ids.has(d.fromTask) && ids.has(d.toTask) && !want.has(`${d.fromTask}\0${d.toTask}`)) {
      db.prepare("DELETE FROM task_deps WHERE fromTask = ? AND toTask = ?").run(d.fromTask, d.toTask);
    }
  }
  for (const d of view.dependencies) upsert(db, "task_deps", ["fromTask", "toTask"], depRow(ref.project, d));
}

function writeWorkflows(db: Database, view: V2FeatureView, ref: ExecutionProjectionRef, cards: readonly string[]): void {
  const want = new Set(view.workflows.map(w => w.taskId));
  // The center deleted it (or the card left the view), so the local row goes too; the projection never invents a workflow.
  for (const id of cards) if (!want.has(id)) db.prepare("DELETE FROM task_workflows WHERE taskId = ?").run(id);
  for (const w of view.workflows) upsert(db, "task_workflows", ["taskId"], workflowRow(ref.project, w));
}

type IntentRef = { id: string; taskId: string; action: string; status: string };
type Report = { taskId: string; intentId: string };
function writeIntents(db: Database, view: V2FeatureView, ref: ExecutionProjectionRef, cards: Set<string>): { orphans: Report[]; unmapped: Report[] } {
  const projected = view.intents.filter(i => PROJECTED_ACTIONS.includes(i.action));
  for (const i of projected) {
    const row = intentRow(ref.project, i);
    const old = db.query("SELECT id, taskId, action, status FROM scheduler_intents WHERE id = ?").get(row.id) as IntentRef | null;
    if (old && (old.taskId !== i.taskId || old.action !== i.action)) scopeError(`意图 ${row.id} 与本机行的卡或动作不符`);
    upsert(db, "scheduler_intents", ["id"], row);
  }
  const want = new Set(projected.map(i => i.operationId));
  const orphans = (db.query(`SELECT id, taskId, action, status FROM scheduler_intents WHERE project = ?`).all(ref.project) as IntentRef[])
    .filter(i => cards.has(i.taskId) && PROJECTED_ACTIONS.includes(i.action) && !want.has(i.id) && !TERMINAL_INTENT.includes(i.status))
    .map(i => ({ taskId: i.taskId, intentId: i.id }));
  const unmapped = view.intents.filter(i => !PROJECTED_ACTIONS.includes(i.action)).map(i => ({ taskId: i.taskId, intentId: i.id }));
  return { orphans, unmapped };
}

function writeResources(db: Database, view: V2FeatureView, ref: ExecutionProjectionRef, cards: Set<string>, orphaned: readonly Report[]): void {
  const orphans = orphaned.map(o => o.intentId);
  const landed = new Set(view.intents.filter(i => PROJECTED_ACTIONS.includes(i.action)).map(i => i.operationId));
  const rows = view.resources.filter(r => landed.has(r.operationId)).map(r => resourceRow(ref.project, r));
  const want = new Set(rows.map(r => `${r.resource}\0${r.intentId}`));
  const held = db.query(`SELECT r.resource, r.taskId, r.intentId, i.action FROM scheduler_resources r JOIN scheduler_intents i ON i.id = r.intentId
    WHERE r.project = ?`).all(ref.project) as { resource: string; taskId: string; intentId: string; action: string }[];
  for (const r of held) {
    // Only center-action locks of this feature's cards; a live orphan keeps its locks until X13H / X13B settles it.
    if (!cards.has(r.taskId) || !PROJECTED_ACTIONS.includes(r.action) || orphans.includes(r.intentId) || want.has(`${r.resource}\0${r.intentId}`)) continue;
    db.prepare("DELETE FROM scheduler_resources WHERE project = ? AND resource = ? AND intentId = ?").run(ref.project, r.resource, r.intentId);
  }
  for (const row of rows) {
    const old = held.find(r => r.resource === row.resource);
    if (old && old.intentId !== row.intentId && (LOCAL_ACTIONS.includes(old.action) || !cards.has(old.taskId)
      || (orphans.includes(old.intentId)))) scopeError(`资源 ${row.resource} 已被本机或别卡的意图占用`);
    upsert(db, "scheduler_resources", ["project", "resource"], row);
  }
}

function writeSteps(db: Database, view: V2FeatureView, ref: ExecutionProjectionRef): void {
  for (const s of view.steps) upsert(db, "task_steps", ["taskId", "step", "round"], stepRow(s, ref.identity));
}

function featureCards(db: Database, ref: Pick<ExecutionProjectionRef, "project" | "featureId">): string[] {
  return (db.query("SELECT id, featureId, extra FROM tasks WHERE project = ?").all(ref.project) as { id: string; featureId: string | null; extra: string }[])
    .filter(t => belongs(t, ref.featureId)).map(t => t.id);
}

/**
 * Guard follows the trusted local mode, never the view: execution / migrating cards stay guarded; only a controlled revert
 * (migrating revert) landing the center's planning view releases them. A planning view for a plain execution feature is refused.
 */
function guardPlan(m: SharedLedgerMode, view: V2FeatureView): "guard" | "release" {
  if (m.migrating?.kind === "revert" && view.feature.authorityMode === "planning") return "release";
  if (!m.migrating && view.feature.authorityMode !== "execution") scopeError("快照不是 execution，与本机 execution 模式不符");
  return "guard";
}

/**
 * Writes one center feature view (S2K parseFeatureView) onto the local ledger. centerSeq = view.serverSeq; a view not newer than
 * what already landed writes nothing. Must be called with the trusted local project / feature id and, under migrating, the batch id.
 */
export function writeExecutionProjection(db: Database, raw: unknown, ref: ExecutionProjectionRef): ExecutionProjectionOutcome {
  const view = parseView(raw);
  const m = readSharedLedgerMode(ref.featureId, modeDir(db));
  checkScope(m, view, ref);
  // Same authority rule as withProjectionScope, checked first so a wrong batch is refused even for an old view.
  if (m.migrating ? ref.batchId !== m.migrating.batchId : m.authorityMode !== "execution" || !m.centerExecution) {
    throw new LedgerError("forbidden", "投影不属于当前 execution / migrating 批次");
  }
  const landed = landedCenterSeq(db, ref.featureId);
  if (view.serverSeq <= landed) return { kind: "stale", centerSeq: view.serverSeq, landed };
  const guard = guardPlan(m, view);
  const ctx = { actor: PROJECTION_ACTOR, now: ref.now ?? Date.now() };
  const result = tx(db, () => withProjectionScope(db, { featureId: ref.featureId, centerSeq: view.serverSeq, ...(ref.batchId ? { batchId: ref.batchId } : {}) },
    () => withProjectionWriter(db, () => {
      const ids = new Set(view.tasks.map(t => t.id));
      // Every local card of the feature missing from the view (projected earlier, or a stage-one card on a first migration view):
      // each carries this view's centerSeq, so an empty view still cleans absent workflows and lands its watermark.
      const absent = featureCards(db, ref).filter(id => !ids.has(id));
      if (!ids.size && !absent.length) throw new LedgerError("conflict", "projection_empty: 空快照没有可落水位的卡，拒绝而不返回 written");
      writeTasks(db, view, ref);
      writeDeps(db, view, ref, ids);
      writeSteps(db, view, ref);
      // Cleanup / orphan scope is every card of the trusted feature, not just the view: cards that left it, and on a first
      // migration stage-one cards never projected, lose absent workflows and report their live center intents.
      const cards = new Set([...ids, ...absent]);
      writeWorkflows(db, view, ref, [...cards]);
      const intents = writeIntents(db, view, ref, cards);
      writeResources(db, view, ref, cards, intents.orphans);
      for (const t of view.tasks) insertEvent(db, ctx, { project: ref.project, target: t.id, kind: "task", data: cardEventData(view, t) }, false);
      for (const id of absent) insertEvent(db, ctx, { project: ref.project, target: id, kind: "task",
        data: { op: "center-projection", centerFeatureId: view.feature.id, serverSeq: view.serverSeq, absent: true } }, false);
      if (guard === "guard") guardProjectionTasks(db, [...ids], []);
      else guardProjectionTasks(db, [], [...new Set([...ids, ...featureCards(db, ref)])]);
      return { ...intents, tasks: [...ids] };
    })));
  // Logged after commit only: a rolled-back write must not leave an observe line.
  for (const o of result.orphans) report(ref, o, "projection_orphan");
  for (const o of result.unmapped) report(ref, o, "projection_unmapped_action");
  return { kind: "written", centerSeq: view.serverSeq, tasks: result.tasks, orphans: result.orphans.map(o => o.intentId) };
}

function report(ref: ExecutionProjectionRef, o: Report, code: string): void {
  if (ref.observe) ref.observe(o.taskId, `${code}:${o.intentId}`);
  else console.warn(`[shared-ledger-v2-projection ${code}] ${o.taskId}: ${o.intentId}`);
}

/** X13B after clearing `migrating`: release every card of a feature that is no longer execution from the S2V guard. */
export function releaseProjectionGuard(db: Database, ref: Pick<ExecutionProjectionRef, "project" | "featureId">): string[] {
  const m = readSharedLedgerMode(ref.featureId, modeDir(db));
  if (m.authorityMode === "execution" || m.migrating) throw new LedgerError("conflict", "projection_scope: execution / migrating feature 不能移出守卫");
  const cards = featureCards(db, ref);
  guardProjectionTasks(db, [], cards);
  return cards;
}
