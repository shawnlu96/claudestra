/**
 * ACP 回合以不可重试的错误中止（acp-link 开「回合失败」卡那一支）：先记在这里，这一轮的 StopFailure 到了由 stop-settle 告诉
 * 开这一轮的请求方（notifyFailedTurn）。回程槽靠不住：它中途 reply 一句「开始审了」就把槽消化了，之后失败 caller 什么也收不到。
 * 只认这一轮开始之后记的（宿主起不来时报的失败不在任何一轮里，到 Stop 时按时刻丢掉）；同一个失败重报（同 key）只记一次。
 * tests/turn-failure-notice.test.ts、tests/turn-failure-transient.test.ts
 */
import { onStreakEnd } from "../lib/api-error-resume.js";
import { TRANSIENT_BACKOFF_MS } from "../lib/transient-error.js";

/** retrying = 网络类：bridge 会按退避自动续跑（api-error-resume.ts），先说「正在重试」，用完再补最终说明 */
export interface TurnFailure { key: string; message: string; label: string; agent: string; at: number; retrying?: boolean }

const pending = new Map<string, TurnFailure>();
const lastKey = new Map<string, string>();
/** 原文太长时截到这么多字：cyber_policy 那句约 330 字，够放下各家的原文 */
const MESSAGE_CAP = 1000;

export function noteTurnFailure(cid: string, f: Omit<TurnFailure, "at">, now = Date.now()): void {
  if (lastKey.get(cid) === f.key) return;
  lastKey.set(cid, f.key);
  pending.set(cid, { ...f, at: now });
}

/** 这个频道的一轮收尾时取走记下的失败（不管用不用，取了就清）；since = 这一轮开始的时刻，在它之前记的不算这一轮的 */
export function takeTurnFailure(cid: string, since: number): TurnFailure | undefined {
  const f = pending.get(cid);
  pending.delete(cid);
  return f && f.at >= since ? f : undefined;
}

/** 推给请求方的那一条。answered = 它的回程已经被这一轮更早的回复消化了（那句多半只是「收到 / 开始做」） */
export function turnFailureNotice(f: TurnFailure, answered: boolean, said?: string): string {
  const message = f.message.length > MESSAGE_CAP ? `${f.message.slice(0, MESSAGE_CAP)}…` : f.message;
  const retry = `bridge 正在自动重试（最多 ${TRANSIENT_BACKOFF_MS.length} 次，约 ${TRANSIENT_BACKOFF_MS.reduce((a, b) => a + b, 0) / 60_000} 分钟），先别重派；重试用完仍失败会再告诉你。`;
  const head = f.retrying
    ? `[⚠️ ${f.agent} ${answered ? "回过你之后，" : ""}这一轮因网络类错误中断：${retry}${answered ? "它先前那条回复不是最终结果。" : ""}`
    : answered
    ? `[⚠️ ${f.agent} 回过你之后，这一轮以不可重试的错误中止：你的请求没有被处理完，它先前那条回复不是最终结果。`
    : `[⚠️ ${f.agent} 这一轮以不可重试的错误中止：你的请求没有被处理。`;
  const tail = said ? `\n\n出错前它说的（不是完整答复）：\n${said}` : "";
  return `${head}失败原因（${f.label} 原文）：${message}]${tail}`;
}

/** drain 文字去掉宿主写进会话的那条错误（failureEntry 的 "API Error: <原文>"），剩下的才是它出错前说的话 */
export function spokenBefore(text: string | null, f: TurnFailure): string | undefined {
  return text?.replace(`API Error: ${f.message}`, "").trim() || undefined;
}

/**
 * 收到「正在自动重试」的请求方：这一串续跑的结局到了（api-error-resume 的 onStreakEnd）补一条最终说明，恢复了就不打扰。
 * 结局可能先于登记到（acp_failure / api_error_turn / StopFailure 三路先后不定）：刚结束的一串留 LATE_MS，晚到的登记当场补发。
 */
const LATE_MS = 60_000;
type Retrying = { agent: string; at: number; send: (body: string) => Promise<unknown> };
const retrying = new Map<string, Retrying[]>();
const ended = new Map<string, { text: string; at: number }>();

const finalFailureNotice = (agent: string, why: string): string => `[⛔ ${agent} 网络类错误的自动重试没救回来，你的请求没有被处理完：${why}]`;

const sendFinal = (r: Retrying, why: string, cid: string): void =>
  void r.send(finalFailureNotice(r.agent, why)).catch((e: Error) => console.error(`⚠️ ${cid} 重试用完的最终说明没推到请求方：${e.message}`));

export function noteRetryingCaller(cid: string, agent: string, send: Retrying["send"], now = Date.now()): void {
  const r = { agent, at: now, send };
  const e = ended.get(cid);
  if (e && now - e.at < LATE_MS) return sendFinal(r, e.text, cid);
  retrying.set(cid, [...(retrying.get(cid) ?? []), r]);
}

onStreakEnd((cid, text, since, now) => {
  const list = (retrying.get(cid) ?? []).filter((r) => r.at >= since - LATE_MS); // 更早那串留下的（被人接手 / 撞额度撤掉的）不算这一串
  retrying.delete(cid);
  if (text === null) return void ended.delete(cid);
  ended.set(cid, { text, at: now });
  for (const r of list) sendFinal(r, text, cid);
});
