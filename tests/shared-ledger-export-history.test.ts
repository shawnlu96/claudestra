import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationErrorText, prepareSharedLedgerImport } from "../scripts/shared-ledger-import.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import {
  HISTORY_ONE_LINE, HISTORY_REASON, previewSharedLedgerExport, SharedLedgerExportBlockedError, SharedLedgerExportContractError,
} from "../src/lib/shared-ledger-export.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { SharedLedgerScrubError } from "../src/lib/shared-ledger-scrub.js";

const identity = { username: "local-user", hostname: "local-host" }; // 本机身份
const SPEC = "~/.claude-orchestrator/specs/plan.md"; // 本机规格路径
type Node = { key: string; oneLine: string; deps?: string[]; fileGlobs?: string[]; taskId?: string | null };
interface Version { reason: string; nodes: Node[] }

/** 本机：临时台账，一个 feature、多版 DAG（最后一版是当前版本）、一张卡 */
async function historyLedger(versions: Version[], extra: { title?: string; events?: number; gated?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shared-ledger-history-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const project = "local-project", featureId = "hist-plan";
  createTask(db, { actor: "owner", now: 1000 }, { project, id: "hist-card", title: "Card", kind: "code" });
  db.prepare("INSERT INTO features (id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,'active',?,1,'owner',1000,1000)")
    .run(featureId, project, extra.title ?? "Team plan", "Shared description", versions.length);
  for (const [i, v] of versions.entries()) {
    db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES (?,?,?,?,'owner',1000,?)")
      .run(featureId, i + 1, i ? "new_issue" : "initial", v.reason, JSON.stringify(v.nodes.map((n) => ({ key: n.key, taskId: n.taskId ?? null,
        oneLine: n.oneLine, deps: n.deps ?? [], fileGlobs: n.fileGlobs ?? [], estimate: "1h" }))));
  }
  for (let i = 0; i < (extra.events ?? 0); i++) {
    db.prepare("INSERT INTO events(ts,actor,project,target,kind,text,data,dedupKey) VALUES (?,'owner',?,'hist-card','note','','{}',?)")
      .run(2000 + i, project, `note-${i}`);
  }
  if (extra.gated !== false) await writeSharedLedgerMode(featureId, { authorityMode: "source", sharedPlanning: true }, dir);
  const options = { localProject: project, projectId: "shared-project", sourceInstanceId: "peer-a", featureIds: [featureId], batchId: "batch-a",
    stateDir: dir, summaries: {}, scrub: { identity, knownSecrets: ["known-private-value"] } };
  return { dir, db, options, close() { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}
const caught = (run: () => unknown): Error => {
  try { run(); } catch (error) { return error as Error; }
  throw new Error("expected a refusal");
};

test("past DAG reasons with a local path upload as the fixed placeholder, and the whole package passes the gate", async () => {
  const f = await historyLedger([
    { reason: `初版,见 ${SPEC}`, nodes: [{ key: "build", oneLine: "Build" }] },
    { reason: `改图:规格在 /Users/someone/spec.md`, nodes: [{ key: "build", oneLine: "Build" }] },
    { reason: "Current plan", nodes: [{ key: "build", oneLine: "Build" }] },
  ]);
  try {
    const out = previewSharedLedgerExport(f.db, f.options);
    expect(out.payload.manifest.features[0]!.versions.map((v) => v.reason)).toEqual([HISTORY_REASON, HISTORY_REASON, "Current plan"]);
    expect(out.preview).not.toContain(".claude-orchestrator");
    expect(out.payload.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    // 本机台账原文不动
    expect((f.db.query("SELECT reasonText FROM dag_versions WHERE version = 1").get() as { reasonText: string }).reasonText).toContain(SPEC);
  } finally { f.close(); }
});

test("a path in the current reason still refuses the whole batch and names its location without the text", async () => {
  const f = await historyLedger([
    { reason: "Plan", nodes: [{ key: "build", oneLine: "Build" }] },
    { reason: `改图,见 ${SPEC}`, nodes: [{ key: "build", oneLine: "Build" }] },
  ]);
  try {
    const error = caught(() => previewSharedLedgerExport(f.db, f.options));
    expect(error).toBeInstanceOf(SharedLedgerScrubError);
    expect((error as SharedLedgerScrubError).fields).toEqual(["$.manifest.features[0].versions[1].reason"]);
    expect(error.message).toContain("feature hist-plan · version 2 (current) · reason · path");
    expect(error.message).not.toContain(".claude-orchestrator");
  } finally { f.close(); }
});

test("a past node oneLine the gate refuses uploads the current same-key text or the placeholder; clean history stays", async () => {
  const f = await historyLedger([
    { reason: "Plan", nodes: [{ key: "build", oneLine: `按 ${SPEC} 做` }, { key: "gone", oneLine: `旧 ${SPEC}` },
      { key: "keep", oneLine: "Old keep text" }] },
    { reason: "Current", nodes: [{ key: "build", oneLine: "Build now" }, { key: "keep", oneLine: "Keep now" }] },
  ]);
  try {
    const [past, current] = previewSharedLedgerExport(f.db, f.options).payload.manifest.features[0]!.versions;
    expect(past!.nodes.map((n) => n.oneLine)).toEqual(["Build now", HISTORY_ONE_LINE, "Old keep text"]);
    expect(current!.nodes.map((n) => n.oneLine)).toEqual(["Build now", "Keep now"]);
  } finally { f.close(); }
});

const kinds: [string, string][] = [
  [`see ${SPEC}`, "path"], ["ask local-user first", "identity"], ["host 10.1.2.3 only", "address"],
  [`token ${"ab".repeat(20)}`, "secret"], ["uses known-private-value", "known-value"],
];
for (const [oneLine, kind] of kinds) {
  test(`a current node oneLine refused as ${kind} names feature, node key and category, never the text`, async () => {
    const f = await historyLedger([{ reason: "Plan", nodes: [{ key: "build", oneLine: "Build" }, { key: "ship", oneLine }] }]);
    try {
      const error = caught(() => previewSharedLedgerExport(f.db, f.options));
      expect(error).toBeInstanceOf(SharedLedgerExportBlockedError);
      expect((error as SharedLedgerScrubError).fields).toEqual(["$.manifest.features[0].versions[0].nodes[1].oneLine"]);
      expect(error.message).toContain(`feature hist-plan · version 1 (current) · node ship · oneLine · ${kind} (rewrite_dag`);
      expect(error.message).not.toContain(oneLine);
      // prepare 打印的就是这条定位
      expect(migrationErrorText(error)).toBe(error.message);
    } finally { f.close(); }
  });
}

test("prepare reports the node locator and a rerun after the text is rewritten produces a digest", async () => {
  const f = await historyLedger([{ reason: "Plan", nodes: [{ key: "ship", oneLine: `see ${SPEC}` }] }], { gated: false });
  try {
    const persistent = { ...f.options, stateDir: f.dir };
    const error = await prepareSharedLedgerImport(f.db, persistent).then(() => null, (e: Error) => e);
    expect(migrationErrorText(error)).toContain("feature hist-plan · version 1 (current) · node ship · oneLine · path");
    // PM 用 rewrite_dag 改写这条 oneLine:新增当前版本,旧版本里的同 key 文本随之改传当前文本
    f.db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES ('hist-plan',2,'new_issue','Rewrite','owner',1001,?)")
      .run(JSON.stringify([{ key: "ship", taskId: null, oneLine: "Ship it", deps: [], fileGlobs: [], estimate: "1h" }]));
    f.db.prepare("UPDATE features SET currentVersion = 2, rev = 2").run();
    const out = await prepareSharedLedgerImport(f.db, persistent);
    expect(out.payload.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(out.payload.manifest.features[0]!.versions.map((v) => v.nodes[0]!.oneLine)).toEqual(["Ship it", "Ship it"]);
  } finally { f.close(); }
});

test("a node key bound twice reports the binding path, not just the feature", async () => {
  const f = await historyLedger([{ reason: "Plan", nodes: [{ key: "a", oneLine: "A", taskId: "hist-card" }, { key: "b", oneLine: "B", taskId: "hist-card" }] }]);
  try {
    const error = caught(() => previewSharedLedgerExport(f.db, f.options));
    expect(error).toBeInstanceOf(SharedLedgerExportContractError);
    expect((error as SharedLedgerExportContractError).field).toBe("$.manifest.features[0].versions[0].bindings[1]");
  } finally { f.close(); }
});

test("a dependency on a missing node and an empty title report their field paths", async () => {
  const f = await historyLedger([{ reason: "Plan", nodes: [{ key: "a", oneLine: "A" }, { key: "b", oneLine: "B", deps: ["ghost"] }] }]);
  try {
    expect((caught(() => previewSharedLedgerExport(f.db, f.options)) as SharedLedgerExportContractError).field)
      .toBe("$.manifest.features[0].versions[0].nodes[1].deps");
  } finally { f.close(); }
  const g = await historyLedger([{ reason: "Plan", nodes: [{ key: "a", oneLine: "A" }] }], { title: "" });
  try {
    expect((caught(() => previewSharedLedgerExport(g.db, g.options)) as SharedLedgerExportContractError).field)
      .toBe("$.manifest.features[0].title");
  } finally { g.close(); }
});

test("events past the contract count upload only the newest ones and the package fits", async () => {
  const f = await historyLedger([{ reason: "Plan", nodes: [{ key: "a", oneLine: "A", taskId: "hist-card" }] }], { events: 1200 });
  try {
    const out = previewSharedLedgerExport(f.db, f.options);
    const events = out.payload.manifest.features[0]!.projection.events;
    expect(events.length).toBe(1000);
    expect(events.at(-1)!.sourceSeq).toBe(out.payload.manifest.sourceSeq);
    expect((f.db.query("SELECT COUNT(*) AS n FROM events WHERE target = 'hist-card'").get() as { n: number }).n).toBeGreaterThan(1200);
  } finally { f.close(); }
});
