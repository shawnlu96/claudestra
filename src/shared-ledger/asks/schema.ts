import type { V2Statement } from "../../lib/shared-ledger-contract-v2.js";

const scope = "teamId=$teamId AND projectId=$projectId";
export const asksSchema: Record<string, string> = {
  "asks.rows": `CREATE TABLE IF NOT EXISTS v2_asks (
    teamId TEXT NOT NULL, projectId TEXT NOT NULL, id TEXT NOT NULL, featureId TEXT NOT NULL,
    rev INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(teamId,projectId,id))`,
  "asks.proposals": `CREATE TABLE IF NOT EXISTS v2_ask_proposals (
    teamId TEXT NOT NULL, projectId TEXT NOT NULL, id TEXT NOT NULL, featureId TEXT NOT NULL,
    state TEXT NOT NULL, rev INTEGER NOT NULL, body TEXT NOT NULL, snapshot TEXT NOT NULL,
    PRIMARY KEY(teamId,projectId,id))`,
  "asks.pending": `CREATE UNIQUE INDEX IF NOT EXISTS v2_ask_pending
    ON v2_ask_proposals(teamId,projectId,featureId) WHERE state='pending'`,
  "asks.audit": `CREATE TABLE IF NOT EXISTS v2_ask_audit (
    teamId TEXT NOT NULL, projectId TEXT NOT NULL, entityId TEXT NOT NULL, rev INTEGER NOT NULL,
    eventSeq INTEGER NOT NULL, actor TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(teamId,projectId,entityId,rev))`,
};
for (const action of ["UPDATE", "DELETE"]) asksSchema[`asks.audit.${action}`] =
  `CREATE TRIGGER IF NOT EXISTS v2_ask_audit_${action} BEFORE ${action} ON v2_ask_audit
    BEGIN SELECT RAISE(ABORT, 'immutable ask audit'); END`;
export const asksStatements: Record<string, V2Statement> = {
  "asks.get": { mode: "read", sql: `SELECT body FROM v2_asks WHERE ${scope} AND id=$id` },
  "asks.list": { mode: "read", sql: `SELECT body FROM v2_asks WHERE ${scope} ORDER BY id` },
  "asks.insert": { mode: "write", sql: `INSERT INTO v2_asks VALUES ($teamId,$projectId,$id,$featureId,$rev,$body)` },
  "asks.update": { mode: "write", sql: `UPDATE v2_asks SET rev=$rev,body=$body WHERE ${scope} AND id=$id AND rev=$expectedRev` },
  "asks.proposal.get": { mode: "read", sql: `SELECT body,snapshot FROM v2_ask_proposals WHERE ${scope} AND id=$id` },
  "asks.proposal.list": { mode: "read", sql: `SELECT body,snapshot FROM v2_ask_proposals WHERE ${scope} ORDER BY id` },
  "asks.proposal.pending": { mode: "read", sql: `SELECT id FROM v2_ask_proposals WHERE ${scope} AND featureId=$featureId AND state='pending'` },
  "asks.proposal.insert": { mode: "write", sql: `INSERT INTO v2_ask_proposals VALUES ($teamId,$projectId,$id,$featureId,$state,$rev,$body,$snapshot)` },
  "asks.proposal.update": { mode: "write", sql: `UPDATE v2_ask_proposals SET state=$state,rev=$rev,body=$body
    WHERE ${scope} AND id=$id AND rev=$expectedRev` },
  "asks.audit.insert": { mode: "write", sql: `INSERT INTO v2_ask_audit VALUES ($teamId,$projectId,$entityId,$rev,$eventSeq,$actor,$body)` },
  "asks.audit.list": { mode: "read", sql: `SELECT eventSeq,actor,body FROM v2_ask_audit WHERE ${scope} AND entityId=$entityId ORDER BY rev` },
};
