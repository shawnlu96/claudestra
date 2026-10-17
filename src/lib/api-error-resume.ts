/**
 * 回合以 API 错误结束时的自动续跑（owner 2026-09-18 16:45 拍，起因：market-maker 15:50
 * 撞 UNKNOWN_CERTIFICATE_VERIFICATION_ERROR 回合静默终止，47 分钟没人接；该错误在其
 * 会话里 5 月起 33 次、当天 5 次）。规则与预算：docs/architecture/api-error-resume.md。
 *
 * 机制：jsonl-watcher 见到 `isApiErrorMessage:true` 的 assistant 条目 → 发 `api_error_turn`
 * 事件；bridge 记下时间。等一段时间该 agent 没有任何新活动（自己又开始跑了 / 有人发了消息）就注一条「继续」。
 * - 网络 / 服务端瞬时错误（transient-error.ts）：按 TRANSIENT_BACKOFF_MS 退避续跑（1、2、4、8 分钟），期间不报；
 *   第 5 次再撞才升级到频道、报一次。续跑后正常结束一个回合（stop-settle → channelTurnOk → noteTurnOk）= 清零（续跑后 1 小时没动静才丢）。
 * - 其它错误：60s 后续跑**一次**——续跑之后 10 分钟内再撞同类错误 ⇒ 不再续，升级到频道报错。
 * wedge watcher 盯的是「在动但不结束」，这里补的是「已结束但是被错误结束的」。
 * 纯逻辑，单测 tests/api-error-resume.test.ts、tests/api-error-resume-transient.test.ts。
 */
import { overloadEscalate } from "./agent-supervisor-bridge.js";
import { statePath } from "./paths.js";
import { readJsonStateSync, reportCorrupt, writeJsonAtomicSync } from "./state-file.js";
import { isTransientError, TRANSIENT_BACKOFF_MS } from "./transient-error.js";
export { noteOverload } from "./agent-supervisor-bridge.js"; // 给 quota-wall-wiring 用：它的单测按本模块的导出注入依赖

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
  /** 撞错那一轮是谁开的（stop-settle 的来源记录）：退避中重启后，续跑消息开的一轮照它继承，答复才推得回请求方 */
  source?: ResumeSource;
}

export interface ResumeSource { who: string; callers: string[]; askers: string[]; askedAt?: Record<string, number> }

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNetStreak = (v: unknown): boolean => {
  const n = v as NetStreak;
  return !!n && typeof n === "object" && Number.isInteger(n.n) && n.n >= 0 && n.n <= TRANSIENT_BACKOFF_MS.length && num(n.since) && typeof n.last === "string";
};
const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
const isSource = (v: unknown): boolean => {
  const s = v as ResumeSource;
  return !!s && typeof s === "object" && typeof s.who === "string" && strings(s.callers) && strings(s.askers)
    && (s.askedAt === undefined || (!!s.askedAt && typeof s.askedAt === "object" && Object.values(s.askedAt).every(num)));
};
/** 每个字段都核：net / resumedAt 坏了这条就永不到期、之后的网络错误永远静默（第 2 轮 P2-3） */
const isApiErrorState = (v: unknown): boolean => {
  const s = v as ApiErrorState;
  return !!s && typeof s === "object" && num(s.errorAt) && typeof s.error === "string" && (s.resumedAt === undefined || num(s.resumedAt))
    && (s.net === undefined || isNetStreak(s.net)) && (s.agent === undefined || typeof s.agent === "string") && (s.source === undefined || isSource(s.source))
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

/** 陈旧的（撞错已过 STALE_RESUME_MS 还没续）照样读回：由投续跑前那道检查（dropStale）丢，顺带告诉收到过「正在自动重试」的请求方 */
export function loadResumeStates(path = RESUME_STATES_PATH): Map<string, ApiErrorState> {
  const r = readJsonStateSync(path, isStateFile);
  if (r.status === "corrupt") reportCorrupt(path, r.error, "api-error-resume", false);
  const m = new Map<string, ApiErrorState>();
  for (const [cid, s] of Object.entries(r.status === "ok" ? (r.data as Record<string, unknown>) : {})) {
    if (!isApiErrorState(s)) console.error(`🚨 API 错误续跑计划 ${cid} 字段坏了，丢掉：${JSON.stringify(s).slice(0, 200)}`);
    else m.set(cid, s as ApiErrorState);
  }
  return m;
}

const savedJson = new Map<string, string>();
/** 同一个落盘错误（按错误码；原文里带递增的临时文件名，每次都不同）这么久只记一行：写不进时每个事件、每 15 秒一拍都会再试一次 */
export const SAVE_ERROR_LOG_GAP_MS = 10 * 60_000;
const saveErrorLogged = new Map<string, { kind: string; at: number }>();
/** 和上次落的一样就不写；写失败只记日志（内存里还在，只是重启会丢），同一错误节流 */
export function saveResumeStates(m: Map<string, ApiErrorState>, path = RESUME_STATES_PATH, now = Date.now()): void {
  const json = JSON.stringify(Object.fromEntries(m));
  if (savedJson.get(path) === json) return;
  try {
    writeJsonAtomicSync(path, JSON.parse(json));
    savedJson.set(path, json);
    saveErrorLogged.delete(path);
  } catch (e) {
    const message = (e as Error).message;
    const kind = (e as NodeJS.ErrnoException).code ?? message;
    const last = saveErrorLogged.get(path);
    if (last?.kind === kind && now - last.at < SAVE_ERROR_LOG_GAP_MS) return;
    saveErrorLogged.set(path, { kind, at: now });
    console.error(`🚨 API 错误续跑计划落盘失败（内存里还在，bridge 重启会丢；同一错误 ${SAVE_ERROR_LOG_GAP_MS / 60_000} 分钟内不再记）: ${message}`);
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

/** 续跑计划怎么没的：failed = 没救回来（请求没处理完），否则只是 bridge 不再替它续（结果看它之后的答复）；why = 给请求方的原因 */
export interface StreakOutcome { failed: boolean; why: string }
/** 一串续跑的结局（null = 恢复了）：turn-failure 据此给先前收到「正在自动重试」的请求方补一句结局说明 */
type StreakEnd = (cid: string, end: StreakOutcome | null, since: number, now: number) => void;
let streakEnd: StreakEnd = () => {};
export const onStreakEnd = (cb: StreakEnd): void => void (streakEnd = cb);

/** 删掉这个频道的续跑计划并报结局（没有计划就什么都不做）。计划在哪条路上没的都经它，请求方才不会只收到「正在重试」 */
export function endStreak(m: Map<string, ApiErrorState>, cid: string, now: number, end: StreakOutcome | null): ApiErrorState | undefined {
  const s = m.get(cid);
  if (!s) return undefined;
  m.delete(cid);
  streakEnd(cid, end, s.net?.since ?? s.errorAt, now);
  return s;
}

/** stop-settle 在 cid 每个正常结束的回合调：不看有没有卡要关、registry 里有没有它、有没有 ledger 库（master 也算）。quota-wall-wiring 据此 noteTurnOk */
type TurnOk = (cid: string, at: number) => void;
let turnOk: TurnOk = () => {};
export const onChannelTurnOk = (cb: TurnOk): void => void (turnOk = cb);
export const channelTurnOk = (cid: string, at: number): void => turnOk(cid, at);

/** 撞错那一轮的来源跟着续跑计划落盘：stop-settle 在以 API 错误结束的一轮记下（noteResumeSource），重启后查不到内存记录时读回（resumeSourceOf） */
type SourceHook = { save(cid: string, src: ResumeSource): void; get(cid: string): ResumeSource | undefined };
let sourceHook: SourceHook = { save: () => {}, get: () => undefined };
export const onResumeSource = (h: SourceHook): void => void (sourceHook = h);
export const noteResumeSource = (cid: string, src: ResumeSource): void => sourceHook.save(cid, src);
export const resumeSourceOf = (cid: string): ResumeSource | undefined => sourceHook.get(cid);

export type NoteResult = "track" | "escalate";

/** error = 错误码（CC）或失败原文（ACP）；text = 条目里那句原文（判网络类、报错时引用） */
export function noteApiError(m: Map<string, ApiErrorState>, cid: string, error: string, now: number, text = ""): NoteResult {
  const prev = m.get(cid);
  const r = isTransientError(`${error}\n${text}`) ? noteTransient(m, cid, prev, error, firstLine(text) || error, now) : noteOther(m, cid, prev, error, now);
  if (r === "escalate") streakEnd(cid, { failed: true, why: giveUpText(prev, error, text) }, prev?.net?.since ?? now, now);
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
  return endStreak(m, cid, ts, { failed: false, why: "它之后又有了新活动（有人发了消息 / 它自己接着跑），bridge 不再替它续跑" });
}

/** 续跑后正常结束了一个回合（Stop 且不是 API 错误）：网络类连败清零。别的错误照旧按窗口判「又撞」 */
export function noteTurnOk(m: Map<string, ApiErrorState>, cid: string, at: number): void {
  const s = m.get(cid);
  if (!s?.net || s.resumedAt === undefined || at <= s.resumedAt) return;
  endStreak(m, cid, at, null);
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
      if (now - s.resumedAt >= (s.net ? STREAK_IDLE_MS : RESUME_WINDOW_MS)) endStreak(m, cid, now, s.net ? IDLE_END : null); // 非网络类过了窗口 = 续过没再撞
      continue;
    }
    if (now - s.errorAt >= resumeDelayMs(s)) due.push(cid);
  }
  return due;
}

const IDLE_END: StreakOutcome = { failed: false, why: "续跑后 1 小时既没再撞、也没等到它正常结束这一轮（回合被打断 / 窗口没了），bridge 不再跟踪" };

export function markResumed(m: Map<string, ApiErrorState>, cid: string, now: number): void {
  const s = m.get(cid);
  if (s) m.set(cid, { ...s, resumedAt: now, ...(s.net ? { net: { ...s.net, n: s.net.n + 1 } } : {}) });
}

/** 非网络类到点没连着：从本进程第一次看到它没连着起留这么久等它重连（bridge 刚重启时 agent 按退避连回，最长约 60 秒一次），过了只记日志 */
export const OFFLINE_GRACE_MS = 3 * 60_000;

/**
 * 到点要续跑而 agent 没连着。网络类、agent 还在 registry 的（kept；master 算在）：留着等它连回来，撞错满 STALE_RESUME_MS 还没连上就作废、
 * 返回频道那句的原因（报一次）。非网络类静默等 OFFLINE_GRACE_MS，过了只记日志；已经收掉的当场丢、不往频道报（频道多半已经没人看）。其余返回 null
 */
export function dropOffline(m: Map<string, ApiErrorState>, cid: string, now: number, kept = true, offlineAt = now): string | null {
  const s = m.get(cid);
  if (!s) return null;
  if (!kept) {
    endStreak(m, cid, now, s.net ? { failed: true, why: "它已经被收掉（不在 agent 名单里），续跑作废" } : null);
    return null;
  }
  if (!s.net) {
    if (now - offlineAt < OFFLINE_GRACE_MS) return null;
    endStreak(m, cid, now, null);
    console.log(`🗑 API 错误续跑 ${cid}：到点要续时它没连着，又等了 ${OFFLINE_GRACE_MS / 60_000} 分钟仍没连上 bridge，不再续`);
    return null;
  }
  if (now - s.errorAt < STALE_RESUME_MS) return null;
  const why = `${hhmm(s.errorAt)} 那一回合以 API 错误结束（${s.net.last}），到点要续跑时它一直没连上 bridge（${Math.round((now - s.errorAt) / 60_000)} 分钟），` +
    "续跑作废。需要人看一眼它的窗口后手动发一句继续。";
  endStreak(m, cid, now, { failed: true, why });
  return why;
}

/**
 * 投续跑前的陈旧检查（每次投都查，不只开机读回时）：撞错已过 STALE_RESUME_MS 还没续 = 机器睡了很久 / bridge 停过机，
 * 它接着做的多半已经不是现在要的，不投「继续」。丢掉时返回 true（只记日志，和开机读回丢掉时一样不往频道报）
 */
export function dropStale(m: Map<string, ApiErrorState>, cid: string, now: number): boolean {
  const s = m.get(cid);
  if (!s || s.resumedAt !== undefined || now - s.errorAt < STALE_RESUME_MS) return false;
  const mins = Math.round((now - s.errorAt) / 60_000);
  endStreak(m, cid, now, { failed: true, why: `${hhmm(s.errorAt)} 撞错后 ${mins} 分钟才轮到续跑（机器睡眠 / bridge 停机），续跑作废，不投陈旧的「继续」` });
  console.log(`🗑 API 错误续跑计划 ${cid} 撞错已过 ${mins} 分钟，不再续`);
  return true;
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
