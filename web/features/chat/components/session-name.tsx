"use client";
import { useCallback, useState } from "react";
import { useT } from "@/lib/i18n";
import type { SubSessionRow } from "@/lib/session-nesting";

export { sessionRowKey, sessionTree, type SubSessionInfo } from "@/lib/session-nesting";

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

/** 折叠状态：展开了的行键集合（默认全收起——子会话多，一展开就把列表撑满） */
export function useFold(): { open: ReadonlySet<string>; toggle: (key: string) => void } {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => setOpen((s) => { const n = new Set(s); if (!n.delete(key)) n.add(key); return n; }), []);
  return { open, toggle };
}

/** 行首折叠开关：有子会话显示 ▸/▾ + 数量，没有就留同宽空位，让各行名字对齐 */
export function FoldToggle({ kids, open, onToggle }: { kids: number; open: boolean; onToggle: () => void }) {
  const t = useT();
  if (kids === 0) return <span className="w-7 shrink-0" />;
  return (
    <button
      type="button"
      className="flex w-7 shrink-0 touch-manipulation flex-col items-center pt-1.5 text-[10px] leading-tight text-base-content/45 hover:text-base-content/80"
      title={open ? t("收起子会话") : t("展开子会话")}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="text-[11px]">{open ? "▾" : "▸"}</span>
      {kids}
    </button>
  );
}

/** 已纳管主会话的分组头：它自己不在「未纳管」里，但子会话要有个地方挂，不能平铺开 */
export function ManagedAnchor({ s, kids, open, onToggle }: { s: SubSessionRow & { agentName?: string | null }; kids: number; open: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <button type="button" className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] text-base-content/60 hover:bg-base-200/60" aria-expanded={open} onClick={onToggle}>
      <span className="w-4 shrink-0 text-[11px] text-base-content/45">{open ? "▾" : "▸"}</span>
      <span className="truncate">🤖 {(s.agentName ?? "").replace(/^agent-/, "") || s.name}</span>
      <span className="shrink-0 rounded bg-base-content/10 px-1 text-[10px]">{t("已纳管")}</span>
      <span className="ml-auto shrink-0 text-[11px] text-base-content/40">{t("{n} 个子会话", { n: kids })}</span>
    </button>
  );
}
