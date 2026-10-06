import { EnrollmentResponses } from "./shared-ledger-migration-http-fixture.ts";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinSharedLedger, parseSharedLedgerJoinCode } from "../src/lib/shared-ledger-join.js";
import { resolveSharedLedgerCredential, writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { readSharedLedgerBindings } from "../src/lib/shared-ledger-gate-bindings.js";
import { SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import type { InstanceKey } from "../src/lib/instance-key.js";

const newKey = (): InstanceKey => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
};
const scrub = { identity: { username: "nobody-local", hostname: "nobody-host" } };
let root: string, responses: EnrollmentResponses, url: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sl-migration-http-"));
  responses = new EnrollmentResponses();
  url = responses.url;
});
afterAll(() => { responses.close(); rmSync(root, { recursive: true, force: true }); });

const admin = (...args: string[]) => {
  const value = (flag: string, fallback: string) => args.includes(flag) ? args[args.indexOf(flag) + 1]! : fallback;
  return responses.invite({ projectId: value("--project", "project-a"), personId: value("--person", "peer-a"),
    role: value("--role", "member") as "member" | "service", actions: value("--actions", "read").split(",") as ("read" | "plan")[] });
};

describe("shared ledger enrollment end to end", () => {
  test("failed center confirmation preserves existing credentials and bindings", async () => {
    const dir = join(root, "state-confirm"), key = newKey(), instanceId = "instance-confirm", subject = "owner:self";
    const first = admin("--person", "peer-confirm", "--code", "peer-confirm", "--role", "member", "--actions", "read");
    const joined = await joinSharedLedger({ url, code: String(first.joinCode), key, instanceId, subject, stateDir: dir });
    const files = ["shared-ledger-credentials.json", "shared-ledger-bindings.json"].map((name) => join(dir, name));
    const before = files.map((path) => readFileSync(path, "utf8"));
    let calls = 0;
    const fakeFetch = (async () => ++calls === 1 ? Response.json({ centerId: joined.centerId, teamId: "team-a", personId: "peer-other",
      instanceId, bearer: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 60_000, role: "member",
      projects: [{ projectId: "project-a", actions: ["read"] }] }) : Response.json({}, { status: 403 })) as unknown as typeof fetch;
    await expect(joinSharedLedger({ url: "https://other.example/", code: String(first.joinCode), key, instanceId, subject,
      stateDir: dir, fetch: fakeFetch })).rejects.toThrow("center did not accept");
    expect(calls).toBe(2);
    expect(files.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  test("legacy single-project credentials remain readable and replacement is project scoped", async () => {
    const dir = mkdtempSync(join(root, "legacy-"));
    const credential = { localSubject: "owner:self", kind: "person" as const, centerId: "center-a", baseUrl: url,
      teamId: "team-a", personId: "peer-a", instanceId: "instance-a", bearer: "legacy-bearer",
      projects: [{ projectId: "project-a", actions: ["read" as const] }] };
    writeFileSync(join(dir, "shared-ledger-credentials.json"), JSON.stringify({ credentials: [credential] }), { mode: 0o600 });
    const resolve = (projectId: string) => resolveSharedLedgerCredential("owner:self", "person", "center-a", "team-a", projectId, "read", dir);
    expect(resolve("project-a")).toEqual(credential);
    await writeSharedLedgerCredential({ ...credential, bearer: "b-bearer", projects: [{ projectId: "project-b", actions: ["read"] }] }, dir);
    await writeSharedLedgerCredential({ ...credential, bearer: "new-a-bearer" }, dir);
    expect(resolve("project-a")!.bearer).toBe("new-a-bearer");
    expect(resolve("project-b")!.bearer).toBe("b-bearer");
    expect(resolve("project-c")).toBeNull();
  });

  test("same subject joins A then B and reads both while unjoined C is refused", async () => {
    const dir = join(root, "state-multi"), key = newKey(), subject = "owner:self", instanceId = "instance-multi";
    let centerId = "";
    const features: string[] = [];
    for (const projectId of ["project-a", "project-b"]) {
      const invite = admin("--project", projectId, "--person", "peer-multi", "--code", "peer-multi",
        "--role", "member", "--actions", "read,plan");
      const result = await joinSharedLedger({ url, code: String(invite.joinCode), key, instanceId, subject, stateDir: dir });
      centerId = result.centerId;
      const credential = resolveSharedLedgerCredential(subject, "person", centerId, "team-a", projectId, "plan", dir)!;
      const created = await new SharedLedgerClient(credential, key, { scrub }).command({ type: "feature.new", projectId,
        requestId: randomBytes(6).toString("hex"), title: projectId, description: "Shared plan", homeInstanceId: instanceId });
      features.push((created as { result: { featureId: string } }).result.featureId);
    }
    const credentials = ["project-a", "project-b"].map((projectId) =>
      resolveSharedLedgerCredential(subject, "person", centerId, "team-a", projectId, "read", dir));
    for (const [i, credential] of credentials.entries()) {
      expect(credential).not.toBeNull();
      const client = new SharedLedgerClient(credential!, key);
      expect((await client.feature(features[i]!)).feature.projectId).toBe(i === 0 ? "project-a" : "project-b");
      await expect(client.feature(features[1 - i]!)).rejects.toMatchObject({ status: 403 });
    }
    expect(credentials[0]!.bearer).not.toBe(credentials[1]!.bearer);
    expect(resolveSharedLedgerCredential(subject, "person", centerId, "team-a", "project-c", "read", dir)).toBeNull();
  });

  test("two members enroll from isolated state dirs and read the same project; a third instance is refused", async () => {
    const logs: string[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((m) => spyOn(console, m).mockImplementation((...a) => { logs.push(a.join(" ")); }));
    try {
      const a = admin("--person", "peer-a", "--code", "peer-a", "--role", "member", "--actions", "read,plan");
      const b = admin("--person", "peer-b", "--code", "peer-b", "--role", "member", "--actions", "read");
      expect(a.ok && b.ok).toBe(true);
      const codes = [String(a.joinCode), String(b.joinCode)];


      const members = await Promise.all(["a", "b"].map(async (n, i) => {
        const dir = join(root, `state-${n}`), key = newKey(), instanceId = `instance-${n}`;
        const result = await joinSharedLedger({ url, code: codes[i]!, key, instanceId, subject: "owner:self", stateDir: dir });
        return { dir, key, instanceId, result };
      }));
      const bearers: string[] = [];
      for (const m of members) {
        const file = join(m.dir, "shared-ledger-credentials.json");
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(join(m.dir, "shared-ledger-bindings.json")).mode & 0o777).toBe(0o600);
        expect(readSharedLedgerBindings(m.dir)).toEqual([{ centerId: m.result.centerId, teamId: "team-a", projectId: "project-a", localProjectId: "project-a" }]);
        expect(m.result).toMatchObject({ teamId: "team-a", projectId: "project-a", kind: "person", identities: 1 });
        expect(JSON.stringify(m.result)).not.toMatch(/bearer|sljoin1/);
        bearers.push(resolveSharedLedgerCredential("owner:self", "person", m.result.centerId, "team-a", "project-a", "read", m.dir)!.bearer);
      }
      const [ma, mb] = members as [typeof members[0], typeof members[0]];
      const credA = resolveSharedLedgerCredential("owner:self", "person", ma.result.centerId, "team-a", "project-a", "plan", ma.dir)!;
      const created = await new SharedLedgerClient(credA, ma.key, { scrub }).command({ type: "feature.new", projectId: "project-a",
        requestId: randomBytes(6).toString("hex"), title: "Shared plan", description: "Visible to both", homeInstanceId: ma.instanceId });
      const credB = resolveSharedLedgerCredential("owner:self", "person", mb.result.centerId, "team-a", "project-a", "read", mb.dir)!;
      const seenByB = await new SharedLedgerClient(credB, mb.key).features();
      expect(seenByB.features.map((f) => f.id)).toContain((created as { result: { featureId: string } }).result.featureId);
      // peer B holds read only: no plan authority.
      expect(resolveSharedLedgerCredential("owner:self", "person", mb.result.centerId, "team-a", "project-a", "plan", mb.dir)).toBeNull();

      // Third instance: no join code. Reusing peer A's code (already redeemed) and a forged code both fail.
      const third = join(root, "state-c");
      responses.deniedCodes.add(codes[0]!);
      for (const code of [codes[0]!, `sljoin1.${ma.result.centerId}.${"a".repeat(32)}.${"A".repeat(43)}`]) {
        await expect(joinSharedLedger({ url, code, key: newKey(), instanceId: "instance-c", subject: "owner:self", stateDir: third }))
          .rejects.toThrow("join rejected");
      }
      const forged = new SharedLedgerClient({ ...credB, instanceId: "instance-c", bearer: randomBytes(32).toString("base64url") }, newKey());
      await expect(forged.features()).rejects.toMatchObject({ status: 403 });

      // Secrets never reach logs, output or ledger events.
      for (const s of [...codes, ...bearers]) {
        expect(logs.join("\n").includes(s)).toBe(false);
      }
    } finally { for (const s of spies) s.mockRestore(); }
  });

  test("owner service identity enrolls through the same join path", async () => {
    const s = admin("--person", "owner-service", "--code", "owner-svc", "--role", "service", "--actions", "read,plan,import,project");
    const dir = join(root, "state-svc");
    const r = await joinSharedLedger({ url, code: String(s.joinCode), key: newKey(), instanceId: "instance-svc", subject: "importer", stateDir: dir });
    expect(r.kind).toBe("service");
    expect(resolveSharedLedgerCredential("importer", "service", r.centerId, "team-a", "project-a", "import", dir)).not.toBeNull();
  });
});
