/**
 * 调度服务起 PM 处理员 worker 的入口（agents-PMJOB1）：有排队的单、且没有租约还活着的 running 单时，起一个独立的一次性子进程
 * （src/manager/pm-job-worker.ts），脱离父进程（detached + unref）：调度服务或 bridge 重启都不影响它把结果写完。
 * 调度服务（src/scheduler.ts runScheduler）每轮调一次 pmJobWorkerTick()，启动后第一轮就扫，不靠新流量；多起了也无妨，认领在锁里，同一时刻只有一个 worker 拿得到单。
 * bridge 不调这里：能跑模型的只有调度服务起的 worker。
 */
import { spawn } from "node:child_process";
import { resolveBunPath } from "./bun-path.js";
import { PmJobStore } from "./pm-job-store.js";
import { SRC_DIR } from "./repo-root.js";

export interface PmJobSpawnDeps { store: PmJobStore; now(): number; spawn(argv: string[]): void }

const detached = (argv: string[]): void => {
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: "ignore", env: process.env });
  child.on("error", (e) => console.error(`[pm-job] worker 没起来：${e.message}`));
  child.unref();
};

/** 起了 worker = true。永不抛出：状态读不了这轮就不起 */
export function pmJobWorkerTick(deps: Partial<PmJobSpawnDeps> = {}): boolean {
  try {
    const d = { store: new PmJobStore(), now: Date.now, spawn: detached, ...deps }, jobs = d.store.list(), now = d.now();
    if (!jobs.some((j) => j.state === "queued") || jobs.some((j) => j.state === "running" && (j.lease?.until ?? 0) > now)) return false;
    d.spawn([resolveBunPath(), `${SRC_DIR}/manager/pm-job-worker.ts`]);
    return true;
  } catch (e) {
    console.error(`[pm-job] worker 扫单出错：${(e as Error).message}`);
    return false;
  }
}
