/**
 * team-parity-MIRRORID1 PM 补：源 DAG 的绑定里有撞闸卡号时，on 下这条绑定不进 bindings（节点照常在），
 * 推送（shared-ledger-source-dag-push.ts）和落库前检查（dag-write-scrub.ts）一起恢复；observe / off 照旧被拒。
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { rewriteDag, bindNode } from "../src/lib/ledger-dag-write.js";
import { effectiveNodes, getDagVersion } from "../src/lib/ledger-feature.js";
import { createTask } from "../src/lib/ledger-write.js";
import { LedgerError } from "../src/lib/ledger-store.js";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import type { SourceDagUpload } from "../src/lib/shared-ledger-contract-source-dag.js";
import { readSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { pushSourceDagMirror, SOURCE_DAG_REASONS } from "../src/lib/shared-ledger-source-dag-push.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { cleanupMirrorState, commitJournal, SCRUB, serviceCredential } from "./shared-ledger-mirror-fixture.test.js";

const BLOCKED = "followup-reliability-RECLAIMINT1";
const BAD = "demo-project-ZETAQK-r13-20270102.md";
const setPolicy = (project: string, keys: { dagWriteScrub: RecoveryMode; mirrorSkipBlockedId: RecoveryMode }) => {
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [project]: { keys } } }));
};
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  rmSync(RECOVERY_POLICY_PATH, { force: true });
  for (const c of cleanups.splice(0).reverse()) await c();
  cleanupMirrorState();
});

/** 来源镜像 feature：撞闸的卡绑在 v1 的 next 上，v2 原样带着这条绑定，另加一个节点。 */
async function world() {
  const f = integrationFixture();
  cleanups.push(() => f.close());
  await commitJournal(f, "batch-mirrorid1");
  await serviceCredential();
  expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: true });
  createTask(f.db, { actor: f.actor }, { project: f.project, id: BLOCKED, title: "Blocked id", kind: "code" });
  bindNode(f.db, { actor: f.actor }, { id: f.id, rev: f.feature().rev, key: "next", taskId: BLOCKED });
  setPolicy(f.project, { dagWriteScrub: "off", mirrorSkipBlockedId: "off" }); // 闸之前的旧状态：带着这条绑定写出 v2
  rewrite(f, "v2", "more");
  return f;
}
/** 当前版本原样带入（含 dag-bind 的绑定），再加一个节点。 */
const rewrite = (f: ReturnType<typeof integrationFixture>, reasonText: string, key: string, oneLine = "More work") => {
  const cur = effectiveNodes(f.db, getDagVersion(f.db, f.id, f.feature().currentVersion)!)
    .map((n) => ({ key: n.key, taskId: n.taskId, oneLine: n.oneLine, deps: n.deps, ...(n.fileGlobs ? { fileGlobs: n.fileGlobs } : {}) }));
  return rewriteDag(f.db, { actor: f.actor }, { id: f.id, rev: f.feature().rev, reasonKind: "new_issue", reasonText, cancel: new Map(), scopeChange: false,
    askFrom: { agent: f.actor, channelId: null }, nodes: [...cur, { key, oneLine, deps: ["existing"] }] });
};
function center() {
  const uploads: SourceDagUpload[] = [];
  const client = { async sourceDag(u: SourceDagUpload) {
    uploads.push(structuredClone(u));
    return { kind: "ok" as const, result: { schemaVersion: 1 as const, featureId: u.featureId, version: u.dag.version, digest: "a".repeat(64), droppedBindings: 0 } };
  } };
  return { uploads, client };
}
const entryOf = (f: { id: string }) => readSharedLedgerMirrors()[f.id]!;
const refusal = (run: () => unknown): LedgerError => {
  try { run(); } catch (e) { if (e instanceof LedgerError) return e; throw e; }
  throw new Error("expected a refusal");
};

test("[验收线 5] 源 DAG 推送：on 下 bindings 去掉撞闸的卡、节点照常在、同版本不反复重推；observe / off 照旧被拒", async () => {
  const f = await world();
  expect(f.feature().currentVersion).toBe(2);
  for (const mode of ["off", "observe"] as const) {
    setPolicy(f.project, { dagWriteScrub: "off", mirrorSkipBlockedId: mode });
    const c = center();
    const next = await pushSourceDagMirror(f.db, f.id, entryOf(f), { client: c.client, scrub: SCRUB, now: 1_000 });
    expect(c.uploads).toHaveLength(0);
    expect(next.dagError).toMatchObject({ reason: SOURCE_DAG_REASONS.blocked, failures: 1 });
  }
  setPolicy(f.project, { dagWriteScrub: "off", mirrorSkipBlockedId: "on" });
  const c = center();
  const done = await pushSourceDagMirror(f.db, f.id, entryOf(f), { client: c.client, scrub: SCRUB, now: 1_000 });
  expect(c.uploads).toHaveLength(1);
  const dag = c.uploads[0]!.dag;
  expect(JSON.stringify(c.uploads[0])).not.toContain(BLOCKED);
  expect(dag.bindings).toEqual([{ nodeKey: "existing", taskId: "c5-existing" }]);
  expect(dag.nodes.map((n) => n.key).sort()).toEqual(["existing", "more", "next"]);
  expect(done).toMatchObject({ dagVersion: 2, dagError: null });
  // 绑定摘要按略过后的集合算：同一版本下一轮不会因为「本机绑定变了」再推
  expect(await pushSourceDagMirror(f.db, f.id, done, { client: c.client, scrub: SCRUB, now: 2_000 })).toBe(done);
  expect(c.uploads).toHaveLength(1);
});

test("[验收线 5] rewrite_dag 加新节点（dagWriteScrub on）：on 能写入；observe / off 照旧被拒、文本不变；节点 oneLine 撞闸 on 下也照拒", async () => {
  const f = await world();
  const refused: string[] = [];
  for (const mode of ["off", "observe"] as const) {
    setPolicy(f.project, { dagWriteScrub: "on", mirrorSkipBlockedId: mode });
    const e = refusal(() => rewrite(f, "v3", "extra"));
    expect(e.current?.dagWriteScrub).toEqual([expect.stringMatching(/^dag\.bindings\[\d+\]\.taskId$/)]);
    expect(e.message).toMatch(/^这一版推不出去：dag\.bindings\[\d+\]\.taskId（含不能外发的内容，没有写入；改掉这些字段的文字再写）$/);
    expect(f.feature().currentVersion).toBe(2);
    refused.push(e.message);
  }
  expect(refused[1]).toBe(refused[0]);
  setPolicy(f.project, { dagWriteScrub: "on", mirrorSkipBlockedId: "on" });
  const bad = refusal(() => rewrite(f, "v3", "extra", `见 ${BAD}`));
  expect(bad.current?.dagWriteScrub).toEqual([expect.stringMatching(/^dag\.nodes\[\d+\]\.oneLine$/)]);
  expect(f.feature().currentVersion).toBe(2);
  rewrite(f, "v3", "extra");
  expect(f.feature().currentVersion).toBe(3);
});
