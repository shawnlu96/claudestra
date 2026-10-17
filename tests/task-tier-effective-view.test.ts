import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRoleModelSettingsApi } from "../src/bridge/local-api/role-model-settings.js";
import { effectivePrincipal } from "../src/lib/devices.js";
import { CARD_ROLES, defaultRoleModels, readRoleModels, ROLE_MODEL_FAMILIES, roleModelOf } from "../src/lib/role-model-settings.js";
import { resolveTierModel } from "../src/lib/task-tier-models.js";
import { TASK_TIERS, tierLaunchable } from "../src/lib/task-tier-spec.js";

const at = "2026-10-01T00:00:00Z";
const owner = effectivePrincipal({
  principal: { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at },
  credential: { id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", createdAt: at, expiresAt: "2099-01-01T00:00:00Z",
    grant: { agents: ["*"], terminal: true, manage: true } },
});
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tier-effective-"));
  dirs.push(dir);
  const path = join(dir, "roles.json");
  const table = defaultRoleModels();
  table.tiers = { code: { reviewer: { claude: "claude-sonnet-5-5", codex: "high" } } };
  writeFileSync(path, JSON.stringify(table));
  const api = makeRoleModelSettingsApi({ path, now: () => 42, log: () => undefined });
  const request = async (body?: unknown, who = owner) => {
    const req = new Request("http://x/settings/role-models", body === undefined ? {} : { method: "PUT", body: JSON.stringify(body) });
    const response = (await api(req, "/settings/role-models", who))!;
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return { path, request };
}

function checkEffective(body: Record<string, any>, path: string) {
  const read = readRoleModels(path);
  for (const tier of TASK_TIERS) for (const role of CARD_ROLES) for (const family of ROLE_MODEL_FAMILIES) {
    expect(body.effective?.[tier]?.find((r: { role: string }) => r.role === role)?.[family]).toEqual(resolveTierModel(read, tier, role, family));
  }
  for (const tier of TASK_TIERS) expect(body.templates?.[tier]).toBe(tierLaunchable(tier));
  expect(body.effective.undeclared).toEqual(CARD_ROLES.map((role) => ({ role,
    claude: roleModelOf(read, role, "claude"), codex: roleModelOf(read, role, "codex"),
  })));
}

test("[验收线 1] GET 全部类型 × 角色 × 家族与 resolveTierModel 一致，code 存值不污染 ui", async () => {
  const s = setup();
  const { status, body } = await s.request();
  expect(status).toBe(200);
  checkEffective(body, s.path);
  expect(body.effective.code.find((r: { role: string }) => r.role === "reviewer").claude.source).toBe("tier-settings");
  expect(body.effective.ui.find((r: { role: string }) => r.role === "reviewer").claude.source).toBe("role-settings");
});

test("[验收线 2] observe 项目如实显示；配置诊断或读取异常不显示猜测的 off", async () => {
  const { taskTierEffectiveView } = await import("../src/lib/task-tier-effective-view.js");
  const { taskTierMode } = await import("../src/lib/task-tier-models.js");
  const { recoveryPolicy } = await import("../src/lib/recovery-policy.js");
  const s = setup();
  const policyPath = join(dirs[dirs.length - 1], "recovery.json");
  const brokenPath = join(dirs[dirs.length - 1], "unreadable.json");
  writeFileSync(policyPath, JSON.stringify({ projects: { observing: { keys: { taskTierModels: "observe" } }, disabled: { keys: { taskTierModels: "off" } } } }));
  writeFileSync(brokenPath, "{broken");
  const read = readRoleModels(s.path);
  const view = await taskTierEffectiveView(read.table, read.status, {
    projects: async () => ({ projects: ["observing", "disabled", "broken", "throws"].map((id) => ({ id, name: id, dirs: [], createdAt: at })) }),
    mode: (id) => {
      if (id === "throws") throw new Error("private filesystem path");
      return taskTierMode(id, { read: () => read, now: () => 42,
        policy: (project, key) => recoveryPolicy(project, key, id === "broken" ? brokenPath : policyPath) });
    },
  });
  expect(view.projects).toEqual({ observing: { mode: "observe" }, disabled: { mode: "off" },
    broken: { diagnostic: "task_tier_config_unavailable" }, throws: { diagnostic: "task_tier_config_unavailable" } });
  expect(JSON.stringify(view)).not.toContain(policyPath);
});

test("模板可用性每次读取注册表；缺省、坏表也逐格复用执行解析", async () => {
  const { taskTierEffectiveView } = await import("../src/lib/task-tier-effective-view.js");
  const { registerTierTemplate } = await import("../src/lib/task-tier-spec.js");
  const deps = { projects: async () => ({ projects: [] }), mode: () => ({ mode: "on" as const }) };
  for (const status of ["missing", "invalid", "unreadable"] as const) {
    const table = defaultRoleModels();
    const read = status === "missing" ? { status, table } : { status, table, error: "local path" };
    const view = await taskTierEffectiveView(table, status, deps);
    for (const tier of TASK_TIERS) for (const role of CARD_ROLES) for (const family of ROLE_MODEL_FAMILIES) {
      expect(view.effective[tier].find((r) => r.role === role)?.[family]).toEqual(resolveTierModel(read, tier, role, family));
    }
  }
  const before = tierLaunchable("docs");
  const undo = registerTierTemplate("docs");
  try { expect((await taskTierEffectiveView(defaultRoleModels(), "missing", deps)).templates.docs).toBe(true); }
  finally { undo(); }
  expect((await taskTierEffectiveView(defaultRoleModels(), "missing", deps)).templates.docs).toBe(before);
});

const withoutProjection = ({ effective, projects, templates, ...old }: Record<string, any>) => old;

test("[验收线 3] PUT 成功和 409 的现表只新增视图字段，400 原文不变；缩权设备仍 403", async () => {
  const { CODEX_EFFORT_LEVELS } = await import("../src/lib/codex-launch.js");
  const s = setup();
  const initial = withoutProjection((await s.request()).body);
  expect(initial).toEqual({ ok: true, config: { status: "ok", error: null }, rev: 0,
    families: ROLE_MODEL_FAMILIES, roles: CARD_ROLES.map((role) => ({ role, ...defaultRoleModels().roles[role] })),
    codexEfforts: CODEX_EFFORT_LEVELS, taskTiers: TASK_TIERS,
    tiers: { code: { reviewer: { claude: "claude-sonnet-5-5", codex: "high" } } } });
  const saved = await s.request({ rev: 0, role: "reviewer", tier: "code", codex: "medium" });
  expect(saved.status).toBe(200);
  expect(withoutProjection(saved.body)).toEqual({ ...initial, rev: 1,
    tiers: { code: { reviewer: { claude: "claude-sonnet-5-5", codex: "medium" } } } });
  checkEffective(saved.body, s.path);
  const stale = await s.request({ rev: 0, role: "reviewer", codex: "low" });
  expect(stale).toEqual({ status: 409, body: { ok: false, code: "conflict",
    error: "这张表刚被别处改过，已刷新为最新值，请确认后再改", current: saved.body } });
  const bad = await s.request({ rev: 1, role: "reviewer", codex: "invalid" });
  expect(bad).toEqual({ status: 400, body: { ok: false, error: `codex 只认 null（照 Codex 配置）或 ${CODEX_EFFORT_LEVELS.join(" / ")}` } });
  const denied = await s.request(undefined, { ...owner, manage: false });
  expect(denied.status).toBe(403);
});
