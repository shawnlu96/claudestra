import {
  assertTransactionContext, parseCommand, fail, type V2DomainModule, type V2Ask, type V2Proposal,
} from "../../lib/shared-ledger-contract-v2.js";
import { asksSchema } from "./schema.js";
import { gate, type AskCommand, type AskPorts } from "./policy.js";
import { createAsk, changeAsk } from "./lifecycle.js";
import { checkAuthorization } from "./authorization.js";
import { propose, decide, closeProposal } from "./proposals.js";

export { asksSchema, asksStatements } from "./schema.js";
export { readAsk, readAsks, readProposals, readAskAudit } from "./storage.js";
export { authorizationDigest, askBindDigest } from "./authorization.js";
export { proposalDigest } from "./proposals.js";
export type { AskCommand, AskPorts } from "./policy.js";
export interface AskOutcome { ask: V2Ask; proposal?: V2Proposal; authorizationDigest?: string }
/** X12 owns the transaction, shared sequence, request deduplication/receipt and live identity/fence checks. */
export function createAsksDomain(ports: AskPorts): V2DomainModule<AskCommand, AskOutcome> {
  return {
    installSchema(ctx) { for (const name of Object.keys(asksSchema)) ctx.install(name); },
    applyInTransaction(ctx, input) {
      assertTransactionContext(ctx);
      const command = parseCommand(input);
      if (!["ask.create", "ask.answer", "ask.cancel", "ask.expire", "authorization.check", "dag.propose", "dag.decide"].includes(command.type)) fail();
      const c = command as AskCommand;
      gate(ctx, ports, c);
      if (c.type === "ask.create") return { ask: createAsk(ctx, ports, c) };
      if (c.type === "authorization.check") return checkAuthorization(ctx, ports, c);
      if (c.type === "dag.propose") return propose(ctx, ports, c);
      if (c.type === "dag.decide") return decide(ctx, ports, c);
      const ask = changeAsk(ctx, ports, c);
      closeProposal(ctx, ports, c, ask);
      return { ask };
    },
  };
}
