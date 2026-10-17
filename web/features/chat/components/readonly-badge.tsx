"use client";
import { useLang, type Lang } from "@/lib/i18n";

/**
 * 系统强制只读的 Codex agent（registry permissionMode=readOnly，bridge GET agents 的 readOnly）：运行时图标右下角挂一把锁。
 * 文案就地中英两套：只此一处用，不进共享词典；悬停说的是沙箱真拦的（写文件、写入命令），读取不拦（docs/runtimes/codex-readonly.md）。
 */
const LABEL: Record<Lang, string> = {
  zh: "只读：不能改文件，不能跑写入命令",
  en: "Read-only: can't modify files or run write commands",
};

export function readOnlyBadgeLabel(lang: Lang): string {
  return LABEL[lang] ?? LABEL.en;
}

/** lucide lock */
function LockIcon({ size = 8 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/** lang 只给测试 / 无 hook 的渲染用；组件里缺省跟随当前语言 */
export function ReadOnlyBadge({ lang }: { lang?: Lang }) {
  const current = useLang();
  const label = readOnlyBadgeLabel(lang ?? current);
  return (
    <span
      className="absolute -bottom-[4px] -right-[4px] flex size-[11px] items-center justify-center rounded-full bg-base-200 text-base-content/70"
      title={label}
      aria-label={label}
      data-readonly-badge=""
    >
      <LockIcon />
    </span>
  );
}
