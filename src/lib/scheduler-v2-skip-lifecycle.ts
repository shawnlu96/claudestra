/**
 * S2D2 · the lifecycle executor re-checks the route right before each effect (PM 定 3, S2V's rule): the plan is from a snapshot
 * that marked skip cards frozen, but a card can turn migrating while an action runs. An effect of a card that is skip now throws
 * S2V's `V2Held` before it is sent (archive / remove, git, temp folder, PM notice, ledger record); other cards' effects go on.
 * A git read is checked again when it returns: the checkout cleanup archives and unlinks files right after its surveys, so a
 * change during a survey stops it before those file effects (agent-lifecycle-cleanup.ts).
 * Tests: tests/shared-ledger-v2-stage2-skip-lifecycle.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LifecyclePolicy } from "./agent-lifecycle-config.js";
import type { LifecycleDeps } from "./agent-lifecycle-run.js";
import type { Action, Plan } from "./agent-lifecycle.js";
import { within, worktreeDirs } from "./scheduler-retire.js";
import { claudeTmpDirFor } from "./scheduler-retire-tmp.js";
import { V2Held } from "./scheduler-v2-retire.js";
import { schedulerV2Held, schedulerV2SkipTask } from "./scheduler-v2-skip-card.js";

/** Every path an action's cleanup can touch: its card's checkouts, its cwd, a retry's entries, and their temp folders. */
function actionPaths(a: Action, deps: Pick<LifecycleDeps, "worktreeRoot" | "tmp">): string[] {
  const dirs = [...(a.taskId ? worktreeDirs(deps.worktreeRoot, a.taskId) : []), ...(a.cwd ? [a.cwd] : []),
    ...(a.entries ?? []).flatMap((e) => (e.tmp ? [e.checkout, e.tmp] : [e.checkout]))];
  const root = deps.tmp?.root;
  return root ? [...dirs, ...dirs.map((d) => claudeTmpDirFor(d, root))] : dirs;
}

export function schedulerV2LifecycleDeps(db: Database, plan: Pick<Plan, "actions" | "memory" | "cleanups">, deps: LifecycleDeps): LifecycleDeps {
  const all = [...plan.actions, ...plan.memory, ...plan.cleanups];
  const hold = (actions: readonly Pick<Action, "taskId">[]): void => {
    for (const a of actions) {
      if (a.taskId && schedulerV2SkipTask(db, a.taskId)) {
        schedulerV2Held("lifecycle", a.taskId);
        throw new V2Held(a.taskId);
      }
    }
  };
  const touching = (paths: readonly string[]) => all.filter((a) => actionPaths(a, deps).some((d) => paths.some((p) => within(p, d) || within(d, p))));
  return {
    ...deps,
    manager: async (...args) => { hold(all.filter((a) => a.agent === args[args.length - 1])); return deps.manager(...args); },
    git: async (args) => {
      const mine = () => touching(args.filter((x) => x.startsWith("/")));
      hold(mine());
      const out = await deps.git(args);
      hold(mine());
      return out;
    },
    ...(deps.tmp ? { tmp: { ...deps.tmp, rm: async (p: string) => { hold(touching([p])); return deps.tmp!.rm(p); } } } : {}),
    record: async (r) => { hold([r]); return deps.record(r); },
    ...(deps.notifyPm ? { notifyPm: async (a: Action, text: string) => { hold([a]); return deps.notifyPm!(a, text); } } : {}),
  };
}

/** `runLifecycle` with the per-effect route check (agent-lifecycle-deps.ts's one-line hook). */
export const schedulerV2Lifecycle = <R>(db: Database, run: (plan: Plan, policy: LifecyclePolicy, deps: LifecycleDeps) => Promise<R>) =>
  (plan: Plan, policy: LifecyclePolicy, deps: LifecycleDeps): Promise<R> => run(plan, policy, schedulerV2LifecycleDeps(db, plan, deps));
