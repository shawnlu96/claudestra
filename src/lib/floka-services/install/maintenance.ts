import { isAbsolute } from "node:path";
import { consumeGrant } from "../../state-maintenance/grant.js";
import type { Grant } from "../../state-maintenance/grant.js";
import { object, renameMode } from "../../floka-config/values.js";
import { runServicePlan } from "../plan/index.js";
import { validatePlan } from "../plan/definition.js";
import { inventory } from "../plan/safety.js";
import type { Controller, Result, ServicePlan } from "../plan/types.js";
import { captureCli, installCli, restoreCli, serviceWrapperScript } from "./cli.js";
import { digest, durableJson, readStored, ServiceStore, type Snapshot } from "./store.js";

export interface MaintenanceOptions {
  config: unknown;
  root: string;
  plan: ServicePlan;
  input: Snapshot["input"];
  cliPaths: string[];
  controller: Controller;
  grant?: string;
  action?: "resume" | "rollback" | "retire";
  callerSafe(): Promise<boolean>;
  provePaths(): Promise<boolean | string>;
  roleRefusal(actor: string): string | null;
  /** Runner only: the request was atomically claimed after the parent consumed STATE2's grant. */
  authorization?: Grant;
  wrapperContext?: Snapshot["wrapperContext"];
}

export function servicesBinding(plan: ServicePlan, action = "resume"): Record<string, string> {
  return { txId: plan.id, action, labels: digest(plan.services.map(s => [s.oldLabel, s.newLabel])) };
}

/** The controller owns the same lock as install/update. Recovery inputs live beside the journal. */
export async function serviceMaintenance(o: MaintenanceOptions): Promise<Result | { status: "retired"; plan: ServicePlan }> {
  const mode = renameMode(object(object(o.config).rename).services);
  const cli = renameMode(object(object(o.config).rename).cli);
  if (mode === "observe" || cli === "observe") return runServicePlan({ plan: o.plan, controller: o.controller, rename: { services: "observe" } });
  if (mode === "off" && cli === "off" && (!o.action || o.action === "resume")) return { status: "off", plan: o.plan };
  if (mode === "on" && cli !== "on" && (!o.action || o.action === "resume")) return { status: "blocked", plan: o.plan, error: "先把 cli 切到 on" };
  try {
    validatePlan(o.plan);
    if (!o.grant && !o.authorization) throw new Error("Service maintenance requires a single use grant");
    const auth = o.authorization ? { ok: true as const, grant: o.authorization }
      : consumeGrant(o.root, o.grant!, "services", servicesBinding(o.plan, o.action));
    if (!auth.ok) throw new Error(auth.error);
    if (auth.grant.action !== "services" || Date.now() > auth.grant.expiresAt || Object.entries(servicesBinding(o.plan, o.action))
      .some(([k, v]) => auth.grant.binding[k] !== v)) throw new Error("Invalid runner authorization binding");
    const no = o.roleRefusal(auth.grant.actor);
    if (no) throw new Error(no);
    if (!await o.callerSafe()) throw new Error("Maintenance caller belongs to a daemon being switched");
    const proof = await o.provePaths();
    if (!proof) throw new Error("State identity/runtime path equality is not proven");
    if (o.cliPaths.some(p => !isAbsolute(p)) || new Set(o.cliPaths).size !== o.cliPaths.length) throw new Error("Invalid CLI installation paths");
    return await o.controller.withLock("floka-services", async lease => {
      const store = new ServiceStore(o.root);
      let saved = store.active();
      if (saved && saved.plan.id !== o.plan.id) throw new Error("Retire the previous terminal transaction before starting another");
      if (o.action === "retire") {
        if (!saved) throw new Error("No transaction to retire");
        const j = store.journal();
        if (!j || j.status === "running") throw new Error("Cannot retire a running service transaction");
        if (!saved.cliOnly) await inventory({ plan: saved.plan, controller: o.controller, lease },
          j.status === "committed" ? "old" : "new", j.status === "committed" ? "new" : "old");
        store.retire();
        return { status: "retired" as const, plan: saved.plan };
      }
      if (!saved) {
        if (o.action === "rollback") throw new Error("No service snapshot to roll back");
        if (readStored(`${o.root}/retired-${o.plan.id}/active.json`)) throw new Error("Retired service transaction id cannot be reused");
        saved = { version: 1, plan: structuredClone(o.plan), input: structuredClone(o.input),
          cli: cli === "on", before: o.cliPaths.map(captureCli), cliOnly: mode === "off", wrapperContext: o.wrapperContext,
          ...(typeof proof === "string" ? { proof } : {}) };
        store.prepare(saved);
      }
      const snapshot = saved;
      if (snapshot.proof && proof !== snapshot.proof) throw new Error("Identity/runtime proof differs from the approved snapshot");
      if (snapshot.cliOnly) {
        const previous = store.journal();
        if (previous?.status === "rolled-back" || previous?.status === "committed" && o.action !== "rollback") {
          return { status: previous.status, plan: snapshot.plan };
        }
        if (o.action === "rollback") for (const before of snapshot.before) restoreCli(before);
        else installCli(snapshot.before.map(b => b.path), serviceWrapperScript(snapshot.input.repoRoot, snapshot.input.bunPath,
          snapshot.plan.services.map(s => s.oldLabel), snapshot.wrapperContext));
        store.save({ version: 1, planKey: JSON.stringify(snapshot.plan), snapshot: snapshot.plan,
          direction: o.action === "rollback" ? "rollback" : "forward", cursor: 0,
          status: o.action === "rollback" ? "rolled-back" : "committed" });
        return { status: o.action === "rollback" ? "rolled-back" as const : "committed" as const, plan: snapshot.plan };
      }
      const controller: Controller = {
        withLock: async (_key, run) => run(lease), readJournal: async () => store.journal(), saveJournal: async j => store.save(j),
        auditLegacy: p => o.controller.auditLegacy(p), inspect: (p, s, side) => o.controller.inspect(p, s, side),
        prepare: async (p, s) => {
          await o.controller.prepare(p, s);
          if (snapshot.cli) installCli(snapshot.before.map(b => b.path), serviceWrapperScript(snapshot.input.repoRoot,
            snapshot.input.bunPath, p.services.map(s => s.newLabel), snapshot.wrapperContext));
        },
        unload: (p, s, side) => o.controller.unload(p, s, side),
        waitExited: (p, s, side) => o.controller.waitExited(p, s, side), restoreOld: (p, s) => o.controller.restoreOld(p, s),
        load: (p, s, side) => o.controller.load(p, s, side), health: (p, s, side) => o.controller.health(p, s, side),
        commit: async (p, side) => {
          if (snapshot.cli) {
            if (side === "old") for (const before of snapshot.before) restoreCli(before);
            else installCli(snapshot.before.map(b => b.path), serviceWrapperScript(snapshot.input.repoRoot,
              snapshot.input.bunPath, p.services.map(s => s.newLabel), snapshot.wrapperContext));
          }
          await o.controller.commit(p, side);
          durableJson(`${o.root}/services-current.json`, { side });
        },
      };
      return runServicePlan({ plan: snapshot.plan, controller, rename: { services: "on" }, action: o.action });
    });
  } catch (e) {
    return { status: "blocked", plan: o.plan, error: e instanceof Error ? e.message : String(e) };
  }
}
