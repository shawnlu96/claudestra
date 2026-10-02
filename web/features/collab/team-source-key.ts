import type { Identity } from "@/lib/api/shared-ledger";

const PREFIX = "shared-ledger:";
export function sharedCollabProject(i: Identity): string {
  return PREFIX + JSON.stringify({ center: i.center, team: i.team, person: i.person, project: i.project, machine: i.machine,
    ...(i.homeInstanceId ? { homeInstanceId: i.homeInstanceId } : {}) });
}
export function sharedIdentity(project: string): Identity | null {
  if (!project.startsWith(PREFIX)) return null;
  try {
    const parsed = JSON.parse(project.slice(PREFIX.length));
    const [center, team, person, name, machine] = Array.isArray(parsed) ? parsed :
      [parsed?.center, parsed?.team, parsed?.person, parsed?.project, parsed?.machine];
    return [center, team, person, name, machine].every(v => typeof v === "string" && !!v)
      ? { center, team, person, project: name, machine, ...(typeof parsed.homeInstanceId === "string" ? { homeInstanceId: parsed.homeInstanceId } : {}) } : null;
  } catch { return null; } // Malformed navigation keys cannot authorize a shared request; retain the local fallback.
}
