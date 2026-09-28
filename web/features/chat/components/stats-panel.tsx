"use client";
import { useEffect, useRef, useState } from "react";
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
  const quotaState = useSubscriptionQuota(open);
  // 冷启动自动补拉只试一次/每次打开(openRef 防面板已关还在拉)
  const retriedRef = useRef(false);
  const openRef = useRef(open);
  // 同 composer：ref 的最新值在 effect 里同步，避免在可能被丢弃的 render 里写。
  useEffect(() => {
    openRef.current = open;
  });

  const load = (force: boolean) => {
    if (force) void quotaState.reload();
    if (force) setRefreshing(true);
    // 上下文占用行的数据在 agents store 里——打开/手动刷新都顺带静默重拉，
    // 否则「刷新」只刷账号用量，ctx 行看起来点了没反应（2026-07-16 用户实报）
    store.refreshAgents();
    stats<{ global?: GlobalStats; agents?: StatAgent[]; quotas?: unknown; machine?: unknown; window?: unknown }>(force)
      .then((j) => {
        setG(j.global ?? null);
        setUsage(usageTableData(j));
        setQuotas(codexQuotas(j.quotas));
        // bridge 刚重启时账号 gauge 缓存为空——本次请求已在服务端触发后台抓取,
        // ~6.5s 后静默重拉补上,不用用户手点刷新
        if (!j.global && !retriedRef.current) {
          retriedRef.current = true;
          setTimeout(() => {
            if (openRef.current) load(false);
          }, 6500);
        }
      })
      .catch(() => {})
      .finally(() => setRefreshing(false));
  };

  useEffect(() => {
    if (!open) return;
    retriedRef.current = false;
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
            title={t("强制重抓账号用量（最长约 20 秒）")}
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
