import type { V2SchemaContext, V2Statement } from "../../lib/shared-ledger-contract-v2.js";

const scope = "teamId = $teamId AND projectId = $projectId";
// Generation is service-wide. Only the authorized recovery path may receive its
// mutation statement grants; ordinary project commands cannot revoke other projects.
const serviceScope = "$teamId IS NOT NULL AND $projectId IS NOT NULL";
export const leaseSchema = {
  "leases.schema": `CREATE TABLE IF NOT EXISTS v2_scheduler_leases (
    teamId TEXT NOT NULL, projectId TEXT NOT NULL, taskId TEXT NOT NULL, featureId TEXT NOT NULL,
    epoch INTEGER NOT NULL, active INTEGER NOT NULL, lease TEXT NOT NULL,
    PRIMARY KEY (teamId, projectId, taskId))`,
  "leases.boots.schema": `CREATE TABLE IF NOT EXISTS v2_scheduler_boots (
    teamId TEXT NOT NULL, projectId TEXT NOT NULL, homeInstanceId TEXT NOT NULL, bootId TEXT NOT NULL, active INTEGER NOT NULL,
    PRIMARY KEY (teamId, projectId, homeInstanceId, bootId))`,
  "leases.boots.index": `CREATE UNIQUE INDEX IF NOT EXISTS v2_scheduler_current_boot
    ON v2_scheduler_boots (teamId, projectId, homeInstanceId) WHERE active = 1`,
  "leases.generation.schema": `CREATE TABLE IF NOT EXISTS v2_service_generation (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), generation TEXT NOT NULL)`,
} as const;
export const leaseStatements: Readonly<Record<string, V2Statement>> = {
  "leases.get": { mode: "read", sql: `SELECT * FROM v2_scheduler_leases WHERE ${scope} AND taskId = $taskId` },
  "leases.put": { mode: "write", sql: `INSERT INTO v2_scheduler_leases
    (teamId, projectId, taskId, featureId, epoch, active, lease)
    VALUES ($teamId, $projectId, $taskId, $featureId, $nextEpoch, $active, $lease)
    ON CONFLICT (teamId, projectId, taskId) DO UPDATE SET epoch = excluded.epoch,
    active = excluded.active, lease = excluded.lease` },
  "leases.revokeFeature": { mode: "write", sql: `UPDATE v2_scheduler_leases SET active = 0, epoch = $nextEpoch
    WHERE ${scope} AND featureId = $featureId` },
  "leases.boot": { mode: "read", sql: `SELECT bootId, active FROM v2_scheduler_boots
    WHERE ${scope} AND homeInstanceId = $instanceId AND bootId = $bootId` },
  "leases.retire": { mode: "write", sql: `UPDATE v2_scheduler_boots SET active = 0
    WHERE ${scope} AND homeInstanceId = $instanceId AND active = 1` },
  "leases.boot.put": { mode: "write", sql: `INSERT INTO v2_scheduler_boots
    (teamId, projectId, homeInstanceId, bootId, active) VALUES ($teamId, $projectId, $instanceId, $bootId, 1)` },
  "leases.boot.features": { mode: "read", sql: `SELECT DISTINCT featureId FROM v2_scheduler_leases
    WHERE ${scope} AND active = 1 AND json_extract(lease, '$.holderInstanceId') = $instanceId
    AND json_extract(lease, '$.bootId') != $bootId` },
  "leases.boot.revoke": { mode: "write", sql: `UPDATE v2_scheduler_leases SET active = 0, epoch = $nextEpoch
    WHERE ${scope} AND featureId = $featureId AND active = 1 AND json_extract(lease, '$.holderInstanceId') = $instanceId
    AND json_extract(lease, '$.bootId') != $bootId` },
  "leases.boots.retireAll": { mode: "write", sql: `UPDATE v2_scheduler_boots SET active = 0 WHERE ${serviceScope}` },
  "leases.generation.get": { mode: "read", sql: `SELECT generation FROM v2_service_generation WHERE ${serviceScope}` },
  "leases.generation.put": { mode: "write", sql: `INSERT INTO v2_service_generation (singleton, generation)
    SELECT 1, $generation WHERE ${serviceScope}
    ON CONFLICT (singleton) DO UPDATE SET generation = excluded.generation` },
  "leases.revokeAll": { mode: "write", sql: `UPDATE v2_scheduler_leases SET active = 0 WHERE ${serviceScope}` },
};
export function installLeaseSchema(context: V2SchemaContext): void {
  for (const name of Object.keys(leaseSchema)) context.install(name);
}
