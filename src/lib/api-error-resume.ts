/**
 * 回合以 API 错误结束时的自动续跑（owner 2026-09-18 16:45 拍，起因：market-maker 15:50
 * 撞 UNKNOWN_CERTIFICATE_VERIFICATION_ERROR 回合静默终止，47 分钟没人接；该错误在其
 * 会话里 5 月起 33 次、当天 5 次）。规则与预算：docs/architecture/api-error-resume.md。
 *
 * 机制：jsonl-watcher 见到 `isApiErrorMessage:true` 的 assistant 条目 → 发 `api_error_turn`
 * 事件；bridge 记下时间。等一段时间该 agent 没有任何新活动（自己又开始跑了 / 有人发了消息）就注一条「继续」。
 * - 网络 / 服务端瞬时错误（transient-error.ts）：按 TRANSIENT_BACKOFF_MS 退避续跑（1、2、4、8 分钟），期间不报；
 *   第 5 次再撞才升级到频道、报一次。续跑后正常结束一个回合（noteTurnOk）= 清零（续跑后 1 小时没动静才丢）。
 * - 其它错误：60s 后续跑**一次**——续跑之后 10 分钟内再撞同类错误 ⇒ 不再续，升级到频道报错。
 * wedge watcher 盯的是「在动但不结束」，这里补的是「已结束但是被错误结束的」。
 * 纯逻辑，单测 tests/api-error-resume.test.ts、tests/api-error-resume-transient.test.ts。
 */
import { overloadEscalate } from "./agent-supervisor-bridge.js";
import { statePath } from "./paths.js";
import { readJsonStateSync, reportCorrupt, writeJsonAtomicSync } from "./state-file.js";
import { isTransientError, TRANSIENT_BACKOFF_MS } from "./transient-error.js";
export { noteOverload, onTurnOk } from "./agent-supervisor-bridge.js"; // 给 quota-wall-wiring 用：它的单测按本模块的导出注入依赖

/** 网络类连败：n = 这一串已经续过几次，since = 第一次撞的时刻，last = 最后一次的原文 */
export interface NetStreak {
  n: number;
  since: number;
  last: string;
}

export interface ApiErrorState {
  errorAt: number;
  error: string;
  resumedAt?: number;
  net?: NetStreak;
  /** 哪个 agent（bridge 落盘用：重启后到期续跑、交给闸、按名清零都要它） */
  agent?: string;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNetStreak = (v: unknown): boolean => {
  const n = v as NetStreak;
  return !!n && typeof n === "object" && Number.isInteger(n.n) && n.n >= 0 && n.n <= TRANSIENT_BACKOFF_MS.length && num(n.since) && typeof n.last === "string";
};
/** 每个字段都核：net / resumedAt 坏了这条就永不到期、之后的网络错误永远静默（第 2 轮 P2-3） */
const isApiErrorState = (v: unknown): boolean => {
  const s = v as ApiErrorState;
  return !!s && typeof s === "object" && num(s.errorAt) && typeof s.error === "string" && (s.resumedAt === undefined || num(s.resumedAt))
    && (s.net === undefined || isNetStreak(s.net)) && (s.agent === undefined || typeof s.agent === "string")
    && !(s.net?.n === TRANSIENT_BACKOFF_MS.length && s.resumedAt === undefined); // n=4 只会出现在第 4 次续跑之后：没续过却 n=4 = 坏数据（否则退避间隔取不到、永不到期）
};
const isStateFile = (d: unknown): boolean => !!d && typeof d === "object" && !Array.isArray(d);

/**
 * 续跑计划落盘：网络类退避单步最长 8 分钟、整串约 15 分钟，期间 bridge 重启（beta 自动更新挑的正是全员空闲）丢了它，
 * ACP agent 不开卡就静默停住。读回来到点照续、次数接着数。坏文件不恢复、只报一次（不能让 bridge 起不来）；坏的单条丢掉记日志
 */
export const RESUME_STATES_PATH = statePath("api-error-resume.json");
/** 撞错后这么久还没续上的计划作废：开机不投陈旧的「继续」（停机一夜后它接着做的多半已经不是现在要的），等不回来的 agent 也到此为止 */
export const STALE_RESUME_MS = 30 * 60_000;

export function loadResumeStates(path = RESUME_STATES_PATH, now = Date.now()): Map<string, ApiErrorState> {
  const r = readJsonStateSync(path, isStateFile);
  if (r.status === "corrupt") reportCorrupt(path, r.error, "api-error-resume", false);
  const m = new Map<string, ApiErrorState>();
  for (const [cid, s] of Object.entries(r.status === "ok" ? (r.data as Record<string, unknown>) : {})) {
    if (!isApiErrorState(s)) console.error(`🚨 API 错误续跑计划 ${cid} 字段坏了，丢掉：${JSON.stringify(s).slice(0, 200)}`);
    else if ((s as ApiErrorState).resumedAt === undefined && now - (s as ApiErrorState).errorAt >= STALE_RESUME_MS) {
      console.log(`🗑 API 错误续跑计划 ${cid} 撞错已过 ${Math.round((now - (s as ApiErrorState).errorAt) / 60_000)} 分钟，不再续`);
    } else m.set(cid, s as ApiErrorState);
  }
  return m;
}

const savedJson = new Map<string, string>();
/** 和上次落的一样就不写；写失败只记日志（内存里还在，只是重启会丢） */
export function saveResumeStates(m: Map<string, ApiErrorState>, path = RESUME_STATES_PATH): void {
  const json = JSON.stringify(Object.fromEntries(m));
  if (savedJson.get(path) === json) return;
  try {
    writeJsonAtomicSync(path, JSON.parse(json));
    savedJson.set(path, json);
  } catch (e) {
    console.error(`🚨 API 错误续跑计划落盘失败（内存里还在，bridge 重启会丢）: ${(e as Error).message}`);
  }
}

export const RESUME_DELAY_MS = 60_000;
/** 续跑后这么久内再撞错 ⇒ 升级；过了就当新一次（网络类不看它，见 STREAK_IDLE_MS） */
export const RESUME_WINDOW_MS = 10 * 60_000;
/**
 * 网络类连败只靠正常结束一个回合清零：黑洞式断网每轮要等 10 分钟以上的超时才失败，按 10 分钟窗口算会每次都当新一串、永不升级。
 * 续跑后这么久既没撞错也没正常结束（agent 没了 / 回合被打断）才丢掉这串
 */
export const STREAK_IDLE_MS = 60 * 60_000;

/** 一串续跑的结局（text = 升级正文；null = 恢复了）：turn-failure 据此给先前收到「正在自动重试」的请求方补最终说明 */
type StreakEnd = (cid: string, text: string | null, since: number, now: number) => void;
let streakEnd: StreakEnd = () => {};
export const onStreakEnd = (cb: StreakEnd): void => void (streakEnd = cb);

export type NoteResult = "track" | "escalate";

/** error = 错误码（CC）或失败原文（ACP）；text = 条目里那句原文（判网络类、报错时引用） */
export function noteApiError(m: Map<string, ApiErrorState>, cid: string, error: string, now: number, text = ""): NoteResult {
  const prev = m.get(cid);
  const r = isTransientError(`${error}\n${text}`) ? noteTransient(m, cid, prev, error, firstLine(text) || error, now) : noteOther(m, cid, prev, error, now);
  if (r === "escalate") streakEnd(cid, giveUpText(prev, error, text), prev?.net?.since ?? now, now);
  return r;
}

function noteOther(m: Map<string, ApiErrorState>, cid: string, prev: ApiErrorState | undefined, error: string, now: number): NoteResult {
  if (overloadEscalate(cid, now, prev, RESUME_WINDOW_MS, undefined, undefined, error)) {
    m.delete(cid);
    return "escalate";
  }
  m.set(cid, { errorAt: now, error });
  return "track";
}

const firstLine = (s: string): string => s.split("\n")[0].trim().slice(0, 300);

/**
 * 网络类：上一次续过、还没正常结束一个回合又撞 = 同一串，次数接着数（不论隔多久）；续跑还没发出去又撞 = 同一次，只更新原文、重新计时。
 * 4 次续跑用完（或监护对象这件活的续跑次数用完）⇒ escalate，记录删掉：下次再撞是新的一串。
 */
function noteTransient(m: Map<string, ApiErrorState>, cid: string, prev: ApiErrorState | undefined, error: string, last: string, now: number): NoteResult {
  const pending = prev?.net && prev.resumedAt === undefined;
  if (pending) {
    m.set(cid, { ...prev, errorAt: now, error, net: { ...prev.net!, last } });
    return "track";
  }
  const live = prev?.net;
  const n = live?.n ?? 0;
  if (n >= TRANSIENT_BACKOFF_MS.length || overloadEscalate(cid, now, undefined, RESUME_WINDOW_MS, undefined, undefined, `${error}\n${last}`)) {
    m.delete(cid);
    return "escalate";
  }
  m.set(cid, { errorAt: now, error, net: { n, since: live?.since ?? now, last } });
  return "track";
}

/** 这一条离撞错多久该续 */
export const resumeDelayMs = (s: ApiErrorState): number => (s.net ? TRANSIENT_BACKOFF_MS[s.net.n] : RESUME_DELAY_MS);

/**
 * 错误条目自己会在同一次 watcher 扫描里连带发出 assistant_text（那句 "API Error: …"）
 * 与 agent_status:thinking（isPostTurnActivity 把新 assistant 条目当「活着」）——它们的
 * 时间戳只比 api_error_turn 晚几毫秒。2026-09-18 17:22/17:29 实测两次都被这样删掉、
 * 续跑一次没触发。所以错误后这段宽限内的活动不算。
 */
export const ACTIVITY_GRACE_MS = 3_000;

/** 该 agent 有了错误之后的新活动 ⇒ 不用续（还没续过才删；续过的留到窗口过期以便判「又撞」）。返回被取消的那条（没取消 = undefined） */
export function noteActivity(m: Map<string, ApiErrorState>, cid: string, ts: number): ApiErrorState | undefined {
  const s = m.get(cid);
  if (!s || s.resumedAt !== undefined || ts <= s.errorAt + ACTIVITY_GRACE_MS) return undefined;
  m.delete(cid);
  return s;
}

/** 续跑后正常结束了一个回合（Stop 且不是 API 错误）：网络类连败清零。别的错误照旧按窗口判「又撞」 */
export function noteTurnOk(m: Map<string, ApiErrorState>, cid: string, at: number): void {
  const s = m.get(cid);
  if (!s?.net || s.resumedAt === undefined || at <= s.resumedAt) return;
  m.delete(cid);
  streakEnd(cid, null, s.net.since, at);
}

/** 哪些事件算「它又动了」：错误条目自己的那句 "API Error: …" / 撞额度原文（rateLimited）不算 */
export function countsAsActivity(type: string, data: Record<string, unknown>): boolean {
  if (type === "tool_start" || type === "chat_message") return true;
  if (type === "agent_status") return (data as { status?: unknown }).status === "thinking";
  if (type === "assistant_text") return data.rateLimited !== true && !String((data as { text?: unknown }).text ?? "").startsWith("API Error");
  return false;
}

export function dueForResume(m: Map<string, ApiErrorState>, now: number): string[] {
  const due: string[] = [];
  for (const [cid, s] of m) {
    if (s.resumedAt !== undefined) {
      if (now - s.resumedAt >= (s.net ? STREAK_IDLE_MS : RESUME_WINDOW_MS)) m.delete(cid);
      continue;
    }
    if (now - s.errorAt >= resumeDelayMs(s)) due.push(cid);
  }
  return due;
}

export function markResumed(m: Map<string, ApiErrorState>, cid: string, now: number): void {
  const s = m.get(cid);
  if (s) m.set(cid, { ...s, resumedAt: now, ...(s.net ? { net: { ...s.net, n: s.net.n + 1 } } : {}) });
}

/**
 * 到点要续跑而 agent 没连着（重启后没连回来 / 窗口没了）：留着等它，撞错满 STALE_RESUME_MS 还没连上就作废、在频道报一次。
 * 没到时候返回 null；作废时删掉这条、返回频道那句的原因
 */
export function dropOffline(m: Map<string, ApiErrorState>, cid: string, now: number): string | null {
  const s = m.get(cid);
  if (!s || now - s.errorAt < STALE_RESUME_MS) return null;
  m.delete(cid);
  const why = `${hhmm(s.errorAt)} 那一回合以 API 错误结束（${s.net?.last ?? s.error}），到点要续跑时它一直没连上 bridge（${Math.round((now - s.errorAt) / 60_000)} 分钟），` +
    "续跑作废。需要人看一眼它的窗口后手动发一句继续。";
  streakEnd(cid, why, s.net?.since ?? s.errorAt, now);
  return why;
}

const hhmm = (t: number): string => new Date(t).toTimeString().slice(0, 5);
const waitText = (ms: number): string => (ms < 120_000 ? `${ms / 1000} 秒` : `${ms / 60_000} 分钟`);

export function resumeText(error: string, errorAt: number, delayMs = RESUME_DELAY_MS): string {
  return (
    `[⚠️ api-error-resume] 你 ${hhmm(errorAt)} 那一回合以 API 错误结束（${error || "API Error"}），不是你自己结束的，` +
    `之后 ${waitText(delayMs)}没有新活动。请从上一步接着做，不必复述已做的；如果确实没有未完的事，直接 end_turn。]`
  );
}

/** 升级时频道里那句的原因。before = 这次撞错前的记录（网络类连败的次数与起点在它上面）；不是网络类连败照旧那句 */
export function giveUpText(before: ApiErrorState | undefined, error: string, text: string): string {
  const last = (firstLine(text) || error || "API Error").replace(/^API Error: /, "").replace(/[。.]+$/, "");
  if (!isTransientError(`${error}\n${text}`)) {
    return `连续两次因 API 错误中断（自动续跑一次已用完，不再续）：${error || "API Error"}。需要人看一眼网络/代理后手动发一句继续。`;
  }
  const tail = `最后一次：${last}。需要人看一眼网络/代理后手动发一句继续。`;
  if (!before?.net) return `网络类错误，这件活的自动续跑次数已用完（不再续），${tail}`; // 监护对象：次数按整件活数，早于这一串就用完了
  return `连续 ${before.net.n + 1} 次网络类错误（${hhmm(before.net.since)} 起，自动续跑 ${before.net.n} 次已用完，不再续），${tail}`;
}
