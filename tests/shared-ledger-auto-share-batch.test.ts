/** team-project-N8A3 acceptance 1/2/3/5/7: shared cards and body size split batches; a failed batch never repeats as is. */
import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { createTask } from "../src/lib/ledger-write.js";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { readSharedLedgerMode, writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { previewSharedLedgerExport } from "../src/lib/shared-ledger-export.js";
import { SharedLedgerRemoteError, type SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import { SHARED_LEDGER_MAX_IMPORT_BODY_BYTES, type SharedLedgerImport } from "../src/lib/shared-ledger-contract.js";
import { prepareSharedLedgerImport, revokeUncommittedSharedLedgerImport } from "../src/lib/shared-ledger-import-run.js";
import { runSharedLedgerAutoSharePass, type AutoShareDeps } from "../src/lib/shared-ledger-auto-share.js";
import { AUTO_SHARE_MAX_BATCH_BYTES, autoShareRequestBytes, selectAutoShareBatch } from "../src/lib/shared-ledger-auto-share-batch.js";
import { AUTO_SHARE_RULES } from "../src/lib/shared-ledger-auto-share-check.js";
import { autoShareFixture, cleanupAutoShareState, PROJECT } from "./shared-ledger-auto-share-fixture.test.js";
import { CENTER, SCRUB } from "./shared-ledger-mirror-fixture.test.js";

afterEach(() => cleanupAutoShareState());
const T0 = Date.UTC(2026, 9, 9, 12, 0), STEP = 300_000;
const OPEN = { authorityMode: "source" as const, sharedPlanning: false };
type Fixture = Awaited<ReturnType<typeof autoShareFixture>>;
const batchAt = (n: number) => `auto-${PROJECT}-2026100912${String(n * 5).padStart(2, "0")}`;
const backup = (batchId: string) => join(STATE_DIR, "shared-ledger-migrations", `${batchId}.backup.sqlite`);
const members = (f: Fixture) => f.center.batches.map((b) => b.manifest.features.map((x) => x.sourceFeatureId));
const rev = (db: Database, id: string) => (db.prepare("SELECT rev FROM features WHERE id = ?").get(id) as { rev: number }).rev;

/** Appends DAG versions to a feature (each `nodes` long, every text `width` chars); returns its new current version. */
function addVersions(db: Database, featureId: string, count: number, nodes: { key: string; oneLine: string; taskId?: string }[] | ((v: number) => { key: string; oneLine: string }[])) {
  let version = (db.prepare("SELECT currentVersion FROM features WHERE id = ?").get(featureId) as { currentVersion: number }).currentVersion;
  for (let i = 0; i < count; i++) {
    version++;
    const list = typeof nodes === "function" ? nodes(version) : nodes;
    db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES (?,?,'new_issue','More work','owner',1000,?)")
      .run(featureId, version, JSON.stringify(list.map((n) => ({ key: n.key, taskId: (n as { taskId?: string }).taskId ?? null, oneLine: n.oneLine,
        deps: [], fileGlobs: [], estimate: "1h" }))));
  }
  db.prepare("UPDATE features SET currentVersion = ? WHERE id = ?").run(version, featureId);
  return version;
}
/** Two cards of `owner` that a later DAG version of `borrower` binds too (b5cf-i28 / quota-runtime shape). */
function shareCards(f: Fixture, owner: string, borrower: string) {
  for (const id of ["card-1", "card-2"]) {
    createTask(f.db, { actor: "owner", now: 1000 }, { project: PROJECT, id, title: `Card ${id}`, kind: "code" });
    f.db.prepare("UPDATE tasks SET featureId = ? WHERE id = ?").run(owner, id);
  }
  addVersions(f.db, borrower, 1, [{ key: "work", oneLine: "Plan" }, { key: "c1", oneLine: "Card one", taskId: "card-1" },
    { key: "c2", oneLine: "Card two", taskId: "card-2" }]);
}
/** The fixture's fake center, optionally answering some imports with 413, and a prepare that can be made to fail. */
function deps(f: Fixture, opts: { tooLarge?: (p: SharedLedgerImport) => boolean; failPrepare?: (ids: readonly string[]) => boolean } = {}) {
  const prepares: string[][] = [];
  const make = (now: number): AutoShareDeps => ({ ledgerPath: f.path, now: () => now, scrub: async () => SCRUB,
    client: (credential) => {
      const inner = f.center.client(credential);
      return new Proxy(inner, { get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== "import" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
        return async (p: SharedLedgerImport) => {
          if (opts.tooLarge?.(p)) { f.center.calls.push(`413 ${p.batchId}`); throw new SharedLedgerRemoteError(413, { error: "shared ledger rejected" }); }
          return (value as (p: SharedLedgerImport) => unknown).call(target, p);
        };
      } }) as SharedLedgerClient;
    },
    prepare: async (db, options) => {
      prepares.push([...options.featureIds]);
      const out = await prepareSharedLedgerImport(db, options);
      if (opts.failPrepare?.(options.featureIds)) throw new Error("injected prepare failure");
      return out;
    } });
  return { prepares, pass: (now: number) => runSharedLedgerAutoSharePass(make(now)) };
}

test("N8A3-1/2 共用卡分批: A·B share two cards, C is independent → one batch A+C staged; B then refused as sharing cards, never retried", async () => {
  const f = await autoShareFixture(["alpha", "beta", "gamma"]);
  try {
    const [a, b, c] = f.features as [string, string, string];
    shareCards(f, a, b);
    // main's batch (A and B together) is what the import contract refuses: the shared cards appear twice.
    const scratch = mkdtempSync(join(tmpdir(), "n8a3-")), both = [a, b];
    try {
      for (const id of both) await writeSharedLedgerMode(id, { authorityMode: "source", sharedPlanning: true }, scratch, f.path);
      expect(() => previewSharedLedgerExport(f.db, { localProject: PROJECT, projectId: CENTER.projectId, sourceInstanceId: CENTER.instanceId,
        featureIds: both, batchId: "probe", stateDir: scratch, scrub: SCRUB, summaries: {} })).toThrow();
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    const run = deps(f);
    await f.ledger(["shared-auto", "on", PROJECT]);
    expect(await run.pass(T0)).toEqual({ [PROJECT]: { action: "batch", batchId: batchAt(0) } });
    expect(members(f)).toEqual([[a, c].sort()]);
    expect(f.state().batches!.map((x) => x.outcome)).toEqual(["staged"]);
    expect(f.state().features![b]).toMatchObject({ status: "will_share" });
    expect(readSharedLedgerMode(b)).toEqual(OPEN);
    // 2: the next pass refuses B before any request; unchanged rev / version / rules → not pre-checked again.
    const calls = f.center.calls.length;
    await run.pass(T0 + STEP);
    const refused = { status: "refused" as const, reason: "与已共享的 feature 共用卡", rev: rev(f.db, b), version: 2, at: T0 + STEP, rules: AUTO_SHARE_RULES };
    expect(f.state().features![b]).toEqual(refused);
    expect(f.center.calls.length).toBe(calls);
    await run.pass(T0 + 2 * STEP);
    expect(f.state().features![b]).toEqual(refused);
    expect(f.center.calls.length).toBe(calls);
    expect(run.prepares).toEqual([[a, c]]);
    expect(readSharedLedgerMode(b)).toEqual(OPEN);
  } finally { await f.close(); }
});

test("N8A3-3/5 不原批重试: X fails prepare with Y → split; Y alone staged, X alone refused, then 0 prepares; aborted auto backups go", async () => {
  const f = await autoShareFixture(["alpha", "omega"]);
  try {
    const [y, x] = f.features as [string, string];
    const run = deps(f, { failPrepare: (ids) => ids.includes(x) });
    await f.ledger(["shared-auto", "on", PROJECT]);
    await run.pass(T0);
    expect(f.state().batches!.map((b) => [b.featureIds, b.outcome])).toEqual([[[y, x], "prepare-failed"]]);
    for (const id of [x, y]) {
      expect(f.state().features![id]).toMatchObject({ status: "deferred", reason: "批次准备失败", solo: true });
      expect(readSharedLedgerMode(id)).toEqual(OPEN);
    }
    expect(f.journal(batchAt(0)).phase).toBe("aborted");
    expect(existsSync(backup(batchAt(0)))).toBe(false);
    await run.pass(T0 + STEP);
    expect(members(f)).toEqual([[y]]);
    expect(f.journal(batchAt(1)).phase).toBe("verified");
    expect(existsSync(backup(batchAt(1)))).toBe(true); // staged: the backup stays
    await run.pass(T0 + 2 * STEP);
    expect(f.state().features![x]).toEqual({ status: "refused", reason: "导入准备失败", rev: rev(f.db, x), version: 1, at: T0 + 2 * STEP, rules: AUTO_SHARE_RULES });
    expect(existsSync(backup(batchAt(2)))).toBe(false);
    await run.pass(T0 + 3 * STEP);
    expect(run.prepares).toEqual([[y, x], [y], [x]]);
    expect(new Set(run.prepares.map((ids) => ids.join(","))).size).toBe(run.prepares.length);
    expect(f.center.batches).toHaveLength(1);
    expect(readSharedLedgerMode(x)).toEqual(OPEN);
  } finally { await f.close(); }
});

test("N8A3-5 a manual (non auto-) batch keeps its backup when revoked", async () => {
  const f = await autoShareFixture(["alpha"]);
  try {
    const options = { localProject: PROJECT, projectId: CENTER.projectId, sourceInstanceId: CENTER.instanceId, featureIds: [f.features[0]!],
      batchId: "manual-n8a3", stateDir: STATE_DIR, scrub: SCRUB, summaries: {} };
    const { payload } = await prepareSharedLedgerImport(f.db, options);
    expect(await revokeUncommittedSharedLedgerImport(f.db, STATE_DIR, "manual-n8a3", payload.manifestDigest)).toMatchObject({ status: "aborted" });
    expect(existsSync(backup("manual-n8a3"))).toBe(true);
  } finally { await f.close(); }
});

/** ~20 KB per past version: 20 long node texts (past texts upload as they are); `count` versions ≈ count × 20 KB of body. */
const bulky = (v: number) => Array.from({ length: 20 }, (_, i) => ({ key: `n${i}`, oneLine: `Version ${v} node ${i} ${"step ".repeat(180)}`.slice(0, 1000) }));
const MIB = 1_048_576;
const bodyBytes = (f: Fixture, n: number) => autoShareRequestBytes(f.center.batches[n]!);

test("N8A6B 体积上限 = 中心导入上限 8 MiB 减余量 → 7_500_000", () => {
  expect(AUTO_SHARE_MAX_BATCH_BYTES).toBe(7_500_000);
  expect(SHARED_LEDGER_MAX_IMPORT_BODY_BYTES - AUTO_SHARE_MAX_BATCH_BYTES).toBeGreaterThanOrEqual(600_000);
});

test("N8A6B-1 体积: a ~1.5 MB feature (over the old 1 MiB center cap) and a small one go in one staged batch", async () => {
  const f = await autoShareFixture(["xray", "yankee"]);
  try {
    const [x, y] = f.features as [string, string];
    addVersions(f.db, x, 75, bulky);
    const run = deps(f);
    await f.ledger(["shared-auto", "on", PROJECT]);
    await run.pass(T0);
    expect(f.state().features![x]).toMatchObject({ status: "shared" });
    expect(members(f)).toEqual([[x, y]]);
    expect(bodyBytes(f, 0)).toBeGreaterThan(MIB);
    expect(bodyBytes(f, 0)).toBeLessThanOrEqual(AUTO_SHARE_MAX_BATCH_BYTES);
    expect(f.center.calls.some((call) => call.includes("413"))).toBe(false);
    expect(run.prepares).toEqual([[x, y]]);
  } finally { await f.close(); }
});

test("N8A6B-2 体积: X's own ~7.6 MB body is over the limit → refused with 0 requests; Y and Z go in one batch", async () => {
  const f = await autoShareFixture(["xray", "yankee", "zulu"]);
  try {
    const [x, y, z] = f.features as [string, string, string];
    addVersions(f.db, x, 380, bulky);
    const run = deps(f);
    await f.ledger(["shared-auto", "on", PROJECT]);
    await run.pass(T0);
    expect(f.state().features![x]).toEqual({ status: "refused", reason: "体积超过中心上限", rev: rev(f.db, x), version: 381, at: T0, rules: AUTO_SHARE_RULES });
    expect(members(f)).toEqual([[y, z]]);
    expect(f.center.calls.some((call) => call.includes("413"))).toBe(false);
    expect(run.prepares).toEqual([[y, z]]);
    expect(readSharedLedgerMode(x)).toEqual(OPEN);
  } finally { await f.close(); }
}, 60_000);

test("N8A6B-3 体积: two ~4 MB features never share a batch; each batch stays under the limit", async () => {
  const f = await autoShareFixture(["alpha", "bravo"]);
  try {
    const [a, b] = f.features as [string, string];
    for (const id of [a, b]) addVersions(f.db, id, 200, bulky);
    const run = deps(f);
    await f.ledger(["shared-auto", "on", PROJECT]);
    await run.pass(T0);
    expect(members(f)).toEqual([[a]]);
    await run.pass(T0 + STEP);
    expect(members(f)).toEqual([[a], [b]]);
    for (const n of [0, 1]) {
      expect(bodyBytes(f, n)).toBeGreaterThan(3 * MIB);
      expect(bodyBytes(f, n)).toBeLessThanOrEqual(AUTO_SHARE_MAX_BATCH_BYTES);
    }
    expect(bodyBytes(f, 0) + bodyBytes(f, 1)).toBeGreaterThan(AUTO_SHARE_MAX_BATCH_BYTES);
    expect(run.prepares).toEqual([[a], [b]]);
    expect(f.center.calls.some((call) => call.includes("413"))).toBe(false);
  } finally { await f.close(); }
}, 90_000);

test("N8A6B batch selection at the new cap: 1.5 MB + 0.2 MB share a batch, two 4 MB bodies never do", () => {
  const entry = (bytes: number): Parameters<typeof selectAutoShareBatch>[1][string] => ({ taskIds: [], bytes, envelope: 500, solo: false });
  expect(selectAutoShareBatch(["a", "b"], { a: entry(1_500_000), b: entry(200_000) })).toEqual(["a", "b"]);
  expect(selectAutoShareBatch(["a", "b"], { a: entry(4_000_000), b: entry(4_000_000) })).toEqual(["a"]);
  expect(selectAutoShareBatch(["b"], { b: entry(4_000_000) })).toEqual(["b"]);
});

test("N8A3-7 体积: the center answers a two-feature batch with 413 → each alone next; alone 413 again → refused for size", async () => {
  const f = await autoShareFixture(["yankee", "zulu"]);
  try {
    const [y, z] = f.features as [string, string];
    const run = deps(f, { tooLarge: (p) => p.manifest.features.length > 1 || p.manifest.features[0]!.sourceFeatureId === z });
    await f.ledger(["shared-auto", "on", PROJECT]);
    await run.pass(T0);
    expect(f.state().batches!.map((b) => b.outcome)).toEqual(["too-large"]);
    for (const id of [y, z]) {
      expect(f.state().features![id]).toMatchObject({ status: "deferred", reason: "批次体积超过中心上限", solo: true });
      expect(readSharedLedgerMode(id)).toEqual(OPEN);
    }
    expect(existsSync(backup(batchAt(0)))).toBe(false);
    await run.pass(T0 + STEP);
    expect(members(f)).toEqual([[y]]);
    await run.pass(T0 + 2 * STEP);
    expect(f.state().features![z]).toMatchObject({ status: "refused", reason: "体积超过中心上限", rules: AUTO_SHARE_RULES });
    expect(readSharedLedgerMode(z)).toEqual(OPEN);
    const calls = f.center.calls.length;
    await run.pass(T0 + 3 * STEP);
    expect(f.center.calls.length).toBe(calls);
    expect(run.prepares).toEqual([[y, z], [y], [z]]);
  } finally { await f.close(); }
});

test("N8A3-6 the measured size is the body the real client sends to POST imports", async () => {
  const f = await autoShareFixture(["alpha", "beta"]);
  try {
    const sent: { mode: string; bytes: number; payload: SharedLedgerImport }[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input), method = init?.method ?? "GET";
      if (method === "GET") return Response.json({ status: "unknown", batchId: url.pathname.split("/").at(-1) });
      const body = String(init!.body), payload = (JSON.parse(body) as { payload: SharedLedgerImport }).payload;
      sent.push({ mode: payload.mode, bytes: Buffer.byteLength(body), payload });
      return new Response("{}", { status: 422 });
    }) as typeof fetch;
    await f.ledger(["shared-auto", "on", PROJECT]);
    await runSharedLedgerAutoSharePass({ ledgerPath: f.path, now: () => T0, fetch: fetcher, key: () => instanceKeySync(STATE_DIR), scrub: async () => SCRUB });
    expect(sent.map((s) => s.mode)).toEqual(["dry-run"]);
    expect(autoShareRequestBytes(sent[0]!.payload)).toBe(sent[0]!.bytes);
    expect(sent[0]!.bytes).toBeLessThan(AUTO_SHARE_MAX_BATCH_BYTES);
  } finally { await f.close(); }
});
