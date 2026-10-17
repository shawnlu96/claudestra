/**
 * docs 流程模板（src/lib/task-tier-docs-template.ts）：taskTierModels on / observe 才挂（进程级常驻，off 项目各边界按项目拒），流程逐版借 code 的、模型值全由 TIER3 解析；
 * 类型只认卡首唯一「模板：docs」；开卡前按 fileGlobs 校验；off 按项目回到旧模板校验的拒绝路径（开卡、调度规划），原有模板开卡 / 规划结果不变，重新 on 可再校验。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightStart, type StartEnv } from "../src/lib/dag-tools-start.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getWorkflow, WORKFLOW_TEMPLATES } from "../src/lib/ledger-scheduler.js";
import { migrateWorkflowDocsTemplate } from "../src/lib/ledger-scheduler-schema.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, LEDGER_SCHEMA_VERSION, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { defaultRoleModels, type RoleModelRead } from "../src/lib/role-model-settings.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { templateFor } from "../src/lib/scheduler-template.js";
import { docsFlows, resetDocsTemplate, syncDocsTemplate } from "../src/lib/task-tier-docs-template.js";
import { decideTierLaunch, resolveTierModel, reviewerTierCtx, TIER_DEFAULTS, useTaskTierPort } from "../src/lib/task-tier-models.js";
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
  test("off 不挂模板与钩子；原有模板开卡计划与 docs 未加载时逐字一致；docs 走旧拒绝路径（on 挂过之后 off 也一样）", async () => {
    const f = fixture();
    mode("off");
    const before = await f.start("good", card("模板：security"));
    expect(await f.start("good", card("模板：docs"), "docs")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("docs 还没有注册流程模板") });
    expect(syncDocsTemplate(f.project)).toBe(false);
    expect(tierLaunchable("docs")).toBe(false);
    expect(WORKFLOW_TEMPLATES).not.toContain("docs" as never);
    expect(runTierChecks("dispatch", { project: f.project, taskId: "x", tier: "docs", fileGlobs: ["src/**"] })).toBeNull();
    mode("on");
    syncDocsTemplate(f.project);
    mode("off");
    expect(syncDocsTemplate(f.project)).toBe(false); // 注册是进程级、留给别的 on 项目；本项目由各消费边界按项目拒
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
  test("没调过 syncDocsTemplate：on 可开 docs 卡、经 setWorkflow 正式落库、启动用 docs 有效值；off 回旧拒绝；重新 on 可再开", async () => {
    const f = fixture();
    resetDocsTemplate();
    mode("on");
    expect(tierLaunchable("docs")).toBe(false);
    const r = await f.start("good", card("模板：docs"));
    expect(workflowOf(r)).toEqual({ template: "docs", version: 3 });
    expect(tierLaunchable("docs")).toBe(true);
    // 计划的流程经正式 workflow 写入落库（不禁用 CHECK）；之后的审查员上下文从已存流程取 docs，模型走 TIER3 docs 有效值
    const id = "d0-docs-card", spec = card("模板：docs");
    createTask(f.db, { actor: "agent-d0-pm" }, { project: f.project, id, title: id, kind: "code" });
    const w = setWorkflow(f.db, { actor: "agent-d0-pm" }, { taskId: id, taskRev: getTask(f.db, id)!.rev, template: "docs" as never, templateVersion: 3,
      mode: "auto", authorFamily: "claude", fallback: "退 PM 人工" });
    expect(w.workflow).toMatchObject({ template: "docs", templateVersion: 3 });
    expect(getWorkflow(f.db, id)?.template as string).toBe("docs");
    const ctx = reviewerTierCtx(f.db, getTask(f.db, id)!);
    expect(ctx?.tier as string).toBe("docs");
    expect(decideTierLaunch({ ...ctx!, specText: spec }, "author", "claude", null, null)).toMatchObject({ mode: "on", value: TIER_DEFAULTS.docs.author.claude });
    mode("off");
    expect(await f.start("good", card("模板：docs"), "docs")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("docs 还没有注册流程模板") });
    mode("on");
    expect(workflowOf(await f.start("good", card("模板：docs")))).toEqual({ template: "docs", version: 3 });
  });
});

describe("[验收线 1] 台账迁移 migrateWorkflowDocsTemplate：旧库 task_workflows 的 CHECK 放开 docs", () => {
  test("旧 CHECK 的库升级后行数与各列逐行一致、docs 可写、非法值照拒、索引在；重复执行什么都不做", () => {
    const dir = mkdtempSync(join(tmpdir(), "tier3e-mig-")), path = join(dir, "ledger.sqlite");
    cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
    let db = openLedger(path);
    const insert = (id: string, template: string, mode = "auto") => db.prepare(`INSERT INTO task_workflows
      (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, rev, createdAt, updatedAt) VALUES (?, 'm', ?, 3, ?, 'codex', ?, 2, 4, 11, 22)`)
      .run(id, template, mode, `fallback ${id}`);
    for (const id of ["M1", "M2", "M3", "N1", "N2"]) createTask(db, { actor: "owner" }, { project: "m", id, title: id, kind: "code" });
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'task_workflows'").get() as { sql: string }).sql;
    expect(sql).toContain("'docs'");
    // 造旧库：按旧建表语句（只收三类）重建 task_workflows，版本号退到本迁移之前
    db.transaction(() => {
      db.run("ALTER TABLE task_workflows RENAME TO wf_new");
      db.run(sql.replace(",'docs'", ""));
      db.run("INSERT INTO task_workflows SELECT * FROM wf_new");
      db.run("DROP TABLE wf_new");
      db.run("CREATE INDEX IF NOT EXISTS task_workflows_project ON task_workflows(project, mode)");
    })();
    db.run(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION - 1}`);
    insert("M1", "code"); insert("M2", "ui", "manual"); insert("M3", "security", "observe");
    expect(() => insert("N1", "docs")).toThrow("CHECK constraint failed");
    const rows = () => db.prepare("SELECT * FROM task_workflows ORDER BY taskId").all();
    const before = rows();
    expect(before).toHaveLength(3);
    closeLedger(path);
    db = openLedger(path);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LEDGER_SCHEMA_VERSION);
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'task_workflows'").get() as { sql: string }).sql).toContain("'docs'");
    expect(rows()).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'task_workflows_project'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'task_workflows_docs_mig'").get()).toBeNull();
    insert("N1", "docs");
    expect(() => insert("N2", "bogus")).toThrow("CHECK constraint failed");
    expect(() => db.prepare("UPDATE task_workflows SET mode = 'nope' WHERE taskId = 'M1'").run()).toThrow("CHECK constraint failed");
    const after = rows(), schema = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    const changes = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    migrateWorkflowDocsTemplate(db); // 第二次：什么都不做
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(changes);
    expect([rows(), db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all()]).toEqual([after, schema]);
    expect(getWorkflow(db, "N1")).toMatchObject({ template: "docs", authorFamily: "codex", specRev: 2, rev: 4 });
  });
});

/** 一张已开好的 docs 卡（spec 阶段、auto 流程、建卡事件齐），规划走调度器真实入口 autoSnapshot + planScheduler */
function docsCard(project: string) {
  const dir = mkdtempSync(join(tmpdir(), "tier3e-plan-")), path = join(dir, "ledger.sqlite");
  const db = openLedger(path), actor = "agent-d0-pm";
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  setMeta(db, { actor: "owner" }, { project, key: "pms", value: [actor] });
  const add = (id: string, template: string) => {
    createTask(db, { actor }, { project, id, title: id, kind: "code" });
    db.prepare(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, rev, createdAt, updatedAt)
      VALUES (?, ?, ?, 3, 'auto', 'claude', '退 PM 人工', ?, 1, 1, 1)`).run(id, project, template, getTask(db, id)!.specRev);
  };
  add("D1", "docs"); add("C1", "code");
  const plan = (id: string) => planScheduler(autoSnapshot(db, getTask(db, id)!, { registry: [], maxWorkers: 2, now: 1 }));
  return { db, path, plan };
}
const brief = (d: ReturnType<typeof planScheduler>) => d.kind === "intent" ? { kind: d.kind, action: d.action } : { kind: d.kind, code: (d as { code?: string }).code };

describe("[验收线 1、3] 调度规划边界：已有 docs 卡按本项目档位推进 / 暂停，不靠开卡或交付先同步", () => {
  test("冷启动的生产进程（只加载开卡入口）：on 下已有 docs 卡照 code 流程规划，不判 workflow_drift", () => {
    const f = docsCard("d0-cold");
    closeLedger(f.path);
    const lib = (m: string) => JSON.stringify(join(import.meta.dir, "../src/lib", m));
    const script = `
      await import(${lib("dag-tools-start.ts")});
      const { useTaskTierPort } = await import(${lib("task-tier-models.ts")});
      const { openLedger, getTask } = await import(${lib("ledger-store.ts")});
      const { autoSnapshot } = await import(${lib("scheduler-auto-snapshot.ts")});
      const { planScheduler } = await import(${lib("scheduler-plan.ts")});
      useTaskTierPort({ policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }) });
      const db = openLedger(${JSON.stringify(f.path)});
      const out = {};
      for (const id of ["D1", "C1"]) { const d = planScheduler(autoSnapshot(db, getTask(db, id), { registry: [], maxWorkers: 2, now: 1 }));
        out[id] = d.kind === "intent" ? { kind: d.kind, action: d.action } : { kind: d.kind, code: d.code }; }
      console.log(JSON.stringify(out));`;
    const r = Bun.spawnSync([process.execPath, "-e", script], { cwd: join(import.meta.dir, ".."), env: process.env });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
    expect(out.D1).toEqual(out.C1);
    expect(out.D1.code).not.toBe("workflow_drift");
  });

  test("on→off 不新开卡：已有 docs 卡暂停（旧模板校验拒绝路径，诊断要求恢复开关或纠正规格），code 卡规划不变；重新 on 照常推进", () => {
    const f = docsCard("d0-flip");
    mode("on");
    const onDocs = brief(f.plan("D1")), onCode = brief(f.plan("C1"));
    expect(onDocs).toEqual(onCode);
    expect(onDocs.code).not.toBe("workflow_drift");
    mode("off");
    const off = f.plan("D1");
    expect(off).toMatchObject({ kind: "escalate", code: "workflow_drift", reason: expect.stringContaining("taskTierModels") });
    expect(brief(f.plan("C1"))).toEqual(onCode);
    mode("on");
    expect(brief(f.plan("D1"))).toEqual(onDocs);
  });

  test("同一进程两个项目：off 项目开卡不摘 on 项目的 docs；on 项目 docs 卡照常规划，off 项目 docs 卡暂停", async () => {
    const on = docsCard("d0-on"), off = docsCard("d0-off");
    const f = fixture();
    useTaskTierPort({ policy: (project: string) => ({ mode: project === "d0-on" ? "on" : "off", manualAfterMs: null, source: "config" }), read: () => TABLE });
    const want = brief(on.plan("C1"));
    expect(brief(on.plan("D1"))).toEqual(want);
    expect(await f.start("good", card("模板：docs"), "docs")).toMatchObject({ ok: false, error: expect.stringContaining("docs 还没有注册流程模板") }); // d0-project 是 off
    expect(brief(on.plan("D1"))).toEqual(want);
    expect(off.plan("D1")).toMatchObject({ kind: "escalate", code: "workflow_drift" });
  });
});
