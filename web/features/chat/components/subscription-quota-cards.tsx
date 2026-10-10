"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { codexResetAction, resetConfirmParams, type ResetAction, type ResetOutcome } from "../quota-reset";
import { fmtTok, type QuotaView } from "../usage-view";
import type { useSubscriptionQuota } from "../use-subscription-quota";
import {
  balanceText, canRetry, entryRuntime, expiryParts, fmtAt, identityNote, layerLabel, meterLabel, reasonText,
  type EntryView, type MeterView, type QuotaPanelData,
} from "../quota-view";
import { CardTitle, ClaudeQuotaCard, CodexQuotaCard, fmtAge, GaugeRow, WarnIcon, type GlobalStats } from "./quota-cards";

/**
 * 用量看板顶部的「订阅额度」卡片组（bridge GET /api/v1/quota）：Claude、Codex（含重置次数与各自到期日）、
 * Pi 各接入商（本周 tokens / 花费），以及账户卡失效时的本机缓存条目。每张卡写明数据层（实时 / 实时过期 /
 * 本机缓存 / 无）与原因——旧数据不能装成现值。Codex 的重置卡可以在这里用（owner 要求加的，真实消费）：此刻可用 ≥ 1 才能点，
 * 点了先二次确认；Claude 的卡仍只展示。
 */

/** 使用 Codex 重置卡的状态与动作（use-subscription-quota.ts 的 reset）；不给 = 不出按钮 */
type ResetApi = { run: (key: string) => void; running: boolean; outcome: ResetOutcome | null };
const OUTCOME_TONE: Record<ResetOutcome["tone"], string> = { success: "text-success", info: "text-base-content/60", error: "text-error" };

/** 「使用一次重置」：不可用时置灰并写原因；可用时点了先出确认（写明会扣 1 次、到期时间、不可撤销），确认后显示进行中 */
function CodexResetControl({ action, reset }: { action: ResetAction; reset: ResetApi }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  if (confirming && action.enabled && !reset.running) {
    const c = resetConfirmParams(action);
    const go = () => {
      setConfirming(false);
      reset.run(action.key);
    };
    return (
      <div role="alertdialog" aria-label={t("使用一次重置")} className="space-y-1.5 rounded-lg bg-base-300 p-2">
        <div className="text-[11px] text-base-content/80">{t(c.key, c.params)}</div>
        <div className="flex justify-end gap-1.5">
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setConfirming(false)}>{t("取消")}</button>
          <button type="button" className="btn btn-error btn-xs" onClick={go}>{t("确认使用")}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-end gap-2">
      {!action.enabled && <span className="min-w-0 flex-1 text-[10.5px] text-base-content/45">{t(action.why)}</span>}
      <button
        type="button"
        className="btn btn-outline btn-xs -my-0.5 h-6 min-h-6 px-2 text-[10.5px]"
        disabled={!action.enabled || reset.running}
        onClick={() => setConfirming(true)}
      >
        {reset.running ? t("正在使用…") : t("使用一次重置")}
      </button>
    </div>
  );
}

function SourceRow({ e, onRetry, retrying }: { e: EntryView; onRetry: (p: "claude" | "codex") => void; retrying: boolean }) {
  const t = useT();
  const { layer, observedAt, reason } = e.source;
  const why = reasonText(reason);
  const who = identityNote(e);
  const retry = canRetry(e);
  const warn = layer === "live_stale" || layer === "none";
  return (
    <div className="flex items-start gap-2 text-[10.5px] text-base-content/40">
      <span className="min-w-0 flex-1">
        <span className={warn ? "text-warning-soft-80" : undefined}>
          {warn && <WarnIcon />} {t("数据")}：{t(layerLabel(e))}
        </span>
        {typeof observedAt === "number" && ` · ${fmtAge(observedAt)}`}
        {why && ` · ${t(why)}`}
        {who && ` · ${t(who)}`}
      </span>
      {retry && (
        <button className="btn btn-ghost btn-xs -my-1 h-6 min-h-6 px-2 text-[10.5px]" disabled={retrying} onClick={() => onRetry(retry)}>
          {t("重试")}
        </button>
      )}
    </div>
  );
}

function ValueRow({ m }: { m: MeterView }) {
  const t = useT();
  const v = m.used === null ? "—" : m.unit === "usd" ? `$${m.used.toFixed(2)}` : m.unit === "tokens" ? fmtTok(m.used) : String(m.used);
  return (
    <div className="flex justify-between gap-2 text-xs">
      <span className="text-base-content/60">{t(meterLabel(m))}</span>
      <span className="font-mono tabular-nums">{v}</span>
    </div>
  );
}

function ResetCredits({ e, c, reset }: { e: EntryView; c: NonNullable<EntryView["resetCredits"]>; reset?: ResetApi }) {
  const t = useT();
  const action = reset ? codexResetAction(e) : null;
  if (c.ineligibleReason) {
    return <div className="text-[10.5px] text-base-content/45">{t("这个入口看不到重置卡（原因：{why}）", { why: c.ineligibleReason })}</div>;
  }
  if (c.held <= 0 && !c.expiries?.length) return null;
  return (
    <div className="space-y-0.5 text-xs">
      <div className="flex justify-between gap-2">
        <span className="text-base-content/60">{t("免费额度重置")}</span>
        <span className="tabular-nums">{t("持有 {n} 次，此刻可用 {m} 次", { n: c.held, m: c.applicableNow })}</span>
      </div>
      {action && reset && <CodexResetControl action={action} reset={reset} />}
      {c.expiries && c.expiries.length > 0 && (
        <div className="space-y-0.5 text-[10.5px] text-base-content/45">
          {c.expiries.map((x, i) => (
            <div key={i}>{expiryParts(x).map((p) => t(p.key, p.params)).join(" · ")}</div>
          ))}
          {c.stale && <div className="text-warning-soft-80">{t("明细偏旧")}</div>}
        </div>
      )}
      {/* CC 界面原意：重置卡是补满额度，不挪动周重置日 */}
      {e.id === "claude" && <div className="text-[10.5px] text-base-content/40">{t("用了补满额度，周重置日不变")}</div>}
    </div>
  );
}

function EntryCard({ e, onRetry, retrying, reset }: { e: EntryView; onRetry: (p: "claude" | "codex") => void; retrying: boolean; reset?: ResetApi }) {
  const t = useT();
  const title = e.id.startsWith("pi:") ? `Pi · ${e.name}` : e.name;
  return (
    <div className="space-y-2.5 rounded-xl bg-base-200 p-3.5">
      <CardTitle runtime={entryRuntime(e)} title={title} tag={e.plan} />
      {e.meters.map((m) =>
        m.unit === "pct" ? (
          <GaugeRow
            key={m.id}
            label={t(meterLabel(m))}
            pct={m.used === null ? null : Math.round(m.used)}
            resets={m.resetsAtMs ? fmtAt(m.resetsAtMs) : undefined}
            passed={m.resetPassed}
          />
        ) : (
          <ValueRow key={m.id} m={m} />
        ),
      )}
      {e.balance && (
        <div className="flex justify-between gap-2 text-xs">
          <span className="text-base-content/60">{t("余额")}</span>
          <span className="font-mono tabular-nums">{balanceText(e.balance)}</span>
        </div>
      )}
      {e.meters.length === 0 && !e.balance && e.kind === "subscription" && <div className="text-xs text-base-content/45">{t("暂无数据")}</div>}
      {e.resetCredits && <ResetCredits e={e} c={e.resetCredits} reset={reset} />}
      {e.id === "codex" && reset?.outcome && (
        <div role="status" className={`text-[10.5px] ${OUTCOME_TONE[reset.outcome.tone]}`}>{t(reset.outcome.key, reset.outcome.params)}</div>
      )}
      <SourceRow e={e} onRetry={onRetry} retrying={retrying} />
    </div>
  );
}

export function SubscriptionQuotaCards({ data, onRetry, retrying, reset }: {
  data: QuotaPanelData;
  onRetry: (p: "claude" | "codex") => void;
  retrying: boolean;
  reset?: ResetApi;
}) {
  const t = useT();
  return (
    <div className="mb-3 space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-base-content/40">{t("订阅额度")}</div>
      {!data.enabled && <div className="text-[10.5px] text-base-content/45">{t("实时读取已关闭，只显示本机缓存（设置 · 集成里可打开）")}</div>}
      {data.entries.map((e) => (
        <EntryCard key={e.id} e={e} onRetry={onRetry} retrying={retrying} reset={reset} />
      ))}
      {data.entries.length === 0 && <div className="rounded-xl bg-base-200 p-3.5 text-xs text-base-content/45">{t("暂无数据")}</div>}
    </div>
  );
}

/**
 * 看板顶部的额度区：有订阅额度数据就只画卡片组（本机缓存已作为 *.local 条目在里面）；拿不到（403 / 404 / 503）退回旧卡：
 * Claude 订阅（/status 抓取 + 状态栏缓存）+ 最近一次 Codex 会话看到的（没有 Codex rollout 的机器没有这张）。
 */
export function QuotaArea({ quota, g, quotas }: { quota: ReturnType<typeof useSubscriptionQuota>; g: GlobalStats | null; quotas: QuotaView[] }) {
  const t = useT();
  if (quota.sub) return <SubscriptionQuotaCards data={quota.sub} onRetry={quota.retry} retrying={quota.retrying} reset={quota.reset} />;
  return (
    <>
      {/* 账号 gauge 还没到手（bridge 冷启动首抓中）——给占位而不是整块消失 */}
      {!g && (
        <div className="mb-3 rounded-xl bg-base-200 p-3.5 text-xs text-base-content/50">
          {t("账号用量抓取中…约几秒后自动显示，也可点右上角刷新强制重抓")}
        </div>
      )}
      {g && <ClaudeQuotaCard g={g} />}
      {quotas.map((q) => (
        <CodexQuotaCard key={`${q.source}:${q.sessionId ?? ""}`} q={q} />
      ))}
    </>
  );
}
