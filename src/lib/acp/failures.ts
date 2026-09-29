/**
 * 回合失败的结构化识别（ACP 下不再停在 Codex 的菜单上，失败就是 session/prompt 的结果）。适配器按客户端声明分两种给法：
 * - 声明了 JetBrains AIR 扩展 sessionFailure：prompt 以 end_turn 返回，_meta.jetbrains.air.sessionFailure 带
 *   {id, revision, category, severity, title, actions}。同一个失败横幅 id 不变、revision 递增 → 按 id 去重。
 *   没有 codexErrorInfo，种类只能按适配器的策略表认（CodexEventHandler.ts SESSION_FAILURE_POLICY）：
 *   limit 且没有动作 = 额度用完；limit+retry = 限流；limit+new_session = 上下文 / 预算耗尽；access / login = 要登录。
 * - 没声明：只有额度用完会变成 JSON-RPC 错误（-32603，data.codexErrorInfo = "usageLimitExceeded"），同一回合只认一次；
 *   其它错误只是一段正文、照常 end_turn（看不出来）。
 * - 没登录：-32000 Authentication required（session/new|load 与 prompt 都可能），出「需要 owner 登录」的卡。
 * 重置时间 ACP 不给，照旧从 rollout 读（codex-usage.ts）。tests/acp-failures.test.ts。
 */
import { RpcError } from "./rpc.js";

const AUTH_REQUIRED_CODE = -32000;

export type AcpFailure =
  /** 额度用完：进额度通道、出「待你处理」卡（切模型 / 等重置），绝不自动选 */
  | { kind: "quota"; key: string; message: string }
  /** 没登录：出「需要 owner 登录」的卡 */
  | { kind: "auth"; key: string; message: string }
  /** 其它：retry = 适配器说能不能重试（只有 AIR 给，legacy 不知道 = undefined）；newSession = 上下文 / 预算耗尽 */
  | { kind: "error"; key: string; message: string; retry?: boolean; newSession?: boolean };

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
export function classifyAirFailure(f: AirSessionFailure): AcpFailure {
  const key = `air:${f.id}`;
  const message = f.title || `Codex 回合失败（${f.category}）`;
  if (f.category === "access" || f.actions.includes("login")) return { kind: "auth", key, message };
  const retry = f.actions.includes("retry");
  const newSession = f.actions.includes("new_session");
  if (f.category === "limit" && ((!retry && !newSession) || USAGE_LIMIT_RE.test(f.title))) return { kind: "quota", key, message };
  return { kind: "error", key, message, retry, ...(newSession ? { newSession: true } : {}) };
}

/** session/prompt（或 session/new|load）抛的错 → 分类；认不出的一律 error。turnKey = 宿主给这一轮的编号（同一回合只出一次） */
export function classifyPromptError(e: unknown, turnKey: string): AcpFailure {
  if (e instanceof RpcError) {
    if (e.code === AUTH_REQUIRED_CODE) return { kind: "auth", key: `auth:${turnKey}`, message: e.message || "Authentication required" };
    const data = (e.data ?? {}) as Record<string, unknown>;
    const detail = typeof data.message === "string" && data.message ? data.message : e.message;
    if (data.codexErrorInfo === "usageLimitExceeded") return { kind: "quota", key: `quota:${turnKey}`, message: detail };
    return { kind: "error", key: `rpc:${turnKey}`, message: detail };
  }
  return { kind: "error", key: `rpc:${turnKey}`, message: e instanceof Error ? e.message : String(e) };
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
 * 不自动续跑）；其它文字带 "API Error: "，适配器没说不能重试的才标 isApiErrorMessage（它会触发 60s 后自动续跑一次，
 * 策略拒绝 / 请求错误续跑了也是白跑）。没登录不出条目：那一张卡就够了，正文里再来一条只是重复。
 */
export function failureEntry(f: AcpFailure, ts: string): Record<string, unknown> | null {
  if (f.kind === "auth") return null;
  const quota = f.kind === "quota";
  return {
    type: "assistant",
    timestamp: ts,
    isApiErrorMessage: f.kind === "error" && f.retry !== false,
    error: f.message,
    message: { content: [{ type: "text", text: quota ? f.message : `API Error: ${f.message}` }] },
  };
}
