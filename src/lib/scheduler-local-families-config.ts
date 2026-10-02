/** Local family policy is optional: omission keeps both local runtimes eligible. */
export type LocalFamily = "claude" | "codex";
export interface LocalFamilies { localFamilies?: LocalFamily[] }
export interface LocalFamiliesSet { localFamilies?: LocalFamily[] | null }

export function parseLocalFamilies(raw: unknown): LocalFamilies {
  if (raw === undefined) return {};
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2 || new Set(raw).size !== raw.length ||
    raw.some((family) => family !== "claude" && family !== "codex")) {
    throw new Error("remote.localFamilies must contain claude / codex, each once");
  }
  return { localFamilies: [...raw] as LocalFamily[] };
}

/** CLI any removes the restriction rather than storing a second spelling of unrestricted. */
export function localFamiliesFlag(raw: string | undefined): LocalFamiliesSet {
  if (raw === undefined) return {};
  return raw === "any" ? { localFamilies: null } : parseLocalFamilies(raw.split(","));
}

/** Validate before taking the writer lock, including patches that also change other settings. */
export function hasLocalFamilies(set: LocalFamiliesSet): boolean {
  if (set.localFamilies === undefined) return false;
  if (set.localFamilies !== null) parseLocalFamilies(set.localFamilies);
  return true;
}

/** Mutates the existing raw remote object so the owning writer audits and rolls back the same transaction. */
export function localFamiliesPatch(p: Record<string, unknown>, set: LocalFamiliesSet): LocalFamiliesSet {
  if (!hasLocalFamilies(set)) return {};
  const remote = p.remote as Record<string, unknown> | undefined;
  const from = parseLocalFamilies(remote?.localFamilies).localFamilies ?? null;
  if (JSON.stringify(from) === JSON.stringify(set.localFamilies)) return { localFamilies: set.localFamilies };
  if (set.localFamilies === null) {
    if (remote) delete remote.localFamilies;
  } else {
    const target = remote ?? (p.remote = {}) as Record<string, unknown>;
    target.localFamilies = [...set.localFamilies!];
  }
  return { localFamilies: from };
}
