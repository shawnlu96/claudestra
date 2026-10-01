import { SharedLedgerError, type SharedLedgerImport, type SharedLedgerImportResult, type SharedLedgerFeature } from "../lib/shared-ledger-contract.js";
import type { SharedLedgerPrincipal } from "../lib/shared-ledger-auth.js";
import { assertSharedLedgerMutation } from "../lib/shared-ledger-contract-validation.js";
import { actorCode, registeredHome } from "./identity.js";
import { conflict, meta } from "./reads.js";
import { insertFeature, saveDag } from "./commands.js";
import { applyProjection } from "./projections.js";
import { Store, decode, encode, newId, rejectSensitive } from "./store.js";

export function importManifest(store: Store, p: SharedLedgerPrincipal, input: SharedLedgerImport, now: number): SharedLedgerImportResult {
  rejectSensitive(input);
  const m = input.manifest;
  if (!registeredHome(store, p.teamId, m.sourceInstanceId, m.projectId)) throw new SharedLedgerError("forbidden");
  const previous = store.get<{ digest: string; projectId: string; response: string }>(
    "SELECT digest,projectId,response FROM import_batches WHERE teamId=? AND sourceInstanceId=? AND batchId=?", p.teamId, p.instanceId, input.batchId);
  if (previous) {
    if (previous.projectId !== m.projectId) throw new SharedLedgerError("forbidden");
    if (previous.digest !== input.manifestDigest) throw new SharedLedgerError("replayed");
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
      if (previousDag.version) {
        assertSharedLedgerMutation({ type: "dag.rewrite", requestId: input.batchId, projectId: m.projectId, featureId: id,
          expectedRev: f.rev, baseVersion: previousDag.version, nodes: dag.nodes, reason: dag.reason || "import" },
        { ...meta(store, p.teamId), feature: { ...f, authorityMode: "planning", version: previousDag.version }, dag: previousDag, tasks: [] }, false);
        if (previousDag.bindings.some((b) => !dag.bindings.some((next) => next.nodeKey === b.nodeKey && next.taskId === b.taskId))) {
          throw new SharedLedgerError("invalid_field", "Historical binding removed");
        }
      }
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
  } else store.run("INSERT INTO import_batches VALUES (?,?,?,?,?,?)", p.teamId, p.instanceId, input.batchId, m.projectId, input.manifestDigest, encode(result));
  store.run("RELEASE import_preview");
  return result;
}
