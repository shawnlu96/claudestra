/** Light checks deliberately claim no full coverage; every merge entrance shares this unconditional refusal. */
export const CI_SCOPE_LIGHT = "ci scope light";
export const CI_SCOPE_FULL = "ci scope full";
export function lightOnly(checks: readonly { name: string; bucket: string }[]): boolean {
  return checks.some((c) => c.name === CI_SCOPE_LIGHT) && !checks.some((c) => c.name === CI_SCOPE_FULL && c.bucket === "pass");
}
