/**
 * i28-UIQ1：带界面的 feature 自动维护整页验收节点 PAGEOK（dag-init / dag-rewrite 落库前），没 verified 不许 feature 改成 done；
 * ui 卡的审查单附对照基准与新的标准答复，code 卡审查单逐字不变。台账是临时目录里的文件库：规格卡在库旁的 ledger/docs/tasks/。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRewrite, planOverExisting } from "../src/lib/dag-tools-plan.js";
import { effectiveNodes, getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { standardAnswers, UI_BASIS_RULE } from "../src/lib/order-standard-answers.js";
import { PAGE_CHECK_KEY, uiReviewBasis } from "../src/lib/ui-acceptance.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const PM = "agent-pm";
const F = "ab12-i28";
const UI_SPEC = "# 规格\n模板：ui\n## 复用对象\n团队视图\n## 对照基准\n/tmp/base.png 现有团队视图\n";
let dir: string, dbPath: string, db: Database;

function run(actor: string, ...args: string[]) {
  return runLedger(args, {
    db, actor, actorProject: actor === "owner" ? undefined : P, projectIds: [P],
    loadRegistry: async () => ({ socket: "", agents: { [PM]: { channelId: "c-pm" } } }) as never, saveRegistry: async () => {}, now: () => 2_000,
  }) as Promise<Record<string, any>>;
}

const J = (x: unknown) => JSON.stringify(x);
const rev = () => String(getFeature(db, F)!.rev);
const spec = (taskId: string, text: string) => writeFileSync(join(dir, "ledger", "docs", "tasks", `${taskId}.md`), text);
const nodes = () => effectiveNodes(db, getDagVersion(db, F, getFeature(db, F)!.currentVersion)!);
const page = () => nodes().filter((n) => n.key === PAGE_CHECK_KEY);
const rewrite = (ns: unknown) => run(PM, "dag-rewrite", "i28", "--rev", rev(), "--nodes", J(ns), "--reason-kind", "new_issue", "--reason", "加减 ui 节点");
const uiWorkflow = (taskId: string) => db.prepare(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
  VALUES (?, ?, 'ui', 3, 'manual', 'claude', 'PM 接管', 1, 1, 1)`).run(taskId, P);
const node = (key: string, deps: string[] = []) => ({ key, oneLine: `节点 ${key}`, deps, fileGlobs: [`src/lib/${key}*.ts`] });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "uiq1-"));
  dbPath = join(dir, "ledger.sqlite");
  mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
  db = openLedger(dbPath);
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
  expect((await run(PM, "feature-new", "i28", "--title", "团队视图")).ok).toBe(true);
});
afterEach(() => {
  closeLedger(dbPath);
  rmSync(dir, { recursive: true, force: true });
});

describe("整页验收节点 PAGEOK", () => {
  test("page-tool-remove：工具组合删除部分及最后一个 UI 节点", async () => {
    spec("i28-a", UI_SPEC);
    spec("i28-b", UI_SPEC);
    expect((await run(PM, "dag-init", "i28", "--rev", rev(), "--nodes", J([node("a"), node("b"), node("c")]))).ok).toBe(true);
    for (const key of ["a", "b"]) {
      const next = composeRewrite(nodes(), { add: [], update: [], remove: [key], cancel: {} }, () => "idle");
      expect(next.ok).toBe(true);
      if (next.ok) expect((await rewrite(next.value)).ok).toBe(true);
      expect(page().map((n) => n.deps)).toEqual(key === "a" ? [["b"]] : []);
    }
  });

  test("page-tool-remove：plan_feature 不把系统验收节点当调用方取消的任务", async () => {
    spec("i28-a", UI_SPEC);
    expect((await run(PM, "dag-init", "i28", "--rev", rev(), "--nodes", J([node("a"), node("b")]))).ok).toBe(true);
    createTask(db, { actor: "owner", now: 600 }, { project: P, id: "PG", title: "验收中", kind: "code" });
    expect((await run(PM, "dag-bind", "i28", PAGE_CHECK_KEY, "PG", "--rev", rev())).ok).toBe(true);
    db.prepare("UPDATE tasks SET stage = 'build' WHERE id = 'PG'").run();
    const next = planOverExisting(nodes(), [{ ...node("b"), deps: [] }], (n) => n.key === PAGE_CHECK_KEY ? "active" : "idle");
    expect(next.ok).toBe(true);
    if (next.ok) expect((await rewrite(next.value)).ok).toBe(true);
    expect(page()[0]).toMatchObject({ taskId: "PG", deps: [] });
  });

  test("page-frozen：验收通过后新增 UI 必须重新验收全部 UI", async () => {
    spec("i28-a", UI_SPEC);
    expect((await run(PM, "dag-init", "i28", "--rev", rev(), "--nodes", J([node("a")]))).ok).toBe(true);
    createTask(db, { actor: "owner", now: 600 }, { project: P, id: "PG", title: "整页验收", kind: "code" });
    expect((await run(PM, "dag-bind", "i28", PAGE_CHECK_KEY, "PG", "--rev", rev())).ok).toBe(true);
    db.prepare("UPDATE tasks SET stage = 'verified' WHERE id = 'PG'").run();
    spec("i28-b", UI_SPEC);
    expect((await rewrite([node("a"), node("b")])).ok).toBe(true);
    expect(page()[0].deps).toEqual(["a", "b"]);
    expect(page()[0].taskId).toBeNull();
    expect(getTask(db, "PG")!.stage).toBe("verified");
    expect(getDagVersion(db, F, 1)!.nodes.find((n) => n.key === PAGE_CHECK_KEY)!.deps).toEqual(["a"]);
    expect((await run(PM, "feature-set", "i28", "--rev", rev(), "--status", "done")).ok).toBe(false);
  });

  test("page-late-ui：规划后绑定 UI 卡完成门拒绝直到重写补验收", async () => {
    expect((await run(PM, "dag-init", "i28", "--rev", rev(), "--nodes", J([node("a")]))).ok).toBe(true);
    createTask(db, { actor: "owner", now: 600 }, { project: P, id: "U", title: "后绑定 UI", kind: "code" });
    uiWorkflow("U");
    expect((await run(PM, "dag-bind", "i28", "a", "U", "--rev", rev())).ok).toBe(true);
    expect(page()).toEqual([]);
    expect(getFeature(db, F)!.currentVersion).toBe(1);
    const result = await run(PM, "feature-set", "i28", "--rev", rev(), "--status", "done");
    expect(result.ok).toBe(false);
    expect(result.error).toContain(PAGE_CHECK_KEY);
    expect((await rewrite([{ ...node("a"), taskId: "U" }])).ok).toBe(true);
    expect(page().map((n) => n.deps)).toEqual([["a"]]);
  });

  test("page-late-ui：新规划后规格变 UI 且缺 PAGEOK 时完成门仍拒绝", async () => {
    expect((await run(PM, "dag-init", "i28", "--rev", rev(), "--nodes", J([node("a")]))).ok).toBe(true);
    spec("i28-a", UI_SPEC);
    const result = await run(PM, "feature-set", "i28", "--rev", rev(), "--status", "done");
    expect(result.ok).toBe(false);
    expect(result.error).toContain(PAGE_CHECK_KEY);
  });

  test("历史 DAG 无 opt-in 不追溯拦截，之后重写才启用整页验收", async () => {
    const old = { ...node("a"), taskId: null, status: "planned" as const, estimate: "", inheritedFrom: null };
    db.prepare(`INSERT INTO dag_versions (featureId, version, reasonKind, reasonText, proposedBy, createdAt, nodes)
      VALUES (?, 1, 'initial', '历史规划', ?, 1, ?)`).run(F, PM, J([old]));
    db.prepare("UPDATE features SET currentVersion = 1 WHERE id = ?").run(F);
    spec("i28-a", UI_SPEC);
    expect((await run(PM, "feature-set", "i28", "--rev", rev(), "--status", "done")).ok).toBe(true);
    expect(page()).toEqual([]);
    expect((await rewrite([node("a"), node("b")])).ok).toBe(true);
    expect(page().map((n) => n.deps)).toEqual([["a"]]);
    expect((await run(PM, "feature-set", "i28", "--rev", rev(), "--status", "done")).ok).toBe(false);
    expect(getDagVersion(db, F, 1)!.nodes).toEqual([old]);
  });

  test("重写系统验收不会放松普通已完成节点的原样保护", async () => {
    expect((await run(PM, "dag-init", "i28", "--rev", rev(), "--nodes", J([node("a")]))).ok).toBe(true);
    createTask(db, { actor: "owner", now: 600 }, { project: P, id: "A", title: "已完成普通卡", kind: "code" });
    expect((await run(PM, "dag-bind", "i28", "a", "A", "--rev", rev())).ok).toBe(true);
    db.prepare("UPDATE tasks SET stage = 'verified' WHERE id = 'A'").run();
    const result = await rewrite([{ ...node("a"), taskId: "A", oneLine: "修改已完成内容" }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("已完成的节点 a");
  });

  test("没有 ui 节点：不出现", async () => {
    expect((await run(PM, "dag-init", "i28", "--rev", rev(), "--nodes", J([node("a"), node("b")]))).ok).toBe(true);
    expect(page()).toEqual([]);
  });

  test("第一个 ui 节点出现 → 自动加；再加 / 删 ui 节点依赖跟着变；重复写入不出第二个；删光且未开工 → 移除", async () => {
    spec("i28-a", UI_SPEC);
    expect((await run(PM, "dag-init", "i28", "--rev", rev(), "--nodes", J([node("a"), node("b")]))).ok).toBe(true);
    expect(page()).toHaveLength(1);
    expect(page()[0]).toMatchObject({ deps: ["a"], taskId: null });
    expect(page()[0].fileGlobs).toBeUndefined();
    expect(page()[0].cardSlug).toBe("i28");

    spec("i28-c", UI_SPEC);
    expect((await rewrite([node("a"), node("b"), node("c")])).ok).toBe(true);
    expect(page().map((n) => n.deps)).toEqual([["a", "c"]]);

    // PM 把 PAGEOK 原样（带旧依赖）抄回来、同时删掉 a：不报依赖错，也不多出一份
    expect((await rewrite([node("b"), node("c"), { key: PAGE_CHECK_KEY, oneLine: "x", deps: ["c"] }])).ok).toBe(true);
    expect(page().map((n) => n.deps)).toEqual([["c"]]);
    expect((await rewrite([node("b"), node("c"), node("d")])).ok).toBe(true);
    expect(page()).toHaveLength(1);

    expect((await rewrite([node("b"), node("d")])).ok).toBe(true);
    expect(page()).toEqual([]);
  });

  test("绑的卡 workflow 模板是 ui 也算 ui 节点", async () => {
    createTask(db, { actor: "owner", now: 600 }, { project: P, id: "U1", title: "ui 卡", kind: "code" });
    uiWorkflow("U1");
    expect((await run(PM, "dag-init", "i28", "--rev", rev(), "--nodes", J([{ taskId: "U1" }, node("b")]))).ok).toBe(true);
    expect(page().map((n) => n.deps)).toEqual([["U1"]]);
  });

  test("已开工的 PAGEOK 不随 ui 节点删光而移除", async () => {
    spec("i28-a", UI_SPEC);
    expect((await run(PM, "dag-init", "i28", "--rev", rev(), "--nodes", J([node("a"), node("b")]))).ok).toBe(true);
    createTask(db, { actor: "owner", now: 600 }, { project: P, id: "PG", title: "整页验收", kind: "code" });
    expect((await run(PM, "dag-bind", "i28", PAGE_CHECK_KEY, "PG", "--rev", rev())).ok).toBe(true);
    db.prepare("UPDATE tasks SET stage = 'build' WHERE id = 'PG'").run();
    expect((await rewrite([node("b")])).ok).toBe(true);
    expect(page()).toMatchObject([{ taskId: "PG", deps: [] }]);
  });

  test("PAGEOK 没 verified：feature 不能改成 done；verified 之后可以；没有 PAGEOK 的 feature 照旧", async () => {
    spec("i28-a", UI_SPEC);
    expect((await run(PM, "dag-init", "i28", "--rev", rev(), "--nodes", J([node("a")]))).ok).toBe(true);
    const unbound = await run(PM, "feature-set", "i28", "--rev", rev(), "--status", "done");
    expect(unbound).toMatchObject({ ok: false, code: "conflict" });
    expect(unbound.error).toContain(PAGE_CHECK_KEY);
    createTask(db, { actor: "owner", now: 600 }, { project: P, id: "PG", title: "整页验收", kind: "code" });
    expect((await run(PM, "dag-bind", "i28", PAGE_CHECK_KEY, "PG", "--rev", rev())).ok).toBe(true);
    db.prepare("UPDATE tasks SET stage = 'review' WHERE id = 'PG'").run();
    expect((await run(PM, "feature-set", "i28", "--rev", rev(), "--status", "done")).ok).toBe(false);
    db.prepare("UPDATE tasks SET stage = 'verified' WHERE id = 'PG'").run();
    expect((await run(PM, "feature-set", "i28", "--rev", rev(), "--status", "done")).ok).toBe(true);
    expect(getFeature(db, F)!.status).toBe("done");

    expect((await run(PM, "feature-new", "i29", "--title", "纯后端")).ok).toBe(true);
    expect((await run(PM, "dag-init", "i29", "--rev", "1", "--nodes", J([node("x")]))).ok).toBe(true);
    expect((await run(PM, "feature-set", "i29", "--rev", String(getFeature(db, "ab12-i29")!.rev), "--status", "done")).ok).toBe(true);
  });
});

describe("ui 卡审查单附对照基准", () => {
  const task = (id: string, specPath: string | null) => {
    createTask(db, { actor: "owner", now: 600 }, { project: P, id, title: id, kind: "code", spec: specPath });
    return getTask(db, id) as LedgerTask;
  };

  test("ui 规格：对照基准一节 + 新的标准答复；code 规格：审查单那一项逐字不变", () => {
    spec("UI1", UI_SPEC);
    const ui = standardAnswers("review", uiReviewBasis(db, task("UI1", join(dir, "ledger", "docs", "tasks", "UI1.md"))));
    expect(ui).toContain(UI_BASIS_RULE);
    expect(ui).toContain("对照基准（规格原文");
    expect(ui).toContain("/tmp/base.png 现有团队视图");
    spec("C1", "# 规格\n## 目标\n");
    const code = uiReviewBasis(db, task("C1", join(dir, "ledger", "docs", "tasks", "C1.md")));
    expect(code).toBeUndefined();
    expect(standardAnswers("review", code)).toBe(standardAnswers("review"));
  });

  test("规格没写对照基准：说明缺基准；出借池按传入的规格原文判", () => {
    const basis = uiReviewBasis(db, task("UI2", null), "# 规格\n模板：ui\n## 目标\n");
    expect(basis).toContain("规格没写「## 对照基准」");
    expect(uiReviewBasis(db, task("C2", null), "# 规格\n")).toBeUndefined();
  });

  test("没有规格但卡的 workflow 模板是 ui：也附（基准缺）", () => {
    const t = task("UI3", null);
    uiWorkflow("UI3");
    expect(uiReviewBasis(db, t)).toContain("规格没写");
  });
});
