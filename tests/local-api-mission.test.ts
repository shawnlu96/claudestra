/** bridge/local-api/mission.ts：网页开 / 关 Autopilot——要 manage、要在 scope 内、agent 要存在、目标与截止时间要合法 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { setMissionApiPathsForTest } from "../src/bridge/local-api/mission.js";
import { readMissions } from "../src/lib/missions.js";
import type { Principal } from "../src/lib/principals.js";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const GUEST: Principal = { id: "guest:1", role: "external", name: "g", agents: ["worker"], createdAt: "2026-01-01T00:00:00Z", manage: false, credential: "dev_g1" };
const dir = mkdtempSync(join(tmpdir(), "mission-api-"));
const missions = join(dir, "missions.json");

beforeAll(() => {
  writeFileSync(join(dir, "registry.json"), JSON.stringify({ socket: "", agents: { "agent-worker": { cwd: dir, status: "active" } } }));
  setMissionApiPathsForTest({ missions, registry: join(dir, "registry.json") });
});
afterAll(() => setMissionApiPathsForTest(undefined));

async function call(method: string, path: string, p: Principal, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) };
  const r = new Request(`http://bridge.local/api/v1${path}`, init);
  return (await handleLocalApi(r, new URL(r.url), p))!;
}

describe("POST / DELETE /api/v1/agents/:name/mission", () => {
  test("开：写进状态文件（去掉 agent- 前缀），截止时间按 +4h 解析", async () => {
    const res = await call("POST", "/agents/agent-worker/mission", OWNER, { goal: "按台账推进", until: "+4h" });
    expect(res.status).toBe(200);
    const m = (await readMissions(missions)).worker;
    expect(m).toMatchObject({ agent: "worker", goal: "按台账推进", status: "active", nudges: 0 });
    expect(Date.parse(m.until) - Date.now()).toBeGreaterThan(3.9 * 3_600_000);
  });
  test("关：变 stopped；再关一次 404", async () => {
    expect((await call("DELETE", "/agents/worker/mission", OWNER)).status).toBe(200);
    expect((await readMissions(missions)).worker.status).toBe("stopped");
    expect((await call("DELETE", "/agents/worker/mission", OWNER)).status).toBe(404);
  });
  test("没有 manage 403；不存在的 agent 404；没目标 / 截止时间写错 400；master 可以", async () => {
    expect((await call("POST", "/agents/worker/mission", GUEST, { goal: "x", until: "+1h" })).status).toBe(403);
    expect((await call("POST", "/agents/ghost/mission", OWNER, { goal: "x", until: "+1h" })).status).toBe(404);
    expect((await call("POST", "/agents/worker/mission", OWNER, { goal: " ", until: "+1h" })).status).toBe(400);
    expect((await call("POST", "/agents/worker/mission", OWNER, { goal: "x", until: "明早" })).status).toBe(400);
    expect((await call("POST", "/agents/master/mission", OWNER, { goal: "x", until: "+1h" })).status).toBe(200);
  });
});
