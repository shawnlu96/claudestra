"use client";
import { useT } from "@/lib/i18n";
import type { SubSessionRow } from "@/lib/session-nesting";

export { nestSubSessions, type SubSessionInfo } from "@/lib/session-nesting";

/** 行标题：子会话前面挂「↳ 昵称 / 自动审查 / 子会话」徽章 */
export function SessionName({ s }: { s: SubSessionRow }) {
  const t = useT();
  const tag = s.sub ? (s.sub.nickname ?? (s.sub.kind === "guardian_review" ? t("自动审查") : t("子会话"))) : null;
  return (
    <>
      {tag ? (
        <span className="shrink-0 rounded bg-base-content/10 px-1 text-[10px] text-base-content/60" title={t("子会话")}>
          ↳ {tag}
        </span>
      ) : null}
      <span className="truncate text-base-content/80">{s.name || s.sessionId.slice(0, 8)}</span>
    </>
  );
}
