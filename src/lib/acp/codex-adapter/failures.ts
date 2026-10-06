// 移植自 codex-acp v2.1.1 的 CodexEventHandler.ts / ServiceErrorMessage.ts（Apache-2.0，Copyright 2025 JetBrains s.r.o.），已修改：
// 只留 codexErrorInfo → 失败种类 → AIR 策略表与可读标题，其余从头写。来源见同目录 PROVENANCE.json。
/**
 * 回合失败的三种出口共用一份失败（B32、B55）：prompt 回包的 AIR sessionFailure、idle 的终态信封 _meta.claudestra.turn，
 * 两者 id 相同（`<turnId>:error`），宿主按 `air:<id>` 去重只出一张卡。投递结果不明（I14）不走 AIR：prompt 回 JSON-RPC 错误带
 * data.deliveryUnknown，宿主据此出只能由人结的卡、附原文（CX-H 契约）。tests/codex-adapter-failures.test.ts。
 */
import { RpcError } from "../rpc.js";

type FailureKind =
  | "transport_lost" | "auth_required" | "rate_limited" | "quota_exhausted" | "overloaded" | "context_exhausted"
  | "budget_exhausted" | "policy_denied" | "bad_request" | "provider_error" | "internal_error";
type Action = "retry" | "new_session" | "login";

const POLICY: Record<FailureKind, { category: string; actions: Action[] }> = {
  transport_lost: { category: "connection", actions: ["retry", "new_session"] },
  auth_required: { category: "access", actions: ["login"] },
  rate_limited: { category: "limit", actions: ["retry"] },
  quota_exhausted: { category: "limit", actions: [] },
  overloaded: { category: "service", actions: ["retry"] },
  context_exhausted: { category: "limit", actions: ["new_session"] },
  budget_exhausted: { category: "limit", actions: ["new_session"] },
  policy_denied: { category: "request", actions: [] },
  bad_request: { category: "request", actions: [] },
  provider_error: { category: "service", actions: ["retry"] },
  internal_error: { category: "service", actions: ["retry", "new_session"] },
};

const STRING_INFO: Record<string, FailureKind> = {
  contextWindowExceeded: "context_exhausted", sessionBudgetExceeded: "budget_exhausted", usageLimitExceeded: "quota_exhausted",
  rateLimitExceeded: "rate_limited", flexUnavailable: "provider_error", serverOverloaded: "overloaded", cyberPolicy: "policy_denied",
  misalignmentPolicyViolation: "policy_denied", tooManyDenials: "provider_error", internalServerError: "internal_error",
  unauthorized: "auth_required", badRequest: "bad_request", threadRollbackFailed: "provider_error", sandboxError: "provider_error",
  other: "provider_error",
};
const STRUCT_INFO: Record<string, FailureKind> = {
  httpConnectionFailed: "transport_lost", responseStreamConnectionFailed: "transport_lost", responseStreamDisconnected: "transport_lost",
  responseTooManyFailedAttempts: "transport_lost", activeTurnNotSteerable: "provider_error",
};

/** 一轮的失败。actions 给了就覆盖策略表（结果不明 / 主动停掉本地执行时不许自动续跑） */
export interface TurnFailure {
  kind: FailureKind;
  title: string;
  actions?: Action[];
}

function httpStatus(info: unknown): number | null {
  if (!info || typeof info !== "object") return null;
  const d = Object.values(info)[0] as { httpStatusCode?: unknown } | null;
  return d && typeof d === "object" && typeof d.httpStatusCode === "number" ? d.httpStatusCode : null;
}

function kindOf(info: unknown): FailureKind {
  if (info === "unauthorized" || httpStatus(info) === 401) return "auth_required";
  if (httpStatus(info) === 429) return "rate_limited";
  if (typeof info === "string") return STRING_INFO[info] ?? "provider_error";
  if (info && typeof info === "object") for (const k of Object.keys(STRUCT_INFO)) if (k in info) return STRUCT_INFO[k]!;
  return "provider_error";
}

const SERVICE_ERROR_TYPES = new Set([
  "invalid_request_error", "server_error", "rate_limit_error", "insufficient_quota", "authentication_error",
  "permission_error", "not_found_error", "conflict_error", "overloaded_error",
]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** provider 的错误信封 `{type:"error",status,error:{type,message}}` 取出 message（B33）；别的文字原样 */
function readable(text: string): string {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return text; // 不是 JSON 就是给人看的文字本身
  }
  if (!isObj(v) || v.type !== "error" || typeof v.status !== "number" || v.status < 400 || v.status > 599 || !isObj(v.error)) return text;
  const e = v.error;
  return typeof e.type === "string" && SERVICE_ERROR_TYPES.has(e.type) && typeof e.message === "string" && e.message.trim() ? e.message : text;
}

/** turn.error / error 通知 → 失败；severity 只有 error 级会走到这里（willRetry:true 只记日志，Q1） */
export function failureOf(err: { message: string; codexErrorInfo?: unknown }): TurnFailure {
  return { kind: kindOf(err.codexErrorInfo), title: readable(err.message) || "Codex 回合失败" };
}

const AIR_ID = (turnId: string) => `${turnId}:error`;
const actionsOf = (f: TurnFailure) => f.actions ?? POLICY[f.kind].actions;

/** idle 上的终态信封（B55）。kind / retry / newSession 按宿主 classifyAirFailure 同一套推，宿主两条通道得到同一个分类 */
export function envelopeFailure(turnId: string, f: TurnFailure): Record<string, unknown> {
  const acts = actionsOf(f);
  const kind = f.kind === "auth_required" ? "auth" : f.kind === "quota_exhausted" ? "quota" : f.kind === "rate_limited" ? "rate_limit" : "error";
  if (kind === "auth" || kind === "quota") return { kind, message: f.title, id: AIR_ID(turnId) };
  return { kind, message: f.title, id: AIR_ID(turnId), retry: acts.includes("retry"), ...(acts.includes("new_session") ? { newSession: true } : {}) };
}

/** prompt 回合失败的回包：声明了 AIR 走 sessionFailure；没声明只有额度用完变成 -32603（B34），其余照常 end_turn */
export function promptFailureResult(turnId: string, f: TurnFailure, air: boolean): Record<string, unknown> {
  if (air) {
    const sessionFailure = { id: AIR_ID(turnId), revision: 1, category: POLICY[f.kind].category, severity: "error", title: f.title, actions: actionsOf(f) };
    return { stopReason: "end_turn", _meta: { jetbrains: { air: { version: 1, sessionFailure } } } };
  }
  if (f.kind === "quota_exhausted") throw new RpcError(-32603, f.title, { codexErrorInfo: "usageLimitExceeded", message: f.title });
  return { stopReason: "end_turn" };
}

/** 输入写进了 app-server 却拿不到可信结果（I14）：宿主认 data.deliveryUnknown，不重排、不续跑 */
export const deliveryUnknownError = (message: string) => new RpcError(-32603, message, { deliveryUnknown: true });

export const transportLost = (why: string, noRetry = false): TurnFailure => ({
  kind: "transport_lost",
  title: `和 Codex app-server 的连接断了（${why}）`,
  ...(noRetry ? { actions: [] } : {}),
});
export const protocolFailure = (why: string): TurnFailure => ({ kind: "bad_request", title: why });
