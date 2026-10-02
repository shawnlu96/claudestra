import {
  assertTransactionContext, fail, parseAsk, parseProposal,
  type V2Ask, type V2Proposal, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { event, type AskCommand, type AskPorts } from "./policy.js";

export function readAsk(ctx: V2TransactionContext, id: string): V2Ask {
  assertTransactionContext(ctx);
  const row = ctx.all("asks.get", { id })[0] as { body: string } | undefined;
  return row ? parseAsk(JSON.parse(row.body)) : fail("not_found");
}
export function readAsks(ctx: V2TransactionContext): V2Ask[] {
  assertTransactionContext(ctx);
  return (ctx.all("asks.list") as { body: string }[]).map(row => parseAsk(JSON.parse(row.body)));
}
export function readProposals(ctx: V2TransactionContext): V2Proposal[] {
  assertTransactionContext(ctx);
  return (ctx.all("asks.proposal.list") as { body: string }[]).map(row => parseProposal(JSON.parse(row.body)));
}
export function readAskAudit(ctx: V2TransactionContext, entityId: string) {
  assertTransactionContext(ctx);
  return ctx.all("asks.audit.list", { entityId });
}
export function audit(ctx: V2TransactionContext, row: V2Ask | V2Proposal, eventSeq: number): void {
  ctx.run("asks.audit.insert", { entityId: row.id, rev: row.rev, eventSeq, actor: JSON.stringify(ctx.scope.actor), body: JSON.stringify(row) });
}
export function saveAsk(ctx: V2TransactionContext, ports: AskPorts, command: AskCommand, value: V2Ask, insert = false): V2Ask {
  const valid = parseAsk(value);
  const summary = command.type === "ask.cancel" ? command.payload.reason : valid.state;
  const row = parseAsk({ ...valid, auditEventSeq: event(ctx, ports, command, valid.id, "ask", summary) });
  const bindings = { id: row.id, rev: row.rev, body: JSON.stringify(row) };
  const changes = insert ? ctx.run("asks.insert", { ...bindings, featureId: row.featureId })
    : ctx.run("asks.update", { ...bindings, expectedRev: row.rev - 1 });
  if (changes !== 1) fail("conflict");
  audit(ctx, row, row.auditEventSeq); return row;
}
