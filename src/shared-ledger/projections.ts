import { SharedLedgerError, type SharedLedgerProjection, type SharedLedgerProjectionResult, type SharedLedgerTaskProjection } from "../lib/shared-ledger-contract.js";
import type { SharedLedgerPrincipal } from "../lib/shared-ledger-auth.js";
import { sharedLedgerProjectionDigest } from "../lib/shared-ledger-contract-transfer.js";
import { conflict, feature } from "./reads.js";
import { saveFeature } from "./commands.js";
import { refreshFeatureState } from "./feature-state.js";
import { actorCode } from "./identity.js";
import { Store, encode, decode, newId, rejectSensitive } from "./store.js";

function taskMapping(store: Store, team: string, project: string, source: string, sourceId: string, create = false): string {
  const row = store.get<{ id: string; teamId: string; projectId: string }>(
    "SELECT id,teamId,projectId FROM id_map WHERE kind='task' AND sourceInstanceId=? AND sourceId=?", source, sourceId);
  if (row) {
    if (row.teamId !== team || row.projectId !== project) throw new SharedLedgerError("forbidden");
    return row.id;
  }
  if (!create) throw new SharedLedgerError("invalid_field", "Missing source task reference");
  const id = newId();
  store.run("INSERT INTO id_map VALUES ('task',?,?,?,?,?)", source, sourceId, team, project, id);
  return id;
}
function writeTask(store: Store, p: SharedLedgerPrincipal, projection: SharedLedgerProjection, task: SharedLedgerTaskProjection): void {
  const id = taskMapping(store, p.teamId, projection.projectId, projection.sourceInstanceId, task.sourceTaskId);
  const old = store.get<{ featureId: string; data: string }>("SELECT featureId,data FROM task_mirrors WHERE taskId=?", id);
  if (old && old.featureId !== projection.featureId) throw new SharedLedgerError("invalid_field");
  const before = old ? decode<SharedLedgerTaskProjection>(old.data) : null;
  if (before && (task.sourceRev < before.sourceRev || task.sourceSeq < before.sourceSeq)) conflict(store, p, projection.featureId);
  for (const step of task.steps) {
    const prior = store.get<{ data: string }>("SELECT data FROM step_mirrors WHERE taskId=? AND sourceStepId=?", id, step.sourceStepId);
    const prev = prior ? decode<typeof step>(prior.data) : null;
    if (prev && (step.sourceRev < prev.sourceRev || step.sourceSeq < prev.sourceSeq)) conflict(store, p, projection.featureId);
  }
  for (const dep of task.deps) taskMapping(store, p.teamId, projection.projectId, projection.sourceInstanceId, dep);
  const steps = new Map(before?.steps.map((s) => [s.sourceStepId, s]));
  for (const s of task.steps) steps.set(s.sourceStepId, s);
  const merged = { ...task, steps: [...steps.values()] };
  store.run(`INSERT INTO task_mirrors VALUES (?,?,?,?,?) ON CONFLICT(taskId) DO UPDATE SET data=excluded.data`,
    id, projection.featureId, projection.sourceInstanceId, task.sourceTaskId, encode(merged));
  for (const step of task.steps) {
    store.run("INSERT INTO step_mirrors VALUES (?,?,?) ON CONFLICT(taskId,sourceStepId) DO UPDATE SET data=excluded.data", id, step.sourceStepId, encode(step));
  }
}
export function applyProjection(store: Store, p: SharedLedgerPrincipal, projection: SharedLedgerProjection, now: number): SharedLedgerProjectionResult {
  rejectSensitive(projection);
  const f = feature(store, p.teamId, projection.featureId);
  if (!f || f.projectId !== projection.projectId || f.homeInstanceId !== p.instanceId) throw new SharedLedgerError("forbidden");
  const digest = sharedLedgerProjectionDigest(projection);
  const water = store.get<{ sourceSeq: number; digest: string; response: string }>("SELECT * FROM projection_watermarks WHERE featureId=?", f.id);
  if (water && projection.sourceSeq === water.sourceSeq) {
    if (water.digest !== digest) conflict(store, p, f.id);
    return decode(water.response);
  }
  if ((water && projection.sourceSeq < water.sourceSeq)
    || (projection.mode === "delta" && projection.previousSourceSeq !== (water?.sourceSeq ?? 0))) conflict(store, p, f.id);
  for (const task of projection.tasks) taskMapping(store, p.teamId, f.projectId, p.instanceId, task.sourceTaskId, true);
  for (const task of projection.tasks) writeTask(store, p, projection, task);
  for (const event of projection.events) {
    taskMapping(store, p.teamId, f.projectId, p.instanceId, event.sourceTaskId);
    const old = store.get<{ featureId: string; data: string }>(
      "SELECT featureId,data FROM source_event_mirrors WHERE sourceInstanceId=? AND sourceSeq=?", p.instanceId, event.sourceSeq);
    if (old && (old.featureId !== f.id || old.data !== encode(event))) conflict(store, p, f.id);
    if (!old) store.run("INSERT INTO source_event_mirrors VALUES (?,?,?,?)", p.instanceId, event.sourceSeq, f.id, encode(event));
  }
  f.projection = { sourceInstanceId: p.instanceId, sourceSeq: projection.sourceSeq, observedAt: projection.observedAt, receivedAt: now };
  refreshFeatureState(store, f);
  saveFeature(store, p.teamId, f);
  const response: SharedLedgerProjectionResult = { schemaVersion: 1,
    serverSeq: store.event(p.teamId, f.projectId, f.id, "projection", actorCode(store, p), now),
    sourceInstanceId: p.instanceId, sourceSeq: projection.sourceSeq, digest };
  store.run(`INSERT INTO projection_watermarks VALUES (?,?,?,?) ON CONFLICT(featureId)
    DO UPDATE SET sourceSeq=excluded.sourceSeq,digest=excluded.digest,response=excluded.response`, f.id, projection.sourceSeq, digest, encode(response));
  return response;
}
