/**
 * System swap use and available memory for the worker lifecycle's memory backstop (agent-lifecycle.ts). macOS reads
 * `sysctl -n vm.swapusage`, Linux /proc/meminfo; anything unreadable is null, and a null swap figure skips the backstop
 * rather than guessing (tests/sys-memory.test.ts covers the parsers).
 */
import { readFileSync } from "node:fs";
import { freemem } from "node:os";

export interface MemoryReading { swapPct: number | null; swapUsedMb: number | null; availMb: number }

const mb = (v: string, unit: string): number => Number(v) * ({ K: 1 / 1024, M: 1, G: 1024 }[unit.toUpperCase()] ?? 1);

/** `total = 14336.00M  used = 13000.00M  free = 1336.00M  (encrypted)` → used / total. */
export function parseSwapUsage(out: string): { totalMb: number; usedMb: number } | null {
  const t = out.match(/total\s*=\s*([\d.]+)([KMG])/i), u = out.match(/used\s*=\s*([\d.]+)([KMG])/i);
  return t && u ? { totalMb: mb(t[1], t[2]), usedMb: mb(u[1], u[2]) } : null;
}

/** /proc/meminfo SwapTotal / SwapFree / MemAvailable (kB). */
export function parseMeminfo(text: string): { totalMb: number; usedMb: number; availMb: number | null } | null {
  const kb = (key: string): number | null => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
    return m ? Number(m[1]) / 1024 : null;
  };
  const total = kb("SwapTotal"), free = kb("SwapFree");
  return total === null || free === null ? null : { totalMb: total, usedMb: total - free, availMb: kb("MemAvailable") };
}

const pct = (s: { totalMb: number; usedMb: number }): number => (s.totalMb > 0 ? (s.usedMb / s.totalMb) * 100 : 0);

export async function readMemory(platform = process.platform): Promise<MemoryReading> {
  const availMb = freemem() / 1048576;
  if (platform === "darwin") {
    // plain spawn, not runBounded: that one hooks SIGTERM process-wide, which the scheduler daemon's own stop handling must not see
    const r = Bun.spawnSync(["sysctl", "-n", "vm.swapusage"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
    const s = r.exitCode === 0 ? parseSwapUsage(r.stdout.toString()) : null;
    return { swapPct: s ? pct(s) : null, swapUsedMb: s?.usedMb ?? null, availMb };
  }
  let text = "";
  try { text = readFileSync("/proc/meminfo", "utf8"); } catch { return { swapPct: null, swapUsedMb: null, availMb }; /* no procfs: the backstop just skips */ }
  const s = parseMeminfo(text);
  return { swapPct: s ? pct(s) : null, swapUsedMb: s?.usedMb ?? null, availMb: s?.availMb ?? availMb };
}
