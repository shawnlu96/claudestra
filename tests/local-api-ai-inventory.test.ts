/**
 * GET /api/v1/ai-inventory：只给全权设备（与额度看板同一道门 canSeeQuota），只读（非 GET 405），能力列表里登记。
 * 验收线 P1：API 不得对非全权设备开放；不得新增写操作。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setAiInventoryForTest } from "../src/bridge/local-api/ai-inventory.js";
import { handleLocalApi, LOCAL_API_FEATURES } from "../src/bridge/local-api/index.js";
import type { AiInventory } from "../src/lib/ai-inventory.js";
import { effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import type { Principal } from "../src/lib/principals.js";

const at = "2026-09-30T00:00:00Z";
const cred = (grant: Grant): DeviceCredential => ({ id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const device = (grant: Grant, base: Principal = OWNER_BASE) => effectivePrincipal({ principal: base, credential: cred(grant) });

const MATRIX: [string, Principal, boolean][] = [
  ["owner 设备 · 全 scope", device({ agents: ["*"], terminal: true, manage: true }), true],
  ["owner 设备 · 部分 scope", device({ agents: ["worker"], terminal: true, manage: true }), false],
  ["owner 设备 · 全 scope 但 manage 关", device({ agents: ["*"], terminal: false, manage: false }), false],
  ["guest 设备", device({ agents: ["*"], terminal: false, manage: true }, { id: "guest:g", role: "external", agents: ["*"], createdAt: at }), false],
  ["peer token（历史上签过 *）", { id: "token:tok_peer", role: "external", agents: ["*"], peer: "P", createdAt: at }, false],
  ["部分 scope 的 Bearer token", { id: "token:tok_s", role: "external", agents: ["worker"], createdAt: at }, false],
];
const OWNER = MATRIX[0][1];

const FAKE: AiInventory = { generatedAt: 1, runtimes: [] };
beforeAll(() => setAiInventoryForTest(FAKE));
afterAll(() => setAiInventoryForTest(null));

async function call(p: Principal, method = "GET"): Promise<Response> {
  const r = new Request("http://bridge.local/api/v1/ai-inventory", { method });
  return (await handleLocalApi(r, new URL(r.url), p))!;
}

describe("权限矩阵", () => {
  for (const [name, p, ok] of MATRIX) {
    test(`${name} → ${ok ? "200" : "403"}`, async () => {
      const r = await call(p);
      expect(r.status).toBe(ok ? 200 : 403);
      if (ok) expect(await r.json()).toEqual({ ok: true, ...FAKE });
    });
  }
});

test("只读：非 GET 一律 405（非全权先 403，看不出端点形状）", async () => {
  for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
    expect((await call(OWNER, m)).status).toBe(405);
    expect((await call(MATRIX[1][1], m)).status).toBe(403);
  }
});

test("能力列表登记 ai-inventory；别的路径不认", async () => {
  expect(LOCAL_API_FEATURES).toContain("ai-inventory");
  const r = new Request("http://bridge.local/api/v1/ai-inventory/x");
  expect(await handleLocalApi(r, new URL(r.url), OWNER)).toBeNull();
});
