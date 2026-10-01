/**
 * 从旧 web 服务升上来（src/lib/legacy-web.ts + bridge/devices.ts legacy-session + bridge/legacy-web-port.ts）：
 * 旧 plist 读端口、旧会话只搬 sha256 且只能换一次、兑换接口的门槛、旧端口接管后拒 WebSocket。
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticateApi, setApiAuthPrincipalsPathForTest } from "../src/bridge/api-auth.js";
import { handleDevicesPublic, setDevicesPrincipalsPathForTest } from "../src/bridge/devices.js";
import { startLegacyWebPort } from "../src/bridge/legacy-web-port.js";
import { setWebStatePathForTest } from "../src/bridge/local-api/db.js";
import { setRequestContext, type RequestContext } from "../src/bridge/request-context.js";
import { legacyWebPortFromPlist, redeemLegacySession } from "../src/lib/legacy-web.js";
import { closeWebState, openWebState } from "../src/lib/web-state.js";
import { importLegacySessions, sessionIdHash } from "../src/lib/web-state-migrate.js";

const T0 = new Date(); // 相对现在：devices 路由按真实时间判过期，写死的日期过了「T0+3 天」这条夹具就成了过期会话
const later = (days: number) => new Date(T0.getTime() + days * 86_400_000).toISOString();

function oldSettingsDb(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)");
  const ins = db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)");
  ins.run("live-session-id-0000000000000000", "shawn", later(3), T0.toISOString());
  ins.run("dead-session-id-0000000000000000", "shawn", later(-1), T0.toISOString());
  return db;
}

describe("legacyWebPortFromPlist", () => {
  test("读 next start -p / --port；读不出来用旧 web 默认 3333", () => {
    expect(legacyWebPortFromPlist("<string>exec ./node_modules/.bin/next start -p 3333</string>")).toBe(3333);
    expect(legacyWebPortFromPlist("<string>next start --port=4000</string>")).toBe(4000);
    expect(legacyWebPortFromPlist("<string>something else</string>")).toBe(3333);
  });
});

describe("旧会话：导入与一次性兑换", () => {
  test("只搬没过期的、只存 sha256；兑换一次后作废；过期 / 不认识 / 超长的都不给", () => {
    const dst = openWebState(":memory:");
    expect(importLegacySessions(oldSettingsDb(), dst, T0)).toBe(1);
    const rows = dst.prepare("SELECT id_hash FROM legacy_sessions").all() as { id_hash: string }[];
    expect(rows).toEqual([{ id_hash: sessionIdHash("live-session-id-0000000000000000") }]);
    expect(redeemLegacySession(dst, "live-session-id-0000000000000000", T0)).toEqual({ username: "shawn" });
    expect(redeemLegacySession(dst, "live-session-id-0000000000000000", T0)).toBeNull();
    expect(redeemLegacySession(dst, "dead-session-id-0000000000000000", T0)).toBeNull();
    expect(redeemLegacySession(dst, "x".repeat(300), T0)).toBeNull();
    closeWebState(":memory:");
  });
  test("到期时间过了也不给（导入后才过期）", () => {
    const dst = openWebState(":memory:");
    importLegacySessions(oldSettingsDb(), dst, T0);
    expect(redeemLegacySession(dst, "live-session-id-0000000000000000", new Date(later(4)))).toBeNull();
    closeWebState(":memory:");
  });
});

describe("POST /api/v1/devices/legacy-session", () => {
  let dir: string;
  const LAN: RequestContext = { source: "lan", clientIp: "100.64.0.9", https: true };
  const RELAY: RequestContext = { source: "relay", clientIp: "203.0.113.9", relayBase: "relay.test", pathPrefix: "/m/16f9-b5d1-30fb-8923", https: true };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "legacy-"));
    setDevicesPrincipalsPathForTest(join(dir, "principals.json"));
    setApiAuthPrincipalsPathForTest(join(dir, "principals.json"));
    setWebStatePathForTest(join(dir, "web-state.sqlite"));
    importLegacySessions(oldSettingsDb(), openWebState(join(dir, "web-state.sqlite")), new Date());
  });
  afterAll(() => {
    setDevicesPrincipalsPathForTest(undefined);
    setApiAuthPrincipalsPathForTest(undefined);
    closeWebState(join(dir, "web-state.sqlite"));
    setWebStatePathForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const post = (ctx: RequestContext, headers: Record<string, string>) => {
    const r = new Request("http://bridge.local/api/v1/devices/legacy-session", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    setRequestContext(r, ctx);
    return handleDevicesPublic(r, new URL(r.url));
  };
  test("没 CSRF 头 403；没旧 cookie 或经中继 404；不认识的 401", async () => {
    expect((await post(LAN, { cookie: "cstra_session=live-session-id-0000000000000000" }))!.status).toBe(403);
    expect((await post(LAN, { "x-cstra-device": "1" }))!.status).toBe(404);
    expect((await post(RELAY, { "x-cstra-device": "1", cookie: "cstra_session=live-session-id-0000000000000000" }))!.status).toBe(404);
    expect((await post(LAN, { "x-cstra-device": "1", cookie: "cstra_session=nope" }))!.status).toBe(401);
  });
  test("旧会话有效：签 owner 全权设备凭据（Path=/）、清掉旧 cookie；同一个 cookie 第二次 401；新凭据能过鉴权", async () => {
    const res = (await post(LAN, { "x-cstra-device": "1", cookie: "cstra_session=live-session-id-0000000000000000" }))!;
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("cstra_dev=") && c.includes("Path=/;"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("cstra_session=;") && c.includes("Max-Age=0"))).toBe(true);
    expect(((await res.json()) as { grant: unknown }).grant).toEqual({ agents: ["*", "master"], terminal: true, manage: true });
    expect((await post(LAN, { "x-cstra-device": "1", cookie: "cstra_session=live-session-id-0000000000000000" }))!.status).toBe(401);
    const dev = cookies.find((c) => c.startsWith("cstra_dev="))!.split(";")[0];
    const r = new Request("http://bridge.local/api/v1/agents", { headers: { cookie: dev } });
    setRequestContext(r, LAN);
    const p = await authenticateApi(r, new URL(r.url), { rateLimit: false });
    expect(p instanceof Response).toBe(false);
  });
});

describe("旧 web 端口由 bridge 接管", () => {
  test("没配 / 配错端口不监听；配了：请求交给同一个处理函数（带 server），WebSocket 升级一律 426", async () => {
    // 与 bridgeFetch 一样：每个请求都先试 server.upgrade()（没配 websocket 的 listener 上 Bun 会抛，接管端口必须兜住）
    const handler = async (req: Request, server: { requestIP(r: Request): { address: string } | null; upgrade(r: Request): boolean }) => {
      if (server.upgrade(req)) return undefined;
      return new Response(JSON.stringify({ path: new URL(req.url).pathname, ip: server.requestIP(req)?.address ?? null }));
    };
    expect(startLegacyWebPort(handler, {})).toBeNull();
    expect(startLegacyWebPort(handler, { BRIDGE_LEGACY_WEB_PORT: "abc" })).toBeNull();
    const port = 20000 + Math.floor(Math.random() * 20000);
    const s = startLegacyWebPort(handler, { BRIDGE_LEGACY_WEB_PORT: String(port), BRIDGE_LEGACY_WEB_BIND: "127.0.0.1" });
    expect(s).not.toBeNull();
    try {
      const j = (await (await fetch(`http://127.0.0.1:${port}/chat`)).json()) as { path: string; ip: string };
      expect(j.path).toBe("/chat");
      expect(j.ip).toContain("127.0.0.1");
      const ws = await fetch(`http://127.0.0.1:${port}/`, { headers: { upgrade: "websocket", connection: "Upgrade" } });
      expect(ws.status).toBe(426);
    } finally {
      s!.stop();
    }
  });
});
