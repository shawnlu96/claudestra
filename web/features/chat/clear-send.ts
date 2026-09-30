/** Web chat 的 ACP /clear 会等线程轮换；超时只能报结果未确认，避免一键重发又清一次。 */
export const isClearSend = (wire: string, hasFiles: boolean) => !hasFiles && /^\/clear(?:\s|$)/.test(wire);
export const sendTimeoutMs = (clearing: boolean, hasFiles: boolean) => clearing ? 230_000 : hasFiles ? 60_000 : 20_000;
export const canSendClearBoot = (activeAgent: string, targetAgent: string) => activeAgent === targetAgent;

export function classifySendFailure(
  e: unknown, clearing: boolean, lang: string, errorText: (e: unknown) => string,
): { text: string; handled: boolean; unknown: boolean } {
  const code = e && typeof e === "object" && "code" in e ? String(e.code) : undefined;
  const timedOut = (e as Error).name === "TimeoutError";
  const unknown = clearing && (timedOut || code === "clear_result_unknown");
  if (unknown) return {
    text: lang === "zh" ? "⚠️ /clear 结果未确认，请先查看当前会话，再决定是否重试" : "⚠️ /clear outcome unknown; check the current session before retrying",
    handled: true, unknown: true,
  };
  return {
    text: timedOut ? (lang === "zh" ? "上传超时（网络不稳）" : "upload timed out") : errorText(e),
    handled: code === "ask_closed", unknown: false,
  };
}

const bareSession = (sid: string) => sid.replace(/^acp:/, "");

export class RetiredAcpStreams {
  private readonly sessions = new Map<string, Set<string>>();
  retire(agent: string, sessionId?: string): void {
    if (!sessionId) return;
    const ids = this.sessions.get(agent) ?? new Set<string>();
    ids.add(bareSession(sessionId));
    this.sessions.set(agent, ids);
  }
  shouldDrop(agent: string, sourceSid?: string): boolean {
    return !!sourceSid && (this.sessions.get(agent)?.has(bareSession(sourceSid)) ?? false);
  }
}

export function settleClearSend<T extends {
  activeAgent: string; messages: { id: string; role?: string; ts?: string; sid?: string }[];
  pendingPermission: unknown; pendingAsk: unknown; streaming: boolean; awaitingChunk: boolean;
}>(cache: Map<string, unknown>, agent: string, optimisticId: string | null, retired: RetiredAcpStreams,
  previousSessionId?: string, startedAt?: number): (state: T) => void {
  cache.delete(agent);
  retired.retire(agent, previousSessionId);
  return (s) => {
    if (s.activeAgent !== agent) return; // 请求结束前切到别的 agent，不能清掉它的视图。
    const at = optimisticId ? s.messages.findIndex((m) => m.id === optimisticId) : -1;
    s.messages = at >= 0 ? s.messages.slice(at + 1) : startedAt === undefined ? [] : s.messages.filter((m) =>
      Date.parse(m.ts ?? "") >= startedAt && (m.role === "user" || !!m.sid && !retired.shouldDrop(agent, m.sid)));
    s.pendingPermission = null;
    s.pendingAsk = null;
    s.streaming = false;
    s.awaitingChunk = false;
  };
}
