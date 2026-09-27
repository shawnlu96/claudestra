/** 本地 API：/api/v1/agents/:name/settings（开机指令）、/api/v1/agents/:name/hidden（跨设备隐藏区间）、/api/v1/skills/prefs（置顶 / 使用频次） */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setWebStatePathForTest } from "../src/bridge/local-api/db.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import type { Principal } from "../src/lib/principals.js";
import { closeWebState } from "../src/lib/web-state.js";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1234", role: "external", name: "friend", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };

let dir: string;
let dbPath: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "local-api-prefs-"));
  dbPath = join(dir, "web-state.sqlite");
  setWebStatePathForTest(dbPath);
});
afterAll(() => {
  setWebStatePathForTest(undefined);
  closeWebState(dbPath);
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, p: Principal, body?: unknown): Promise<Response> {
  const r = new Request(`http://bridge.local${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  return (await handleLocalApi(r, new URL(r.url), p))!;
}
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("/api/v1/agents/:name/settings", () => {
  test("没设过是 null；PUT 字符串后读回；PUT null 清除；agent 名按路径参数原样存", async () => {
    expect(await json(await call("GET", "/api/v1/agents/worker/settings", OWNER))).toEqual({ ok: true, initMessage: null });
    expect(await json(await call("PUT", "/api/v1/agents/worker/settings", OWNER, { initMessage: "读一下 HANDOFF.md" }))).toEqual({ ok: true, initMessage: "读一下 HANDOFF.md" });
    expect(await json(await call("GET", "/api/v1/agents/worker/settings", GUEST))).toEqual({ ok: true, initMessage: "读一下 HANDOFF.md" });
    expect(await json(await call("GET", "/api/v1/agents/agent-worker/settings", OWNER))).toEqual({ ok: true, initMessage: null });
    expect(await json(await call("PUT", "/api/v1/agents/worker/settings", OWNER, { initMessage: null }))).toEqual({ ok: true, initMessage: null });
  });
  test("scope：guest 碰不到不在名单里的 agent；坏体 400", async () => {
    expect((await call("GET", "/api/v1/agents/other/settings", GUEST)).status).toBe(403);
    expect((await call("PUT", "/api/v1/agents/master/settings", GUEST, { initMessage: "x" })).status).toBe(403);
    expect((await call("PUT", "/api/v1/agents/worker/settings", OWNER, { initMessage: 5 })).status).toBe(400);
    expect((await call("PUT", "/api/v1/agents/worker/settings", OWNER, "{")).status).toBe(400);
  });
  test("别的方法 → null", async () => {
    const r = new Request("http://bridge.local/api/v1/agents/worker/settings", { method: "DELETE" });
    expect(await handleLocalApi(r, new URL(r.url), OWNER)).toBeNull();
  });
});

describe("/api/v1/agents/:name/hidden", () => {
  const SID = "0f3a9c1e-1111-4222-8333-444455556666";
  test("隐藏区间：POST 记、GET 读、同 fromSeq 再 POST 覆盖 toSeq、hide:false 撤销", async () => {
    expect(await json(await call("GET", "/api/v1/agents/worker/hidden", OWNER))).toEqual({ ok: true, ranges: [] });
    expect(await json(await call("POST", "/api/v1/agents/worker/hidden", OWNER, { sessionId: SID, fromSeq: 10, toSeq: 14, hide: true }))).toEqual({
      ok: true, ranges: [{ sessionId: SID, fromSeq: 10, toSeq: 14 }],
    });
    await call("POST", "/api/v1/agents/worker/hidden", OWNER, { sessionId: SID, fromSeq: 3 });
    await call("POST", "/api/v1/agents/worker/hidden", OWNER, { sessionId: SID, fromSeq: 10, toSeq: 20 });
    expect(await json(await call("GET", "/api/v1/agents/worker/hidden", GUEST))).toEqual({
      ok: true, ranges: [{ sessionId: SID, fromSeq: 3, toSeq: 3 }, { sessionId: SID, fromSeq: 10, toSeq: 20 }],
    });
    expect(await json(await call("POST", "/api/v1/agents/worker/hidden", OWNER, { sessionId: SID, fromSeq: 10, hide: false }))).toEqual({
      ok: true, ranges: [{ sessionId: SID, fromSeq: 3, toSeq: 3 }],
    });
    // 另一个 agent 的记录互不可见
    expect(await json(await call("GET", "/api/v1/agents/other/hidden", OWNER))).toEqual({ ok: true, ranges: [] });
  });
  test("校验：sessionId 形状、区间非负 / 不倒置 / 不超 10000；guest 越 scope 403", async () => {
    expect((await call("POST", "/api/v1/agents/worker/hidden", OWNER, { sessionId: "a b", fromSeq: 1 })).status).toBe(400);
    expect((await call("POST", "/api/v1/agents/worker/hidden", OWNER, { sessionId: SID, fromSeq: -1 })).status).toBe(400);
    expect((await call("POST", "/api/v1/agents/worker/hidden", OWNER, { sessionId: SID, fromSeq: 5, toSeq: 4 })).status).toBe(400);
    expect((await call("POST", "/api/v1/agents/worker/hidden", OWNER, { sessionId: SID, fromSeq: 0, toSeq: 10_001 })).status).toBe(400);
    expect((await call("POST", "/api/v1/agents/worker/hidden", OWNER, { sessionId: SID, fromSeq: 1.5 })).status).toBe(400);
    expect((await call("POST", "/api/v1/agents/other/hidden", GUEST, { sessionId: SID, fromSeq: 1 })).status).toBe(403);
  });
});

describe("/api/v1/skills/prefs", () => {
  test("空表；used +1 累计；pinned 开关；置顶的排前面；任何凭据都能改", async () => {
    expect(await json(await call("GET", "/api/v1/skills/prefs", GUEST))).toEqual({ ok: true, prefs: [] });
    await call("POST", "/api/v1/skills/prefs/save-compact/used", GUEST);
    await call("POST", "/api/v1/skills/prefs/save-compact/used", GUEST);
    await call("POST", "/api/v1/skills/prefs/run/used", GUEST);
    const pinned = await json(await call("PUT", "/api/v1/skills/prefs/run", OWNER, { pinned: true }));
    const prefs = pinned.prefs as { name: string; pinned: boolean; usedCount: number }[];
    expect(prefs.map((p) => [p.name, p.pinned, p.usedCount])).toEqual([["run", true, 1], ["save-compact", false, 2]]);
    const un = await json(await call("PUT", "/api/v1/skills/prefs/run", OWNER, { pinned: false }));
    expect((un.prefs as { name: string }[]).map((p) => p.name)).toEqual(["save-compact", "run"]);
    // 从没用过、直接置顶：used_count 0
    const fresh = await json(await call("PUT", "/api/v1/skills/prefs/anthropic-skills:pdf", OWNER, { pinned: true }));
    expect((fresh.prefs as { name: string; pinned: boolean; usedCount: number }[])[0]).toMatchObject({ name: "anthropic-skills:pdf", pinned: true, usedCount: 0 });
  });
  test("校验：名字只认 [\\w:-]{1,64}；pinned 必须布尔；used 只认 POST、pinned 只认 PUT", async () => {
    expect((await call("PUT", "/api/v1/skills/prefs/bad%20name", OWNER, { pinned: true })).status).toBe(400);
    expect((await call("PUT", "/api/v1/skills/prefs/run", OWNER, { pinned: "yes" })).status).toBe(400);
    const r = new Request("http://bridge.local/api/v1/skills/prefs/run/used", { method: "PUT" });
    expect(await handleLocalApi(r, new URL(r.url), OWNER)).toBeNull();
    const r2 = new Request("http://bridge.local/api/v1/skills/prefs/run", { method: "POST" });
    expect(await handleLocalApi(r2, new URL(r2.url), OWNER)).toBeNull();
  });
});
