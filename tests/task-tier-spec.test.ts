/**
 * TIER3 任务类型声明（src/lib/task-tier-spec.ts）：只认卡首唯一一行「模板：」，缺 = code，重复 / 不认识 / 与已存流程冲突明确诊断；
 * docs 只在表里，注册前开不了卡也起不了会话；派单前的校验钩子接入 start_node 预检后生效（停派并记事件），off 不调用。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { preflightStart } from "../src/lib/dag-tools-start.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { WORKFLOW_TEMPLATES } from "../src/lib/ledger-scheduler.js";
import { FLOW_TEMPLATES, templateFor } from "../src/lib/scheduler-template.js";
import { decideTierLaunch, useTaskTierPort } from "../src/lib/task-tier-models.js";
import { parseTaskTier, registerTierChecks, registerTierTemplate, tierAtLaunch, tierLaunchable } from "../src/lib/task-tier-spec.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";

const cleanups: (() => void)[] = [];
afterEach(() => { useTaskTierPort(); for (const c of cleanups.splice(0)) c(); });
const card = (head: string, body = "## 背景\n模板：ui\n") => `前言里的 模板：security 不算\n# 卡\n${head}\n${body}`;
const mode = (m: "on" | "observe" | "off") => useTaskTierPort({ policy: () => ({ mode: m, manualAfterMs: null, source: "config" }) });

describe("[验收线 1] 卡首声明", () => {
  test("缺声明 = code（default）；唯一一行按声明；正文和标题前的不算", () => {
    expect(parseTaskTier(card(""))).toEqual({ ok: true, tier: "code", source: "default" });
    for (const t of ["security", "code", "ui", "docs"] as const) expect(parseTaskTier(card(`模板：${t}`))).toEqual({ ok: true, tier: t, source: "spec" });
    expect(parseTaskTier(card("模板: UI"))).toEqual({ ok: true, tier: "ui", source: "spec" });
  });

  test("重复 / 不认识：明确诊断，不猜", () => {
    expect(parseTaskTier(card("模板：code\n模板：ui"))).toMatchObject({ ok: false, code: "duplicate", error: expect.stringContaining("2 行") });
    expect(parseTaskTier(card("模板：infra"))).toMatchObject({ ok: false, code: "unknown", error: expect.stringContaining("infra") });
  });

  test("启动核对：已存流程优先；卡首明写另一类型 = 冲突；缺声明不冲突；读不到规格只认已存", () => {
    expect(tierAtLaunch({ template: "ui", specRev: 2 }, card(""))).toEqual({ ok: true, tier: "ui", source: "workflow" });
    expect(tierAtLaunch({ template: "ui", specRev: 2 }, card("模板：ui"))).toEqual({ ok: true, tier: "ui", source: "workflow" });
    expect(tierAtLaunch({ template: "ui", specRev: 2 }, card("模板：security"))).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("第 2 版") });
    expect(tierAtLaunch({ template: "security", specRev: 1 }, null)).toEqual({ ok: true, tier: "security", source: "workflow" });
    expect(tierAtLaunch(null, card("模板：ui"))).toEqual({ ok: true, tier: "ui", source: "spec" });
    expect(tierAtLaunch(null, undefined)).toEqual({ ok: true, tier: "code", source: "default" });
    expect(tierAtLaunch({ template: "code", specRev: 1 }, card("模板：code\n模板：ui"))).toMatchObject({ ok: false, code: "duplicate" });
    expect(tierAtLaunch({ template: "weird", specRev: 1 }, null)).toMatchObject({ ok: false, code: "unknown" });
  });
});

describe("[验收线 1] docs 未注册不可达", () => {
  test("启动核对拒 docs；注册后可达、撤销后又不可达；内建三种不受注册影响", () => {
    expect(tierLaunchable("docs")).toBe(false);
    expect(tierAtLaunch(null, card("模板：docs"))).toMatchObject({ ok: false, code: "unregistered" });
    const undo = registerTierTemplate("docs");
    expect(tierLaunchable("docs")).toBe(true);
    expect(tierAtLaunch(null, card("模板：docs"))).toEqual({ ok: true, tier: "docs", source: "spec" });
    undo();
    expect(tierLaunchable("docs")).toBe(false);
    registerTierTemplate("code")();
    expect(tierLaunchable("code")).toBe(true);
  });

  test("start_node 预检：template=docs 开不了卡，什么都不建", async () => {
    const f = integrationFixture();
    try {
      const r = await preflightStart(f.startEnv, { featureId: f.id, key: "next", template: "docs", spec: "# scope" });
      expect(r).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("docs 还没有注册流程模板") });
      expect(f.calls).toEqual([]);
    } finally { await f.close(); }
  });
});

describe("[验收线 1] start_node 预检按卡首声明定类型", () => {
  test("on：只给规格（模板：security），计划的流程就是 security，送进启动核对不冲突；显式 template 与声明不同拒", async () => {
    const f = integrationFixture();
    try {
      mode("on");
      const spec = card("模板：security");
      const r = await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec });
      if (!r.ok || !("plan" in r)) throw new Error(JSON.stringify(r));
      expect(r.plan.workflow).toEqual({ template: "security", version: 3 });
      const d = decideTierLaunch({ project: f.project, card: r.plan.taskId, tier: r.plan.workflow!.template, specText: spec }, "author", "claude", null, null);
      expect(d).toMatchObject({ mode: "on", value: "claude-opus-5-5" });
      expect(await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec, template: "security" })).toMatchObject({ ok: true });
      expect(await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec, template: "ui" })).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("冲突") });
      expect(await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec: card("模板：ui\n模板：code") })).toMatchObject({ ok: false, code: "invalid" });
      expect(await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec: card("模板：docs") })).toMatchObject({ ok: false, error: expect.stringContaining("docs 还没有注册") });
      const none = await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec: "# scope" });
      expect(none.ok && "plan" in none && none.plan.workflow?.template).toBe("code");
    } finally { await f.close(); }
  });

  test("off / observe：与旧路径一样只看参数（缺省 code），卡首声明不改流程", async () => {
    const f = integrationFixture();
    try {
      for (const m of ["off", "observe"] as const) {
        mode(m);
        const r = await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec: card("模板：security") });
        expect(r.ok && "plan" in r && r.plan.workflow?.template).toBe("code");
      }
    } finally { await f.close(); }
  });
});

describe("扩展点 2（模板注册）：新模块注册流程后开卡可达", () => {
  test("registerTierTemplate 带流程定义：templateFor / 开卡校验 / 计划都认 docs；撤销后又不可达", async () => {
    const f = integrationFixture();
    try {
      mode("on");
      const { id: _id, version: _v, ...flow } = FLOW_TEMPLATES.code;
      const undo = registerTierTemplate("docs", [{ ...flow, version: 3 }]);
      cleanups.push(undo);
      expect(templateFor("docs" as never, 3)).toMatchObject({ id: "docs", version: 3 });
      expect(WORKFLOW_TEMPLATES).toContain("docs" as never);
      const r = await preflightStart(f.startEnv, { featureId: f.id, key: "next", template: "docs", spec: "# scope" });
      expect(r.ok && "plan" in r && r.plan.workflow).toEqual({ template: "docs", version: 3 });
      const byDecl = await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec: card("模板：docs") });
      expect(byDecl.ok && "plan" in byDecl && byDecl.plan.workflow?.template).toBe("docs");
      undo();
      expect(templateFor("docs" as never, 3)).toBeNull();
      expect(WORKFLOW_TEMPLATES).not.toContain("docs" as never);
      expect(await preflightStart(f.startEnv, { featureId: f.id, key: "next", template: "docs", spec: "# scope" })).toMatchObject({ ok: false, code: "invalid" });
    } finally { await f.close(); }
  });

  test("内建模板名不能被注册覆盖", () => {
    expect(templateFor("code", 3)?.id).toBe("code");
    expect(registerTierTemplate("code", [{ ...FLOW_TEMPLATES.code, version: 9 }])).toBeFunction(); // 内建类型：无副作用
    expect(templateFor("code", 9)).toBeNull();
  });
});

describe("扩展点 2：派单前校验钩子接入 start_node 预检", () => {
  test("on：钩子返回原因就停派并记一条事件（重跑不重记）；没钩子 / 放行照常出计划", async () => {
    const f = integrationFixture();
    try {
      mode("on");
      expect(await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec: "# scope" })).toMatchObject({ ok: true });
      const seen: string[] = [];
      cleanups.push(registerTierChecks({ dispatch: (c) => (seen.push(`${c.tier}:${c.fileGlobs.join(",")}`), c.tier === "code" ? "文件范围不符合 code 模板" : null) }));
      const args = { featureId: f.id, key: "next", spec: "# scope" };
      expect(await preflightStart(f.startEnv, args)).toMatchObject({ ok: false, code: "tier_check", error: expect.stringContaining("文件范围不符合 code 模板") });
      expect(await preflightStart(f.startEnv, args)).toMatchObject({ ok: false, code: "tier_check" });
      expect(seen.length).toBe(2);
      const evs = listEvents(f.db, { project: f.project }).filter((e) => e.data.op === "task_tier_check");
      expect(evs).toEqual([expect.objectContaining({ kind: "note", data: expect.objectContaining({ phase: "dispatch", mode: "on", reason: "文件范围不符合 code 模板" }) })]);
      expect(await preflightStart(f.startEnv, { ...args, template: "ui" })).toMatchObject({ ok: true });
    } finally { await f.close(); }
  });

  test("off：钩子不调用、不记事件；observe：只记会拒的原因，放行", async () => {
    const f = integrationFixture();
    try {
      let calls = 0;
      cleanups.push(registerTierChecks({ dispatch: () => (calls++, "拒") }));
      mode("off");
      expect(await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec: "# scope" })).toMatchObject({ ok: true });
      expect(calls).toBe(0);
      expect(listEvents(f.db, { project: f.project }).filter((e) => e.data.op === "task_tier_check")).toEqual([]);
      mode("observe");
      expect(await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec: "# scope" })).toMatchObject({ ok: true });
      expect(calls).toBe(1);
      expect(listEvents(f.db, { project: f.project }).filter((e) => e.data.op === "task_tier_check").map((e) => e.data.mode)).toEqual(["observe"]);
    } finally { await f.close(); }
  });
});
