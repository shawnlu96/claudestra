/**
 * bridge/local-api/agent-skills.ts + skills-library.ts：按 agent 的技能开关要 manage 且在 scope 内（同目录按 agent 的写端点同一口径），
 * master 单独判（"*" 不含 master）；技能库的 overrides 只报 scope 内的 agent。状态目录由 tests/preload.ts 隔离。
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { setSkillOverride } from "../src/lib/agent-settings.js";
import type { Principal } from "../src/lib/principals.js";

const base = { createdAt: "2026-01-01T00:00:00Z" };
const OWNER: Principal = { ...base, id: "owner:self", role: "owner", agents: ["*", "master"], manage: true, credential: "dev_o1" };
/** owner 设备但只授权了部分会话、带 manage */
const PARTIAL: Principal = { ...base, id: "owner:dev2", role: "owner", agents: ["worker"], manage: true, credential: "dev_p1" };
/** 老的全 scope Bearer：能过 canManage，但 "*" 不含 master */
const STAR: Principal = { ...base, id: "token:tok_1", role: "external", name: "t", agents: ["*"], secret: "x" };

async function call(method: string, path: string, p: Principal, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) };
  const r = new Request(`http://bridge.local/api/v1${path}`, init);
  return (await handleLocalApi(r, new URL(r.url), p))!;
}

beforeAll(async () => {
  await setSkillOverride("agent-worker", "pdf", "off");
  await setSkillOverride("agent-other", "pdf", "off");
  await setSkillOverride("master", "save-compact", "off");
});

describe("/agents/:name/skill-settings 的 scope", () => {
  test("部分 scope 的设备凭据：scope 外的 agent 读写都 403（写不会去起 manager）", async () => {
    expect((await call("GET", "/agents/other/skill-settings", PARTIAL)).status).toBe(403);
    expect((await call("POST", "/agents/agent-other/skill-settings", PARTIAL, { skill: "pdf", state: "on" })).status).toBe(403);
    expect((await call("GET", "/agents/master/skill-settings", PARTIAL)).status).toBe(403);
    // scope 内的名字过了闸，registry 里没有 → 404
    expect((await call("GET", "/agents/worker/skill-settings", PARTIAL)).status).toBe(404);
  });
  test('"*" token 碰不到 master（agent-master 写法也不行）', async () => {
    expect((await call("GET", "/agents/master/skill-settings", STAR)).status).toBe(403);
    expect((await call("POST", "/agents/master/skill-settings", STAR, { skill: "save", state: "off" })).status).toBe(403);
    expect((await call("GET", "/agents/agent-master/skill-settings", STAR)).status).toBe(403);
  });
  test("显式带 master 的 owner 能看大总管的技能", async () => {
    const r = await call("GET", "/agents/master/skill-settings", OWNER);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).view.runtime).toBe("claude-code");
  });
});

describe("/skills/library 的 overrides", () => {
  // 状态目录是整次 bun test 共用的（tests/preload.ts），别的测试文件写的 agent 设置也在里面：
  // 只对本文件建的几个断言在不在，不断言整张表（"*" 覆盖所有非 master 的 agent，会带上它们）
  test("只报 scope 内的 agent", async () => {
    const keys = async (p: Principal) => Object.keys(((await (await call("GET", "/skills/library", p)).json()) as any).overrides);
    expect(await keys(PARTIAL)).toEqual(["agent-worker"]); // 只授权了 worker：别的文件建的 agent 也不该出现
    const star = await keys(STAR);
    expect(star).toEqual(expect.arrayContaining(["agent-other", "agent-worker"]));
    expect(star).not.toContain("master");
    expect(await keys(OWNER)).toEqual(expect.arrayContaining(["agent-other", "agent-worker", "master"]));
  });
});
