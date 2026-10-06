import { join } from "node:path";
import { readJsonStateSync } from "./state-file.js";
import { readSharedLedgerBindings } from "./shared-ledger-gate-bindings.js";
import type { SharedLedgerLocalCredential } from "./shared-ledger-mode.js";

/** Pins belong to the center and local project, independent of any role or subject returned by a center. */
export function sharedLedgerJoinPinsMatch(next: SharedLedgerLocalCredential, localProjectId: string, projectId: string, dir: string): boolean {
  const state = readJsonStateSync(join(dir, "shared-ledger-credentials.json"), (v) => {
    const credentials = (v as { credentials?: unknown[] } | null)?.credentials;
    return Array.isArray(credentials) && credentials.every((c) => c && typeof c === "object"
      && typeof (c as SharedLedgerLocalCredential).centerId === "string" && typeof (c as SharedLedgerLocalCredential).baseUrl === "string");
  });
  if (state.status === "corrupt") throw new Error("shared ledger local state invalid; nothing was saved");
  const credentials = state.status === "missing" ? [] : (state.data as { credentials: SharedLedgerLocalCredential[] }).credentials;
  return !credentials.some((c) => c.centerId === next.centerId && c.baseUrl !== next.baseUrl)
    && !readSharedLedgerBindings(dir).some((b) => (b.localProjectId ?? b.projectId) === localProjectId
      && (b.centerId !== next.centerId || b.teamId !== next.teamId || b.projectId !== projectId))
    && !readSharedLedgerBindings(dir).some((b) => b.centerId === next.centerId && b.teamId === next.teamId
      && b.projectId === projectId && (b.localProjectId ?? b.projectId) !== localProjectId);
}
