/**
 * docs 流程模板（src/lib/task-tier-docs-template.ts）：taskTierModels on 才挂，流程逐版借 code 的、模型值全由 TIER3 解析；
 * 类型只认卡首唯一「模板：docs」；开卡前按 fileGlobs 校验；off 摘掉后回到旧模板校验的拒绝路径，原有模板开卡结果不变，重新 on 可再校验。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightStart, type StartEnv } from "../src/lib/dag-tools-start.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { WORKFLOW_TEMPLATES } from "../src/lib/ledger-scheduler.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { defaultRoleModels, type RoleModelRead } from "../src/lib/role-model-settings.js";
import { templateFor } from "../src/lib/scheduler-template.js";
import { docsFlows, resetDocsTemplate, syncDocsTemplate } from "../src/lib/task-tier-docs-template.js";
import { decideTierLaunch, resolveTierModel, TIER_DEFAULTS, useTaskTierPort } from "../src/lib/task-tier-models.js";
import { runTierChecks, tierLaunchable } from "../src/lib/task-tier-spec.js";

const cleanups: (() => void)[] = [];
afterEach(() => { resetDocsTemplate(); useTaskTierPort(); for (const c of cleanups.splice(0)) c(); });
const TABLE: RoleModelRead = (() => { const t = defaultRoleModels(); t.roles.reviewer = { claude: "claude-haiku-5-5", codex: "low" }; return { status: "ok", table: t }; })();
const mode = (m: "on" | "observe" | "off") => useTaskTierPort({ policy: () => ({ mode: m, manualAfterMs: null, source: "config" }), read: () => TABLE });
const card = (head: string, body = "## 背景\n正文\n") => `# 卡\n${head}\n${body}`;

/** 一本临时台账 + 三个待开节点：docs 合规、宽泛授权、发版说明通配 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tier3e-tpl-")), path = join(dir, "ledger.sqlite");
  const db = openLedger(path), actor = "agent-d0-pm", project = "d0-project", id = "d0c5-docs";
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  db.run("INSERT INTO ledger_instance VALUES ('origin', 'd0c5')");
  setMeta(db, { actor: "owner" }, { project, key: "pms", value: [actor] });
  createTask(db, { actor }, { project, id: "d0-existing", title: "Existing", kind: "code" });
  createFeature(db, { actor }, { project, slug: "docs", title: "Docs" });
  initDag(db, { actor }, { id, rev: 1, nodes: [
    { key: "good", oneLine: "Docs", fileGlobs: ["docs/**", "README.md", "RELEASE_NOTES.txt"] },
    { key: "wide", oneLine: "Wide", fileGlobs: ["src/**"] },
    { key: "loose", oneLine: "Loose", fileGlobs: ["release-notes/*"] },
  ] });
  const env: StartEnv = { db, caller: actor, ledgerDir: dir, worktreeRoot: join(dir, "worktrees"), projectDirs: async () => [dir], agentNames: () => [],
    exists: (p) => p === join(dir, ".git"), branchExists: async () => false, autoReady: () => null, template: () => null };
  const start = (key: string, spec: string, template?: string) => preflightStart(env, { featureId: id, key, spec, ...(template ? { template } : {}) });
  const checks = () => listEvents(db, { project }).filter((e) => e.data.op === "task_tier_check");
  return { db, project, start, checks };
}
const workflowOf = (r: Awaited<ReturnType<typeof preflightStart>>): unknown => (r.ok && "plan" in r ? r.plan.workflow : r);

describe("[验收线 1] on：docs 可开卡，流程与 code 一致，模型值由 TIER3 解析", () => {
  test("流程逐版借 code：节点、对抗审查、跨家族、无 ui 闸都相同", () => {
    const flows = docsFlows();
    expect(flows.map((f) => f.version)).toEqual([2, 3]);
    for (const f of flows) {
      const { id: _id, version: _v, ...code } = templateFor("code", f.version)!;
      expect(f).toEqual({ ...code, version: f.version });
      expect(f).toMatchObject({ reviewMode: "adversarial", crossFamily: true, uiGate: false });
    }
  });

  test("卡首「模板：docs」+ 合规 fileGlobs：计划是 docs 最新版；启动走 TIER3 有效值（作者 docs 档、审查员继承角色格）", async () => {
    const f = fixture();
    mode("on");
    expect(syncDocsTemplate(f.project)).toBe(true);
    expect(tierLaunchable("docs")).toBe(true);
    expect(templateFor("docs" as never, 3)?.nodes).toEqual(templateFor("code", 3)!.nodes);
    const spec = card("模板：docs");
    expect(workflowOf(await f.start("good", spec))).toEqual({ template: "docs", version: 3 });
    expect(workflowOf(await f.start("good", spec, "docs"))).toEqual({ template: "docs", version: 3 });
    const author = decideTierLaunch({ project: f.project, card: "D1", tier: "docs", specText: spec }, "author", "claude", null, null);
    expect(author).toMatchObject({ mode: "on", value: TIER_DEFAULTS.docs.author.claude });
    expect(author).toMatchObject({ value: resolveTierModel(TABLE, "docs", "author", "claude").value });
    const reviewer = decideTierLaunch({ project: f.project, card: "D1", tier: "docs", specText: spec }, "reviewer", "claude", null, null);
    expect(reviewer).toMatchObject({ mode: "on", value: "claude-haiku-5-5" });
    expect(f.checks()).toEqual([]);
  });

  test("只认卡首唯一声明：缺声明 = code，标题 / 正文里的 docs 不算，重复声明与显式参数冲突明确拒", async () => {
    const f = fixture();
    mode("on");
    syncDocsTemplate(f.project);
    expect(workflowOf(await f.start("good", "# 文档 docs 整理\n\n## 背景\n模板：docs\n"))).toEqual({ template: "code", version: 3 });
    expect(await f.start("good", card("模板：docs\n模板：docs"))).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("只能有一行") });
    expect(await f.start("good", card("模板：docs"), "code")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("冲突") });
    expect(await f.start("good", card("模板：doc"))).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("不认识") });
  });
});

describe("[验收线 2] 开卡前按 fileGlobs 停派", () => {
  test("宽泛授权 / 发版说明通配：停派、诊断要求纠正规格、记一条事件；不转 code", async () => {
    const f = fixture();
    mode("on");
    syncDocsTemplate(f.project);
    const spec = card("模板：docs");
    expect(await f.start("wide", spec)).toMatchObject({ ok: false, code: "tier_check", error: expect.stringContaining("纠正规格") });
    expect(await f.start("wide", spec)).toMatchObject({ ok: false, code: "tier_check" }); // 重跑不重记
    expect(await f.start("loose", spec)).toMatchObject({ ok: false, code: "tier_check", error: expect.stringContaining("逐项写具体文件路径") });
    expect(f.checks().map((e) => [e.data.phase, e.data.tier, e.data.mode])).toEqual([["dispatch", "docs", "on"], ["dispatch", "docs", "on"]]);
    // 同一节点按 code 开卡不受 docs 钩子影响
    expect(workflowOf(await f.start("wide", card("")))).toEqual({ template: "code", version: 3 });
  });

  test("observe：钩子只记会拒、放行（类型按旧路径取参数）", async () => {
    const f = fixture();
    mode("observe");
    expect(syncDocsTemplate(f.project)).toBe(true);
    expect(workflowOf(await f.start("wide", card("模板：docs"), "docs"))).toEqual({ template: "docs", version: 3 });
    expect(f.checks().map((e) => [e.data.phase, e.data.mode])).toEqual([["dispatch", "observe"]]);
  });
});

describe("[验收线 3] off：不挂模板、不加事件，回到旧模板校验拒绝；重新 on 可再校验", () => {
  test("off 摘掉模板与钩子；原有模板开卡计划与 docs 未加载时逐字一致；docs 走旧拒绝路径", async () => {
    const f = fixture();
    mode("off");
    const before = await f.start("good", card("模板：security"));
    mode("on");
    syncDocsTemplate(f.project);
    mode("off");
    expect(syncDocsTemplate(f.project)).toBe(false);
    expect(tierLaunchable("docs")).toBe(false);
    expect(WORKFLOW_TEMPLATES).not.toContain("docs" as never);
    expect(runTierChecks("dispatch", { project: f.project, taskId: "x", tier: "docs", fileGlobs: ["src/**"] })).toBeNull();
    expect(await f.start("good", card("模板：security"))).toEqual(before);
    expect(await f.start("good", card("模板：docs"), "docs")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("docs 还没有注册流程模板") });
    expect(await f.start("wide", card("模板：docs"))).toMatchObject({ ok: true }); // off：卡首声明不读，旧路径缺省 code
    expect(f.checks()).toEqual([]);
    mode("on");
    expect(syncDocsTemplate(f.project)).toBe(true);
    expect(await f.start("wide", card("模板：docs"))).toMatchObject({ ok: false, code: "tier_check" });
    expect(workflowOf(await f.start("good", card("模板：docs")))).toEqual({ template: "docs", version: 3 });
  });
});

describe("[验收线 1、3] 生产开卡入口：preflightStart 自己按项目同步 docs，不靠测试手动注册", () => {
  test("没调过 syncDocsTemplate：on 可开 docs 卡；off 回旧拒绝、摘掉注册；重新 on 可再开", async () => {
    const f = fixture();
    resetDocsTemplate();
    mode("on");
    expect(tierLaunchable("docs")).toBe(false);
    const r = await f.start("good", card("模板：docs"));
    expect(workflowOf(r)).toEqual({ template: "docs", version: 3 });
    expect(tierLaunchable("docs")).toBe(true);
    mode("off");
    expect(await f.start("good", card("模板：docs"), "docs")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("docs 还没有注册流程模板") });
    expect(tierLaunchable("docs")).toBe(false);
    mode("on");
    expect(workflowOf(await f.start("good", card("模板：docs")))).toEqual({ template: "docs", version: 3 });
  });
});
