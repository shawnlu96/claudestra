/** Transport is not identity: local runtime wins; a remote claim needs the card's explicit peer assignment. */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { currentReview, stepAtStage, stepPeer, stepsOf } from "./ledger-steps.js";
import { LedgerError } from "./ledger-store.js";
import { bareCanonicalName, readRegistryAgentsSync } from "./registry.js";
import { setWorkerKind } from "./worker-kind.js";
import type { BindSessionInput } from "./scheduler-sessions.js";

export function requireSessionIdentity(db: Database, task: LedgerTask, input: BindSessionInput, agent: string): void {
  const local = readRegistryAgentsSync(input.registryPath).find((row) => bareCanonicalName(row.name) === bareCanonicalName(agent));
  if (local) {
    const family = local.runtime === "codex" ? "codex" :
      local.runtime === undefined || local.runtime === "claude-code" ? "claude" : null;
    if (!family || family !== input.family) throw new LedgerError("invalid", "本机 session 模型家族与 registry runtime 不符");
    if (input.transport === "peer") throw new LedgerError("invalid", "本机 registry agent 不能声明 peer transport");
    if (agent !== local.name) throw new LedgerError("invalid", "本机 session 必须使用 registry 完整名称");
    if (!setWorkerKind({ [local.name]: { ...local } }, local.name, "worker")) {
      throw new LedgerError("invalid", "长驻主 agent / PM 不能绑定成每卡 worker session");
    }
    return;
  }
  if (input.transport !== "peer") throw new LedgerError("invalid", "本机 session 模型家族与 registry runtime 不符");
  const steps = stepsOf(db, task);
  const assigned = input.role === "reviewer" ? currentReview(steps) : stepAtStage(steps, task);
  if (!assigned || assigned.executor !== agent || !stepPeer(assigned)) {
    throw new LedgerError("invalid", "peer session 必须是本卡当前步骤明确委托的 <agent>@<peer>");
  }
}
