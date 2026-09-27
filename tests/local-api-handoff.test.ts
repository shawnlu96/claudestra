/** bridge/local-api/handoff.ts：只收 cstra_ 键；同一身份才取得出；取一次即删；peer token 不能用 */
import { describe, expect, test } from "bun:test";
import { cleanEntries } from "../src/bridge/local-api/handoff.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import type { Principal } from "../src/lib/principals.js";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1234", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };
const PEER: Principal = { id: "token:tok_p", role: "external", name: "peer", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", peer: "alice" };

async function call(method: string, path: string, p: Principal, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) };
  const r = new Request(`http://bridge.local/api/v1${path}`, init);
  return (await handleLocalApi(r, new URL(r.url), p))!;
}

describe("cleanEntries", () => {
  test("只留 cstra_ 键的字符串值；不是对象 → null；超量 → null", () => {
    expect(cleanEntries({ cstra_theme: "dark", other: "x", cstra_n: 1 })).toEqual({ cstra_theme: "dark" });
    expect(cleanEntries(["cstra_theme"])).toBeNull();
    expect(cleanEntries(null)).toBeNull();
    expect(cleanEntries({ cstra_big: "x".repeat(300 * 1024) })).toBeNull();
  });
});

describe("POST / GET /api/v1/handoff", () => {
  test("存进去 → 同一身份取一次拿到，第二次 404", async () => {
    const created = (await (await call("POST", "/handoff", OWNER, { entries: { cstra_theme: "dark", evil: "1" } })).json()) as { id: string };
    expect(created.id).toMatch(/^[a-f0-9]{32}$/);
    const got = await call("GET", `/handoff/${created.id}`, OWNER);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ ok: true, entries: { cstra_theme: "dark" } });
    expect((await call("GET", `/handoff/${created.id}`, OWNER)).status).toBe(404);
  });
  test("别的身份取不到（也不消耗）；peer token 不能存；坏体 400", async () => {
    const { id } = (await (await call("POST", "/handoff", OWNER, { entries: { cstra_lang: "en" } })).json()) as { id: string };
    expect((await call("GET", `/handoff/${id}`, GUEST)).status).toBe(404);
    expect((await call("GET", `/handoff/${id}`, OWNER)).status).toBe(200);
    expect((await call("POST", "/handoff", PEER, { entries: {} })).status).toBe(403);
    expect((await call("POST", "/handoff", OWNER, { entries: "x" })).status).toBe(400);
  });
});
