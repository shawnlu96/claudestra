import type { ReactNode } from "react";
import type { LineIconName } from "../agent-menu";

/** 手抄的 lucide 线条图标（网页不用 emoji）；颜色跟随 currentColor，由调用方的文字色决定 */
const svgProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} className={className} aria-hidden {...svgProps}>
      {children}
    </svg>
  );
}

/** lucide bell */
export const BellIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </Svg>
);

/** lucide moon */
export const MoonIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </Svg>
);

/** lucide folder-open */
export const FolderOpenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  </Svg>
);

/** lucide folder */
export const FolderIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </Svg>
);

/** 菜单里按名字取的图标（名字由 ../agent-menu.ts 的纯函数给出，它不能依赖 React） */
const MENU_ICONS: Record<LineIconName, (p: IconProps) => ReactNode> = {
  "folder-open": FolderOpenIcon,
  "folder-input": (p) => (
    <Svg {...p}>
      <path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1" />
      <path d="M2 13h10" />
      <path d="m9 16 3-3-3-3" />
    </Svg>
  ),
  archive: (p) => (
    <Svg {...p}>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </Svg>
  ),
  terminal: (p) => (
    <Svg {...p}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </Svg>
  ),
  code: (p) => (
    <Svg {...p}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </Svg>
  ),
};

/** 菜单项图标：有线条图标名就画 SVG（14px，与 Autopilot 图标同尺寸），否则是文字符号 */
export function menuItemIcon(it: { icon: string; lineIcon?: LineIconName }): ReactNode {
  const Icon = it.lineIcon && MENU_ICONS[it.lineIcon];
  return Icon ? <Icon size={14} /> : it.icon;
}
