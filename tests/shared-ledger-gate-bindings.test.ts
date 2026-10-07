import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjects, writeProjects } from "../src/lib/projects.js";
import { readSharedLedgerBindings, setSharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings.js";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const shared = { centerId: "center", teamId: "team", projectId: "shared" };
async function world() {
  const dir = mkdtempSync(join(tmpdir(), "sl-bindings-")); roots.push(dir);
  await writeProjects({ projects: ["a", "b", "keep", "personal", "umbrella"].map(id => ({ id, name: id,
    dirs: id === "umbrella" ? ["/"] : [], ...(id === "personal" ? { personal: true } : {}), createdAt: "" })) }, join(dir, "projects.json"));
  return dir;
}

test("ordinary addition rejects central/local collisions and illegal targets without changing bytes", async () => {
  const dir = await world();
  const first = { ...shared, localProjectId: "a" };
  await setSharedLedgerBinding(first, dir);
  const path = join(dir, "shared-ledger-bindings.json"), before = readFileSync(path);
  await setSharedLedgerBinding(first, dir);
  expect(readFileSync(path)).toEqual(before);
  for (const binding of [{ ...shared, localProjectId: "b" }, { ...shared, centerId: "other", localProjectId: "a" },
    ...["missing", "personal", "umbrella"].map(localProjectId => ({ ...shared, projectId: "other", localProjectId }))]) {
    await expect(setSharedLedgerBinding(binding, dir)).rejects.toThrow();
    expect(readFileSync(path)).toEqual(before);
  }
  expect(readSharedLedgerBindings(dir)).toEqual([first]);
});

test("independent mappings survive and concurrent conflicting additions admit exactly one", async () => {
  const dir = await world();
  const keep = { centerId: "keep", teamId: "team", projectId: "keep", localProjectId: "keep" };
  await setSharedLedgerBinding(keep, dir);
  const results = await Promise.allSettled(["a", "b"].map(localProjectId => setSharedLedgerBinding({ ...shared, localProjectId }, dir)));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(readSharedLedgerBindings(dir)).toHaveLength(2);
  expect(readSharedLedgerBindings(dir)[0]).toEqual(keep);
});

test("a corrupt projects file cannot authorize from the ordinary reader's last-good cache", async () => {
  const dir = await world(), projectsPath = join(dir, "projects.json");
  await setSharedLedgerBinding({ ...shared, localProjectId: "a" }, dir);
  await readProjects(projectsPath); // Populate the non-security reader's cache.
  writeFileSync(projectsPath, "corrupt fixture bytes");
  const path = join(dir, "shared-ledger-bindings.json"), before = readFileSync(path);
  await expect(setSharedLedgerBinding({ ...shared, projectId: "different", localProjectId: "b" }, dir)).rejects.toThrow("invalid local projects");
  expect(readFileSync(path)).toEqual(before);
  expect(readFileSync(projectsPath, "utf8")).toBe("corrupt fixture bytes");
});
