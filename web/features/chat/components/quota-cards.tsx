"use client";
import { Fragment } from "react";
import { getLang, t as tr, useT } from "@/lib/i18n";
import { RuntimeBadge } from "./runtime-badge";
import {
  claudeQuotaSource,
  fmtUsageCell,
  groupUsageRows,
  listPriceUsd,
  quotaOrigin,
  weekColumnNote,
  windowLabel,
  type MachineView,
  type QuotaView,
  type StatAgent,
  type UsageWindowView,
} from "../usage-view";

/**
 * 用量看板的三张卡：Claude 订阅额度、最近一次 Codex 会话看到的额度、token 与花费。
 * 每张额度卡都写明数据从哪来、多久之前观测到的——额度不是实时推送，旧值不能装成现值。
 */

export interface GlobalStats {
  sessionPct?: number;
  sessionResets?: string;
  weekPct?: number;
  weekResets?: string;
  totalCost?: string;
  /** 账号 gauge 抓取时刻——不标年龄用户会把旧缓存当实时 */
  scrapedAt?: number;
  /** bridge 的来源标记（statusline 缓存 / 推算）或 /status 面板原文 */
  raw?: string;
}

/** 超过这么久没新观测就标「数据偏旧」 */
const STALE_MS = 15 * 60_000;

export function fmtAge(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 90_000) return tr("刚刚");
  if (ms < 3_600_000)
    return getLang() === "en" ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 60_000)} 分钟前`;
  return getLang() === "en" ? `${(ms / 3_600_000).toFixed(1)} h ago` : `${(ms / 3_600_000).toFixed(1)} 小时前`;
}

const isStale = (ts: number) => Date.now() - ts > STALE_MS;

export function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-base-content/10">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

export function WarnIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="inline-block align-[-1px]">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function CardTitle({ runtime, title, tag }: { runtime: string; title: string; tag?: string | null }) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium">
      <RuntimeBadge runtime={runtime} />
      <span className="truncate">{title}</span>
      {tag && <span className="ml-auto rounded-md bg-base-content/10 px-1.5 py-px font-mono text-[10.5px] text-base-content/60">{tag}</span>}
    </div>
  );
}

/** 一条额度窗口：百分比 + 重置时间；过了重置时刻只说「待刷新」，不把旧百分比当现值 */
export function GaugeRow({ label, pct, resets, passed }: { label: string; pct?: number | null; resets?: string; passed?: boolean }) {
  const t = useT();
  return (
    <div>
      <div className="mb-1 flex justify-between gap-2 text-xs">
        <span className="text-base-content/60">{label}</span>
        {passed ? (
          <span className="text-base-content/50">{t("已过重置时间，待刷新")}</span>
        ) : (
          <span className="font-mono tabular-nums">
            {pct ?? "?"}%
            {resets && <span className="ml-1.5 opacity-50">{t("重置")} {resets}</span>}
          </span>
        )}
      </div>
      <Bar pct={passed ? 0 : (pct ?? 0)} tone={!passed && (pct ?? 0) >= 80 ? "bg-error" : "bg-primary"} />
    </div>
  );
}

/** 来源 + 新鲜度一行；超过 15 分钟没新观测加「数据偏旧」 */
function SourceLine({ source, ts }: { source: string; ts?: number }) {
  const t = useT();
  const has = typeof ts === "number" && ts > 0;
  return (
    <div className="text-[10.5px] text-base-content/35">
      {source}
      {has && ` · ${fmtAge(ts)}`}
      {has && isStale(ts) && (
        <span className="ml-1 text-warning-soft-80">
          <WarnIcon /> {t("数据偏旧")}
        </span>
      )}
    </div>
  );
}

const CLAUDE_SOURCE_LABEL = {
  statusline: "来源：Claude Code 状态栏",
  "statusline-stale": "来源：Claude Code 状态栏（已停写，过了重置时间的窗口按 0% 推算）",
  "status-panel": "来源：/status 面板抓取",
} as const;

export function ClaudeQuotaCard({ g }: { g: GlobalStats }) {
  const t = useT();
  const src = claudeQuotaSource(g.raw);
  return (
    <div className="mb-3 space-y-3 rounded-xl bg-base-200 p-3.5">
      <CardTitle runtime="claude-code" title={t("Claude 订阅额度")} />
      <GaugeRow label={t("本时段用量")} pct={g.sessionPct} resets={g.sessionResets} />
      <GaugeRow label={t("本周用量")} pct={g.weekPct} resets={g.weekResets} />
      <SourceLine source={src ? t(CLAUDE_SOURCE_LABEL[src]) : t("账号用量")} ts={g.scrapedAt} />
    </div>
  );
}

export function CodexQuotaCard({ q }: { q: QuotaView }) {
  const t = useT();
  const en = getLang() === "en";
  const c = q.credits;
  const origin = quotaOrigin(q);
  return (
    <div className="mb-3 space-y-3 rounded-xl bg-base-200 p-3.5">
      <CardTitle runtime="codex" title={t("最近一次 Codex 会话看到的额度")} tag={q.plan} />
      {(q.windows ?? []).map((w) => (
        <GaugeRow key={w.id} label={windowLabel(w.id, en)} pct={w.pct} resets={w.resets} passed={w.resetPassed} />
      ))}
      {q.limitReached && (
        <div className="text-xs text-error">
          <WarnIcon /> {t("已撞到限额")}：{q.limitReached}
        </div>
      )}
      {c && (c.unlimited || c.hasCredits) && (
        <div className="text-xs text-base-content/60">
          {t("Credits 余额")}：{c.unlimited ? t("不限") : (c.balance ?? "?")}
        </div>
      )}
      <SourceLine source={`${t("来源：Codex 会话记录")}${origin ? ` · ${origin}` : ""}`} ts={q.observedAt} />
    </div>
  );
}

export function UsageTable({ agents, machine, window: win, sandbox }: {
  agents: StatAgent[];
  machine?: MachineView | null;
  window?: UsageWindowView | null;
  sandbox?: boolean;
}) {
  const t = useT();
  const rows = groupUsageRows(agents, machine);
  const weekNote = weekColumnNote(win, getLang() === "en");
  const unpriced = rows.some((r) => r.kind === "usage" && (listPriceUsd(r.today) === null || listPriceUsd(r.week) === null));
  const reported = rows.some((r) => r.kind === "reported");
  return (
    <div className="mb-4 space-y-1.5 rounded-xl bg-base-200 p-3.5">
      <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-3 gap-y-0.5 text-xs">
        <span className="font-medium">{t("token 与花费")}</span>
        <span className="text-right text-[10.5px] text-base-content/40">{t("今日")}</span>
        <span className="text-right text-[10.5px] leading-tight text-base-content/40">
          {t("本周")}
          {weekNote && <span className="block text-[9.5px] text-base-content/35">{weekNote}</span>}
        </span>
        {rows.map((r) => (
          <Fragment key={r.key}>
            <span
              className={
                r.kind === "reported"
                  ? "pl-3 text-[10.5px] text-base-content/45"
                  : r.key === "agents" || r.key === "others"
                    ? "pl-3 text-base-content/50"
                    : "text-base-content/60"
              }
            >
              {t(r.label)}
            </span>
            <span className="text-right font-mono tabular-nums">{fmtUsageCell(r, "today")}</span>
            <span className="text-right font-mono tabular-nums">{fmtUsageCell(r, "week")}</span>
          </Fragment>
        ))}
      </div>
      <div className="text-[10.5px] text-base-content/35">{t("成本为 API 牌价折算（订阅制实际不按此扣费）")}</div>
      {machine && (
        <div className="text-[10.5px] text-base-content/35">
          {t("这台机器合计 = 全部会话（含已结束的 agent、子 agent、终端里直接开的），同一次响应只计一次")}
          {/* 全机合计有 60 秒缓存，agent 行是即时的：「其他会话」是两者相减，标出扫描时刻免得把差值当精确值 */}
          {typeof machine.scannedAt === "number" && ` · ${t("扫描于")} ${fmtAge(machine.scannedAt)}`}
        </div>
      )}
      {sandbox && <div className="text-[10.5px] text-base-content/35">{t("沙箱内不统计全机，只有 agent 当前会话")}</div>}
      {weekNote && win?.weekSource === "quota" && (
        <div className="text-[10.5px] text-base-content/35">{t("本周 = 当前周额度周期，与上面的周额度条同一口径")}</div>
      )}
      {unpriced && <div className="text-[10.5px] text-base-content/35">{t("「—」= 没有牌价可折算（如 Codex 的模型）")}</div>}
      {reported && (
        <div className="text-[10.5px] text-base-content/35">
          {t("运行时报告的费用：Pi 会话记录里的 usage.cost，是 Pi 按自己的价目表算的，不是账单；与牌价折算分开记")}
        </div>
      )}
    </div>
  );
}
