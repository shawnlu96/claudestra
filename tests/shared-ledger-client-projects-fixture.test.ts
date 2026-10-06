/** N3 uses only the fixed public producer's fresh synthetic DTOs and parsers.
 * This exercises signed client transport; it does not claim a deployed center or N2/N4 composition.
 */
import { generateKeyPairSync } from "node:crypto";
import { createV2ProjectsFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures.js";
import { parseV2ProjectsRequest, parseV2ProjectsResponse } from "../src/lib/shared-ledger-contract-v2-projects.js";
import type { SharedLedgerProjectOwner, SharedLedgerProjectsProtocol } from "../src/lib/shared-ledger-client-projects.js";

export const fixtures = createV2ProjectsFixtures;
export const protocol = { parseV2ProjectsRequest, parseV2ProjectsResponse } satisfies SharedLedgerProjectsProtocol;
const sample = fixtures();
export const owner: SharedLedgerProjectOwner = {
  centerId: sample.identity.centerId, baseUrl: "https://center.invalid", teamId: sample.identity.teamId,
  personId: sample.person.personId, instanceId: sample.person.instanceId,
  bearer: sample.grant.bearer, localSubject: "owner:self", kind: "person",
};
export const invitationCode = sample.creatorInvite.code;
export const project = sample.project;
export function key() {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
}
