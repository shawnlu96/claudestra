import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { MigrateMap } from "./ledger-feature-migrate.js";

export function migrateBackupPath(dbPath: string, map: MigrateMap, now: number): string {
  const hash = createHash("sha256").update(JSON.stringify(map)).digest("hex").slice(0, 8);
  const ts = new Date(now).toISOString().replace(/[-:]/g, "").replace(".", "-").replace("Z", "");
  return join(dirname(dbPath), "backups", `${basename(dbPath)}.pre-feature-migrate-${ts}-${hash}-${randomBytes(4).toString("hex")}.bak`);
}
