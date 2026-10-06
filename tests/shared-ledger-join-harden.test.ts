import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/shared-ledger/store.js";
import { LedgerService } from "../src/shared-ledger/service.js";
import { startServer } from "../src/shared-ledger/server.js";
import { createJoinCode, joinHandler, listJoinCodes, type JoinInvite } from "../src/shared-ledger/join.js";
import { runAdmin } from "../scripts/shared-ledger-admin.js";
import { joinSharedLedger, sharedLedgerInstanceId, signSharedLedgerJoin, SHARED_LEDGER_JOIN_PATH } from "../src/lib/shared-ledger-join.js";
import { signSharedLedgerRequest } from "../src/lib/shared-ledger-auth.js";
import { resolveSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import type { InstanceKey } from "../src/lib/instance-key.js";

const newKey = (): InstanceKey => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
};
const invite = (over: Partial<JoinInvite> = {}): JoinInvite => ({ teamId: "team-a", projectId: "project-a", personId: "peer-a",
  memberCode: "peer-a", role: "member", actions: ["read"], ttlMs: 3_600_000, ...over });
const REJECTED = { code: "join_rejected", message: "Join rejected" };
let root: string, db: string, store: Store, service: LedgerService, server: ReturnType<typeof startServer>, url: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sl-join-harden-"));
  db = join(root, "center.sqlite");
  store = new Store(db);
  service = new LedgerService(store);
  server = startServer(service);
  url = `http://127.0.0.1:${server.port}/`;
});
afterAll(() => { server.stop(true); store.close(); rmSync(root, { recursive: true, force: true }); });


function localState(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ projects: ["project-a", "project-b"].map(id => ({ id, name: id, dirs: [] })) }));
  return dir;
}

const loose = () => joinHandler(store, { perSourcePerMinute: 100_000, perCodePer10Minutes: 100_000 });
async function redeem(h: ReturnType<typeof joinHandler>, code: string, key: InstanceKey, instanceId = sharedLedgerInstanceId(key.publicKey), remote = "peer") {
  const r = h("POST", JSON.stringify(signSharedLedgerJoin(code, instanceId, key)), remote, Date.now());
  return { status: r.status, body: await r.json() as Record<string, any> };
}
/** Signed read with the given bearer, straight against the center service. */
const read = (bearer: string, instanceId: string, key: InstanceKey) => service.handle(signSharedLedgerRequest({ method: "GET",
  path: "/v1/teams/team-a/features", body: "", bearer, instanceId, ts: String(Math.floor(Date.now() / 1000)),
  attemptNonce: randomBytes(16).toString("hex") }, key), Date.now()).status;

describe("instance id squatting", () => {
  test("peer A cannot claim peer B's key-derived instance id; peer B then redeems with its own key", async () => {
    const h = loose(), keyA = newKey(), keyB = newKey();
    const codeA = createJoinCode(store, invite({ personId: "squat-a", memberCode: "squat-a" })).code;
    const codeB = createJoinCode(store, invite({ personId: "squat-b", memberCode: "squat-b" })).code;
    const idB = sharedLedgerInstanceId(keyB.publicKey);
    expect(idB).toMatch(/^sli-[0-9a-f]{24}$/);
    // Peer A signs a perfectly valid proof with its own key, but for peer B's id: refused, and peer A's code stays unused.
    expect(await redeem(h, codeA, keyA, idB)).toEqual({ status: 403, body: REJECTED });
    expect(store.all("SELECT * FROM instance_bindings WHERE instanceId=?", idB)).toEqual([]);
    const b = await redeem(h, codeB, keyB);
    expect(b.status).toBe(200);
    expect(b.body.instanceId).toBe(idB);
    expect(read(b.body.bearer, idB, keyB)).toBe(200);
    // Peer B cannot turn around and take peer A's id either; peer A still joins under its own.
    expect(await redeem(h, codeA, keyB, sharedLedgerInstanceId(keyA.publicKey))).toEqual({ status: 403, body: REJECTED });
    expect((await redeem(h, codeA, keyA)).body.instanceId).toBe(sharedLedgerInstanceId(keyA.publicKey));
  });

  test("the member-side join uses the key-derived id by default", async () => {
    const key = newKey(), dir = localState("derived");
    const code = createJoinCode(store, invite({ personId: "derived", memberCode: "derived" })).code;
    const r = await joinSharedLedger({ localProjectId: "project-a", url, code, key, subject: "owner:self", stateDir: dir });
    expect(resolveSharedLedgerCredential("owner:self", "person", r.centerId, "team-a", "project-a", "read", dir)!.instanceId)
      .toBe(sharedLedgerInstanceId(key.publicKey));
  });
});

describe("join rate limit table", () => {
  test("a full table evicts the least recently seen source instead of refusing every new one", async () => {
    const h = joinHandler(store, { perSourcePerMinute: 2, perCodePer10Minutes: 100_000 });
    const now = Date.now();
    const probe = (remote: string, body = "{") => h("POST", body, remote, now).status;
    expect([probe("oldest"), probe("oldest"), probe("oldest")]).toEqual([403, 403, 429]);
    for (let i = 0; i < 4096; i++) probe(`filler-${i}`);
    // New source, valid code, within its quota: served.
    const code = createJoinCode(store, invite({ personId: "rate-new", memberCode: "rate-new" })).code;
    const key = newKey();
    const fresh = h("POST", JSON.stringify(signSharedLedgerJoin(code, sharedLedgerInstanceId(key.publicKey), key)), "fresh", now);
    expect(fresh.status).toBe(200);
    // "oldest" was evicted, so its counter restarted; a recently seen filler keeps its count.
    expect(probe("oldest")).toBe(403);
    expect([probe("filler-4095"), probe("filler-4095")]).toEqual([403, 429]);
  });

  test("malformed requests are bucketed per source", () => {
    const h = joinHandler(store, { perSourcePerMinute: 100_000, perCodePer10Minutes: 2 });
    const now = Date.now();
    expect(["{", "{", "{"].map((b) => h("POST", b, "noisy", now).status)).toEqual([403, 403, 429]);
    expect(h("POST", "{", "quiet", now).status).toBe(403);
    expect(h("POST", JSON.stringify({ code: 7 }), "quiet", now).status).toBe(403);
  });

  test("forged X-Forwarded-For does not bypass the per-source join limit", async () => {
    // Own server: this test spends the loopback source's whole quota.
    const dir = mkdtempSync(join(root, "xff-")), own = new Store(join(dir, "center.sqlite")), srv = startServer(new LedgerService(own));
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const fake = `sljoin1.center-${"0".repeat(32)}.${randomBytes(16).toString("hex")}.${"A".repeat(43)}`;
      const r = await fetch(`http://127.0.0.1:${srv.port}${SHARED_LEDGER_JOIN_PATH}`, { method: "POST",
        headers: { "x-forwarded-for": `203.0.113.${i}`, "x-real-ip": `198.51.100.${i}` }, body: JSON.stringify({ code: fake }) });
      statuses.push(r.status);
    }
    srv.stop(true); own.close();
    expect(statuses).toEqual([...Array(10).fill(403), 429]);
  });
});

describe("lost confirmation", () => {
  test("the same instance key can retry its redeemed code; the earlier bearer is revoked, other keys stay refused", async () => {
    const h = loose(), key = newKey(), id = sharedLedgerInstanceId(key.publicKey);
    const code = createJoinCode(store, invite({ personId: "retry", memberCode: "retry" })).code;
    const first = await redeem(h, code, key);
    const second = await redeem(h, code, key);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body.bearer).not.toBe(first.body.bearer);
    expect(read(first.body.bearer, id, key)).toBe(403);
    expect(read(second.body.bearer, id, key)).toBe(200);
    expect(store.get<{ n: number }>("SELECT COUNT(*) n FROM credentials WHERE personId='retry' AND revokedAt IS NULL")!.n).toBe(1);
    const other = newKey();
    expect(await redeem(h, code, other, id)).toEqual({ status: 403, body: REJECTED });
    expect(await redeem(h, code, other)).toEqual({ status: 403, body: REJECTED });
  });

  test("a confirmation dropped by the network reports accurately, writes nothing, and the same code then succeeds", async () => {
    const key = newKey(), dir = localState("flaky");
    const code = createJoinCode(store, invite({ personId: "flaky", memberCode: "flaky" })).code;
    let calls = 0;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (++calls === 2) throw new TypeError("network connection lost");
      return fetch(input, init);
    }) as typeof fetch;
    const err = await joinSharedLedger({ localProjectId: "project-a", url, code, key, subject: "owner:self", stateDir: dir, fetch: flaky }).catch((e: Error) => e);
    expect((err as Error).message).toContain("nothing was saved");
    expect((err as Error).message).not.toContain("joined,");
    expect(existsSync(join(dir, "shared-ledger-credentials.json"))).toBe(false);
    const r = await joinSharedLedger({ localProjectId: "project-a", url, code, key, subject: "owner:self", stateDir: dir });
    const credential = resolveSharedLedgerCredential("owner:self", "person", r.centerId, "team-a", "project-a", "read", dir)!;
    expect(read(credential.bearer, credential.instanceId, key)).toBe(200);
    // The bearer dropped with the lost confirmation no longer holds authority: only one live credential remains.
    expect(store.get<{ n: number }>("SELECT COUNT(*) n FROM credentials WHERE personId='flaky' AND revokedAt IS NULL")!.n).toBe(1);
  });
});

describe("member remove / readd", () => {
  test("removal shows pending codes as rejected; readd warns that old bearers come back, --revoke-old revokes them", async () => {
    const h = loose(), key = newKey(), id = sharedLedgerInstanceId(key.publicKey);
    const granted = await redeem(h, createJoinCode(store, invite({ personId: "readd", memberCode: "readd" })).code, key);
    const pending = createJoinCode(store, invite({ personId: "readd", memberCode: "readd", projectId: "project-b" }));
    const status = () => listJoinCodes(store).find((c) => c.id === pending.id)!.status;
    expect(status()).toBe("pending");

    const removed = runAdmin(["member-remove", "--db", db, "--team", "team-a", "--person", "readd"]);
    expect(removed).toMatchObject({ ok: true, changed: true });
    expect(status()).toBe("rejected");
    expect(read(granted.body.bearer, id, key)).toBe(403);

    const readd = runAdmin(["member-readd", "--db", db, "--team", "team-a", "--person", "readd"]);
    expect(readd).toMatchObject({ ok: true, changed: true, revoked: 0 });
    expect(String(readd.note)).toContain("旧 bearer 的授权会一并恢复");
    expect(String(readd.note)).toContain("--revoke-old");
    expect(read(granted.body.bearer, id, key)).toBe(200);
    expect(status()).toBe("pending");

    runAdmin(["member-remove", "--db", db, "--team", "team-a", "--person", "readd"]);
    const fresh = runAdmin(["member-readd", "--db", db, "--team", "team-a", "--person", "readd", "--revoke-old"]);
    expect(fresh).toMatchObject({ ok: true, changed: true, revoked: 1 });
    expect(String(fresh.note)).toContain("旧 bearer 已吊销");
    expect(read(granted.body.bearer, id, key)).toBe(403);
    // A new code still works for the re-added member.
    expect((await redeem(h, pending.code, key)).status).toBe(200);
  });

  test("unknown members and misplaced flags are refused", () => {
    expect(runAdmin(["member-remove", "--db", db, "--team", "team-a", "--person", "nobody"])).toMatchObject({ ok: false, error: "member not found" });
    expect(() => runAdmin(["member-remove", "--db", db, "--team", "team-a", "--person", "readd", "--revoke-old"])).toThrow("member-readd");
  });
});

describe("center identity pinning", () => {
  test("a different URL answering for the pinned center id, confirmation included, cannot replace local credentials", async () => {
    const key = newKey(), dir = localState("pinned");
    const code = createJoinCode(store, invite({ personId: "pinned", memberCode: "pinned" })).code;
    const joined = await joinSharedLedger({ localProjectId: "project-a", url, code, key, subject: "owner:self", stateDir: dir });
    const credential = resolveSharedLedgerCredential("owner:self", "person", joined.centerId, "team-a", "project-a", "read", dir)!;
    const features = await new SharedLedgerClient(credential, key).features();
    const files = ["shared-ledger-credentials.json", "shared-ledger-bindings.json"].map((name) => join(dir, name));
    const before = files.map((path) => readFileSync(path, "utf8"));
    // A malicious center saw a fresh code for this center: it echoes the center id and also answers the confirmation.
    const next = createJoinCode(store, invite({ personId: "pinned", memberCode: "pinned" })).code;
    const evil = (async (input: string | URL | Request) => String(input).endsWith(SHARED_LEDGER_JOIN_PATH)
      ? Response.json({ centerId: joined.centerId, teamId: "team-a", personId: "pinned", instanceId: sharedLedgerInstanceId(key.publicKey),
        bearer: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 60_000, role: "member",
        projects: [{ projectId: "project-a", actions: ["read"] }] })
      : Response.json(features)) as unknown as typeof fetch;
    await expect(joinSharedLedger({ localProjectId: "project-a", url: "https://evil.example/", code: next, key, subject: "owner:self", stateDir: dir, fetch: evil }))
      .rejects.toThrow("does not match the pinned center");
    expect(files.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });
});


describe("P1 enrollment regressions", () => {
  test("malformed JSON codes cannot exhaust another source's code bucket", () => {
    const own = new Store(":memory:");
    try {
      const h = joinHandler(own, { perSourcePerMinute: 100, perCodePer10Minutes: 2 });
      for (const code of ["not.a.code", "sljoin1.bad.shared.bad", 7, null]) {
        const body = JSON.stringify({ code }), source = String(code);
        expect([h("POST", body, `noisy-${source}`, 1).status, h("POST", body, `noisy-${source}`, 1).status,
          h("POST", body, `quiet-${source}`, 1).status]).toEqual([403, 403, 403]);
        expect(h("POST", body, `noisy-${source}`, 1).status).toBe(429);
      }
    } finally { own.close(); }
  });

  test("retry A only revokes its own credential when project B was issued at the same instant", async () => {
    const own = new Store(":memory:"), key = newKey(), now = Date.now();
    try {
      const a = createJoinCode(own, invite(), now), b = createJoinCode(own, invite({ projectId: "project-b" }), now);
      const body = (code: string) => JSON.stringify(signSharedLedgerJoin(code, sharedLedgerInstanceId(key.publicKey), key));
      const h = joinHandler(own, { perSourcePerMinute: 100, perCodePer10Minutes: 100 });
      const first = await h("POST", body(a.code), "peer A", now).json() as { bearer: string };
      const other = await h("POST", body(b.code), "peer A", now).json() as { bearer: string };
      // Recreate the handler: the code-to-credential link must outlive its in-memory rate tables.
      const retry = await joinHandler(own)("POST", body(a.code), "peer A", now + 1).json() as { bearer: string };
      const rows = own.all<{ hash: string; revokedAt: number | null }>("SELECT hash, revokedAt FROM credentials");
      const hash = (bearer: string) => createHash("sha256").update(bearer).digest("hex");
      expect(rows.find((r) => r.hash === hash(first.bearer))!.revokedAt).toBe(now + 1);
      expect(rows.find((r) => r.hash === hash(other.bearer))!.revokedAt).toBeNull();
      expect(rows.find((r) => r.hash === hash(retry.bearer))!.revokedAt).toBeNull();
    } finally { own.close(); }
  });

  test("a service grant with a changed team cannot bypass center and local project pins", async () => {
    const key = newKey(), dir = localState("service-pin");
    const code = createJoinCode(store, invite({ personId: "service-pin", memberCode: "service-pin" })).code;
    const joined = await joinSharedLedger({ localProjectId: "project-a", url, code, key, subject: "owner:self", stateDir: dir });
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
      await expect(joinSharedLedger({ url: target, code, key, subject: "owner:self", stateDir: dir, fetch: evil,
        localProjectId: target === url ? "project-a" : "project-b" })).rejects.toThrow("nothing was saved");
      expect(files.map((path) => readFileSync(path))).toEqual(before);
    }
  });
});
