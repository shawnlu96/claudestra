/**
 * Refuse secrets before peer dispatch; address / personal-info masking belongs to dispatch-redact.ts.
 * Prefixes, Bearer, PEM and hex still ignore whitespace; only a whole, exact ledger head in free text is exempt.
 * Random values are checked per token, joining adjacent non-word fragments, including single characters, never English sentences or ids.
 * Flattening prose for that rule again would strand peer repair orders containing review reports. Tests: peer-secret-gate*.
 */
import { redactFields } from "./redact-fields.js";

const RULES: readonly (readonly [string, RegExp])[] = [
  ["密钥前缀", /sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|tok_[A-Za-z0-9]{8,}/],
  ["Bearer", /Bearer[A-Za-z0-9._~+/=-]{8,}/i],
  ["私钥块", /-----BEGIN[A-Z]*PRIVATEKEY-----/],
];

/** Folded text has no control characters, so this placeholder never makes a real value look already masked. */
const SENTINEL = "\u0000";

/** Word-shaped segments keep camelCase, snake_case and lend/card ids out of the random-value heuristic. */
function identifier(token: string): boolean {
  const camel = (part: string) => /^(?:[a-z]+\d*|[A-Z][a-z]+\d*)(?:[A-Z][a-z]+\d*|[A-Z]+\d*)+$/.test(part)
    && (part.match(/[A-Za-z][a-z]{2,}/g)?.length ?? 0) >= 2;
  const word = /^(?:[a-z]+|[A-Z][a-z]+|[A-Z]+)(?:\d+[a-z]?)?$|^\d+$/;
  const acronym = (part: string) => /^[A-Za-z][a-z]{2,}(?:[A-Z][a-z]{2,})*[A-Z]{2,}\d*$/.test(part);
  return camel(token) || acronym(token) || (/[_-]/.test(token) && token.split(/[_-]/).every((part) => word.test(part) || camel(part) || acronym(part)));
}

/** Ordinary words and identifiers stop joins; short random fragments must not reset a split secret. */
function randomBarrier(token: string): boolean {
  return /^(?:[a-z]{2,}|[A-Z][a-z]+|\d{2,})$/.test(token) || identifier(token);
}

/** Punctuation breaks a join; whitespace joins non-word fragments before testing the combined value. */
function randomHit(text: string): boolean {
  let end = 0;
  let run = "";
  for (const match of text.matchAll(/[\w-]+/g)) {
    const token = match[0];
    if (!randomBarrier(token)) {
      run = run && /^\s+$/.test(text.slice(end, match.index)) ? run + token : token;
      if (run.length >= 32 && /\d/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run)) return true;
    } else run = "";
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
  const text = typeof ledgerHead === "string" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(ledgerHead)
    ? folded.replace(new RegExp(`(?<![\\w-])${ledgerHead}(?![\\w-])`, "g"), SENTINEL) : folded;
  if (/[0-9a-f]{32,}/i.test(text.replace(/\s+/g, ""))) return "长十六进制";
  return randomHit(text) ? "随机串" : null;
}
