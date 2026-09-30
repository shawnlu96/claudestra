/**
 * v2.23.1+ pendingAgentCalls（agent→agent 回程路由簿）的失效判定，与押后队列联动。
 *
 * 事故（2026-09-17）：master → claudestra 的消息因目标回合中被押后（heldLocalMsgs）；
 * 目标回合持续 >10 分钟，每分钟扫描把这条 pac 当「对方忘了回」清掉了。消息本身还
 * 押着、之后照常投递，但目标回复时已无路由 → caller 收不到，且无人知情。
 *
 * 规则：逐条请求判——还押在目标队里（它还没看到）的请求不过期，失效钟从真正送达起算；
 * 按槽判会让同一 caller 已送到的前一条把还押着的后一条一起带走。纯函数，单测在 tests/held-pac.test.ts。
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

/** 单条请求还押在 target 队里（它没看到）：有 message_id 按 id 查，老数据没有就按发送方查 */
export function requestStillHeld(req: { messageId?: string; callerChannelId: string }, held: HeldFromLike[] | undefined): boolean {
  if (!req.messageId) return pacStillHeld(req.callerChannelId, held);
  return !!held?.some((h) => h.messageId === req.messageId);
}

/** 这条请求该被 stale 扫描清掉：还押着的不算；钟 = 它自己的送达时刻，老数据没记就回落槽级 ts */
export function requestExpired(
  req: { messageId?: string; deliveredAt?: number },
  call: { ts: number; callerChannelId: string },
  held: HeldFromLike[] | undefined,
  now: number,
  staleMs: number,
): boolean {
  if (requestStillHeld({ messageId: req.messageId, callerChannelId: call.callerChannelId }, held)) return false;
  return now - (req.deliveredAt ?? call.ts) > staleMs;
}
