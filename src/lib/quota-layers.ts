/**
 * 订阅额度选层（纯函数；设计稿 T2b §2 / §2.1 / §6.1）：调度器的远程视图 + 本机缓存 → 统一的 QuotaSnapshot。
 *
 *   - 账户卡：实时成功 = live；失败但同账户有上次快照 = live_stale（带原因）；都没有 = none（带原因）。
 *   - 本机缓存（statusline usage-cache、Codex rollout）不带账户身份：账户卡不是 live 时另出一条 `*.local`，
 *     identity "unknown"，永不并进账户卡、也不触发提醒。
 *   - 过了 resets_at 的窗口标 resetPassed（「应已重置（未确认）」），不推成 0。
 *   - 重置次数是独立权益，放 resetCredits，不进 meters。
 *   - ProviderEntry 是通用「接入商」条目：Pi 的自定义 provider（按量）等由调用方经 extra 原样拼进来。
 * 单测 tests/quota-layers.test.ts。
 */

import type { CodexQuotaObservation } from "./codex-usage.js";
import type { QuotaWindowDto } from "./quota-dto.js";
import type { ProviderRemote, RemoteView } from "./quota-scheduler.js";
import { resetPassed, type CachedUsage } from "./usage-cache.js";

type LayerSource = "live" | "live_stale" | "local_cache" | "none";

/** 一根量条：订阅是百分比；按量接入商是 tokens / 金额 / 请求数 */
interface QuotaMeter {
  id: string;
  kind: "session" | "weekly" | "weekly_scoped" | "other" | "usage";
  /** 补充标注（weekly_scoped 的模型名、按量接入商的模型等） */
  label: string | null;
  unit: "pct" | "tokens" | "usd" | "requests";
  used: number | null;
  limit?: number | null;
  resetsAtMs?: number | null;
  /** 观测到的重置时刻已过：used 是上一个窗口的旧值，前端显示「应已重置（未确认）」 */
  resetPassed?: boolean;
  severity?: "normal" | "warning" | "critical" | null;
}

interface ResetCreditsView {
  /** 持有总数 / 此刻真能兑换的数 */
  held: number;
  applicableNow: number;
  /** 明细拿不到（从没成功过）= null，只剩汇总数 */
  credits: { key: string; expiresAtMs: number }[] | null;
  stale: boolean;
  observedAt: number | null;
}

export interface ProviderEntry {
  /** "claude" | "codex" | "claude.local" | "codex.local" | "pi:<provider>" … */
  id: string;
  name: string;
  kind: "subscription" | "api";
  plan?: string | null;
  account: { key: string; identity: "assumed" | "bound" } | { key: null; identity: "unknown" };
  meters: QuotaMeter[];
  balance?: { amount: string; currency: string | null } | null;
  resetCredits?: ResetCreditsView | null;
  source: { layer: LayerSource; observedAt: number | null; reason: string | null };
}

export interface QuotaSnapshot {
  generatedAt: number;
  providers: ProviderEntry[];
}

export interface LayerInput {
  now: number;
  enabled: boolean;
  /** scheduler.view()；开关关时可不传 */
  remote: RemoteView | null;
  local: { claudeCache: CachedUsage | null; codexRollout: CodexQuotaObservation | null };
  extra?: ProviderEntry[];
}

/** 这些原因表示「本机没有这家的订阅凭据」，不是故障：不出账户卡、不报错，只看本机缓存 */
const NOT_CONFIGURED = new Set(["auth_missing", "account_missing", "keychain_missing"]);
const NAMES = { claude: "Claude", codex: "Codex" } as const;

function windowMeter(w: QuotaWindowDto, now: number): QuotaMeter {
  return {
    id: w.id,
    kind: w.kind,
    label: w.scopeModel,
    unit: "pct",
    used: w.usedPct,
    limit: 100,
    resetsAtMs: w.resetsAtMs,
    resetPassed: resetPassed(w.resetsAtMs, now),
    severity: w.severity,
  };
}

function pctMeter(id: string, kind: QuotaMeter["kind"], used: number | null, resetsAtMs: number | null, now: number): QuotaMeter {
  return { id, kind, label: null, unit: "pct", used, limit: 100, resetsAtMs, resetPassed: resetPassed(resetsAtMs, now) };
}

function resetCreditsOf(r: ProviderRemote, now: number): ResetCreditsView | null {
  const usage = r.endpoints.codex_usage?.snapshot;
  const detail = r.endpoints.codex_reset_credits;
  const summary = usage?.data.resetCredits ?? null;
  if (!summary && !detail?.snapshot) return null;
  const credits = detail?.snapshot
    ? detail.snapshot.data.credits.filter((c) => c.status === "available" && c.expiresAtMs > now).map((c) => ({ key: c.key, expiresAtMs: c.expiresAtMs }))
    : null;
  return {
    held: summary?.availableCount ?? detail?.snapshot?.data.availableCount ?? 0,
    applicableNow: summary?.applicableAvailableCount ?? 0,
    credits: credits?.sort((a, b) => a.expiresAtMs - b.expiresAtMs) ?? null,
    stale: detail ? detail.stale : true,
    observedAt: detail?.snapshot?.observedAt ?? usage?.observedAt ?? null,
  };
}

/** 一家的账户卡；账户未知且原因是「没配这家」时返回 null（不出卡） */
function accountCard(p: "claude" | "codex", r: ProviderRemote, now: number): ProviderEntry | null {
  const ev = p === "claude" ? r.endpoints.claude_usage : r.endpoints.codex_usage;
  const snap = ev?.snapshot ?? null;
  const reason = ev?.lastCode ?? r.credFailure?.code ?? (r.account?.uncertain ? "account_uncertain" : null);
  if (!r.account) {
    if (!r.credFailure || NOT_CONFIGURED.has(r.credFailure.code)) return null;
    return { id: p, name: NAMES[p], kind: "subscription", account: { key: null, identity: "unknown" }, meters: [], source: { layer: "none", observedAt: null, reason } };
  }
  const layer: LayerSource = !snap ? "none" : ev?.stale ? "live_stale" : "live";
  const codex = p === "codex" ? r.endpoints.codex_usage?.snapshot?.data : undefined;
  return {
    id: p,
    name: NAMES[p],
    kind: "subscription",
    plan: codex?.plan ?? null,
    account: { key: r.account.key, identity: r.account.identity },
    meters: snap ? snap.data.windows.map((w) => windowMeter(w, now)) : [],
    balance: codex?.balance ? { amount: codex.balance, currency: null } : null,
    resetCredits: p === "codex" ? resetCreditsOf(r, now) : null,
    source: { layer, observedAt: snap?.observedAt ?? null, reason: layer === "live" ? null : reason },
  };
}

function localEntry(id: string, name: string, meters: QuotaMeter[], observedAt: number, plan: string | null = null): ProviderEntry {
  return { id, name, kind: "subscription", plan, account: { key: null, identity: "unknown" }, meters, source: { layer: "local_cache", observedAt, reason: null } };
}

function claudeLocal(c: CachedUsage, now: number): ProviderEntry {
  return localEntry("claude.local", NAMES.claude, [
    pctMeter("5h", "session", c.sessionPct, c.sessionResetsAtMs, now),
    pctMeter("7d", "weekly", c.weekPct, c.weekResetsAtMs, now),
  ], c.scrapedAt);
}

function codexLocal(o: CodexQuotaObservation, now: number): ProviderEntry {
  const meters = o.windows.map((w) => {
    const kind = w.windowMinutes === 300 ? "session" : w.windowMinutes === 10080 ? "weekly" : "other";
    return pctMeter(w.id, kind, w.pct, w.resetsAtMs, now);
  });
  return localEntry("codex.local", NAMES.codex, meters, o.observedAt, o.plan);
}

export function selectQuotaLayers(input: LayerInput): QuotaSnapshot {
  const { now } = input;
  const providers: ProviderEntry[] = [];
  const locals = { claude: input.local.claudeCache ? claudeLocal(input.local.claudeCache, now) : null,
    codex: input.local.codexRollout ? codexLocal(input.local.codexRollout, now) : null };
  for (const p of ["claude", "codex"] as const) {
    const card = input.enabled && input.remote ? accountCard(p, input.remote[p], now) : null;
    if (card) providers.push(card);
    const local = locals[p];
    if (local && card?.source.layer !== "live") providers.push(local);
  }
  return { generatedAt: now, providers: [...providers, ...(input.extra ?? [])] };
}
