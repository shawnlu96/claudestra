"use client";
import { useT } from "@/lib/i18n";
import { parseSource, type SourceKind } from "../source-label";

/**
 * 外源入站消息（peer / 其它 agent / 别的用户）的头行：圆形 icon + [badge] + 名字，
 * 与本人消息的「圆形头像 + 昵称」、assistant 的「圆形 ✦ + 名字」同一套版式
 * （owner 2026-09-24「统一信息来源的显示…不要用 emoji」）。图标是手抄的 lucide
 * 路径（仓库没有 icon 库，其它组件同款做法）。
 */
const ICONS: Record<SourceKind, React.ReactNode> = {
  "peer-notify": (
    <>
      <path d="m11 17 2 2a1 1 0 1 0 3-3" />
      <path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4" />
      <path d="m21 3 1 11h-2" />
      <path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3" />
      <path d="M3 4h8" />
    </>
  ),
  "peer-reply": null, // 与 peer-notify 同图（owner:「跟上一个一样」）
  agent: (
    <>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </>
  ),
  user: (
    <>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
};

export function SourceHeader({ from }: { from: string }) {
  const t = useT();
  const s = parseSource(from);
  const icon = ICONS[s.kind] ?? ICONS["peer-notify"];
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-info/15 text-info">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {icon}
        </svg>
      </span>
      {s.badge && <span className="badge badge-outline badge-info badge-xs">{t(s.badge)}</span>}
      <span className="text-[10px] opacity-50">{s.name}</span>
    </div>
  );
}
