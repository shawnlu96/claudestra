/** team-project-N8M: a source mirror uploads its newer local DAG version to `source-dags` (contract N8MK) after each pass. */
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/lib/canonical-json.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { moveStage } from "../src/lib/ledger-write.js";
import { effectiveNodes, getDagVersion } from "../src/lib/ledger-feature.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { readSharedLedgerMirrors, updateSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { runSharedLedgerMirrorPass } from "../src/lib/shared-ledger-mirror-loop.js";
import { parseSourceDagUpload, SOURCE_DAG_UPLOAD_PATH, type SourceDagUpload } from "../src/lib/shared-ledger-contract-source-dag.js";
import { pushSourceDagMirror, SOURCE_DAG_DROPPED_RETRY_MS, SOURCE_DAG_REASONS, SOURCE_DAG_UNSUPPORTED_RETRY_MS, sourceDagStatus } from "../src/lib/shared-ledger-source-dag-push.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { CENTER, cleanupMirrorState, commitJournal, SCRUB, serviceCredential } from "./shared-ledger-mirror-fixture.test.js";

afterEach(() => cleanupMirrorState());
const HOUR = 60 * 60_000, T0 = 1_000_000;

async function mirrored() {
  const f = integrationFixture();
  await commitJournal(f, "batch-n8m");
  await serviceCredential();
  expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: true });
  return f;
}
/** Local versions 2..to, as rewrite_dag leaves them (the bound node keeps its card). */
function bumpTo(f: Awaited<ReturnType<typeof mirrored>>, to: number, oneLine = (v: number) => `Work for v${v}`) {
  for (let v = f.feature().currentVersion + 1; v <= to; v++) {
    f.db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES (?,?,'new_issue',?,'owner',1001,?)")
      .run(f.id, v, `Rewrite ${v}`, JSON.stringify([{ key: "existing", taskId: "c5-existing", oneLine: "Existing", deps: [], status: "spec", estimate: "", inheritedFrom: null },
        { key: "next", taskId: null, oneLine: oneLine(v), deps: ["existing"], status: "planned", estimate: "S", inheritedFrom: null, fileGlobs: ["src/lib/c5.ts"] }]));
  }
  f.db.prepare("UPDATE features SET currentVersion = ? WHERE id = ?").run(to, f.id);
}

/** merge: an N8B3C center — the same version with the same nodes and a superset of its bindings merges; bindings to
 * the listed (not yet mirrored) task ids are dropped and counted. */
type Mode = "contract" | "old" | { conflict: number } | { status: 400 | 403 } | { merge: Set<string> };
/** Fake center behind the real SharedLedgerClient: projections always confirm; source-dags follows the N8MK status table. */
function fakeCenter(version: number, modeOf: Mode | (() => Mode) = "contract") {
  const dags: SourceDagUpload[] = [], projections: unknown[] = [];
  let current = version, digest = "", stored: SourceDagUpload["dag"] | null = null;
  const fetcher = (async (url: URL, init?: RequestInit) => {
    const { payload } = JSON.parse(String(init?.body)) as { payload: Record<string, unknown> };
    if (url.pathname === SOURCE_DAG_UPLOAD_PATH.replace("{teamId}", CENTER.teamId)) {
      const mode = typeof modeOf === "function" ? modeOf() : modeOf;
      const upload = parseSourceDagUpload(payload);
      dags.push(upload);
      if (mode === "old") return new Response("<html>not found</html>", { status: 404 });
      if (typeof mode === "object" && "status" in mode) {
        return Response.json({ schemaVersion: 1, code: mode.status === 403 ? "forbidden" : "invalid", status: mode.status, message: "secret-center-text" }, { status: mode.status });
      }
      const at = createHash("sha256").update(canonicalJson(upload.dag)).digest("hex");
      if (typeof mode === "object" && "merge" in mode && stored && upload.dag.version === current
        && canonicalJson(upload.dag.nodes) === canonicalJson(stored.nodes)
        && stored.bindings.every((b) => upload.dag.bindings.some((n) => n.nodeKey === b.nodeKey && n.taskId === b.taskId))) {
        stored = upload.dag; digest = at;
        const droppedBindings = upload.dag.bindings.filter((b) => mode.merge.has(b.taskId)).length;
        return Response.json({ schemaVersion: 1, featureId: upload.featureId, version: current, digest: at, droppedBindings });
      }
      const conflict = typeof mode === "object" && "conflict" in mode ? mode.conflict : null;
      if (conflict !== null || upload.dag.version < current || (upload.dag.version === current && at !== digest)) {
        return Response.json({ schemaVersion: 1, code: "conflict", status: 409, message: "secret-center-text", currentVersion: conflict ?? current }, { status: 409 });
      }
      current = upload.dag.version; digest = at; stored = upload.dag;
      const droppedBindings = typeof mode === "object" && "merge" in mode ? upload.dag.bindings.filter((b) => mode.merge.has(b.taskId)).length : 0;
      return Response.json({ schemaVersion: 1, featureId: upload.featureId, version: current, digest: at, droppedBindings });
    }
    projections.push(payload);
    return Response.json({ schemaVersion: 1, serverSeq: projections.length, sourceInstanceId: payload.sourceInstanceId, sourceSeq: payload.sourceSeq, digest: "b".repeat(64) });
  }) as unknown as typeof fetch;
  return { dags, projections, fetcher, current: () => current };
}
const pass = (f: Awaited<ReturnType<typeof mirrored>>, center: ReturnType<typeof fakeCenter>, at: number) =>
  runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, now: () => at, fetch: center.fetcher });
const entryOf = (f: Awaited<ReturnType<typeof mirrored>>) => readSharedLedgerMirrors()[f.id]!;
/** dag-bind on the current version: a binding row, no new version. */
const bind = (f: Awaited<ReturnType<typeof mirrored>>, nodeKey: string, taskId: string) =>
  f.db.prepare("INSERT INTO dag_bindings (featureId, version, nodeKey, taskId, boundBy, boundAt) VALUES (?, ?, ?, ?, 'owner', 1002)")
    .run(f.id, f.feature().currentVersion, nodeKey, taskId);
const touch = (f: Awaited<ReturnType<typeof mirrored>>, from: "spec" | "restate" = "spec", to: "spec" | "restate" = "restate") =>
  moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from, to });

test("N8M-1 补版本: center at v16, local v17 → one source-dags POST of v17 with local nodes and sourceTaskId bindings", async () => {
  const f = await mirrored();
  try {
    bumpTo(f, 17);
    const center = fakeCenter(16);
    await updateSharedLedgerMirrors(STATE_DIR, (all) => { all[f.id] = { ...all[f.id]!, dagVersion: 16 }; });
    touch(f);
    expect((await pass(f, center, T0))[f.id]).toMatchObject({ kind: "pushed" });
    expect(center.dags).toHaveLength(1);
    const sent = center.dags[0]!, local = getDagVersion(f.db, f.id, 17)!;
    expect(sent).toMatchObject({ projectId: CENTER.projectId, featureId: "center-feature-1", sourceInstanceId: CENTER.instanceId });
    expect(sent.dag.version).toBe(17);
    expect(sent.dag.reason).toBe("Rewrite 17");
    expect(sent.dag.nodes).toEqual(effectiveNodes(f.db, local).map((n) => ({ key: n.key, deps: n.deps, fileGlobs: n.fileGlobs ?? [], estimate: n.estimate, oneLine: n.oneLine })));
    expect(sent.dag.bindings).toEqual([{ nodeKey: "existing", taskId: "c5-existing" }]);
    expect(entryOf(f)).toMatchObject({ dagVersion: 17, dagError: null, failures: 0 });
    expect(center.current()).toBe(17);
    expect(sourceDagStatus(f.id)).toMatchObject({ dagVersion: 17, dagUnsupportedUntil: null, dagError: null });
    expect(await f.ledger(["shared-mirror", "status", f.id])).toMatchObject({ ok: true, dagVersion: 17, dagError: null });
  } finally { await f.close(); }
});

test("N8M-1b an old entry without dagVersion (= 0) uploads the current version once, even on an idle projection pass", async () => {
  const f = await mirrored();
  try {
    const center = fakeCenter(0);
    expect(entryOf(f).dagVersion).toBeUndefined();
    expect((await pass(f, center, T0))[f.id]).toMatchObject({ kind: "idle" });
    expect(center.dags.map((d) => d.dag.version)).toEqual([1]);
    expect(entryOf(f).dagVersion).toBe(1);
  } finally { await f.close(); }
});

test("N8M-2 不重复: a second pass with the local version unchanged uploads nothing", async () => {
  const f = await mirrored();
  try {
    bumpTo(f, 3);
    const center = fakeCenter(2);
    await pass(f, center, T0);
    expect(center.dags).toHaveLength(1);
    touch(f);
    expect((await pass(f, center, T0 + 1000))[f.id]).toMatchObject({ kind: "pushed" });
    await pass(f, center, T0 + 2000);
    expect(center.dags).toHaveLength(1);
    // A later local version goes up again, skipping straight to the newest.
    bumpTo(f, 5);
    await pass(f, center, T0 + 3000);
    expect(center.dags.map((d) => d.dag.version)).toEqual([3, 5]);
  } finally { await f.close(); }
});

test("N8M-3 旧中心: 404 sets dagUnsupportedUntil without failures or backoff; projection still pushes; retried after 6 hours", async () => {
  const f = await mirrored();
  try {
    bumpTo(f, 2);
    const center = fakeCenter(1, "old");
    touch(f);
    expect((await pass(f, center, T0))[f.id]).toMatchObject({ kind: "pushed" });
    expect(center.dags).toHaveLength(1);
    expect(center.projections).toHaveLength(1);
    let e = entryOf(f);
    expect(e).toMatchObject({ dagUnsupportedUntil: T0 + SOURCE_DAG_UNSUPPORTED_RETRY_MS, failures: 0, nextAttemptAt: 0, lastError: null });
    expect(e.dagError ?? null).toBeNull();
    expect(e.dagVersion ?? 0).toBe(0);
    touch(f, "restate", "spec");
    expect((await pass(f, center, T0 + HOUR))[f.id]).toMatchObject({ kind: "pushed" });
    await pass(f, center, T0 + 6 * HOUR - 1);
    expect(center.dags).toHaveLength(1);
    expect(center.projections).toHaveLength(2);
    await pass(f, center, T0 + 6 * HOUR);
    expect(center.dags).toHaveLength(2);
    e = entryOf(f);
    expect(e).toMatchObject({ dagUnsupportedUntil: T0 + 12 * HOUR, failures: 0 });
  } finally { await f.close(); }
});

test("N8M-4a 409 with currentVersion ≥ local: the version is confirmed, its bindings are not; one same-version retry, then backoff", async () => {
  const f = await mirrored();
  try {
    bumpTo(f, 17);
    const center = fakeCenter(17, { conflict: 17 });
    await pass(f, center, T0);
    expect(center.dags).toHaveLength(1);
    expect(entryOf(f)).toMatchObject({ dagVersion: 17, dagError: null, failures: 0 });
    expect(entryOf(f).dagBindings).toBeUndefined();
    // The center may hold an earlier upload of v17 without these bindings, so the same version goes up once more.
    touch(f);
    expect((await pass(f, center, T0 + 1000))[f.id]).toMatchObject({ kind: "pushed" });
    expect(center.dags.map((d) => d.dag.version)).toEqual([17, 17]);
    expect(entryOf(f)).toMatchObject({ dagVersion: 17, failures: 0, lastError: null,
      dagError: { reason: SOURCE_DAG_REASONS.merge, at: T0 + 1000, failures: 1, nextAttemptAt: T0 + 11_000 } });
    await pass(f, center, T0 + 5000);
    expect(center.dags).toHaveLength(2);
  } finally { await f.close(); }
});

test("N8M-4b 409 with currentVersion < local: fixed dagError and backoff; the projection is unaffected", async () => {
  const f = await mirrored();
  try {
    bumpTo(f, 17);
    const center = fakeCenter(16, { conflict: 16 });
    touch(f);
    expect((await pass(f, center, T0))[f.id]).toMatchObject({ kind: "pushed" });
    const e = entryOf(f);
    expect(e.dagError).toEqual({ reason: SOURCE_DAG_REASONS.behind, at: T0, failures: 1, nextAttemptAt: T0 + 10_000 });
    expect(e).toMatchObject({ failures: 0, nextAttemptAt: 0, lastError: null, lastPushSeq: e.watermark });
    expect(JSON.stringify(e)).not.toContain("secret-center-text");
    // Inside the DAG backoff the projection keeps pushing and no upload is attempted.
    touch(f, "restate", "spec");
    expect((await pass(f, center, T0 + 5000))[f.id]).toMatchObject({ kind: "pushed" });
    expect(center.dags).toHaveLength(1);
    expect(center.projections).toHaveLength(2);
    await pass(f, center, T0 + 10_000);
    expect(center.dags).toHaveLength(2);
    expect(entryOf(f).dagError).toMatchObject({ failures: 2, nextAttemptAt: T0 + 30_000 });
  } finally { await f.close(); }
});

test("N8M-4c 403 / 400 record a fixed reason (no center text) and back off", async () => {
  for (const status of [403, 400] as const) {
    const f = await mirrored();
    try {
      bumpTo(f, 2);
      const center = fakeCenter(1, { status });
      await pass(f, center, T0);
      expect(center.dags).toHaveLength(1);
      expect(entryOf(f).dagError).toMatchObject({ reason: SOURCE_DAG_REASONS.rejected(status), failures: 1 });
      expect(entryOf(f).dagVersion ?? 0).toBe(0);
    } finally { await f.close(); cleanupMirrorState(); }
  }
});

test("N8M-5 脱敏: a node text with a secret shape is never sent; dagError carries the fixed reason", async () => {
  const f = await mirrored();
  try {
    const secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    bumpTo(f, 2, () => `rotate ${secret}`);
    const center = fakeCenter(1);
    touch(f);
    expect((await pass(f, center, T0))[f.id]).toMatchObject({ kind: "pushed" });
    expect(center.dags).toHaveLength(0);
    const e = entryOf(f);
    expect(e.dagError).toMatchObject({ reason: SOURCE_DAG_REASONS.blocked, failures: 1 });
    expect(e).toMatchObject({ failures: 0, lastError: null });
    expect(JSON.stringify(e)).not.toContain(secret);
    expect(JSON.stringify(center.projections)).not.toContain(secret);
  } finally { await f.close(); }
});

test("N8M-6 只管来源: planning replicas and features without an enabled mirror never upload", async () => {
  const f = await mirrored();
  try {
    bumpTo(f, 2);
    let calls = 0;
    const client = { async sourceDag() { calls++; return { kind: "unsupported" as const }; } };
    const entry = entryOf(f);
    // N7X planning replica mode: not a source mirror, nothing is attempted.
    await writeSharedLedgerMode(f.id, { authorityMode: "planning", sharedPlanning: true,
      centerPlanned: { centerId: CENTER.centerId, teamId: CENTER.teamId, projectId: CENTER.projectId, centerFeatureId: "center-feature-1" } }, STATE_DIR, f.db.filename);
    expect(await pushSourceDagMirror(f.db, f.id, entry, { client, scrub: SCRUB, now: T0 })).toBe(entry);
    expect(calls).toBe(0);
    await writeSharedLedgerMode(f.id, { authorityMode: "source", sharedPlanning: true, mirror: true }, STATE_DIR, f.db.filename);
    // Mirror switched off: the pass skips the feature entirely.
    expect(await f.ledger(["shared-mirror", "off", f.id])).toMatchObject({ ok: true });
    const center = fakeCenter(1);
    touch(f);
    expect(await pass(f, center, T0)).toEqual({});
    expect(center.dags).toHaveLength(0);
    // A client without sourceDag (older fakes) is a no-op too.
    expect(await pushSourceDagMirror(f.db, f.id, entry, { client: {}, scrub: SCRUB, now: T0 })).toBe(entry);
  } finally { await f.close(); }
});

test("N8M-6b an unreachable center is recorded on dagError only; the pass never throws", async () => {
  const f = await mirrored();
  try {
    bumpTo(f, 2);
    const base = fakeCenter(1);
    const fetcher = (async (url: URL, init?: RequestInit) => url.pathname.endsWith("/source-dags")
      ? (() => { throw new Error("socket closed bearer-for-tests-only"); })() : base.fetcher(url, init)) as unknown as typeof fetch;
    touch(f);
    expect((await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, now: () => T0, fetch: fetcher }))[f.id]).toMatchObject({ kind: "pushed" });
    expect(entryOf(f)).toMatchObject({ failures: 0, lastError: null, dagError: { reason: SOURCE_DAG_REASONS.unavailable, failures: 1 } });
  } finally { await f.close(); }
});

test("N8B3-1 同版本新增绑卡: the confirmed version goes up again with the new binding; 200 updates the digest; then quiet", async () => {
  const f = await mirrored();
  try {
    bumpTo(f, 3);
    const center = fakeCenter(2, { merge: new Set() });
    await pass(f, center, T0);
    expect(center.dags.map((d) => d.dag.bindings.length)).toEqual([1]);
    const before = entryOf(f).dagBindings;
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    bind(f, "next", "c5-next");
    touch(f);
    expect((await pass(f, center, T0 + 1000))[f.id]).toMatchObject({ kind: "pushed" });
    expect(center.dags.map((d) => d.dag.version)).toEqual([3, 3]);
    expect(center.dags[1]!.dag.bindings).toEqual([{ nodeKey: "existing", taskId: "c5-existing" }, { nodeKey: "next", taskId: "c5-next" }]);
    expect(entryOf(f)).toMatchObject({ dagVersion: 3, dagError: null, dagDroppedBindings: 0, dagUploadedAt: T0 + 1000 });
    expect(entryOf(f).dagBindings).not.toBe(before);
    await pass(f, center, T0 + 2000);
    await pass(f, center, T0 + 7 * HOUR);
    expect(center.dags).toHaveLength(2);
  } finally { await f.close(); }
});

test("N8B3-1b an entry confirmed before N8B3 (no bindings digest) sends its version once, then stays quiet", async () => {
  const f = await mirrored();
  try {
    bumpTo(f, 3);
    const center = fakeCenter(2, { merge: new Set() });
    await pass(f, center, T0);
    // As main left it: v3 confirmed, no N8B3 fields; the binding came later.
    await updateSharedLedgerMirrors(STATE_DIR, (all) => {
      const { dagBindings: _b, dagDroppedBindings: _d, dagUploadedAt: _u, ...old } = all[f.id]!;
      all[f.id] = old;
    });
    bind(f, "next", "c5-next");
    await pass(f, center, T0 + 1000);
    await pass(f, center, T0 + 2000);
    expect(center.dags.map((d) => [d.dag.version, d.dag.bindings.length])).toEqual([[3, 1], [3, 2]]);
    expect(entryOf(f)).toMatchObject({ dagVersion: 3, dagError: null });
  } finally { await f.close(); }
});

test("N8B3-2 droppedBindings: retried once a retry interval has passed, and no more once the center keeps every binding", async () => {
  const f = await mirrored();
  try {
    bumpTo(f, 3);
    const unmirrored = new Set(["c5-next"]);
    const center = fakeCenter(2, { merge: unmirrored });
    await pass(f, center, T0);
    bind(f, "next", "c5-next");
    await pass(f, center, T0 + 1000);
    expect(center.dags).toHaveLength(2);
    expect(entryOf(f)).toMatchObject({ dagDroppedBindings: 1, dagUploadedAt: T0 + 1000, dagError: null });
    await pass(f, center, T0 + 2000);
    await pass(f, center, T0 + 1000 + SOURCE_DAG_UNSUPPORTED_RETRY_MS - 1);
    expect(center.dags).toHaveLength(2);
    unmirrored.delete("c5-next");
    await pass(f, center, T0 + 1000 + SOURCE_DAG_UNSUPPORTED_RETRY_MS);
    expect(center.dags.map((d) => d.dag.version)).toEqual([3, 3, 3]);
    expect(entryOf(f)).toMatchObject({ dagDroppedBindings: 0, dagError: null });
    await pass(f, center, T0 + 1000 + 3 * SOURCE_DAG_UNSUPPORTED_RETRY_MS);
    expect(center.dags).toHaveLength(3);
  } finally { await f.close(); }
});

test("N8B3-3 bindings unchanged: no upload request at all", async () => {
  const f = await mirrored();
  try {
    bumpTo(f, 3);
    const center = fakeCenter(2, { merge: new Set() });
    await pass(f, center, T0);
    for (const at of [T0 + 1000, T0 + HOUR, T0 + 7 * HOUR]) { touch(f, ...(at === T0 + HOUR ? ["restate", "spec"] as const : ["spec", "restate"] as const)); await pass(f, center, at); }
    expect(center.dags).toHaveLength(1);
    expect(center.projections.length).toBeGreaterThan(1);
  } finally { await f.close(); }
});

test("N8B3-4 a center that will not merge (409, e.g. before N8B3C): fixed dagError and backoff; the same pass still pushes the projection", async () => {
  const f = await mirrored();
  try {
    bumpTo(f, 3);
    const center = fakeCenter(2);
    await pass(f, center, T0);
    const digest = entryOf(f).dagBindings;
    bind(f, "next", "c5-next");
    touch(f);
    expect((await pass(f, center, T0 + 1000))[f.id]).toMatchObject({ kind: "pushed" });
    expect(center.dags.map((d) => d.dag.version)).toEqual([3, 3]);
    const e = entryOf(f);
    expect(e.dagError).toEqual({ reason: SOURCE_DAG_REASONS.merge, at: T0 + 1000, failures: 1, nextAttemptAt: T0 + 11_000 });
    expect(e).toMatchObject({ dagVersion: 3, dagBindings: digest, failures: 0, lastError: null, lastPushSeq: e.watermark });
    expect(JSON.stringify(e)).not.toContain("secret-center-text");
    touch(f, "restate", "spec");
    expect((await pass(f, center, T0 + 5000))[f.id]).toMatchObject({ kind: "pushed" });
    expect(center.dags).toHaveLength(2);
    await pass(f, center, T0 + 11_000);
    expect(center.dags).toHaveLength(3);
    expect(entryOf(f).dagError).toMatchObject({ reason: SOURCE_DAG_REASONS.merge, failures: 2, nextAttemptAt: T0 + 31_000 });
  } finally { await f.close(); }
});

test("N8B3F-1 丢回执: a 409 at a version the center already holds confirms the version only; the new binding goes up once the center merges", async () => {
  const f = await mirrored();
  try {
    bumpTo(f, 3);
    let mode: Mode = "contract";
    const center = fakeCenter(2, () => mode);
    let dropReceipt = true;
    const fetcher = (async (url: URL, init?: RequestInit) => {
      const response = await center.fetcher(url, init);
      if (dropReceipt && url.pathname.endsWith("/source-dags")) { dropReceipt = false; throw new Error("receipt lost"); }
      return response;
    }) as unknown as typeof fetch;
    const run = (at: number) => runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, now: () => at, fetch: fetcher });
    // The center keeps v3, the receipt is lost: dagVersion stays behind.
    await run(T0);
    expect(center.current()).toBe(3);
    expect(entryOf(f)).toMatchObject({ dagError: { reason: SOURCE_DAG_REASONS.unavailable } });
    expect(entryOf(f).dagVersion ?? 0).toBeLessThan(3);
    bind(f, "next", "c5-next");
    // A center that will not merge (before N8B3C) answers 409 at v3: only the version is confirmed.
    await run(T0 + HOUR);
    expect(center.dags.map((d) => [d.dag.version, d.dag.bindings.length])).toEqual([[3, 1], [3, 2]]);
    expect(entryOf(f)).toMatchObject({ dagVersion: 3, dagError: null });
    expect(entryOf(f).dagBindings).toBeUndefined();
    // Next pass sends the same version again; still 409 → fixed dagError and backoff.
    await run(T0 + HOUR + 1000);
    expect(center.dags).toHaveLength(3);
    expect(entryOf(f)).toMatchObject({ dagVersion: 3, dagError: { reason: SOURCE_DAG_REASONS.merge, failures: 1 } });
    expect(entryOf(f).dagBindings).toBeUndefined();
    // The center learns to merge (N8B3C): the next attempt is a 200, the digest moves, then quiet.
    mode = { merge: new Set() };
    await run(T0 + 2 * HOUR);
    expect(center.dags.map((d) => [d.dag.version, d.dag.bindings.length])).toEqual([[3, 1], [3, 2], [3, 2], [3, 2]]);
    expect(entryOf(f)).toMatchObject({ dagVersion: 3, dagError: null, dagDroppedBindings: 0, dagUploadedAt: T0 + 2 * HOUR });
    expect(entryOf(f).dagBindings).toMatch(/^[0-9a-f]{64}$/);
    await run(T0 + 3 * HOUR);
    await run(T0 + 2 * HOUR + 2 * SOURCE_DAG_DROPPED_RETRY_MS);
    expect(center.dags).toHaveLength(4);
  } finally { await f.close(); }
});
