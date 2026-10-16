"use client";
/**
 * 额度摘要（QUOTA1）：「Claude 本周已用 62% · Codex 本周已用 18%」，到线 / 用完的族后面跟状态字（警示色）。只读 quota-lines-store
 * 的同一份读数，不另外轮询；读不到（403 / 404 / 失败）整行不出。「今天 · 团队与额度」的额度行与用量看板顶部共用。
 */
import { useT } from "@/lib/i18n";
import { useQuotaLinesReading, useQuotaWallReading } from "./quota-lines-store";
import { summaryParts, usedPhrase } from "./quota-notice-model";

const TONE = { warning: "text-warning", error: "text-error" } as const;

/** hook = 文字那一段的 DOM 钩子（今天页用 data-now-quota）；trailing = 行尾的链接 */
export function QuotaSummary({ className, hook, trailing }: { className?: string; hook?: string; trailing?: React.ReactNode }) {
  const t = useT();
  const lines = useQuotaLinesReading();
  const wall = useQuotaWallReading();
  const parts = summaryParts(lines.value, wall.value, Math.max(lines.at, wall.at));
  if (!parts) return null;
  return (
    <p className={className} data-quota-summary>
      <span {...(hook ? { [hook]: "" } : {})}>
        {parts.map((p, i) => (
          <span key={p.family} data-quota-summary-family={p.family}>
            {i > 0 && " · "}
            {t(usedPhrase(p).text, usedPhrase(p).vars)}
            {p.tag && (
              <span className={`font-medium transition-colors duration-200 motion-reduce:transition-none ${TONE[p.tone!]}`}>
                {" "}{t(p.tag.text, p.tag.vars)}
              </span>
            )}
          </span>
        ))}
      </span>
      {trailing}
    </p>
  );
}
