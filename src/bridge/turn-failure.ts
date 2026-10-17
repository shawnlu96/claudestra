/**
 * ACP 回合以不可重试的错误中止（acp-link 开「回合失败」卡那一支）：先记在这里，这一轮的 StopFailure 到了由 stop-settle 告诉
 * 开这一轮的请求方（notifyFailedTurn）。回程槽靠不住：它中途 reply 一句「开始审了」就把槽消化了，之后失败 caller 什么也收不到。
 * 只认这一轮开始之后记的（宿主起不来时报的失败不在任何一轮里，到 Stop 时按时刻丢掉）；同一个失败重报（同 key）只记一次。
 * tests/turn-failure-notice.test.ts、tests/turn-failure-transient.test.ts
 */
import { onStreakEnd, type StreakOutcome } from "../lib/api-error-resume.js";
import { statePath } from "../lib/paths.js";
import { readJsonStateSync, reportCorrupt, writeJsonAtomicSync } from "../lib/state-file.js";
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
 * 收到「正在自动重试」的请求方：这一串续跑的结局到了（api-error-resume 的 onStreakEnd，升级 / 作废 / 被取消 / 撞额度撤掉 / 1 小时不再跟踪）
 * 补一句结局说明，恢复了就不打扰；之后已经答复过它的（回程槽被消化了 / 它给请求方发过请求）不再说「没处理完」。
 * 名单落盘：退避中 bridge 重启，结局照样补得上（推的通道由 stop-settle 每次结算时交来，重启后第一次 Stop 之前到的结局先排着）。
 * 结局先于登记到（宿主先写错误条目再报 Stop：升级那一轮的 api_error_turn 总早于 StopFailure）：刚结束的一串留 ENDED_KEEP_MS，
 * 晚到的登记属于这一串（请求在这一串开始前送到、失败时刻不晚于结局 SKEW_MS）才补发，已经处理过的请求方（handled）不再发；
 * 请求在这一串开始之后才送到的是新的一串，不拿旧结局串话。
 */
export interface RetryingCaller {
  agent: string;
  /** 告诉它「正在重试」的那次失败的时刻 */
  at: number;
  /** 它这条请求送到 target 的时刻：分清属于哪一串（续跑的几轮继承开头那一轮的） */
  askedAt: number;
  caller: string;
  callerName: string;
  replyTo?: string;
  /** 登记时回程槽还在：之后槽没了 = 已经答复过它 */
  slot: boolean;
  answered?: boolean;
}
/** 推结局说明、查回程槽还在不在（bridge 的依赖，stop-settle 交来） */
export interface RetryPort {
  notify(cid: string, r: RetryingCaller, body: string): Promise<unknown>;
  slotGone(cid: string, r: RetryingCaller): boolean;
}

const RETRYING_PATH = statePath("turn-failure-retrying.json");
const LATE_MS = 60_000;
const ENDED_KEEP_MS = 3 * 60_000;
const SKEW_MS = 5_000;
let retrying: Map<string, RetryingCaller[]> | null = null;
/** 刚结束的一串：handled = 已经对它们处理过结局的请求方（推过、或判为答复过） */
const ended = new Map<string, { end: StreakOutcome | null; at: number; since: number; seen: number; handled: Set<string> }>();
let port: RetryPort | null = null;
const unsent: (() => void)[] = [];

const isCaller = (v: unknown): boolean => {
  const r = v as RetryingCaller;
  return !!r && typeof r === "object" && typeof r.agent === "string" && typeof r.caller === "string" && typeof r.callerName === "string"
    && Number.isFinite(r.at) && Number.isFinite(r.askedAt) && typeof r.slot === "boolean";
};
function book(): Map<string, RetryingCaller[]> {
  if (retrying) return retrying;
  const r = readJsonStateSync(RETRYING_PATH, (d) => !!d && typeof d === "object" && !Array.isArray(d));
  if (r.status === "corrupt") reportCorrupt(RETRYING_PATH, r.error, "turn-failure-retrying", false);
  const entries = Object.entries(r.status === "ok" ? (r.data as Record<string, unknown>) : {});
  retrying = new Map(entries.map(([cid, list]) => [cid, Array.isArray(list) ? (list.filter(isCaller) as RetryingCaller[]) : []]));
  return retrying;
}
function save(): void {
  try {
    writeJsonAtomicSync(RETRYING_PATH, Object.fromEntries(book()));
  } catch (e) {
    console.error(`⚠️ 「正在重试」的请求方名单落盘失败（内存里还在，bridge 重启会丢）：${(e as Error).message}`);
  }
}

const finalNotice = (agent: string, end: StreakOutcome): string => end.failed
  ? `[⛔ ${agent} 网络类错误的自动重试没救回来，你的请求没有被处理完：${end.why}]`
  : `[ℹ️ ${agent} 的自动重试停了：${end.why}。结果以它之后的答复为准，没等到再重派。]`;

function finish(cid: string, r: RetryingCaller, end: StreakOutcome): void {
  const go = (p: RetryPort): void => {
    // 登记时的槽都记了「等续跑」（stop-settle markApiError），槽没了只有两条路：被答复消化，或 onExpired 已经推了结局（kill / 2 小时扫掉）
    if (r.answered || p.slotGone(cid, r)) return void console.log(`🤫 ${r.agent} 的自动重试结束，${r.callerName} 之后已经收到过答复，不再补结局说明`);
    void p.notify(cid, r, finalNotice(r.agent, end)).catch((e: Error) => console.error(`⚠️ ${cid} 自动重试的结局说明没推到 ${r.callerName}：${e.message}`));
  };
  if (port) go(port);
  else unsent.push(() => go(port!));
}

/** stop-settle 每次结算时调：交来推送通道，排着的结局说明顺带推掉 */
export function useRetryPort(p: RetryPort): void {
  port = p;
  for (const f of unsent.splice(0)) f();
}

/** 刚结束的那一串（这次失败属于它的话）；否则 undefined */
function endedFor(cid: string, askedAt: number, failedAt: number, now: number) {
  const e = ended.get(cid);
  return e && now - e.seen < ENDED_KEEP_MS && askedAt <= e.since && failedAt <= e.at + SKEW_MS ? e : undefined;
}

/** 这位请求方这条请求已经在这一串里（登记过，或这一串刚结束、已处理过它）：续跑的几轮和升级那一轮不再说「正在重试」 */
export function retryingKnown(cid: string, caller: string, askedAt: number, failedAt: number, now = Date.now()): boolean {
  return !!book().get(cid)?.some((r) => r.caller === caller && r.askedAt >= askedAt) || !!endedFor(cid, askedAt, failedAt, now)?.handled.has(caller);
}

export function noteRetryingCaller(cid: string, r: RetryingCaller, now = Date.now()): void {
  const e = endedFor(cid, r.askedAt, r.at, now);
  if (e) {
    if (e.end && !e.handled.has(r.caller)) finish(cid, r, e.end);
    e.handled.add(r.caller);
    return;
  }
  const list = book().get(cid) ?? [];
  if (list.some((x) => x.caller === r.caller && x.askedAt >= r.askedAt)) return; // 同一条请求一串只登记一次
  book().set(cid, [...list.filter((x) => x.caller !== r.caller), r]); // 同一请求方的更早一条请求：换成这条
  save();
}

/** target 给 caller 发了请求（send_to_agent，不含 bridge 推的说明）：算答复过它，这一串没救回来也不再说「没处理完」 */
export function noteCallerAnswered(target: string, caller: string, at: number): void {
  const list = book().get(target);
  if (!list?.some((r) => r.caller === caller && !r.answered && at > r.at)) return;
  book().set(target, list.map((r) => (r.caller === caller && at > r.at ? { ...r, answered: true } : r)));
  save();
}

onStreakEnd((cid, end, since, now) => {
  const list = (book().get(cid) ?? []).filter((r) => r.at >= since - LATE_MS); // 更早那串留下的不算这一串
  if (book().delete(cid)) save();
  ended.set(cid, { end, at: now, since, seen: Date.now(), handled: new Set(list.map((r) => r.caller)) });
  if (end) for (const r of list) finish(cid, r, end);
});
