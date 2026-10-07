import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { freemem, loadavg, totalmem } from "node:os";

type CheckProcess = { pid: number; start: string };
export type CheckProcessObservation =
  | { kind: "present"; process: CheckProcess }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

function absent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; } // EPERM is not evidence of death.
}

function command(file: string, args: string[]): string {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 1000, env: { PATH: "/usr/bin:/bin:/usr/sbin", LC_ALL: "C", TZ: "UTC" } });
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error("process observation unavailable");
  return result.stdout.trim();
}

// Read only OS identity, never command lines, owner configuration or credentials. A failed read is not death.
// Darwin's second-resolution start time can retain a reused PID conservatively; it must never free it speculatively.
export function observeLendCheckProcess(pid: number, os = { platform: process.platform, command }): CheckProcessObservation {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown", reason: "invalid pid" };
  try {
    let start: string;
    if (os.platform === "linux") {
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
      if (!boot || !ticks || !/^\d+$/.test(ticks)) throw new Error("invalid process identity");
      start = `linux:${boot}:${ticks}`;
    } else if (os.platform === "darwin") {
      // Unlike kern.boottime, the boot session UUID does not change when the wall clock is stepped.
      const boot = os.command("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(boot)) throw new Error("invalid boot session");
      const birth = os.command("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
      if (!Number.isFinite(Date.parse(birth))) throw new Error("invalid process start time");
      start = `darwin:${boot}:${birth}`;
    } else return { kind: "unknown", reason: "unsupported process identity platform" };
    return { kind: "present", process: { pid, start } };
  } catch { // Only ESRCH confirms exit; IO/permission/parse failures keep the reservation.
    return absent(pid) ? { kind: "absent" } : { kind: "unknown", reason: "process identity unreadable" };
  }
}

// These measurements are diagnostic, not quota, capacity configuration, or permission to retry/change model family.
export function observeLendCheckResources() {
  return { sampledAt: Date.now(), loadAverage: loadavg(), freeMemoryBytes: freemem(), totalMemoryBytes: totalmem() };
}
