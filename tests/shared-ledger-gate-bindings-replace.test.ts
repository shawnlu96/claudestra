import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeProjects } from "../src/lib/projects.js";
import { replaceSharedLedgerBindings, readSharedLedgerBindings, type SharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings.js";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const shared = { centerId: "center", teamId: "team", projectId: "shared" };
const next = { ...shared, localProjectId: "local" };
async function world(rows: SharedLedgerBinding[]) {
  const dir = mkdtempSync(join(tmpdir(), "sl-replace-")); roots.push(dir);
  await writeProjects({ projects: ["local", "personal", "umbrella"].map(id => ({ id, name: id,
    dirs: id === "umbrella" ? ["/"] : [], ...(id === "personal" ? { personal: true } : {}), createdAt: "" })) }, join(dir, "projects.json"));
  // Invalid legacy bindings are constructed directly, never via a permissive product setter.
  writeFileSync(join(dir, "shared-ledger-bindings.json"), JSON.stringify(rows, null, 3) + "\n", { mode: 0o600 });
  writeFileSync(join(dir, "shared-ledger-credentials.json"), "original credential bytes\n", { mode: 0o600 });
  return dir;
}

test("authorized dangling/duplicate/implicit/old-personal bindings converge with an exact private backup", async () => {
  for (const expected of [[{ ...shared, localProjectId: "missing" }],
    [{ ...shared, localProjectId: "missing" }, { ...shared, localProjectId: "personal" }], [shared], [{ ...shared, localProjectId: "personal" }]]) {
    const keep = { centerId: "other", teamId: "team", projectId: "keep", localProjectId: "keep" };
    const dir = await world([...expected, keep]), path = join(dir, "shared-ledger-bindings.json"), before = readFileSync(path);
    await replaceSharedLedgerBindings({ expected, next }, dir);
    expect(readSharedLedgerBindings(dir)).toEqual([keep, next]);
    const backups = readdirSync(dir).filter(f => f.startsWith("shared-ledger-bindings.json.bak-"));
    expect(backups).toHaveLength(1);
    expect(statSync(join(dir, backups[0]!)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, backups[0]!))).toEqual(before);
    expect(readFileSync(join(dir, "shared-ledger-credentials.json"), "utf8")).toBe("original credential bytes\n");
  }
});

test("drift, partial expected rows, illegal targets and other central bindings refuse without writes or backups", async () => {
  const old = { ...shared, localProjectId: "missing" };
  for (const mode of ["drift", "partial", "missing", "personal", "umbrella", "taken", "implicit-taken"]) {
    const rows: SharedLedgerBinding[] = [old];
    if (mode === "partial") rows.push({ ...shared, localProjectId: "also-missing" });
    if (mode === "taken") rows.push({ centerId: "other", teamId: "team", projectId: "other", localProjectId: "local" });
    if (mode === "implicit-taken") rows.push({ centerId: "other", teamId: "team", projectId: "local" });
    const dir = await world(rows), path = join(dir, "shared-ledger-bindings.json"), before = readFileSync(path);
    await expect(replaceSharedLedgerBindings({ expected: mode === "drift" ? [] : [old],
      next: { ...next, localProjectId: ["missing", "personal", "umbrella"].includes(mode) ? mode : "local" } }, dir)).rejects.toThrow();
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dir).filter(f => f.includes(".bak-"))).toEqual([]);
    expect(readFileSync(join(dir, "shared-ledger-credentials.json"), "utf8")).toBe("original credential bytes\n");
  }
});

test("concurrent authorizations cannot both replace the same expected rows", async () => {
  const old = { ...shared, localProjectId: "missing" }, dir = await world([old]);
  const result = await Promise.allSettled([1, 2].map(() => replaceSharedLedgerBindings({ expected: [old], next }, dir)));
  expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(readSharedLedgerBindings(dir)).toEqual([next]);
});
