/**
 * Refuse secrets before peer dispatch; address / personal-info masking belongs to dispatch-redact.ts.
 * Prefixes, Bearer, PEM and hex still ignore whitespace; only a whole, exact ledger head in free text is exempt.
 * Random checks exempt word-shaped identifiers and filenames; adjacent fragments of at least eight characters may join.
 * Shorter whitespace pieces and character-by-character separators are known limits; this gate guards accidental pastes, not deliberate encoding.
 */
import { redactFields } from "./redact-fields.js";

const RULES: readonly (readonly [string, RegExp])[] = [
  ["密钥前缀", /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|tok_[A-Za-z0-9]{8,}/],
  ["Bearer", /Bearer[A-Za-z0-9._~+/=-]{8,}/i],
  ["私钥块", /-----BEGIN[A-Z]*PRIVATEKEY-----/],
];

/** Folded text has no control characters, so this placeholder never makes a real value look already masked. */
const SENTINEL = "\u0000";

/** Lowercase word runs distinguish source names from mixed random pastes without a density threshold. */
function identifier(value: string): boolean {
  return value.split(/[_-]/).filter(Boolean).every((part) => {
    if (/^(?:[a-z]+|[A-Z]+)\d+[a-z]?$/.test(part)) return true;
    const words = part.match(/[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+/g) ?? [];
    return words.join("") === part && words.every((word, i) => /^[A-Z]+$|^\d+$/.test(word)
      || word.replace(/^[A-Z]/, "").length >= 3
      || /^(?:id|to|by|on|of|as|in|is|db|ws|ui|api|url|uri|pi|for|mac|pro|get|set|put|use|has|key|ref|map|max|min|new|row|adv)$/i.test(word)
      || (i === 0 && /^[a-z]$/.test(word) && /^\d+$/.test(words[i + 1] ?? "")));
  });
}

/** Word-shaped random values and unusual digit-heavy camelCase remain heuristic ambiguities, outside the finite corpus guarantee. */
function randomValue(value: string): boolean {
  return value.length >= 32 && /[A-Z]/.test(value) && /[a-z]/.test(value) && !identifier(value);
}

/** Only long copy/wrap fragments join; pieces shorter than eight characters are a known protection limit. */
function randomHit(text: string): boolean {
  let end = 0;
  let parts: string[] = [];
  for (const match of text.matchAll(/[A-Za-z0-9_-]+/g)) {
    const token = match[0];
    if (randomValue(token)) return true;
    if (token.length >= 8) {
      if (!/^\s+$/.test(text.slice(end, match.index))) parts = [];
      parts.push(token);
      if (parts.length > 3) parts.shift();
      if (parts.length >= 2 && randomValue(parts.join(""))) return true;
      if (parts.length === 3 && randomValue(parts.slice(1).join(""))) return true;
    } else parts = [];
    end = match.index + token.length;
  }
  return false;
}

/** The caller has already NFKC / zero-width folded the text; pass a ledger head only for free-text fields. */
export function peerSecretHit(folded: string): string | null;
export function peerSecretHit(folded: string, ledgerHead: string | null): string | null;
export function peerSecretHit(folded: string, ledgerHead?: string | null): string | null {
  if (redactFields(folded, SENTINEL).count > 0) return "敏感字段名";
  const flat = folded.replace(/\s+/g, "");
  const hit = RULES.find(([, re]) => re.test(flat))?.[0];
  if (hit) return hit;
  // Deleting whitespace can attach a real sk prefix to the preceding word; retain its original left boundary too.
  if (/(?<![A-Za-z0-9])s\s*k\s*-\s*(?:[A-Za-z0-9_-]\s*){16,}/.test(folded)) return "密钥前缀";
  const text = typeof ledgerHead === "string" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(ledgerHead)
    ? folded.replace(new RegExp(`(?<![\\w-])${ledgerHead}(?![\\w-])`, "g"), SENTINEL) : folded;
  if (/[0-9a-f]{32,}/i.test(text.replace(/\s+/g, ""))) return "长十六进制";
  return randomHit(text) ? "随机串" : null;
}
