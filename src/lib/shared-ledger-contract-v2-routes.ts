/** Frozen stage-2 V2 HTTP routes (S2K). Additive only: existing exports and V2_COMMAND_NAMES are untouched.
 * Every path is rooted at /v2/teams/{teamId}/projects/{projectId}/; path ids never contain "/" or "..".
 * Parsers cover success bodies only; error bodies use parseError. Scope mismatches between path and body are invalid_field.
 */
import {
  array, bounded, choice, digest, distinct, fail, id, integer, literal, nullable, object, positive,
  refine, scope, timestamp, whole, type Schema,
} from "./shared-ledger-contract-v2-validation.js";
import { parseAsk } from "./shared-ledger-contract-v2-asks.js";
import { parseCommand, parseReceipt } from "./shared-ledger-contract-v2-commands.js";
import { parseDag, parseFeature } from "./shared-ledger-contract-v2-dag.js";
import { parseLendLease, parseLendOrder } from "./shared-ledger-contract-v2-lend.js";
import { parseIntent, parseResource, resourceKey } from "./shared-ledger-contract-v2-scheduling.js";
import { parseDependency, parseStep, parseTask, parseWorkflow } from "./shared-ledger-contract-v2-tasks.js";
import { parseCapabilities, parseMigration, parseMigrationResult, parseReceiptLookup } from "./shared-ledger-contract-v2-transfer.js";

type Scoped = { teamId: string; projectId: string };
const sameScope = (a: Scoped, b: Scoped) => a.teamId === b.teamId && a.projectId === b.projectId;
function scoped<T extends Scoped>(value: T, params: Scoped): T { return sameScope(value, params) ? value : fail(); }

const V2_ROUTE_PREFIX = "/v2/teams";
/** A path segment is a contract id that additionally can never traverse or split the path. */
export const parsePathId: Schema<string> = v => typeof v === "string" && !v.includes("/") && !v.includes("..") ? id(v) : fail();
export function v2ProjectRoot(teamId: string, projectId: string): string {
  return `${V2_ROUTE_PREFIX}/${parsePathId(teamId)}/projects/${parsePathId(projectId)}`;
}

/** One feature's central execution state, as served by GET features/{featureId} and returned by a revert. */
export const parseFeatureView = bounded(refine(object({
  ...scope, serverSeq: integer, serviceGeneration: positive, feature: parseFeature, dag: nullable(parseDag),
  tasks: array(parseTask), dependencies: array(parseDependency), steps: array(parseStep), workflows: array(parseWorkflow),
  intents: array(parseIntent), resources: array(parseResource), pendingAsks: array(parseAsk), capabilities: parseCapabilities,
}), v => {
  const inScope = (x: Scoped) => sameScope(x, v), tasks = new Set(v.tasks.map(t => t.id));
  const intents = new Map(v.intents.map(i => [i.id, i]));
  return inScope(v.feature)
    && v.tasks.every(t => inScope(t) && t.featureId === v.feature.id && t.homeInstanceId === v.feature.homeInstanceId)
    && (v.feature.currentVersion === 0 ? v.dag === null
      : v.dag !== null && v.dag.version === v.feature.currentVersion && v.dag.bindings.every(b => tasks.has(b.taskId)))
    && v.dependencies.every(d => inScope(d) && tasks.has(d.fromTask) && tasks.has(d.toTask))
    && v.steps.every(s => inScope(s) && tasks.has(s.taskId))
    && v.workflows.every(w => inScope(w) && tasks.has(w.taskId))
    && v.intents.every(i => inScope(i) && tasks.has(i.taskId) && i.serviceGeneration <= v.serviceGeneration)
    && v.resources.every(r => inScope(r.key) && tasks.has(r.taskId) && intents.get(r.intentId)?.taskId === r.taskId
      && intents.get(r.intentId)?.operationId === r.operationId)
    && v.pendingAsks.every(a => inScope(a) && a.featureId === v.feature.id && a.state === "open" && (a.taskId === null || tasks.has(a.taskId)))
    && distinct(v.tasks, t => t.id) && distinct(v.workflows, w => w.taskId) && distinct(v.intents, i => i.id)
    && distinct(v.pendingAsks, a => a.id) && distinct(v.resources, r => resourceKey(r.key))
    && distinct(v.dependencies, d => JSON.stringify([d.fromTask, d.toTask]))
    && distinct(v.steps, s => JSON.stringify([s.taskId, s.step, s.round]));
}), 16_777_216);

/** Mirrors the lend central view {order, lease, task, now}; the lease, if any, belongs to the order's current generation. */
export const parseLendView = refine(object({
  order: parseLendOrder, lease: nullable(parseLendLease), task: parseTask, now: timestamp,
}), v => v.order.taskId === v.task.id && sameScope(v.order, v.task) && (v.lease === null
  || (v.lease.orderId === v.order.orderId && v.lease.taskId === v.order.taskId && sameScope(v.lease, v.order)
    && v.lease.leaseGen === v.order.leaseGen)));

/** Owner-authorized return of an execution group to stage one; the center re-checks every evidence claim. */
export const parseRevertRequest = refine(object({
  ...scope, batchId: id, featureIds: array(id), expectedEpoch: positive, authorizationAskId: id,
  evidence: object({ dispatchPaused: literal(true), leasesReleased: literal(true), lendSettled: literal(true), unknownReconciled: literal(true) }),
}), r => r.featureIds.length > 0 && distinct(r.featureIds));
const liveIntent = ["pending", "submitted", "unknown"];
/** views[i] is the final planning-mode view of featureIds[i]: no held resources, no live or unknown intents. */
export const parseRevertResult = bounded(refine(object({
  ...scope, schemaVersion: literal(2), batchId: id, featureIds: array(id), nextEpoch: whole(2),
  serviceGeneration: positive, serverSeq: positive, committedAt: timestamp, views: array(parseFeatureView),
}), r => r.featureIds.length > 0 && distinct(r.featureIds) && r.views.length === r.featureIds.length
  && r.views.every((v, i) => sameScope(v, r) && v.feature.id === r.featureIds[i] && v.feature.authorityMode === "planning"
    && v.feature.epoch === r.nextEpoch && v.serverSeq <= r.serverSeq && v.serviceGeneration === r.serviceGeneration
    && v.resources.length === 0 && v.intents.every(i => !liveIntent.includes(i.status)))), 16_777_216);

/** A lost response is resolved only by these lookups; unknown never implies failure. */
const lookupFields = { ...scope, batchId: id, status: choice(["committed", "unknown"]) };
type Lookup = Scoped & { batchId: string; status: "committed" | "unknown"; result: (Scoped & { batchId: string }) | null };
const validLookup = (l: Lookup) => l.status === "unknown" ? l.result === null
  : l.result !== null && l.result.batchId === l.batchId && sameScope(l.result, l);
export const parseMigrationLookup = refine(object({ ...lookupFields, result: nullable(parseMigrationResult) }), validLookup);
export const parseRevertLookup = refine(object({ ...lookupFields, result: nullable(parseRevertResult) }), validLookup);

export interface V2Route<P, Req, Res> {
  readonly method: "GET" | "POST";
  readonly parseParams: Schema<P>;
  /** Re-validates params; throws invalid_field for any id containing "/" or "..". */
  path(params: P): string;
  /** GET routes accept only an absent body; POST bodies must match the path scope. */
  parseRequest(value: unknown, params: P): Req;
  parseResponse(value: unknown, params: P): Res;
}
function route<P, Req, Res>(def: {
  method: "GET" | "POST"; params: Schema<P>; path: (p: NoInfer<P>) => string;
  request: (v: unknown, p: NoInfer<P>) => Req; response: (v: unknown, p: NoInfer<P>) => Res;
}): V2Route<P, Req, Res> {
  return Object.freeze({
    method: def.method, parseParams: def.params,
    path: (p: P) => def.path(def.params(p)),
    parseRequest: (v: unknown, p: P) => def.request(v, def.params(p)),
    parseResponse: (v: unknown, p: P) => def.response(v, def.params(p)),
  });
}
const noBody = (v: unknown): undefined => v === undefined ? undefined : fail();
const project = { teamId: parsePathId, projectId: parsePathId };
const root = (p: Scoped) => v2ProjectRoot(p.teamId, p.projectId);
const parseProjectParams = object(project);
const parseBatchParams = object({ ...project, batchId: parsePathId });
const parseAskParams = object({ ...project, askId: parsePathId });
const parseFeatureParams = object({ ...project, featureId: parsePathId });
const parseOrderParams = object({ ...project, orderId: parsePathId });
const parseReceiptParams = object({ ...project, requestId: parsePathId, operationId: nullable(parsePathId), commandDigest: digest });

export const V2_ROUTES = Object.freeze({
  commands: route({
    method: "POST", params: parseProjectParams, path: p => `${root(p)}/commands`,
    request: (v, p) => scoped(parseCommand(v), p), response: (v, p) => scoped(parseReceipt(v), p),
  }),
  receipts: route({
    method: "GET", params: parseReceiptParams,
    path: p => `${root(p)}/receipts/${p.requestId}?${new URLSearchParams(
      p.operationId === null ? { commandDigest: p.commandDigest } : { operationId: p.operationId, commandDigest: p.commandDigest })}`,
    request: noBody,
    response: (v, p) => {
      const r = scoped(parseReceiptLookup(v), p);
      return r.requestId === p.requestId && (r.receipt === null || r.receipt.commandDigest === p.commandDigest) ? r : fail();
    },
  }),
  asks: route({
    method: "GET", params: parseAskParams, path: p => `${root(p)}/asks/${p.askId}`,
    request: noBody, response: (v, p) => { const a = scoped(parseAsk(v), p); return a.id === p.askId ? a : fail(); },
  }),
  features: route({
    method: "GET", params: parseFeatureParams, path: p => `${root(p)}/features/${p.featureId}`,
    request: noBody, response: (v, p) => { const f = scoped(parseFeatureView(v), p); return f.feature.id === p.featureId ? f : fail(); },
  }),
  lend: route({
    method: "GET", params: parseOrderParams, path: p => `${root(p)}/lend/${p.orderId}`,
    request: noBody,
    response: (v, p) => { const l = parseLendView(v); scoped(l.order, p); return l.order.orderId === p.orderId ? l : fail(); },
  }),
  migrations: route({
    method: "POST", params: parseProjectParams, path: p => `${root(p)}/migrations`,
    request: (v, p) => { const m = parseMigration(v); scoped(m.manifest, p); return m; },
    response: (v, p) => scoped(parseMigrationResult(v), p),
  }),
  migration: route({
    method: "GET", params: parseBatchParams, path: p => `${root(p)}/migrations/${p.batchId}`,
    request: noBody, response: (v, p) => { const l = scoped(parseMigrationLookup(v), p); return l.batchId === p.batchId ? l : fail(); },
  }),
  reverts: route({
    method: "POST", params: parseProjectParams, path: p => `${root(p)}/reverts`,
    request: (v, p) => scoped(parseRevertRequest(v), p), response: (v, p) => scoped(parseRevertResult(v), p),
  }),
  revert: route({
    method: "GET", params: parseBatchParams, path: p => `${root(p)}/reverts/${p.batchId}`,
    request: noBody, response: (v, p) => { const l = scoped(parseRevertLookup(v), p); return l.batchId === p.batchId ? l : fail(); },
  }),
});
export type V2RouteName = keyof typeof V2_ROUTES;
export const V2_ROUTE_NAMES = Object.freeze(Object.keys(V2_ROUTES) as V2RouteName[]);

const TAILS: Record<V2RouteName, readonly string[]> = {
  commands: ["commands"], receipts: ["receipts", "requestId"], asks: ["asks", "askId"], features: ["features", "featureId"],
  lend: ["lend", "orderId"], migrations: ["migrations"], migration: ["migrations", "batchId"], reverts: ["reverts"], revert: ["reverts", "batchId"],
};
/** Inverse of path(): resolves a method + path (with query) to a route and validated params, or null. */
export function matchV2Route(method: string, url: string): { name: V2RouteName; params: Record<string, unknown> } | null {
  const [path, query = ""] = url.split("?", 2);
  const parts = path.split("/");
  if (parts.length < 7 || parts[0] !== "" || parts[1] !== "v2" || parts[2] !== "teams" || parts[4] !== "projects") return null;
  const tail = parts.slice(6);
  for (const name of V2_ROUTE_NAMES) {
    const shape = TAILS[name], r = V2_ROUTES[name];
    if (r.method !== method || shape.length !== tail.length || shape[0] !== tail[0]) continue;
    if ((name === "receipts") !== (query !== "")) continue;
    const params: Record<string, unknown> = { teamId: parts[3], projectId: parts[5] };
    if (shape[1]) params[shape[1]] = tail[1];
    if (name === "receipts") {
      const q = new URLSearchParams(query);
      if ([...q.keys()].some(k => k !== "operationId" && k !== "commandDigest") || q.getAll("operationId").length > 1) return null;
      params.operationId = q.get("operationId"); params.commandDigest = q.get("commandDigest");
    }
    try { r.parseParams(params); } catch { return null; }
    return r.path(params as never) === url ? { name, params } : null;
  }
  return null;
}
