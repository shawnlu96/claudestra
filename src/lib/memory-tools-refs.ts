/**
 * deliver.memoryRefs 落账（设计稿 docs/design/project-memory.md §3.4、§4.2）：执行者交付时标单子上各条记忆 applied / irrelevant / wrong。
 * - 整份 memoryRefs 记一条 events.kind = 'memory'（data.op = 'refs'），§9 的引用率 / 无关率 / 错误率按它数；
 * - 每条 wrong 自动转成一条 dispute mark（reason = note，source = 上面那条事件，dedupKey 按设计稿 §1.2 的 auto: 格式），不再进单子、进 PM 待办。
 * 只认「这张单 + 这个 head 的交付是调用方自己记的」（deliver 的 dedup 事件），所以身份跟着 deliver 走、不另收。
 * 只收交付所在项目的记忆：别的项目的 id 整份拒（不落事件、不标争议），执行者不能借自己的交付把别处的记忆标成争议、挤出检索。
 * 重试安全：事件按 dedupKey 只写一次；同键再来必须是同一份 refs（不同就拒），补记 dispute 只按已落的那份做，dispute 按 dedupKey 只记一次。
 * bridge 侧 withMemoryRefs 在 deliver 成功（含重放）之后调，失败只附在回执里、不推翻交付。tests/memory-tools-refs.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getMemory, markMemory } from "./ledger-memory.js";
import type { MemorySourceRef } from "./ledger-memory-fold.js";
import { ORIGIN_VALUES, originArgs } from "./ledger-origin.js";
import { getEventByDedup, LedgerError, toEvent } from "./ledger-store.js";
import type { MemoryRef } from "./memory-tools-wire.js";
import { ledgerWrite, type LedgerRun } from "./order-ledger-exit.js";
import type { OrderToolResult, VerifiedCall } from "./order-tool-route.js";

/** deliver 工具那次交付的 dedupKey（order-deliver.ts 从这里引）：memory-refs 只跟在调用方自己的那次交付后面 */
export const deliverDedupKey = (orderId: string, head: string): string => `mcp-deliver:${orderId}:${head}`;
const memoryRefsKey = (orderId: string, head: string) => `memory-refs:${orderId}:${head}`;

const refOf = (e: { seq: number; origin?: string | null; originSeq?: number | null }): MemorySourceRef =>
  e.origin && e.originSeq ? { origin: e.origin, originSeq: e.originSeq } : { seq: e.seq };
const refText = (r: MemorySourceRef) => ("seq" in r ? `seq/${r.seq}` : `${r.origin}/${r.originSeq}`);

export interface RefsOutcome { eventSeq: number; duplicate: boolean; disputed: string[]; unknown: string[]; failed: { id: string; error: string }[] }

/** refs 里每条已有的记忆都得在交付的项目里；不在的整份拒（事件与 marks 都还没写） */
function foreignRefs(db: Database, project: string, refs: readonly MemoryRef[]): string[] {
  return refs.filter((r) => { const m = getMemory(db, r.id); return !!m && m.project !== project; }).map((r) => r.id);
}

const sameRefs = (a: readonly MemoryRef[], b: readonly MemoryRef[]) =>
  JSON.stringify(a.map((r) => [r.id, r.use, r.note ?? null])) === JSON.stringify(b.map((r) => [r.id, r.use, r.note ?? null]));

export function recordMemoryRefs(db: Database, actor: string, input: { orderId: string; head: string; refs: MemoryRef[] }, now: number): RefsOutcome {
  const delivered = getEventByDedup(db, deliverDedupKey(input.orderId, input.head));
  if (!delivered || delivered.kind !== "deliver") throw new LedgerError("not_found", `没有 ${input.orderId} @ ${input.head.slice(0, 12)} 的交付，memoryRefs 只跟在交付后面`);
  if (delivered.actor !== actor) throw new LedgerError("forbidden", "这次交付不是你记的，不能替它标 memoryRefs");
  const taskId = delivered.target;
  const key = memoryRefsKey(input.orderId, input.head);
  let event = getEventByDedup(db, key);
  const duplicate = !!event;
  if (event) {
    const stored = (event.data as { refs?: MemoryRef[] } | null)?.refs ?? [];
    if (!sameRefs(stored, input.refs)) throw new LedgerError("dedup_mismatch", `${input.orderId} @ ${input.head.slice(0, 12)} 已记过另一份 memoryRefs，同一次交付不能改`);
  } else {
    const foreign = foreignRefs(db, delivered.project, input.refs);
    if (foreign.length) throw new LedgerError("forbidden", `记忆 ${foreign.slice(0, 5).join(", ")} 不在这次交付的项目 ${delivered.project} 里，整份 memoryRefs 没记`);
    const r = db.prepare(`INSERT INTO events (ts, actor, project, target, kind, text, data, dedupKey, origin, originSeq) VALUES (?, ?, ?, ?, 'memory', '', ?, ?, ${ORIGIN_VALUES}) RETURNING *`)
      .get(now, actor, delivered.project, taskId, JSON.stringify({ op: "refs", orderId: input.orderId, head: input.head, refs: input.refs }), key, ...originArgs(db));
    event = toEvent(r as Record<string, unknown>);
  }
  const source = refOf(event);
  const out: RefsOutcome = { eventSeq: event.seq, duplicate, disputed: [], unknown: [], failed: [] };
  for (const ref of input.refs.filter((x) => x.use === "wrong")) {
    const memory = getMemory(db, ref.id);
    if (!memory) {
      out.unknown.push(ref.id);
      continue;
    }
    if (memory.project !== delivered.project) { // 首次落账时还不存在、之后才出现的同号记忆：不跨项目标
      out.failed.push({ id: ref.id, error: `不在项目 ${delivered.project} 里` });
      continue;
    }
    try {
      markMemory(db, { actor, now }, { memoryId: ref.id, mark: "dispute", reason: ref.note ?? "交付时标 wrong", source,
        dedupKey: `auto:dispute:${ref.id}:${taskId}:${refText(source)}` });
      out.disputed.push(ref.id);
    } catch (e) {
      out.failed.push({ id: ref.id, error: (e as Error).message.slice(0, 300) });
    }
  }
  return out;
}

/** bridge：交付回执（成功或重放）后补记 memoryRefs；没给或交付被拒就原样返回 */
export async function withMemoryRefs(result: OrderToolResult, call: VerifiedCall, run: LedgerRun, orderId: string, head: string,
  refs: MemoryRef[] | undefined): Promise<OrderToolResult> {
  if (!result.ok || !refs?.length) return result;
  const r = await ledgerWrite(call, run, "memory-refs", orderId, { head, refs: JSON.stringify(refs) }, memoryRefsKey(orderId, head));
  return { ...result, memoryRefs: r.ok ? { ok: true, disputed: r.disputed, unknown: r.unknown, failed: r.failed } : { ok: false, error: r.error } };
}
