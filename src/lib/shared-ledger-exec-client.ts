import {
  fail, id, object, parseAsk, parseCommand, parseReceipt, scope, V2ContractError, v2ObjectDigest,
  type V2Actor, type V2Ask, type V2Command, type V2Receipt,
} from "./shared-ledger-contract-v2.js";
import { SharedLedgerExecGate, type ExecIdentity } from "./shared-ledger-exec-gate.js";

type Command<K extends V2Command["type"]> = Extract<V2Command, { type: K }>;
const askQuery = object({ ...scope, askId: id });
interface ExecReceiptQuery {
  teamId: string; projectId: string; requestId: string; operationId: string | null; commandDigest: string;
}
/** Adapter methods are authenticated center calls. null means an authoritative not-found, never a transport failure.
 * operationId narrows the lookup, but requestId/digest still identify each command (one operation has several commands).
 * The actor is verified context for signing/audit, not a body field. The center must independently authenticate it.
 */
export interface ExecTransport {
  receipt(query: ExecReceiptQuery, actor: V2Actor): Promise<unknown | null>;
  submit(command: V2Command, actor: V2Actor): Promise<unknown>;
  ask(query: { teamId: string; projectId: string; askId: string }, actor: V2Actor): Promise<unknown>;
}
export function execOperationId(command: V2Command): string | null {
  const p = command.payload;
  return "operationId" in p ? p.operationId : "result" in p ? p.result.operationId : null;
}
function matchingReceipt(raw: unknown, command: V2Command, identity: ExecIdentity): V2Receipt {
  const r = parseReceipt(raw);
  if (r.teamId !== command.teamId || r.projectId !== command.projectId || r.requestId !== command.requestId
    || r.command !== command.type || r.commandDigest !== v2ObjectDigest(command)
    || r.personId !== identity.actor.personId || r.instanceId !== identity.actor.instanceId
    || r.result.operationId !== execOperationId(command)) fail("dedup_mismatch");
  if (r.serviceGeneration !== command.serviceGeneration) fail("stale_generation");
  if (r.result.epoch !== command.epoch) fail("stale_epoch");
  return r;
}
/** Only center-confirmed receipts are successes. There is no local executor, approval cache, auto retry or queue. */
export class SharedLedgerExecClient {
  private lastSuccess: number | null = null;
  private available: boolean | null = null;
  private readonly asks = new Map<string, { value: V2Ask; lastSuccessAt: number }>();
  constructor(private readonly gate: SharedLedgerExecGate, private readonly transport: ExecTransport,
    private readonly now: () => number = Date.now) {}
  status(): { available: boolean | null; lastSuccessAt: number | null } {
    return { available: this.available, lastSuccessAt: this.lastSuccess };
  }
  private async online<T>(action: () => Promise<T>): Promise<T> {
    try {
      const value = await action();
      this.lastSuccess = this.now(); this.available = true;
      return value;
    } catch (error) {
      if (error instanceof V2ContractError && error.status < 500) {
        if ([401, 403].includes(error.status)) this.asks.clear();
        throw error;
      }
      this.available = false;
      fail("unavailable");
    }
  }
  async command(input: V2Command): Promise<V2Receipt> {
    const command = parseCommand(input);
    const identity = this.gate.authorize(command);
    const query: ExecReceiptQuery = { teamId: command.teamId, projectId: command.projectId,
      requestId: command.requestId, operationId: execOperationId(command), commandDigest: v2ObjectDigest(command) };
    // Always query, even in a fresh process: a prior send may have committed before losing its response.
    const prior = await this.online(async () => {
      const raw = await this.transport.receipt(query, structuredClone(identity.actor));
      return raw === null ? null : matchingReceipt(raw, command, identity);
    });
    const current = this.gate.authorize(command);
    if (v2ObjectDigest(current) !== v2ObjectDigest(identity)) fail("unauthenticated");
    if (prior) {
      // A historical authorization check is evidence, never a reusable live grant. Ask again with a new request id.
      if (command.type === "authorization.check") fail("replayed");
      return prior;
    }
    return this.online(async () => matchingReceipt(
      await this.transport.submit(structuredClone(command), structuredClone(current.actor)), command, current));
  }
  createAsk(command: Command<"ask.create">): Promise<V2Receipt> { return this.askCommand("ask.create", command); }
  answerAsk(command: Command<"ask.answer">): Promise<V2Receipt> { return this.askCommand("ask.answer", command); }
  cancelAsk(command: Command<"ask.cancel">): Promise<V2Receipt> { return this.askCommand("ask.cancel", command); }
  expireAsk(command: Command<"ask.expire">): Promise<V2Receipt> { return this.askCommand("ask.expire", command); }
  checkAuthorization(command: Command<"authorization.check">): Promise<V2Receipt> { return this.askCommand("authorization.check", command); }
  private askCommand(type: V2Command["type"], command: V2Command): Promise<V2Receipt> {
    if (command.type !== type) fail("invalid_field");
    return this.command(command);
  }
  async queryAsk(input: { teamId: string; projectId: string; askId: string }): Promise<V2Ask> {
    const query = askQuery(input);
    const identity = this.gate.identity(query.teamId, query.projectId);
    // X0 has no read-action DTO: service reads are restricted to the same ask capability as creation.
    if (identity.actor.kind === "service" && !identity.actor.actions.includes("ask.create")) fail("forbidden");
    const value = await this.online(async () => {
      const value = parseAsk(await this.transport.ask(query, structuredClone(identity.actor)));
      if (value.teamId !== query.teamId || value.projectId !== query.projectId || value.id !== query.askId) fail("forbidden");
      if (v2ObjectDigest(this.gate.identity(query.teamId, query.projectId)) !== v2ObjectDigest(identity)) fail("unauthenticated");
      return value;
    });
    this.asks.set(this.cacheKey(identity, query.askId), { value: structuredClone(value), lastSuccessAt: this.lastSuccess! });
    return value;
  }
  /** Explicit display-only API: queryAsk/checkAuthorization never fall back here, even if the cached ask says approved. */
  cachedAsk(input: { teamId: string; projectId: string; askId: string }) {
    const query = askQuery(input);
    const identity = this.gate.identity(query.teamId, query.projectId);
    const entry = this.asks.get(this.cacheKey(identity, query.askId));
    return entry ? { ...structuredClone(entry), displayOnly: true as const, authoritative: false as const, stale: true as const } : null;
  }
  private cacheKey(identity: ExecIdentity, askId: string): string {
    return v2ObjectDigest({ identity, askId });
  }
}
