/**
 * bridge/local-api/quota.ts：订阅额度接口的权限矩阵（与台账同一道门）、参数校验、开关读写、服务没起来时 503、
 * 响应里没有凭据 / 原始账户 id / email；使用重置卡（POST /quota/codex/reset-credit）的更严一道门、参数、在途 409。
 * 服务是真实的 createQuotaService + 假凭据 / fetch / 内存存储；使用接口是假 POST，真实接口一次都不调。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { handleLocalApi, LOCAL_API_FEATURES } from "../src/bridge/local-api/index.js";
import { createQuotaService, setQuotaServiceForTest } from "../src/bridge/quota-service.js";
import { heldFields, stopExtra } from "../src/bridge/api-respond.js";
import { canReadLedger, canSeeQuota, effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import type { Principal } from "../src/lib/principals.js";
import { confirmCredential, hmacHex, peekAccountKey, readClaudeCredential, readCodexCredential } from "../src/lib/quota-credentials.js";
import { QuotaScheduler } from "../src/lib/quota-scheduler.js";
import { memoryQuotaStore } from "../src/lib/quota-state.js";
import { CODEX_ACCOUNT, CREDIT_IDS, SECRET, T0, expectNoSentinel, fakeCredDeps, fakeFetch, fakePost, jsonResponse, usableRoutes } from "./quota-fixtures.js";

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
let cfgEnabled = true; // 假 config.json：写了就读回（服务每个 tick / GET 现读）
let usable = 0; // 此刻可用次数（只影响使用重置卡；其余用例与 T2a 样例一样是 0）
const fetch = fakeFetch((url) => usableRoutes(() => usable)(url));
let postGate: Promise<void> = Promise.resolve();
const post = fakePost(async () => {
  await postGate;
  return jsonResponse(200, { code: "reset", windows_reset: 2 });
});

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
      consumeFetch: post,
    }),
    readEnabled: () => cfgEnabled,
    writeEnabled: async (v) => {
      persisted.push(v);
      cfgEnabled = v;
    },
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
  test("API 202 押住时：queued 给所有人，原因 heldBy 只给能看额度的（api-respond heldFields，与这里同口径）", () => {
    for (const [, p, ok] of MATRIX) expect(heldFields("wall_menu", p)).toEqual({ queued: true, heldBy: ok ? "wall_menu" : undefined });
    expect(heldFields(undefined, OWNER)).toEqual({});
  });

  test("停止回执停在撞墙画面上：wallWait 只给能看额度的，别人拿中性的 refused（T24 审查 P2-5）", () => {
    for (const [, p, ok] of MATRIX) {
      const r = stopExtra({ keys: [], wall: "countdown" }, p);
      expect([r.wallWait, r.refused]).toEqual(ok ? [true, undefined] : [undefined, true]);
    }
  });
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

describe("POST /quota/codex/reset-credit（使用重置卡，真实消费）", () => {
  const PATH = "/quota/codex/reset-credit";
  /** 与 GET /quota 里那张卡的 key 同一口径：HMAC(密钥, 账户键 + 原始 id) */
  const keyOf = (rawId: string) => hmacHex(SECRET, hmacHex(SECRET, "codex", CODEX_ACCOUNT), rawId);
  afterEach(() => {
    usable = 0;
    postGate = Promise.resolve();
  });

  test("比看额度再严一道：只有 owner 本人的设备凭据放行，老的全 scope Bearer / guest / peer / 部分 scope 一律 403，上游一个请求都不发", async () => {
    usable = 1;
    const n = { post: post.calls.length, get: fetch.calls.length };
    for (const [name, p] of MATRIX.slice(1)) {
      const r = await call(PATH, p, "POST", { creditKey: null });
      expect([name, r.status]).toEqual([name, 403]);
    }
    expect([post.calls.length, fetch.calls.length]).toEqual([n.post, n.get]);
  });

  test("owner：按 GET /quota 给的键用那张卡，结果原样返回；响应里没有原始 credit id / 凭据", async () => {
    usable = 1;
    const r = await call(PATH, OWNER, "POST", { creditKey: keyOf(CREDIT_IDS[1]) });
    const text = await r.text();
    expectNoSentinel(text);
    expect(r.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: true, result: { status: "done", code: "reset", windowsReset: 2 } });
    expect(post.calls.at(-1)?.body.credit_id).toBe(CREDIT_IDS[1]);
  });

  test("此刻可用为 0：200 + refused not_applicable，POST 没发", async () => {
    const n = post.calls.length;
    expect(await (await call(PATH, OWNER, "POST", {})).json()).toEqual({ ok: true, result: { status: "refused", code: "not_applicable" } });
    expect(post.calls.length).toBe(n);
  });

  test("连点：第二个请求 409，上游只收到一次 POST", async () => {
    usable = 1;
    let release: () => void = () => {};
    postGate = new Promise<void>((r) => (release = r));
    const n = post.calls.length;
    const first = call(PATH, OWNER, "POST", {});
    for (let i = 0; i < 500 && post.calls.length === n; i++) await Bun.sleep(2); // 等第一个真走到 POST 在途（全量并跑时机器忙，不按固定时长猜）
    const second = await call(PATH, OWNER, "POST", {});
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(post.calls.length).toBe(n + 1);
  });

  test("手改 config 关掉开关（没走 PUT）：消费入口现读开关 → refused disabled，POST 0（审查 #687）", async () => {
    usable = 1;
    const n = post.calls.length;
    cfgEnabled = false;
    try {
      expect(await (await call(PATH, OWNER, "POST", {})).json()).toEqual({ ok: true, result: { status: "refused", code: "disabled" } });
      expect(post.calls.length).toBe(n);
    } finally {
      cfgEnabled = true;
    }
  });

  test("参数与方法：creditKey 只收 32 位 hex 或不给；坏 JSON 400；GET 405；服务没起来时门先于 503", async () => {
    const n = post.calls.length;
    for (const bad of [{ creditKey: 1 }, { creditKey: "xyz" }, { creditKey: CREDIT_IDS[0] }]) expect((await call(PATH, OWNER, "POST", bad)).status).toBe(400);
    const raw = new Request(`http://bridge.local/api/v1${PATH}`, { method: "POST", body: "{", headers: { "content-type": "application/json" } });
    expect((await handleLocalApi(raw, new URL(raw.url), OWNER))!.status).toBe(400);
    expect((await call(PATH)).status).toBe(405);
    const { quotaService } = await import("../src/bridge/quota-service.js");
    const keep = quotaService();
    setQuotaServiceForTest(null);
    try {
      expect((await call(PATH, OWNER, "POST", {})).status).toBe(503);
      expect((await call(PATH, MATRIX[5][1], "POST", {})).status).toBe(403);
    } finally {
      setQuotaServiceForTest(keep);
    }
    expect(post.calls.length).toBe(n);
  });
});
