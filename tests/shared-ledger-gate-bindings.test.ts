import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSharedLedgerBindings, setSharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings.js";

test("ordinary setter rejects rebinding the same center/team/project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-bindings-"));
  try {
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: ["a", "b"].map(id => ({ id, name: id, dirs: [] })) }));
    const shared = { centerId: "center", teamId: "team", projectId: "shared" };
    await setSharedLedgerBinding({ ...shared, localProjectId: "a" }, dir);
    const before = readFileSync(join(dir, "shared-ledger-bindings.json"));
    await expect(setSharedLedgerBinding({ ...shared, localProjectId: "b" }, dir)).rejects.toThrow("already bound");
    expect(readSharedLedgerBindings(dir)).toEqual([{ ...shared, localProjectId: "a" }]);
    expect(readFileSync(join(dir, "shared-ledger-bindings.json"))).toEqual(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("same local project cannot replace another identity and unrelated mappings survive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-binding-local-"));
  try {
    writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: ["local", "keep"].map(id => ({ id, name: id, dirs: [] })) }));
    await setSharedLedgerBinding({ centerId: "old", teamId: "team", projectId: "shared", localProjectId: "local" }, dir);
    const unrelated = { centerId: "keep", teamId: "team", projectId: "keep", localProjectId: "keep" };
    await setSharedLedgerBinding(unrelated, dir);
    const replacement = { centerId: "new", teamId: "team", projectId: "new", localProjectId: "local" };
    const before = readFileSync(join(dir, "shared-ledger-bindings.json"));
    await expect(setSharedLedgerBinding(replacement, dir)).rejects.toThrow("already bound");
    expect(readFileSync(join(dir, "shared-ledger-bindings.json"))).toEqual(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
