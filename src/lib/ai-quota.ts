/**
 * AI 能力清单的额度段（T91；tests/ai-quota.test.ts）：只读现成模块已经落盘的数据，不起调度器、不联网、不碰 Keychain。
 *   - 订阅额度（T2b-2）：quota-state.json 经 remoteViewOf + selectQuotaLayers，与网页额度看板同一套选层；刷新频率就是 bridge 调度器的
 *   - 本机缓存：statusline 落盘的 usage-cache（Claude）、最近一次 Codex rollout token_count 的 rate_limits / plan_type
 * 取不到就是 status "unknown" 加原因，百分比给 null；观测后已过重置时刻的旧百分比也给 null（新窗口用了多少没人知道，不推成 0 也不沿用旧值）。
 */

import { findLatestCodexQuota, toCodexQuota, type CodexQuotaObservation } from "./codex-usage.js";
import { readConfigSync } from "./config-store.js";
import { selectQuotaLayers, type LayerSource, type ProviderEntry, type QuotaSnapshot } from "./quota-layers.js";
import { remoteViewOf } from "./quota-scheduler.js";
import { fileQuotaStore } from "./quota-state.js";
import { readUsageCacheStale } from "./usage-cache.js";

interface InventoryQuotaWindow {
  id: string;
  kind: string;
  /** 已用百分比；不知道 = null */
  usedPct: number | null;
  resetsAtMs: number | null;
  /** 观测后已过重置时刻：usedPct 置 null，界面写「应已重置（未确认）」 */
  resetPassed: boolean;
}

export interface InventoryQuota {
  status: "known" | "unknown";
  /** live = 订阅接口实时；live_stale = 上次成功的快照；local_cache = 本机缓存（statusline / Codex rollout，不带账户身份） */
  source: LayerSource | null;
  observedAt: number | null;
  plan: string | null;
  windows: InventoryQuotaWindow[];
  reason: string | null;
}

export const unknownQuota = (reason: string): InventoryQuota =>
  ({ status: "unknown", source: null, observedAt: null, plan: null, windows: [], reason });

function fromEntry(e: ProviderEntry): InventoryQuota {
  const windows = e.meters.filter((m) => m.unit === "pct").map((m) => ({
    id: m.id,
    kind: m.kind,
    usedPct: m.resetPassed || typeof m.used !== "number" || !Number.isFinite(m.used) ? null : m.used,
    resetsAtMs: m.resetsAtMs ?? null,
    resetPassed: !!m.resetPassed,
  }));
  const known = windows.some((w) => w.usedPct !== null);
  return {
    status: known ? "known" : "unknown",
    source: e.source.layer,
    observedAt: e.source.observedAt,
    plan: e.plan ?? null,
    windows,
    reason: known ? e.source.reason : e.source.reason ?? (windows.length ? "观测到的窗口都已过重置时刻，新窗口用量未知" : "没有额度窗口数据"),
  };
}

/** 一家的额度：实时账户卡有数就用它；否则旧快照与本机缓存里观测更新的那份；都没有 → unknown */
export function quotaFor(snap: QuotaSnapshot, provider: "claude" | "codex"): InventoryQuota {
  const card = snap.providers.find((p) => p.id === provider);
  const local = snap.providers.find((p) => p.id === `${provider}.local`);
  const a = card ? fromEntry(card) : null;
  if (a?.status === "known" && a.source === "live") return a;
  const b = local ? fromEntry(local) : null;
  const known = [a, b].filter((q): q is InventoryQuota => q?.status === "known");
  if (known.length) return known.sort((x, y) => (y.observedAt ?? 0) - (x.observedAt ?? 0))[0]!;
  return a ?? b ?? unknownQuota(provider === "claude"
    ? "没有订阅额度快照，也没有 statusline 用量缓存"
    : "没有订阅额度快照，最近的 Codex 会话记录里也没有 rate_limits");
}

export interface QuotaReadDeps {
  now: number;
  enabled(): boolean;
  loadState: () => ReturnType<ReturnType<typeof fileQuotaStore>["load"]>;
  claudeCache: typeof readUsageCacheStale;
  codexRollout(now: number): Promise<CodexQuotaObservation | null>;
}

const productionDeps = (now: number): QuotaReadDeps => ({
  now,
  enabled: () => readConfigSync().quotaLive !== false,
  loadState: () => fileQuotaStore().load(),
  claudeCache: readUsageCacheStale,
  codexRollout: async (t) => {
    const raw = await findLatestCodexQuota();
    return raw ? toCodexQuota(raw, [], t) : null;
  },
});

/** 各来源独立失败：某一块读不到只少那一块，不让整份清单失败 */
export async function readInventoryQuota(d: QuotaReadDeps = productionDeps(Date.now())): Promise<Record<"claude" | "codex", InventoryQuota>> {
  const enabled = d.enabled();
  const [state, codexRollout] = await Promise.all([
    d.loadState().catch((e) => (console.error("[ai-inventory] 读订阅额度快照失败:", (e as Error).message), null)),
    d.codexRollout(d.now).catch((e) => (console.error("[ai-inventory] 读 Codex rollout 额度失败:", (e as Error).message), null)),
  ]);
  let claudeCache = null;
  try { claudeCache = d.claudeCache(d.now); } catch (e) { console.error("[ai-inventory] 读 statusline 用量缓存失败:", (e as Error).message); }
  const snap = selectQuotaLayers({
    now: d.now, enabled, remote: state ? remoteViewOf(state, d.now, enabled) : null, local: { claudeCache, codexRollout },
  });
  return { claude: quotaFor(snap, "claude"), codex: quotaFor(snap, "codex") };
}
