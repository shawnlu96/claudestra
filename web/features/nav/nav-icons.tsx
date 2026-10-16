/**
 * 五个入口与「我的」各条的线性图标（手抄 lucide，网页不用 emoji）：颜色跟随 currentColor，选中 / 悬停由调用方的文字色决定。
 * 「我的」各条沿用原顶栏按钮的同一张图（设置、项目管理、多选、用量、终端、图片、全部已读），换了位置不换样子。
 */
import type { ReactNode } from "react";
import { CheckCheckIcon, SettingsIcon } from "../chat/components/line-icons";
import { ImagesIcon } from "../media/media-icons";
import type { MeIconName } from "./me-entries";
import type { NavIconName } from "./nav-entries";


function Svg({ size, children, width = 1.8 }: { size: number; children: ReactNode; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

const NAV_PATHS: Record<NavIconName, ReactNode> = {
  today: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>
  ),
  projects: (
    <>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <path d="M8 10v4M12 10v2M16 10v6" />
    </>
  ),
  sessions: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  team: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  me: (
    <>
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </>
  ),
};

export const NavIcon = ({ name, size = 22 }: { name: NavIconName; size?: number }) => <Svg size={size}>{NAV_PATHS[name]}</Svg>;

const ME_PATHS: Partial<Record<MeIconName, ReactNode>> = {
  projectAdmin: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  manage: <path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8" />,
  peers: (
    <>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  stats: <path d="M3 3v16a2 2 0 0 0 2 2h16M7 13v4M12 9v8M17 5v12" />,
  shell: <path d="m4 17 6-6-6-6M12 19h8" />,
};

export function MeIcon({ name, size = 16 }: { name: MeIconName; size?: number }) {
  if (name === "settings") return <SettingsIcon size={size} />;
  if (name === "readAll") return <CheckCheckIcon size={size} />;
  if (name === "media") return <ImagesIcon size={size} />;
  return <Svg size={size}>{ME_PATHS[name]}</Svg>;
}
