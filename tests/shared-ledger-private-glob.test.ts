/** team-project-N8A5: a private-repo node's file range (`repo:` globs) never leaves this machine; the gate itself is unchanged. */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage } from "../src/lib/ledger-write.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { previewSharedLedgerExport } from "../src/lib/shared-ledger-export.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { SharedLedgerScrubError } from "../src/lib/shared-ledger-scrub.js";
import { isPrivateRepoGlob, sharedLedgerDagVersion } from "../src/lib/shared-ledger-source-dag-push-version.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { updateSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { runSharedLedgerMirrorPass } from "../src/lib/shared-ledger-mirror-loop.js";
import { SOURCE_DAG_UPLOAD_PATH } from "../src/lib/shared-ledger-contract-source-dag.js";
import { updateAutoShareProject } from "../src/lib/shared-ledger-auto-share-state.js";
import { AUTO_SHARE_REASONS, AUTO_SHARE_RULES } from "../src/lib/shared-ledger-auto-share-check.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { CENTER, cleanupMirrorState, commitJournal, serviceCredential } from "./shared-ledger-mirror-fixture.test.js";
import { autoShareFixture, PROJECT } from "./shared-ledger-auto-share-fixture.test.js";

afterEach(() => cleanupMirrorState());
const identity = { username: "glob-user", hostname: "glob-host" }; // 本机身份（合成）
const PRIVATE = "repo:org/x/y.ts";
type Node = { key: string; taskId: string | null; oneLine: string; fileGlobs: string[] };

/** 合成台账：一个 feature 三个版本；节点 A 一条普通 glob + 一条 repo:，节点 B 只有 repo:，A、B 都绑卡。 */
async function privateLedger(patch: (version: number, nodes: Node[]) => Node[] = (_v, n) => n, reason = (v: number) => `Plan v${v}`) {
  const dir = mkdtempSync(join(tmpdir(), "shared-ledger-private-glob-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const project = "glob-project", featureId = "glob-plan";
  for (const id of ["card-a", "card-b"]) createTask(db, { actor: "owner", now: 1000 }, { project, id, title: `Card ${id}`, kind: "code" });
  db.prepare("INSERT INTO features (id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,'active',3,1,'owner',1000,1000)")
    .run(featureId, project, "Private plan", "Shared description");
  for (const version of [1, 2, 3]) {
    const nodes = patch(version, [{ key: "a", taskId: "card-a", oneLine: `Node A v${version}`, fileGlobs: ["src/a.ts", PRIVATE] },
      { key: "b", taskId: "card-b", oneLine: `Node B v${version}`, fileGlobs: ["repo:org/x/z/**", PRIVATE] }]);
    db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES (?,?,?,?,'owner',1000,?)")
      .run(featureId, version, version > 1 ? "new_issue" : "initial", reason(version),
        JSON.stringify(nodes.map((n) => ({ ...n, deps: [], estimate: "1h" }))));
  }
  await writeSharedLedgerMode(featureId, { authorityMode: "source", sharedPlanning: true }, dir);
  const options = { localProject: project, projectId: "shared-project", sourceInstanceId: "peer-a", featureIds: [featureId], batchId: "batch-glob",
    stateDir: dir, summaries: {}, scrub: { identity } };
  const localNodes = () => (db.query("SELECT version, nodes FROM dag_versions ORDER BY version").all() as { version: number; nodes: string }[]);
  return { db, options, localNodes, close() { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}

test("isPrivateRepoGlob: only the `repo:` prefix", () => {
  expect(["repo:org/x/y.ts", "repo:"].map(isPrivateRepoGlob)).toEqual([true, true]);
  expect(["src/repo:x", "other:x", "repos/x", "/repo:x"].map(isPrivateRepoGlob)).toEqual([false, false, false, false]);
  const out = sharedLedgerDagVersion({ version: 1, reasonText: "r" }, [{ key: "b", deps: [], fileGlobs: [PRIVATE], oneLine: "B" } as never]);
  expect(out.nodes[0]!.fileGlobs).toEqual([]);
});

test("验收 1/4 导出去掉 repo: 条目: every version uploads A = [src/a.ts], B = []; the body has no `repo:` / `org/x`; local nodes unchanged", async () => {
  const f = await privateLedger();
  try {
    const before = f.localNodes();
    const out = previewSharedLedgerExport(f.db, f.options);
    const versions = out.payload.manifest.features[0]!.versions;
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    for (const v of versions) {
      expect(v.nodes.map((n) => [n.key, n.fileGlobs])).toEqual([["a", ["src/a.ts"]], ["b", []]]);
      expect(v.bindings).toEqual([{ nodeKey: "a", taskId: "card-a" }, { nodeKey: "b", taskId: "card-b" }]);
    }
    const body = JSON.stringify(out.payload);
    expect(body).not.toContain("repo:");
    expect(body).not.toContain("org/x");
    expect(out.preview).not.toContain("repo:");
    expect(f.localNodes()).toEqual(before);
    expect(before.every((r) => r.nodes.includes(PRIVATE))).toBe(true);
  } finally { f.close(); }
});

test("验收 3 闸没放宽: any other bad glob next to repo: still refuses the whole package", async () => {
  for (const bad of ["/abs/x.ts", "../x", "~/x", "other:x"]) {
    const f = await privateLedger((v, nodes) => v === 2 ? nodes.map((n) => n.key === "a" ? { ...n, fileGlobs: [...n.fileGlobs, bad] } : n) : nodes);
    try {
      let error: unknown = null;
      try { previewSharedLedgerExport(f.db, f.options); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(SharedLedgerScrubError);
      expect((error as SharedLedgerScrubError).fields.some((x) => x.includes("fileGlobs"))).toBe(true);
    } finally { f.close(); }
  }
});

test("验收 3 只作用于 fileGlobs: `repo:` text in the current oneLine / reason goes through the gate as before (kept as written)", async () => {
  const f = await privateLedger((v, nodes) => v === 3 ? nodes.map((n) => n.key === "a" ? { ...n, oneLine: "Port repo:org/x/y.ts" } : n) : nodes,
    (v) => v === 3 ? "Follow repo:org/x" : `Plan v${v}`);
  try {
    const current = previewSharedLedgerExport(f.db, f.options).payload.manifest.features[0]!.versions[2]!;
    expect(current.nodes[0]!.oneLine).toBe("Port repo:org/x/y.ts");
    expect(current.reason).toBe("Follow repo:org/x");
    expect(current.nodes.map((n) => n.fileGlobs)).toEqual([["src/a.ts"], []]);
  } finally { f.close(); }
});

test("验收 2 源 DAG 推送同规则: a rewritten version uploads without repo: globs; the request body has no `repo:`", async () => {
  const f = integrationFixture();
  try {
    await commitJournal(f, "batch-n8a5");
    await serviceCredential();
    expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: true });
    f.db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES (?,2,'new_issue','Rewrite 2','owner',1001,?)")
      .run(f.id, JSON.stringify([{ key: "existing", taskId: "c5-existing", oneLine: "Existing", deps: [], status: "spec", estimate: "", inheritedFrom: null, fileGlobs: [PRIVATE] },
        { key: "next", taskId: null, oneLine: "Work", deps: ["existing"], status: "planned", estimate: "S", inheritedFrom: null, fileGlobs: ["src/lib/c5.ts", PRIVATE] }]));
    f.db.prepare("UPDATE features SET currentVersion = 2 WHERE id = ?").run(f.id);
    await updateSharedLedgerMirrors(STATE_DIR, (all) => { all[f.id] = { ...all[f.id]!, dagVersion: 1 }; });
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    const bodies: string[] = [];
    let seq = 0;
    const fetcher = (async (url: URL, init?: RequestInit) => {
      const raw = String(init?.body), { payload } = JSON.parse(raw) as { payload: Record<string, unknown> };
      if (url.pathname === SOURCE_DAG_UPLOAD_PATH.replace("{teamId}", CENTER.teamId)) {
        bodies.push(raw);
        const dag = payload.dag as { version: number };
        return Response.json({ schemaVersion: 1, featureId: payload.featureId, version: dag.version, digest: "c".repeat(64), droppedBindings: 0 });
      }
      return Response.json({ schemaVersion: 1, serverSeq: ++seq, sourceInstanceId: payload.sourceInstanceId, sourceSeq: payload.sourceSeq, digest: "b".repeat(64) });
    }) as unknown as typeof fetch;
    expect((await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, now: () => 1_000_000, fetch: fetcher }))[f.id]).toMatchObject({ kind: "pushed" });
    expect(bodies).toHaveLength(1);
    const dag = (JSON.parse(bodies[0]!) as { payload: { dag: { version: number; nodes: { key: string; fileGlobs: string[] }[] } } }).payload.dag;
    expect(dag.version).toBe(2);
    expect(dag.nodes.map((n) => [n.key, n.fileGlobs])).toEqual([["existing", []], ["next", ["src/lib/c5.ts"]]]);
    expect(bodies[0]).not.toContain("repo:");
    expect(f.db.prepare("SELECT nodes FROM dag_versions WHERE featureId = ? AND version = 2").get(f.id)).toMatchObject({ nodes: expect.stringContaining(PRIVATE) });
  } finally { await f.close(); }
});

test("验收 5 规则版本 5: a feature refused under rules 4 for its text, rev / version unchanged, is pre-checked again and now passes", async () => {
  const f = await autoShareFixture([]);
  try {
    const id = createFeature(f.db, { actor: f.actor }, { project: PROJECT, slug: "private", title: "Feature private" }).row.id;
    initDag(f.db, { actor: f.actor }, { id, rev: 1, nodes: [{ key: "work", oneLine: "Plan private", fileGlobs: ["src/private.ts", PRIVATE] }] });
    expect(await f.ledger(["shared-auto", "observe", PROJECT])).toMatchObject({ ok: true, mode: "observe" });
    const row = f.db.prepare("SELECT rev, currentVersion AS version FROM features WHERE id = ?").get(id) as { rev: number; version: number };
    await updateAutoShareProject(STATE_DIR, PROJECT, (p) => {
      p.features = { [id]: { status: "refused", reason: AUTO_SHARE_REASONS.scrub, ...row, at: 1, rules: 4 } };
    });
    expect(AUTO_SHARE_RULES).toBe(6);
    await f.pass(Date.UTC(2026, 9, 9, 12, 0));
    expect(f.state().features![id]!.status).toBe("will_share");
  } finally { await f.close(); }
});
