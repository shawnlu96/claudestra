/**
 * team-project-N8A r2 P1 (auto-share-stale-controls): the real signed client awaits on its own before the payload POST
 * (commitImport's receipt lookup). A `shared-auto off|observe|exclude` completing in that await must stop the commit.
 * Real SharedLedgerClient (signing, scrub, parsers); only fetch is a contract-valid fake center.
 */
import { afterEach, expect, test } from "bun:test";
import { STATE_DIR } from "../src/lib/paths.js";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { readSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { runSharedLedgerAutoSharePass } from "../src/lib/shared-ledger-auto-share.js";
import type { SharedLedgerImport } from "../src/lib/shared-ledger-contract.js";
import { autoShareFixture, cleanupAutoShareState, PROJECT } from "./shared-ledger-auto-share-fixture.test.js";
import { CENTER, SCRUB } from "./shared-ledger-mirror-fixture.test.js";

afterEach(() => cleanupAutoShareState());
const T0 = Date.UTC(2026, 9, 8, 12, 0), BATCH = `auto-${PROJECT}-202610081200`;
const OPEN = { authorityMode: "source" as const, sharedPlanning: false };
const IMPORTS = `/v1/teams/${CENTER.teamId}/imports`;
type Fixture = Awaited<ReturnType<typeof autoShareFixture>>;

/** Wire-level fake center: answers GET imports/<id> and POST imports exactly as the client's parsers require. */
function fakeFetch(onReceipt: (n: number) => Promise<void> = async () => {}) {
  const wire: string[] = [], receipts = new Map<string, unknown>();
  let serverSeq = 0, receiptCount = 0;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input), method = init?.method ?? "GET";
    if (method === "GET" && url.pathname.startsWith(`${IMPORTS}/`)) {
      const batchId = url.pathname.slice(IMPORTS.length + 1);
      wire.push(`GET receipt ${batchId}`);
      await onReceipt(++receiptCount);
      return json(receipts.get(batchId) ?? { status: "unknown", batchId });
    }
    if (method === "POST" && url.pathname === IMPORTS) {
      const p = (JSON.parse(String(init!.body)) as { payload: SharedLedgerImport }).payload, fs = p.manifest.features, src = p.manifest.sourceInstanceId;
      wire.push(`POST ${p.mode} ${p.batchId} ${fs.map((f) => f.sourceFeatureId).sort().join(",")}`);
      serverSeq++;
      const mappings = fs.flatMap((f) => [{ kind: "feature", sourceInstanceId: src, sourceId: f.sourceFeatureId, id: `center-${f.sourceFeatureId}` },
        ...f.projection.tasks.map((t) => ({ kind: "task", sourceInstanceId: src, sourceId: t.sourceTaskId, id: `center-task-${t.sourceTaskId}` }))]);
      const result = { schemaVersion: 1, mode: p.mode, batchId: p.batchId, manifestDigest: p.manifestDigest, serverSeq, mappings };
      if (p.mode === "commit") receipts.set(p.batchId, { status: "staged", batchId: p.batchId, projectId: p.manifest.projectId, serverSeq, receipt: result,
        verification: { features: fs.length, versions: fs.reduce((n, f) => n + f.versions.length, 0),
          bindings: fs.reduce((n, f) => n + f.versions.reduce((a, v) => a + v.bindings.length, 0), 0),
          tasks: fs.reduce((n, f) => n + f.projection.tasks.length, 0), sourceSeq: p.manifest.sourceSeq, manifestDigest: p.manifestDigest } });
      return json(result);
    }
    wire.push(`${method} ${url.pathname} (unexpected)`);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { wire, fetcher };
}
const realPass = (f: Fixture, fetcher: typeof fetch, now = T0) => runSharedLedgerAutoSharePass({ ledgerPath: f.path, now: () => now,
  fetch: fetcher, key: () => instanceKeySync(STATE_DIR), scrub: async () => SCRUB });

test("N8A-r2 real client baseline: no control change → dry-run, commit, staged, mirror on", async () => {
  const f = await autoShareFixture(["alpha", "beta", "gamma"]);
  try {
    await f.ledger(["shared-auto", "on", PROJECT]);
    const center = fakeFetch(), ids = [...f.features].sort().join(",");
    expect(await realPass(f, center.fetcher)).toEqual({ [PROJECT]: { action: "batch", batchId: BATCH } });
    expect(center.wire).toEqual([`GET receipt ${BATCH}`, `POST dry-run ${BATCH} ${ids}`, `GET receipt ${BATCH}`, `POST commit ${BATCH} ${ids}`,
      `GET receipt ${BATCH}`]);
    for (const id of f.features) expect(readSharedLedgerMode(id)).toEqual({ authorityMode: "source", sharedPlanning: true, mirror: true });
  } finally { await f.close(); }
});

for (const change of ["off", "observe", "exclude"] as const) {
  test(`N8A-r2 ${change} completes during commitImport's own receipt lookup → commit POST never sent, batch aborted`, async () => {
    const f = await autoShareFixture(["alpha", "beta", "gamma"]);
    try {
      await f.ledger(["shared-auto", "on", PROJECT]);
      // Receipt 1: advance's pre-dry-run lookup; receipt 2: the lookup inside the real commitImport, before its POST.
      const center = fakeFetch(async (n) => {
        if (n !== 2) return;
        const args = change === "exclude" ? ["shared-auto", "exclude", PROJECT, f.features[1]!] : ["shared-auto", change, PROJECT];
        expect(await f.ledger(args)).toMatchObject({ ok: true });
      });
      await realPass(f, center.fetcher);
      expect(center.wire.filter((w) => w.startsWith("POST commit"))).toEqual([]);
      expect(center.wire).toEqual([`GET receipt ${BATCH}`, `POST dry-run ${BATCH} ${[...f.features].sort().join(",")}`, `GET receipt ${BATCH}`,
        `GET receipt ${BATCH}`]);
      expect(f.journal(BATCH).phase).toBe("aborted");
      for (const id of f.features) {
        expect(readSharedLedgerMode(id)).toEqual(OPEN);
        expect(f.state().features![id]).toMatchObject({ status: "deferred", reason: "自动共享开关已改，本批未上传" });
      }
      if (change === "exclude") expect(f.state()).toMatchObject({ mode: "on", exclude: [f.features[1]] });
      else expect(f.state().mode).toBe(change);
      expect(f.state()).toMatchObject({ pending: null, batches: [{ batchId: BATCH, outcome: "fenced" }] });
      expect(f.state().halted ?? null).toBeNull();
    } finally { await f.close(); }
  });
}
