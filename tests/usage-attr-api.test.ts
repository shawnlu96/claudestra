/**
 * GET /api/v1/usage/task/:id、/usage/feature/:id（T95）：只给全权设备（canAdministerPairing：全 scope、非 peer、manage、设备凭据，老 Bearer 不放），
 * 只读（非 GET 405），能力列表里登记。验收线 P1：API 不得对非全权设备开放。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleLocalApi, LOCAL_API_FEATURES } from "../src/bridge/local-api/index.js";
import { setUsageDbPathForTest } from "../src/bridge/local-api/usage.js";
import { effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import type { Principal } from "../src/lib/principals.js";
import { openUsageDb } from "../src/lib/usage-store.js";

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
  ["老的全 scope Bearer token", { id: "token:test", role: "external", agents: ["*"], createdAt: at }, false],
  ["老的 owner 全 scope Bearer（web-ui）", { id: "token:tok_w", name: "web-ui", role: "owner", agents: ["*", "master"], createdAt: at }, false],
];
const OWNER = MATRIX[0][1];

beforeAll(() => {
  const path = join(mkdtempSync(join(tmpdir(), "usage-api-")), "usage.sqlite");
  const db = openUsageDb(path);
  db.prepare(`INSERT INTO turns (turn_id, agent, session_id, sidechain, started_at, kind, trigger, runtime, attr_task, attr_step, attr_round, attr_item, attr_basis)
    VALUES ('t1', 'agent-a', 's', 0, 1000, 'channel', '', 'claude-code', 'T1', 'write', 1, 'i1', 'step')`).run();
  db.prepare(`INSERT INTO calls (key, turn_id, ts, day, model, input, cache_creation, cache_read, output, reasoning)
    VALUES ('c1', 't1', 2000, '2026-09-30', 'm', 1, 2, 3, 4, 0)`).run();
  db.close(); // 关库会 checkpoint 掉 -wal / -shm：路由的只读连接要在没有它们时也打得开
  setUsageDbPathForTest(path);
});
afterAll(() => setUsageDbPathForTest(null));

async function call(p: Principal, path = "/usage/task/T1", method = "GET"): Promise<Response> {
  const r = new Request(`http://bridge.local/api/v1${path}`, { method });
  return (await handleLocalApi(r, new URL(r.url), p))!;
}

describe("权限矩阵", () => {
  for (const [name, p, ok] of MATRIX) {
    test(`${name} → ${ok ? "200" : "403"}（卡、feature、agent 三类路径）`, async () => {
      for (const path of ["/usage/task/T1", "/usage/feature/i1", "/usage/agent/agent-a"]) {
        const r = await call(p, path);
        expect(r.status).toBe(ok ? 200 : 403);
      }
    });
  }
});

test("全权设备拿到按步骤 / 按卡的数", async () => {
  const task = await (await call(OWNER, "/usage/task/T1")).json();
  expect(task).toMatchObject({ ok: true, task: "T1", rows: [{ step: "write", round: 1, agent: "agent-a", calls: 1, totalTokens: 10 }] });
  const feature = await (await call(OWNER, "/usage/feature/i1")).json();
  expect(feature).toMatchObject({ ok: true, feature: "i1", rows: [{ task: "T1", turns: 1, totalTokens: 10 }] });
  expect(await (await call(OWNER, "/usage/task/NOPE")).json()).toEqual({ ok: true, task: "NOPE", rows: [] });
});

test("只读：非 GET 一律 405（非全权先 403）", async () => {
  for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
    expect((await call(OWNER, "/usage/task/T1", m)).status).toBe(405);
    expect((await call(MATRIX[1][1], "/usage/task/T1", m)).status).toBe(403);
  }
});

test("能力列表登记 usage；别的路径不认", async () => {
  expect(LOCAL_API_FEATURES).toContain("usage");
  for (const p of ["/usage/task", "/usage/task/T1/x", "/usage/agent", "/usage"]) {
    const r = new Request(`http://bridge.local/api/v1${p}`);
    expect(await handleLocalApi(r, new URL(r.url), OWNER)).toBeNull();
  }
});
