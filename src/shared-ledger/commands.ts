import type { SharedLedgerCommand, SharedLedgerCommandResult, SharedLedgerDag, SharedLedgerFeature } from "../lib/shared-ledger-contract.js";
import { SharedLedgerError } from "../lib/shared-ledger-contract.js";
import type { SharedLedgerPrincipal } from "../lib/shared-ledger-auth.js";
import { sharedLedgerCommandDigest } from "../lib/shared-ledger-auth.js";
import { assertSharedLedgerMutation } from "../lib/shared-ledger-contract-validation.js";
import { refreshFeatureState } from "./feature-state.js";
import { actorCode, registeredHome } from "./identity.js";
import { conflict, detail, ownReceipt } from "./reads.js";
import { Store, decode, encode, newId, rejectSensitive } from "./store.js";

export function saveFeature(store: Store, team: string, f: SharedLedgerFeature): void {
  store.run("UPDATE features SET title=?,data=? WHERE teamId=? AND id=?", f.title, encode(f), team, f.id);
}
export function insertFeature(store: Store, team: string, f: SharedLedgerFeature): void {
  store.run("INSERT INTO features VALUES (?,?,?,?,?)", f.id, team, f.projectId, f.title, encode(f));
  store.run("INSERT INTO feature_locations VALUES (?,?,?,?)", f.id, f.homeInstanceId, f.authorityMode, 1);
}
export function saveDag(store: Store, id: string, dag: SharedLedgerDag, reason: string, source = false): void {
  store.run(`INSERT INTO ${source ? "source_dag_mirrors" : "dag_versions"} VALUES (?,?,?)`, id, dag.version, encode({ ...dag, reason }));
  if (!source) for (const b of dag.bindings) {
    store.run("INSERT INTO dag_bindings VALUES (?,?,?,?)", id, dag.version, b.nodeKey, b.taskId);
  }
}
export function executeCommand(store: Store, p: SharedLedgerPrincipal, command: SharedLedgerCommand, now: number): SharedLedgerCommandResult {
  rejectSensitive(command);
  const digest = sharedLedgerCommandDigest({ attemptNonce: "0".repeat(32), payload: command });
  const old = ownReceipt(store, p, command.requestId);
  if (old) {
    if (old.projectId !== command.projectId) throw new SharedLedgerError("forbidden");
    if (old.digest !== digest) conflict(store, p, "featureId" in command ? command.featureId : undefined);
    return decode(old.response);
  }
  const code = actorCode(store, p);
  const duplicate = store.get<{ id: string }>("SELECT id FROM features WHERE teamId=? AND projectId=? AND title=?",
    p.teamId, command.projectId, command.type === "feature.new" ? command.title : command.type === "feature.set" ? command.patch.title ?? "" : "");
  let f: SharedLedgerFeature;
  if (command.type === "feature.new") {
    if (duplicate) conflict(store, p, duplicate.id);
    if (!registeredHome(store, p.teamId, command.homeInstanceId, command.projectId)) throw new SharedLedgerError("forbidden");
    f = { id: newId(), projectId: command.projectId, title: command.title, description: command.description, rev: 1, version: 0,
      authorityMode: "planning", homeInstanceId: command.homeInstanceId, executorInstanceIds: [], status: "planned",
      counts: { total: 0, completed: 0, blocked: 0, missing: 0 }, updatedBy: code, updatedAt: now, projection: null };
    insertFeature(store, p.teamId, f);
  } else {
    const current = detail(store, p.teamId, command.featureId);
    if (current.feature.projectId !== command.projectId) throw new SharedLedgerError("forbidden");
    try { assertSharedLedgerMutation(command, current, false); }
    catch (e) {
      if (e instanceof SharedLedgerError && e.code === "conflict") conflict(store, p, command.featureId);
      throw e;
    }
    f = { ...current.feature, rev: current.feature.rev + 1, updatedBy: code, updatedAt: now };
    if (command.type === "feature.set") {
      if (duplicate && duplicate.id !== f.id) conflict(store, p, duplicate.id);
      Object.assign(f, command.patch);
    } else {
      f.version++;
      saveDag(store, f.id, { version: f.version, nodes: command.nodes, bindings: current.dag.bindings }, command.reason);
      f.counts = { ...f.counts, total: command.nodes.length };
      refreshFeatureState(store, f);
    }
    saveFeature(store, p.teamId, f);
  }
  const serverSeq = store.event(p.teamId, command.projectId, f.id, command.type, code, now);
  const response: SharedLedgerCommandResult = { schemaVersion: 1, requestId: command.requestId, commandDigest: digest,
    serverSeq, committedAt: now, result: { featureId: f.id, rev: f.rev, version: f.version } };
  store.run("INSERT INTO command_receipts VALUES (?,?,?,?,?,?,?)", p.teamId, p.personId, p.instanceId,
    command.requestId, command.projectId, digest, encode(response));
  return response;
}
