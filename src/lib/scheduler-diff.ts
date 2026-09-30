/**
 * Pure comparison of observe records with what actually happened next. Each observation is answered by the first
 * later non-scheduler event; PM stage moves or escalations that follow in the same window are listed as unplanned.
 * "match" means the engine would have done (or waited for) the same thing; everything else is a diff row for PM.
 */
import type { LedgerEvent } from "./ledger-stages.js";
import type { ObservedDecision } from "./scheduler-observe.js";

export interface DiffRow {
  observationSeq: number;
  stage: string;
  round: number;
  planned: string;
  actual: string | null;
  actor: string | null;
  verdict: "match" | "diff" | "pending";
  note: string;
  lagMs: number | null;
}

const RESPONSE_KINDS = new Set(["stage", "dispatch", "escalate", "deliver", "review", "verify", "ask", "decision"]);
const PM_GATES = new Set(["pm_restate"]);
/** Waits that end when a worker (not PM) writes its result; a worker event answering them is the expected path. */
const WORKER_WAITS = new Set(["in_flight", "intent_in_flight", "review_transition"]);

const isObservation = (e: LedgerEvent): boolean => e.kind === "scheduler" && e.data.op === "observe";
const moveOf = (e: LedgerEvent): string => `${String(e.data.from ?? "?")}→${String(e.data.to ?? "?")}`;

export function describeEvent(e: LedgerEvent): string {
  if (e.kind === "stage") return `推阶段 ${moveOf(e)}`;
  if (e.kind === "review") return `审查结论 ${String(e.data.verdict ?? "?")}（${String(e.data.reviewer ?? "?")}）`;
  if (e.kind === "dispatch") return `派审（${String(e.data.reviewer ?? "?")}）`;
  if (e.kind === "deliver") return "交付";
  if (e.kind === "verify") return `完成检查 ${String(e.data.result ?? "?")}`;
  return e.kind;
}

export function describeDecision(d: ObservedDecision): string {
  if (d.kind === "wait") return `等待（${d.code}）`;
  if (d.kind === "escalate") return `停下升级（${d.code}）`;
  const to = d.recipient ? ` → ${d.recipient}` : "";
  if (d.action === "stage") return `推阶段到 ${d.targetStage}`;
  if (d.action === "ensure_session") return `新建本卡 ${d.sessionRole} session`;
  return `${d.action} ${d.node}${to}`;
}

/** Stage the intent's success would lead to; used to recognise PM doing the same thing by hand. */
const EXPECTED_STAGE: Record<string, string | undefined> = { merge: "live", verify: "verified", retire: "done" };

function judge(d: ObservedDecision, e: LedgerEvent, isPm: (actor: string) => boolean): { verdict: "match" | "diff"; note: string } {
  const pmMove = e.kind === "stage" && isPm(e.actor);
  if (d.kind === "escalate") {
    if (e.kind === "escalate") return { verdict: "match", note: "PM 同样升级" };
    return { verdict: "diff", note: `引擎会停下（${d.code}），实际继续：${describeEvent(e)}` };
  }
  if (d.kind === "wait") {
    if (PM_GATES.has(d.code ?? "") && pmMove) return { verdict: "match", note: "PM 闸由 PM 放行" };
    if (WORKER_WAITS.has(d.code ?? "") && !pmMove) return { verdict: "match", note: "等到的正是 worker 结果" };
    return pmMove ? { verdict: "diff", note: `引擎会等（${d.code}），PM ${describeEvent(e)}` } : { verdict: "match", note: "等待期间的外部事实" };
  }
  switch (d.action) {
    case "stage":
      return pmMove && e.data.to === d.targetStage ? { verdict: "match", note: "阶段一致" }
        : { verdict: "diff", note: `引擎会推到 ${d.targetStage}，实际：${describeEvent(e)}` };
    case "review":
      if (e.kind === "dispatch") return { verdict: "match", note: "PM 手动派审" };
      if (e.kind === "review") return e.data.reviewer === d.recipient ? { verdict: "match", note: "同一审查者" }
        : { verdict: "diff", note: `引擎会派 ${d.recipient}，实际审查者 ${String(e.data.reviewer)}` };
      return { verdict: "diff", note: `引擎会派审，实际：${describeEvent(e)}` };
    case "dispatch":
      if ((e.kind === "deliver" || e.kind === "stage") && e.actor === d.recipient) return { verdict: "match", note: "同一执行者接手" };
      return { verdict: "diff", note: `引擎会派给 ${d.recipient}，实际：${e.actor} ${describeEvent(e)}` };
    case "ensure_session":
      return { verdict: "diff", note: `引擎会先建本卡独立 ${d.sessionRole} session，实际由 ${e.actor} 接手（${describeEvent(e)}）` };
    default: {
      const want = EXPECTED_STAGE[d.action ?? ""];
      if (want && e.kind === "stage" && e.data.to === want) return { verdict: "match", note: "PM 手动完成同一步" };
      if (d.action === "verify" && e.kind === "verify") return { verdict: "match", note: "PM 手动核证" };
      if (d.action === "ask" && e.kind === "ask") return { verdict: "match", note: "已向 owner 发 ask" };
      return { verdict: "diff", note: `引擎会 ${d.action}，实际：${describeEvent(e)}` };
    }
  }
}

/** isPm: the project's PMs plus master / owner; a worker's own stage move (restate, deliver) is never "unplanned". */
/**
 * `review --to X` writes the verdict and PM's stage move in one transaction, so no observation sits between them.
 * The move is judged against the planner's branch for that verdict (P0/block stop, P1 fix, otherwise merge).
 */
function reviewBranch(review: LedgerEvent): string | null {
  const count = (k: string) => (typeof review.data[k] === "number" ? review.data[k] as number : 0);
  if (review.data.verdict === "block" || count("p0") > 0) return null;
  return count("p1") > 0 ? "fix" : "merge";
}

function sameTxMove(review: LedgerEvent, next: LedgerEvent | undefined, isPm: (actor: string) => boolean): boolean {
  // One write transaction stamps every event with the same actor and timestamp; step bookkeeping may sit between them.
  return !!next && next.kind === "stage" && next.ts === review.ts && next.actor === review.actor && isPm(next.actor);
}

export function schedulerDiff(events: readonly LedgerEvent[], isPm: (actor: string) => boolean): DiffRow[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const observations = sorted.filter(isObservation);
  const rows: DiffRow[] = [];
  observations.forEach((o, i) => {
    const until = observations[i + 1]?.seq ?? Number.MAX_SAFE_INTEGER;
    const window = sorted.filter((e) => e.seq > o.seq && e.seq < until && e.actor !== "scheduler" && RESPONSE_KINDS.has(e.kind));
    const d = o.data.decision as ObservedDecision;
    const base = { observationSeq: o.seq, stage: String(o.data.stage), round: Number(o.data.round), planned: describeDecision(d) };
    const [first, ...rest] = window;
    if (!first) {
      rows.push({ ...base, actual: null, actor: null, verdict: "pending", note: "尚无后续动作", lagMs: null });
      return;
    }
    rows.push({ ...base, actual: describeEvent(first), actor: first.actor, ...judge(d, first, isPm), lagMs: first.ts - o.ts });
    let prev = first;
    for (const e of rest) {
      const before = prev;
      prev = e;
      if (before.kind === "review" && sameTxMove(before, e, isPm)) {
        const want = reviewBranch(before);
        const ok = want !== null && e.data.to === want;
        rows.push({ ...base, planned: want ? `按审查结论推到 ${want}` : "按审查结论停下升级", actual: describeEvent(e), actor: e.actor,
          verdict: ok ? "match" : "diff", note: "同一事务的 review --to，按结论分支判", lagMs: e.ts - o.ts });
        continue;
      }
      if (!((e.kind === "stage" || e.kind === "escalate") && isPm(e.actor))) continue;
      rows.push({ ...base, actual: describeEvent(e), actor: e.actor, verdict: "diff", note: "观察之后又一个未经计划的动作", lagMs: e.ts - o.ts });
    }
  });
  return rows;
}
