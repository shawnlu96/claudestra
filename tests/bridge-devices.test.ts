/**
 * 设备配对与凭据的 HTTP 面（src/bridge/devices.ts + src/bridge/api-auth.ts），principals.json 指到临时目录。
 * 负向用例先写：隧道来源打不到本机配对、没有 CSRF 头的写请求、guest / 受限凭据碰管理端点、撤销后立刻失效、短码穷举限流。
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setApiAuthPrincipalsPathForTest, authenticateApi } from "../src/bridge/api-auth.js";
import {
  decideApproval, handleDevicesManaged, hasPairingApprover, handleDevicesPublic, issuePairing, pendingApprovals, setDevicesPrincipalsPathForTest, setDevicesRegistryPathForTest,
  setLocalPairingControlTokenForTest,
} from "../src/bridge/devices.js";
import { relayControlRoutes } from "../src/bridge/relay-routes.js";
import { setRequestContext, type RequestContext } from "../src/bridge/request-context.js";
import { attachCredential, ensureOwnerPrincipal, fullGrant, guestGrant, newGuestPrincipal, OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { proofFor } from "../src/lib/pairing-codes.js";
import { readPrincipalsStrict, type Principal, type PrincipalsFile } from "../src/lib/principals.js";

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

describe("guest 配对码的名字", () => {
  test("不许叫保留名 web-ui（它的消息来源名会被网页当成 owner 本人）", () => {
    for (const guest of ["web-ui", "WEB-UI "]) {
      const info = issuePairing(machine, { guest });
      expect([guest, info.ok, String(info.error)]).toEqual([guest, false, expect.stringContaining("保留名")]);
    }
    expect(issuePairing(machine, { guest: "friend", agents: ["worker-a"] }).ok).toBe(true);
  });
});

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

  test("DELETE /devices/current：guest 不拉列表也能退出登录；撤完清 cookie、最后一条就停用 principal、旧 cookie 401", async () => {
    const info = issuePairing(machine, { guest: "Bob", agents: ["worker-a"] });
    const pair = async (deviceName: string) => {
      const ch = (await (await pub("GET", "/api/v1/devices/pair/challenge", RELAY))!.json()) as { challenge: string };
      return (await pub("POST", "/api/v1/devices/pair", RELAY, { body: { proof: { challenge: ch.challenge, hmac: proofFor(secretOf(info), ch.challenge) }, deviceName } }))!;
    };
    const res = await pair("Bob 的手机");
    const cookie = cookiePair(res);
    // 写请求照样要 x-cstra-device（跨站表单附不上这个头）
    expect(((await auth(cookie, RELAY, "DELETE")) as Response).status).toBe(403);
    const p = (await auth(cookie, RELAY, "DELETE", { "x-cstra-device": "1" })) as Principal;
    expect(p.id.startsWith("guest:")).toBe(true);
    const out = await handleDevicesManaged(req("DELETE", "/api/v1/devices/current", RELAY), new URL("http://x/api/v1/devices/current"), p);
    expect(out!.status).toBe(200);
    expect(await out!.json()).toMatchObject({ ok: true, revoked: p.credential, principal: p.id });
    expect(cookieOf(out!)).toContain(`cstra_dev=; Path=/m/${FP}/`);
    expect(((await auth(cookie, RELAY)) as Response).status).toBe(401);
    const file = await readPrincipalsStrict(join(dir, "principals.json"));
    expect(file.principals.find((x) => x.id === p.id)).toMatchObject({ disabled: true, credentials: [] });
    // 再调一次（凭据已撤）：鉴权这层就 401，走不到路由
    expect(((await auth(cookie, RELAY, "DELETE", { "x-cstra-device": "1" })) as Response).status).toBe(401);
  });

  test("DELETE /devices/current：Bearer token、peer token 没有设备凭据，404，什么都不撤", async () => {
    const before = JSON.stringify(await readPrincipalsStrict(join(dir, "principals.json")));
    const tokens: Principal[] = [
      { id: "token:web", role: "owner", name: "web-ui", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z" },
      { id: "token:peer", role: "external", name: "peer-x", peer: "x", agents: ["worker-a"], createdAt: "2026-01-01T00:00:00Z" },
    ];
    for (const t of tokens) {
      const r = await handleDevicesManaged(req("DELETE", "/api/v1/devices/current", RELAY), new URL("http://x/api/v1/devices/current"), t);
      expect(r!.status).toBe(404);
    }
    expect(JSON.stringify(await readPrincipalsStrict(join(dir, "principals.json")))).toBe(before);
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
  const LOCAL_H = { "x-cstra-device": "1", origin: "http://bridge.local" };
  const local = (headers: Record<string, string> = LOCAL_H, ctx: RequestContext = LOOPBACK) =>
    pub("POST", "/api/v1/devices/local", ctx, { headers, body: { deviceName: "Safari" } }) as Promise<Response>;
  const status = (id: string, claim: string, ctx: RequestContext = LOOPBACK) =>
    pub("GET", `/api/v1/devices/pair/status?approval=${encodeURIComponent(id)}`, ctx, { headers: claim ? { cookie: claim } : {} }) as Promise<Response>;
  const cancel = (id: string, claim: string) =>
    pub("POST", "/api/v1/devices/local/cancel", LOOPBACK, { headers: { ...LOCAL_H, ...(claim ? { cookie: claim } : {}) }, body: { approval: id } }) as Promise<Response>;
  /** 待批响应里的领取凭据（HttpOnly cookie）；设备凭据 cookie 另算 */
  const claimOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("cstra_local_claim=")) ?? "";
  const devCookies = (r: Response) => r.headers.getSetCookie().filter((c) => c.startsWith("cstra_dev="));
  async function open(headers?: Record<string, string>): Promise<{ id: string; code: string; claim: string }> {
    const r = await local(headers);
    expect(r.status).toBe(202);
    const { approvalId, code } = (await r.json()) as { approvalId: string; code: string };
    return { id: approvalId, code, claim: claimOf(r) };
  }
  const loopbackList = async () => ((await (await relayControlRoutes(new Request("http://bridge.local/relay/pair/approvals"), new URL("http://bridge.local/relay/pair/approvals"))).json()) as {
    approvals: Array<Record<string, unknown>>;
  }).approvals;
  const phone: Principal = { id: OWNER_PRINCIPAL_ID, role: "owner", agents: ["*", "master"], createdAt: "", credential: "dev_phone" };
  afterEach(() => setLocalPairingControlTokenForTest(undefined));

  test("隧道来源（source relay）打不到；LAN 打不到；回环缺自定义头 / 跨源都拒", async () => {
    setLocalPairingControlTokenForTest("ctl-secret");
    const tok = { authorization: "Bearer ctl-secret" };
    expect((await pub("POST", "/api/v1/devices/local", RELAY, { headers: { "x-cstra-device": "1", ...tok } }))!.status).toBe(403);
    expect((await pub("POST", "/api/v1/devices/local", LAN, { headers: { "x-cstra-device": "1", ...tok } }))!.status).toBe(403);
    expect((await pub("POST", "/api/v1/devices/local", LOOPBACK, { headers: tok }))!.status).toBe(403);
    expect((await pub("POST", "/api/v1/devices/local", LOOPBACK, { headers: { "x-cstra-device": "1", origin: "http://evil.local", ...tok } }))!.status).toBe(403);
  });

  test("只有回环 + 头 + 同源：不再直接签——没有能批的设备回 no_approver，有就进待批（202，不发设备 cookie）", async () => {
    const empty = join(dir, "empty-principals.json");
    setDevicesPrincipalsPathForTest(empty);
    try {
      const r = await local();
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ code: "no_approver" });
      expect(r.headers.getSetCookie()).toEqual([]);
    } finally {
      setDevicesPrincipalsPathForTest(join(dir, "principals.json"));
    }
    const r = await local();
    expect(r.status).toBe(202);
    expect(devCookies(r)).toEqual([]);
    const { approvalId, code } = (await r.json()) as { approvalId: string; code: string };
    expect(code).toMatch(/^[0-9A-Z]{8}$/);
    expect(pendingApprovals().find((a) => a.id === approvalId)).toMatchObject({ local: true, code, grant: { agents: ["*", "master"], terminal: true, manage: true } });
    expect(await decideApproval(approvalId, false)).toMatchObject({ state: "denied" });
  });

  test("带控制 token（Bearer / X-Bridge-Token）→ 直接签全权，cookie 不带 Secure、Path=/；token 不对 → 仍进待批", async () => {
    setLocalPairingControlTokenForTest("ctl-secret");
    const bad = await open({ ...LOCAL_H, authorization: "Bearer nope" });
    expect(await decideApproval(bad.id, false)).toMatchObject({ state: "denied" });
    expect((await local({ ...LOCAL_H, "x-bridge-token": "ctl-secret" })).status).toBe(200);
    const ok = await local({ ...LOCAL_H, authorization: "Bearer ctl-secret" });
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

  test("真人确认：未批准取不到；回环控制路由（本机 agent 也能打）批不了；网页设备批准后签一次，nonce 不可重放；别的来源取不走", async () => {
    const { id: approvalId, claim } = await open();
    expect((await status(approvalId, claim)).status).toBe(202);
    expect(await decideApproval(approvalId, true)).toMatchObject({ ok: false, state: "pending" }); // approver 缺省 = /relay/pair/approve
    const viaRoute = await relayControlRoutes(
      new Request("http://bridge.local/relay/pair/approve", { method: "POST", body: JSON.stringify({ id: approvalId, approve: true }) }), new URL("http://bridge.local/relay/pair/approve"),
    );
    expect(viaRoute.status).toBe(403);
    expect((await status(approvalId, claim)).status).toBe(202);
    const out = (await decideApproval(approvalId, true, phone))!;
    expect(out).toMatchObject({ ok: true, state: "approved" });
    expect((await status(approvalId, claim, RELAY)).status).toBe(403);
    const got = await status(approvalId, claim);
    expect(got.status).toBe(200);
    expect((await auth(cookiePair(got), LOOPBACK)) as Principal).toMatchObject({ id: OWNER_PRINCIPAL_ID, manage: true });
    const cred = (await readPrincipalsStrict(join(dir, "principals.json"))).principals.flatMap((p) => p.credentials ?? []).find((c) => c.id === out.credentialId);
    expect(cred).toMatchObject({ approvedBy: "dev_phone", grant: { manage: true, terminal: true } });
    const again = await status(approvalId, claim);
    expect(again.status).toBe(410);
    expect(devCookies(again)).toEqual([]);
  });

  test("只有发起的那个浏览器领得走：不带 / 带错领取 cookie 都拒且不消耗；回环列表不给 local 待批的编号", async () => {
    const mine = await open();
    const other = await open();
    expect(mine.claim).toMatch(/^cstra_local_claim=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32,}$/);
    const listed = (await loopbackList()).filter((a) => a.local);
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed.every((a) => a.id === undefined)).toBe(true);
    expect(pendingApprovals().some((a) => a.id === mine.id)).toBe(true); // 网页批准横幅（管理端点）仍要编号
    expect(await decideApproval(mine.id, true, phone)).toMatchObject({ ok: true, state: "approved" });
    for (const claim of ["", other.claim, `cstra_local_claim=${mine.id}.wrong-secret-wrong-secret-wrong-secret`]) {
      const r = await status(mine.id, claim);
      expect([claim, r.status]).toEqual([claim, 403]);
      expect(devCookies(r)).toEqual([]);
    }
    const got = await status(mine.id, mine.claim);
    expect(got.status).toBe(200);
    expect(devCookies(got).length).toBe(1);
    await decideApproval(other.id, false);
  });

  test("取消 = 作废：带领取 cookie 才能取消；取消掉的不占名额，第 4 次正常申请不会 429；同一浏览器再申请顶掉自己上一条", async () => {
    const ids = [await open(), await open(), await open()];
    expect((await local()).status).toBe(429);
    expect((await cancel(ids[0].id, "")).status).toBe(403);
    expect((await cancel(ids[0].id, ids[1].claim)).status).toBe(403);
    for (const a of ids) expect((await cancel(a.id, a.claim)).status).toBe(200);
    expect(pendingApprovals().filter((a) => a.local)).toEqual([]);
    expect((await status(ids[0].id, ids[0].claim)).status).toBe(410);
    const first = await open();
    const second = await open({ ...LOCAL_H, cookie: first.claim });
    expect(pendingApprovals().filter((a) => a.local).map((a) => a.id)).toEqual([second.id]);
    await decideApproval(second.id, false);
  });

  test("拒绝后取不到；过期（10 分钟）取不到也批不了；同时挂着的待批有上限", async () => {
    const denied = await open();
    expect(await decideApproval(denied.id, false)).toMatchObject({ state: "denied" });
    expect(await (await status(denied.id, denied.claim)).json()).toMatchObject({ state: "denied" });
    const stale = await open();
    setSystemTime(new Date(Date.now() + 10 * 60_000 + 1_000));
    try {
      expect(await decideApproval(stale.id, true, phone)).toBeNull();
      expect(await (await status(stale.id, stale.claim)).json()).toMatchObject({ state: "expired" });
    } finally {
      setSystemTime();
    }
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await open()).id);
    expect((await local()).status).toBe(429);
    for (const id of ids) await decideApproval(id, false);
  });
});

describe("hasPairingApprover（本机全权请求有没有人能批）", () => {
  const T0 = new Date("2026-09-27T12:00:00Z");
  test("只认未停用、未过期、全 scope 带 manage 的设备凭据；guest / 受限 / 过期 / 停用都不算", () => {
    const file = ({ principals: [] } as PrincipalsFile);
    expect(hasPairingApprover(file, T0.getTime())).toBe(false);
    const guest = newGuestPrincipal("alex", guestGrant(["x"]), T0);
    attachCredential(guest, "alex", guestGrant(["x"]), { now: T0 });
    file.principals.push(guest);
    const owner = ensureOwnerPrincipal(file, T0);
    attachCredential(owner, "narrow", { agents: ["x"], terminal: false, manage: true }, { now: T0 });
    const { credential } = attachCredential(owner, "mac", fullGrant(), { now: T0 });
    expect(hasPairingApprover(file, T0.getTime())).toBe(true);
    expect(hasPairingApprover(file, Date.parse(credential.expiresAt) + 1)).toBe(false);
    credential.disabled = true;
    expect(hasPairingApprover(file, T0.getTime())).toBe(false);
    credential.disabled = false;
    owner.disabled = true;
    expect(hasPairingApprover(file, T0.getTime())).toBe(false);
  });

  test("按有效权限判：只有一台受限设备（无终端 / 缺 master / 主体 scope 收窄 / 非 owner / 无 manage）都不算；grant 顺序不同的全权算", () => {
    const only = (grant: ReturnType<typeof fullGrant>, tweak: (p: Principal) => void = () => {}) => {
      const file = ({ principals: [] } as PrincipalsFile);
      const owner = ensureOwnerPrincipal(file, T0);
      tweak(owner);
      attachCredential(owner, "only", grant, { now: T0 });
      return hasPairingApprover(file, T0.getTime());
    };
    expect(only({ agents: ["*", "master"], terminal: false, manage: true })).toBe(false);
    expect(only({ agents: ["*"], terminal: true, manage: true })).toBe(false);
    expect(only(fullGrant(), (p) => { p.agents = ["worker-a"]; })).toBe(false);
    expect(only(fullGrant(), (p) => { p.role = "external"; })).toBe(false);
    expect(only({ agents: ["*", "master"], terminal: true, manage: false })).toBe(false);
    expect(only({ agents: ["master", "*"], terminal: true, manage: true })).toBe(true);
    expect(only(fullGrant())).toBe(true);
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
