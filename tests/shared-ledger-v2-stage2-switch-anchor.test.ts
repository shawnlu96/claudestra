import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStage2Release, readStage2Switch, writeStage2Release, writeStage2Switch } from "../src/lib/shared-ledger-v2-switch.js";
import type { Stage2Release } from "../src/lib/shared-ledger-v2-switch.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "shared-ledger-v2-stage2-anchor-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const releases = () => join(dir, "shared-ledger-v2-release.json");
const DAY = 86_400_000, DRILL = "s2-drill-example", PROJECT = "formal-example";
const drill = (at: number): Stage2Release => ({ kind: "drill", askId: "owner-ask-123", grantedAt: at, expiresAt: at + 7 * DAY });
const handWrite = (project: string, entry: unknown) => writeFileSync(releases(), JSON.stringify({ projects: { [project]: entry } }));
const switchOn = async (project: string) => {
  await writeStage2Release(project, drill(Date.now()), dir);
  await writeStage2Switch(project, "on", dir);
};

test("S2S2 writer refuses a future drill window that would turn on later", async () => {
  const now = Date.now(), future = { ...drill(now + 30 * DAY) };
  expect(future.expiresAt).toBe(now + 37 * DAY);
  await expect(writeStage2Release(DRILL, future, dir)).rejects.toThrow("invalid stage2 release entry");
  await expect(writeStage2Release(PROJECT, { ...future, kind: "release" }, dir)).rejects.toThrow("invalid stage2 release entry");
  expect(readdirSync(dir)).toEqual([]);
});

test("S2S2 future anchor uses an injectable clock and a 60 second tolerance", async () => {
  const now = 1_800_000_000_000;
  await expect(writeStage2Release(DRILL, drill(now + 60_001), dir, { now })).rejects.toThrow("invalid stage2 release entry");
  await expect(writeStage2Release(DRILL, drill(now + 1), dir, { now, clockSkewMs: 0 })).rejects.toThrow("invalid stage2 release entry");
  await expect(writeStage2Release(DRILL, drill(now), dir, { now, clockSkewMs: NaN })).rejects.toThrow("invalid stage2 release entry");
  await expect(writeStage2Release(DRILL, drill(now), dir, { now: NaN })).rejects.toThrow("invalid stage2 release entry");
  await writeStage2Release(DRILL, drill(now + 60_000), dir, { now });
  expect(readStage2Release(DRILL, dir)).toEqual(drill(now + 60_000));
  // The existing 7 day drill cap still applies to an anchored grant.
  await expect(writeStage2Release(DRILL, { ...drill(now), expiresAt: now + 7 * DAY + 1 }, dir, { now })).rejects.toThrow("invalid stage2 release entry");
});

test("S2S2 hand-written future grant reads as observe and cannot authorize on", async () => {
  await switchOn(DRILL);
  const now = Date.now(), future = drill(now + 30 * DAY);
  handWrite(DRILL, future);
  expect(readStage2Switch(DRILL, dir, now)).toBe("observe");
  expect(readStage2Switch(DRILL, dir, now + 30 * DAY - 1)).toBe("observe");
  await writeStage2Switch(DRILL, "observe", dir);
  await expect(writeStage2Switch(DRILL, "on", dir)).rejects.toThrow("valid release entry");
});

test("S2S2 writer records only the four release fields", async () => {
  const now = Date.now();
  const entry = { ...drill(now), note: "owner said yes", nested: { kind: "release", expiresAt: null } } as unknown as Stage2Release;
  await writeStage2Release(DRILL, entry, dir);
  const recorded = JSON.parse(readFileSync(releases(), "utf8")).projects[DRILL];
  expect(Object.keys(recorded).sort()).toEqual(["askId", "expiresAt", "grantedAt", "kind"]);
  expect(recorded).toEqual(drill(now));
  await writeStage2Release(PROJECT, { kind: "release", askId: "ask", grantedAt: now, note: "x" } as Stage2Release, dir);
  expect(Object.keys(JSON.parse(readFileSync(releases(), "utf8")).projects[PROJECT]).sort()).toEqual(["askId", "grantedAt", "kind"]);
});

for (const extra of [{ note: "x" }, { nested: { a: 1 } }, { extra: null }]) {
  test(`S2S2 hand-written extra fields read as invalid: ${JSON.stringify(extra)}`, async () => {
    await switchOn(DRILL);
    handWrite(DRILL, { ...drill(Date.now()), ...extra });
    expect(readStage2Switch(DRILL, dir)).toBe("observe");
    expect(readStage2Release(DRILL, dir)).toBeNull();
    await expect(writeStage2Switch(DRILL, "on", dir)).rejects.toThrow("拒绝覆盖");
  });
}
