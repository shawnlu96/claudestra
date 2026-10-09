/** Optional layer benchmark. On the base checkout set SCRUB_PERF_LEGACY=1 to time the original random rule. */
import { test } from "bun:test";
import { redactForPeer } from "../src/lib/dispatch-redact.ts";
import { peerPrSecretHit, redactPeerPr } from "../src/lib/peer-pr-redact.ts";
import { peerSecretHit } from "../src/lib/peer-secret-gate.ts";
import { redactFields } from "../src/lib/redact-fields.ts";
import { redactSecrets } from "../src/lib/redact-secrets.ts";
import { scrubSharedLedger, SharedLedgerScrubError } from "../src/lib/shared-ledger-scrub.ts";

import { parseSharedLedgerImport } from "../src/lib/shared-ledger-contract-transfer.ts";
import { scrubPerfPayload } from "./scrub-perf-fixture.test.ts";
import { legacyRedactFields } from "./scrub-perf-legacy-fields.test.ts";

const identity = { username: "fixture-user", hostname: "fixture-host" }, commits = new Set<string>();
let seed = 1;
function base64(length: number) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    out += alphabet[(seed >>> 0) % alphabet.length];
  }
  return out;
}
function measure(run: () => unknown) {
  const started = performance.now();
  try { run(); }
  catch (error) { if (!(error instanceof SharedLedgerScrubError)) throw error; }
  return +(performance.now() - started).toFixed(2);
}
function randomRule(text: string): boolean {
  if (process.env.SCRUB_PERF_LEGACY) return /(?=[\w-]*\d)(?=[\w-]*[A-Z])(?=[\w-]*[a-z])[\w-]{32,}/.test(text);
  for (const m of text.matchAll(/[\w-]{32,}/g)) if (/\d/.test(m[0]) && /[A-Z]/.test(m[0]) && /[a-z]/.test(m[0])) return true;
  return false;
}

test.skipIf(!process.env.SCRUB_PERF_PROFILE)("N8A7 per-layer three-length benchmark", () => {
  for (const size of [4000, 8000, 16000]) for (const kind of ["x", "base64", "english"]) {
    const strings = Array.from({ length: 130 }, () => kind === "x" ? "x".repeat(size) : kind === "base64" ? base64(size)
      : "The ordinary report contains readable words and useful details. ".repeat(Math.ceil(size / 63)).slice(0, size));
    const out: Record<string, unknown> = { kind, size, bytes: strings.join("").length };
    const layers = {
      fields: (s: string) => redactFields(s, "\0"), dispatch: redactForPeer,
      pr: (s: string) => redactPeerPr(s, identity, commits), gate: peerSecretHit,
      prGate: (s: string) => peerPrSecretHit(s, commits), secrets: redactSecrets, randomRule,
    };
    for (const [name, fn] of Object.entries(layers)) out[name] = measure(() => strings.forEach(fn));
    const payload = scrubPerfPayload(strings);
    out.scrub = measure(() => scrubSharedLedger(payload, parseSharedLedgerImport, { identity }));
    console.log(JSON.stringify(out));
  }
  for (const size of [500, 1000, 2000]) {
    const text = "-".repeat(size);
    console.log(JSON.stringify({ kind: "dash-flag-rule", size, strings: 130,
      before: measure(() => { for (let i = 0; i < 130; i++) legacyRedactFields(text, "[mask]"); }),
      after: measure(() => { for (let i = 0; i < 130; i++) redactFields(text, "[mask]"); }) }));
  }
}, 180_000);
