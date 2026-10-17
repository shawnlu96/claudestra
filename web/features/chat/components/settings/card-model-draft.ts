import type { RoleModelView, RoleModelBatch } from "./role-model-settings-api";
export type Family = "claude" | "codex";
export type Draft = Record<string, string>;
export const cellKey = (tier: string, role: string, family: Family) => `${tier}:${role}:${family}`;
export function storedValue(view: RoleModelView, tier: string, role: string, family: Family): string {
  const row = view.roles.find((r) => r.role === role)!;
  const value = tier === "undeclared" ? row[family] : view.tiers[tier]?.[role]?.[family];
  return value === null ? "global" : value === undefined ? "default" : value;
}
export function batchOf(view: RoleModelView, draft: Draft): RoleModelBatch {
  const changes: RoleModelBatch["changes"] = [];
  for (const tier of [...view.taskTiers, "undeclared"]) for (const row of view.roles) {
    const change: RoleModelBatch["changes"][number] = { role: row.role, ...(tier !== "undeclared" ? { tier } : {}) };
    for (const family of ["claude", "codex"] as const) {
      const value = draft[cellKey(tier, row.role, family)];
      if (value !== undefined && value !== storedValue(view, tier, row.role, family)) {
        if (family === "claude") change.claude = value;
        else change.codex = value === "global" ? null : value;
      }
    }
    if ("claude" in change || "codex" in change) changes.push(change);
  }
  return { rev: view.rev, changes };
}
