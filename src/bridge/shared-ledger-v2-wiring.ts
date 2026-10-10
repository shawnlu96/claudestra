/**
 * S2F · bridge-process composition root: `initSharedLedgerV2()` (called from ask-entry.ts initAskWiring) injects S2A business
 * asks, S2L lend (both configureLendCentral and configureLendCentralRouting, E1) and S2E entry ports. S2D's `schedulerV2Route`
 * is the only route; the pass port is configured here too (switch only, no manager wrapping) so the route reads S2S in this
 * process. Clients are cached per Principal + project (shared-ledger-v2-wiring.ts): S2A uses the bridge's own Principal
 * (owner:self), S2E the caller's, so the two share a client only for the same Principal. Off = no center request at start-up.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Ask, NewAsk } from "../lib/ledger-asks.js";
import { LedgerReader } from "../lib/ledger-read.js";
import { getTask } from "../lib/ledger-store.js";
import { readLend } from "../lib/lend-config.js";
import { readLendContext } from "../lib/lend-policy.js";
import type { Principal } from "../lib/principals.js";
import { configureSchedulerV2Pass, schedulerV2Route } from "../lib/scheduler-v2-pass.js";
import { fail, parseAuthorizationBind, v2ObjectDigest, type V2AuthorizationBind, type V2Command } from "../lib/shared-ledger-contract-v2.js";
import { OWNER_PRINCIPAL, Stage2Wiring, type ExecFeatureRef, type Stage2Principal, type Stage2WiringOptions } from "../lib/shared-ledger-v2-wiring.js";
import { configureSharedAsks, type SharedAskCommandContext } from "./shared-ledger-v2-asks.js";
import { configureSharedExecEntry } from "./shared-ledger-v2-entry.js";
import { configureLendCentral, configureLendCentralRouting } from "./shared-ledger-v2-lend.js";

type Route = "local" | "skip" | "central";
export interface SharedLedgerV2Options extends Stage2WiringOptions {
  wiring?: Stage2Wiring;
  db?(): Database | null;
  /** Lend outbox / journal directory (default <state>/shared-ledger-v2-lend). */
  outboxDir?: string;
}
export interface SharedLedgerV2Bridge { wiring: Stage2Wiring; route(taskId: string): Route; stop(): void }

/** Local ask bind action → V2 authorization action; anything else cannot be authorized through the center. */
const BIND_ACTIONS: Record<string, V2AuthorizationBind["actions"][number]> = {
  merge: "merge", deploy: "deploy", release: "release", "workflow.auto": "workflow.auto", "task.cancel": "task.cancel",
  "scope.change": "scope.change", "home.change": "home.change", "artifact.share": "artifact.share",
};
const principalOf = (p: Principal): Stage2Principal => ({ subject: p.id, kind: "person" });

let active: SharedLedgerV2Bridge | null = null;
export function sharedLedgerV2Bridge(): SharedLedgerV2Bridge | null { return active; }

export function initSharedLedgerV2(opts: SharedLedgerV2Options = {}): SharedLedgerV2Bridge {
  if (active) return active;
  const wiring = opts.wiring ?? new Stage2Wiring(opts);
  const reader = opts.db ? null : new LedgerReader();
  const db = (): Database | null => opts.db ? opts.db() : reader!.get();
  const bootId = `bridge-${randomUUID()}`;
  const route = (taskId: string): Route => schedulerV2Route(taskId, db());
  const observe = (entry: Record<string, unknown>) => wiring.observe({ node: "bridge", ...entry });
  const stop = () => {
    configureSharedAsks(null); configureLendCentral(null); configureLendCentralRouting(null); configureSharedExecEntry(null);
    configureSchedulerV2Pass(null);
    reader?.close();
    active = null;
  };
  if (!wiring.wired()) {
    // No local credential: every port is null (execution entries answer unavailable). A credential added later needs a restart.
    stop();
    active = { wiring, route, stop };
    return active;
  }
  configureSchedulerV2Pass({ mode: (p) => wiring.mode(p), wrapManager: (m) => m });

  /** Local feature for a center feature id (or a local id passed as is). */
  const localFeature = (project: string, featureId: string): ExecFeatureRef | null => {
    const direct = wiring.featureRef(featureId, project);
    if (direct) return direct;
    const d = db();
    const rows = d ? d.query("SELECT id FROM features WHERE project = ?").all(project) as { id: string }[] : [];
    for (const row of rows) {
      const ref = wiring.featureRef(row.id, project);
      if (ref?.centerFeatureId === featureId) return ref;
    }
    return null;
  };
  const featureRoute = (featureId: string, project?: string): "local" | "central" | { route: "skip"; reason: "migrating" | "unavailable" } => {
    const mode = wiring.readMode(featureId);
    if (!mode) return { route: "skip", reason: "unavailable" };
    if (mode.migrating) return { route: "skip", reason: "migrating" };
    if (mode.authorityMode !== "execution") return "local";
    const p = project ?? (db()?.query("SELECT project FROM features WHERE id = ?").get(featureId) as { project: string } | null)?.project;
    return p && wiring.mode(p) === "on" ? "central" : { route: "skip", reason: "unavailable" };
  };
  /** Command context from the cached center view; a miss primes the view and holds this call (unavailable). */
  const commandContext = (project: string, feature: ExecFeatureRef, localTaskId: string): SharedAskCommandContext | null => {
    const view = wiring.cachedView(feature.centerFeatureId);
    if (!view) {
      void wiring.snapshot(project, feature.localFeatureId).catch((e: Error) => console.warn(`[stage2 bridge] snapshot failed: ${e.message}`));
      return null;
    }
    return { teamId: view.teamId, projectId: view.projectId, serviceGeneration: view.serviceGeneration, epoch: view.feature.epoch,
      bootId, taskId: localTaskId };
  };
  const authorizationBind = (ask: NewAsk, feature: ExecFeatureRef, context: SharedAskCommandContext): V2AuthorizationBind | null => {
    const view = wiring.cachedView(feature.centerFeatureId), local = ask.bind;
    const action = local ? BIND_ACTIONS[local.action] : undefined;
    const task = view?.tasks.find((t) => t.id === context.taskId), workflow = view?.workflows.find((w) => w.taskId === context.taskId);
    if (!view || !local || !action || !task || !/^[0-9a-f]{64}$/.test(local.paramsHash)) return null;
    const content = v2ObjectDigest(local.params ?? null);
    try {
      return parseAuthorizationBind({ taskId: task.id, featureId: feature.centerFeatureId, taskRev: task.rev, specRev: task.specRev,
        workflowRev: workflow?.rev ?? null, baseVersion: view.feature.currentVersion, proposalDigest: null, head: task.head,
        originalDigest: content, sharedDigest: content, actionDigest: local.paramsHash, redactionVersion: 1, actions: [action],
        homeInstanceId: view.feature.homeInstanceId, expiresAt: ask.expiresAt ?? Date.now() + 24 * 3600_000 });
    } catch { return null; }
  };

  configureSharedAsks({
    mode: (p) => wiring.mode(p),
    clientFor: (p) => wiring.clientFor(OWNER_PRINCIPAL, p),
    featureOfTask: (taskId) => wiring.featureOfTask(db(), taskId),
    route,
    commandContext: (p, feature, _principal, localTaskId) => commandContext(p, feature, localTaskId),
    authorizationBind,
  });

  configureLendCentral({
    mode: (p) => wiring.mode(p),
    // X9 resolves a requestId through the journaled command; the outbox is S2L's, so no lookup is available here yet.
    transportFor: (p) => wiring.transportFor(p)?.lend(() => null) ?? null,
    grant: { readLend: () => readLend(), context: readLendContext, now: Date.now },
    outboxDir: opts.outboxDir ?? join(wiring.dir, "shared-ledger-v2-lend"),
  });
  configureLendCentralRouting({
    route,
    // No trusted fresh binding source exists yet (lend.create is not wired): only journal-pinned orders reach the center.
    bindingFor: () => null,
    sharedResult: () => fail("unavailable"),
    skipReason: (taskId) => {
      const task = db() && getTask(db()!, taskId), featureId = task?.featureId ?? task?.extra.sharedFeatureId;
      return typeof featureId === "string" && wiring.readMode(featureId)?.migrating ? "migrating" : "unavailable";
    },
    observe: (d) => observe({ node: "lend", ...d }),
  });

  const entryProject = (projectId: string): string | null => {
    const d = db();
    const projects = d ? (d.query("SELECT DISTINCT project FROM tasks").all() as { project: string }[]).map((r) => r.project) : [];
    return projects.find((p) => wiring.scope(p)?.projectId === projectId) ?? null;
  };
  configureSharedExecEntry({
    mode: (p) => wiring.mode(p),
    clientFor: (principal, p) => wiring.clientFor(principalOf(principal), p),
    snapshot: async (principal, p, featureId) => {
      const ref = localFeature(p, featureId);
      if (!ref) return fail("not_found");
      return wiring.snapshot(p, ref.localFeatureId, principalOf(principal));
    },
    receipt: async (principal, query) => {
      const p = entryProject(query.projectId), transport = p ? wiring.transportFor(p, principalOf(principal)) : null;
      if (!transport) return fail("unavailable");
      return transport.receipt({ requestId: query.requestId, operationId: query.operationId, commandDigest: query.commandDigest });
    },
    scopeFor: (_principal, p) => {
      const s = wiring.scope(p);
      return s ? { teamId: s.teamId, projectId: s.projectId } : null;
    },
    route,
    featureRoute: (featureId) => { const r = featureRoute(featureId); return typeof r === "string" ? r : "skip"; },
    commandRoute: (_principal, project, command: V2Command) => {
      const payload = command.payload as Record<string, unknown>;
      if (typeof payload.taskId === "string" && db() && getTask(db()!, payload.taskId)) {
        const r = route(payload.taskId);
        return r === "skip" ? { route: "skip", reason: skipReason(payload.taskId) } : r;
      }
      if (typeof payload.featureId === "string") {
        const ref = localFeature(project, payload.featureId);
        const r = ref ? featureRoute(ref.localFeatureId, project) : null;
        return r ?? { route: "skip", reason: "v2_unmapped" };
      }
      return { route: "skip", reason: "v2_unmapped" };
    },
    holdReason: (id) => {
      const featureId = featureOfTaskId(id) ?? id, mode = wiring.readMode(featureId);
      return mode?.migrating ? "migrating" : null;
    },
  });
  const featureOfTaskId = (taskId: string): string | null => {
    const task = db() && getTask(db()!, taskId), f = task?.featureId ?? task?.extra.sharedFeatureId;
    return typeof f === "string" ? f : null;
  };
  const skipReason = (taskId: string): "migrating" | "unavailable" => {
    const f = featureOfTaskId(taskId);
    return f && wiring.readMode(f)?.migrating ? "migrating" : "unavailable";
  };

  active = { wiring, route, stop };
  return active;
}

export type { Ask };
