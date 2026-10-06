/**
 * 回合失败的结构化识别（ACP 下不再停在 Codex 的菜单上，失败就是 session/prompt 的结果）。适配器按客户端声明分两种给法：
 * - 声明了 JetBrains AIR 扩展 sessionFailure：prompt 以 end_turn 返回，_meta.jetbrains.air.sessionFailure 带
 *   {id, revision, category, severity, title, actions}。同一个失败横幅 id 不变、revision 递增 → 按 id 去重。
 *   没有 codexErrorInfo，种类只能按适配器的策略表认（CodexEventHandler.ts SESSION_FAILURE_POLICY）：
 *   limit 且没有动作 = 额度用完；limit+retry = 限流；limit+new_session = 上下文 / 预算耗尽；access / login = 要登录。
 * - 没声明：只有额度用完会变成 JSON-RPC 错误（-32603，data.codexErrorInfo = "usageLimitExceeded"），同一回合只认一次；
 *   其它错误只是一段正文、照常 end_turn（看不出来）。
 * - 没登录：-32000 Authentication required（session/new|load 与 prompt 都可能），出「需要 owner 登录」的卡。
 * - 协议不兼容（protocol.ts，initialize 时判）：不可重试的 error、固定 key——一个宿主只出一张卡，之后的回合按同一个失败收尾。
 * - 用户输入写出后拿不到可信结果（deliveryUnknownCause）：不可重试的 error、带 deliveryUnknown，宿主不重排、不续跑，卡上附原文。
 * 重置时间 ACP 不给，照旧从 rollout 读（codex-usage.ts）。tests/acp-failures.test.ts。
 */
import { AcpIncompatibleError } from "./protocol.js";
import { RpcError, RpcLostError } from "./rpc.js";

const AUTH_REQUIRED_CODE = -32000;

export type AcpFailure =
  /** 额度用完：进额度通道、出「待你处理」卡（切模型 / 等重置），绝不自动选 */
  | { kind: "quota"; key: string; message: string }
  /** 没登录：出「需要 owner 登录」的卡 */
  | { kind: "auth"; key: string; message: string }
  /** 其它：retry = 适配器说能不能重试（只有 AIR 给，legacy 不知道 = undefined）；newSession = 上下文 / 预算耗尽；deliveryUnknown 见 deliveryUnknownCause */
  | { kind: "error"; key: string; message: string; retry?: boolean; newSession?: boolean; deliveryUnknown?: true };

export interface AirSessionFailure {
  id: string;
  revision: number;
  category: string;
  severity: string;
  title: string;
  actions: string[];
}

const USAGE_LIMIT_RE = /usage limit/i;

/** prompt 结果里的 AIR sessionFailure（形状不对返回 null） */
export function airFailureOf(result: unknown): AirSessionFailure | null {
  const f = (result as any)?._meta?.jetbrains?.air?.sessionFailure;
  if (!f || typeof f !== "object" || typeof f.id !== "string" || !f.id) return null;
  return {
    id: f.id,
    revision: typeof f.revision === "number" ? f.revision : 1,
    category: String(f.category ?? "unknown"),
    severity: String(f.severity ?? "error"),
    title: typeof f.title === "string" ? f.title : "",
    actions: Array.isArray(f.actions) ? f.actions.map(String) : [],
  };
}

/** AIR 失败 → 我们的分类（key = air:<id>：同一横幅的后续 revision 不再出第二张卡） */
export function classifyAirFailure(f: AirSessionFailure, label = "Codex"): AcpFailure {
  const key = `air:${f.id}`;
  const message = f.title || `${label} 回合失败（${f.category}）`;
  if (f.category === "access" || f.actions.includes("login")) return { kind: "auth", key, message };
  const retry = f.actions.includes("retry");
  const newSession = f.actions.includes("new_session");
  if (f.category === "limit" && ((!retry && !newSession) || USAGE_LIMIT_RE.test(f.title))) return { kind: "quota", key, message };
  return { kind: "error", key, message, retry, ...(newSession ? { newSession: true } : {}) };
}

/**
 * 运行时无关的失败种类（Pi 适配器给：prompt 错误的 data.failureKind、idle 上 turn.failure.kind）→ 分类。
 * rate_limit 是暂时限流：只出条目、标可重试，不进额度通道；认不出的种类返回 null，由调用方按 error 处理。
 */
export function classifyNeutralFailure(kind: unknown, key: string, message: string): AcpFailure | null {
  if (kind === "quota") return { kind: "quota", key: `quota:${key}`, message };
  if (kind === "auth") return { kind: "auth", key: `auth:${key}`, message };
  if (kind === "rate_limit") return { kind: "error", key: `rpc:${key}`, message, retry: true };
  return null;
}

/** idle 终态信封 _meta.claudestra.turn.failure 的形状（字段都按对端可能乱给来读） */
export interface TurnEndFailure {
  kind?: unknown;
  message?: unknown;
  id?: unknown;
  retry?: unknown;
  newSession?: unknown;
  deliveryUnknown?: unknown;
}

/**
 * 终态信封里的失败 → 分类。Pi 只给 kind / message；自研 Codex 适配器另带 id（键改成 air:<id>，和 prompt 回包的 AIR 失败共用，
 * FailureDedup 只出一张卡）、retry / newSession / deliveryUnknown（照原样带上，宿主据此决定续不续跑）。不带这些字段时结果和原来逐字相同。
 */
export function classifyTurnEndFailure(f: TurnEndFailure, key: string, message: string): AcpFailure {
  const base = classifyNeutralFailure(f.kind, key, message) ?? { kind: "error", key, message };
  const keyed: AcpFailure = typeof f.id === "string" && f.id ? { ...base, key: `air:${f.id}` } : base;
  if (keyed.kind !== "error") return keyed;
  const retry = typeof f.retry === "boolean" ? { retry: f.retry } : {};
  return { ...keyed, ...retry, ...(f.newSession === true ? { newSession: true } : {}), ...(f.deliveryUnknown === true ? { deliveryUnknown: true as const } : {}) };
}

/** session/prompt（或 session/new|load）抛的错 → 分类；认不出的一律 error。turnKey = 宿主给这一轮的编号（同一回合只出一次） */
export function classifyPromptError(e: unknown, turnKey: string): AcpFailure {
  if (e instanceof AcpIncompatibleError) return { kind: "error", key: "incompatible", message: e.message, retry: false };
  if (e instanceof RpcError) {
    if (e.code === AUTH_REQUIRED_CODE) return { kind: "auth", key: `auth:${turnKey}`, message: e.message || "Authentication required" };
    const data = (e.data ?? {}) as Record<string, unknown>;
    const detail = typeof data.message === "string" && data.message ? data.message : e.message;
    if (data.codexErrorInfo === "usageLimitExceeded") return { kind: "quota", key: `quota:${turnKey}`, message: detail };
    return classifyNeutralFailure(data.failureKind, turnKey, detail) ?? { kind: "error", key: `rpc:${turnKey}`, message: detail };
  }
  return { kind: "error", key: `rpc:${turnKey}`, message: e instanceof Error ? e.message : String(e) };
}

/**
 * 用户输入（prompt / steering）已经写给适配器、却没拿到可信结果时返回原因，否则 null：写出后断线 / 超时 / 回包不合规 / 写入抛错
 * （rpc.ts RpcLostError sent:true），或适配器自己说投递不明（Pi 的 data.deliveryUnknown）。这时输入可能已经执行，重排或续跑都会重复执行；
 * 没写出（sent:false）和适配器明确的错误返回 null，照旧处理。tests/acp-session.test.ts「CX-H」。
 */
export function deliveryUnknownCause(e: unknown): string | null {
  const marked = e instanceof RpcLostError ? e.sent : e instanceof RpcError && (e.data as { deliveryUnknown?: unknown } | undefined)?.deliveryUnknown === true;
  return marked ? (e as Error).message || "对端没说明原因" : null; // 调用方按 !== null 判：标记看的是 sent / data，不看 message 是否为空
}

/** 卡上附的原文上限：够人工核对、重发，又不让一条贴了整份日志的消息撑爆卡片和流里的错误条目 */
const UNKNOWN_TEXT_MAX = 4_000;

/** 投递不明的失败：retry:false 不触发 60s 续跑（failureEntry），卡片文案就是 message（bridge 不用改） */
export function deliveryUnknownFailure(key: string, cause: string, text: string): AcpFailure {
  // 留尾不留头：用户的消息在最后（前面可能是重启后首条消息带的上下文前言），人工重发要的是它
  const shown = text.length > UNKNOWN_TEXT_MAX ? `…（前面截掉了 ${text.length - UNKNOWN_TEXT_MAX} 字）${text.slice(-UNKNOWN_TEXT_MAX)}` : text;
  const message = `这条消息可能已经被执行，没有自动重发，需要人决定要不要重发（${cause}）。消息原文：\n${shown}`;
  return { kind: "error", key, message, retry: false, deliveryUnknown: true };
}

/** 同一个失败只出一张卡：记住见过的 key（AIR 的后续 revision、legacy 的同一回合重复上报都挡住） */
export class FailureDedup {
  private seen = new Set<string>();
  constructor(private readonly cap = 200) {}
  /** 第一次见到返回 true */
  admit(f: AcpFailure): boolean {
    if (this.seen.has(f.key)) return false;
    this.seen.add(f.key);
    if (this.seen.size > this.cap) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }
}

/**
 * 失败 → Claude Code 形状的错误条目（与 codex-session.ts codexTurnError 同形）：额度原文照登、不标 API 错误（watcher 走 ⛔、
 * 不自动续跑）；rateLimited 显式携带分类（false 也保留），避免下游从措辞重新猜额度。其它文字带 "API Error: "，
 * 适配器没说不能重试的才标 isApiErrorMessage（它会触发 60s 后自动续跑一次，
 * 策略拒绝 / 请求错误续跑了也是白跑）。没登录不出条目：那一张卡就够了，正文里再来一条只是重复。
 */
export function failureEntry(f: AcpFailure, ts: string): Record<string, unknown> | null {
  if (f.kind === "auth") return null;
  const quota = f.kind === "quota";
  return {
    type: "assistant",
    timestamp: ts,
    rateLimited: quota,
    isApiErrorMessage: f.kind === "error" && f.retry !== false,
    error: f.message,
    message: { content: [{ type: "text", text: quota ? f.message : `API Error: ${f.message}` }] },
  };
}
