import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSharedLedgerBindings, setSharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings.js";

test("rebinding the same center/team/project replaces its old local project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-bindings-"));
  try {
    const shared = { centerId: "center", teamId: "team", projectId: "shared" };
    await setSharedLedgerBinding({ ...shared, localProjectId: "a" }, dir);
    await setSharedLedgerBinding({ ...shared, localProjectId: "b" }, dir);
    expect(readSharedLedgerBindings(dir)).toEqual([{ ...shared, localProjectId: "b" }]);
    expect(readFileSync(join(dir, "shared-ledger-bindings.json"), "utf8")).not.toContain('"a"');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("same local project replaces another identity while unrelated local mappings survive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-binding-local-"));
  try {
    await setSharedLedgerBinding({ centerId: "old", teamId: "team", projectId: "shared", localProjectId: "local" }, dir);
    const unrelated = { centerId: "keep", teamId: "team", projectId: "keep", localProjectId: "keep" };
    await setSharedLedgerBinding(unrelated, dir);
    const replacement = { centerId: "new", teamId: "team", projectId: "new", localProjectId: "local" };
    await setSharedLedgerBinding(replacement, dir);
    expect(readSharedLedgerBindings(dir)).toEqual([unrelated, replacement]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
