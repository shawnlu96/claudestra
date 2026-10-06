/**
 * ACP 回合以不可重试的错误中止（acp-link 开「回合失败」卡那一支）：先记在这里，这一轮的 StopFailure 到了由 stop-settle 告诉
 * 开这一轮的请求方（notifyFailedTurn）。回程槽靠不住：它中途 reply 一句「开始审了」就把槽消化了，之后失败 caller 什么也收不到。
 * 只认这一轮开始之后记的（宿主起不来时报的失败不在任何一轮里，到 Stop 时按时刻丢掉）；同一个失败重报（同 key）只记一次。
 * tests/turn-failure-notice.test.ts
 */
export interface TurnFailure { key: string; message: string; label: string; agent: string; at: number }

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
  const head = answered
    ? `[⚠️ ${f.agent} 回过你之后，这一轮以不可重试的错误中止：你的请求没有被处理完，它先前那条回复不是最终结果。`
    : `[⚠️ ${f.agent} 这一轮以不可重试的错误中止：你的请求没有被处理。`;
  const tail = said ? `\n\n出错前它说的（不是完整答复）：\n${said}` : "";
  return `${head}失败原因（${f.label} 原文）：${message}]${tail}`;
}

/** drain 文字去掉宿主写进会话的那条错误（failureEntry 的 "API Error: <原文>"），剩下的才是它出错前说的话 */
export function spokenBefore(text: string | null, f: TurnFailure): string | undefined {
  return text?.replace(`API Error: ${f.message}`, "").trim() || undefined;
}
