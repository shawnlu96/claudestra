/**
 * 订阅额度接口响应 → 白名单 DTO（纯函数）。
 *
 * 只挑验证过的字段**新建**对象，从不 spread 原始响应：wham/usage 带明文 email / user_id / account_id，
 * 按字段名删 PII 挡不住以后新加的字段（T2a 就在长度规则上栽过），所以反过来只放行认识的。
 * 字符串字段一律过正则（模型名、套餐名），credit 的原始 id 在这里就被 HMAC 掉，不出解析函数。
 * 字段形状取自 T2a 实测样例（docs/tasks/T2a.report.md）；单测 tests/quota-dto.test.ts。
 */

import { windowIdOf } from "./codex-usage.js";
import { resetTsMs } from "./usage-cache.js";

type AnyRecord = Record<string, any>;

export interface QuotaWindowDto {
  /** "5h" / "7d" / "7d:<模型名>" / 其它窗口按长度或 kind 命名 */
  id: string;
  kind: "session" | "weekly" | "weekly_scoped" | "other";
  /** 0–100 */
  usedPct: number;
  resetsAtMs: number | null;
  windowMinutes: number | null;
  severity: "normal" | "warning" | "critical" | null;
  /** weekly_scoped 的模型显示名 */
  scopeModel: string | null;
}

export interface ClaudeUsageDto {
  windows: QuotaWindowDto[];
}

export interface CodexUsageDto {
  plan: string | null;
  limitReached: boolean;
  windows: QuotaWindowDto[];
  /** 按量付费余额（和「重置次数」是两回事） */
  balance: string | null;
  /** 持有总数 / 此刻真能兑换的数（T2a 样例 2 / 0） */
  resetCredits: { availableCount: number; applicableAvailableCount: number } | null;
}

export interface ResetCreditDto {
  /** HMAC(本机密钥, 账户键 + credit.id) */
  key: string;
  status: "available" | "redeemed" | "other";
  supportedByPlan: boolean;
  redeemStarted: boolean;
  redeemed: boolean;
  grantedAtMs: number | null;
  expiresAtMs: number;
}

export interface CodexResetCreditsDto {
  credits: ResetCreditDto[];
  availableCount: number;
}

const obj = (v: unknown): AnyRecord | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as AnyRecord) : null);

/** 百分比：负数 / 非数字不认；超过 100（超额）按 100 显示 */
function pctOf(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.min(100, Math.round(v * 10) / 10);
}

function countOf(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 10_000 ? v : null;
}

/** ISO 串 / Unix 秒 → ms；认不出 null */
function timeOf(v: unknown): number | null {
  if (typeof v === "string" && !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?$/.test(v)) return null;
  return resetTsMs(v);
}

const MODEL_RE = /^[\w .-]{1,32}$/;
const PLAN_RE = /^[a-z0-9_]{1,24}$/;
const KIND_RE = /^[a-z_]{1,32}$/;
const SEVERITIES = new Set(["normal", "warning", "critical"]);
const severityOf = (v: unknown): QuotaWindowDto["severity"] => (typeof v === "string" && SEVERITIES.has(v) ? (v as QuotaWindowDto["severity"]) : null);

// ── Claude：GET api.anthropic.com/api/oauth/usage ───────────────────────────

function claudeLimit(l: AnyRecord): QuotaWindowDto | null {
  const usedPct = pctOf(l.percent);
  if (usedPct === null || typeof l.kind !== "string" || !KIND_RE.test(l.kind)) return null;
  const base = { usedPct, resetsAtMs: timeOf(l.resets_at), severity: severityOf(l.severity), scopeModel: null };
  if (l.kind === "session") return { ...base, id: "5h", kind: "session", windowMinutes: 300 };
  if (l.kind === "weekly_all") return { ...base, id: "7d", kind: "weekly", windowMinutes: 10080 };
  if (l.kind === "weekly_scoped") {
    const name = obj(obj(l.scope)?.model)?.display_name;
    const model = typeof name === "string" && MODEL_RE.test(name) ? name : null;
    return { ...base, id: model ? `7d:${model}` : "7d:scoped", kind: "weekly_scoped", windowMinutes: 10080, scopeModel: model };
  }
  return { ...base, id: l.kind, kind: "other", windowMinutes: null };
}

/** 老形态：只有 five_hour / seven_day 两个对象（limits[] 缺席时退回它） */
function claudeLegacy(j: AnyRecord): QuotaWindowDto[] {
  const out: QuotaWindowDto[] = [];
  for (const [field, id, kind, minutes] of [["five_hour", "5h", "session", 300], ["seven_day", "7d", "weekly", 10080]] as const) {
    const w = obj(j[field]);
    const usedPct = pctOf(w?.utilization);
    if (!w || usedPct === null) continue;
    out.push({ id, kind, usedPct, resetsAtMs: timeOf(w.resets_at), windowMinutes: minutes, severity: null, scopeModel: null });
  }
  return out;
}

export function parseClaudeUsage(json: unknown): ClaudeUsageDto | null {
  const j = obj(json);
  if (!j) return null;
  const limits = Array.isArray(j.limits) ? j.limits.slice(0, 32).map(obj).filter((l): l is AnyRecord => l !== null) : [];
  const fromLimits = limits.map(claudeLimit).filter((w): w is QuotaWindowDto => w !== null);
  const windows = fromLimits.length ? fromLimits : claudeLegacy(j);
  return windows.length ? { windows } : null;
}

// ── Codex：GET chatgpt.com/backend-api/wham/usage ──────────────────────────

function codexWindow(slot: string, v: unknown): QuotaWindowDto | null {
  const w = obj(v);
  const usedPct = pctOf(w?.used_percent);
  if (!w || usedPct === null) return null;
  const secs = w.limit_window_seconds;
  const minutes = typeof secs === "number" && Number.isFinite(secs) && secs > 0 ? Math.round(secs / 60) : null;
  const kind = minutes === 300 ? "session" : minutes === 10080 ? "weekly" : "other";
  return { id: minutes ? windowIdOf(minutes) : slot, kind, usedPct, resetsAtMs: timeOf(w.reset_at), windowMinutes: minutes, severity: null, scopeModel: null };
}

export function parseCodexUsage(json: unknown): CodexUsageDto | null {
  const j = obj(json);
  const rl = obj(j?.rate_limit);
  if (!j || !rl) return null;
  const windows = [codexWindow("primary", rl.primary_window), codexWindow("secondary", rl.secondary_window)].filter(
    (w): w is QuotaWindowDto => w !== null,
  );
  if (!windows.length) return null;
  const rc = obj(j.rate_limit_reset_credits);
  const held = countOf(rc?.available_count);
  const applicable = countOf(rc?.applicable_available_count);
  const bal = obj(j.credits)?.balance;
  return {
    plan: typeof j.plan_type === "string" && PLAN_RE.test(j.plan_type) ? j.plan_type : null,
    limitReached: rl.limit_reached === true,
    windows,
    balance: typeof bal === "string" && /^\d{1,12}(\.\d{1,6})?$/.test(bal) ? bal : null,
    resetCredits: held === null ? null : { availableCount: held, applicableAvailableCount: applicable ?? 0 },
  };
}

// ── Codex 重置明细：GET …/wham/rate-limit-reset-credits ─────────────────────

function resetCredit(c: AnyRecord, hashId: (rawId: string) => string): ResetCreditDto | null {
  const expiresAtMs = timeOf(c.expires_at);
  if (typeof c.id !== "string" || !c.id || c.id.length > 256 || expiresAtMs === null) return null;
  return {
    key: hashId(c.id),
    status: c.status === "available" ? "available" : c.status === "redeemed" ? "redeemed" : "other",
    supportedByPlan: c.is_supported_by_plan === true,
    redeemStarted: c.redeem_started_at != null,
    redeemed: c.redeemed_at != null,
    grantedAtMs: timeOf(c.granted_at),
    expiresAtMs,
  };
}

export function parseCodexResetCredits(json: unknown, hashId: (rawId: string) => string): CodexResetCreditsDto | null {
  const j = obj(json);
  const availableCount = countOf(j?.available_count);
  if (!j || !Array.isArray(j.credits) || availableCount === null) return null;
  const credits = j.credits
    .slice(0, 100)
    .map(obj)
    .filter((c): c is AnyRecord => c !== null)
    .map((c) => resetCredit(c, hashId))
    .filter((c): c is ResetCreditDto => c !== null);
  return { credits, availableCount };
}
