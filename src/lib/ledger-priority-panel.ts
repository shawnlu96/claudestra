/** Read-only projection: PRIO1 owns effective bands and ordering; work-board owns waiting facts. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { boardContext, featureCard, hasFeatureSchema, type BoardCtx, type BoardNode } from "./ledger-dag-board.js";
import type { Feature } from "./ledger-feature.js";
import { isAskEvent } from "./ledger-stages.js";
import { getAsk } from "./ledger-asks.js";
import { listDeps, getEventByDedup, LedgerError } from "./ledger-store.js";
import { priorityHistory, readPriority, readPriorityModes, readPriorityOrder } from "./ledger-priority-read.js";
import type { PriorityTarget, PriorityView } from "./ledger-priority-types.js";
import { workBoard, type WorkBoardOptions } from "./ledger-work-board.js";

export interface PriorityPanelRow {
  key: string; target: PriorityTarget; taskId: string | null; featureId: string | null; nodeKey: string | null;
  title: string; feature: string | null; stage: string;
  state: "dependency" | "capacity" | "owner" | "uncertain" | "unknown" | "working" | "waiting" | "ready";
  reason: string; since: number | null; priority: PriorityView; escalation: string;
}
export type PriorityPanel = ReturnType<typeof priorityPanel>;
export const panelKey = (target: PriorityTarget): string => canonicalJson(target);
const terminal = (stage: string) => ["done", "verified", "cancelled"].includes(stage);

function workState(code: string | null, reason: string | null): PriorityPanelRow["state"] {
  if (code === "unknown_effect") return "uncertain";
  if (code === "capacity") return "capacity";
  if (code === "owner" || (code === "ask" && reason === "等 owner")) return "owner";
  return "waiting";
}

function taskFacts(ctx: BoardCtx, taskId: string, work?: ReturnType<typeof workBoard>): Pick<PriorityPanelRow, "state" | "reason" | "since"> {
  const task = ctx.tasks.get(taskId)!;
  const row = work && [...work.working, ...work.waiting, ...work.todo.ready, ...work.todo.blocked].find(r => r.taskId === taskId);
  const deps = listDeps(ctx.db, ctx.project).filter(d => d.to === taskId && !terminal(ctx.tasks.get(d.from)?.stage ?? "unknown"));
  const since = row?.since ?? ctx.events.get(taskId)?.findLast(e => e.kind === "stage")?.ts ?? task.createdAt;
  if (deps.length) return { state: "dependency", reason: `等待依赖：${deps.map(d => d.from).join("、")}`, since };
  if (row && work?.waiting.includes(row)) return { state: workState(row.code, row.reason), reason: row.reason ?? "等待中", since };
  if (row && work?.working.includes(row)) return { state: "working", reason: "执行中", since };
  const pending = ctx.sched.get(taskId)?.latestIntent;
  if (pending?.status === "unknown") return { state: "uncertain", reason: "外部结果不明，需核实", since: pending.updatedAt };
  return { state: "unknown", reason: row?.reason ?? "数据未知：尚无可靠的执行或等待状态", since };
}

function nodeFacts(node: BoardNode, nodes: BoardNode[]): Pick<PriorityPanelRow, "state" | "reason" | "since"> {
  const blocked = node.deps.filter(key => !nodes.find(n => n.key === key)?.satisfied);
  return blocked.length ? { state: "dependency", reason: `等待依赖：${blocked.join("、")}`, since: null }
    : { state: "unknown", reason: "未绑卡计划：开工及停滞数据未知", since: null };
}

/** PRIO3 is optional on this baseline; absent/invalid threshold uses a 24-hour visual warning. */
function stallThreshold(db: Database, project: string): number {
  const row = db.query("SELECT value FROM meta WHERE project=? AND key='priority-stall-threshold'").get(project) as { value: string } | null;
  if (!row) return 86400000;
  try {
    const hours: unknown = JSON.parse(row.value);
    return typeof hours === "number" && Number.isFinite(hours) && hours > 0 ? hours * 3600000 : 86400000;
  } catch { return 86400000; } // Invalid optional PRIO3 metadata must not hide otherwise readable now work.
}

export function priorityPanel(db: Database, project: string, now: number, opts?: WorkBoardOptions) {
  const ctx = boardContext(db, project, now);
  const features = hasFeatureSchema(db) ? db.query("SELECT * FROM features WHERE project=?").all(project) as Feature[] : [];
  const cards = features.map(f => featureCard(ctx, f));
  const refs = cards.flatMap(f => f.nodes.map(node => ({ feature: f, node })));
  const work = opts ? workBoard(db, project, now, opts) : undefined;
  const modes = readPriorityModes(db, project);
  const order = readPriorityOrder(db, project, "project", "now");
  const rows: PriorityPanelRow[] = [];
  const add = (row: Omit<PriorityPanelRow, "key" | "priority" | "escalation">) => {
    const priority = readPriority(db, project, row.target);
    if (priority.effective === "now") rows.push({ ...row, key: panelKey(row.target), priority, escalation: "尚未启用" });
  };
  for (const task of ctx.tasks.values()) {
    if (terminal(task.stage)) continue;
    const ref = refs.find(r => r.node.taskId === task.id);
    const parent = cards.find(f => f.id === task.featureId);
    const facts = taskFacts(ctx, task.id, work);
    const blocked = ref?.node.deps.filter(key => !ref.feature.nodes.find(n => n.key === key)?.satisfied) ?? [];
    if (blocked.length && (facts.state === "unknown" || facts.state === "ready")) { facts.state = "dependency"; facts.reason = `等待依赖：${blocked.join("、")}`; }
    add({ target: { kind: "task", id: task.id }, taskId: task.id, title: task.title, stage: task.stage,
      featureId: ref?.feature.id ?? parent?.id ?? null, feature: ref?.feature.title ?? parent?.title ?? null,
      nodeKey: ref?.node.key ?? null, ...facts });
  }
  for (const { feature, node } of refs) {
    if (feature.status !== "active" || node.taskId || node.phase === "done") continue;
    add({ target: { kind: "node", id: feature.id, nodeKey: node.key }, taskId: null, title: node.oneLine || node.key,
      stage: "planned", featureId: feature.id, feature: feature.title, nodeKey: node.key, ...nodeFacts(node, feature.nodes) });
  }
  rows.sort((a, b) => (a.priority.order ?? Number.MAX_SAFE_INTEGER) - (b.priority.order ?? Number.MAX_SAFE_INTEGER));
  // Time is kept outside the digest: polling alone cannot invalidate an unchanged owner choice.
  const policy = Object.fromEntries(Object.entries(modes).map(([key, value]) => [key, { ...value, available: key === "priorityPanel" }]));
  const version = createHash("sha256").update(canonicalJson({ rows: rows.map(r => ({ key: r.key, stage: r.stage, priority: r.priority })), order, modes: policy })).digest("hex");
  return { project, now, stallThresholdMs: stallThreshold(db, project), version, asOfSeq: ctx.asOfSeq, rows, order, modes: policy };
}

/** Historical decisions remain queryable after a completed card leaves the current panel. */
export function panelHistory(db: Database, project: string) {
  return priorityHistory(db, project).filter(e => !isAskEvent(e));
}

/** Compare immutable command output against the same live PRIO1 read used by the CLI. */
export function panelResult(db: Database, project: string, askId: string) {
  const ask = getAsk(db, askId), event = getEventByDedup(db, `priority-panel:${askId}`);
  if (!ask || ask.project !== project || ask.createdBy !== "system:priority-panel" || !event) {
    throw new LedgerError("conflict", "尚未确认应用结果，请刷新核对");
  }
  const input = ask.bind!.params as { operation: string; target: PriorityTarget };
  const current = input.operation === "up" || input.operation === "down"
    ? { queue: "project", band: "now", ...readPriorityOrder(db, project, "project", "now") }
    : readPriority(db, project, input.target);
  const observed = event.data.op === "would_apply";
  return { verified: observed || canonicalJson(current) === canonicalJson(event.data.result), observed, current };
}
