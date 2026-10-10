/** S2T · V2 signed transport (§2.2 frozen export `createStage2Transport(conn)`): adapters for X7 `ExecTransport`,
 * X9 `LendCentralTransport`, X8 `SchedulerCentralClient`, plus snapshot / migration / revert reads and writes.
 * Every call is one signed attempt over the S2K `V2_ROUTES` (see `shared-ledger-v2-transport-wire.ts`); nothing is cached,
 * retried or queued here — idempotency is the callers' receipt lookups. The actor handed to X7 adapters is checked against the
 * signing credential and never sent: the center derives identity from the signature, the body never carries actor / role.
 */
import {
  fail, parseActor, parseCommand, v2ObjectDigest, type V2Actor, type V2Command, type V2Receipt,
} from "./shared-ledger-contract-v2.js";
import type { ExecTransport } from "./shared-ledger-exec-client.js";
import { execOperationId } from "./shared-ledger-exec-client.js";
import type { LendCentralTransport } from "./ledger-lend-central.js";
import type { SchedulerCentralClient } from "./scheduler-central-context.js";
import { sharedLedgerCenterUrl } from "./shared-ledger-client-transport.js";
import {
  callStage2Route, type Stage2Connection, type Stage2RouteBody, type Stage2RouteParams, type Stage2RouteResult,
} from "./shared-ledger-v2-transport-wire.js";
import type { V2RouteName } from "./shared-ledger-contract-v2-routes.js";

export type { Stage2Connection } from "./shared-ledger-v2-transport-wire.js";
type ReceiptQuery = { teamId: string; projectId: string; requestId: string; operationId: string | null; commandDigest: string };
type Stage2ReceiptLookup = Stage2RouteResult<"receipts">;
/** X9 only passes a requestId; the receipt route needs the command digest, so the caller resolves its own journaled command. */
type LendCommandLookup = (requestId: string) => V2Command | null;

export interface Stage2Transport {
  readonly scope: { teamId: string; projectId: string };
  /** Generic signed call over one S2K route (scope comes from the connection). */
  call<N extends V2RouteName>(name: N, params: Stage2RouteParams<N>, body?: unknown): Promise<Stage2RouteResult<N>>;
  /** X7 adapter: null from receipt = authoritative status "unknown", never a transport failure. */
  exec: ExecTransport;
  /** X9 adapter for one project; `commandOf` resolves a requestId to the journaled command (outbox), or null. */
  lend(commandOf: LendCommandLookup): LendCentralTransport;
  /** X8 adapter: one POST commands per call, a fresh authenticated round trip each time. */
  scheduler: SchedulerCentralClient;
  snapshot(featureId: string): Promise<Stage2RouteResult<"features">>;
  receipt(query: Omit<ReceiptQuery, "teamId" | "projectId">): Promise<Stage2ReceiptLookup>;
  ask(askId: string): Promise<Stage2RouteResult<"asks">>;
  migrate(body: Stage2RouteBody<"migrations">): Promise<Stage2RouteResult<"migrations">>;
  migration(batchId: string): Promise<Stage2RouteResult<"migration">>;
  revert(body: Stage2RouteBody<"reverts">): Promise<Stage2RouteResult<"reverts">>;
  revertStatus(batchId: string): Promise<Stage2RouteResult<"revert">>;
}

/** The verified actor must be the identity the request is signed with; anything else is refused before any request. */
function signer(conn: Stage2Connection, raw: V2Actor, projectId: string): void {
  const actor = parseActor(structuredClone(raw)), c = conn.connection;
  if (actor.instanceId !== c.instanceId || (actor.kind === "person" && actor.personId !== c.personId)) fail("unauthenticated");
  if (projectId !== conn.projectId || !actor.projects.includes(projectId)) fail("forbidden");
}
const committed = (l: Stage2ReceiptLookup): V2Receipt | null => l.status === "committed" ? l.receipt : null;

export function createStage2Transport(conn: Stage2Connection): Stage2Transport {
  sharedLedgerCenterUrl(conn.connection.baseUrl); // configuration errors surface at construction, not as unavailable
  const scope = { teamId: conn.connection.teamId, projectId: conn.projectId };
  const call = <N extends V2RouteName>(name: N, params: Stage2RouteParams<N>, body?: unknown) =>
    callStage2Route(conn, name, params, body);
  const inScope = (q: { teamId: string; projectId: string }) => {
    if (q.teamId !== scope.teamId || q.projectId !== scope.projectId) fail("forbidden");
  };
  const receipt = (q: Omit<ReceiptQuery, "teamId" | "projectId">) =>
    call("receipts", { requestId: q.requestId, operationId: q.operationId, commandDigest: q.commandDigest });
  const submit = async (command: V2Command): Promise<V2Receipt> => {
    inScope(command);
    return call("commands", {}, command);
  };

  const exec: ExecTransport = {
    async receipt(query, actor) {
      inScope(query); signer(conn, actor, query.projectId);
      return committed(await receipt(query));
    },
    async submit(command, actor) {
      inScope(command); signer(conn, actor, command.projectId);
      return submit(command);
    },
    async ask(query, actor) {
      inScope(query); signer(conn, actor, query.projectId);
      return call("asks", { askId: query.askId });
    },
  };

  const lend = (commandOf: LendCommandLookup): LendCentralTransport => ({
    async receipt(requestId) {
      const found = commandOf(requestId);
      if (found === null) return fail("unknown_operation");
      const command = parseCommand(structuredClone(found));
      if (command.requestId !== requestId) return fail("dedup_mismatch");
      inScope(command);
      return committed(await receipt({ requestId, operationId: execOperationId(command), commandDigest: v2ObjectDigest(command) }));
    },
    view: orderId => call("lend", { orderId }),
    command: submit,
  });

  return {
    scope, call, exec, lend,
    scheduler: { command: command => submit(command) },
    snapshot: featureId => call("features", { featureId }),
    receipt,
    ask: askId => call("asks", { askId }),
    migrate: body => call("migrations", {}, body),
    migration: batchId => call("migration", { batchId }),
    revert: body => call("reverts", {}, body),
    revertStatus: batchId => call("revert", { batchId }),
  };
}
