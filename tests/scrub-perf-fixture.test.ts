/** Valid import payloads keep hashing and contract checks in the measured scrub, with fixture construction outside it. */
import type { SharedLedgerImportManifest } from "../src/lib/shared-ledger-contract.ts";
import { parseSharedLedgerImport, sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.ts";
import { scrubSharedLedger, SharedLedgerScrubError } from "../src/lib/shared-ledger-scrub.ts";

export const identity = { username: "fixture-user", hostname: "fixture-host" };
export const commits = new Set(["ab".repeat(20), "cd".repeat(32)]);

export function scrubPerfPayload(strings: string[]) {
  const manifest: SharedLedgerImportManifest = { projectId: "fixture", sourceInstanceId: "fixture", sourceSeq: 0,
    features: strings.map((description, i) => ({ sourceFeatureId: `f${i}`, title: `Feature ${i}`, description, rev: 1,
      authorityMode: "source", pendingProposal: false, versions: [],
      projection: { mode: "snapshot", previousSourceSeq: 0, sourceSeq: 0, observedAt: 0, tasks: [], events: [] } })) };
  return { mode: "dry-run", batchId: "perf", manifestDigest: sharedLedgerManifestDigest(manifest), manifest };
}

export function scrub(payload: ReturnType<typeof scrubPerfPayload>): "allowed" | "refused" {
  try { scrubSharedLedger(payload, parseSharedLedgerImport, { identity, commits }); return "allowed"; }
  catch (error) {
    if (!(error instanceof SharedLedgerScrubError)) throw error;
    return "refused";
  }
}

/** xorshift32 with a fixed seed: the same sample list on every run. */
export function randomSource() {
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

/** The joined-token shapes the N8A7B review found quadratic; `n` is the segment length. */
export const JOINED_SHAPES: Record<string, (n: number) => string> = {
  "hyphen-joined x-x-x": (n) => "x-".repeat(n / 2),
  "dot-joined a.a.a": (n) => "a.".repeat(n / 2),
  "dash run + placeholder on one line": (n) => `${"-".repeat(n - 20)} [已脱敏:密钥]`,
};

const english = (size: number) => "The ordinary report contains readable words and useful details. ".repeat(Math.ceil(size / 63)).slice(0, size);
const base64 = (size: number) => randomSource()("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", size);
const fill = (make: (n: number) => string) => () => Array.from({ length: 130 }, () => make(16000));

/** 130 fields × 16000 characters each; `capMs` is the wall-clock cap checked only under SCRUB_PERF_PROFILE. */
export const SCRUB_PERF_CASES: { name: string; strings: () => string[]; verdict: "allowed" | "refused"; capMs: number }[] = [
  { name: "N8A7 130 long uninterrupted x fields", strings: fill((n) => "x".repeat(n)), verdict: "allowed", capMs: 2000 },
  { name: "N8A7 130 equal-sized base64 fields", strings: fill(base64), verdict: "refused", capMs: 2000 },
  { name: "N8A7 130 ordinary English fields", strings: fill(english), verdict: "allowed", capMs: 2000 },
  { name: "N8A7 130 uninterrupted dash runs", strings: fill((n) => "-".repeat(n)), verdict: "allowed", capMs: 2000 },
  ...Object.entries(JOINED_SHAPES).map(([shape, make]) => ({ name: `N8A7B 130 ${shape} fields`, strings: fill(make), verdict: "allowed" as const, capMs: 3000 })),
];
