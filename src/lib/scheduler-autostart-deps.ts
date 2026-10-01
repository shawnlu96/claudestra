/**
 * 自动开卡 / 自动交回（i28-A1）的生产接线：schedulerPass 在 autoDispatch 块里先 resume（auto tick 之前）、后 start（之后）。
 * 台账写走传进来的调度身份 CLI（已套租约守卫）；create / kill 走不带调度身份、带服务租约的 manager（同 scheduler-auto-deps.ts 建审查员）；
 * git 每次调用都包在 whileOwned 里，服务停了或丢了租约，排着的 git 什么都不做。进程内去重表跨轮保留（模块级），重启清空。
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readInventoryQuota } from "./ai-quota.js";
import { resolveBunPath } from "./bun-path.js";
import { statePath } from "./paths.js";
import { notifyProjectPm } from "./pm-notify.js";
import { readProjects } from "./projects.js";
import { readRegistryAgentsSync } from "./registry.js";
import { SRC_DIR } from "./repo-root.js";
import { runBounded } from "./run-bounded.js";
import { runManagerProcess } from "./run-manager.js";
import type { ServiceFacts, SpecFile } from "./scheduler-autostart.js";
import { autoResumeTick } from "./scheduler-autostart-resume.js";
import { autostartTick, type StartTickEnv } from "./scheduler-autostart-run.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { encodeLease, SCHEDULER_LEASE_ENV, type SchedulerLease } from "./scheduler-lease-env.js";
import { SchedulerStopped, whileOwned } from "./scheduler-maintenance.js";
import type { TickPace } from "./scheduler-yield.js";
import { writeTextAtomicSync } from "./state-file.js";

type Failed = { taskId: string; error: string }[];
type Ledger = (...args: string[]) => Promise<Record<string, unknown>>;

export interface AutostartHooks {
  resume(config: SchedulerConfig, pace: TickPace): Promise<Failed>;
  start(config: SchedulerConfig, pace: TickPace): Promise<Failed>;
}

const serviceFacts = (config: SchedulerConfig): ServiceFacts => ({
  autoDispatch: config.autoDispatch === true, projects: config.enabled ? Object.keys(config.projects) : [],
  maxWorkers: (p) => config.projects[p]?.maxActiveWorkers ?? 0,
});

/** 跨轮的去重表：额度窗口、被核心拒绝的交付（重启后各最多再发一次） */
const MEMO = new Set<string>();

/** 自动开卡规格卡的唯一拼法：specGate 读它，建卡时 task.spec 也记它（绝对路径，挂给远端审查才找得到原文） */
export const autostartSpecPath = (taskId: string) => join(statePath("ledger"), "docs", "tasks", `${taskId}.md`);

function readSpec(path: string): SpecFile | null {
  try {
    return { mtimeMs: statSync(path).mtimeMs, text: readFileSync(path, "utf8") };
  } catch {
    return null; // 不在（还在 drafts/ 里）或读不了：都当没定稿，不开
  }
}

interface WireOpts { db: Database; ledger: Ledger; active: () => void; lease: SchedulerLease | undefined }

/** start_node 要的读环境与执行 IO：路径、registry、项目目录从生产位置现读；git 套 whileOwned */
function startIo(o: WireOpts, config: SchedulerConfig): Pick<StartTickEnv, "startEnv" | "stepIO" | "plain"> {
  const git = async (cwd: string, args: string[], timeoutMs = 30_000) => whileOwned(o.active, async () => {
    const r = await runBounded(["git", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs });
    if (r.code === 0 && !r.timedOut) return { ok: true, out: r.stdout.trim() };
    return { ok: false, out: (r.timedOut ? "超时" : r.stderr || r.stdout).trim().slice(0, 500) };
  });
  const agentNames = () => readRegistryAgentsSync().map((a) => a.name);
  const execTemplate = statePath("ledger", "prompts", "exec-template.md");
  return {
    plain: async (args, timeoutMs = 120_000) => {
      const r = await whileOwned(o.active, () => runManagerProcess(args, { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`,
        env: { ...process.env, DISCORD_CHANNEL_ID: "", [SCHEDULER_LEASE_ENV]: encodeLease(o.lease) }, timeoutMs }));
      if (r?.code === "lease-lost") throw new SchedulerStopped(`manager ${args[0]}: ${String(r.error)}`); // 服务在停，不是这一步失败
      return r;
    },
    startEnv: () => ({
      ledgerDir: statePath("ledger"), worktreeRoot: statePath("worktrees"), agentNames, exists: existsSync,
      projectDirs: async (id) => (await readProjects()).projects.find((p) => p.id === id)?.dirs ?? [],
      branchExists: async (repo, branch) => (await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok,
      autoReady: (project) => (config.enabled && config.autoDispatch && Object.hasOwn(config.projects, project) ? null : `调度服务没对项目 ${project} 开自动派单`),
      template: () => (existsSync(execTemplate) ? readFileSync(execTemplate, "utf8") : null),
    }),
    stepIO: () => ({
      git, exists: existsSync, read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null), write: (p, text) => writeTextAtomicSync(p, text),
      remove: (p) => { if (existsSync(p)) unlinkSync(p); }, symlink: (target, p) => symlinkSync(target, p),
      agentExists: (agent) => agentNames().includes(agent),
    }),
  };
}

export function autostartHooks(o: WireOpts): AutostartHooks {
  const alive = () => {
    try { o.active(); return true; } catch { return false; /* 存活检查抛错 = 服务在停或丢了租约：什么都不发 */ }
  };
  const notifyPm = (project: string, text: string) => notifyProjectPm(o.db, project, text, { fromName: "scheduler", stillActive: alive });
  return {
    resume: (config, pace) => autoResumeTick({ db: o.db, svc: serviceFacts(config), ledger: o.ledger, notifyPm, memo: MEMO }, pace),
    start: (config, pace) => autostartTick({
      db: o.db, svc: serviceFacts(config), ledger: o.ledger, ...startIo(o, config), notifyPm, memo: MEMO, now: Date.now,
      readSpec: (taskId) => readSpec(autostartSpecPath(taskId)),
      quota: async () => (await readInventoryQuota()).claude, attempt: () => randomBytes(4).toString("hex"),
    }, pace),
  };
}
