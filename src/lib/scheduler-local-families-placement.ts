/** The project writer runtime travels with the parsed pool policy; raw config writers never serialize this object. */
import type { LocalFamily } from "./scheduler-local-families-config.js";
import type { PlacementFacts, PlaceRole } from "./scheduler-placement.js";

export interface LocalFamilyPolicy { localAuthorRuntime?: LocalFamily }

/** Only restricted projects need this derived field; omission preserves existing parsed policy shapes. */
export function localFamilyPolicy<T extends { localFamilies?: LocalFamily[] }>(remote: T, runtime: unknown): T & LocalFamilyPolicy {
  return remote.localFamilies ? { ...remote, localAuthorRuntime: runtime === "codex" ? "codex" : "claude" } : remote;
}

export function localFamilyRefusal(facts: Pick<PlacementFacts, "remote">, role: PlaceRole, family: LocalFamily): string | null {
  const policy = facts.remote;
  const localFamily = role === "review" ? family : policy?.localAuthorRuntime ?? "claude";
  return policy?.localFamilies && !policy.localFamilies.includes(localFamily) ? `本机不接 ${localFamily}` : null;
}


/** Early planner exits mean local; they must apply the same family gate as the ranked pool. */
export function localReviewFallback(s: { pool?: { remote: PlacementFacts["remote"] } | null; workflow: { authorFamily: LocalFamily } | null }): { wait: string } | null {
  if (!s.workflow) return null;
  const family = s.workflow.authorFamily === "codex" ? "claude" : "codex";
  const refusal = localFamilyRefusal({ remote: s.pool?.remote ?? null }, "review", family);
  return refusal ? { wait: refusal } : null;
}
