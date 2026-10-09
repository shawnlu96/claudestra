/** Valid import payloads keep hashing and contract checks in the measured scrub, with fixture construction outside it. */
import type { SharedLedgerImportManifest } from "../src/lib/shared-ledger-contract.ts";
import { sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.ts";

export function scrubPerfPayload(strings: string[]) {
  const manifest: SharedLedgerImportManifest = { projectId: "fixture", sourceInstanceId: "fixture", sourceSeq: 0,
    features: strings.map((description, i) => ({ sourceFeatureId: `f${i}`, title: `Feature ${i}`, description, rev: 1,
      authorityMode: "source", pendingProposal: false, versions: [],
      projection: { mode: "snapshot", previousSourceSeq: 0, sourceSeq: 0, observedAt: 0, tasks: [], events: [] } })) };
  return { mode: "dry-run", batchId: "perf", manifestDigest: sharedLedgerManifestDigest(manifest), manifest };
}
