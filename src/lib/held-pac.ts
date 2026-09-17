/**
 * v2.23.1+ pendingAgentCalls（agent→agent 回程路由簿）的失效判定，与押后队列联动。
 *
 * 事故（2026-09-17）：master → claudestra 的消息因目标回合中被押后（heldLocalMsgs）；
 * 目标回合持续 >10 分钟，每分钟扫描把这条 pac 当「对方忘了回」清掉了。消息本身还
 * 押着、之后照常投递，但目标回复时已无路由 → caller 收不到，且无人知情（flushHeld
 * 投递时会刷新 pac.ts，可 pac 已经不在了，刷新无从谈起）。
 *
 * 规则：目标频道的押后队列里**还有该 caller 发出的消息** ⇒ 这条 pac 不算过期——
 * 失效钟从真正投递起算，而不是从发出起算。纯函数，单测在 tests/held-pac.test.ts。
 */
export interface HeldFromLike {
  /** 押后消息的发送端类型（RouterEnvelope.from.kind） */
  fromKind: string;
  /** from.kind === "local" 时的发送端频道 id */
  fromChannelId?: string;
}

export function pacStillHeld(callerChannelId: string, held: HeldFromLike[] | undefined): boolean {
  if (!held || held.length === 0) return false;
  return held.some((h) => h.fromKind === "local" && h.fromChannelId === callerChannelId);
}

/** 该 pac 是否该被 stale 扫描清掉 */
export function shouldSweepPac(
  pac: { ts: number; callerChannelId: string },
  held: HeldFromLike[] | undefined,
  now: number,
  staleMs: number,
): boolean {
  if (pacStillHeld(pac.callerChannelId, held)) return false;
  return now - pac.ts > staleMs;
}
