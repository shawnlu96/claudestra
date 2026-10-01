/** 出借面板用到的 lucide 线条图标（内联 SVG，web 不装图标库；路径取自 lucide 官方） */
import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  lock: (<><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>),
  pause: (<><rect x="14" y="4" width="4" height="16" rx="1" /><rect x="6" y="4" width="4" height="16" rx="1" /></>),
  clockAlert: (<><path d="M12 6v6l4 2" /><path d="M16 21.16a10 10 0 1 1 5-13.516" /><path d="M20 11.5v6" /><path d="M20 21.5h.01" /></>),
  triangleAlert: (<><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>),
  circleAlert: (<><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></>),
  play: <polygon points="6 3 20 12 6 21 6 3" />,
  check: <path d="M20 6 9 17l-5-5" />,
  circleCheck: (<><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>),
  square: <rect width="18" height="18" x="3" y="3" rx="2" />,
  clock: (<><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>),
  loaderCircle: <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
  activity: <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />,
  hourglass: (
    <>
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
      <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </>
  ),
  plus: (<><path d="M5 12h14" /><path d="M12 5v14" /></>),
  x: (<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>),
  undo2: (<><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" /></>),
  rotateCcw: (<><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>),
};

export type LendIconName = keyof typeof PATHS;

export function LendIcon({ name, size = 14, className }: { name: LendIconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true" style={{ flex: "none" }}>
      {PATHS[name]}
    </svg>
  );
}
