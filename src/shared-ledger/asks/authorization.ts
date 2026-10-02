import {
  fail, parseAuthorizationBind, v2ObjectDigest, type V2Ask, type V2AuthorizationBind, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { feature, task, workflow, type AskCommand, type AskPorts } from "./policy.js";
import { readAsk } from "./storage.js";

export function authorizationDigest(bind: V2AuthorizationBind): string {
  return v2ObjectDigest(parseAuthorizationBind(bind));
}
/** Non-authorization asks still CAS the explicit null bind, never an arbitrary caller digest. */
export function askBindDigest(ask: V2Ask): string { return v2ObjectDigest(ask.bind); }
export function liveBind(ctx: V2TransactionContext, ports: AskPorts, bind: V2AuthorizationBind): void {
  const f = feature(ctx, ports, bind.featureId);
  if (bind.expiresAt <= ctx.scope.now) fail("authorization_expired");
  if (bind.baseVersion !== f.currentVersion || bind.homeInstanceId !== f.homeInstanceId) fail("authorization_mismatch");
  if (bind.taskId === null) {
    if (bind.taskRev !== null || bind.specRev !== null || bind.workflowRev !== null || bind.head !== null) fail("authorization_mismatch");
    return;
  }
  const t = task(ctx, ports, bind.taskId, bind.featureId), w = workflow(ctx, ports, t);
  // Sharing authorizes a new copy: X3 verifies that copy's digest, which need not already be the task's shared copy.
  const sharing = bind.actions.every(action => action === "artifact.share");
  if (bind.taskRev !== t.rev || bind.specRev !== t.specRev || bind.workflowRev !== w.rev || (!sharing && bind.head !== t.head)
    || bind.homeInstanceId !== t.homeInstanceId || (!sharing && bind.originalDigest !== t.spec.originalDigest)
    || (!sharing && bind.sharedDigest !== t.spec.sharedDigest) || (sharing && bind.head !== null && bind.head !== t.head)) fail("authorization_mismatch");
}
export function approvedAsk(ctx: V2TransactionContext, ports: AskPorts, id: string): V2Ask {
  const ask = readAsk(ctx, id);
  if (ask.state === "expired" || ask.expiresAt <= ctx.scope.now) fail("authorization_expired");
  if (ask.kind !== "authorize" || ask.state !== "answered" || ask.decision !== "approved" || !ask.bind
    || !ask.answeredBy || ports.isOwner(ctx, ask.answeredBy) !== true) fail("authorization_mismatch");
  return ask;
}
export function checkAuthorization(ctx: V2TransactionContext, ports: AskPorts, c: Extract<AskCommand, { type: "authorization.check" }>) {
  const p = c.payload, ask = approvedAsk(ctx, ports, p.askId), bind = ask.bind!;
  if (authorizationDigest(bind) !== authorizationDigest(p.bind) || !bind.actions.some(a => a === p.action)
    || bind.taskId !== p.taskId || bind.taskRev !== p.expectedRev || bind.specRev !== p.expectedSpecRev
    || bind.workflowRev !== p.expectedWorkflowRev) fail("authorization_mismatch");
  liveBind(ctx, ports, bind);
  return { ask, authorizationDigest: authorizationDigest(bind) };
}
