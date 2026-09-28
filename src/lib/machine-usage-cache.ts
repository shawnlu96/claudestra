/**
 * bridge 侧的全机用量缓存：子进程（`manager cost --machine`）算，bridge 只存结果。
 * - 60 秒 TTL，同一时间只跑一个子进程；过期时先回旧值、后台刷新（看板不等扫描）
 * - 窗口变了（跨零点 / 周期重置）旧值就是错的口径：等新结果，最多等 waitMs，等不到返回 null（不显示也不显示错的）
 * - 失败沿用旧值（同窗口），状态切换时报一次
 * 单测 tests/machine-usage.test.ts（run 可注入）。
 */

import type { MachineUsage } from "./machine-usage.js";
import { createFailureLatch } from "./run-manager.js";
import type { UsageWindowBounds } from "./usage-window.js";

const MACHINE_USAGE_TTL_MS = 60_000;

const windowKey = (w: UsageWindowBounds) => `${w.dayStart},${w.weekStart},${w.weekSource}`;

export function createMachineUsageCache(
  run: (args: string[]) => Promise<any>,
  opts: { ttlMs?: number; waitMs?: number; now?: () => number; log?: (msg: string) => void } = {},
) {
  const ttl = opts.ttlMs ?? MACHINE_USAGE_TTL_MS;
  const waitMs = opts.waitMs ?? 5000;
  const now = opts.now ?? Date.now;
  const latch = createFailureLatch("全机用量扫描", opts.log);
  let cached: { key: string; at: number; data: MachineUsage } | null = null;
  let inflight: { key: string; p: Promise<void> } | null = null;

  const refresh = (w: UsageWindowBounds): Promise<void> => {
    const key = windowKey(w);
    if (inflight?.key === key) return inflight.p;
    const p = run(["cost", "--machine", "--window", key])
      .then((r) => {
        if (!r?.ok || !r.machine) throw new Error(r?.error ?? "无输出");
        cached = { key, at: now(), data: r.machine as MachineUsage };
        latch.ok();
      })
      .catch((e) => latch.fail(e)) // 失败沿用旧值；latch 负责只在切换时喊一次
      .finally(() => {
        if (inflight?.p === p) inflight = null;
      });
    inflight = { key, p };
    return p;
  };

  return async function get(w: UsageWindowBounds): Promise<MachineUsage | null> {
    const key = windowKey(w);
    if (cached?.key === key) {
      if (now() - cached.at >= ttl) void refresh(w);
      return cached.data;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([refresh(w), new Promise((r) => (timer = setTimeout(r, waitMs)))]);
    clearTimeout(timer);
    return cached?.key === key ? cached.data : null;
  };
}
