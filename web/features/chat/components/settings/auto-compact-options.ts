/**
 * 「自动存记忆 + Compact」两个下拉的选项计算（纯函数，从 settings-modal 渲染体搬出，单测见
 * tests/web-settings-auto-compact.test.ts）。
 *
 * 当前生效值：null = 未设 → 用默认；选项表兜住手工改过的非标准值（插进去并排序），
 * 否则 select 的 value 对不上任何 option，界面会显示成第一项、看起来像被改了。
 */
export interface AutoCompactState {
  window: number | null;
  idleHours: number | null;
  /** v2.21.3+ 93% 救命线独立开关(常规线关了它也兜底) */
  emergency?: boolean;
  defaults: { window: number; idleHours: number; emergency?: boolean; emergencyRatio?: number };
}

export const AC_WINDOW_PRESETS = [400_000, 500_000, 750_000, 1_000_000] as const;
export const AC_IDLE_PRESETS = [0, 1, 3, 6, 12] as const;

export function autoCompactOptions(ac: AutoCompactState | null): {
  acWindow: number | null;
  acIdle: number | null;
  acWindowOpts: number[];
  acIdleOpts: number[];
} {
  const acWindow = ac ? (ac.window ?? ac.defaults.window) : null;
  const acIdle = ac ? (ac.idleHours ?? ac.defaults.idleHours) : null;
  const acWindowOpts: number[] = [...AC_WINDOW_PRESETS];
  if (acWindow !== null && acWindow !== 0 && !acWindowOpts.includes(acWindow)) {
    acWindowOpts.push(acWindow);
    acWindowOpts.sort((a, b) => a - b);
  }
  const acIdleOpts: number[] = [...AC_IDLE_PRESETS];
  if (acIdle !== null && !acIdleOpts.includes(acIdle)) {
    acIdleOpts.push(acIdle);
    acIdleOpts.sort((a, b) => a - b);
  }
  return { acWindow, acIdle, acWindowOpts, acIdleOpts };
}

/** 1_000_000 → "1M"，750_000 → "750K" */
export const fmtTokens = (w: number) => (w >= 1_000_000 ? `${w / 1_000_000}M` : `${Math.round(w / 1000)}K`);
