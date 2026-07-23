"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useChatStore, useChatStoreApi } from "../chat-store";
import { ctxLevel, CTX_WINDOW } from "../ctx-level";
import { fmtAgo } from "../fmt-time";
import { getLang, t, useT } from "@/lib/i18n";

/**
 * 用量/上下文看板（2026-07-14 owner：context 要成体系,web 看板可以更详细）。
 * 顶部 = 全局订阅用量(Bridge /stats);列表 = 各 agent 上下文占用条
 * (200k 参考刻度)+ 忙碌态 + 最后对话时间。侧栏 📊 进入,portal 到 body。
 */

interface GlobalStats {
  sessionPct?: number;
  sessionResets?: string;
  weekPct?: number;
  weekResets?: string;
  totalCost?: string;
  /** 账号 gauge 抓取时刻——不标年龄用户会把旧缓存当实时（owner 2026-07-14「停在 15%」） */
  scrapedAt?: number;
}

function fmtAge(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 90_000) return t("刚刚");
  if (ms < 3_600_000)
    return getLang() === "en" ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 60_000)} 分钟前`;
  return getLang() === "en" ? `${(ms / 3_600_000).toFixed(1)} h ago` : `${(ms / 3_600_000).toFixed(1)} 小时前`;
}

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-base-content/10">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

/** bridge /stats agents 项（只取本面板要用的字段） */
interface StatAgent {
  name: string;
  today?: { tokens: number; costUsd?: number };
  week?: { tokens: number; costUsd?: number };
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// 相对时间与侧栏列表统一口径(x秒前/x分钟前/x小时x分前/x天前)
const fmtRel = fmtAgo;

export function StatsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const store = useChatStoreApi();
  const agents = useChatStore((s) => s.state.agents);
  const [g, setG] = useState<GlobalStats | null>(null);
  const [statAgents, setStatAgents] = useState<StatAgent[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  // 冷启动自动补拉只试一次/每次打开(openRef 防面板已关还在拉)
  const retriedRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;

  const load = (force: boolean) => {
    if (force) setRefreshing(true);
    // 上下文占用行的数据在 agents store 里——打开/手动刷新都顺带静默重拉，
    // 否则「刷新」只刷账号用量，ctx 行看起来点了没反应（2026-07-16 用户实报）
    store.refreshAgents();
    fetch(force ? "/api/stats?refresh=1" : "/api/stats")
      .then((r) => r.json())
      .then((j: { global?: GlobalStats; agents?: StatAgent[] }) => {
        setG(j.global ?? null);
        setStatAgents(Array.isArray(j.agents) ? j.agents : []);
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

  return createPortal(
    <div className="overlay-in fixed inset-0 z-[80] grid place-items-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="panel-pop flex max-h-[85dvh] w-full max-w-md flex-col rounded-2xl bg-base-100 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
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
          {/* 账号 gauge 还没到手(bridge 冷启动首抓中)——给占位而不是整块消失 */}
          {!g && (
            <div className="mb-4 rounded-xl bg-base-200 p-3.5 text-xs text-base-content/50">
              {t("账号用量抓取中…约几秒后自动显示，也可点右上角刷新强制重抓")}
            </div>
          )}
          {/* 全局订阅用量 */}
          {g && (
            <div className="mb-4 space-y-3 rounded-xl bg-base-200 p-3.5">
              <div>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-base-content/60">{t("本时段用量")}</span>
                  <span className="font-mono tabular-nums">
                    {g.sessionPct ?? "?"}%
                    {g.sessionResets && <span className="ml-1.5 opacity-50">{t("重置")} {g.sessionResets}</span>}
                  </span>
                </div>
                <Bar pct={g.sessionPct ?? 0} tone={(g.sessionPct ?? 0) >= 80 ? "bg-error" : "bg-primary"} />
              </div>
              <div>
                <div className="mb-1 flex justify-between text-xs">
                  <span className="text-base-content/60">{t("本周用量")}</span>
                  <span className="font-mono tabular-nums">
                    {g.weekPct ?? "?"}%
                    {g.weekResets && <span className="ml-1.5 opacity-50">{t("重置")} {g.weekResets}</span>}
                  </span>
                </div>
                <Bar pct={g.weekPct ?? 0} tone={(g.weekPct ?? 0) >= 80 ? "bg-error" : "bg-primary"} />
              </div>
              {/* 全机折算成本（owner 2026-07-14 点选替换掉误导性的「累计成本」——
                  旧值是被借去抓 /status 的那个窗口单会话的数）：Σ 所有活跃 agent
                  的今日/本周 token × 各模型 API 牌价。订阅制不按此扣费,仅参考。 */}
              {statAgents.length > 0 && (() => {
                const td = statAgents.reduce((s, a) => s + (a.today?.costUsd || 0), 0);
                const wk = statAgents.reduce((s, a) => s + (a.week?.costUsd || 0), 0);
                const tdTok = statAgents.reduce((s, a) => s + (a.today?.tokens || 0), 0);
                const wkTok = statAgents.reduce((s, a) => s + (a.week?.tokens || 0), 0);
                return (
                  <>
                    <div className="flex justify-between text-xs">
                      <span className="text-base-content/60">{t("今日全机用量")}</span>
                      <span className="font-mono tabular-nums">
                        {fmtTok(tdTok)} tok · ${td.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-base-content/60">{t("本周全机用量")}</span>
                      <span className="font-mono tabular-nums">
                        {fmtTok(wkTok)} tok · ${wk.toFixed(2)}
                      </span>
                    </div>
                    <div className="text-[10.5px] text-base-content/35">
                      {t("成本为 API 牌价折算（订阅制实际不按此扣费）· 活跃 agent 合计")}
                    </div>
                  </>
                );
              })()}
              {typeof g.scrapedAt === "number" && g.scrapedAt > 0 && (
                <div className="text-[10.5px] text-base-content/35">
                  {t("账号用量抓取于")} {fmtAge(g.scrapedAt)}
                  {Date.now() - g.scrapedAt > 15 * 60_000 && ` ${t("⚠️ 数据偏旧")}`}
                </div>
              )}
            </div>
          )}

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
              const tone = {
                deep: "bg-error",
                high: "bg-error/60",
                mid: "bg-warning",
                none: "bg-success",
              }[ctxLevel(tok)];
              return (
                <div key={a.name}>
                  <div className="mb-1 flex items-center gap-1.5 text-xs">
                    {a.busy && <span className="size-1.5 rounded-full bg-warning" />}
                    <span className="truncate">{t(a.displayName)}</span>
                    <span className="ml-auto font-mono tabular-nums text-base-content/60">
                      {Math.round(tok / 1000)}k
                    </span>
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
      </div>
    </div>,
    document.body
  );
}
