import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { readStage2Release, readStage2Switch, writeStage2Release, writeStage2Switch } from "../src/lib/shared-ledger-v2-switch.js";
import type { Stage2Release, Stage2Switch } from "../src/lib/shared-ledger-v2-switch.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "shared-ledger-v2-stage2-switch-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const sw = () => join(dir, "shared-ledger-v2-switch.json");
const releases = () => join(dir, "shared-ledger-v2-release.json");
const DAY = 86_400_000, DRILL = "s2-drill-example", PROJECT = "formal-example";
const grant = (kind: Stage2Release["kind"] = "release", at = Date.now()): Stage2Release =>
  ({ kind, askId: "owner-ask-123", grantedAt: at, ...(kind === "drill" ? { expiresAt: at + 7 * DAY } : {}) });

test("S2S defaults to off without creating files, including inherited property names", () => {
  for (const project of [PROJECT, "constructor", "toString"]) {
    expect(readStage2Switch(project, dir)).toBe("off");
    expect(readStage2Release(project, dir)).toBeNull();
  }
  expect(readdirSync(dir)).toEqual([]);
});

for (const raw of ["{", "null", "[]", "{}", '{"projects":[]}', '{"projects":{"formal-example":"enabled"}}']) {
  test(`S2S corrupt switch fails closed: ${raw}`, () => {
    writeFileSync(sw(), raw);
    expect(readStage2Switch(PROJECT, dir)).toBe("off");
    expect(readFileSync(sw(), "utf8")).toBe(raw);
  });
}

test("S2S on without authorization refuses without changing the existing switch", async () => {
  await expect(writeStage2Switch(PROJECT, "on", dir)).rejects.toThrow("valid release entry");
  expect(existsSync(sw())).toBe(false);
  await writeStage2Switch(PROJECT, "observe", dir);
  const before = readFileSync(sw(), "utf8");
  await expect(writeStage2Switch(PROJECT, "on", dir)).rejects.toThrow("valid release entry");
  expect(readFileSync(sw(), "utf8")).toBe(before);
  expect(readdirSync(dir)).toEqual(["shared-ledger-v2-switch.json"]);
});

for (const kind of ["drill", "release"] as const) {
  test(`S2S ${kind} allows on; granting cannot upgrade off or observe`, async () => {
    const project = kind === "drill" ? DRILL : PROJECT, entry = grant(kind);
    await writeStage2Release(project, entry, dir);
    expect(readStage2Release(project, dir)).toEqual(entry);
    expect(readStage2Switch(project, dir)).toBe("off");
    for (const mode of ["observe", "on", "off"] as const) {
      await writeStage2Switch(project, mode, dir);
      expect(readStage2Switch(project, dir)).toBe(mode);
    }
    expect(readStage2Switch("unlisted-project", dir)).toBe("off");
  });
}

test("S2S expiry boundary and revocation downgrade immediately without rewriting the switch", async () => {
  const entry = grant("drill");
  await writeStage2Release(DRILL, entry, dir);
  await writeStage2Switch(DRILL, "on", dir);
  const before = readFileSync(sw(), "utf8"), inode = statSync(sw()).ino;
  expect(readStage2Switch(DRILL, dir, entry.expiresAt! - 1)).toBe("on");
  expect(readStage2Switch(DRILL, dir, entry.expiresAt!)).toBe("observe");
  expect(readStage2Switch(DRILL, dir, entry.expiresAt! + 1)).toBe("observe");
  expect(readStage2Release(DRILL, dir)).toEqual(entry);
  await writeStage2Release(DRILL, null, dir);
  expect(readStage2Switch(DRILL, dir, entry.grantedAt)).toBe("observe");
  expect(readStage2Release(DRILL, dir)).toBeNull();
  expect(readFileSync(sw(), "utf8")).toBe(before);
  expect(statSync(sw()).ino).toBe(inode);
});

for (const raw of ["{", '{"projects":[]}', '{"projects":{"formal-example":{"kind":"release","grantedAt":0}}}']) {
  test(`S2S corrupt release downgrades a stored on: ${raw}`, async () => {
    await writeStage2Release(PROJECT, grant(), dir);
    await writeStage2Switch(PROJECT, "on", dir);
    const before = readFileSync(sw(), "utf8");
    writeFileSync(releases(), raw);
    expect(readStage2Switch(PROJECT, dir)).toBe("observe");
    expect(readStage2Release(PROJECT, dir)).toBeNull();
    await expect(writeStage2Switch(PROJECT, "on", dir)).rejects.toThrow("拒绝覆盖");
    expect(readFileSync(sw(), "utf8")).toBe(before);
    expect(readFileSync(releases(), "utf8")).toBe(raw);
    // Disabling remains available even when the release list needs repair.
    await writeStage2Switch(PROJECT, "off", dir);
    expect(readStage2Switch(PROJECT, dir)).toBe("off");
  });
}

test("S2S missing release list also downgrades a stored on", async () => {
  await writeStage2Release(PROJECT, grant(), dir);
  await writeStage2Switch(PROJECT, "on", dir);
  rmSync(releases());
  expect(readStage2Switch(PROJECT, dir)).toBe("observe");
});

test("S2S expired and future grants cannot authorize writing on", async () => {
  const now = Date.now();
  for (const entry of [{ ...grant(), grantedAt: now - DAY, expiresAt: now - 1 }, grant("release", now + DAY)]) {
    await writeStage2Release(PROJECT, entry, dir);
    await expect(writeStage2Switch(PROJECT, "on", dir)).rejects.toThrow("valid release entry");
    expect(existsSync(sw())).toBe(false);
  }
});

test("S2S rejects non-drill projects, absent/overlong drill expiry and absent askId", async () => {
  const now = Date.now(), entry = grant("drill", now);
  const invalid: [string, unknown][] = [
    [PROJECT, entry], [DRILL, { kind: "drill", askId: "ask", grantedAt: now }],
    [DRILL, { ...entry, expiresAt: now + 7 * DAY + 1 }], [DRILL, { ...entry, expiresAt: now }],
    [DRILL, { ...entry, askId: undefined }], [DRILL, { ...entry, askId: "   " }],
    [PROJECT, { ...grant(), askId: "" }], [DRILL, { ...entry, grantedAt: NaN }],
    [PROJECT, { ...grant(), expiresAt: "tomorrow" }], [DRILL, { ...entry, kind: "other" }],
  ];
  for (const [project, value] of invalid) {
    await expect(writeStage2Release(project, value as Stage2Release, dir)).rejects.toThrow("invalid stage2 release entry");
  }
  expect(readdirSync(dir)).toEqual([]);
});

test("S2S release permits unlimited duration or no expiry", async () => {
  const entry = grant();
  for (const value of [entry, { ...entry, expiresAt: entry.grantedAt + 3650 * DAY }]) {
    await writeStage2Release(PROJECT, value, dir);
    await writeStage2Switch(PROJECT, "on", dir);
    expect(readStage2Switch(PROJECT, dir, entry.grantedAt + 365 * DAY)).toBe("on");
  }
});

test("S2S rejects invalid project and mode inputs", async () => {
  for (const project of ["", "../project", "__proto__"]) {
    await expect(writeStage2Switch(project, "off", dir)).rejects.toThrow("invalid stage2 project");
    await expect(writeStage2Release(project, grant(), dir)).rejects.toThrow("invalid stage2 project");
  }
  await expect(writeStage2Switch(PROJECT, "enabled" as Stage2Switch, dir)).rejects.toThrow("switch mode");
  expect(readdirSync(dir)).toEqual([]);
});

test("S2S corrupt files are preserved by their writers and locks are released", async () => {
  writeFileSync(sw(), "broken switch");
  await expect(writeStage2Switch(PROJECT, "off", dir)).rejects.toThrow("拒绝覆盖");
  expect(readFileSync(sw(), "utf8")).toBe("broken switch");
  writeFileSync(releases(), "broken releases");
  await expect(writeStage2Release(PROJECT, grant(), dir)).rejects.toThrow("拒绝覆盖");
  await expect(writeStage2Release(PROJECT, null, dir)).rejects.toThrow("拒绝覆盖");
  expect(readFileSync(releases(), "utf8")).toBe("broken releases");
  expect(readdirSync(dir).sort()).toEqual(["shared-ledger-v2-release.json", "shared-ledger-v2-switch.json"]);
});

test("S2S both files use 0600 and atomic replacement, including existing permissive files", async () => {
  await writeStage2Switch(PROJECT, "off", dir);
  await writeStage2Release(PROJECT, grant(), dir);
  for (const path of [sw(), releases()]) {
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const before = readFileSync(path, "utf8"), fd = openSync(path, "r");
    try {
      chmodSync(path, 0o644);
      if (path === sw()) await writeStage2Switch(PROJECT, "observe", dir);
      else await writeStage2Release(PROJECT, null, dir);
      expect(readFileSync(fd, "utf8")).toBe(before);
      expect(readFileSync(path, "utf8")).not.toBe(before);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally { closeSync(fd); }
  }
  expect(readdirSync(dir).sort()).toEqual(["shared-ledger-v2-release.json", "shared-ledger-v2-switch.json"]);
});

for (const file of ["shared-ledger-v2-switch.json", "shared-ledger-v2-release.json"]) {
  test(`S2S writers wait for ${file} lock and re-read revoked authorization`, async () => {
    await writeStage2Release(PROJECT, grant(), dir);
    await writeStage2Switch(PROJECT, "observe", dir);
    const lock = await acquireLock(join(dir, `${file}.lock`));
    expect(lock).not.toBeNull();
    let finished = false;
    const pending = writeStage2Switch(PROJECT, "on", dir).then(() => "written", (e: Error) => e.message).finally(() => { finished = true; });
    try {
      await Bun.sleep(25);
      expect(finished).toBe(false);
      expect(readStage2Switch(PROJECT, dir)).toBe("observe");
      // Model another holder completing revocation before this writer acquires its locks.
      writeFileSync(releases(), JSON.stringify({ projects: {} }));
    } finally { lock!.release(); }
    expect(await pending).toContain("valid release entry");
    expect(readStage2Switch(PROJECT, dir)).toBe("observe");
  });
}

test("S2S losing a held lock before commit refuses replacement and removes the temporary file", async () => {
  await writeStage2Switch(PROJECT, "off", dir);
  const before = readFileSync(sw(), "utf8"), releaseLock = await acquireLock(`${releases()}.lock`);
  expect(releaseLock).not.toBeNull();
  const pending = writeStage2Switch(PROJECT, "observe", dir).then(() => "written", (e: Error) => e.message);
  try {
    await Bun.sleep(25);
    const owner = join(`${sw()}.lock`, "owner");
    expect(existsSync(owner)).toBe(true);
    writeFileSync(owner, "replacement-holder");
  } finally { releaseLock!.release(); }
  expect(await pending).toContain("提交前核验没通过");
  expect(readFileSync(sw(), "utf8")).toBe(before);
  expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
});

test("S2S release writer waits for the lock and snapshots caller data", async () => {
  const lock = await acquireLock(`${sw()}.lock`), entry = grant();
  expect(lock).not.toBeNull();
  const expected = { ...entry };
  let finished = false;
  const pending = writeStage2Release(PROJECT, entry, dir).finally(() => { finished = true; });
  try {
    await Bun.sleep(25);
    expect(finished).toBe(false);
    expect(existsSync(releases())).toBe(false);
    entry.askId = "";
  } finally { lock!.release(); }
  await pending;
  expect(readStage2Release(PROJECT, dir)).toEqual(expected);
});

test("S2S concurrent project updates and revoke preserve unrelated entries", async () => {
  const projects = [PROJECT, DRILL, "constructor", "another-project"];
  await Promise.all(projects.map((project) => writeStage2Release(project, grant(), dir)));
  await Promise.all(projects.map((project) => writeStage2Switch(project, "on", dir)));
  for (const project of projects) expect(readStage2Switch(project, dir)).toBe("on");
  await Promise.all([writeStage2Release(PROJECT, null, dir), writeStage2Switch(DRILL, "observe", dir), writeStage2Switch("another-project", "off", dir)]);
  expect(projects.map((project) => readStage2Switch(project, dir))).toEqual(["observe", "observe", "on", "off"]);
  expect(readStage2Release(DRILL, dir)).not.toBeNull();
});
