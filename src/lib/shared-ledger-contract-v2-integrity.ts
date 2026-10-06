import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { fail, parseFence, type V2Fence } from "./shared-ledger-contract-v2-validation.js";

export const v2ContentDigest = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");
export const v2ObjectDigest = (value: unknown): string => v2ContentDigest(canonicalJson(value));
/** Self-digests omit exactly their own field; all evidence/mappings/rows remain bound. */
export function v2ManifestDigest(manifest: { manifestDigest: string }): string {
  const { manifestDigest: _self, ...body } = manifest;
  return v2ObjectDigest(body);
}
/** Storage calls before every execution write; clients must carry the exact generation and holder incarnation. */
export function assertFence(expected: V2Fence, supplied: V2Fence): void {
  parseFence(expected); parseFence(supplied);
  if (supplied.serviceGeneration !== expected.serviceGeneration) fail("stale_generation");
  if (supplied.epoch !== expected.epoch || supplied.bootId !== expected.bootId) fail("stale_epoch");
}
