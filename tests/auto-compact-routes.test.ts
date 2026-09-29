import { afterAll, expect, test } from "bun:test";
import { rmSync } from "fs";
import { handleAutoCompactRoute } from "../src/bridge/auto-compact-routes.js";
import { readConfig } from "../src/lib/config-store.js";
import { CONFIG_PATH } from "../src/lib/paths.js";
import type { Principal } from "../src/lib/principals.js";

const at = "2026-01-01T00:00:00Z";
const owner: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at };
const scoped: Principal = { id: "token:tok_a", role: "external", agents: ["agent-a"], createdAt: at };
const call = async (p: Principal, method: string, body?: unknown) => {
  const req = new Request("http://x/api/v1/auto-compact", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const r = (await handleAutoCompactRoute(req, "/auto-compact", p))!;
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

afterAll(() => rmSync(CONFIG_PATH, { force: true }));

test("inject 开关：GET 带出来（缺省关）；POST 只收布尔值，改完回读；别的路径不接（r3 P2-4：只装网页也能打开）", async () => {
  rmSync(CONFIG_PATH, { force: true });
  expect(await handleAutoCompactRoute(new Request("http://x/api/v1/other"), "/other", owner)).toBeNull();
  expect((await call(scoped, "GET")).status).toBe(403);
  expect((await call(owner, "GET")).body).toMatchObject({ ok: true, inject: false, emergency: true, defaults: { inject: false } });
  for (const bad of ["true", "false", 1, null]) {
    expect(await call(owner, "POST", { inject: bad })).toEqual({ status: 400, body: { ok: false, error: "inject must be true or false" } });
  }
  expect(await call(owner, "POST", { inject: true })).toMatchObject({ status: 200, body: { inject: true, emergency: true } });
  expect((await readConfig()).autoCompact?.inject).toBe(true);
  // 只改救命线不动开关；开关关掉不动救命线
  expect((await call(owner, "POST", { emergency: false })).body).toMatchObject({ inject: true, emergency: false });
  expect((await call(owner, "POST", { inject: false })).body).toMatchObject({ inject: false, emergency: false });
  expect(await call(owner, "POST", {})).toEqual({ status: 400, body: { ok: false, error: "nothing to set" } });
});
