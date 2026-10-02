import { validateDag } from "./shared-ledger-contract-validation.js";
import { SharedLedgerError } from "./shared-ledger-contract.js";
import {
  array, boolean, choice, digest, distinct, id, integer, nullable, object, positive, refine,
  revisions, scope, text, timestamp, relativePath, fail, type Infer, type Schema,
} from "./shared-ledger-contract-v2-validation.js";

function v1Schema<T>(schema: Schema<T>): Schema<T> {
  return value => {
    try { return schema(value); }
    catch (e) { if (e instanceof SharedLedgerError) return fail(); throw e; }
  };
}
export const parseNode = object({ key: id, oneLine: text(2000, 1), deps: array(id), fileGlobs: array(relativePath), estimate: text(200) });
const dagSchema = object({ version: integer, nodes: array(parseNode), bindings: array(object({ nodeKey: id, taskId: id })) });
export const parseDag = v1Schema((value: unknown) => { const dag = dagSchema(value); validateDag(dag); return dag; });
export const parseFeature = refine(object({
  ...scope, id, title: text(300, 1), description: text(16000), ownerWords: text(16000), ownerWordsBy: id,
  authorityMode: choice(["source", "planning", "execution"]), homeInstanceId: id, epoch: positive,
  status: choice(["active", "paused", "done", "dropped"]), currentVersion: integer, ...revisions,
}), f => f.updatedAt >= f.createdAt);
export type V2Feature = Infer<typeof parseFeature>;
export const proposalContentFields = {
  baseVersion: positive, version: positive, reasonKind: choice(["new_issue", "requirement_change", "p1_fallback"]),
  reasonText: text(2000, 1), nodes: array(parseNode), cancels: array(id), scopeChange: boolean,
  proposalDigest: digest, baseDigest: digest, expiresAt: timestamp,
};
export const parseProposal = refine(object({
  ...scope, id, featureId: id, ...proposalContentFields, rev: positive, proposedBy: id, askId: id,
  createdAt: timestamp, state: choice(["pending", "approved", "rejected", "void", "expired"]),
  decidedAt: nullable(timestamp), decidedBy: nullable(id), decisionNote: text(2000),
}), p => {
  parseDag({ version: p.version, nodes: p.nodes, bindings: [] });
  return p.version === p.baseVersion + 1 && p.expiresAt > p.createdAt && distinct(p.cancels)
    && (p.state === "pending" ? p.decidedAt === null && p.decidedBy === null : p.decidedAt !== null && p.decidedBy !== null);
});
export type V2Proposal = Infer<typeof parseProposal>;
