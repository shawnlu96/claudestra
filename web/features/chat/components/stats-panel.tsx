"use client";
import { useEffect, useState } from "react";
import { CenteredModal } from "./centered-modal";
import { useChatStore, useChatStoreApi } from "../chat-store";
import { ctxLevel, CTX_WINDOW } from "../ctx-level";
import { fmtAgo } from "../fmt-time";
import { useT } from "@/lib/i18n";
import { RuntimeBadge } from "./runtime-badge";
import { CtxBoundaryChip } from "./ctx-boundary-chip";
import { BOUNDARY_BAR } from "../ctx-boundary-view";
import { stats } from "@/lib/api/system";
import { Bar, UsageTable, type GlobalStats } from "./quota-cards";
import { QuotaArea } from "./subscription-quota-cards";
import { codexQuotas, usageTableData, type QuotaView, type StatAgent, type UsageTableData } from "../usage-view";
import { useSubscriptionQuota } from "../use-subscription-quota";

/**
 * 用量/上下文看板（2026-07-14 owner：context 要成体系,web 看板可以更详细）。
 * 顶部 = 订阅额度卡片组（/api/v1/quota，打开期间每 60 秒拉一次——这也是 bridge 判「有人在看」的心跳）；
 * 拿不到（非 owner 403 / 老 bridge 404 / 服务没起 503）退回旧的额度卡（Claude 订阅 + 最近一次 Codex 会话看到的）。
 * 其下是按 runtime 分行的 token / 花费
 * (Bridge /stats);列表 = 各 agent 上下文占用条 + 忙碌态 + 最后对话时间。侧栏 📊 进入,portal 到 body。
 */

// 相对时间与侧栏列表统一口径(x秒前/x分钟前/x小时x分前/x天前)
const fmtRel = fmtAgo;

export function StatsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const store = useChatStoreApi();
  const agents = useChatStore((s) => s.state.agents);
  const [g, setG] = useState<GlobalStats | null>(null);
  const [usage, setUsage] = useState<UsageTableData>({ agents: [], machine: null, window: null, sandbox: false });
  // 老 bridge 没有 quotas 字段 → 空数组，不画 Codex 卡
  const [quotas, setQuotas] = useState<QuotaView[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  // 上次点刷新的结果（bridge 的手动探测闸：失败后 30 分钟内再点也不探测，给下一可刷新时间）
  const [refreshNote, setRefreshNote] = useState<RefreshNote | null>(null);
  const quotaState = useSubscriptionQuota(open);

  const load = (force: boolean) => {
    if (force) void quotaState.reload();
    if (force) setRefreshing(true);
    // 上下文占用行的数据在 agents store 里——打开/手动刷新都顺带静默重拉，
    // 否则「刷新」只刷账号用量，ctx 行看起来点了没反应（2026-07-16 用户实报）
    store.refreshAgents();
    // 打开面板只读缓存（后台从不抓 TUI）；没有读数时 global 的百分比是 null，卡片显示「?」而不是 0
    stats<{ global?: GlobalStats & { source?: string; stale?: boolean; reason?: string | null }; agents?: StatAgent[]; quotas?: unknown;
      machine?: unknown; window?: unknown; refresh?: RefreshNote }>(force)
      .then((j) => {
        setG(j.global ?? null);
        setUsage(usageTableData(j));
        setQuotas(codexQuotas(j.quotas));
        if (force) setRefreshNote(j.refresh ?? null);
        else if (j.global?.source === "none") setRefreshNote({ outcome: "unknown", nextAllowedAt: null, reason: j.global.reason ?? null });
      })
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };

  useEffect(() => {
    if (!open) return;
    setRefreshNote(null);
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const rows = agents
    .filter((a) => typeof a.contextTokens === "number" && a.contextTokens! > 0)
    .sort((a, b) => (b.contextTokens ?? 0) - (a.contextTokens ?? 0));

  return (
    <CenteredModal onClose={onClose} layer="base" tall={false}>
        <div className="flex items-center px-5 pb-2 pt-4">
          <span className="text-base font-semibold">{t("用量看板")}</span>
          <button
            className="ml-auto flex size-7 items-center justify-center rounded-lg text-base-content/50 transition-colors hover:bg-base-200 hover:text-base-content disabled:opacity-40"
            aria-label={t("强制刷新账号用量")}
            title={t("用独立临时会话读取账号用量（最长约 90 秒；失败后 30 分钟内不再读取）")}
            disabled={refreshing}
            onClick={() => load(true)}
          >
            {/* 与侧栏图标同一套 SVG 线条语言（emoji 🔄 被 owner 嫌丑）;刷新中自转 */}
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={refreshing ? "animate-spin" : ""}
            >
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M8 16H3v5" />
            </svg>
          </button>
          <button
            className="flex size-7 items-center justify-center rounded-lg text-base-content/50 transition-colors hover:bg-base-200 hover:text-base-content"
            aria-label={t("关闭")}
            onClick={onClose}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
          {refreshNote && <RefreshNoteLine note={refreshNote} />}
          <QuotaArea quota={quotaState} g={g} quotas={quotas} />
          {/* token 与花费按 runtime 分行（Claude Code / Codex / Pi 口径各不相同，混着看互相淹没） */}
          {(usage.agents.length > 0 || usage.machine) && <UsageTable {...usage} />}

          {/* 各 agent 上下文占用(1M 参考刻度) */}
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-base-content/40">
            {t("各会话上下文占用")}
          </div>
          <div className="space-y-3">
            {rows.map((a) => {
              // tok 不叫 t——外层 t 是翻译函数,遮蔽了 displayName 就没法翻(review 2026-07-18)
              const tok = a.contextTokens!;
              const pct = (tok / CTX_WINDOW) * 100;
              // 色阶(owner 定阈值,1M 窗):≥750k 深红(实色) / ≥500k 红 / ≥200k 黄 / 其余绿
              // 有上下文边界的（Claude Code）按边界上色：过压缩线黄、过硬上限红；没有的（Codex / Pi）照旧按 1M 刻度
              const b = a.ctxBoundary;
              const tone = b ? BOUNDARY_BAR[b.level] : { deep: "bg-error", high: "bg-error/60", mid: "bg-warning", none: "bg-success" }[ctxLevel(tok)];
              return (
                <div key={a.name}>
                  <div className="mb-1 flex items-center gap-1.5 text-xs">
                    {a.busy && <span className="size-1.5 rounded-full bg-warning" />}
                    <span className="truncate">{t(a.displayName)}</span>
                    {/* v2.23+ Pi 与 CC 的窗口差 10 倍(1M vs 200k)，条子上得看得出来 */}
                    <RuntimeBadge runtime={a.runtime ?? ""} />
                    <span className="ml-auto font-mono tabular-nums text-base-content/60">
                      {Math.round(tok / 1000)}k
                    </span>
                    {b && <CtxBoundaryChip b={b} />}
                    <span className="font-mono text-[10px] tabular-nums text-base-content/35">
                      {fmtRel(a.lastActivityTs)}
                    </span>
                  </div>
                  <Bar pct={pct} tone={tone} />
                </div>
              );
            })}
            {rows.length === 0 && (
              <div className="py-4 text-center text-xs opacity-40">{t("暂无数据")}</div>
            )}
          </div>
        </div>
    </CenteredModal>
  );
}

/** bridge POST /stats/refresh 的 refresh 字段；unknown = 打开面板时没有任何读数 */
interface RefreshNote {
  outcome: "refreshed" | "backoff" | "failed" | "busy" | "unknown";
  nextAllowedAt: number | null;
  reason: string | null;
}

function RefreshNoteLine({ note }: { note: RefreshNote }) {
  const t = useT();
  // busy = 别的请求正在读，结果很快就到；refreshed 卡片自己会显示新读数
  if (note.outcome === "refreshed" || note.outcome === "busy") return null;
  const time = note.nextAllowedAt ? new Date(note.nextAllowedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
  return (
    <div className="mb-3 rounded-xl bg-base-200 p-3 text-xs text-base-content/60">
      {note.outcome === "unknown" ? t("账号用量未知（没有状态栏缓存），可点右上角刷新读取一次") : t("读取账号用量失败，显示的是上次读数或未知；{time} 前不再重试", { time })}
    </div>
  );
}
