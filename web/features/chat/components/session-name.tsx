"use client";
import { useCallback, useState } from "react";
import { useT } from "@/lib/i18n";
import { managedAgentOf, type SubSessionRow } from "@/lib/session-nesting";
import { BotIcon } from "./line-icons";
import { Chevron } from "./project-group";

export { sessionRowKey, sessionTree } from "@/lib/session-nesting";

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

/** 行首折叠开关：有子会话显示箭头 + 数量，没有就留同宽空位，让各行名字对齐 */
export function FoldToggle({ kids, open, onToggle }: { kids: number; open: boolean; onToggle: () => void }) {
  const t = useT();
  if (kids === 0) return <span className="w-7 shrink-0" />;
  return (
    <button
      type="button"
      className="flex w-7 shrink-0 touch-manipulation flex-col items-center gap-0.5 pt-1.5 text-[10px] leading-tight text-base-content/45 hover:text-base-content/80"
      title={open ? t("收起子会话") : t("展开子会话")}
      aria-expanded={open}
      onClick={onToggle}
    >
      <Chevron open={open} />
      {kids}
    </button>
  );
}

/**
 * 主会话本身不列时的分组头：子会话要有个地方挂，不能平铺开。已纳管（有 agentName）才画机器人图标和「已纳管」徽章；
 * 另一种是临时目录里的主会话（isTempSession 滤掉的），它没被纳管，只给中性的名字，否则会被误标成「已纳管」。
 */
export function GroupAnchor({ s, kids, open, onToggle }: { s: SubSessionRow & { agentName?: string | null }; kids: number; open: boolean; onToggle: () => void }) {
  const t = useT();
  const agent = managedAgentOf(s);
  return (
    <button type="button" className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] text-base-content/60 hover:bg-base-200/60" aria-expanded={open} onClick={onToggle}>
      <Chevron open={open} className="text-base-content/45" />
      {agent ? <BotIcon size={13} className="shrink-0 text-base-content/50" /> : null}
      <span className="truncate">{agent || s.name || s.sessionId.slice(0, 8)}</span>
      {agent ? <span className="shrink-0 rounded bg-base-content/10 px-1 text-[10px]">{t("已纳管")}</span> : null}
      <span className="ml-auto shrink-0 text-[11px] text-base-content/40">{t("{n} 个子会话", { n: kids })}</span>
    </button>
  );
}

/** 后端每个主会话只带最新 50 个子线程，省掉的只报个数（展开时挂在分组下面第一行） */
export function MoreSubsNote({ n, depth }: { n: number; depth: number }) {
  const t = useT();
  return (
    <li className="py-0.5 pr-1.5 text-[11px] text-base-content/40" style={{ paddingLeft: Math.min(depth + 1, 3) * 14 + 28 }}>
      {t("另有 {n} 个较早的子会话未列出", { n })}
    </li>
  );
}
