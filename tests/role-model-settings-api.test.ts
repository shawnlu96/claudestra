/**
 * bridge/local-api/role-model-settings.ts（TIER1）：门禁矩阵（只有 owner 本人 + 全权 manage；guest / peer / agent token / 缩权 / 停用 403，
 * 拒时不读盘不写盘）、GET 视图与坏配置提示、PUT 坏值 400 不保存、rev 过期 409 带回现表、成功按回包、读不了 500 不写；
 * 以及 handleLocalApi 里真的登记了这条路径。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRoleModelSettingsApi } from "../src/bridge/local-api/role-model-settings.js";
import { effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import type { Principal } from "../src/lib/principals.js";

const at = "2026-10-01T00:00:00Z";
const cred = (grant: Grant): DeviceCredential => ({ id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const device = (grant: Grant, base: Principal = OWNER_BASE) => effectivePrincipal({ principal: base, credential: cred(grant) });
const OWNER = device({ agents: ["*"], terminal: true, manage: true });
const DENIED: [string, Principal][] = [
  ["owner 设备 · 部分 scope", device({ agents: ["worker"], terminal: true, manage: true })],
  ["owner 设备 · manage:false", device({ agents: ["*"], terminal: true, manage: false })],
  ["guest 设备", device({ agents: ["*"], terminal: false, manage: true }, { id: "guest:g", role: "external", agents: ["*"], createdAt: at })],
  ["peer token", { id: "token:tok_peer", role: "external", agents: ["*"], peer: "team-a", createdAt: at }],
  ["agent / 外部 token", { id: "token:tok_agent", role: "external", name: "agent-x", agents: ["agent-x"], createdAt: at }],
  ["停用的 owner", { ...OWNER_BASE, disabled: true }],
];

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "role-models-api-"));
  dirs.push(dir);
  const path = join(dir, "role-model-settings.json"), logs: string[] = [];
  return { dir, path, logs, api: makeRoleModelSettingsApi({ path, now: () => 42, log: (m) => logs.push(m) }) };
}
const get = () => new Request("http://x/api/v1/settings/role-models");
const put = (body: unknown) => new Request("http://x/api/v1/settings/role-models", { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body) });
const json = async (r: Response | null) => ({ status: r!.status, body: (await r!.json()) as Record<string, any> });

describe("门禁", () => {
  test.each(DENIED)("%s：GET / PUT 都 403，不写盘", async (_, who) => {
    const s = setup();
    expect((await s.api(get(), "/settings/role-models", who))!.status).toBe(403);
    expect((await s.api(put({ rev: 0, role: "author", codex: "high" }), "/settings/role-models", who))!.status).toBe(403);
    expect(existsSync(s.path)).toBe(false);
  });

  test("别的路径不是我的", async () => {
    expect(await setup().api(get(), "/settings", OWNER)).toBeNull();
  });
});

describe("GET", () => {
  test("没存过：默认表，四个角色 Claude 全 Opus 5.5、Codex 照配置；带 Codex 推理档清单", async () => {
    const { status, body } = await json(await setup().api(get(), "/settings/role-models", OWNER));
    expect(status).toBe(200);
    expect(body.config).toEqual({ status: "missing", error: null });
    expect(body.rev).toBe(0);
    expect(body.roles.map((r: { role: string }) => r.role)).toEqual(["author", "reviewer", "adversarial-reviewer", "pm-reviewer"]);
    expect(body.roles.every((r: { claude: string; codex: unknown }) => r.claude === "claude-opus-5-5" && r.codex === null)).toBe(true);
    expect(body.codexEfforts).toContain("xhigh");
  });

  test("坏配置：固定错误码、默认表，原因只进日志", async () => {
    const s = setup();
    writeFileSync(s.path, "{bad");
    const { body } = await json(await s.api(get(), "/settings/role-models", OWNER));
    expect(body.config).toEqual({ status: "invalid", error: "config_invalid" });
    expect(JSON.stringify(body)).not.toContain(s.dir);
    expect(s.logs.join("\n")).toContain("JSON");
  });
});

describe("PUT", () => {
  test("成功：按回包刷新（rev+1、只改这一格），文件同值", async () => {
    const s = setup();
    const { status, body } = await json(await s.api(put({ rev: 0, role: "reviewer", claude: "claude-sonnet-5-5" }), "/settings/role-models", OWNER));
    expect(status).toBe(200);
    expect(body.rev).toBe(1);
    expect(body.roles.find((r: { role: string }) => r.role === "reviewer")).toEqual({ role: "reviewer", claude: "claude-sonnet-5-5", codex: null });
    expect(JSON.parse(readFileSync(s.path, "utf8")).roles.reviewer.claude).toBe("claude-sonnet-5-5");
  });

  test.each([[{ rev: 0, role: "author", claude: "gpt-6" }], [{ rev: 0, role: "author", codex: "claude-opus-5-5" }], ["not json"], [{ rev: 0, role: "author" }]])(
    "坏值 %j：400，不保存", async (b) => {
      const s = setup();
      const r = await json(await s.api(put(b), "/settings/role-models", OWNER));
      expect(r.status).toBe(400);
      expect(r.body.ok).toBe(false);
      expect(existsSync(s.path)).toBe(false);
    });

  test("rev 过期：409，带回现表，不覆盖", async () => {
    const s = setup();
    await s.api(put({ rev: 0, role: "author", codex: "high" }), "/settings/role-models", OWNER);
    const r = await json(await s.api(put({ rev: 0, role: "author", codex: "low" }), "/settings/role-models", OWNER));
    expect(r.status).toBe(409);
    expect(r.body.current.rev).toBe(1);
    expect(r.body.current.roles[0]).toEqual({ role: "author", claude: "claude-opus-5-5", codex: "high" });
    expect(JSON.parse(readFileSync(s.path, "utf8")).roles.author.codex).toBe("high");
  });

  test("读不了文件：500 固定文案，不写；本机路径不出 bridge", async () => {
    const s = setup();
    mkdirSync(s.path);
    const r = await json(await s.api(put({ rev: 0, role: "author", codex: "high" }), "/settings/role-models", OWNER));
    expect(r.status).toBe(500);
    expect(r.body.code).toBe("unreadable");
    expect(JSON.stringify(r.body)).not.toContain(s.dir);
  });

  test("坏文件：保存修好它并带 replaced_invalid 警告", async () => {
    const s = setup();
    writeFileSync(s.path, JSON.stringify({ v: 1, rev: 0, roles: {} }));
    const r = await json(await s.api(put({ rev: 0, role: "pm-reviewer", codex: "medium" }), "/settings/role-models", OWNER));
    expect(r.status).toBe(200);
    expect(r.body.warning).toBe("replaced_invalid");
    expect(existsSync(`${s.path}.invalid-42`)).toBe(true);
  });
});

test("handleLocalApi 登记了 /settings/role-models（guest 进来是 403，不是没人认的 null）", async () => {
  const { handleLocalApi } = await import("../src/bridge/local-api/index.js");
  const r = await handleLocalApi(get(), new URL("http://x/api/v1/settings/role-models"), DENIED[2]![1]);
  expect(r?.status).toBe(403);
});

// CARDMODEL1: the view and launch resolvers must have identical values and provenance.
describe("卡片模型：有效视图与原子批量保存", () => {
  test("四类型、未声明 × 四职责 × 两家族逐格等于启动解析器", async () => {
    const { readRoleModels, CARD_ROLES, roleModelOf, defaultRoleModels } = await import("../src/lib/role-model-settings.js");
    const { resolveTierModel } = await import("../src/lib/task-tier-models.js");
    const { TASK_TIERS } = await import("../src/lib/task-tier-spec.js");
    const s = setup();
    for (const stored of [false, true]) {
      if (stored) {
        const table = defaultRoleModels();
        table.roles.author.codex = "xhigh";
        table.tiers = { docs: { reviewer: { claude: "inherit", codex: "ultra" } }, ui: { author: { codex: "down1" } } };
        writeFileSync(s.path, JSON.stringify(table));
      }
      const { body } = await json(await s.api(get(), "/settings/role-models", OWNER));
      const read = readRoleModels(s.path);
      for (const tier of TASK_TIERS) for (const role of CARD_ROLES) for (const family of ["claude", "codex"] as const) {
        expect(body.effective[tier].find((r: { role: string }) => r.role === role)[family]).toEqual(resolveTierModel(read, tier, role, family));
      }
      for (const role of CARD_ROLES) for (const family of ["claude", "codex"] as const) {
        expect(body.effective.undeclared.find((r: { role: string }) => r.role === role)[family]).toEqual(roleModelOf(read, role, family));
      }
      expect(body.effective.docs[0].claude).toEqual({ value: "claude-haiku-5-5", source: "tier-default" });
    }
  });

  test.each(["off", "observe", "on"] as const)("两个恢复开关：%s，使用请求项目", async (mode) => {
    const s = setup();
    const seen: string[] = [];
    const api = makeRoleModelSettingsApi({ path: s.path, policy: (project, key) => {
      seen.push(`${project}:${key}`);
      return { mode, source: "config", manualAfterMs: null };
    } });
    const r = await json(await api(new Request("http://x/settings/role-models?project=sample"), "/settings/role-models", OWNER));
    expect(r.body.switches).toEqual({ project: "sample", taskTierModels: { mode }, roleModel: { mode } });
    expect(seen.sort()).toEqual(["sample:roleModel", "sample:taskTierModels"]);
  });

  const changes = [
    { role: "author", tier: "docs", claude: "claude-sonnet-5-5" },
    { role: "reviewer", codex: "high" },
    { role: "pm-reviewer", tier: "ui", codex: "down1" },
  ];
  test("批量改三格与逐格结果相同；版本只加一次；过期回现表", async () => {
    const batch = setup(), single = setup();
    const r = await json(await batch.api(put({ rev: 0, changes }), "/settings/role-models", OWNER));
    expect(r.status).toBe(200);
    expect(r.body.rev).toBe(1);
    for (const [rev, change] of changes.entries()) expect((await single.api(put({ rev, ...change }), "/settings/role-models", OWNER))!.status).toBe(200);
    const a = JSON.parse(readFileSync(batch.path, "utf8")), b = JSON.parse(readFileSync(single.path, "utf8"));
    expect({ ...a, rev: 0 }).toEqual({ ...b, rev: 0 });
    const conflict = await json(await batch.api(put({ rev: 0, changes }), "/settings/role-models", OWNER));
    expect(conflict).toMatchObject({ status: 409, body: { current: { rev: 1, effective: expect.any(Object), switches: expect.any(Object) } } });
  });

  test("一格违反 security 下限，整批拒绝、原文件逐字不变，并指出格子", async () => {
    const s = setup();
    await s.api(put({ rev: 0, role: "author", codex: "ultra" }), "/settings/role-models", OWNER);
    const before = readFileSync(s.path, "utf8");
    const r = await json(await s.api(put({ rev: 1, changes: [...changes,
      { tier: "security", role: "reviewer", claude: "claude-haiku-5-5" }] }), "/settings/role-models", OWNER));
    expect(r).toMatchObject({ status: 400, body: { code: "invalid", reason: expect.stringContaining("security 的 reviewer 不得低于 Opus") } });
    expect(readFileSync(s.path, "utf8")).toBe(before);
  });

  test("并发单格与批量 CAS 只放行一个；旧 ultra 值仍可读写", async () => {
    const s = setup();
    const results = await Promise.all([
      s.api(put({ rev: 0, changes }), "/settings/role-models", OWNER),
      s.api(put({ rev: 0, role: "reviewer", codex: "ultra" }), "/settings/role-models", OWNER),
    ]);
    expect(results.map((r) => r!.status).sort()).toEqual([200, 409]);
    expect((await s.api(put({ rev: 1, role: "reviewer", codex: "ultra" }), "/settings/role-models", OWNER))!.status).toBe(200);
  });

  test("空批、过大批、坏角色、嵌套 rev、多余字段均整批拒绝", async () => {
    for (const changes of [[], Array(41).fill({ role: "author", codex: "high" }), [{ role: "boss", codex: "low" }],
      [{ role: "author", codex: "high", rev: 9 }], [{ role: "author", codex: "high", model: "ignored" }],
      [{ role: "author", codex: "high" }, { role: "author", codex: "low" }]]) {
      const s = setup();
      expect((await s.api(put({ rev: 0, changes }), "/settings/role-models", OWNER))!.status).toBe(400);
      expect(existsSync(s.path)).toBe(false);
    }
  });
});


test("卡片模型：未存或坏文件的 CAS 冲突回包保持真实来源，不伪装成已存配置", async () => {
  const s = setup();
  for (const status of ["missing", "invalid"]) {
    if (status === "invalid") writeFileSync(s.path, "bad-json");
    const current = await json(await s.api(put({ rev: 9, changes: [{ role: "author", codex: "high" }] }), "/settings/role-models", OWNER));
    const getView = await json(await s.api(get(), "/settings/role-models", OWNER));
    expect(current.status).toBe(409);
    expect(current.body.current.config.status).toBe(status);
    expect(current.body.current.effective).toEqual(getView.body.effective);
  }
});
