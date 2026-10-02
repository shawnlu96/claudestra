import { expect, test } from "bun:test";
import { statSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { isWriteInvocation, needsWriteLock } from "../src/manager/write-commands.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { readSharedLedgerBindings } from "../src/lib/shared-ledger-gate-bindings.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";

test("only a local project PM/owner can atomically install a 0600 trusted binding; web bodies cannot", async () => {
  const f = integrationFixture(), path = join(STATE_DIR, "shared-ledger-bindings.json");
  const args = ["shared-bindings-set", "--center", "fixture", "--team", "team-a", "--shared-project", "project-a"];
  try {
    expect(isWriteInvocation("ledger", args)).toBe(true);
    expect(needsWriteLock("ledger", args)).toBe(false);
    expect(await f.ledger(args, "guest:member")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.ledger(args)).toMatchObject({ ok: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readSharedLedgerBindings()).toEqual([{ centerId: "fixture", teamId: "team-a", projectId: "project-a", localProjectId: f.project }]);
    const before = readFileSync(path, "utf8");
    const req = new Request("https://fixture.invalid/api/v1/shared-ledger/bindings", { method: "POST", body: JSON.stringify({ actor: "owner", bindings: [] }) });
    const response = await handleLocalApi(req, new URL(req.url), { id: "guest:member", role: "external", agents: [], createdAt: "test" });
    expect(response?.status).toBe(403);
    expect(readFileSync(path, "utf8")).toBe(before);
  } finally { rmSync(path, { force: true }); await f.close(); }
});
