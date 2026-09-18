/**
 * 回合以 API 错误结束时的自动续跑（owner 2026-09-18 16:45 拍，起因：market-maker 15:50
 * 撞 UNKNOWN_CERTIFICATE_VERIFICATION_ERROR 回合静默终止，47 分钟没人接；该错误在其
 * 会话里 5 月起 33 次、当天 5 次）。
 *
 * 机制：jsonl-watcher 见到 `isApiErrorMessage:true` 的 assistant 条目 → 发 `api_error_turn`
 * 事件；bridge 记下时间。60s 内该 agent 没有任何新活动（自己又开始跑了 / 有人发了消息）
 * 就注一条「继续」；**最多一次**——续跑之后 10 分钟内再撞同类错误 ⇒ 不再续，升级到频道报错。
 * wedge watcher 盯的是「在动但不结束」，这里补的是「已结束但是被错误结束的」。
 * 纯逻辑，单测 tests/api-error-resume.test.ts。
 */
export interface ApiErrorState {
  errorAt: number;
  error: string;
  resumedAt?: number;
}

export const RESUME_DELAY_MS = 60_000;
/** 续跑后这么久内再撞错 ⇒ 升级；过了就当新一次 */
export const RESUME_WINDOW_MS = 10 * 60_000;

export type NoteResult = "track" | "escalate";

export function noteApiError(m: Map<string, ApiErrorState>, cid: string, error: string, now: number): NoteResult {
  const prev = m.get(cid);
  if (prev?.resumedAt !== undefined && now - prev.resumedAt < RESUME_WINDOW_MS) {
    m.delete(cid);
    return "escalate";
  }
  m.set(cid, { errorAt: now, error });
  return "track";
}

/** 该 agent 有了错误之后的新活动 ⇒ 不用续（还没续过才删；续过的留到窗口过期以便判「又撞」） */
export function noteActivity(m: Map<string, ApiErrorState>, cid: string, ts: number): void {
  const s = m.get(cid);
  if (!s) return;
  if (s.resumedAt === undefined && ts > s.errorAt) m.delete(cid);
}

export function dueForResume(m: Map<string, ApiErrorState>, now: number): string[] {
  const due: string[] = [];
  for (const [cid, s] of m) {
    if (s.resumedAt !== undefined) {
      if (now - s.resumedAt >= RESUME_WINDOW_MS) m.delete(cid);
      continue;
    }
    if (now - s.errorAt >= RESUME_DELAY_MS) due.push(cid);
  }
  return due;
}

export function markResumed(m: Map<string, ApiErrorState>, cid: string, now: number): void {
  const s = m.get(cid);
  if (s) s.resumedAt = now;
}

export function resumeText(error: string, errorAt: number): string {
  const hhmm = new Date(errorAt).toTimeString().slice(0, 5);
  return (
    `[⚠️ api-error-resume] 你 ${hhmm} 那一回合以 API 错误结束（${error || "API Error"}），不是你自己结束的，` +
    `之后 60 秒没有新活动。请从上一步接着做，不必复述已做的；如果确实没有未完的事，直接 end_turn。]`
  );
}
