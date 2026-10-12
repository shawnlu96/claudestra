/**
 * cron 运行台账（cron-runs.json）：每次启动先按 job + epochMinute 落一条认领，再发任何外部动作。
 *
 * 内存里的 runningJobs / lastTickMinute 进程一换就没了：第二个 daemon 实例会在同一分钟重跑，
 * 临时 agent 的名字、会话、截止时间也只在内存，daemon 退出后没人收。这里把它们写进一个文件：
 * 同一个 key 只有一个实例认领得到；状态分 running / success / error / timeout / unknown，
 * 重启后不重发结果未知的动作，只保证「不盲目重复」，不宣称业务恰好一次。
 * 读坏、抢不到锁、写不进去一律抛 CronRunStateError：调用方按零派发处理（tests/cron-audit-run.test.ts）。
 */

import { acquireLock } from "./file-lock.js";
import { readJsonState, writeJsonAtomic, type StateRead } from "./state-file.js";

export type CronRunStatus = "running" | "success" | "error" | "timeout" | "unknown";

/**
 * 临时 agent 的监督状态。create-attempted = 发过 create 但会话身份没确认；supervising = 身份已确认、在等它跑完；
 * cleanup-pending = 结果已定、原会话还没收；cleaned = 已收或本就不在；needs-review = 身份对不上 / 没有身份，交人核，不再动它。
 */
export type CronTempSupervision = "create-attempted" | "supervising" | "cleanup-pending" | "cleaned" | "needs-review";

interface CronRunTemp {
  /** 这次启动独有的名字（不带 agent- 前缀），create 之前就落盘 */
  agentName: string;
  createAttemptedAt: string;
  /** create 返回的会话 id：之后停它只认这个会话，同名换了会话的不碰 */
  sessionId?: string;
  confirmedAt?: string;
  promptAttemptedAt?: string;
  supervision: CronTempSupervision;
  cleanupError?: string;
}

export interface CronRunRecord {
  /** `${jobId}@${epochMinute}` */
  key: string;
  jobId: string;
  jobName: string;
  epochMinute: number;
  historyId: string;
  /** 认领它的 daemon 实例（pid.启动时刻.随机） */
  owner: string;
  startedAt: string;
  /** 过了这个时刻还没结果就按超时收 */
  deadlineAt: string;
  status: CronRunStatus;
  finishedAt?: string;
  error?: string;
  /** 定向现存 agent：发 prompt 之前落；有它 = 可能已经发出去 */
  dispatchAttemptedAt?: string;
  reportChannel?: string;
  dir?: string;
  temp?: CronRunTemp;
}

const OPEN_SUPERVISION = new Set<CronTempSupervision>(["create-attempted", "supervising", "cleanup-pending"]);

/** 还要有人管：没出结果，或者临时 agent 还没收 / 没核 */
export const isUnfinishedCronRun = (r: CronRunRecord): boolean =>
  r.status === "running" || (!!r.temp && OPEN_SUPERVISION.has(r.temp.supervision));

export const cronRunKey = (jobId: string, epochMinute: number): string => `${jobId}@${epochMinute}`;

class CronRunStateError extends Error {
  constructor(readonly reason: "lock" | "read" | "write", detail: string) {
    super(`cron 运行台账${reason === "lock" ? "抢不到锁" : reason === "read" ? "读不出" : "写不进"}: ${detail}`);
    this.name = "CronRunStateError";
  }
}

type CronRunClaimInput = Omit<CronRunRecord, "key" | "status" | "finishedAt" | "error" | "dispatchAttemptedAt" | "temp">;

type CronRunClaim =
  | { claimed: true; record: CronRunRecord }
  | { claimed: false; reason: "duplicate"; existing: CronRunRecord }
  | { claimed: false; reason: "lock" | "read" | "write"; error: string };

export interface CronRunIo {
  read(path: string): Promise<StateRead>;
  write(path: string, data: unknown): Promise<void>;
}

export interface CronRunStore {
  /** 认领 job + epochMinute 的这一次启动；不抛，认不到就说原因 */
  claim(input: CronRunClaimInput): Promise<CronRunClaim>;
  /** 锁内改一条。mutate 返回 false = 前提不成立、不写。返回改后的记录；没这条 / 没写返回 null。读写锁失败抛 CronRunStateError */
  update(key: string, mutate: (r: CronRunRecord) => boolean | void): Promise<CronRunRecord | null>;
  /** 全部记录；文件坏了抛（调用方不能把读不出当成没有记录） */
  list(): Promise<CronRunRecord[]>;
}

interface CronRunFile { version: 1; runs: CronRunRecord[] }

const isRunFile = (d: unknown): boolean => !!d && typeof d === "object" && Array.isArray((d as CronRunFile).runs);

/** 结束了的只留最近这么多条；没结束的一条不丢（丢了就没人收它的临时 agent） */
const KEEP_FINISHED = 300;
/**
 * 去重时域：认领只会落在 tick 看到的那一分钟（加上等锁的十来秒），这几分钟内的记录就是去重凭据本身，不算进条数上限——
 * 一分钟里跑完的任务比 KEEP_FINISHED 多时，按条数裁会把这一分钟的认领裁掉，另一个实例同分钟就能再认领一次。
 */
const DEDUP_HORIZON_MINUTES = 5;

/**
 * nowMinute 与台账里最新的那一分钟取小的做基准：时钟被拨快过留下的未来记录不会把基准带走，
 * 合成 / 回放的旧时刻（基准在墙上时钟之前）也照样受保护。
 */
function pruned(runs: CronRunRecord[], keepFinished: number, nowMinute: number): CronRunRecord[] {
  const finished = runs.filter((r) => !isUnfinishedCronRun(r));
  if (finished.length <= keepFinished) return runs;
  const floor = Math.min(nowMinute, Math.max(...runs.map((r) => r.epochMinute))) - DEDUP_HORIZON_MINUTES;
  const drop = new Set(finished.slice(0, finished.length - keepFinished).filter((r) => r.epochMinute < floor));
  return drop.size ? runs.filter((r) => !drop.has(r)) : runs;
}

export function createCronRunStore(
  path: string,
  opts: { io?: Partial<CronRunIo>; lockWaitMs?: number; lockStaleMs?: number; keepFinished?: number; now?: () => number } = {},
): CronRunStore {
  const io: CronRunIo = {
    read: opts.io?.read ?? ((p) => readJsonState(p, isRunFile)),
    write: opts.io?.write ?? ((p, data) => writeJsonAtomic(p, data)),
  };

  const load = async (): Promise<CronRunRecord[]> => {
    let r: StateRead;
    try { r = await io.read(path); } catch (e) { throw new CronRunStateError("read", (e as Error).message); }
    if (r.status === "corrupt") throw new CronRunStateError("read", r.error);
    return r.status === "missing" ? [] : (r.data as CronRunFile).runs;
  };

  /** 锁内读改写。fn 返回 dirty 才写；抢不到锁不降级放行——这里的锁就是「只有一个实例认领得到」本身 */
  async function transact<T>(fn: (runs: CronRunRecord[]) => { result: T; dirty: boolean }): Promise<T> {
    const lock = await acquireLock(`${path}.lock`, opts.lockWaitMs ?? 10_000, opts.lockStaleMs ?? 60_000);
    if (!lock) throw new CronRunStateError("lock", `${path}.lock`);
    try {
      const runs = await load();
      const { result, dirty } = fn(runs);
      if (!dirty) return result;
      if (!lock.held()) throw new CronRunStateError("lock", "写之前锁已被回收");
      try {
        const nowMinute = Math.floor((opts.now ?? Date.now)() / 60_000);
        await io.write(path, { version: 1, runs: pruned(runs, opts.keepFinished ?? KEEP_FINISHED, nowMinute) } satisfies CronRunFile);
      } catch (e) {
        throw new CronRunStateError("write", (e as Error).message);
      }
      return result;
    } finally {
      lock.release();
    }
  }

  return {
    async claim(input) {
      const key = cronRunKey(input.jobId, input.epochMinute);
      try {
        return await transact<CronRunClaim>((runs) => {
          const existing = runs.find((r) => r.key === key);
          if (existing) return { result: { claimed: false, reason: "duplicate", existing }, dirty: false };
          const record: CronRunRecord = { key, ...input, status: "running" };
          runs.push(record);
          return { result: { claimed: true, record }, dirty: true };
        });
      } catch (e) {
        if (!(e instanceof CronRunStateError)) throw e;
        return { claimed: false, reason: e.reason, error: e.message };
      }
    },
    update(key, mutate) {
      return transact<CronRunRecord | null>((runs) => {
        const rec = runs.find((r) => r.key === key);
        if (!rec || mutate(rec) === false) return { result: null, dirty: false };
        return { result: structuredClone(rec), dirty: true };
      });
    },
    list: load,
  };
}
