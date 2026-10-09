/** Retirement effects must check the live route and the intent's claimed term at the moment of emission. */
import type { Database } from "bun:sqlite";
import type { RetireDeps } from "./scheduler-retire.js";
import type { V2Fence } from "./shared-ledger-contract-v2-validation.js";

export interface ExecFeatureRef {
  localFeatureId: string;
  projectId: string;
  centerFeatureId: string;
  epoch: number;
}

export interface SchedulerV2RetirePort {
  route(taskId: string): "local" | "skip" | "central";
  featureOfTask(taskId: string): ExecFeatureRef | null;
  fence(featureId: string): V2Fence | null;
  claimFence(intentId: string): V2Fence | null;
}

let configured: SchedulerV2RetirePort | null = null;
export function configureSchedulerV2Retire(port: SchedulerV2RetirePort | null): void { configured = port; }

export class V2Held extends Error {
  constructor(taskId: string) { super(`V2Held: ${taskId} retirement route is skip`); this.name = "V2Held"; }
}
export class V2LeaseLost extends Error {
  constructor(taskId: string) { super(`V2LeaseLost: ${taskId} retirement claim is not the current term`); this.name = "V2LeaseLost"; }
}

export function withSchedulerV2Retire(db: Database, deps: RetireDeps): RetireDeps {
  const port = configured;
  if (!port) return deps;
  let taskId: string | null = null, intentId: string | null = null;
  const check = (agent?: string): void => {
    let task = taskId, intent = intentId;
    if (!task && agent) {
      const row = db.query("SELECT taskId FROM scheduler_sessions WHERE agent = ? ORDER BY updatedAt DESC LIMIT 1")
        .get(agent) as { taskId: string } | null;
      task = row?.taskId ?? null;
      if (task) intent = (db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND action = 'retire' AND status = 'submitted'")
        .get(task) as { id: string } | null)?.id ?? null;
    }
    if (!task) return;
    const route = port.route(task);
    if (route === "local") return;
    if (route === "skip") throw new V2Held(task);
    const feature = port.featureOfTask(task), current = feature ? port.fence(feature.centerFeatureId) : null;
    const claim = intent ? port.claimFence(intent) : null;
    if (!current || !claim || current.epoch !== claim.epoch || current.bootId !== claim.bootId ||
      current.serviceGeneration !== claim.serviceGeneration) throw new V2LeaseLost(task);
  };
  return {
    ...deps,
    ledger: async (...args) => {
      const begin = args[0] === "ledger" && args[1] === "scheduler-retire";
      if (begin) { taskId = args[2] ?? null; intentId = null; }
      const result = await deps.ledger(...args);
      if (begin) intentId = (result.intent as { id?: string } | undefined)?.id ?? null;
      return result;
    },
    agent: (...args) => { if (args[0] === "archive" || args[0] === "kill") check(args[1]); return deps.agent(...args); },
    git: (args) => { check(); return deps.git(args); },
    ...(deps.tmp ? { tmp: { ...deps.tmp, rm: (path: string) => { check(); return deps.tmp!.rm(path); } } } : {}),
  };
}
