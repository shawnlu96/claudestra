/**
 * Pi 接入商的套餐用量 / 余额（照 CC Switch 的做法）：按 models.json 里 provider 的 baseUrl 认出是哪家，拿它自己的 API key
 * 调那家的只读用量接口。key 只发往它本来就在用的那个主机（接口主机必须等于 baseUrl 的主机），地址只能从固定表里选。
 *   DeepSeek       GET https://api.deepseek.com/user/balance   余额
 *   OpenCode Go    GET https://opencode.ai/zen/go/v1/usage      5 小时 / 本周 / 本月百分比（没有公开文档，格式可能变）
 *   Kimi For Coding GET https://api.kimi.com/coding/v1/usages   5 小时 / 本周（limit / remaining 折成百分比）
 * 只在有人打开用量看板时查（bridge/quota-service.ts 的快照），每家 5 分钟一次；失败按错误码退避，只记码不记正文。
 * 单测 tests/quota-pi-plans.test.ts（全部假 fetch）。
 */
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { pctOf, timeOf } from "./quota-dto.js";
import type { ProviderEntry, QuotaMeter } from "./quota-layers.js";
import { fetchJsonCapped, type FetchErrorCode, type QuotaFetch } from "./quota-providers.js";

export type PlanKind = "deepseek_balance" | "opencode_go" | "kimi_coding";

const PLAN_URL: Readonly<Record<PlanKind, string>> = Object.freeze({
  deepseek_balance: "https://api.deepseek.com/user/balance",
  opencode_go: "https://opencode.ai/zen/go/v1/usage",
  kimi_coding: "https://api.kimi.com/coding/v1/usages",
});
const PLAN_LABEL: Record<PlanKind, string> = { deepseek_balance: "DeepSeek", opencode_go: "OpenCode Go", kimi_coding: "Kimi For Coding" };

/** baseUrl → 哪家（只认 https、主机逐字相等，api.deepseek.com.evil.com 这类不算）；认不出 null，不查 */
export function planKindOf(baseUrl: unknown): PlanKind | null {
  let u: URL;
  try {
    u = new URL(String(baseUrl));
  } catch {
    return null; // 写坏的 baseUrl：不是我们认得的接入商
  }
  if (u.protocol !== "https:") return null;
  if (u.hostname === "api.deepseek.com") return "deepseek_balance";
  if (u.hostname === "opencode.ai" && u.pathname.startsWith("/zen/go")) return "opencode_go";
  if (u.hostname === "api.kimi.com" && u.pathname.startsWith("/coding")) return "kimi_coding";
  return null;
}

export interface PlanProvider { name: string; kind: PlanKind; apiKey: string }

const NAME_RE = /^[\w.:-]{1,64}$/;
/** apiKey 写成环境变量名（全大写）且环境里有它 → 取环境值；其余按字面。`!命令` 形式不执行，直接跳过 */
function keyOf(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim() || v.startsWith("!")) return null;
  return /^[A-Z][A-Z0-9_]{2,}$/.test(v) && process.env[v] ? process.env[v]! : v.trim();
}

/** models.json 里认得的接入商；文件缺失 / 坏了 = 空（不是故障，本机可能没装 Pi） */
export function readPlanProviders(agentDir = join(homedir(), ".pi", "agent")): PlanProvider[] {
  let providers: Record<string, unknown>;
  try {
    providers = (JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as { providers?: Record<string, unknown> }).providers ?? {};
  } catch {
    return []; // 没装 Pi 或 models.json 写坏了：没有可查的接入商
  }
  return Object.entries(providers).flatMap(([name, p]) => {
    const o = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    const kind = planKindOf(o.baseUrl);
    const apiKey = keyOf(o.apiKey);
    return kind && apiKey && NAME_RE.test(name) && new URL(PLAN_URL[kind]).hostname === new URL(String(o.baseUrl)).hostname ? [{ name, kind, apiKey }] : [];
  });
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const numOf = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
/** 重置时刻：ISO 串或 Unix 秒 / 毫秒（≥1e12 当毫秒） */
const resetOf = (v: unknown): number | null => timeOf(typeof v === "number" && v >= 1e12 ? v / 1000 : v);

type Window = "session" | "weekly" | "monthly";
function pctMeter(w: Window, used: number | null, resetsAtMs: number | null): QuotaMeter {
  const kind = w === "monthly" ? "other" : w;
  return { id: w, kind, label: w === "monthly" ? "本月" : null, unit: "pct", used, limit: 100, resetsAtMs, periodMinutes: null };
}

/** OpenCode Go：usage.{rolling,weekly,monthly}.{percent,resetsAt}；percent 为 0 时 resetsAt 是占位值，不显示 */
export function parseOpenCodeGo(json: unknown): QuotaMeter[] | null {
  const u = obj(obj(json)?.usage);
  const slots: [string, Window][] = [["rolling", "session"], ["weekly", "weekly"], ["monthly", "monthly"]];
  const out = slots.flatMap(([k, w]) => {
    const s = obj(u?.[k]);
    const pct = s ? pctOf(numOf(s.percent)) : null;
    return pct === null ? [] : [pctMeter(w, pct, pct > 0 ? resetOf(s!.resetsAt) : null)];
  });
  return out.length ? out : null;
}

/** limit / remaining → 已用百分比；limit 不是正数认不出 */
function usedPct(s: Record<string, unknown> | null): number | null {
  const limit = numOf(s?.limit), remaining = numOf(s?.remaining);
  return limit !== null && limit > 0 && remaining !== null ? pctOf(Math.max(0, ((limit - remaining) / limit) * 100)) : null;
}

/** Kimi For Coding：limits[0].detail 是 5 小时窗口，usage 是每周；各自 {limit, remaining, resetTime} */
export function parseKimi(json: unknown): QuotaMeter[] | null {
  const j = obj(json);
  const five = obj(obj(Array.isArray(j?.limits) ? j!.limits[0] : null)?.detail);
  const week = obj(j?.usage);
  const out: QuotaMeter[] = [];
  const p5 = usedPct(five), pw = usedPct(week);
  if (p5 !== null) out.push(pctMeter("session", p5, resetOf(five!.resetTime)));
  if (pw !== null) out.push(pctMeter("weekly", pw, resetOf(week!.resetTime)));
  return out.length ? out : null;
}

/** DeepSeek：balance_infos[0] 的 total_balance（数字或数字串）与币种 */
export function parseDeepSeekBalance(json: unknown): { amount: string; currency: string | null } | null {
  const b = obj(Array.isArray(obj(json)?.balance_infos) ? (obj(json)!.balance_infos as unknown[])[0] : null);
  const amount = numOf(b?.total_balance);
  if (amount === null) return null;
  const cur = typeof b!.currency === "string" && /^[A-Z]{3}$/.test(b!.currency) ? b!.currency : null;
  return { amount: amount.toFixed(2), currency: cur };
}

const OK_MS = 5 * 60_000;
/** 401 = key 无效；403 = key 有效但没开这个套餐（OpenCode Go 实测）：都是改配置才会变，1 小时再看 */
const BACKOFF_MS: Partial<Record<FetchErrorCode, number>> = { http_401: 3600_000, http_403: 3600_000, http_429: 15 * 60_000 };
/** 给界面的码：401 / 403 换成 Pi 专用的说法（通用文案讲的是 Claude Code / codex 的登录凭据） */
const REASON: Partial<Record<FetchErrorCode, string>> = { http_401: "pi_key_invalid", http_403: "pi_no_plan" };

interface Cached { ok: { meters: QuotaMeter[]; balance: ProviderEntry["balance"]; at: number } | null; code: string | null; next: number }
/** 键带上 key 本身（只在内存里）：换了 key 立刻重查，不背着旧 key 的 401 退避 */
const cache = new Map<string, Cached>();
const cacheKey = (p: PlanProvider): string => `${p.name}\0${p.kind}\0${p.apiKey}`;
/** 同一家正在查：后来的等同一个结果（手机和电脑同时开着看板时不重复打接口） */
const inflight = new Map<string, Promise<void>>();
/** 单测之间清掉 */
export const resetPlanCache = (): void => (cache.clear(), inflight.clear());

function refreshOnce(p: PlanProvider, deps: { fetch: QuotaFetch; now: () => number }): Promise<void> {
  const k = cacheKey(p);
  const cur = inflight.get(k);
  if (cur) return cur;
  const run = refresh(p, deps).finally(() => inflight.delete(k));
  inflight.set(k, run);
  return run;
}

async function refresh(p: PlanProvider, deps: { fetch: QuotaFetch; now: () => number }): Promise<void> {
  const prev = cache.get(cacheKey(p));
  const now = deps.now();
  const r = await fetchJsonCapped(PLAN_URL[p.kind], { Authorization: `Bearer ${p.apiKey}` }, deps);
  const parsed = !r.ok ? null : p.kind === "deepseek_balance" ? parseDeepSeekBalance(r.data) : (p.kind === "opencode_go" ? parseOpenCodeGo : parseKimi)(r.data);
  if (parsed) {
    const ok = "amount" in parsed ? { meters: [], balance: parsed, at: now } : { meters: parsed, balance: null, at: now };
    return void cache.set(cacheKey(p), { ok, code: null, next: now + OK_MS });
  }
  const code: FetchErrorCode = r.ok ? "bad_shape" : r.code;
  const wait = (!r.ok && r.retryAfterMs) || BACKOFF_MS[code] || OK_MS;
  cache.set(cacheKey(p), { ok: prev?.ok ?? null, code: REASON[code] ?? code, next: now + wait });
}

function entryOf(p: PlanProvider, c: Cached): ProviderEntry {
  const layer = c.ok ? (c.code ? "live_stale" : "live") : "none";
  return {
    id: `pi:${p.name}`,
    name: p.name,
    kind: p.kind === "deepseek_balance" ? "api" : "subscription",
    plan: PLAN_LABEL[p.kind],
    account: { key: null, identity: "unknown" },
    meters: c.ok?.meters ?? [],
    balance: c.ok?.balance ?? null,
    source: { layer, observedAt: c.ok?.at ?? null, reason: c.code },
  };
}

/** 到期的各家并行查一遍（每家最多 5 秒），返回全部认得的接入商的条目 */
export async function piPlanEntries(deps: { fetch: QuotaFetch; now: () => number; providers?: () => PlanProvider[] }): Promise<ProviderEntry[]> {
  const ps = (deps.providers ?? readPlanProviders)();
  const now = deps.now();
  await Promise.all(ps.filter((p) => (cache.get(cacheKey(p))?.next ?? 0) <= now).map((p) => refreshOnce(p, deps)));
  return ps.flatMap((p) => {
    const c = cache.get(cacheKey(p));
    return c ? [entryOf(p, c)] : [];
  });
}
