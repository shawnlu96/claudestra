/**
 * PM 处理员的持久状态（agents-PMJOB1）：每单一个 JSON（原子写）、同目录 drafts/<askId>.md 是草稿；开关和模式世代放在 PMDIG 的
 * pm-digest-mode.json（jobProjects / jobGens，缺省 observe），不新增恢复键。所有状态迁移在目录锁（lib/file-lock.ts）里读-核-写：
 * bridge 与 worker 是两个进程，谁先迁走谁算，另一方的写落空。认领同时发租约，任何时刻至多一单 running（并发上限 1）。
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { PM_JOB_STATES, type PmJob, type PmJobMode, type PmJobResult, type PmJobState, type PmJobUsage } from "./pm-job-types.js";
import { readJsonStateSync, reportCorrupt, StateCorruptError, writeJsonAtomicSync, writeTextAtomicSync } from "./state-file.js";

const ASK_ID = /^ask_[A-Za-z0-9]+$/;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

interface Modes { jobProjects?: Record<string, unknown>; jobGens?: Record<string, unknown> }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validModes = (v: unknown): boolean => isObj(v) && (v.jobProjects === undefined || isObj(v.jobProjects)) && (v.jobGens === undefined || isObj(v.jobGens));
const str = (v: unknown): boolean => typeof v === "string";
const num = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const validJob = (v: unknown): boolean => isObj(v) && v.v === 1 && str(v.askId) && ASK_ID.test(v.askId as string) && str(v.messageId) && str(v.project)
  && str(v.card) && str(v.target) && str(v.pm) && str(v.specHash) && str(v.question) && str(v.draftPath) && typeof v.direct === "boolean"
  && num(v.modeGen) && num(v.createdAt) && PM_JOB_STATES.includes(v.state as PmJobState) && Array.isArray(v.paths) && v.paths.every(str);

class PmJobLockBusy extends Error {}

export class PmJobStore {
  constructor(readonly dir = statePath("pm-job"), readonly modePath = statePath("pm-digest-mode.json")) {}

  private modes(): Modes {
    const r = readJsonStateSync(this.modePath, validModes);
    if (r.status === "corrupt") reportCorrupt(this.modePath, r.error, "pm-job");
    return r.status === "ok" ? r.data as Modes : {};
  }

  /** 缺省 / 文件损坏 = observe（原通知照常送，只出草稿） */
  mode(project: string): PmJobMode {
    const m = this.modes().jobProjects?.[project];
    return m === "on" || m === "off" ? m : "observe";
  }

  /** 模式世代：每次切开关加一；接单时记下，发前对不上就不直回 */
  gen(project: string): number {
    const g = this.modes().jobGens?.[project];
    return typeof g === "number" && Number.isInteger(g) && g >= 0 ? g : 0;
  }

  /** 写者读：损坏就拒写；PMDIG / PMROUTE 的键原样保留 */
  setMode(project: string, mode: PmJobMode): void {
    const r = readJsonStateSync(this.modePath, validModes);
    if (r.status === "corrupt") throw new StateCorruptError(this.modePath, r.error);
    const v = (r.status === "ok" ? r.data : {}) as Modes;
    writeJsonAtomicSync(this.modePath, { ...v, jobProjects: { ...v.jobProjects, [project]: mode }, jobGens: { ...v.jobGens, [project]: this.gen(project) + 1 } });
  }

  private file(askId: string, ...at: string[]): string {
    if (!ASK_ID.test(askId)) throw new Error(`不是合法的 ask 编号：${askId.slice(0, 40)}`);
    return join(this.dir, ...at);
  }

  path(askId: string): string { return this.file(askId, `${askId}.json`); }

  draftPath(askId: string): string { return this.file(askId, "drafts", `${askId}.md`); }

  /** 没有 / 损坏 / 文件名与内容里的 ask 编号对不上（挪过来的别的单）都按没有 */
  get(askId: string): PmJob | null {
    if (!ASK_ID.test(askId)) return null;
    const path = this.path(askId), r = readJsonStateSync(path, validJob);
    if (r.status === "corrupt") reportCorrupt(path, r.error, "pm-job");
    return r.status === "ok" && (r.data as PmJob).askId === askId ? r.data as PmJob : null;
  }

  list(): PmJob[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".json") && ASK_ID.test(f.slice(0, -5)))
      .map((f) => this.get(f.slice(0, -5))).filter((j): j is PmJob => !!j).sort((a, b) => a.createdAt - b.createdAt || a.askId.localeCompare(b.askId));
  }

  /** 锁内跑 fn；拿不到锁就抛（不降级放行：迁移必须独占） */
  async locked<T>(fn: () => T): Promise<T> {
    mkdirSync(this.dir, { recursive: true });
    const lock = await acquireLock(join(this.dir, ".lock"), LOCK_WAIT_MS, LOCK_STALE_MS);
    if (!lock) throw new PmJobLockBusy("pm-job 状态锁拿不到");
    try { return fn(); } finally { lock.release(); }
  }

  writeDraft(askId: string, text: string): void { writeTextAtomicSync(this.draftPath(askId), text); }

  private write(job: PmJob, now: number): PmJob {
    const next = { ...job, updatedAt: now };
    writeJsonAtomicSync(this.path(job.askId), next);
    return next;
  }

  /** 新单：草稿占位和单子都落盘才算接下；同号已有文件（哪怕损坏）不覆盖 */
  create(job: PmJob, draft: string): Promise<PmJob> {
    return this.locked(() => {
      if (existsSync(this.path(job.askId))) throw new Error(`${job.askId} 已有处理单`);
      this.writeDraft(job.askId, draft);
      return this.write(job, job.createdAt);
    });
  }

  /** 状态还在 from 里才迁；fn 返回 null = 核对没过，不写 */
  update(askId: string, from: readonly PmJobState[], now: number, fn: (job: PmJob) => PmJob | null): Promise<PmJob | null> {
    return this.locked(() => {
      const cur = this.get(askId), next = cur && from.includes(cur.state) ? fn(cur) : null;
      return next ? this.write(next, now) : null;
    });
  }

  /**
   * worker 认领最早一单并发租约。已有一单 running 且租约没过期 = 不领（上限 1，也挡住第二个 worker）；
   * 租约过期的 running = 持有它的 worker 死了：不重跑，记成要升级的草稿交给 bridge。
   */
  claim(now: number, lease: { token: string; pid: number; ms: number }, interrupted: (job: PmJob) => { result: PmJobResult; draft: string }): Promise<PmJob | null> {
    if (!existsSync(this.dir)) return Promise.resolve(null); // 从没接过单：不为认领建目录
    return this.locked(() => {
      const jobs = this.list();
      let busy = false;
      for (const j of jobs.filter((x) => x.state === "running")) {
        if ((j.lease?.until ?? 0) > now) { busy = true; continue; }
        const { result, draft } = interrupted(j);
        this.writeDraft(j.askId, draft);
        this.write({ ...j, state: "drafted", result, finishedAt: now, lease: undefined }, now);
      }
      const next = busy ? undefined : jobs.find((j) => j.state === "queued");
      return next ? this.write({ ...next, state: "running", startedAt: now, lease: { token: lease.token, pid: lease.pid, until: now + lease.ms } }, now) : null;
    });
  }

  private mine(askId: string, token: string): PmJob | null {
    const j = this.get(askId);
    return j && j.state === "running" && j.lease?.token === token ? j : null;
  }

  renew(askId: string, token: string, now: number, ms: number): Promise<boolean> {
    return this.locked(() => {
      const j = this.mine(askId, token);
      return !!j && !!this.write({ ...j, lease: { ...j.lease!, until: now + ms } }, now);
    });
  }

  /** 没开跑就放回队列（槽位满）：下一个 worker 再领 */
  requeue(askId: string, token: string, now: number): Promise<boolean> {
    return this.locked(() => {
      const j = this.mine(askId, token);
      return !!j && !!this.write({ ...j, state: "queued", lease: undefined, startedAt: undefined }, now);
    });
  }

  /** worker 写结果：草稿先落盘，再把单子迁到 drafted；租约已不是自己的（bridge 超时接走了）就不写 */
  finish(askId: string, token: string, now: number, result: PmJobResult, usage: PmJobUsage | undefined, draft: (job: PmJob) => string): Promise<boolean> {
    return this.locked(() => {
      const j = this.mine(askId, token);
      if (!j) return false;
      const next: PmJob = { ...j, state: "drafted", result, ...(usage ? { usage } : {}), finishedAt: now, lease: undefined };
      this.writeDraft(askId, draft(next));
      return !!this.write(next, now);
    });
  }

  remove(askId: string): void {
    rmSync(this.path(askId), { force: true });
    rmSync(this.draftPath(askId), { force: true });
  }
}
