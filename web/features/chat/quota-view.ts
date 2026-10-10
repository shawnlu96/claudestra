/**
 * 订阅额度卡片组的纯映射（bridge GET /api/v1/quota → 卡片）：数据层与原因码的人话、量条标签、重置时刻、
 * 「重试」按钮该不该出。形状照 src/lib/quota-layers.ts 的 ProviderEntry（web 与 src 互不 import，这里只取要用的字段，
 * 未知字段一律丢掉）。单测 tests/web-quota-view.test.ts。
 */

export type LayerSource = "live" | "live_stale" | "local_cache" | "none";

export interface MeterView {
  id: string;
  kind: string;
  label: string | null;
  unit: "pct" | "tokens" | "usd" | "requests";
  used: number | null;
  resetsAtMs: number | null;
  resetPassed: boolean;
}

export interface EntryView {
  id: string;
  name: string;
  kind: "subscription" | "api";
  plan: string | null;
  identity: "assumed" | "bound" | "unknown";
  meters: MeterView[];
  /** 按量接入商的余额（Pi 的 DeepSeek 等）；amount 是 bridge 格式化好的两位小数串 */
  balance: { amount: string; currency: string | null } | null;
  /** expiries：每张卡 / 每条 credit 的截止；left = 这张卡剩几次（Claude 一张卡可含多次），requiresLimit = 到限额才能用 */
  /** ineligibleReason：接口说这个入口看不到重置卡（如 surface），界面写原因，不显示成 0 张 */
  /** limitReached：Codex 额度是否已撞上限（此刻可用为 0 时据此写「为什么现在用不了」）；没给 = null */
  resetCredits: {
    held: number; applicableNow: number; expiries: CreditExpiry[] | null; stale: boolean; ineligibleReason: string | null; limitReached: boolean | null;
  } | null;
  source: { layer: LayerSource; observedAt: number | null; reason: string | null; needsUserRetry: boolean };
}

export interface CreditExpiry {
  /** bridge 给的卡键（HMAC，不是原始 id）：使用重置卡时按它指定用哪张；没给 / 形状不对 = null */
  key: string | null;
  /** null = 没有截止日（Claude 的卡可以没有） */
  at: number | null;
  left: number | null;
  requiresLimit: boolean;
}

export interface QuotaPanelData {
  enabled: boolean;
  generatedAt: number;
  entries: EntryView[];
}

const LAYERS: readonly LayerSource[] = ["live", "live_stale", "local_cache", "none"];
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function meterOf(v: unknown): MeterView | null {
  const m = obj(v);
  const unit = m?.unit;
  if (!m || typeof m.id !== "string" || (unit !== "pct" && unit !== "tokens" && unit !== "usd" && unit !== "requests")) return null;
  return { id: m.id, kind: String(m.kind ?? "other"), label: str(m.label), unit, used: num(m.used), resetsAtMs: num(m.resetsAtMs), resetPassed: m.resetPassed === true };
}

function creditsOf(v: unknown): EntryView["resetCredits"] {
  const c = obj(v);
  if (!c) return null;
  const expiry = (x: unknown): CreditExpiry | null => {
    const o = obj(x);
    if (!o) return null;
    const at = num(o.expiresAtMs);
    if (at === null && o.expiresAtMs !== null) return null; // 缺字段 / 坏值丢掉；明确的 null 才是「无截止日」
    const key = typeof o.key === "string" && /^[0-9a-f]{32}$/.test(o.key) ? o.key : null;
    return { key, at, left: num(o.left), requiresLimit: o.requiresLimit === true };
  };
  const list = Array.isArray(c.credits) ? c.credits.map(expiry).filter((x): x is CreditExpiry => x !== null) : null;
  const why = str(c.ineligibleReason);
  const limitReached = typeof c.limitReached === "boolean" ? c.limitReached : null;
  return { held: num(c.held) ?? 0, applicableNow: num(c.applicableNow) ?? 0, expiries: list, stale: c.stale === true, ineligibleReason: why && /^[a-z_]{1,32}$/.test(why) ? why : null, limitReached };
}

function balanceOf(v: unknown): EntryView["balance"] {
  const b = obj(v);
  const cur = str(b?.currency);
  return b && typeof b.amount === "string" && /^-?\d{1,12}(\.\d{1,4})?$/.test(b.amount) ? { amount: b.amount, currency: cur && /^[A-Z]{3}$/.test(cur) ? cur : null } : null;
}

/** 余额显示：人民币 / 美元写符号，其余带币种代码 */
export function balanceText(b: NonNullable<EntryView["balance"]>): string {
  return b.currency === "CNY" ? `¥${b.amount}` : b.currency === "USD" ? `$${b.amount}` : b.currency ? `${b.amount} ${b.currency}` : b.amount;
}

function entryOf(v: unknown): EntryView | null {
  const e = obj(v);
  const src = obj(e?.source);
  if (!e || !src || typeof e.id !== "string" || typeof e.name !== "string") return null;
  const layer = LAYERS.includes(src.layer as LayerSource) ? (src.layer as LayerSource) : "none";
  const identity = obj(e.account)?.identity;
  return {
    id: e.id,
    name: e.name,
    kind: e.kind === "api" ? "api" : "subscription",
    plan: str(e.plan),
    identity: identity === "assumed" || identity === "bound" ? identity : "unknown",
    meters: (Array.isArray(e.meters) ? e.meters : []).map(meterOf).filter((m): m is MeterView => m !== null),
    balance: balanceOf(e.balance),
    resetCredits: creditsOf(e.resetCredits),
    source: { layer, observedAt: num(src.observedAt), reason: str(src.reason), needsUserRetry: src.needsUserRetry === true },
  };
}

/** GET /quota 的响应 → 面板数据；形状不对返回 null（面板退回旧卡） */
export function quotaPanelData(j: unknown): QuotaPanelData | null {
  const r = obj(j);
  const snap = obj(r?.snapshot);
  if (!r || !snap || !Array.isArray(snap.providers)) return null;
  return {
    enabled: r.enabled !== false,
    generatedAt: num(snap.generatedAt) ?? Date.now(),
    entries: snap.providers.map(entryOf).filter((e): e is EntryView => e !== null),
  };
}

/** 卡片左上角的运行时徽章 */
export function entryRuntime(e: EntryView): string {
  if (e.id.startsWith("pi:")) return "pi";
  return e.id.startsWith("codex") ? "codex" : "claude-code";
}

export const LAYER_LABEL: Record<LayerSource, string> = {
  live: "实时",
  live_stale: "实时过期",
  local_cache: "本机缓存",
  none: "无",
};

/** 数据层标签：按量接入商（Pi）的数据是本机会话记录，不是缓存，照实叫「本机记录」 */
export function layerLabel(e: EntryView): string {
  return e.kind === "api" && e.source.layer === "local_cache" ? "本机记录" : LAYER_LABEL[e.source.layer];
}

/** 固定错误码 → 人话（zh 原文，面板里再过 t()）；认不出的码原样显示 */
const REASONS: Record<string, string> = {
  timeout: "接口超时",
  network: "网络不通",
  http_5xx: "服务端出错，稍后自动重试",
  http_429: "请求太频繁，按对方要求等一会儿",
  http_401: "凭据过期或已撤销，等 Claude Code / codex 自己续期",
  http_403: "接口拒绝访问",
  http_404: "接口变了，已暂停，可点重试",
  http_4xx: "接口变了，已暂停，可点重试",
  bad_shape: "返回格式变了，已暂停，可点重试",
  bad_json: "返回格式变了，已暂停，可点重试",
  redirect: "接口跳转了，已暂停，可点重试",
  too_large: "返回过大，已暂停，可点重试",
  keychain_denied: "钥匙串拒绝访问，点重试再读",
  keychain_timeout: "钥匙串没响应（可能在等授权弹框），点重试再读",
  keychain_error: "读钥匙串出错",
  keychain_missing: "钥匙串里没有凭据",
  auth_missing: "没有找到登录凭据",
  auth_bad_shape: "凭据格式认不出",
  account_missing: "找不到账户标识",
  token_expired: "凭据已过期，等客户端自己续期",
  identity_changed: "读取期间换了账号，这次结果已丢弃",
  account_uncertain: "账户不确定，暂不出提醒",
  no_secret: "本机密钥不可用",
  pi_key_invalid: "API key 无效或已撤销（检查 Pi 的 models.json）",
  pi_no_plan: "这个 key 没有开通该套餐",
  internal: "内部出错，稍后自动重试",
};
export function reasonText(code: string | null): string | null {
  return code ? (REASONS[code] ?? code) : null;
}

/**
 * 只有「用户主动重试」才解除的状态：以 bridge 给的 needsUserRetry 为准；老 bridge 没这个字段时按原因码兜底
 * （Keychain 被拒 / 超时 / 出错、端点暂停）；403 虽然自己退避重试，也给按钮，省得干等。
 */
const RETRY_CODES = new Set(["http_403", "keychain_denied", "keychain_timeout", "keychain_error", "http_404", "http_4xx", "bad_shape", "bad_json", "redirect", "too_large"]);
export function canRetry(e: EntryView): "claude" | "codex" | null {
  if (e.id !== "claude" && e.id !== "codex") return null;
  return e.source.needsUserRetry || (e.source.reason && RETRY_CODES.has(e.source.reason)) ? e.id : null;
}

/** 量条标签（zh 原文）：5 小时 / 本周 / 本周 · 模型 */
export function meterLabel(m: MeterView): string {
  if (m.kind === "session") return "5 小时";
  if (m.kind === "weekly") return "本周";
  if (m.kind === "weekly_scoped") return m.label ? `本周 · ${m.label}` : "本周";
  if (m.id === "week_tokens") return "本周 tokens";
  if (m.id === "week_usd") return "本周花费";
  return m.label ?? m.id;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** 本机时区：今天只写 HH:mm，其余 MM-DD HH:mm */
export function fmtAt(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** 本机缓存条目的账户归属一律未知（设计稿 §2.1）；按量接入商没有账户概念 */
export function identityNote(e: EntryView): string | null {
  if (e.kind === "api") return null;
  if (e.source.layer === "local_cache") return "账户归属未知";
  return e.identity === "assumed" ? "账户按本机登录推定" : null;
}

/** 一张卡 / 一条 credit 的截止说明（zh 原文 + 参数，面板里过 t()） */
export function expiryParts(x: CreditExpiry): { key: string; params: Record<string, string | number> }[] {
  const out: { key: string; params: Record<string, string | number> }[] = [
    x.at === null ? { key: "无截止日", params: {} } : { key: "{at} 到期", params: { at: fmtAt(x.at) } },
  ];
  if (x.left !== null && x.left > 1) out.push({ key: "剩 {n} 次", params: { n: x.left } });
  if (x.requiresLimit) out.push({ key: "到限额才能用", params: {} });
  return out;
}
