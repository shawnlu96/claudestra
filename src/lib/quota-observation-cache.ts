import type { StoredReading } from "./account-usage-refresh.js";
import type { CachedUsage } from "./usage-cache.js";
import { observationLowerBound, observationTime } from "./quota-observation.js";

/** Compare the manual read with each window; an omitted window is not a new observation. */
export function mergeManualObservation(cache: CachedUsage | null, manual: StoredReading | null, now: number): CachedUsage | null {
  if (!manual || !observationTime(manual.scrapedAt, now).eligible) return cache;
  const out: CachedUsage = cache ? { ...cache } : {
    sessionPct: null, weekPct: null, sessionResets: "", weekResets: "",
    sessionResetsAtMs: null, weekResetsAtMs: null, scrapedAt: 0,
    sessionObservedAt: null, weekObservedAt: null,
  };
  for (const key of ["session", "week"] as const) {
    const timeKey = key === "session" ? "sessionObservedAt" : "weekObservedAt";
    const qualificationKey = key === "session" ? "sessionObservationQualification" : "weekObservationQualification";
    if (out[timeKey] === undefined) {
      out[timeKey] = out.scrapedAt;
      out[qualificationKey] = "legacy_lower_bound";
    }
    const at = out[timeKey];
    const time = observationTime(at, now);
    const pct = manual[key === "session" ? "sessionPct" : "weekPct"];
    if (pct === null || (time.eligible && at! >= manual.scrapedAt)) continue;
    const resetKey = key === "session" ? "sessionResetsAtMs" : "weekResetsAtMs";
    out[key === "session" ? "sessionPct" : "weekPct"] = pct;
    out[key === "session" ? "sessionResets" : "weekResets"] = manual[key === "session" ? "sessionResets" : "weekResets"];
    // The panel's local reset text has no timezone; retain a numeric reset only if it still follows this observation.
    out[resetKey] = out[resetKey] != null && out[resetKey]! > manual.scrapedAt ? out[resetKey] : null;
    out[key === "session" ? "sessionObservedAt" : "weekObservedAt"] = manual.scrapedAt;
    out[key === "session" ? "sessionObservationQualification" : "weekObservationQualification"] = "observed";
  }
  if (out.sessionPct === null && out.weekPct === null) return cache;
  out.scrapedAt = observationLowerBound([
    out.sessionPct !== null && observationTime(out.sessionObservedAt, now).eligible ? out.sessionObservedAt ?? null : null,
    out.weekPct !== null && observationTime(out.weekObservedAt, now).eligible ? out.weekObservedAt ?? null : null,
  ]) ?? 0;
  return out;
}
