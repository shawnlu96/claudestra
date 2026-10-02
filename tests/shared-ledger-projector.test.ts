import { expect, test } from "bun:test";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { getTask } from "../src/lib/ledger-store.js";
import { SharedLedgerRemoteError, SharedLedgerUnavailable } from "../src/lib/shared-ledger-client.js";
import type { SharedLedgerProjection } from "../src/lib/shared-ledger-contract.js";
import { pushSharedLedgerMirror, type MirrorClient } from "../src/lib/shared-ledger-projector.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { globalSeq, mirrorEntry, SCRUB } from "./shared-ledger-mirror-fixture.test.js";

/** In-memory center stand-in: records payloads; `fail` decides per call. */
function fakeCenter(fail: (p: SharedLedgerProjection, n: number) => unknown = () => null) {
  const sent: SharedLedgerProjection[] = [];
  const client: MirrorClient = {
    async projection(p) {
      const error = fail(p, sent.length);
      sent.push(structuredClone(p));
      if (error) throw error;
      return { schemaVersion: 1, serverSeq: sent.length, sourceInstanceId: p.sourceInstanceId, sourceSeq: p.sourceSeq, digest: "a".repeat(64) };
    },
  };
  return { sent, client };
}
const conflict = () => new SharedLedgerRemoteError(409, { code: "conflict", status: 409 });
const deps = (client: MirrorClient, now = 1_000) => ({ client, scrub: SCRUB, now });

test("stage change and a newly opened card reach the center as increments with monotonic sourceSeq", async () => {
  const f = integrationFixture();
  try {
    const ctx = { actor: f.actor }, center = fakeCenter();
    let entry = mirrorEntry(f, globalSeq(f));
    // Nothing changed since import: nothing to send.
    let r = await pushSharedLedgerMirror(f.db, f.id, entry, deps(center.client));
    expect(r.outcome.kind).toBe("idle");
    expect(center.sent).toHaveLength(0);

    moveStage(f.db, ctx, { taskId: "c5-existing", from: "spec", to: "restate" });
    r = await pushSharedLedgerMirror(f.db, f.id, entry, deps(center.client));
    expect(r.outcome).toMatchObject({ kind: "pushed", mode: "delta" });
    const first = center.sent[0]!;
    expect(first).toMatchObject({ mode: "delta", previousSourceSeq: entry.watermark, featureId: "center-feature-1", sourceInstanceId: "home-a" });
    expect(first.sourceSeq).toBeGreaterThan(entry.watermark);
    expect(first.tasks.map((t) => [t.sourceTaskId, t.stage])).toEqual([["c5-existing", "restate"]]);
    expect(first.events.every((e) => e.sourceSeq > entry.watermark && e.sourceSeq <= first.sourceSeq)).toBe(true);
    entry = r.entry;
    expect(entry.watermark).toBe(first.sourceSeq);

    // New card bound to the DAG with a dep: the next delta carries it (and only it) with deps for the web graph.
    createTask(f.db, ctx, { project: f.project, id: "c5-new", title: "New card", kind: "code" });
    bindNode(f.db, ctx, { id: f.id, rev: f.feature().rev, key: "next", taskId: "c5-new" });
    addDep(f.db, ctx, { from: "c5-existing", to: "c5-new", when: "verified" });
    r = await pushSharedLedgerMirror(f.db, f.id, entry, deps(center.client, 2_000));
    const second = center.sent[1]!;
    expect(second).toMatchObject({ mode: "delta", previousSourceSeq: first.sourceSeq });
    expect(second.sourceSeq).toBeGreaterThan(first.sourceSeq);
    expect(second.tasks.map((t) => t.sourceTaskId)).toEqual(["c5-new"]);
    expect(second.tasks[0]).toMatchObject({ deps: ["c5-existing"], stage: getTask(f.db, "c5-new")!.stage, fullText: "home_only" });
    expect(r.entry.watermark).toBe(second.sourceSeq);
  } finally { await f.close(); }
});

test("a conflict or watermark gap is answered with one full snapshot, not a blind retry", async () => {
  const f = integrationFixture();
  try {
    const center = fakeCenter((_p, n) => n === 0 ? conflict() : null);
    const entry = mirrorEntry(f, globalSeq(f));
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    const r = await pushSharedLedgerMirror(f.db, f.id, entry, deps(center.client));
    expect(center.sent.map((p) => p.mode)).toEqual(["delta", "snapshot"]);
    expect(center.sent[1]!.tasks.map((t) => t.sourceTaskId)).toEqual(["c5-existing"]);
    expect(center.sent[1]!.sourceSeq).toBe(center.sent[0]!.sourceSeq);
    expect(r.outcome).toMatchObject({ kind: "pushed", mode: "snapshot" });
    expect(r.entry).toMatchObject({ watermark: center.sent[1]!.sourceSeq, snapshot: false, failures: 0 });
  } finally { await f.close(); }
});

test("failed pushes keep the old watermark and back off; a rejected snapshot stays pending for the next pass", async () => {
  const f = integrationFixture();
  try {
    const entry = mirrorEntry(f, globalSeq(f));
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    const down = fakeCenter(() => new SharedLedgerUnavailable());
    let r = await pushSharedLedgerMirror(f.db, f.id, entry, deps(down.client, 5_000));
    expect(down.sent).toHaveLength(1); // no blind retry inside the pass
    expect(r.outcome).toMatchObject({ kind: "failed", error: "center unavailable; outcome unconfirmed" });
    expect(r.entry).toMatchObject({ watermark: entry.watermark, failures: 1, nextAttemptAt: 15_000, fingerprints: {} });
    r = await pushSharedLedgerMirror(f.db, f.id, r.entry, deps(down.client, 20_000));
    expect(r.entry).toMatchObject({ watermark: entry.watermark, failures: 2, nextAttemptAt: 40_000 });

    const stubborn = fakeCenter(() => conflict());
    r = await pushSharedLedgerMirror(f.db, f.id, entry, deps(stubborn.client));
    expect(stubborn.sent.map((p) => p.mode)).toEqual(["delta", "snapshot"]);
    expect(r.entry).toMatchObject({ watermark: entry.watermark, snapshot: true, failures: 1, lastError: "center rejected (409)" });
    const ok = fakeCenter();
    r = await pushSharedLedgerMirror(f.db, f.id, r.entry, deps(ok.client));
    expect(ok.sent.map((p) => p.mode)).toEqual(["snapshot"]);
    expect(r.entry).toMatchObject({ snapshot: false, failures: 0, lastError: null });
  } finally { await f.close(); }
});

test("a card missing locally is never sent as deleted or done", async () => {
  const f = integrationFixture();
  try {
    const center = fakeCenter();
    const entry = mirrorEntry(f, globalSeq(f), { fingerprints: { "gone-card": "f".repeat(64) } });
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    await pushSharedLedgerMirror(f.db, f.id, entry, deps(center.client));
    expect(center.sent[0]!.tasks.map((t) => t.sourceTaskId)).toEqual(["c5-existing"]);
  } finally { await f.close(); }
});

const allowed: Record<string, string[]> = {
  $: ["projectId", "featureId", "sourceInstanceId", "mode", "previousSourceSeq", "sourceSeq", "observedAt", "tasks", "events"],
  tasks: ["sourceTaskId", "sourceRev", "sourceSeq", "stage", "assigneeCode", "executorInstanceId", "pr", "head", "deps",
    "specSummary", "specDigest", "fullText", "steps", "asks"],
  steps: ["sourceStepId", "sourceRev", "sourceSeq", "state"], asks: ["kind", "state", "blocking"],
  events: ["sourceSeq", "sourceTaskId", "type", "at", "summary"],
};
function keysOutside(value: unknown, shape = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => keysOutside(v, shape));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => allowed[shape]?.includes(k) ? keysOutside(v, k) : [`${shape}.${k}`]);
}

test("only frozen DTO fields leave the machine and the scrubber stops a secret-looking value", async () => {
  const f = integrationFixture();
  try {
    const center = fakeCenter();
    setMeta(f.db, { actor: "owner" }, { project: f.project, key: "pms", value: [f.actor] }); // global seq moves
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    const entry = mirrorEntry(f, 0);
    const r = await pushSharedLedgerMirror(f.db, f.id, entry, deps(center.client));
    expect(r.outcome.kind).toBe("pushed");
    expect(keysOutside(center.sent[0])).toEqual([]);
    // Local-only task fields never appear.
    expect(JSON.stringify(center.sent[0])).not.toContain("Existing card");

    const secret = `ghp_${"A1b2C3d4E5".repeat(4)}`;
    const leaky = fakeCenter();
    const blocked = await pushSharedLedgerMirror(f.db, f.id,
      mirrorEntry(f, 0, { taskMeta: { "c5-existing": { specSummary: `token ${secret}`, specDigest: null, assigneeCode: null } } }), deps(leaky.client));
    expect(leaky.sent).toHaveLength(0);
    expect(blocked.outcome).toMatchObject({ kind: "failed" });
    expect(blocked.entry.watermark).toBe(0);
    expect(blocked.entry.lastError).toContain("upload blocked at $.tasks[0].specSummary");
    expect(blocked.entry.lastError).not.toContain(secret);
  } finally { await f.close(); }
});

test("freshness (PM 10-02 option A): another card's event moves the global seq → one empty delta; no event → no push", async () => {
  const f = integrationFixture();
  try {
    const center = fakeCenter();
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    const entry = (await pushSharedLedgerMirror(f.db, f.id, mirrorEntry(f, 0), deps(center.client))).entry; // baseline
    center.sent.length = 0;
    // Global seq unchanged: no push and no fabricated event.
    const idle = await pushSharedLedgerMirror(f.db, f.id, entry, deps(center.client));
    expect(idle.outcome.kind).toBe("idle");
    expect(center.sent).toHaveLength(0);
    expect(globalSeq(f)).toBe(entry.watermark);
    // A card outside this feature changes: the feature still gets a newer sourceSeq so the center refreshes observedAt.
    createTask(f.db, { actor: f.actor }, { project: f.project, id: "c5-unrelated", title: "Unrelated", kind: "code" });
    const r = await pushSharedLedgerMirror(f.db, f.id, entry, deps(center.client, 9_000));
    expect(center.sent).toHaveLength(1);
    expect(center.sent[0]).toMatchObject({ mode: "delta", previousSourceSeq: entry.watermark, sourceSeq: globalSeq(f), observedAt: 9_000, tasks: [], events: [] });
    expect(r.entry.watermark).toBe(globalSeq(f));
  } finally { await f.close(); }
});
