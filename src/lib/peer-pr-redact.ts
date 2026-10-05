/**
 * What leaves this machine for a peer PR author (i28-A2 §5): sanitizeForeign (fold + dispatch-redact) first, then the masks it
 * lacks — Claude project dir names (-Users-<name>-), temp paths, this host's name and user, and every long hex that is not a
 * commit of the repository. Deterministic: same text + same identity / commit set → same output. The gate then runs on the
 * masked text (placeholders never count) and only answers refuse-or-not; a hit means nothing is sent. tests/peer-pr-redact.test.ts.
 */
import { hostname, userInfo } from "node:os";
import { REDACTED } from "./dispatch-redact.js";
import { sanitizeForeign } from "./order-wire-render.js";
import { redactFields } from "./redact-fields.js";

export const TEMP_DIR = "<本机临时目录>";
export const HEX_MASK = "[已脱敏:长十六进制]";
/** Every placeholder this path writes (dispatch-redact's and ours). */
const PLACEHOLDER = /\[已脱敏:(?:密钥|内网地址|个人信息|长十六进制)\]|<本机临时目录>/g;

export interface LocalIdentity { username: string; hostname: string }

export function localIdentity(): LocalIdentity {
  let username = "";
  try { username = userInfo().username; } catch (e) { console.error(`⚠️ [peer-pr] 读不到当前用户名，脱敏少一条规则：${(e as Error).message}`); }
  return { username, hostname: hostname() };
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TEMP = /(?:\/private)?\/var\/folders\/[^\s'"`<>)\]]*|\/private\/tmp\/[^\s'"`<>)\]]*|\/tmp\/claude-[^\s'"`<>)\]]*/g;
const PROJECT_DIR = /-(Users|home)-[^-\s/'"`]+(?=-)/g;
const LONG_HEX = /(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])/g;

/** Candidate commit ids in the text (40 / 64 hex), for the caller's `git cat-file --batch-check`. */
export function hexCandidates(text: string): string[] {
  return [...new Set([...text.matchAll(/(?<![0-9A-Za-z])(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![0-9A-Za-z])/g)].map((m) => m[0].toLowerCase()))];
}

function nameRules(id: LocalIdentity): [RegExp, string][] {
  const out: [RegExp, string][] = [];
  const host = id.hostname.trim();
  for (const h of new Set([host, host.replace(/\.local$/i, "")])) {
    if (h.length >= 3) out.push([new RegExp(`(?<![A-Za-z0-9_.-])${escape(h)}(?![A-Za-z0-9_-])`, "gi"), REDACTED.addr]);
  }
  const user = id.username.trim();
  if (user.length >= 3) out.push([new RegExp(`(?<![A-Za-z0-9_])${escape(user)}(?![A-Za-z0-9_])`, "gi"), REDACTED.personal]);
  return out;
}

/** `commits` = the 40 / 64-hex values the repository knows as commits (lowercase); the card's head belongs there. */
export function redactPeerPr(text: string, id: LocalIdentity, commits: ReadonlySet<string>): { text: string; count: number } {
  let out = sanitizeForeign(text);
  out = out.replace(TEMP, TEMP_DIR).replace(PROJECT_DIR, (_m, root: string) => `-${root}-${REDACTED.personal}`);
  for (const [re, to] of nameRules(id)) out = out.replace(re, to);
  out = out.replace(LONG_HEX, (m) => (commits.has(m.toLowerCase()) ? m : HEX_MASK));
  const placeholders = (s: string) => s.match(PLACEHOLDER)?.length ?? 0;
  return { text: out, count: Math.max(0, placeholders(out) - placeholders(text)) };
}

/** Invisible in a rendered report: format chars, combining marks and the blank-looking fillers (Hangul, braille). */
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}\u115F\u1160\u3164\uFFA0\u2800]+/gu;
const fold = (s: string): string => s.replace(INVISIBLE, "").normalize("NFKC").replace(INVISIBLE, "");

/**
 * redactFields is frozen and skips bare placeholder prefixes but counts quoted ones. In this audit-only copy, accept only
 * complete scalar masks; every other field still reaches that same parser. The marker cannot be supplied by report text.
 */
function fieldAudit(text: string): string {
  const supplied = new Set(text.toLowerCase().match(/__peer_pr_mask_\d+__/g));
  let marker = "__peer_pr_mask_0__";
  for (let i = 1; supplied.has(marker); i++) marker = `__peer_pr_mask_${i}__`;
  const audit = text.replace(PLACEHOLDER, marker).replaceAll("[已脱敏", "[untrusted-mask");
  const sensitive = String.raw`(?:[\w.-]*?(?:token|password|passwd|secret|api[_-]?key|apikey|authorization|credential|private[_-]?key)|key)`;
  const prefix = String.raw`((?:^|[\s{,;(\[?&])(["']?)${sensitive}\2\s*[:=][ \t]*|--[\w-]*?(?:token|password|secret|api-key|apikey)(?:\s+|=))`;
  const scalar = new RegExp(`${prefix}(["']?)${marker}\\3`, "gi");
  const lines = audit.split("\n");
  return lines.map((line, i) => line.replace(scalar, (match, key: string, _quote: string, _valueQuote: string, at: number) => {
    const tail = line.slice(at + match.length);
    // A quote ending the first part of a concatenation is not a complete field value.
    if (!/^[ \t]*(?:[}\]][ \t]*)*(?:$|[,;&][ \t]*(?:$|["']?[\w.-]+["']?[ \t]*[:=]))/.test(tail)) return match;
    const indent = line.match(/^[ \t]*/)![0].length;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (!next.trim()) continue;
      if (next.match(/^[ \t]*/)![0].length <= indent || /^\s*["']?[\w.-]+["']?\s*[:=]/.test(next)) break;
      // The redactor masks each bare continuation separately; every row must be a complete mask, not only the first one.
      if (next.trim() !== marker) return match;
    }
    return key + REDACTED.secret;
  })).join("\n");
}
/**
 * Prefixes that cannot start inside a word ("task-…" is not a key): matched only at a token start, blanks allowed between the
 * prefix's own characters too ("s k - …" is the same key), then the value is read past blanks.
 */
const ANCHORED = /(?<![A-Za-z0-9])(?:s\s*k\s*-|t\s*o\s*k\s*_)/g;
const ANCHORED_FULL = /^(?:sk-[A-Za-z0-9_-]{16,}|tok_[A-Za-z0-9]{8,})/;
const DISTINCT = /gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN[A-Z]*PRIVATEKEY-----/;
const RANDOM = /(?=[\w-]*\d)(?=[\w-]*[A-Z])(?=[\w-]*[a-z])[\w-]{32,}/;

/** `text` with blanks removed, and for every index of `text` where it lands in that string (any run of blanks reads as none). */
function flatten(text: string): { flat: string; at: Int32Array } {
  const at = new Int32Array(text.length + 1);
  const kept: string[] = [];
  for (let i = 0; i < text.length; i++) {
    at[i] = kept.length;
    if (!/\s/.test(text[i]!)) kept.push(text[i]!);
  }
  at[text.length] = kept.length;
  return { flat: kept.join(""), at };
}

/**
 * The first rule the (already masked) text trips, or null. Blank-split keys: prefix / Bearer / PEM rules read the text with
 * blanks removed; long hex and random strings are judged per blank-separated token after the known commits are taken out,
 * so a line of short shas never joins into one long value.
 */
export function peerPrSecretHit(text: string, commits: ReadonlySet<string>): string | null {
  const folded = fold(text);
  if (redactFields(fieldAudit(folded), REDACTED.secret).count > 0) return "敏感字段名";
  const t = folded.replace(PLACEHOLDER, REDACTED.secret);
  const bare = t.replaceAll(REDACTED.secret, "\u0000");
  const { flat, at } = flatten(bare);
  if (DISTINCT.test(flat)) return "密钥前缀";
  for (const m of bare.matchAll(ANCHORED)) if (ANCHORED_FULL.test(flat.slice(at[m.index]!, at[m.index]! + 48))) return "密钥前缀";
  for (const m of flat.matchAll(/Bearer([A-Za-z0-9._~+/=-]{8,})/gi)) if (/\d/.test(m[1]!)) return "Bearer";
  for (const raw of bare.split(/\s+/)) {
    let token = raw;
    for (const sha of hexCandidates(raw)) if (commits.has(sha)) token = token.replace(new RegExp(sha, "gi"), "\u0000");
    if (/[0-9a-f]{32,}/i.test(token)) return "长十六进制";
    if (RANDOM.test(token)) return "随机串";
  }
  return null;
}
