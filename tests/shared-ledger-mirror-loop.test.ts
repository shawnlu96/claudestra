import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";
import { moveStage } from "../src/lib/ledger-write.js";
import { acquireLock } from "../src/lib/file-lock.js";
import type { SharedLedgerProjection } from "../src/lib/shared-ledger-contract.js";
import { mirrorPushLockPath, readSharedLedgerMirrors, resolveMirrorCredential, sharedMirrorStatus } from "../src/lib/shared-ledger-mirror.js";
import { SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { runSharedLedgerMirrorPass, startSharedLedgerMirrorLoop } from "../src/lib/shared-ledger-mirror-loop.js";
import type { MirrorClient } from "../src/lib/shared-ledger-projector.js";
import { parseSourceDagUpload, sourceDagUploadDigest, type SourceDagUpload } from "../src/lib/shared-ledger-contract-source-dag.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { cleanupMirrorState, commitJournal, SCRUB, serviceCredential } from "./shared-ledger-mirror-fixture.test.js";

afterEach(() => cleanupMirrorState());
const okClient = (sent: SharedLedgerProjection[]): MirrorClient => ({ async projection(p) {
  sent.push(p);
  return { schemaVersion: 1, serverSeq: sent.length, sourceInstanceId: p.sourceInstanceId, sourceSeq: p.sourceSeq, digest: "b".repeat(64) };
} });

async function mirrored() {
  const f = integrationFixture();
  await commitJournal(f, "batch-pj1-loop");
  await serviceCredential();
  expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: true });
  return f;
}

test("a pass pushes the mirrored feature, persists the confirmed watermark, and status reports it", async () => {
  const f = await mirrored();
  try {
    const sent: SharedLedgerProjection[] = [];
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    const out = await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, now: () => 50_000, client: () => okClient(sent), scrub: async () => SCRUB });
    expect(out[f.id]).toMatchObject({ kind: "pushed", mode: "delta" });
    expect(sent[0]?.tasks.find((t) => t.sourceTaskId === "c5-existing")).toMatchObject({ stage: "restate", specSummary: "Existing work" });
    expect(sharedMirrorStatus(f.id)).toMatchObject({ mirroring: true, lastPushSeq: sent[0]!.sourceSeq, lastPushAt: new Date(50_000).toISOString(), lastError: null });
  } finally { await f.close(); }
});

test("push exceptions stay inside the pass: state records the error, the watermark holds, nothing throws", async () => {
  const f = await mirrored();
  try {
    const before = readSharedLedgerMirrors()[f.id]!.watermark;
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    const boom: MirrorClient = { async projection() { throw new Error("socket exploded with bearer-for-tests-only"); } };
    const out = await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, now: () => 60_000, client: () => boom, scrub: async () => SCRUB });
    expect(out[f.id]).toMatchObject({ kind: "failed" });
    const e = readSharedLedgerMirrors()[f.id]!;
    expect(e).toMatchObject({ watermark: before, failures: 1, nextAttemptAt: 70_000 });
    expect(e.lastError).not.toContain("bearer");
    // Backing off: the next pass before nextAttemptAt does not call the center at all.
    let calls = 0;
    await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, now: () => 65_000, client: () => ({ async projection() { calls++; throw new Error("x"); } }), scrub: async () => SCRUB });
    expect(calls).toBe(0);
    // Thrown setup (scrub/identity) is also contained.
    const out2 = await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, now: () => 80_000, client: () => boom, scrub: async () => { throw new Error("no identity"); } });
    expect(out2[f.id]).toMatchObject({ kind: "failed" });
  } finally { await f.close(); }
});

test("the mirror loop runs on its own timer: a throwing pass never stops the host's other periodic work", async () => {
  const f = await mirrored();
  try {
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    let attempts = 0, hostTicks = 0;
    const host = setInterval(() => { hostTicks++; }, 5);
    // A pass-level crash (not a per-feature failure, which is already contained): the clock itself throws every pass.
    const stop = startSharedLedgerMirrorLoop({ ledgerPath: f.db.filename, now: () => { attempts++; throw new Error("clock crashed"); },
      client: () => okClient([]), scrub: async () => SCRUB }, 10);
    const deadline = Date.now() + 3000;
    while ((attempts < 3 || hostTicks < 10) && Date.now() < deadline) await Bun.sleep(10);
    stop(); clearInterval(host);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(hostTicks).toBeGreaterThanOrEqual(10);
  } finally { await f.close(); }
});

test("cron hosts the loop outside its tick, and off waits for an in-flight push before reopening the gate", async () => {
  const cron = readFileSync(join(REPO_ROOT, "src/cron.ts"), "utf8");
  const main = cron.slice(cron.indexOf("async function main()"));
  expect(main.indexOf("startSharedLedgerMirrorLoop()")).toBeGreaterThan(-1);
  expect(main.indexOf("startSharedLedgerMirrorLoop()")).toBeLessThan(main.indexOf("while (true)"));

  const f = await mirrored();
  try {
    const held = (await acquireLock(mirrorPushLockPath(STATE_DIR)))!;
    let done = false;
    const off = f.ledger(["shared-mirror", "off", f.id]).then((r) => { done = true; return r; });
    await Bun.sleep(300);
    expect(done).toBe(false);
    expect(readSharedLedgerMirrors()[f.id]?.enabled).toBe(false); // pushing stopped first
    held.release();
    expect(await off).toMatchObject({ ok: true, mirroring: false });
    // A disabled feature is skipped by the pusher.
    const sent: SharedLedgerProjection[] = [];
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    expect(await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, client: () => okClient(sent), scrub: async () => SCRUB })).toEqual({});
    expect(sent).toHaveLength(0);
  } finally { await f.close(); }
});

/** Real SharedLedgerClient (its own second scrub) in front of a fake center transport. */
function fakeCenter() {
  const sent: SharedLedgerProjection[] = [], dags: SourceDagUpload[] = [], order: string[] = [];
  const fetcher = (async (url: URL, init?: RequestInit) => {
    // N8M: routed by resource; source-dags answers per contract (SourceDagUploadResult with the upload's own digest).
    if (url.pathname.endsWith("/source-dags")) {
      const upload = parseSourceDagUpload((JSON.parse(String(init?.body)) as { payload: unknown }).payload);
      dags.push(upload); order.push("source-dags");
      return Response.json({ schemaVersion: 1, featureId: upload.featureId, version: upload.dag.version, digest: sourceDagUploadDigest(upload), droppedBindings: 0 });
    }
    const { payload } = JSON.parse(String(init?.body)) as { payload: SharedLedgerProjection };
    sent.push(payload); order.push("projections");
    return Response.json({ schemaVersion: 1, serverSeq: sent.length, sourceInstanceId: payload.sourceInstanceId, sourceSeq: payload.sourceSeq, digest: "b".repeat(64) });
  }) as unknown as typeof fetch;
  return { sent, dags, order, fetcher };
}
const repoHead = () => Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim();

test("real client: a task head that is a commit in this repo passes both scrubs, the request goes out and the watermark advances", async () => {
  const f = await mirrored();
  try {
    const head = repoHead();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    f.db.prepare("UPDATE tasks SET headSHA = ? WHERE id = ?").run(head, "c5-existing");
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    const before = readSharedLedgerMirrors()[f.id]!.watermark, center = fakeCenter();
    const out = await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, now: () => 50_000, fetch: center.fetcher });
    expect(out[f.id]).toMatchObject({ kind: "pushed" });
    expect(center.sent).toHaveLength(1);
    expect(center.sent[0]!.tasks.find((t) => t.sourceTaskId === "c5-existing")?.head).toBe(head);
    const e = readSharedLedgerMirrors()[f.id]!;
    expect(e.watermark).toBeGreaterThan(before);
    expect(e).toMatchObject({ lastError: null, failures: 0, lastPushSeq: center.sent[0]!.sourceSeq });
    // N8M: the current local DAG version goes up once, after this pass's projection, and is persisted as confirmed.
    expect(center.dags).toHaveLength(1);
    expect(center.dags[0]!.dag.version).toBe(f.feature().currentVersion);
    expect(center.order).toEqual(["projections", "source-dags"]);
    expect(e.dagVersion).toBe(f.feature().currentVersion);
    await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, now: () => 60_000, fetch: center.fetcher });
    expect(center.dags).toHaveLength(1);
  } finally { await f.close(); }
});

test("real client: a 40-hex head that is not a commit in this repo never reaches the center; the client scrub still blocks it", async () => {
  const f = await mirrored();
  try {
    const unknown = "0123456789abcdef0123456789abcdef01234567", head = repoHead();
    f.db.prepare("UPDATE tasks SET headSHA = ? WHERE id = ?").run(unknown, "c5-existing");
    moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
    const center = fakeCenter();
    const out = await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, now: () => 50_000, fetch: center.fetcher });
    // The projector only keeps allowlisted heads: the unknown one goes out as null, never as raw hex.
    expect(out[f.id]).toMatchObject({ kind: "pushed" });
    expect(center.sent[0]!.tasks.find((t) => t.sourceTaskId === "c5-existing")?.head).toBeNull();
    expect(JSON.stringify(center.sent)).not.toContain(unknown);
    // The allowlist the real client now carries does not widen the scrub: a raw unknown head is still refused before any request.
    const entry = readSharedLedgerMirrors()[f.id]!, scrubbing = fakeCenter();
    const client = new SharedLedgerClient(resolveMirrorCredential(entry)!, instanceKeySync(STATE_DIR)!,
      { scrub: { ...SCRUB, commits: new Set([head]) }, fetch: scrubbing.fetcher });
    const raw = { ...center.sent[0]!, tasks: center.sent[0]!.tasks.map((t) => ({ ...t, head: unknown })) };
    await expect(client.projection(raw)).rejects.toThrow("tasks[0].head");
    expect(scrubbing.sent).toHaveLength(0);
    await expect(client.projection({ ...raw, tasks: raw.tasks.map((t) => ({ ...t, head })) })).resolves.toMatchObject({ sourceSeq: raw.sourceSeq });
  } finally { await f.close(); }
});
