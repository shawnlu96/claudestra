/**
 * Pure comparison of observe records with what actually happened next. Each observation is answered by the first
 * later non-scheduler event; PM stage moves or escalations that follow in the same window are listed as unplanned.
 * A move right after a verdict is answered by the retro observation replayed at that verdict (scheduler-observe).
 * "match" only when the ledger proves the same action; what cannot be told from the ledger is "unknown", never a match.
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
  /** superseded = a later observation replaced the plan with no answering action in between (e.g. a dependency cleared). */
  verdict: "match" | "diff" | "unknown" | "pending" | "superseded";
  note: string;
  lagMs: number | null;
}

/** step counts only as PM's explicit assignment (op=assign); delivery bookkeeping on steps is not an action. */
const RESPONSE_KINDS = new Set(["stage", "dispatch", "escalate", "deliver", "review", "verify", "ask", "decision", "step"]);
const PM_GATES = new Set(["pm_restate"]);
/** Waits that end when a worker (not PM) writes its result; a worker event answering them is the expected path. */
const WORKER_WAITS = new Set(["in_flight", "intent_in_flight", "review_transition"]);

const isObservation = (e: LedgerEvent): boolean => e.kind === "scheduler" && e.data.op === "observe" && e.data.retro === undefined;
const retroOf = (e: LedgerEvent): { reviewSeq: number; moveSeq: number } | null =>
  e.kind === "scheduler" && e.data.op === "observe" && e.data.retro && typeof e.data.retro === "object" ? e.data.retro as { reviewSeq: number; moveSeq: number } : null;
const moveOf = (e: LedgerEvent): string => `${String(e.data.from ?? "?")}→${String(e.data.to ?? "?")}`;

function describeEvent(e: LedgerEvent): string {
  if (e.kind === "stage") return `推阶段 ${moveOf(e)}`;
  if (e.kind === "review") return `审查结论 ${String(e.data.verdict ?? "?")}（${String(e.data.reviewer ?? "?")}）`;
  if (e.kind === "dispatch") return `派审（${String(e.data.reviewer ?? "?")}）`;
  if (e.kind === "deliver") return "交付";
  if (e.kind === "step") return `指派「${String(e.data.step ?? "?")}」给 ${String(e.data.executor ?? "?")}`;
  if (e.kind === "verify") return `完成检查 ${String(e.data.result ?? "?")}`;
  return e.kind;
}

function describeDecision(d: ObservedDecision): string {
  if (d.kind === "wait") return `等待（${d.code}）`;
  if (d.kind === "escalate") return `停下升级（${d.code}）`;
  const to = d.recipient ?? "?";
  switch (d.action) {
    case "stage": return `推阶段到 ${d.targetStage}`;
    case "ensure_session": return `新建本卡独立 ${d.sessionRole === "reviewer" ? "审查" : "执行"} session`;
    case "dispatch": return `派「${d.node}」给 ${to}`;
    case "review": return `派对抗式审查给 ${to}`;
    case "merge": return "进合并队列（合并 + 部署）";
    case "verify": return "跑完成检查单";
    case "retire": return "归档并结束本卡 session";
    case "ask": return "请 owner 看前后截图";
    default: return `${d.action}（${d.node}）`;
  }
}

/** Stage the intent's success would lead to; used to recognise PM doing the same thing by hand. */
const EXPECTED_STAGE: Record<string, string | undefined> = { merge: "live", verify: "verified", retire: "done" };

/** Facts judge() needs beyond the answering event: the reviewer PM had assigned, the reviewer the engine planned. */
interface JudgeCtx { assignedReviewer: (seq: number) => string | null; plannedReviewer: string | null }

type Judged = { verdict: "match" | "diff" | "unknown"; note: string };

function judgeReviewDispatch(d: ObservedDecision, e: LedgerEvent, c: JudgeCtx): Judged {
  if (e.data.reviewer !== "adversarial") return { verdict: "diff", note: `引擎会派对抗式审查，PM 派的是 ${String(e.data.reviewer ?? "?")}` };
  const to = c.assignedReviewer(e.seq);
  if (!to) return { verdict: "unknown", note: "派审没记收件人，之前也没有指派审查者，无法核对派给了谁" };
  return to === d.recipient ? { verdict: "match", note: `PM 手动派对抗式审查，收件人按指派是 ${to}` }
    : { verdict: "diff", note: `引擎会派 ${d.recipient}，PM 指派的审查者是 ${to}` };
}

function judge(d: ObservedDecision, e: LedgerEvent, isPm: (actor: string) => boolean, c: JudgeCtx): Judged {
  const pmMove = e.kind === "stage" && isPm(e.actor);
  if (d.kind === "escalate") {
    if (e.kind === "escalate") return { verdict: "match", note: "PM 同样升级" };
    return { verdict: "diff", note: `引擎会停下（${d.code}），实际继续：${describeEvent(e)}` };
  }
  if (d.kind === "wait") {
    if (PM_GATES.has(d.code ?? "") && pmMove) return { verdict: "match", note: "PM 闸由 PM 放行" };
    if (e.kind === "review" && c.plannedReviewer && e.data.reviewer !== c.plannedReviewer) {
      return { verdict: "diff", note: `结论来自 ${String(e.data.reviewer)}，不是引擎要派的 ${c.plannedReviewer}` };
    }
    if (WORKER_WAITS.has(d.code ?? "") && !pmMove) return { verdict: "match", note: "等到的正是 worker 结果" };
    return pmMove ? { verdict: "diff", note: `引擎会等（${d.code}），PM ${describeEvent(e)}` } : { verdict: "match", note: "等待期间的外部事实" };
  }
  switch (d.action) {
    case "stage":
      return pmMove && e.data.to === d.targetStage ? { verdict: "match", note: "阶段一致" }
        : { verdict: "diff", note: `引擎会推到 ${d.targetStage}，实际：${describeEvent(e)}` };
    case "review":
      if (e.kind === "dispatch") return judgeReviewDispatch(d, e, c);
      if (e.kind === "review") return { verdict: "diff", note: `引擎会先派审给 ${d.recipient}，实际直接记了 ${String(e.data.reviewer)} 的结论` };
      return { verdict: "diff", note: `引擎会派审，实际：${describeEvent(e)}` };
    case "dispatch":
      if ((e.kind === "deliver" || e.kind === "stage") && e.actor === d.recipient) return { verdict: "match", note: "同一执行者接手" };
      return { verdict: "diff", note: `引擎会派给 ${d.recipient}，实际：${e.actor} ${describeEvent(e)}` };
    case "ensure_session":
      return { verdict: "diff", note: e.kind === "step" ? "引擎会新建本卡独立 session，PM 指派了现有 agent"
        : `引擎会先建本卡独立 ${d.sessionRole} session，实际由 ${e.actor} 接手` };
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
export function schedulerDiff(events: readonly LedgerEvent[], isPm: (actor: string) => boolean): DiffRow[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const observations = sorted.filter(isObservation);
  const retros = new Map<number, LedgerEvent>();
  for (const e of sorted) { const r = retroOf(e); if (r) retros.set(r.moveSeq, e); }
  const assignedReviewer = (seq: number): string | null => {
    const a = sorted.findLast((e) => e.kind === "step" && e.data.op === "assign" && e.data.step === "review" && e.seq < seq);
    return a?.data.executorKind === "agent" && typeof a.data.executor === "string" ? a.data.executor : null;
  };
  const rows: (DiffRow & { at: number })[] = [];
  let plannedReviewer: string | null = null;
  observations.forEach((o, i) => {
    const until = observations[i + 1]?.seq ?? Number.MAX_SAFE_INTEGER;
    const window = sorted.filter((e) => e.seq > o.seq && e.seq < until && e.actor !== "scheduler" && RESPONSE_KINDS.has(e.kind) &&
      (e.kind !== "step" || e.data.op === "assign"));
    const d = o.data.decision as ObservedDecision;
    if (d.kind === "intent" && d.action === "review" && d.recipient) plannedReviewer = d.recipient;
    const base = { observationSeq: o.seq, stage: String(o.data.stage), round: Number(o.data.round), planned: describeDecision(d) };
    const c = { assignedReviewer, plannedReviewer };
    const [first, ...rest] = window;
    if (!first) {
      const later = i + 1 < observations.length;
      rows.push({ ...base, actual: null, actor: null, verdict: later ? "superseded" : "pending",
        note: later ? "计划被后续事实改写，其间没有对应动作" : "尚无后续动作", lagMs: null, at: o.seq });
      return;
    }
    rows.push({ ...base, actual: describeEvent(first), actor: first.actor, ...judge(d, first, isPm, c), lagMs: first.ts - o.ts, at: first.seq });
    let sawVerdict = first.kind === "review";
    for (const e of rest) {
      const retro = retros.get(e.seq);
      if (retro) {
        const rd = retro.data.decision as ObservedDecision;
        const j = judge(rd, e, isPm, c);
        rows.push({ observationSeq: retro.seq, stage: "review", round: Number(retro.data.round), planned: describeDecision(rd), actual: describeEvent(e),
          actor: e.actor, verdict: j.verdict, note: `按结论当时的台账回溯重算；${j.note}`, lagMs: 0, at: e.seq });
      } else if (e.kind === "stage" && sawVerdict && e.data.from === "review" && isPm(e.actor)) {
        rows.push({ ...base, planned: "（结论后的计划没有记录）", actual: describeEvent(e), actor: e.actor, verdict: "unknown",
          note: "审查结论之后直接推阶段、中间没有观察，无法还原引擎的判断，需核对", lagMs: e.ts - o.ts, at: e.seq });
      } else if ((e.kind === "stage" || e.kind === "escalate") && isPm(e.actor)) {
        rows.push({ ...base, actual: describeEvent(e), actor: e.actor, verdict: "diff", note: "观察之后又一个未经计划的动作", lagMs: e.ts - o.ts, at: e.seq });
      }
      if (e.kind === "review") sawVerdict = true;
    }
  });
  return rows.sort((a, b) => a.at - b.at).map(({ at: _at, ...r }) => r);
}

const VERDICT_WORD: Record<DiffRow["verdict"], string> = { match: "一致", diff: "差异", unknown: "未知", pending: "未决", superseded: "改写" };

/** One human line per row for PM / owner: card, stage and round, verdict, engine plan vs what actually happened. */
export function diffLine(taskId: string, r: DiffRow): string {
  const actual = r.actual ? `${r.actor ?? "?"} ${r.actual}` : "（还没有）";
  const lag = r.lagMs === null ? "" : `，${Math.round(r.lagMs / 1000)} 秒后`;
  return `${taskId} · ${r.stage} 第 ${r.round} 轮 · ${VERDICT_WORD[r.verdict]} · 引擎：${r.planned} ｜ 实际：${actual}（${r.note}${lag}）`;
}
