/**
 * Which acceptance line (or regression) a review finding hangs on. A P1 must name one, or the planner treats it as P2
 * (review-converge.ts). Remotes that predate the `basis` field still mark the finding text with 「[验收线 N]」 / 「[回归]」;
 * both spellings resolve to the same value, so an old verdict converges like a new one. tests/review-converge-basis.test.ts.
 */

/** `acceptance:<N>` = breaks the spec's acceptance line N (1-based); `regression` = a correctness / security bug this diff added. */
export type FindingBasis = `acceptance:${number}` | "regression";

const FIELD = /^(?:acceptance:([1-9]\d{0,2})|regression)$/;
const MARK_ACCEPT = /[[【]\s*(?:验收线|验收|acceptance)\s*[#:：]?\s*([1-9]\d{0,2})\s*[\]】]/i;
const MARK_REGRESSION = /[[【]\s*(?:回归|regression)\s*[\]】]/i;

/** The structured field as written; anything else is "no basis", never an error (a bad basis only costs the P1 its weight). */
export function basisField(v: unknown): FindingBasis | null {
  return typeof v === "string" && FIELD.test(v.trim()) ? v.trim() as FindingBasis : null;
}

/** First marker in free text: an acceptance line wins over a regression mark when both appear (it is the narrower claim). */
export function basisFromText(text: string): FindingBasis | null {
  const n = MARK_ACCEPT.exec(text)?.[1];
  if (n) return `acceptance:${Number(n)}`;
  return MARK_REGRESSION.test(text) ? "regression" : null;
}

export interface BasisSource { basis?: unknown; findingId: string; family: string; probe: string; description?: string }

/** The field first, then markers in the finding's own text (title fields, probe, description). */
export function findingBasis(f: BasisSource): FindingBasis | null {
  return basisField(f.basis) ?? basisFromText([f.findingId, f.family, f.probe, f.description ?? ""].join("\n"));
}

/** Wire-side check for the optional field: absent / null = none; present must be well-formed, or the verdict is refused. */
export function wireBasis(v: unknown, fail: (why: string) => never): { basis?: FindingBasis } {
  if (v === undefined || v === null) return {};
  return basisField(v) ? { basis: basisField(v) as FindingBasis } : fail("只认 \"acceptance:<验收线编号>\" 或 \"regression\"");
}
