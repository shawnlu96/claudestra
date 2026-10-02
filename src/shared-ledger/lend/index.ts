import { parseCommand } from "../../lib/shared-ledger-contract-v2-commands.js";
import type { V2LendOrder, V2LendLease, V2LendResult } from "../../lib/shared-ledger-contract-v2-lend.js";
import type { V2DomainModule, V2TransactionContext } from "../../lib/shared-ledger-contract-v2-transaction.js";
import { fail } from "../../lib/shared-ledger-contract-v2-validation.js";
import { assertCommand, assertOrderContext, synchronous, type LendCommand, type LendPorts } from "./checks.js";
import { installLendSchema, readLendRow } from "./storage.js";
import { cancelOrder, claimOrder, createOrder, renewOrder } from "./actions.js";
import { resultOrder } from "./results.js";
import { importLendManifest } from "./migration.js";

export interface LendOutcome { order: V2LendOrder; lease?: V2LendLease; result?: V2LendResult; replayed: boolean }
/** X12 registers lendStatements/lendSchema and adds this domain to its single command transaction.
 * Reads, step CAS, event and receipt writes must all use the caller's context and roll back on any throw.
 */
export function createLendDomain(ports: LendPorts): V2DomainModule<LendCommand, LendOutcome> & {
  importInTransaction(context: V2TransactionContext, manifest: unknown): V2LendOrder[];
} {
  return {
    installSchema: installLendSchema,
    applyInTransaction(context, input) {
      const parsed = parseCommand(input);
      if (!parsed.type.startsWith("lend.")) return fail("invalid_field");
      const command = parsed as LendCommand;
      assertCommand(context, command);
      if (command.type === "lend.create") {
        synchronous(ports.authorize(context, command, null));
        return { order: createOrder(context, ports, command), replayed: false };
      }
      const p = command.payload;
      const orderId = "claim" in p ? p.claim.orderId : "result" in p ? p.result.orderId : p.orderId;
      const order = readLendRow(context, "order", orderId);
      if (!order) return fail("not_found");
      assertOrderContext(context, order);
      if (context.scope.actor.instanceId !== order.homeInstanceId) return fail("wrong_home");
      synchronous(ports.authorize(context, command, order));
      switch (command.type) {
        case "lend.claim": return claimOrder(context, ports, command, order);
        case "lend.renew": return renewOrder(context, ports, command, order);
        case "lend.result": return resultOrder(context, ports, command, order);
        case "lend.cancel": return cancelOrder(context, ports, command, order);
      }
    },
    importInTransaction: (context, manifest) => importLendManifest(context, ports, manifest),
  };
}
