/** Observation time is independent of cache/context writes; legacy timestamps are only a lower bound. */
export type ObservationQualification = "observed" | "legacy_lower_bound" | "future" | "invalid";

export interface ObservationTime {
  observedAt: number | null;
  qualification: ObservationQualification;
  eligible: boolean;
}

export function observationTime(at: unknown, now: number, legacy = false): ObservationTime {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || !Number.isFinite(now)) {
    return { observedAt: null, qualification: "invalid", eligible: false };
  }
  if (at > now) return { observedAt: at, qualification: "future", eligible: false };
  return { observedAt: at, qualification: legacy ? "legacy_lower_bound" : "observed", eligible: true };
}

/** A whole reading cannot claim its oldest populated window was observed at its newest window's time. */
export function observationLowerBound(times: Array<number | null>): number | null {
  const known = times.filter((at): at is number => at !== null && Number.isFinite(at) && at > 0);
  return known.length ? Math.min(...known) : null;
}
