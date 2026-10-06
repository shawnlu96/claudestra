import type { Ask } from "../../lib/ledger-asks.js";
import type { CreateAskInput } from "../asks.js";
import type { SharedLedgerBinding } from "../../lib/shared-ledger-gate-bindings.js";
import type { JoinOfferProject } from "../../lib/shared-ledger-join-offer.js";

/** N1–N3 adapters must verify signatures and grants before exposing these secret-free records. */
export interface ProjectPerson {
  subject: "owner:self"; kind: "person"; centerId: string; teamId: string; personId: string; instanceId: string;
}
interface SharedProjectRecord extends JoinOfferProject {
  centerId: string; rev: number; status: "active" | "archived";
}
export type ProjectSelection = { mode: "create" } | { mode: "existing"; localProjectId: string };
export interface ProjectCreate { operationId: string; id?: string; name: string; selection?: ProjectSelection }
export interface CreatorOperation {
  operationId: string; version: number; project: SharedProjectRecord;
}
export interface BootstrapPreflight {
  centerId: string; teamId: string; personId: string; instanceId: string; instanceKeyDigest: string;
  operationId: string; expiresAt: number; summaryDigest: string; ownerCount: number; memberActive: boolean;
}
export interface SharedProjectsPorts {
  now: () => number;
  /** Resolve a signed/verified owner:self person, never from HTTP JSON or service grants. */
  person: () => Promise<ProjectPerson>;
  list: (who: ProjectPerson) => Promise<SharedProjectRecord[]>;
  create: (who: ProjectPerson, input: ProjectCreate) => Promise<CreatorOperation>;
  patch: (who: ProjectPerson, projectId: string, input: { rev: number; name?: string; status?: "active" | "archived" }) => Promise<SharedProjectRecord>;
  /** N3 mints and delivers in memory; output contains no code or response body. */
  invite: (who: ProjectPerson, projectId: string, peers: string[], note?: string) => Promise<{ peer: string; offerId: string; accepted: boolean }[]>;
  operation: (who: ProjectPerson, operationId: string) => Promise<CreatorOperation>;
  /** N3 recovery uses the operation version; N2 validates identity before saving B, without touching A. */
  saveCreatorCredential: (who: ProjectPerson, operation: CreatorOperation) => Promise<void>;
  credentialSaved: (who: ProjectPerson, project: SharedProjectRecord) => Promise<boolean>;
  bind: (who: ProjectPerson, project: SharedProjectRecord, selection: ProjectSelection) => Promise<string>;
  /** Must read B via the real gate proxy, after credential readback and binding. */
  gateRead: (who: ProjectPerson, project: SharedProjectRecord, localProjectId: string) => Promise<boolean>;
  members: (who: ProjectPerson, projectId: string) => Promise<{ personId: string; code: string; role: "owner" | "member"; status: "invited" | "active" | "removed" }[]>;
  remove: (who: ProjectPerson, projectId: string, personId: string) => Promise<void>;
  setDirs: (who: ProjectPerson, projectId: string, localProjectId: string, dirs: string[]) => Promise<void>;
  leave: (who: ProjectPerson, projectId: string, localProjectId: string) => Promise<void>;
  bindings: () => SharedLedgerBinding[];
  eligible: () => Promise<{ id: string; name: string }[]>;
  openAsk: (input: CreateAskInput) => Ask;
  /** Deployment authorization is separate from local owner authority, and cannot come from an agent. */
  deploymentAuthorized: () => Promise<boolean>;
  preflight: (who: ProjectPerson, operationId: string) => Promise<BootstrapPreflight>;
  confirmOwner: (who: ProjectPerson, approved: BootstrapPreflight) => Promise<void>;
}

export class SharedProjectsError extends Error {
  constructor(readonly status: number, readonly code: string, readonly current?: SharedProjectRecord) { super("shared project operation rejected"); }
}
export function requireProjectPerson(who: ProjectPerson): void {
  if (!who || who.subject !== "owner:self" || who.kind !== "person"
    || [who.centerId, who.teamId, who.personId, who.instanceId].some(v => typeof v !== "string" || !v)) {
    throw new SharedProjectsError(403, "person_required");
  }
}
