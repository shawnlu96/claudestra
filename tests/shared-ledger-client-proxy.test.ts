import { expect, test } from "bun:test";
import { mkdtempSync, statSync, chmodSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSharedLedgerApi } from "../src/bridge/local-api/shared-ledger.js";
import { writeSharedLedgerCredential, resolveSharedLedgerCredential, writeSharedLedgerMode,
  readSharedLedgerMode, localSharedLedgerPlanningAllowed } from "../src/lib/shared-ledger-mode.js";
import { sharedLedgerCommandDigest } from "../src/lib/shared-ledger-auth.js";
import { fakeKey, fakeConnection, fakeCommand } from "./shared-ledger-client.test.js";

test("proxy ignores actor/role and keeps authenticated person and service identities separate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-ledger-fake-"));
  try {
    await writeSharedLedgerCredential({ ...fakeConnection, localSubject: "owner:self", kind: "person",
      projects: [{ projectId: "fake-project", actions: ["read", "plan"] }] }, dir);
    await writeSharedLedgerCredential({ ...fakeConnection, personId: "fake-service", bearer: "obviously-fake-service-credential",
      localSubject: "fake-worker", kind: "service", projects: [{ projectId: "fake-project", actions: ["read"] }] }, dir);
    expect(statSync(join(dir, "shared-ledger-credentials.json")).mode & 0o777).toBe(0o600);
    expect(resolveSharedLedgerCredential("fake-worker", "person", "fake-center", "fake-team", "fake-project", "read", dir)).toBeNull();
    expect(resolveSharedLedgerCredential("owner:self", "service", "fake-center", "fake-team", "fake-project", "read", dir)).toBeNull();
    const bearers: string[] = [];
    const fetcher = (async (_url, init) => {
      bearers.push((init!.headers as Record<string, string>).authorization);
      if (init!.method === "GET") return Response.json({ status: "unknown", requestId: fakeCommand.requestId });
      const body = JSON.parse(init!.body as string);
      expect(body.payload.actor).toBeUndefined(); expect(body.payload.role).toBeUndefined();
      return Response.json({ schemaVersion: 1, requestId: fakeCommand.requestId, commandDigest: sharedLedgerCommandDigest(body),
        serverSeq: 1, committedAt: 1, result: { featureId: "fake-feature", rev: 1, version: 0 } });
    }) as typeof fetch;
    const deps = { stateDir: dir, centerId: "fake-center", teamId: "fake-team", projectId: "fake-project", key: fakeKey(), fetch: fetcher,
      scrub: { identity: { username: "fake-user", hostname: "fake-host" } } };
    const principal = { id: "owner:self", role: "owner" as const, agents: ["*"], createdAt: "fake-date" };
    const request = () => new Request("https://fake.invalid/api/v1/shared-ledger/commands", {
      method: "POST", body: JSON.stringify({ ...fakeCommand, actor: "forged-owner", role: "owner" }) });
    const response = await handleSharedLedgerApi(request(), "/shared-ledger/commands", principal, deps);
    expect(response!.status).toBe(200);
    expect(bearers).toEqual([`Bearer ${fakeConnection.bearer}`, `Bearer ${fakeConnection.bearer}`]);
    const service = await handleSharedLedgerApi(request(), "/shared-ledger/commands", principal,
      { ...deps, serviceSubject: () => "fake-worker" });
    expect(service!.status).toBe(403);
    const unregistered = await handleSharedLedgerApi(request(), "/shared-ledger/commands", { ...principal, id: "fake-stranger" }, deps);
    expect(unregistered!.status).toBe(403);
    expect(bearers).toHaveLength(2);
    chmodSync(join(dir, "shared-ledger-credentials.json"), 0o644);
    expect(() => resolveSharedLedgerCredential("owner:self", "person", "fake-center", "fake-team", "fake-project", "read", dir)).toThrow("0600");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("persistent planning gate survives reads and corrupt state refuses writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-ledger-fake-mode-"));
  try {
    expect(localSharedLedgerPlanningAllowed(readSharedLedgerMode("fake-feature", dir))).toBe(true);
    await writeSharedLedgerMode("fake-feature", { authorityMode: "source", sharedPlanning: true }, dir);
    expect(localSharedLedgerPlanningAllowed(readSharedLedgerMode("fake-feature", dir))).toBe(false);
    for (const authorityMode of ["planning", "execution"] as const) {
      await writeSharedLedgerMode("fake-feature", { authorityMode, sharedPlanning: true }, dir);
      expect(readSharedLedgerMode("fake-feature", dir).authorityMode).toBe(authorityMode);
    }
    writeFileSync(join(dir, "shared-ledger-modes.json"), "invalid fake state");
    expect(() => readSharedLedgerMode("fake-feature", dir)).toThrow("invalid");
    await expect(writeSharedLedgerMode("fake-feature", { authorityMode: "source", sharedPlanning: false }, dir)).rejects.toThrow("invalid");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
