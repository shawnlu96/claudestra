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
  /** 押后消息的 message_id（回程槽记了请求 id 时按它精确查） */
  messageId?: string;
}

export function pacStillHeld(callerChannelId: string, held: HeldFromLike[] | undefined): boolean {
  if (!held || held.length === 0) return false;
  return held.some((h) => h.fromKind === "local" && h.fromChannelId === callerChannelId);
}

/**
 * 这一槽的请求 target 一条都还没看到：槽里记了请求 message_id 就按 id 查——同一 caller 后来的另一条还押着，
 * 不该挡住前一条（已送到）的回程（codex 2026-09-28 复核）；老槽没记 id 就按发送方查。
 */
export function callStillHeld(call: { callerChannelId: string; messageIds?: string[] }, held: HeldFromLike[] | undefined): boolean {
  if (!call.messageIds?.length) return pacStillHeld(call.callerChannelId, held);
  const unseen = new Set((held ?? []).map((h) => h.messageId));
  return call.messageIds.every((id) => unseen.has(id));
}

/** 该 pac 是否该被 stale 扫描清掉 */
export function shouldSweepPac(
  pac: { ts: number; callerChannelId: string; messageIds?: string[] },
  held: HeldFromLike[] | undefined,
  now: number,
  staleMs: number,
): boolean {
  if (callStillHeld(pac, held)) return false;
  return now - pac.ts > staleMs;
}
