import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advanceSharedLedgerImport, importScrubContext, prepareSharedLedgerImport } from "../scripts/shared-ledger-import.js";
import { canonicalJson } from "../src/lib/ask-bind.js";
import { SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";
import { fakeConnection, fakeKey } from "./shared-ledger-client.test.js";
import { fitLedger, gitRepo } from "./shared-ledger-export-fit.test.js";

const SPAWN_MS = 30_000;
const GENERIC = "Migration stopped; retain local gate and inspect the local journal before recovery.";
const identity = { username: "local-user", hostname: "local-host" }; // 本机身份

test("prepare and commit use the same scrub context: the commit-time client carries the verified head", async () => {
  const g = gitRepo();
  const f = await fitLedger({ head: g.head, gated: false });
  try {
    const before = await importScrubContext(f.db, f.options, f.dir, identity, g.repo);
    expect([...before.commits!]).toEqual([g.head]);
    const prepared = await prepareSharedLedgerImport(f.db, { ...f.options, scrub: before });
    expect(prepared.payload.manifest.features[0]!.projection.tasks[0]!.head).toBe(g.head);

    // commit 时同一个函数再算一次（此时还会读到已审 payload 里的 head），客户端带着它上传
    const scrub = await importScrubContext(f.db, f.options, f.dir, identity, g.repo);
    expect([...scrub.commits!]).toEqual([g.head]);
    const posted: unknown[] = [];
    const fetcher = (async (url, init) => {
      if (init?.method === "GET") return Response.json({ status: "unknown", batchId: f.options.batchId });
      posted.push(JSON.parse(init!.body as string).payload);
      return new Response("local test stop", { status: 500 });
    }) as typeof fetch;
    const connection = { ...fakeConnection, instanceId: f.options.sourceInstanceId };
    const client = new SharedLedgerClient(connection, fakeKey(), { fetch: fetcher, attempts: 1, scrub });
    await expect(advanceSharedLedgerImport(f.db, f.dir, f.options.batchId, client, prepared.payload.manifestDigest, "commit")).rejects.toThrow();
    expect(posted.length).toBe(1);
    expect(JSON.stringify(posted[0])).toContain(g.head);

    // 不带 commits 的客户端在上传前就被脱敏闸拦下，不会发请求
    posted.length = 0;
    const bare = new SharedLedgerClient(connection, fakeKey(), { fetch: fetcher, attempts: 1, scrub: { identity } });
    await expect(advanceSharedLedgerImport(f.db, f.dir, f.options.batchId, bare, prepared.payload.manifestDigest, "commit")).rejects.toThrow("tasks[0].head");
    expect(posted.length).toBe(0);
  } finally { f.close(); g.close(); }
});

test("a gating journal written with the old selection digest continues under the new scrub context", async () => {
  const g = gitRepo();
  const f = await fitLedger({ head: g.head, reason: "规划说明。".repeat(900) });
  try {
    // 旧代码的算法：options 去掉 scrub 后的 canonicalJson
    const selectionDigest = createHash("sha256").update(canonicalJson({ ...f.options, scrub: undefined })).digest("hex");
    const dir = join(f.dir, "shared-ledger-migrations");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${f.options.batchId}.json`), JSON.stringify({ schemaVersion: 1, selectionDigest,
      featureIds: f.options.featureIds, backup: join(dir, "old.backup.sqlite"), phase: "gating" }), { mode: 0o600 });
    const scrub = await importScrubContext(f.db, f.options, f.dir, identity, g.repo);
    const out = await prepareSharedLedgerImport(f.db, { ...f.options, scrub });
    expect(out.payload.manifest.features[0]!.versions[0]!.reason.length).toBeLessThanOrEqual(2000);
    expect(out.payload.manifest.features[0]!.projection.tasks[0]!.head).toBe(g.head);
  } finally { f.close(); g.close(); }
});

/** 本机：用临时状态目录跑脚本入口 */
function runScript(dir: string, plan: object, ...args: string[]) {
  const planPath = join(dir, "local-plan.json");
  writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 });
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "scripts", "shared-ledger-import.ts"), args[0]!, planPath, ...args.slice(1)], {
    env: { ...process.env, CLAUDESTRA_STATE_DIR: dir }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stderr: p.stderr.toString(), stdout: p.stdout.toString() };
}
const planOf = (o: Awaited<ReturnType<typeof fitLedger>>["options"]) => ({ centerId: "center-a", teamId: "team-a", localProject: o.localProject,
  projectId: o.projectId, sourceInstanceId: o.sourceInstanceId, featureIds: o.featureIds, batchId: o.batchId, summaries: {} });

test("the script's prepare lets through a head that is a commit of the install repo", async () => {
  const head = Bun.spawnSync(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
  const f = await fitLedger({ gated: false, head, reason: "规划说明。".repeat(900) });
  try {
    f.db.close();
    const r = runScript(f.dir, planOf(f.options), "prepare");
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(head);
    expect(r.stdout).toContain("Review manifestDigest:");
  } finally { f.close(); }
}, SPAWN_MS);

test("a remaining contract misfit prints the fixed text with a path, not the generic line or field content", async () => {
  const f = await fitLedger({ key: "bad key!", gated: false });
  try {
    f.db.close();
    const r = runScript(f.dir, planOf(f.options), "prepare");
    expect(r.code).toBe(1);
    expect(r.stderr.trim()).toBe("export does not fit the shared-ledger contract at $.manifest.features[0].versions[0].nodes[0]");
    expect(r.stderr).not.toContain(GENERIC);
    expect(r.stderr).not.toContain("bad key");
  } finally { f.close(); }
}, SPAWN_MS);
