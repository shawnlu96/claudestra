/**
 * Reviewer / PM identity on body records (team-project-TEAMVIS12), word for word the center's (TEAMVIS11B «PM 定» 1):
 * `{memberCode, instanceId?}` or `{instanceId}`, every value an `id`. The home sends `{instanceId}` only; the center
 * looks the member code up in its write transaction and members read back `{memberCode, instanceId}`.
 * A review record's meta may carry `reviewer`; a spec record's meta is exactly `{pm}`. tests/team-body-roles-contract.test.ts.
 */
import { id, object, optional, record, type Schema } from "./shared-ledger-contract-schema.js";

export type TeamBodyIdentity = { memberCode: string; instanceId?: string } | { instanceId: string };
/** The only meta a spec record carries; the `never` keys keep event-meta reads on a record's meta well typed. */
export interface TeamBodySpecMeta { pm: TeamBodyIdentity; kind?: never; ts?: never; stageTo?: never; reviewer?: never }

const withCode = object({ memberCode: id, instanceId: optional(id) });
const instanceOnly = object({ instanceId: id });
/** Two shapes only: an empty object, an extra key, both keys missing or a value outside `id` are invalid. */
export const teamBodyIdentity: Schema<TeamBodyIdentity> = (value) => Object.hasOwn(record(value), "memberCode") ? withCode(value) : instanceOnly(value);

const specShape = object({ pm: teamBodyIdentity });
export const teamBodySpecMeta: Schema<TeamBodySpecMeta> = (value) => specShape(value) as TeamBodySpecMeta;

/** The identity when it passes the schema, else undefined: a sender drops the key, never the record. */
export function checkedIdentity(value: unknown): TeamBodyIdentity | undefined {
  try { return teamBodyIdentity(value); } catch { return undefined; }
}
