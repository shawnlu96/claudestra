import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSharedLedgerBindings, replaceSharedLedgerBindings, setSharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings.js";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const shared = { centerId: "center", teamId: "team", projectId: "claude-orchestrator" };
function world() {
  const dir = mkdtempSync(join(tmpdir(), "sl-replace-")); roots.push(dir);
  const projects = ["claudestra", "second", "personal"].map(id => ({ id, name: id, dirs: [], personal: id === "personal" }));
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects }));
  const file = join(dir, "shared-ledger-bindings.json");
  return { dir, file };
}

test("repair dangling and duplicate center rows with exact 0600 backup; unrelated state survives", async () => {
  for (const duplicate of [false, true]) {
    const { dir, file } = world();
    const expected = [{ ...shared, localProjectId: "claude-orchestrator" }];
    if (duplicate) expected.push({ ...shared, localProjectId: "second" });
    const before = JSON.stringify(expected, null, 3) + "\n";
    writeFileSync(file, before, { mode: 0o600 });
    const credentials = join(dir, "shared-ledger-credentials.json");
    writeFileSync(credentials, "untouched credentials\n", { mode: 0o600 });
    const next = { ...shared, localProjectId: "claudestra" };
    const result = await replaceSharedLedgerBindings({ expected, next }, dir);
    expect(readSharedLedgerBindings(dir)).toEqual([next]);
    expect(readFileSync(result.backupPath!, "utf8")).toBe(before);
    expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
    expect(readFileSync(credentials, "utf8")).toBe("untouched credentials\n");
  }
});

test("replacement rejects stale expected, personal, missing, and occupied local project without changing bytes", async () => {
  const { dir, file } = world();
  const old = { ...shared, localProjectId: "gone" };
  const other = { ...shared, projectId: "other", localProjectId: "second" };
  writeFileSync(file, JSON.stringify([old, other], null, 1), { mode: 0o600 });
  const before = readFileSync(file);
  for (const localProjectId of ["personal", "missing", "second"]) {
    await expect(replaceSharedLedgerBindings({ expected: [old], next: { ...shared, localProjectId } }, dir)).rejects.toThrow();
    expect(readFileSync(file)).toEqual(before);
  }
  await expect(replaceSharedLedgerBindings({ expected: [], next: { ...shared, localProjectId: "claudestra" } }, dir)).rejects.toThrow("changed");
  expect(readFileSync(file)).toEqual(before);
});

test("ordinary setter enforces both unique keys and personal protection, allowing only identical retry", async () => {
  const { dir, file } = world();
  const first = { ...shared, localProjectId: "claudestra" };
  await setSharedLedgerBinding(first, dir);
  const before = readFileSync(file);
  for (const next of [{ ...shared, localProjectId: "second" }, { ...first, projectId: "another" },
    { ...first, localProjectId: "personal" }, { ...first, localProjectId: "missing" }]) {
    await expect(setSharedLedgerBinding(next, dir)).rejects.toThrow();
    expect(readFileSync(file)).toEqual(before);
  }
  await setSharedLedgerBinding(first, dir);
  expect(readSharedLedgerBindings(dir)).toEqual([first]);
});
