import { validatePlan } from "./definition.ts";
import { inventory, legacy, port, type Context } from "./safety.ts";
import { execute, steps } from "./steps.ts";
import type { Journal, Options, Result, ServicePlan } from "./types.ts";
export { createServicePlan } from "./definition.ts";

function validateJournal(j: Journal, key: string, c: Context): void {
  if (j.version !== 1 || j.planKey !== key || !["forward", "rollback"].includes(j.direction) ||
      !["running", "committed", "rolled-back"].includes(j.status)) throw new Error("Journal does not match this service plan");
  const end = steps(c, j.direction).length;
  if (!Number.isSafeInteger(j.cursor) || j.cursor < 0 || j.cursor > end ||
      (j.status === "running" && j.cursor === end) ||
      (j.status !== "running" && (j.cursor !== end || j.status !== (j.direction === "forward" ? "committed" : "rolled-back")))) {
    throw new Error("Invalid service journal cursor/status");
  }
}

async function underLock(c: Context, action: Options["action"]): Promise<Result> {
  let j = await port(c, () => c.controller.readJournal());
  if (j) {
    const snapshot: ServicePlan = structuredClone(j.snapshot ?? JSON.parse(j.planKey));
    validatePlan(snapshot);
    if (snapshot.id !== c.plan.id || snapshot.services.some((s, i) =>
      s.oldLabel !== c.plan.services[i]?.oldLabel || s.newLabel !== c.plan.services[i]?.newLabel)) {
      throw new Error("Journal transaction/labels do not match this service plan");
    }
    c.plan = snapshot;
    validateJournal(j, JSON.stringify(snapshot), c);
  }
  else {
    if (action === "rollback") throw new Error("No service journal to roll back");
    await legacy(c);
    await inventory(c, "new");
    j = { version: 1, planKey: JSON.stringify(c.plan), snapshot: c.plan, direction: "forward", cursor: 0, status: "running" };
    await port(c, () => c.controller.saveJournal(j!));
  }
  if (action === "rollback" && j.direction === "forward") {
    j = { ...j, direction: "rollback", cursor: 0, status: "running" };
    await port(c, () => c.controller.saveJournal(j!));
  }
  if (j.status !== "running") return { status: j.status, plan: c.plan, journal: j };
  const todo = steps(c, j.direction);
  for (let i = j.cursor; i < todo.length; i++) {
    await execute(c, todo[i]!);
    j = { ...j, cursor: i + 1,
      status: i + 1 === todo.length ? (j.direction === "forward" ? "committed" : "rolled-back") : "running" };
    await port(c, () => c.controller.saveJournal(j!));
  }
  return { status: j.status === "committed" ? "committed" : "rolled-back", plan: c.plan, journal: j };
}

/** rename.services defaults off. Observe is a pure plan: even read/lock/audit ports remain untouched. */
export async function runServicePlan(o: Options): Promise<Result> {
  const mode = o.rename?.services;
  if (mode !== "observe" && mode !== "on") return { status: "off", plan: o.plan };
  try {
    // Own the data across awaits; caller mutations cannot alter the identities of an in-flight switch.
    const plan = structuredClone(o.plan);
    validatePlan(plan);
    if (mode === "observe") return { status: "observed", plan };
    if (o.action !== undefined && o.action !== "resume" && o.action !== "rollback") throw new Error("Invalid service action");
    return await o.controller.withLock("floka-services", (lease) => underLock({ plan, controller: o.controller, lease }, o.action));
  } catch (error) {
    // Do not auto-compensate an uncertain effect or failed journal write; reread under lock to resume/rollback.
    return { status: "blocked", plan: o.plan, error: error instanceof Error ? error.message : String(error) };
  }
}
