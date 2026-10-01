import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { resolve, basename } from "node:path";
import { migrate } from "./migrations.js";
import { SharedLedgerError } from "../lib/shared-ledger-contract.js";
import { canonicalJson } from "../lib/ask-bind.js";
import { redactForPeer } from "../lib/dispatch-redact.js";

export class Store {
  readonly db: Database;
  constructor(path: string) {
    if (!path || basename(path) === "ledger.sqlite") throw new Error("Explicit independent database path required");
    this.db = new Database(path === ":memory:" ? path : resolve(path), { create: true, strict: true });
    migrate(this.db);
  }
  get<T>(sql: string, ...args: (string | number | null)[]): T | null {
    return this.db.query(sql).get(...args) as T | null;
  }
  all<T>(sql: string, ...args: (string | number | null)[]): T[] {
    return this.db.query(sql).all(...args) as T[];
  }
  run(sql: string, ...args: (string | number | null)[]): void { this.db.query(sql).run(...args); }
  write<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  read<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  claim(key: string, expiresAt: number, now: number): boolean {
    return this.write(() => {
      this.run("DELETE FROM replay_claims WHERE expiresAt <= ?", now);
      return this.db.query("INSERT OR IGNORE INTO replay_claims VALUES (?,?)").run(key, expiresAt).changes === 1;
    });
  }
  seq(): number { return this.get<{ n: number }>("SELECT COALESCE(MAX(serverSeq),0) n FROM events")!.n; }
  event(team: string, project: string, feature: string, kind: string, actor: string, now: number): number {
    this.run("INSERT INTO events(teamId,projectId,featureId,kind,actor,at) VALUES (?,?,?,?,?,?)", team, project, feature, kind, actor, now);
    return this.seq();
  }
  close(): void { this.db.close(); }
}

export const newId = (): string => randomUUID();
export const encode = (value: unknown): string => canonicalJson(value);
export const decode = <T>(value: string): T => JSON.parse(value) as T;
export function rejectSensitive(value: unknown): void {
  if (typeof value === "string") {
    if (redactForPeer(value).count) throw new SharedLedgerError("invalid_field", "Sensitive shared text rejected");
  } else if (Array.isArray(value)) value.forEach(rejectSensitive);
  else if (value && typeof value === "object") {
    for (const [key, field] of Object.entries(value)) {
      // Schema-validated content digests and commit hashes are metadata, not free text secrets.
      if (!["manifestDigest", "specDigest", "head"].includes(key)) rejectSensitive(field);
    }
  }
}
