/** Synthetic codec for the N3 injection boundary, NOT an N1C production wire contract.
 * The design freezes routes/authority, but leaves envelope and recovery version fields to N1C.
 */
import { generateKeyPairSync } from "node:crypto";
import { canonicalJson } from "../src/lib/ask-bind.js";
import { array, choice, id, integer, literal, nullable, object, optional, positive, text } from "../src/lib/shared-ledger-contract-schema.js";
import type { SharedLedgerProjectOwner, SharedLedgerProjectScope, SharedLedgerProjectsProtocol } from "../src/lib/shared-ledger-client-projects.js";

export const owner: SharedLedgerProjectOwner = {
  centerId: "fixture-center", baseUrl: "https://center.invalid", teamId: "fixture-team", personId: "fixture-owner",
  instanceId: "fixture-instance", bearer: "fixture-owner-person-bearer", localSubject: "owner:self", kind: "person",
};
export function key() {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
}
export const project = { teamId: owner.teamId, id: "project-b", code: "project-b", name: "Team Project", createdBy: owner.personId,
  createdAt: 1, updatedAt: 2, status: "active" as const, rev: 2 };
const projectSchema = object({ teamId: id, id, code: id, name: text(64, 1), createdBy: nullable(id), createdAt: integer,
  updatedAt: integer, status: choice(["active", "archived"]), rev: positive });
export const invitationCode = "fixture-only-one-time-code";
const scopeSchema = object({ centerId: id, teamId: id, personId: id, instanceId: id,
  projectId: optional(id), operationId: optional(id), targetPersonId: optional(id) });
export function scope(selected: Partial<SharedLedgerProjectScope> = {}): SharedLedgerProjectScope {
  return { centerId: owner.centerId, teamId: owner.teamId, personId: owner.personId, instanceId: owner.instanceId, ...selected };
}
export const envelope = (value: unknown, selected: Partial<SharedLedgerProjectScope> = {}) => ({ fixtureScope: scope(selected), fixtureValue: value });
function parse<T>(schema: (raw: unknown) => T, raw: unknown, expected: SharedLedgerProjectScope): T {
  const response = object({ fixtureScope: scopeSchema, fixtureValue: schema })(raw);
  if (canonicalJson(response.fixtureScope) !== canonicalJson(expected)) throw new Error("fixture scope mismatch");
  return response.fixtureValue;
}
function projectInScope(expected: SharedLedgerProjectScope) {
  return (raw: unknown) => {
    const value = projectSchema(raw);
    if (value.teamId !== expected.teamId || (expected.projectId && value.id !== expected.projectId)) throw new Error("fixture project mismatch");
    return value;
  };
}
const createSchema = object({ operationId: id, name: text(64, 1), id: optional(id) });
const updateSchema = object({ rev: positive, name: optional(text(64, 1)), status: optional(choice(["active", "archived"])) });
const inviteSchema = object({ personId: id });
const recoverSchema = object({ operationId: id, fixtureVersion: positive });
const encode = <T>(schema: (raw: unknown) => T, input: unknown, nonce: string) => ({ fixtureNonce: nonce, fixtureInput: schema(input) });
const receipt = object({ project: projectSchema, operationId: id, fixtureVersion: positive, code: text(512, 1) });
function parsedReceipt(raw: unknown, expected: SharedLedgerProjectScope, input: unknown) {
  const value = parse(receipt, raw, expected);
  projectInScope(expected)(value.project);
  if (value.operationId !== (input as { operationId: string }).operationId
    || (expected.projectId && value.project.id !== expected.projectId)) throw new Error("fixture operation mismatch");
  return value;
}
export const protocol = {
  requests: {
    create: (input: { operationId: string; name: string; id?: string }, _scope: SharedLedgerProjectScope, nonce: string) => encode(createSchema, input, nonce),
    update: (input: { rev: number; name?: string; status?: "active" | "archived" }, _scope: SharedLedgerProjectScope, nonce: string) => encode(updateSchema, input, nonce),
    invite: (input: { personId: string }, _scope: SharedLedgerProjectScope, nonce: string) => encode(inviteSchema, input, nonce),
    remove: (_input: undefined, _scope: SharedLedgerProjectScope, nonce: string) => ({ fixtureNonce: nonce }),
    recover: (input: { operationId: string; fixtureVersion: number }, _scope: SharedLedgerProjectScope, nonce: string) => encode(recoverSchema, input, nonce),
  },
  responses: {
    projects: (raw: unknown, expected: SharedLedgerProjectScope) => parse(array(projectInScope(expected)), raw, expected),
    create: parsedReceipt,
    update: (raw: unknown, expected: SharedLedgerProjectScope) => parse(projectInScope(expected), raw, expected),
    members: (raw: unknown, expected: SharedLedgerProjectScope) => parse(array(object({ personId: id, role: choice(["owner", "member"]),
      status: choice(["invited", "active", "removed"]), addedBy: id, addedAt: integer })), raw, expected),
    invite: (raw: unknown, expected: SharedLedgerProjectScope) => parse(object({ code: text(512, 1) }), raw, expected),
    remove: (raw: unknown, expected: SharedLedgerProjectScope) => parse(object({ status: literal("removed") }), raw, expected),
    operation: (raw: unknown, expected: SharedLedgerProjectScope) => parse(object({ fixtureVersion: positive, project: projectInScope(expected) }), raw, expected),
    recover: parsedReceipt,
  },
  conflict: (raw: unknown, expected: SharedLedgerProjectScope) => parse(object({ current: projectInScope(expected) }), raw, expected).current,
} satisfies SharedLedgerProjectsProtocol;
