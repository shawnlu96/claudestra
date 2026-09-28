/**
 * 设备配对与凭据的 HTTP 面（src/bridge/devices.ts + src/bridge/api-auth.ts），principals.json 指到临时目录。
 * 负向用例先写：隧道来源打不到本机配对、没有 CSRF 头的写请求、guest / 受限凭据碰管理端点、撤销后立刻失效、短码穷举限流。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setApiAuthPrincipalsPathForTest, authenticateApi } from "../src/bridge/api-auth.js";
import {
  decideApproval, handleDevicesManaged, handleDevicesPublic, issuePairing, pendingApprovals, setDevicesPrincipalsPathForTest, setDevicesRegistryPathForTest,
} from "../src/bridge/devices.js";
import { setRequestContext, type RequestContext } from "../src/bridge/request-context.js";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { proofFor } from "../src/lib/pairing-codes.js";
import { readPrincipalsStrict, type Principal } from "../src/lib/principals.js";

const FP = "16f9-b5d1-30fb-8923";
const RELAY: RequestContext = { source: "relay", clientIp: "203.0.113.9", relayBase: "relay.test", pathPrefix: `/m/${FP}`, https: true };
const LOOPBACK: RequestContext = { source: "loopback", clientIp: "127.0.0.1", https: false };
const LAN: RequestContext = { source: "lan", clientIp: "192.168.1.9", https: false };
const machine = { url: "https://mini.relay.test", base: "relay.test", slug: "mini", fp: FP };

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "devices-"));
  setDevicesPrincipalsPathForTest(join(dir, "principals.json"));
  setApiAuthPrincipalsPathForTest(join(dir, "principals.json"));
  writeFileSync(join(dir, "registry.json"), JSON.stringify({ agents: { "agent-worker-a": {} } })); // guest 只能开放 registry 里有的名字
  setDevicesRegistryPathForTest(join(dir, "registry.json"));
});
afterAll(() => {
  setDevicesPrincipalsPathForTest(undefined);
  setApiAuthPrincipalsPathForTest(undefined);
  setDevicesRegistryPathForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

function req(method: string, path: string, ctx: RequestContext, init: { body?: unknown; headers?: Record<string, string> } = {}): Request {
  const r = new Request(`http://bridge.local${path}`, {
    method,
    headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  setRequestContext(r, ctx);
  return r;
}
const pub = (method: string, path: string, ctx: RequestContext, init?: { body?: unknown; headers?: Record<string, string> }) => {
  const r = req(method, path, ctx, init);
  return handleDevicesPublic(r, new URL(r.url));
};
const secretOf = (info: Record<string, unknown>) => String(info.link).split("#")[1].split(".")[1];
const cookieOf = (res: Response) => res.headers.getSetCookie()[0];
const cookiePair = (res: Response) => cookieOf(res).split(";")[0];
async function auth(cookie: string, ctx: RequestContext, method = "GET", extra: Record<string, string> = {}): Promise<Principal | Response> {
  const r = req(method, "/api/v1/agents", ctx, { headers: { cookie, ...extra } });
  return authenticateApi(r, new URL(r.url), { rateLimit: false });
}

describe("二维码配对（挑战应答）", () => {
  test("秘密只在链接的 # 里；挑战一次性；配对成功签 owner:self 的凭据，cookie Path 带机器前缀、Secure", async () => {
    const info = issuePairing(machine, {});
    expect(info.url).toBe(`https://mini.relay.test/pair#${info.code}`);
    expect(String(info.link)).toMatch(new RegExp(`^https://relay.test/pair#${FP}\\.[A-Za-z0-9_-]{22}$`));
    expect(info.grant).toEqual({ agents: ["*", "master"], terminal: true, manage: true });
    const ch = (await (await pub("GET", "/api/v1/devices/pair/challenge", RELAY))!.json()) as { challenge: string; fp: string };
    expect(ch.fp).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    const res = (await pub("POST", "/api/v1/devices/pair", RELAY, { body: { proof: { challenge: ch.challenge, hmac: proofFor(secretOf(info), ch.challenge) }, deviceName: "iPhone" } }))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, principalId: OWNER_PRINCIPAL_ID, grant: { agents: ["*", "master"], terminal: true, manage: true } });
    expect(cookieOf(res)).toMatch(new RegExp(`^cstra_dev=dev_[A-Za-z0-9_-]+; Path=/m/${FP}/; Max-Age=7776000; HttpOnly; SameSite=Strict; Secure$`));
    expect(JSON.stringify(await readPrincipalsStrict(join(dir, "principals.json")))).not.toContain(cookiePair(res).slice("cstra_dev=".length));
    // 同一个挑战不能再用
    const again = (await pub("POST", "/api/v1/devices/pair", RELAY, { body: { proof: { challenge: ch.challenge, hmac: proofFor(secretOf(info), ch.challenge) } } }))!;
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ code: "challenge_invalid" });
    // 拿这个 cookie 鉴权：owner 视图；写请求要带 x-cstra-device
    const p = (await auth(cookiePair(res), RELAY)) as Principal;
    expect(p).toMatchObject({ id: OWNER_PRINCIPAL_ID, role: "owner", agents: ["*", "master"], terminal: true, manage: true });
    const noCsrf = (await auth(cookiePair(res), RELAY, "POST")) as Response;
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toMatchObject({ code: "csrf" });
    expect((await auth(cookiePair(res), RELAY, "POST", { "x-cstra-device": "1" })) as Principal).toMatchObject({ id: OWNER_PRINCIPAL_ID });
  });

});

describe("手输短码：进待确认，Mac 侧点头才发凭据", () => {
  test("pending → approve → 轮询取到凭据（只给一次）；拒绝 → 410", async () => {
    const info = issuePairing(machine, { agents: ["worker-a"], terminal: false, manage: false });
    const r = (await pub("POST", "/api/v1/devices/pair", RELAY, { body: { code: String(info.display).toLowerCase(), deviceName: "iPad" } }))!;
    expect(r.status).toBe(202);
    const { approvalId } = (await r.json()) as { approvalId: string };
    expect(pendingApprovals()).toMatchObject([{ id: approvalId, deviceName: "iPad", clientIp: "203.0.113.9", grant: { agents: ["worker-a"], terminal: false, manage: false } }]);
    expect((await pub("GET", `/api/v1/devices/pair/status?approval=${approvalId}`, RELAY))!.status).toBe(202);
    expect(await decideApproval(approvalId, true)).toMatchObject({ ok: true, state: "approved", principalId: OWNER_PRINCIPAL_ID });
    expect(await decideApproval(approvalId, true)).toBeNull();
    const got = (await pub("GET", `/api/v1/devices/pair/status?approval=${approvalId}`, RELAY))!;
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ ok: true, grant: { agents: ["worker-a"], terminal: false, manage: false } });
    expect((await pub("GET", `/api/v1/devices/pair/status?approval=${approvalId}`, RELAY))!.status).toBe(410);
    // 受限凭据：agents 收窄、终端关、管理关 → 管理端点 403
    const p = (await auth(cookiePair(got), RELAY)) as Principal;
    expect(p).toMatchObject({ id: OWNER_PRINCIPAL_ID, role: "external", agents: ["worker-a"], terminal: false, manage: false });
    const list = await handleDevicesManaged(req("GET", "/api/v1/devices", RELAY), new URL("http://x/api/v1/devices"), p);
    expect(list!.status).toBe(403);
    // 拒绝
    const info2 = issuePairing(machine, {});
    const r2 = (await pub("POST", "/api/v1/devices/pair", RELAY, { body: { code: info2.code } }))!;
    const { approvalId: id2 } = (await r2.json()) as { approvalId: string };
    expect(await decideApproval(id2, false)).toMatchObject({ state: "denied" });
    const denied = (await pub("GET", `/api/v1/devices/pair/status?approval=${id2}`, RELAY))!;
    expect(denied.status).toBe(410);
    expect(await denied.json()).toMatchObject({ state: "denied" });
    expect((await pub("GET", "/api/v1/devices/pair/status?approval=nope", RELAY))!.status).toBe(410);
  });

  test("guest 码：凭据挂到新的 guest principal，不含 master、无终端、无管理", async () => {
    const info = issuePairing(machine, { guest: "Alice", agents: ["worker-a", "master"], terminal: true });
    expect(info).toMatchObject({ guest: "Alice", grant: { agents: ["worker-a"], terminal: false, manage: false } });
    const ch = (await (await pub("GET", "/api/v1/devices/pair/challenge", RELAY))!.json()) as { challenge: string };
    const res = (await pub("POST", "/api/v1/devices/pair", RELAY, { body: { proof: { challenge: ch.challenge, hmac: proofFor(secretOf(info), ch.challenge) }, deviceName: "Alice 的手机" } }))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principalId: string };
    expect(body.principalId.startsWith("guest:")).toBe(true);
    const p = (await auth(cookiePair(res), RELAY)) as Principal;
    expect(p).toMatchObject({ id: body.principalId, role: "external", name: "Alice", agents: ["worker-a"], manage: false });
    // guest 只能撤自己（= 退出登录），撤完 principal 停用、cookie 立刻无效
    const own = await handleDevicesManaged(req("DELETE", `/api/v1/devices/${p.credential}`, RELAY), new URL(`http://x/api/v1/devices/${p.credential}`), p);
    expect(own!.status).toBe(200);
    expect(cookieOf(own!)).toContain("cstra_dev=; Path=/m/");
    const after = (await auth(cookiePair(res), RELAY)) as Response;
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ code: "device_invalid" });
  });
});

describe("网页里批准配对（管理端点）", () => {
  const owner: Principal = { id: OWNER_PRINCIPAL_ID, role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", credential: "dev_owner" };
  const managed = async (method: string, path: string, body?: unknown, p: Principal = owner) =>
    (await handleDevicesManaged(req(method, path, RELAY, body === undefined ? {} : { body }), new URL(`http://x${path}`), p))!;
  test("列表带还没用掉的码；码被输入后进待确认、不再算「没用掉」；网页批准即发凭据", async () => {
    const info = issuePairing(machine, { guest: "Alex", agents: ["worker-a"] });
    const code = String(info.code);
    const before = (await (await managed("GET", "/api/v1/devices/approvals")).json()) as { activeCodes: string[] };
    expect(before.activeCodes).toContain(code);
    const r = (await pub("POST", "/api/v1/devices/pair", RELAY, { body: { code, deviceName: "Alex iPhone" } }))!;
    const { approvalId } = (await r.json()) as { approvalId: string };
    const mid = (await (await managed("GET", "/api/v1/devices/approvals")).json()) as { activeCodes: string[]; approvals: Array<{ id: string; code: string; guest?: string }> };
    expect(mid.activeCodes).not.toContain(code);
    expect(mid.approvals.find((a) => a.id === approvalId)).toMatchObject({ code, guest: "Alex" });
    const dec = await managed("POST", `/api/v1/devices/approvals/${approvalId}`, { approve: true });
    expect(await dec.json()).toMatchObject({ ok: true, state: "approved", deviceName: "Alex iPhone" });
    expect((await managed("POST", `/api/v1/devices/approvals/${approvalId}`, { approve: true })).status).toBe(404);
  });

  test("老的全 scope Bearer token（没有设备凭据）看不到也批不了；会话受限的管理设备批不了比自己大的请求", async () => {
    const token: Principal = { id: "token:tok_x", role: "owner", agents: ["*"], createdAt: "2026-01-01T00:00:00Z" };
    expect((await managed("GET", "/api/v1/devices/approvals", undefined, token)).status).toBe(403);
    const info = issuePairing(machine, {});
    const r = (await pub("POST", "/api/v1/devices/pair", RELAY, { body: { code: String(info.code), deviceName: "big" } }))!;
    const { approvalId } = (await r.json()) as { approvalId: string };
    const narrow: Principal = { id: OWNER_PRINCIPAL_ID, role: "external", agents: ["*"], createdAt: "", manage: true, terminal: false, credential: "dev_n" };
    const refused = await managed("POST", `/api/v1/devices/approvals/${approvalId}`, { approve: true }, narrow);
    expect(refused.status).toBe(403);
    expect(pendingApprovals().some((a) => a.id === approvalId)).toBe(true); // 没被吃掉，全权设备还能批
    expect(await decideApproval(approvalId, false)).toMatchObject({ state: "denied" });
  });

  test("两台设备同时批准：只有一个赢，只签一张凭据", async () => {
    const info = issuePairing(machine, { agents: ["worker-a"], terminal: false, manage: false });
    const r = (await pub("POST", "/api/v1/devices/pair", RELAY, { body: { code: String(info.code), deviceName: "race" } }))!;
    const { approvalId } = (await r.json()) as { approvalId: string };
    const [a, b] = await Promise.all([decideApproval(approvalId, true, owner), decideApproval(approvalId, true, owner)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await decideApproval(approvalId, false)).toBeNull();
  });

  test("网页发码：给出去的不能比发码设备自己的大（没有终端 / 大总管的管理设备签不出带它们的码）", () => {
    const narrow: Principal = { id: OWNER_PRINCIPAL_ID, role: "external", agents: ["*"], createdAt: "", manage: true, terminal: false, credential: "dev_n" };
    expect(issuePairing(machine, {}, narrow)).toMatchObject({ ok: true, grant: { agents: ["*"], terminal: false, manage: true } });
    const one: Principal = { ...narrow, agents: ["worker-a"], manage: false };
    expect(issuePairing(machine, { agents: ["other"] }, one)).toMatchObject({ ok: false });
    expect(issuePairing(machine, {}, owner)).toMatchObject({ ok: true, grant: { agents: ["*", "master"], terminal: true, manage: true } });
  });
});

describe("审计：新凭据记下谁签的码、谁批准的", () => {
  const creds = async () => (await readPrincipalsStrict(join(dir, "principals.json"))).principals.flatMap((p) => p.credentials ?? []);
  test("网页发的码扫码配对 → issuedBy = 发码设备；终端发的码手输后网页批准 → issuedBy cli、approvedBy = 批准设备", async () => {
    const phone: Principal = { id: OWNER_PRINCIPAL_ID, role: "owner", agents: ["*", "master"], createdAt: "", credential: "dev_phone" };
    const info = issuePairing(machine, {}, phone);
    const ch = (await (await pub("GET", "/api/v1/devices/pair/challenge", RELAY))!.json()) as { challenge: string };
    const res = (await pub("POST", "/api/v1/devices/pair", RELAY, { body: { proof: { challenge: ch.challenge, hmac: proofFor(secretOf(info), ch.challenge) }, deviceName: "audit-ipad" } }))!;
    const { credentialId } = (await res.json()) as { credentialId: string };
    expect((await creds()).find((c) => c.id === credentialId)).toMatchObject({ issuedBy: "dev_phone" });
    expect((await creds()).find((c) => c.id === credentialId)?.approvedBy).toBeUndefined();

    const cli = issuePairing(machine, {});
    const r = (await pub("POST", "/api/v1/devices/pair", RELAY, { body: { code: String(cli.code), deviceName: "audit-mac" } }))!;
    const { approvalId } = (await r.json()) as { approvalId: string };
    const out = (await decideApproval(approvalId, true, phone))!;
    expect((await creds()).find((c) => c.id === out.credentialId)).toMatchObject({ issuedBy: "cli", approvedBy: "dev_phone" });
  });
});

describe("本机回环自动配对", () => {
  test("隧道来源（source relay）打不到；LAN 打不到；回环缺自定义头 / 跨源都拒；回环 + 头 + 同源 → 凭据，cookie 不带 Secure、Path=/", async () => {
    expect((await pub("POST", "/api/v1/devices/local", RELAY, { headers: { "x-cstra-device": "1" } }))!.status).toBe(403);
    expect((await pub("POST", "/api/v1/devices/local", LAN, { headers: { "x-cstra-device": "1" } }))!.status).toBe(403);
    expect((await pub("POST", "/api/v1/devices/local", LOOPBACK))!.status).toBe(403);
    expect((await pub("POST", "/api/v1/devices/local", LOOPBACK, { headers: { "x-cstra-device": "1", origin: "http://evil.local" } }))!.status).toBe(403);
    const ok = (await pub("POST", "/api/v1/devices/local", LOOPBACK, { headers: { "x-cstra-device": "1", origin: "http://bridge.local" }, body: { deviceName: "Safari" } }))!;
    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).toBe(`${cookiePair(ok)}; Path=/; Max-Age=7776000; HttpOnly; SameSite=Strict`);
    const p = (await auth(cookiePair(ok), LOOPBACK)) as Principal;
    expect(p).toMatchObject({ id: OWNER_PRINCIPAL_ID, role: "owner", manage: true });
    // owner 设备能列全部设备并撤别人
    const list = await handleDevicesManaged(req("GET", "/api/v1/devices", LOOPBACK), new URL("http://x/api/v1/devices"), p);
    const devices = ((await list!.json()) as { devices: Array<{ id: string; current: boolean; principal: string; deviceName: string }> }).devices;
    expect(devices.filter((d) => d.current).map((d) => d.deviceName)).toEqual(["Safari"]);
    const other = devices.find((d) => !d.current && d.principal === OWNER_PRINCIPAL_ID)!;
    const del = await handleDevicesManaged(req("DELETE", `/api/v1/devices/${other.id}`, LOOPBACK), new URL(`http://x/api/v1/devices/${other.id}`), p);
    expect(await del!.json()).toMatchObject({ ok: true, revoked: other.id });
    expect((await handleDevicesManaged(req("DELETE", `/api/v1/devices/${other.id}`, LOOPBACK), new URL(`http://x/api/v1/devices/${other.id}`), p))!.status).toBe(404);
  });
});

// 放最后：这一组把状态机的每分钟错误窗口打满，后面再跑别的配对都会 429
describe("穷举防护", () => {
  test("没连中继也能签：没有入口地址就只给短码与 fragment；--url 给了入口就拼出链接；指纹取本机实例密钥", () => {
    const bare = issuePairing({}, {});
    expect(bare).toMatchObject({ ok: true, link: null, url: null, base: null, slug: null });
    expect(String(bare.fragment)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}\.[A-Za-z0-9_-]{22}$/);
    const withUrl = issuePairing({}, { url: "https://mac.ts.net/" });
    expect(String(withUrl.link)).toBe(`https://mac.ts.net/pair#${withUrl.fragment}`);
    expect(withUrl.fp).toBe(String(bare.fragment).split(".")[0]);
  });

  test("HMAC 对不上 → 400 code invalid；连错 5 次 → 429", async () => {
    issuePairing(machine, {});
    for (let i = 0; i < 6; i++) {
      const ch = (await (await pub("GET", "/api/v1/devices/pair/challenge", RELAY))!.json()) as { challenge: string };
      const r = (await pub("POST", "/api/v1/devices/pair", RELAY, { body: { proof: { challenge: ch.challenge, hmac: "AAAA" } } }))!;
      expect(r.status).toBe(i < 5 ? 400 : 429);
    }
  });
});
