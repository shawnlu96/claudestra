/**
 * 批量管理的入口权限：HTTP（bridge/local-api/fleet.ts）只给 owner 本人的全 scope manage 凭据；
 * CLI 的 ws 请求（bridge/fleet/ws.ts）只收升级时判定为直连回环的连接。状态目录由 tests/preload.ts 隔离到临时目录。
 */
import { describe, expect, test } from "bun:test";
import { handleFleetWs } from "../src/bridge/fleet/ws.js";
import { sseEventAllow } from "../src/bridge/ledger-feed.js";
import { handleLocalApi, LOCAL_API_FEATURES } from "../src/bridge/local-api/index.js";
import { effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import { canRunFleet, type Principal } from "../src/lib/principals.js";

const at = "2026-09-29T00:00:00Z";
const cred = (grant: Grant): DeviceCredential => ({ id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const device = (grant: Grant, base: Principal = OWNER_BASE) => effectivePrincipal({ principal: base, credential: cred(grant) });

const MATRIX: [string, Principal, boolean][] = [
  ["owner 设备 · 全 scope + manage", device({ agents: ["*"], terminal: true, manage: true }), true],
  ["owner 设备 · 部分 scope", device({ agents: ["worker"], terminal: true, manage: true }), false],
  ["owner 设备 · manage 关", device({ agents: ["*"], terminal: false, manage: false }), false],
  ["guest 设备", device({ agents: ["*"], terminal: false, manage: true }, { id: "guest:g", role: "external", agents: ["*"], createdAt: at }), false],
  ["peer token（历史上签过 *）", { id: "token:tok_peer", role: "external", agents: ["*"], peer: "P", createdAt: at }, false],
  ["不是 owner 的 * Bearer token", { id: "token:tok_old", role: "external", agents: ["*"], createdAt: at }, false],
  ["部分 scope 的 Bearer token", { id: "token:tok_s", role: "external", agents: ["worker"], createdAt: at }, false],
];

const call = (p: Principal, path: string, init?: RequestInit) => handleLocalApi(new Request(`http://x/api/v1${path}`, init), new URL(`http://x/api/v1${path}`), p);
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("HTTP 权限矩阵", () => {
  for (const [name, p, allowed] of MATRIX) {
    test(`${name} → ${allowed ? "放行" : "403"}`, async () => {
      expect(canRunFleet(p)).toBe(allowed);
      const state = await call(p, "/fleet/state");
      const run = await call(p, "/fleet/run", post({ action: { kind: "lp-on" }, select: { all: true }, dryRun: true }));
      expect(state?.status).toBe(allowed ? 200 : 403);
      expect(run?.status).toBe(allowed ? 200 : 403);
    });
  }

  test("features 里报 fleet", () => expect(LOCAL_API_FEATURES).toContain("fleet"));
});

describe("HTTP 参数校验（owner）", () => {
  const owner = MATRIX[0]![1];
  test("动作不在白名单 → 400", async () => {
    const r = await call(owner, "/fleet/run", post({ action: { kind: "rm-rf" }, select: { all: true } }));
    expect(r?.status).toBe(400);
  });
  test("没给范围 → 400", async () => {
    const r = await call(owner, "/fleet/run", post({ action: { kind: "compact" }, select: {} }));
    expect(r?.status).toBe(400);
  });
  test("方法不对 → 405", async () => {
    expect((await call(owner, "/fleet/run"))?.status).toBe(405);
    expect((await call(owner, "/fleet/state", post({})))?.status).toBe(405);
  });
  test("预演只列目标、不发键（空 registry → 没有目标）", async () => {
    const r = await call(owner, "/fleet/run", post({ action: { kind: "lp-compact" }, select: { all: true }, dryRun: true }));
    const body = (await r!.json()) as { report: { dryRun: boolean; results: unknown[] } };
    expect(body.report.dryRun).toBe(true);
    expect(body.report.results).toEqual([]);
  });
});

describe("ws：只收直连回环", () => {
  test("升级时没标 loopback（非回环 / 带 XFF 的反代）→ 拒绝", async () => {
    for (const data of [undefined, {}, { loopback: false }, { loopback: "true" }]) {
      expect(await handleFleetWs({ type: "fleet_state" }, data)).toEqual({ error: "批量管理只收本机直连回环的连接" });
    }
  });
  test("回环 + 坏参数 → 报错而不是执行", async () => {
    expect((await handleFleetWs({ type: "fleet_run", action: { kind: "nope" }, select: { all: true } }, { loopback: true })).error).toContain("动作只能是");
    expect((await handleFleetWs({ type: "fleet_run", action: { kind: "compact" }, select: {} }, { loopback: true })).error).toContain("要指定");
  });
});

describe("ws：认不出调用方是不是 owner，只给最低权限（adv1 P1-1）", () => {
  const ws = (action: unknown, select: unknown) => handleFleetWs({ type: "fleet_run", action, select, dryRun: true }, { loopback: true });
  test("群发文字、自定义保留清单、带上大总管（includeMaster 或点名）一律拒收", async () => {
    for (const [action, select] of [
      [{ kind: "text", text: "hi" }, { all: true }],
      [{ kind: "compact", keep: "新任务：git push --force" }, { all: true }],
      [{ kind: "compact" }, { all: true, includeMaster: true }],
      [{ kind: "lp-on" }, { agents: ["master"] }],
      [{ kind: "lp-on" }, { agents: ["a", "agent-master"] }],
    ] as const) {
      expect((await ws(action, select)).error).toContain("只在网页上用 owner 设备操作");
    }
  });
});

describe("low_priority 的 SSE 只推给 owner 的全权设备（和 /agents 的 lowPriority 字段、批量管理同一道门）", () => {
  const evt = { type: "low_priority", agent: "worker", chatId: "", data: {}, ts: 0 } as unknown as Parameters<ReturnType<typeof sseEventAllow>>[0];
  for (const [name, p, allowed] of MATRIX) test(`${name} → ${allowed ? "推" : "不推"}`, () => expect(sseEventAllow(p)(evt)).toBe(allowed));
});
