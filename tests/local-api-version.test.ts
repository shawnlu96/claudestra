/** 本地 API：GET /api/v1/version 与直托管入口配置 /app-config.json（src/bridge/local-api/version.ts） */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiFeatures } from "../src/bridge/api-extensions.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { API_VERSION, appConfigResponse, MIN_CLIENT } from "../src/bridge/local-api/version.js";
import type { Principal } from "../src/lib/principals.js";
import { REPO_ROOT } from "../src/lib/repo-root.js";

const semver = (v: string) => v.split(".").map(Number) as [number, number, number];
const lte = (a: string, b: string) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return true;
};

const GUEST: Principal = { id: "guest:1234", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };
const call = (method: string, path: string, p: Principal = GUEST) => {
  const r = new Request(`http://bridge.local${path}`, { method });
  return handleLocalApi(r, new URL(r.url), p);
};

describe("GET /api/v1/version", () => {
  test("任何凭据都能读：version 来自根 package.json，commit 是短 hash，apiVersion / minClient 是常量", async () => {
    const res = (await call("GET", "/api/v1/version"))!;
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(j.commit).toMatch(/^[0-9a-f]{7,12}$/);
    expect(j.apiVersion).toBe(API_VERSION);
    expect(j.minClient).toBe(MIN_CLIENT);
    // MIN_CLIENT 不能高于当前仓库版本：bundle 烤入的是 package.json 的版本，写高了刚构建的前端都会被判太旧
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    expect(lte(MIN_CLIENT, pkg.version)).toBe(true);
  });
  test("别的方法 / 未知路径 → null（交给 api-routes 自己的路由）", async () => {
    expect(await call("POST", "/api/v1/version")).toBeNull();
    expect(await call("GET", "/api/v1/agents")).toBeNull();
    expect(await call("GET", "/api/v1/settings/archive-retention")).toBeNull();
  });
  test("capabilities 里报的 apiVersion 与 features", () => {
    const f = apiFeatures();
    expect(f.apiVersion).toBe(1);
    for (const name of ["settings", "profile", "transcribe", "client-log", "host-open", "attachments", "control"]) expect(f.features).toContain(name);
  });
});

describe("GET /app-config.json（直托管）", () => {
  test("mode direct + 本机指纹 + 机器名 + 版本；不缓存", async () => {
    const res = await appConfigResponse();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.mode).toBe("direct");
    expect(j.fp).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(typeof j.machineName).toBe("string");
    expect(j.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
