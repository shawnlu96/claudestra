/**
 * bridge/local-api/quota.ts：订阅额度接口的权限矩阵（与台账同一道门）、参数校验、开关读写、服务没起来时 503、
 * 响应里没有凭据 / 原始账户 id / email。服务是真实的 createQuotaService + 假凭据 / fetch / 内存存储。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { handleLocalApi, LOCAL_API_FEATURES } from "../src/bridge/local-api/index.js";
import { createQuotaService, setQuotaServiceForTest } from "../src/bridge/quota-service.js";
import { canReadLedger, canSeeQuota, effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import type { Principal } from "../src/lib/principals.js";
import { confirmCredential, hmacHex, peekAccountKey, readClaudeCredential, readCodexCredential } from "../src/lib/quota-credentials.js";
import { QuotaScheduler } from "../src/lib/quota-scheduler.js";
import { memoryQuotaStore } from "../src/lib/quota-state.js";
import { SECRET, T0, expectNoSentinel, fakeCredDeps, fakeFetch, okRoutes } from "./quota-fixtures.js";

const at = "2026-09-28T00:00:00Z";
const cred = (grant: Grant): DeviceCredential => ({ id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const device = (grant: Grant, base: Principal = OWNER_BASE) => effectivePrincipal({ principal: base, credential: cred(grant) });

const MATRIX: [string, Principal, boolean][] = [
  ["owner 设备 · 全 scope", device({ agents: ["*"], terminal: true, manage: true }), true],
  ["owner 设备 · 部分 scope", device({ agents: ["worker"], terminal: true, manage: true }), false],
  ["owner 设备 · 全 scope 但 manage 关", device({ agents: ["*"], terminal: false, manage: false }), false],
  ["guest 设备", device({ agents: ["*"], terminal: false, manage: true }, { id: "guest:g", role: "external", agents: ["*"], createdAt: at }), false],
  ["peer token（历史上签过 *）", { id: "token:tok_peer", role: "external", agents: ["*"], peer: "P", createdAt: at }, false],
  ["老的 * Bearer token（canManage 过渡期放行）", { id: "token:tok_old", role: "external", agents: ["*"], createdAt: at }, true],
  ["部分 scope 的 Bearer token", { id: "token:tok_s", role: "external", agents: ["worker"], createdAt: at }, false],
];
const OWNER = MATRIX[0][1];

const persisted: boolean[] = [];
const fetch = fakeFetch((url) => okRoutes(url));

beforeAll(() => {
  const cd = fakeCredDeps();
  const svc = createQuotaService({
    now: () => T0,
    makeScheduler: (isEnabled) => new QuotaScheduler({
      now: () => T0, random: () => 0.5, fetch,
      readCredential: (p) => (p === "claude" ? readClaudeCredential(cd) : readCodexCredential(cd)),
      peekAccountKey: (p) => peekAccountKey(p, cd),
      confirmCredential: (c) => confirmCredential(c, cd),
      hashCreditId: (a, id) => hmacHex(SECRET, a, id),
      store: memoryQuotaStore(),
      isEnabled,
    }),
    readEnabled: () => true,
    writeEnabled: async (v) => void persisted.push(v),
    local: async () => ({ claudeCache: null, codexRollout: null, extra: [] }),
    afterTick: async () => {},
    setTimer: () => 0,
    clearTimer: () => {},
    log: () => {},
  });
  setQuotaServiceForTest(svc);
});
afterAll(() => setQuotaServiceForTest(null));

async function call(path: string, p: Principal = OWNER, method = "GET", json?: unknown): Promise<Response> {
  const r = new Request(`http://bridge.local/api/v1${path}`, { method, ...(json !== undefined ? { body: JSON.stringify(json), headers: { "content-type": "application/json" } } : {}) });
  return (await handleLocalApi(r, new URL(r.url), p))!;
}

describe("权限：canSeeQuota 矩阵（三个端点一致，与 canReadLedger 同口径）", () => {
  for (const [name, p, ok] of MATRIX) {
    test(`${name} → ${ok ? "放行" : "403"}`, async () => {
      expect(canSeeQuota(p)).toBe(canReadLedger(p));
      expect((await call("/quota", p)).status).toBe(ok ? 200 : 403);
      expect((await call("/quota/settings", p)).status).toBe(ok ? 200 : 403);
      expect((await call("/quota/retry", p, "POST", { provider: "codex" })).status).toBe(ok ? 200 : 403);
    });
  }
  test("被拒的调用方连开关都改不了", async () => {
    const n = persisted.length;
    expect((await call("/quota/settings", MATRIX[1][1], "PUT", { enabled: false })).status).toBe(403);
    expect(persisted.length).toBe(n);
  });
});

describe("GET /quota", () => {
  test("两家实时卡；响应里没有 token / 原始账户 id / email / credit 原始 id", async () => {
    const r = await call("/quota");
    const text = await r.text();
    expectNoSentinel(text);
    const j = JSON.parse(text);
    expect(j.ok).toBe(true);
    expect(j.enabled).toBe(true);
    expect(j.snapshot.providers.map((p: { id: string }) => p.id)).toEqual(["claude", "codex"]);
    expect(LOCAL_API_FEATURES).toContain("quota");
  });
});

describe("参数与方法", () => {
  test("retry 的 provider 只认 claude / codex；非法 JSON 400；方法不对 405", async () => {
    expect((await call("/quota/retry", OWNER, "POST", { provider: "pi" })).status).toBe(400);
    const bad = new Request("http://bridge.local/api/v1/quota/retry", { method: "POST", body: "{", headers: { "content-type": "application/json" } });
    expect((await handleLocalApi(bad, new URL(bad.url), OWNER))!.status).toBe(400);
    expect((await call("/quota", OWNER, "POST")).status).toBe(405);
    expect((await call("/quota/retry")).status).toBe(405);
    expect((await call("/quota/settings", OWNER, "PUT", { enabled: "no" })).status).toBe(400);
  });

  test("开关：PUT 落盘并立即生效，GET 读回", async () => {
    const r = await call("/quota/settings", OWNER, "PUT", { enabled: false });
    expect(await r.json()).toEqual({ ok: true, enabled: false });
    expect(persisted.at(-1)).toBe(false);
    expect(await (await call("/quota/settings")).json()).toEqual({ ok: true, enabled: false });
    expect(((await (await call("/quota")).json()) as { snapshot: { providers: unknown[] } }).snapshot.providers).toEqual([]);
    await call("/quota/settings", OWNER, "PUT", { enabled: true });
  });

  test("服务没起来（沙箱 / 启动早期）→ 503", async () => {
    const { quotaService } = await import("../src/bridge/quota-service.js");
    const keep = quotaService();
    setQuotaServiceForTest(null);
    try {
      expect((await call("/quota")).status).toBe(503);
      expect((await call("/quota/settings", MATRIX[1][1])).status).toBe(403); // 门先于 503：非 owner 看不出服务状态
    } finally {
      setQuotaServiceForTest(keep);
    }
  });
});
