"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "@/lib/i18n";

/**
 * 设置弹窗左侧菜单：八个页面的顺序、图标、标题都定在这里；页面内容在 ./pages.tsx，一页一个组件。
 * 图标手抄自 lucide(24 viewBox、stroke),与侧栏按钮同源——仓库不引 icon 库。
 * 手机(< sm)上没有左栏的空间：同一份菜单横向滚动排在标题栏下面，图标 + 文字并排。
 */
export type SettingsPageId = "general" | "sessions" | "appearance" | "connect" | "peers" | "security" | "labs" | "claude";

export const SETTINGS_PAGES: { id: SettingsPageId; label: string; icon: ReactNode }[] = [
  {
    id: "general",
    label: "通用",
    icon: (
      <>
        <line x1="21" x2="14" y1="4" y2="4" />
        <line x1="10" x2="3" y1="4" y2="4" />
        <line x1="21" x2="12" y1="12" y2="12" />
        <line x1="8" x2="3" y1="12" y2="12" />
        <line x1="21" x2="16" y1="20" y2="20" />
        <line x1="12" x2="3" y1="20" y2="20" />
        <line x1="14" x2="14" y1="2" y2="6" />
        <line x1="8" x2="8" y1="10" y2="14" />
        <line x1="16" x2="16" y1="18" y2="22" />
      </>
    ),
  },
  {
    id: "sessions",
    label: "会话与自动化",
    icon: (
      <>
        <rect width="8" height="8" x="3" y="3" rx="2" />
        <path d="M7 11v4a2 2 0 0 0 2 2h4" />
        <rect width="8" height="8" x="13" y="13" rx="2" />
      </>
    ),
  },
  {
    id: "appearance",
    label: "外观",
    icon: (
      <>
        <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
        <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
        <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
        <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
        <path
          d={
            "M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125" +
            "-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554" +
            "C21.965 6.012 17.461 2 12 2z"
          }
        />
      </>
    ),
  },
  {
    id: "connect",
    label: "连接与集成",
    icon: (
      <>
        <path d="M12 22v-5" />
        <path d="M9 8V2" />
        <path d="M15 8V2" />
        <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
      </>
    ),
  },
  {
    id: "peers",
    label: "Peer 协作",
    icon: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
  },
  {
    id: "security",
    label: "安全",
    icon: (
      <path
        d={
          "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72" +
          "a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
        }
      />
    ),
  },
  {
    id: "labs",
    label: "实验",
    icon: (
      <>
        <path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2" />
        <path d="M6.453 15h11.094" />
        <path d="M8.5 2h7" />
      </>
    ),
  },
  {
    id: "claude",
    label: "Claude",
    icon: (
      <>
        <path
          d={
            "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5" +
            "l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964" +
            "L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
          }
        />
        <path d="M20 3v4" />
        <path d="M22 5h-4" />
        <path d="M4 17v2" />
        <path d="M5 18H3" />
      </>
    ),
  },
];

/** 左栏(sm+)/顶部横条(手机)二合一：同一组按钮，靠响应式类切方向。 */
export function SettingsNav({ page, onSelect }: { page: SettingsPageId; onSelect: (id: SettingsPageId) => void }) {
  const t = useT();
  const navRef = useRef<HTMLElement>(null);
  // 手机横条一屏放不下八项：从侧栏 Peer 按钮直达时当前项在屏外，看不出在哪一页。打开 / 切页时
  // 把当前项横向滚到中间；只改横条自己的 scrollLeft——scrollIntoView 在 iOS 上会连带滚外层。
  // 桌面竖排没有横向溢出，直接跳过。
  useEffect(() => {
    const nav = navRef.current;
    const el = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !el || nav.scrollWidth <= nav.clientWidth) return;
    const n = nav.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.left < n.left || r.right > n.right) nav.scrollLeft += r.left - n.left - (n.width - r.width) / 2;
  }, [page]);
  return (
    <nav
      ref={navRef}
      aria-label={t("设置")}
      className={
        "flex shrink-0 gap-1 overflow-x-auto border-b border-base-300 px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden " +
        "sm:w-52 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r sm:px-2 sm:pb-3"
      }
    >
      {SETTINGS_PAGES.map((p) => {
        const active = p.id === page;
        return (
          <button
            key={p.id}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(p.id)}
            className={
              "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors sm:whitespace-normal " +
              (active
                ? "bg-base-content/8 font-semibold text-base-content"
                : "text-base-content/60 hover:bg-base-content/5 hover:text-base-content")
            }
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0"
            >
              {p.icon}
            </svg>
            <span>{t(p.label)}</span>
          </button>
        );
      })}
    </nav>
  );
}
