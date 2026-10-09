import type { Principal } from "../lib/principals.js";
import type { SharedLedgerExecClient } from "../lib/shared-ledger-exec-client.js";
import { V2ContractError, type V2Command, type V2Fence, type V2Receipt } from "../lib/shared-ledger-contract-v2.js";
import type { VerifiedCall } from "../lib/order-tool-route.js";

export type EntrySwitch = "off" | "observe" | "on";
type EntryCommandRoute = "local" | "central" | { route: "skip"; reason: "migrating" | "v2_unmapped" | "unavailable" };
export interface EntryReceiptQuery {
  teamId: string; projectId: string; requestId: string; operationId: string | null; commandDigest: string;
}
type Command<K extends V2Command["type"]> = Extract<V2Command, { type: K }>;
export type EntryTool = "start_node" | "deliver" | "submit_verdict";
/** S2F resolves credentials, current orders, CAS versions and artifact ids from authenticated local records.
 * Wire paths and worker assertions never supply identity, a fence, a lease or an artifact id.
 */
export interface EntryToolContext {
  principal: Principal;
  project: string;
  /** Durable operation key from the local intent record, retained across session restart and partial completion. */
  requestKey: string;
  scope: { teamId: string; projectId: string } & V2Fence;
  task?: { id: string; rev: number; specRev: number; workflowRev: number; round: number; head: string | null };
  order?: { id: string | null; leaseGen: number | null };
  artifactIds?: string[];
  /** S2F checks the stored branch on origin and its unique open main-base PR before returning these facts. */
  delivery?: { head: string; pr: string };
  reportArtifactId?: string;
  start?: { featureId: string; expectedRev: number; baseVersion: number; nodeKey: string; payload: Command<"task.new">["payload"] };
}
export interface SharedExecEntryPort {
  mode(project: string): EntrySwitch;
  clientFor(principal: Principal, project: string): Pick<SharedLedgerExecClient, "command" | "queryAsk"> | null;
  snapshot(principal: Principal, project: string, featureId: string): Promise<unknown>;
  receipt(principal: Principal, query: EntryReceiptQuery): Promise<unknown>;
  scopeFor?(principal: Principal, project: string): { teamId: string; projectId: string } | null;
  route?(taskId: string): "local" | "skip" | "central";
  featureRoute?(featureId: string): "local" | "skip" | "central";
  commandRoute?(principal: Principal, project: string, command: V2Command): EntryCommandRoute;
  holdReason?(id: string): "migrating" | "v2_unmapped" | null;
  toolContext?(call: VerifiedCall, tool: EntryTool, target: string, wire: unknown): Promise<EntryToolContext | null>;
}
let port: SharedExecEntryPort | null = null;
/** null and an unconfigured process both mean no execution authority. */
export function configureSharedExecEntry(value: SharedExecEntryPort | null): void { port = value; }
export function sharedExecEntryPort(): SharedExecEntryPort | null { return port; }
export class SharedExecEntryError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export function requireSharedExecEntry(project: string, write = false): SharedExecEntryPort {
  if (!port || port.mode(project) === "off") throw new SharedExecEntryError(503, "unavailable");
  if (write && port.mode(project) !== "on") throw new SharedExecEntryError(403, "execution_not_shared");
  return port;
}
/** Fixed errors exclude transport messages, tokens, paths and arbitrary center response text. */
export function sharedExecEntryFailure(error: unknown): { status: number; code: string } {
  if (error instanceof SharedExecEntryError || error instanceof V2ContractError) return { status: error.status, code: error.code };
  console.warn("shared execution entry failed");
  return { status: 503, code: "unavailable" };
}
export async function sharedExecCommand(principal: Principal, project: string, command: V2Command): Promise<V2Receipt> {
  const p = requireSharedExecEntry(project, true);
  const client = p.clientFor(principal, project);
  if (!client) throw new SharedExecEntryError(503, "unavailable");
  return client.command(command);
}
