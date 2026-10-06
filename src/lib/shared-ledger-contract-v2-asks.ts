import {
  array, boolean, choice, digest, distinct, head, id, integer, literal, nullable, object, positive,
  refine, scope, text, timestamp, union, type Infer,
} from "./shared-ledger-contract-v2-validation.js";
import { v2ContentDigest } from "./shared-ledger-contract-v2-integrity.js";

/** Approval binds the content actually used, separately from the approved shared copy. */
const authorizationFields = {
  taskId: nullable(id), featureId: id, taskRev: nullable(positive), specRev: nullable(positive), workflowRev: nullable(positive),
  baseVersion: integer, proposalDigest: nullable(digest), head: nullable(head),
  originalDigest: digest, sharedDigest: digest, actionDigest: digest, redactionVersion: positive,
  actions: array(choice(["scope.change", "home.change", "task.cancel", "merge", "deploy", "release", "artifact.share", "workflow.auto"]), 8),
  homeInstanceId: id, expiresAt: timestamp,
};
export const parseAuthorizationBind = refine(object(authorizationFields), b => b.actions.length > 0 && distinct(b.actions));
export type V2AuthorizationBind = Infer<typeof parseAuthorizationBind>;
const askOption = object({ id, label: text(200, 1) });
export const askContentFields = {
  kind: choice(["decide", "authorize", "owner_action", "accept"]), blocking: boolean,
  title: text(300, 1), context: text(16000), options: array(askOption, 25), allowText: boolean,
  bind: nullable(parseAuthorizationBind),
};
export const parseAskAnswer = union(
  object({ kind: literal("option"), optionId: id }), object({ kind: literal("text"), text: text(4000, 1) }),
);
export const parseAsk = refine(object({
  ...scope, id, featureId: id, taskId: nullable(id), source: literal("business"), ...askContentFields,
  state: choice(["open", "answered", "expired", "cancelled"]), rev: positive, createdBy: id,
  createdAt: timestamp, expiresAt: timestamp, answeredBy: nullable(id), answeredAt: nullable(timestamp),
  answer: nullable(parseAskAnswer), decision: nullable(choice(["approved", "rejected", "acknowledged"])),
  auditEventSeq: positive,
}), a => a.expiresAt > a.createdAt
  && (a.kind === "authorize" ? a.bind !== null && a.expiresAt === a.bind.expiresAt
    && a.featureId === a.bind.featureId && a.taskId === a.bind.taskId : a.bind === null)
  && distinct(a.options, o => o.id)
  && (a.state === "answered" ? a.answer !== null && a.answeredBy !== null && a.answeredAt !== null
    && a.answeredAt >= a.createdAt && a.answeredAt < a.expiresAt && a.decision !== null
    : a.answer === null && a.answeredBy === null && a.answeredAt === null && a.decision === null)
  && (a.answer?.kind !== "option" || a.options.map(o => o.id).includes(a.answer.optionId))
  && (a.answer?.kind !== "text" || a.allowText));
export type V2Ask = Infer<typeof parseAsk>;
const artifactSchema = refine(object({
  ...scope, artifactId: id, kind: choice(["spec", "review", "report", "evidence"]), taskId: id,
  specRev: nullable(positive), head: nullable(head), digest, originalDigest: digest, sharedDigest: digest,
  redactionVersion: positive, approvalAskId: id, approvedBy: id, createdAt: timestamp,
  mediaType: choice(["text/plain", "text/markdown", "application/json"]), bytes: integer,
  content: text(262144), visibility: literal("approved_copy"),
}), a => (a.specRev !== null || a.head !== null) && (a.kind !== "spec" || a.specRev !== null)
  && a.digest === a.sharedDigest && a.digest === v2ContentDigest(a.content)
  && a.bytes === new TextEncoder().encode(a.content).length && a.bytes <= 262144);
/** Immutable object id/digest/bind tuple. artifact.put is append/idempotent-only; there is no patch/delete action. */
export const parseArtifact = (value: unknown) => Object.freeze(artifactSchema(value));
export type V2Artifact = Infer<typeof parseArtifact>;
