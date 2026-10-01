/**
 * i28-A1 台账侧（验收线 1 / 5）：claim 的事务内重核与 arm 唯一、step 的授权边界（只到本 claim 的那一张卡）、settle、开关的权限、
 * PM hold，以及用源码断言钉住授权钩子只出现在规定位置。临时台账，命令一律经进程内 runLedger（与 CLI 同一路径）。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setFrozen, setMeta } from "../src/lib/ledger-write.js";
import { TEMPLATE_VERSION } from "../src/lib/scheduler-autostart.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator", PM = "agent-pm", FID = "ab12-i28", ARM = "0123456789abcdef", ARM2 = "fedcba9876543210";
let dir: string, db: Database, now: number, autoDispatch: boolean;

const run = (actor: string, args: string[]) => runLedger(args, {
  db, actor, projectIds: [P], loadRegistry: async () => ({}) as never, saveRegistry: async () => {}, now: () => now++,
  autoDispatch: () => autoDispatch, autoProjects: () => [P],
});
const sch = (...args: string[]) => run("scheduler", args) as Promise<Record<string, any>>;
const claim = (key = "a", arm = ARM, template = "code") => sch("scheduler-autostart", "claim", FID, key, "--arm", arm, "--template", template, "--max-workers", "3");
const step = (seq: number, ...args: string[]) => sch("scheduler-autostart", "step", String(seq), ...args);
const taskNew = (seq: number, id = "i28-a") => step(seq, "task-new", id, "--title=x", "--kind=code", "--branch=evil", "--pm=agent-x", "--dedup=d:tn");
const wf = (seq: number, id = "i28-a", mode = "auto") => step(seq, "workflow-set", id, `--rev=${getTask(db, id)?.rev ?? 0}`, `--workflow-rev=${getWorkflow(db, id)?.rev ?? 0}`,
  "--template=code", "--version=3", `--mode=${mode}`, "--author-family=codex", "--fallback=x");
const bind = (seq: number, key = "a", id = "i28-a") => step(seq, "dag-bind", FID, key, id, `--rev=${getFeature(db, FID)!.rev}`, "--dedup=d:bind");
const settle = (seq: number, outcome: string) => sch("scheduler-autostart", "settle", String(seq), "--outcome", outcome);

beforeEach(() => {
  now = 1_000;
  autoDispatch = true;
  dir = mkdtempSync(join(tmpdir(), "i28-a1-claim-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
  createFeature(db, { actor: PM, now: now++ }, { project: P, slug: "i28", title: "协作底座" });
  initDag(db, { actor: PM, now: now++ }, { id: FID, rev: 1, nodes: [
    { key: "a", oneLine: "节点 a", fileGlobs: ["src/lib/a*.ts"] }, { key: "b", oneLine: "节点 b", fileGlobs: ["src/lib/b.ts"] },
  ] });
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("claim", () => {
  test("卡号 / agent / 分支 / PM 由台账按规则算，同一 arm 再来是 duplicate，节点有活 claim 时别的 arm 也拒", async () => {
    const r = await claim();
    expect(r).toMatchObject({ ok: true, duplicate: false, claim: { taskId: "i28-a", agent: "agent-task-i28-a", branch: "feat/i28-a", pm: PM, template: "code", version: TEMPLATE_VERSION.code } });
    expect(await claim()).toMatchObject({ ok: true, duplicate: true, claim: { seq: r.claim.seq } });
    expect(await claim("a", ARM2)).toMatchObject({ ok: false, code: "conflict" });
    await settle(r.claim.seq, "failed");
    expect(await claim()).toMatchObject({ ok: true, duplicate: true });
  });

  test("只有调度身份能 claim / step / settle", async () => {
    expect(await run(PM, ["scheduler-autostart", "claim", FID, "a", "--arm", ARM, "--template", "code", "--max-workers", "3"])).toMatchObject({ ok: false, code: "forbidden" });
    const c = await claim();
    expect(await run(PM, ["scheduler-autostart", "settle", String(c.claim.seq), "--outcome", "unknown"])).toMatchObject({ ok: false, code: "forbidden" });
  });

  const twists: [string, () => unknown][] = [
    ["队列冻结", () => setFrozen(db, { actor: PM, now: now++ }, { project: P, frozen: true, reason: "x" })],
    ["开关关了", () => run(PM, ["autostart-set", "off", "--reason", "owner 一键关", "--project", P])],
    ["节点被 PM 绑了", () => {
      createTask(db, { actor: PM, now: now++ }, { project: P, id: "i28-a", title: "a", kind: "code" });
      bindNode(db, { actor: PM, now: now++ }, { id: FID, rev: getFeature(db, FID)!.rev, key: "a", taskId: "i28-a" });
    }],
    ["车道变了（项目里新开了重叠的卡）", () => createTask(db, { actor: PM, now: now++ }, { project: P, id: "T9", title: "x", kind: "code", extra: { fileGlobs: ["src/lib/a.ts"] } })],
    ["容量满了", () => {
      for (const id of ["T1", "T2", "T3"]) {
        createTask(db, { actor: PM, now: now++ }, { project: P, id, title: id, kind: "code" });
        db.query(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
          VALUES (?, ?, 'code', 3, 'auto', 'claude', 'x', 1, 1, 1)`).run(id, P);
      }
    }],
    ["autoDispatch 关了", () => { autoDispatch = false; }],
  ];
  for (const [name, twist] of twists) {
    test(`选完候选、写 claim 之前${name}：claim 拒，什么都没写`, async () => {
      await twist();
      const before = listEvents(db, { target: FID }).length;
      expect(await claim()).toMatchObject({ ok: false, code: "conflict" });
      expect(listEvents(db, { target: FID }).length).toBe(before);
    });
  }
});

describe("step：授权只到本 claim 的那张卡", () => {
  test("完整一遍：字段取 claim 与节点，不信适配器（分支 / PM / 作者家族 / 模板都被纠正）", async () => {
    const c = (await claim("a", ARM, "ui")).claim;
    expect(await taskNew(c.seq)).toMatchObject({ ok: true });
    expect(getTask(db, "i28-a")).toMatchObject({ branch: "feat/i28-a", pm: PM, agent: "agent-task-i28-a", kind: "code", extra: { fileGlobs: ["src/lib/a*.ts"] } });
    expect(await step(c.seq, "task-set", "i28-a", "--rev=1", "--agent=agent-task-i28-a", "--dedup=d:ts")).toMatchObject({ ok: true, duplicate: true });
    expect(await wf(c.seq)).toMatchObject({ ok: true });
    expect(getWorkflow(db, "i28-a")).toMatchObject({ mode: "auto", template: "ui", templateVersion: TEMPLATE_VERSION.ui, authorFamily: "claude" });
    expect(await bind(c.seq)).toMatchObject({ ok: true });
    expect(await settle(c.seq, "done")).toMatchObject({ ok: true });
  });

  test("拒：卡号不是 claim 的、换执行者、别的子命令、claim 已结、claim 不存在", async () => {
    const c = (await claim()).claim;
    expect(await taskNew(c.seq, "i28-b")).toMatchObject({ ok: false, code: "forbidden" });
    await taskNew(c.seq);
    expect(await step(c.seq, "task-set", "i28-a", "--rev=1", "--agent=agent-evil")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await step(c.seq, "review", "i28-a", "--text=pass")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await step(c.seq, "stage", "i28-a", "--from=spec", "--to=restate")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await bind(c.seq, "b")).toMatchObject({ ok: false, code: "forbidden" });
    await settle(c.seq, "failed");
    expect(await wf(c.seq)).toMatchObject({ ok: false, code: "forbidden" });
    expect(getWorkflow(db, "i28-a")).toBeNull();
    expect(await step(99_999, "workflow-set", "i28-a")).toMatchObject({ ok: false, code: "not_found" });
  });

  test("同卡号的卡是别人建的（PM 先开了）：claim 不授予开 auto、绑节点、取消", async () => {
    const c = (await claim()).claim;
    createTask(db, { actor: PM, now: now++ }, { project: P, id: "i28-a", title: "a", kind: "code" });
    expect(await taskNew(c.seq)).toMatchObject({ ok: false, code: "conflict" });
    expect(await wf(c.seq)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await bind(c.seq)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await step(c.seq, "stage", "i28-a", "--from=spec", "--to=cancelled", "--dedup=d:undo")).toMatchObject({ ok: false, code: "forbidden" });
    expect(getTask(db, "i28-a")!.stage).toBe("spec");
  });

  test("回滚：只能把本 claim 建的卡推到 cancelled，开过的 auto 能退回 manual", async () => {
    const c = (await claim()).claim;
    await taskNew(c.seq);
    await wf(c.seq);
    expect(await wf(c.seq, "i28-a", "manual")).toMatchObject({ ok: true });
    expect(await step(c.seq, "stage", "i28-a", "--from=spec", "--to=cancelled", "--dedup=d:undo")).toMatchObject({ ok: true });
    expect(getTask(db, "i28-a")!.stage).toBe("cancelled");
    expect(await settle(c.seq, "failed")).toMatchObject({ ok: true });
  });

  test("模板声明不合法的 claim：不授予开 auto", async () => {
    const c = (await claim("a", ARM, "invalid")).claim;
    expect(c.template).toBeNull();
    await taskNew(c.seq);
    expect(await wf(c.seq)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("lib 钩子：调度身份没有核过的 claim 就什么都写不了", () => {
  test("setWorkflow / bindNode：没有 ctx.autostart、或指向别的卡 / 节点，一律 forbidden", () => {
    createTask(db, { actor: PM, now: now++ }, { project: P, id: "i28-a", title: "a", kind: "code" });
    const wfIn = { taskId: "i28-a", taskRev: 1, template: "code" as const, templateVersion: 3, mode: "auto" as const, authorFamily: "claude" as const, fallback: "x" };
    expect(() => setWorkflow(db, { actor: "scheduler" }, wfIn)).toThrow(/只有项目 PM/);
    expect(() => setWorkflow(db, { actor: "scheduler", autostart: { claim: 1, featureId: FID, key: "a", taskId: "i28-b" } }, wfIn)).toThrow(/只有项目 PM/);
    expect(() => setWorkflow(db, { actor: "agent-x", autostart: { claim: 1, featureId: FID, key: "a", taskId: "i28-a" } }, wfIn)).toThrow(/只有项目 PM/);
    const bindIn = { id: FID, rev: getFeature(db, FID)!.rev, key: "a", taskId: "i28-a" };
    expect(() => bindNode(db, { actor: "scheduler" }, bindIn)).toThrow(/PM/);
    expect(() => bindNode(db, { actor: "scheduler", autostart: { claim: 1, featureId: FID, key: "b", taskId: "i28-a" } }, bindIn)).toThrow(/PM/);
  });

  test("源码断言：autostartGrant 只在 setWorkflow 与 bindNode 两处；ctx.autostart 只由 step 模块放入；applyMove 带角色的调用只在 step 的回滚取消", () => {
    const root = resolve(import.meta.dir, "../src");
    const hits: Record<string, string[]> = { grant: [], put: [] };
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) {
          const src = readFileSync(p, "utf8"), rel = p.slice(root.length + 1);
          for (const m of src.matchAll(/autostartGrant\(/g)) hits.grant.push(`${rel}@${src.slice(0, m.index).split("\n").length}`);
          if (/autostart: \{ claim:/.test(src)) hits.put.push(rel);
        }
      }
    };
    walk(root);
    const files = hits.grant.map((h) => h.split("@")[0]);
    expect(files.sort()).toEqual(["lib/ledger-autostart-grant.ts", "lib/ledger-dag-write.ts", "lib/ledger-scheduler-write.ts"]);
    expect(hits.put).toEqual(["lib/ledger-autostart-step.ts"]);
    const step = readFileSync(join(root, "lib/ledger-autostart-step.ts"), "utf8");
    expect([...step.matchAll(/applyMove\(/g)]).toHaveLength(1);
    expect(step).toMatch(/applyMove\(db, ctx, task, \{ from, to: "cancelled" \}/);
    const sw = readFileSync(join(root, "lib/ledger-scheduler-write.ts"), "utf8");
    expect(sw).toMatch(/if \(!actorMayConfigure\(db, ctx\.actor, task\.project\) && !autostartGrant\(ctx, task\.id\)\) throw/);
    const dw = readFileSync(join(root, "lib/ledger-dag-write.ts"), "utf8");
    expect(dw).toMatch(/ops\("dag-bind"\)\);\n {4}if \(dup\) return dup;\n {4}if \(!autostartGrant\(ctx, input\.taskId, \{ featureId: f\.id, key: input\.key \}\)\) requireManager/);
  });
});

describe("settle", () => {
  test("done 要节点已绑；绑了本 claim 的卡就只能 done；同结论重来是 duplicate、换结论 conflict", async () => {
    const c = (await claim()).claim;
    expect(await settle(c.seq, "done")).toMatchObject({ ok: false, code: "conflict" });
    await taskNew(c.seq);
    await bind(c.seq);
    expect(await settle(c.seq, "failed")).toMatchObject({ ok: false, code: "conflict" });
    expect(await settle(c.seq, "done")).toMatchObject({ ok: true, duplicate: false, boundTo: "i28-a" });
    expect(await settle(c.seq, "done")).toMatchObject({ ok: true, duplicate: true });
    expect(await settle(c.seq, "unknown")).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("开关 autostart-set", () => {
  test("PM / master / owner 能改并留审计事件；执行者、调度服务不能；--line 只收 50–100", async () => {
    expect(await run(PM, ["autostart-set", "off", "--reason", "owner 一键关", "--project", P])).toMatchObject({ ok: true, autostart: { off: { by: PM } } });
    expect(await run("owner", ["autostart-set", "on", "--line", "85", "--reason", "owner 改线", "--project", P])).toMatchObject({ ok: true, autostart: { weeklyLinePct: 85 } });
    expect(await run("master", ["autostart-set", "off", "--feature", FID, "--reason", "这条先手动", "--project", P])).toMatchObject({ ok: true });
    expect(await run("agent-x", ["autostart-set", "off", "--reason", "x", "--project", P])).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run("scheduler", ["autostart-set", "off", "--reason", "x", "--project", P])).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(PM, ["autostart-set", "on", "--line", "40", "--reason", "x", "--project", P])).toMatchObject({ ok: false, code: "invalid" });
    expect(listEvents(db, { project: P }).filter((e) => e.kind === "meta" && e.data.op === "autostart")).toHaveLength(3);
  });

  test("feature-show 带 autostart 字段：开关与每个计划节点卡在哪道门", async () => {
    await run(PM, ["autostart-set", "off", "--feature", FID, "--reason", "先手动", "--project", P]);
    const r = await run(PM, ["feature-show", FID]) as Record<string, any>;
    expect(r.autostart.switch.feature).toMatchObject({ off: true, reason: "先手动" });
    expect(r.autostart.nodes.map((n: { key: string; gate: string }) => [n.key, n.gate])).toEqual([["a", "switch"], ["b", "switch"]]);
  });
});

describe("PM hold", () => {
  test("已是 manual 的卡带 --reason 再设 manual：记一条带 hold 的事件；不带 --reason 仍是原样的空操作", () => {
    createTask(db, { actor: PM, now: now++ }, { project: P, id: "T1", title: "t", kind: "code" });
    const base = { taskId: "T1", template: "code" as const, templateVersion: 3, mode: "manual" as const, authorFamily: "claude" as const, fallback: "x" };
    setWorkflow(db, { actor: PM, now: now++ }, { ...base, taskRev: 1 });
    const w = getWorkflow(db, "T1")!;
    expect(setWorkflow(db, { actor: PM, now: now++ }, { ...base, taskRev: 1, workflowRev: w.rev }).duplicate).toBe(true);
    expect(setWorkflow(db, { actor: PM, now: now++ }, { ...base, taskRev: 1, workflowRev: w.rev, reason: "等 owner 看截图" }).duplicate).toBe(false);
    expect(listEvents(db, { target: "T1" }).findLast((e) => e.data.op === "workflow")!.data).toMatchObject({ mode: "manual", hold: "等 owner 看截图" });
  });
});
