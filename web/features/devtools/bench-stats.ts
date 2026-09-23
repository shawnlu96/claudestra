/**
 * 渲染基准的纯统计:一串帧间隔(ms)→ p50 / p95 / 最大 / 超阈值帧数。无 DOM,bun test 覆盖。
 * 面板的「渲染基准」分区(bench-section.ts)用它把一次自动滚动的采样压成一行结论。
 */

export type FrameStats = { frames: number; p50: number; p95: number; max: number; over50: number; over100: number };

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarizeFrames(gaps: number[]): FrameStats {
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    frames: gaps.length,
    p50: Math.round(percentile(sorted, 50) * 10) / 10,
    p95: Math.round(percentile(sorted, 95) * 10) / 10,
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
    over50: gaps.filter((g) => g > 50).length,
    over100: gaps.filter((g) => g > 100).length,
  };
}

/** 一行可复制的结论(进事件列表 / 贴回对话)。 */
export function formatBench(label: string, s: FrameStats, extra: Record<string, string | number>): string {
  const tail = Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ");
  return `${label} frames=${s.frames} p50=${s.p50}ms p95=${s.p95}ms max=${s.max}ms >50ms=${s.over50} >100ms=${s.over100} ${tail}`.trim();
}

/** 正弦摆动:t=0 在 min,半个周期到 max,再回来。侧栏基准用。 */
export function oscillate(t: number, min: number, max: number, periodMs: number): number {
  const phase = (1 - Math.cos((2 * Math.PI * t) / periodMs)) / 2;
  return min + (max - min) * phase;
}
