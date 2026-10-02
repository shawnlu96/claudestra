import {
  SHARED_LEDGER_CAPABILITIES, SharedLedgerError, type SharedLedgerFeature, type SharedLedgerFeatureDetail,
  type SharedLedgerDag, type SharedLedgerTaskProjection, type SharedLedgerErrorResponse,
} from "../lib/shared-ledger-contract.js";
import type { SharedLedgerPrincipal } from "../lib/shared-ledger-auth.js";
import { hasRead } from "./identity.js";
import { Store, decode } from "./store.js";

export function meta(store: Store, teamId: string) {
  return { schemaVersion: 1 as const, teamId, serverSeq: store.seq(), capabilities: SHARED_LEDGER_CAPABILITIES };
}
export function feature(store: Store, team: string, id: string): SharedLedgerFeature | null {
  const row = store.get<{ data: string }>("SELECT data FROM features WHERE teamId=? AND id=?", team, id);
  return row ? decode(row.data) : null;
}
export function detail(store: Store, team: string, id: string): SharedLedgerFeatureDetail {
  const f = feature(store, team, id);
  if (!f) throw new SharedLedgerError("forbidden");
  const table = f.authorityMode === "source" ? "source_dag_mirrors" : "dag_versions";
  const row = store.get<{ data: string }>(`SELECT data FROM ${table} WHERE featureId=? AND version=?`, id, f.version);
  const stored = row ? decode<SharedLedgerDag>(row.data) : { version: 0, nodes: [], bindings: [] };
  const dag = { version: stored.version, nodes: stored.nodes, bindings: stored.bindings };
  const tasks = store.all<{ taskId: string; data: string }>("SELECT taskId,data FROM task_mirrors WHERE featureId=? ORDER BY taskId", id)
    .map((t) => ({ ...decode<SharedLedgerTaskProjection>(t.data), taskId: t.taskId }));
  return { ...meta(store, team), feature: f, dag, tasks };
}
export class Conflict extends Error {
  constructor(readonly response: SharedLedgerErrorResponse) { super("Shared planning conflict"); }
}
export function conflict(store: Store, p: SharedLedgerPrincipal, id?: string): never {
  const f = id ? feature(store, p.teamId, id) : null;
  if (!f || !hasRead(p, f.projectId)) throw new SharedLedgerError("replayed");
  throw new Conflict({ code: "conflict", status: 409, currentRev: f.rev, currentVersion: f.version,
    latest: detail(store, p.teamId, f.id), modifiedBy: f.updatedBy, modifiedAt: f.updatedAt });
}
export function ownReceipt(store: Store, p: SharedLedgerPrincipal, requestId: string) {
  return store.get<{ projectId: string; digest: string; response: string }>(
    "SELECT projectId,digest,response FROM command_receipts WHERE teamId=? AND personId=? AND instanceId=? AND requestId=?",
    p.teamId, p.personId, p.instanceId, requestId);
}
