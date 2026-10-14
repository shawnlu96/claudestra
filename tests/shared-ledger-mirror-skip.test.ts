/**
 * team-parity-MIRRORID1：卡号撞外发闸的卡不再卡死整个 feature 的事件镜像（src/lib/shared-ledger-mirror-skip.ts）。
 * 卡号是编造的，形状同 10-14 那张：正好 32 位、含大写小写和数字，被随机串规则判中。
 */
import { expect, test } from "bun:test";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { createTask, moveStage } from "../src/lib/ledger-write.js";
import { observeDedupKey, type RecoveryMode, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import type { SharedLedgerProjection } from "../src/lib/shared-ledger-contract.js";
import { pushSharedLedgerMirror, type MirrorClient, type MirrorEntry } from "../src/lib/shared-ledger-projector.js";
import { scrubSharedLedger, sharedLedgerValueBlocked } from "../src/lib/shared-ledger-scrub.js";
import { MIRROR_SKIP_KEY } from "../src/lib/shared-ledger-mirror-skip.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { mirrorEntry, SCRUB } from "./shared-ledger-mirror-fixture.test.js";

const BLOCKED = "followup-reliability-RECLAIMINT1";
const policy = (mode: RecoveryMode): RecoveryPolicyPort => () => ({ mode, manualAfterMs: null, source: "config" });

function center() {
  const sent: SharedLedgerProjection[] = [];
  const client: MirrorClient = {
    async projection(p) {
      sent.push(structuredClone(p));
      return { schemaVersion: 1, serverSeq: sent.length, sourceInstanceId: p.sourceInstanceId, sourceSeq: p.sourceSeq, digest: "a".repeat(64) };
    },
  };
  return { sent, client };
}

/** 合成 feature：撞闸的卡只绑在旧版本（v1 的 next），当前版本已不绑它；另有两张正常卡，边两头都有它和正常的边。 */
function world() {
  const f = integrationFixture(), ctx = { actor: f.actor };
  createTask(f.db, ctx, { project: f.project, id: BLOCKED, title: "Blocked id", kind: "code" });
  createTask(f.db, ctx, { project: f.project, id: "c5-other", title: "Other card", kind: "code" });
  bindNode(f.db, ctx, { id: f.id, rev: f.feature().rev, key: "next", taskId: BLOCKED });
  f.db.prepare("UPDATE tasks SET featureId = NULL WHERE id = ?").run(BLOCKED); // 只靠旧版本的绑定进推送集合
  f.db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES (?,2,'new_issue','v2','owner',1001,?)")
    .run(f.id, JSON.stringify([{ key: "existing", taskId: "c5-existing", oneLine: "Existing", deps: [], status: "spec", estimate: "", inheritedFrom: null },
      { key: "other", taskId: "c5-other", oneLine: "Other", deps: [], status: "spec", estimate: "", inheritedFrom: null }]));
  f.db.prepare("UPDATE features SET currentVersion = 2 WHERE id = ?").run(f.id);
  addDep(f.db, ctx, { from: BLOCKED, to: "c5-existing", when: "verified" });
  addDep(f.db, ctx, { from: "c5-other", to: BLOCKED, when: "verified" });
  addDep(f.db, ctx, { from: "c5-other", to: "c5-existing", when: "verified" });
  for (const id of [BLOCKED, "c5-existing", "c5-other"]) moveStage(f.db, ctx, { taskId: id, from: "spec", to: "restate" });
  return f;
}
const push = (f: ReturnType<typeof world>, entry: MirrorEntry, client: MirrorClient, mode: RecoveryMode, now = 5_000) =>
  pushSharedLedgerMirror(f.db, f.id, entry, { client, scrub: SCRUB, now, skipPolicy: policy(mode) });
const notes = (f: ReturnType<typeof world>) => f.db.query("SELECT target, data FROM events WHERE dedupKey = ?")
  .all(observeDedupKey({ project: f.project, mechanism: MIRROR_SKIP_KEY, target: BLOCKED, actionKey: `mirror-skip:${f.id}` })) as { target: string; data: string }[];

test("单值判定与 scrub 逐字节一致：卡号字段里判中的值，scrub 整批拒的也正是它", () => {
  const cases = [BLOCKED, BLOCKED.slice(0, 31), BLOCKED.toLowerCase(), "c5-existing", "pj1-host-card", "/Users/x/a", "a".repeat(40)];
  for (const value of cases) {
    let refused = false;
    try { scrubSharedLedger({ events: [{ sourceTaskId: value }] }, (v) => v, SCRUB); } catch { refused = true; }
    expect([value, sharedLedgerValueBlocked(value, SCRUB, "sourceTaskId")]).toEqual([value, refused]);
  }
  expect(sharedLedgerValueBlocked(BLOCKED, SCRUB, "sourceTaskId")).toBe(true);
  expect(sharedLedgerValueBlocked(BLOCKED.slice(0, 31), SCRUB, "sourceTaskId")).toBe(false);
  expect(sharedLedgerValueBlocked("x", { identity: { username: " ", hostname: "h" } })).toBe(true); // 身份缺失，scrub 整批拒
});

test("[验收线 1] on：略过撞闸的卡、它的事件和以它为端点的边，其余照推、水位前进、skippedTasks 列出它", async () => {
  const f = world();
  try {
    const c = center(), entry = mirrorEntry(f, 0, { snapshot: true });
    const r = await push(f, entry, c.client, "on");
    expect(r.outcome).toMatchObject({ kind: "pushed", mode: "snapshot" });
    const sent = c.sent[0]!;
    expect(JSON.stringify(sent)).not.toContain(BLOCKED);
    expect(sent.tasks.map((t) => t.sourceTaskId)).toEqual(["c5-existing", "c5-other"]);
    // c5-existing 的前置原有 c5-other 和撞闸卡：正常的边还在，从撞闸卡来的边没了；指向撞闸卡的边随它一起不出去
    expect(sent.tasks.find((t) => t.sourceTaskId === "c5-existing")!.deps).toEqual(["c5-other"]);
    expect(sent.tasks.find((t) => t.sourceTaskId === "c5-other")!.deps).toEqual([]);
    expect(new Set(sent.events.map((e) => e.sourceTaskId))).toEqual(new Set(["c5-existing", "c5-other"]));
    expect(r.entry).toMatchObject({ watermark: sent.sourceSeq, failures: 0, lastError: null, skippedTasks: [BLOCKED] });
    expect(sent.sourceSeq).toBeGreaterThan(0);
    expect(notes(f)).toHaveLength(1);
    expect(notes(f)[0]!.target).toBe(BLOCKED);
    // 下一轮增量照常前进，撞闸的卡的新事件也不出去
    moveStage(f.db, { actor: f.actor }, { taskId: BLOCKED, from: "restate", to: "build" });
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-other", from: "restate", to: "build" });
    const next = await push(f, r.entry, c.client, "on", 6_000);
    expect(next.outcome).toMatchObject({ kind: "pushed", mode: "delta" });
    expect(JSON.stringify(c.sent[1])).not.toContain(BLOCKED);
    expect(c.sent[1]!.tasks.map((t) => t.sourceTaskId)).toEqual(["c5-other"]);
    expect(notes(f)).toHaveLength(1);
  } finally { await f.close(); }
});

test("[验收线 2] off 整批被拒、错误文本不变；observe 照旧被拒，只多一条去重的观察", async () => {
  const f = world();
  try {
    const c = center(), entry = mirrorEntry(f, 0, { snapshot: true });
    const off = await push(f, entry, c.client, "off");
    expect(off.outcome.kind).toBe("failed");
    expect(off.entry.lastError).toMatch(/^upload blocked at \$\.events\[\d+\]\.sourceTaskId/);
    expect(off.entry).toMatchObject({ watermark: 0, failures: 1 });
    expect(off.entry.skippedTasks).toBeUndefined();
    expect(notes(f)).toHaveLength(0);
    const watch = await push(f, entry, c.client, "observe");
    expect(watch.entry.lastError).toBe(off.entry.lastError);
    expect(watch.entry).toMatchObject({ watermark: 0, failures: 1 });
    expect(notes(f)).toHaveLength(1);
    expect(JSON.parse(notes(f)[0]!.data)).toMatchObject({ mechanism: MIRROR_SKIP_KEY, taskId: BLOCKED, featureId: f.id, mode: "observe" });
    // 观察记在撞闸卡自己的事件流里（off 下同样会被列出）；重推照旧整批被拒，不会再记
    const again = await push(f, entry, c.client, "observe", 9_000);
    expect(again.outcome.kind).toBe("failed");
    expect(again.entry.lastError).toMatch(/^upload blocked at \$\.events\[\d+\]\.sourceTaskId/);
    expect(notes(f)).toHaveLength(1);
    expect(c.sent).toHaveLength(0);
  } finally { await f.close(); }
});

test("[验收线 4] 卡号以外的字段撞闸：on 下照旧整批被拒，不因本卡被略过", async () => {
  const f = world();
  try {
    const c = center();
    const entry = mirrorEntry(f, 0, { snapshot: true, taskMeta: { "c5-other": { specSummary: "见 /Users/someone/notes.md", specDigest: null, assigneeCode: null } } });
    const r = await push(f, entry, c.client, "on");
    expect(r.outcome.kind).toBe("failed");
    expect(r.entry.lastError).toBe("upload blocked at $.tasks[1].specSummary");
    expect(r.entry).toMatchObject({ watermark: 0, failures: 1 });
    expect(r.entry.skippedTasks).toBeUndefined();
    expect(c.sent).toHaveLength(0);
  } finally { await f.close(); }
});
