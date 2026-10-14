import type { Controller, Lease, ServicePlan, Side, State } from "./types.ts";

export interface Context { plan: ServicePlan; controller: Controller; lease: Lease }

/** Check ownership after every await as well as before the next I/O. */
export async function port<T>(c: Context, fn: () => Promise<T>): Promise<T> {
  c.lease.assertHeld();
  const value = await fn();
  c.lease.assertHeld();
  return value;
}
function known(s: State): void {
  if (!s || typeof s.loaded !== "boolean" || !Array.isArray(s.pids) || s.pids.some((p) => !Number.isSafeInteger(p) || p <= 0)) {
    throw new Error("Service registration/PID state is unknown");
  }
}
export function stopped(s: State): boolean {
  known(s);
  return s.loaded === false && s.pids!.length === 0;
}
export async function legacy(c: Context): Promise<void> {
  const facts = await port(c, () => c.controller.auditLegacy(c.plan));
  for (const label of c.plan.legacyLabels) {
    if (!facts[label] || !stopped(facts[label]) || facts[label].restartDisabled !== true) {
      throw new Error(`Legacy service not cleared: ${label}`);
    }
  }
}

/** Re-observe the whole set; old/new KeepAlive registrations are exclusive even with zero PIDs. */
export async function inventory(c: Context, absent?: Side, running?: Side): Promise<void> {
  for (const d of c.plan.services) {
    const old = await port(c, () => c.controller.inspect(c.plan, d, "old"));
    const next = await port(c, () => c.controller.inspect(c.plan, d, "new"));
    known(old); known(next);
    if (old.pids!.length + next.pids!.length > 1 || (old.loaded && next.loaded)) {
      throw new Error(`Multiple instances or KeepAlive registrations: ${d.name}`);
    }
    const states = { old, new: next };
    if (absent && !stopped(states[absent])) throw new Error(`Exit not confirmed: ${absent}:${d.name}`);
    if (running && (states[running].loaded !== true || states[running].pids!.length !== 1)) {
      throw new Error(`Not running: ${running}:${d.name}`);
    }
  }
}
