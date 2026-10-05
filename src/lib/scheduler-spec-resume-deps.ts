/**
 * spec 阶段 auto 卡放置（i28-RSM1，scheduler-spec-resume.ts）的生产接线：放置走自动开卡同一个 startPlacement（finishFirst），
 * 策略取 scheduler.json、借入名单取 readEffectiveBorrow、仓库坐标取项目目录 origin；git 包在 whileOwned 里，服务停了就什么都不做。
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { notifyProjectPm } from "./pm-notify.js";
import { readProjects } from "./projects.js";
import { runBounded } from "./run-bounded.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { whileOwned } from "./scheduler-maintenance.js";
import { startPlacement } from "./scheduler-placement-start.js";
import { placementReservationPort } from "./scheduler-placement-reservations.js";
import { readEffectiveBorrow } from "./scheduler-pool-borrow.js";
import { specResumeTick } from "./scheduler-spec-resume.js";
import type { TickPace } from "./scheduler-yield.js";

type Ledger = (...args: string[]) => Promise<Record<string, unknown>>;

const GITHUB = /github\.com[:/]([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?$/;

export function specResumeStep(db: Database, config: SchedulerConfig, ledger: Ledger, active: () => void, pace?: TickPace) {
  const alive = () => { try { active(); return true; } catch { return false; /* 服务在停或丢了租约：不再发通知 */ } };
  const origin = async (dir: string) => whileOwned(active, async () => {
    const r = await runBounded(["git", "remote", "get-url", "origin"], { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 30_000 });
    return r.code === 0 && !r.timedOut ? r.stdout.trim().match(GITHUB)?.[1] ?? null : null;
  });
  const policy = (project: string) => { const p = config.projects[project]; return p ? { remote: p.remote ?? null, maxWorkers: p.maxActiveWorkers } : null; };
  return specResumeTick({
    db, projects: config.enabled && config.autoDispatch === true ? Object.keys(config.projects) : [], ledger,
    place: (d, q) => startPlacement(d, { policy, borrow: readEffectiveBorrow, originRepo: origin, now: Date.now, reservations: placementReservationPort }, q, true),
    repoDir: async (project) => (await readProjects()).projects.find((p) => p.id === project)?.dirs.find((d) => existsSync(join(d, ".git"))) ?? null,
    notifyPm: (project, text) => notifyProjectPm(db, project, text, { fromName: "scheduler", stillActive: alive }),
  }, pace);
}
