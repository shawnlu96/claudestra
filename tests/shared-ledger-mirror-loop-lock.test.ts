import { afterEach, expect, jest, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { moveStage } from "../src/lib/ledger-write.js";
import { acquireLock } from "../src/lib/file-lock.js";
import type { SharedLedgerProjection } from "../src/lib/shared-ledger-contract.js";
import { MIRROR_PUSH_LOCK_STALE_MS, mirrorPushLockPath, readSharedLedgerMirrors } from "../src/lib/shared-ledger-mirror.js";
import { runSharedLedgerMirrorPass } from "../src/lib/shared-ledger-mirror-loop.js";
import type { MirrorClient } from "../src/lib/shared-ledger-projector.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { cleanupMirrorState, commitJournal, SCRUB, serviceCredential } from "./shared-ledger-mirror-fixture.test.js";

// N8A8E: a pass killed mid-push (cron restarted by a deploy) leaves the push lock behind; both holders judge it at 30s.
afterEach(() => cleanupMirrorState());
const okClient = (sent: SharedLedgerProjection[]): MirrorClient => ({ async projection(p) {
  sent.push(p);
  return { schemaVersion: 1, serverSeq: sent.length, sourceInstanceId: p.sourceInstanceId, sourceSeq: p.sourceSeq, digest: "b".repeat(64) };
} });

async function mirrored(batch: string) {
  const f = integrationFixture();
  await commitJournal(f, batch);
  await serviceCredential();
  expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: true });
  moveStage(f.db, { actor: f.actor }, { taskId: "c5-existing", from: "spec", to: "restate" });
  return f;
}
const lockPath = () => mirrorPushLockPath(STATE_DIR);
const ownerOf = () => readFileSync(join(lockPath(), "owner"), "utf8");
const age = (ms: number) => { const t = new Date(Date.now() - ms); utimesSync(lockPath(), t, t); };
/** What a cron killed mid-pass leaves: the lock dir with its token, never renewed again. */
function deadHolder(ageMs: number) {
  mkdirSync(lockPath());
  writeFileSync(join(lockPath(), "owner"), "99999.dead.killed-by-restart");
  age(ageMs);
}

test("the push lock expires in 30s", () => {
  expect(MIRROR_PUSH_LOCK_STALE_MS).toBe(30_000);
});

test("a lock left by a killed pass (dead token, 31s old) is reclaimed on the next pass, which pushes in that same pass", async () => {
  const f = await mirrored("batch-n8a8e-dead");
  try {
    deadHolder(MIRROR_PUSH_LOCK_STALE_MS + 1_000);
    const sent: SharedLedgerProjection[] = [];
    const out = await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, client: () => okClient(sent), scrub: async () => SCRUB });
    expect(out[f.id]).toMatchObject({ kind: "pushed" });
    expect(sent).toHaveLength(1);
    expect(readSharedLedgerMirrors()[f.id]!.lastPushSeq).toBe(sent[0]!.sourceSeq);
  } finally { await f.close(); }
});

test("a live holder renewing on its own timer keeps the lock for 60s: every pass in between skips and reclaims nothing", async () => {
  const f = await mirrored("batch-n8a8e-live");
  // Virtual clock drives file-lock's own renewal interval and Date.now() together (mtime is written from the same clock);
  // nothing here touches the lock: with the renewal timer gone the lock turns stale after 30s and a pass pushes.
  jest.useFakeTimers();
  try {
    const holder = (await acquireLock(lockPath(), 0, MIRROR_PUSH_LOCK_STALE_MS))!;
    const token = ownerOf(), sent: SharedLedgerProjection[] = [];
    for (let t = 0; t < 60_000; t += 5_000) {
      jest.advanceTimersByTime(5_000);
      expect(await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, client: () => okClient(sent), scrub: async () => SCRUB })).toEqual({});
      expect(ownerOf()).toBe(token);
    }
    expect(sent).toHaveLength(0);
    holder.release();
    jest.useRealTimers();
    // Control: the same pass pushes once the holder is gone, so the skips above were the lock and nothing else.
    expect(await runSharedLedgerMirrorPass({ ledgerPath: f.db.filename, client: () => okClient(sent), scrub: async () => SCRUB })).toMatchObject({ [f.id]: { kind: "pushed" } });
  } finally { jest.useRealTimers(); await f.close(); }
});

test("shared-mirror off judges the push lock with the same 30s: a dead pass's lock is reclaimed, a live one is waited on", async () => {
  const f = await mirrored("batch-n8a8e-off");
  try {
    // Off waits up to 20s: on file-lock's 180s default it would never reclaim this one and fail busy.
    deadHolder(MIRROR_PUSH_LOCK_STALE_MS + 1_000);
    const started = Date.now();
    expect(await f.ledger(["shared-mirror", "off", f.id])).toMatchObject({ ok: true, mirroring: false });
    expect(Date.now() - started).toBeLessThan(3_000);

    expect(await f.ledger(["shared-mirror", "on", f.id])).toMatchObject({ ok: true });
    const holder = (await acquireLock(lockPath(), 0, MIRROR_PUSH_LOCK_STALE_MS))!;
    age(MIRROR_PUSH_LOCK_STALE_MS - 5_000);
    let done = false;
    const off = f.ledger(["shared-mirror", "off", f.id]).then((r) => { done = true; return r; });
    await Bun.sleep(500);
    expect(done).toBe(false); // 25s old but owned: not reclaimed
    expect(holder.held()).toBe(true);
    holder.release();
    expect(await off).toMatchObject({ ok: true, mirroring: false });
  } finally { await f.close(); }
});
