/** team-project-N8A: active features of a bound project are shared to the center read-only without manual import steps. */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { readSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { readSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { rewriteDag } from "../src/lib/ledger-dag-write.js";
import { runSharedLedgerMirrorPass } from "../src/lib/shared-ledger-mirror-loop.js";
import { SOURCE_DAG_UPLOAD_PATH } from "../src/lib/shared-ledger-contract-source-dag.js";
import { CENTER } from "./shared-ledger-mirror-fixture.test.js";
import { autoShareFixture, cleanupAutoShareState, mixedFixture, PROJECT, SECRET } from "./shared-ledger-auto-share-fixture.test.js";

afterEach(() => cleanupAutoShareState());
const T0 = Date.UTC(2026, 9, 8, 12, 0), MIRRORED = { authorityMode: "source" as const, sharedPlanning: true, mirror: true as const };

test("N8A-1 补共享: mode=on, one pass → exactly one batch with the 3 unshared active features, staged, all mirrored", async () => {
  const f = await mixedFixture();
  try {
    expect(await f.ledger(["shared-auto", "exclude", PROJECT, f.excluded])).toMatchObject({ ok: true, exclude: [f.excluded] });
    expect(await f.ledger(["shared-auto", "on", PROJECT])).toMatchObject({ ok: true, mode: "on" });
    expect(await f.pass(T0)).toEqual({ [PROJECT]: { action: "batch", batchId: `auto-${PROJECT}-202610081200` } });
    expect(f.center.batches).toHaveLength(1);
    const batch = f.center.batches[0]!;
    expect(batch.manifest.features.map((x) => x.sourceFeatureId)).toEqual([...f.features].sort());
    expect(f.journal(batch.batchId)).toMatchObject({ phase: "verified", receipt: { status: "staged" } });
    for (const id of f.features) expect(readSharedLedgerMode(id)).toEqual(MIRRORED);
    for (const id of [f.done, f.excluded]) expect(readSharedLedgerMode(id)).toEqual({ authorityMode: "source", sharedPlanning: false });
    expect(readSharedLedgerMode(f.replica).centerPlanned).toBeDefined();
    // Audit: the batch was committed under its own digest (owner 10-08), recorded with the time.
    expect(f.state().halted ?? null).toBeNull();
    expect(f.state()).toMatchObject({ pending: null, lastError: null,
      batches: [{ batchId: batch.batchId, digest: batch.manifestDigest, featureIds: [...f.features].sort(), at: T0, outcome: "staged" }] });
    const status = await f.ledger(["shared-auto", "status", PROJECT]) as { lists: Record<string, { featureId: string }[]> };
    expect(status.lists["已共享"]!.map((x) => x.featureId)).toEqual([...f.features, f.mirrored].sort());
    expect(status.lists["排除"]!.map((x) => x.featureId)).toEqual([f.excluded]);
    // Nothing left: the next pass opens no batch.
    expect(await f.pass(T0 + 300_000)).toEqual({ [PROJECT]: { action: "idle" } });
    expect(f.center.batches).toHaveLength(1);
  } finally { await f.close(); }
});

test("N8A-2 本机照常规划: after auto-share a dag rewrite succeeds and the mirror loop pushes projection + source-dags", async () => {
  const f = await autoShareFixture(["alpha", "beta", "gamma"]);
  try {
    await f.ledger(["shared-auto", "on", PROJECT]);
    await f.pass(T0);
    const id = f.features[0]!, feature = f.db.prepare("SELECT rev FROM features WHERE id = ?").get(id) as { rev: number };
    const r = rewriteDag(f.db, { actor: f.actor }, { id, rev: feature.rev, nodes: [{ key: "work", oneLine: "Rewritten locally", fileGlobs: ["src/alpha.ts"] }],
      reasonKind: "new_issue", reasonText: "Local replanning", cancel: new Map(), scopeChange: false, askFrom: { agent: f.actor, channelId: null } });
    expect(r.row.version?.version).toBe(2);
    const sent: { path: string; payload: Record<string, unknown> }[] = [];
    const fetcher = (async (url: URL, init?: RequestInit) => {
      const { payload } = JSON.parse(String(init?.body)) as { payload: Record<string, unknown> };
      sent.push({ path: url.pathname, payload });
      if (url.pathname === SOURCE_DAG_UPLOAD_PATH.replace("{teamId}", CENTER.teamId)) {
        return Response.json({ schemaVersion: 1, featureId: payload.featureId, version: (payload.dag as { version: number }).version, digest: "c".repeat(64), droppedBindings: 0 });
      }
      return Response.json({ schemaVersion: 1, serverSeq: sent.length, sourceInstanceId: payload.sourceInstanceId, sourceSeq: payload.sourceSeq, digest: "b".repeat(64) });
    }) as unknown as typeof fetch;
    await runSharedLedgerMirrorPass({ ledgerPath: f.path, now: () => T0 + 1000, fetch: fetcher });
    const mine = sent.filter((s) => s.payload.featureId === `center-${id}`);
    expect(mine.some((s) => s.path.endsWith("/projections") || s.path.includes("projection"))).toBe(true);
    expect(mine.filter((s) => s.path.includes("source-dags")).map((s) => (s.payload.dag as { version: number }).version)).toEqual([2]);
    expect(readSharedLedgerMirrors()[id]).toMatchObject({ enabled: true, dagVersion: 2, lastError: null });
  } finally { await f.close(); }
});

test("N8A-3 拒收不连坐: a secret-shaped node text is refused without a gate; the rest import; unchanged rev / version is not retried", async () => {
  const f = await autoShareFixture(["alpha", "beta", "leaky"], (slug) => slug === "leaky" ? `rotate ${SECRET}` : `Plan ${slug}`);
  try {
    const leaky = f.features[2]!;
    let probes = 0;
    f.setScrub(async (_db, plan) => { if (plan.featureIds.includes(leaky)) probes++; return { identity: { username: "n8a-user", hostname: "n8a-host" } }; });
    await f.ledger(["shared-auto", "on", PROJECT]);
    await f.pass(T0);
    expect(f.center.batches[0]!.manifest.features.map((x) => x.sourceFeatureId)).toEqual(f.features.slice(0, 2).sort());
    expect(readSharedLedgerMode(leaky)).toEqual({ authorityMode: "source", sharedPlanning: false });
    const refused = f.state().features![leaky]!;
    const rev = (f.db.prepare("SELECT rev FROM features WHERE id = ?").get(leaky) as { rev: number }).rev;
    expect(refused).toEqual({ status: "refused", reason: "当前内容含不能外发的文字", rev, version: 1, at: T0, rules: 4 });
    expect(JSON.stringify(f.state())).not.toContain(SECRET);
    expect(probes).toBe(1);
    await f.pass(T0 + 300_000);
    expect(probes).toBe(1);
    expect(f.state().features![leaky]!.at).toBe(T0);
    expect(f.center.batches).toHaveLength(1);
    // A new DAG version is a new chance (it is not rewritten for the gate by auto-share itself).
    rewriteDag(f.db, { actor: f.actor }, { id: leaky, rev, nodes: [{ key: "work", oneLine: "Rotate the token", fileGlobs: ["src/leaky.ts"] }],
      reasonKind: "new_issue", reasonText: "Clean wording", cancel: new Map(), scopeChange: false, askFrom: { agent: f.actor, channelId: null } });
    await f.pass(T0 + 600_000);
    expect(f.center.batches.map((b) => b.manifest.features.map((x) => x.sourceFeatureId))).toEqual([f.features.slice(0, 2).sort(), [leaky]]);
  } finally { await f.close(); }
});

test("N8A-4 暂缓: a pending revision proposal skips the feature with its mode untouched; once decided it imports next pass", async () => {
  const f = await autoShareFixture(["alpha", "beta"]);
  try {
    const [held, other] = f.features as [string, string];
    f.db.prepare("INSERT INTO dag_proposals(featureId,version,baseVersion,reasonKind,reasonText,proposedBy,nodes,cancels,scopeChange,sha,askId,createdAt,state) "
      + "VALUES (?,2,1,'new_issue','Review','owner','[]','[]',1,'digest','ask',1,'pending')").run(held);
    await f.ledger(["shared-auto", "on", PROJECT]);
    await f.pass(T0);
    expect(f.center.batches.map((b) => b.manifest.features.map((x) => x.sourceFeatureId))).toEqual([[other]]);
    expect(f.state().features![held]).toMatchObject({ status: "deferred", reason: "有未批修订提案" });
    expect(readSharedLedgerMode(held)).toEqual({ authorityMode: "source", sharedPlanning: false });
    f.db.prepare("UPDATE dag_proposals SET state = 'rejected' WHERE featureId = ?").run(held);
    await f.pass(T0 + 300_000);
    expect(f.center.batches.map((b) => b.manifest.features.map((x) => x.sourceFeatureId))).toEqual([[other], [held]]);
    expect(readSharedLedgerMode(held)).toEqual(MIRRORED);
  } finally { await f.close(); }
});

test("N8A-6 observe / off: observe lists 会共享 with 0 center requests, 0 journals, modes unchanged; off and a missing file do nothing", async () => {
  const f = await mixedFixture();
  try {
    expect(await f.pass(T0)).toEqual({});
    expect(existsSync(join(STATE_DIR, "shared-ledger-auto-share.json"))).toBe(false);
    await f.ledger(["shared-auto", "exclude", PROJECT, f.excluded]);
    expect(await f.pass(T0)).toEqual({});
    const modes = f.modesRaw();
    expect(await f.ledger(["shared-auto", "observe", PROJECT])).toMatchObject({ ok: true, mode: "observe" });
    expect(await f.pass(T0)).toEqual({ [PROJECT]: { action: "observe" } });
    expect(f.center.calls).toEqual([]);
    expect(existsSync(join(STATE_DIR, "shared-ledger-migrations"))).toBe(false);
    expect(f.modesRaw()).toBe(modes);
    const status = await f.ledger(["shared-auto", "status", PROJECT]) as { lists: Record<string, { featureId: string }[]> };
    expect(status.lists["会共享"]!.map((x) => x.featureId)).toEqual([...f.features].sort());
    expect(status.lists["排除"]!.map((x) => x.featureId)).toEqual([f.excluded]);
    expect(status.lists["已共享"]!.map((x) => x.featureId)).toEqual([f.mirrored]);
    expect(JSON.stringify(status)).not.toContain(f.done);
    expect(JSON.stringify(status)).not.toContain(f.replica);
    await f.ledger(["shared-auto", "off", PROJECT]);
    expect(await f.pass(T0 + 300_000)).toEqual({});
    expect(f.center.calls).toEqual([]);
  } finally { await f.close(); }
});

test("N8A-7 上限: 8 candidates → 5 in the first pass, 3 in the second", async () => {
  const f = await autoShareFixture(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);
  try {
    await f.ledger(["shared-auto", "on", PROJECT]);
    await f.pass(T0);
    await f.pass(T0);
    expect(f.center.batches.map((b) => b.manifest.features.length)).toEqual([5, 3]);
    expect(f.center.batches.map((b) => b.batchId)).toEqual([`auto-${PROJECT}-202610081200`, `auto-${PROJECT}-202610081200-2`]);
    for (const id of f.features) expect(readSharedLedgerMode(id)).toEqual(MIRRORED);
  } finally { await f.close(); }
});
