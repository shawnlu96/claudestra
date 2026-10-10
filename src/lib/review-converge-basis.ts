/**
 * Which acceptance line (or regression) a review finding hangs on. A P1 must name one, or the planner treats it as P2
 * (review-converge.ts). Remotes that predate the `basis` field still mark the finding text with 「[验收线 N]」 / 「[回归]」;
 * both spellings resolve to the same value, so an old verdict converges like a new one. tests/review-converge.test.ts.
 */

/** `acceptance:<N>` = breaks the spec's acceptance line N (1-based); `regression` = a correctness / security bug this diff added. */
export type FindingBasis = `acceptance:${number}` | "regression";

const FIELD = /^(?:acceptance:([1-9]\d{0,2})|regression)$/;
/** A bracketed marker closed by its own bracket: [ ], 【 】, ［ ］ or （ ）. A mismatched pair is no marker; the labels may wrap lines. */
const MARK = /\[([^[\]【】［］（）]+)\]|【([^[\]【】［］（）]+)】|［([^[\]【】［］（）]+)］|（([^[\]【】［］（）]+)）/g;
const PAIRS: Record<string, string> = { "[": "]", "【": "】", "［": "］", "（": "）", "(": ")" };
const CLOSERS = new Set(Object.values(PAIRS));
/** One label inside a marker: 「验收线 N」 (any spelling), 「回归」, or a bare N continuing an acceptance list. */
const ITEM = /\s*(?:(?:验收线|验收|acceptance)\s*[#:：]?\s*([1-9]\d{0,2})(?!\d)|(回归|regression)(?![a-z])|#?\s*([1-9]\d{0,2})(?!\d))\s*/iy;
const SEP = /(?:[、,，;；/&]|和|及|与|and(?![a-z]))\s*/iy;
/** The field spelling written bare in a Markdown heading (「## F1 acceptance:1 and acceptance:2」): the first one counts. */
const MARK_FIELD = /(?<![\w-])acceptance:([1-9]\d{0,2})(?![\w\-\]】］）])/i;
const HEADING = /^\s*#{1,6}\s.*$/gm;

/**
 * A heading line with every bracketed span blanked, nested ones whole and a mismatched or unclosed one to the line end, so a
 * bare field never leaks out of a broken marker. Only a flat 「(…)」 holding nothing but labels keeps its text.
 */
function outsideBrackets(line: string): string {
  const out = line.split("");
  const stack: string[] = [];
  let start = 0, nested = false, broken = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (PAIRS[c]) {
      if (stack.length) nested = true;
      else [start, nested, broken] = [i, false, false];
      stack.push(c);
    } else if (stack.length && CLOSERS.has(c)) {
      if (PAIRS[stack[stack.length - 1]] !== c) { broken = true; continue; }
      stack.pop();
      if (stack.length) continue;
      const keep = line[start] === "(" && !nested && !broken && !!markLabels(line.slice(start + 1, i))?.lines.length;
      if (!keep) out.fill(" ", start, i + 1);
    }
  }
  if (stack.length) out.fill(" ", start);
  return out.join("");
}

/**
 * A marker's labels, or null unless the whole content is labels: 「[验收线 1、2]」「[回归;验收线 6]」「[验收线 2 / 验收线 6]」.
 * A bare number only continues an acceptance list; line 0, four digits or any stray word voids the whole marker.
 */
function markLabels(body: string): { lines: number[]; regression: boolean } | null {
  const lines: number[] = [];
  let regression = false;
  for (let at = 0; ;) {
    ITEM.lastIndex = at;
    const m = ITEM.exec(body);
    if (!m) return null;
    if (m[2]) regression = true;
    else if (m[1] || lines.length) lines.push(Number(m[1] ?? m[3]));
    else return null;
    at = ITEM.lastIndex;
    if (at === body.length) return { lines, regression };
    SEP.lastIndex = at;
    if (SEP.exec(body)) at = SEP.lastIndex;
    else if (!/\s/.test(body[at - 1])) return null;
  }
}

/** Only these may close a label list before free text in a near marker; 「、」 or a bare space never do. */
const NEAR_SEP = /\s*[;；,，]\s*/y;

/**
 * A near marker (i28-CONV6): acceptance labels, then 「; ； , ，」, then any note: 「[验收线 1、2;PM 定 4]」 → 1. Null for a
 * whole marker, a void one (line 0, four digits, a non-label start) or a note glued on without that separator.
 */
function nearLabelsLine(body: string): number | null {
  const lines: number[] = [];
  for (let at = 0; ;) {
    ITEM.lastIndex = at;
    const m = ITEM.exec(body);
    if (!m) return null;
    if (m[1] || (m[3] && lines.length)) lines.push(Number(m[1] ?? m[3]));
    else if (!m[2] || !lines.length) return null;
    at = ITEM.lastIndex;
    if (at === body.length) return null;
    NEAR_SEP.lastIndex = at;
    if (NEAR_SEP.exec(body)) {
      ITEM.lastIndex = NEAR_SEP.lastIndex;
      if (NEAR_SEP.lastIndex < body.length && !ITEM.exec(body)) return lines[0];
    }
    SEP.lastIndex = at;
    if (SEP.exec(body)) at = SEP.lastIndex;
    else if (!/\s/.test(body[at - 1])) return null;
  }
}

/** First near marker's first acceptance line in free text; whole markers are basisFromText's and never answer here. */
export function nearMarkLine(text: string): number | null {
  for (const m of text.matchAll(MARK)) {
    const n = nearLabelsLine(m[1] ?? m[2] ?? m[3] ?? m[4]);
    if (n !== null) return n;
  }
  return null;
}

/** The near-marker line in the same fields findingBasis reads (the field itself is never near: it is strict). */
export function nearFindingLine(f: BasisSource): number | null {
  return nearMarkLine(basisText(f));
}

/** The structured field as written; anything else is "no basis", never an error (a bad basis only costs the P1 its weight). */
export function basisField(v: unknown): FindingBasis | null {
  return typeof v === "string" && FIELD.test(v.trim()) ? v.trim() as FindingBasis : null;
}

/** First marker in free text: an acceptance line wins over a regression mark when both appear (it is the narrower claim). */
export function basisFromText(text: string): FindingBasis | null {
  let regression = false;
  for (const m of text.matchAll(MARK)) {
    const labels = markLabels(m[1] ?? m[2] ?? m[3] ?? m[4]);
    if (labels?.lines.length) return `acceptance:${labels.lines[0]}`;
    regression ||= !!labels?.regression;
  }
  for (const [heading] of text.matchAll(HEADING)) {
    const n = MARK_FIELD.exec(outsideBrackets(heading))?.[1];
    if (n) return `acceptance:${Number(n)}`;
  }
  return regression ? "regression" : null;
}

export interface BasisSource { basis?: unknown; findingId: string; family: string; probe: string; description?: string }

const basisText = (f: BasisSource): string => [f.findingId, f.family, f.probe, f.description ?? ""].join("\n");

/** The field first, then markers in the finding's own text (title fields, probe, description). */
export function findingBasis(f: BasisSource): FindingBasis | null {
  return basisField(f.basis) ?? basisFromText(basisText(f));
}

/** Wire-side check for the optional field: absent / null = none; present must be well-formed, or the verdict is refused. */
export function wireBasis(v: unknown, fail: (why: string) => never): { basis?: FindingBasis } {
  if (v === undefined || v === null) return {};
  return basisField(v) ? { basis: basisField(v) as FindingBasis } : fail("只认 \"acceptance:<验收线编号>\" 或 \"regression\"");
}
