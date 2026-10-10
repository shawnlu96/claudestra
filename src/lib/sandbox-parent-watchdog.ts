/**
 * 沙箱 bridge 的父进程看门狗：启动方（测试 runner / 出借 worker）被硬杀时它的收尾不跑，沙箱 bridge 会被 launchd 收养一直挂着。
 * 只在 isSandbox() 时启用，生产 bridge 什么都不做。启动方不在了就给自己发 SIGTERM（bridge 的正常关停），graceMs 内没退再 SIGKILL。
 * 检查跑在 Worker 线程里：bridge 装了 JS 的 SIGTERM 监听（bridge/stats-dashboard.ts），信号要等主线程处理；主线程卡在同步调用
 * （Bun.spawnSync 等）时 SIGTERM 被吞、主线程上的定时器也不跑，只有另一个线程收得掉它。tests/sandbox-parent-watchdog.test.ts。
 */
import { isSandbox } from "./sandbox.js";

/** 启动方 pid；0 = 不看门（scripts/sandbox.ts 手动起的常驻沙箱，靠 down 收）；不设 = 看启动时的 process.ppid */
export const SANDBOX_PARENT_PID_ENV = "CLAUDESTRA_SANDBOX_PARENT_PID";

type Env = Record<string, string | undefined>;

/** 要看的启动方；null = 不启用。explicit = 环境变量给的（只看它活不活），否则是直接父进程（被收养也算不在了） */
export function watchdogOwner(env: Env, ppid: number): { pid: number; explicit: boolean } | null {
  if (!isSandbox(env)) return null;
  const raw = (env[SANDBOX_PARENT_PID_ENV] || "").trim();
  if (raw === "0") return null;
  if (raw === "") return ppid > 1 ? { pid: ppid, explicit: false } : null;
  if (!/^\d+$/.test(raw) || Number(raw) <= 1) throw new Error(`${SANDBOX_PARENT_PID_ENV}=${raw} 不认识：填启动方的 pid，0 = 不看门`);
  return { pid: Number(raw), explicit: true };
}

/** Worker 里跑的检查（独立线程，不经主线程的事件循环） */
const workerSource = (owner: number, explicit: boolean, everyMs: number, graceMs: number) => `
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const t = setInterval(() => {
  if (alive(${owner}) && (${explicit} || process.ppid === ${owner})) return;
  clearInterval(t);
  console.error("沙箱看门狗：启动方 ${owner} 已不在，SIGTERM 关停 bridge，${graceMs}ms 内没退就 SIGKILL");
  process.kill(process.pid, "SIGTERM");
  setTimeout(() => process.kill(process.pid, "SIGKILL"), ${graceMs});
}, ${everyMs});
`;

export function startSandboxParentWatchdog(opts: { env?: Env; everyMs?: number; graceMs?: number } = {}): Worker | null {
  const owner = watchdogOwner(opts.env ?? process.env, process.ppid);
  if (!owner) return null;
  const src = workerSource(owner.pid, owner.explicit, opts.everyMs ?? 2_000, opts.graceMs ?? 5_000);
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
  w.unref(); // 不拖住 bridge 自己的退出
  return w;
}
