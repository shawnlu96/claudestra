import type { Ask } from "../../lib/ledger-asks.js";
import type { CreateAskInput } from "../asks.js";
import type { SharedLedgerBinding } from "../../lib/shared-ledger-gate-bindings.js";
import type { V2ProjectRecord, V2ProjectMember, V2ProjectOperation } from "../../lib/shared-ledger-contract-v2-projects.js";

/** N1–N3 adapters must verify signatures and grants before exposing these secret-free records. */
export interface ProjectPerson {
  subject: "owner:self"; kind: "person"; centerId: string; teamId: string; personId: string; instanceId: string; sourceBinding?: SharedLedgerBinding;
}
type SharedProjectRecord = V2ProjectRecord;
export type ProjectSelection = { mode: "create" } | { mode: "existing"; localProjectId: string };
export interface ProjectCreate { operationId: string; id?: string; name: string; selection?: ProjectSelection }
export interface CreatorOperation {
  operation: V2ProjectOperation; project: SharedProjectRecord;
}
export interface BootstrapPreflight {
  centerId: string; teamId: string; personId: string; instanceId: string; instanceKeyDigest: string;
  operationId: string; expiresAt: number; summaryDigest: string; ownerCount: number; memberActive: boolean;
}
export interface SharedProjectsPorts {
  now: () => number;
  /** Resolve the authenticated owner’s original person credential, never HTTP JSON or a service grant. */
  person: () => Promise<ProjectPerson>;
  list: (who: ProjectPerson) => Promise<SharedProjectRecord[]>;
  create: (who: ProjectPerson, input: ProjectCreate) => Promise<CreatorOperation>;
  patch: (who: ProjectPerson, projectId: string, input: { rev: number; name?: string; status?: "active" | "archived" }) => Promise<SharedProjectRecord>;
  /** N3 mints and delivers in memory; output contains no code or response body. */
  invite: (who: ProjectPerson, projectId: string, peers: string[], note?: string) => Promise<{ peer: string; offerId: string; accepted: boolean }[]>;
  operation: (who: ProjectPerson, operationId: string) => Promise<CreatorOperation>;
  /** N3 obtains a creator invite in memory; N2 alone redeems and atomically saves the selected project and credential. */
  enrollCreator: (who: ProjectPerson, operation: CreatorOperation, selection: ProjectSelection) => Promise<string>;
  credentialSaved: (who: ProjectPerson, project: SharedProjectRecord) => Promise<boolean>;
  /** Must read B via the real gate proxy, after credential readback and binding. */
  gateRead: (who: ProjectPerson, project: SharedProjectRecord, localProjectId: string) => Promise<boolean>;
  members: (who: ProjectPerson, projectId: string) => Promise<V2ProjectMember[]>;
  remove: (who: ProjectPerson, projectId: string, personId: string) => Promise<void>;
  setDirs: (who: ProjectPerson, projectId: string, localProjectId: string, dirs: string[]) => Promise<void>;
  leave: (who: ProjectPerson, projectId: string, localProjectId: string) => Promise<void>;
  bindings: () => SharedLedgerBinding[];
  eligible: () => Promise<{ id: string; name: string }[]>;
  openAsk: (input: CreateAskInput) => Ask;
  getAsk: (id: string) => Ask | null;
  /** Durable, synchronous one-time claim after the stored card and its approval have been checked. */
  claimAsk: (ask: Ask) => boolean;
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
