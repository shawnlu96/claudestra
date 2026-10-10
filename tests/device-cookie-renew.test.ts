/**
 * 设备 cookie 随使用续发（src/bridge/device-cookie-renew.ts）：只在中继出口（relay-dispatch.ts）续，只续设备 cookie 鉴权通过的成功响应，
 * 每条凭据 24 小时一次，开关 on / observe / off；两个设备 401 分支记原因和来源、限频、不记 cookie 值。
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticateApi, setApiAuthPrincipalsPathForTest } from "../src/bridge/api-auth.js";
import { logDeviceRefusal, renewDeviceCookie, setDeviceCookieRenewForTest } from "../src/bridge/device-cookie-renew.js";
import { handleDevicesManaged, setDevicesPrincipalsPathForTest } from "../src/bridge/devices.js";
import { dispatchMachineRequest } from "../src/bridge/relay-dispatch.js";
import { setRequestContext, type RequestContext } from "../src/bridge/request-context.js";
import { attachCredential, deviceCookieHeader, DEVICE_COOKIE, DEVICE_HEADER, ensureOwnerPrincipal, fullGrant } from "../src/lib/devices.js";
import { newTokenPrincipal, type PrincipalsFile } from "../src/lib/principals.js";
import { filterMachineResponseHeaders, RELAY_MODE_API, RELAY_MODE_HEADER, RELAY_PREFIX_HEADER } from "../src/lib/relay-machine-path.js";
import { recordToHeaders } from "../src/lib/relay-stream.js";
import { readConfigSync } from "../src/lib/config-store.js";
import { CONFIG_PATH } from "../src/lib/paths.js";

const PREFIX = "/m/16f9-b5d1-30fb-8923";
const LAN: RequestContext = { source: "lan", clientIp: "192.168.1.9", https: false };
const DAY = 24 * 60 * 60_000;

let dir: string;
let tokenA: string;
let tokenB: string;
let tokenC: string;
let bearer: string;
let peerSecret: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "devcookie-"));
  const file: PrincipalsFile = { version: 1, principals: [] } as unknown as PrincipalsFile;
  const owner = ensureOwnerPrincipal(file);
  tokenA = attachCredential(owner, "iPhone", fullGrant()).token;
  tokenB = attachCredential(owner, "iPad", fullGrant()).token;
  tokenC = attachCredential(owner, "Mac", fullGrant()).token;
  const script = newTokenPrincipal("script", ["*"]);
  const peer = newTokenPrincipal("peer-x", ["*"], { peer: "x" });
  file.principals.push(script, peer);
  bearer = script.secret!;
  peerSecret = peer.secret!;
  writeFileSync(join(dir, "principals.json"), JSON.stringify(file));
  setApiAuthPrincipalsPathForTest(join(dir, "principals.json"));
  setDevicesPrincipalsPathForTest(join(dir, "principals.json"));
});
afterAll(() => {
  setApiAuthPrincipalsPathForTest(undefined);
  setDevicesPrincipalsPathForTest(undefined);
  setDeviceCookieRenewForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => setDeviceCookieRenewForTest(undefined));

/** 进程内 API：鉴权通过回 200，没过把鉴权的响应原样回（与 serveApiRequest 同形） */
async function api(r: Request): Promise<Response> {
  const p = await authenticateApi(r, new URL(r.url), { rateLimit: false });
  return p instanceof Response ? p : new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
}
const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });

/** 经中继路径模式：relay-dispatch → 中继出站过滤，返回浏览器拿到的 Set-Cookie */
async function viaRelay(headers: Record<string, string>, path = "/api/v1/agents", method = "GET", handler = api) {
  const out = await dispatchMachineRequest(
    { method, path, headers: { [RELAY_MODE_HEADER]: RELAY_MODE_API, [RELAY_PREFIX_HEADER]: PREFIX, ...headers }, body: empty() },
    { from: "relay", signal: new AbortController().signal }, handler,
  );
  const browser = filterMachineResponseHeaders(out.headers, PREFIX);
  return { status: out.status, machine: recordToHeaders(out.headers).getSetCookie(), browser: browser["set-cookie"] ?? null };
}
const cookie = (t: string) => ({ cookie: `${DEVICE_COOKIE}=${t}` });

describe("[验收线 1] on：中继出口续发", () => {
  test("第一次带回与配对时一致的 cookie，过滤后 Path 为机器前缀；24 小时内不带，满 24 小时再带", async () => {
    setDeviceCookieRenewForTest("on");
    const t0 = Date.now();
    const first = await viaRelay(cookie(tokenA));
    expect(first.status).toBe(200);
    // 配对时（bridge/devices.ts cookieFor）经中继：Path=<前缀>/、Secure
    expect(first.machine).toEqual([deviceCookieHeader(tokenA, { path: `${PREFIX}/`, secure: true })]);
    expect(first.machine[0]).toMatch(/Max-Age=7776000; HttpOnly; SameSite=Strict; Secure$/);
    expect(first.browser).toBe(`${DEVICE_COOKIE}=${tokenA}; Path=${PREFIX}/; Max-Age=7776000; HttpOnly; Secure; SameSite=Strict`);
    expect((await viaRelay(cookie(tokenA))).machine).toEqual([]);
    // 别的凭据各算各的
    expect((await viaRelay(cookie(tokenB))).machine).toHaveLength(1);

    const r = new Request("http://relay.local/api/v1/agents", { headers: cookie(tokenA) });
    setRequestContext(r, { source: "relay", clientIp: null, https: true, pathPrefix: PREFIX });
    const ok = await api(r);
    expect(renewDeviceCookie(r, ok, t0 + DAY - 60_000).headers.getSetCookie()).toEqual([]);
    expect(renewDeviceCookie(r, ok, t0 + DAY + 60_000).headers.getSetCookie()).toEqual([deviceCookieHeader(tokenA, { path: `${PREFIX}/`, secure: true })]);
  });

  test("直连不经中继出口：鉴权通过的响应不带续发的 Set-Cookie", async () => {
    setDeviceCookieRenewForTest("on");
    const r = new Request("http://bridge.local/api/v1/agents", { headers: cookie(tokenA) });
    setRequestContext(r, LAN);
    expect((await api(r)).headers.getSetCookie()).toEqual([]);
  });
});

describe("[验收线 2] 不续发的情形", () => {
  test("退出登录（DELETE /api/v1/devices/current）经中继出口：只有删除 cookie，不被续发盖掉", async () => {
    setDeviceCookieRenewForTest("on");
    // 真实鉴权 + 设备管理处理器（与 serveApiRequest 同形）；该凭据从没续发过，满足续发条件
    const managed = async (r: Request): Promise<Response> => {
      const url = new URL(r.url);
      const p = await authenticateApi(r, url, { rateLimit: false });
      return p instanceof Response ? p : (await handleDevicesManaged(r, url, p)) ?? new Response("not found", { status: 404 });
    };
    const out = await viaRelay({ ...cookie(tokenC), [DEVICE_HEADER]: "1" }, "/api/v1/devices/current", "DELETE", managed);
    expect(out.status).toBe(200);
    expect(out.machine).toEqual([deviceCookieHeader(null, { path: `${PREFIX}/`, secure: true })]);
    const browser = [out.browser ?? []].flat();
    expect(browser).toHaveLength(1);
    expect(browser[0]).toMatch(new RegExp(`^${DEVICE_COOKIE}=; Path=${PREFIX}/; Max-Age=0;`));
    expect(browser.join("\n")).not.toContain(tokenC);
  });

  test("Bearer、peer token、E2E 内层、401 / 403 都不带", async () => {
    setDeviceCookieRenewForTest("on");
    expect((await viaRelay({ authorization: `Bearer ${bearer}` })).machine).toEqual([]);
    // peer token 经中继路径模式 403；带着设备 cookie 也一样，Bearer 优先
    const peer = await viaRelay({ authorization: `Bearer ${peerSecret}`, ...cookie(tokenA) });
    expect([peer.status, peer.machine]).toEqual([403, []]);
    const bad = await viaRelay(cookie("nope"));
    expect([bad.status, bad.machine]).toEqual([401, []]);
    const csrf = await dispatchMachineRequest(
      { method: "POST", path: "/api/v1/agents", headers: { [RELAY_MODE_HEADER]: RELAY_MODE_API, [RELAY_PREFIX_HEADER]: PREFIX, ...cookie(tokenB) }, body: empty() },
      { from: "relay", signal: new AbortController().signal }, api,
    );
    expect(csrf.status).toBe(403);
    expect(csrf.headers["set-cookie"]).toBeUndefined();

    const inner = new Request("http://bridge.local/api/v1/agents", { headers: cookie(tokenA) });
    setRequestContext(inner, { ...LAN, e2e: { peerFp: "ab" } });
    const res = await api(inner);
    expect(res.status).toBe(403);
    expect(renewDeviceCookie(inner, res).headers.getSetCookie()).toEqual([]);
  });

  test("observe 只记『会续发』不带 cookie；off 什么都不做", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      setDeviceCookieRenewForTest("observe");
      expect((await viaRelay(cookie(tokenA))).machine).toEqual([]);
      expect(log.mock.calls.filter((c) => String(c[0]).includes("会续发"))).toHaveLength(1);
      expect(String(log.mock.calls[0]![0])).not.toContain(tokenA);
      await viaRelay(cookie(tokenA)); // 观察也按凭据一天一次
      expect(log.mock.calls.filter((c) => String(c[0]).includes("会续发"))).toHaveLength(1);
      log.mockClear();
      setDeviceCookieRenewForTest("off");
      expect((await viaRelay(cookie(tokenA))).machine).toEqual([]);
      expect(log.mock.calls.filter((c) => String(c[0]).includes("会续发"))).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  test("config.json 的 deviceCookieRenew：只认 on / observe / off，缺省 observe", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    // CONFIG_PATH 是整个测试进程共享的状态目录里的：先存原样，结束时放回
    const saved = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH) : null;
    try {
      for (const [raw, want] of [["on", "on"], ["off", "off"], ["observe", "observe"], ["yes", undefined]] as const) {
        writeFileSync(CONFIG_PATH, JSON.stringify({ deviceCookieRenew: raw }));
        expect(readConfigSync().deviceCookieRenew).toBe(want);
      }
      writeFileSync(CONFIG_PATH, JSON.stringify({ deviceCookieRenew: "on" }));
      setDeviceCookieRenewForTest(undefined); // 现读 config.json
      expect((await viaRelay(cookie(tokenA))).machine).toHaveLength(1);
      rmSync(CONFIG_PATH, { force: true });
      setDeviceCookieRenewForTest(undefined); // 没配 = observe
      expect((await viaRelay(cookie(tokenA))).machine).toEqual([]);
      expect(log.mock.calls.some((c) => String(c[0]).includes("会续发"))).toBe(true);
    } finally {
      if (saved) writeFileSync(CONFIG_PATH, saved);
      else rmSync(CONFIG_PATH, { force: true });
      log.mockRestore();
    }
  });
});

describe("[验收线 3] 设备请求被拒记原因", () => {
  test("没带 cookie / 凭据不认各一行，带来源和路径，同原因同来源每分钟一行，不记 cookie 值", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const lines = () => warn.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("[device-auth]"));
      await viaRelay({}, "/api/v1/client-log");
      await viaRelay({}, "/api/v1/client-log");
      await viaRelay(cookie("stale-token-value"));
      await viaRelay(cookie("stale-token-value"));
      const lan = new Request("http://bridge.local/api/v1/agents");
      setRequestContext(lan, LAN);
      await api(lan);
      expect(lines()).toHaveLength(3);
      expect(lines()[0]).toContain("missing_cookie");
      expect(lines()[0]).toContain("来源 relay");
      expect(lines()[0]).toContain("/api/v1/client-log");
      expect(lines()[1]).toContain("credential_invalid");
      expect(lines()[2]).toContain("来源 lan");
      expect(lines().join("\n")).not.toContain("stale-token-value");
      // 一分钟后同一原因同一来源可以再打，并带上被压下的条数
      logDeviceRefusal(lan, new URL(lan.url), "missing_cookie", Date.now() + 61_000);
      expect(lines()).toHaveLength(4);
    } finally {
      warn.mockRestore();
    }
  });
});
