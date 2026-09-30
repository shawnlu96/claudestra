/**
 * i28-L5 四个 MCP 工具走完整管道：bridge handler（bridge/dag-tools.ts）→ 以调用方频道跑 `manager ledger …`（这里用进程内 runLedger 代替子进程，
 * actor 同样按频道认）→ 台账。git / manager create / kill 换成记账的假实现，文件落在临时目录。
 * 覆盖验收线的每条 P1：非 PM 调写类工具、缺 fileGlobs、start_node 中途失败留半截、重叠算并行、不带原因删进行中节点；以及正常路径。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dagToolHandlers, type DagToolDeps } from "../src/bridge/dag-tools.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { VerifiedCall } from "../src/lib/order-tool-route.js";
import { isOrderTool } from "../src/lib/order-tools.js";
import { resolveActor } from "../src/manager/ledger-identity.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const PM: VerifiedCall = { agent: "agent-pm", sessionId: "s-pm", family: "claude-code", channelId: "ch-pm" };
const X: VerifiedCall = { agent: "agent-x", sessionId: "s-x", family: "claude-code", channelId: "ch-x" };
const MASTER: VerifiedCall = { agent: "master", sessionId: null, family: "claude-code", channelId: "ch-ctl" };

let dir: string, repo: string, db: Database, now: number;
let agents: Record<string, { channelId: string; projectId?: string }>;
let branches: Set<string>;
let calls: string[][];
/** 返回 true 的 manager / git 调用被注入成失败 */
let failOn: (args: string[]) => boolean;
let autoDispatch: boolean;

const ledgerRun = async (args: string[], channelId: string) => {
  const who = resolveActor({ channelId, controlChannelId: "ch-ctl" }, agents);
  if (!who.ok) return { ok: false, code: "forbidden", error: who.error };
  return runLedger(args.slice(1), {
    db, actor: who.actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents }) as never, saveRegistry: async () => {},
    now: () => now++, autoDispatch: () => autoDispatch, autoProjects: () => [P],
  });
};

function deps(): DagToolDeps {
  return {
    db: () => db,
    manager: async (args, channelId) => {
      calls.push(args);
      if (failOn(args)) return { ok: false, error: `注入失败：${args[0]} ${args[1]}` };
      if (args[0] === "ledger") return ledgerRun(args, channelId);
      if (args[0] === "create") {
        agents[`agent-${args[1]}`] = { channelId: `ch-${args[1]}`, projectId: P };
        return { ok: true, agent: `agent-${args[1]}` };
      }
      if (args[0] === "kill") {
        delete agents[args[1]];
        return { ok: true };
      }
      return { ok: false, error: "未知命令" };
    },
    callerProject: (a) => agents[a]?.projectId ?? null,
    startEnv: () => ({
      ledgerDir: join(dir, "ledger"), worktreeRoot: join(dir, "wt"), projectDirs: async () => [repo], agentNames: () => Object.keys(agents),
      exists: existsSync, branchExists: async (_r, b) => branches.has(b), autoReady: () => (autoDispatch ? null : "调度服务没开"), template: () => null,
    }),
    stepIO: () => ({
      git: async (_cwd, args) => {
        calls.push(["git", ...args]);
        if (failOn(["git", ...args])) return { ok: false, out: "注入失败" };
        if (args[0] === "worktree" && args[1] === "add") {
          mkdirSync(args[4], { recursive: true });
          branches.add(args[3]);
        } else if (args[0] === "worktree" && args[1] === "remove") rmSync(args[3], { recursive: true, force: true });
        else if (args[0] === "rev-parse") return { ok: branches.has(args[3].replace("refs/heads/", "")), out: "" };
        else if (args[0] === "branch") branches.delete(args[2]);
        return { ok: true, out: "" };
      },
      exists: existsSync, read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
      write: (p, t) => (mkdirSync(join(p, ".."), { recursive: true }), writeFileSync(p, t)), remove: (p) => rmSync(p, { force: true }),
      symlink: (t, p) => writeFileSync(p, `-> ${t}`), agentExists: (a) => !!agents[a],
    }),
  };
}

const tools = () => dagToolHandlers(deps());
const call = (who: VerifiedCall, tool: string, args: unknown) => tools()[tool](who, args) as Promise<Record<string, any>>;
const node = (key: string, fileGlobs: unknown, more: Record<string, unknown> = {}) => ({ key, oneLine: `节点 ${key}`, fileGlobs, ...more });
const plan = (who = PM, nodes: unknown[] = [node("a", ["src/lib/a*.ts"]), node("b", ["src/bridge/b.ts"])]) =>
  call(who, "plan_feature", { slug: "i28", title: "协作底座", ownerWords: "原话", nodes });
const spec = (id: string) => {
  mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
  writeFileSync(join(dir, "ledger", "docs", "tasks", `${id}.md`), "# 规格\n");
};
const start = (key: string, who = PM, more: Record<string, unknown> = {}) => call(who, "start_node", { featureId: "i28", key, ...more });
const writes = () => calls.filter((c) => c[0] !== "ledger" || !["dag-show", "feature-show"].includes(c[1]));

beforeEach(() => {
  now = 1_000;
  calls = [];
  failOn = () => false;
  autoDispatch = true;
  branches = new Set(["main"]);
  dir = mkdtempSync(join(tmpdir(), "i28-l5-"));
  repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  db = openLedger(join(dir, "ledger.sqlite"));
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM.agent] });
  agents = { [PM.agent]: { channelId: "ch-pm", projectId: P }, [X.agent]: { channelId: "ch-x", projectId: P } };
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("工具注册", () => {
  test("四个工具都在 channel-server 的派单工具表里", () => {
    for (const t of ["plan_feature", "rewrite_dag", "start_node", "show_dag"]) expect(isOrderTool(t)).toBe(true);
  });
});

describe("P1：权限", () => {
  test("非 PM 调写类工具一律 forbidden，什么都没写；show_dag 只读可以看", async () => {
    expect(await plan(X)).toMatchObject({ ok: false, code: "forbidden" });
    expect(getFeature(db, "ab12-i28")).toBeNull();
    expect((await plan()).ok).toBe(true);
    spec("i28-a");
    calls = [];
    expect(await start("a", X)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await call(X, "rewrite_dag", { featureId: "i28", reasonKind: "new_issue", reason: "x", remove: ["b"] })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await call(X, "plan_feature", { featureId: "i28", nodes: [node("a", ["x.ts"])], reasonKind: "new_issue", reason: "x" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(writes()).toEqual([]);
    expect(await call(X, "show_dag", { featureId: "i28" })).toMatchObject({ ok: true, current: 1 });
  });

  test("master 可以调", async () => {
    expect(await call(MASTER, "plan_feature", { slug: "m1", title: "大总管建的", project: P, nodes: [node("a", ["a.ts"])] })).toMatchObject({ ok: true });
  });
});

describe("P1：fileGlobs 必填", () => {
  test("缺 / 空 fileGlobs 的节点被拒，feature 也不建", async () => {
    expect(await plan(PM, [node("a", undefined)])).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("fileGlobs") });
    expect(await plan(PM, [node("a", [])])).toMatchObject({ ok: false, code: "invalid" });
    expect(await plan(PM, [node("a", ["../etc/passwd"])])).toMatchObject({ ok: false, code: "invalid" });
    expect(getFeature(db, "ab12-i28")).toBeNull();
    expect(writes()).toEqual([]);
  });
});

describe("正常路径：规划 → 两条车道 → 两次开工", () => {
  test("两节点不重叠：两条车道，两次 start_node 建出两张 auto 卡", async () => {
    const r = await plan();
    expect(r).toMatchObject({ ok: true, feature: "ab12-i28", lanes: { startNow: ["a", "b"], lanes: [["a"], ["b"]] } });
    spec("i28-b");
    const a = await start("a", PM, { spec: "# i28-a 规格\n范围……" });
    expect(a).toMatchObject({ ok: true, taskId: "i28-a", agent: "agent-task-i28-a", branch: "feat/i28-a" });
    expect((await start("b")).ok).toBe(true);
    for (const [id, key, globs] of [["i28-a", "a", ["src/lib/a*.ts"]], ["i28-b", "b", ["src/bridge/b.ts"]]] as const) {
      const t = getTask(db, id)!;
      expect(t).toMatchObject({ stage: "spec", agent: `agent-task-${id}`, pm: PM.agent, branch: `feat/${id}`, featureId: "ab12-i28", spec: `docs/tasks/${id}.md` });
      expect(t.extra.fileGlobs).toEqual([...globs]);
      expect(getWorkflow(db, id)).toMatchObject({ mode: "auto", template: "code", templateVersion: 2, authorFamily: "claude" });
      const prompt = readFileSync(join(dir, "ledger", "reviews", `${id}-exec-prompt.md`), "utf8");
      expect(prompt).toContain("本卡是自动卡");
      expect(prompt).toContain(`不要给 ${PM.agent} 发任何进度`);
      expect(lstatSync(join(dir, "wt", id, "node_modules")).isFile()).toBe(true);
      const show = await call(PM, "show_dag", { featureId: "i28" });
      expect(show.version.nodes.find((n: any) => n.key === key)).toMatchObject({ taskId: id, status: "spec", agent: `agent-task-${id}`, fileGlobs: [...globs] });
    }
    expect(readFileSync(join(dir, "ledger", "docs", "tasks", "i28-a.md"), "utf8")).toContain("i28-a 规格");
    const create = calls.find((c) => c[0] === "create" && c[1] === "task-i28-a")!;
    expect(create).toEqual(expect.arrayContaining(["--task", "i28-a", "--project", P, join(dir, "wt", "i28-a")]));
    expect(await start("a")).toMatchObject({ ok: true, duplicate: true, taskId: "i28-a" });
    expect(calls.filter((c) => c[0] === "create")).toHaveLength(2);
  });
});

describe("P1：start_node 中途失败不留半截", () => {
  const cases: [string, (a: string[]) => boolean][] = [
    ["worktree", (a) => a[0] === "git" && a[1] === "worktree" && a[2] === "add"],
    ["agent", (a) => a[0] === "create"],
    ["task-set", (a) => a[0] === "ledger" && a[1] === "task-set"],
    ["workflow", (a) => a[0] === "ledger" && a[1] === "workflow-set"],
    ["bind", (a) => a[0] === "ledger" && a[1] === "dag-bind"],
  ];
  for (const [step, when] of cases) {
    test(`${step} 失败：卡取消、worktree / 分支 / agent / 说明全撤、节点没绑`, async () => {
      await plan();
      spec("i28-a");
      failOn = when;
      const r = await start("a");
      expect(r).toMatchObject({ ok: false, code: "start_failed", failedStep: step, leftovers: [] });
      expect(getTask(db, "i28-a")?.stage).toBe("cancelled");
      expect(getWorkflow(db, "i28-a")?.mode ?? "manual").not.toBe("auto");
      expect(existsSync(join(dir, "wt", "i28-a"))).toBe(false);
      expect(branches.has("feat/i28-a")).toBe(false);
      expect(agents["agent-task-i28-a"]).toBeUndefined();
      expect(existsSync(join(dir, "ledger", "reviews", "i28-a-exec-prompt.md"))).toBe(false);
      const show = await call(PM, "show_dag", { featureId: "i28" });
      expect(show.version.nodes.find((n: any) => n.key === "a").taskId).toBeNull();
      failOn = () => false;
      expect(await start("a", PM, { taskId: "i28-a2", spec: "重试" })).toMatchObject({ ok: true, taskId: "i28-a2" });
    });
  }

  test("task-new 失败：什么都没留下；规格卡是这次写的也删掉", async () => {
    await plan();
    failOn = (a) => a[0] === "ledger" && a[1] === "task-new";
    expect(await start("a", PM, { spec: "正文" })).toMatchObject({ ok: false, failedStep: "task-new" });
    expect(getTask(db, "i28-a")).toBeNull();
    expect(calls.some((c) => c[0] === "git" || c[0] === "create")).toBe(false);
  });

  test("预检不过就一步不做：依赖没满足、没有规格卡、调度服务没开 auto、分支已存在", async () => {
    await plan(PM, [node("a", ["a.ts"]), node("b", ["b.ts"], { deps: ["a"] })]);
    calls = [];
    expect(await start("b")).toMatchObject({ ok: false, code: "deps_unmet" });
    expect(await start("a")).toMatchObject({ ok: false, code: "no_spec" });
    spec("i28-a");
    autoDispatch = false;
    expect(await start("a")).toMatchObject({ ok: false, code: "auto_off" });
    autoDispatch = true;
    branches.add("feat/i28-a");
    expect(await start("a")).toMatchObject({ ok: false, code: "conflict" });
    expect(writes()).toEqual([]);
  });
});

describe("P1：rewrite_dag 删进行中的节点必须带原因", () => {
  test("remove 进行中节点被拒；cancel 带原因 → 待 owner 批；拆计划节点直接生效，车道跟着变", async () => {
    await plan();
    spec("i28-a");
    expect((await start("a")).ok).toBe(true);
    db.prepare("UPDATE tasks SET stage = 'build' WHERE id = 'i28-a'").run();
    const base = { featureId: "i28", reasonKind: "requirement_change", reason: "owner：不做了" };
    expect(await call(PM, "rewrite_dag", { ...base, remove: ["a"] })).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("cancel") });
    expect(await call(PM, "rewrite_dag", { featureId: "i28", remove: ["b"] })).toMatchObject({ ok: false, error: expect.stringContaining("reason") });
    const split = await call(PM, "rewrite_dag", { ...base, remove: ["b"], add: [node("b1", ["src/lib/a-x.ts"]), node("b2", ["docs/b2.md"])] });
    expect(split).toMatchObject({ ok: true, applied: true, lanes: { startNow: ["b2"], waiting: [{ key: "b1", why: "files", on: ["a"] }] } });
    const cancel = await call(PM, "rewrite_dag", { ...base, cancel: { a: "owner 说不做了" } });
    expect(cancel).toMatchObject({ ok: true, applied: false, askId: expect.any(String) });
    expect(getFeature(db, "ab12-i28")?.currentVersion).toBe(2);
    const diff = await call(PM, "show_dag", { featureId: "i28", diff: ["1", "pending"] });
    expect(diff.diff.cancelled).toEqual([{ key: "a", taskId: "i28-a", reason: "owner 说不做了" }]);
  });

  test("plan_feature 覆盖已有 DAG 要带原因；漏掉进行中的节点被拒", async () => {
    await plan();
    spec("i28-a");
    await start("a");
    db.prepare("UPDATE tasks SET stage = 'build' WHERE id = 'i28-a'").run();
    expect(await call(PM, "plan_feature", { featureId: "i28", nodes: [node("b", ["b.ts"])] })).toMatchObject({ ok: false, error: expect.stringContaining("reason") });
    const again = { featureId: "i28", reasonKind: "new_issue", reason: "审查发现要加一步" };
    expect(await call(PM, "plan_feature", { ...again, nodes: [node("b", ["src/bridge/b.ts"])] })).toMatchObject({ ok: false, error: expect.stringContaining("a") });
    const r = await call(PM, "plan_feature", { ...again, nodes: [node("a", ["src/lib/a*.ts"]), node("b", ["src/bridge/b.ts"]), node("c", ["c.ts"], { deps: ["a"] })] });
    expect(r).toMatchObject({ ok: true, applied: true, lanes: { waiting: [{ key: "c", why: "deps", on: ["a"] }] } });
    expect(getTask(db, "i28-a")?.featureId).toBe("ab12-i28");
  });
});
