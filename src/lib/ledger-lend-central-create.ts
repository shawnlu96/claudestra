import {
  fail, parseCommand, parseReceipt, v2ObjectDigest, V2ContractError, type V2Command, type V2Receipt,
} from "./shared-ledger-contract-v2.js";
import type { LendCentralTransport } from "./ledger-lend-central.js";
import type { LendCentralOutbox, LendCentralPending } from "./ledger-lend-central-state.js";

type CreateCommand = Extract<V2Command, { type: "lend.create" }>;
/** S2F2: every lend.create field is supplied complete by the caller (the home's own trusted records: its cached center view,
 * lease fence and grant). This module looks nothing up; it only passes the body through the contract parser. */
export type LendCentralCreateFields = Pick<CreateCommand, "teamId" | "projectId" | "serviceGeneration" | "epoch" | "bootId"> & CreateCommand["payload"];
export type LendCentralCreateOutcome =
  /** orderId is the center's order id (the receipt's entityId); the home row is written under it. */
  | { status: "confirmed"; orderId: string; receipt: V2Receipt; fresh: boolean }
  /** The center could not be reached; the command stays journaled and the next call reconciles it. */
  | { status: "outbox"; requestId: string }
  /** Not a central card (local route), or held (skip: switch off / observe, migrating, port missing): nothing was asked
   * of the center and nothing was written. */
  | { status: "local" | "held" };
type LendCentralCreateTransport = Pick<LendCentralTransport, "receipt" | "command">;
export interface LendCentralCreateDeps {
  transport: LendCentralCreateTransport;
  /** Constructed only once the card routes central, so off / observe / local leave no directory behind. */
  outbox(): LendCentralOutbox;
  /** The frozen route rule (S2D schedulerV2Route, injected); read again before every center request. */
  route(taskId: string): "local" | "skip" | "central";
}

/** Derived only from the home's attempt key (lend:<card>:s<specRev>:r<round>:a<n>): a replay asks under the same id. */
export function lendCreateRequestId(attemptKey: string): string {
  return `lend-create:${v2ObjectDigest(["lend.create", attemptKey])}`;
}
function createCommand(fields: LendCentralCreateFields, requestId: string): CreateCommand {
  const { teamId, projectId, serviceGeneration, epoch, bootId, ...payload } = fields;
  const c = parseCommand({ teamId, projectId, serviceGeneration, epoch, bootId, requestId, type: "lend.create", payload });
  return c.type === "lend.create" ? c : fail();
}
function createReceipt(command: CreateCommand, raw: unknown): V2Receipt {
  const r = parseReceipt(raw);
  if (r.teamId !== command.teamId || r.projectId !== command.projectId || r.requestId !== command.requestId
    || r.command !== "lend.create" || r.commandDigest !== v2ObjectDigest(command)
    || r.serviceGeneration !== command.serviceGeneration || r.result.epoch !== command.epoch) return fail("dedup_mismatch");
  return r;
}
/** The journaled command is the one the center may already hold: an attempt key never changes card, step or round. */
function journaled(entry: LendCentralPending, requestId: string, fields: LendCentralCreateFields): CreateCommand {
  const c = entry.command;
  if (c.type !== "lend.create" || c.requestId !== requestId) return fail("dedup_mismatch");
  const p = c.payload;
  if (c.teamId !== fields.teamId || c.projectId !== fields.projectId || p.taskId !== fields.taskId || p.featureId !== fields.featureId
    || p.step !== fields.step || p.round !== fields.round || p.family !== fields.family) return fail("dedup_mismatch");
  return c;
}

/**
 * Creates the center order for one home lend attempt, at most once. Only a card on the central route (execution + switch on)
 * reaches the center; any other route returns before the outbox or the transport is touched.
 * Order of work under the attempt's outbox lock: journaled receipt → the center's receipt for the derived requestId → only
 * then the command, sent once. A crash between sending and recording therefore resolves by receipt lookup and never issues
 * a second command body; the center dedups the requestId, so one attempt key maps to one center order.
 * A refusal by the center drops the journal entry (no order exists; a later call builds a current command).
 */
export async function createLendCentralOrder(attemptKey: string, fields: LendCentralCreateFields,
  deps: LendCentralCreateDeps): Promise<LendCentralCreateOutcome> {
  if (!attemptKey) return fail("invalid_field");
  const first = deps.route(fields.taskId);
  if (first !== "central") return { status: first === "local" ? "local" : "held" };
  const requestId = lendCreateRequestId(attemptKey), outbox = deps.outbox();
  // The switch or the release entry may be withdrawn while this call waits on its lock or on the center.
  const admitted = () => { if (deps.route(fields.taskId) !== "central") fail("unavailable"); };
  const transport: LendCentralCreateTransport = {
    receipt: id => { admitted(); return deps.transport.receipt(id); },
    command: c => { admitted(); return deps.transport.command(c); },
  };
  return outbox.exclusive(requestId, async held => {
    const old = outbox.read(requestId);
    const entry: LendCentralPending = old ?? { inputDigest: v2ObjectDigest(fields), input: structuredClone(fields),
      command: createCommand(fields, requestId), receipt: null };
    const command = old ? journaled(old, requestId, fields) : createCommand(fields, requestId);
    const confirmed = (receipt: V2Receipt, fresh: boolean): LendCentralCreateOutcome =>
      ({ status: "confirmed", orderId: receipt.result.entityId, receipt, fresh });
    if (entry.receipt) return confirmed(createReceipt(command, entry.receipt), false);
    const record = (raw: unknown): V2Receipt => {
      const receipt = createReceipt(command, raw);
      entry.receipt = receipt;
      held(); outbox.save(requestId, entry);
      return receipt;
    };
    try {
      if (old) {
        const found = await transport.receipt(requestId);
        if (found !== null) return confirmed(record(found), false);
      } else { held(); outbox.save(requestId, entry); }
    } catch (error) {
      if (error instanceof V2ContractError && error.code === "unavailable") return { status: "outbox", requestId };
      throw error;
    }
    let raw: unknown;
    held();
    try {
      raw = await transport.command(command);
    } catch (error) {
      if (!(error instanceof V2ContractError)) throw error;
      if (error.code === "unavailable") return { status: "outbox", requestId };
      // The center answered with a refusal, so no order exists under this id. A dedup mismatch is the exception:
      // the center holds another body under it, and the journal stays as evidence.
      if (error.code !== "dedup_mismatch") { held(); outbox.remove(requestId); }
      throw error;
    }
    return confirmed(record(raw), true);
  });
}

/** The center order id already journaled for an attempt, without asking the center; null = no confirmed create. */
export function createdLendCentralOrderId(attemptKey: string, outbox: LendCentralOutbox): string | null {
  const requestId = lendCreateRequestId(attemptKey), entry = outbox.read(requestId);
  if (!entry || entry.receipt === null) return null;
  const c = entry.command;
  if (c.type !== "lend.create" || c.requestId !== requestId) return fail("dedup_mismatch");
  return createReceipt(c, entry.receipt).result.entityId;
}
