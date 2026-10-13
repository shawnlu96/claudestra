/**
 * 子 DAG 节点的「最近一条事件」与「完成时刻」（SUBDAG2）：纯函数，只吃这张卡的事件（按 seq 升序）与节点三态。
 * 台账里绝大多数事件是调度记账（settle / plan / pool_offer……）、空文本的 memory / step、观察类 note，直接取最后一条几乎总是它们；
 * 所以「有信息」按白名单认，新出现的 kind / op 默认不算。只出现在本机 /ledger/:p/dag 与 /work 的响应里，不进中心。
 */
import type { NodePhase } from "./ledger-dag-rules.js";
import type { LedgerEvent } from "./ledger-stages.js";

export interface BoardLastEvent {
  at: number;
  actor: string;
  kind: string;
  text: string;
}

const INFO_KINDS: ReadonlySet<string> = new Set(["stage", "deliver", "review", "verify", "deploy", "ask", "ask_cancel", "decision", "dispatch"]);
const NOTE_OPS: ReadonlySet<string> = new Set(["review_ask", "local_author", "lend_author_family", "supervise", "lock_yield_released", "refusal_owner_inform"]);
const SCHEDULER_OPS: ReadonlySet<string> = new Set(["merge_phase", "deploy_phase", "order_taken", "fallback_manual", "convergence_effect"]);
const MAX_TEXT = 120;
/** 恰好 40 位的十六进制（更长的摘要不动）；order-gate-heads.ts 的 shortenShas 要 heads 集合，这里用不上 */
const SHA40 = /\b([0-9a-f]{12})[0-9a-f]{28}\b/gi;

/** note 只认手写的（没有 data.op）与白名单 op；scheduler 只认白名单 op */
function informative(e: LedgerEvent): boolean {
  if (INFO_KINDS.has(e.kind)) return true;
  const op = e.data?.op;
  if (e.kind === "note") return op === undefined || op === null || (typeof op === "string" && NOTE_OPS.has(op));
  return e.kind === "scheduler" && typeof op === "string" && SCHEDULER_OPS.has(op);
}

/** 换行折成空格、40 位 sha 截到 12 位、按码点截到 120 字（不切断代理对） */
function cleanText(raw: string): string {
  const text = raw.replace(/\s*[\r\n]+\s*/g, " ").trim().replace(SHA40, "$1");
  const points = Array.from(text);
  return points.length > MAX_TEXT ? `${points.slice(0, MAX_TEXT).join("")}…` : text;
}

function lastInformative(events: readonly LedgerEvent[]): BoardLastEvent | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (!informative(e)) continue;
    const text = cleanText(e.text ?? "");
    if (text) return { at: e.ts, actor: e.actor, kind: e.kind, text };
  }
  return null;
}

/** lastEvent 只给进行中的节点算，doneAt（最后一条 stage 事件的 ts）只给已完成的算；其余为 null */
export function nodeEventFacts(events: readonly LedgerEvent[] | undefined, phase: NodePhase): { lastEvent: BoardLastEvent | null; doneAt: number | null } {
  const list = events ?? [];
  return {
    lastEvent: phase === "active" ? lastInformative(list) : null,
    doneAt: phase === "done" ? list.findLast((e) => e.kind === "stage")?.ts ?? null : null,
  };
}
