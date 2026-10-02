import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import {
  fitSharedLedgerText, previewSharedLedgerExport, sharedLedgerExportHeads, sharedLedgerExportLimits, sharedLedgerScrubWithCommits,
  SharedLedgerExportContractError,
} from "../src/lib/shared-ledger-export.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { SharedLedgerScrubError } from "../src/lib/shared-ledger-scrub.js";

const MARKER = /\.\.\.\(已截断,原文 \d+ 字\)$/;
const identity = { username: "local-user", hostname: "local-host" }; // 本机身份
export interface FitFields { reason?: string; oneLine?: string; estimate?: string; title?: string; description?: string; key?: string; head?: string; gated?: boolean }

/** 本机：临时状态目录 + 临时台账，一个 feature、一版 DAG、一张绑定的卡 */
export async function fitLedger(fields: FitFields = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shared-ledger-fit-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const project = "local-project", featureId = "fit-plan", key = fields.key ?? "build";
  createTask(db, { actor: "owner", now: 1000 }, { project, id: "fit-card", title: "Card", kind: "code" });
  if (fields.head) db.prepare("UPDATE tasks SET headSHA = ? WHERE id = ?").run(fields.head, "fit-card");
  db.prepare("INSERT INTO features (id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,'active',1,1,'owner',1000,1000)")
    .run(featureId, project, fields.title ?? "Team plan", fields.description ?? "Shared description");
  db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES (?,1,'initial',?,'owner',1000,?)")
    .run(featureId, fields.reason ?? "Plan", JSON.stringify([{ key, taskId: null, oneLine: fields.oneLine ?? "Build", deps: [], fileGlobs: [], estimate: fields.estimate ?? "1h" }]));
  db.prepare("INSERT INTO dag_bindings (featureId,version,nodeKey,taskId,boundBy,boundAt) VALUES (?,1,?,'fit-card','owner',1000)").run(featureId, key);
  if (fields.gated !== false) await writeSharedLedgerMode(featureId, { authorityMode: "source", sharedPlanning: true }, dir);
  const options = { localProject: project, projectId: "shared-project", sourceInstanceId: "peer-a", featureIds: [featureId], batchId: "batch-a",
    stateDir: dir, summaries: {}, scrub: { identity } };
  return { dir, path, db, options, close() { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}

/** 本机临时 git 仓库，带一个提交 */
export function gitRepo() {
  const repo = mkdtempSync(join(tmpdir(), "shared-ledger-fit-repo-"));
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.name=local", "-c", "user.email=local@example.invalid", ...args],
    { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  return { repo, head: git("rev-parse", "HEAD"), close: () => rmSync(repo, { recursive: true, force: true }) };
}
const prose = (n: number) => "规划说明。".repeat(Math.ceil(n / 5)).slice(0, n);

test("limits come from the contract schema", () => {
  expect(sharedLedgerExportLimits()).toEqual({ reason: 2000, title: 300, description: 16000, oneLine: 2000, estimate: 200 });
  expect(fitSharedLedgerText("short", 10)).toBe("short");
  const cut = fitSharedLedgerText(prose(4500), 2000);
  expect(cut.length).toBe(2000);
  expect(cut).toMatch(/\.\.\.\(已截断,原文 4500 字\)$/);
  // 不把代理对切成半个字符
  expect(fitSharedLedgerText("😀".repeat(100), 51)).not.toMatch(/[\uD800-\uDBFF]\.\.\./);
});

test("a 4500-char DAG reason previews, uploads at most 2000 chars with the marker, and leaves the local ledger as is", async () => {
  const f = await fitLedger({ reason: prose(4500) });
  try {
    const before = f.db.query("SELECT reasonText FROM dag_versions").get() as { reasonText: string };
    const a = previewSharedLedgerExport(f.db, f.options), b = previewSharedLedgerExport(f.db, f.options);
    const reason = a.payload.manifest.features[0]!.versions[0]!.reason;
    expect(reason.length).toBeLessThanOrEqual(2000);
    expect(reason).toMatch(/\.\.\.\(已截断,原文 4500 字\)$/);
    expect(reason.startsWith(prose(100))).toBe(true);
    expect(f.db.query("SELECT reasonText FROM dag_versions").get()).toEqual(before);
    expect(before.reasonText.length).toBe(4500);
    expect(a.payload.manifestDigest).toBe(b.payload.manifestDigest);
    expect(a.preview).toBe(b.preview);
  } finally { f.close(); }
});

const cases: [keyof FitFields, number, (m: ReturnType<typeof previewSharedLedgerExport>["payload"]["manifest"]) => string][] = [
  ["oneLine", 2000, (m) => m.features[0]!.versions[0]!.nodes[0]!.oneLine],
  ["estimate", 200, (m) => m.features[0]!.versions[0]!.nodes[0]!.estimate],
  ["title", 300, (m) => m.features[0]!.title],
  ["description", 16000, (m) => m.features[0]!.description],
];
for (const [field, max, pick] of cases) {
  test(`an over-long ${field} is cut to the contract limit with the marker`, async () => {
    const f = await fitLedger({ [field]: prose(max + 50) });
    try {
      const value = pick(previewSharedLedgerExport(f.db, f.options).payload.manifest);
      expect(value.length).toBeLessThanOrEqual(max);
      expect(value).toMatch(MARKER);
      expect(value).toContain(`原文 ${max + 50} 字`);
    } finally { f.close(); }
  });
}

test("a head that is a commit in the repo uploads verbatim; unknown 40-hex stays blocked at tasks[i].head", async () => {
  const g = gitRepo();
  try {
    const f = await fitLedger({ head: g.head });
    try {
      expect(sharedLedgerExportHeads(f.db, f.options.localProject, f.options.featureIds)).toEqual([g.head]);
      // 只有 identity 时照旧拦下（生产卡点的原样）
      expect(() => previewSharedLedgerExport(f.db, f.options)).toThrow("tasks[0].head");
      const scrub = await sharedLedgerScrubWithCommits({ identity }, sharedLedgerExportHeads(f.db, f.options.localProject, f.options.featureIds), g.repo);
      expect([...scrub.commits!]).toEqual([g.head]);
      const out = previewSharedLedgerExport(f.db, { ...f.options, scrub });
      expect(out.payload.manifest.features[0]!.projection.tasks[0]!.head).toBe(g.head);
    } finally { f.close(); }
    const missing = "deadbeef".repeat(5);
    const f2 = await fitLedger({ head: missing });
    try {
      const scrub = await sharedLedgerScrubWithCommits({ identity }, [missing], g.repo);
      expect(scrub.commits!.size).toBe(0);
      let error: unknown;
      try { previewSharedLedgerExport(f2.db, { ...f2.options, scrub }); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(SharedLedgerScrubError);
      expect((error as SharedLedgerScrubError).fields).toEqual(["$.manifest.features[0].projection.tasks[0].head"]);
    } finally { f2.close(); }
  } finally { g.close(); }
});

test("a remaining contract misfit names the location with fixed text and no field content", async () => {
  const f = await fitLedger({ key: "bad key!" });
  try {
    let error: unknown;
    try { previewSharedLedgerExport(f.db, f.options); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(SharedLedgerExportContractError);
    expect((error as Error).message).toBe("export does not fit the shared-ledger contract at $.manifest.features[0].versions[0].nodes[0]");
    expect((error as Error).message).not.toContain("bad key");
  } finally { f.close(); }
});
