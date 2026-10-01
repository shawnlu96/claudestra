/**
 * Refuse secrets before peer dispatch; address / personal-info masking belongs to dispatch-redact.ts.
 * Prefixes, Bearer, PEM and hex still ignore whitespace; only a whole, exact ledger head in free text is exempt.
 * Random checks join all adjacent ASCII fragments across whitespace, then measure 32-character windows.
 * Category-switch density separates random values from prose; word-shaped split pieces must never bypass the gate. Tests: peer-secret-gate*.
 */
import { redactFields } from "./redact-fields.js";

const RULES: readonly (readonly [string, RegExp])[] = [
  ["密钥前缀", /sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|tok_[A-Za-z0-9]{8,}/],
  ["Bearer", /Bearer[A-Za-z0-9._~+/=-]{8,}/i],
  ["私钥块", /-----BEGIN[A-Z]*PRIVATEKEY-----/],
];

/** Folded text has no control characters, so this placeholder never makes a real value look already masked. */
const SENTINEL = "\u0000";

/** A 32-character window needs all three classes and at least 14 letter/digit class switches (14/31).
 * Separators contribute no switches: report filenames and prose stay below the density of mixed random values.
 */
function randomWindow(value: string): boolean {
  const classes = [...value].map((c) => /[a-z]/.test(c) ? 0 : /[A-Z]/.test(c) ? 1 : /[0-9]/.test(c) ? 2 : 3);
  const counts = [0, 0, 0, 0];
  let switches = 0;
  const change = (a: number, b: number) => a < 3 && b < 3 && a !== b ? 1 : 0;
  for (let i = 0; i < classes.length; i++) {
    counts[classes[i]!]!++;
    if (i > 0) switches += change(classes[i - 1]!, classes[i]!);
    if (i >= 32) {
      counts[classes[i - 32]!]!--;
      switches -= change(classes[i - 32]!, classes[i - 31]!);
    }
    if (i >= 31 && switches >= 14 && counts[0]! > 0 && counts[1]! > 0 && counts[2]! > 0) return true;
  }
  return false;
}

/** Whitespace never breaks an ASCII run, even when a secret's middle piece happens to spell a word. */
function randomHit(text: string): boolean {
  for (const match of text.matchAll(/[A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+)*/g)) {
    const value = match[0].replace(/\s+/g, "");
    if (value.length >= 32 && randomWindow(value)) return true;
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
