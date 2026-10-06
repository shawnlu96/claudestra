/**
 * dispatch-recovery-MODELXW2：未领的审查单，绑定会话在唤醒投递回执（done）之后的那一回合以策略拒审结束（会话 / head / 轮次 / specRev 都对得上）→ confirmed，
 * 交 watch() 现有失败分支。信号是 bridge 的回合失败卡（extra.failure / sessionId / failedAt），cyber 判定同监护，usage_policy 同 MODEL。
 * 关联不上或读不到 → suspected：不动，未领单报警正文带「疑似领单前拒审，未能确认」。observe 归不到单、或 ACP 按认领时刻归给本单的同类拒审也先过这里。
 * 只读台账；只在 modelOutcome on 下生效。tests/scheduler-refusal-unclaimed*.test.ts。
 */import type { Database } from "bun:sqlite";
import { isCyberPolicy } from "./agent-supervisor-policy.js";
import { listAsks, type Ask } from "./ledger-asks.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import { orderTakenSeq } from "./order-mark.js";
import { classifyModelOutcome } from "./scheduler-model-outcome.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { sentAsWake, type SessionRef, type WorkerObservation } from "./worker-session.js";

export type UnclaimedRefusal =
  | { kind: "confirmed"; failure: { kind: "error"; message: string }; cardId: string }
  | { kind: "suspected"; note: string };

export const SUSPECT_NOTE = "；疑似领单前拒审，未能确认";

/** 提供方策略拒审：监护认的 cyber_policy，或 MODEL 归为 safety 的（含 Claude usage_policy） */
const isPolicyRefusal = (message: string): boolean =>
  isCyberPolicy(message) || classifyModelOutcome({ failure: { kind: "error", message } })?.cls === "safety";

/** observe 报了归不到单的策略拒审（真实 codexFailure 的 afterKey:null：卡缺会话或时刻） */
const unattributedRefusal = (seen: WorkerObservation): boolean =>
  seen.state === "unknown" && seen.failure?.kind === "error" && isPolicyRefusal(seen.failure.message);

/** observe 报了归不到单的失败，但它是本卡管的策略拒审、且已做过关联识别：交给识别结果，不提前退人工；额度 / 登录 / 普通失败照旧 */
export const awaitsAssociation = (seen: WorkerObservation, pre: UnclaimedRefusal | null): boolean => pre !== null && unattributedRefusal(seen);

const cardMessage = (a: Ask): string => `${a.title}：${a.context}`;
const roundOf = (intentId: string): number | null => {
  const m = /:r(\d+):/.exec(intentId);
  return m ? Number(m[1]) : null;
};

/** 这个 agent 在 at 时刻（含）之前最后一张发出（pending→submitted）的派单 / 派审意图：拒审归哪张单，和 codexFailure 同一把尺 */
function sentBefore(db: Database, agent: string, at: number): string | null {
  const r = db.query(`SELECT i.id FROM scheduler_intents AS i JOIN events AS e ON e.dedupKey = 'scheduler:' || i.id || ':submitted'
    WHERE i.recipient = ? AND i.action IN ('dispatch','review') AND e.ts <= ? ORDER BY e.seq DESC LIMIT 1`).get(agent, at) as { id: string } | null;
  return r?.id ?? null;
}

/** 关联不上的原因；null = 这张卡就是本单唤醒之后、本会话最后一回合的策略拒审 */
function mismatch(db: Database, task: LedgerTask, sent: SchedulerIntent, ref: SessionRef, card: Ask, claimedAt: number, newest: Ask): string | null {
  const { failedAt, sessionId } = card.extra;
  if (typeof failedAt !== "number" || !Number.isFinite(failedAt) || typeof sessionId !== "string" || !sessionId) return "卡上缺失败时刻或会话";
  if (sessionId !== ref.sessionId) return "拒审不在绑定的审查会话上";
  if (failedAt < claimedAt) return "拒审发生在唤醒之前";
  // submitted 是发送前的认领；只有晚于投递回执（done）的失败才证明是唤醒送达之后的回合，夹在两者之间的分不清新旧
  const delivered = getEventByDedup(db, `scheduler:${sent.id}:done`);
  if (!delivered) return "唤醒的投递回执还没落账";
  if (failedAt <= delivered.ts) return "拒审落在认领与投递回执之间，分不清是旧回合还是本单唤醒的回合";
  if (sentBefore(db, ref.agent, failedAt) !== sent.id) return "拒审属于别的单";
  if (card.state !== "open" || newest.id !== card.id) return "拒审之后会话还有别的回合";
  if (sent.head !== task.headSHA || sent.specRev !== task.specRev || roundOf(sent.id) !== task.round) return "head / specRev / 轮次和本单不符";
  return null;
}

/**
 * watch() 在 observe 没给出本单失败时调用。只看审查单：未领、以唤醒发出、绑定仍是这个会话；这个 agent 最新一张开着的回合失败卡是
 * 策略拒审，并且关联得上 → confirmed（failure 交原分支）；有唤醒之后的拒审卡却关联不上 → suspected（只改报警正文）；否则 null（照旧）。
 */
export async function unclaimedRefusal(db: Database, task: LedgerTask, sent: SchedulerIntent, ref: SessionRef,
  seen: WorkerObservation): Promise<UnclaimedRefusal | null> {
  if (seen.state === "result" && !hostRefusal(seen)) return null; // observe 已给出本单结果：一行不读，原失败分支照旧
  let pre: UnclaimedRefusal | null;
  try {
    pre = await recognize(db, task, sent, ref, seen);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    // 读失败不猜成确认，也不让这一轮丢掉未领单报警：照旧报警，正文写明疑似
    pre = { kind: "suspected", note: `${SUSPECT_NOTE}（信号读不到：${(e as Error).message.slice(0, 120)}）` };
  }
  if (pre?.kind === "suspected") demote(seen);
  return pre;
}

/** 宿主报的策略拒审失败（ACP codexFailure 按 submitted 认领时刻归单，认领与真正发送之间的旧回合也会算进来）：同样要过关联 */
const hostRefusal = (seen: WorkerObservation): boolean =>
  seen.state === "result" && seen.outcome === "failed" && seen.failure.kind === "error" && isPolicyRefusal(seen.failure.message);

/**
 * 关联不上的宿主拒审不能当本单失败：就地把这次观测降成「归不到单的失败」（observe 每轮新建的对象），watch 于是不进失败分支、
 * 不提前退人工（awaitsAssociation），照旧走带疑似的未领单报警。
 */
function demote(seen: WorkerObservation): void {
  if (seen.state !== "result" || seen.outcome !== "failed") return;
  const { failure } = seen;
  const target = seen as Record<string, unknown>;
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, { state: "unknown", reason: `宿主把策略拒审归给了本单，但关联不上`, failure });
}

async function recognize(db: Database, task: LedgerTask, sent: SchedulerIntent, ref: SessionRef, seen: WorkerObservation): Promise<UnclaimedRefusal | null> {
  if (ref.role !== "reviewer" || sent.action !== "review") return null;
  if (!sentAsWake(sent.receipt) || orderTakenSeq(db, sent.id) !== null) return null;
  const woke = getEventByDedup(db, `scheduler:${sent.id}:submitted`);
  if (!woke) return null;
  // observe / off：监护照旧认领，这里不碰（行为与改动前逐字相同）
  if ((await (await import("./scheduler-model-wiring.js")).modelOutcomeMode(task.project)) !== "on") return null;
  const cards = listAsks(db, { fromAgent: ref.agent, source: "codex" }).filter((a) => a.extra.failure === "error")
    .sort((a, b) => b.createdAt - a.createdAt);
  // 唤醒之后开出的拒审卡，或绑定会话上还开着的拒审卡（bridge 同指纹不重开卡时，时刻停在唤醒之前）：都没有就照旧报警
  const refusals = cards.filter((a) => (a.createdAt >= woke.ts || (a.state === "open" && a.extra.sessionId === ref.sessionId)) &&
    isPolicyRefusal(cardMessage(a)));
  // 卡缺会话 / 时刻、又开在唤醒之前时进不了候选，但 observe 已带着这条拒审：关联不上，按疑似报警
  if (!refusals.length) return unattributedRefusal(seen) ? { kind: "suspected", note: `${SUSPECT_NOTE}（宿主报了归不到单的策略拒审）` } : null;
  const newestOpen = cards.find((a) => a.state === "open");
  const card = refusals[0];
  const row = getSchedulerSession(db, task.id, "reviewer");
  const why = !newestOpen ? "拒审之后会话还有别的回合"
    : row?.state !== "active" || row.sessionId !== ref.sessionId ? "审查绑定已变"
    : seen.state === "running" && seen.busy ? "会话正在跑新的回合"
    : mismatch(db, task, sent, ref, card, woke.ts, newestOpen);
  if (why) return { kind: "suspected", note: `${SUSPECT_NOTE}（${why}）` };
  return { kind: "confirmed", failure: { kind: "error", message: cardMessage(card).slice(0, 4000) }, cardId: card.id };
}
