import {
  fail, parseAsk, parseDag, parseTask, parseProposal, v2ObjectDigest,
  type V2Ask, type V2Proposal, type V2Feature, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { entityId, feature, owner, checkScope, event, type AskCommand, type AskPorts, type Dag } from "./policy.js";
import { readAsk, saveAsk, audit, readProposals } from "./storage.js";
import { approvedAsk, authorizationDigest } from "./authorization.js";

type Propose = Extract<AskCommand, { type: "dag.propose" }>;
type Decide = Extract<AskCommand, { type: "dag.decide" }>;
/** Proposal digest covers the complete frozen payload except its own digest field. */
export function proposalDigest(payload: Propose["payload"]): string {
  const { proposalDigest: _digest, ...body } = payload; return v2ObjectDigest(body);
}
function snapshot(ctx: V2TransactionContext, ports: AskPorts, f: V2Feature) {
  const tasks = ports.readTasks(ctx, f.id).map(parseTask);
  for (const t of tasks) { checkScope(ctx, t); if (t.featureId !== f.id) fail("conflict"); }
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) fail("conflict");
  return { featureRev: f.rev, tasks: tasks.map(t => ({ id: t.id, rev: t.rev })).sort((a, b) => a.id.localeCompare(b.id)) };
}
function saveProposal(ctx: V2TransactionContext, ports: AskPorts, c: AskCommand, row: V2Proposal, snapshotBody?: string): V2Proposal {
  row = parseProposal(row);
  const bindings = { id: row.id, rev: row.rev, state: row.state, body: JSON.stringify(row) };
  const changes = snapshotBody === undefined
    ? ctx.run("asks.proposal.update", { ...bindings, expectedRev: row.rev - 1 })
    : ctx.run("asks.proposal.insert", { ...bindings, featureId: row.featureId, snapshot: snapshotBody });
  if (changes !== 1) fail("conflict");
  audit(ctx, row, event(ctx, ports, c, row.id, "dag", row.state)); return row;
}
export function propose(ctx: V2TransactionContext, ports: AskPorts, c: Propose) {
  const p = c.payload, f = feature(ctx, ports, p.featureId), dag = parseDag(ports.readDag(ctx, f.id));
  if (ctx.all("asks.proposal.pending", { featureId: f.id }).length) fail("pending_proposal");
  if (p.expiresAt <= ctx.scope.now) fail("authorization_expired");
  if (f.rev !== p.expectedRev || f.currentVersion !== p.baseVersion || dag.version !== p.baseVersion) fail("conflict");
  if (p.baseDigest !== v2ObjectDigest(dag) || p.proposalDigest !== proposalDigest(p)) fail("authorization_mismatch");
  const current = snapshot(ctx, ports, f);
  if (p.cancels.some(id => !current.tasks.some(t => t.id === id))) fail("conflict");
  nextDag(dag, p.nodes, p.cancels, p.version);
  const askId = entityId(ctx, c, "ask"), id = entityId(ctx, c, "proposal");
  const ask = saveAsk(ctx, ports, c, parseAsk({ teamId: c.teamId, projectId: c.projectId, id: askId,
    featureId: f.id, taskId: null, source: "business", kind: "authorize", blocking: true,
    title: "范围变更审批", context: p.reasonText,
    options: [{ id: "approve", label: "批准" }, { id: "reject", label: "拒绝" }], allowText: false,
    bind: { taskId: null, featureId: f.id, taskRev: null, specRev: null, workflowRev: null,
      baseVersion: p.baseVersion, proposalDigest: p.proposalDigest, head: null,
      originalDigest: p.proposalDigest, sharedDigest: p.proposalDigest, actionDigest: p.proposalDigest,
      redactionVersion: 1, actions: ["scope.change"], homeInstanceId: f.homeInstanceId, expiresAt: p.expiresAt },
    state: "open", rev: 1, createdBy: ctx.scope.actor.personId, createdAt: ctx.scope.now, expiresAt: p.expiresAt,
    answeredBy: null, answeredAt: null, answer: null, decision: null, auditEventSeq: 1 }), true);
  const { expectedRev: _rev, ...content } = p;
  const proposal = saveProposal(ctx, ports, c, parseProposal({ ...content, teamId: c.teamId, projectId: c.projectId, id,
    rev: 1, proposedBy: ctx.scope.actor.personId, askId, createdAt: ctx.scope.now, state: "pending",
    decidedAt: null, decidedBy: null, decisionNote: "" }), JSON.stringify(current));
  return { ask, proposal, authorizationDigest: authorizationDigest(ask.bind!) };
}
function nextDag(dag: Dag, nodes: Dag["nodes"], cancels: string[], version: number): Dag {
  // Removing a bound node requires an explicit cancellation; completed-node policy belongs to X14.
  if (dag.bindings.some(b => !nodes.some(n => n.key === b.nodeKey) && !cancels.includes(b.taskId))) fail("conflict");
  return parseDag({ version, nodes, bindings: dag.bindings.filter(b => !cancels.includes(b.taskId)) });
}
export function decide(ctx: V2TransactionContext, ports: AskPorts, c: Decide) {
  owner(ctx, ports);
  const p = c.payload, f = feature(ctx, ports, p.featureId);
  const stored = ctx.all("asks.proposal.get", { id: p.proposalId })[0] as { body: string; snapshot: string } | undefined;
  if (!stored) fail("not_found");
  const old = parseProposal(JSON.parse(stored.body));
  if (old.featureId !== f.id || old.askId !== p.askId || old.baseVersion !== p.baseVersion
    || old.proposalDigest !== p.proposalDigest) fail("authorization_mismatch");
  if (old.state !== "pending" || f.rev !== p.expectedRev) fail("conflict");
  let ask = readAsk(ctx, old.askId);
  if (p.decision === "approved") validateApproval(ctx, ports, f, old, ask, stored.snapshot);
  else if (ask.state !== "open" && !(ask.state === "answered" && ask.decision === "rejected")) fail("authorization_mismatch");
  if (ask.state === "open") {
    if (ask.expiresAt <= ctx.scope.now) fail("authorization_expired");
    ask = saveAsk(ctx, ports, c, { ...ask, rev: ask.rev + 1, state: "answered", decision: p.decision,
      answeredBy: ctx.scope.actor.personId, answeredAt: ctx.scope.now,
      answer: { kind: "option", optionId: p.decision === "approved" ? "approve" : "reject" } });
  }
  if (p.decision === "approved") {
    approvedAsk(ctx, ports, ask.id);
    const dag = parseDag(ports.readDag(ctx, f.id));
    if (ports.replaceDag(ctx, f, nextDag(dag, old.nodes, old.cancels, old.version), old.cancels) !== undefined) fail("transaction_control");
  }
  const proposal = saveProposal(ctx, ports, c, { ...old, rev: old.rev + 1, state: p.decision,
    decidedAt: ctx.scope.now, decidedBy: ctx.scope.actor.personId, decisionNote: p.decision });
  return { ask, proposal, authorizationDigest: authorizationDigest(ask.bind!) };
}
function validateApproval(ctx: V2TransactionContext, ports: AskPorts, f: V2Feature, p: V2Proposal, ask: V2Ask, saved: string): void {
  if (p.expiresAt <= ctx.scope.now || ask.expiresAt <= ctx.scope.now) fail("authorization_expired");
  if (ask.state !== "open") approvedAsk(ctx, ports, ask.id);
  const b = ask.bind;
  if (!b || b.taskId !== null || b.featureId !== f.id || b.proposalDigest !== p.proposalDigest
    || b.baseVersion !== p.baseVersion || b.expiresAt !== p.expiresAt || b.actionDigest !== p.proposalDigest
    || b.homeInstanceId !== f.homeInstanceId || !b.actions.includes("scope.change")) fail("authorization_mismatch");
  const dag = parseDag(ports.readDag(ctx, f.id));
  if (f.currentVersion !== p.baseVersion || dag.version !== p.baseVersion || v2ObjectDigest(dag) !== p.baseDigest
    || v2ObjectDigest(snapshot(ctx, ports, f)) !== v2ObjectDigest(JSON.parse(saved))) fail("conflict");
}
/** Terminal asks release the unique pending slot without making a proposal effective. */
export function closeProposal(ctx: V2TransactionContext, ports: AskPorts, c: AskCommand, ask: V2Ask): void {
  const state = ask.state === "cancelled" ? "void" : ask.state === "expired" ? "expired"
    : ask.state === "answered" && ask.decision === "rejected" ? "rejected" : null;
  if (!state) return;
  for (const p of readProposals(ctx).filter(p => p.askId === ask.id && p.state === "pending")) {
    saveProposal(ctx, ports, c, { ...p, rev: p.rev + 1, state, decidedAt: ctx.scope.now,
      decidedBy: ctx.scope.actor.personId, decisionNote: state });
  }
}
