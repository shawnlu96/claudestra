"use client";
import { useT } from "@/lib/i18n";

/**
 * Peer 面板里的交接数字（数据由桥接 GET /peers 的 handoffs 字段给，见 src/lib/handoff-log.ts）：
 * 顶部一张近 7 天的汇总，每张 peer 卡片一行它自己的次数。只记时间和长度，不记内容。
 */

interface HandoffStatsInfo {
  total: number;
  in: number;
  out: number;
  replied: number;
  fallback: number;
  failed: number;
  medianMs: number | null;
  p90Ms: number | null;
}

export interface HandoffSummaryInfo extends HandoffStatsInfo {
  sinceMs: number;
  byPeer: Array<HandoffStatsInfo & { peer: string }>;
}

function useDuration() {
  const t = useT();
  return (ms: number | null): string => {
    if (ms === null) return "—";
    if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} ${t("秒")}`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)} ${t("分钟")}`;
    return `${(ms / 3_600_000).toFixed(1)} ${t("小时")}`;
  };
}

export function HandoffSummaryCard({ summary }: { summary: HandoffSummaryInfo | null }) {
  const t = useT();
  const dur = useDuration();
  if (!summary) return null;
  if (summary.total === 0) {
    return (
      <div className="rounded-xl bg-base-200/60 px-3 py-2 text-[11.5px] leading-relaxed text-base-content/50">
        {t("近 7 天还没有跨实例交接。双方 agent 互相找时会自动记在这里（只记时间和长度，不记内容）。")}
      </div>
    );
  }
  const cells: Array<[string, string]> = [
    [t("交接"), String(summary.total)],
    [t("回复中位"), dur(summary.medianMs)],
    [t("慢的 10%"), dur(summary.p90Ms)],
    [t("失败"), String(summary.failed)],
  ];
  return (
    <div className="rounded-xl bg-base-200/60 px-3 py-2">
      <div className="mb-1 text-[11px] text-base-content/50">
        {t("近 7 天")} · {t("找我")} {summary.in} · {t("我找")} {summary.out}
        {summary.fallback > 0 && ` · ${t("没正式回复")} ${summary.fallback}`}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {cells.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <div className="truncate font-mono text-[15px] tabular-nums">{v}</div>
            <div className="truncate text-[10.5px] text-base-content/45">{k}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** peer 卡片里的一行：近 7 天和这位的交接次数与回复中位 */
export function PeerHandoffLine({ summary, peer }: { summary: HandoffSummaryInfo | null; peer: string }) {
  const t = useT();
  const dur = useDuration();
  const s = summary?.byPeer.find((x) => x.peer === peer);
  if (!s || s.total === 0) return null;
  return (
    <div className="mt-0.5 text-[11px] text-base-content/45">
      {t("近 7 天交接")} {s.total} · {t("回复中位")} {dur(s.medianMs)}
      {s.failed > 0 && ` · ${t("失败")} ${s.failed}`}
    </div>
  );
}
