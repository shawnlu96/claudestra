/**
 * team-project-N8A6B: the bridge's /api/v1/shared-ledger/* body cap is the one the center applies to the same route
 * (sharedLedgerBodyLimit), so a team import the center would take (≤ 8 MiB) is never refused 413 by the bridge first,
 * while commands / projections keep the 1 MiB transport cap.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSharedLedgerApi } from "../src/bridge/local-api/shared-ledger.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { SHARED_LEDGER_IMPORT_FIXTURE } from "../src/lib/shared-ledger-contract-fixtures.js";
import { sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.js";
import { SHARED_LEDGER_MAX_BODY_BYTES, type SharedLedgerImport } from "../src/lib/shared-ledger-contract.js";
import { fakeKey, fakeConnection } from "./shared-ledger-client.test.js";

const MIB = 1_048_576;
/** A valid import for `projectId` with `count` distinct features, each with the contract's longest description (16 000 chars of prose). */
function bulkImport(projectId: string, count: number): SharedLedgerImport {
  const base = SHARED_LEDGER_IMPORT_FIXTURE.payload;
  const feature = JSON.stringify(base.manifest.features[0]!);
  const features = Array.from({ length: count }, (_, i) => ({
    ...JSON.parse(feature.replaceAll("old-feature-a", `feature-${i}`).replaceAll("task-a", `task-${i}`)) as typeof base.manifest.features[number],
    title: `Feature ${i}`, description: "step ".repeat(3200),
  }));
  const manifest = { ...base.manifest, projectId, features };
  return { ...base, manifest, manifestDigest: sharedLedgerManifestDigest(manifest) };
}

test("N8A6B a 2 MiB team import passes the bridge and reaches the center; 1 MiB + 1 commands / projections bodies are still 413", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-ledger-body-limit-"));
  try {
    await writeSharedLedgerCredential({ ...fakeConnection, localSubject: "owner:self", kind: "person",
      projects: [{ projectId: "fake-project", actions: ["read", "plan", "import", "project"] }] }, dir);
    const posted: { path: string; bytes: number }[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "POST") return Response.json({ status: "unknown" });
      const url = new URL(input instanceof Request ? input.url : input);
      posted.push({ path: url.pathname, bytes: Buffer.byteLength(String(init!.body)) });
      return Response.json({ code: "invalid_field" }, { status: 400 });
    }) as typeof fetch;
    const deps = { stateDir: dir, centerId: "fake-center", teamId: "fake-team", projectId: "fake-project", key: fakeKey(), fetch: fetcher,
      scrub: { identity: { username: "fake-user", hostname: "fake-host" } } };
    const principal = { id: "owner:self", role: "owner" as const, agents: ["*"], createdAt: "fake-date" };
    const post = (resource: string, body: string) => handleSharedLedgerApi(
      new Request(`https://fake.invalid/api/v1/shared-ledger/${resource}`, { method: "POST", body }), `/shared-ledger/${resource}`, principal, deps);

    const body = JSON.stringify(bulkImport("fake-project", 130));
    expect(Buffer.byteLength(body)).toBeGreaterThan(2 * MIB);
    const imported = await post("imports", body);
    expect(imported!.status).toBe(400); // the stub center's answer, i.e. the bridge forwarded the body instead of refusing it
    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toBe("/v1/teams/fake-team/imports");
    expect(posted[0]!.bytes).toBeGreaterThan(2 * MIB);

    const oversized = `{"pad":"${"x".repeat(SHARED_LEDGER_MAX_BODY_BYTES + 1 - 10)}"}`;
    expect(Buffer.byteLength(oversized)).toBe(SHARED_LEDGER_MAX_BODY_BYTES + 1);
    for (const resource of ["projections", "commands"]) {
      const refused = await post(resource, oversized);
      expect(refused!.status).toBe(413);
    }
    expect(posted).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
