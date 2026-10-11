/**
 * UIEXEC1 · the web execution context (GET /api/v1/shared-exec/context). The browser's TeamSource only knows center coordinates;
 * this resolves the one local project bound to them and answers what ExecPanel needs: switch, local project, fence, viewer,
 * repository and instance names. Every fact comes from the bridge composition root (bindings, S2S switch, X13 mode record,
 * the caller's own credential) or is cross-checked against it; a center reply can only confirm, never widen, the context.
 * Nothing is cached here: each call re-reads the switch, the binding, the caller's current credential and center view, so
 * revocation is seen at once. The wiring caches connections per Principal; a credential that is gone or names another instance
 * makes the port drop them (`revoke`) before refusing, and every local fact is read again after the center answers.
 */
import type { Principal } from "../lib/principals.js";
import type { SharedLedgerBinding } from "../lib/shared-ledger-gate-bindings.js";
import { requireSharedExecEntry, SharedExecEntryError, type EntrySwitch } from "./shared-ledger-v2-entry.js";

export interface WebExecContextQuery { teamId: string; projectId: string; featureId: string }
/** Exactly the fields of web ExecContext; no credential, token, path or other project's fact. */
export interface WebExecContext {
  mode: Exclude<EntrySwitch, "off">; localProjectId: string;
  scope: { teamId: string; projectId: string; serviceGeneration: number; epoch: number; bootId: string };
  viewer: { role: "owner" | "member"; instanceId: string };
  repository: string; instanceNames: Record<string, string>;
}
/** The minimal shape the context reads from the caller's center view. */
export interface WebContextView {
  teamId: string; projectId: string; serviceGeneration: number;
  feature: { id: string; epoch: number; authorityMode: string };
}
export interface WebContextDeps {
  /** Local binding records (shared-ledger-bindings.json); unreadable = []. */
  bindings(): SharedLedgerBinding[];
  /** The caller's credential for the project as it is on disk now (never cached); null = revoked or never granted. */
  credential(principal: Principal, project: string): { instanceId: string } | null;
  /** Drop cached connections opened with a credential that is no longer current. */
  revoke(principal: Principal, project: string): void;
  /** The caller's own Principal-scoped center connection; null = this Principal holds no credential for the project. */
  open(principal: Principal, project: string): { scope: SharedLedgerBinding; signer: { instanceId: string } } | null;
  role(principal: Principal, scope: SharedLedgerBinding): "owner" | "member";
  /** X13 local record of an execution feature: the center id it is bound to and its current epoch. */
  localFeature(project: string, centerFeatureId: string): { localFeatureId: string; centerFeatureId: string; epoch: number } | null;
  /** Read through the caller's own transport, never a cache shared with another Principal. */
  snapshot(principal: Principal, project: string, localFeatureId: string): Promise<WebContextView>;
  repository(project: string): string | null;
  bootId: string;
}

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const refuse = (status: number, code: string): never => { throw new SharedExecEntryError(status, code); };

/** One binding for these center coordinates; zero or several (ambiguous mapping) = unmapped. */
function localProjectOf(deps: WebContextDeps, q: WebExecContextQuery): string {
  const found = deps.bindings().filter((b) => b.teamId === q.teamId && b.projectId === q.projectId && b.localProjectId);
  return found.length === 1 ? found[0]!.localProjectId! : refuse(503, "v2_unmapped");
}

/** The cached connection must still match the caller's current credential; otherwise drop it and refuse. */
function currentOpen(deps: WebContextDeps, principal: Principal, local: string) {
  const credential = deps.credential(principal, local);
  if (!credential) {
    // Without a credential a fresh open resolves nothing, so a connection here is a stale cached one: drop it.
    if (deps.open(principal, local)) deps.revoke(principal, local);
    return refuse(403, "forbidden");
  }
  let opened = deps.open(principal, local);
  if (opened && opened.signer.instanceId !== credential.instanceId) { deps.revoke(principal, local); opened = deps.open(principal, local); }
  return opened && opened.signer.instanceId === credential.instanceId ? opened : refuse(403, "forbidden");
}
/** The local execution record for the feature, read now. */
function featureOf(deps: WebContextDeps, local: string, featureId: string) {
  const ref = deps.localFeature(local, featureId);
  return ref && ref.centerFeatureId === featureId ? ref : refuse(404, "not_found");
}

export function sharedExecWebContext(deps: WebContextDeps) {
  return async (principal: Principal, q: WebExecContextQuery): Promise<WebExecContext> => {
    if (principal.disabled || principal.peer) refuse(403, "forbidden");
    const local = localProjectOf(deps, q);
    const mode = requireSharedExecEntry(local).mode(local);
    if (mode === "off") return refuse(503, "unavailable");
    const opened = currentOpen(deps, principal, local);
    if (opened.scope.teamId !== q.teamId || opened.scope.projectId !== q.projectId) refuse(503, "v2_unmapped");
    const ref = featureOf(deps, local, q.featureId);
    const repository = deps.repository(local);
    if (!repository || !REPOSITORY.test(repository)) return refuse(503, "v2_unmapped");
    const view = await deps.snapshot(principal, local, ref.localFeatureId);
    // A reply naming another team, project or feature, or an epoch the local record has moved past, is not this context.
    if (view.teamId !== q.teamId || view.projectId !== q.projectId || view.feature.id !== q.featureId
      || view.feature.authorityMode !== "execution" || view.feature.epoch !== ref.epoch
      || !Number.isSafeInteger(view.serviceGeneration) || view.serviceGeneration < 1) refuse(503, "unavailable");
    // Local facts may have moved while the center answered: mapping, credential and fence are read again and must be unchanged.
    if (localProjectOf(deps, q) !== local) refuse(503, "v2_unmapped");
    if (deps.credential(principal, local)?.instanceId !== opened.signer.instanceId) {
      deps.revoke(principal, local);
      refuse(403, "forbidden");
    }
    const now = featureOf(deps, local, q.featureId);
    if (now.localFeatureId !== ref.localFeatureId || now.epoch !== view.feature.epoch) refuse(503, "unavailable");
    // The switch may have moved too; the later reading wins and off still means no context.
    const current = requireSharedExecEntry(local).mode(local);
    if (current === "off") return refuse(503, "unavailable");
    const instanceId = opened.signer.instanceId;
    return {
      mode: current === "on" && mode === "on" ? "on" : "observe", localProjectId: local,
      scope: { teamId: q.teamId, projectId: q.projectId, serviceGeneration: view.serviceGeneration, epoch: now.epoch, bootId: deps.bootId },
      viewer: { role: deps.role(principal, opened.scope), instanceId },
      repository, instanceNames: { [instanceId]: "本机" },
    };
  };
}
