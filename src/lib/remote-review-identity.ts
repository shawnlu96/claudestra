import { createHash } from "node:crypto";
import { prCoordinates } from "./card-repo.js";

export interface RemoteIdentity { repo: string; number: number; fullHead: string }

/** Reuse the PR URL grammar, so wire identities and card identities accept the same repositories. */
export const validRemoteRepo = (repo: string): boolean => prCoordinates(`https://github.com/${repo}/pull/1`) !== null;
export const fullRemoteHead = (head: unknown): head is string => typeof head === "string" && /^[0-9a-f]{40}$/i.test(head);
export const sameRemoteHead = (a: unknown, b: unknown): boolean => fullRemoteHead(a) && fullRemoteHead(b) && a.toLowerCase() === b.toLowerCase();
export const remoteIdentityKey = (r: RemoteIdentity): string => `${r.repo.toLowerCase()}:${r.number}:${r.fullHead.toLowerCase()}`;
/** Fixed-size file component: repo names cannot create directories or exceed the filesystem's name limit. */
export const remoteIdentityDigest = (r: RemoteIdentity): string => createHash("sha256").update(remoteIdentityKey(r)).digest("hex");

export function sameRemotePr(pr: string | null, r: Pick<RemoteIdentity, "repo" | "number">): boolean {
  const c = prCoordinates(pr);
  return !!c && c.pr === r.number && c.repo.toLowerCase() === r.repo.toLowerCase();
}
