import { describe, expect, test, afterEach } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/shared-ledger/store.js";
import { LedgerService } from "../src/shared-ledger/service.js";
import { createHandler } from "../src/shared-ledger/server.js";
import { checkJoinGrant, createJoinCode, joinHandler, listJoinCodes, revokeJoinCode, type JoinInvite } from "../src/shared-ledger/join.js";
import { signSharedLedgerJoin, parseSharedLedgerJoinCode, SHARED_LEDGER_JOIN_PATH } from "../src/lib/shared-ledger-join.js";
import { signSharedLedgerRequest } from "../src/lib/shared-ledger-auth.js";
import type { InstanceKey } from "../src/lib/instance-key.js";
import { sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.js";
import { fixture } from "./shared-ledger-server-fixture.test.js";

const newKey = (): InstanceKey => {
  const pair = generateKeyPairSync("ed25519");
  return { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
};
const invite = (over: Partial<JoinInvite> = {}): JoinInvite => ({ teamId: "team-a", projectId: "project-a", personId: "peer-a",
  memberCode: "peer-a", role: "member", actions: ["read", "plan"], ttlMs: 3_600_000, ...over });
const dirs: string[] = [];
function center() {
  const dir = mkdtempSync(join(tmpdir(), "sl-join-"));
  dirs.push(dir);
  const path = join(dir, "center.sqlite");
  const store = new Store(path);
  return { store, path, handle: joinHandler(store, { perSourcePerMinute: 1000, perCodePer10Minutes: 1000 }) };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const body = (code: string, key = newKey(), instanceId = "instance-a") => JSON.stringify(signSharedLedgerJoin(code, instanceId, key));
async function send(h: ReturnType<typeof center>["handle"], b: string, now = Date.now(), remote = "peer") {
  const r = h("POST", b, remote, now);
  return { status: r.status, body: await r.json() as Record<string, any> };
}
const REJECTED = { status: 403, body: { code: "join_rejected", message: "Join rejected" } };

describe("shared ledger join codes (center)", () => {
  test("one-time: second redeem and redeem with a fresh key are rejected identically", async () => {
    const c = center();
    const { code } = createJoinCode(c.store, invite());
    const ok = await send(c.handle, body(code));
    expect(ok.status).toBe(200);
    expect(ok.body.bearer).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await send(c.handle, body(code))).toEqual(REJECTED);
    expect(await send(c.handle, body(code, newKey(), "instance-b"))).toEqual(REJECTED);
    expect(listJoinCodes(c.store)[0]).toMatchObject({ status: "used", instanceId: "instance-a" });
  });

  test("expired, revoked, wrong secret, wrong center, bad signature and swapped key all return one error", async () => {
    const c = center();
    const now = Date.now();
    const expired = createJoinCode(c.store, invite({ ttlMs: 60_000 }), now - 120_000).code;
    const revoked = createJoinCode(c.store, invite());
    expect(revokeJoinCode(c.store, revoked.id)).toBe(true);
    const live = createJoinCode(c.store, invite()).code;
    const p = parseSharedLedgerJoinCode(live)!;
    const wrongSecret = `sljoin1.${p.centerId}.${p.codeId}.${randomBytes(32).toString("base64url")}`;
    const wrongCenter = `sljoin1.center-${"0".repeat(32)}.${p.codeId}.${p.secret}`;
    const a = newKey(), b = newKey();
    const swapped = { ...signSharedLedgerJoin(live, "instance-a", a), publicKey: b.publicKey };
    const otherInstance = { ...signSharedLedgerJoin(live, "instance-a", a), instanceId: "instance-z" };
    const forgedSig = { ...signSharedLedgerJoin(live, "instance-a", a), signature: signSharedLedgerJoin(live, "instance-a", b).signature };
    const unknown = `sljoin1.${p.centerId}.${"f".repeat(32)}.${p.secret}`;
    for (const b2 of [body(expired), body(revoked.code), body(wrongSecret), body(wrongCenter), body(unknown), JSON.stringify(swapped),
      JSON.stringify(otherInstance), JSON.stringify(forgedSig), "{", JSON.stringify({ ...swapped, extra: "x" })]) {
      expect(await send(c.handle, b2, now)).toEqual(REJECTED);
    }
    expect(c.handle("GET", "", "peer", now).status).toBe(403);
    // None of the rejected attempts consumed the live code.
    expect((await send(c.handle, body(live, a), now)).status).toBe(200);
  });

  test("rate limits apply per source and per claimed code id", async () => {
    const c = center();
    const h = joinHandler(c.store, { perSourcePerMinute: 3, perCodePer10Minutes: 2 });
    const now = Date.now();
    const code = createJoinCode(c.store, invite()).code;
    const bad = code.slice(0, -4) + "AAAA";
    expect((await send(h, body(bad), now, "s1")).status).toBe(403);
    expect((await send(h, body(bad), now, "s2")).status).toBe(403);
    const limited = await send(h, body(code), now, "s3");
    expect(limited.status).toBe(429);
    expect(limited.body.bearer).toBeUndefined();
    const other = createJoinCode(c.store, invite({ personId: "peer-b", memberCode: "peer-b" })).code;
    for (let i = 0; i < 3; i++) await send(h, "{", now, "s4");
    expect((await send(h, body(other), now, "s4")).status).toBe(429);
    expect((await send(h, body(other), now + 61_000, "s4")).status).toBe(200);
  });

  test("the store keeps no plaintext join secret or bearer", async () => {
    const c = center();
    const { code } = createJoinCode(c.store, invite());
    const ok = await send(c.handle, body(code));
    c.store.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const dump = readFileSync(c.path).toString("latin1");
    const secret = parseSharedLedgerJoinCode(code)!.secret;
    for (const v of [secret, code, ok.body.bearer]) {
      expect(dump.includes(v)).toBe(false);
      for (const t of ["join_codes", "credentials", "events", "members", "instance_bindings"]) {
        expect(JSON.stringify(c.store.all(`SELECT * FROM ${t}`)).includes(v)).toBe(false);
      }
    }
  });

  test("enrollment never grants wildcard, owner, merge/release/grant/remote or member import", () => {
    const c = center();
    for (const bad of [invite({ projectId: "*" }), invite({ role: "owner" as "member" }), invite({ actions: ["read", "merge"] }),
      invite({ actions: ["read", "release"] }), invite({ actions: ["read", "grant"] }), invite({ actions: ["read", "remote"] }),
      invite({ actions: ["read", "import"] }), invite({ actions: ["plan"] }), invite({ actions: [] }), invite({ ttlMs: 31 * 86_400_000 }),
      invite({ role: "service", actions: ["read", "admin"] })]) {
      expect(() => createJoinCode(c.store, bad)).toThrow();
    }
    expect(c.store.all("SELECT * FROM join_codes")).toEqual([]);
    expect(() => checkJoinGrant("service", "project-a", ["read", "plan", "import", "project"])).not.toThrow();
  });

  test("a tampered stored grant is not issued; an instance cannot be rebound to another person or key", async () => {
    const c = center();
    const t = createJoinCode(c.store, invite());
    c.store.run("UPDATE join_codes SET actions=? WHERE id=?", JSON.stringify(["read", "merge"]), t.id);
    expect(await send(c.handle, body(t.code))).toEqual(REJECTED);
    const a = createJoinCode(c.store, invite({ personId: "peer-x", memberCode: "peer-x" })).code;
    expect((await send(c.handle, body(a, newKey(), "instance-shared"))).status).toBe(200);
    const b = createJoinCode(c.store, invite({ personId: "peer-y", memberCode: "peer-y" })).code;
    expect(await send(c.handle, body(b, newKey(), "instance-shared"))).toEqual(REJECTED);
  });

  test("joined member hits C1 policy: import and projection are forbidden", async () => {
    const f = fixture();
    try {
      const key = newKey();
      const { code } = createJoinCode(f.store, invite());
      const grant = (await send(joinHandler(f.store), body(code, key))).body;
      const m = f.manifest();
      const payloads = { imports: { mode: "commit", batchId: "batch-j", manifestDigest: sharedLedgerManifestDigest(m), manifest: m },
        projections: f.projection("feature-x") };
      for (const [resource, payload] of Object.entries(payloads)) {
        const attemptNonce = randomBytes(16).toString("hex");
        const req = signSharedLedgerRequest({ method: "POST", path: `/v1/teams/team-a/${resource}`, body: JSON.stringify({ attemptNonce, payload }),
          bearer: grant.bearer, instanceId: grant.instanceId, ts: String(Math.floor(f.now / 1000)), attemptNonce }, key);
        expect(f.service.handle(req, f.now)).toMatchObject({ status: 403 });
      }
    } finally { f.cleanup(); }
  });

  test("server route is mounted at the join path", async () => {
    const c = center();
    const handler = createHandler(new LedgerService(c.store));
    const { code } = createJoinCode(c.store, invite());
    const r = await handler(new Request(`http://127.0.0.1${SHARED_LEDGER_JOIN_PATH}`, { method: "POST", body: body(code) }));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});
