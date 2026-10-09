/**
 * S2P: center feature view → local row images for the six projected tables (§2.2「调度输入供应」). Pure mapping, no writes.
 * Center task id = local card id (S2Q addresses the center with the local id); center intent operationId = local intent id.
 */
import type { V2Dependency, V2Executor, V2Step, V2Task, V2Workflow } from "./shared-ledger-contract-v2-tasks.js";
import { resourceKey, type V2Intent, type V2Resource } from "./shared-ledger-contract-v2-scheduling.js";
import type { parseFeatureView } from "./shared-ledger-contract-v2-routes.js";
import { LedgerError } from "./ledger-store.js";

export type V2FeatureView = ReturnType<typeof parseFeatureView>;
/** Actions both sides share; other center actions (deliver / deploy / release / pause / cancel) have no local scheduler row. */
export const PROJECTED_ACTIONS: readonly string[] = ["dispatch", "stage", "review", "merge", "verify"];
/** Home-only actions (S2Q executor token); the projection never touches these intents or their locks. */
export const LOCAL_ACTIONS: readonly string[] = ["ensure_session", "retire"];
export const TERMINAL_INTENT: readonly string[] = ["done", "cancelled"];

type Row = Record<string, string | number | null>;
export interface LocalTaskRow { id: string; project: string; spec: string | null; specRev: number; pr: string | null; extra: string }

/** Trusted instance coordinates (S2F): the home instance id and the local peer each remote instance maps to; never read from the view. */
export interface ProjectionIdentity { home: string; peer(instanceId: string): { name: string; fp: string } | null }
type Who = { step: string; stepKind: "agent" | "human" | "peer"; assignee: string; assigneeKind: "agent" | "human" | "peer_agent"; agent: string | null };

/** Center coordinates → the local forms readers already use: agent / agent@peer (steps, extra) and fp/agent (peer_agent assignee). */
function localWho(e: V2Executor, id: ProjectionIdentity | undefined): Who {
  if (e.kind === "human") return { step: e.personId, stepKind: "human", assignee: e.personId, assigneeKind: "human", agent: null };
  if (!id) throw new LedgerError("conflict", `v2_unmapped: 没有可信实例映射，无法落地执行者 ${e.agentId}`);
  if (e.instanceId === id.home) return { step: e.agentId, stepKind: "agent", assignee: e.agentId, assigneeKind: "agent", agent: e.agentId };
  const peer = id.peer(e.instanceId);
  if (!peer) throw new LedgerError("conflict", `v2_unmapped: 实例 ${e.instanceId} 没有可信本机 peer 映射`);
  return { step: `${e.agentId}@${peer.name}`, stepKind: "peer", assignee: `${peer.fp}/${e.agentId}`, assigneeKind: "peer_agent", agent: null };
}
const who = (e: V2Executor | null, id: ProjectionIdentity | undefined): Who | null => e === null ? null : localWho(e, id);

/** Center-only task fields with no local column, kept verbatim under extra.centerTask (S2F reads review / delivery artifacts from it). */
export const centerTaskFields = (t: V2Task) => ({
  plan: t.plan, homeInstanceId: t.homeInstanceId, executor: t.executor, executorInstanceId: t.executorInstanceId, pm: t.pm,
  repository: t.repository, spec: t.spec, collaboration: t.collaboration, review: t.review, delivery: t.delivery,
});

/** Local extra keeps its home-only keys; center-owned keys (centerTask, reviewer / delegate in local form) follow the view. */
export function taskExtra(t: V2Task, localExtra: Record<string, unknown>, id: ProjectionIdentity | undefined): string {
  const extra: Record<string, unknown> = { ...localExtra, centerTask: centerTaskFields(t) };
  for (const field of ["reviewer", "delegate"] as const) {
    const w = who(t.collaboration[field], id);
    if (w) extra[field] = w.step; else delete extra[field];
  }
  return JSON.stringify(extra);
}

/** Local pr is a PR URL; keep an existing URL of the same number, otherwise derive the GitHub URL from the center repository. */
function prUrl(t: V2Task, local: LocalTaskRow | null): string | null {
  if (t.pr === null) return null;
  if (local?.pr && Number(local.pr.match(/\/pull\/(\d+)$/)?.[1]) === t.pr) return local.pr;
  return `https://github.com/${t.repository}/pull/${t.pr}`;
}

/** Card columns the center owns. spec: the home keeps its original text; the shared summary lands only for a new card or a newer specRev. */
export function taskRow(t: V2Task, local: LocalTaskRow | null, id: ProjectionIdentity | undefined): Row {
  const spec = local && local.spec !== null && local.specRev >= t.specRev ? local.spec : t.spec.summary;
  const exec = who(t.executor, id);
  return {
    title: t.title, kind: t.kind, stage: t.stage, stageBefore: t.stageBefore, round: t.round,
    agent: exec?.agent ?? null, assigneeKind: exec?.assigneeKind ?? null, assignee: exec?.assignee ?? null, pm: who(t.pm, id)?.step ?? null,
    branch: t.branch, pr: prUrl(t, local), headSHA: t.head, spec, specRev: t.specRev, rev: t.rev, createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

export const depRow = (project: string, d: V2Dependency): Row => ({
  project, fromTask: d.fromTask, toTask: d.toTask, kind: d.kind, cond: d.when, state: d.state,
  rev: d.rev, createdBy: d.createdBy, createdAt: d.createdAt, updatedAt: d.updatedAt,
});

export const stepRow = (s: V2Step, id: ProjectionIdentity | undefined): Row => ({
  taskId: s.taskId, step: s.step, round: s.round, executor: localWho(s.executor, id).step, executorKind: localWho(s.executor, id).stepKind, state: s.state, headFrom: s.headFrom, headTo: s.headTo,
  verdict: s.verdict, verified: JSON.stringify(s.verified), claims: JSON.stringify(s.claims), rev: s.rev, createdAt: s.createdAt, updatedAt: s.updatedAt,
});

/** fallback ← family array joined with ","; project ← the local project (§2.2 table). */
export const workflowRow = (project: string, w: V2Workflow): Row => ({
  taskId: w.taskId, project, template: w.template, templateVersion: w.templateVersion, mode: w.mode, authorFamily: w.authorFamily,
  fallback: w.fallback.join(","), specRev: w.specRev, rev: w.rev, createdAt: w.createdAt, updatedAt: w.updatedAt,
});

/** recipient / receipt have no center field; the writer keeps the local value on update. */
export const intentRow = (project: string, i: V2Intent): Row => ({
  id: i.operationId, taskId: i.taskId, project, node: i.node, action: i.action, causalSeq: i.causalSeq, eventSeq: i.eventSeq,
  taskRev: i.taskRev, specRev: i.specRev, head: i.head, templateVersion: i.templateVersion, status: i.status, attempts: i.attempts,
  reason: i.reason, createdAt: i.createdAt, updatedAt: i.updatedAt,
});

/** resource ← X0 structured key string (S2Q parses it back); intentId ← the declaring intent's local id. */
export const resourceRow = (project: string, r: V2Resource): Row => ({
  project, resource: resourceKey(r.key), taskId: r.taskId, intentId: r.operationId, acquiredAt: r.acquiredAt, scope: r.scope,
});

/** Per-card event data; S2F reads intents[].fence as the trusted submitted fence for claimFence. */
export function cardEventData(view: V2FeatureView, t: V2Task): Record<string, unknown> {
  return {
    op: "center-projection", centerFeatureId: view.feature.id, serverSeq: view.serverSeq, serviceGeneration: view.serviceGeneration,
    rev: t.rev, stage: t.stage, round: t.round, head: t.head, task: centerTaskFields(t),
    intents: view.intents.filter(i => i.taskId === t.id && PROJECTED_ACTIONS.includes(i.action)).map(i => ({
      id: i.operationId, centerId: i.id, action: i.action, status: i.status,
      fence: { serviceGeneration: i.serviceGeneration, epoch: i.epoch, bootId: i.bootId },
    })),
  };
}
