/** peer-MIGASK1 · forwarding the owner's answer to a migration authorization card. The bridge injects one port: the same
 * owner-Principal transport its V2 ask answers already sign with (Stage2Wiring.transportFor, OWNER_PRINCIPAL); nothing here
 * resolves a credential. Only the owner answers (a PM, service, guest or agent is refused before any center call), only
 * approve / reject options count, an expired card forwards nothing, and a center refusal surfaces unchanged with the local
 * card left open. The local answer is written after the center confirmed it, for display only.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  array, digest, fail, id, integer, literal, object, parseCommand, positive, scope, v2ObjectDigest, V2_MIGRATION_FEATURE_IDS_MAX,
  type V2Ask,
} from "./shared-ledger-contract-v2.js";
import { answerAsk, type Ask, type AskVia } from "./ledger-asks.js";
import type { Stage2Transport } from "./shared-ledger-v2-transport.js";

export const MIGRATION_APPROVE = "approve";
export const MIGRATION_REJECT = "reject";
const parseRecord = object({
  ...scope, centerAskId: id, centerFeatureId: id, batchId: id, featureIds: array(id, V2_MIGRATION_FEATURE_IDS_MAX), actionDigest: digest,
  fence: object({ serviceGeneration: positive, epoch: integer, bootId: id }), displayOnly: literal(true), authoritative: literal(false),
});
export type MigrationAskRecord = ReturnType<typeof parseRecord>;

/** A malformed record fails closed (throws) instead of letting the card be answered locally. */
export function migrationAskRecord(a: Pick<Ask, "kind" | "extra">): MigrationAskRecord | null {
  return a.kind === "authorize" && Object.hasOwn(a.extra, "migrationAsk") ? parseRecord(a.extra.migrationAsk) : null;
}

export interface MigrationAskPort { transportFor(project: string): Pick<Stage2Transport, "scope" | "call" | "ask"> | null }
let port: MigrationAskPort | null = null;
/** Bridge wiring only; null (no center credential) makes every migration answer unavailable, never a local approval. */
export function configureMigrationAsks(value: MigrationAskPort | null): void { port = value; }

export interface MigrationAnswerInput {
  ask: Ask; picks: { wire: string; label: string }[]; text: string;
  /** From the bridge's authenticated entry (isOwnerSource), never from the request body. */
  owner: boolean; principal: string; device?: string; via: AskVia; now?: number;
}
function decisionOf(picks: MigrationAnswerInput["picks"]): "approved" | "rejected" {
  const wire = picks.length === 1 ? picks[0]!.wire : null;
  if (wire === `[button:${MIGRATION_APPROVE}]`) return "approved";
  return wire === `[button:${MIGRATION_REJECT}]` ? "rejected" : fail("invalid_field");
}
/** The center's current view of the ask must still be the one this card was opened for. */
function assertSameAsk(center: V2Ask, r: MigrationAskRecord): void {
  if (center.state === "expired") fail("authorization_expired");
  if (center.state !== "open") fail("conflict");
  if (center.kind !== "authorize" || center.taskId !== null || center.featureId !== r.centerFeatureId
    || center.bind?.actionDigest !== r.actionDigest || !center.bind.actions.includes("migration")) fail("authorization_mismatch");
}

/** Owner answer → center ask.answer → local display answer. Throws V2ContractError (the bridge maps it to 403 / 409 / 503). */
export async function answerMigrationAsk(input: MigrationAnswerInput, db: Database): Promise<Ask> {
  const r = migrationAskRecord(input.ask) ?? fail("invalid_field"), now = input.now ?? Date.now();
  if (!input.owner) fail("forbidden");
  if (input.ask.state !== "open") fail("conflict");
  if (input.ask.expiresAt <= now) fail("authorization_expired");
  const decision = decisionOf(input.picks);
  const transport = port?.transportFor(input.ask.project) ?? fail("unavailable");
  if (transport.scope.teamId !== r.teamId || transport.scope.projectId !== r.projectId) fail("forbidden");
  const center = await transport.ask(r.centerAskId);
  assertSameAsk(center, r);
  await transport.call("commands", {}, parseCommand({ teamId: r.teamId, projectId: r.projectId, ...r.fence,
    requestId: `migration-answer-${randomUUID()}`, type: "ask.answer", payload: { askId: r.centerAskId, expectedRev: center.rev,
      bindDigest: v2ObjectDigest(center.bind), answer: { kind: "option", optionId: decision === "approved" ? MIGRATION_APPROVE : MIGRATION_REJECT },
      decision } }));
  return answerAsk(db, input.ask.id, { choices: input.picks.map(p => p.wire), labels: input.picks.map(p => p.label), text: input.text,
    principal: input.principal, ...(input.device ? { device: input.device } : {}), via: input.via, at: now, final: true, owner: true });
}
