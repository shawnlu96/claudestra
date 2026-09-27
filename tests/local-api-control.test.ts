/** 本地 API：控制路由的 manage 版 GET /api/v1/relay/status · POST /api/v1/relay/pair · GET /api/v1/stats——没 manage grant 一律 403 */
import { describe, expect, test } from "bun:test";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import type { Principal } from "../src/lib/principals.js";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1234", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };
/** owner 本人的设备，但这条凭据签的时候没给 manage */
const OWNER_NO_MANAGE: Principal = { ...OWNER, manage: false, credential: "dev_o2" };
/** 老的全 scope 非 peer token：过渡期仍算 manage（lib/devices.ts canManage） */
const LEGACY_TOKEN: Principal = { id: "token:tok_1234", role: "external", name: "web-ui", agents: ["*"], secret: "x", createdAt: "2026-01-01T00:00:00Z" };
const PEER_TOKEN: Principal = { ...LEGACY_TOKEN, id: "token:tok_peer", peer: "sekai" };

async function call(method: string, path: string, p: Principal, body?: unknown): Promise<Response | null> {
  const r = new Request(`http://bridge.local${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return handleLocalApi(r, new URL(r.url), p);
}

describe("manage 门", () => {
  test("guest / 无 manage 的 owner 设备 / peer token → 403，三个端点一致", async () => {
    for (const p of [GUEST, OWNER_NO_MANAGE, PEER_TOKEN]) {
      expect((await call("GET", "/api/v1/relay/status", p))!.status).toBe(403);
      expect((await call("POST", "/api/v1/relay/pair", p, {}))!.status).toBe(403);
      expect((await call("GET", "/api/v1/stats", p))!.status).toBe(403);
    }
  });
  test("别的方法 / 路径 → null（不抢 api-routes 的路）", async () => {
    expect(await call("POST", "/api/v1/relay/status", OWNER)).toBeNull();
    expect(await call("GET", "/api/v1/relay/pair", OWNER)).toBeNull();
    expect(await call("POST", "/api/v1/stats", OWNER)).toBeNull();
    expect(await call("GET", "/api/v1/stats/refresh", OWNER)).toBeNull();
  });
});

describe("relay 端点（进程里没有中继连接）", () => {
  test("GET /relay/status：与回环 /relay/status 同一个体（ok + relayInfo + peers + pairingCodes）", async () => {
    for (const p of [OWNER, LEGACY_TOKEN]) {
      const res = (await call("GET", "/api/v1/relay/status", p))!;
      expect(res.status).toBe(200);
      const j = (await res.json()) as Record<string, unknown>;
      expect(j.ok).toBe(true);
      expect(typeof j.enabled).toBe("boolean");
      expect(j.connected).toBe(false);
      expect(j.peers).toEqual([]);
      expect(typeof j.pairingCodes).toBe("number");
    }
  });
  test("POST /relay/pair：没连上中继也能签（直托管入口配对）——没有链接与中继名字，只有短码 / fragment / grant", async () => {
    const res = (await call("POST", "/api/v1/relay/pair", OWNER, { agents: ["worker"], terminal: false }))!;
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j).toMatchObject({ ok: true, link: null, url: null, base: null, grant: { agents: ["worker"], terminal: false, manage: true } });
    expect(String(j.display)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(String(j.fragment)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}\./);
  });
});
