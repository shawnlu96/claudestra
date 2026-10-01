/** Delivery and all three review builders share this lazy, deduplicated scope registration (including pool deliveries). */
import { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask, listTasks } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { scopeDiff, type ScopeDiff, type ScopeFile } from "./order-deliver-scope-git.js";
import { clipWire } from "./order-findings.js";
import { WIRE_LIMITS, WIRE_MAX_BYTES } from "./order-wire.js";

interface OutsideFile extends ScopeFile { sharedWith: string[] }
const globs = (t: LedgerTask): string[] => Array.isArray(t.extra.fileGlobs) ? t.extra.fileGlobs.filter((g): g is string => typeof g === "string") : [];
const inScope = (path: string, patterns: string[]) => patterns.some((g) => new Bun.Glob(g).match(path));
const RUNNING = new Set(["restate", "build", "review", "fix", "blocked"]);

function outsideFiles(db: Database, task: LedgerTask, files: ScopeFile[]): OutsideFile[] {
  const others = listTasks(db, task.project).filter((t) => t.id !== task.id && RUNNING.has(t.stage));
  return files.filter((f) => !inScope(f.path, globs(task))).map((f) => ({ ...f,
    sharedWith: others.filter((t) => inScope(f.path, globs(t))).map((t) => t.id),
  }));
}

function describe(files: OutsideFile[]): string {
  return ["规格外文件（相对 PR base）：", ...files.map((f) => `${JSON.stringify(f.path)}：` +
    (f.added === null || f.deleted === null ? "二进制，行数不适用" : `+${f.added} / -${f.deleted}（${f.added + f.deleted} 行）`) +
    (f.sharedWith.length ? `；与 ${f.sharedWith.join("、")} 共改，冲突两边保留` : "")),
  "审查员判断范围扩展是否合理；理由不充分记 P2，不因规格外文件判 P1。"].join("\n");
}

/** Note-only write exception for review construction; never migrate or create a ledger from a read connection. */
function record(db: Database, task: LedgerTask, key: string, text: string, data: Record<string, unknown>): void {
  const queryOnly = (db.query("PRAGMA query_only").get() as { query_only: number }).query_only === 1;
  const writer = queryOnly ? new Database(db.filename, { readwrite: true, create: false }) : db;
  try {
    appendEvent(writer, { actor: "scheduler", dedupKey: key }, { project: task.project, target: task.id, kind: "note", text, data });
  } finally { if (writer !== db) writer.close(); }
}

/** Unavailable is recorded once but retried later; success uses one key across deliver, local review, scheduler and pool. */
export function ensureDeliverScope(db: Database, task: LedgerTask, head: string | null = task.headSHA,
  read: (db: Database, task: LedgerTask, head: string) => ScopeDiff = scopeDiff): string[] {
  if (!head || !Array.isArray(task.extra.fileGlobs)) return [];
  const key = `deliver-scope:${task.id}:${task.specRev}:${head}`;
  try {
    const prior = getEventByDedup(db, key);
    if (prior) return scopeInput(prior.text, prior.seq);
    const diff = read(db, task, head);
    const files = outsideFiles(db, task, diff.files);
    const text = files.length ? describe(files) : "规格外文件：无（相对 PR base）";
    record(db, task, key, text, { op: "deliver_scope", head, base: diff.base, specRev: task.specRev, files });
    return scopeInput(text, getEventByDedup(db, key)?.seq);
  } catch (e) {
    // Full SHAs in inputs are rejected by the pool's secret gate; details belong in event data, never the review wire.
    const text = "规格外文件未能登记；不挡派审，请审查员核对 diff（详情见本卡 deliver_scope_unavailable 事件）。";
    try { record(db, task, `${key}:unavailable`, text, { op: "deliver_scope_unavailable", head, error: (e as Error).message.slice(0, 1000) }); }
    catch (err) { console.error(`⚠️ ${task.id} 范围登记事件写入失败：${(err as Error).message}`); }
    return [text];
  }
}

function scopeInput(text: string, seq?: number): string[] {
  const clipped = clipWire(text, 8000);
  return [clipped === text ? text : `${clipped}\n列表过长，完整逐文件清单见台账事件 ${seq ?? "deliver_scope"}。`];
}

/** Re-read after deliver so newly registered PR and head are used; errors must never turn a successful delivery into refusal. */
export function deliveredScope(db: Database, taskId: string, head: string): void {
  const task = getTask(db, taskId);
  if (task) ensureDeliverScope(db, task, head);
}

/** Keep oversized lists in the event with a pointer in the order; scope registration must never make a valid order too large. */
export function withDeliverScope<T extends { inputs: string[]; head: string | null }>(db: Database | undefined, task: LedgerTask, order: T): T {
  if (!db) return order;
  const scope = ensureDeliverScope(db, task, order.head).join("\n");
  if (!scope) return order;
  const pointer = `完整规格外文件清单见 ${task.id} 台账 deliver_scope 事件（当前审查 head）；理由不充分记 P2。`;
  const append = (text: string): T => ({ ...order, inputs: order.inputs.length < WIRE_LIMITS.items ? [...order.inputs, text]
    : [...order.inputs.slice(0, -1), `${order.inputs.at(-1)}\n${text}`] });
  for (let limit = Buffer.byteLength(scope); limit >= 0; limit = limit > 0 ? Math.floor(limit / 2) : -1) {
    const next = append(limit >= Buffer.byteLength(scope) ? scope : `${clipWire(scope, limit)}\n${pointer}`);
    if (Buffer.byteLength(JSON.stringify(next)) <= WIRE_MAX_BYTES - 512 && next.inputs.every((s) => Buffer.byteLength(s) <= WIRE_LIMITS.input)) return next;
  }
  // A wire already at its cap cannot hold even a pointer. Its durable event still exists, and dispatch is not refused.
  return order;
}
