import { configuredAgentLimits } from "./scheduler-agent-pool-runtime.js";
import { cardRoleIo } from "./card-role-definitions.js";
/** Adapts the existing start pipeline, retaining its rollback and the runtime's canonical ACP manager launch. */
import { queueLocalStart, type QueuedStart } from "./scheduler-local-runtime-queue.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { preflightStart, type StartPlan } from "./dag-tools-start.js";
import type { StepIO, StartOutcome } from "./dag-tools-steps.js";
import { projectPm, type Candidate } from "./scheduler-autostart.js";
import type { StartTickEnv } from "./scheduler-autostart-run.js";
import type { StartPlacement } from "./scheduler-placement-start.js";
import type { EnsureResult } from "./worker-session.js";
import { readRegistryAgentsSync } from "./registry.js";
import { localAuthorRuntime } from "./scheduler-local-runtime.js";
import { codexSlotHeld, withCodexSlot, type CodexSlotOptions, type SlotWait } from "./scheduler-local-runtime-slots.js";
import type { Database } from "bun:sqlite";
import { bindTierSession } from "./task-tier-launch-events.js";
import type { TierLaunchCtx } from "./task-tier-models.js";

export { localAuthorRuntime } from "./scheduler-local-runtime.js";

const selection = new AsyncLocalStorage<{ project: string; runtime: "claude" | "codex" }>();
const selected = (project: string, path?: string) => {
  const current = selection.getStore();
  return current?.project === project ? current.runtime : localAuthorRuntime(project, path);
};

export interface LocalStartOptions extends CodexSlotOptions {
  configPath?: string; projectsPath?: string; queuedReady?: (plan: StartPlan) => Promise<string | null>; queuedNotice?: (text: string) => Promise<void>;
}

export type { QueuedStart } from "./scheduler-local-runtime-queue.js";

export async function runLocalStart(io: StepIO, p: StartPlan, run: (io: StepIO, p: StartPlan) => Promise<StartOutcome | QueuedStart>,
  opts: LocalStartOptions = {}): Promise<StartOutcome | QueuedStart> {
  const runtime = selected(p.project, opts.configPath);
  const tier = startTier(io, p);
  io = cardRoleIo(io, { family: runtime, ...(tier ? { tier } : {}) }); // ROLE1 + TIER3: role definition and task-tier model (card-role-definitions.ts)
  const slotOpts = { ...opts, project: p.project, family: runtime };
  if (p.peer || (runtime === "claude" && !configuredAgentLimits(slotOpts))) return bound(tier, p, await run(io, p), opts.registryPath);
  const retry = (beforeStart?: () => Promise<void>) => withCodexSlot(async () => {
    await beforeStart?.();
    return run({ ...io, manager: async (args, timeout) => {
    if (args[0] === "create") {
      if (!codexSlotHeld()) return { ok: false, error: "Codex 全机槽锁已失租，没有创建会话" };
      if (runtime === "codex") args = [...args, "--runtime", "codex", "--transport", "acp"];
    } else if (args[0] === "ledger" && args[1] === "workflow-set") {
      args = args.map((arg) => arg.startsWith("--author-family=") ? `--author-family=${runtime}` : arg);
      const index = args.indexOf("--author-family");
      if (index >= 0) { args = [...args]; args[index + 1] = runtime; }
    }
    return io.manager(args, timeout);
  } }, p);
  }, { ...slotOpts, checkQuota: true });
  const result = await retry();
  return "kind" in result ? queueLocalStart(io, p, opts, result.reason, retry) : bound(tier, p, result, opts.registryPath);
}

/** start_node 的作者：新卡，类型 = 预检定下的流程模板，规格就是这次要写进去的那份；argv 自带的 --effort high 是原档。peer 卡不在本机建，不给 */
function startTier(io: StepIO, p: StartPlan): TierLaunchCtx | null {
  if (p.peer) return null;
  // 只给了 manager 的精简 io（测试替身、嵌套入口）没有台账 / 读文件：这时不记事实、只认计划里的模板
  let db: Database | undefined;
  try { db = typeof io.db === "function" ? io.db() : undefined; } catch (e) { console.error(`[task-tier] ${p.taskId} 开台账失败，启动事实不记：${(e as Error).message}`); }
  const specText = p.specText ?? (typeof io.read === "function" ? io.read(p.specPath) : null);
  return { db, project: p.project, card: p.taskId, tier: p.workflow?.template ?? "code", specText, round: 0, baseEffort: "high" };
}

/** 建成后 registry 里已有 session id 才绑；还没有就留在「已尝试」，读出来实际是 unknown */
function bound<T>(tier: TierLaunchCtx | null, p: StartPlan, result: T, registryPath?: string): T {
  const sid = tier?.db ? readRegistryAgentsSync(registryPath).find((r) => r.name === p.agent)?.sessionId : undefined;
  if (tier?.db && sid) bindTierSession(tier.db, { project: p.project, id: p.taskId }, p.agent, sid, "author");
  return result;
}

/** Claim waits before writing anything; nested runStart reuses the same lock instead of racing or deadlocking. */
export async function localAutostart(project: string, run: () => Promise<void>, opts: LocalStartOptions = {}): Promise<void | SlotWait> {
  const runtime = selected(project, opts.configPath);
  return selection.run({ project, runtime }, async () => {
    if (runtime === "claude" && !configuredAgentLimits({ ...opts, project })) return run();
    return withCodexSlot(run, { ...opts, project, family: runtime, checkQuota: true });
  });
}

/** The registry, rather than a mutable project setting or caller flag, proves the runtime actually created. */
export function localCreatedFamily(agent: string, registryPath?: string): "claude" | "codex" {
  return readRegistryAgentsSync(registryPath).find((r) => r.name === agent)?.runtime === "codex" ? "codex" : "claude";
}

export async function localEnsure(family: string, exists: boolean, run: () => Promise<EnsureResult>, opts: CodexSlotOptions = {}): Promise<EnsureResult> {
  if (configuredAgentLimits(opts)) return withCodexSlot(run, { ...opts, family: family as "claude" | "codex" });
  if (family !== "codex" || exists) return run();
  return withCodexSlot(run, opts);
}

/** Guard the manager spawn after reviewer worktree preparation; lease loss must not create beyond the limit. */
export function localCreateGuard<T extends (...args: string[]) => Promise<Record<string, unknown>>>(create: T): T {
  return (async (...args: string[]) => {
    if (args[0] === "create" && (args[args.indexOf("--runtime") + 1] === "codex" || args.includes("--runtime=codex")) && !codexSlotHeld()) {
      return { ok: false, error: "Codex 全机槽锁已失租，没有创建会话" };
    }
    return create(...args);
  }) as T;
}

/** LS1 chooses a destination before claim: peer work consumes no local Codex slot, and the choice stays pinned for that claim. */
export async function localAutostartNode(env: StartTickEnv, cand: Candidate, run: (next: StartTickEnv) => Promise<void>,
  opts: LocalStartOptions = {}): Promise<void | SlotWait> {
  if (localAuthorRuntime(cand.f.project, opts.configPath) === "claude" &&
    !configuredAgentLimits({ ...opts, project: cand.f.project })) return run(env);
  const pre = await preflightStart({ ...env.startEnv(), db: env.db, caller: projectPm(env.db, cand.f.project) ?? "" },
    { featureId: cand.f.id, key: cand.key, template: cand.head.template.ok ? cand.head.template.template : undefined });
  if (!pre.ok || "already" in pre) return run(env);
  const peer = pre.plan.peer;
  const placement: StartPlacement = peer ? { where: "peer", peer: peer.name, repo: peer.repo, reason: peer.reason }
    : { where: "local", reason: "本轮 preflight 选定本机，claim 仍核对目的地容量" };
  const next: StartTickEnv = { ...env, startEnv: () => ({ ...env.startEnv(), placement: async () => placement }) };
  if (peer) return run(next);
  return localAutostart(cand.f.project, () => run(next), { ...opts, ledgerPath: opts.ledgerPath ?? env.db.filename });
}
