/** 运行中耗时：27m 47s / 1h 3m / 45s（与 CC 底栏同一种读法；后台任务卡与运行中的工具卡共用，tests/web-fmt-clock.test.ts） */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** 从 ISO 起点到 now 的耗时；没有 / 解析不了起点返回 ""（只显示「运行中」，不编一个 0s） */
export function elapsedSince(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? fmtClock(now - t) : "";
}
