/** bridge/local-probe.ts：只答真实回环；跨源只放中继自己的 origin；预检带 Private Network Access 头；只回 fp / 名字 / 端口 */
import { describe, expect, test } from "bun:test";
import { localProbeResponse } from "../src/bridge/local-probe.js";
import { setRequestContext, type RequestContext } from "../src/bridge/request-context.js";

const deps = { relayBase: () => "relay.test", identity: () => ({ fp: "16f9-b5d1-30fb-8923", machineName: "mini" }), port: 3847 };
const LOOPBACK: RequestContext = { source: "loopback", clientIp: "127.0.0.1", https: false };

function req(path: string, ctx: RequestContext, init: { method?: string; origin?: string } = {}): Request {
  const r = new Request(`http://127.0.0.1:3847${path}`, { method: init.method ?? "GET", headers: init.origin ? { origin: init.origin } : {} });
  setRequestContext(r, ctx);
  return r;
}

describe("GET /local-probe", () => {
  test("别的路径不接（null）", () => {
    expect(localProbeResponse(req("/app-config.json", LOOPBACK), deps)).toBeNull();
    expect(localProbeResponse(req("/local-probe/x", LOOPBACK), deps)).toBeNull();
  });
  test("中继 origin + 回环 → fp / 名字 / 端口，CORS 只回这个 origin，不缓存", async () => {
    const res = localProbeResponse(req("/local-probe", LOOPBACK, { origin: "https://relay.test" }), deps)!;
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://relay.test");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, fp: "16f9-b5d1-30fb-8923", machineName: "mini", port: 3847 });
  });
  test("无 Origin（本机 curl / 同源）照答，不发 CORS 头", async () => {
    const res = localProbeResponse(req("/local-probe", LOOPBACK), deps)!;
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  test("其它跨源 403；http 的中继名 403；没连中继（base 为空）时任何跨源都 403", () => {
    expect(localProbeResponse(req("/local-probe", LOOPBACK, { origin: "https://evil.test" }), deps)!.status).toBe(403);
    expect(localProbeResponse(req("/local-probe", LOOPBACK, { origin: "http://relay.test" }), deps)!.status).toBe(403);
    expect(localProbeResponse(req("/local-probe", LOOPBACK, { origin: "https://relay.test" }), { ...deps, relayBase: () => null })!.status).toBe(403);
  });
  test("不是真实回环（反代转来 / 局域网 / 中继隧道）一律 404——探测的意义就是证明浏览器摸得到回环", () => {
    for (const source of ["lan", "relay"] as const) {
      expect(localProbeResponse(req("/local-probe", { source, clientIp: "127.0.0.1", https: true }, { origin: "https://relay.test" }), deps)!.status).toBe(404);
    }
  });
  test("OPTIONS 预检：204 + Allow-Private-Network；其它方法 405", () => {
    const pre = localProbeResponse(req("/local-probe", LOOPBACK, { method: "OPTIONS", origin: "https://relay.test" }), deps)!;
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-private-network")).toBe("true");
    expect(localProbeResponse(req("/local-probe", LOOPBACK, { method: "POST", origin: "https://relay.test" }), deps)!.status).toBe(405);
  });
});
