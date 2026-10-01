import { Svg } from "@/features/fleet/icons";

export { CheckIcon, ClockIcon, MinusIcon, XIcon } from "@/features/fleet/icons";

/** 手抄的 lucide 线条图标（网页不用 emoji），颜色跟随 currentColor；外框复用 fleet 的 Svg */
type IconProps = { className?: string };

export const ServerIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
    <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
    <path d="M6 6h.01" />
    <path d="M6 18h.01" />
  </Svg>
);

export const PlusIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </Svg>
);

/** lucide trash-2 */
export const TrashIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </Svg>
);

/** lucide zap：推送（proto 2） */
export const ZapIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
  </Svg>
);

/** lucide repeat：只轮询（proto 1） */
export const RepeatIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="m17 2 4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
    <path d="m7 22-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </Svg>
);

export const CircleAlertIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4" />
    <path d="M12 16h.01" />
  </Svg>
);

/** lucide activity：远端在跑 */
export const ActivityIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
  </Svg>
);

/** lucide pause */
export const PauseIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <rect x="14" y="4" width="4" height="16" rx="1" />
    <rect x="6" y="4" width="4" height="16" rx="1" />
  </Svg>
);

/** lucide pencil：重选项目 */
export const PencilIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </Svg>
);

/** lucide monitor：放本机 */
export const MonitorIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />
  </Svg>
);

/** lucide hourglass：等着放 */
export const HourglassIcon = ({ className }: IconProps) => (
  <Svg className={className}>
    <path d="M5 22h14" />
    <path d="M5 2h14" />
    <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
    <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
  </Svg>
);
