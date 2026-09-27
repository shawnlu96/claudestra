/** bridge/local-api/access.ts：「访问」页总览——要 manage；只听回环时局域网地址照报但标明没开；中继报首页不报旧子域名 */
import { afterAll, describe, expect, test } from "bun:test";
import { setAccessDepsForTest } from "../src/bridge/local-api/access.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import type { Principal } from "../src/lib/principals.js";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };
const get = async (p: Principal) => {
  const url = new URL("http://bridge.local/api/v1/access-paths");
  return (await handleLocalApi(new Request(url.href), url, p))!;
};
afterAll(() => setAccessDepsForTest(undefined));

describe("GET /api/v1/access-paths", () => {
  test("没有管理权限 → 403", async () => {
    expect((await get(GUEST)).status).toBe(403);
  });

  test("只听回环：局域网地址照报、bindAll=false；中继连着报首页", async () => {
    setAccessDepsForTest({
      bind: () => "127.0.0.1",
      lanUrls: () => ["http://192.168.1.5:3847"],
      relay: () => ({ enabled: true, connected: true, state: "online", base: "relay.example.com" }),
    });
    expect(await (await get(OWNER)).json()).toEqual({
      ok: true,
      relay: { enabled: true, connected: true, state: "online", home: "https://relay.example.com" },
      lan: { bind: "127.0.0.1", bindAll: false, urls: ["http://192.168.1.5:3847"] },
    });
  });

  test("监听所有网卡 → bindAll；没配中继 → home null", async () => {
    setAccessDepsForTest({ bind: () => "0.0.0.0", lanUrls: () => [], relay: () => ({ enabled: false, connected: false, state: null, base: null }) });
    const j = (await (await get(OWNER)).json()) as { relay: { home: string | null }; lan: { bindAll: boolean } };
    expect(j.lan.bindAll).toBe(true);
    expect(j.relay.home).toBeNull();
  });
});
