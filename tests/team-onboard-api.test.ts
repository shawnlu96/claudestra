/** ONB-3 网页入口 POST /api/v1/projects/:id/onboard（bridge/local-api/project-onboard.ts）：只转发 team onboard；要 manage 授权。 */
import { describe, expect, test } from "bun:test";
import { handleProjectOnboardApi, onboardArgs } from "../src/bridge/local-api/project-onboard.js";
import type { Principal } from "../src/lib/principals.js";

const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-01-01", manage: true };
const guest: Principal = { id: "ext:g", role: "external", agents: ["agent-x"], createdAt: "2026-01-01" };

function api(reply: Record<string, unknown>) {
  const runs: string[][] = [];
  const deps = { exists: async (p: string) => p === "dn", run: async (args: string[]) => (runs.push(args), reply) };
  const call = (body: unknown, o: { method?: string; principal?: Principal; project?: string } = {}) => handleProjectOnboardApi(
    new Request(`http://localhost/api/v1/projects/${o.project ?? "dn"}/onboard`, { method: o.method ?? "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    `/projects/${o.project ?? "dn"}/onboard`, o.principal ?? owner, deps,
  );
  return { call, runs };
}

describe("project onboard api", () => {
  test("请求体转成 team onboard 参数", () => {
    expect(onboardArgs("dn", { dryRun: true })).toEqual(["team", "onboard", "--project", "dn", "--dry-run"]);
    expect(onboardArgs("dn", { dryRun: false, localMerge: true, checks: " cargo test ", maxWorkers: 2 }))
      .toEqual(["team", "onboard", "--project", "dn", "--local-merge", "--checks=cargo test", "--max-workers=2"]);
    for (const bad of [{}, { dryRun: "1" }, { dryRun: true, maxWorkers: 33 }, { dryRun: true, checks: "a\nb" }, { dryRun: true, localMerge: 1 }]) {
      expect(onboardArgs("dn", bad as never)).toBeNull();
    }
  });

  test("有清单就 200（ok:false 也带清单）；没清单按错误码", async () => {
    const items = [{ key: "git", status: "blocked", text: "x" }];
    expect((await api({ ok: false, code: "blocked", items }).call({ dryRun: true }))?.status).toBe(200);
    expect((await api({ ok: false, code: "forbidden", error: "no" }).call({ dryRun: true }))?.status).toBe(403);
  });

  test("没有 manage 授权、方法不对、项目不存在、参数不合法：不跑命令", async () => {
    const h = api({ ok: true, items: [] });
    expect((await h.call({ dryRun: true }, { principal: guest }))?.status).toBe(403);
    expect((await h.call(undefined, { method: "GET" }))?.status).toBe(405);
    expect((await h.call({ dryRun: true }, { project: "nope" }))?.status).toBe(404);
    expect((await h.call({ dryRun: "yes" }))?.status).toBe(400);
    expect(h.runs).toEqual([]);
    expect(await h.call({ dryRun: true }, { project: "dn/pm" })).toBeNull();
  });
});
