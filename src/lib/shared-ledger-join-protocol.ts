/**
 * Shared-ledger join wire protocol, pure: join-code format, proof fields, request/grant shapes and the default instance id.
 * No network, credential storage or local state here; redeeming a code lives in shared-ledger-join.ts (which re-exports these).
 */
import { createHash } from "node:crypto";
import type { SharedLedgerCredential } from "./shared-ledger-auth.js";

export const SHARED_LEDGER_JOIN_PATH = "/v1/join";
/** Join proofs reuse the shared-ledger purpose; the JOIN tag and field count keep them disjoint from request signatures. */
export const SHARED_LEDGER_JOIN_PURPOSE = "claudestra-shared-ledger-v1";
const CODE_RE = /^sljoin1\.(center-[a-f0-9]{32})\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/;
type Action = SharedLedgerCredential["projects"][number]["actions"][number];

export interface SharedLedgerJoinCode { centerId: string; codeId: string; secret: string }
export const formatSharedLedgerJoinCode = (c: SharedLedgerJoinCode): string => `sljoin1.${c.centerId}.${c.codeId}.${c.secret}`;
export function parseSharedLedgerJoinCode(code: unknown): SharedLedgerJoinCode | null {
  const m = typeof code === "string" ? CODE_RE.exec(code.trim()) : null;
  return m ? { centerId: m[1]!, codeId: m[2]!, secret: m[3]! } : null;
}
/** True for anything shaped like a join code: callers use it to refuse codes passed through argv. */
export const looksLikeSharedLedgerJoinCode = (v: string): boolean => /sljoin1\./.test(v);

/** Default enrollment instance id, derived from the instance key: only its holder can claim it (free-form ids are first-come). */
export const sharedLedgerInstanceId = (key: string) => `sli-${createHash("sha256").update(Buffer.from(key, "base64url")).digest("hex").slice(0, 24)}`;
export function sharedLedgerJoinFields(centerId: string, code: string, publicKey: string, instanceId: string): string[] {
  return ["JOIN", SHARED_LEDGER_JOIN_PATH, centerId, createHash("sha256").update(code).digest("hex"), publicKey, instanceId];
}
export interface SharedLedgerJoinRequest { code: string; publicKey: string; instanceId: string; signature: string }

export interface SharedLedgerJoinGrant {
  centerId: string; teamId: string; personId: string; instanceId: string; bearer: string; expiresAt: number;
  role: "member" | "service"; projects: { projectId: string; actions: Action[] }[];
}
