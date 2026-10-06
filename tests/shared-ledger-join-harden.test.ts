import { EnrollmentResponses } from "./shared-ledger-migration-http-fixture.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinSharedLedger, sharedLedgerInstanceId, signSharedLedgerJoin, SHARED_LEDGER_JOIN_PATH } from "../src/lib/shared-ledger-join.js";
import { signSharedLedgerRequest } from "../src/lib/shared-ledger-auth.js";
import { resolveSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import { writeProjects } from "../src/lib/projects.js";
import type { InstanceKey } from "../src/lib/instance-key.js";

// Explicit choices reference legitimate local projects; no product setter manufactures missing targets.
async function joinFixture(input: Parameters<typeof joinSharedLedger>[0]) {
  await writeProjects({ projects: ["project-a", "project-b"].map(id => ({ id, name: id, dirs: [], createdAt: "" })) },
    join(input.stateDir!, "projects.json"));
  return joinSharedLedger({ ...input, localProjectId: input.localProjectId ?? "project-a" });
}

const newKey = (): InstanceKey => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
};
let root: string, responses: EnrollmentResponses, url: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sl-join-harden-consumer-"));
  responses = new EnrollmentResponses();
  url = responses.url;
});
afterAll(() => { responses.close(); rmSync(root, { recursive: true, force: true }); });

test("missing choice and nonexistent/personal local projects never redeem or alter existing credential bytes", async () => {
  const dir = mkdtempSync(join(root, "preflight-")), key = newKey();
  const { writeFileSync } = await import("node:fs");
  const file = join(dir, "shared-ledger-credentials.json"), before = Buffer.from("fixture unchanged credentials\n");
  writeFileSync(file, before, { mode: 0o600 });
  await writeProjects({ projects: [{ id: "personal", name: "Personal", personal: true, dirs: [], createdAt: "" }] }, join(dir, "projects.json"));
  let calls = 0;
  const fetcher = (async () => { calls++; throw new Error("must not redeem"); }) as unknown as typeof fetch;
  const code = responses.invite({ personId: "preflight" }).joinCode;
  for (const localProjectId of [undefined, "missing", "personal"]) {
    await expect(joinSharedLedger({ url, code, key, subject: "owner:self", stateDir: dir, localProjectId, fetch: fetcher,
      expectedProject: { centerId: code.split(".")[1]!, teamId: "team-a", projectId: "project-a", name: "Project A" } })).rejects.toThrow();
    expect(readFileSync(file)).toEqual(before);
    expect(existsSync(join(dir, "shared-ledger-bindings.json"))).toBe(false);
  }
  expect(calls).toBe(0);
});

test("a central-project collision after redemption preserves the original credential and binding bytes", async () => {
  const dir = mkdtempSync(join(root, "collision-")), key = newKey();
  const code = responses.invite({ personId: "collision" }).joinCode;
  await joinFixture({ url, code, key, subject: "owner:self", stateDir: dir });
  const files = ["shared-ledger-credentials.json", "shared-ledger-bindings.json"].map(f => join(dir, f));
  const before = files.map(f => readFileSync(f));
  await expect(joinSharedLedger({ url, code, key, subject: "owner:self", stateDir: dir, localProjectId: "project-b" })).rejects.toThrow("pinned center");
  expect(files.map(f => readFileSync(f))).toEqual(before);
});

describe("instance id squatting", () => {
  ;

  test("the member-side join uses the key-derived id by default", async () => {
    const key = newKey(), dir = join(root, "derived");
    const code = responses.invite({ personId: "derived" }).joinCode;
    const r = await joinFixture({ url, code, key, subject: "owner:self", stateDir: dir });
    expect(resolveSharedLedgerCredential("owner:self", "person", r.centerId, "team-a", "project-a", "read", dir)!.instanceId)
      .toBe(sharedLedgerInstanceId(key.publicKey));
  });
});


describe("lost confirmation", () => {
  ;

  test("a confirmation dropped by the network reports accurately, writes nothing, and the same code then succeeds", async () => {
    const key = newKey(), dir = join(root, "flaky");
    const code = responses.invite({ personId: "flaky" }).joinCode;
    let calls = 0;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (++calls === 2) throw new TypeError("network connection lost");
      return fetch(input, init);
    }) as typeof fetch;
    const err = await joinFixture({ url, code, key, subject: "owner:self", stateDir: dir, fetch: flaky }).catch((e: Error) => e);
    expect((err as Error).message).toContain("nothing was saved");
    expect((err as Error).message).not.toContain("joined,");
    expect(existsSync(join(dir, "shared-ledger-credentials.json"))).toBe(false);
    const r = await joinFixture({ url, code, key, subject: "owner:self", stateDir: dir });
    const credential = resolveSharedLedgerCredential("owner:self", "person", r.centerId, "team-a", "project-a", "read", dir)!;
    expect((await new SharedLedgerClient(credential, key).features()).features).toEqual([]);
    // The bearer dropped with the lost confirmation no longer holds authority: only one live credential remains.
  });
});


describe("center identity pinning", () => {
  test("a different URL answering for the pinned center id, confirmation included, cannot replace local credentials", async () => {
    const key = newKey(), dir = join(root, "pinned");
    const code = responses.invite({ personId: "pinned" }).joinCode;
    const joined = await joinFixture({ url, code, key, subject: "owner:self", stateDir: dir });
    const credential = resolveSharedLedgerCredential("owner:self", "person", joined.centerId, "team-a", "project-a", "read", dir)!;
    const features = await new SharedLedgerClient(credential, key).features();
    const files = ["shared-ledger-credentials.json", "shared-ledger-bindings.json"].map((name) => join(dir, name));
    const before = files.map((path) => readFileSync(path, "utf8"));
    // A malicious center saw a fresh code for this center: it echoes the center id and also answers the confirmation.
    const next = responses.invite({ personId: "pinned" }).joinCode;
    const evil = (async (input: string | URL | Request) => String(input).endsWith(SHARED_LEDGER_JOIN_PATH)
      ? Response.json({ centerId: joined.centerId, teamId: "team-a", personId: "pinned", instanceId: sharedLedgerInstanceId(key.publicKey),
        bearer: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 60_000, role: "member",
        projects: [{ projectId: "project-a", actions: ["read"] }] })
      : Response.json(features)) as unknown as typeof fetch;
    await expect(joinFixture({ url: "https://evil.example/", code: next, key, subject: "owner:self", stateDir: dir, fetch: evil }))
      .rejects.toThrow("does not match the pinned center");
    expect(files.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });
});


describe("P1 enrollment regressions", () => {
  ;

  ;

  test("a service grant with a changed team cannot bypass center and local project pins", async () => {
    const key = newKey(), dir = join(root, "service-pin");
    const code = responses.invite({ personId: "service-pin" }).joinCode;
    const joined = await joinFixture({ url, code, key, subject: "owner:self", stateDir: dir });
    const files = ["shared-ledger-credentials.json", "shared-ledger-bindings.json"].map((name) => join(dir, name));
    const before = files.map((path) => readFileSync(path));
    const credential = resolveSharedLedgerCredential("owner:self", "person", joined.centerId, "team-a", "project-a", "read", dir)!;
    const features = await new SharedLedgerClient(credential, key).features();
    const evil = (async (input: string | URL | Request) => String(input).endsWith(SHARED_LEDGER_JOIN_PATH)
      ? Response.json({ centerId: joined.centerId, teamId: "team-b", personId: "service-pin", instanceId: credential.instanceId,
        bearer: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 60_000, role: "service",
        projects: [{ projectId: "project-a", actions: ["read"] }] })
      : Response.json({ ...features, teamId: "team-b" })) as unknown as typeof fetch;
    for (const target of ["https://evil.example/", url]) {
      await expect(joinFixture({ url: target, code, key, subject: "owner:self", stateDir: dir, fetch: evil,
        localProjectId: target === url ? "project-a" : "project-b" })).rejects.toThrow("nothing was saved");
      expect(files.map((path) => readFileSync(path))).toEqual(before);
    }
  });
});
