/**
 * Refuse-first secret gate for orders leaving this machine (docs/design/remote-capacity.md §2.1): dispatch-redact.ts masks
 * addresses and personal info, this only answers "refuse or not" for secrets. It reads a copy with every blank removed, so a
 * tab / space / newline split cannot hide a key, and no rule leans on \b (an "_" prefix defeats it). Refusing an innocent
 * order is the accepted cost: it stays on this machine for a local worker. tests/order-wire.test.ts "peer rendering".
 */
import { redactFields } from "./redact-fields.js";

const RULES: readonly (readonly [string, RegExp])[] = [
  ["密钥前缀", /sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|tok_[A-Za-z0-9]{8,}/],
  ["Bearer", /Bearer[A-Za-z0-9._~+/=-]{8,}/i],
  ["私钥块", /-----BEGIN[A-Z]*PRIVATEKEY-----/],
  // 32 hex: md5-sized keys and any git sha, the order's own head included: head travels only in its own field.
  ["长十六进制", /[0-9a-f]{32,}/i],
  ["随机串", /(?=[\w-]*\d)(?=[\w-]*[A-Z])(?=[\w-]*[a-z])[\w-]{32,}/],
];

/** Folded text has no control characters, so this placeholder never makes a real value look already masked. */
const SENTINEL = "\u0000";

/** The first secret rule `folded` (already NFKC / zero-width folded) trips, or null. No value is exempt, head included. */
export function peerSecretHit(folded: string): string | null {
  if (redactFields(folded, SENTINEL).count > 0) return "敏感字段名";
  const flat = folded.replace(/\s+/g, "");
  return RULES.find(([, re]) => re.test(flat))?.[0] ?? null;
}
