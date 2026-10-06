/**
 * 额度线用的「本周已用」事实（QLINE1）：来源只有 quota-week.ts readWeekQuota（AI 清单的额度段，自带 60 秒缓存），不另扫描、不另登录。
 * 每次成功读到某族的周窗口就记一份 {weekUsedPct, resetAt, readAt}，进程内一份、statePath 一份（一次性的收单进程、重启后也能用）。
 * 用哪份：同族里 readAt 最新、且 resetAt 还没到的那份。读失败 / 这族没周窗口时沿用本代窗口（同一个 resetAt）的上次读数——
 * 周内用量只增不减，上次读数是下界，不会因为读失败就当成 0%；resetAt 一过这份作废（新窗口用了多少没人知道）= unknown。
 * claim / hello 是同步路径：factsNow 只读缓存，过期了在后台补读一次（测试进程不补读，由测试显式 refresh）。tests/lend-quota-line-facts.test.ts。
 */
import { LEND_FAMILIES, type LendFamily } from "./lend-wire-types.js";
import { statePath } from "./paths.js";
import { readWeekQuota, type QuotaReport } from "./quota-week.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { isTestProcess } from "./test-guard.js";

export const QUOTA_LINE_FACTS_PATH = statePath("lend-quota-line-facts.json");
/** 进程内缓存多久后补读一次；与 readWeekQuota 自己的 60 秒缓存对齐，再短也读不到更新的数 */
export const FACT_REFRESH_MS = 60_000;
/** 比本机此刻还晚这么多的 readAt = 时钟被往回拨过或文件被人改过：不信这份 */
const FUTURE_SKEW_MS = 5 * 60_000;

export interface QuotaFact { weekUsedPct: number; resetAt: number; readAt: number }
export type QuotaFacts = Partial<Record<LendFamily, QuotaFact>>;

const isFact = (v: unknown): v is QuotaFact => {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o === "object" && [o.weekUsedPct, o.resetAt, o.readAt].every((n) => typeof n === "number" && Number.isFinite(n))
    && (o.weekUsedPct as number) >= 0 && (o.weekUsedPct as number) <= 100;
};

/** 某族此刻可用的事实：resetAt 没到、readAt 不在未来；否则 undefined（= unknown） */
export function liveFact(f: QuotaFact | undefined, now: number): QuotaFact | undefined {
  return f && f.resetAt > now && f.readAt <= now + FUTURE_SKEW_MS ? f : undefined;
}

/** 两份里取 readAt 新的那份（各自先过 liveFact） */
const newer = (a: QuotaFact | undefined, b: QuotaFact | undefined): QuotaFact | undefined => (!a ? b : !b ? a : b.readAt > a.readAt ? b : a);

/** 一次读数并进旧事实：读到的族换成新数（含新窗口），没读到的族沿用本代的旧数；过期的一律丢 */
export function mergeReport(prev: QuotaFacts, report: QuotaReport, now: number): QuotaFacts {
  const out: QuotaFacts = {};
  for (const f of LEND_FAMILIES) {
    const r = report[f];
    const fact = r ? { weekUsedPct: r.weekUsedPct, resetAt: r.resetAt, readAt: now } : liveFact(prev[f], now);
    if (liveFact(fact, now)) out[f] = fact;
  }
  return out;
}

export interface FactsIo {
  read(): Promise<QuotaReport>;
  path: string;
}
const DEFAULT_IO: FactsIo = { read: () => readWeekQuota(), path: QUOTA_LINE_FACTS_PATH };

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
 * 现读一次并记下（同一时刻只跑一份）。readWeekQuota 读失败返回 {}：这时没有一族被更新，旧数按本代规则沿用。
 * 落盘失败只记日志：内存里这份照用，别的进程拿不到新数时退回它们自己的旧数（仍只沿用本代），不会当成 0%。
 */
export function refreshQuotaFacts(now = Date.now(), io: FactsIo = DEFAULT_IO): Promise<QuotaFacts> {
  inflight ??= (async () => {
    let report: QuotaReport = {};
    try { report = await io.read(); } catch (e) { console.warn(`⚠️ [lend-quota-line] 读本周额度失败，沿用本代窗口的上次读数：${(e as Error).message}`); }
    const facts = mergeReport(combined(now, io.path), report, now);
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
export const resetQuotaFactsForTest = (): void => { memo = null; inflight = null; };
