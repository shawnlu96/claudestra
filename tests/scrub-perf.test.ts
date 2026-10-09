import { expect, test } from "bun:test";
import { peerPrSecretHit, redactPeerPr } from "../src/lib/peer-pr-redact.ts";
import { scrubSharedLedger, SharedLedgerScrubError } from "../src/lib/shared-ledger-scrub.ts";
import { legacyPeerPrSecretHit, redactPeerPr as legacyRedactPeerPr } from "./scrub-perf-legacy.test.ts";

import { parseSharedLedgerImport } from "../src/lib/shared-ledger-contract-transfer.ts";
import { scrubPerfPayload } from "./scrub-perf-fixture.test.ts";
import { redactFields } from "../src/lib/redact-fields.ts";
import { legacyRedactFields } from "./scrub-perf-legacy-fields.test.ts";

const identity = { username: "fixture-user", hostname: "fixture-host" };
const commits = new Set(["ab".repeat(20), "cd".repeat(32)]);

function scrub(payload: ReturnType<typeof scrubPerfPayload>) {
  try { scrubSharedLedger(payload, parseSharedLedgerImport, { identity, commits }); return "allowed"; }
  catch (error) {
    if (!(error instanceof SharedLedgerScrubError)) throw error;
    return "refused";
  }
}

function randomSource() {
  let state = 1;
  return (alphabet: string, length: number) => {
    let out = "";
    for (let i = 0; i < length; i++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      out += alphabet[(state >>> 0) % alphabet.length];
    }
    return out;
  };
}

test("N8A7 reproduction: 130 long uninterrupted x fields scrub within 2 seconds", () => {
  const strings = Array.from({ length: 130 }, () => "x".repeat(16000));
  const payload = scrubPerfPayload(strings);
  const started = performance.now();
  expect(scrub(payload)).toBe("allowed");
  expect(performance.now() - started).toBeLessThanOrEqual(2000);
}, 60_000);

test("N8A7 equal-sized base64 and ordinary English scrub within 2 seconds", () => {
  const random = randomSource();
  for (const kind of ["base64", "english"]) {
    const strings = Array.from({ length: 130 }, () => kind === "base64"
      ? random("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", 16000)
      : "The ordinary report contains readable words and useful details. ".repeat(254).slice(0, 16000));
    const payload = scrubPerfPayload(strings);
    const started = performance.now();
    expect(scrub(payload)).toBe(kind === "base64" ? "refused" : "allowed");
    expect(performance.now() - started).toBeLessThanOrEqual(2000);
  }
}, 60_000);

test("N8A7 uninterrupted dash runs do not retry a flag suffix at every position", () => {
  const payload = scrubPerfPayload(Array.from({ length: 130 }, () => "-".repeat(16000)));
  const started = performance.now();
  expect(scrub(payload)).toBe("allowed");
  expect(performance.now() - started).toBeLessThanOrEqual(2000);
}, 60_000);

test("N8A7 fixed-seed mixed corpus preserves the old first-hit verdict", () => {
  const random = randomSource();
  const corpus = ["", "x".repeat(16000), "X".repeat(16000), "9".repeat(16000), "-".repeat(512),
    "sk-" + "a1".repeat(10), "ghp_" + "A1b2".repeat(6), "s k - a b c d e f g h i j k l m n o p q r",
    "tok_abcdefgh12", "task-scheduler-pass-tick-review-merge", "stock_quantity_lookup", "Bearer abc123def456",
    "-----BEGIN RSA PRIVATE KEY-----", "a".repeat(32), "ab".repeat(20), "cd".repeat(32),
    "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNbVc", '{"password": "hunter2hunter2"}',
    "token: [已脱敏:密钥]", 'token: "[已脱敏:密钥]" + "raw-value"', "token: [已脱敏:密钥]\n  raw-value",
    "__peer_pr_mask_0__ token: [已脱敏:密钥]", "sk-abcdefghijklmnopqrstuvwx".split("").join("\u200b")];
  const alphabets = ["x", "X", "9", "_-", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-", "abcABC09+/=."];
  const wraps = ["", " ", "\n", "\t", ".", "/", "-", "\u0000", "\u200b", "\u034f", "\u3164"];
  for (let i = 0; i < 2400; i++) {
    const value = random(alphabets[i % alphabets.length]!, [7, 8, 16, 31, 32, 33, 40, 64, 128, 512][i % 10]!);
    const wrap = wraps[i % wraps.length]!;
    const split = i % (value.length + 1);
    const joined = value.slice(0, split) + wrap + value.slice(split);
    corpus.push(i % 4 === 0 ? `${corpus[4 + i % 19]} ${joined}` : joined);
  }
  for (const value of corpus) {
    expect(peerPrSecretHit(value, commits)).toBe(legacyPeerPrSecretHit(value, commits));
    expect(peerPrSecretHit(value, new Set())).toBe(legacyPeerPrSecretHit(value, new Set()));
    expect(redactPeerPr(value, identity, commits)).toEqual(legacyRedactPeerPr(value, identity, commits));
    expect(redactFields(value, "[mask]")).toEqual(legacyRedactFields(value, "[mask]"));
  }
}, 60_000);

test("N8A7 flag scanning preserves start positions, separator greediness and the consumed value", () => {
  const flags = ["--debug", "--token", "--SECRET", "prefix--debug--api-key", "--my-apikey", "--passwordX", "--"];
  const separators = [" ", "=", "\n  ", "\t", "==", "= ", "#"];
  const values = ["raw-value", "[已脱敏:密钥]", "--token secret", '"raw value"', "secret --password next"];
  for (const flag of flags) for (const sep of separators) for (const value of values) {
    const text = `${flag}${sep}${value} --unknown --token final`;
    expect(redactFields(text, "[mask]")).toEqual(legacyRedactFields(text, "[mask]"));
    expect(peerPrSecretHit(text, commits)).toBe(legacyPeerPrSecretHit(text, commits));
  }
});
