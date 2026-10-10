/** Resident scrub-performance suite: verdicts, n-vs-4n cost ratios and old/new equivalence only. Wall-clock caps: scrub-perf-wallclock. */
import { expect, test } from "bun:test";
import { redactForPeer } from "../src/lib/dispatch-redact.ts";
import { peerPrSecretHit, redactPeerPr } from "../src/lib/peer-pr-redact.ts";
import { redactFields } from "../src/lib/redact-fields.ts";
import { commits, identity, JOINED_SHAPES, randomSource, scrub, SCRUB_PERF_CASES, scrubPerfPayload } from "./scrub-perf-fixture.test.ts";
import { legacyRedactForPeer } from "./scrub-perf-legacy-dispatch.test.ts";
import { legacyRedactFields } from "./scrub-perf-legacy-fields.test.ts";
import { legacyPeerPrSecretHit, redactPeerPr as legacyRedactPeerPr } from "./scrub-perf-legacy.test.ts";

for (const c of SCRUB_PERF_CASES) {
  test(`${c.name} keep the verdict`, () => expect(scrub(scrubPerfPayload(c.strings()))).toBe(c.verdict), 60_000);
}

/** Median of three runs; a floor of 1 ms keeps timer noise on a tiny base from inventing a ratio. */
function medianMs(run: () => void): number {
  const samples = [0, 1, 2].map(() => { const started = performance.now(); run(); return performance.now() - started; });
  return Math.max(1, samples.sort((a, b) => a - b)[1]!);
}

test("N8A7B joined tokens: 4× the segment length costs each layer at most 8× the time (linear ≈ 4×, quadratic ≈ 16×)", () => {
  const layers: Record<string, (s: string) => unknown> = { redactForPeer, redactPeerPr: (s) => redactPeerPr(s, identity, commits),
    peerPrSecretHit: (s) => peerPrSecretHit(s, commits) };
  const table: Record<string, number> = {};
  for (const [shape, make] of Object.entries(JOINED_SHAPES)) {
    const small = Array.from({ length: 65 }, () => make(2000)), large = Array.from({ length: 65 }, () => make(8000));
    for (const [layer, fn] of Object.entries(layers)) {
      const ratio = medianMs(() => large.forEach(fn)) / medianMs(() => small.forEach(fn));
      table[`${shape} / ${layer}`] = +ratio.toFixed(2);
    }
  }
  for (const [key, ratio] of Object.entries(table)) expect(ratio, key).toBeLessThanOrEqual(8);
}, 60_000);

test("N8A7 fixed-seed mixed corpus preserves the old first-hit verdict", () => {
  const random = randomSource();
  const corpus = ["", "x".repeat(16000), "X".repeat(16000), "9".repeat(16000), "-".repeat(512),
    "sk-" + "a1".repeat(10), "ghp_" + "A1b2".repeat(6), "s k - a b c d e f g h i j k l m n o p q r",
    "tok_abcdefgh12", "task-scheduler-pass-tick-review-merge", "stock_quantity_lookup", "Bearer abc123def456",
    "-----BEGIN RSA PRIVATE KEY-----", "a".repeat(32), "ab".repeat(20), "cd".repeat(32),
    "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNbVc", '{"password": "hunter2hunter2"}',
    "token: [已脱敏:密钥]", 'token: "[已脱敏:密钥]" + "raw-value"', "token: [已脱敏:密钥]\n  raw-value",
    "__peer_pr_mask_0__ token: [已脱敏:密钥]", "sk-abcdefghijklmnopqrstuvwx".split("").join("​")];
  const alphabets = ["x", "X", "9", "_-", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-", "abcABC09+/=."];
  const wraps = ["", " ", "\n", "\t", ".", "/", "-", "\u0000", "​", "͏", "ㅤ"];
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

test("N8A7B fixed-seed joined-token corpus preserves the old redaction and verdict", () => {
  const random = randomSource();
  // Real hostnames / emails / masked flags embedded at the start, middle and end of joined runs, touching placeholders and odd neighbours.
  const joiners = ["x-", "a.", "-", "--", "_-", "x_", "a.-", "9-", "A.", ".."];
  const inserts = ["nas.local", "box.ts.net", "a-b.c.internal", "home.arpa", "x.lan", "a@b.com", "x.y@mail.example.org", "@b.co", "a@b",
    "--token=[已脱敏:密钥]", "--api-key [已脱敏:密钥]", '--secret "[已脱敏:密钥]"', "--token=raw", "[已脱敏:密钥]", "[已脱敏:个人信息]",
    "token: [已脱敏:密钥]", "_", "..", "@", "#", '"', " ", "\n", "​", "é", "local", "token", ""];
  const edges = ["", " ", "_", ".", "-", "@", "#", "\n", "\t", "​", "ㅤ", "x", "9", '"', "--", "[已脱敏:密钥]"];
  const corpus: string[] = [];
  for (let i = 0; i < 2600; i++) {
    const length = [0, 1, 2, 7, 31, 32, 33, 64, 200, 600][i % 10]!;
    const run = joiners[i % joiners.length]!.repeat(Math.ceil(length / 2)).slice(0, length);
    const insert = inserts[Math.floor(i / 10) % inserts.length]!;
    const at = [0, Math.floor(run.length / 2), run.length][i % 3]!;
    const body = run.slice(0, at) + insert + run.slice(at);
    const value = edges[i % edges.length]! + body + edges[Math.floor(i / 7) % edges.length]!;
    corpus.push(i % 5 === 4 ? `${value} ${random("abcABC09-._@", 1 + (i % 40))}` : value);
  }
  expect(corpus.length).toBeGreaterThanOrEqual(2000);
  for (const value of corpus) {
    expect(redactForPeer(value), value).toEqual(legacyRedactForPeer(value));
    expect(redactPeerPr(value, identity, commits), value).toEqual(legacyRedactPeerPr(value, identity, commits));
    expect(peerPrSecretHit(value, commits), value).toBe(legacyPeerPrSecretHit(value, commits));
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
