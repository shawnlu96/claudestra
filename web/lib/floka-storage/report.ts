import type { StorageMode } from "./config";

export interface MigrationScope {
  mode: StorageMode;
  origin?: string;
  targetOrigin?: string;
}
export interface MigrationReport {
  area: "localStorage" | "indexedDB";
  status: "off" | "observed" | "complete" | "interrupted" | "cross-origin";
  /** Identifiers only: reports never contain stored values or credentials. */
  changes: string[];
  conflicts: string[];
}
export function migrationReport(area: MigrationReport["area"], scope: MigrationScope): MigrationReport {
  const crossOrigin = scope.targetOrigin !== undefined && scope.targetOrigin !== scope.origin;
  const status = crossOrigin ? "cross-origin" : scope.mode === "on" ? "complete" : scope.mode === "observe" ? "observed" : "off";
  return { area, status, changes: [], conflicts: [] };
}
export function reportMigration(report: MigrationReport): void {
  if (report.status === "interrupted") console.warn("[floka-storage] migration incomplete; legacy remains authoritative", report);
  else if (report.status === "observed" || report.conflicts.length) console.info("[floka-storage]", report);
}
