import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { SPLIT_NOTE } from "../src/lib/ledger-product-board-edges.js";
import { productBoard } from "../src/lib/ledger-product-board.js";
import { syncFeatureDeps, featureDepsMode } from "../src/lib/feature-deps-sync.js";
import type { MirrorEntry } from "../src/lib/shared-ledger-projector.js";
import type { FeatureDepsUpload } from "../src/lib/shared-ledger-contract-feature-deps.js";
import { SharedLedgerRemoteError } from "../src/lib/shared-ledger-client.js";
import { serviceCredential } from "./shared-ledger-mirror-fixture.test.js";

async function world(mode: "off" | "observe" | "on" = "observe") {
  const dir = mkdtempSync(join(tmpdir(), "feature-deps-")), db = openLedger(":memory:"), ctx = { actor: "owner", now: 1 };
  writeFileSync(join(dir, "instance-id"), "home-a");
  await serviceCredential(dir);
  const fs = ["a", "b", "c", "not-mirrored"].map((slug) => createFeature(db, ctx, { project: "p", slug, title: slug }).row.id);
  const [a, b, c, d] = fs as [string, string, string, string];
  const dep = (from: string, to: string, note: string) => db.prepare(
    "INSERT INTO feature_deps (project,fromFeature,toFeature,note,createdBy,createdAt) VALUES ('p',?,?,?,'owner',1)").run(from, to, note);
  dep(a, b, "note repo:org/x confidential"); dep(b, c, SPLIT_NOTE); dep(d, c, "must disappear");
  for (const [id, f] of [["private-card-a", a], ["private-card-b", b]]) {
    createTask(db, ctx, { project: "p", id: id!, title: "card", kind: "code", stage: "spec" });
    db.prepare("UPDATE tasks SET featureId=? WHERE id=?").run(f!, id!);
  }
  db.prepare("INSERT INTO task_deps (project,fromTask,toTask,kind,createdBy,createdAt,updatedAt) VALUES ('p','private-card-a','private-card-b','blocks','owner',1,1)").run();
  initDag(db, ctx, { id: c, rev: 1, nodes: [{ key: "waiting", oneLine: "work", deps: [], estimate: "S", fileGlobs: ["repo:org/x/**"] }] });
  db.prepare(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,taskRev,specRev,templateVersion,status,reason,createdAt,updatedAt)
    VALUES ('intent-a','private-card-a','p','build','dispatch',1,1,1,1,'submitted','work',1,1)`).run();
  db.prepare(`INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt,scope)
    VALUES ('p','repo:org/x/**','private-card-a','intent-a',1,'card')`).run();
  const entries: [string, MirrorEntry][] = fs.slice(0, 3).map((id, i) => [id, {
    enabled: true, batchId: "batch-a", centerId: "center-a", teamId: "team-a", projectId: "shared-project", centerFeatureId: `center-feature-${i}`,
    sourceInstanceId: "home-a", localProject: "p", watermark: 0, snapshot: false, fingerprints: {}, taskMeta: {},
    lastPushAt: null, lastPushSeq: null, lastError: null, lastErrorAt: null, failures: 0, nextAttemptAt: 0,
  }]);
  const policy = (m: "off" | "observe" | "on") => writeFileSync(join(dir, "recovery-policy.json"), JSON.stringify({ projects: { p: { keys: { featureDeps: m } } } }));
  policy(mode);
  let now = 1_790_000_000_000, failure: Error | null = null;
  const uploads: FeatureDepsUpload[] = [];
  const pass = (live = entries, sleep?: (ms: number) => Promise<void>) => syncFeatureDeps(db, live, { stateDir: dir,
    now: () => now, requestGapMs: 0, sleep, mirrors: () => entries, client: () => ({ async uploadFeatureDeps(body) {
      if (failure) throw failure;
      uploads.push(structuredClone(body)); return { schemaVersion: 1, accepted: body.edges.length };
    } }) });
  const state = () => JSON.parse(readFileSync(join(dir, "feature-deps-sync.json"), "utf8"));
  const group = () => Object.values(state().groups)[0] as any;
  return { dir, db, fs, entries, uploads, pass, policy, group, state,
    advance: (ms: number) => { now += ms; }, fail: (e: Error | null) => { failure = e; },
    close: () => { closeLedger(":memory:"); rmSync(dir, { recursive: true, force: true }); } };
}

test("[验收线 2] observe strips notes, task evidence and locks; uses full mirrors when live is a slice", async () => {
  const w = await world();
  try {
    expect(productBoard(w.db, "p", 1).links.some((e) => e.kind === "lock")).toBe(true);
    const before = JSON.stringify(w.entries);
    await w.pass(w.entries.slice(0, 1));
    const body = w.group().wouldSend;
    expect(body.edges.map((e: any) => e.kind).sort()).toEqual(["declared", "split", "task"]);
    expect(body.edges.every((e: any) => e.from.startsWith("center-feature-") && e.to.startsWith("center-feature-"))).toBe(true);
    for (const hidden of ["repo:", "note", "evidence", "private-card", "confidential", w.fs[3]!]) expect(JSON.stringify(body)).not.toContain(hidden);
    expect(w.uploads).toHaveLength(0);
    expect(JSON.stringify(w.entries)).toBe(before);
  } finally { w.close(); }
});
test("[验收线 2] on sends once, throttles computation, refreshes after six hours and clears with empty replacement", async () => {
  const w = await world("on");
  try {
    await w.pass(); expect(w.uploads).toHaveLength(1);
    const computed = w.group().lastComputedAt;
    w.advance(10_000); await w.pass(); expect(w.uploads).toHaveLength(1); expect(w.group().lastComputedAt).toBe(computed);
    w.advance(6 * 3600_000); await w.pass(); expect(w.uploads).toHaveLength(2);
    w.db.run("DELETE FROM feature_deps"); w.db.run("DELETE FROM task_deps");
    w.advance(300_000); await w.pass(); expect(w.uploads[2]!.edges).toEqual([]);
    w.advance(300_000); await w.pass(); expect(w.uploads).toHaveLength(3);
  } finally { w.close(); }
});
test("[验收线 2] off does no computation or recording; policy defaults observe and corrupt policy stops", async () => {
  const w = await world("off");
  try {
    await w.pass(); expect(existsSync(join(w.dir, "feature-deps-sync.json"))).toBe(false);
    expect(featureDepsMode("missing", join(w.dir, "recovery-policy.json"))).toBe("observe");
    writeFileSync(join(w.dir, "recovery-policy.json"), "broken"); await w.pass();
    expect(existsSync(join(w.dir, "feature-deps-sync.json"))).toBe(false);
  } finally { w.close(); }
});
for (const status of [403, 404]) test(`[验收线 2] ${status} is unsupported for six hours without a failure`, async () => {
  const w = await world("on");
  try {
    w.fail(new SharedLedgerRemoteError(status, null)); await w.pass();
    expect(w.group().unsupportedUntil - w.group().lastComputedAt).toBe(6 * 3600_000);
    expect(w.group().failures).toBe(0); expect(w.state().notedDays).toEqual({ "center-a": Math.floor(w.group().lastComputedAt / 86400_000) });
    w.fail(null); w.advance(300_000); await w.pass(); expect(w.uploads).toHaveLength(0);
    w.advance(6 * 3600_000); await w.pass(); expect(w.uploads).toHaveLength(1);
  } finally { w.close(); }
});
test("[验收线 2] 429 caps cooldown like body sync and stops this pass; other failures back off independently", async () => {
  const w = await world("on");
  try {
    w.fail(new SharedLedgerRemoteError(429, null, 90_000)); await w.pass();
    expect(w.group().cooldown - w.group().lastComputedAt).toBe(60_000); expect(w.group().failures).toBe(0);
    w.fail(null); w.advance(59_000); await w.pass(); expect(w.uploads).toHaveLength(0);
    w.advance(1000); await w.pass(); expect(w.uploads).toHaveLength(1);
    w.advance(6 * 3600_000); w.fail(new Error("secret failure text")); await w.pass();
    expect(w.group().failures).toBe(1); expect(JSON.stringify(w.state())).not.toContain("secret failure text");
  } finally { w.close(); }
});
test("[验收线 2] changed mirror scope cannot send a stale cache, foreign-home targets and cross-project endpoints disappear", async () => {
  const w = await world("on");
  try {
    w.entries[1]![1].sourceInstanceId = "other-home";
    w.entries[2]![1].projectId = "other-project";
    await w.pass(); expect(w.uploads[0]!.edges).toEqual([]);
    w.entries[1]![1].sourceInstanceId = "home-a"; w.entries[2]![1].projectId = "shared-project";
    w.advance(1000); await w.pass(); expect(w.uploads).toHaveLength(1);
    w.advance(300_000); await w.pass(); expect(w.uploads[1]!.edges).toHaveLength(3);
  } finally { w.close(); }
});

test("[验收线 2] mixed project switches observe or pause the whole replacement; switch off during pacing stops send", async () => {
  const w = await world("on");
  try {
    w.entries.push(["feature-other-project", { ...w.entries[0]![1], localProject: "q", centerFeatureId: "center-other" }]);
    const policy = (q: string) => writeFileSync(join(w.dir, "recovery-policy.json"), JSON.stringify({ projects: {
      p: { keys: { featureDeps: "on" } }, q: { keys: { featureDeps: q } },
    } }));
    policy("observe"); await w.pass(); expect(w.uploads).toHaveLength(0); expect(w.group().wouldSend.edges).toHaveLength(3);
    policy("off"); const before = readFileSync(join(w.dir, "feature-deps-sync.json"), "utf8");
    w.advance(300_000); await w.pass(); expect(readFileSync(join(w.dir, "feature-deps-sync.json"), "utf8")).toBe(before);
    policy("on"); await w.pass(w.entries, async () => { policy("off"); }); expect(w.uploads).toHaveLength(0);
  } finally { w.close(); }
});
test("[验收线 2] center cooldown also blocks another team on the next pass", async () => {
  const w = await world("on");
  try {
    for (const [id, entry] of [...w.entries]) w.entries.push([id, { ...entry, teamId: "team-b" }]);
    w.fail(new SharedLedgerRemoteError(429, null, 60_000)); await w.pass();
    expect(Object.keys(w.state().groups)).toHaveLength(1);
    w.fail(null); w.advance(10_000); await w.pass(); expect(w.uploads).toHaveLength(0);
    expect(Object.values(w.state().groups).every((g: any) => g.failures === 0)).toBe(true);
  } finally { w.close(); }
});
test("[验收线 2] corrupt state is preserved and isolated from mirror projection work", async () => {
  const w = await world("on");
  try {
    const path = join(w.dir, "feature-deps-sync.json"); writeFileSync(path, "broken");
    await w.pass(); expect(w.uploads).toHaveLength(0); expect(readFileSync(path, "utf8")).toBe("broken");
  } finally { w.close(); }
});
