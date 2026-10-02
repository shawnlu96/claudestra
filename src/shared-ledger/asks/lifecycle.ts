import { fail, parseAsk, type V2Ask, type V2TransactionContext } from "../../lib/shared-ledger-contract-v2.js";
import { entityId, feature, task, owner, type AskCommand, type AskPorts } from "./policy.js";
import { askBindDigest, liveBind } from "./authorization.js";
import { readAsk, saveAsk, readProposals } from "./storage.js";

export function createAsk(ctx: V2TransactionContext, ports: AskPorts, c: Extract<AskCommand, { type: "ask.create" }>): V2Ask {
  const p = c.payload;
  feature(ctx, ports, p.featureId);
  if (p.taskId !== null) task(ctx, ports, p.taskId, p.featureId);
  if (p.expiresAt <= ctx.scope.now) fail("authorization_expired");
  if (p.bind) liveBind(ctx, ports, p.bind);
  const row = parseAsk({ ...p, teamId: ctx.scope.teamId, projectId: ctx.scope.projectId, id: entityId(ctx, c, "ask"),
    source: "business", state: "open", rev: 1, createdBy: ctx.scope.actor.personId, createdAt: ctx.scope.now,
    answeredBy: null, answeredAt: null, answer: null, decision: null, auditEventSeq: 1 });
  return saveAsk(ctx, ports, c, row, true);
}
export function changeAsk(ctx: V2TransactionContext, ports: AskPorts,
  c: Extract<AskCommand, { type: "ask.answer" | "ask.cancel" | "ask.expire" }>): V2Ask {
  const p = c.payload, old = readAsk(ctx, p.askId);
  feature(ctx, ports, old.featureId);
  if (old.rev !== p.expectedRev) fail("conflict");
  if (askBindDigest(old) !== p.bindDigest) fail("authorization_mismatch");
  if (c.type === "ask.answer") {
    owner(ctx, ports);
    if (old.expiresAt <= ctx.scope.now) fail("authorization_expired");
    if (old.state !== "open") fail("conflict");
    if (readProposals(ctx).some(proposal => proposal.askId === old.id)) {
      const { answer, decision } = c.payload;
      if (decision === "acknowledged" || answer.kind !== "option"
        || answer.optionId !== (decision === "approved" ? "approve" : "reject")) fail("authorization_mismatch");
    }
    if (old.bind && c.payload.decision === "approved") liveBind(ctx, ports, old.bind);
    return saveAsk(ctx, ports, c, { ...old, rev: old.rev + 1, state: "answered",
      answer: c.payload.answer, decision: c.payload.decision, answeredBy: ctx.scope.actor.personId, answeredAt: ctx.scope.now });
  }
  if (old.state === "cancelled" || old.state === "expired") fail("conflict");
  if (c.type === "ask.cancel") owner(ctx, ports);
  else if (ctx.scope.now < old.expiresAt) fail("conflict");
  // The frozen DTO clears answer fields on revocation/expiry; immutable audit retains the prior signed decision.
  return saveAsk(ctx, ports, c, { ...old, rev: old.rev + 1, state: c.type === "ask.cancel" ? "cancelled" : "expired",
    answer: null, decision: null, answeredBy: null, answeredAt: null });
}
