import { expect, spyOn, test } from "bun:test";
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
import { mergeFeatureDeps, TooManyFeatureDeps } from "../src/lib/feature-deps-sync-edges.js";

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
  return { dir, db, fs, entries, uploads, pass, policy, group, state, dep,
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

test("[验收线 1] home mirrors all off: on clears once with an empty upload then forgets the group", async () => {
  const w = await world("on");
  try {
    await w.pass(); expect(w.uploads).toHaveLength(1);
    for (const [, e] of w.entries) e.enabled = false;
    w.advance(1000); await w.pass([]);
    expect(w.uploads).toHaveLength(2); expect(w.uploads[1]).toEqual({ schemaVersion: 1, teamId: "team-a", sourceInstanceId: "home-a", edges: [] });
    expect(w.state().groups).toEqual({});
    w.advance(6 * 3600_000); await w.pass([]); expect(w.uploads).toHaveLength(2);
  } finally { w.close(); }
});
test("[验收线 1] home mirrors all off under observe: no upload, the clear is recorded once", async () => {
  const w = await world("on");
  try {
    await w.pass(); w.policy("observe");
    for (const [, e] of w.entries) e.enabled = false;
    w.advance(1000); await w.pass([]);
    const at = w.group().clearObservedAt;
    expect(at).toBeGreaterThan(0); expect(w.uploads).toHaveLength(1);
    w.advance(6 * 3600_000); await w.pass([]);
    expect(w.group().clearObservedAt).toBe(at); expect(w.uploads).toHaveLength(1);
    w.policy("off"); const before = readFileSync(join(w.dir, "feature-deps-sync.json"), "utf8");
    w.advance(1000); await w.pass([]); expect(readFileSync(join(w.dir, "feature-deps-sync.json"), "utf8")).toBe(before);
  } finally { w.close(); }
});
test("[验收线 2] a group merely missing from live (not due or truncated) is neither cleared nor sent empty", async () => {
  const w = await world("on");
  try {
    await w.pass(); expect(w.uploads).toHaveLength(1);
    const other: [string, MirrorEntry] = ["other-team-feature", { ...w.entries[0]![1], teamId: "team-b", sourceInstanceId: "other-home" }];
    w.advance(6 * 3600_000); await w.pass([]); await w.pass([other]);
    expect(w.uploads).toHaveLength(1); expect(Object.keys(w.state().groups)).toHaveLength(1);
    expect(w.group().clearObservedAt).toBeUndefined();
  } finally { w.close(); }
});
test("[验收线 3] two local features on one center feature merge into one edge and upload", async () => {
  const w = await world("on");
  try {
    const [a, b, , d] = w.fs as [string, string, string, string];
    w.entries.push([d, { ...w.entries[0]![1], centerFeatureId: "center-feature-0" }]);
    w.dep(d, b, "second local edge onto the same center pair");
    w.db.prepare("UPDATE features SET status='done' WHERE id=?").run(d);
    await w.pass();
    expect(w.uploads).toHaveLength(1); expect(w.group().failures).toBe(0);
    const merged = w.uploads[0]!.edges.filter((e) => e.from === "center-feature-0" && e.to === "center-feature-1" && e.kind === "declared");
    expect(merged).toEqual([{ projectId: "shared-project", from: "center-feature-0", to: "center-feature-1", kind: "declared", satisfied: false, count: 2 }]);
    expect(a).not.toBe(d);
  } finally { w.close(); }
});
test("[验收线 3] merge sums counts, satisfied only when all are, drops self loops; over the cap throws a skip", () => {
  const e = (satisfied: boolean, count = 1, to = "y") => ({ projectId: "p", from: "x", to, kind: "task" as const, satisfied, count });
  expect(mergeFeatureDeps([e(true, 2), e(true, 3)])).toEqual([e(true, 5)]);
  expect(mergeFeatureDeps([e(true), e(false)])).toEqual([e(false, 2)]);
  expect(mergeFeatureDeps([e(true, 1, "x")])).toEqual([]);
  const many = Array.from({ length: 2001 }, (_, i) => e(true, 1, `y${i}`));
  expect(mergeFeatureDeps(many.slice(0, 2000))).toHaveLength(2000);
  expect(() => mergeFeatureDeps(many)).toThrow(TooManyFeatureDeps);
});
test("[验收线 3] more than 2000 merged edges: no upload, too_many_edges recorded, no backoff, no upload-failure log", async () => {
  const w = await world("on"), warn = spyOn(console, "warn");
  try {
    const extra = Array.from({ length: 65 }, (_, i) => createFeature(w.db, { actor: "owner", now: 1 }, { project: "p", slug: `bulk-${i}`, title: `bulk-${i}` }).row.id);
    extra.forEach((id, i) => w.entries.push([id, { ...w.entries[0]![1], centerFeatureId: `bulk-${i}` }]));
    // Acyclic on purpose (i < j): 65 * 64 / 2 = 2080 declared edges, the board rejects cycles.
    extra.forEach((from, i) => extra.slice(i + 1).forEach((to) => w.dep(from, to, "bulk")));
    await w.pass();
    expect(w.uploads).toHaveLength(0);
    expect(w.group().skipped).toBe("too_many_edges"); expect(w.group().skippedEdges).toBeGreaterThan(2000);
    expect(w.group().failures).toBe(0); expect(w.group().nextAttemptAt).toBe(0);
    const logs = warn.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes("上传失败"))).toBe(false); expect(logs.filter((l) => l.includes("超过上限"))).toHaveLength(1);
    w.advance(300_000); await w.pass(); expect(warn.mock.calls.filter((c) => String(c[0]).includes("超过上限"))).toHaveLength(1);
  } finally { warn.mockRestore(); w.close(); }
});
test("[验收线 4] observe compute errors keep failures and backoff untouched; on still backs off", async () => {
  const w = await world("observe");
  try {
    // Stands in for a ledger read failure inside compute (the board itself tolerates missing tables).
    spyOn(w.db, "transaction").mockImplementation(() => { throw new Error("ledger read failed"); });
    await w.pass(); expect(w.group().failures).toBe(0); expect(w.group().nextAttemptAt).toBe(0);
    w.policy("on"); w.advance(300_000); await w.pass();
    expect(w.group().failures).toBe(1); expect(w.group().nextAttemptAt).toBeGreaterThan(0); expect(w.uploads).toHaveLength(0);
  } finally { w.close(); }
});
// Exact pre-TEAMDEPS1c serialized group: coverage must come from the (disabled) registry entries.
const legacy = { hash: null, scopeHash: null, lastSentAt: 123, lastComputedAt: 123, unsupportedUntil: 0, cooldown: 0, failures: 0, nextAttemptAt: 0, wouldSend: null };
test("[验收线 1] state written before this change (no projects / centerProjects) still clears from the complete registry", async () => {
  for (const mode of ["on", "observe"] as const) {
    const w = await world(mode);
    try {
      writeFileSync(join(w.dir, "feature-deps-sync.json"), JSON.stringify({ schemaVersion: 1,
        groups: { [JSON.stringify(["center-a", "team-a", "home-a"])]: legacy }, notedDays: {}, cooldowns: {} }));
      for (const [, e] of w.entries) e.enabled = false;
      await w.pass([]);
      if (mode === "on") { expect(w.uploads).toEqual([{ schemaVersion: 1, teamId: "team-a", sourceInstanceId: "home-a", edges: [] }]); expect(w.state().groups).toEqual({}); }
      else { expect(w.uploads).toHaveLength(0); expect(w.group().clearObservedAt).toBeGreaterThan(0); }
    } finally { w.close(); }
  }
});
test("[验收线 1] legacy state with no registry entry left for the team stays put (coverage unknown, fail closed)", async () => {
  const w = await world("on");
  try {
    writeFileSync(join(w.dir, "feature-deps-sync.json"), JSON.stringify({ schemaVersion: 1,
      groups: { [JSON.stringify(["center-a", "team-gone", "home-a"])]: legacy }, notedDays: {}, cooldowns: {} }));
    await w.pass(); w.uploads.length = 0;
    w.advance(1000); await w.pass([]);
    expect(w.uploads).toHaveLength(0); expect(w.state().groups[JSON.stringify(["center-a", "team-gone", "home-a"])].failures).toBe(0);
  } finally { w.close(); }
});
