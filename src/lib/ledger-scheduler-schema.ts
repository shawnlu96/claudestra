/** T68 scheduler facts live in the ledger so a process restart can reconcile every pending action. */
import type { Database } from "bun:sqlite";

const SCHEDULER_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS scheduler_meta (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  )`,
  `INSERT OR IGNORE INTO scheduler_meta (key, value)
   SELECT 'activationSeq', CAST(COALESCE(MAX(seq), 0) AS TEXT) FROM events`,
  `CREATE TABLE IF NOT EXISTS task_workflows (
    taskId TEXT PRIMARY KEY REFERENCES tasks(id), project TEXT NOT NULL,
    template TEXT NOT NULL CHECK (template IN ('code','ui','security')),
    templateVersion INTEGER NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('manual','observe','auto')),
    authorFamily TEXT NOT NULL CHECK (authorFamily IN ('claude','codex')),
    fallback TEXT NOT NULL, specRev INTEGER NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS task_workflows_project ON task_workflows(project, mode)",
  `CREATE TABLE IF NOT EXISTS scheduler_intents (
    id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), project TEXT NOT NULL,
    node TEXT NOT NULL, action TEXT NOT NULL, recipient TEXT,
    causalSeq INTEGER NOT NULL, eventSeq INTEGER NOT NULL DEFAULT 0,
    taskRev INTEGER NOT NULL, specRev INTEGER NOT NULL,
    head TEXT, templateVersion INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','submitted','done','unknown','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0, receipt TEXT, reason TEXT NOT NULL,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS scheduler_resources (
    project TEXT NOT NULL, resource TEXT NOT NULL, taskId TEXT NOT NULL REFERENCES tasks(id),
    intentId TEXT NOT NULL REFERENCES scheduler_intents(id), acquiredAt INTEGER NOT NULL,
    scope TEXT NOT NULL DEFAULT 'intent' CHECK (scope IN ('intent','card')),
    PRIMARY KEY (project, resource)
  )`,
];

/** Branches may have created an earlier v7 table without eventSeq; repair it before building indexes. */
export function SCHEDULER_SCHEMA(db: Database): void {
  for (const sql of SCHEDULER_SQL) db.prepare(sql).run();
  const columns = db.prepare("PRAGMA table_info(scheduler_intents)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "eventSeq")) db.prepare("ALTER TABLE scheduler_intents ADD COLUMN eventSeq INTEGER NOT NULL DEFAULT 0").run();
  const resourceColumns = db.prepare("PRAGMA table_info(scheduler_resources)").all() as { name: string }[];
  if (!resourceColumns.some((c) => c.name === "scope")) db.prepare("ALTER TABLE scheduler_resources ADD COLUMN scope TEXT NOT NULL DEFAULT 'intent'").run();
  db.prepare(`UPDATE scheduler_resources SET scope = 'card' WHERE scope = 'intent' AND resource NOT LIKE 'task:%'
    AND intentId IN (SELECT id FROM scheduler_intents WHERE action = 'dispatch')`).run();
  db.prepare("UPDATE scheduler_intents SET eventSeq = COALESCE((SELECT seq FROM events WHERE dedupKey = 'scheduler:' || scheduler_intents.id), 0) WHERE eventSeq = 0").run();
  db.prepare("CREATE INDEX IF NOT EXISTS scheduler_intents_task ON scheduler_intents(taskId, eventSeq)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS scheduler_intents_project_status ON scheduler_intents(project, status)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS scheduler_resources_task ON scheduler_resources(taskId)").run();
}

/** A card owns at most one author and one reviewer session; the reviewer survives every fix round. */
export function SCHEDULER_SESSIONS_SCHEMA(db: Database): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS scheduler_sessions (
    taskId TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL CHECK (role IN ('author','reviewer')),
    agent TEXT NOT NULL, sessionId TEXT NOT NULL, family TEXT NOT NULL CHECK (family IN ('claude','codex')),
    transport TEXT NOT NULL CHECK (transport IN ('acp','tmux','peer')),
    state TEXT NOT NULL CHECK (state IN ('active','retiring','retired')),
    createIntentId TEXT NOT NULL REFERENCES scheduler_intents(id), retireIntentId TEXT REFERENCES scheduler_intents(id),
    archiveReceipt TEXT, killReceipt TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
    PRIMARY KEY (taskId, role), UNIQUE (sessionId)
  )`).run();
  db.prepare("CREATE INDEX IF NOT EXISTS scheduler_sessions_state ON scheduler_sessions(state)").run();
}

export const SCHEDULER_TABLES = ["scheduler_meta", "task_workflows", "scheduler_intents", "scheduler_resources", "scheduler_sessions"] as const;
export const SCHEDULER_COLUMNS = {
  scheduler_meta: ["key", "value"],
  task_workflows: ["taskId", "project", "template", "templateVersion", "mode", "authorFamily", "fallback", "specRev", "rev"],
  scheduler_intents: ["id", "taskId", "project", "node", "action", "causalSeq", "eventSeq", "taskRev", "specRev", "status", "reason", "receipt"],
  scheduler_resources: ["project", "resource", "taskId", "intentId", "acquiredAt", "scope"],
  scheduler_sessions: ["taskId", "role", "agent", "sessionId", "family", "transport", "state", "createIntentId", "retireIntentId", "archiveReceipt", "killReceipt"],
} as const;
export const SCHEDULER_INDEXES = {
  task_workflows: ["task_workflows_project"],
  scheduler_intents: ["scheduler_intents_task", "scheduler_intents_project_status"],
  scheduler_resources: ["scheduler_resources_task"],
  scheduler_sessions: ["scheduler_sessions_state"],
} as const;
