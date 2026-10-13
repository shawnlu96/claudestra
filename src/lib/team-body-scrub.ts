/**
 * Home-side scrub of card body text before it is uploaded to the center (team-project-TEAMVIS2). Detection is the
 * shared-ledger upload gate itself (shared-ledger-scrub.ts, imported, never copied), so every rule that refuses a
 * ledger upload masks body text too. The whole text is judged first; a hit masks whole segments (a paragraph, a
 * fenced code block, a private-key block), never a substring, and the result is judged again as a whole: a hit that
 * survives masking refuses the text instead of returning it half masked. Over-masking is the accepted cost.
 * Truncate only after scrubbing: a cut through a secret leaves a piece no rule recognises (scrubSessionPage).
 * tests/team-body-scrub.test.ts.
 */
import { REDACTED } from "./dispatch-redact.js";
import { localIdentity } from "./peer-pr-redact.js";
import { redactFields } from "./redact-fields.js";
import { scrubSharedLedger, SharedLedgerScrubError, type SharedLedgerScrubContext } from "./shared-ledger-scrub.js";

/** Bump by hand whenever the rule set or the segment rules change; uploaded records carry it. */
export const TEAM_BODY_SCRUB_VERSION = 1;
export const TEAM_BODY_MASK = "[已遮蔽:疑似密钥]";
/** Characters of one tool output kept on a session page. */
export const TEAM_BODY_TOOL_OUTPUT_MAX = 2000;
/** Scrubbed beyond the cut so a secret straddling it is still seen whole; no real key is longer than this. */
const TOOL_OUTPUT_LOOKAHEAD = 64 * 1024;
/** Rounds of the cross-segment search before giving up and refusing. */
const SPAN_ROUNDS = 4;

/** refused: the text must not leave; `text` is then empty. maskedSegments counts whole segments replaced by the mask. */
export interface TeamBodyScrub { text: string; maskedSegments: number; refused: boolean; scrubVersion: number }
export interface TeamSessionMessage { text: string; tool?: boolean }

/** Body lines [start, end) then blank lines [end, next). force: holds a private-key marker, masked whatever the rules say. */
interface Segment { start: number; end: number; next: number; force: boolean }

const blank = (line: string): boolean => /^\s*$/.test(line);
const FENCE = /^\s*(`{3,}|~{3,})/;
const PEM_MARK = /-----(BEGIN|END)[A-Z \t]*PRIVATE[ \t]*KEY/g;

/**
 * Paragraphs split at blank lines. A fenced code block is one segment up to its closing fence (or the end of the text),
 * and a private-key block keeps its paragraph open across blank lines until its END line (or the end of the text):
 * base64 lines with "+" / "/" trip no rule on their own once the BEGIN line is gone.
 */
function segmentsOf(lines: readonly string[]): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = i;
    let force = false;
    const fence = FENCE.exec(lines[i]!);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      i++;
      while (i < lines.length && !close.test(lines[i]!)) i++;
      if (i < lines.length) i++;
    } else {
      let pem = false;
      for (; i < lines.length; i++) {
        const line = lines[i]!;
        if (!pem && (blank(line) || (i > start && FENCE.test(line)))) break;
        for (const mark of line.matchAll(PEM_MARK)) {
          pem = mark[1] === "BEGIN";
          force = true;
        }
      }
    }
    const end = i;
    while (i < lines.length && blank(lines[i]!)) i++;
    out.push({ start, end, next: i, force });
  }
  return out;
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
  const done = (out: string, maskedSegments: number, refused = false): TeamBodyScrub =>
    ({ text: refused ? "" : out, maskedSegments, refused, scrubVersion: TEAM_BODY_SCRUB_VERSION });
  if (!hits(text, context)) return done(text, 0);
  const lines = text.split("\n");
  const segments = segmentsOf(lines);
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
  // so every line it rewrites in the whole text marks its segment, even one that is clean when read alone.
  const fields = redactFields(text, REDACTED.secret).text.split("\n");
  const aligned = fields.length === lines.length;
  segments.forEach((s, k) => {
    if (s.end === s.start) return;
    let touched = !aligned;
    for (let line = s.start; !touched && line < s.end; line++) touched = fields[line] !== lines[line];
    masked[k] = s.force || touched || hits(body(s), context);
  });
  // What is left spans segments (a key split by a blank line). Narrow it to the shortest run that still trips and mask
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
 * One result per message, same order. A tool output is scrubbed, then cut to TEAM_BODY_TOOL_OUTPUT_MAX, then judged once
 * more by the same function: cutting first would leave the head of a key that straddles the cut, and no rule knows half
 * a key. A refused message carries no text; whether that refuses the whole page is the caller's decision.
 */
export function scrubSessionPage(messages: readonly TeamSessionMessage[], context?: SharedLedgerScrubContext): TeamBodyScrub[] {
  return messages.map((message) => {
    if (!message.tool) return scrubTeamBody(message.text, context);
    const whole = scrubTeamBody(message.text.slice(0, TEAM_BODY_TOOL_OUTPUT_MAX + TOOL_OUTPUT_LOOKAHEAD), context);
    if (whole.refused) return whole;
    const head = cut(whole.text, TEAM_BODY_TOOL_OUTPUT_MAX);
    const again = scrubTeamBody(head, context);
    // Masks the first pass wrote and the cut kept, plus whatever the second pass still had to mask.
    return { ...again, maskedSegments: Math.min(maskCount(head), whole.maskedSegments) + again.maskedSegments };
  });
}
