/**
 * TIER3 security 下限在每个入口都挡得住：保存（saveRoleModels）、直接 API（PUT /settings/role-models）、手改配置文件（读成 invalid →
 * security 卡拒绝启动）、显式参数（--model / --effort）与最终启动；包含 pm-reviewer。非 security 的类型格照常可存、可删回缺省。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRoleModelSettingsApi } from "../src/bridge/local-api/role-model-settings.js";
import { applyCardRole } from "../src/lib/card-role-definitions.js";
import { effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import type { Principal } from "../src/lib/principals.js";
import { useRoleModelPort } from "../src/lib/role-model-settings-local.js";
import { saveRoleModels } from "../src/lib/role-model-settings-save.js";
import { defaultRoleModels, parseRoleModelPatch, readRoleModels, type RoleModelPatch } from "../src/lib/role-model-settings.js";
import { registerAuthorTierOverride, tierFloorProblem, useTaskTierPort, type TierLaunchCtx } from "../src/lib/task-tier-models.js";

const SONNET = "claude-sonnet-5-5", OPUS = "claude-opus-5-5";
const at = "2026-10-01T00:00:00Z";
const cred = (grant: Grant): DeviceCredential => ({ id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER: Principal = effectivePrincipal({ principal: { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true },
  credential: cred({ agents: ["*"], terminal: true, manage: true }) });

const dirs: string[] = [];
afterEach(() => { useTaskTierPort(); useRoleModelPort(); registerAuthorTierOverride(null); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tier3-api-"));
  dirs.push(dir);
  const path = join(dir, "role-model-settings.json"), logs: string[] = [];
  return { path, logs, api: makeRoleModelSettingsApi({ path, now: () => 42, log: (m) => logs.push(m) }) };
}
const put = (body: unknown) => new Request("http://x/api/v1/settings/role-models", { method: "PUT", body: JSON.stringify(body) });
const get = () => new Request("http://x/api/v1/settings/role-models");
const json = async (r: Response | null) => ({ status: r!.status, body: (await r!.json()) as Record<string, any> });
const patch = (b: Record<string, unknown>): RoleModelPatch => { const p = parseRoleModelPatch(b); if (typeof p === "string") throw new Error(p); return p; };

/** 把 tier 端口指到这个文件（真读盘），taskTierModels on；旧 roleModel 键 observe 不落盘 */
function launchFrom(path: string): void {
  useTaskTierPort({ policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }), read: () => readRoleModels(path) });
  useRoleModelPort({ policy: () => ({ mode: "observe", manualAfterMs: null, source: "config" }), read: () => readRoleModels(path), observe: () => undefined });
}
const ctx = (tier: string, extra: Partial<TierLaunchCtx> = {}): TierLaunchCtx => ({ project: "p1", card: "T1", tier, ...extra });
const author = (...extra: string[]) => ["create", "a1", "/w", "--purpose", "T1", "--task", "T1", "--card", "T1", "--card-role", "author", "--effort", "high", "--project", "p1", ...extra];
const reviewer = (...extra: string[]) => ["create", "r1", "/w", "--purpose", "T1 审查", "--project", "p1", "--card", "T1", "--card-role", "reviewer", ...extra];
const pm = (...extra: string[]) => ["create", "m1", "/w", "--purpose", "T1 PM", "--project", "p1", "--card", "T1", "--card-role", "other", ...extra];
const CODEX = ["--runtime", "codex", "--transport", "acp"];

describe("[验收线 2] 保存（saveRoleModels）", () => {
  test("security 各角色写低于 Opus、Codex 写任何非 inherit 档：invalid，不写盘", async () => {
    const { path } = setup();
    for (const role of ["author", "reviewer", "adversarial-reviewer", "pm-reviewer"]) {
      const r = await saveRoleModels(patch({ rev: 0, role, tier: "security", claude: SONNET }), path);
      expect(r).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("不得低于 Opus") });
    }
    expect(await saveRoleModels(patch({ rev: 0, role: "author", tier: "security", codex: "low" }), path)).toMatchObject({ ok: false, code: "invalid" });
    expect(await saveRoleModels(patch({ rev: 0, role: "author", tier: "security", codex: "xhigh" }), path)).toMatchObject({ ok: false, code: "invalid" });
    expect(existsSync(path)).toBe(false);
  });

  test("显式继承核角色格：security inherit 之后再把角色格降到 Sonnet 也被拒（交叉校验），先降再 inherit 同样拒", async () => {
    const { path } = setup();
    expect(await saveRoleModels(patch({ rev: 0, role: "reviewer", tier: "security", claude: "inherit" }), path)).toMatchObject({ ok: true });
    expect(await saveRoleModels(patch({ rev: 1, role: "reviewer", claude: SONNET }), path)).toMatchObject({ ok: false, code: "invalid" });
    expect(await saveRoleModels(patch({ rev: 1, role: "author", claude: SONNET }), path)).toMatchObject({ ok: true });
    expect(await saveRoleModels(patch({ rev: 2, role: "author", tier: "security", claude: "inherit" }), path)).toMatchObject({ ok: false, code: "invalid" });
    expect(readRoleModels(path)).toMatchObject({ status: "ok", table: { rev: 2, tiers: { security: { reviewer: { claude: "inherit" } } } } });
  });

  test("非 security 照常存；default 删回缺省，空了整段去掉", async () => {
    const { path } = setup();
    expect(await saveRoleModels(patch({ rev: 0, role: "author", tier: "ui", claude: "claude-haiku-5-5", codex: "down1" }), path)).toMatchObject({ ok: true });
    expect(await saveRoleModels(patch({ rev: 1, role: "author", tier: "ui", claude: "default" }), path)).toMatchObject({ ok: true, table: { tiers: { ui: { author: { codex: "down1" } } } } });
    const r = await saveRoleModels(patch({ rev: 2, role: "author", tier: "ui", codex: "default" }), path);
    expect(r.ok && r.table.tiers).toBeUndefined();
    expect(parseRoleModelPatch({ rev: 0, role: "author", tier: "infra", claude: OPUS })).toContain("tier 只认");
  });
});

describe("[验收线 2] 直接 API", () => {
  test("PUT security 低于 Opus → 400 带校验原因，不写盘；GET 带 tiers 与类型清单", async () => {
    const s = setup();
    const bad = await json(await s.api(put({ rev: 0, role: "pm-reviewer", tier: "security", claude: SONNET }), "/settings/role-models", OWNER));
    expect(bad).toMatchObject({ status: 400, body: { ok: false, code: "invalid", reason: expect.stringContaining("pm-reviewer 不得低于 Opus") } });
    expect(existsSync(s.path)).toBe(false);
    const ok = await json(await s.api(put({ rev: 0, role: "pm-reviewer", tier: "code", claude: OPUS }), "/settings/role-models", OWNER));
    expect(ok).toMatchObject({ status: 200, body: { rev: 1, tiers: { code: { "pm-reviewer": { claude: OPUS } } } } });
    const view = await json(await s.api(get(), "/settings/role-models", OWNER));
    expect(view.body).toMatchObject({ taskTiers: ["security", "code", "ui", "docs"], tiers: { code: { "pm-reviewer": { claude: OPUS } } } });
  });
});

describe("[验收线 2] 手改配置", () => {
  test("文件里 security 写了 Sonnet：读成 invalid；security 卡拒绝启动，非 security 照产品默认起", () => {
    const { path } = setup();
    writeFileSync(path, JSON.stringify({ ...defaultRoleModels(), rev: 3, tiers: { security: { author: { claude: SONNET } } } }));
    const read = readRoleModels(path);
    expect(read).toMatchObject({ status: "invalid", error: expect.stringContaining("不得低于 Opus") });
    launchFrom(path);
    for (const [args, role] of [[author(), undefined], [reviewer(), undefined], [pm(), "pm-reviewer"]] as const) {
      expect(applyCardRole([...args], { ...(role ? { role } : {}), tier: ctx("security") })).toMatchObject({ error: expect.stringContaining("不启动") });
    }
    const ui = applyCardRole(author(), { tier: ctx("ui") });
    expect("args" in ui && ui.args[ui.args.indexOf("--model") + 1]).toBe(SONNET);
    expect(readFileSync(path, "utf8")).toContain(SONNET); // 读取不改写
  });

  test("Codex 档手改坏了（security 写 low）同样拒启动", () => {
    const { path } = setup();
    writeFileSync(path, JSON.stringify({ ...defaultRoleModels(), tiers: { security: { reviewer: { codex: "low" } } } }));
    launchFrom(path);
    expect(applyCardRole([...reviewer(), ...CODEX], { tier: ctx("security") })).toMatchObject({ error: expect.stringContaining("不启动") });
  });
});

describe("[验收线 2] 显式参数与最终启动", () => {
  test("security 卡显式 --model Sonnet / Haiku：作者、审查员、pm-reviewer 都拒；显式 Opus 放行", () => {
    const { path } = setup();
    launchFrom(path);
    for (const m of [SONNET, "claude-haiku-5-5", "claude-fable-5-1"]) {
      expect(applyCardRole(author("--model", m), { tier: ctx("security") })).toMatchObject({ error: expect.stringContaining("不得低于 Opus") });
      expect(applyCardRole(reviewer("--model", m), { tier: ctx("security") })).toMatchObject({ error: expect.stringContaining("不得低于 Opus") });
      expect(applyCardRole(pm("--model", m), { role: "pm-reviewer", tier: ctx("security") })).toMatchObject({ error: expect.stringContaining("不得低于 Opus") });
    }
    const ok = applyCardRole(author("--model", OPUS), { tier: ctx("security") });
    expect("args" in ok && ok.args.filter((a) => a === "--model").length).toBe(1);
  });

  test("security Codex：显式 --effort 低于原档拒，高于原档放行；不换家族（runtime 原样）", () => {
    const { path } = setup();
    launchFrom(path);
    const codexAuthor = (e: string) => [...author(), ...CODEX].map((x, i, all) => (all[i - 1] === "--effort" ? e : x));
    expect(applyCardRole(codexAuthor("low"), { tier: ctx("security", { baseEffort: "high" }) })).toMatchObject({ error: expect.stringContaining("不得低于原档 high") });
    const up = applyCardRole(codexAuthor("xhigh"), { tier: ctx("security", { baseEffort: "high" }) });
    expect("args" in up && up.args).toEqual(codexAuthor("xhigh"));
    const same = applyCardRole(codexAuthor("high"), { tier: ctx("security", { baseEffort: "high" }) });
    expect("args" in same && same.args).toEqual(codexAuthor("high"));
  });

  test("security Codex 没给 baseEffort：原档回退到角色格（xhigh），显式 --effort low 与覆盖值 low 都过不了下限", () => {
    const { path } = setup();
    const t = defaultRoleModels();
    t.roles.reviewer.codex = "xhigh";
    t.roles.author.codex = "xhigh";
    writeFileSync(path, JSON.stringify(t));
    launchFrom(path);
    expect(applyCardRole([...reviewer("--effort", "low"), ...CODEX], { tier: ctx("security") })).toMatchObject({ error: expect.stringContaining("不得低于原档 xhigh") });
    const up = applyCardRole([...reviewer("--effort", "max"), ...CODEX], { tier: ctx("security") });
    expect("args" in up && up.args).toEqual([...reviewer("--effort", "max"), ...CODEX]);
    // 覆盖扩展点用同一原档：low 不用，照类型解析（角色格 xhigh）起并注明
    registerAuthorTierOverride(() => "low");
    const noBase = [...author(), ...CODEX].filter((x, i, all) => x !== "--effort" && all[i - 1] !== "--effort");
    const ov = applyCardRole(noBase, { tier: ctx("security") });
    expect("args" in ov && ov.args).toEqual([...noBase, "--effort", "xhigh"]);
    expect(ov.tierLaunch).toMatchObject({ suggested: "xhigh", final: { effort: "xhigh" }, note: expect.stringContaining("覆盖值 low 低于安全下限") });
  });

  test("统一校验函数：最终值逐项过下限", () => {
    expect(tierFloorProblem("security", "author", "claude", OPUS, undefined)).toBeNull();
    expect(tierFloorProblem("security", "pm-reviewer", "claude", null, undefined)).toContain("不得低于 Opus");
    expect(tierFloorProblem("security", "reviewer", "codex", null, "high")).toContain("原档 high");
    expect(tierFloorProblem("security", "reviewer", "codex", "medium", null)).toBeNull(); // 原档不可核实：无从比较
    expect(tierFloorProblem("ui", "author", "claude", "claude-haiku-5-5", undefined)).toBeNull();
  });
});
