/** Adapts the existing start pipeline, retaining its rollback and the runtime's canonical ACP manager launch. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { StartPlan } from "./dag-tools-start.js";
import type { StepIO, StartOutcome } from "./dag-tools-steps.js";
import type { EnsureResult } from "./worker-session.js";
import { readRegistryAgentsSync } from "./registry.js";
import { localAuthorRuntime } from "./scheduler-local-runtime.js";
import { codexSlotHeld, withCodexSlot, type CodexSlotOptions } from "./scheduler-local-runtime-slots.js";

export { localAuthorRuntime } from "./scheduler-local-runtime.js";

const selection = new AsyncLocalStorage<{ project: string; runtime: "claude" | "codex" }>();
const selected = (project: string, path?: string) => {
  const current = selection.getStore();
  return current?.project === project ? current.runtime : localAuthorRuntime(project, path);
};

export interface LocalStartOptions extends CodexSlotOptions { configPath?: string }

export async function runLocalStart(io: StepIO, p: StartPlan, run: (io: StepIO, p: StartPlan) => Promise<StartOutcome>,
  opts: LocalStartOptions = {}): Promise<StartOutcome> {
  if (p.peer || selected(p.project, opts.configPath) === "claude") return run(io, p);
  const result = await withCodexSlot(() => run({ ...io, manager: async (args, timeout) => {
    if (args[0] === "create") {
      if (!codexSlotHeld()) return { ok: false, error: "Codex 全机槽锁已失租，没有创建会话" };
      args = [...args, "--runtime", "codex", "--transport", "acp"];
    } else if (args[0] === "ledger" && args[1] === "workflow-set") {
      args = args.map((arg) => arg.startsWith("--author-family=") ? "--author-family=codex" : arg);
      const index = args.indexOf("--author-family");
      if (index >= 0) { args = [...args]; args[index + 1] = "codex"; }
    }
    return io.manager(args, timeout);
  } }, p), opts);
  return "kind" in result ? { ok: false, code: "start_failed", error: result.reason, failedStep: "agent", rolledBack: [], leftovers: [] } : result;
}

/** Claim waits before writing anything; nested runStart reuses the same lock instead of racing or deadlocking. */
export async function localAutostart(project: string, run: () => Promise<void>, opts: LocalStartOptions = {}): Promise<void> {
  const runtime = selected(project, opts.configPath);
  await selection.run({ project, runtime }, async () => {
    if (runtime === "claude") return run();
    await withCodexSlot(run, opts);
  });
}

/** The registry, rather than a mutable project setting or caller flag, proves the runtime actually created. */
export function localCreatedFamily(agent: string, registryPath?: string): "claude" | "codex" {
  return readRegistryAgentsSync(registryPath).find((r) => r.name === agent)?.runtime === "codex" ? "codex" : "claude";
}

export async function localEnsure(family: string, exists: boolean, run: () => Promise<EnsureResult>, opts: CodexSlotOptions = {}): Promise<EnsureResult> {
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
