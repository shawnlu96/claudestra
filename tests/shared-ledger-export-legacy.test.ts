/** team-project-N8A2: legacy cards (short heads, cross-feature deps) export under the mirror's field rules, built in one place. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import type { SharedLedgerProjection, SharedLedgerTaskProjection } from "../src/lib/shared-ledger-contract.js";
import { previewSharedLedgerExport, sharedLedgerExportHeads, sharedLedgerScrubWithCommits } from "../src/lib/shared-ledger-export.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { pushSharedLedgerMirror, type MirrorEntry } from "../src/lib/shared-ledger-projector.js";
import { updateAutoShareProject } from "../src/lib/shared-ledger-auto-share-state.js";
import { AUTO_SHARE_REASONS, AUTO_SHARE_RULES } from "../src/lib/shared-ledger-auto-share-check.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { gitRepo } from "./shared-ledger-export-fit.test.js";
import { autoShareFixture, cleanupAutoShareState, PROJECT } from "./shared-ledger-auto-share-fixture.test.js";

const identity = { username: "legacy-user", hostname: "legacy-host" }; // 本机身份（合成）
const UNKNOWN = "feedface".repeat(5);

/**
 * 合成台账：feature A 有 a-known（已知提交、pr 12）、a-short（7 位短号、pr "0"）、a-unknown（认不出的 40 位、pr "x"）；
 * feature B 有 b-card。边：a-known → a-short（A 内）、b-card → a-known（跨 feature）。
 */
async function legacyLedger(knownHead: string) {
  const dir = mkdtempSync(join(tmpdir(), "shared-ledger-legacy-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const actor = "agent-legacy-pm", ctx = { actor }, project = "legacy-project";
  db.run("INSERT INTO ledger_instance VALUES ('origin', 'lg00')");
  setMeta(db, { actor: "owner" }, { project, key: "pms", value: [actor] });
  const card = (id: string, head: string, pr: string) => {
    createTask(db, ctx, { project, id, title: id, kind: "code" });
    db.prepare("UPDATE tasks SET headSHA = ?, pr = ? WHERE id = ?").run(head, pr, id);
  };
  card("a-known", knownHead, "12"); card("a-short", "abc1234", "0"); card("a-unknown", UNKNOWN, "x"); card("b-card", "1234567", "7");
  const feature = (slug: string, nodes: { key: string; taskId: string }[]) => {
    const id = createFeature(db, ctx, { project, slug, title: `Feature ${slug}` }).row.id;
    initDag(db, ctx, { id, rev: 1, nodes: nodes.map((n) => ({ ...n, oneLine: n.key, fileGlobs: [`src/${n.key}.ts`] })) });
    return id;
  };
  const a = feature("alpha", [{ key: "known", taskId: "a-known" }, { key: "short", taskId: "a-short" }, { key: "unknown", taskId: "a-unknown" }]);
  const b = feature("beta", [{ key: "b", taskId: "b-card" }]);
  addDep(db, ctx, { from: "a-known", to: "a-short", when: "verified" });
  addDep(db, ctx, { from: "b-card", to: "a-known", when: "verified" });
  for (const id of [a, b]) await writeSharedLedgerMode(id, { authorityMode: "source", sharedPlanning: true }, dir);
  const options = (featureIds: string[], scrub: { identity: typeof identity; commits?: ReadonlySet<string> } = { identity }) => ({
    localProject: project, projectId: "shared-project", sourceInstanceId: "peer-a", featureIds, batchId: "batch-legacy", stateDir: dir,
    summaries: {}, scrub });
  return { db, dir, a, b, project, options, close() { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}
const tasksOf = (payload: ReturnType<typeof previewSharedLedgerExport>["payload"], featureId: string) =>
  Object.fromEntries(payload.manifest.features.find((f) => f.sourceFeatureId === featureId)!.projection.tasks.map((t) => [t.sourceTaskId, t]));
const fields = (t: SharedLedgerTaskProjection) => ({ head: t.head, deps: t.deps, pr: t.pr });

afterEach(() => cleanupAutoShareState());

test("验收 1 短提交号: a 7-char head previews as head=null instead of a contract error", async () => {
  const g = gitRepo(), f = await legacyLedger(g.head);
  try {
    const { payload } = previewSharedLedgerExport(f.db, f.options([f.a]));
    expect(tasksOf(payload, f.a)["a-short"]!.head).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("abc1234");
  } finally { f.close(); g.close(); }
});

test("验收 2 跨 feature 依赖: exporting only A drops B's edge; exporting A and B together still keeps feature-local edges only", async () => {
  const g = gitRepo(), f = await legacyLedger(g.head);
  try {
    const only = tasksOf(previewSharedLedgerExport(f.db, f.options([f.a])).payload, f.a);
    expect(only["a-known"]!.deps).toEqual([]);
    expect(only["a-short"]!.deps).toEqual(["a-known"]);
    const both = previewSharedLedgerExport(f.db, f.options([f.a, f.b])).payload;
    expect(tasksOf(both, f.a)["a-known"]!.deps).toEqual([]);
    expect(tasksOf(both, f.a)["a-short"]!.deps).toEqual(["a-known"]);
    expect(tasksOf(both, f.b)["b-card"]!.deps).toEqual([]);
  } finally { f.close(); g.close(); }
});

test("验收 3 认不出的完整提交号: unknown 40-hex is null and not blocked; a known commit uploads verbatim", async () => {
  const g = gitRepo(), f = await legacyLedger(g.head);
  try {
    const scrub = await sharedLedgerScrubWithCommits({ identity }, sharedLedgerExportHeads(f.db, f.project, [f.a]), g.repo);
    expect([...scrub.commits!]).toEqual([g.head]);
    const { payload } = previewSharedLedgerExport(f.db, f.options([f.a], scrub));
    const tasks = tasksOf(payload, f.a);
    expect(tasks["a-known"]!.head).toBe(g.head);
    expect(tasks["a-unknown"]!.head).toBeNull();
    expect(JSON.stringify(payload)).not.toContain(UNKNOWN);
    // Without commits even a real head is not known here: null, never raw.
    expect(tasksOf(previewSharedLedgerExport(f.db, f.options([f.a])).payload, f.a)["a-known"]!.head).toBeNull();
  } finally { f.close(); g.close(); }
});

test("验收 4 一处规则: the same cards built by the export and by the mirror push have identical head / deps / pr", async () => {
  const g = gitRepo(), f = await legacyLedger(g.head);
  try {
    const scrub = await sharedLedgerScrubWithCommits({ identity }, sharedLedgerExportHeads(f.db, f.project, [f.a]), g.repo);
    const exported = tasksOf(previewSharedLedgerExport(f.db, f.options([f.a], scrub)).payload, f.a);
    const sent: SharedLedgerProjection[] = [];
    const client = { async projection(p: SharedLedgerProjection) {
      sent.push(structuredClone(p));
      return { schemaVersion: 1 as const, serverSeq: 1, sourceInstanceId: p.sourceInstanceId, sourceSeq: p.sourceSeq, digest: "a".repeat(64) };
    } };
    const entry: MirrorEntry = { enabled: true, batchId: "batch-legacy", centerId: "center-a", teamId: "team-a", projectId: "shared-project",
      centerFeatureId: "center-feature-a", sourceInstanceId: "peer-a", localProject: f.project, watermark: 0, snapshot: true,
      fingerprints: {}, taskMeta: {}, lastPushAt: null, lastPushSeq: null, lastError: null, lastErrorAt: null, failures: 0, nextAttemptAt: 0 };
    const r = await pushSharedLedgerMirror(f.db, f.a, entry, { client, scrub, now: 1_000 });
    expect(r.outcome).toMatchObject({ kind: "pushed" });
    const mirrored = Object.fromEntries(sent[0]!.tasks.map((t) => [t.sourceTaskId, t]));
    expect(Object.keys(mirrored).sort()).toEqual(Object.keys(exported).sort());
    for (const id of Object.keys(exported)) expect(fields(mirrored[id]!)).toEqual(fields(exported[id]!));
    expect(fields(exported["a-known"]!)).toEqual({ head: g.head, deps: [], pr: 12 });
    expect(fields(exported["a-short"]!)).toEqual({ head: null, deps: ["a-known"], pr: null });
    expect(fields(exported["a-unknown"]!)).toEqual({ head: null, deps: [], pr: null });
  } finally { f.close(); g.close(); }
});

test("验收 5 规则版本重试: every refused feature without a rules version (any reason) is pre-checked again in observe; one at the current version is not", async () => {
  const f = await autoShareFixture(["alpha", "beta", "gamma", "delta", "epsilon"]);
  try {
    const [scrubStale, scrubCurrent, centerStale, centerCurrent, bare] = f.features as [string, string, string, string, string];
    expect(await f.ledger(["shared-auto", "observe", PROJECT])).toMatchObject({ ok: true, mode: "observe" });
    const row = (id: string) => f.db.prepare("SELECT rev, currentVersion AS version FROM features WHERE id = ?").get(id) as { rev: number; version: number };
    const refused = (id: string, reason?: string, rules?: number) =>
      ({ status: "refused" as const, ...(reason ? { reason } : {}), ...row(id), at: 1, ...(rules ? { rules } : {}) });
    await updateAutoShareProject(STATE_DIR, PROJECT, (p) => {
      p.features = { [scrubStale]: refused(scrubStale, AUTO_SHARE_REASONS.scrub), [scrubCurrent]: refused(scrubCurrent, AUTO_SHARE_REASONS.scrub, AUTO_SHARE_RULES),
        [centerStale]: refused(centerStale, AUTO_SHARE_REASONS.center), [centerCurrent]: refused(centerCurrent, AUTO_SHARE_REASONS.center, AUTO_SHARE_RULES),
        [bare]: refused(bare) };
    });
    expect(AUTO_SHARE_RULES).toBe(4);
    expect(await f.pass(Date.UTC(2026, 9, 9, 12, 0))).toEqual({ [PROJECT]: { action: "observe" } });
    expect(f.features.map((id) => f.state().features![id]!.status)).toEqual(["will_share", "refused", "will_share", "refused", "will_share"]);
    expect(f.state().features![scrubCurrent]).toEqual({ status: "refused", reason: AUTO_SHARE_REASONS.scrub, ...row(scrubCurrent), at: 1, rules: 4 });
    expect(f.state().features![centerCurrent]).toEqual({ status: "refused", reason: AUTO_SHARE_REASONS.center, ...row(centerCurrent), at: 1, rules: 4 });
    const status = await f.ledger(["shared-auto", "status", PROJECT]) as { lists: Record<string, { featureId: string }[]> };
    expect(status.lists["会共享"]!.map((x) => x.featureId).sort()).toEqual([scrubStale, centerStale, bare].sort());
    expect(f.center.calls).toEqual([]);
  } finally { await f.close(); }
});

test("验收 5 规则版本重试: a center refusal records the current rules version, so it is not retried every pass", async () => {
  const f = await autoShareFixture(["alpha", "beta"]);
  try {
    f.center.fault("dry-run-4xx");
    await f.ledger(["shared-auto", "on", PROJECT]);
    await f.pass(Date.UTC(2026, 9, 9, 12, 0));
    for (const id of f.features) expect(f.state().features![id]).toMatchObject({ status: "deferred", reason: AUTO_SHARE_REASONS.batchRejected, solo: true });
    await f.pass(Date.UTC(2026, 9, 9, 12, 1));
    await f.pass(Date.UTC(2026, 9, 9, 12, 2));
    for (const id of f.features) expect(f.state().features![id]).toMatchObject({ status: "refused", reason: "中心拒收(unknown)", rules: AUTO_SHARE_RULES });
    f.center.fault("none");
    expect(await f.ledger(["shared-auto", "observe", PROJECT])).toMatchObject({ ok: true, mode: "observe" });
    const calls = f.center.calls.length;
    await f.pass(Date.UTC(2026, 9, 9, 12, 5));
    for (const id of f.features) expect(f.state().features![id]).toMatchObject({ status: "refused", reason: "中心拒收(unknown)" });
    expect(f.center.calls.length).toBe(calls);
  } finally { await f.close(); }
});
