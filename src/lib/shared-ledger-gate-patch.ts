import type { FeaturePatch } from "./ledger-feature-write.js";
import type { FeatureStatus } from "./ledger-feature-schema.js";

export function patchFlags(c: { p: { flags: Record<string, string | undefined> } }): FeaturePatch {
  const f = c.p.flags;
  return {
    ...(f.title !== undefined ? { title: f.title } : {}),
    ...(f.words !== undefined ? { ownerWords: f.words } : {}),
    ...(f.status !== undefined ? { status: f.status as FeatureStatus } : {}),
  };
}
