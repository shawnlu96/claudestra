/** Reproducible optional end-to-end benchmark; the real preview/contract/scrub/size checks run against an isolated ledger. */
import { expect, test } from "bun:test";
import { checkAutoShareCandidates } from "../src/lib/shared-ledger-auto-share-check.ts";
import { STATE_DIR } from "../src/lib/paths.ts";
import { join } from "node:path";
import { previewSharedLedgerExport } from "../src/lib/shared-ledger-export.ts";
import { AUTO_SHARE_MAX_BATCH_BYTES, autoShareRequestBytes } from "../src/lib/shared-ledger-auto-share-batch.ts";
import { autoShareFixture, PROJECT } from "./shared-ledger-auto-share-fixture.test.ts";
import { CENTER, SCRUB } from "./shared-ledger-mirror-fixture.test.ts";

test.skipIf(!process.env.SCRUB_PERF_PROFILE)("N8A7 full auto-share precheck on a 7.6 MB ordinary-text feature", async () => {
  const f = await autoShareFixture(["perf"]);
  try {
    const id = f.features[0]!;
    const text = "The ordinary report contains readable words and useful details. ".repeat(16).slice(0, 1000);
    const insert = f.db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES (?,?,'new_issue','More','owner',1000,?)");
    for (let version = 2; version <= 101; version++) {
      const nodes = Array.from({ length: 71 }, (_, i) => ({ key: `n${i}`, oneLine: text, taskId: null,
        deps: [], fileGlobs: [], estimate: "1h" }));
      insert.run(id, version, JSON.stringify(nodes));
    }
    f.db.prepare("UPDATE features SET currentVersion = 101 WHERE id = ?").run(id);
    const started = performance.now();
    const result = await checkAutoShareCandidates({ db: f.db, dir: STATE_DIR, localProject: PROJECT,
      projectId: CENTER.projectId, sourceInstanceId: CENTER.instanceId, exclude: [], prior: {}, pendingIds: new Set(), now: 1000,
      scrub: async () => SCRUB });
    const ms = +(performance.now() - started).toFixed(2);
    await Bun.write(join(f.dir, "shared-ledger-modes.json"), JSON.stringify({ features: { [id]: { authorityMode: "source", sharedPlanning: true } } }));
    const { payload } = previewSharedLedgerExport(f.db, { localProject: PROJECT, projectId: CENTER.projectId,
      sourceInstanceId: CENTER.instanceId, featureIds: [id], batchId: "auto-precheck", stateDir: f.dir, scrub: SCRUB, summaries: {} });
    const bytes = autoShareRequestBytes(payload);
    console.log(JSON.stringify({ benchmark: "full-auto-share-precheck", bytes, ms, status: result.results[id]?.status,
      reason: result.results[id]?.reason }));
    expect(result.ready).toEqual(bytes > AUTO_SHARE_MAX_BATCH_BYTES ? [] : [id]);
    expect(bytes).toBeGreaterThan(7_000_000);
  } finally { await f.close(); }
}, 60_000);
