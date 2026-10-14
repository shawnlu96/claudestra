import { api } from "./client";
import { parseRosterWire } from "@/features/collab/team/roster-model";
import type { Roster } from "@/features/collab/team/roster-types";

/** Shared navigation keys never name a local scheduler project. */
export async function fetchTeamRoster(project: string, signal: AbortSignal): Promise<Roster | null> {
  if (!project || project.startsWith("shared-ledger:")) return null;
  return parseRosterWire(await api(`/team/roster?project=${encodeURIComponent(project)}`, { signal }));
}
