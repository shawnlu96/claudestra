import type { V2SchemaContext, V2Statement } from "../../lib/shared-ledger-contract-v2.js";

// Separate columns retain the original/copy distinction for reads, exports and approval audits.
export const artifactSchemaStatements = {
  "artifacts.schema": `CREATE TABLE IF NOT EXISTS v2_artifacts (
    teamId TEXT NOT NULL, projectId TEXT NOT NULL, artifactId TEXT NOT NULL,
    kind TEXT NOT NULL, taskId TEXT NOT NULL, specRev INTEGER, head TEXT,
    digest TEXT NOT NULL, originalDigest TEXT NOT NULL, sharedDigest TEXT NOT NULL,
    redactionVersion INTEGER NOT NULL, approvalAskId TEXT NOT NULL, approvedBy TEXT NOT NULL,
    createdAt INTEGER NOT NULL, mediaType TEXT NOT NULL, bytes INTEGER NOT NULL,
    content TEXT NOT NULL, visibility TEXT NOT NULL CHECK (visibility = 'approved_copy'),
    PRIMARY KEY (teamId, projectId, artifactId), CHECK (digest = sharedDigest)
  )`,
  "artifacts.approvalIndex": `CREATE INDEX IF NOT EXISTS v2_artifacts_approval
    ON v2_artifacts (teamId, projectId, approvalAskId)`,
  "artifacts.noUpdate": `CREATE TRIGGER IF NOT EXISTS v2_artifacts_no_update BEFORE UPDATE ON v2_artifacts
    BEGIN SELECT RAISE(ABORT, 'immutable artifact'); END`,
  "artifacts.noDelete": `CREATE TRIGGER IF NOT EXISTS v2_artifacts_no_delete BEFORE DELETE ON v2_artifacts
    BEGIN SELECT RAISE(ABORT, 'immutable artifact'); END`,
  "artifacts.noReplace": `CREATE TRIGGER IF NOT EXISTS v2_artifacts_no_replace BEFORE INSERT ON v2_artifacts
    WHEN EXISTS (SELECT 1 FROM v2_artifacts WHERE teamId = NEW.teamId AND projectId = NEW.projectId AND artifactId = NEW.artifactId)
    BEGIN SELECT RAISE(ABORT, 'immutable artifact'); END`,
} as const;
export const artifactStatements = {
  "artifacts.get": { mode: "read", sql: `SELECT * FROM v2_artifacts
    WHERE teamId = $teamId AND projectId = $projectId AND artifactId = $artifactId` },
  "artifacts.approvalConflict": { mode: "read", sql: `SELECT artifactId FROM v2_artifacts
    WHERE teamId = $teamId AND projectId = $projectId AND approvalAskId = $approvalAskId
      AND (originalDigest != $originalDigest OR sharedDigest != $sharedDigest OR redactionVersion != $redactionVersion
        OR taskId != $taskId OR specRev IS NOT $specRev OR head IS NOT $head OR approvedBy != $approvedBy) LIMIT 1` },
  "artifacts.put": { mode: "write", sql: `INSERT INTO v2_artifacts
    (teamId, projectId, artifactId, kind, taskId, specRev, head, digest, originalDigest, sharedDigest,
      redactionVersion, approvalAskId, approvedBy, createdAt, mediaType, bytes, content, visibility)
    VALUES ($teamId, $projectId, $artifactId, $kind, $taskId, $specRev, $head, $digest, $originalDigest, $sharedDigest,
      $redactionVersion, $approvalAskId, $approvedBy, $createdAt, $mediaType, $bytes, $content, $visibility)` },
} as const satisfies Record<string, V2Statement>;
export function installArtifactSchema(context: V2SchemaContext): void {
  for (const name of Object.keys(artifactSchemaStatements)) context.install(name);
}
