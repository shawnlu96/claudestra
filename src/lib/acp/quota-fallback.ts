/**
 * ACP 额度卡的选项与备用链（纯函数，时间 / 到顶事实 / 配置都由调用方给；接线在 bridge/acp-quota.ts）。规则见 docs/architecture/acp-quota.md：
 * - 和当前模型同 provider 的不列（同一个账号 / 套餐，切过去照样撞墙）；已知同样到顶的 provider 也不列；
 * - 剩下的同系列优先（名字去掉版本号相同 > 同一家 > 其它，同档里版本越接近越前），同系列的第一个标「推荐」；
 * - 备用链 quotaFallback：off 不管；observe 只在卡上写「按备用链会切到 X」；on 由 bridge 直接切过去再出通知卡。
 * 原 provider 恢复后不自动切回（来回切比停一下更糟）。tests/quota-fallback.test.ts。
 */

/** Codex 的模型值不带 provider 前缀：都是同一个 ChatGPT 账号 */
export const CODEX_PROVIDER = "openai-codex";

type FallbackMode = "off" | "observe" | "on";

export interface QuotaFallbackConfig {
  mode: FallbackMode;
  /** 有序：每项是 provider（如 cc-switch-deep-seek）或完整模型值（provider/id，也认只写 id） */
  chain: string[];
}

export interface WalledProvider {
  provider: string;
  /** 解析不出重置时间 = null */
  resetAt: number | null;
  /** 给人看的判断来源（「Codex 额度快照」「本机 10:02 撞墙」） */
  source: string;
}

interface Choice {
  value: string;
  name: string;
}

export const providerOf = (value: string): string => (value.indexOf("/") > 0 ? value.slice(0, value.indexOf("/")) : CODEX_PROVIDER);
const idOf = (value: string): string => (value.indexOf("/") > 0 ? value.slice(value.indexOf("/") + 1) : value);

const VERSION_RE = /^v?\d+(\.\d+)*$/;

/** 模型 id → 系列：去掉版本号的名字、第一段（哪一家）、版本数（比远近用） */
export function seriesOf(value: string): { base: string; vendor: string; version: number | null } {
  const parts = idOf(value).toLowerCase().split(/[-_\s]+/).filter(Boolean);
  const names = parts.filter((p) => !VERSION_RE.test(p));
  const ver = parts.find((p) => VERSION_RE.test(p));
  const nums = ver ? ver.replace(/^v/, "").split(".").map(Number) : null;
  return { base: names.join("-"), vendor: names[0] ?? "", version: nums ? nums[0]! * 1000 + (nums[1] ?? 0) : null };
}

/** 0 = 同系列，1 = 同一家，2 = 其它 */
function tierOf(current: string, value: string): number {
  const a = seriesOf(current), b = seriesOf(value);
  return a.base && a.base === b.base ? 0 : a.vendor && a.vendor === b.vendor ? 1 : 2;
}

function distance(current: string, value: string): number {
  const a = seriesOf(current).version, b = seriesOf(value).version;
  return a === null || b === null ? Number.MAX_SAFE_INTEGER : Math.abs(a - b);
}

export interface UsableModels<C extends Choice> {
  /** 能切的，已按同系列排好；recommended = 第一个且同系列 / 同一家 */
  usable: C[];
  recommended: boolean;
  sameProvider: number;
  walled: number;
}

export function usableModels<C extends Choice>(current: string, choices: readonly C[], walled: readonly string[]): UsableModels<C> {
  const own = providerOf(current);
  const others = choices.filter((c) => c.value !== current);
  const same = others.filter((c) => providerOf(c.value) === own);
  const rest = others.filter((c) => providerOf(c.value) !== own);
  const open = rest.filter((c) => !walled.includes(providerOf(c.value)));
  // sort 是稳定的：同档同距离保持下拉里的原顺序
  const usable = [...open].sort((x, y) => tierOf(current, x.value) - tierOf(current, y.value) || distance(current, x.value) - distance(current, y.value));
  return { usable, recommended: !!usable[0] && tierOf(current, usable[0].value) < 2, sameProvider: same.length, walled: rest.length - open.length };
}

/** 备用链里第一个能落到「能切的」模型上的那项；provider 项取这家排最前的模型 */
export function fallbackTarget(chain: readonly string[], usable: readonly Choice[]): string | null {
  for (const entry of chain) {
    const hit = usable.find((c) => c.value === entry || idOf(c.value) === entry) ?? usable.find((c) => providerOf(c.value) === entry);
    if (hit) return hit.value;
  }
  return null;
}

const MODES: readonly FallbackMode[] = ["off", "observe", "on"];
const modeOf = (v: unknown): FallbackMode | undefined => (MODES.includes(v as FallbackMode) ? (v as FallbackMode) : undefined);
const chainOf = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : undefined;

/** config.json 的 quotaFallback → 这个项目用的档位和链：项目里写了的字段盖过全局的；缺省 observe、空链；写坏的字段当没写 */
export function resolveFallback(raw: unknown, project: string | undefined): QuotaFallbackConfig {
  const g = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const projects = g.projects && typeof g.projects === "object" ? (g.projects as Record<string, unknown>) : {};
  const p = project && projects[project] && typeof projects[project] === "object" ? (projects[project] as Record<string, unknown>) : {};
  return { mode: modeOf(p.mode) ?? modeOf(g.mode) ?? "observe", chain: chainOf(p.chain) ?? chainOf(g.chain) ?? [] };
}

const MAX_RAW = 500;
const MAX_SUMMARY = 80;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** provider 回的原文 → 一行人话（≤500 字）：认得出 {type, message}（或 error 里套一层）就写「type: message」，否则原样 */
export function rawQuotaText(message: string): string {
  return cut(tidyRaw(message).replace(/\s+/g, " "), MAX_RAW);
}

function tidyRaw(message: string): string {
  if (!message.includes("{")) return message.trim();
  try {
    const o = JSON.parse(message.slice(message.indexOf("{"))) as Record<string, any>;
    const e = o.error && typeof o.error === "object" ? o.error : o;
    const type = typeof e.type === "string" ? e.type : typeof e.code === "string" ? e.code : "";
    if (typeof e.message === "string" && e.message) return type ? `${type}: ${e.message}` : e.message;
  } catch { /* 不是完整 JSON：按原文给，人照样看得到原话 */ }
  return message.trim();
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 本机时区：今天的只写时刻，别的天带上日期 */
export function whenText(at: number | null, now: number): string {
  if (at === null) return "未知";
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export interface QuotaCardFacts {
  /** 运行时称呼（Codex / Pi） */
  label: string;
  current: string;
  /** 卡上写的「谁到顶」：确认了的 provider 名，或「Codex 当前账号」（模型 id 不带前缀时认不出是哪家） */
  provider: string;
  message: string;
  resetAt: number | null;
  now: number;
  sameProvider: number;
  /** 被当成到顶而没列的 provider（只列确实挡掉了模型的） */
  walled: readonly WalledProvider[];
  /** 能切的模型，已排好；第一个是推荐（recommended 时） */
  usable: readonly string[];
  recommended: boolean;
  fallback: FallbackMode;
  chain: readonly string[];
  target: string | null;
  /** on 档也不自动切的原因（审查 / 出借会话） */
  noAuto?: string;
  /** on 档切了没成：宿主给的原因 */
  switchError?: string;
}

/** 第 1 行：谁到顶 + 原文摘要 + 重置时间（网页卡只显示前 3 行，手机上这一行还会折） */
const headLine = (f: QuotaCardFacts) =>
  `${f.provider} 额度到顶：${cut(rawQuotaText(f.message), MAX_SUMMARY)}；重置 ${whenText(f.resetAt, f.now)}`;

function waitReason(f: QuotaCardFacts): string {
  const why = [
    ...(f.sameProvider ? [`同一个账号的另外 ${f.sameProvider} 个模型也用不了`] : []),
    ...(f.walled.length ? [`${f.walled.map((w) => w.provider).join("、")} 也到顶了`] : []),
  ];
  return why.length ? why.join("，") : "下拉里没有别家的模型";
}

function fallbackLine(f: QuotaCardFacts): string | null {
  if (f.fallback === "off" || !f.chain.length) return null;
  if (f.switchError) return `按备用链切到 ${f.target} 没成：${f.switchError}`;
  if (!f.target) return "备用链里没有现在能用的模型";
  if (f.fallback === "on") return `按备用链该切到 ${f.target}，但${f.noAuto ?? "没有切"}`;
  return `按备用链会切到 ${f.target}（observe 档，没有自动切）`;
}

/** 额度卡正文：前 3 行是谁到顶 / 原文 / 重置、推荐切到谁或只能等、备用链；其余（完整原文、为什么没列、怎么切回）在后面 */
export function quotaCardText(f: QuotaCardFacts): string {
  const next = f.usable.length ? `${f.recommended ? "推荐" : "可以"}切到 ${f.usable[0]}` : `只能等重置（${waitReason(f)}）`;
  const lines = [headLine(f), next, fallbackLine(f)].filter((l): l is string => l !== null);
  lines.push(`当前模型：${f.current}；原文：${rawQuotaText(f.message)}`);
  if (f.usable.length && f.sameProvider) lines.push(`没列：${f.provider} 的另外 ${f.sameProvider} 个模型（同一个账号 / 套餐，切过去照样撞墙）`);
  if (f.usable.length) for (const w of f.walled) lines.push(`没列：${w.provider} 也到顶了（${w.source}，重置 ${whenText(w.resetAt, f.now)}）`);
  if (f.usable.length) lines.push(`切走以后原 provider 恢复了也不会自动切回：要切回就在设置页的模型下拉里选 ${f.current}。`);
  return lines.join("\n");
}

/** 备用链自动切换后的通知卡正文 */
export function switchedCardText(f: QuotaCardFacts & { target: string }): string {
  return [
    `已按备用链从 ${f.current} 切到 ${f.target}`,
    headLine(f),
    "撞墙的那一轮没跑完：重发消息或说「继续」接着做。",
    `不会自动切回：点「切回 ${f.current}」，或在设置页的模型下拉里手动切。原 provider 重置前切回会再撞一次墙。`,
  ].join("\n");
}
