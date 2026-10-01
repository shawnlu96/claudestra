/**
 * 规格外文件登记（i28-ASK2）：交付的 PR diff（相对 base）对卡的 fileGlobs，规格外的文件与行数记一条 note 事件，带进下一张审查单。
 * 分两半：ensureDeliverScope 异步、会跑 gh / git（可能 fetch），只在事务外 await——交付后（order-deliver.ts）、调度派审前
 * （scheduler-auto-tick.ts）、挂池前（manager 的 lend-offer / scheduler-pool-step）；三处拼审查单（review-order.ts、
 * scheduler-work-order.ts、ledger-lend.ts）只经 withDeliverScope 同步读已登记的事件，不起子进程——放进挂池的 BEGIN IMMEDIATE
 * 或 bridge 的事件循环里会锁台账 / 卡住 bridge（r1 P1-3、P2-1）。同一 dedupKey，谁先到谁登记；登记失败不挡交付、不挡派审。
 * tests/order-deliver-scope.test.ts。
 */
import { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask, listTasks } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { scopeDiff, type ScopeDiff, type ScopeFile } from "./order-deliver-scope-git.js";
import { clipWire } from "./order-findings.js";
import { WIRE_LIMITS, WIRE_MAX_BYTES } from "./order-wire.js";

interface OutsideFile extends ScopeFile { sharedWith: string[] }
type ScopeRead = (db: Database, task: LedgerTask, head: string) => Promise<ScopeDiff>;

const globs = (t: LedgerTask): string[] => Array.isArray(t.extra.fileGlobs) ? t.extra.fileGlobs.filter((g): g is string => typeof g === "string") : [];
const inScope = (path: string, patterns: string[]) => patterns.some((g) => new Bun.Glob(g).match(path));
/** 还没进 main 的卡都算在跑：merge 排队的同样会和本卡冲突 */
const RUNNING = new Set(["restate", "build", "review", "fix", "blocked", "merge"]);
/** 登记失败后这么久内不再重读（每次重读最长 15 秒的 gh / fetch） */
export const SCOPE_RETRY_MS = 5 * 60_000;
const WRITER_BUSY_MS = 5_000;

const UNAVAILABLE = "规格外文件未能登记；不挡派审，请审查员自己用 diff 对照 fileGlobs 核对（详情见本卡 deliver_scope_unavailable 事件）。";
const UNREGISTERED = "规格外文件还没有登记记录；请审查员自己用 diff（相对 PR base）对照卡上的 fileGlobs 核对。理由不充分记 P2，不判 P1。";

const scopeKey = (task: LedgerTask, head: string): string => `deliver-scope:${task.id}:${task.specRev}:${head}`;
const unavailablePrefix = (key: string): string => `${key}:unavailable`;

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

/** 只写 note；bridge 的只读连接（query_only）另开一条带 busy_timeout 的写连接，不迁移、不建库 */
function record(db: Database, task: LedgerTask, key: string, text: string, data: Record<string, unknown>, now: number): void {
  const queryOnly = (db.query("PRAGMA query_only").get() as { query_only: number }).query_only === 1;
  const writer = queryOnly ? new Database(db.filename, { readwrite: true, create: false }) : db;
  try {
    if (writer !== db) writer.exec(`PRAGMA busy_timeout = ${WRITER_BUSY_MS}`);
    appendEvent(writer, { actor: "scheduler", dedupKey: key, now }, { project: task.project, target: task.id, kind: "note", text, data });
  } finally { if (writer !== db) writer.close(); }
}

/** 最近一次「未能登记」的时刻（按 5 分钟一桶记，同一桶只一条） */
function lastUnavailable(db: Database, key: string): number | null {
  // 键是「前缀:桶号」：按 ':' 与 ';' 夹出范围，走 dedupKey 索引，不全表扫
  const p = unavailablePrefix(key);
  const r = db.query("SELECT ts FROM events WHERE dedupKey > ? AND dedupKey < ? ORDER BY seq DESC LIMIT 1").get(`${p}:`, `${p};`) as { ts: number } | null;
  return r?.ts ?? null;
}

/**
 * 没登记就登记（同一 dedupKey，重复调用只读）。只在事务外 await。失败记「未能登记」事件后 SCOPE_RETRY_MS 内不再重读；永不抛出。
 */
export async function ensureDeliverScope(db: Database, task: LedgerTask, head: string | null = task.headSHA, read: ScopeRead = scopeDiff,
  now = Date.now()): Promise<void> {
  if (!head) return;
  const key = scopeKey(task, head);
  try {
    if (getEventByDedup(db, key)) return;
    // 没有 fileGlobs = 没定义范围（老卡 / 手动卡），无从比对：不写事件、不加行，出借 v1 报文与老卡派单逐字不变（tests/lend-wire-v1-golden.test.ts）
    if (!globs(task).length) return;
    const seen = lastUnavailable(db, key);
    if (seen !== null && now - seen < SCOPE_RETRY_MS) return;
    let diff: ScopeDiff;
    try {
      diff = await read(db, task, head);
    } catch (e) {
      const bucket = Math.floor(now / SCOPE_RETRY_MS);
      return record(db, task, `${unavailablePrefix(key)}:${bucket}`, UNAVAILABLE, { op: "deliver_scope_unavailable", head, error: (e as Error).message.slice(0, 1000) }, now);
    }
    const files = outsideFiles(db, task, diff.files);
    record(db, task, key, files.length ? describe(files) : "规格外文件：无（相对 PR base）", { op: "deliver_scope", head, base: diff.base, specRev: task.specRev, files }, now);
  } catch (e) {
    console.error(`⚠️ ${task.id} 规格外文件登记事件写入失败（派审照常，下次派审前再补）：${(e as Error).message}`);
  }
}

/** 交付后补登记：重读卡（deliver 刚写了 PR / head）；出错只打日志，不把成功的交付变成失败 */
export async function deliveredScope(db: Database | null, taskId: string, head: string): Promise<void> {
  const task = db ? getTask(db, taskId) : null;
  if (db && task) await ensureDeliverScope(db, task, head);
}

/** 同步只读：已登记的列表 / 未能登记 / 还没登记，三选一（给审查单） */
export function scopeInputs(db: Database, task: LedgerTask, head: string | null): string[] {
  if (!head) return [];
  const key = scopeKey(task, head);
  const prior = getEventByDedup(db, key);
  if (prior) {
    const clipped = clipWire(prior.text, 8000);
    return [clipped === prior.text ? prior.text : `${clipped}\n列表过长，完整逐文件清单见台账事件 ${prior.seq}。`];
  }
  if (lastUnavailable(db, key) !== null) return [UNAVAILABLE];
  // 没有 fileGlobs 的卡没登记过就不加行（登记后才有「未比对」那句）：老卡、手动卡的派单逐字不变
  return globs(task).length ? [UNREGISTERED] : [];
}

/** Keep oversized lists in the event with a pointer in the order; scope registration must never make a valid order too large. */
export function withDeliverScope<T extends { inputs: string[]; head: string | null }>(db: Database | undefined, task: LedgerTask, order: T): T {
  if (!db) return order;
  const scope = scopeInputs(db, task, order.head).join("\n");
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

/** 挂池入口（CLI lend-offer、调度 scheduler-pool-step）在事务外调：卡在 review 才登记，挂池事务里的 reviewOrder 只读 */
export async function ensureReviewScope(db: Database, taskId: string | null | undefined): Promise<void> {
  const task = taskId ? getTask(db, taskId) : null;
  if (task?.stage === "review") await ensureDeliverScope(db, task);
}
