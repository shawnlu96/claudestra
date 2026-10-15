/** peer-MIGASK1 · the frozen migration manifest: written once by `ledger shared-exec migration-ask` at
 * `<drill root>/shared-ledger-v2-migration/<batchId>/frozen-manifest.json` (0600) and then sent byte-for-byte by dry-run and
 * commit, so the owner's approval (its actionDigest) covers exactly what the center receives. Only authorizationAskId and the
 * manifestDigest it changes may differ after the freeze; anything else needs a new freeze and a new approval.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseMigrationManifest, v2ManifestDigest, v2ObjectDigest, type V2MigrationManifest } from "./shared-ledger-contract-v2.js";
import { batchDir, underRoot, writeRootJson } from "./shared-ledger-v2-migration-local.js";

/** The center's migrationActionDigest (CMIGAUTH1): the whole frozen manifest minus the ask approving it and its own digest.
 * Mode is not part of it, so one approval covers the dry-run and the commit; no array is sorted or trimmed. A different
 * rule here makes every approval mismatch at the center (tests/shared-ledger-v2-migration-ask.test.ts recomputes it).
 */
export function migrationActionDigest(manifest: V2MigrationManifest): string {
  const { authorizationAskId: _ask, manifestDigest: _self, ...frozen } = manifest;
  return v2ObjectDigest(frozen);
}

/** Ask id of a manifest frozen before the center returned one; dry-run / commit refuse to send it. */
export const PENDING_AUTHORIZATION = "pending-authorization";
export const frozenManifestPath = (root: string, batchId: string): string => join(batchDir(root, batchId), "frozen-manifest.json");

/** null = never frozen; an unreadable or invalid file throws (the caller refuses instead of re-freezing silently). */
export function readFrozenManifest(root: string, batchId: string): V2MigrationManifest | null {
  const path = frozenManifestPath(root, batchId);
  if (!existsSync(path)) return null;
  return parseMigrationManifest(JSON.parse(readFileSync(underRoot(root, path), "utf8")));
}

/** Seals (manifestDigest over the new ask id) and writes 0600 inside the drill root. */
export function writeFrozenManifest(root: string, manifest: V2MigrationManifest, authorizationAskId = manifest.authorizationAskId): V2MigrationManifest {
  const next = { ...manifest, authorizationAskId, manifestDigest: "" };
  next.manifestDigest = v2ManifestDigest(next);
  const sealed = parseMigrationManifest(next);
  writeRootJson(root, frozenManifestPath(root, sealed.batchId), sealed);
  return sealed;
}
