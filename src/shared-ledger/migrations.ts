import type { Database } from "bun:sqlite";

/** This schema has its own version counter; it must never run against the local execution ledger. */
export function migrate(db: Database): void {
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS shared_schema(version INTEGER NOT NULL);
    INSERT INTO shared_schema SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM shared_schema);
    CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY, code TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(teamId TEXT NOT NULL, id TEXT NOT NULL, code TEXT NOT NULL,
      PRIMARY KEY(teamId,id), FOREIGN KEY(teamId) REFERENCES teams(id));
    CREATE TABLE IF NOT EXISTS members(teamId TEXT NOT NULL, personId TEXT NOT NULL, code TEXT NOT NULL, status TEXT NOT NULL,
      PRIMARY KEY(teamId,personId), FOREIGN KEY(teamId) REFERENCES teams(id));
    CREATE TABLE IF NOT EXISTS instance_bindings(teamId TEXT NOT NULL, personId TEXT NOT NULL, instanceId TEXT NOT NULL,
      publicKey TEXT NOT NULL, PRIMARY KEY(teamId,personId,instanceId),
      FOREIGN KEY(teamId,personId) REFERENCES members(teamId,personId));
    CREATE TABLE IF NOT EXISTS credentials(hash TEXT PRIMARY KEY, teamId TEXT NOT NULL, personId TEXT NOT NULL,
      instanceId TEXT NOT NULL, expiresAt INTEGER NOT NULL, revokedAt INTEGER, grants TEXT NOT NULL,
      FOREIGN KEY(teamId,personId,instanceId) REFERENCES instance_bindings(teamId,personId,instanceId));
    CREATE TABLE IF NOT EXISTS features(id TEXT PRIMARY KEY, teamId TEXT NOT NULL, projectId TEXT NOT NULL,
      title TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(teamId,projectId,title),
      FOREIGN KEY(teamId,projectId) REFERENCES projects(teamId,id));
    CREATE TABLE IF NOT EXISTS feature_locations(featureId TEXT PRIMARY KEY REFERENCES features(id),
      homeInstanceId TEXT NOT NULL, authorityMode TEXT NOT NULL, epoch INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dag_versions(featureId TEXT NOT NULL REFERENCES features(id), version INTEGER NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(featureId,version));
    CREATE TABLE IF NOT EXISTS dag_bindings(featureId TEXT NOT NULL, version INTEGER NOT NULL, nodeKey TEXT NOT NULL, taskId TEXT NOT NULL,
      PRIMARY KEY(featureId,version,nodeKey), UNIQUE(featureId,version,taskId),
      FOREIGN KEY(featureId,version) REFERENCES dag_versions(featureId,version));
    CREATE TABLE IF NOT EXISTS events(serverSeq INTEGER PRIMARY KEY AUTOINCREMENT, teamId TEXT NOT NULL,
      projectId TEXT NOT NULL, featureId TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS command_receipts(teamId TEXT NOT NULL, personId TEXT NOT NULL, instanceId TEXT NOT NULL,
      requestId TEXT NOT NULL, projectId TEXT NOT NULL, digest TEXT NOT NULL, response TEXT NOT NULL,
      PRIMARY KEY(teamId,personId,instanceId,requestId));
    CREATE TABLE IF NOT EXISTS import_batches(teamId TEXT NOT NULL, sourceInstanceId TEXT NOT NULL, batchId TEXT NOT NULL,
      projectId TEXT NOT NULL, digest TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(teamId,sourceInstanceId,batchId));
    CREATE TABLE IF NOT EXISTS id_map(kind TEXT NOT NULL, sourceInstanceId TEXT NOT NULL, sourceId TEXT NOT NULL,
      teamId TEXT NOT NULL, projectId TEXT NOT NULL, id TEXT NOT NULL UNIQUE, PRIMARY KEY(kind,sourceInstanceId,sourceId));
    CREATE TABLE IF NOT EXISTS source_dag_mirrors(featureId TEXT NOT NULL REFERENCES features(id), version INTEGER NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(featureId,version));
    CREATE TABLE IF NOT EXISTS task_mirrors(taskId TEXT PRIMARY KEY, featureId TEXT NOT NULL REFERENCES features(id),
      sourceInstanceId TEXT NOT NULL, sourceTaskId TEXT NOT NULL, data TEXT NOT NULL,
      UNIQUE(sourceInstanceId,sourceTaskId));
    CREATE TABLE IF NOT EXISTS step_mirrors(taskId TEXT NOT NULL REFERENCES task_mirrors(taskId), sourceStepId TEXT NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(taskId,sourceStepId));
    CREATE TABLE IF NOT EXISTS source_event_mirrors(sourceInstanceId TEXT NOT NULL, sourceSeq INTEGER NOT NULL,
      featureId TEXT NOT NULL REFERENCES features(id), data TEXT NOT NULL, PRIMARY KEY(sourceInstanceId,sourceSeq));
    CREATE TABLE IF NOT EXISTS projection_watermarks(featureId TEXT PRIMARY KEY REFERENCES features(id),
      sourceSeq INTEGER NOT NULL, digest TEXT NOT NULL, response TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS replay_claims(key TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS replay_expiry ON replay_claims(expiresAt);
    COMMIT;
  `);
  const row = db.query("SELECT version FROM shared_schema").get() as { version: number };
  if (row.version !== 1) throw new Error("Unsupported shared ledger schema");
}
