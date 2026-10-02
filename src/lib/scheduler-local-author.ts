/** Late local placement creates the same worktree/worker shape as start_node, without reopening the existing card. */
import type { Database } from "bun:sqlite";
import { configuredAgentLimits, poolAuthorRuntime } from "./scheduler-agent-pool-runtime.js";
import { existsSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getMeta, getTask } from "./ledger-store.js";
import type { RegistryRow } from "./scheduler-auto-ports.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { localAuthorPlan, type LocalAuthorPlan } from "./scheduler-local-author-plan.js";
import { reusableAuthorWorktree } from "./scheduler-create-retry.js";
import { queuedLocalAuthor } from "./scheduler-local-author-queue.js";
import { localAuthorRuntime, localCreateGuard, type LocalStartOptions } from "./scheduler-local-runtime-start.js";
import { withCodexSlot } from "./scheduler-local-runtime-slots.js";
import { SchedulerStopped, whileOwned } from "./scheduler-maintenance.js";
import type { Git } from "./scheduler-review-worktree.js";
import { writeTextAtomicSync } from "./state-file.js";
import type { EnsureResult } from "./worker-session.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface LocalAuthorEnv {
  db: Database; registryRow: RegistryRow; worktreeRoot: string; active: () => void; git: Git; create: Manager; ledger: Manager; registryPath?: string;
}

function claimed(env: LocalAuthorEnv, task: LedgerTask): SchedulerIntent | null {
  env.active();
  const cur = getTask(env.db, task.id), w = getWorkflow(env.db, task.id);
  if (!cur || cur.rev !== task.rev || cur.agent || !w || w.mode !== "auto" || w.specRev !== cur.specRev
    || getMeta(env.db, task.project).queueFrozen.frozen || String(cur.extra.placement ?? "").startsWith("peer:")) return null;
  return env.db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND action = 'ensure_session' AND node != 'adversarial_review'
    AND status = 'submitted' AND recipient IS NULL AND taskRev = ? AND specRev = ? ORDER BY eventSeq DESC LIMIT 1`)
    .get(task.id, task.rev, task.specRev) as SchedulerIntent | null;
}

async function checkout(env: LocalAuthorEnv, p: LocalAuthorPlan, guard: () => void): Promise<string | null> {
  const git = (args: string[]) => whileOwned(guard, () => env.git(["-C", p.repo, ...args]));
  // A clean create failure's retry finds its own earlier worktree: reuse it only when untouched (scheduler-create-retry.ts).
  const left = existsSync(p.worktree) ? await reusableAuthorWorktree(git, p) : undefined;
  if (left) return left;
  if (left === undefined) {
    if ((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${p.branch}`])).code === 0) return `分支 ${p.branch} 已存在，保留并等待核对`;
    const fetch = await git(["fetch", "-q", "origin"]);
    if (fetch.code !== 0) return `更新仓库失败：${fetch.out}`;
    if ((await git(["check-ref-format", "--branch", p.branch])).code !== 0) return "卡上分支名不合法";
    const add = await git(["worktree", "add", "-b", p.branch, p.worktree, p.base]);
    if (add.code !== 0) return `创建本机 worktree 失败：${add.out}`;
  }
  guard();
  for (const sub of ["node_modules", join("web", "node_modules")]) {
    const source = join(p.repo, sub), dest = join(p.worktree, sub);
    if (existsSync(source) && existsSync(dirname(dest)) && !existsSync(dest)) symlinkSync(source, dest);
  }
  writeTextAtomicSync(p.promptPath, p.promptText);
  return null;
}

async function launch(env: LocalAuthorEnv, task: LedgerTask, p: LocalAuthorPlan, opts: LocalStartOptions): Promise<EnsureResult> {
  const intent = claimed(env, task);
  if (!intent) return { kind: "wait", reason: "作者建会话意图已改变，下一轮重算" };
  const policy = readSchedulerConfig(opts.configPath).projects[task.project];
  const family = policy?.agents ? poolAuthorRuntime(task.project, policy.agents, env.db.filename) : localAuthorRuntime(task.project, opts.configPath);
  const guard = () => {
    env.active();
    if (claimed(env, task)?.id !== intent.id) throw new Error("卡或建会话意图已改变，停止本次创建");
    const config = readSchedulerConfig(opts.configPath);
    if (!config.enabled || !config.autoDispatch || !config.projects[task.project]) throw new Error("本机执行者配置已改变，停止本次创建");
  };
  const create = async (): Promise<EnsureResult> => {
    guard();
    if (env.registryRow(p.agent)) return { kind: "unknown", reason: `${p.agent} 已存在但未绑定，保留会话等待核对` };
    const failure = await checkout(env, p, guard);
    if (failure) return { kind: "unknown", reason: failure };
    const flags = family === "codex" ? ["--runtime", "codex", "--transport", "acp"] : [];
    const r = await whileOwned(guard, () => localCreateGuard(env.create)("create", p.agentName, p.worktree,
      "--purpose", p.purpose, "--task", p.taskId, "--effort", "high", "--project", p.project, ...flags));
    if (r.code === "lease-lost") throw new SchedulerStopped(String(r.error));
    if (r.ok !== true) return { kind: "unknown", reason: `建 ${p.agent} 结果不明：${String(r.error ?? "")}` };
    for (let n = 0; n < 30; n++) {
      guard();
      const row = env.registryRow(p.agent);
      if (row?.sessionId) {
        if (row.cwd !== p.worktree || row.projectId !== task.project || (row.runtime === "codex" ? "codex" : "claude") !== family) {
          return { kind: "unknown", reason: `${p.agent} 的目录、项目或运行时不符` };
        }
        const saved = await whileOwned(env.active, () => env.ledger("ledger", "scheduler-autostart", "step", String(intent.eventSeq), "local-author",
          task.id, intent.id, `--rev=${task.rev}`, `--agent=${row.name}`, `--author-family=${family}`, `--dedup=local-author:${intent.id}`));
        if (saved.code === "lease-lost") throw new SchedulerStopped(String(saved.error));
        if (saved.ok !== true) return { kind: "unknown", reason: `本机会话已建，写回执行者失败：${String(saved.error)}` };
        return { kind: "ready", created: true, ref: { taskId: task.id, role: "author", agent: row.name, sessionId: row.sessionId,
          family, transport: row.transport === "acp" ? "acp" : "tmux" } };
      }
      await Bun.sleep(3000);
    }
    return { kind: "unknown", reason: `${p.agent} 已建，90 秒内没等到 session id` };
  };
  const slotOpts = { ...opts, registryPath: env.registryPath ?? opts.registryPath, ledgerPath: env.db.filename, project: task.project, taskId: task.id, family };
  return family === "codex" || configuredAgentLimits(slotOpts) ? withCodexSlot(create, { ...slotOpts, checkQuota: true }) : create();
}

export async function ensureLocalAuthor(env: LocalAuthorEnv, task: LedgerTask, opts: LocalStartOptions = {}): Promise<EnsureResult> {
  const intent = claimed(env, task);
  if (!intent) return { kind: "manual", reason: "缺当前作者建会话意图，需 PM 指定执行者或由调度器重新计划" };
  const plan = await localAuthorPlan(env.db, task, env.worktreeRoot, opts);
  if (typeof plan === "string") return { kind: "manual", reason: plan };
  const note = (args: string[]) => whileOwned(env.active, () => env.ledger("ledger", "scheduler-autostart", "step", String(intent.eventSeq),
    "local-author-note", task.id, intent.id, `--text=${args[3]}`, `--dedup=local-author-queue:${intent.id}:${args[3]?.match(/排队 (\w+)/)?.[1]}`));
  return queuedLocalAuthor(env.db, plan, opts, note, () => launch(env, task, plan, opts));
}
