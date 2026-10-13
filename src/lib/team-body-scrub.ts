/**
 * Home-side scrub of card body text before it is uploaded to the center (team-project-TEAMVIS2). Detection is the
 * shared-ledger upload gate itself (shared-ledger-scrub.ts, imported, never copied), so every rule that refuses a
 * ledger upload masks body text too. The whole text is judged first; a hit masks whole segments (a paragraph, a
 * fenced code block, a private-key block), never a substring, and the result is judged again as a whole: a hit that
 * survives masking refuses the text instead of returning it half masked. Over-masking is the accepted cost.
 * Segments and the extent of a secret are read on the gate's own view of the text (invisible characters dropped, NFKC,
 * blanks removed where the gate removes them), line for line, and masked in the original: a zero-width or full-width
 * spelling the gate sees through must not hide where a key block or a field value ends.
 * Truncate only after scrubbing the complete text: a cut through a secret leaves a piece no rule recognises (scrubSessionPage).
 * tests/team-body-scrub.test.ts.
 */
import { REDACTED } from "./dispatch-redact.js";
import { localIdentity } from "./peer-pr-redact.js";
import { redactFields } from "./redact-fields.js";
import { scrubSharedLedger, SharedLedgerScrubError, type SharedLedgerScrubContext } from "./shared-ledger-scrub.js";

/** Bump by hand whenever the rule set or the segment rules change; uploaded records carry it. */
export const TEAM_BODY_SCRUB_VERSION = 2;
export const TEAM_BODY_MASK = "[已遮蔽:疑似密钥]";
/** Characters of one tool output kept on a session page. */
export const TEAM_BODY_TOOL_OUTPUT_MAX = 2000;
/** Rounds of the cross-segment search before giving up and refusing. */
const SPAN_ROUNDS = 4;

/** refused: the text must not leave; `text` is then empty. maskedSegments counts whole segments replaced by the mask. */
export interface TeamBodyScrub { text: string; maskedSegments: number; refused: boolean; scrubVersion: number }
export interface TeamSessionMessage { text: string; tool?: boolean }

/** Body lines [start, end) then blank lines [end, next). force: holds a secret that runs across lines, masked whatever the rules say. */
interface Segment { start: number; end: number; next: number; force: boolean }

const blank = (line: string): boolean => /^\s*$/.test(line);
const FENCE = /^\s*(`{3,}|~{3,})/;

/** peer-pr-redact.ts drops these before it judges (not exported there). */
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}\u115F\u1160\u3164\uFFA0\u2800]+/gu;
/**
 * One line as the gate's rules read it: both of its folds (peer-pr-redact.ts, order-wire-render.ts) drop invisible characters
 * around an NFKC pass, and controls read as blanks. Neither adds nor removes a "\n", so view line k is original line k.
 */
const fold = (line: string): string => /^[\x20-\x7e]*$/.test(line) ? line
  : line.replace(INVISIBLE, "").normalize("NFKC").replace(INVISIBLE, "").replace(/[\p{Cc}\u2028\u2029]/gu, " ");

// Where a secret the gate reads with blanks removed starts and how far it runs. The gate stops at the shortest piece that
// trips; the value goes on for as long as its characters do, across line and paragraph breaks ("s k -" is the same key).
const PEM_BEGIN = /-----BEGIN[A-Z]*PRIVATEKEY-----/g;
const PEM_END = /-----END[A-Z]*PRIVATEKEY-----/g;
const PREFIXED = /gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16,}/g;
const BEARER = /Bearer([A-Za-z0-9._~+/=-]{8,})/gi;
const ANCHORED = /(?<![A-Za-z0-9])(?:s\s*k\s*-|t\s*o\s*k\s*_)/g;
const ANCHORED_FULL = /(?:sk-[A-Za-z0-9_-]{16,}|tok_[A-Za-z0-9]{8,})/y;

/**
 * Line ranges [first, last] of the secrets that can run across lines, found on the view with blanks removed. A private-key
 * block runs to its END marker (or the end of the text: base64 lines trip no rule once the BEGIN line is gone); a prefixed
 * key or a Bearer value runs to the first character that cannot belong to it. Text that follows a key with nothing but
 * blanks and key characters between is taken with it: over-masking, never a tail left behind.
 */
function runsOf(view: readonly string[]): [number, number][] {
  const starts: number[] = [];
  const parts: string[] = [];
  let length = 0;
  for (const line of view) {
    const part = line.replace(/\s+/g, "");
    starts.push(length);
    parts.push(part);
    length += part.length;
  }
  const flat = parts.join("");
  /** The line holding flat offset `at`: the last one that starts at or before it. */
  const lineAt = (at: number): number => {
    let low = 0, high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= at) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const runs: [number, number][] = [];
  for (const begin of flat.matchAll(PEM_BEGIN)) {
    PEM_END.lastIndex = begin.index + begin[0].length;
    const end = PEM_END.exec(flat);
    runs.push([lineAt(begin.index), end ? lineAt(end.index + end[0].length - 1) : view.length - 1]);
    if (!end) break; // Everything after an unclosed block is already taken.
  }
  for (const match of flat.matchAll(PREFIXED)) runs.push([lineAt(match.index), lineAt(match.index + match[0].length - 1)]);
  for (const match of flat.matchAll(BEARER)) {
    if (/\d/.test(match[1]!)) runs.push([lineAt(match.index), lineAt(match.index + match[0].length - 1)]);
  }
  // These prefixes count only at a token start, which the text with its blanks decides; the value is then read without them.
  const text = view.join("\n");
  const blanks = text.matchAll(/\s+/g);
  let next = blanks.next(), removed = 0;
  for (const match of text.matchAll(ANCHORED)) {
    while (!next.done && next.value.index < match.index) {
      removed += next.value[0].length;
      next = blanks.next();
    }
    ANCHORED_FULL.lastIndex = match.index - removed;
    const full = ANCHORED_FULL.exec(flat);
    if (full) runs.push([lineAt(full.index), lineAt(full.index + full[0].length - 1)]);
  }
  return runs;
}

/**
 * Paragraphs split at blank lines; a fenced code block is one segment up to its closing fence (or the end of the text).
 * Segments a run touches are joined into one forced segment. Lines are the gate's view (fold), indexes fit the original.
 */
function segmentsOf(lines: readonly string[]): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = i;
    const fence = FENCE.exec(lines[i]!);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      i++;
      while (i < lines.length && !close.test(lines[i]!)) i++;
      if (i < lines.length) i++;
    } else {
      while (i < lines.length && !blank(lines[i]!) && !(i > start && FENCE.test(lines[i]!))) i++;
    }
    const end = i;
    while (i < lines.length && blank(lines[i]!)) i++;
    out.push({ start, end, next: i, force: false });
  }
  const runs = runsOf(lines);
  if (!runs.length) return out;
  /** The segment holding a line. */
  const at = (line: number): number => {
    let low = 0, high = out.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (out[middle]!.start <= line) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  // Difference arrays: runs may overlap and there may be many of them.
  const force = new Int32Array(out.length + 1), glue = new Int32Array(out.length + 1);
  for (const [first, last] of runs) {
    const from = at(first), to = at(last);
    force[from]!++;
    force[to + 1]!--;
    glue[from]!++;
    glue[to]!--;
  }
  const joined: Segment[] = [];
  let forced = 0, glued = 0, open = false;
  out.forEach((s, k) => {
    forced += force[k]!;
    if (open) Object.assign(joined[joined.length - 1]!, { end: s.end, next: s.next });
    else joined.push({ ...s, force: forced > 0 });
    glued += glue[k]!;
    open = glued > 0;
  });
  return joined;
}

function hits(text: string, context: SharedLedgerScrubContext): boolean {
  try {
    scrubSharedLedger({ description: text }, (value) => value, context);
    return false;
  } catch (error) {
    if (error instanceof SharedLedgerScrubError) return true;
    throw error;
  }
}

/** Without a context: this machine's identity and no known commits, so every long hex (a head included) is masked. */
export function scrubTeamBody(text: string, context: SharedLedgerScrubContext = { identity: localIdentity() }): TeamBodyScrub {
  return scrub(text, context, Infinity);
}

/**
 * keep: the caller sends only the first `keep` characters of the result. The whole text is still read for where secrets
 * start and end; segments that begin after that many characters are masked unjudged, which saves a gate call for each
 * paragraph of a long tool output and can only mask more.
 */
function scrub(text: string, context: SharedLedgerScrubContext, keep: number): TeamBodyScrub {
  const done = (out: string, maskedSegments: number, refused = false): TeamBodyScrub =>
    ({ text: refused ? "" : out, maskedSegments, refused, scrubVersion: TEAM_BODY_SCRUB_VERSION });
  if (!hits(text, context)) return done(text, 0);
  const lines = text.split("\n");
  const view = lines.map(fold);
  const segments = segmentsOf(view);
  const body = (s: Segment): string => lines.slice(s.start, s.end).join("\n");
  const masked = segments.map(() => false);
  /** Segments [from, to] as they would be sent, with the blank lines between them. */
  const render = (from = 0, to = segments.length - 1): string => {
    const out: string[] = [];
    for (let k = from; k <= to; k++) {
      const s = segments[k]!;
      if (masked[k]) out.push(TEAM_BODY_MASK);
      else out.push(...lines.slice(s.start, s.end));
      out.push(...lines.slice(s.end, k === to ? s.end : s.next));
    }
    if (to === segments.length - 1) out.push(...lines.slice(segments[to]!.end));
    return out.join("\n");
  };
  // A field value may run on past a blank line (block scalar, unclosed quote): the field redactor keeps the line count,
  // so every line it rewrites in the whole view marks its segment, even one that is clean when read alone. The view, as
  // the gate names fields on it ("ｐａｓｓｗｏｒｄ", a zero-width split name); and no value is trusted for looking masked
  // already, which the redactor would skip and the gate does not.
  const named = view.map((line) => line.replaceAll("[已脱敏", "[未脱敏"));
  const fields = redactFields(named.join("\n"), REDACTED.secret).text.split("\n");
  const aligned = fields.length === lines.length;
  // The redactor ends a value early where it does not know the block header ("|2", "| # note", "!!str |": a plain value
  // to it, over at the first line that looks like a field). A value goes on for as long as lines are indented deeper than
  // the line the redactor rewrote, blank lines between them included: YAML's own rule, and it can only mask more.
  const valued = new Uint8Array(lines.length);
  for (let line = 0, under = -1; aligned && line < lines.length; line++) {
    if (blank(view[line]!)) continue;
    const indent = /^\s*/.exec(view[line]!)![0].length;
    if (indent <= under) under = -1;
    if (under >= 0) valued[line] = 1;
    else if (fields[line] !== named[line]) { valued[line] = 1; under = indent; }
  }
  let sent = 0; // Never more than the characters rendered so far.
  segments.forEach((s, k) => {
    if (s.end === s.start) return;
    let touched = !aligned || sent > keep;
    for (let line = s.start; !touched && line < s.end; line++) touched = valued[line] === 1;
    masked[k] = s.force || touched || hits(body(s), context);
    sent += masked[k] ? TEAM_BODY_MASK.length : body(s).length;
  });
  // What is left spans segments in a way no run names (a known value with a blank line in it). Narrow it to the shortest run that still trips and mask
  // that run whole. The searches assume a longer run trips whenever a shorter one does; where that fails the final
  // whole-text check below still refuses.
  for (let round = 0; round < SPAN_ROUNDS && hits(render(), context); round++) {
    let low = 0, high = segments.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (hits(render(0, middle), context)) high = middle;
      else low = middle + 1;
    }
    const last = low;
    low = 0;
    high = last;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (hits(render(middle, last), context)) low = middle;
      else high = middle - 1;
    }
    let changed = false;
    for (let k = low; k <= last; k++) {
      if (masked[k] || segments[k]!.end === segments[k]!.start) continue;
      masked[k] = changed = true;
    }
    if (!changed) break;
  }
  const out = render();
  const count = masked.filter(Boolean).length;
  return done(out, count, hits(out, context));
}

/** The first `max` characters of scrubbed text, never half a mask and never half a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  for (let part = 1; part < TEAM_BODY_MASK.length; part++) {
    if (text.startsWith(TEAM_BODY_MASK, max - part)) end = max - part;
  }
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

const maskCount = (text: string): number => text.split(TEAM_BODY_MASK).length - 1;

/**
 * One result per message, same order. A tool output is scrubbed complete, whatever its length, then cut to
 * TEAM_BODY_TOOL_OUTPUT_MAX, then judged once more by the same function: cutting first, at any distance, leaves the head
 * of a key whose rest lies beyond the cut (blanks may stretch a key without limit), and no rule knows half a key.
 * A refused message carries no text; whether that refuses the whole page is the caller's decision.
 */
export function scrubSessionPage(messages: readonly TeamSessionMessage[], context?: SharedLedgerScrubContext): TeamBodyScrub[] {
  return messages.map((message) => {
    if (!message.tool) return scrubTeamBody(message.text, context);
    const whole = scrub(message.text, context ?? { identity: localIdentity() }, TEAM_BODY_TOOL_OUTPUT_MAX);
    if (whole.refused) return whole;
    const head = cut(whole.text, TEAM_BODY_TOOL_OUTPUT_MAX);
    const again = scrubTeamBody(head, context);
    // Masks the first pass wrote and the cut kept, plus whatever the second pass still had to mask.
    return { ...again, maskedSegments: Math.min(maskCount(head), whole.maskedSegments) + again.maskedSegments };
  });
}
