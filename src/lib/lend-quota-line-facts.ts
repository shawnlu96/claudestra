/**
 * 额度线用的「本周已用」事实（QLINE1）：来源只有 AI 清单的额度段（ai-quota.ts readInventoryQuota，与 quota-week 同一份），
 * 周窗口由 quota-week.ts weekOf 取，不另扫描、不另登录。和 readWeekQuota 不同的是这里保留来源（live / live_stale / local_cache）
 * 与真实观测时刻 observedAt：判新旧只看 observedAt，不看「这次是什么时候读的」——旧快照每轮被重读一遍也不会变新。
 * 用哪份：同族里 observedAt 最新、且 resetAt 还没到的那份（同一时刻以本次读数为准）；所以真正更新的低读数（重置卡 / 账号修正）能恢复，
 * 观测更早的旧快照盖不掉更新的事实。读失败 / 这族没周窗口时沿用已有的那份（本代窗口内），不当 0%；resetAt 一过作废 = unknown。
 * claim / hello 是同步路径：factsNow 只读缓存，过期了在后台补读一次（测试进程不补读，由测试显式 refresh）。tests/lend-quota-line-facts.test.ts。
 */
import { readInventoryQuota, type InventoryQuota } from "./ai-quota.js";
import { LEND_FAMILIES, type LendFamily } from "./lend-wire-types.js";
import { statePath } from "./paths.js";
import { weekOf } from "./quota-week.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { isTestProcess } from "./test-guard.js";

export const QUOTA_LINE_FACTS_PATH = statePath("lend-quota-line-facts.json");
/** 进程内缓存多久后补读一次；与 quota-week 的 60 秒缓存对齐，再短也读不到更新的数 */
const FACT_REFRESH_MS = 60_000;
/** 观测时刻比本机此刻还晚这么多 = 时钟被往回拨过或文件被人改过：不信这份 */
const FUTURE_SKEW_MS = 5 * 60_000;

const FACT_SOURCES = ["live", "live_stale", "local_cache"] as const;
export type FactSource = (typeof FACT_SOURCES)[number];
export interface QuotaFact { weekUsedPct: number; resetAt: number; observedAt: number; source: FactSource }
export type QuotaFacts = Partial<Record<LendFamily, QuotaFact>>;
export type QuotaInventory = Partial<Record<LendFamily, InventoryQuota>>;

const isFact = (v: unknown): v is QuotaFact => {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o === "object" && [o.weekUsedPct, o.resetAt, o.observedAt].every((n) => typeof n === "number" && Number.isFinite(n))
    && (o.weekUsedPct as number) >= 0 && (o.weekUsedPct as number) <= 100 && FACT_SOURCES.includes(o.source as FactSource);
};

/** 某族此刻可用的事实：resetAt 没到、observedAt 不在未来；否则 undefined（= unknown） */
export function liveFact(f: QuotaFact | undefined, now: number): QuotaFact | undefined {
  return f && f.resetAt > now && f.observedAt <= now + FUTURE_SKEW_MS ? f : undefined;
}

/** 两份里取观测更新的那份（各自先过 liveFact）；一样新取 b（调用方把本次读数放 b） */
const newer = (a: QuotaFact | undefined, b: QuotaFact | undefined): QuotaFact | undefined => (!a ? b : !b ? a : b.observedAt >= a.observedAt ? b : a);

/** 清单里一族 → 事实：要有周窗口、可识别的来源和真实观测时刻；缺一样就不算这次读到 */
export function factOf(q: InventoryQuota | undefined, now: number): QuotaFact | undefined {
  if (!q || q.status !== "known" || !FACT_SOURCES.includes(q.source as FactSource)) return undefined;
  if (typeof q.observedAt !== "number" || !Number.isFinite(q.observedAt)) return undefined;
  const w = weekOf(q, now);
  return w ? { ...w, observedAt: q.observedAt, source: q.source as FactSource } : undefined;
}

/** 一次读数并进旧事实：每族取观测更新的那份（读到的新窗口 / 新观测换上，旧快照盖不掉更新的事实）；过期的一律丢 */
export function mergeReport(prev: QuotaFacts, inv: QuotaInventory, now: number): QuotaFacts {
  const out: QuotaFacts = {};
  for (const f of LEND_FAMILIES) {
    const v = newer(liveFact(prev[f], now), liveFact(factOf(inv[f], now), now));
    if (v) out[f] = v;
  }
  return out;
}

export interface FactsIo {
  read(): Promise<QuotaInventory>;
  path: string;
}

/** 清单读数自带 60 秒缓存：GET 网页与后台补读挤在一起时不重复扫 rollout */
let invCache: { at: number; value: QuotaInventory } | null = null;
async function readInventoryCached(): Promise<QuotaInventory> {
  const now = Date.now();
  if (invCache && now - invCache.at >= 0 && now - invCache.at < FACT_REFRESH_MS) return invCache.value;
  const value = await readInventoryQuota();
  invCache = { at: now, value };
  return value;
}
const DEFAULT_IO: FactsIo = { read: readInventoryCached, path: QUOTA_LINE_FACTS_PATH };

let memo: { facts: QuotaFacts; at: number } | null = null;
let inflight: Promise<QuotaFacts> | null = null;

/** 落盘的那份；不存在 / 坏了都当没有（坏的不往外传，下一次成功读数会整份覆盖） */
export function readFactsFile(path = QUOTA_LINE_FACTS_PATH): QuotaFacts {
  const r = readJsonStateSync(path);
  if (r.status !== "ok" || !r.data || typeof r.data !== "object") return {};
  const out: QuotaFacts = {};
  for (const f of LEND_FAMILIES) {
    const v = (r.data as Record<string, unknown>)[f];
    if (isFact(v)) out[f] = v;
  }
  return out;
}

/** 内存与文件两份合起来、过期的丢掉：别的进程刚读到的新数也能用上 */
function combined(now: number, path: string): QuotaFacts {
  const disk = readFactsFile(path);
  const out: QuotaFacts = {};
  for (const f of LEND_FAMILIES) {
    const v = newer(liveFact(memo?.facts[f], now), liveFact(disk[f], now));
    if (v) out[f] = v;
  }
  return out;
}

/**
 * 现读一次并记下（同一时刻只跑一份）。读失败时没有一族被更新，已有事实按本代规则沿用。
 * 落盘失败只记日志：内存里这份照用，别的进程拿不到新数时退回它们自己的旧数（仍只沿用本代），不会当成 0%。
 */
export function refreshQuotaFacts(now = Date.now(), io: FactsIo = DEFAULT_IO): Promise<QuotaFacts> {
  inflight ??= (async () => {
    let inv: QuotaInventory = {};
    try { inv = await io.read(); } catch (e) { console.warn(`⚠️ [lend-quota-line] 读本周额度失败，沿用本代窗口的上次读数：${(e as Error).message}`); }
    const facts = mergeReport(combined(now, io.path), inv, now);
    memo = { facts, at: now };
    try { writeJsonAtomicSync(io.path, facts, { mode: 0o600 }); } catch (e) { console.warn(`⚠️ [lend-quota-line] 记额度事实失败（本进程照用）：${(e as Error).message}`); }
    return facts;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** 同步拿此刻的事实（claim / hello 用）；内存那份过了 FACT_REFRESH_MS 就在后台补读，本次先用手上的 */
export function factsNow(now = Date.now(), io: FactsIo = DEFAULT_IO): QuotaFacts {
  if (!isTestProcess() && (!memo || now - memo.at >= FACT_REFRESH_MS || now < memo.at)) {
    // 补读自己兜住读额度 / 落盘的错；这里只防万一，丢掉也只是这一轮没补到新数
    refreshQuotaFacts(now, io).catch((e) => console.warn(`⚠️ [lend-quota-line] 后台补读额度失败：${(e as Error).message}`));
  }
  return combined(now, io.path);
}

/** 单测：回到进程刚起的样子 */
export const resetQuotaFactsForTest = (): void => { memo = null; inflight = null; invCache = null; };
