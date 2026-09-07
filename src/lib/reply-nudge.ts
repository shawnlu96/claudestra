/**
 * Stop hook「补 reply」拦截(v2.22.x,owner 2026-09-07:「这个 agent 总是忘了调用 mcp
 * 回复我,尤其短对话不涉及 tool use」——agent 把结论写成叙述文本就结束回合,用户在
 * web 上只看到过程流(💬)、收不到推送,Discord 上没有正式回复)。
 *
 * 机制:Claude Code 的 Stop hook 可以返回 {decision:"block", reason} 让 agent 继续。
 * bridge 在 Stop 到达时看该 agent ws 上还挂着的 pendingReplies——request 投递时挂、
 * reply()/response envelope 到达时清——还在就是「这回合没回」,拦一次,reason 里写明
 * 该回哪个 chat_id。只拦一次:stop_hook_active(Claude Code 标记「已经因 Stop hook
 * 续跑过」)为真不拦,pending 已 nudge 过也不拦,免得 agent 真没话说时死循环。
 * StopFailure / Notification 不拦。纯逻辑,单测 tests/reply-nudge.test.ts。
 */
export interface NudgeCandidate {
  /** pendingReplies 的键 = 该请求要回到的 chat_id */
  key: string;
  ts: number;
  nudgedAt?: number;
}

/** 请求挂上到 Stop 之间至少这么久才算「这回合本该回」——刚投递就 Stop 的,agent 还没看到。 */
export const NUDGE_MIN_AGE_MS = 500;

export function pickUnrepliedForNudge(
  candidates: NudgeCandidate[],
  opts: { event: string; stopHookActive: boolean; now: number },
): NudgeCandidate | null {
  if (opts.event !== "Stop") return null;
  if (opts.stopHookActive) return null;
  let pick: NudgeCandidate | null = null;
  for (const c of candidates) {
    if (c.nudgedAt) continue;
    if (opts.now - c.ts < NUDGE_MIN_AGE_MS) continue;
    if (!pick || c.ts < pick.ts) pick = c;
  }
  return pick;
}

export function nudgeReason(chatId: string): string {
  return (
    `你这一回合没有用 reply 工具回复 chat_id=${chatId} 的消息。对方看不到正式回复、收不到推送` +
    `(web 端只有零散的过程文本,Discord 端没有回复消息)。请现在调用 reply(chat_id="${chatId}") ` +
    `把刚才的结论发过去——直接复用你已经写好的回答即可,不要重新分析;需要对方决定的用 buttons/multiselect。`
  );
}
