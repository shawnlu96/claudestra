import {
  parseEvent, parseReceipt, v2ObjectDigest, fail, type V2Command, type V2Receipt, type V2Event,
  type V2Statement, type V2SchemaContext, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { scopeWhere } from "./schema.js";

// X12 shares this journal across domains, so serverSeq is one central SQLite sequence.
export const journalSchema: Record<string, string> = {
  "xt.events": `CREATE TABLE IF NOT EXISTS exec_events (seq INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId TEXT,projectId TEXT,personId TEXT,instanceId TEXT,requestId TEXT,data TEXT,
    UNIQUE(teamId,projectId,personId,instanceId,requestId))`,
  "xt.receipts": `CREATE TABLE IF NOT EXISTS exec_command_receipts (teamId TEXT,projectId TEXT,personId TEXT,
    instanceId TEXT,requestId TEXT,actorDigest TEXT,data TEXT, PRIMARY KEY(teamId,projectId,personId,instanceId,requestId))`,
};
for (const table of ["exec_events", "exec_command_receipts"]) {
  for (const action of ["UPDATE", "DELETE"]) journalSchema[`xt.${table}.${action}`] =
    `CREATE TRIGGER IF NOT EXISTS ${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable'); END`;
}
const ownRequest = `${scopeWhere} AND personId=$personId AND instanceId=$instanceId AND requestId=$requestId`;
export const journalStatements: Record<string, V2Statement> = {
  "xt.receipt.get": { mode: "read", sql: `SELECT data,actorDigest FROM exec_command_receipts WHERE ${ownRequest}` },
  "xt.receipt.insert": { mode: "write", sql: `INSERT INTO exec_command_receipts
    VALUES ($teamId,$projectId,$personId,$instanceId,$requestId,$actorDigest,$data)` },
  "xt.event.insert": { mode: "write", sql: `INSERT INTO exec_events (teamId,projectId,personId,instanceId,requestId,data)
    VALUES ($teamId,$projectId,$personId,$instanceId,$requestId,$data)` },
  "xt.event.seq": { mode: "read", sql: `SELECT seq FROM exec_events WHERE ${ownRequest}` },
  "xt.event.list": { mode: "read", sql: `SELECT seq,data FROM exec_events WHERE ${scopeWhere} ORDER BY seq` },
};
export function installJournal(ctx: V2SchemaContext): void {
  for (const name of Object.keys(journalSchema)) ctx.install(name);
}
export function findReceipt(ctx: V2TransactionContext, command: V2Command): V2Receipt | null {
  const old = ctx.all("xt.receipt.get", { requestId: command.requestId })[0] as { data: string; actorDigest: string } | undefined;
  if (!old) return null;
  const receipt = parseReceipt(JSON.parse(old.data));
  if (old.actorDigest !== v2ObjectDigest(ctx.scope.actor) || receipt.commandDigest !== v2ObjectDigest(command)) fail("dedup_mismatch");
  return receipt;
}
export function readEvents(ctx: V2TransactionContext): V2Event[] {
  return (ctx.all("xt.event.list") as Array<{ seq: number; data: string }>).map(row => parseEvent({ ...JSON.parse(row.data), seq: row.seq }));
}
export function recordCommit(
  ctx: V2TransactionContext, command: V2Command, result: V2Receipt["result"], kind: V2Event["kind"], head: string | null = null,
): V2Receipt {
  const { teamId, projectId, now, actor, serviceGeneration } = ctx.scope;
  const event = parseEvent({ teamId, projectId, seq: 1, timestamp: now, entityId: result.entityId, kind,
    command: command.type, requestId: command.requestId, actor, summary: "", taskRev: kind === "task" ? result.rev : null,
    specRev: result.specRev, head, source: null });
  const { seq: _allocatedByDatabase, ...data } = event;
  ctx.run("xt.event.insert", { requestId: command.requestId, data: JSON.stringify(data) });
  const seq = (ctx.all("xt.event.seq", { requestId: command.requestId })[0] as { seq: number }).seq;
  const receipt = parseReceipt({ teamId, projectId, schemaVersion: 2, serviceGeneration, requestId: command.requestId,
    personId: actor.personId, instanceId: actor.instanceId, commandDigest: v2ObjectDigest(command),
    command: command.type, serverSeq: seq, committedAt: now, result });
  ctx.run("xt.receipt.insert", { requestId: command.requestId, actorDigest: v2ObjectDigest(actor), data: JSON.stringify(receipt) });
  return receipt;
}
