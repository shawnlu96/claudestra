/** Bounded, fail-closed memory survives snapshot errors and TeamPanel remounts. */
export function createTeamAnimationMemory(maxProjects = 64, maxIds = 2000) {
  const projects = new Map<string, Map<string, number>>();
  return (scope: string, id: string, at: number, now: number): boolean => {
    let seen = projects.get(scope);
    if (!seen) {
      if (projects.size >= maxProjects) return false;
      seen = new Map(); projects.set(scope, seen);
    }
    for (const [key, time] of seen) if (time <= now - 600_000) seen.delete(key);
    if (seen.has(id) || seen.size >= maxIds || at <= now - 600_000 || at > now) return false;
    seen.set(id, at);
    return true;
  };
}

export const claimTeamAnimation = createTeamAnimationMemory();

/** Event order changes must not move the lanes of previously drawn edges. */
export function teamEdgeLane(id: string): number {
  let hash = 0;
  for (const c of id) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) | 0;
  return (hash >>> 0) % 3;
}
