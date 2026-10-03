import {
  SharedLedgerError, type SharedLedgerImport, type SharedLedgerImportResult, type SharedLedgerFeature,
  type SharedLedgerImportManifest, type SharedLedgerImportControl, type SharedLedgerImportReceipt, type SharedLedgerImportVerification,
  type SharedLedgerTaskProjection,
} from "../lib/shared-ledger-contract.js";
import { sharedLedgerManifestDigest } from "../lib/shared-ledger-contract-transfer.js";
import type { SharedLedgerPrincipal } from "../lib/shared-ledger-auth.js";
import { assertImportedDagStep } from "./import-history.js";
import { actorCode, projectionHome } from "./identity.js";
import { conflict, feature, meta } from "./reads.js";
import { insertFeature, saveDag, saveFeature } from "./commands.js";
import { applyProjection } from "./projections.js";
import { Store, decode, encode, newId, rejectSensitive } from "./store.js";

export function importManifest(store: Store, p: SharedLedgerPrincipal, input: SharedLedgerImport, now: number): SharedLedgerImportResult {
  rejectSensitive(input);
  const m = input.manifest;
  if (!projectionHome(store, p.teamId, m.sourceInstanceId, m.projectId, now)) {
    throw new SharedLedgerError("forbidden", "主场没有可投影的服务身份");
  }
  const previous = store.get<{ digest: string; projectId: string; response: string }>(
    "SELECT digest,projectId,response FROM import_batches WHERE teamId=? AND sourceInstanceId=? AND batchId=?", p.teamId, p.instanceId, input.batchId);
  if (previous) {
    if (previous.projectId !== m.projectId) throw new SharedLedgerError("forbidden");
    if (previous.digest !== input.manifestDigest) throw new SharedLedgerError("replayed");
    if (lifecycle(store, p, input.batchId)?.status === "revoked") throw new SharedLedgerError("replayed", "Import was revoked");
    return { ...decode<SharedLedgerImportResult>(previous.response), mode: input.mode };
  }
  const mappings: SharedLedgerImportResult["mappings"] = [];
  for (const f of m.features) {
    const duplicate = store.get<{ id: string }>("SELECT id FROM features WHERE teamId=? AND projectId=? AND title=?", p.teamId, m.projectId, f.title);
    if (duplicate) conflict(store, p, duplicate.id);
    mappings.push({ kind: "feature", sourceInstanceId: p.instanceId, sourceId: f.sourceFeatureId, id: newId() });
    for (const t of f.projection.tasks) mappings.push({ kind: "task", sourceInstanceId: p.instanceId, sourceId: t.sourceTaskId, id: newId() });
  }
  for (const mapping of mappings) {
    if (store.get("SELECT id FROM id_map WHERE kind=? AND sourceInstanceId=? AND sourceId=?", mapping.kind, p.instanceId, mapping.sourceId)) {
      throw new SharedLedgerError("replayed", "Source identity already mapped");
    }
  }
  // Dry runs execute the exact commit path under a savepoint, then discard every business row and sequence.
  store.run("SAVEPOINT import_preview");
  for (const map of mappings) store.run("INSERT INTO id_map VALUES (?,?,?,?,?,?)", map.kind, p.instanceId, map.sourceId, p.teamId, m.projectId, map.id);
  for (const source of m.features) {
    const id = mappings.find((map) => map.kind === "feature" && map.sourceId === source.sourceFeatureId)!.id;
    const f: SharedLedgerFeature = { id, projectId: m.projectId, title: source.title, description: source.description, rev: source.rev,
      version: source.versions.length, authorityMode: source.authorityMode, homeInstanceId: p.instanceId, executorInstanceIds: [],
      status: "planned", counts: { total: source.versions.at(-1)?.nodes.length ?? 0, completed: 0, blocked: 0, missing: 0 },
      updatedBy: actorCode(store, p), updatedAt: now, projection: null };
    insertFeature(store, p.teamId, f);
    let previousDag = { version: 0, nodes: [], bindings: [], reason: "" } as typeof source.versions[number];
    for (const dag of source.versions) {
      if (previousDag.version) assertImportedDagStep(previousDag, dag, f, meta(store, p.teamId), input.batchId);
      const bindings = dag.bindings.map((b) => ({ ...b, taskId: mappings.find((map) => map.kind === "task" && map.sourceId === b.taskId)!.id }));
      saveDag(store, id, { ...dag, bindings }, dag.reason, source.authorityMode === "source");
      previousDag = dag;
    }
    applyProjection(store, p, { ...source.projection, projectId: m.projectId, featureId: id, sourceInstanceId: p.instanceId }, now);
    store.event(p.teamId, m.projectId, id, "import", actorCode(store, p), now);
  }
  const result: SharedLedgerImportResult = { schemaVersion: 1, mode: input.mode, batchId: input.batchId,
    manifestDigest: input.manifestDigest, serverSeq: store.seq(), mappings };
  if (input.mode === "dry-run") {
    store.run("ROLLBACK TO import_preview");
    result.serverSeq = store.seq();
  } else {
    store.run("INSERT INTO import_batches VALUES (?,?,?,?,?,?)", p.teamId, p.instanceId, input.batchId, m.projectId, input.manifestDigest, encode(result));
    store.run("INSERT INTO import_lifecycle VALUES (?,?,?,?,?,?,NULL)", p.teamId, p.instanceId, input.batchId, encode(m),
      m.features.length && m.features.every((f) => f.authorityMode === "source") ? "staged" : "active", result.serverSeq);
  }
  store.run("RELEASE import_preview");
  return result;
}

interface Lifecycle { manifest: string; status: "staged" | "active" | "revoked"; serverSeq: number; verification: string | null }
function lifecycle(store: Store, p: SharedLedgerPrincipal, batchId: string) {
  return store.get<Lifecycle>("SELECT manifest,status,serverSeq,verification FROM import_lifecycle WHERE teamId=? AND sourceInstanceId=? AND batchId=?",
    p.teamId, p.instanceId, batchId);
}

/** Reconstruct from stored rows, including historical DAGs. A saved digest alone is not verification. */
function verifyStoredImport(store: Store, p: SharedLedgerPrincipal, manifest: SharedLedgerImportManifest,
  receipt: SharedLedgerImportResult): SharedLedgerImportVerification {
  const mapped = (kind: "task" | "feature", sourceId: string) => {
    const mapping = receipt.mappings.find((m) => m.kind === kind && m.sourceId === sourceId && m.sourceInstanceId === p.instanceId);
    if (!mapping) throw new SharedLedgerError("invalid_field", "Import mapping missing");
    return mapping.id;
  };
  const restored: SharedLedgerImportManifest = { ...manifest, features: manifest.features.map((source) => {
    const id = mapped("feature", source.sourceFeatureId), f = feature(store, p.teamId, id);
    if (!f || f.authorityMode !== "source" || f.projectId !== manifest.projectId || f.homeInstanceId !== p.instanceId) {
      throw new SharedLedgerError("replayed", "Import state changed");
    }
    const versions = store.all<{ data: string }>("SELECT data FROM source_dag_mirrors WHERE featureId=? ORDER BY version", id)
      .map((row) => decode<typeof source.versions[number]>(row.data)).map((dag) => ({ ...dag, bindings: dag.bindings.map((b) => {
        const task = receipt.mappings.find((m) => m.kind === "task" && m.id === b.taskId);
        if (!task) throw new SharedLedgerError("invalid_field", "Import binding missing");
        return { ...b, taskId: task.sourceId };
      }) }));
    if (f.version !== versions.length) throw new SharedLedgerError("replayed");
    const rows = store.all<{ data: string }>("SELECT data FROM task_mirrors WHERE featureId=?", id)
      .map((row) => decode<SharedLedgerTaskProjection>(row.data));
    if (rows.length !== source.projection.tasks.length) throw new SharedLedgerError("replayed");
    const tasks = source.projection.tasks.map((t) => {
      const row = rows.find((r) => r.sourceTaskId === t.sourceTaskId);
      if (!row) throw new SharedLedgerError("replayed");
      const steps = store.all<{ data: string }>("SELECT data FROM step_mirrors WHERE taskId=?", mapped("task", t.sourceTaskId)).map((r) => decode(r.data));
      if (steps.length !== row.steps.length || row.steps.some((s) => !steps.some((v) => encode(v) === encode(s)))) throw new SharedLedgerError("replayed");
      return row;
    });
    const events = store.all<{ data: string }>("SELECT data FROM source_event_mirrors WHERE featureId=? ORDER BY sourceSeq", id)
      .map((row) => decode<typeof source.projection.events[number]>(row.data));
    const water = store.get<{ sourceSeq: number }>("SELECT sourceSeq FROM projection_watermarks WHERE featureId=?", id);
    if (!water || f.projection?.sourceSeq !== water.sourceSeq) throw new SharedLedgerError("replayed");
    return { ...source, title: f.title, description: f.description, rev: f.rev, versions,
      projection: { ...source.projection, sourceSeq: water.sourceSeq, observedAt: f.projection.observedAt, tasks, events } };
  }) };
  const manifestDigest = sharedLedgerManifestDigest(restored);
  if (manifestDigest !== receipt.manifestDigest) throw new SharedLedgerError("replayed", "Import verification mismatch");
  return { features: restored.features.length, versions: restored.features.reduce((n, f) => n + f.versions.length, 0),
    bindings: restored.features.reduce((n, f) => n + f.versions.reduce((a, v) => a + v.bindings.length, 0), 0),
    tasks: restored.features.reduce((n, f) => n + f.projection.tasks.length, 0), sourceSeq: restored.sourceSeq, manifestDigest };
}

export function importReceipt(store: Store, p: SharedLedgerPrincipal, batchId: string): SharedLedgerImportReceipt {
  const batch = store.get<{ projectId: string; response: string }>(
    "SELECT projectId,response FROM import_batches WHERE teamId=? AND sourceInstanceId=? AND batchId=?", p.teamId, p.instanceId, batchId);
  if (!batch) return { status: "unknown", batchId };
  if (!p.projects.some((g) => g.projectId === batch.projectId && g.actions.includes("import"))) throw new SharedLedgerError("forbidden");
  const life = lifecycle(store, p, batchId);
  if (!life) throw new SharedLedgerError("replayed", "Legacy import requires reconciliation");
  const receipt = decode<SharedLedgerImportResult>(batch.response);
  const verification = life.status === "staged" ? verifyStoredImport(store, p, decode(life.manifest), receipt)
    : life.verification ? decode<SharedLedgerImportVerification>(life.verification) : null;
  return { status: life.status, batchId, projectId: batch.projectId, serverSeq: life.serverSeq, receipt, verification };
}

function revokeFeatures(store: Store, p: SharedLedgerPrincipal, receipt: SharedLedgerImportResult): void {
  const ids = receipt.mappings.filter((m) => m.kind === "feature").map((m) => m.id);
  const taskIds = new Set(receipt.mappings.filter((m) => m.kind === "task").map((m) => m.sourceId));
  for (const row of store.all<{ featureId: string; data: string }>("SELECT featureId,data FROM task_mirrors WHERE sourceInstanceId=?", p.instanceId)) {
    if (!ids.includes(row.featureId) && decode<SharedLedgerTaskProjection>(row.data).deps.some((d) => taskIds.has(d))) {
      throw new SharedLedgerError("replayed", "Imported tasks are referenced");
    }
  }
  for (const id of ids) {
    store.run("DELETE FROM step_mirrors WHERE taskId IN (SELECT taskId FROM task_mirrors WHERE featureId=?)", id);
    for (const table of ["task_mirrors", "source_event_mirrors", "projection_watermarks", "source_dag_mirrors", "feature_locations"]) {
      store.run(`DELETE FROM ${table} WHERE featureId=?`, id);
    }
    store.run("DELETE FROM features WHERE id=? AND teamId=?", id, p.teamId);
  }
  for (const map of receipt.mappings) store.run("DELETE FROM id_map WHERE id=? AND sourceInstanceId=?", map.id, p.instanceId);
}

/** Both transitions and their receipts commit under the center's single writer transaction. */
export function controlImport(store: Store, p: SharedLedgerPrincipal, input: SharedLedgerImportControl, now: number): SharedLedgerImportReceipt {
  const current = importReceipt(store, p, input.batchId);
  if (current.status === "unknown") throw new SharedLedgerError("invalid_field", "Import receipt missing");
  if (current.projectId !== input.projectId) throw new SharedLedgerError("forbidden");
  if (current.receipt.manifestDigest !== input.manifestDigest) throw new SharedLedgerError("replayed");
  const status = input.mode === "activate" ? "active" : "revoked";
  if (current.status === status) return current;
  if (current.status !== "staged") throw new SharedLedgerError("replayed", "Import already opened or revoked");
  if (input.mode === "revoke") revokeFeatures(store, p, current.receipt);
  else for (const map of current.receipt.mappings.filter((m) => m.kind === "feature")) {
    const f = feature(store, p.teamId, map.id)!;
    for (const row of store.all<{ data: string }>("SELECT data FROM source_dag_mirrors WHERE featureId=? ORDER BY version", f.id)) {
      const dag = decode<SharedLedgerImportManifest["features"][number]["versions"][number]>(row.data);
      saveDag(store, f.id, dag, dag.reason);
    }
    f.authorityMode = "planning";
    saveFeature(store, p.teamId, f);
    store.run("UPDATE feature_locations SET authorityMode='planning' WHERE featureId=?", f.id);
  }
  const seq = store.event(p.teamId, input.projectId, "", `import.${input.mode}`, actorCode(store, p), now);
  store.run("UPDATE import_lifecycle SET status=?,serverSeq=?,verification=? WHERE teamId=? AND sourceInstanceId=? AND batchId=?",
    status, seq, encode(current.verification), p.teamId, p.instanceId, input.batchId);
  return { ...current, status, serverSeq: seq };
}
