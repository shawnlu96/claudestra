import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "../src/lib/principals.js";
import { instanceIdSync } from "../src/lib/instance-id.js";
import { setSharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings.js";
import { writeSharedLedgerCredential, type SharedLedgerLocalCredential } from "../src/lib/shared-ledger-mode.js";
import { resolveSharedProjectOwner } from "../src/bridge/local-api/shared-projects-auth.js";

const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], manage: true, createdAt: "" };
test("actual owner scope resolves only the original bound person credential and real instance key without writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "n4-owner-"));
  try {
    const original = { centerId: "synthetic-center", teamId: "synthetic-team", projectId: "original", localProjectId: "original" };
    await setSharedLedgerBinding(original, dir);
    const credential: SharedLedgerLocalCredential = { localSubject: "owner:self", kind: "person", centerId: original.centerId, teamId: original.teamId,
      baseUrl: "https://synthetic.example/", personId: "synthetic-person", instanceId: instanceIdSync(dir), bearer: "S".repeat(43),
      projects: [{ projectId: original.projectId, actions: ["read", "project"] }] };
    await writeSharedLedgerCredential(credential, dir);
    const file = join(dir, "shared-ledger-credentials.json"), before = readFileSync(file);
    const result = resolveSharedProjectOwner(owner, original, "project", dir);
    expect(result.person).toEqual({ subject: "owner:self", kind: "person", centerId: original.centerId, teamId: original.teamId,
      personId: credential.personId, instanceId: credential.instanceId });
    expect(result.key.publicKey).toBeTruthy();
    expect(result.credential.bearer).toBe(credential.bearer);
    expect(readFileSync(file)).toEqual(before);
    for (const principal of [{ ...owner, id: "guest:test" }, { ...owner, peer: "peer" }, { ...owner, disabled: true },
      { ...owner, role: "external" as const }, { ...owner, manage: false }, { ...owner, id: "token:old", name: "web-ui" }]) {
      expect(() => resolveSharedProjectOwner(principal, original, "project", dir)).toThrow();
    }
    expect(() => resolveSharedProjectOwner(owner, { ...original, projectId: "new-body-project" }, "read", dir)).toThrow();
    expect(() => resolveSharedProjectOwner(owner, original, "import", dir)).toThrow();
    await writeSharedLedgerCredential({ ...credential, kind: "service" }, dir);
    // An unrelated service credential cannot replace or promote the person's original scoped record.
    expect(resolveSharedProjectOwner(owner, original, "read", dir).person.kind).toBe("person");
    const serviceOnly = { ...original, teamId: "service-only", projectId: "service-only", localProjectId: "service-only" };
    await setSharedLedgerBinding(serviceOnly, dir);
    await writeSharedLedgerCredential({ ...credential, teamId: serviceOnly.teamId, kind: "service",
      projects: [{ projectId: serviceOnly.projectId, actions: ["read", "project"] }] }, dir);
    expect(() => resolveSharedProjectOwner(owner, serviceOnly, "project", dir)).toThrow();
    await writeSharedLedgerCredential({ ...credential, instanceId: "other-instance" }, dir);
    expect(() => resolveSharedProjectOwner(owner, original, "read", dir)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
