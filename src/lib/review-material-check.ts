/**
 * MODELX r4 审查单材料快照的只读核对（自 scheduler-model-wiring.ts 原样抽出，dispatch-recovery-MANEX1 · ask_mv0qumrq5afed07b9b）：
 * 快照 key / 格式、摘要与 orderSha256 算法、每次重新 hash 真实文件、读不到 / 无快照即拒，全部不变。快照 writer 与 MODEL 接线仍在
 * wiring（它原名 re-export 这里的 reviewMaterialCheck / reviewMaterialDigest / snapshotKey）；人工合并同族豁免门
 * （manual-merge-review-exemption.ts）直接引这里，不经 wiring（wiring → scheduler-maintenance → … → scheduler-merge 成环）。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AuthorFamily, SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getMeta, listEvents } from "./ledger-store.js";
import { reviewAfterBounce } from "./scheduler-merge-conflict.js";
import type { MaterialCheck, OrderPlan } from "./scheduler-review-swap.js";
import { workOrderFor } from "./scheduler-work-order.js";
import { specPathFor } from "./task-spec.js";

const PLACEHOLDER = { agent: "<reviewer>", sessionId: "<session>", family: "<family>" as AuthorFamily, checkout: "<checkout>", order: "<order>" };

/**
 * MODELX r4 (监工 10-06 19:1x): every formal review dispatch freezes its materials before the order goes out — the normalized
 * order (the full review order with only the ticket's identity and address replaced: order id, reviewer, session, family, checkout)
 * and a structured list of the real files behind it, each { path, sha256 }: the spec body (task.spec as specPathFor resolves it),
 * the prior round's review report, and fix_strategy's material. Paths come from structured fields, never from the order's text.
 * A refusal continuation compares only against this snapshot, item by item, re-hashing each file: any difference, an unreadable or
 * missing file, or no snapshot at all (an order sent before this existed) refuses the continuation — never "unreadable = unchecked".
 */
export const snapshotKey = (intentId: string): string => `review-materials:${intentId}`;
export const SNAPSHOT_OP = "review_material_snapshot";
export type Role = "spec" | "prior_report" | "fix_strategy";
export interface Item { role: Role; path: string | null; sha256?: string; error?: string }
const ROLE: Record<Role, string> = { spec: "规格正文", prior_report: "上一轮审查报告", fix_strategy: "fix_strategy 材料" };
export const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** The normalized order text: as it goes out, with only the ticket's own identity and address replaced by placeholders. */
export function normalizedOrder(db: Database, task: LedgerTask, sent: SchedulerIntent, plan?: OrderPlan): string {
  const bounce = plan === undefined ? reviewAfterBounce(listEvents(db, { project: task.project, target: task.id })) : null;
  const facts = plan === undefined ? (bounce ? { workOrder: { reportPath: "", findings: [], fallbackWarning: null, bounce } } : null) : plan;
  const order = workOrderFor(task, { ...sent, id: PLACEHOLDER.order }, facts as Parameters<typeof workOrderFor>[2],
    { taskId: task.id, role: "reviewer", agent: PLACEHOLDER.agent, sessionId: PLACEHOLDER.sessionId, family: PLACEHOLDER.family, transport: "tmux" },
    PLACEHOLDER.checkout, db);
  return JSON.stringify([task.project, task.id, order]);
}

/** The order's material files, from structured ledger fields only (no path guessed out of free text). */
export function materialPaths(db: Database, task: LedgerTask, sent: Pick<SchedulerIntent, "eventSeq">): { role: Role; path: string | null }[] {
  const events = listEvents(db, { project: task.project, target: task.id });
  const report = events.findLast((e) => e.kind === "review" && e.seq < sent.eventSeq)?.data.path;
  const material = events.findLast((e) => e.kind === "scheduler" && e.data.op === "fix_strategy" && e.data.specRev === task.specRev &&
    e.data.round === task.round)?.data.material;
  // task.spec as specPathFor resolves it; an absolute task.spec that is gone stays named, so it reads as a failure, not as absent
  const spec = specPathFor(task, getMeta(db, task.project).docsDir) ?? (task.spec && isAbsolute(task.spec) ? task.spec : null);
  return [{ role: "spec", path: spec },
    ...(report === undefined ? [] : [{ role: "prior_report" as const, path: typeof report === "string" ? report : null }]),
    ...(material === undefined ? [] : [{ role: "fix_strategy" as const, path: typeof material === "string" ? material : null }])];
}

/** One file's bytes now, or why they cannot be read (never skipped). */
export function hashFile(path: string | null): { sha256: string } | { error: string } {
  if (!path) return { error: "找不到文件" };
  if (!isAbsolute(path)) return { error: "不是绝对路径" };
  try { return { sha256: sha256(readFileSync(path)) }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

/** The ticket's snapshot as the scheduler wrote it for that very order, or null. */
function frozen(db: Database, task: LedgerTask, sent: SchedulerIntent): LedgerEvent | null {
  const e = getEventByDedup(db, snapshotKey(sent.id));
  return e && e.actor === "scheduler" && e.kind === "note" && e.target === task.id && e.data.op === SNAPSHOT_OP && e.data.intentId === sent.id &&
    e.data.head === sent.head && e.data.specRev === sent.specRev && typeof e.data.digest === "string" && Array.isArray(e.data.files) ? e : null;
}

/** What MODEL records for a refused ticket: its frozen snapshot's digest (no snapshot: a marker no check accepts). */
export const reviewMaterialDigest = (db: Database) => (task: LedgerTask, sent: SchedulerIntent): string =>
  String(frozen(db, task, sent)?.data.digest ?? `nosnapshot:${sent.id}`);

/**
 * Why the ticket's materials are no longer its frozen snapshot, or null. want: the digest MODEL recorded. order: a new order (the
 * exempt ticket) whose own text and material list must equal the snapshot. Every file is re-hashed now.
 */
export const reviewMaterialCheck = (db: Database): MaterialCheck => (task, sent, want, order) => {
  const snap = frozen(db, task, sent);
  if (!snap) return "原派单无材料快照";
  if (snap.data.digest !== want) return "MODEL 记下的材料摘要不是原派单快照";
  if (sha256(normalizedOrder(db, task, order?.intent ?? sent, order ? order.plan : undefined)) !== snap.data.orderSha256) {
    return order ? "新审查单正文与原派单快照不一致" : "审查单正文与原派单快照不一致";
  }
  const items = snap.data.files as Item[];
  const list = (xs: readonly { role: Role; path: string | null }[]) => xs.map((x) => `${x.role}:${x.path ?? "-"}`).join("，");
  const was = list(items), now = list(materialPaths(db, task, order?.intent ?? sent));
  if (was !== now) return `材料清单与原派单快照不一致（原 ${was}；现 ${now}）`;
  for (const it of items) {
    const what = `${ROLE[it.role] ?? it.role} ${it.path ?? "（无路径）"}`;
    if (typeof it.sha256 !== "string") return `${what} 原派单时就读不到（${it.error ?? "无摘要"}），无法证明材料不变`;
    const h = hashFile(it.path);
    if ("error" in h) return `${what} 读取失败（${h.error}）`;
    if (h.sha256 !== it.sha256) return `${what} 内容与原派单快照不一致`;
  }
  return null;
};
