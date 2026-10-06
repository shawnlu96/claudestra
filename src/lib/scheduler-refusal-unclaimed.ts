/**
 * dispatch-recovery-MODELXW2：领单前的策略拒审也认成本单拒审。复用的旧审查会话带着之前被拒的上下文，一收到唤醒就被提供方拒了：
 * 这张单从没被领过，observe 归不到「本单回合失败」，auto tick 只会报未领单；而 MODELXW 验收线 3 下监护在 on 时又让开了，于是没人处理。
 * 这里只读台账，认出「本单已发唤醒、未领、绑定的审查会话在唤醒之后的那一回合以策略拒审结束、会话 / head / 轮次 / specRev 都对得上」，
 * 把那条拒审交给 watch() 现有的失败分支（无快照 legacyReviewStep，有快照 modelOutcomeStep）。信号是 bridge 开的「回合失败」卡
 * （bridge/acp-link.ts，extra.failure = error / sessionId / failedAt），判定与监护一致：cyber 用监护的 isCyberPolicy，usage_policy 用
 * MODEL 的安全拒绝分类（scheduler-model-wiring.ts legacyReviewStep 认的同一个）。只读，不改监护、不写台账。
 * 有拒审卡却关联不上（唤醒之前、别的单、别的会话、缺时刻或会话、已有后续回合、head / 轮次不符）：不动，未领单报警正文带上
 * 「疑似领单前拒审，未能确认」。不能猜。只在 modelOutcome on 下生效：observe / off 返回 null，行为不变。tests/scheduler-refusal-unclaimed*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { isCyberPolicy } from "./agent-supervisor-policy.js";
import { listAsks, type Ask } from "./ledger-asks.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import { orderTakenSeq } from "./order-mark.js";
import { classifyModelOutcome } from "./scheduler-model-outcome.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { sentAsWake, type SessionRef, type WorkerObservation } from "./worker-session.js";

export type UnclaimedRefusal =
  | { kind: "confirmed"; failure: { kind: "error"; message: string }; cardId: string }
  | { kind: "suspected"; note: string };

export const SUSPECT_NOTE = "；疑似领单前拒审，未能确认";

/** 提供方策略拒审：监护认的 cyber_policy，或 MODEL 归为 safety 的（含 Claude usage_policy） */
export const isPolicyRefusal = (message: string): boolean =>
  isCyberPolicy(message) || classifyModelOutcome({ failure: { kind: "error", message } })?.cls === "safety";

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
function mismatch(db: Database, task: LedgerTask, sent: SchedulerIntent, ref: SessionRef, card: Ask, wokeAt: number, newest: Ask): string | null {
  const { failedAt, sessionId } = card.extra;
  if (typeof failedAt !== "number" || !Number.isFinite(failedAt) || typeof sessionId !== "string" || !sessionId) return "卡上缺失败时刻或会话";
  if (sessionId !== ref.sessionId) return "拒审不在绑定的审查会话上";
  if (failedAt < wokeAt) return "拒审发生在唤醒之前";
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
  if (ref.role !== "reviewer" || sent.action !== "review" || seen.state === "result") return null;
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
  if (!refusals.length) return null;
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
