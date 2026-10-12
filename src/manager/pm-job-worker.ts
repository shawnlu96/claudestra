/**
 * PM 处理员 worker 的进程入口（agents-PMJOB1）：`bun src/manager/pm-job-worker.ts`，由调度服务经 lib/pm-job-spawn.ts 起成独立子进程。
 * 领完排队的单就退出；不连 bridge、不写台账、不发消息，结果只落在 statePath("pm-job/")。逻辑在 lib/pm-job-worker.ts。
 */
import { runPmJobWorker } from "../lib/pm-job-worker.js";

/** 跑到没单为止；返回进程退出码 */
export async function pmJobWorkerMain(run: () => Promise<number> = runPmJobWorker): Promise<number> {
  try {
    console.log(`[pm-job] worker 处理了 ${await run()} 单`);
    return 0;
  } catch (e) {
    console.error(`[pm-job] worker 出错退出：${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await pmJobWorkerMain());
