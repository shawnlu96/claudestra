import type { ReactNode } from "react";

/** 手抄的 lucide 线条图标（网页不用 emoji）；颜色跟随 currentColor */
const svgProps = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
type P = { size?: number; className?: string };
const Svg = ({ size = 16, className, children }: P & { children: ReactNode }) => (
  <svg width={size} height={size} className={className} aria-hidden {...svgProps}>
    {children}
  </svg>
);

/** lucide plus */
export const PlusIcon = (p: P) => <Svg {...p}><path d="M5 12h14" /><path d="M12 5v14" /></Svg>;
/** lucide image */
export const ImageIcon = (p: P) => (
  <Svg {...p}><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></Svg>
);
/** lucide at-sign */
export const AtIcon = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></Svg>;
/** lucide send-horizontal */
export const SendIcon = (p: P) => (
  <Svg {...p}><path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z" /><path d="M6 12h16" /></Svg>
);
/** lucide inbox-arrow（丢进工作台）：lucide archive-restore */
export const DropIcon = (p: P) => (
  <Svg {...p}><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h2" /><path d="M20 8v11a2 2 0 0 1-2 2h-2" /><path d="m9 15 3-3 3 3" /><path d="M12 12v9" /></Svg>
);
/** lucide users */
export const UsersIcon = (p: P) => (
  <Svg {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></Svg>
);
/** lucide chevron-left */
export const BackIcon = (p: P) => <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>;
/** lucide trash-2 */
export const TrashIcon = (p: P) => (
  <Svg {...p}><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></Svg>
);
/** lucide x */
export const CloseIcon = (p: P) => <Svg {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Svg>;
/** lucide list-checks（选择消息） */
export const SelectIcon = (p: P) => (
  <Svg {...p}><path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /><path d="M13 6h8" /><path d="M13 12h8" /><path d="M13 18h8" /></Svg>
);
