/** Synthetic values for home and center contract tests. No local ids, paths or private resource names. */
import type { FeatureDeps, FeatureDepsUpload } from "./shared-ledger-contract-feature-deps.js";
export const FEATURE_DEPS_UPLOAD_FIXTURE: FeatureDepsUpload = {
  schemaVersion: 1, teamId: "team-a", sourceInstanceId: "instance-a", edges: [
    { projectId: "project-a", from: "feature-a", to: "feature-b", kind: "declared", satisfied: false, count: 1 },
    { projectId: "project-a", from: "feature-b", to: "feature-c", kind: "split", satisfied: true, count: 1 },
    { projectId: "project-a", from: "feature-a", to: "feature-c", kind: "task", satisfied: false, count: 2 },
  ],
};
export const FEATURE_DEPS_READ_FIXTURE: FeatureDeps = {
  schemaVersion: 1, teamId: "team-a", edges: FEATURE_DEPS_UPLOAD_FIXTURE.edges, updatedAt: 1_790_000_000_000,
};
const row = FEATURE_DEPS_UPLOAD_FIXTURE.edges[0]!;
const withRow = (patch: Record<string, unknown>) => ({ ...FEATURE_DEPS_UPLOAD_FIXTURE, edges: [{ ...row, ...patch }] });
/** Each must throw invalid_field, including fields that the product board keeps locally. */
export const FEATURE_DEPS_INVALID_UPLOADS: Record<string, unknown> = {
  topLevelExtraKey: { ...FEATURE_DEPS_UPLOAD_FIXTURE, extra: true },
  edgeNote: withRow({ note: "private detail" }),
  edgeEvidence: withRow({ evidence: [] }),
  lockKind: withRow({ kind: "lock" }),
  selfLoop: withRow({ to: row.from }),
  duplicate: { ...FEATURE_DEPS_UPLOAD_FIXTURE, edges: [row, row] },
  zeroCount: withRow({ count: 0 }),
  schemaVersion2: { ...FEATURE_DEPS_UPLOAD_FIXTURE, schemaVersion: 2 },
  overLimit: { ...FEATURE_DEPS_UPLOAD_FIXTURE, edges: Array.from({ length: 2001 }, (_, i) => ({ ...row, from: `feature-${i}` })) },
};
/** The deployed center's unknown-route handler returns forbidden (403), rather than not found (404). */
export const FEATURE_DEPS_OLD_CENTER_STATUS = 403;
