import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { WriteCtx } from "./ledger-checks.js";
import { activeProjectPm } from "./pm-role.js";
import { getEventByDedup, getMeta, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { priorityRecord, priorityTarget, readPriority, readPriorityModes, readPriorityOrder } from "./ledger-priority-read.js";
import { PRIORITY_BANDS, PRIORITY_MECHANISMS, PRIORITY_MODES, type PriorityBand, type PriorityContext,
  type PriorityEvidence, type PriorityMechanism, type PriorityMode, type PriorityRecord, type PriorityTarget, type PriorityView } from "./ledger-priority-types.js";

export function priorityAudit(db: Database, ctx: WriteCtx, project: string, data: Record<string, unknown>, primary = false) {
  return insertEvent(db, ctx, { project, target: String(data.recordId ?? ""), kind: "decision",
    text: typeof data.ownerWords === "string" ? data.ownerWords : "", data: { namespace: "priority", ...data } }, primary);
}

/** The roster's active PM must still be in pms; master and the dispatcher never inherit owner authority. */
function authorize(db: Database, ctx: PriorityContext, evidence: PriorityEvidence): void {
  const meta = getMeta(db, ctx.project);
  if (ctx.actor !== "owner" && (ctx.actor === "master" || ctx.actor === "scheduler" || ctx.actor === "import"
    || !meta.pms.includes(ctx.actor) || meta.team?.dispatcher === ctx.actor || activeProjectPm(db, ctx.project) !== ctx.actor)) {
    throw new LedgerError("forbidden", "只有 owner 或项目当班真实 PM 可按 owner 原话登记优先级");
  }
  if (!evidence || typeof evidence.ownerWords !== "string" || !evidence.ownerWords.trim()
    || typeof evidence.sourceRef !== "string" || !evidence.sourceRef.trim()
    || !Number.isSafeInteger(evidence.ownerAt) || evidence.ownerAt <= 0) {
    throw new LedgerError("invalid", "登记必须保存非空 owner 原话、原话时间（毫秒）及来源引用；无可靠原话请走 ask");
  }
  if (!Number.isSafeInteger(ctx.now ?? Date.now()) || (ctx.now ?? Date.now()) <= 0) throw new LedgerError("invalid", "登记时间非法");
  if (typeof ctx.dedupKey !== "string" || !ctx.dedupKey.trim()) throw new LedgerError("invalid", "修改必须带非空 dedupKey");
}

function revision(current: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new LedgerError("invalid", "rev 必须是非负整数（未登记用 0）");
  if (current !== expected) throw new LedgerError("conflict", "优先级版本冲突", { rev: current });
}

/** Identical payload and actor replay their immutable result; a changed request may never reuse an authorization key. */
function duplicate<T = unknown>(db: Database, ctx: PriorityContext, request: unknown) {
  const prior = getEventByDedup(db, ctx.dedupKey);
  if (!prior) return null;
  if (prior.project !== ctx.project || prior.actor !== ctx.actor || prior.data.namespace !== "priority"
    || JSON.stringify(prior.data.request) !== JSON.stringify(request)) {
    throw new LedgerError("dedup_mismatch", "去重键已被不同的优先级请求使用");
  }
  return { row: prior.data.result as T, event: prior, duplicate: true };
}

export function ensurePriorityRecord(db: Database, project: string, target: PriorityTarget): PriorityRecord {
  const record = priorityRecord(db, project, target);
  if (record) return record;
  const ref = priorityTarget(db, project, target), id = randomUUID();
  db.query("INSERT INTO priority_records(id,project,kind,featureId,nodeKey,taskId) VALUES (?,?,?,?,?,?)")
    .run(id, project, target.kind === "feature" ? "feature" : "work", target.kind === "task" ? null : ref.featureId, ref.nodeKey, ref.taskId);
  return priorityRecord(db, project, target)!;
}

export function setPriority(db: Database, ctx: PriorityContext, input: {
  target: PriorityTarget; rev: number; band: PriorityBand | null; evidence: PriorityEvidence;
}) {
  return tx(db, () => {
    authorize(db, ctx, input.evidence);
    if (input.band !== null && !PRIORITY_BANDS.includes(input.band)) throw new LedgerError("invalid", "档位只能是 now / next / later");
    priorityTarget(db, ctx.project, input.target);
    const request = { op: input.band === null ? "clear" : "set", target: input.target, rev: input.rev, band: input.band, evidence: input.evidence };
    const prior = duplicate<PriorityView>(db, ctx, request);
    if (prior) return prior;
    const before = readPriority(db, ctx.project, input.target);
    revision(before.rev, input.rev);
    const record = ensurePriorityRecord(db, ctx.project, input.target);
    db.query("UPDATE priority_records SET band=?,rev=rev+1 WHERE id=?").run(input.band, record.id);
    const result = readPriority(db, ctx.project, input.target);
    const event = priorityAudit(db, ctx, ctx.project, { ...input.evidence, op: request.op, request, recordId: record.id,
      location: record, before, after: result, result }, true);
    return { row: result, event, duplicate: false };
  });
}

export function setPriorityOrder(db: Database, ctx: PriorityContext, input: {
  queue: string; band: PriorityBand; targets: PriorityTarget[]; rev: number; evidence: PriorityEvidence;
}) {
  return tx(db, () => {
    authorize(db, ctx, input.evidence);
    if (!PRIORITY_BANDS.includes(input.band)) throw new LedgerError("invalid", "非法档位");
    if (typeof input.queue !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(input.queue)) throw new LedgerError("invalid", "queue 为项目内非空队列名");
    if (!Array.isArray(input.targets) || input.targets.length > 200) throw new LedgerError("invalid", "同档顺序最多 200 个目标；空数组恢复默认顺序");
    const before = readPriorityOrder(db, ctx.project, input.queue, input.band), request = { op: "order", ...input };
    const prior = duplicate(db, ctx, request);
    if (prior) return prior;
    revision(before.rev, input.rev);
    const members = input.targets.map((target) => {
      if (readPriority(db, ctx.project, target).effective !== input.band) throw new LedgerError("invalid", "只能排列同一档位的目标");
      return ensurePriorityRecord(db, ctx.project, target).id;
    });
    if (new Set(members).size !== members.length) throw new LedgerError("invalid", "同一记录不能重复排序（绑卡与节点是同一记录）");
    const result = { queue: input.queue, band: input.band, members, rev: before.rev + 1 };
    db.query(`INSERT INTO priority_orders(project,queue,band,members,rev) VALUES (?,?,?,?,?)
      ON CONFLICT(project,queue,band) DO UPDATE SET members=excluded.members,rev=excluded.rev`)
      .run(ctx.project, input.queue, input.band, JSON.stringify(members), result.rev);
    const event = priorityAudit(db, ctx, ctx.project, { ...input.evidence, op: "order", request, before, after: result, result }, true);
    return { row: result, event, duplicate: false };
  });
}

/** Mode writes only record policy. Consumers must implement each mechanism and honor observe independently. */
export function setPriorityMode(db: Database, ctx: PriorityContext, input: {
  mechanism: PriorityMechanism; mode: PriorityMode; rev: number; evidence: PriorityEvidence;
}) {
  return tx(db, () => {
    authorize(db, ctx, input.evidence);
    if (!PRIORITY_MECHANISMS.includes(input.mechanism) || !PRIORITY_MODES.includes(input.mode)) throw new LedgerError("invalid", "非法机制或开关档位");
    const request = { op: "mode", ...input }, prior = duplicate(db, ctx, request);
    if (prior) return prior;
    const before = readPriorityModes(db, ctx.project)[input.mechanism];
    revision(before.rev, input.rev);
    const result = { mechanism: input.mechanism, mode: input.mode, rev: before.rev + 1 };
    db.query(`INSERT INTO priority_modes(project,mechanism,mode,rev) VALUES (?,?,?,?)
      ON CONFLICT(project,mechanism) DO UPDATE SET mode=excluded.mode,rev=excluded.rev`)
      .run(ctx.project, input.mechanism, input.mode, result.rev);
    const event = priorityAudit(db, ctx, ctx.project, { ...input.evidence, op: "mode", request, before, after: result, result }, true);
    return { row: result, event, duplicate: false };
  });
}
