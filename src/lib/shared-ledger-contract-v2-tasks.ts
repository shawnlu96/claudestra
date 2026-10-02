import { ITEM_STATUSES, STAGES, STEPS, TASK_KINDS } from "./ledger-stages.js";
import {
  array, boolean, choice, digest, distinct, head, id, integer, literal, nullable, object, optional,
  positive, refine, relativePath, repository, revisions, scope, text, union, branch, type Infer,
} from "./shared-ledger-contract-v2-validation.js";

/** Coordinates contain no worktree, session, channel, registry or credentials. */
export const parseExecutor = union(
  object({ kind: literal("human"), personId: id }),
  object({ kind: choice(["agent", "peer_agent"]), instanceId: id, agentId: id }),
);
export type V2Executor = Infer<typeof parseExecutor>;
const parseSpec = object({
  summary: text(16000), originalDigest: digest, sharedDigest: nullable(digest), artifactId: nullable(id),
  visibility: choice(["home_only", "approved_copy"]), repositoryPath: nullable(relativePath), commit: nullable(head),
});
export const parseTaskSpec = refine(parseSpec, s => s.visibility === "approved_copy"
  ? s.artifactId !== null && s.sharedDigest !== null : s.artifactId === null && s.sharedDigest === null);
const taskPlanningFields = { title: optional(text(300, 1)), plan: optional(text(16000)) };
export const parseTaskPatch = refine(object(taskPlanningFields), p => Object.keys(p).length > 0);
/** Named replacements for local extra; absence means unavailable, never an arbitrary metadata bag. */
export const parseTask = refine(object({
  ...scope, id, itemId: nullable(id), featureId: id, title: text(300, 1), plan: text(16000),
  kind: choice(TASK_KINDS), stage: choice(STAGES), stageBefore: nullable(choice(STAGES)),
  round: integer, specRev: positive, ...revisions, homeInstanceId: id, executor: nullable(parseExecutor),
  executorInstanceId: nullable(id), pm: nullable(parseExecutor), repository, branch: nullable(branch),
  pr: nullable(positive), head: nullable(head), spec: parseTaskSpec,
  collaboration: object({ reviewer: nullable(parseExecutor), delegate: nullable(parseExecutor) }),
  review: object({ verdict: nullable(choice(["pass", "changes", "block"])), reviewedHead: nullable(head), reportArtifactId: nullable(id) }),
  delivery: object({ orderId: nullable(id), summary: text(4000), artifactIds: array(id, 100) }),
}), t => t.updatedAt >= t.createdAt && (t.stage === "blocked" ? t.stageBefore !== null : t.stageBefore === null)
  && distinct(t.delivery.artifactIds));
export type V2Task = Infer<typeof parseTask>;
export const parseItem = refine(object({
  ...scope, id, featureId: nullable(id), title: text(300, 1), ownerWords: text(16000), ownerWordsBy: id,
  description: text(16000), descriptionBy: id, priority: choice(["", "P0", "P1", "P2", "P3"]),
  status: choice(ITEM_STATUSES), oneLine: text(2000), next: text(2000), ...revisions,
}), t => t.updatedAt >= t.createdAt);
export type V2Item = Infer<typeof parseItem>;
export const parseDependency = refine(object({
  ...scope, fromTask: id, toTask: id, kind: choice(["blocks", "branch"]), when: text(2000),
  state: nullable(choice(["waiting", "active", "done"])), createdBy: id, ...revisions,
}), d => d.fromTask !== d.toTask && d.updatedAt >= d.createdAt);
export type V2Dependency = Infer<typeof parseDependency>;
const stepEvidence = object({
  author: nullable(parseExecutor), independentReviewer: boolean, verifiedHead: nullable(head), evidenceArtifactIds: array(id, 100),
});
const stepClaims = object({ family: nullable(choice(["claude", "codex"])), model: nullable(text(100)), summary: text(4000) });
export const parseStep = refine(object({
  ...scope, taskId: id, step: choice(STEPS), round: integer, executor: parseExecutor,
  state: choice(["assigned", "delivered", "done"]), headFrom: nullable(head), headTo: nullable(head),
  verdict: nullable(choice(["pass", "changes", "block"])), verified: stepEvidence, claims: stepClaims, ...revisions,
}), s => s.updatedAt >= s.createdAt && distinct(s.verified.evidenceArtifactIds));
export type V2Step = Infer<typeof parseStep>;
export const workflowSettings = {
  template: choice(["code", "ui", "security"]), templateVersion: positive, mode: choice(["manual", "observe", "auto"]),
  authorFamily: choice(["claude", "codex"]), fallback: array(choice(["claude", "codex"]), 2),
};
export const parseWorkflow = refine(object({ ...scope, taskId: id, ...workflowSettings, specRev: positive, ...revisions }),
  w => distinct(w.fallback) && w.updatedAt >= w.createdAt);
export type V2Workflow = Infer<typeof parseWorkflow>;
